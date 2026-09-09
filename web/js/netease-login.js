// 网易云登录：顶栏徽标 + 二维码弹窗（App 扫码登录）。
// 登录态保存在服务器本地（SQLite），重启不丢；登录后会员歌可正常播放。
const VIP_LABELS = { 11: '黑胶VIP', 110: '黑胶VIP', 10: '音乐包', 100: '音乐包' };

async function getJSON(url, opts = {}) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function vipLabel(t) {
  return VIP_LABELS[t] || '';
}

export function initNeteaseLogin({ toast }) {
  const badge = document.getElementById('netease-login');
  if (!badge) return;

  let status = null; // { loggedIn, nickname, vipType } | null
  let qrKey = '';
  let pollTimer = null;
  let modal = null;

  function renderBadge() {
    if (status && status.loggedIn) {
      const vip = vipLabel(status.vipType);
      badge.textContent = `🎵 网易云：${status.nickname}${vip ? `（${vip}）` : ''}`;
      badge.classList.add('logged-in');
    } else {
      badge.textContent = '🎵 网易云未登录';
      badge.classList.remove('logged-in');
    }
  }

  function buildModal() {
    modal = document.createElement('div');
    modal.className = 'nlogin-mask';
    modal.innerHTML = `
      <div class="nlogin">
        <h2 class="title">登录网易云音乐</h2>
        <p class="hint">用网易云音乐 App 扫码登录，登录后会员歌曲可正常播放</p>
        <div class="qr-wrap"><img alt="登录二维码" /></div>
        <p class="qr-tip"></p>
        <div class="btns">
          <button class="btn refresh">刷新二维码</button>
          <button class="btn danger logout">退出登录</button>
          <button class="btn close">关闭</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector('.close').onclick = () => hideModal();
    modal.querySelector('.refresh').onclick = startLogin;
    modal.querySelector('.logout').onclick = logout;
    modal.addEventListener('click', (e) => { if (e.target === modal) hideModal(); });
  }

  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  function showLoggedIn() {
    modal.querySelector('.title').textContent = '网易云已登录';
    const vip = vipLabel(status.vipType);
    modal.querySelector('.hint').textContent = `当前账号：${status.nickname}${vip ? `（${vip}）` : ''}`;
    modal.querySelector('.qr-tip').textContent = '';
    modal.classList.add('hide-qr');
    modal.classList.add('show');
  }

  function showLoginForm() {
    modal.querySelector('.title').textContent = '登录网易云音乐';
    modal.querySelector('.hint').textContent = '用网易云音乐 App 扫码登录，登录后会员歌曲可正常播放';
    modal.classList.remove('hide-qr');
  }

  async function startLogin() {
    if (!modal) buildModal();
    stopPolling();
    showLoginForm();
    const tip = modal.querySelector('.qr-tip');
    const img = modal.querySelector('.qr-wrap img');
    img.src = '';
    tip.textContent = '正在获取二维码…';
    modal.classList.add('show');
    try {
      const r = await getJSON('/api/netease/qr-login', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      qrKey = r.qrKey;
      // 网易云返回的 qrimg 可能自带 data: 前缀，避免双前缀
      img.src = String(r.qrImg).startsWith('data:') ? r.qrImg : 'data:image/png;base64,' + r.qrImg;
      tip.textContent = '请用网易云音乐 App 扫码（扫完在手机上点「确认登录」）';
      pollTimer = setInterval(pollCheck, 2000);
    } catch (e) {
      tip.textContent = '获取二维码失败：' + e.message;
    }
  }

  async function pollCheck() {
    if (!qrKey) return;
    try {
      const r = await getJSON('/api/netease/qr-check', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ qrKey }),
      });
      const tip = modal.querySelector('.qr-tip');
      if (r.code === 803) {
        stopPolling();
        status = { loggedIn: true, nickname: r.nickname || '', vipType: r.vipType || 0 };
        renderBadge();
        showLoggedIn();
        toast(`网易云登录成功：${status.nickname}${vipLabel(status.vipType) ? `（${vipLabel(status.vipType)}）` : ''}，会员歌可正常播放`, 3000);
      } else if (r.code === 802) {
        tip.textContent = '已扫码，请在手机上确认登录';
      } else if (r.code === 800) {
        stopPolling();
        tip.textContent = '二维码已过期，点「刷新二维码」重试';
      }
    } catch (e) {
      stopPolling();
      modal.querySelector('.qr-tip').textContent = '查询失败：' + e.message;
    }
  }

  async function logout() {
    stopPolling();
    try {
      await getJSON('/api/netease/logout', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      status = null;
      renderBadge();
      hideModal();
      toast('已退出网易云登录', 2000);
    } catch (e) {
      toast('退出失败：' + e.message, 2000);
    }
  }

  function hideModal() {
    stopPolling();
    if (modal) modal.classList.remove('show');
  }

  badge.addEventListener('click', () => {
    if (!modal) buildModal();
    if (status && status.loggedIn) showLoggedIn();
    else startLogin();
  });

  // 页面加载时同步一次登录态
  getJSON('/api/netease/login-status').then((r) => {
    status = r.status;
    renderBadge();
  }).catch(() => { /* 服务未就绪时保持默认文案 */ });
}
