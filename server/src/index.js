'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const { createApi } = require('./api');
const { createRealtime } = require('./ws');

// 组装整个应用。netease/history 等依赖注入，便于测试。
function createApp({ netease, history, isPlayerToken, webDir, lanUrls }) {
  const app = express();
  app.use(express.json());
  app.use('/api', createApi({ netease, store: history, lanUrls }));
  app.use(express.static(webDir));
  // SPA 兜底：非 /api 路径回 index.html
  app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(webDir, 'index.html')));

  const server = http.createServer(app);
  const { jukebox } = createRealtime({
    server,
    history,
    resolveUrl: (song) => netease.songUrl(song.song_id),
    isPlayerToken,
  });
  return { app, server, jukebox };
}
module.exports = { createApp };
