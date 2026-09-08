@echo off
setlocal
cd /d "%~dp0"
echo === KTV 点歌台播放端安装 ===

where python >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Python。请安装 Python 3.9+ 并勾选 "Add to PATH"
  echo 下载地址: https://www.python.org/downloads/
  pause & exit /b 1
)

python -m pip install -r requirements.txt
if errorlevel 1 ( echo [错误] 依赖安装失败 & pause & exit /b 1 )

if not exist libmpv\mpv-2.dll (
  echo 正在下载 libmpv（约 40MB）...
  mkdir libmpv 2>nul
  powershell -NoProfile -Command "$r=Invoke-RestMethod https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/latest; $a=$r.assets | Where-Object {$_.name -match 'mpv-dev-x86_64.*\.7z$'} | Select-Object -First 1; if(-not $a){throw '找不到 mpv-dev 包'}; Write-Host ('下载 ' + $a.name); Invoke-WebRequest $a.browser_download_url -OutFile 'libmpv\mpv.7z'"
  if errorlevel 1 ( echo [错误] libmpv 下载失败，请手动到 https://github.com/shinchiro/mpv-winbuild-cmake/releases 下载 mpv-dev-x86_64-*.7z 解压出 mpv-2.dll 放到 libmpv\ & pause & exit /b 1 )
  tar -xf libmpv\mpv.7z -C libmpv
)

if not exist player_config.json (
  copy player_config.example.json player_config.json >nul
  echo.
  echo 请填写 player_config.json 里的 server 和 token：
  notepad player_config.json
  pause
)

echo === 虚拟模式试运行（确认能连上云端）===
python player.py --virtual

echo === 注册开机自启 ===
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup')+'\点歌台播放端.lnk'); $s.TargetPath='%~dp0player_start.bat'; $s.WorkingDirectory='%~dp0'; $s.Save()"
echo.
echo 安装完成！正式播放前：右下角音量图标 → 输出设备选蓝牙音箱 → 双击 player_start.bat（或重启电脑）
pause
