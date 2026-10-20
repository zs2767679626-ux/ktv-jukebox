'use strict';
const { WebSocketServer } = require('ws');
const { createJukebox } = require('./queue');

// WebSocket 中枢。连接分类 + 指令分发 + 状态广播 + 心跳。
function createRealtime({ server, history, resolveUrl, isPlayerToken, onPlayerSlotFree = () => {}, log = () => {} }) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const webClients = new Set();
  let player = null;

  function sendToPlayer(cmd) {
    if (player && player.readyState === 1) {
      player.send(JSON.stringify({ type: 'player_cmd', cmd }));
    }
  }
  function stateMsg() {
    // streamActive：当前播放端是电台流（手机电台模式据此显示「声音在电脑端」）
    return JSON.stringify({
      type: 'state',
      state: { ...jukebox.getState(), streamActive: Boolean(player && player.isStream) },
      servertime: Date.now(),
    });
  }
  function sendState() {
    const msg = stateMsg();
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
    isStreamPlayerActive: () => Boolean(player && player.isStream),
  });

  // 注册/顶替播放端：真实 WS 与流播放端（mock）共用同一条路径，保留「最后注册者赢」语义
  function registerPlayer(p) {
    if (player && player !== p) {
      if (player.readyState === 1) player.send(JSON.stringify({ type: 'player_replaced' }));
      try { player.close(); } catch {}
    }
    player = p;
    jukebox.playerHello();
  }

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
        ws.send(stateMsg());
      }
    }, 30);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (role === 'web' && msg.type === 'player_hello' && isPlayerToken(msg.token)) {
        clearTimeout(snapTimer);
        webClients.delete(ws);
        role = 'player';
        // 通知旧播放端被顶替（含流播放端）：它收到后自动退出进程/转静音，不再对轰
        registerPlayer(ws);
        log('player connected');
        return;
      }
      if (role === 'player') {
        if (msg.type === 'player_event') jukebox.playerEvent(msg.event, msg.detail);
        return;
      }
      switch (msg.type) {
        // 应用层心跳应答：手机网页端靠 ping/pong 判僵死（half-open 下协议层 terminate 的 FIN 可能收不到）
        case 'ping': ws.send(JSON.stringify({ type: 'pong' })); break;
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
          onPlayerSlotFree(); // 播放端交椅空出：流端可自动抢回（若有流客户端在听）
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

  // —— 流播放端（虚拟播放端，见 stream.js）——
  function setStreamPlayer(mock) {
    if (!mock || player === mock) return; // 幂等：多客户端共用同一 mock，仅 0→1 注册
    registerPlayer(mock);
    log('stream player connected');
  }
  function clearStreamPlayer(mock) {
    if (player === mock) {          // 已被真实播放端顶掉时不误清（镜像 close 处理器里的 player === ws 守卫）
      player = null;
      jukebox.playerGone();
      log('stream player disconnected');
    }
  }
  function isStreamPlayerActive() { return Boolean(player && player.isStream); }

  return { jukebox, wss, setStreamPlayer, clearStreamPlayer, isStreamPlayerActive };
}
module.exports = { createRealtime };
