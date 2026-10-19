'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const os = require('node:os');
const { WebSocket } = require('ws');
const { createApp } = require('../src/index');

// 电台流（/stream）测试。经 createApp 全量接线（ws.js 虚拟播放端插槽 + queue 状态机），
// fetch 注入假上游 body（node:test 不碰真实网络），字节用 marker 区分来源：
// 0x00=静音，0x41='A' 歌，0x42='B' 歌。
const SILENCE = Buffer.alloc(64); // 测试静音帧（全零）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SONG = (t) => ({ text: t, song_id: t, title: t, artist: 'X', duration_ms: 60000, fee: 0 });

// 假上游：逐块吐字节。gapMs=0 时同步全量 enqueue（本环境 await+setTimeout 每轮要 ~14ms，
// 400 块就是 6 秒，会拖爆 waitFor；同步 enqueue 几毫秒完事）；gapMs>0 时按节奏吐，
// 供「下载中」状态的用例（切歌/顶替要打在下载中途）。cancel/跑完自动停（有界，不泄漏）。
function bodyStream(chunks, gapMs = 0) {
  let done = false;
  return new ReadableStream({
    start(controller) {
      (async () => {
        try {
          for (const c of chunks) {
            if (gapMs > 0) await sleep(gapMs);
            if (done) return;
            controller.enqueue(c);
          }
          if (!done) controller.close();
        } catch { /* 流已销毁 */ }
      })();
    },
    cancel() { done = true; },
  });
}
// marker 字节 × n 块；routes 里的值可以是流本体，也可以是工厂（每次 fetch 新流，供 resume 重取用）。
// 首块开头写 ID3 魔数——stream.js 下载完后校验 mp3 格式，纯 marker 字节会被判为格式错误跳过。
const music = (marker, n = 400, size = 64, gapMs = 0) => () => {
  const chunks = Array.from({ length: n }, () => Buffer.alloc(size, marker));
  chunks[0].write('ID3');
  return bodyStream(chunks, gapMs);
};

const waitFor = async (pred, t = 5000, label = '') => {
  const deadline = Date.now() + t;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(10);
  }
  throw new Error('waitFor 超时：' + label);
};

async function withStream(opts, handler) {
  const resolveCalls = [];
  const fetchCalls = [];
  const routes = opts.routes || {};
  const history = {
    records: [],
    add(song) { const id = this.records.length + 1; this.records.push({ id, song, status: 'requested', updates: [] }); return id; },
    update(id, f) { const r = this.records.find((x) => x.id === id); if (r) { r.status = f.status ?? r.status; r.updates.push(f); } },
    listPlayed: () => [],
    getSetting: () => null,
    setSetting: () => {},
  };
  const providers = {
    resolveUrl: async (song, o) => {
      resolveCalls.push({ song: song.song_id, opts: o });
      return { url: 'http://' + song.song_id + '.mp3' };
    },
  };
  const fetchImpl = async (url, init = {}) => {
    fetchCalls.push({ url, init });
    const r = routes[url];
    if (!r) return { ok: false, status: 404, body: null };
    return { ok: true, status: 200, body: (typeof r === 'function' ? r() : r) };
  };
  const { server, jukebox, wss, streamer } = createApp({
    providers, history,
    isPlayerToken: (t) => t === 'tok',
    webDir: os.tmpdir(),
    lanUrls: [],
    streamOptions: {
      fetchImpl,
      silence: SILENCE,
      silenceIntervalMs: opts.silenceIntervalMs ?? 15,
      stallMs: opts.stallMs ?? 20000,
      evictLimit: opts.evictLimit ?? (1 << 20),
      tickCap: opts.tickCap, // undefined → 生产默认
      graceMs: opts.graceMs ?? 60, // 生产 90s；测试压小加速
    },
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  // 一次性流客户端：排水到谓词满足即毁连返回累计字节；5s 超时转失败
  const openStream = (pred) => new Promise((resolve, reject) => {
    const req = http.get({ port, path: '/stream?token=tok' }, (res) => {
      const chunks = [];
      res.on('data', (c) => { chunks.push(c); if (pred(Buffer.concat(chunks))) { req.destroy(); resolve(Buffer.concat(chunks)); } });
      res.on('error', () => {});
    });
    const deadline = setTimeout(() => { req.destroy(); reject(new Error('openStream 等待数据超时')); }, 5000);
    req.on('error', reject);
    req.on('close', () => clearTimeout(deadline));
  });
  // 常驻流客户端：持续累积字节，测试自己轮询 buf()（观察切歌/接管/驱逐的字节流变化）
  const streamCollector = () => {
    const chunks = [];
    const req = http.get({ port, path: '/stream?token=tok' }, (res) => {
      res.on('data', (c) => chunks.push(c));
      res.on('error', () => {});
    });
    req.on('error', () => {});
    return {
      buf: () => Buffer.concat(chunks),
      len: () => chunks.reduce((s, c) => s + c.length, 0), // 只加总不拷贝：大流量用例轮询不拖慢事件循环
      close: () => req.destroy(),
    };
  };
  const rawGet = (path) => new Promise((resolve, reject) => {
    http.get({ port, path }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    }).on('error', reject);
  });
  const wsClient = () => new Promise((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    w.on('open', () => resolve(w));
    w.on('error', reject);
  });

  try { await handler({ port, jukebox, history, streamer, openStream, streamCollector, rawGet, wsClient, resolveCalls, fetchCalls }); }
  finally {
    wss.close(); // 清 pingTimer，否则 30s interval 挂住进程
    server.close();
    server.closeAllConnections(); // 流式响应永不结束，强制断开才能退出
  }
}

test('/stream 鉴权：无 token 与错 token 均 403 JSON（不被 SPA 兜底吞掉）', async () => {
  await withStream({}, async ({ rawGet }) => {
    for (const path of ['/stream', '/stream?token=bad', '/stream?token=']) {
      const r = await rawGet(path);
      assert.equal(r.status, 403);
      assert.ok(String(r.headers['content-type']).includes('json'));
      assert.deepEqual(JSON.parse(r.body), { error: 'bad token' });
    }
  });
});

test('HEAD 探活 200，不占播放交椅', async () => {
  await withStream({}, async ({ port, jukebox }) => {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ port, path: '/stream?token=tok', method: 'HEAD' }, (res) => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject); req.end();
    });
    assert.equal(status, 200);
    assert.equal(jukebox.getState().playerOnline, false);
  });
});

test('空队列：流客户端注册为播放端并收到静音垫底', async () => {
  await withStream({}, async ({ openStream, jukebox }) => {
    const buf = await openStream((b) => b.length >= 128);
    for (const byte of buf) assert.equal(byte, 0);
    assert.equal(jukebox.getState().playerOnline, true); // 流端上线（虚拟播放端注册成功）
  });
});

test('点歌：流客户端收到音乐字节', async () => {
  await withStream({ routes: { 'http://A.mp3': music(0x41) } }, async ({ jukebox, streamCollector }) => {
    const col = streamCollector();
    await waitFor(() => jukebox.getState().playerOnline, 5000, '流端上线');
    jukebox.addToQueue(SONG('A'));
    await waitFor(() => col.buf().includes(0x41), 5000, 'A 的字节');
    assert.equal(jukebox.getState().current.song.title, 'A');
    col.close();
  });
});

test('切歌：下载中的旧上游被 abort，新歌字节到达', async () => {
  await withStream({
    // A 是 10 秒长下载（流端全量下载完才开推），skip 打在下载中途
    routes: { 'http://A.mp3': music(0x41, 2000, 64, 5), 'http://B.mp3': music(0x42) },
  }, async ({ jukebox, fetchCalls, streamCollector }) => {
    const col = streamCollector();
    await waitFor(() => jukebox.getState().playerOnline, 5000, '流端上线');
    jukebox.addToQueue(SONG('A'));
    jukebox.addToQueue(SONG('B'));
    await waitFor(() => fetchCalls.length >= 1, 5000, 'A 开始下载');
    jukebox.skip();
    await waitFor(() => col.buf().includes(0x42), 5000, 'B 的字节');
    assert.equal(fetchCalls[0].init.signal.aborted, true); // 旧上游已 abort
    assert.equal(jukebox.getState().current.song.title, 'B');
    col.close();
  });
});

test('暂停冻结断点：静音垫底；恢复从断点续推（不重解析、不重置起点）', async () => {
  await withStream({
    routes: { 'http://A.mp3': music(0x41, 400) }, // 快下载（gap 0），5s 超时内稳起播
  }, async ({ jukebox, resolveCalls, streamCollector }) => {
    const col = streamCollector();
    await waitFor(() => jukebox.getState().playerOnline, 5000, '流端上线');
    jukebox.addToQueue(SONG('A'));
    await waitFor(() => col.buf().includes(0x41), 5000, 'A 起播');
    jukebox.pause(); // 喂送中暂停 → 冻结断点（喂送状态保留，不再丢弃重来）
    // 冻结后转静音垫底：先等尾部 256 字节转全零（排掉在途音乐块），再验证静音持续
    await waitFor(() => {
      const b = col.buf();
      return b.length >= 256 && b.subarray(b.length - 256).every((x) => x === 0);
    }, 5000, '暂停后转静音');
    assert.equal(jukebox.getState().paused, true);
    const lenAtPause = col.buf().length;
    await waitFor(() => col.buf().length >= lenAtPause + 256, 5000, '静音持续垫底');
    for (const byte of col.buf().subarray(lenAtPause)) assert.equal(byte, 0);
    await sleep(20);
    const startedAtPause = jukebox.getState().current.started_at;
    const resolveCount = resolveCalls.length;
    jukebox.resume();
    await waitFor(() => col.buf().subarray(col.buf().length - 64).includes(0x41), 5000, '恢复后音乐续推');
    assert.equal(resolveCalls.length, resolveCount); // 冻结路径不重解析、不从头流
    assert.ok(jukebox.getState().current.started_at > startedAtPause); // 冻结窗口被平移掉（started_at += 暂停时长），进度停在断点
    assert.equal(jukebox.getState().paused, false);
    col.close();
  });
});

test('冻结期重连：恢复不重播，推送指针回拨到播放位置续推', async () => {
  await withStream({
    // 4 秒短歌：开播瞬间整首字节已推入在场客户端（推速上限内）；
    // 冻结期间新客户端重连，若恢复时不回拨指针，新客户端只能等到曲末静音
    routes: { 'http://A.mp3': music(0x41, 400) },
  }, async ({ jukebox, resolveCalls, streamCollector }) => {
    const A = SONG('A'); A.duration_ms = 4000;
    const col = streamCollector();
    await waitFor(() => jukebox.getState().playerOnline, 5000, '流端上线');
    jukebox.addToQueue(A);
    await waitFor(() => col.buf().includes(0x41), 5000, 'A 起播（整首字节已推完）');
    jukebox.pause(); // 冻结断点
    const col2 = streamCollector(); // 冻结期重连：缓冲已丢，注册不触发整首重播
    await waitFor(() => col2.len() >= 64, 5000, '冻结期新客户端收到静音垫底');
    for (const byte of col2.buf()) assert.equal(byte, 0);
    const resolveCount = resolveCalls.length;
    jukebox.resume();
    await waitFor(() => col2.buf().includes(0x41), 5000, '恢复后新客户端从断点续收音乐');
    assert.equal(resolveCalls.length, resolveCount); // 不重解析：断点续推而非整首重播
    assert.equal(jukebox.getState().paused, false);
    col.close();
    col2.close();
  });
});

test('上游 404：历史记加载失败并自动接播下一首；全挂则安静停下（不回填历史）', async () => {
  await withStream({ routes: {} }, async ({ jukebox, history, streamCollector }) => {
    const col = streamCollector();
    await waitFor(() => jukebox.getState().playerOnline, 5000, '流端上线');
    jukebox.addToQueue(SONG('A'));
    jukebox.addToQueue(SONG('B'));
    // A 404 → 跳过 + 自动接播 B（playNext(false) 只挡历史回填，排队歌照播）→ B 也 404 → 安静停下
    await waitFor(() => history.records.length >= 2 && history.records[1].status === 'skipped', 5000, 'A、B 都被跳过');
    assert.equal(history.records[0].status, 'skipped');
    assert.equal(history.records[0].updates.at(-1).reason, '加载失败');
    assert.equal(history.records[1].updates.at(-1).reason, '加载失败');
    assert.equal(jukebox.getState().current, null);
    assert.equal(jukebox.getState().queue.length, 0);
    assert.equal(jukebox.getState().playerOnline, true); // 播放交椅还在，静音垫底
    col.close();
  });
});

test('最后一个流客户端断开：立即摘交椅+宽限冻结，宽限期内点歌只排队不喂虚空，超时不跳歌', async () => {
  await withStream({ graceMs: 300, routes: { 'http://A.mp3': music(0x41) } }, async ({ jukebox, history, streamCollector }) => {
    const col = streamCollector();
    await waitFor(() => jukebox.getState().playerOnline, 5000, '流端上线');
    jukebox.addToQueue(SONG('A'));
    await waitFor(() => col.buf().includes(0x41), 5000, 'A 起播');
    col.close();
    await waitFor(() => jukebox.getState().paused === true, 2000, '断线即冻结（暂停语义）');
    assert.ok(jukebox.getState().current, '宽限期内不跳歌');
    assert.equal(jukebox.getState().playerOnline, false, '断线即摘播放交椅：网页端显示真实离线（旧实现宽限内虚报在线）');
    // 宽限期内网页端点歌：只排队不自动开播（旧实现会开播喂进零客户端，手机回来时进度错位半首歌）
    jukebox.addToQueue(SONG('B'));
    assert.equal(jukebox.getState().current.song.title, 'A', '宽限期内点歌不顶掉当前歌');
    assert.equal(jukebox.getState().queue.length, 1, '宽限期内点歌只排队');
    assert.equal(jukebox.getState().queue[0].song.title, 'B');
    assert.equal(jukebox.getState().paused, true, '点歌不解冻宽限冻结');
    await waitFor(() => jukebox.getState().paused === false, 5000, '宽限超时清冻结');
    assert.equal(jukebox.getState().current.song.title, 'A', '超时也不跳歌');
    assert.equal(jukebox.getState().playerOnline, false);
    assert.equal(history.records[0].status, 'playing', '历史不记断线跳过');
    const col2 = streamCollector(); // 重连：重解析续播当前歌
    await waitFor(() => col2.buf().includes(0x41), 5000, '重连后当前歌 A 续播');
    assert.equal(jukebox.getState().current.song.title, 'A');
    assert.equal(jukebox.getState().playerOnline, true);
    col2.close();
  });
});

test('断线宽限期：客户端在宽限内回来，从断点续播（不重解析、进度平移、不跳歌）', async () => {
  await withStream({ routes: { 'http://A.mp3': music(0x41) } }, async ({ jukebox, history, resolveCalls, streamCollector }) => {
    const col = streamCollector();
    await waitFor(() => jukebox.getState().playerOnline, 5000, '流端上线');
    jukebox.addToQueue(SONG('A'));
    await waitFor(() => col.buf().includes(0x41), 5000, 'A 起播');
    col.close(); // 手机切后台：断线
    await waitFor(() => jukebox.getState().paused === true, 2000, '宽限冻结');
    const startedAtFreeze = jukebox.getState().current.started_at;
    const resolveCount = resolveCalls.length;
    const col2 = streamCollector(); // 宽限内回来
    await waitFor(() => col2.buf().includes(0x41), 5000, '续播：新客户端收到音乐');
    assert.equal(jukebox.getState().paused, false, '自动解冻');
    assert.equal(jukebox.getState().current.song.title, 'A', '不跳歌');
    assert.equal(jukebox.getState().playerOnline, true, '交椅仍在');
    assert.equal(resolveCalls.length, resolveCount, '不重解析（断点续推而非整首重播）');
    assert.ok(jukebox.getState().current.started_at > startedAtFreeze, '进度平移（冻结窗口不计入）');
    assert.equal(history.records[0].status, 'playing', '历史仍为播放中');
    col2.close();
  });
});

test('桌面播放端接入：流被顶替转静音，下载中的上游被 abort', async () => {
  await withStream({ routes: { 'http://A.mp3': music(0x41, 2000, 64, 5) } }, async ({ jukebox, fetchCalls, wsClient, streamCollector }) => {
    const col = streamCollector();
    await waitFor(() => jukebox.getState().playerOnline, 5000, '流端上线');
    jukebox.addToQueue(SONG('A'));
    await waitFor(() => fetchCalls.length >= 1, 5000, 'A 开始下载'); // 10 秒长下载：顶替打在下载中途
    const desktop = await wsClient();
    desktop.send(JSON.stringify({ type: 'player_hello', token: 'tok' }));
    await waitFor(() => {
      const b = col.buf();
      return b.length >= 256 && b.subarray(b.length - 256).every((x) => x === 0);
    }, 5000, '被顶替后转静音'); // 下载期间静音照常垫底，顶替后静音持续
    assert.equal(fetchCalls[0].init.signal.aborted, true);
    assert.equal(jukebox.getState().playerOnline, true); // 播放权在桌面端，在线状态保持
    desktop.close();
    col.close();
  });
});

test('桌面端断开：流端自动抢回（reclaim）续播当前歌，不跳下一首', async () => {
  await withStream({
    routes: { 'http://A.mp3': music(0x41, 800), 'http://B.mp3': music(0x42) },
  }, async ({ jukebox, history, wsClient, streamCollector }) => {
    const col = streamCollector();
    await waitFor(() => jukebox.getState().playerOnline, 5000, '流端上线');
    jukebox.addToQueue(SONG('A'));
    jukebox.addToQueue(SONG('B'));
    await waitFor(() => col.buf().includes(0x41), 5000, 'A 起播');
    const desktop = await wsClient();
    desktop.send(JSON.stringify({ type: 'player_hello', token: 'tok' }));
    await waitFor(() => {
      const b = col.buf();
      return b.length >= 256 && b.subarray(b.length - 256).every((x) => x === 0);
    }, 5000, '被顶替转静音');
    const lenBefore = col.buf().length;
    desktop.close(); // 桌面断开 → 不跳歌 → reclaim 抢回 → playerHello → 重解析续播当前歌 A
    await waitFor(() => col.buf().subarray(lenBefore).includes(0x41), 5000, '抢回后当前歌 A 续播');
    assert.equal(jukebox.getState().current.song.title, 'A');
    assert.equal(jukebox.getState().playerOnline, true);
    assert.equal(history.records[0].status, 'playing');
    assert.equal(history.records[1].status, 'requested'); // B 不动，仍在队列
    assert.equal(jukebox.getState().queue.length, 1);
    col.close();
  });
});

test('多客户端扇出；慢客户端背压超标被驱逐，不拖累他人', async () => {
  await withStream({
    // 64MB 大文件 + 大 tickCap（40MB/s 级 burst）：慢客户端内核缓冲必满被驱逐。
    // 推送循环每 64KB 让出事件循环，健康客户端趁隙排水，不会被大 burst 误驱逐
    routes: { 'http://A.mp3': music(0x41, 4000, 16384) },
    evictLimit: 256,     // 调小驱逐线加速测试
    tickCap: 4 << 20,    // 4MB/tick
  }, async ({ port, jukebox, streamer, streamCollector }) => {
    const A = SONG('A'); A.duration_ms = 8000; // 短时长 → 推速高，驱逐发生得早
    // 两个客户端都在点歌前的静音期连好（事件循环空闲，连接回调即时处理）：
    // 64MB 下载会阻塞事件循环 ~数百 ms，若健康客户端在点歌后才连，回调可能拖到
    // 慢客户端已被驱逐之后才处理，客户端数 1→0→1 永远不经过 2，测试变成时序竞态
    const col = streamCollector();
    // 慢客户端：暂停原始 socket 停止读（res.pause() 只停 data 事件、Node 仍往内存读，无背压）。
    // Windows 上暂停态客户端感知不到对端关闭（不读 socket 就看不到 RST），驱逐结果用服务器侧客户端数断言
    const slowReq = http.get({ port, path: '/stream?token=tok' }, (res) => {
      res.socket.pause();
      res.on('error', () => {});
    });
    slowReq.on('error', () => {});
    try {
      await waitFor(() => streamer.getClientCount() === 2, 5000, '两个客户端都在');
      await waitFor(() => jukebox.getState().playerOnline, 5000, '流端上线');
      jukebox.addToQueue(A); // 开播，音乐扇出给两个客户端
      await waitFor(() => streamer.getClientCount() === 1, 5000, '慢客户端被驱逐');
      assert.equal(jukebox.getState().playerOnline, true); // 还有健康客户端，播放交椅不掉
      const lenBefore = col.len();
      await waitFor(() => col.len() >= lenBefore + 1024, 5000, '驱逐后健康客户端不受影响');
      await waitFor(() => col.buf().includes(0x41), 5000, '健康客户端收到音乐字节');
      col.close();
    } finally {
      slowReq.destroy(); // 半开连接必须在进程内显式销毁，否则挂住事件循环
    }
  });
});
