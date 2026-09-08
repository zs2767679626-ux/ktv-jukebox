// 已点视图：在播 + 队列列表，支持置顶/删除。render 幂等：构建一次，之后仅重建列表。
export function render(el, ctx) {
  if (el.__jukeboxQueue) { update(el, ctx); return; }
  el.__jukeboxQueue = true;
  el.innerHTML = `<div class="card"><h2>已点歌单</h2><div id="queueList"><div class="loading">加载中…</div></div></div>`;
  el.addEventListener('click', (e) => {
    const top = e.target.closest('[data-top]');
    if (top) { ctx.actions.top(top.dataset.top); ctx.toast('已置顶到下一首'); }
    const rm = e.target.closest('[data-remove]');
    if (rm) ctx.actions.remove(rm.dataset.remove);
  });
  update(el, ctx);
}

function update(el, ctx) {
  const st = ctx.state;
  if (!st) return;
  const listEl = el.querySelector('#queueList');
  const rows = [];
  if (st.current) {
    const c = st.current.song;
    rows.push(`
      <div class="queue-item">
        <span class="tag" style="background:var(--green);color:#000;font-size:10px;padding:2px 6px;border-radius:4px">在播</span>
        <div class="body"><div class="name">${esc(c.title || c.text)}</div>
        <div class="meta">${esc(c.artist || '')}</div></div>
      </div>`);
  }
  for (const q of st.queue || []) {
    const s = q.song;
    rows.push(`
      <div class="queue-item">
        <div class="body"><div class="name">${esc(s.title || s.text)}</div>
        <div class="meta">${esc(s.artist || '')}${s.album ? ' · ' + esc(s.album) : ''}</div></div>
        <div class="ops">
          <button class="op" data-top="${esc(q.id)}">⏫ 置顶</button>
          <button class="op" data-remove="${esc(q.id)}">🗑</button>
        </div>
      </div>`);
  }
  listEl.innerHTML = rows.join('') || '<div class="empty-tip">还没有点过歌，去点歌页来一首吧</div>';
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
