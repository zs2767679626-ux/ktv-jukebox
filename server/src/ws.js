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
    initialMode: history.getSetting('play_mode'),
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
    // 新网页端连接即收一次当前 state 快照：后进页面首屏即有内容，无需等下一条事件广播。
    // 帧必须等握手完成后单独成帧发送：若在连接回调里同步发送，帧与握手响应同包抵达客户端，
    // 客户端在升级的同步阶段就把帧排进 nextTick 队列（早于 open 之后才挂载的任何监听，
    // 含测试的排水 nextMsg），帧被静默丢弃。延迟 30ms 保证帧独立成段、排水必收到；
    // 播放端升级时取消，播放端不收快照帧。
    const snapTimer = setTimeout(() => {
      if (role === 'web' && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'state', state: jukebox.getState(), servertime: Date.now() }));
      }
    }, 30);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (role === 'web' && msg.type === 'player_hello' && isPlayerToken(msg.token)) {
        clearTimeout(snapTimer);
        webClients.delete(ws);
        role = 'player';
        if (player) {
          // 通知旧播放端被顶替：它收到后自动退出进程，不再重连回来对轰
          if (player.readyState === 1) player.send(JSON.stringify({ type: 'player_replaced' }));
          player.close();
        }
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
        case 'mode_set': jukebox.setMode(msg.value); break;
      }
    });

    ws.on('close', () => {
      clearTimeout(snapTimer);
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
