'use strict';
const express = require('express');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { createApi } = require('./api');
const { createRealtime } = require('./ws');
const { createStream } = require('./stream');

// 组装整个应用。providers/history 等依赖注入，便于测试。
function createApp({ providers, history, isPlayerToken, webDir, lanUrls, streamOptions = {} }) {
  const app = express();
  app.use(express.json());
  app.use('/api', createApi({ providers, store: history, lanUrls }));
  app.use(express.static(webDir));
  // 电台流：必须在 SPA 兜底之前注册（兜底正则 ^\/(?!api) 会吞掉 /stream 返回 index.html）
  let streamer = null;
  app.get('/stream', (req, res) => streamer.addClient(req, res));
  app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(webDir, 'index.html')));

  const server = http.createServer(app);
  const { jukebox, wss, setStreamPlayer, clearStreamPlayer } = createRealtime({
    server,
    history,
    resolveUrl: providers.resolveUrl,
    isPlayerToken,
    onPlayerSlotFree: () => streamer && streamer.reclaim(), // 桌面端断开后流端自动抢回
  });
  let silence = streamOptions.silence;
  if (silence === undefined) {
    try { silence = fs.readFileSync(path.join(__dirname, 'silence.mp3')); }
    catch (e) { console.error('[stream] silence.mp3 缺失，静音垫底降级（后台可靠性降低）', e && e.message); silence = Buffer.alloc(0); }
  }
  streamer = createStream({
    jukebox,
    resolveUrl: providers.resolveUrl,
    setStreamPlayer,
    clearStreamPlayer,
    isPlayerToken,
    silence,
    fetchImpl: streamOptions.fetchImpl,
    stallMs: streamOptions.stallMs,
    evictLimit: streamOptions.evictLimit,
    silenceIntervalMs: streamOptions.silenceIntervalMs,
  });
  return { app, server, jukebox, streamer, wss };
}
module.exports = { createApp };
