@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
chcp 65001 >nul
echo === 办公室 KTV 点歌台 · 局域网安装 ===
echo.
echo 本机将同时运行：
echo   1) 点歌服务器（端口 3000）——员工手机连办公室 Wi-Fi 用浏览器访问
echo   2) 播放端（mpv 播到蓝牙音箱）
echo.

REM ---- 1. Node 检查（服务器需要 23.4+）----
set NODE_VER=
where node >nul 2>nul
if %errorlevel%==0 (
  for /f "delims=" %%v in ('node -e "process.stdout.write(process.versions.node)"') do set NODE_VER=%%v
  node -e "if(+process.versions.node.split('.')[0]<23)process.exit(1)"
  if errorlevel 1 set NODE_VER=
)
if not defined NODE_VER (
  echo [错误] 需要 Node.js 23.4 或更高版本（点歌服务器依赖）
  echo 下载安装：https://nodejs.org/zh-cn  （选 LTS 版本，一路下一步）
  echo 装好后重新双击本脚本。
  pause & exit /b 1
)
echo [OK] Node 版本：%NODE_VER%

REM ---- 2. 服务器依赖 ----
if not exist server\node_modules (
  echo 首次安装服务器依赖（需联网，几分钟）...
  pushd server
  call npm install
  if errorlevel 1 ( echo [错误] npm install 失败 & popd & pause & exit /b 1 )
  popd
)
echo [OK] 服务器依赖就绪

REM ---- 3. 设备口令（写 server\.env，播放端与服务器共用）----
if not exist server\.env (
  set /p TOKEN=请输入设备口令（直接回车用默认 ktv-2026-xj）：
  if "!TOKEN!"=="" set TOKEN=ktv-2026-xj
  > server\.env echo DEVICE_TOKEN=!TOKEN!
)
echo [OK] server\.env 已就绪

REM ---- 4. 防火墙放行 3000（需要管理员权限）----
netsh advfirewall firewall show rule name="KTV点歌台3000" >nul 2>nul
if errorlevel 1 (
  netsh advfirewall firewall add rule name="KTV点歌台3000" dir=in action=allow protocol=TCP localport=3000 >nul 2>nul
  if errorlevel 1 (
    echo [提示] 防火墙放行失败（未以管理员运行？）。首次启动服务器时 Windows 弹窗请点"允许访问"，
    echo        否则员工手机连不上。
  ) else (
    echo [OK] 防火墙已放行 3000 端口
  )
)

REM ---- 5. 服务器开机自启 ----
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup')+'\点歌台服务器.lnk'); $s.TargetPath='%~dp0server\server_start.bat'; $s.WorkingDirectory='%~dp0server'; $s.Save()"
echo [OK] 服务器开机自启已注册

REM ---- 6. 启动服务器 ----
echo.
echo 正在启动点歌服务器（单独窗口，关窗即停）...
start "KTV点歌台服务器" cmd /k "cd /d %~dp0server && npm start"

REM ---- 7. 打印局域网地址 ----
echo.
echo 员工手机访问地址（办公室 Wi-Fi 下）：
for /f "delims=" %%i in ('powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 ^| Where-Object {$_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*'} ^| Select-Object -ExpandProperty IPAddress) -join '  '"') do echo   http://%%i:3000
echo 手机上打开后：顶栏点「🎵 网易云」或「🎶 QQ音乐」扫码登录 → VIP 歌即可正常播放
echo.

REM ---- 8. 播放端 ----
echo 接下来安装播放端（连蓝牙音箱的部分）...
echo 注意：player_config.json 里的 server 填 ws://127.0.0.1:3000
pause
call player\setup_win.bat
