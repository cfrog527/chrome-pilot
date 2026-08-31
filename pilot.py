#!/usr/bin/env python3
"""chrome-pilot v2 CLI — 發送操作到 Chrome (:9222 CDP API)
透過 WebSocket 連接到 chrome-pilot v2 bridge (port 8790)。"""
import subprocess, sys, json, uuid, os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# 直接使用 websockets 客戶端
async def send_ws(action, **kwargs):
    """透過 WebSocket 發送指令到 chrome-pilot v2"""
    import asyncio
    try:
        import websockets
    except ImportError:
        import subprocess
        subprocess.check_call([sys.executable, "-m", "pip", "install", "websockets", "-q"])
        import websockets

    url = "ws://127.0.0.1:8790"
    msg = {"action": action, "id": str(uuid.uuid4())[:8]}
    msg.update(kwargs)

    async with websockets.connect(url) as ws:
        await ws.send(json.dumps(msg))
        resp = json.loads(await ws.recv())
        return resp

async def send_ws_tab(action, tab_id, **kwargs):
    """透過 WebSocket 發送指令到 chrome-pilot v2，附帶 tabId"""
    import asyncio
    import json
    import uuid

    try:
        import websockets
    except ImportError:
        import subprocess
        subprocess.check_call([sys.executable, "-m", "pip", "install", "websockets", "-q"])
        import websockets

    url = "ws://127.0.0.1:8790"
    msg = {"action": action, "id": str(uuid.uuid4())[:8], "tabId": tab_id}
    msg.update(kwargs)

    async with websockets.connect(url) as ws:
        await ws.send(json.dumps(msg))
        resp = json.loads(await ws.recv())
        return resp

async def main():
    import argparse
    parser = argparse.ArgumentParser(description="Chrome Pilot v2")
    parser.add_argument("command", choices=["open", "tabs", "eval", "click", "status", "navigate", "reload"])
    parser.add_argument("args", nargs="*")
    parser.add_argument("--tab", type=int, help="Tab ID")
    args = parser.parse_args()

    try:
        if args.command == "open":
            resp = await send_ws("open", url=args.args[0] if args.args else "about:blank")
            print(json.dumps(resp, indent=2, ensure_ascii=False))

        elif args.command == "tabs":
            resp = await send_ws("tabs")
            print(json.dumps(resp, indent=2, ensure_ascii=False))

        elif args.command == "eval":
            expr = args.args[0] if args.args else "(function(){return true})()"
            if args.tab:
                resp = await send_ws_tab("eval", args.tab, expression=expr)
            else:
                resp = await send_ws("eval", expression=expr)
            print(json.dumps(resp, indent=2, ensure_ascii=False))

        elif args.command == "click":
            selector = args.args[0] if args.args else ""
            if args.tab:
                resp = await send_ws_tab("click", args.tab, selector=selector)
            else:
                resp = await send_ws("click", selector=selector)
            print(json.dumps(resp, indent=2, ensure_ascii=False))

        elif args.command == "status":
            resp = await send_ws("status")
            print(json.dumps(resp, indent=2, ensure_ascii=False))

        elif args.command == "reload":
            # 遠端觸發 chrome.runtime.reload()：SW 終止並重新載入磁碟上的新版
            # reload 後 SW 需要時間喚醒重連，稍等後驗證 status
            resp = await send_ws("reload")
            print(json.dumps(resp, indent=2, ensure_ascii=False))
            await asyncio.sleep(8)
            try:
                check = await send_ws("status")
                print("reloaded, status:", json.dumps(check, ensure_ascii=False))
            except Exception as e:
                print("reload 後重連中（MV3 alarm 30s 內會自動連）:", e)

        elif args.command == "navigate":
            url = args.args[0] if args.args else ""
            if args.tab:
                resp = await send_ws_tab("navigate", args.tab, url=url)
            else:
                resp = await send_ws("navigate", url=url)
            print(json.dumps(resp, indent=2, ensure_ascii=False))

    except Exception as e:
        print(json.dumps({"error": str(e)}, indent=2))

if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
