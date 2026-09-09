import { createWsClient } from './ws-client.js';
import { store } from './state.js';
import { bindActions } from './actions.js';
import { initNeteaseLogin } from './netease-login.js';
import * as pointView from './views/point.js';
import * as playerView from './views/player.js';
import * as queueView from './views/queue.js';

const connEl = document.getElementById('conn');
const toastEl = document.getElementById('toast');
const tabsEl = document.getElementById('tabs');

let toastTimer = null;
function toast(msg, ms = 2000) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

const ws = createWsClient(`${location.origin.replace(/^http/, 'ws')}/ws`, {
  onMessage: (m) => {
    if (m.type === 'state') {
      store.apply(m);
      window.__jukeboxState = m.state; // actions.js 读取 paused 用
    } else if (m.type === 'toast') {
      toast(m.msg);
    }
  },
  onStatus: (s) => {
    connEl.textContent = s === 'online' ? '🟢 已连接' : '🔴 断线重连中…';
    connEl.className = 'sub' + (s === 'online' ? '' : ' offline');
  },
});

const actions = bindActions(ws);
const ctx = {
  get state() { return store.state; },
  actions,
  toast,
  serverNow: () => store.serverNow(),
  isDesktop: () => window.matchMedia('(min-width: 768px)').matches,
};

const views = {
  point: pointView,
  player: playerView,
  queue: queueView,
};

// 视图渲染是幂等的：各视图首次构建 DOM + 挂监听，之后原地更新。
// 启动时先渲染一次（state 尚为空，各视图自行显示占位），保证首屏有内容。
function renderAll() {
  for (const [name, view] of Object.entries(views)) {
    view.render(document.getElementById('view-' + name), ctx);
  }
}

store.subscribe(renderAll);
ws.connect();
renderAll();

initNeteaseLogin({ toast });

// 移动端标签切换
tabsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.body.dataset.view = btn.dataset.view;
  tabsEl.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
});
document.body.dataset.view = 'point';
