#!/usr/bin/env python3
"""chrome-pilot CLI — 透過 WS bridge (127.0.0.1:8790) 控制已登入 Chrome。

子命令:
  status                         連線狀態 + 目前 active tab
  tabs [--filter 文字]           列出所有 page tab
  open  <url>                    開新 tab
  navigate <url> [--tab N]       導航
  eval   <js>   [--tab N]        執行 JS（回傳值）
  click  [--selector S] [--text T] [--tab N]   真實滑鼠點擊
  type   <text> [--tab N]        逐字鍵入
  key    <keys> [--tab N]       按鍵（ctrl+c / Enter / Down ...）
  reload                         遠端 chrome.runtime.reload()（載入新版 extension）
  raw    <json>                  直接送原始指令

--tab N = chrome.tabs id（數字）；不帶 = active/第一個 page tab。
"""
import json, os, sys, uuid
import asyncio

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
WS_URL = "ws://127.0.0.1:8790"


async def send_ws(action, **kwargs):
    try:
        import websockets
    except ImportError:
        import subprocess
        subprocess.check_call([sys.executable, "-m", "pip", "install", "websockets", "-q"])
        import websockets

    msg = {"action": action, "id": str(uuid.uuid4())[:8]}
    msg.update(kwargs)
    async with websockets.connect(WS_URL) as ws:
        await ws.send(json.dumps(msg))
        while True:
            resp = json.loads(await ws.recv())
            if resp.get("id") == msg["id"]:
                return resp


def parse_args(argv):
    import argparse
    p = argparse.ArgumentParser(description="Chrome Pilot v2")
    p.add_argument("command",
                   choices=["open", "navigate", "tabs", "eval", "click",
                            "type", "key", "status", "reload", "raw"])
    p.add_argument("args", nargs="*")
    p.add_argument("--tab", type=int, help="chrome.tabs id")
    p.add_argument("--filter", help="tabs 過濾（URL 子字串）")
    p.add_argument("--selector", help="click: CSS selector")
    p.add_argument("--text", help="click: 文字匹配 / type: 要輸入的文字")
    p.add_argument("--url", help="open/navigate 的 URL（也可當位置參數）")
    return p.parse_args(argv)


def first_url(a):
    """從位置參數拿 url"""
    if a.args and a.args[0].startswith("http"):
        return a.args[0]
    return a.url


async def main(argv):
    a = parse_args(argv)
    cmd = a.command

    if cmd == "status":
        r = await send_ws("status")

    elif cmd == "tabs":
        r = await send_ws("tabs")
        if a.filter:
            r["tabs"] = [t for t in r.get("tabs", [])
                          if a.filter.lower() in (t.get("url") or "").lower()]

    elif cmd == "open":
        url = first_url(a) or "about:blank"
        r = await send_ws("open", url=url)

    elif cmd == "navigate":
        url = first_url(a) or (a.args[0] if a.args else "")
        if a.tab is not None:
            r = await send_ws("navigatetab", tabId=a.tab, url=url)
        else:
            r = await send_ws("navigatetab", url=url)

    elif cmd == "eval":
        expr = a.args[0] if a.args else "document.title"
        if a.tab is not None:
            r = await send_ws("eval", tabId=a.tab, expression=expr)
        else:
            r = await send_ws("eval", expression=expr)

    elif cmd == "click":
        kw = {}
        if a.selector:
            kw["selector"] = a.selector
        if a.text:
            kw["text"] = a.text
        if a.tab is not None:
            kw["tabId"] = a.tab
        r = await send_ws("click", **kw)

    elif cmd == "type":
        text = a.text or (a.args[0] if a.args else "")
        kw = {"text": text}
        if a.tab is not None:
            kw["tabId"] = a.tab
        r = await send_ws("type", **kw)

    elif cmd == "key":
        keys = a.args[0] if a.args else "Enter"
        kw = {"keys": keys}
        if a.tab is not None:
            kw["tabId"] = a.tab
        r = await send_ws("key", **kw)

    elif cmd == "reload":
        r = await send_ws("reload")
        print(json.dumps(r, indent=2, ensure_ascii=False))
        await asyncio.sleep(8)
        try:
            chk = await send_ws("status")
            print("reloaded, status:", json.dumps(chk, ensure_ascii=False))
        except Exception as e:
            print("reload 後重連中（MV3 alarm 30s 內會自動連）:", e)
        return

    elif cmd == "raw":
        raw = json.loads(a.args[0]) if a.args else {}
        r = await send_ws(**raw)

    print(json.dumps(r, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    try:
        asyncio.run(main(sys.argv[1:]))
    except Exception as e:
        print(json.dumps({"error": str(e)}, indent=2, ensure_ascii=False))
        sys.exit(1)
