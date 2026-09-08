# 点歌台播放客户端（Win/Mac 通用）

作用：连云端领取播放任务，用 mpv 播放到本机默认音频设备（蓝牙音箱）。

## 安装

- Windows：双击 `setup_win.bat`
- Mac：`bash setup_mac.sh`

两个脚本都会：装 Python 依赖 → 装/下载 libmpv → 生成 player_config.json → 注册开机自启。

## 配置 player_config.json

- `server`：云端网址（自动补全 wss:// 与 /ws）
- `token`：云端 DEVICE_TOKEN，设备口令
- `libmpv`：留空自动找（Windows 会搜 libmpv/ 目录下的 mpv-2.dll）

## 手动运行

`python player.py`（真实播放）；`python player.py --virtual`（不出声联调）

## 换电脑

新电脑跑一遍安装脚本，填同一个 server/token 即可，云端无感知。
