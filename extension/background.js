/* Hermes Chrome Pilot v2 — MV3 service worker
 * 透過 chrome.debugger API 控制（extension 控制，非直接 CDP）
 * 連上 8790 bridge，接收指令、執行、回傳結果
 */
const BRIDGE = "ws://127.0.0.1:8790";
let ws = null;
const debuggerTabs = new Set();

function wsAlive() {
  return ws && ws.readyState === WebSocket.OPEN;
}

function connect() {
  if (wsAlive()) return;
  try { ws && ws.close(); } catch {}
  ws = new WebSocket(BRIDGE);
  ws.onopen = () => {
    console.log("pilot extension connected");
    try { ws.send(JSON.stringify({ action: "ext_hello", v: 2 })); } catch {}
  };
  ws.onclose = () => {
    console.log("pilot WS closed, reconnecting");
    setTimeout(connect, 1500);
  };
  ws.onerror = (e) => console.log("pilot WS error", e.message || "unknown");
  ws.onmessage = (e) => {
    let req;
    try { req = JSON.parse(e.data); } catch { return; }
    if (req.action === "ping") {
      if (wsAlive()) try { ws.send(JSON.stringify({ action: "pong" })); } catch {}
      return;
    }
    handleReq(req).catch((err) => {
      try { ws.send(JSON.stringify({ id: req.id, error: err.message })); } catch {}
    });
  };
}

/* MV3 service worker 會 30s 沒活動就暫停 → WS 斷線
 * 用 alarms 定期喚醒 + 檢查連線（alarms 是最靠譜的保活方式）
 * 開發模式最小值 = 0.5 分鐘（30秒） */
chrome.alarms.create("pilot-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "pilot-keepalive") connect();
});

/* 啟動時 + 安裝/升級時都連一次 */
chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());

/* 暴露給外部（bridge 可用 CDP 對 SW target 呼叫 __pilot.connect() 喚醒）
 * 因為 SW 被暫停後不會自己重連，bridge 下指令前先喚醒 */
globalThis.__pilot = {
  version: "v3",
  connect,
  isAlive: wsAlive,
  handleReq
};

async function handleReq(req) {
  const id = req.id;
  let tabId = req.tabId;

  // 找 tab：優先 tabId > urlPattern > 第一個 page tab
  async function resolveTab() {
    if (tabId != null) {
      const t = await chrome.tabs.get(tabId).catch(() => null);
      if (t) return t;
    }
    const tabs = await chrome.tabs.query({});
    if (req.urlPattern) {
      const hit = tabs.find((t) => (t.url || "").includes(req.urlPattern) && t.type === "page");
      if (hit) return hit;
    }
    return tabs.find((t) => t.type === "page") || null;
  }

  const action = req.action;

  if (action === "open") {
    const t = await chrome.tabs.create({ url: req.url });
    // 等頁面 load 完成
    await waitForLoad(t.id);
    tabId = t.id;
    return reply(id, { tabId: t.id, url: t.url });
  }

  if (action === "navigatetab") {
    const t = await resolveTab();
    if (!t) throw new Error("no tab");
    const prevLoad = t.status;
    await chrome.tabs.update(t.id, { url: req.url });
    await waitForLoad(t.id);
    return reply(id, { tabId: t.id, url: req.url });
  }

  if (action === "eval") {
    const t = await resolveTab();
    if (!t) throw new Error("no tab");
    const value = await cdpEval(t.id, req.expression);
    return reply(id, { value, tabId: t.id });
  }

  if (action === "click") {
    const t = await resolveTab();
    if (!t) throw new Error("no tab");
    const result = await realClick(t.id, req.selector, req.text);
    return reply(id, { result, tabId: t.id });
  }

  if (action === "key") {
    const t = await resolveTab();
    if (!t) throw new Error("no tab");
    await chrome.windows.update(t.windowId, { focused: true });
    const seq = keySequence(req.keys || "Enter");
    await ensureDebugger(t.id);
    for (const ev of seq) {
      await cdpSend(t.id, "Input.dispatchKeyEvent", ev);
      await new Promise((r) => setTimeout(r, 60));
    }
    return reply(id, { ok: true, keys: req.keys, tabId: t.id });
  }

  if (action === "type") {
    const t = await resolveTab();
    if (!t) throw new Error("no tab");
    await chrome.windows.update(t.windowId, { focused: true });
    await ensureDebugger(t.id);
    const text = req.text || "";
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      await cdpSend(t.id, "Input.dispatchKeyEvent", {
        type: "keyDown", text: ch, key: ch, unmodifiedText: ch,
        windowsVirtualKeyCode: code, nativeVirtualKeyCode: code
      });
      await new Promise((r) => setTimeout(r, 40));
    }
    return reply(id, { ok: true, len: text.length, tabId: t.id });
  }

  if (action === "tabs") {
    const tabs = await chrome.tabs.query({});
    return reply(id, { tabs: tabs.filter(t => t.type === "page").map(t => ({ tabId: t.id, url: t.url, title: t.title, active: t.active })) });
  }

  if (action === "status") {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => x.type === "page" && x.active) || tabs.find((x) => x.type === "page") || tabs[0];
    return reply(id, { connected: true, tabId: t ? t.id : null, url: t ? t.url : null, title: t ? t.title : null, tabs: tabs.length });
  }

  return reply(id, { error: "unknown action: " + action });
}

function reply(id, obj) {
  obj.id = id;
  ws.send(JSON.stringify(obj));
}

/* 等 tab load 完成（chrome.tabs.onUpdated） */
function waitForLoad(tabId, timeout = 20000) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => finish(), timeout);
    const onLoad = (tId, info) => {
      if (tId === tabId && info.status === "complete") finish();
    };
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onLoad);
      // 多等一小段讓 SPA 渲染
      setTimeout(resolve, 800);
    }
    chrome.tabs.onUpdated.addListener(onLoad);
    // 若 tab 已 complete，直接回
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === "complete") finish();
    }).catch(() => finish());
  });
}

async function ensureDebugger(tabId) {
  if (debuggerTabs.has(tabId)) return;
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      debuggerTabs.add(tabId);
      resolve();
    });
  });
}

function detach(tabId) {
  if (debuggerTabs.has(tabId)) {
    chrome.debugger.detach({ tabId }, () => debuggerTabs.delete(tabId));
  }
}

function cdpSend(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(res);
    });
  });
}

/* 鍵盤組合 -> CDP Input.dispatchKeyEvent 事件序列
 * 支援: "Enter", "Down", "Tab", "ctrl+c" 等 */
const VK = {
  Enter: 13, Tab: 9, Backspace: 8, Delete: 46,
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
  Escape: 27, Space: 32, F1: 112, F2: 113, F3: 114, F4: 115,
  F5: 116, F6: 117, F7: 118, F8: 119, F9: 120, F10: 121,
  F11: 122, F12: 123
};
const CODE_MAP = {
  Enter: "Enter", Tab: "Tab", Backspace: "Backspace", Delete: "Delete",
  ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight", Escape: "Escape", Space: "Space"
};

function keySequence(spec) {
  const parts = String(spec).split("+");
  const main = parts.pop();
  const MODKEYS = { ctrl: "Control", alt: "Alt", shift: "Shift", meta: "Meta", cmd: "Meta", win: "Meta" };
  const mods = parts.map((p) => MODKEYS[p.toLowerCase()] || p);
  const vk = VK[main] || (/[A-Z]/.test(main) ? main.toUpperCase().charCodeAt(0) : main.charCodeAt(0) || 0);
  const code = CODE_MAP[main] || main;
  return [
    { type: "keyDown", code, key: main, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods.length ? mods.join(",") : undefined, text: /[a-z0-9]/i.test(main) ? main : undefined },
    { type: "keyUp", code, key: main, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods.length ? mods.join(",") : undefined }
  ];
}

async function cdpEval(tabId, expression, timeout = 15000) {
  await ensureDebugger(tabId);
  const t0 = Date.now();
  try {
    while (Date.now() - t0 < timeout) {
      try {
        const res = await cdpSend(tabId, "Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise: true
        });
        if (res && res.result) return res.result.value;
      } catch (e) {
        // tab 正在導覽時 evaluate 會失敗 → 重試
      }
      await sleep(500);
    }
    throw new Error("eval timeout");
  } finally {
    detach(tabId);
  }
}

/* 真實滑鼠事件點擊：
 * 1. JS 拿按鈕中心座標（getBoundingClientRect + scrollTop）
 * 2. chrome.debugger Input.dispatchMouseEvent mousePressed/mouseReleased
 * 3. 若找不到 selector，回傳 {found:false}
 */
async function realClick(tabId, selector, text, timeout = 15000) {
  await ensureDebugger(tabId);
  const t0 = Date.now();
  let lastErr = null;
  try {
    while (Date.now() - t0 < timeout) {
      try {
        // 1. 拿座標 — 選「最具體(文字最短)+可見+elementFromPoint驗證」的候選元素
        const probe = await cdpSend(tabId, "Runtime.evaluate", {
          expression: `(() => {
            const norm = s => (s || "").trim().replace(/\\s+/g, " ");
            const isVisible = el => {
              const r = el.getBoundingClientRect();
              if (r.width < 2 || r.height < 2) return false;
              // checkVisibility() 正確處理 position:fixed popover（offsetParent 會為 null）
              if (el.checkVisibility && !el.checkVisibility()) return false;
              const cs = getComputedStyle(el);
              if (cs.visibility === "hidden" || cs.display === "none") return false;
              return true;
            };
            const inViewport = el => {
              const r = el.getBoundingClientRect();
              return r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight + 2 && r.right <= window.innerWidth + 2;
            };
            let el = null;
            ${text ? `
              const cands = Array.from(document.querySelectorAll(
                'button, a, [role="menuitem"], [role="menuitemcheckbox"], [role="option"], [role="tab"], [role="dialog"] label, .Box label'
              ));
              const matches = cands.filter(c =>
                norm(c.textContent || c.getAttribute("aria-label") || "").includes(${JSON.stringify(text)}));
              const vis = matches.filter(isVisible);
              const pool = vis.length ? vis : matches;
              // 最具體 = 文字最短（排除大容器），同長時取葉子(子元素少)
              pool.sort((a, b) => {
                const la = norm(a.textContent || "").length, lb = norm(b.textContent || "").length;
                if (la !== lb) return la - lb;
                return a.children.length - b.children.length;
              });
              el = pool[0] || null;
            ` : `
              el = document.querySelector(${JSON.stringify(selector)});
            `}
            if (!el || !isVisible(el)) return { found: false, reason: "not-visible" };
            // 只在元素跑出 viewport 時才 scroll；選單項目已可見就絕不 scroll（避免頁面移動導致座標過期/選單關閉）
            if (!inViewport(el)) {
              el.scrollIntoView({ block: "center" });
            }
            return { needsSettle: !inViewport(el) ? true : false };
          })()`,
          returnByValue: true
        });
        const info0 = probe && probe.result ? probe.result.value : null;
        if (!info0 || info0.reason) {
          detach(tabId);
          return { found: false, error: info0 && info0.reason ? info0.reason : "not visible" };
        }
        // scroll 後等頁面穩定再量最終座標
        if (info0.needsSettle) await sleep(250);

        // 2. 量最終座標 + elementFromPoint 驗證
        const probe2 = await cdpSend(tabId, "Runtime.evaluate", {
          expression: `(() => {
            const norm = s => (s || "").trim().replace(/\\s+/g, " ");
            const isVisible = el => {
              const r = el.getBoundingClientRect();
              return r.width >= 2 && r.height >= 2 &&
                     (!el.checkVisibility || el.checkVisibility()) &&
                     getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none";
            };
            let el = null;
            ${text ? `
              const cands = Array.from(document.querySelectorAll(
                'button, a, [role="menuitem"], [role="menuitemcheckbox"], [role="option"], [role="tab"], [role="dialog"] label, .Box label'
              ));
              const matches = cands.filter(c =>
                norm(c.textContent || c.getAttribute("aria-label") || "").includes(${JSON.stringify(text)}));
              const vis = matches.filter(isVisible);
              const pool = vis.length ? vis : matches;
              pool.sort((a, b) => {
                const la = norm(a.textContent || "").length, lb = norm(b.textContent || "").length;
                if (la !== lb) return la - lb;
                return a.children.length - b.children.length;
              });
              el = pool[0] || null;
            ` : `
              el = document.querySelector(${JSON.stringify(selector)});
            `}
            if (!el || !isVisible(el)) return { found: false };
            const r = el.getBoundingClientRect();
            const x = r.left + r.width / 2, y = r.top + r.height / 2;
            const hit = document.elementFromPoint(x, y);
            const verified = !!(hit && (hit === el || el.contains(hit) || hit.contains(el)));
            return { found: verified, verified, x, y,
                     tag: el.tagName, text: norm(el.textContent || el.value || "").slice(0, 120),
                     disabled: el.disabled,
                     hitTag: hit ? hit.tagName : null,
                     hitCls: hit ? (hit.className || "").toString().slice(0, 80) : null };
          })()`,
          returnByValue: true
        });
        const info = probe2 && probe2.result ? probe2.result.value : null;
        if (!info || !info.verified) {
          detach(tabId);
          if (Date.now() - t0 > timeout - 1500) return { found: false, error: "not visible/verified", info };
          continue;
        }

        // 2. 真實滑鼠事件
        await sleep(200); // 等 scrollIntoView 生效
        await cdpSend(tabId, "Input.dispatchMouseEvent", {
          type: "mousePressed", button: "left", x: info.x, y: info.y,
          clickCount: 1, buttons: 1
        });
        await sleep(80);
        await cdpSend(tabId, "Input.dispatchMouseEvent", {
          type: "mouseReleased", button: "left", x: info.x, y: info.y,
          clickCount: 1, buttons: 0
        });
        detach(tabId);
        return { found: true, clicked: true, x: info.x, y: info.y, tag: info.tag, text: info.text, disabled: !!info.disabled };
      } catch (e) {
        lastErr = e;
      }
      await sleep(500);
    }
    throw new Error("click timeout: " + (lastErr ? lastErr.message : ""));
  } catch (e) {
    detach(tabId);
    throw e;
  }
}

/* tab 關閉時 detach */
chrome.tabs.onRemoved.addListener((tabId) => detach(tabId));
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) debuggerTabs.delete(source.tabId);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
connect();
console.log("pilot extension v2 loaded");
