"""临时脚本：把 ~/.liveagent/config.sqlite 里已启用的 MCP server 导出成 JSON。

用途：给 release 量测用的 Rust 测试提供**真实配置**，避免手抄配置时漏字段或
写错值。导出的是设置里存的那份 JSON 原样，不做任何字段转换——前端发的就是它。

用完即删。
"""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

LIVEAGENT_DIR = Path.home() / ".liveagent"
SRC = LIVEAGENT_DIR / "config.sqlite"
OUT = Path(tempfile.gettempdir()) / "real-mcp-configs.json"


def copy_db_with_wal() -> Path:
    """把 sqlite 及其 WAL 一起拷到临时目录再打开。

    直接打开原库读不到 `-wal` 里尚未 checkpoint 的改动（设置刚改过就在里面），
    会拿到过期数据。
    """
    tmpdir = Path(tempfile.mkdtemp(prefix="lacfg-dump-"))
    for suffix in ("", "-wal", "-shm"):
        src = Path(str(SRC) + suffix)
        if src.exists():
            shutil.copy2(src, Path(str(tmpdir / SRC.name) + suffix))
    return tmpdir / SRC.name


def main() -> int:
    if not SRC.exists():
        print(f"找不到 {SRC}", file=sys.stderr)
        return 1

    db = copy_db_with_wal()
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row

    tables = [
        r[0]
        for r in conn.execute(
            "select name from sqlite_master where type='table' order by name"
        )
    ]
    print(f"表: {tables}", file=sys.stderr)

    # 真实 schema：mcp_settings(server_id, payload_json, sort_index, updated_at)
    # —— 一行一个 server，payload_json 就是该 server 的配置对象。
    # 按 sort_index 取，保证导出顺序 = 设置里的显示顺序 = 前端发给 Rust 的顺序。
    rows = list(
        conn.execute("select payload_json from mcp_settings order by sort_index, server_id")
    )
    if not rows:
        print("mcp_settings 为空", file=sys.stderr)
        return 1

    servers = []
    for row in rows:
        try:
            servers.append(json.loads(row["payload_json"]))
        except json.JSONDecodeError as exc:
            print(f"跳过无法解析的行：{exc}", file=sys.stderr)

    enabled = [s for s in servers if s.get("enabled") and (s.get("id") or "").strip()]

    OUT.write_text(json.dumps(enabled, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"导出 {len(enabled)}/{len(servers)} 个 enabled server → {OUT}", file=sys.stderr)
    for s in enabled:
        cmd = s.get("command") or ""
        args = " ".join(s.get("args") or [])
        print(
            f"  {s['id']:<24} {s.get('transport') or 'stdio':<6} "
            f"timeoutMs={s.get('timeoutMs')} {cmd} {args}".rstrip(),
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
