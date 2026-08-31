# Hermes Chrome Pilot

讓 Hermes Agent 直接控制**你已登入的真實 Chrome/Chromium**（MV3 extension + 本機 WebSocket bridge）。
比 Browser-Use / CDP remote-debugging 好處：

- 不觸發「Allow remote debugging」彈窗
- 不搶滑鼠鍵盤（背景操作）
- 能操作已登入的真實 session（Canva / Gamma / GitHub 等帳號）
- 用**真實** `Input.dispatchMouseEvent` / `dispatchKeyEvent`（`isTrusted`），繞過只認真實事件的 SPA 框架（React/Preact）

## 架構

```
pilot.py (Hermes CLI)
   │  ws://127.0.0.1:8790
   ▼
chrome_pilot.py  ── 本機 WS 中繼（bridge，127.0.0.1 only）
   │  （同一個 8790）
   ▼
extension/background.js  ── MV3 service worker
   │  chrome.debugger（CDP）+ chrome.tabs
   ▼
你的真實 Chrome/Chromium
```

> 只有一個 port（8790）。bridge 同時接 pilot client 與 extension；
> extension 在線時把指令轉發，離線時指令排隊（≤200）。

## 安裝

```bash
# 1. venv
cd ~/.hermes/scripts/chrome-pilot
python3 -m venv venv && venv/bin/pip install websockets

# 2. bridge 常駐（systemd user service）
mkdir -p ~/.config/systemd/user
sed "s|/home/cfrog527|$HOME|g" deploy/chrome-pilot-bridge.service \
  > ~/.config/systemd/user/chrome-pilot-bridge.service
systemctl --user daemon-reload
systemctl --user enable --now chrome-pilot-bridge.service

# 3. extension 自動載入（任何 chromium 啟動都載入）
sudo cp deploy/hermes-pilot-chromium.d /etc/chromium.d/hermes-pilot
sudo sed -i "s|/home/cfrog527|$HOME|g" /etc/chromium.d/hermes-pilot
# （Debian/EndeavourOS 的 chromium wrapper 會 source /etc/chromium.d/*）
```

重啟 Chrome 後 extension 自動接上 bridge（30s 內）。
驗證：`ss -tlnp | grep ':8790'` + `pilot.py status` 回 `connected: true`。

## 使用（Hermes 端）

```bash
P=~/.hermes/scripts/chrome-pilot
PY=$P/venv/bin/python

$PY $P/pilot.py status                     # 連線狀態 + 目前 active tab
$PY $P/pilot.py tabs [--filter 文字]       # 列出所有 tab（含 type）
$PY $P/pilot.py open  <url>                # 開新 tab（回 tabId）
$PY $P/pilot.py navigate <url> [--tab N]   # 導航
$PY $P/pilot.py eval   <js>   [--tab N]    # 執行 JS（回傳值）
$PY $P/pilot.py click  [--selector S] [--text T] [--tab N]  # 真實滑鼠點擊
$PY $P/pilot.py type   <text> [--tab N]    # 逐字鍵入
$PY $P/pilot.py key    <keys> [--tab N]    # 按鍵（Enter / Down / ctrl+c …）
$PY $P/pilot.py reload                     # 遠端 chrome.runtime.reload()
$PY $P/pilot.py raw   '{"action":"tabs"}'  # 送原始指令
```

- `--tab N` = **chrome.tabs 的數字 id**（`tabs` / `open` / `status` 回傳的 `tabId`），不是 index。不帶 = active / 第一個 page tab。
- `click --text` 用**文字**匹配（選單項目、按鈕），`--selector` 用 CSS selector；兩者可併用（selector 優先用，找不到再用 text 搜尋 button/a/`[role=menuitem]`）。
- `key` 支援組合鍵：`ctrl+c`、`ctrl+shift+t`、`alt+F4`；單鍵：`Enter`、`Tab`、`Down`、`Escape`、`F5`、字母。

### 範例：把 GitHub repo 改 public（免 2FA）

```bash
$PY $P/pilot.py open "https://github.com/<owner>/<repo>/settings"
# 取回 tabId 後：
$PY $P/pilot.py eval '(() => {
  const f = document.querySelector("form[action*=set_visibility]");
  f.insertAdjacentHTML("beforeend", "<input type=hidden name=visibility value=public>");
  f.insertAdjacentHTML("beforeend", "<input type=hidden name=new-visibility value=public>");
  f.insertAdjacentHTML("beforeend", "<input type=hidden name=verify value=<owner>/<repo>>");
  f.submit();
})()' --tab <tabId>
```

> **GitHub `set_visibility` form 需要 `verify` 欄位**（值 = repo 全名）。
> 缺了會回 "You must type the name of the repository to confirm."（常被誤判成要 2FA）。
> 加上 `verify` 後直接成功，**不需要驗證碼**。

## 組件

| 檔案 | 作用 |
|---|---|
| `extension/manifest.json` | MV3，permissions: tabs/storage/alarms/debugger/notifications/windows |
| `extension/background.js` | service worker，`chrome.tabs` + `chrome.debugger` 執行指令 |
| `chrome_pilot.py` | 本機 WS 中繼（bridge）；每 15s ping 維持 SW 存活；離線時排隊 |
| `pilot.py` | Hermes 端 CLI |
| `deploy/` | systemd unit + chromium.d 安裝檔 |

### Extension actions（`pilot.py raw` 可直接送）

`open` · `navigatetab` · `eval` · `click` · `key` · `type` · `tabs` · `status` · `reload`

## 關鍵設計（踩過的坑）

1. **eval/click/type 走 `chrome.debugger`（CDP），不用 `chrome.scripting`**：
   `chrome.scripting` 注入的 `eval` 在 MAIN world 會被頁面 CSP（無 `unsafe-eval`）擋；
   `chrome.debugger` 的 `Runtime.evaluate` 不受 CSP 限制。
2. **真實輸入事件**：`click` 用 `Input.dispatchMouseEvent`（mouseMoved/Pressed/Released 序列）、
   `key`/`type` 用 `Input.dispatchKeyEvent`。SPA（React/Preact）只認 `isTrusted` 事件，
   `el.click()` / `dispatchEvent` 常被忽略或被 ad blocker 攔截。
   → 點前會先 `chrome.windows.update({focused:true})` 聚焦窗口（背景 Chrome 的 Input 事件需要 focus）。
3. **`checkVisibility()` 判可見**：`position:fixed` 的 popover（如 GitHub action-menu）
   `offsetParent === null`，用 `offsetParent` 判斷會誤判成不可見。改用 `checkVisibility()`。
4. **`ensureDebugger`**：attach 前先 `detach` 清殘留。SW 被殺時 `finally` 沒跑到會留下
   "Another debugger is already attached"，之後全部失敗。
5. **MV3 SW 休眠**：WS ~30s 無活動即被殺 → `chrome.alarms`（periodInMinutes:0.5）+
   bridge 每 15s `ping` 喚醒重連；`onclose` setTimeout 3s 重連。
6. **bridge 只認一個 extension**：多個 Chrome 實例同時載入同一 extension，舊 SW 會搶 worker slot
   → 跑錯版本。一次只開一個實例。
7. **extension 斷線期間指令排隊**（≤200），回線後依序送達（舊指令可能 stale）。
8. **改 extension code 後要重新載入**：`pilot.py reload`（遠端 `chrome.runtime.reload()`）。
   若 SW 版本沒更新（`__pilot.version` 沒變），清 `~/.config/chromium/Default/Service Worker/CacheStorage`
   + `Code Cache` 後重啟 Chrome。

## 安全

- bridge 只綁 `127.0.0.1`；extension 只接受本機 WS `ws://127.0.0.1:8790`。
- `debugger` 權限執行中該 tab 頂部短暫顯示「正在調試」列（完成即消失）。
- **絕不用 bridge 輸送密碼/驗證碼等敏感值**；1Password/OTP 由使用者手動填，bridge 只負責「點提交」。

## 驗證閉環（form 測試）

建 `pilot_form.html`（`input#name` + `button#btn` + `div#out`，body 內 script 監聽 click 寫 `out=clicked:<name>`）：

```bash
$PY $P/pilot.py open file://$PWD/pilot_form.html      # 取 tabId
$PY $P/pilot.py type  marvin --selector-ignored       # 先 click 聚焦 input
$PY $P/pilot.py click --selector "#name"
$PY $P/pilot.py type  --text marvin
$PY $P/pilot.py click --selector "#btn"
$PY $P/pilot.py eval 'document.getElementById("out").textContent'
# 應回 clicked:marvin
```

注意：test HTML 的 script 要在 `<body>` 內（放 `<head>` 拿不到 DOM）。

## 疑難排解

| 症狀 | 原因 / 解法 |
|---|---|
| `status` 回 `extension offline` | SW 被 MV3 睡著，等 ≤30s 自動重連；或 bridge 沒跑（`systemctl --user status chrome-pilot-bridge`） |
| `tabs` 回 `[]` 但 `status` 有 tab | SW 跑舊 code（`filter(type==="page")`）。`pilot.py reload` 或清 cache 重啟 |
| `click` 回 `found` 但沒反應 | 窗口沒 focus（背景 Chrome）。`key`/`click` 已自動 `windows.update({focused:true})`；確認沒其他視窗搶 focus |
| GitHub 選單/按鈕點不到 | 用 `--text` 匹配 + `checkVisibility`；`position:fixed` popover 不可用 `offsetParent` 判斷 |
| SW 版本沒更新 | `pilot.py reload`；仍舊則清 `Service Worker/CacheStorage` + `Code Cache` 後重啟 Chrome |
| repo visibility 改了沒生效 | 檢查有沒有加 `verify=<owner>/<repo>` 欄位 |
