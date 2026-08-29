# Hermes Chrome Pilot

讓 Hermes Agent 直接控制**你已登入的真實 Chrome/Chromium**（MV3 extension + 本機 WebSocket bridge）。
比 Browser-Use/CDP remote-debugging 好處：不觸發「Allow remote debugging」彈窗、不搶滑鼠鍵盤、
能操作已登入的真實 session（Canva/Gamma 等帳號）。

## 架構
```
Hermes (pilot.py) → bridge :8790 → Chrome extension (SW) :8791 → 你的真實 Chrome
                          (chrome_pilot.py)
```

## 安裝
```bash
# 1. venv
python3 -m venv venv && venv/bin/pip install websockets

# 2. bridge 常駐（systemd user service；deploy 內是 /home/cfrog527 路徑，異機需 sed 改成 $HOME）
mkdir -p ~/.config/systemd/user
sed "s|/home/cfrog527|$HOME|g" deploy/chrome-pilot-bridge.service > ~/.config/systemd/user/chrome-pilot-bridge.service
systemctl --user daemon-reload && systemctl --user enable --now chrome-pilot-bridge.service

# 3. extension 自動載入（任何 chromium 啟動都載入）
sudo cp deploy/hermes-pilot-chromium.d /etc/chromium.d/hermes-pilot
sudo sed -i "s|/home/cfrog527|$HOME|g" /etc/chromium.d/hermes-pilot
# （Debian 的 chromium wrapper 會 source /etc/chromium.d/*；其它發行版需自行等價設定）
```
重啟 Chrome 後 extension 自動接上 bridge（30s 內）。

## 使用（Hermes 端）
```
P=~/.hermes/scripts/chrome-pilot
$P/venv/bin/python $P/pilot.py status
$P/venv/bin/python $P/pilot.py tabs --filter canva
$P/venv/bin/python $P/pilot.py open "https://example.com" --new
$P/venv/bin/python $P/pilot.py nav "https://example.com" --tab 0
$P/venv/bin/python $P/pilot.py eval "document.title" --tab 0
$P/venv/bin/python $P/pilot.py click --selector "#login-btn" --tab 0
$P/venv/bin/python $P/pilot.py type  --selector "input#user" --text "hi" --tab 0
$P/venv/bin/python $P/pilot.py screenshot --tab 0   # response.png_base64
$P/venv/bin/python $P/pilot.py raw '{"action":"tabs"}'
```
`--tab N` = `tabs` 列出的 index（0-based，跨 window 穩定）；不帶 = active tab。

## 組件
| 檔案 | 作用 |
|---|---|
| `extension/` | MV3 service worker，用 `chrome.tabs`/`chrome.debugger` 執行指令 |
| `chrome_pilot.py` | 本機 WS 中繼（127.0.0.1 only）；extension 離線時命令排隊 |
| `pilot.py` | Hermes 端 CLI |
| `deploy/` | systemd unit + chromium.d 安裝用 |

## 關鍵設計（踩過的坑）
1. **eval/click/type 走 `chrome.debugger` 的 Runtime.evaluate，不用 `chrome.scripting`**：
   `chrome.scripting` 注入的 eval 在 MAIN world 會被頁面 CSP（`script-src` 無 `unsafe-eval`）擋。
2. **`ensureDebugger`**：attach 前先 detach 清殘留。SW 被殺時 `finally` 沒跑到會留下
   "Another debugger is already attached"，之後全部失敗。
3. **MV3 SW 休眠**：WS ~30s 無活動即被殺 → `chrome.alarms`（0.5 min）+ `onclose` 3s 重連。
4. **bridge 只認一個 worker**：多個 Chrome 實例同時載入同一 extension 會搶 worker slot。
5. 關 Chrome 前若想要 session restore 還原 tab：`session.restore_on_startup=1`（Preferences）。
   注意：正常關閉（Ctrl+Q）不觸發 restore，只有異常中斷才還原。

## 安全
- bridge 只綁 `127.0.0.1`；extension 只接受本機 WS `ws://127.0.0.1:8791`
- `debugger` 權限執行中該 tab 頂部短暫顯示「正在調試」列（完成即消失）
