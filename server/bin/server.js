'use strict';
const os = require('os');
const path = require('path');
const config = require('../src/config');
const { createStore } = require('../src/store');
const { createNetease } = require('../src/netease');
const { createApp } = require('../src/index');
const neteaseApi = require('NeteaseCloudMusicApi');

// data 目录（SQLite 文件所在地）
require('fs').mkdirSync(path.dirname(config.dbPath), { recursive: true });

const store = createStore(config.dbPath);
// 登录态优先取本地持久化的（扫码登录保存的），其次环境变量 NETEASE_COOKIE
const initialCookie = store.getSetting('netease_cookie') || config.neteaseCookie;
const netease = createNetease(neteaseApi, { realIP: config.neteaseRealIP, cookie: initialCookie });
const { server } = createApp({
  netease,
  history: store,
  isPlayerToken: (t) => Boolean(t) && t === config.deviceToken,
  webDir: path.join(__dirname, '..', '..', 'web'),
});

server.listen(config.port, () => {
  console.log(`jukebox server listening on :${config.port}`);
  // 打印局域网访问地址，方便员工手机打开
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal) {
        console.log(`  http://${a.address}:${config.port}  (${name})`);
      }
    }
  }
  netease.loginStatus().then((s) => {
    console.log(s ? `网易云已登录：${s.nickname}（vipType ${s.vipType}），会员歌可正常播放`
      : '网易云未登录：会员歌将自动跳过，可在网页点「网易云登录」扫码登录');
  });
});
