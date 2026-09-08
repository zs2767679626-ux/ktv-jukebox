#!/bin/bash
set -e
cd "$(dirname "$0")"
PY=$(command -v python3 || true)
if [ -z "$PY" ]; then echo "[错误] 未找到 python3，请先安装 Python 3.9+"; exit 1; fi
command -v brew >/dev/null || { echo "[错误] 请先安装 Homebrew: https://brew.sh"; exit 1; }
echo "=== 安装 libmpv（brew mpv）==="
brew install mpv
echo "=== 安装 Python 依赖 ==="
"$PY" -m pip install -r requirements.txt
[ -f player_config.json ] || cp player_config.example.json player_config.json
echo "请编辑 player_config.json 填入 server 和 token，改完按回车继续"
read -r _
echo "=== 虚拟模式试运行（确认能连上云端）==="
"$PY" player.py --virtual
echo "=== 注册开机自启（LaunchAgent）==="
PLIST="$HOME/Library/LaunchAgents/com.jukebox.player.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.jukebox.player</string>
  <key>ProgramArguments</key><array>
    <string>$PY</string>
    <string>$(pwd)/player.py</string>
  </array>
  <key>WorkingDirectory</key><string>$(pwd)</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(pwd)/player.log</string>
  <key>StandardErrorPath</key><string>$(pwd)/player.log</string>
</dict></plist>
EOF
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "安装完成！播放前把系统输出切到蓝牙音箱，然后重启或执行: launchctl start com.jukebox.player"
