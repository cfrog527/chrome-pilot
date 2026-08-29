#!/usr/bin/env python3
"""pilot.py — Hermes 端 CLI：對 chrome-pilot bridge 下達指令

用法:
  pilot.py status
  pilot.py tabs
  pilot.py tabs --filter canva
  pilot.py open <url> [--new]
  pilot.py eval <js-expression> [--tab N]
  pilot.py click --selector "css" [--tab N]
  pilot.py type --selector "input" --text "hello" [--tab N]
  pilot.py screenshot [--tab N]          # 存 PNG，印出路徑
  pilot.py nav <url> [--tab N]
  pilot.py raw '{"action":"..."}'        # 原始 JSON

Tab 參數 N = tab 列表中的 index（0-based）。預設作用於「active tab」。
timeout 預設 60 秒（--timeout 秒）。
"""
import argparse
import asyncio
import json
import sys
import uuid

import websockets

BRIDGE = "ws://127.0.0.1:8790"


async def call(payload, timeout=60):
    payload = dict(payload)
    payload.setdefault("id", uuid.uuid4().hex[:8])
    payload["timeout"] = timeout
    async with websockets.connect(BRIDGE, open_timeout=5, max_size=50 * 1024 * 1024) as ws:
        await ws.send(json.dumps(payload))
        raw = await asyncio.wait_for(ws.recv(), timeout=timeout + 10)
    return json.loads(raw)


def out(resp):
    print(json.dumps(resp, ensure_ascii=False, indent=2))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add_timeout(p):
        p.add_argument("--timeout", type=int, default=60)

    p = sub.add_parser("status"); add_timeout(p)
    p = sub.add_parser("tabs"); p.add_argument("--filter", default=""); add_timeout(p)
    p = sub.add_parser("open"); p.add_argument("url"); p.add_argument("--new", action="store_true"); add_timeout(p)
    p = sub.add_parser("nav"); p.add_argument("url"); p.add_argument("--tab", type=int, default=None); add_timeout(p)
    p = sub.add_parser("eval"); p.add_argument("js"); p.add_argument("--tab", type=int, default=None); add_timeout(p)
    p = sub.add_parser("click"); p.add_argument("--selector", required=True); p.add_argument("--tab", type=int, default=None); add_timeout(p)
    p = sub.add_parser("type"); p.add_argument("--selector", required=True); p.add_argument("--text", required=True); p.add_argument("--tab", type=int, default=None); add_timeout(p)
    p = sub.add_parser("screenshot"); p.add_argument("--tab", type=int, default=None); add_timeout(p)
    p = sub.add_parser("raw"); p.add_argument("json"); add_timeout(p)

    a = ap.parse_args()

    payload = {"action": a.cmd}
    if a.cmd == "tabs" and a.filter:
        payload["filter"] = a.filter
    if a.cmd == "open":
        payload["url"] = a.url
        payload["new_tab"] = a.new
    if a.cmd == "nav":
        payload["url"] = a.url
    if a.cmd == "eval":
        payload["js"] = a.js
    if a.cmd == "click":
        payload["selector"] = a.selector
    if a.cmd == "type":
        payload["selector"] = a.selector
        payload["text"] = a.text
    if a.cmd == "raw":
        payload = json.loads(a.json)

    if getattr(a, "tab", None) is not None:
        payload["tab"] = a.tab

    try:
        resp = asyncio.run(call(payload, timeout=a.timeout))
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
    out(resp)
    if isinstance(resp, dict) and resp.get("error"):
        sys.exit(2)


if __name__ == "__main__":
    main()
