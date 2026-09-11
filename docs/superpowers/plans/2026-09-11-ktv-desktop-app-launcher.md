# 点歌台桌面 APP 启动器实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 桌面「点歌台」图标一键完成：确保服务器运行 → 确保播放端运行 → 弹出 Edge APP 窗口。

**Architecture:** 新增 `jukebox/tools/` 两个文件（VBS 启动器 + ICO 图标）+ 桌面快捷方式。启动器探测 127.0.0.1:3000，不通则调用既有 server_start_hidden.vbs 隐藏拉起并轮询等待，再按 WMI 防重复拉起 ktv-player.exe，最后 `msedge --app` 弹出独立窗口。不改任何现有代码与部署包。

**Tech Stack:** Windows Script Host（VBScript）+ Edge App 模式 + PowerShell（GDI+ 画图标、建快捷方式）。

## Global Constraints

- **编码铁律**：任何含中文字符的 .vbs / .ps1，写完 UTF-8 后必须转存 UTF-16 LE（带 BOM）再运行——wscript 与 PowerShell 5.1 对无 BOM 文件按 ANSI(GBK) 解析，UTF-8 中文会乱码或吞行。转换命令本身只含 ASCII 路径（临时文件名用 ASCII）。
- 不改 web/、server/、player/ 任何现有代码；不新建、不修改桌面 `办公室KTV-播放端` 文件夹内任何文件（对外部署包）。
- 服务器拉起复用 `C:\Users\Administrator\jukebox\server\server_start_hidden.vbs`；就绪探测 URL `http://127.0.0.1:3000`；APP 窗口 URL `http://192.168.140.67:3000`。
- 播放端 exe：`C:\Users\Administrator\Desktop\办公室KTV-播放端\ktv-player.exe`；防重复按进程名 ktv-player.exe 查 WMI（与既有 启动播放端.vbs 同法）。
- Edge 路径：`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`。
- 轮询：每 2 秒一次，单次探测超时 3 秒，最长等 30 秒；超时 MsgBox 后 `WScript.Quit 1` 不开窗。
- 新文件落位：`C:\Users\Administrator\jukebox\tools\`；桌面快捷方式名 `点歌台.lnk`。
- git 提交信息中文，结尾必须带 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。

---

### Task 1: 生成点歌台.ico 图标

**Files:**
- Create: `C:\Users\Administrator\jukebox\tools\icon_make.ps1`（UTF-16 后运行，产出 ico 并重命名 vbs，见 Task 2 交接）
- Create: `C:\Users\Administrator\jukebox\tools\点歌台.ico`（产出物，256×256 深底音符）

**Interfaces:**
- Consumes: 无
- Produces: `点歌台.ico`（供 Task 3 的 IconLocation 使用）；ps1 末尾附带 `[System.IO.File]::Move` 把 `launcher.vbs` 重命名为 `点歌台.vbs`（Task 2 依赖此步）

- [ ] **Step 1: 建 tools 目录并写 icon_make.ps1（UTF-8）**

```bash
mkdir -p /c/Users/Administrator/jukebox/tools
```

用 Write 工具写入 `C:\Users\Administrator\jukebox\tools\icon_make.ps1`，内容：

```powershell
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 256,256
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$bg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,26,26,46))
$g.FillRectangle($bg, 0, 0, 256, 256)
$accent = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,108,92,231))
$g.FillEllipse($accent, 36, 36, 184, 184)
$white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$g.FillEllipse($white, 74, 152, 52, 44)
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 12
$pen.StartCap = 'Round'; $pen.EndCap = 'Round'
$g.DrawLine($pen, 124, 176, 124, 62)
$g.DrawLine($pen, 124, 62, 172, 80)
$g.DrawLine($pen, 124, 96, 172, 114)
$g.Dispose()
$hIcon = $bmp.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($hIcon)
$fs = [System.IO.File]::Create('C:\Users\Administrator\jukebox\tools\点歌台.ico')
$icon.Save($fs)
$fs.Close()
$bmp.Dispose()
# rename launcher.vbs -> 点歌台.vbs (written by Task 2; guard with existence check)
$src = 'C:\Users\Administrator\jukebox\tools\launcher.vbs'
$dst = 'C:\Users\Administrator\jukebox\tools\点歌台.vbs'
if (Test-Path -LiteralPath $src) { [System.IO.File]::Move($src, $dst) }
Write-Output 'icon done'
```

- [ ] **Step 2: 转存 UTF-16 LE（BOM），路径全 ASCII**

Run:

```bash
powershell -NoProfile -Command "Get-Content -Raw -Encoding UTF8 'C:\Users\Administrator\jukebox\tools\icon_make.ps1' | Set-Content -Encoding Unicode 'C:\Users\Administrator\jukebox\tools\icon_make.ps1'"
```

Expected: 无输出、无报错。验证 BOM：`head -c 2 /c/Users/Administrator/jukebox/tools/icon_make.ps1 | od -An -tx1` 应显示 `ff fe`。

- [ ] **Step 3: 运行生成图标**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\Users\Administrator\jukebox\tools\icon_make.ps1'`
Expected: 输出 `icon done`；`ls -la /c/Users/Administrator/jukebox/tools/` 出现 `点歌台.ico` 且大小 > 0（约 10-50KB）。

- [ ] **Step 4: 提交**

```bash
cd /c/Users/Administrator/jukebox && git add tools/点歌台.ico && git commit -m "点歌台APP启动器：新增 KTV 桌面图标

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

（icon_make.ps1 是一次性工具脚本，不入库，留在 tools/ 供重画用。）

---

### Task 2: 编写点歌台.vbs 一键启动器并验证自愈场景

**Files:**
- Create: `C:\Users\Administrator\jukebox\tools\launcher.vbs`（ASCII 临时名，Task 1 的 ps1 已改名产出 `点歌台.vbs`）
- Modify: 无

**Interfaces:**
- Consumes: `C:\Users\Administrator\jukebox\server\server_start_hidden.vbs`（既有无窗口服务器拉起）；`C:\Users\Administrator\Desktop\办公室KTV-播放端\ktv-player.exe`
- Produces: `点歌台.vbs`（wscript 直接可跑，无参数，无返回值；失败路径 MsgBox + 退出码 1）

- [ ] **Step 1: 写 launcher.vbs（UTF-8）**

用 Write 工具写入 `C:\Users\Administrator\jukebox\tools\launcher.vbs`，内容（注释英文，字符串中文，转存 UTF-16 后运行）：

```vbs
' KTV desktop launcher: ensure server up, ensure player up, open app window.
' Saved as UTF-16 LE with BOM so Chinese strings survive wscript's ANSI parsing.
Option Explicit
Dim sh, fso, baseDir, serverVbs
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
serverVbs = fso.GetAbsolutePathName(baseDir & "\..\server\server_start_hidden.vbs")

If Not ServerUp() Then
  sh.Run """" & serverVbs & """", 0, True
  Dim deadline
  deadline = Timer + 30
  Do While Not ServerUp()
    If Timer > deadline Then
      MsgBox "点歌台服务器启动失败(30秒未就绪)，请查看 server_out.log", 48, "点歌台"
      WScript.Quit 1
    End If
    WScript.Sleep 2000
  Loop
End If

Dim wmi, procs
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set procs = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name='ktv-player.exe'")
If procs.Count = 0 Then
  sh.Run """C:\Users\Administrator\Desktop\办公室KTV-播放端\ktv-player.exe""", 0, False
End If

sh.Run """C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"" --app=http://192.168.140.67:3000", 1, False

Function ServerUp()
  ServerUp = False
  On Error Resume Next
  Err.Clear
  Dim http, st
  Set http = CreateObject("MSXML2.ServerXMLHTTP")
  http.Open "GET", "http://127.0.0.1:3000", False
  http.setTimeouts 3000, 3000, 3000, 3000
  http.Send
  If Err.Number = 0 Then
    st = http.Status
    If Err.Number = 0 Then
      If st = 200 Then ServerUp = True
    End If
  End If
  On Error GoTo 0
End Function
```

> **执行中发现并修复的坑（2026-09-11）**：原计划写 `If Err.Number = 0 And http.Status = 200 Then`——Send 失败后访问 http.Status 会抛 E_PENDING（0x8000000A），VBScript 的 And 不短路且错误插入表达式求值，导致该条件对死端口**求值为 TRUE**（探针实测），启动器误判服务器在线而跳过拉起。修复：Err.Clear + 每步 Err.Number=0 守卫 + Status 先读入中间变量。已用探针对死端口（FALSE）与在线端口（TRUE）双向验证，并重跑自愈场景通过。

- [ ] **Step 2: 转存 UTF-16 LE 并重命名（复用 Task 1 的 ps1）**

```bash
powershell -NoProfile -Command "Get-Content -Raw -Encoding UTF8 'C:\Users\Administrator\jukebox\tools\launcher.vbs' | Set-Content -Encoding Unicode 'C:\Users\Administrator\jukebox\tools\launcher.vbs'" && powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\Users\Administrator\jukebox\tools\icon_make.ps1'
```

Expected: 输出 `icon done`；`ls /c/Users/Administrator/jukebox/tools/` 出现 `点歌台.vbs`，launcher.vbs 消失。

- [ ] **Step 3: 语法检查（服务器在线时跑一次）**

Run: `cscript //nologo 'C:\Users\Administrator\jukebox\tools\点歌台.vbs'`
Expected: 退出码 0；数秒后弹出 Edge 独立窗口（无地址栏/标签页）显示点歌台页面；无 cscript 报错输出。

- [ ] **Step 4: 自愈场景测试（复现今早事故）**

```bash
# 杀掉当前服务器
SERVER_PID=$(netstat -ano | grep -i listen | grep ":3000" | head -1 | awk '{print $NF}')
taskkill //PID $SERVER_PID //F
sleep 1
# 点图标（同一入口，此时服务器已死）
cscript //nologo 'C:\Users\Administrator\jukebox\tools\点歌台.vbs'
```

Expected: 脚本自动隐藏拉起服务器、轮询到就绪后开窗，整个调用 ≤10 秒返回、退出码 0；`netstat -ano | grep -i listen | grep ":3000"` 有新的 LISTENING；`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000` 输出 200；无 MsgBox 弹出（弹出即失败路径）。

- [ ] **Step 5: 提交**

```bash
cd /c/Users/Administrator/jukebox && git add tools/点歌台.vbs && git commit -m "点歌台APP启动器：一键自愈启动脚本（服务器/播放端/APP窗口）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: 桌面快捷方式 + 防重复与端到端验证

**Files:**
- Create: `C:\Users\Administrator\jukebox\tools\make_lnk.ps1`（一次性脚本，不入库）
- Create: `C:\Users\Administrator\Desktop\点歌台.lnk`（产出物）

**Interfaces:**
- Consumes: `C:\Users\Administrator\jukebox\tools\点歌台.vbs`、`C:\Users\Administrator\jukebox\tools\点歌台.ico`（Task 1/2 产出）
- Produces: 桌面 `点歌台.lnk`（目标 wscript.exe，参数指向 vbs，图标点歌台.ico）

- [ ] **Step 1: 写 make_lnk.ps1 并转存 UTF-16**

用 Write 工具写入 `C:\Users\Administrator\jukebox\tools\make_lnk.ps1`：

```powershell
$sh = New-Object -ComObject WScript.Shell
$lnk = $sh.CreateShortcut('C:\Users\Administrator\Desktop\点歌台.lnk')
$lnk.TargetPath = 'C:\Windows\System32\wscript.exe'
$lnk.Arguments = 'C:\Users\Administrator\jukebox\tools\点歌台.vbs'
$lnk.IconLocation = 'C:\Users\Administrator\jukebox\tools\点歌台.ico,0'
$lnk.WorkingDirectory = 'C:\Users\Administrator\jukebox\tools'
$lnk.Save()
$chk = $sh.CreateShortcut('C:\Users\Administrator\Desktop\点歌台.lnk')
Write-Output ('Target: ' + $chk.TargetPath)
Write-Output ('Args: ' + $chk.Arguments)
Write-Output ('Icon: ' + $chk.IconLocation)
```

转存 UTF-16（命令同前，路径换 make_lnk.ps1）后运行：`powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\Users\Administrator\jukebox\tools\make_lnk.ps1'`
Expected: 输出三行分别为 wscript.exe 路径、vbs 路径、ico 路径。

- [ ] **Step 2: 防重复场景（播放端已跑时进程数不变）**

```bash
BEFORE=$(tasklist | grep -c "ktv-player.exe")
cscript //nologo 'C:\Users\Administrator\jukebox\tools\点歌台.vbs'
sleep 2
AFTER=$(tasklist | grep -c "ktv-player.exe")
echo "$BEFORE -> $AFTER"
```

Expected: 前后数字相等（如 2 -> 2；PyInstaller 单文件版一个实例=2 个进程属正常），窗口正常弹出。

- [ ] **Step 3: 端到端——通过桌面图标启动**

Run: `cmd //c start "" "C:\Users\Administrator\Desktop\点歌台.lnk"`
Expected: 数秒内弹出 Edge APP 窗口；`powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { \$_.CommandLine -match '--app=http://192.168.140.67:3000' } | Measure-Object).Count"` 输出 ≥1；页面可点歌。

- [ ] **Step 4: 收尾提交（计划文档入库）**

```bash
cd /c/Users/Administrator/jukebox && git add docs/superpowers/plans/2026-09-11-ktv-desktop-app-launcher.md && git commit -m "点歌台APP启动器实现计划文档

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

- [ ] **Step 5: 验收核对**

对照设计文档核对：① 桌面图标双击＝一键全开 ✓；② 服务器死掉时自动拉起（Task 2 Step 4 已验）✓；③ 播放端不重复启动（Task 3 Step 2 已验）✓；④ 未动 web/server/player 源码与对外部署包（git status 无意外改动）✓。
