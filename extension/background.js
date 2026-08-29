/* Hermes Chrome Pilot — MV3 service worker
 * MV3 SW 會在 ~30s 後休眠 → WebSocket 被殺。用 chrome.alarms (60s) 喚醒維持連線。
 */
const BRIDGE = "ws://127.0.0.1:8791";

let ws = null;

function isAlive() {
  return ws && ws.readyState === WebSocket.OPEN;
}

function connect() {
  if (isAlive()) return;
  try { ws.close(); } catch {}
  ws = new WebSocket(BRIDGE);
  ws.onopen = () => {
    console.log("[pilot] connected");
    ws.send(JSON.stringify({ event: "ready" }));
  };
  ws.onmessage = async (e) => {
    let req;
    try { req = JSON.parse(e.data); } catch { return; }
    if (!req.id || !req.action) { return; }
    let result;
    try {
      result = await handle(req);
      ws.send(JSON.stringify({ id: req.id, ...result }));
    } catch (err) {
      ws.send(JSON.stringify({ id: req.id, error: String(err && err.message || err) }));
    }
  };
  ws.onclose = () => {
    console.log("[pilot] closed, scheduling reconnect");
    try { ws.close(); } catch {}
    setTimeout(connect, 3000);
  };
  ws.onerror = (err) => { console.log("[pilot] ws error", err); };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
  connect();
});
chrome.runtime.onStartup.addListener(connect);
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "keepalive") connect();
});

/* ---------- helpers ---------- */
async function listTabs() {
  return chrome.tabs.query({});
}

async function resolveTab(req) {
  const tabs = await listTabs();
  if (req.tab === undefined || req.tab === null) {
    const active = tabs.find((t) => t.active);
    if (active) return active;
    return tabs[0];
  }
  // 先找「可顯示 tab」的列表（與 `tabs` 指令一致：排除 chrome:// 與 extension 頁）
  const visible = tabs.filter((t) => t.url && !t.url.startsWith("chrome://") && !t.url.startsWith("chrome-extension://"));
  const t = visible[req.tab];
  if (!t) throw new Error(`tab index ${req.tab} not found (${visible.length} visible tabs)`);
  return t;
}

/* ---------- helpers ---------- */
async function handle(req) {
  switch (req.action) {
    case "status": {
      const tabs = await listTabs();
      const active = tabs.find((t) => t.active);
      return {
        ok: true,
        version: chrome.runtime.getManifest().version,
        tabs: tabs.length,
        active: active ? { url: active.url, title: active.title } : null,
      };
    }

    case "tabs": {
      const tabs = await listTabs();
      let rows = tabs
        .filter((t) => t.url && !t.url.startsWith("chrome://") && !t.url.startsWith("chrome-extension://"))
        .map((t, i) => ({ index: i, url: t.url, title: t.title, active: !!t.active }));
      if (req.filter) {
        const f = String(req.filter).toLowerCase();
        rows = rows.filter((r) => (r.url + " " + (r.title || "")).toLowerCase().includes(f));
      }
      return { ok: true, count: rows.length, tabs: rows };
    }

    case "open": {
      const t = await chrome.tabs.create({ url: req.url, active: !req.new_tab });
      return { ok: true, tabId: t.id, url: t.url };
    }

    case "nav": {
      const tab = await resolveTab(req);
      await chrome.tabs.update(tab.id, { url: req.url });
      await waitTabLoad(tab.id, 30000);
      const t2 = await chrome.tabs.get(tab.id);
      return { ok: true, url: t2.url, title: t2.title, status: t2.status };
    }

    case "eval": {
      const tab = await resolveTab(req);
      const value = await debugEval(tab.id, req.js);
      return { ok: true, value };
    }

    case "click": {
      const tab = await resolveTab(req);
      const el = await debugEval(
        tab.id,
        `(function(){var el=document.querySelector(${JSON.stringify(req.selector)});if(!el)return{found:false};el.scrollIntoView({block:'center'});el.click();return{found:true,tag:el.tagName,text:(el.innerText||el.value||'').slice(0,120)};})()`
      );
      if (!el || el.found === false) throw new Error("selector not found: " + req.selector);
      return { ok: true, clicked: el.tag, text: el.text };
    }

    case "type": {
      const tab = await resolveTab(req);
      const el = await debugEval(
        tab.id,
        `(function(){
          var el=document.querySelector(${JSON.stringify(req.selector)});
          if(!el) return {found:false};
          el.focus();
          var proto = el.tagName==='TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          var setter = Object.getOwnPropertyDescriptor(proto,'value').set;
          setter.call(el, ${JSON.stringify(req.text)});
          el.dispatchEvent(new Event('input',{bubbles:true}));
          el.dispatchEvent(new Event('change',{bubbles:true}));
          return {found:true,tag:el.tagName};
        })()`
      );
      if (!el || el.found === false) throw new Error("selector not found: " + req.selector);
      return { ok: true, typed: req.text.length, tag: el.tag };
    }

    case "screenshot": {
      const tab = await resolveTab(req);
      return await captureShot(tab.id);
    }

    default:
      throw new Error("unknown action: " + req.action);
  }
}

function waitTabLoad(tabId, ms) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = async () => {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t.status === "complete") return resolve();
      } catch { return resolve(); }
      if (Date.now() - start >= ms) return resolve();
      setTimeout(tick, 400);
    };
    tick();
  });
}

/* chrome.debugger 的 Runtime.evaluate 在 devtools 上下文執行，不受頁面 CSP 限制
   （chrome.scripting 注入的 eval 在 MAIN world 會被嚴格 CSP 擋） */
async function debugEval(tabId, expression) {
  await ensureDebugger(tabId);
  try {
    const res = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: expression,
      returnByValue: true,
      generatePreview: true,
    });
    if (res.exceptionDetails) {
      throw new Error((res.exceptionDetails.exception && res.exceptionDetails.exception.description)
        || res.exceptionDetails.text || "evaluation error");
    }
    const r = res.result || {};
    return r.type === "undefined" ? null : r.value;
  } finally {
    try { await chrome.debugger.detach({ tabId }); } catch {}
  }
}

/* attach 前先清舊殘留（SW 被殺時 finally 沒跑到會留下 attached 狀態） */
async function ensureDebugger(tabId) {
  try { await chrome.debugger.detach({ tabId }); } catch {}
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (e) {
    if (!String(e).includes("already attached")) throw e;
    // 已被（我們）附加，繼續使用
  }
}

async function captureShot(tabId) {
  await ensureDebugger(tabId);
  try {
    const { data } = await chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
    });
    return { ok: true, png_base64: data };
  } finally {
    try { await chrome.debugger.detach({ tabId }); } catch {}
  }
}
