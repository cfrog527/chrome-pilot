#!/usr/bin/env python3
"""chrome-pilot bridge：Hermes operator (:8790) <-> Chrome extension (:8791)

- operator WS：Hermes 端（pilot.py）；收 JSON command → 暫存；extension 在線時立即轉發
- worker WS：Chrome extension service worker 連線；收到轉發的 command → 執行
- extension 斷線時命令排隊（最多 200 筆），回線後依序送達
"""
import asyncio
import json
import logging

import websockets

OP_PORT = 8790
WRK_PORT = 8791
MAX_QUEUE = 200

log = logging.getLogger("chrome-pilot")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


class Bridge:
    def __init__(self):
        self.worker = None          # extension 的 WS
        self.worker_lock = asyncio.Lock()
        self.pending = []           # 等待 extension 的命令
        self.op_done = {}           # cmd id -> operator 端 Future

    async def op_handler(self, ws):
        try:
            async for msg in ws:
                try:
                    req = json.loads(msg)
                except json.JSONDecodeError:
                    await ws.send(json.dumps({"error": "invalid JSON"}))
                    continue
                cid = req.get("id")
                if cid is None:
                    # 不帶 id：fire-and-forget
                    log.info("cmd (no id): %s", req.get("action"))
                    self._enqueue(req)
                    continue
                fut = asyncio.get_running_loop().create_future()
                self.op_done[cid] = fut
                log.info("cmd #%s: %s", cid, req.get("action"))
                self._enqueue(req)
                try:
                    resp = await asyncio.wait_for(fut, timeout=req.get("timeout", 120))
                except asyncio.TimeoutError:
                    self.op_done.pop(cid, None)
                    await ws.send(json.dumps({"id": cid, "error": "timeout"}))
                    continue
                self.op_done.pop(cid, None)
                await ws.send(json.dumps(resp))
        except websockets.ConnectionClosed:
            pass
        finally:
            # 清除該 operator 未完成 future
            for f in list(self.op_done.values()):
                if not f.done():
                    f.cancel()
            log.info("operator disconnected")

    def _enqueue(self, req):
        if self.worker is not None:
            asyncio.ensure_future(self._dispatch(req))
        else:
            if len(self.pending) < MAX_QUEUE:
                self.pending.append(req)
                log.info("queued (extension offline), pending=%d", len(self.pending))
            else:
                log.warning("queue full, drop %s", req.get("id"))

    async def _dispatch(self, req):
        async with self.worker_lock:
            if self.worker is None:
                # extension 已斷線 → 放回隊列
                self.pending.append(req)
                return
            try:
                await self.worker.send(json.dumps(req))
            except Exception as e:
                log.warning("dispatch failed: %s", e)
                self.pending.append(req)

    def worker_reply(self, resp):
        cid = resp.get("id")
        if cid in self.op_done:
            self.op_done[cid].set_result(resp)
        else:
            log.info("reply for unknown/queued id=%s", cid)

    async def wrk_handler(self, ws):
        self.worker = ws
        log.info("extension connected")
        try:
            # 先送排隊命令
            while self.pending:
                req = self.pending.pop(0)
                await ws.send(json.dumps(req))
            async for msg in ws:
                try:
                    resp = json.loads(msg)
                except json.JSONDecodeError:
                    continue
                if "id" in resp and "error" not in resp:
                    self.worker_reply(resp)
                else:
                    log.info("ext: %s", msg[:200])
        except websockets.ConnectionClosed:
            pass
        finally:
            self.worker = None
            log.info("extension disconnected")


async def main():
    bridge = Bridge()
    async with websockets.serve(bridge.op_handler, "127.0.0.1", OP_PORT), \
             websockets.serve(bridge.wrk_handler, "127.0.0.1", WRK_PORT):
        log.info("bridge listening: operator=%d worker=%d", OP_PORT, WRK_PORT)
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
