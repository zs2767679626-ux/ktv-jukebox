'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createJukebox } = require('../src/queue');

// 构造一个带记录能力的假历史 + 事件收集器
function setup(overrides = {}) {
  const events = []; // ['player', cmd] | ['state', state] | ['toast', msg]
  const settings = {};
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
    listPlayed: overrides.listPlayed || (() => []),
    setSetting: (k, v) => { settings[k] = v; },
  };
  const j = createJukebox({
    resolveUrl: overrides.resolveUrl || (async () => ({ url: 'http://example.com/a.mp3' })),
    sendToPlayer: (cmd) => events.push(['player', cmd]),
    broadcast: () => events.push(['state', j.getState()]),
    toast: (msg) => events.push(['toast', msg]),
    history,
    now: () => 1700000000000,
    initialMode: overrides.initialMode,
  });
  return { j, events, history, settings };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const song = (title) => ({ text: title, song_id: '1', title, artist: 'X', duration_ms: 60000, fee: 0 });
const row = (title) => ({ id: 1, song_id: 's' + title, title, artist: 'X', album: null, text: title, duration_ms: 60000, fee: 0, provider: 'netease', status: 'played' });

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
  j.topQueue(state.queue[1].id); // C 置顶：验证真正搬移（队尾→队首）
  assert.equal(j.getState().queue[0].song.title, 'C');
  assert.equal(j.getState().queue[1].song.title, 'B');
  assert.equal(j.getState().current.song.title, 'A'); // 不打断当前
  j.removeQueue(j.getState().queue[0].id);
  assert.equal(j.getState().queue[0].song.title, 'B');
  const removed = history.records.find((r) => r.song.title === 'C');
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

test('播放错误：历史记 reason 并自动下一首；音频设备掉线则不续播（队列留档）', async () => {
  const { j, history } = setup();
  j.playerHello();
  j.addToQueue(song('A'));
  j.addToQueue(song('B'));
  j.addToQueue(song('C'));
  await flush();
  j.playerEvent('error', { reason: '加载失败' }); // A 错误 → 自动播 B
  await flush();
  assert.equal(j.getState().current.song.title, 'B');
  assert.equal(history.records[0].updates.at(-1).reason, '加载失败');
  j.playerEvent('error', { reason: '音频设备掉线' }); // B 掉线 → 不续播，C 留在队列
  await flush();
  assert.equal(j.getState().current, null);
  assert.equal(j.getState().queue.length, 1);
  assert.equal(j.getState().queue[0].song.title, 'C');
  assert.equal(history.records[1].updates.at(-1).reason, '音频设备掉线');
  j.playerHello(); // 设备恢复重连 → 播队首 C
  await flush();
  assert.equal(j.getState().current.song.title, 'C');
});

test('播放中 resolveUrl 尚未返回时切歌，结果作废', async () => {
  const resolvers = {};
  const { j, events, history } = setup({
    resolveUrl: (song) => new Promise((r) => { resolvers[song.title] = r; }),
  });
  j.playerHello();
  j.addToQueue(song('A'));
  j.addToQueue(song('B'));
  await flush(); // A 的 resolveUrl 还挂着
  j.skip(); // current 是 A（url 未决），直接结算跳过；B 开播、url 同样未决
  await flush();
  assert.equal(j.getState().current.song.title, 'B');
  assert.equal(history.records[0].status, 'skipped');
  resolvers.A({ url: 'http://example.com/late.mp3' }); // A 的迟到结果必须作废
  await flush();
  const plays = () => events.filter((e) => e[0] === 'player' && e[1].action === 'play');
  assert.equal(plays().length, 0); // 迟到结果不得触发 play 指令
  assert.equal(j.getState().current.song.title, 'B'); // 也不得顶替 current
  resolvers.B({ url: 'http://example.com/b.mp3' });
  await flush();
  assert.equal(plays().length, 1);
  assert.equal(plays()[0][1].song.title, 'B'); // 只有 B 正常开播
});

test('VIP 歌解析失败 → toast 版权受限，已自动跳过', async () => {
  const { j, events, history } = setup({ resolveUrl: async () => ({ error: 'vip' }) });
  j.playerHello();
  j.addToQueue(song('A'));
  await Promise.resolve(); // 排空解析链微任务（resolveUrl 返回 vip → finishCurrent + toast）
  await Promise.resolve();
  assert.ok(events.some((e) => e[0] === 'toast' && e[1] === '版权受限，已自动跳过'));
  assert.equal(history.records[0].status, 'skipped');
  assert.equal(history.records[0].updates.at(-1).reason, '版权受限');
  assert.ok(!events.some((e) => e[0] === 'player' && e[1].action === 'play'));
});

test('unavailable → toast 无法获取播放地址，已自动跳过', async () => {
  const { j, events, history } = setup({ resolveUrl: async () => ({ error: 'unavailable' }) });
  j.playerHello();
  j.addToQueue(song('A'));
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(events.some((e) => e[0] === 'toast' && e[1] === '无法获取播放地址，已自动跳过'));
  assert.equal(history.records[0].status, 'skipped');
  assert.equal(history.records[0].updates.at(-1).reason, '无法获取播放地址');
  assert.ok(!events.some((e) => e[0] === 'player' && e[1].action === 'play'));
});

test('播放端 error 事件 → toast 播放错误，已自动跳过', async () => {
  const { j, events, history } = setup();
  j.playerHello();
  j.addToQueue(song('A'));
  await flush(); // 等 URL 解析完成、play 指令发出
  assert.ok(events.some((e) => e[0] === 'player' && e[1].action === 'play'));
  j.playerEvent('error', {});
  assert.ok(events.some((e) => e[0] === 'toast' && e[1] === '播放错误，已自动跳过'));
  assert.equal(history.records[0].status, 'skipped');
  assert.equal(history.records[0].updates.at(-1).reason, '播放错误');
});

test('播放端替换后重发当前歌 play', async () => {
  const { j, events } = setup();
  j.playerHello(); // 第一个播放端上线
  j.addToQueue(song('晴天'));
  await flush(); // 等 URL 解析完成、play 指令发出
  const firstPlay = events.find((e) => e[0] === 'player' && e[1].action === 'play');
  assert.ok(firstPlay, '应发出 play 指令');
  assert.equal(firstPlay[1].url, 'http://example.com/a.mp3'); // current.url 已解析
  const before = j.getState().current;
  events.length = 0; // 清空记录，模拟旧连接已不可达、新连接接管

  j.playerHello(); // 新播放端接管：重发当前歌
  const cmds = events.filter((e) => e[0] === 'player');
  assert.deepEqual(cmds.map((c) => c[1].action), ['volume', 'mute', 'play']);
  assert.deepEqual(cmds[2][1], {
    action: 'play',
    url: 'http://example.com/a.mp3',
    song: song('晴天'),
    volume: j.getState().volume,
    muted: j.getState().muted,
  });
  assert.deepEqual(j.getState().current, before); // 当前歌不变

  // 暂停语义：接管时若处于暂停，重发 play 之后补发 pause
  j.pause();
  events.length = 0;
  j.playerHello();
  const cmds2 = events.filter((e) => e[0] === 'player');
  assert.deepEqual(cmds2.map((c) => c[1].action), ['volume', 'mute', 'play', 'pause']);
});

test('单曲循环：finished 重播同一首，切歌可跳出', async () => {
  const { j, events, history } = setup({ initialMode: 'single' });
  j.playerHello();
  j.addToQueue(song('A'));
  await flush();
  j.playerEvent('finished');
  await flush();
  assert.equal(j.getState().current.song.title, 'A');
  assert.equal(events.filter((e) => e[0] === 'player' && e[1].action === 'play').length, 2);
  assert.equal(history.records.length, 2);
  assert.equal(history.records[0].status, 'played');
  j.addToQueue(song('B'));
  await flush();
  j.skip();
  await flush();
  assert.equal(j.getState().current.song.title, 'B'); // 切歌跳出循环
});

test('单曲循环：重播解析失败自动跳过，不死循环', async () => {
  let calls = 0;
  const { j, events, history } = setup({
    initialMode: 'single',
    resolveUrl: async () => (++calls > 1 ? { error: 'unavailable' } : { url: 'http://example.com/a.mp3' }),
  });
  j.playerHello();
  j.addToQueue(song('A'));
  await flush();
  j.playerEvent('finished');
  await flush();
  assert.equal(j.getState().current, null); // 解析失败跳过，没有第三次 play
  assert.equal(events.filter((e) => e[0] === 'player' && e[1].action === 'play').length, 1);
  assert.equal(history.records.at(-1).status, 'skipped');
});

test('列表循环：队列放空后自动回填已播歌曲并续播（最早优先）', async () => {
  const { j } = setup({ initialMode: 'list', listPlayed: () => [row('老歌1'), row('老歌2')] });
  j.playerHello();
  j.addToQueue(song('A'));
  await flush();
  j.playerEvent('finished');
  await flush();
  assert.equal(j.getState().current.song.title, '老歌1');
  assert.equal(j.getState().queue.length, 1);
  assert.equal(j.getState().queue[0].song.title, '老歌2');
});

test('顺序模式：队列空即停，不回填', async () => {
  const { j } = setup({ listPlayed: () => [row('老歌1')] });
  j.playerHello();
  j.addToQueue(song('A'));
  await flush();
  j.playerEvent('finished');
  await flush();
  assert.equal(j.getState().current, null);
});

test('列表循环：队列非空时不触发回填（排队歌先播）', async () => {
  let listCalls = 0;
  const { j } = setup({ initialMode: 'list', listPlayed: () => { listCalls++; return [row('老歌1')]; } });
  j.playerHello();
  j.addToQueue(song('A'));
  j.addToQueue(song('B'));
  await flush();
  j.playerEvent('finished');
  await flush();
  assert.equal(j.getState().current.song.title, 'B');
  assert.equal(listCalls, 0);
});

test('setMode 变更广播并持久化，非法值忽略', () => {
  const { j, events, settings } = setup();
  j.setMode('list');
  assert.equal(j.getState().mode, 'list');
  assert.equal(settings.play_mode, 'list');
  assert.ok(events.some((e) => e[0] === 'state' && e[1].mode === 'list'));
  j.setMode('bogus');
  assert.equal(j.getState().mode, 'list');
});

test('initialMode 仅接受合法值', () => {
  assert.equal(setup({ initialMode: 'single' }).j.getState().mode, 'single');
  assert.equal(setup({ initialMode: 'whatever' }).j.getState().mode, 'order');
});
