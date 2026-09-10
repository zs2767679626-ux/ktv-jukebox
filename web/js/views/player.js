// 播放视图：当前歌曲、进度条、控制条（暂停/切歌/音量/静音）、下一首预告。
// 歌词（Task 10）与二维码（Task 12）在本文件扩展。
// render 幂等：首次构建 DOM + 挂监听，之后仅原地更新字段。

import { parseLrc, activeIndex } from '../lrc.js';

// 歌词状态（模块级）
let lyricLines = [];
let lyricSongId = null;
let lastActive = -1;

export function render(el, ctx) {
  if (el.__jukeboxPlayer) { update(el, ctx); return; }
  el.__jukeboxPlayer = true;
  el.innerHTML = `
    <div class="now empty" id="now">
      <div class="label">NOW PLAYING</div>
      <div class="song" id="nowTitle">还没有歌，去点一首吧</div>
      <div class="meta" id="nowMeta"></div>
      <div class="progress"><i id="progressBar" style="width:0%"></i></div>
      <div class="meta" id="nextUp"></div>
    </div>
    <div class="card">
      <h2>控制 <span id="playerStatus" style="font-size:11px;color:var(--dim);text-transform:none"></span></h2>
      <div class="controls">
        <button class="btn primary" id="pauseBtn" disabled>⏸ 暂停</button>
        <button class="btn" id="skipBtn" disabled>⏭ 切歌</button>
        <button class="btn" id="muteBtn">🔊</button>
        <div class="vol-row">
          <span style="font-size:13px;color:var(--dim)">音量</span>
          <input type="range" id="volSlider" min="0" max="100" step="1" value="60" />
          <span id="volVal" style="font-size:12px;color:var(--dim);width:32px;text-align:right">60</span>
        </div>
      </div>
      <div class="hint">所有人共享控制权：暂停/切歌/音量对全体实时生效</div>
    </div>
    <div class="card">
      <h2>歌词</h2>
      <div class="lyrics" id="lyrics"><div class="empty-tip">暂无歌词</div></div>
    </div>
    <div class="card qr">
      <h2>扫码点歌</h2>
      <div id="qrcode"></div>
      <p class="qr-tip">同事用手机扫一扫，直接进入点歌台</p>
    </div>`;
  bind(el, ctx);
  update(el, ctx);
  tick(el, ctx);
}

function bind(el, ctx) {
  el.querySelector('#pauseBtn').addEventListener('click', () => ctx.actions.togglePause());
  el.querySelector('#skipBtn').addEventListener('click', () => {
    if (ctx.state && ctx.state.current) ctx.actions.skip();
  });
  el.querySelector('#muteBtn').addEventListener('click', () => ctx.actions.toggleMute());
  const slider = el.querySelector('#volSlider');
  slider.addEventListener('input', () => {
    el.querySelector('#volVal').textContent = slider.value;
    ctx.actions.setVolume(Number(slider.value));
  });
  setInterval(() => tick(el, ctx), 250);
  // 二维码（qrcodejs 全局对象；vendor 缺失时静默跳过）。
  // 内容优先取服务器局域网地址——即使用 127.0.0.1 打开页面，同事手机扫到的也是手机能访问的地址。
  function renderQr(text) {
    if (typeof window.QRCode === 'undefined') return;
    new window.QRCode(el.querySelector('#qrcode'), {
      text,
      width: 128, height: 128,
      correctLevel: window.QRCode.CorrectLevel.M,
    });
  }
  fetch('/api/server-info')
    .then((r) => r.json())
    .then((info) => renderQr((info.lanUrls && info.lanUrls[0]) || (location.origin + location.pathname)))
    .catch(() => renderQr(location.origin + location.pathname));
}

function update(el, ctx) {
  const st = ctx.state;
  if (!st) return;
  const cur = st.current;
  const nowEl = el.querySelector('#now');
  const title = el.querySelector('#nowTitle');
  const meta = el.querySelector('#nowMeta');
  const nextUp = el.querySelector('#nextUp');
  const skipBtn = el.querySelector('#skipBtn');
  const pauseBtn = el.querySelector('#pauseBtn');
  const status = el.querySelector('#playerStatus');

  if (cur && (cur.song.title || cur.song.text)) {
    nowEl.classList.remove('empty');
    const provIco = cur.song.provider === 'qq' ? '🎶' : '🎵';
    title.textContent = `${provIco} ${cur.song.title || cur.song.text}` + (cur.song.artist ? ' · ' + cur.song.artist : '');
    const parts = [];
    if (cur.song.duration_ms) parts.push(fmtDur(cur.song.duration_ms));
    if (cur.started_at) parts.push('开始于 ' + fmtAgo(cur.started_at, ctx));
    meta.textContent = parts.join('  ·  ');
    skipBtn.disabled = false;
    pauseBtn.disabled = false;
  } else {
    nowEl.classList.add('empty');
    title.textContent = '还没有歌，去点一首吧';
    meta.textContent = '';
    skipBtn.disabled = true;
    pauseBtn.disabled = true;
  }
  pauseBtn.textContent = st.paused ? '▶ 继续' : '⏸ 暂停';
  el.querySelector('#muteBtn').textContent = st.muted ? '🔇' : '🔊';
  const slider = el.querySelector('#volSlider');
  if (document.activeElement !== slider) slider.value = st.volume; // 拖动中不抢值
  el.querySelector('#volVal').textContent = st.volume;
  const next = st.queue[0];
  nextUp.textContent = next
    ? `下一首：${next.song.provider === 'qq' ? '🎶' : '🎵'} ${next.song.title || next.song.text}${next.song.artist ? ' · ' + next.song.artist : ''}`
    : (cur ? '队列已空' : '');
  status.textContent = st.playerOnline ? '' : '⚠ 播放端离线，点歌会排队';
  status.style.color = st.playerOnline ? 'var(--dim)' : 'var(--gold)';
}

function tick(el, ctx) {
  const st = ctx.state;
  if (!st || !st.current) { loadLyrics(el, ctx); return; }
  const cur = st.current;
  // 进度
  const bar = el.querySelector('#progressBar');
  if (cur.song.duration_ms && cur.started_at && !st.paused) {
    const pct = Math.max(0, Math.min(100, ((ctx.serverNow() - cur.started_at) / cur.song.duration_ms) * 100));
    bar.style.width = pct.toFixed(1) + '%';
  }
  if (st.paused) return;
  // 歌词
  if (lyricSongId !== cur.song.song_id) { loadLyrics(el, ctx); return; }
  if (!lyricLines.length) return;
  const t = (ctx.serverNow() - cur.started_at) / 1000;
  const idx = activeIndex(lyricLines, t);
  if (idx !== lastActive) {
    const prev = el.querySelector(`.lyric-line[data-i="${lastActive}"]`);
    if (prev) prev.classList.remove('active');
    const lineEl = el.querySelector(`.lyric-line[data-i="${idx}"]`);
    if (lineEl) {
      lineEl.classList.add('active');
      if (idx > lastActive) lineEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    lastActive = idx;
  }
}

function fmtDur(ms) {
  if (!ms) return '';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function fmtAgo(unixMs, ctx) {
  const diff = Math.floor(ctx.serverNow() / 1000) - Math.floor(unixMs / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  return `${Math.floor(diff / 3600)} 小时前`;
}

async function loadLyrics(el, ctx) {
  const cur = ctx.state && ctx.state.current;
  const box = el.querySelector('#lyrics');
  if (!cur || !cur.song.song_id) {
    lyricLines = []; lyricSongId = null; lastActive = -1;
    box.innerHTML = '<div class="empty-tip">暂无歌词</div>';
    return;
  }
  if (lyricSongId === cur.song.song_id) return;
  lyricSongId = cur.song.song_id;
  lyricLines = []; lastActive = -1;
  box.innerHTML = '<div class="empty-tip">歌词加载中…</div>';
  try {
    const r = await fetch(`/api/lyric?id=${encodeURIComponent(cur.song.song_id)}&provider=${encodeURIComponent(cur.song.provider || '')}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    lyricLines = parseLrc(data.lrc);
    if (!lyricLines.length) { box.innerHTML = '<div class="empty-tip">纯音乐</div>'; return; }
    box.innerHTML = lyricLines.map((l, i) => `<div class="lyric-line" data-i="${i}">${esc(l.text)}</div>`).join('');
  } catch {
    box.innerHTML = '<div class="empty-tip">歌词获取失败</div>';
    lyricLines = [];
  }
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
