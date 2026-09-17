"""临时探针：验证「10 路并发 spawn 争抢」是不是放大的原因。

做法：对同一批 npx 型 MCP server，先**串行**做一次 MCP initialize 握手计时，
再**全并发**做一次，比较每个 server 的耗时。

如果并发下每个都变慢 2–3 倍，就说明放大来自争抢（CPU / 磁盘 / npm cache 访问），
而不是 debug build —— 那意味着「并发度开满」并不是最优，且降单 server 成本
（npx 直连 node）才是真正的杠杆。

用完即删。
"""

from __future__ import annotations

import json
import subprocess
import sys
import threading
import time

# 本机真实配置里的 npx 型 server（command 是 cmd，args 是 ["/c","npx",...]）
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
}

INIT = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "probe", "version": "0.0.1"},
    },
}


def one_initialize(args: list[str], timeout: float = 120.0) -> tuple[float, str]:
    """跑一次 initialize，返回（耗时秒, 结果摘要）。"""
    started = time.monotonic()
    proc = subprocess.Popen(
        args,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        shell=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    try:
        assert proc.stdin and proc.stdout
        proc.stdin.write(json.dumps(INIT) + "\n")
        proc.stdin.flush()
        line = proc.stdout.readline()
        elapsed = time.monotonic() - started
        if not line:
            return elapsed, "无响应"
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            return elapsed, f"非 JSON：{line[:60]!r}"
        if "result" in payload:
            version = payload["result"].get("protocolVersion", "?")
            return elapsed, f"ok protocolVersion={version}"
        return elapsed, f"error {payload.get('error')}"
    finally:
        proc.kill()
        proc.wait(timeout=10)


def main() -> int:
    only = sys.argv[1] if len(sys.argv) > 1 else None
    targets = {k: v for k, v in SERVERS.items() if only is None or k == only}

    print("=== 串行（一次一个）===", flush=True)
    serial: dict[str, float] = {}
    for name, args in targets.items():
        elapsed, note = one_initialize(args)
        serial[name] = elapsed
        print(f"  {name:<22} {elapsed:7.3f}s  {note}", flush=True)

    print(f"\n=== 并发（{len(targets)} 路同时）===", flush=True)
    parallel: dict[str, float] = {}
    notes: dict[str, str] = {}
    lock = threading.Lock()

    def worker(name: str, args: list[str]) -> None:
        elapsed, note = one_initialize(args)
        with lock:
            parallel[name] = elapsed
            notes[name] = note

    threads = [threading.Thread(target=worker, args=(n, a)) for n, a in targets.items()]
    wall = time.monotonic()
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    wall = time.monotonic() - wall

    print(f"  墙钟总耗时 {wall:.3f}s", flush=True)
    for name in targets:
        print(f"  {name:<22} {parallel[name]:7.3f}s  {notes[name]}", flush=True)

    print("\n=== 对比 ===", flush=True)
    print(f"  {'server':<22} {'串行':>9} {'并发':>9} {'倍数':>7}", flush=True)
    for name in targets:
        ratio = parallel[name] / serial[name] if serial[name] else float("nan")
        print(f"  {name:<22} {serial[name]:8.3f}s {parallel[name]:8.3f}s {ratio:6.2f}x", flush=True)
    print(
        f"\n  串行合计 {sum(serial.values()):.3f}s → 并发墙钟 {wall:.3f}s "
        f"（提速 {sum(serial.values()) / wall:.2f}x）",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
