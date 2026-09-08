// 点歌视图：搜索 + 分类宫格 + 子页面（歌手/榜单/风格/拼音/歌单/歌曲列表）
// render 幂等：首次构建 DOM 并挂一次性委托监听；后续调用直接返回（浏览中的子页不被状态刷新打断）。

let langMap = null; // 语种榜过滤结果（模块级，供 tab 切换）

export function render(el, ctx) {
  if (el.__jukeboxPoint) return;
  el.__jukeboxPoint = true;
  el.innerHTML = `
    <div class="card">
      <h2>点首歌</h2>
      <div class="search-box">
        <div class="input-row">
          <input id="q" type="text" placeholder="歌名或歌手：周杰伦、晴天、海阔天空 Beyond…" autocomplete="off" />
        </div>
        <div class="candidates" id="candidates"></div>
      </div>
      <div class="hint">输入自动搜索；点候选即可点歌。已点列表里可置顶/删除。</div>
    </div>
    <div class="card">
      <h2>分类点歌</h2>
      <div class="grid" id="tiles">${tilesHtml()}</div>
    </div>
    <div class="card" id="subpage" style="display:none"></div>`;
  bind(el, ctx);
}

// ===== 工具函数（模块级） =====
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function feeTag(fee) {
  if (fee === 1) return '<span class="tag vip">VIP</span>';
  if (fee === 4) return '<span class="tag fee">付费</span>';
  return '';
}
function fmtDur(ms) {
  if (!ms) return '';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
const TILES = [
  { icon: '🎤', name: '歌手', page: 'artistCats' },
  { icon: '🌍', name: '语种', page: 'toplist', arg: { lang: true } },
  { icon: '🎨', name: '风格', page: 'styles' },
  { icon: '🔤', name: '拼音A-Z', page: 'letters' },
  { icon: '🔥', name: '热门榜', page: 'toplist', arg: { id: '3778678' } },
  { icon: '✨', name: '新歌榜', page: 'toplist', arg: { id: '3779629' } },
];
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
// 语种榜关键词过滤（网易云榜单名包含这些词）
const LANG_KEYS = [['华语', '华语'], ['欧美', '欧美'], ['日韩', '日本', '日语', '韩语', '韩国'], ['粤语', '粤语']];

function tilesHtml() {
  return TILES.map((t) => `
    <div class="tile" data-page="${t.page}" data-arg='${t.arg ? esc(JSON.stringify(t.arg)) : ''}'>
      <span class="icon">${t.icon}</span>${t.name}
    </div>`).join('');
}
function SONG_ROW(s) {
  return `
    <div class="song-row">
      <div class="body">
        <div class="name">${esc(s.title || s.text || '')}</div>
        <div class="meta">${esc(s.artist || '')}${s.album ? ' · ' + esc(s.album) : ''}</div>
      </div>
      <span class="dur">${fmtDur(s.duration_ms)}</span>
      ${feeTag(s.fee)}
      <button class="btn primary" data-song='${esc(JSON.stringify(s))}'>点歌</button>
    </div>`;
}

// ===== 事件与页面逻辑 =====
function bind(el, ctx) {
  const { actions } = ctx;
  const $ = (s) => el.querySelector(s);

  function request(song) {
    actions.request({ text: `${song.title || ''} ${song.artist || ''}`.trim(), ...song });
    ctx.toast('已点 🎵');
    $('#q').value = '';
    $('#candidates').classList.remove('show');
  }
  function hideSub() { $('#subpage').style.display = 'none'; $('#subpage').innerHTML = ''; }
  function subhead(title) {
    return `<div class="subhead"><button class="back">← 返回</button><h2>${esc(title)}</h2></div>`;
  }
  function tabRowHtml(tabs, activeKey) {
    return `<div class="subhead" style="margin-bottom:8px">${tabs.map(([key, label]) =>
      `<button class="sub-tab" data-tabkey="${esc(key)}" style="${key === activeKey ? 'color:var(--accent);font-weight:600' : ''}">${esc(label)}</button>`).join('')}</div>`;
  }
  function renderListRows(lists) {
    return lists.map((t) => `
      <div class="song-row"><div class="body"><div class="name">${esc(t.name)}</div></div>
      <button class="btn" data-toplist="${esc(t.id)}">进去</button></div>`).join('');
  }
  function renderLangLists(key) {
    const keys = [...langMap.keys()];
    const active = key || keys[0];
    $('#subpage').innerHTML = subhead('语种榜') +
      tabRowHtml(keys.map((k) => [k, k]), active) +
      renderListRows(langMap.get(active) || []);
  }

  // ===== 搜索（防抖 280ms；input 事件冒泡，委托在 el 上） =====
  let debounce = null;
  let seq = 0;
  el.addEventListener('input', (e) => {
    if (e.target.id !== 'q') return;
    clearTimeout(debounce);
    const q = e.target.value.trim();
    if (!q) { $('#candidates').classList.remove('show'); return; }
    debounce = setTimeout(() => search(q), 280);
  });
  async function search(q) {
    const mySeq = ++seq;
    try {
      const data = await getJSON('/api/search', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q }),
      });
      if (mySeq !== seq) return;
      renderCandidates(data.results || []);
    } catch {
      if (mySeq === seq) {
        $('#candidates').innerHTML = '<div class="empty-tip">暂时不可用，请稍后重试</div>';
        $('#candidates').classList.add('show');
      }
    }
  }
  function renderCandidates(results) {
    $('#candidates').innerHTML = results.length
      ? results.map((s) => `
        <div class="cand" data-song='${esc(JSON.stringify(s))}'>
          <div class="body"><div class="name">${esc(s.title)}</div>
            <div class="meta">${esc(s.artist)}${s.album ? ' · ' + esc(s.album) : ''}</div></div>
          <span class="dur">${fmtDur(s.duration_ms)}</span>${feeTag(s.fee)}
        </div>`).join('')
      : '<div class="empty-tip">没找到，换个词试试？</div>';
    $('#candidates').classList.add('show');
  }

  // ===== 子页面 =====
  async function artistList(type) {
    $('#subpage').style.display = 'block';
    $('#subpage').innerHTML = '<div class="loading">加载中…</div>';
    try {
      const data = await getJSON(`/api/artists?type=${type}`);
      const list = data.artists || [];
      $('#subpage').innerHTML = subhead('歌手') +
        tabRowHtml([['male', '男歌手'], ['female', '女歌手'], ['band', '组合']], type) +
        list.map((a) => `
        <div class="song-row"><div class="body"><div class="name">${esc(a.name)}</div></div>
        <button class="btn" data-artist="${esc(a.id)}">进去</button></div>`).join('');
    } catch (err) {
      $('#subpage').innerHTML = `<div class="empty-tip">加载失败：${esc(String(err.message || err))}</div>`;
    }
  }
  async function songPage(title, fetchSongs) {
    $('#subpage').style.display = 'block';
    $('#subpage').innerHTML = '<div class="loading">加载中…</div>';
    try {
      const data = await fetchSongs();
      const songs = data.songs || [];
      $('#subpage').innerHTML = subhead(title) + (songs.length
        ? songs.map((s) => SONG_ROW(s)).join('')
        : '<div class="empty-tip">没有找到歌曲</div>');
    } catch (err) {
      $('#subpage').innerHTML = `<div class="empty-tip">加载失败：${esc(String(err.message || err))}</div>`;
    }
  }
  async function stylePage(cat) {
    $('#subpage').innerHTML = '<div class="loading">加载中…</div>';
    try {
      const data = await getJSON(`/api/style-playlists?cat=${encodeURIComponent(cat)}`);
      $('#subpage').innerHTML = subhead(cat) + (data.playlists || []).map((p) => `
        <div class="song-row"><div class="body"><div class="name">${esc(p.name)}</div></div>
        <button class="btn" data-playlist="${esc(p.id)}">进去</button></div>`).join('');
    } catch (err) {
      $('#subpage').innerHTML = `<div class="empty-tip">加载失败：${esc(String(err.message || err))}</div>`;
    }
  }
  async function letterList(letter) {
    $('#subpage').innerHTML = '<div class="loading">加载中…</div>';
    try {
      const data = await getJSON(`/api/artists?type=male&initial=${letter}`);
      const list = data.artists || [];
      $('#subpage').innerHTML = subhead(`拼音 ${letter}`) + list.map((a) => `
        <div class="song-row"><div class="body"><div class="name">${esc(a.name)}</div></div>
        <button class="btn" data-artist="${esc(a.id)}">进去</button></div>`).join('');
    } catch (err) {
      $('#subpage').innerHTML = `<div class="empty-tip">加载失败：${esc(String(err.message || err))}</div>`;
    }
  }
  async function openPage(page, arg = {}) {
    $('#subpage').style.display = 'block';
    $('#subpage').innerHTML = '<div class="loading">加载中…</div>';
    try {
      if (page === 'artistCats') { await artistList('male'); return; }
      if (page === 'toplist') {
        if (arg.id) { await songPage('榜单歌曲', () => getJSON(`/api/toplist?id=${arg.id}`)); return; }
        const data = await getJSON('/api/toplist');
        const lists = data.lists || [];
        if (arg.lang) {
          langMap = new Map();
          for (const [label, ...keys] of LANG_KEYS) {
            const found = lists.filter((l) => keys.some((k) => l.name.includes(k)));
            if (found.length) langMap.set(label, found);
          }
          if (langMap.size) renderLangLists();
          else $('#subpage').innerHTML = subhead('语种榜') + '<div class="empty-tip">暂无语种榜数据</div>';
        } else {
          $('#subpage').innerHTML = subhead('榜单') + renderListRows(lists);
        }
        return;
      }
      if (page === 'styles') {
        const data = await getJSON('/api/catlist');
        $('#subpage').innerHTML = subhead('风格') + `<div class="grid">${(data.cats || []).map((c) =>
          `<div class="tile" data-style="${esc(c)}">${esc(c)}</div>`).join('')}</div>`;
        return;
      }
      if (page === 'letters') {
        $('#subpage').innerHTML = subhead('拼音索引') + `<div class="grid">${LETTERS.map((l) =>
          `<div class="tile" data-letter="${l}">${l}</div>`).join('')}</div>`;
        return;
      }
    } catch (err) {
      $('#subpage').innerHTML = `<div class="empty-tip">加载失败：${esc(String(err.message || err))}</div>`;
    }
  }

  // ===== 一次性委托（唯一监听挂载点） =====
  el.addEventListener('click', (e) => {
    const songEl = e.target.closest('[data-song]');
    if (songEl) { request(JSON.parse(songEl.dataset.song)); return; }
    const tile = e.target.closest('.tile[data-page]');
    if (tile) { openPage(tile.dataset.page, tile.dataset.arg ? JSON.parse(tile.dataset.arg) : {}); return; }
    if (e.target.closest('#subpage .back')) { hideSub(); return; }
    const tab = e.target.closest('[data-tabkey]');
    if (tab) {
      if (langMap && langMap.has(tab.dataset.tabkey)) { renderLangLists(tab.dataset.tabkey); return; }
      artistList(tab.dataset.tabkey);
      return;
    }
    const tl = e.target.closest('[data-toplist]');
    if (tl) { songPage('榜单歌曲', () => getJSON(`/api/toplist?id=${tl.dataset.toplist}`)); return; }
    const st = e.target.closest('[data-style]');
    if (st) { stylePage(st.dataset.style); return; }
    const pl = e.target.closest('[data-playlist]');
    if (pl) { songPage('歌单', () => getJSON(`/api/playlist-songs?id=${pl.dataset.playlist}`)); return; }
    const lt = e.target.closest('[data-letter]');
    if (lt) { letterList(lt.dataset.letter); return; }
    const ar = e.target.closest('[data-artist]');
    if (ar) { songPage('歌手歌曲', () => getJSON(`/api/artist-songs?id=${ar.dataset.artist}`)); return; }
  });
}
