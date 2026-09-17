"""把 `npx <pkg>` 型 MCP server 解析成「直连 node」的配置，并实测验证。

为什么需要它：npx 每次启动要回查 registry + 加载 npm CLI + 多层进程转发，实测
占单个 server 冷启动的 99.8%（5.2s / 5.96s）。直连 node 只要 0.74s。

做的事：
1. 从 `~/.liveagent/config.sqlite` 读真实配置（复用 dump-mcp-configs.py 的逻辑）；
2. 识别 `npx` 型（command 是 npx/npx.cmd，或 cmd /c npx …），抽出包名；
3. 在 `~/AppData/Local/npm-cache/_npx/*/node_modules/<pkg>` 里定位已缓存的包，
   读 package.json 的 `bin` 字段解析入口，校验文件存在；
4. 实测直连的 `initialize` 耗时，与走 npx 的对照。

只打印，**不修改任何配置**。

用法：
    python scripts/resolve-mcp-direct-entries.py          # 解析 + 校验 + 实测
    python scripts/resolve-mcp-direct-entries.py --no-time  # 跳过实测（快）
"""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

CONFIG_DB = Path.home() / ".liveagent" / "config.sqlite"
NPX_CACHE = Path.home() / "AppData" / "Local" / "npm-cache" / "_npx"

INIT = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "2025-11-25",
        "capabilities": {},
        "clientInfo": {"name": "LiveAgent", "version": "probe"},
    },
}


def load_configs() -> list[dict]:
    """读已启用的 MCP server。必须连 -wal/-shm 一起拷，否则读不到未 checkpoint 的改动。"""
    tmpdir = Path(tempfile.mkdtemp(prefix="laentries-"))
    for suffix in ("", "-wal", "-shm"):
        src = Path(str(CONFIG_DB) + suffix)
        if src.exists():
            shutil.copy2(src, Path(str(tmpdir / CONFIG_DB.name) + suffix))
    conn = sqlite3.connect(tmpdir / CONFIG_DB.name)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "select payload_json from mcp_settings order by sort_index, server_id"
    ).fetchall()
    servers = [json.loads(r["payload_json"]) for r in rows]
    return [s for s in servers if s.get("enabled") and (s.get("id") or "").strip()]


def npx_spec(server: dict) -> str | None:
    """从配置里抽出 `npx` 后面的包 spec；不是 npx 型就返回 None。"""
    command = (server.get("command") or "").strip()
    args = list(server.get("args") or [])
    tokens = [command, *args]

    # 定位 npx（可能经 cmd /c 转发）
    npx_at = None
    for i, tok in enumerate(tokens):
        base = Path(tok).name.lower()
        if base in ("npx", "npx.cmd", "npx.exe"):
            npx_at = i
            break
    if npx_at is None:
        return None

    # npx 之后第一个不以 - 开头的 token 就是包 spec
    for tok in tokens[npx_at + 1 :]:
        if not tok.startswith("-"):
            return tok
    return None


def split_spec(spec: str) -> tuple[str, str | None]:
    """`@scope/pkg@1.2.3` → (`@scope/pkg`, `1.2.3`)；无版本返回 None。"""
    body = spec
    at = body.rfind("@")
    if at > 0:  # >0 避开 @scope 开头那个 @
        return body[:at], body[at + 1 :]
    return body, None


def version_key(version: str) -> tuple[int, ...]:
    """把版本串变成可比较的元组，用于「取最高版本」。

    只取数字段：`v1.0.14` → (1,0,14)、`2026.7.4` → (2026,7,4)、
    `0.0.10` → (0,0,10)。带预发布后缀（`1.0.0-beta.2`）的段会被拆成额外的
    数字，比较结果对「挑最高的稳定版」这个用途足够。
    """
    parts: list[int] = []
    for chunk in version.lstrip("vV").replace("-", ".").replace("+", ".").split("."):
        digits = "".join(ch for ch in chunk if ch.isdigit())
        if digits:
            parts.append(int(digits))
    return tuple(parts) if parts else (0,)


def find_entry(pkg: str) -> tuple[Path | None, str, list[tuple[Path, str]]]:
    """在 npx 缓存里找包目录并解析 bin 入口。

    **按版本号取最高，不按 mtime** —— 踩过：缓存里同时存在 context7 的
    `v1.0.14`（mtime 更新）与两份 `4.1.1`，按 mtime 会挑中旧的那份，而且
    目录哈希无法反推版本，光看目录名分辨不出来。

    返回 (入口, 版本, [(目录, 版本)] 全部候选按版本降序)。
    """
    dirs = [d for d in NPX_CACHE.glob(f"*/node_modules/{pkg}") if d.is_dir()]
    if not dirs:
        return None, "", []

    found: list[tuple[Path, str]] = []
    for d in dirs:
        manifest = d / "package.json"
        if not manifest.exists():
            continue
        try:
            version = json.loads(manifest.read_text(encoding="utf-8")).get("version", "?")
        except json.JSONDecodeError:
            continue
        found.append((d, version))

    if not found:
        return None, "", []
    found.sort(key=lambda item: version_key(item[1]), reverse=True)

    pkgdir, version = found[0]
    manifest = pkgdir / "package.json"
    data = json.loads(manifest.read_text(encoding="utf-8"))
    bin_field = data.get("bin")

    entry: str | None = None
    if isinstance(bin_field, str):
        entry = bin_field
    elif isinstance(bin_field, dict) and bin_field:
        # 优先取与包名同名的那个 bin（多 bin 时最常见的约定）
        base = pkg.split("/")[-1]
        entry = bin_field.get(base) or next(iter(bin_field.values()))
    else:
        # 没有 bin 字段：退回 package.json 的 main
        entry = data.get("main")

    if not entry:
        return None, version, found
    return pkgdir / entry, version, found


def time_initialize(command: str, args: list[str]) -> tuple[float, str]:
    """实测一次 initialize。command 走 PATH 解析，与 app 的行为一致。"""
    started = time.monotonic()
    proc = subprocess.Popen(
        [command, *args],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
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
        payload = json.loads(line)
        if "result" in payload:
            return elapsed, "ok " + payload["result"].get("protocolVersion", "?")
        return elapsed, f"error {payload.get('error')}"
    except (json.JSONDecodeError, AssertionError) as exc:
        return time.monotonic() - started, f"异常 {exc}"
    finally:
        proc.kill()
        proc.wait(timeout=10)


def main() -> int:
    do_time = "--no-time" not in sys.argv
    servers = load_configs()

    resolved: list[tuple[dict, str, Path, str, list[tuple[Path, str]]]] = []
    skipped: list[dict] = []

    for server in servers:
        spec = npx_spec(server)
        if not spec:
            skipped.append(server)
            continue
        pkg, pinned = split_spec(spec)
        entry, version, candidates = find_entry(pkg)
        if entry is None:
            print(f"[!] {server['id']}: 在 npx 缓存里没找到 {pkg} 的可用入口", file=sys.stderr)
            continue
        resolved.append((server, spec, entry, version, candidates))
        if pinned and pinned != version:
            print(
                f"[!] {server['id']}: 配置写的是 @{pinned}，缓存里最高版本是 {version}（不一致）",
                file=sys.stderr,
            )

    print(f"=== {len(resolved)} 个 npx 型 server 的直连入口 ===\n")
    multi_version: list[str] = []
    for server, spec, entry, version, candidates in resolved:
        exists = "✓" if entry.exists() else "✗ 不存在"
        print(f"{server['id']}")
        print(f"  当前    {server['command']} {' '.join(server.get('args') or [])}")
        print(f"  包      {spec}  →  缓存里最高版本 {version}")
        print(f"  建议    command = node")
        print(f"          args    = [\"{entry.as_posix()}\"]")
        print(f"  入口    {exists}  {entry.as_posix()}")
        versions = {v for _d, v in candidates}
        if len(versions) > 1:
            multi_version.append(server["id"])
            print(f"  !!      缓存里有 {len(versions)} 个不同版本，挑了最高的：")
            for d, v in candidates:
                mark = "  ← 选中" if d == entry.parent else ""
                print(f"            {v:<14} {d.as_posix()}{mark}")
        elif len(candidates) > 1:
            print(f"  注意    缓存里有 {len(candidates)} 份同版本副本，任选其一")
        print()

    if multi_version:
        print(
            f"!! {len(multi_version)} 个 server 在缓存里有多个版本共存（{'、'.join(multi_version)}）。\n"
            f"   目录哈希无法反推版本，只能读 package.json 才知道装的是哪版 —— 这正是\n"
            f"   「指向 npx 缓存」这条路不可靠的原因。要长期稳定，用 npm i -g（见文档 §7.15）。\n"
        )

    if do_time:
        print("=== 实测 initialize（直连 node）===")
        for server, spec, entry, _version, _c in resolved:
            if not entry.exists():
                continue
            elapsed, note = time_initialize("node", [entry.as_posix()])
            print(f"  {server['id']:<22} {elapsed:7.3f}s  {note}")
        print("\n  对照：走 npx 的 context7 实测 5.961s（见 §7.14）")

    if skipped:
        print(f"\n=== 非 npx 型（无需改，{len(skipped)} 个）===")
        for server in skipped:
            print(f"  {server['id']:<22} {server['command']}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
