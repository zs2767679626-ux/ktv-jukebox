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
  try { await handler({ rt, ws, nextMsg, history, port }); }
  finally { server.close(); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('网页端点歌 → 广播 state，播放端收到 play 指令', async () => {
  await withRealtime(async ({ ws, nextMsg }) => {
    const player = await ws();
    player.send(JSON.stringify({ type: 'player_hello', token: 'tok' }));
    await sleep(30);
    const web = await ws();
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
  await withRealtime(async ({ ws, nextMsg }) => {
    const player = await ws();
    player.send(JSON.stringify({ type: 'player_hello', token: 'tok' }));
    await sleep(30);
    const web1 = await ws();
    const web2 = await ws();
    web1.send(JSON.stringify({ type: 'play_request', song: { text: 'A', song_id: '1', title: 'A', duration_ms: 1000, fee: 0 } }));
    await nextMsg(web1); await nextMsg(web2);
    web1.send(JSON.stringify({ type: 'play_request', song: { text: 'B', song_id: '2', title: 'B', duration_ms: 1000, fee: 0 } }));
    await nextMsg(web1);
    player.send(JSON.stringify({ type: 'player_event', event: 'finished' }));
    const [m1, m2] = await Promise.all([nextMsg(web1), nextMsg(web2)]);
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
  await withRealtime(async ({ ws, nextMsg }) => {
    const player = await ws();
    player.send(JSON.stringify({ type: 'player_hello', token: 'tok' }));
    await sleep(30);
    const web = await ws();
    const song = (t) => JSON.stringify({ type: 'play_request', song: { text: t, song_id: t, title: t, duration_ms: 1000, fee: 0 } });
    web.send(song('A')); await nextMsg(web);
    web.send(song('B')); await nextMsg(web);
    web.send(song('C')); await nextMsg(web);
    let m = await nextMsg(web);
    const bId = m.state.queue.find((x) => x.song.title === 'B').id;
    web.send(JSON.stringify({ type: 'queue_top', id: bId })); m = await nextMsg(web);
    assert.equal(m.state.queue[0].song.title, 'B');
    web.send(JSON.stringify({ type: 'queue_remove', id: bId })); m = await nextMsg(web);
    assert.equal(m.state.queue[0].song.title, 'C');
    web.send(JSON.stringify({ type: 'pause' })); m = await nextMsg(web);
    assert.equal(m.state.paused, true);
    web.send(JSON.stringify({ type: 'resume' }));
    web.send(JSON.stringify({ type: 'volume_set', value: 77 })); m = await nextMsg(web);
    assert.equal(m.state.volume, 77);
    web.send(JSON.stringify({ type: 'mute_toggle' })); m = await nextMsg(web);
    assert.equal(m.state.muted, true);
    web.send(JSON.stringify({ type: 'skip' })); m = await nextMsg(web);
    assert.equal(m.state.current.song.title, 'C');
    web.close(); player.close();
  });
});
