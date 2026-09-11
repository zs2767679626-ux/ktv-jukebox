'use strict';

// 点歌队列状态机。纯逻辑：不接触网络/数据库，所有副作用经注入钩子完成。
// 状态语义：
//   current  — 正在播（或 URL 解析中）的条目 {id, song, historyId, started_at, url}
//   queue    — 排队条目 [{id, song, historyId}]
//   volume   — 0..100（mpv 音量）
//   paused / muted / playerOnline — 布尔
//   mode     — 播放模式：order 顺序（队列空即停）/ single 单曲循环 / list 列表循环（自动回填已播）
function createJukebox(deps) {
  const {
    resolveUrl,   // async (song) => {url} | {error:'vip'|'unavailable'}
    sendToPlayer, // (cmd) => void
    broadcast,    // () => void
    history,      // { add(song) => id, update(id, fields), listPlayed(limit), setSetting(k, v) }
    initialMode = 'order', // 初始播放模式；非法值回落 order
    now = () => Date.now(),
    toast = () => {},   // (msg) => void：自动跳过时向网页端提示；默认 no-op 兼容既有测试
  } = deps;

  const state = {
    current: null,
    queue: [],
    volume: 60,
    paused: false,
    muted: false,
    playerOnline: false,
    mode: ['order', 'single', 'list'].includes(initialMode) ? initialMode : 'order',
  };

  let seq = 0;
  const nextId = () => 'q' + (++seq) + Math.random().toString(36).slice(2, 6);

  function getState() {
    return {
      current: state.current && {
        id: state.current.id,
        song: state.current.song,
        started_at: state.current.started_at,
      },
      queue: state.queue.map(({ id, song }) => ({ id, song })),
      volume: state.volume,
      paused: state.paused,
      muted: state.muted,
      playerOnline: state.playerOnline,
      mode: state.mode,
    };
  }

  function send(cmd) { sendToPlayer(cmd); }

  function addToQueue(song) {
    const item = { id: nextId(), song, historyId: history.add(song) };
    if (state.playerOnline && !state.current) {
      playItem(item);
    } else {
      state.queue.push(item);
      broadcast();
    }
  }

  function topQueue(id) {
    const i = state.queue.findIndex((q) => q.id === id);
    if (i > 0) {
      const [item] = state.queue.splice(i, 1);
      state.queue.unshift(item);
      broadcast();
    }
  }

  function removeQueue(id) {
    const i = state.queue.findIndex((q) => q.id === id);
    if (i >= 0) {
      const [item] = state.queue.splice(i, 1);
      history.update(item.historyId, { status: 'skipped', reason: '被移除', finished_at: now() });
      broadcast();
    }
  }

  async function playItem(item) {
    state.current = item;
    item.started_at = now();
    history.update(item.historyId, { status: 'playing', started_at: item.started_at });
    broadcast();
    const resolved = await resolveUrl(item.song).catch(() => ({ error: 'unavailable' }));
    if (state.current !== item) return; // 解析期间已被顶替（切歌等），结果作废
    if (resolved.error) {
      finishCurrent('skipped', resolved.error === 'vip' ? '版权受限' : '无法获取播放地址');
      toast(resolved.error === 'vip' ? '版权受限，已自动跳过' : '无法获取播放地址，已自动跳过');
      playNext();
      return;
    }
    item.url = resolved.url;
    send({ action: 'play', url: resolved.url, song: item.song, volume: state.volume, muted: state.muted });
    broadcast();
  }

  function finishCurrent(status, reason) {
    if (!state.current) return;
    history.update(state.current.historyId, { status, reason: reason || null, finished_at: now() });
    state.current = null;
    broadcast();
  }

  function playNext() {
    if (!state.current && state.playerOnline) {
      if (!state.queue.length && state.mode === 'list') refillQueue();
      if (state.queue.length) { playItem(state.queue.shift()); return; }
    }
    broadcast();
  }

  // 列表循环：队列空时把已播过的歌按最早播放顺序接回来（每首新 history 行）
  function refillQueue() {
    for (const row of history.listPlayed(100)) {
      const s = {
        song_id: row.song_id, title: row.title, artist: row.artist, album: row.album,
        text: row.text, duration_ms: row.duration_ms, fee: row.fee, provider: row.provider,
      };
      state.queue.push({ id: nextId(), song: s, historyId: history.add(s) });
    }
  }

  // ===== 全员指令 =====
  function setMode(m) {
    if (!['order', 'single', 'list'].includes(m) || state.mode === m) return;
    state.mode = m;
    history.setSetting('play_mode', m);
    broadcast();
  }

  function skip() {
    if (state.current) {
      send({ action: 'stop' });
      finishCurrent('skipped', '用户跳过');
    }
    playNext();
  }

  function pause() {
    if (state.current) { state.paused = true; send({ action: 'pause' }); broadcast(); }
  }

  function resume() {
    if (state.current) { state.paused = false; send({ action: 'resume' }); broadcast(); }
  }

  function setVolume(v) {
    state.volume = Math.max(0, Math.min(100, Math.round(v)));
    send({ action: 'volume', value: state.volume });
    broadcast();
  }

  function toggleMute() {
    state.muted = !state.muted;
    send({ action: 'mute', value: state.muted });
    broadcast();
  }

  // ===== 播放端事件 =====
  function playerHello() {
    state.playerOnline = true;
    send({ action: 'volume', value: state.volume });
    send({ action: 'mute', value: state.muted });
    if (!state.current) {
      // 空队列不立即回填已播历史（列表回填只在播完触发）：否则播放端一连上就自动开播一串老歌
      if (state.queue.length || state.mode !== 'list') { playNext(); return; }
      broadcast();
      return;
    }
    if (state.current.url) {                       // URL 已解析：重发给新播放端
      state.current.started_at = now();            // 进度/歌词从新起点算
      history.update(state.current.historyId, { started_at: state.current.started_at });
      send({ action: 'play', url: state.current.url, song: state.current.song,
             volume: state.volume, muted: state.muted });
      if (state.paused) send({ action: 'pause' }); // 保住暂停语义
    }
    broadcast();
  }

  function playerGone() {
    state.playerOnline = false;
    if (state.current) {
      finishCurrent('skipped', '播放端断线');
    }
    broadcast();
  }

  function playerEvent(event, detail = {}) {
    if (event === 'finished') {
      if (state.mode === 'single' && state.current) {
        const song = state.current.song;
        finishCurrent('played', null);
        addToQueue(song); // 在线即重播；解析失败走跳过分支，不会死循环
        return;
      }
      finishCurrent('played', null);
      playNext();
    } else if (event === 'error') {
      finishCurrent('skipped', detail.reason || '播放错误');
      toast((detail.reason || '播放错误') + '，已自动跳过');
      // 音频设备掉线时不自动续播（音箱没了，播下去也是漏音），恢复后由播放端重连或手动点歌触发
      if (detail.reason !== '音频设备掉线') playNext();
    }
    // 'started' 由播放端在上报时自带，服务端无需处理
  }

  return {
    getState, addToQueue, topQueue, removeQueue,
    setMode, skip, pause, resume, setVolume, toggleMute,
    playerHello, playerGone, playerEvent, playNext,
  };
}
module.exports = { createJukebox };
