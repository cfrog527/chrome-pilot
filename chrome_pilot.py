#!/usr/bin/env python3
"""chrome-pilot bridge v15：路由 pilot client <-> Chrome extension
- pilot.py 連 8790 發送指令
- extension (background.js) 也連 8790，bridge 把指令轉給 extension
- extension 用 chrome.debugger API 操作（extension 控制）
- bridge 每 15s ping extension 保持 MV3 service worker 存活
- 相容 websockets 新版（ServerConnection 用 .state 判斷，無 .open）
"""
import asyncio
import json
import logging
import time
import websockets

OP_PORT = 8790
log = logging.getLogger("chrome-pilot")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


def is_open(conn):
    """websockets 新版 ServerConnection 沒有 .open，用 .state 判斷"""
    if conn is None:
        return False
    st = getattr(conn, "state", None)
    if st is not None:
        try:
            return st.name == "OPEN"
        except Exception:
            try:
                return str(st).upper().endswith("OPEN")
            except Exception:
                return True
    # 舊版 fallback
    return getattr(conn, "open", True)


class Bridge:
    def __init__(self):
        self.ext_ws = None          # extension 連線
        self.pending = {}           # cmd_id -> asyncio.Future（extension 的回應）

    async def handle(self, connection):
        # 握手：extension 會送 ext_hello；pilot client 直接送指令
        first = None
        try:
            first_msg = await asyncio.wait_for(connection.recv(), timeout=5)
            first = json.loads(first_msg)
        except Exception:
            return

        is_ext = first.get("action") == "ext_hello"
        if is_ext:
            await self._accept_ext(connection)
        else:
            # pilot client：處理第一筆 + 後續
            await self._route_pilot(connection, first)
            async for raw in connection:
                try:
                    req = json.loads(raw)
                except Exception as e:
                    try:
                        await connection.send(json.dumps({"error": str(e)}))
                    except Exception:
                        pass
                    continue
                await self._route_pilot(connection, req)

    async def _accept_ext(self, ws):
        log.info("extension connected")
        # 踢掉舊 extension
        if self.ext_ws and self.ext_ws is not ws and is_open(self.ext_ws):
            try:
                await self.ext_ws.close()
            except Exception:
                pass
        self.ext_ws = ws
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                action = msg.get("action")
                if action == "pong":
                    continue
                if "id" in msg:
                    fut = self.pending.get(msg["id"])
                    if fut and not fut.done():
                        fut.set_result(msg)
        except Exception:
            pass
        finally:
            if self.ext_ws is ws:
                self.ext_ws = None
                log.info("extension disconnected")

    async def _route_pilot(self, ws, req):
        cmd_id = req.get("id")
        action = req.get("action")
        log.info("cmd from pilot: %s", action)

        # 等 extension 連線（SW 被 MV3 暫停時，alarm 最多 30s 內喚醒重連）
        deadline = time.time() + 40
        while not is_open(self.ext_ws):
            if time.time() > deadline:
                await ws.send(json.dumps({"id": cmd_id, "error": "extension offline"}))
                return
            await asyncio.sleep(0.2)

        fut = asyncio.get_event_loop().create_future()
        self.pending[cmd_id] = fut
        try:
            await self.ext_ws.send(json.dumps(req))
            resp = await asyncio.wait_for(fut, timeout=25)
            await ws.send(json.dumps(resp))
            log.info("cmd done: %s", action)
        except asyncio.TimeoutError:
            await ws.send(json.dumps({"id": cmd_id, "error": "extension timeout"}))
        except Exception as e:
            log.error("route error: %s", e)
            await ws.send(json.dumps({"id": cmd_id, "error": str(e)}))
        finally:
            self.pending.pop(cmd_id, None)

    async def ping_loop(self):
        """定期 ping extension，保持 MV3 service worker 存活"""
        while True:
            await asyncio.sleep(15)
            if is_open(self.ext_ws):
                try:
                    await self.ext_ws.send(json.dumps({"action": "ping"}))
                except Exception:
                    pass


async def main():
    log.info("chrome-pilot bridge v15 on port %d", OP_PORT)
    bridge = Bridge()
    async with websockets.serve(bridge.handle, "127.0.0.1", OP_PORT):
        asyncio.create_task(bridge.ping_loop())
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
