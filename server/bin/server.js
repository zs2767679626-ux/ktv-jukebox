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
// 局域网访问地址（网页端「扫码点歌」二维码内容）。
// 按手机可达性排序：192.168.* / 10.* 的真实局域网优先，
// 172.16-31（Docker/WSL 虚拟网卡 NAT 段）殿后——前端取 lanUrls[0] 生成二维码，
// 排错顺序会让手机扫到虚拟网卡地址连不上（卡加载）。
// 169.254.* 是 APIPA 链路本地地址（网线没插/没拿到 DHCP 时系统自分配），手机永远连不上，直接剔除。
const lanUrls = [];
for (const addrs of Object.values(os.networkInterfaces())) {
  for (const a of addrs) {
    if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) {
      lanUrls.push(`http://${a.address}:${config.port}`);
    }
  }
}
const lanRank = (url) => {
  const ip = url.split(':')[1].slice(2);
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  if (ip.startsWith('172.')) return 2;
  return 3;
};
lanUrls.sort((x, y) => lanRank(x) - lanRank(y));
const { server } = createApp({
  providers,
  history: store,
  isPlayerToken: (t) => Boolean(t) && t === config.deviceToken,
  webDir: path.join(__dirname, '..', '..', 'web'),
  lanUrls,
  deviceToken: config.deviceToken,
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
    if (!s) console.log('网易云未登录：会员歌将自动跳过，可在网页点「网易云登录」扫码登录');
    else if (s.unknown) console.log('网易云登录态检查失败（网络故障）：凭证可能仍有效，网络恢复后自动正常');
    else console.log(`网易云已登录：${s.nickname}（vipType ${s.vipType}），会员歌可正常播放`);
  }).catch((e) => console.error('[loginStatus] 网易云登录态检查失败', e && e.message));
  providers.qq.loginStatus().then((s) => {
    if (!s) console.log('QQ音乐未登录：VIP 歌将自动跳过，可在网页点「QQ音乐登录」扫码登录');
    else if (s.unknown) console.log('QQ音乐登录态检查失败（网络故障）：凭证可能仍有效，网络恢复后自动正常');
    else console.log(`QQ音乐已登录：${s.nickname}（vipType ${s.vipType}），VIP 歌可正常播放`);
  }).catch((e) => console.error('[loginStatus] QQ登录态检查失败', e && e.message));
});
