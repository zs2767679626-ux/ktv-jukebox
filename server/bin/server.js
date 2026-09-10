'use strict';
const os = require('os');
const path = require('path');
const config = require('../src/config');
const { createStore } = require('../src/store');
const { createProviders } = require('../src/providers');
const { createApp } = require('../src/index');
const neteaseApi = require('NeteaseCloudMusicApi');

// data 目录（SQLite 文件所在地）
require('fs').mkdirSync(path.dirname(config.dbPath), { recursive: true });

const store = createStore(config.dbPath);
// 登录态优先取本地持久化的（扫码登录保存的），其次环境变量 NETEASE_COOKIE
const providers = createProviders({
  neteaseApi,
  realIP: config.neteaseRealIP,
  initialNeteaseCookie: store.getSetting('netease_cookie') || config.neteaseCookie,
  initialQQCredential: store.getSetting('qq_cookie') || '',
});
// 局域网访问地址（网页端「扫码点歌」二维码内容）
const lanUrls = [];
for (const addrs of Object.values(os.networkInterfaces())) {
  for (const a of addrs) {
    if (a.family === 'IPv4' && !a.internal) lanUrls.push(`http://${a.address}:${config.port}`);
  }
}
const { server } = createApp({
  providers,
  history: store,
  isPlayerToken: (t) => Boolean(t) && t === config.deviceToken,
  webDir: path.join(__dirname, '..', '..', 'web'),
  lanUrls,
});

// 防静默死亡：未捕获异常/未处理的 Promise 拒绝只记日志，不杀进程
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

server.on('error', (e) => {
  // 端口被占说明已有实例在跑：记日志后退出，避免变成不监听的僵尸进程
  console.error(`[server error] ${e && e.message}`);
  if (e && e.code === 'EADDRINUSE') process.exit(1);
});
server.listen(config.port, () => {
  console.log(`jukebox server listening on :${config.port}`);
  // 打印局域网访问地址，方便员工手机打开
  for (const url of lanUrls) console.log(`  ${url}`);
  providers.netease.loginStatus().then((s) => {
    console.log(s ? `网易云已登录：${s.nickname}（vipType ${s.vipType}），会员歌可正常播放`
      : '网易云未登录：会员歌将自动跳过，可在网页点「网易云登录」扫码登录');
  }).catch((e) => console.error('[loginStatus] 网易云登录态检查失败', e && e.message));
  providers.qq.loginStatus().then((s) => {
    console.log(s ? `QQ音乐已登录：${s.nickname}（vipType ${s.vipType}），VIP 歌可正常播放`
      : 'QQ音乐未登录：VIP 歌将自动跳过，可在网页点「QQ音乐登录」扫码登录');
  }).catch((e) => console.error('[loginStatus] QQ登录态检查失败', e && e.message));
});
