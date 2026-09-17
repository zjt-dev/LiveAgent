"""临时探针：复刻 app 的握手序列并分阶段计时，定位 in-app 比离机慢的那 1.5–1.7x。

app 的序列（`McpClient::ensure_initialized` + `tools_list`）与最小探针的差异：

1. `initialize` 的 protocolVersion 依次试 `2025-11-25` → `2025-06-18` → …，
   而最小探针直接发 `2025-06-18`；
2. 握手成功后再发 `notifications/initialized`；
3. 最后才是 `tools/list`。

本脚本把这三段分别计时，好判断差额到底出在「版本选择/多一个往返」还是
「app 的 transport 实现」。

用法：python scripts/mcp-handshake-decompose.py [server_id] [protocol_version]
用完即删。
"""

from __future__ import annotations

import json
import subprocess
import sys
import threading
import time

SERVERS = {
    "context7": ["npx", "-y", "@upstash/context7-mcp@latest"],
    "exa": ["npx", "-y", "exa-mcp-server@latest"],
    "mcp-deepwiki": ["npx", "-y", "mcp-deepwiki@latest"],
    "sequential-thinking": [
        "npx",
        "-y",
        "@modelcontextprotocol/server-sequential-thinking@2026.7.4",
    ],
    "uni-app-x": ["npx", "@dcloudio/uni-app-x-mcp"],
    # 非 npx 型。加进来是为了验证「in-app 的 12–19s 是不是被这几个挤出来的」——
    # 之前只测过 5 路 npx 并发（1.0–1.24x），没测过 8 路混合。
    "cua-driver": [r"C:\Users\zjt\AppData\Local\Programs\Cua\cua-driver\bin\cua-driver.exe", "mcp"],
    "playwright-iso": ["node", "D:/browser/tools/mpw/node_modules/multi-playwright-mcp/dist/index.js"],
    "codebase-memory-mcp": [r"C:/Users/zjt/.local/bin/codebase-memory-mcp.exe"],
}

NPX_IDS = ["context7", "exa", "mcp-deepwiki", "sequential-thinking", "uni-app-x"]

# app 的候选序列（mcp.rs:1328）
CANDIDATES = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"]


class Server:
    def __init__(self, args: list[str]) -> None:
        self._t0 = time.monotonic()
        self.proc = subprocess.Popen(
            args,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,  # app 也是 pipe + 尾读线程
            shell=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        self.spawn = time.monotonic() - self._t0
        # 把 stderr 抽干，避免 npx 写满管道后阻塞（app 有尾读线程做同样的事）
        self.stderr_lines: list[str] = []
        threading.Thread(target=self._drain, daemon=True).start()

    def _drain(self) -> None:
        assert self.proc.stderr
        for line in self.proc.stderr:
            self.stderr_lines.append(line)
            if len(self.stderr_lines) > 200:
                self.stderr_lines.pop(0)

    def send(self, payload: dict) -> None:
        assert self.proc.stdin
        self.proc.stdin.write(json.dumps(payload) + "\n")
        self.proc.stdin.flush()

    def read_line(self) -> str | None:
        assert self.proc.stdout
        return self.proc.stdout.readline()

    def close(self) -> None:
        self.proc.kill()
        self.proc.wait(timeout=10)


def request(server: Server, rpc_id: int, method: str, params: dict) -> tuple[float, dict | None]:
    started = time.monotonic()
    server.send({"jsonrpc": "2.0", "id": rpc_id, "method": method, "params": params})
    line = server.read_line()
    elapsed = time.monotonic() - started
    if not line:
        return elapsed, None
    try:
        return elapsed, json.loads(line)
    except json.JSONDecodeError:
        return elapsed, {"_raw": line[:120]}


def handshake(name: str) -> tuple[float, str]:
    """完整跑一遍 app 的握手序列，返回（initialize 耗时, 结果摘要）。"""
    server = Server(SERVERS[name])
    try:
        for v in CANDIDATES:
            elapsed, payload = request(
                server,
                1,
                "initialize",
                {
                    "protocolVersion": v,
                    "clientInfo": {"name": "LiveAgent", "version": "probe"},
                    "capabilities": {},
                },
            )
            if payload and "result" in payload:
                return elapsed, payload["result"].get("protocolVersion", "?")
        return elapsed, "全部版本失败"
    finally:
        server.close()


def run_all_concurrent() -> int:
    """8 路并发（5 npx + 3 非 npx），看 npx 那 5 个会不会被挤慢。"""
    print("=== 8 路并发 ===", flush=True)
    results: dict[str, tuple[float, str]] = {}
    lock = threading.Lock()

    def worker(n: str) -> None:
        try:
            elapsed, note = handshake(n)
        except Exception as exc:  # noqa: BLE001 - 探针，出错就记下来继续
            elapsed, note = -1.0, f"异常 {exc}"
        with lock:
            results[n] = (elapsed, note)

    threads = [threading.Thread(target=worker, args=(n,)) for n in SERVERS]
    wall = time.monotonic()
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    wall = time.monotonic() - wall

    print(f"  墙钟总耗时 {wall:.3f}s", flush=True)
    for n in SERVERS:
        elapsed, note = results[n]
        tag = "npx" if n in NPX_IDS else "   "
        print(f"  [{tag}] {n:<22} {elapsed:7.3f}s  {note}", flush=True)
    npx_max = max(results[n][0] for n in NPX_IDS)
    print(f"\n  npx 型最慢 {npx_max:.3f}s", flush=True)
    return 0


def main() -> int:
    name = sys.argv[1] if len(sys.argv) > 1 else "context7"
    if name == "ALL":
        return run_all_concurrent()

    forced_version = sys.argv[2] if len(sys.argv) > 2 else None
    args = SERVERS[name]
    versions = [forced_version] if forced_version else CANDIDATES

    print(f"=== {name}: {' '.join(args)} ===", flush=True)
    server = Server(args)
    print(f"  [A] spawn 返回            {server.spawn:7.3f}s", flush=True)

    wall = time.monotonic()
    total_init = 0.0
    negotiated = None

    for v in versions:
        elapsed, payload = request(
            server,
            1,
            "initialize",
            {
                "protocolVersion": v,
                "clientInfo": {"name": "LiveAgent", "version": "probe"},
                "capabilities": {},
            },
        )
        total_init += elapsed
        if payload and "result" in payload:
            negotiated = payload["result"].get("protocolVersion", "?")
            print(f"  [B] initialize({v})  {elapsed:7.3f}s  → ok，协商为 {negotiated}", flush=True)
            break
        note = payload.get("error") if payload else "无响应"
        print(f"  [B] initialize({v})  {elapsed:7.3f}s  → {note}", flush=True)

    if negotiated is None:
        print("  initialize 全部版本都失败，终止", flush=True)
        server.close()
        return 1

    t_notify = time.monotonic()
    server.send({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})
    print(f"  [C] notifications/initialized 写入  {time.monotonic() - t_notify:7.3f}s（不等回复）", flush=True)

    elapsed, payload = request(server, 2, "tools/list", {})
    tools = len((payload or {}).get("result", {}).get("tools", []) or [])
    print(f"  [D] tools/list        {elapsed:7.3f}s  → {tools} 个工具", flush=True)

    print(
        f"\n  合计（不含 spawn）{(time.monotonic() - wall):.3f}s"
        f"   其中 initialize 累计 {total_init:.3f}s",
        flush=True,
    )
    print(f"  stderr 行数 {len(server.stderr_lines)}", flush=True)
    server.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
