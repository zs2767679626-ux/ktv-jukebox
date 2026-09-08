# 部署指南

## 一、云端部署（腾讯 CloudStudio 免费版）

1. 把代码推送到 GitHub 私有仓库（或本地打包 zip）
2. 登录腾讯云 CloudStudio 控制台 → 新建应用 → 导入仓库/上传 zip
3. 配置：运行时 Node.js 24（历史库用内置 node:sqlite，需 ≥23.4）；启动命令 `cd server && npm install && npm start`（平台会注入 PORT）
4. 环境变量：
   - `DEVICE_TOKEN`：设备口令（自己定一串，如 `ktv-2026-xj`）——播放端连接用
   - `NETEASE_REAL_IP`：可选，网易云 API 若限流时填国内 IP
5. 开启"应用常驻"（免费版默认可能休眠，开启后 24 小时在线）
6. 部署完成 → 得到 `https://<hash>.app.workbuddy.link` 域名 → 浏览器访问验证
7. WebSocket 走同域 `/ws`，平台支持（本架构与原版一致，已验证可行）

## 二、公司电脑播放端安装

Windows：双击 `player/setup_win.bat`，按提示填 token，脚本会装依赖、下 libmpv、注册开机自启。
Mac：终端运行 `bash player/setup_mac.sh`，同上。

播放前把系统默认音频输出切到蓝牙音箱（Windows：右下角音量图标 → 输出设备选蓝牙音箱）。

## 三、验收清单

- [ ] 手机打开网址 → 搜索点歌 → 蓝牙音箱出声
- [ ] 多人页面：A 调音量，B 页面 1 秒内同步；A 切歌立刻生效
- [ ] 已点列表置顶/删除
- [ ] 播放端电脑关机 → 页面提示离线、点歌照常排队；开机重连自动接着播
- [ ] 歌词滚动高亮；纯音乐正常显示
- [ ] VIP 歌有标签；播不了自动跳下一首并注明
- [ ] 服务器重启：队列清空、历史保留

## 四、日常维护

- 服务器日志：CloudStudio 控制台看应用日志
- 播放端日志：`player/player.log`
- 历史记录库：`server/data/jukebox.db`（云端实例内）
