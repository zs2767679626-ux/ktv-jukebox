// 手机播放端（2026-10-05 起永久锁定电台模式，普通模式已移除）：
// audio 播服务器 /stream 连续流（服务器把队列拼成一条不断流的音频，静音垫底）。
// 退后台/锁屏不需要收任何指令，音乐自然不断——iOS/安卓通吃。进度为估算值。
// 用法：扫码 → 轻触一下解锁 → 纯环境音箱。其他手机点歌/切歌/暂停，本机自动跟随，无需再操作。
// 另开一条「网页身份」连接：收 state 广播（歌单/播放状态）+ 发控制指令（暂停/切歌）。
// 出声闸门（2026-10-06）：本机未真实出声（自动播放被拦/缓冲卡顿/声音在电脑端）时，
// 进度与唱片动画一律冻结；自动播放被拦会立即发暂停冻结服务器，'playing' 出声后才解冻——
// 杜绝「静音假播」（界面在走、音箱无声）。
(() => {
  'use strict';
  const TOKEN_KEY = 'ktv_phone_token';
  const ROM_HINT_KEY = 'ktv_rom_hint_seen';
  const STREAM_RETRY_MAX_MS = 10000; // 重连退避上限
  const STREAM_STALL_MS = 15000;     // 连续无数据超过此时长才重连（歌间间隙勿误伤）

  const $ = (id) => document.getElementById(id);
  const audio = new Audio();
  audio.preload = 'auto';

  let token = localStorage.getItem(TOKEN_KEY) || '';
  // 二维码直带口令：电脑 IP 变动会让手机把新地址当全新网站（localStorage 随 origin 失效），
  // 从 URL 取口令即恢复「扫码即播放端」；取完立刻清掉地址栏参数，防历史记录/截图泄露
  const urlToken = new URLSearchParams(location.search).get('token');
  if (urlToken) {
    localStorage.setItem(TOKEN_KEY, urlToken);
    token = urlToken;
    history.replaceState(null, '', location.pathname);
  }
  let stateWs = null;
  let streamAttached = false;    // audio 已指向 /stream
  let streamRetry = 0;           // 重连退避计数
  let streamTimer = null;        // 重连定时器
  let stallTimer = null;         // stall 看门狗
  let unlockHandler = null;      // 解锁层整屏点击监听（一次性）
  let interrupted = false;       // 被别的 App 抢声音：已发服务器暂停冻结断点
  let pausedBeforeInterrupt = false; // 打断发生时服务器本来就暂停：恢复时不代用户解冻
  let lastState = null;
  let lastPic = null;           // 当前封面 URL：换歌才换源，防状态广播刷屏时反复重载
  let serverOffset = 0;          // servertime 与本地时钟偏移
  let playingFired = false;      // 本机 <audio> 真实出声（'playing' 事件后置真）
  let stalled = false;           // 缓冲卡顿（waiting）：只冻结本机显示，不惊动服务器
  let blockPauseSent = false;    // 自动播放被拦：已发服务器暂停冻结断点
  let frozenProgress = null;     // 未出声时冻结显示的估算进度（断点）
  let frozenSongId = null;       // 冻结断点所属的歌：换歌必须作废（断线期间错过 current=null 广播时防跨歌残留）

  // ---------- 状态连接（网页身份）：收广播、发控制 ----------
  // 网络波动自愈：half-open 时服务器 30s 协议层 ping 的 terminate 客户端可能收不到 FIN，
  // 必须客户端判死——应用层心跳（20s ping，服务器回 pong；任何入站消息都算活着，
  // 45s 无任何消息判僵死）+ 1s 起步指数退避重连 + 换网（navigator.connection 变化）立即重连。
  const STATE_PING_MS = 20000;  // 心跳间隔
  const STATE_DEAD_MS = 45000;  // 连续无入站消息判僵死上限
  let stateRetry = 0;           // 重连退避计数（连上清零）
  let stateDeadTimer = null;    // 僵死看门狗
  let stateHeart = null;        // 心跳定时器
  let stateEverOpened = false;  // 曾连上过：断线走快速退避；从未连上走 5s 慢速
  let stateReconnectTimer = null;

  function connectState() {
    if (stateWs && (stateWs.readyState === 0 || stateWs.readyState === 1)) return;
    clearTimeout(stateReconnectTimer);
    clearTimeout(stateDeadTimer);
    if (stateHeart) { clearInterval(stateHeart); stateHeart = null; }
    stateWs = new WebSocket(`ws://${location.host}/ws`);
    stateWs.onopen = () => {
      stateRetry = 0;
      stateEverOpened = true;
      armDeadWatch();
      stateSend({ type: 'ping' }); // 打开即发一次，不必等第一个周期
      stateHeart = setInterval(() => { stateSend({ type: 'ping' }); }, STATE_PING_MS);
    };
    stateWs.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      armDeadWatch(); // 任何入站消息都证明连接活着（播放中 state 广播本身就是高频心跳）
      if (msg.type === 'state') {
        if (msg.servertime) serverOffset = msg.servertime - Date.now();
        renderState(msg.state);
      }
    };
    stateWs.onclose = () => {
      stateWs = null;
      if (stateHeart) { clearInterval(stateHeart); stateHeart = null; }
      clearTimeout(stateDeadTimer);
      scheduleStateReconnect();
    };
    stateWs.onerror = () => { try { stateWs.close(); } catch {} }; // 统一走 onclose 重连路径
  }

  /** 僵死看门狗：超时无任何入站消息（state 或 pong）→ 主动断开重连 */
  function armDeadWatch() {
    clearTimeout(stateDeadTimer);
    stateDeadTimer = setTimeout(() => {
      if (stateWs) { try { stateWs.close(); } catch {} }
    }, STATE_DEAD_MS);
  }

  function scheduleStateReconnect() {
    clearTimeout(stateReconnectTimer);
    const delay = stateEverOpened
        ? Math.min(1000 * Math.pow(2, Math.min(stateRetry, 4)), 10000)
        : 5000;
    if (stateEverOpened) stateRetry++;
    setStatus(`网络波动，${Math.round(delay / 1000)} 秒后重连…`);
    stateReconnectTimer = setTimeout(connectState, delay);
  }

  // 换网/网络恢复（安卓 Wi-Fi 抖动会触发多次 change）：立即重连，不必等心跳判死；
  // 音频流卡死时也立即重试（重置退避，新网络从头快速试）
  try {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn && conn.addEventListener) {
      conn.addEventListener('change', () => {
        if (stateWs) {
          try { stateWs.close(); } catch {}   // 走 onclose → 快速退避重连
        } else if (stateEverOpened) {
          scheduleStateReconnect();           // 正在等重连：立即换新定时器
        }
        if (streamAttached && (stalled || audio.readyState < 4)) {
          streamRetry = 0;
          scheduleStreamRetry();
        }
      });
    }
  } catch { /* 老内核不支持 Network Information API，忽略 */ }

  function stateSend(obj) {
    if (stateWs && stateWs.readyState === 1) { stateWs.send(JSON.stringify(obj)); return true; }
    return false; // 连接未就绪：出声闸门靠下一条广播补发，不丢指令
  }

  // ---------- 电台流：连续流 ----------
  function startRadio() {
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
  function attachStream(onBlocked) {
    if (!token) return;
    clearTimeout(streamTimer);
    clearTimeout(stallTimer);
    streamAttached = true;
    playingFired = false;  // 换源：旧「出声」状态作废，等新流 'playing' 重新放行
    stalled = false;
    audio.src = '/stream?token=' + encodeURIComponent(token) + '&ts=' + Date.now();
    audio.load();
    audio.play().catch((err) => {
      if (err && err.name === 'NotAllowedError') {
        (onBlocked || showTapOverlay)();
        blockGate(); // 未出声先冻结服务器：若已在播立即暂停保住断点（不等下一条广播）
        return;
      }
      scheduleStreamRetry();
    });
  }
  function scheduleStreamRetry() {
    if (!streamAttached || !token) return;
    clearTimeout(streamTimer);
    streamRetry = Math.min(streamRetry + 1, 10);
    const delay = Math.min(1000 * streamRetry, STREAM_RETRY_MAX_MS);
    setStatus(`流断开，${Math.round(delay / 1000)} 秒后重连…`);
    streamTimer = setTimeout(startRadio, delay);
  }

  // ---------- 待激活层：轻触整屏任意位置即放行自动播放；'playing' 事件里解冻服务器 ----------
  function showTapOverlay() {
    $('tapOverlay').classList.remove('hidden');
    if (unlockHandler) $('tapOverlay').removeEventListener('pointerdown', unlockHandler);
    unlockHandler = () => {
      $('tapOverlay').classList.add('hidden');
      attachStream(); // 手势内换新源重连起播；仍被拦（罕见）会重新亮层
    };
    $('tapOverlay').addEventListener('pointerdown', unlockHandler, { once: true });
  }

  // ---------- audio 事件 ----------
  audio.addEventListener('playing', () => {
    clearTimeout(stallTimer);
    clearTimeout(streamTimer);   // 流恢复：取消待定的重连
    streamRetry = 0;
    stalled = false;
    playingFired = true;         // 真实出声：进度闸门放行
    $('interruptOverlay').classList.add('hidden');
    if (interrupted) {
      // 恢复解冻：此时新流已注册（冻结期注册不触发重播），服务器从断点续推
      interrupted = false;
      if (!pausedBeforeInterrupt) {
        // 恢复指令丢失（状态连接恰好断线）时交给出声闸门在下条广播里补发：
        // 否则服务器永久停在暂停态，本机出声却听不到，只能手动按按钮
        if (!stateSend({ type: 'resume' })) blockPauseSent = true;
      }
      pausedBeforeInterrupt = false;
    } else if (blockPauseSent) {
      // 待激活层点击成功：解冻服务器（仅当暂停是我们因自动播放被拦而发的），音乐与界面同步起走
      if (lastState && lastState.paused) {
        blockPauseSent = !stateSend({ type: 'resume' }); // 发送失败保旗，出声闸门在下条广播补发
      } else {
        blockPauseSent = false; // 服务器已被别人解冻：无需再发
      }
    }
    updateCover();
    setStatus('正在播放');
  });
  audio.addEventListener('ended', () => {
    playingFired = false;
    scheduleStreamRetry(); // 服务器关了流：退避重连
  });
  audio.addEventListener('error', () => {
    // 任何加载失败一律退避重连：连接被掐断时 networkState 可能卡在 LOADING(2)，
    // 旧判断（readyState<2 && networkState!==2）会永久停止重试——手机从此失声。
    // 换源时旧请求的 error 也会走到这里，多排的一次重试会被 'playing' 清掉，无害。
    playingFired = false;
    scheduleStreamRetry();
  });
  audio.addEventListener('waiting', () => {
    // 缓冲卡顿：立刻冻结进度显示（不出声不走进度）；歌间间隙取流会有短暂 waiting，
    // 仅连续无数据超过上限才重连
    stalled = true;
    renderProgress();
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => scheduleStreamRetry(), STREAM_STALL_MS);
  });
  audio.addEventListener('canplay', () => { stalled = false; clearTimeout(stallTimer); });
  audio.addEventListener('timeupdate', renderProgress);
  audio.addEventListener('durationchange', renderProgress);
  audio.addEventListener('play', () => {
    $('interruptOverlay').classList.add('hidden');
    updateCover();
  });
  audio.addEventListener('pause', () => {
    // 服务器暂停=流切静音，元素不会停；元素停了=别的 App（网易云等）抢了声音：
    // 立刻发服务器暂停，冻结播放进度保住断点（全员共享暂停），再亮恢复层
    playingFired = false;
    updateCover();
    if (!streamAttached) return;
    if (!interrupted) {
      interrupted = true;
      pausedBeforeInterrupt = !!(lastState && lastState.paused);
      if (!pausedBeforeInterrupt) stateSend({ type: 'pause' });
    }
    $('interruptOverlay').classList.remove('hidden');
  });

  // ---------- 出声闸门 ----------
  // 本机是否真实出声：元素在播 + 没卡顿 + 声音没被电脑端接管
  function isSoundOn() {
    if (!streamAttached || !playingFired || audio.paused || stalled) return false;
    const st = lastState;
    if (!st) return false;
    return !!(st.streamActive || !st.playerOnline);
  }

  // 服务器已在播但本机没出声（自动播放被拦）→ 立即发暂停冻结服务器断点 + 亮「待激活」层，
  // 出声('playing')后自动解冻。缓冲卡顿（元素仍在播）只冻结本机显示不惊动服务器；
  // 声音在电脑端走接管横幅；被别的 App 打断走 interrupt 路径，均不在此处理。
  function blockGate() {
    const st = lastState;
    if (!st || !streamAttached || interrupted || !st.streamActive) return;
    if (!st.current) return;
    if (isSoundOn()) {
      // 已真实出声但服务器仍停在「待激活暂停」：补发解冻（防首次发送失败）
      if (blockPauseSent && st.paused) blockPauseSent = !stateSend({ type: 'resume' });
      else if (blockPauseSent && !st.paused) blockPauseSent = false; // 已被别人解冻
      return;
    }
    if (!audio.paused) return; // 缓冲卡顿（元素仍在播）：只冻结显示，不惊动服务器
    if (!st.paused) {
      // 服务器还在走但本机无声：立即冻结（pause 幂等；发送失败下条广播重发）
      blockPauseSent = true;
      stateSend({ type: 'pause' });
    }
    setStatus('🔊 点击屏幕激活音箱');
    showTapOverlay();
  }

  // ---------- 界面 ----------
  // 封面/氛围背景：有图用图（换歌才换源），无图或加载失败回落唱片
  function applyCover(pic) {
    const img = $('coverImg');
    if (pic) {
      img.classList.remove('hidden');
      $('coverFallback').classList.add('hidden');
      if (img.getAttribute('src') !== pic) img.src = pic;
      const bg = $('bgArtImg');
      if (bg.getAttribute('src') !== pic) bg.src = pic;
      $('bgArt').classList.remove('hidden');
    } else {
      img.classList.add('hidden');
      $('coverFallback').classList.remove('hidden');
      $('bgArt').classList.add('hidden');
    }
  }
  $('coverImg').addEventListener('error', () => {
    // 只回落当前这张：换源中旧图被废止触发的 error（src 已是新图）直接忽略
    if ($('coverImg').getAttribute('src') !== lastPic) return;
    $('coverImg').classList.add('hidden');
    $('coverFallback').classList.remove('hidden');
    $('bgArt').classList.add('hidden');
  });

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
    // 封面与氛围背景：状态广播带图就铺图，无图回落唱片
    const pic = cur && (cur.song.pic || '');
    if (pic !== lastPic) { lastPic = pic; applyCover(pic); }
    // 队列预览
    const nextBox = $('nextBox');
    if (st.queue && st.queue.length) {
      $('nextList').innerHTML = st.queue.slice(0, 8).map((item) => {
        const s = item.song || {};
        const prov = s.provider === 'qq' ? '🎶' : '🎵';
        return `<li><span class="txt">${prov} ${esc(s.title || s.text || '')}<span class="dim">${esc(s.artist || '')}</span></span></li>`;
      }).join('');
      nextBox.classList.remove('hidden');
    } else {
      nextBox.classList.add('hidden');
    }
    // 音量/静音随服务器状态（全员共享）
    audio.volume = (st.volume ?? 60) / 100;
    audio.muted = !!st.muted;
    // 接管横幅：流端不在播放交椅上但音乐在播 → 声音在电脑端（强提醒，点横幅抢回手机音箱）
    const taken = !st.streamActive && st.playerOnline && !!cur;
    $('hijackBanner').classList.toggle('hidden', !taken);
    if (taken) setStatus('🔇 声音在电脑端');
    // 控制按钮（经网页身份连接下发，全员共享控制权）
    $('pauseBtn').disabled = !cur;
    if (cur) $('pauseBtn').textContent = st.paused ? '▶' : '⏸';
    $('skipBtn').disabled = !(cur || (st.queue && st.queue.length));
    updateCover();
    renderProgress();
    updateMediaSession();
    blockGate(); // 出声闸门：服务器在播但本机无声 → 冻结服务器 + 亮待激活层
  }

  // 进度：元素播的是连续流，只能按服务器 started_at + 时钟偏移估算。
  // 出声闸门：仅「服务器未暂停 + 本机真实出声」时前进；服务器暂停 / 本机被拦未出声 /
  // 声音在电脑端 / 缓冲卡顿 → 一律冻结在断点——不出声就绝不走进度（杜绝静音假播）。
  function renderProgress() {
    const st = lastState;
    const cur = st && st.current;
    const durMs = cur && cur.song && cur.song.duration_ms;
    const d = durMs ? durMs / 1000 : 0;
    let t = 0;
    if (cur && cur.started_at) {
      t = Math.min((serverNow() - cur.started_at) / 1000, d || Infinity);
    }
    if (!cur) { frozenProgress = null; frozenSongId = null; }
    else if (frozenSongId !== cur.song.song_id) { frozenProgress = null; frozenSongId = cur.song.song_id; }
    const live = !!(st && cur && cur.started_at) && !st.paused && isSoundOn();
    if (live) {
      frozenProgress = t;                          // 出声中：断点随实时值走
      frozenSongId = cur.song.song_id;
    } else if (frozenProgress == null) {
      frozenProgress = Math.min(t, d || Infinity); // 首次冻结：定格在 0:00 或当前断点
    }
    const show = live ? t : (frozenProgress ?? 0);
    $('tCur').textContent = fmt(show);
    $('tDur').textContent = d ? fmt(d) : '--:--';
    $('progressBar').style.width = d ? Math.min(100, (show / d) * 100) + '%' : '0%';
  }

  function updateCover() {
    // 唱片只在真实出声且音乐确实在走时转：暂停/被拦/被接管/卡顿一律冻住，与进度闸门同源
    const st = lastState;
    const cur = st && st.current;
    const live = !!(st && cur && cur.started_at) && !st.paused && isSoundOn();
    $('cover').classList.toggle('playing', live);
  }

  function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const cur = lastState && lastState.current && lastState.current.song;
    if (cur && typeof MediaMetadata !== 'undefined') {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: cur.title || cur.text || '',
        artist: cur.artist || '',
        album: cur.album || '',
        // 锁屏封面：歌对象 pic 字段（providers 归一化输出，状态广播带下来）
        artwork: cur.pic ? [{ src: cur.pic, sizes: '300x300', type: 'image/jpeg' }] : [],
      });
    }
    try {
      // 锁屏控制 → 服务器级暂停/切歌（暂停=流切静音，元素不停，后台安全）
      navigator.mediaSession.setActionHandler('play', () => { if (lastState && lastState.paused) stateSend({ type: 'resume' }); });
      navigator.mediaSession.setActionHandler('pause', () => { if (lastState && !lastState.paused) stateSend({ type: 'pause' }); });
      navigator.mediaSession.setActionHandler('nexttrack', () => stateSend({ type: 'skip' }));
      // 服务器协议没有「上一首」指令（连续流也无法倒带），显式置 null 隐藏锁屏该按钮
      navigator.mediaSession.setActionHandler('previoustrack', null);
    } catch {}
  }

  function setStatus(text) { $('status').textContent = text; }

  // ---------- 声音自检：网页能查的全部查一遍，直接给结论 ----------
  // 音量/蓝牙路由是系统级信息，网页拿不到——能查的全绿时，问题必在手机设置上
  function runSelfCheck() {
    const lines = [];
    if (streamAttached && audio.error) startRadio(); // 顺手修复：点自检即重挂流（加载失败态很可能已停摆）
    const st = lastState;
    if (!st) {
      lines.push('⚠️ 连不上服务器：检查手机网络，确认和电脑连同一个 Wi-Fi');
    } else {
      lines.push('🖥 服务器：' + (st.playerOnline ? '播放端在线' : '⚠️ 无播放端')
        + (st.streamActive ? '，电台模式' : '')
        + (st.paused ? '，暂停中' : '，播放中'));
    }
    if (!streamAttached) {
      lines.push('⚠️ 音频流没连上：网络问题或口令不对');
    } else if (audio.error) {
      lines.push('⚠️ 音频加载失败：网络问题，正在自动重连');
    } else if (audio.paused) {
      lines.push('⚠️ 音频被停住：点「点击继续播放」恢复');
    } else if (!playingFired) {
      lines.push('⚠️ 音频还没出声：点击屏幕任意位置激活');
    } else {
      lines.push('📻 音频在正常播放');
    }
    if (stalled) lines.push('⏳ 缓冲卡顿中：网络不稳定，进度已冻结');
    lines.push('🔊 服务器共享音量：' + (st ? st.volume : '?'));
    const allOk = st && streamAttached && !audio.error && !audio.paused && playingFired && !stalled;
    if (allOk) {
      lines.push('✅ 网页侧一切正常，歌曲确实在播放');
      lines.push('→ 还没声音？问题在手机系统设置：');
      lines.push('① 媒体音量：按侧键拉满（不是铃声音量）');
      lines.push('② 蓝牙：可能连到了别的设备或没开机的设备——先关蓝牙，声音会立刻回手机喇叭');
      lines.push('③ 静音键/勿扰模式（部分安卓手机会静音媒体）');
    }
    $('diagResult').innerHTML = lines.map(esc).join('<br />');
    $('diagOverlay').classList.remove('hidden');
  }

  // ---------- 口令 ----------
  function failToken() {
    localStorage.removeItem(TOKEN_KEY);
    token = '';
    streamAttached = false;
    clearTimeout(streamTimer);
    $('tokenErr').textContent = '口令不正确，请重新输入';
    $('tokenInput').value = '';
    $('tokenOverlay').classList.remove('hidden');
  }

  // ---------- 切回前台自动恢复 ----------
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    tryAutoResume();
    // 后台时看门狗定时器被系统节流，断线可能没被发现：切回前台立即补一次重连安排
    if (!stateWs || stateWs.readyState > 1) scheduleStateReconnect();
  });

  // 恢复播放 = 换新源重连（被打断的 stale 流直接 play() 会卡死，必须重新挂流；&ts 防缓存）。
  // 顺序关键：先挂流（冻结期注册不触发整首重播），'playing' 事件里再解冻服务器（断点续推）
  function recoverPlayback() {
    $('interruptOverlay').classList.add('hidden');
    attachStream();
  }

  // 别的 App 抢声音会把元素停掉；stale 流直接 play() 会卡死，切回前台直接换新源重连起播，
  // 被系统手势策略拦住（NotAllowedError）就亮打断层，层上一点即换源恢复；
  // 服务器解冻在 'playing' 事件里发（挂流成功才解冻，避免断点空跑）
  function tryAutoResume() {
    const wasInterrupted = streamAttached && (interrupted || audio.paused) && !!audio.getAttribute('src');
    if (!wasInterrupted) return;
    // 打断走打断层；自动播放被拦走待激活层（后台回来没有手势上下文，play() 可能仍被拒）
    attachStream(interrupted ? () => $('interruptOverlay').classList.remove('hidden') : showTapOverlay);
  }

  // ---------- 事件绑定与启动 ----------
  $('diagBtn').addEventListener('click', runSelfCheck);
  $('diagClose').addEventListener('click', () => $('diagOverlay').classList.add('hidden'));
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
    startRadio();
  });
  $('hijackBanner').addEventListener('pointerdown', () => attachStream()); // 重连即重新注册，夺回播放权
  // 打断层整层可点（按钮只是视觉提示），一点即换新源重连恢复
  $('interruptOverlay').addEventListener('pointerdown', () => recoverPlayback());
  $('pauseBtn').addEventListener('click', () => {
    if (!lastState || !lastState.current) return;
    stateSend({ type: lastState.paused ? 'resume' : 'pause' });
  });
  $('skipBtn').addEventListener('click', () => stateSend({ type: 'skip' }));

  // 进度每秒心跳（连续流没有真实 timeupdate 语义，只能定时估算）
  setInterval(renderProgress, 1000);

  if (!localStorage.getItem(ROM_HINT_KEY)) $('romHint').classList.remove('hidden');

  connectState(); // 网页身份先连上，没口令也能看队列
  if (token) {
    startRadio(); // 首载即尝试起播；被自动播放策略拦下就亮「轻触解锁」层
  } else {
    $('tokenOverlay').classList.remove('hidden');
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
