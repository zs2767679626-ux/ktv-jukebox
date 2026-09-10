// 双平台登录（网易云 / QQ音乐）：顶栏徽标 + 扫码弹窗 + 徽标面板。
// 扫码成功后：二维码立即消失 → 显示「登录成功」约 2 秒 → 弹窗自动关闭，扫码人无需任何操作。
// 弹窗里不放退出登录按钮；退出/换账号收进徽标面板。
// 登录态保存在服务器本地（SQLite），重启不丢；登录后会员/VIP 歌可正常播放。

const PLATFORMS = {
  netease: {
    label: '网易云',
    icon: '🎵',
    hint: '用网易云音乐 App 扫码登录，登录后会员歌曲可正常播放',
    scanTip: '请用网易云音乐 App 扫码（扫完在手机上点「确认登录」）',
    vipLabels: { 11: '黑胶VIP', 110: '黑胶VIP', 10: '音乐包', 100: '音乐包' },
  },
  qq: {
    label: 'QQ音乐',
    icon: '🎶',
    hint: '用 QQ 或 QQ音乐 App 扫码登录，登录后 VIP 歌曲可正常播放',
    scanTip: '请用手机 QQ 或 QQ音乐 App 扫码（扫完在手机上点「确认登录」）',
    vipLabels: { 1: '豪华绿钻' },
  },
};

async function getJSON(url, opts = {}) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export function initMusicLogin({ toast }) {
  const badges = document.querySelectorAll('.login-badge[data-provider]');
  if (!badges.length) return;

  // 每个平台一份会话状态
  const sessions = new Map(); // provider -> { status, qrKey, pollTimer }
  for (const b of badges) sessions.set(b.dataset.provider, { status: null, qrKey: '', pollTimer: null });

  let modal = null;   // 扫码弹窗（单例，复用）
  let panel = null;   // 徽标面板（单例，复用）
  let panelFor = '';  // 面板当前属于哪个平台
  let openSeq = 0;    // 每次打开登录表单递增，成功自动关闭时校验，防止误关别人的登录

  const cfg = (p) => PLATFORMS[p] || PLATFORMS.netease;
  const sess = (p) => sessions.get(p);
  const vipLabel = (p, t) => cfg(p).vipLabels[t] || '';

  function badgeOf(p) {
    for (const b of badges) if (b.dataset.provider === p) return b;
    return null;
  }
  function renderBadge(p) {
    const s = sess(p).status;
    const b = badgeOf(p);
    if (!b) return;
    if (s && s.loggedIn) {
      const vip = vipLabel(p, s.vipType);
      b.textContent = `${cfg(p).icon} ${cfg(p).label}：${s.nickname}${vip ? `（${vip}）` : ''}`;
      b.classList.add('logged-in');
    } else {
      b.textContent = `${cfg(p).icon} ${cfg(p).label}未登录`;
      b.classList.remove('logged-in');
    }
  }

  function buildModal() {
    modal = document.createElement('div');
    modal.className = 'nlogin-mask';
    modal.innerHTML = `
      <div class="nlogin">
        <h2 class="title"></h2>
        <p class="hint"></p>
        <div class="qr-wrap"><img alt="登录二维码" /></div>
        <p class="qr-tip"></p>
        <div class="btns">
          <button class="btn refresh">刷新二维码</button>
          <button class="btn close">关闭</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector('.close').onclick = hideModal;
    modal.querySelector('.refresh').onclick = () => {
      const p = modal.dataset.provider;
      if (p) startLogin(p);
    };
    modal.addEventListener('click', (e) => { if (e.target === modal) hideModal(); });
  }

  function stopPolling(p) {
    const s = sess(p);
    clearInterval(s.pollTimer);
    s.pollTimer = null;
  }

  function showModal(p) {
    if (!modal) buildModal();
    modal.dataset.provider = p;
    const c = cfg(p);
    modal.querySelector('.title').textContent = `登录${c.label}音乐`;
    modal.querySelector('.hint').textContent = c.hint;
    modal.classList.remove('hide-qr');
    modal.classList.add('show');
  }

  // 扫码成功：二维码消失 → 显示「登录成功」约 2 秒 → 弹窗自动关闭
  function showSuccess(p, mySeq) {
    const s = sess(p).status;
    const c = cfg(p);
    const vip = vipLabel(p, s.vipType);
    modal.classList.add('hide-qr');
    modal.querySelector('.title').textContent = `${c.label}已登录`;
    modal.querySelector('.hint').textContent = `当前账号：${s.nickname}${vip ? `（${vip}）` : ''}`;
    modal.querySelector('.qr-tip').textContent = '';
    toast(`${c.label}登录成功：${s.nickname}${vip ? `（${vip}）` : ''}，VIP 歌可正常播放`, 3000);
    setTimeout(() => {
      if (openSeq === mySeq) hideModal();
    }, 2000);
  }

  async function startLogin(p) {
    showModal(p);
    stopPolling(p);
    const mySeq = ++openSeq;
    const c = cfg(p);
    const tip = modal.querySelector('.qr-tip');
    const img = modal.querySelector('.qr-wrap img');
    img.src = '';
    tip.textContent = '正在获取二维码…';
    try {
      const r = await getJSON('/api/auth/qr-login', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: p }),
      });
      if (mySeq !== openSeq) return; // 期间用户已切换到别的登录流程
      sess(p).qrKey = r.qrKey;
      // 接口返回的图片可能自带 data: 前缀，避免双前缀
      img.src = String(r.qrImg).startsWith('data:') ? r.qrImg : 'data:image/png;base64,' + r.qrImg;
      tip.textContent = c.scanTip;
      sess(p).pollTimer = setInterval(() => pollCheck(p, mySeq), 2000);
    } catch (e) {
      tip.textContent = '获取二维码失败：' + e.message;
    }
  }

  async function pollCheck(p, mySeq) {
    const s = sess(p);
    if (!s.qrKey) return;
    try {
      const r = await getJSON('/api/auth/qr-check', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: p, qrKey: s.qrKey }),
      });
      if (mySeq !== openSeq) return;
      const tip = modal.querySelector('.qr-tip');
      if (r.code === 803) {
        stopPolling(p);
        s.status = { loggedIn: true, nickname: r.nickname || '', vipType: r.vipType || 0 };
        renderBadge(p);
        showSuccess(p, mySeq);
      } else if (r.code === 802) {
        tip.textContent = '已扫码，请在手机上确认登录';
      } else if (r.code === 800) {
        stopPolling(p);
        tip.textContent = '二维码已过期，点「刷新二维码」重试';
      }
    } catch (e) {
      stopPolling(p);
      modal.querySelector('.qr-tip').textContent = '查询失败：' + e.message;
    }
  }

  async function logout(p) {
    stopPolling(p);
    try {
      await getJSON('/api/auth/logout', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: p }),
      });
      sess(p).status = null;
      renderBadge(p);
      hidePanel();
      toast(`已退出${cfg(p).label}登录`, 2000);
    } catch (e) {
      toast('退出失败：' + e.message, 2000);
    }
  }

  function hideModal() {
    if (!modal) return;
    openSeq++;
    for (const p of sessions.keys()) stopPolling(p);
    modal.classList.remove('show');
  }

  // ===== 徽标面板：当前账号 + 换账号 + 退出登录 =====
  function buildPanel() {
    panel = document.createElement('div');
    panel.className = 'login-panel';
    panel.innerHTML = `
      <p class="account"></p>
      <div class="btns">
        <button class="btn relogin">换账号</button>
        <button class="btn danger logout">退出登录</button>
      </div>`;
    document.body.appendChild(panel);
    panel.querySelector('.relogin').onclick = () => {
      const p = panelFor;
      hidePanel();
      startLogin(p);
    };
    panel.querySelector('.logout').onclick = () => logout(panelFor);
    document.addEventListener('click', (e) => {
      if (panel.classList.contains('show')
        && !panel.contains(e.target)
        && !e.target.closest('.login-badge')) hidePanel();
    });
  }

  function showPanel(p) {
    if (!panel) buildPanel();
    panelFor = p;
    const s = sess(p).status;
    const c = cfg(p);
    const vip = s && s.loggedIn ? vipLabel(p, s.vipType) : '';
    panel.querySelector('.account').textContent = `当前账号：${s.nickname}${vip ? `（${vip}）` : ''}`;
    const b = badgeOf(p);
    const r = b.getBoundingClientRect();
    panel.style.top = `${r.bottom + 6}px`;
    panel.style.left = `${Math.max(8, r.right - 180)}px`;
    panel.classList.add('show');
  }
  function hidePanel() {
    if (panel) panel.classList.remove('show');
  }

  for (const b of badges) {
    b.addEventListener('click', () => {
      const p = b.dataset.provider;
      const s = sess(p).status;
      if (s && s.loggedIn) {
        if (panel && panelFor === p && panel.classList.contains('show')) hidePanel();
        else showPanel(p);
      } else {
        hidePanel();
        startLogin(p);
      }
    });
  }

  // 页面加载时同步两个平台的登录态
  for (const p of sessions.keys()) {
    getJSON(`/api/auth/login-status?provider=${p}`).then((r) => {
      sess(p).status = r.status;
      renderBadge(p);
    }).catch(() => { /* 服务未就绪时保持默认文案 */ });
  }
}
