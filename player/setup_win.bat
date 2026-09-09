@echo off
setlocal EnableDelayedExpansion
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

if not exist libmpv\mpv-2.dll if not exist libmpv\libmpv-2.dll (
  echo 正在下载 libmpv（约 40MB）...
  mkdir libmpv 2>nul
  powershell -NoProfile -Command "$r=Invoke-RestMethod https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/latest; $a=$r.assets | Where-Object {$_.name -match 'mpv-dev-x86_64.*\.7z$'} | Select-Object -First 1; if(-not $a){throw '找不到 mpv-dev 包'}; Write-Host ('下载 ' + $a.name); Invoke-WebRequest $a.browser_download_url -OutFile 'libmpv\mpv.7z'"
  if errorlevel 1 ( echo [错误] libmpv 下载失败，请手动到 https://github.com/shinchiro/mpv-winbuild-cmake/releases 下载 mpv-dev-x86_64-*.7z 解压出 mpv-2.dll 或 libmpv-2.dll 放到 libmpv\ & pause & exit /b 1 )
  REM 解压：Windows 自带 tar 不一定支持 7z，失败则改用官方 7zr.exe
  tar -xf libmpv\mpv.7z -C libmpv >nul 2>nul
  if not exist libmpv\mpv-2.dll if not exist libmpv\libmpv-2.dll (
    echo tar 不支持 7z，改用 7zr.exe 解压...
    powershell -NoProfile -Command "Invoke-WebRequest https://www.7-zip.org/a/7zr.exe -OutFile \"$env:TEMP\7zr.exe\""
    if errorlevel 1 ( echo [错误] 7zr.exe 下载失败，请手动解压 mpv.7z & pause & exit /b 1 )
    "%TEMP%\7zr.exe" x libmpv\mpv.7z -olibmpv -y >nul
  )
)

if not exist player_config.json (
  REM 口令自动取自服务器 server\.env（安装第一步设置的口令），无需手填，避免两处不一致
  set TOKEN=
  for /f "tokens=2 delims==" %%t in ('findstr /b "DEVICE_TOKEN=" "..\server\.env" 2^>nul') do set TOKEN=%%t
  if "!TOKEN!"=="" set TOKEN=ktv-2026-xj
  > player_config.json echo {"server": "ws://127.0.0.1:3000", "token": "!TOKEN!", "libmpv": "", "virtual": false}
  echo [OK] player_config.json 已自动生成（token=!TOKEN!，与服务器一致）
)

echo === 虚拟模式试运行（确认能连上服务器）===
python player.py --virtual

echo === 注册开机自启 ===
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup')+'\点歌台播放端.lnk'); $s.TargetPath='%~dp0player_start.bat'; $s.WorkingDirectory='%~dp0'; $s.Save()"
echo.
echo 安装完成！正式播放前：右下角音量图标 → 输出设备选蓝牙音箱 → 双击 player_start.bat（或重启电脑）
pause
