// 手机播放端：浏览器充当官方播放端（HTML5 Audio），蓝牙/耳机出声，电脑免外放。
// 协议与 player/client.py 完全一致：player_hello 注册 → 收 player_cmd → 回 player_event。
// 另开一条「网页身份」连接：收 state 广播（队列/模式）+ 发控制指令（暂停/切歌）。
(() => {
  'use strict';
  const TOKEN_KEY = 'ktv_phone_token';
  const WAKELOCK_KEY = 'ktv_phone_wakelock';
  const LOAD_GRACE_MS = 10000; // 加载缓冲期：与 mpv 端一致，超时才算加载失败

  const $ = (id) => document.getElementById(id);
  const audio = new Audio();
  audio.preload = 'auto';

  let token = localStorage.getItem(TOKEN_KEY) || '';
  let playerWs = null;
  let stateWs = null;
  let stoppedByTakeover = false; // 被电脑端接管：不自动抢回，等用户点按钮
  let unlockDone = false;        // 用户已手动点过「开始」，浏览器放行自动播放
  let currentUrl = null;
  let startedSent = false;
  let erroredSent = false;
  let startTimer = null;
  let playerRetry = 0;
  let helloTimer = null;
  let wakeLock = null;
  let lastState = null;

  // ---------- 连接 ----------
  function connectPlayer() {
    clearTimeout(helloTimer);
    if (stoppedByTakeover) return;
    if (playerWs && (playerWs.readyState === 0 || playerWs.readyState === 1)) return;
    setStatus('连接中…');
    playerWs = new WebSocket(`ws://${location.host}/ws`);
    playerWs.onopen = () => {
      playerWs.send(JSON.stringify({ type: 'player_hello', token }));
      // 口令错误时服务器把连接当「网页身份」，约 30ms 后必收到一条 state 快照。
      // 口令正确则永远收不到 state——用这个差别判定注册成败。
      helloTimer = setTimeout(() => {
        setStatus('已连接 · 等待点歌');
        playerRetry = 0;
      }, 500);
    };
    playerWs.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'state') { failToken(); return; }
      if (msg.type === 'player_cmd') { clearTimeout(helloTimer); handleCmd(msg.cmd); }
      if (msg.type === 'player_replaced') {
        stoppedByTakeover = true;
        stopAudio();
        $('takeoverOverlay').classList.remove('hidden');
        setStatus('播放权被电脑端接管');
        try { playerWs.close(); } catch {}
      }
    };
    playerWs.onclose = () => {
      playerWs = null;
      if (stoppedByTakeover) return;
      playerRetry += 1;
      const delay = Math.min(2000 * playerRetry, 10000);
      setStatus(`连接断开，${Math.round(delay / 1000)} 秒后重连…`);
      setTimeout(connectPlayer, delay);
    };
    playerWs.onerror = () => {};
  }

  function connectState() {
    if (stateWs && (stateWs.readyState === 0 || stateWs.readyState === 1)) return;
    stateWs = new WebSocket(`ws://${location.host}/ws`);
    stateWs.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'state') renderState(msg.state);
    };
    stateWs.onclose = () => { stateWs = null; setTimeout(connectState, 5000); };
    stateWs.onerror = () => {};
  }

  function stateSend(obj) {
    if (stateWs && stateWs.readyState === 1) stateWs.send(JSON.stringify(obj));
  }

  // ---------- 播放端协议 ----------
  function handleCmd(cmd) {
    if (!cmd || !cmd.action) return;
    switch (cmd.action) {
      case 'play':
        if (cmd.volume !== undefined) audio.volume = cmd.volume / 100;
        if (cmd.muted !== undefined) audio.muted = cmd.muted;
        loadAndPlay(cmd.url);
        break;
      case 'pause': audio.pause(); break;
      case 'resume':
        if (audio.src) audio.play().catch((err) => { if (err && err.name === 'NotAllowedError') maybeUnlock(); });
        break;
      case 'volume': audio.volume = (cmd.value || 0) / 100; break;
      case 'mute': audio.muted = !!cmd.value; break;
    }
  }

  function loadAndPlay(url) {
    currentUrl = url;
    startedSent = false;
    erroredSent = false;
    clearTimeout(startTimer);
    $('progressBar').style.width = '0%';
    setStatus('缓冲中…');
    // 加载缓冲期兜底：取流期间无任何事件，10 秒未起播视为加载失败（对齐 mpv 端行为）
    startTimer = setTimeout(() => sendError('加载失败'), LOAD_GRACE_MS);
    audio.src = url;
    audio.load();
    audio.play().catch((err) => {
      if (err && err.name === 'NotAllowedError') { maybeUnlock(); return; }
      sendError('加载失败');
    });
  }

  function stopAudio() {
    currentUrl = null;
    clearTimeout(startTimer);
    try { audio.pause(); } catch {}
    audio.removeAttribute('src');
    audio.load();
  }

  function sendEvent(event, detail) {
    if (playerWs && playerWs.readyState === 1) {
      playerWs.send(JSON.stringify({ type: 'player_event', event, detail }));
    }
  }
  function sendError(reason) {
    if (erroredSent || !currentUrl) return;
    erroredSent = true;
    clearTimeout(startTimer);
    sendEvent('error', { reason });
    setStatus('加载失败，切下一首…');
  }

  audio.addEventListener('playing', () => {
    clearTimeout(startTimer);
    if (!startedSent && currentUrl) {
      startedSent = true;
      sendEvent('started');
      setStatus('正在播放');
    }
  });
  audio.addEventListener('ended', () => {
    if (!currentUrl) return;
    sendEvent('finished');
    setStatus('已播完');
  });
  audio.addEventListener('error', () => { sendError('加载失败'); });
  audio.addEventListener('timeupdate', renderProgress);
  audio.addEventListener('durationchange', renderProgress);
  audio.addEventListener('play', updateCover);
  audio.addEventListener('pause', updateCover);

  // ---------- 界面 ----------
  function renderState(st) {
    lastState = st;
    const cur = st.current;
    // 歌名展示：切歌间隙 current 短暂为空，队列还有歌时保留上一首显示，避免闪「还没有歌」
    if (cur && (cur.song.title || cur.song.text)) {
      $('nowTitle').textContent = cur.song.title || cur.song.text;
      $('nowMeta').textContent = [cur.song.artist, cur.song.album].filter(Boolean).join(' · ');
      $('coverEmoji').textContent = cur.song.provider === 'qq' ? '🎶' : '🎵';
    } else if (!st.queue || !st.queue.length) {
      $('nowTitle').textContent = '还没有歌，去点一首吧';
      $('nowMeta').textContent = '';
      $('coverEmoji').textContent = '💿';
    }
    // 队列预览
    const nextBox = $('nextBox');
    if (st.queue && st.queue.length) {
      $('nextList').innerHTML = st.queue.slice(0, 8).map((item) => {
        const s = item.song || {};
        const prov = s.provider === 'qq' ? '🎶' : '🎵';
        return `<li>${prov} ${esc(s.title || s.text || '')}<span class="dim">${esc(s.artist || '')}</span></li>`;
      }).join('');
      nextBox.classList.remove('hidden');
    } else {
      nextBox.classList.add('hidden');
    }
    $('modeTag').textContent = { order: '顺序', single: '单曲循环', list: '列表循环' }[st.mode] || '顺序';
    // 控制按钮（经网页身份连接下发，全员共享控制权）
    $('pauseBtn').disabled = !cur;
    if (cur) $('pauseBtn').textContent = st.paused ? '▶' : '⏸';
    $('skipBtn').disabled = !(cur || (st.queue && st.queue.length));
    updateCover();
    renderProgress();
  }

  function renderProgress() {
    const t = audio.currentTime || 0;
    const durMs = lastState && lastState.current && lastState.current.song.duration_ms;
    const d = audio.duration || (durMs ? durMs / 1000 : 0);
    $('tCur').textContent = fmt(t);
    $('tDur').textContent = d ? fmt(d) : '--:--';
    $('progressBar').style.width = d ? Math.min(100, (t / d) * 100) + '%' : '0%';
  }

  function updateCover() {
    $('cover').classList.toggle('playing', !!currentUrl && !audio.paused);
  }

  function setStatus(text) { $('status').textContent = text; }

  // ---------- 口令 ----------
  function failToken() {
    localStorage.removeItem(TOKEN_KEY);
    token = '';
    $('tokenErr').textContent = '口令不正确，请重新输入';
    $('tokenInput').value = '';
    $('tokenOverlay').classList.remove('hidden');
    try { playerWs.close(); } catch {}
    playerWs = null;
  }

  // ---------- 自动播放解锁 ----------
  function maybeUnlock() {
    if (unlockDone) return;
    $('tapOverlay').classList.remove('hidden');
    $('tapOk').onclick = () => {
      unlockDone = true;
      $('tapOverlay').classList.add('hidden');
      if (audio.src) {
        audio.play().catch(() => { unlockDone = false; maybeUnlock(); });
      } else {
        // 还没歌时先静音播一段静音片解锁（空数据不触发任何上报）
        const wasMuted = audio.muted;
        audio.muted = true;
        audio.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
        audio.play().then(() => {
          audio.pause();
          audio.removeAttribute('src');
          audio.load();
          audio.muted = wasMuted;
        }).catch(() => { unlockDone = false; maybeUnlock(); });
      }
    };
  }

  // ---------- 保持亮屏 ----------
  async function setWake(on) {
    if (!on) {
      try { if (wakeLock) wakeLock.release(); } catch {}
      wakeLock = null;
      return;
    }
    if (!('wakeLock' in navigator)) { $('wakeHint').classList.remove('hidden'); return; }
    try { wakeLock = await navigator.wakeLock.request('screen'); }
    catch { $('wakeHint').classList.remove('hidden'); }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && $('wakeCb').checked) setWake(true);
  });

  // ---------- 事件绑定与启动 ----------
  $('tokenOk').addEventListener('click', () => {
    const v = $('tokenInput').value.trim();
    if (!v) { $('tokenErr').textContent = '请输入口令'; return; }
    localStorage.setItem(TOKEN_KEY, v);
    token = v;
    $('tokenOverlay').classList.add('hidden');
    stoppedByTakeover = false;
    connectPlayer();
  });
  $('retakeBtn').addEventListener('click', () => {
    stoppedByTakeover = false;
    $('takeoverOverlay').classList.add('hidden');
    connectPlayer();
  });
  $('pauseBtn').addEventListener('click', () => {
    if (!lastState || !lastState.current) return;
    stateSend({ type: lastState.paused ? 'resume' : 'pause' });
  });
  $('skipBtn').addEventListener('click', () => stateSend({ type: 'skip' }));
  $('wakeCb').addEventListener('change', () => {
    localStorage.setItem(WAKELOCK_KEY, $('wakeCb').checked ? '1' : '');
    setWake($('wakeCb').checked);
  });

  connectState(); // 网页身份先连上，没口令也能看队列
  if (token) connectPlayer();
  else $('tokenOverlay').classList.remove('hidden');
  if (localStorage.getItem(WAKELOCK_KEY)) {
    $('wakeCb').checked = true;
    setWake(true);
  }

  function fmt(sec) {
    const s = Math.floor(sec || 0);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
