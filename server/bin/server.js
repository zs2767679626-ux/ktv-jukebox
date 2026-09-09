'use strict';
const path = require('path');
const config = require('../src/config');
const { createStore } = require('../src/store');
const { createNetease } = require('../src/netease');
const { createApp } = require('../src/index');
const neteaseApi = require('NeteaseCloudMusicApi');

// data 目录（SQLite 文件所在地）
require('fs').mkdirSync(path.dirname(config.dbPath), { recursive: true });

const store = createStore(config.dbPath);
const netease = createNetease(neteaseApi, { realIP: config.neteaseRealIP, cookie: config.neteaseCookie });
const { server } = createApp({
  netease,
  history: store,
  isPlayerToken: (t) => Boolean(t) && t === config.deviceToken,
  webDir: path.join(__dirname, '..', '..', 'web'),
});

server.listen(config.port, () => {
  console.log(`jukebox server listening on :${config.port}`);
});
