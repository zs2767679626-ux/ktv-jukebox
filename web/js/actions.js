// 用户操作 → WS 消息
export function bindActions(ws) {
  return {
    request(song) { ws.send({ type: 'play_request', song }); },
    skip() { ws.send({ type: 'skip' }); },
    togglePause() { ws.send({ type: store_paused() }); },
    setVolume(value) { ws.send({ type: 'volume_set', value }); },
    toggleMute() { ws.send({ type: 'mute_toggle' }); },
    top(id) { ws.send({ type: 'queue_top', id }); },
    remove(id) { ws.send({ type: 'queue_remove', id }); },
  };
}
function store_paused() {
  // 依据本地缓存的 paused 决定发 pause 还是 resume
  const paused = window.__jukeboxState && window.__jukeboxState.paused;
  return paused ? 'resume' : 'pause';
}
