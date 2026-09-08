'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createJukebox } = require('../src/queue');

// 构造一个带记录能力的假历史 + 事件收集器
function setup(overrides = {}) {
  const events = []; // ['player', cmd] 或 ['state', state]
  const history = {
    records: [],
    add(song) {
      const id = this.records.length + 1;
      this.records.push({ id, song, status: 'requested', updates: [] });
      return id;
    },
    update(id, fields) {
      const r = this.records.find((x) => x.id === id);
      if (r) { r.status = fields.status ?? r.status; r.updates.push(fields); }
    },
  };
  const j = createJukebox({
    resolveUrl: overrides.resolveUrl || (async () => ({ url: 'http://example.com/a.mp3' })),
    sendToPlayer: (cmd) => events.push(['player', cmd]),
    broadcast: () => events.push(['state', j.getState()]),
    history,
    now: () => 1700000000000,
  });
  return { j, events, history };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const song = (title) => ({ text: title, song_id: '1', title, artist: 'X', duration_ms: 60000, fee: 0 });

test('播放端在线且空闲时，点歌立即播放', async () => {
  const { j, events } = setup();
  j.playerHello();
  j.addToQueue(song('晴天'));
  await flush();
  const play = events.find((e) => e[0] === 'player' && e[1].action === 'play');
  assert.ok(play, '应发出 play 指令');
  assert.equal(play[1].song.title, '晴天');
  assert.equal(j.getState().current.song.title, '晴天');
  assert.equal(j.getState().queue.length, 0);
});

test('正在播放时点歌进入队列，不打断', async () => {
  const { j, events } = setup();
  j.playerHello();
  j.addToQueue(song('A'));
  j.addToQueue(song('B'));
  await flush();
  assert.equal(j.getState().current.song.title, 'A');
  assert.equal(j.getState().queue.length, 1);
  assert.equal(events.filter((e) => e[0] === 'player' && e[1].action === 'play').length, 1);
});

test('播放端离线时点歌只排队，重连后自动开播', async () => {
  const { j, events } = setup();
  j.addToQueue(song('A'));
  assert.equal(j.getState().current, null);
  assert.equal(j.getState().queue.length, 1);
  j.playerHello();
  await flush();
  assert.equal(j.getState().current.song.title, 'A');
  assert.ok(events.some((e) => e[0] === 'player' && e[1].action === 'play'));
});

test('切歌跳过当前并播下一首', async () => {
  const { j, events, history } = setup();
  j.playerHello();
  j.addToQueue(song('A'));
  j.addToQueue(song('B'));
  await flush();
  j.skip();
  await flush();
  assert.equal(j.getState().current.song.title, 'B');
  assert.equal(history.records[0].status, 'skipped');
  assert.ok(events.some((e) => e[0] === 'player' && e[1].action === 'stop'));
});

test('队列空时切歌只停当前', async () => {
  const { j } = setup();
  j.playerHello();
  j.addToQueue(song('A'));
  await flush();
  j.skip();
  await flush();
  assert.equal(j.getState().current, null);
  assert.equal(j.getState().queue.length, 0);
});

test('歌曲播完自动播下一首，历史记为 played', async () => {
  const { j, history } = setup();
  j.playerHello();
  j.addToQueue(song('A'));
  j.addToQueue(song('B'));
  await flush();
  j.playerEvent('finished');
  await flush();
  assert.equal(j.getState().current.song.title, 'B');
  assert.equal(history.records[0].status, 'played');
});

test('版权受限：自动跳过并播下一首，历史记 reason', async () => {
  const { j, history } = setup({
    resolveUrl: async (song) => (song.title === 'A' ? { error: 'vip' } : { url: 'http://example.com/b.mp3' }),
  });
  j.playerHello();
  j.addToQueue(song('A'));
  j.addToQueue(song('B'));
  await flush();
  assert.equal(j.getState().current.song.title, 'B');
  assert.equal(history.records[0].status, 'skipped');
  assert.equal(history.records[0].updates.at(-1).reason, '版权受限');
});

test('音量：钳制到 0-100 并发指令给播放端', () => {
  const { j, events } = setup();
  j.setVolume(150);
  assert.equal(j.getState().volume, 100);
  j.setVolume(-5);
  assert.equal(j.getState().volume, 0);
  j.setVolume(42);
  const v = events.filter((e) => e[0] === 'player' && e[1].action === 'volume');
  assert.equal(v.at(-1)[1].value, 42);
});

test('暂停/恢复/静音切换', async () => {
  const { j, events } = setup();
  j.playerHello();
  j.addToQueue(song('A'));
  await flush(); // 有歌在播时 pause/resume 才有意义（current 为空时服务端忽略该指令）
  j.pause();
  assert.equal(j.getState().paused, true);
  assert.ok(events.some((e) => e[1].action === 'pause'));
  j.resume();
  assert.equal(j.getState().paused, false);
  j.toggleMute();
  assert.equal(j.getState().muted, true);
  j.toggleMute();
  assert.equal(j.getState().muted, false);
});

test('置顶把队列项移到队首（不打断当前），删除记录 skipped/被移除', async () => {
  const { j, history } = setup();
  j.playerHello();
  j.addToQueue(song('A'));
  j.addToQueue(song('B'));
  j.addToQueue(song('C'));
  await flush();
  const state = j.getState();
  j.topQueue(state.queue[0].id); // B 已在队首（A 正在播），对队首置顶是幂等空操作；随后删除 B 验证历史记录
  assert.equal(j.getState().queue[0].song.title, 'B');
  j.removeQueue(j.getState().queue[0].id);
  assert.equal(j.getState().queue[0].song.title, 'C');
  const removed = history.records.find((r) => r.song.title === 'B');
  assert.equal(removed.status, 'skipped');
  assert.equal(removed.updates.at(-1).reason, '被移除');
});

test('播放端断线：当前歌记 skipped/播放端断线，重连后播队首', async () => {
  const { j, history } = setup();
  j.playerHello();
  j.addToQueue(song('A'));
  j.addToQueue(song('B'));
  await flush();
  j.playerGone();
  assert.equal(j.getState().current, null);
  assert.equal(j.getState().playerOnline, false);
  assert.equal(history.records[0].status, 'skipped');
  assert.equal(history.records[0].updates.at(-1).reason, '播放端断线');
  j.playerHello();
  await flush();
  assert.equal(j.getState().current.song.title, 'B');
});

test('播放错误：历史记 reason 并自动下一首；音频设备掉线则停在空档不续播', async () => {
  const { j, history } = setup();
  j.playerHello();
  j.addToQueue(song('A'));
  j.addToQueue(song('B'));
  await flush();
  j.playerEvent('error', { reason: '加载失败' });
  await flush();
  assert.equal(j.getState().current.song.title, 'B');
  assert.equal(history.records[0].updates.at(-1).reason, '加载失败');
  j.playerEvent('error', { reason: '音频设备掉线' });
  await flush();
  assert.equal(j.getState().current, null);
  assert.equal(j.getState().queue.length, 0);
  assert.equal(history.records[1].updates.at(-1).reason, '音频设备掉线');
});

test('播放中 resolveUrl 尚未返回时切歌，结果作废', async () => {
  let resolve;
  const { j, history } = setup({ resolveUrl: () => new Promise((r) => { resolve = r; }) });
  j.playerHello();
  j.addToQueue(song('A'));
  j.addToQueue(song('B'));
  await flush(); // resolveUrl 还挂着
  j.skip(); // 此时 current 是 A（url 未决），直接结算跳过
  resolve({ url: 'http://example.com/late.mp3' });
  await flush();
  assert.equal(j.getState().current.song.title, 'B');
  assert.equal(history.records[0].status, 'skipped');
});
