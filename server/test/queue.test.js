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
    now: overrides.now || (() => 1700000000000),
    initialMode: overrides.initialMode,
    isStreamPlayerActive: overrides.isStreamPlayerActive || (() => false),
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

test('URL 解析期间按暂停：解析完成后补发 pause，保住暂停语义', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { j, events } = setup({
    resolveUrl: async () => { await gate; return { url: 'http://example.com/a.mp3' }; },
  });
  j.playerHello();
  j.addToQueue(song('A'));
  await flush(); // playItem 卡在解析（QQ 取链阶梯要 1~3 秒，此窗口完全可能按暂停）
  j.pause();
  assert.equal(j.getState().paused, true);
  release();
  await flush(); await flush();
  const playerEvs = events.filter((e) => e[0] === 'player');
  const playIdx = playerEvs.findIndex((e) => e[1].action === 'play');
  assert.ok(playIdx >= 0, '应发出 play');
  assert.ok(playerEvs.slice(playIdx + 1).some((e) => e[1].action === 'pause'), 'play 之后应补发 pause');
  assert.equal(j.getState().paused, true, '暂停语义保持');
});

test('暂停中切歌：新歌不带暂停出生（旧实现把 stale 暂停传染给后续每首歌）', async () => {
  const { j, events } = setup();
  j.playerHello();
  j.addToQueue(song('A'));
  j.addToQueue(song('B'));
  await flush();
  j.pause();
  assert.equal(j.getState().paused, true);
  j.skip();
  await flush();
  assert.equal(j.getState().current.song.title, 'B');
  assert.equal(j.getState().paused, false, '切歌后暂停语义作废：新歌正常出声');
  // B 的 play 之后不应跟 pause（暂停语义已被 skip 清掉）
  const playerEvs = events.filter((e) => e[0] === 'player');
  const playIdx = playerEvs.map((e) => e[1].action).lastIndexOf('play');
  assert.ok(!playerEvs.slice(playIdx + 1).some((e) => e[1].action === 'pause'), 'B 起播不带 pause');
  // 新歌自己的暂停/恢复仍正常平移进度（断点不被旧暂停窗口污染）
  let t = 1700000000000;
  const { j: j2 } = setup({ now: () => t });
  j2.playerHello();
  j2.addToQueue(song('A'));
  j2.addToQueue(song('B'));
  await flush();
  j2.pause();
  t += 5000;
  j2.skip();
  await flush();
  const startedAt = j2.getState().current.started_at;
  j2.pause();
  t += 10000;
  j2.resume();
  assert.equal(j2.getState().current.started_at, startedAt + 10000, '恢复只平移本次暂停窗口');
});

test('暂停中解析失败接播：新歌同样不带暂停出生', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { j } = setup({
    resolveUrl: async (s) => {
      if (s.title === 'A') { await gate; return { error: 'unavailable' }; } // A 卡在解析
      return { url: 'http://example.com/b.mp3' };
    },
  });
  j.playerHello();
  j.addToQueue(song('A'));
  j.addToQueue(song('B'));
  await flush(); // A 仍在解析中
  j.pause(); // 暂停语义挂在解析中的 A 上
  assert.equal(j.getState().paused, true);
  release(); // A 解析失败 → 跳过 → 接播 B
  await flush(); await flush();
  assert.equal(j.getState().current.song.title, 'B');
  assert.equal(j.getState().paused, false, '失败接播的新歌不带暂停出生');
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

test('播放端断线：当前歌与队列原样保留（不跳歌），重连续播当前歌', async () => {
  const { j, history, events } = setup();
  j.playerHello();
  j.addToQueue(song('A'));
  j.addToQueue(song('B'));
  await flush();
  j.playerGone();
  assert.equal(j.getState().current.song.title, 'A'); // 当前歌不丢
  assert.equal(j.getState().queue.length, 1);          // 队列不丢
  assert.equal(j.getState().playerOnline, false);
  assert.equal(history.records[0].status, 'playing');  // 不记断线跳过
  assert.ok(events.some((e) => e[0] === 'toast'), '网页端收到保留提示');
  const plays = () => events.filter((e) => e[0] === 'player' && e[1].action === 'play').length;
  const before = plays();
  j.playerHello(); // 重连：续播当前歌，不插队
  await flush();
  assert.equal(j.getState().current.song.title, 'A');
  assert.equal(j.getState().queue.length, 1);
  assert.equal(plays(), before + 1);
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

test('列表循环：解析失败跳过不回填历史，安静停下', async () => {
  let listCalls = 0;
  const { j, events, history } = setup({
    initialMode: 'list',
    listPlayed: () => { listCalls++; return [row('老歌1')]; },
    resolveUrl: async (song) => (song.title === 'A' ? { error: 'vip' } : { url: 'http://example.com/old.mp3' }),
  });
  j.playerHello();
  j.addToQueue(song('A'));
  await flush();
  assert.equal(j.getState().current, null); // 失败就安静停下，不接播老歌
  assert.equal(listCalls, 0);
  assert.equal(history.records.at(-1).status, 'skipped');
  assert.ok(!events.some((e) => e[0] === 'player' && e[1].action === 'play'));
});

test('列表循环：播放错误跳过不回填历史，安静停下', async () => {
  let listCalls = 0;
  const { j, history } = setup({
    initialMode: 'list',
    listPlayed: () => { listCalls++; return [row('老歌1')]; },
  });
  j.playerHello();
  j.addToQueue(song('A'));
  await flush(); // A 正常开播
  j.playerEvent('error', {});
  await flush();
  assert.equal(j.getState().current, null); // 失败就安静停下，不接播老歌
  assert.equal(listCalls, 0);
  assert.equal(history.records[0].status, 'skipped');
});

test('player_event started：以真实起播点重置 started_at（电台流首块/恢复重头播）', async () => {
  let t = 1700000000000;
  const { j, history } = setup({ now: () => t });
  j.playerHello();
  j.addToQueue(song('A'));
  await flush();
  assert.equal(j.getState().current.started_at, 1700000000000); // 起播指令时的起点
  t = 1700000005000; // 真实起播发生在 5 秒后（流首块/播放器加载完成）
  j.playerEvent('started');
  assert.equal(j.getState().current.started_at, 1700000005000);
  assert.equal(history.records[0].updates.at(-1).started_at, 1700000005000);
});

test('流播放端在位时以 mp3Only 解析（QQ 不落 C400/m4a）', async () => {
  let optsSeen = null;
  const { j } = setup({
    isStreamPlayerActive: () => true,
    resolveUrl: async (song, opts) => { optsSeen = opts; return { url: 'http://example.com/a.mp3' }; },
  });
  j.playerHello();
  j.addToQueue(song('A'));
  await flush();
  assert.deepEqual(optsSeen, { mp3Only: true });
});

test('流播放端接管：重解析当前歌（缓存 URL 可能是 m4a），暂停语义保住', async () => {
  let streamActive = false;
  const urls = [];
  const { j, events } = setup({
    isStreamPlayerActive: () => streamActive,
    resolveUrl: async (song, opts) => { urls.push(opts); return { url: 'http://example.com/' + urls.length + '.mp3' }; },
  });
  j.playerHello(); // 普通端先上线
  j.addToQueue(song('A'));
  await flush(); // 普通端解析完成、play 已发
  assert.deepEqual(urls[0], { mp3Only: false });
  events.length = 0;
  streamActive = true; // 电台流接管
  j.playerHello();
  await flush();
  assert.deepEqual(urls[1], { mp3Only: true }); // 不信任缓存 URL，重新解析
  const plays = events.filter((e) => e[0] === 'player' && e[1].action === 'play');
  assert.equal(plays.length, 1);
  assert.equal(plays[0][1].url, 'http://example.com/2.mp3');
  // 暂停状态下被流端接管：不重播（重播会毁掉断点），只重申暂停语义；恢复时流端从断点续推
  j.pause();
  events.length = 0;
  j.playerHello();
  await flush();
  assert.deepEqual(events.filter((e) => e[0] === 'player').map((e) => e[1].action), ['volume', 'mute', 'pause']);
  assert.equal(urls.length, 2); // 暂停接管不重新解析（断点还在，无需重取）
});

test('流端冻结/解冻（断线宽限期）：同暂停语义但不向播放端发指令，进度平移', async () => {
  let t = 1700000000000;
  const { j, events } = setup({ now: () => t });
  j.playerHello();
  j.addToQueue(song('晴天'));
  await flush();
  const cmdCount = () => events.filter((e) => e[0] === 'player').length;
  const base = cmdCount();
  t += 5000;
  j.freezeStream();
  assert.equal(j.getState().paused, true);
  assert.equal(cmdCount(), base, '冻结不向播放端发指令');
  const startedAt = j.getState().current.started_at;
  t += 30000;
  j.resumeStream();
  assert.equal(j.getState().paused, false);
  assert.equal(cmdCount(), base, '解冻不向播放端发指令');
  assert.equal(j.getState().current.started_at, startedAt + 30000, '冻结窗口被平移掉');
});
