'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { WebSocket } = require('ws');
const { createRealtime } = require('../src/ws');

function fakeHistory() {
  const records = [];
  return {
    records,
    add(song) { const id = records.length + 1; records.push({ id, song, status: 'requested', updates: [] }); return id; },
    update(id, f) { const r = records.find((x) => x.id === id); if (r) { r.status = f.status ?? r.status; r.updates.push(f); } },
    listPlayed: () => [],
    getSetting: () => null,
    setSetting: () => {},
  };
}

async function withRealtime(handler, opts = {}) {
  const server = http.createServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const history = fakeHistory();
  const rt = createRealtime({
    server, history,
    resolveUrl: opts.resolveUrl || (async () => ({ url: 'http://x.mp3' })),
    isPlayerToken: opts.isPlayerToken || ((t) => t === 'tok'),
  });
  const ws = (path = '/ws') => new Promise((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    w.on('open', () => resolve(w));
    w.on('error', reject);
  });
  const nextMsg = (w) => new Promise((resolve) => {
    w.on('message', function h(data) { w.off('message', h); resolve(JSON.parse(data)); });
  });
  // 播放路径一次动作会广播多条 state（playItem 解析前后各一条；finished 先发 current=null 帧再发新 current 帧），
  // 用谓词排水等到目标状态，避免一次性 nextMsg 消费偏移；5s 超时转成测试失败而非挂死。
  const nextState = (w, pred) => new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { w.off('message', h); reject(new Error('nextState 等待目标状态超时')); }, 5000);
    function h(data) {
      const m = JSON.parse(data);
      if (m.type !== 'state' || !pred(m.state)) return;
      clearTimeout(deadline);
      w.off('message', h);
      resolve(m);
    }
    w.on('message', h);
  });
  // 与 nextState 同构：排水到 toast 帧；5s 超时转失败
  const nextToast = (w) => new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { w.off('message', h); reject(new Error('nextToast 等待超时')); }, 5000);
    function h(data) {
      const m = JSON.parse(data);
      if (m.type !== 'toast') return;
      clearTimeout(deadline);
      w.off('message', h);
      resolve(m);
    }
    w.on('message', h);
  });
  try { await handler({ rt, ws, nextMsg, nextState, nextToast, history, port }); }
  finally {
    rt.wss.close();
    // 外挂 http server 模式下 wss.close 只摘监听、不关闭存量客户端；测试失败路径没走到 web.close()
    // 时会留一条活连接，node 进程事件循环不空、裸 node --test 不退出。显式 terminate 掉兜底。
    for (const c of rt.wss.clients) c.terminate();
    server.close();
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('网页端点歌 → 广播 state，播放端收到 play 指令', async () => {
  await withRealtime(async ({ ws, nextMsg }) => {
    const player = await ws();
    player.send(JSON.stringify({ type: 'player_hello', token: 'tok' }));
    await sleep(30);
    const web = await ws();
    await nextMsg(web); // 排掉连接快照
    web.send(JSON.stringify({ type: 'play_request', song: { text: '晴天 周杰伦', song_id: '186016', title: '晴天', artist: '周杰伦', duration_ms: 269000, fee: 0 } }));
    const stateMsg = await nextMsg(web);
    assert.equal(stateMsg.type, 'state');
    assert.equal(stateMsg.state.current.song.title, '晴天');
    assert.ok(stateMsg.servertime > 0);
    const cmd = await nextMsg(player);
    assert.equal(cmd.type, 'player_cmd');
    assert.equal(cmd.cmd.action, 'play');
    assert.equal(cmd.cmd.volume, 60);
    web.close(); player.close();
  });
});

test('token 错误按网页端处理，不成为播放端', async () => {
  await withRealtime(async ({ ws, nextMsg }) => {
    const w = await ws();
    await nextMsg(w); // 排掉连接快照
    w.send(JSON.stringify({ type: 'player_hello', token: 'wrong' }));
    w.send(JSON.stringify({ type: 'volume_set', value: 20 }));
    const msg = await nextMsg(w);
    assert.equal(msg.type, 'state');
    assert.equal(msg.state.volume, 20); // 网页端指令生效
    assert.equal(msg.state.playerOnline, false);
    w.close();
  });
});

test('播放端 finished → 下一首 play；网页端全部同步收到新 state', async () => {
  await withRealtime(async ({ ws, nextMsg, nextState }) => {
    const player = await ws();
    player.send(JSON.stringify({ type: 'player_hello', token: 'tok' }));
    await sleep(30);
    const web1 = await ws();
    const web2 = await ws();
    await nextMsg(web1); await nextMsg(web2); // 两个网页端各排一帧连接快照
    web1.send(JSON.stringify({ type: 'play_request', song: { text: 'A', song_id: '1', title: 'A', duration_ms: 1000, fee: 0 } }));
    await nextMsg(web1); await nextMsg(web2);
    web1.send(JSON.stringify({ type: 'play_request', song: { text: 'B', song_id: '2', title: 'B', duration_ms: 1000, fee: 0 } }));
    await nextMsg(web1);
    player.send(JSON.stringify({ type: 'player_event', event: 'finished' }));
    // finished 的广播序列：current=null（finishCurrent）→ current=B（playItem 前后各一），排水到目标状态
    const [m1, m2] = await Promise.all([
      nextState(web1, (s) => s.current && s.current.song.title === 'B'),
      nextState(web2, (s) => s.current && s.current.song.title === 'B'),
    ]);
    assert.equal(m1.state.current.song.title, 'B');
    assert.equal(m2.state.current.song.title, 'B');
    web1.close(); web2.close(); player.close();
  });
});

test('播放端断开 → playerOnline:false，当前歌 skipped', async () => {
  await withRealtime(async ({ ws, nextMsg, history }) => {
    const player = await ws();
    player.send(JSON.stringify({ type: 'player_hello', token: 'tok' }));
    await sleep(30);
    const web = await ws();
    await nextMsg(web); // 排掉连接快照
    web.send(JSON.stringify({ type: 'play_request', song: { text: 'A', song_id: '1', title: 'A', duration_ms: 1000, fee: 0 } }));
    await nextMsg(web);
    player.close();
    const m = await nextMsg(web);
    assert.equal(m.state.playerOnline, false);
    assert.equal(m.state.current, null);
    assert.equal(history.records[0].status, 'skipped');
    assert.equal(history.records[0].updates.at(-1).reason, '播放端断线');
    web.close();
  });
});

test('新播放端顶掉旧的，不误伤当前播放（播放端重连场景）', async () => {
  await withRealtime(async ({ ws, nextMsg }) => {
    const p1 = await ws();
    p1.send(JSON.stringify({ type: 'player_hello', token: 'tok' }));
    await sleep(30);
    const web = await ws();
    await nextMsg(web); // 排掉连接快照
    web.send(JSON.stringify({ type: 'play_request', song: { text: 'A', song_id: '1', title: 'A', duration_ms: 1000, fee: 0 } }));
    await nextMsg(web);
    const p2 = await ws();
    p2.send(JSON.stringify({ type: 'player_hello', token: 'tok' }));
    await sleep(100); // 等旧连接 close 事件处理完，若误触发 playerGone，下面的广播会把错误状态暴露出来
    web.send(JSON.stringify({ type: 'volume_set', value: 30 }));
    const m = await nextMsg(web);
    assert.equal(m.state.volume, 30);
    assert.equal(m.state.playerOnline, true);
    assert.equal(m.state.current.song.title, 'A');
    web.close(); p1.close(); p2.close();
  });
});

test('置顶/删除/暂停/音量/静音/切歌指令端到端', async () => {
  await withRealtime(async ({ ws, nextState }) => {
    const player = await ws();
    player.send(JSON.stringify({ type: 'player_hello', token: 'tok' }));
    await sleep(30);
    const web = await ws();
    const song = (t) => JSON.stringify({ type: 'play_request', song: { text: t, song_id: t, title: t, duration_ms: 1000, fee: 0 } });
    web.send(song('A')); await nextState(web, (s) => s.current && s.current.song.title === 'A');
    web.send(song('B')); await nextState(web, (s) => s.queue.some((q) => q.song.title === 'B'));
    web.send(song('C')); const cState = await nextState(web, (s) => s.queue.length === 2);
    const cId = cState.state.queue.find((q) => q.song.title === 'C').id;
    // 置顶 C（队尾→队首真实搬移；若置顶已居队首的 B，topQueue 走幂等分支不广播，测试会挂死）
    web.send(JSON.stringify({ type: 'queue_top', id: cId }));
    let m = await nextState(web, (s) => s.queue[0] && s.queue[0].song.title === 'C');
    assert.equal(m.state.queue[0].song.title, 'C');
    assert.equal(m.state.queue[1].song.title, 'B');
    web.send(JSON.stringify({ type: 'queue_remove', id: cId }));
    m = await nextState(web, (s) => s.queue.length === 1 && s.queue[0].song.title === 'B');
    assert.equal(m.state.queue[0].song.title, 'B');
    web.send(JSON.stringify({ type: 'pause' })); m = await nextState(web, (s) => s.paused === true);
    assert.equal(m.state.paused, true);
    web.send(JSON.stringify({ type: 'resume' }));
    web.send(JSON.stringify({ type: 'volume_set', value: 77 })); m = await nextState(web, (s) => s.volume === 77);
    assert.equal(m.state.volume, 77);
    web.send(JSON.stringify({ type: 'mute_toggle' })); m = await nextState(web, (s) => s.muted === true);
    assert.equal(m.state.muted, true);
    web.send(JSON.stringify({ type: 'skip' })); m = await nextState(web, (s) => s.current && s.current.song.title === 'B');
    assert.equal(m.state.current.song.title, 'B');
    web.close(); player.close();
  });
});

test('VIP 点歌 → 网页端收到版权受限 toast 与 state，历史 skipped', async () => {
  await withRealtime(async ({ ws, nextMsg, nextToast, nextState, history }) => {
    const player = await ws();
    player.send(JSON.stringify({ type: 'player_hello', token: 'tok' }));
    await sleep(30);
    const web = await ws();
    await nextMsg(web); // 排掉连接快照（否则快照帧 current=null 会提前喂饱 sP 谓词）
    web.send(JSON.stringify({ type: 'play_request', song: { text: 'VIP歌', song_id: '1', title: 'VIP歌', fee: 1 } }));
    // toast 帧与其后 playNext 广播的 state 帧同批送达：两个排水监听先就位，
    // 否则后挂的 nextState 会丢掉已送达的 current=null 帧，确定性超时
    const sP = nextState(web, (st) => st.current === null);
    const t = await nextToast(web);
    assert.equal(t.msg, '版权受限，已自动跳过');
    const s = await sP;
    assert.equal(s.state.current, null);
    assert.equal(history.records[0].status, 'skipped');
    assert.equal(history.records[0].updates.at(-1).reason, '版权受限');
    web.close(); player.close();
  }, { resolveUrl: async () => ({ error: 'vip' }) });
});

test('网页端连接即收到初始 state 快照', async () => {
  await withRealtime(async ({ ws, nextMsg }) => {
    const web = await ws();
    const snap = await nextMsg(web);
    assert.equal(snap.type, 'state');
    assert.ok(snap.servertime > 0);
    assert.equal(snap.state.volume, 60);
    assert.equal(snap.state.current, null);
    assert.equal(snap.state.queue.length, 0);
    web.close();
  });
});

test('mode_set 切换播放模式并广播，非法值忽略', async () => {
  await withRealtime(async ({ ws, nextMsg, nextState }) => {
    const web = await ws();
    await nextMsg(web); // 排掉连接快照
    web.send(JSON.stringify({ type: 'mode_set', value: 'list' }));
    const m = await nextState(web, (s) => s.mode === 'list');
    assert.equal(m.state.mode, 'list');
    web.send(JSON.stringify({ type: 'mode_set', value: 'bogus' }));
    web.send(JSON.stringify({ type: 'volume_set', value: 33 })); // 借一次广播确认 mode 未被污染
    const m2 = await nextState(web, (s) => s.volume === 33);
    assert.equal(m2.state.mode, 'list');
    web.close();
  });
});
