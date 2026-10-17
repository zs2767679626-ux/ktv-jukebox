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
    isStreamPlayerActive = () => false, // 当前播放端是否电台流（决定 mp3Only 解析）
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

  let pausedAt = null; // 暂停起点：恢复时把暂停时长从 started_at 平移掉，进度停在断点

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
    pausedAt = null; // 新歌新起点：上一首歌的暂停窗口作废
    history.update(item.historyId, { status: 'playing', started_at: item.started_at });
    broadcast();
    const resolved = await resolveUrl(item.song, { mp3Only: isStreamPlayerActive() }).catch(() => ({ error: 'unavailable' }));
    if (state.current !== item) return; // 解析期间已被顶替（切歌等），结果作废
    if (resolved.error) {
      finishCurrent('skipped', resolved.error === 'vip' ? '版权受限' : '无法获取播放地址');
      toast(resolved.error === 'vip' ? '版权受限，已自动跳过' : '无法获取播放地址，已自动跳过');
      playNext(false); // 失败跳过不接播历史：列表回填只在正常播完/切歌时发生
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

  function playNext(allowRefill = true) {
    if (!state.current && state.playerOnline) {
      if (allowRefill && !state.queue.length && state.mode === 'list') refillQueue();
      if (state.queue.length) { playItem(state.queue.shift()); return; }
    }
    broadcast();
  }

  // 列表循环：队列空时把已播过的歌按最早播放顺序接回来（每首新 history 行）
  function refillQueue() {
    for (const row of history.listPlayed(100)) {
      const s = {
        song_id: row.song_id, title: row.title, artist: row.artist, album: row.album, pic: row.pic,
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
    if (state.current) { state.paused = true; pausedAt = now(); send({ action: 'pause' }); broadcast(); }
  }

  function resume() {
    if (state.current) {
      state.paused = false;
      // 冻结期不计入播放进度：started_at 平移掉暂停时长，恢复后进度从断点继续
      if (pausedAt != null) {
        state.current.started_at += now() - pausedAt;
        pausedAt = null;
      }
      send({ action: 'resume' }); broadcast();
    }
  }

  // 流端冻结/解冻（断线宽限期专用）：与 pause/resume 同语义，但不向播放端发指令。
  // 喂送状态由流端自管（stream.js），走 send 会误触流端的 resumeSong 整首重播。
  function freezeStream() {
    if (state.current) { state.paused = true; pausedAt = now(); broadcast(); }
  }

  function resumeStream() {
    if (state.current) {
      state.paused = false;
      if (pausedAt != null) {
        state.current.started_at += now() - pausedAt;
        pausedAt = null;
      }
      broadcast();
    }
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
      // 播放端刚连上时空队列不立即回填（否则开机/重连就自动开播一串老歌）；
      // 回填由 playNext 在正常推进时触发（播完/切歌），失败路径传 allowRefill=false 不回填
      if (state.queue.length || state.mode !== 'list') { playNext(); return; }
      broadcast();
      return;
    }
    if (state.current.url) {                       // URL 已解析：重发给新播放端
      const item = state.current;
      if (isStreamPlayerActive()) {
        if (state.paused) {
          // 冻结中重连：不重播（重播会毁掉断点），只重申暂停语义；恢复时流端从断点续推
          send({ action: 'pause' });
          broadcast();
          return;
        }
        // 电台流只收 mp3：缓存 URL 可能是普通播放端解析的 m4a（QQ C400），接管时必须重新解析。
        // playItem 内部以 mp3Only 解析、重置 started_at、失败自动跳过（finishCurrent+toast+playNext(false)）
        playItem(item).then(() => { if (state.paused) send({ action: 'pause' }); });
        return;
      }
      item.started_at = now();                     // 进度/歌词从新起点算
      history.update(item.historyId, { started_at: item.started_at });
      send({ action: 'play', url: item.url, song: item.song,
             volume: state.volume, muted: state.muted });
      if (state.paused) send({ action: 'pause' }); // 保住暂停语义
    }
    broadcast();
  }

  function playerGone() {
    state.playerOnline = false;
    // 掉线不跳歌（2026-10-12 用户要求）：current 与队列原样保留。手机切后台/网络瞬断
    // 会反复掉线，若每次都跳过当前歌，队列会被一首首吃光。重连走 playerHello 续播：
    // 流端宽限内断点续播、超时后重解析重播；桌面端重发 play。版权失败仍在解析路径跳过。
    toast('播放端掉线，歌曲已保留，重连后继续播放');
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
      // 失败路径同样不接播历史：回填只在正常播完/切歌时发生
      if (detail.reason !== '音频设备掉线') playNext(false);
    } else if (event === 'started') {
      // 播放端真实起播点（mpv 加载完成 / 流端首块字节 / 恢复后重头播）：
      // 以此刻为准重置进度起点，进度/歌词从真实起播点计算（对所有播放端都更准）
      if (state.current) {
        state.current.started_at = now();
        pausedAt = null; // 起播点重置：旧暂停窗口作废
        history.update(state.current.historyId, { started_at: state.current.started_at });
        broadcast();
      }
    }
  }

  return {
    getState, addToQueue, topQueue, removeQueue,
    setMode, skip, pause, resume, setVolume, toggleMute,
    freezeStream, resumeStream,
    playerHello, playerGone, playerEvent, playNext,
  };
}
module.exports = { createJukebox };
