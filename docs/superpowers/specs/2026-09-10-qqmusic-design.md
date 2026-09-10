# 设计：点歌台加入 QQ 音乐（双平台 provider 架构）

日期：2026-09-10
状态：已批准（用户 2026-09-10 确认）

## 核心原则

VIP 账号登录是点歌台的存在目的：登录带 VIP 的账号后，VIP 歌曲必须直接拿到高音质播放地址正常播放。不做复杂降级逻辑：
- 已登录 VIP：直接拿高音质直链播放
- 未登录/无权限：返回"版权受限"，队列自动跳过并提示（与网易云现有行为一致）

## 1. 总体架构

- 现有 `server/src/netease.js` 搬入 `server/src/providers/netease.js`，新增 `providers/qq.js`，两者实现同一接口：`search / songUrl / lyric / artists / artistSongs / toplists / toplistSongs / stylePlaylists / playlistSongs / qrKey / qrCreate / qrCheck / setCookie / clearCookie / loginStatus`
- 歌曲对象全程携带 `provider: 'netease' | 'qq'` 字段：搜索 → 点歌 → 队列 → 解析播放地址 → 历史记录
- 队列状态机（queue.js）与播放端（player/*）**不改**——song 对其不透明字段，只认 URL
- 历史表 history 增加 provider 列（老库自动补列）

## 2. 服务端改动

- **`providers/qq.js`**：直接对接 QQ 音乐公开接口（y.qq.com 系列），扫码登录流程移植 Suxiaoqinx/QQMusicapi 的开源实现。功能对齐网易云：搜索、播放地址（VIP 歌靠登录 cookie）、歌词、歌手、榜单、歌单
- **`api.js` 路由泛化**：共享路由加 `provider` 参数（默认 netease）；登录接口统一 `/api/auth/qr-login、qr-check、logout、status`（body/query 带 provider）；旧 `/netease/*` 路由保留兼容
- **`index.js`**：`resolveUrl` 按 `song.provider` 分派
- **`store.js`**：settings 表存 `qq_cookie`（重启不丢）；history 加 provider 列

## 3. 登录流程（两平台统一交互）

- 点徽标 → 弹二维码 → 手机 App 扫码确认
- **登录成功：二维码立刻消失 → 显示"登录成功：昵称（VIP）"约 2 秒 → 弹窗自动关闭**，扫码人全程无需再点任何按钮
- 弹窗内**不放退出登录按钮**。退出入口在顶栏徽标：点已登录徽标 → 小面板显示账号 + "退出登录" + "换账号重新扫码"
- 顶栏两个徽标：🎵 网易云 / 🎵 QQ音乐，各自独立登录、独立状态
- 登录轮询契约与网易云一致：`{code: 801 待扫码, 802 已扫码待确认, 803 成功带 cookie, 800 过期}`

## 4. 网页端改动

- 点歌页顶部平台切换标签「网易云 / QQ音乐」，切换后搜索、歌手、语种、榜单、歌单全走对应平台；选择存 localStorage
- 队列与播放中歌曲显示来源小徽标（🎵/🎶）

## 5. 异常处理

- QQ VIP 歌未登录/无绿钻：`{error:'vip'}` → 队列自动跳过提示"版权受限"
- 二维码过期：code 800 → 提示刷新，停止轮询
- QQ cookie 失效：loginStatus 返回 null → 徽标自动回"未登录"
- 接口偶发失败：轮询容错，搜索失败不崩页面

## 6. 测试

- 服务端：`qq.test.js` mock HTTP 层测适配器（照 netease.test.js 模式）；api 路由 provider 分派测试；队列 VIP 跳过复用现有测试
- 端到端：真实 QQ 账号扫码 → 搜绿钻歌 → 点播 → 播放端出声
