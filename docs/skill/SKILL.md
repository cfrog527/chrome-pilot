---
name: chrome-pilot
description: 控制已登入真實 Chrome 的 MV3 extension + 本機 WS bridge（免 CDP 彈窗）。
version: 2.0.0
author: Hermes Agent
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [Chrome, Extension, CDP, Automation, Browser, MV3]
    related_skills: []
---

# Chrome Pilot

## When to Use
- 要控制**使用者已登入的真實 Chrome/Chromium**（操作 Canva/Gamma/GitHub 等已登入 session）
- 想用 `browser_exec` 但卡在「Allow remote debugging」彈窗、不想搶滑鼠鍵盤時
- 需要本機 agent 驅動瀏覽器：開 tab、跳轉、eval JS、點按鈕、填表、按鍵

讓 Hermes 直接控制**使用者已登入的真實 Chrome/Chromium**（MV3 extension + 本機 WebSocket bridge）。
比 `browser_exec`（CDP remote-debugging）好處：不觸發「Allow remote debugging」彈窗、不搶滑鼠鍵盤、
能操作已登入的真實 session，且用**真實** `Input.dispatch*Event`（`isTrusted`）繞過只認真實事件的 SPA。

**repo**: https://github.com/cfrog527/chrome-pilot（public）

## 位置
```
~/.hermes/scripts/chrome-pilot/
├── chrome_pilot.py   # bridge daemon（WS 8790，同時接 pilot + extension）
├── pilot.py          # Hermes 端 CLI（用 venv 跑）
├── venv/             # python venv（websockets）
├── deploy/           # systemd unit + chromium.d
└── extension/
    ├── manifest.json # MV3: tabs/storage/alarms/debugger/notifications/windows
    ├── background.js # MV3 service worker（chrome.tabs + chrome.debugger）
    └── icon.png
```

## 使用（Hermes 端）
```
P=~/.hermes/scripts/chrome-pilot
$P/venv/bin/python $P/pilot.py status                     # 連線 + active tab
$P/venv/bin/python $P/pilot.py tabs [--filter 文字]       # 列出所有 tab
$P/venv/bin/python $P/pilot.py open <url>                 # 開新 tab（回 tabId）
$P/venv/bin/python $P/pilot.py navigate <url> [--tab N]
$P/venv/bin/python $P/pilot.py eval <js> [--tab N]        # 回傳值
$P/venv/bin/python $P/pilot.py click [--selector S] [--text T] [--tab N]
$P/venv/bin/python $P/pilot.py type <text> [--tab N]      # 逐字鍵入
$P/venv/bin/python $P/pilot.py key <keys> [--tab N]       # Enter / Down / ctrl+c
$P/venv/bin/python $P/pilot.py reload                     # 遠端 chrome.runtime.reload()
$P/venv/bin/python $P/pilot.py raw '{"action":"tabs"}'
```
`--tab N` = **chrome.tabs 數字 id**（`tabs`/`open` 回傳的 tabId），不是 index；不帶 = active tab。
extension actions（raw 可送）：open / navigatetab / eval / click / key / type / tabs / status / reload。

## 啟動 bridge（systemd user service，已常駐）
```
systemctl --user status chrome-pilot-bridge    # 狀態
systemctl --user restart chrome-pilot-bridge   # 重啟
```
驗證：`ss -tlnp | grep ':8790'`；extension 在線時 journal 有 `extension connected`。

## extension 自動載入（/etc/chromium.d/hermes-pilot）
任何 chromium 啟動都自動載入（Debian/EndeavourOS wrapper 會 source /etc/chromium.d/*）。
臨時實例（--user-data-dir）才需手動加 `--load-extension=$P/extension`。

## 關鍵設計（踩過的坑）
1. **eval/click/type 走 `chrome.debugger`（CDP），不用 `chrome.scripting`**：
   scripting 注入的 eval 在 MAIN world 被頁面 CSP（無 unsafe-eval）擋。
2. **真實輸入事件**：click 用 `Input.dispatchMouseEvent`（mouseMoved/Pressed/Released）、
   key/type 用 `Input.dispatchKeyEvent`。React/Preact 只認 `isTrusted` 事件，
   `el.click()`/`dispatchEvent` 常被忽略或被 ad blocker 攔。
   點前自動 `chrome.windows.update({focused:true})`（背景 Chrome 的 Input 事件需 focus）。
3. **`checkVisibility()` 判可見**：`position:fixed` popover（GitHub action-menu）
   `offsetParent === null`，用 offsetParent 判斷會誤判不可見。
4. **`ensureDebugger`**：attach 前先 detach 清殘留（"Another debugger is already attached"）。
5. **MV3 SW 休眠**：WS ~30s 無活動被殺 → `chrome.alarms`(0.5min) + bridge 15s ping 喚醒重連。
6. **bridge 只認一個 extension**：多 Chrome 實例同載會搶 worker slot，一次只開一個。
7. **改 extension code 後重新載入**：`pilot.py reload`（chrome.runtime.reload()，
   開發模式 SW 從磁碟讀 code，~10s 重連）。SW 版本沒變（`__pilot.version` 不變）時，
   清 `~/.config/chromium/Default/Service Worker/CacheStorage` + `Code Cache` 後重啟 Chrome。
8. **SW MV3 30s 休眠期間** `/json` 看不到 SW target — 正常；bridge ping 會喚醒。

## GitHub 改 visibility（免 2FA）
`POST /repos/<owner>/<repo>/settings/set_visibility` form 需要 **`verify` 欄位（= repo 全名）**，
缺了回 "You must type the name of the repository to confirm."（常被誤判成要 2FA）。
payload：`authenticity_token`（form 內已有）+ `visibility=public|private` +
`new-visibility=public|private` + `verify=<owner>/<repo>`。用頁面內 `form.submit()`
（加 hidden inputs）即可，成功後 `api.github.com/repos/<owner>/<repo>` 回 `private:false`。

## 安全
- bridge 只綁 127.0.0.1；extension 只接受本機 WS。
- `debugger` 權限執行中該 tab 頂部短暫顯示「正在調試」列。
- 絕不用 bridge 輸送密碼/驗證碼；OTP 由使用者手動填（1Password），bridge 只點提交。

## 驗證閉環（form 測試）
建 `pilot_form.html`（input#name + button#btn + div#out，body 內 script 監聽 click 寫 `out=clicked:<name>`）：
`click --selector "#name"` → `type --text marvin`（pilot.py type 用法是位置參數）→
`click --selector "#btn"` → `eval 'document.getElementById("out").textContent'` 應回 `clicked:marvin`。
注意：test HTML 的 script 要在 `<body>` 內。
