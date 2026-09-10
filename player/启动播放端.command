#!/bin/bash
# Mac 播放端启动脚本：优先恢复 LaunchAgent 守护（开机自启），未装守护时直接后台运行
cd "$(dirname "$0")"
export DYLD_LIBRARY_PATH="/opt/homebrew/lib:/usr/local/lib:$DYLD_LIBRARY_PATH"
PLIST="$HOME/Library/LaunchAgents/com.jukebox.player.plist"
if [ -f "$PLIST" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST" && launchctl start com.jukebox.player
  echo "播放端已启动（开机自启守护已恢复）"
else
  if pgrep -f "python3 player.py" >/dev/null; then
    echo "播放端已在运行，无需重复启动"
    exit 0
  fi
  nohup python3 player.py >> player.log 2>&1 &
  echo "播放端已启动（后台运行，日志在 player.log）"
fi
