'use strict';
const { WebSocketServer } = require('ws');
const { createJukebox } = require('./queue');

// WebSocket 中枢。连接分类 + 指令分发 + 状态广播 + 心跳。
function createRealtime({ server, history, resolveUrl, isPlayerToken, log = () => {} }) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const webClients = new Set();
  let player = null;

  function sendToPlayer(cmd) {
    if (player && player.readyState === 1) {
      player.send(JSON.stringify({ type: 'player_cmd', cmd }));
    }
  }
  function sendState() {
    const msg = JSON.stringify({ type: 'state', state: jukebox.getState(), servertime: Date.now() });
    for (const c of webClients) if (c.readyState === 1) c.send(msg);
  }
  function sendToast(msg) {
    const data = JSON.stringify({ type: 'toast', msg });
    for (const c of webClients) if (c.readyState === 1) c.send(data);
  }

  const jukebox = createJukebox({
    resolveUrl,
    history,
    sendToPlayer,
    broadcast: sendState,
    toast: sendToast,
  });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    // 网页端连接即注册：只观看不操作的客户端也必须收得到广播
    // （若等首条入站消息才分类，被动观看者永远收不到 state）
    let role = 'web';
    webClients.add(ws);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (role === 'web' && msg.type === 'player_hello' && isPlayerToken(msg.token)) {
        webClients.delete(ws);
        role = 'player';
        if (player) player.close();
        player = ws;
        log('player connected');
        jukebox.playerHello();
        return;
      }
      if (role === 'player') {
        if (msg.type === 'player_event') jukebox.playerEvent(msg.event, msg.detail);
        return;
      }
      switch (msg.type) {
        case 'play_request': jukebox.addToQueue(msg.song || { text: msg.text || '' }); break;
        case 'queue_top': jukebox.topQueue(msg.id); break;
        case 'queue_remove': jukebox.removeQueue(msg.id); break;
        case 'skip': jukebox.skip(); break;
        case 'pause': jukebox.pause(); break;
        case 'resume': jukebox.resume(); break;
        case 'volume_set': jukebox.setVolume(msg.value); break;
        case 'mute_toggle': jukebox.toggleMute(); break;
      }
    });

    ws.on('close', () => {
      if (role === 'player') {
        // 仅当断开的是当前播放端才下线；被新播放端顶掉的旧连接不触发 playerGone（否则会误跳过当前歌、抹掉 playerOnline）
        if (player === ws) {
          player = null;
          jukebox.playerGone();
          log('player disconnected');
        }
      } else if (role === 'web') {
        webClients.delete(ws);
      }
    });
    ws.on('error', () => {});
  });

  const pingTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);
  wss.on('close', () => clearInterval(pingTimer));

  return { jukebox, wss };
}
module.exports = { createRealtime };
