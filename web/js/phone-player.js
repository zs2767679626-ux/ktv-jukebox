// 手机播放端，两种模式：
// - 电台模式（默认）：audio 播服务器 /stream 连续流（服务器把队列拼成一条不断流的音频）。
//   退后台/锁屏不需要收任何指令，音乐自然不断——iOS/安卓通吃。进度为估算值。
// - 普通模式：浏览器充当官方播放端（HTML5 Audio），蓝牙/耳机出声，电脑免外放。
//   协议与 player/client.py 完全一致：player_hello 注册 → 收 player_cmd → 回 player_event。
//   进度精确、可拖进度条，但退后台会被系统冻结断线。
// 两种模式都另开一条「网页身份」连接：收 state 广播（队列/模式）+ 发控制指令（暂停/切歌）。
(() => {
  'use strict';
  const TOKEN_KEY = 'ktv_phone_token';
  const WAKELOCK_KEY = 'ktv_phone_wakelock';
  const MODE_KEY = 'ktv_phone_mode';       // 'radio' | 'normal'
  const ROM_HINT_KEY = 'ktv_rom_hint_seen';
  const LOAD_GRACE_MS = 10000; // 普通模式加载缓冲期：与 mpv 端一致，超时才算加载失败
  const STREAM_RETRY_MAX_MS = 10000; // 电台模式重连退避上限
  const STREAM_STALL_MS = 15000;     // 电台模式：连续无数据超过此时长才重连（歌间间隙勿误伤）

  const $ = (id) => document.getElementById(id);
  const audio = new Audio();
  audio.preload = 'auto';

  const mode = localStorage.getItem(MODE_KEY) === 'normal' ? 'normal' : 'radio';
  let token = localStorage.getItem(TOKEN_KEY) || '';
  // 二维码直带口令：电脑 IP 变动会让手机把新地址当全新网站（localStorage 随 origin 失效），
  // 从 URL 取口令即恢复「扫码即播放端」；取完立刻清掉地址栏参数，防历史记录/截图泄露
  const urlToken = new URLSearchParams(location.search).get('token');
  if (urlToken) {
    localStorage.setItem(TOKEN_KEY, urlToken);
    token = urlToken;
    history.replaceState(null, '', location.pathname);
  }
  let playerWs = null;
  let stateWs = null;
  let stoppedByTakeover = false; // 被电脑端接管：不自动抢回，等用户点按钮
  let unlockDone = false;        // 用户已手动点过「开始」，浏览器放行自动播放
  let pausedByServer = false;    // 本次暂停是否来自服务器指令（否则视为被别的 App 打断）
  let currentUrl = null;         // 普通模式：当前歌地址
  let startedSent = false;
  let erroredSent = false;
  let startTimer = null;
  let playerRetry = 0;
  let helloTimer = null;
  let wakeLock = null;
  let lastState = null;
  let serverOffset = 0;          // 电台：servertime 与本地时钟偏移
  let pausedProgress = null;     // 电台：暂停时冻结的估算进度
  let streamRetry = 0;           // 电台：重连退避计数
  let streamTimer = null;        // 电台：重连定时器
  let streamAttached = false;    // 电台：audio 已指向 /stream
  let stallTimer = null;         // 电台：stall 看门狗

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
      if (msg.type === 'state') {
        if (msg.servertime) serverOffset = msg.servertime - Date.now();
        renderState(msg.state);
      }
    };
    stateWs.onclose = () => { stateWs = null; setTimeout(connectState, 5000); };
    stateWs.onerror = () => {};
  }

  function stateSend(obj) {
    if (stateWs && stateWs.readyState === 1) stateWs.send(JSON.stringify(obj));
  }

  // ---------- 电台模式：连续流 ----------
  function startRadio() {
    if (mode !== 'radio' || !token) return;
    clearTimeout(streamTimer);
    checkStream().then((ok) => { if (ok) attachStream(); });
  }
  async function checkStream() {
    // HEAD 探活：口令错（403）直接弹口令层；服务器没起就交给 audio error 路径退避重试
    try {
      const res = await fetch('/stream?token=' + encodeURIComponent(token), { method: 'HEAD' });
      if (res.status === 403) { failToken(); return false; }
    } catch { /* 忽略 */ }
    return true;
  }
  function attachStream() {
    if (mode !== 'radio' || !token) return;
    clearTimeout(streamTimer);
    clearTimeout(stallTimer);
    streamAttached = true;
    audio.src = '/stream?token=' + encodeURIComponent(token) + '&ts=' + Date.now();
    audio.load();
    audio.play().catch((err) => {
      if (err && err.name === 'NotAllowedError') { maybeUnlock(); return; }
      scheduleStreamRetry();
    });
  }
  function scheduleStreamRetry() {
    if (mode !== 'radio' || !streamAttached || !token) return;
    clearTimeout(streamTimer);
    streamRetry = Math.min(streamRetry + 1, 10);
    const delay = Math.min(1000 * streamRetry, STREAM_RETRY_MAX_MS);
    setStatus(`流断开，${Math.round(delay / 1000)} 秒后重连…`);
    streamTimer = setTimeout(startRadio, delay);
  }

  // ---------- 普通模式：播放端协议 ----------
  function handleCmd(cmd) {
    if (!cmd || !cmd.action) return;
    switch (cmd.action) {
      case 'play':
        if (cmd.volume !== undefined) audio.volume = cmd.volume / 100;
        if (cmd.muted !== undefined) audio.muted = cmd.muted;
        loadAndPlay(cmd.url);
        break;
      case 'pause': pausedByServer = true; audio.pause(); break;
      case 'resume':
        pausedByServer = false;
        if (audio.src) audio.play().catch((err) => { if (err && err.name === 'NotAllowedError') maybeUnlock(); });
        break;
      case 'volume': audio.volume = (cmd.value || 0) / 100; break;
      case 'mute': audio.muted = !!cmd.value; break;
    }
  }

  function loadAndPlay(url) {
    currentUrl = url;
    pausedByServer = false;
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
    $('interruptOverlay').classList.add('hidden');
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
    clearTimeout(stallTimer);
    clearTimeout(streamTimer);   // 流恢复：取消待定的重连
    streamRetry = 0;
    $('interruptOverlay').classList.add('hidden');
    updateCover();
    if (mode === 'radio') setStatus('正在播放');
    if (mode !== 'radio') {
      if (!startedSent && currentUrl) {
        startedSent = true;
        sendEvent('started');
        setStatus('正在播放');
      }
    }
  });
  audio.addEventListener('ended', () => {
    if (mode === 'radio') { scheduleStreamRetry(); return; } // 服务器关了流：退避重连
    if (!currentUrl) return;
    sendEvent('finished');
    setStatus('已播完');
  });
  audio.addEventListener('error', () => {
    if (mode === 'radio') {
      // 换源（重连）时旧请求的 error 不触发重试；真正失败时 readyState 归零且无新加载
      if (audio.readyState < 2 && audio.networkState !== 2) scheduleStreamRetry();
      return;
    }
    sendError('加载失败');
  });
  audio.addEventListener('waiting', () => {
    if (mode !== 'radio') return;
    // 歌间间隙取流会有短暂 waiting；仅连续无数据超过上限才重连
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => scheduleStreamRetry(), STREAM_STALL_MS);
  });
  audio.addEventListener('canplay', () => clearTimeout(stallTimer));
  audio.addEventListener('timeupdate', renderProgress);
  audio.addEventListener('durationchange', renderProgress);
  audio.addEventListener('play', () => {
    $('interruptOverlay').classList.add('hidden');
    updateCover();
  });
  audio.addEventListener('pause', () => {
    updateCover();
    if (mode === 'radio') {
      // 电台模式服务器暂停=流切静音，元素不会停；元素停了=别的 App（网易云等）抢了声音
      if (streamAttached && !stoppedByTakeover) {
        $('interruptOverlay').classList.remove('hidden');
      }
      return;
    }
    // 不是服务器指令、也没自然播完：手机别的 App（网易云等）抢了声音，提示用户恢复
    if (currentUrl && !audio.ended && !pausedByServer && !stoppedByTakeover) {
      $('interruptOverlay').classList.remove('hidden');
    }
  });

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
    if (mode === 'radio') {
      audio.volume = (st.volume ?? 60) / 100;
      audio.muted = !!st.muted;
      // 接管提示：流端不在播放交椅上但音乐在播 → 声音在电脑端，点「抢回」重连夺回
      const taken = !st.streamActive && st.playerOnline && !!cur;
      $('retakeSmall').classList.toggle('hidden', !taken);
      if (taken) setStatus('🔇 声音在电脑端');
    }
    updateCover();
    renderProgress();
    updateMediaSession();
  }

  function renderProgress() {
    if (mode === 'radio') { renderRadioProgress(); return; }
    const t = audio.currentTime || 0;
    const durMs = lastState && lastState.current && lastState.current.song.duration_ms;
    const d = audio.duration || (durMs ? durMs / 1000 : 0);
    $('tCur').textContent = fmt(t);
    $('tDur').textContent = d ? fmt(d) : '--:--';
    $('progressBar').style.width = d ? Math.min(100, (t / d) * 100) + '%' : '0%';
  }

  // 电台模式进度：元素播的是连续流，只能按服务器 started_at + 时钟偏移估算
  function renderRadioProgress() {
    const st = lastState;
    const cur = st && st.current;
    const durMs = cur && cur.song && cur.song.duration_ms;
    const d = durMs ? durMs / 1000 : 0;
    let t = 0;
    if (cur && cur.started_at) {
      if (st.paused) {
        if (pausedProgress == null) pausedProgress = Math.min((serverNow() - cur.started_at) / 1000, d || Infinity);
        t = pausedProgress;
      } else {
        pausedProgress = null;
        t = Math.min((serverNow() - cur.started_at) / 1000, d || Infinity);
      }
    } else {
      pausedProgress = null;
    }
    $('tCur').textContent = fmt(t);
    $('tDur').textContent = d ? fmt(d) : '--:--';
    $('progressBar').style.width = d ? Math.min(100, (t / d) * 100) + '%' : '0%';
  }

  function updateCover() {
    const playing = mode === 'radio'
      ? (streamAttached && !audio.paused)
      : (!!currentUrl && !audio.paused);
    $('cover').classList.toggle('playing', playing);
  }

  function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const cur = lastState && lastState.current && lastState.current.song;
    if (cur && typeof MediaMetadata !== 'undefined') {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: cur.title || cur.text || '',
        artist: cur.artist || '',
        album: cur.album || '',
      });
    }
    try {
      // 锁屏控制 → 服务器级暂停/切歌（电台模式暂停=流切静音，元素不停，后台安全）
      navigator.mediaSession.setActionHandler('play', () => { if (lastState && lastState.paused) stateSend({ type: 'resume' }); });
      navigator.mediaSession.setActionHandler('pause', () => { if (lastState && !lastState.paused) stateSend({ type: 'pause' }); });
      navigator.mediaSession.setActionHandler('nexttrack', () => stateSend({ type: 'skip' }));
    } catch {}
  }

  function setStatus(text) { $('status').textContent = text; }

  // ---------- 口令 ----------
  function failToken() {
    localStorage.removeItem(TOKEN_KEY);
    token = '';
    streamAttached = false;
    clearTimeout(streamTimer);
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

  // ---------- 保持亮屏（仅普通模式用得上；电台模式熄屏照放） ----------
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
  $('modeToggle').addEventListener('click', () => {
    localStorage.setItem(MODE_KEY, mode === 'radio' ? 'normal' : 'radio');
    location.reload();
  });
  $('romHintOk').addEventListener('click', () => {
    localStorage.setItem(ROM_HINT_KEY, '1');
    $('romHint').classList.add('hidden');
  });
  $('tokenOk').addEventListener('click', () => {
    const v = $('tokenInput').value.trim();
    if (!v) { $('tokenErr').textContent = '请输入口令'; return; }
    localStorage.setItem(TOKEN_KEY, v);
    token = v;
    $('tokenOverlay').classList.add('hidden');
    stoppedByTakeover = false;
    if (mode === 'radio') startRadio();
    else connectPlayer();
  });
  $('retakeBtn').addEventListener('click', () => {
    stoppedByTakeover = false;
    $('takeoverOverlay').classList.add('hidden');
    if (mode === 'radio') attachStream(); // 重连即重新注册，夺回播放权
    else connectPlayer();
  });
  $('retakeSmall').addEventListener('click', () => {
    attachStream(); // 与 retakeBtn 同效（电台模式顶栏入口）
  });
  $('resumeBtn').addEventListener('click', () => {
    $('interruptOverlay').classList.add('hidden');
    if (audio.src) audio.play().catch(() => {});
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

  // 电台模式进度每秒心跳（普通模式由 timeupdate 驱动）
  setInterval(() => { if (mode === 'radio') renderProgress(); }, 1000);

  if (mode === 'radio') {
    $('wakeLabel').classList.add('hidden');
    $('wakeHint').classList.add('hidden');
    if (!localStorage.getItem(ROM_HINT_KEY)) $('romHint').classList.remove('hidden');
  }
  $('modeToggle').textContent = mode === 'radio' ? '📻 电台' : '🎧 普通';

  connectState(); // 网页身份先连上，没口令也能看队列
  if (token) {
    if (mode === 'radio') startRadio();
    else connectPlayer();
  } else {
    $('tokenOverlay').classList.remove('hidden');
  }
  if (mode === 'normal' && localStorage.getItem(WAKELOCK_KEY)) {
    $('wakeCb').checked = true;
    setWake(true);
  }

  function serverNow() { return Date.now() + serverOffset; }
  function fmt(sec) {
    const s = Math.floor(sec || 0);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
