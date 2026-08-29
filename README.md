# Hermes Chrome Pilot

讓 Hermes Agent 直接控制**你已登入的真實 Chrome/Chromium**（MV3 extension + 本機 WebSocket bridge），
不走 CDP remote-debugging、不搶滑鼠鍵盤、不觸發「Allow remote debugging」彈窗。

## 組件
```
~/.hermes/scripts/chrome-pilot/
├── chrome_pilot.py   # bridge daemon（operator :8790 / worker :8791）
├── pilot.py          # Hermes 端 CLI
├── venv/             # python venv（websockets）
└── extension/        # MV3 extension（載入未封裝）
    ├── manifest.json
    └── background.js # service worker
```

## 安裝
1. 載入 extension：`chrome://extensions` → 開啟「開發者模式」→ 「載入未封裝的擴充功能」→ 選
   `~/.hermes/scripts/chrome-pilot/extension`
2. 啟動 bridge（背景）：
   ```
   python3 ~/.hermes/scripts/chrome-pilot/chrome_pilot.py
   ```
   extension 會自動連線 :8791 並重試。

## 使用（Hermes 端）
```
P=~/.hermes/scripts/chrome-pilot
$P/venv/bin/python $P/pilot.py status
$P/venv/bin/python $P/pilot.py tabs --filter canva
$P/venv/bin/python $P/pilot.py open "https://example.com" --new
$P/venv/bin/python $P/pilot.py nav "https://example.com" [--tab N]
$P/venv/bin/python $P/pilot.py eval "document.title" [--tab N]
$P/venv/bin/python $P/pilot.py click --selector "#login-btn" [--tab N]
$P/venv/bin/python $P/pilot.py type  --selector "input#user" --text "hello" [--tab N]
$P/venv/bin/python $P/pilot.py screenshot [--tab N]   # base64 PNG（回傳在 response.png_base64）
$P/venv/bin/python $P/pilot.py raw '{"action":"tabs","filter":"gamma"}'
```
- `--tab N`：`tabs` 列出的 index（0-based，跨 window 穩定）；不帶 = 目前 active tab
- 每筆命令有 id、預設 60s timeout（`--timeout 秒` 在 subcommand 後）

## 已實測（2026-08-28，真 Chromium 151 + MV3 extension）
status / tabs / open / nav / eval / click / type / screenshot 全通過，
含 form 閉環測試（type 寫入 → click 觸發 → 頁面 JS 讀到值）。

## 關鍵設計（踩過的坑）
- **eval/click/type 一律走 `chrome.debugger` 的 Runtime.evaluate**：
  `chrome.scripting` 注入的 `eval` 在 MAIN world 會被頁面 CSP（`script-src` 無 `unsafe-eval`）擋。
- **`ensureDebugger`**：attach 前先 detach 清殘留。SW 被殺時 finally 沒跑到，
  會留下 "Another debugger is already attached" 讓之後全部失敗。
- **MV3 SW 休眠**：WebSocket 約 30s 無活動就被殺 → 用 `chrome.alarms`（30s）
  + `onclose` 3s 重連維持連線。
- **bridge 只認一個 worker**：多個 Chrome 實例同時載入同一 extension 時，
  舊 SW 會搶 worker slot → 用錯版本/出錯。一次只開一個實例。
- extension 斷線期間命令排隊（≤200），回線後依序送達（舊命令可能 stale）。

## 注意
- `debugger` 權限用於 eval/screenshot；執行中該 tab 頂部短暫顯示「正在調試」列
- `type` 用 native setter + input/change 事件（React/受控元件相容）
- 安全：bridge 只綁 127.0.0.1；extension 只接受本機 WS

