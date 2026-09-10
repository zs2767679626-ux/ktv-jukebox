#!/bin/bash
# Mac 播放端停止脚本：先卸掉 LaunchAgent（防 KeepAlive 自动拉起），再杀进程
cd "$(dirname "$0")"
launchctl unload "$HOME/Library/LaunchAgents/com.jukebox.player.plist" 2>/dev/null || true
pkill -f "python3 player.py" 2>/dev/null
sleep 1
echo "播放端已停止（开机自启已关闭；要恢复双击「启动播放端.command」）"
