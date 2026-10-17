'use strict';
const { Readable } = require('node:stream');

// 电台流：一个「虚拟播放端」。向 ws.js 注册 mock socket 领受 player_cmd，
// 把队列的歌串成一条不间断的 audio/mpeg 流发给所有 /stream 客户端。
// 手机只播这一条流：后台/锁屏不需要收任何指令，音乐自然不断。
//
// 关键设计：
// - 静音垫底：队列无歌/暂停/被电脑端接管时，按节拍写静音 mp3——音频元素永不 stall
//   （元素一停摆，iOS 会冻结后台页面、掐断连接）；静音→音乐切换在首个音乐块到达时瞬时完成。
// - 实时节流：音乐全量下载后按歌曲时长 1x 推送（带 5 秒预冲缓冲垫）。「字节推完」≠「播完」——
//   办公室带宽几秒就能推完整首歌，若按字节完切歌，手机端收到的是多首歌拼成的垃圾流，解码器直接无声。
//   切歌也按时长判定，与手机端真实播放同步。
// - 冻结续播（2026-10-05）：暂停不再丢弃喂送状态——停在当前字节断点，静音垫底保连接，
//   恢复从断点继续推。冻结期间若有客户端重连（缓冲已丢），推送指针回拨到「播放位置」字节
//   （服务器推到的字节领先实际播放约 5 秒预冲），重连端从断点起播（帧对齐，误差 < 1 帧）。
//   整首歌已全量下载在内存，冻结期间不存在上游 CDN 掉线问题，无需 Range 重连。
// - mp3-only：流内不能切换编码格式（m4a 接 mp3 会把手机解码器卡死）。队列解析时已按
//   isStreamPlayerActive 选 mp3Only 阶梯；此处的 m4a 兜底重取覆盖解析竞态边路。
// - 慢客户端驱逐：扇出时背压超标（本地锁屏暂停塞满缓冲）者单独踢掉，不拖累别人。
// - 接管：与真实播放端同一把交椅，后连者顶前（player_replaced）；被顶后转静音，
//   不自动抢回；等桌面端断开（onPlayerSlotFree→reclaim）或手机重连/点抢回再夺回。

function createStream({
  jukebox,            // queue 实例：playerEvent('started'|'finished'|'error')
  resolveUrl,         // (song, opts) => {url} | {error:'vip'|'unavailable'}
  setStreamPlayer,    // (mockSocket) => void（ws.js）
  clearStreamPlayer,  // (mockSocket) => void（ws.js）
  isPlayerToken,      // (t) => bool：/stream 鉴权（与 WS 播放端同一口令）
  silence,            // Buffer：预生成静音 mp3 帧
  fetchImpl = fetch,
  stallMs = 20000,         // 上游连续无数据超时 → error（队列自动跳过）
  evictLimit = 1 << 20,    // 客户端 writableLength 超过即销毁（约 2 分钟缓冲，健康客户端远低于此）
  silenceIntervalMs = 450, // 静音节拍（略快于 0.5s 静音帧时长；配合 2× 上限检查保持客户端仅领先约 1 秒）
  tickMs = 100,            // 音乐喂送节拍
  tickCap = 512 * 1024,    // 每 tick 推送上限：防首推 burst 把健康客户端缓冲塞爆误驱逐（测试可调大加速驱逐用例）
  graceMs = 90000,         // 断线宽限期：最后一个流客户端断开后，冻结断点等它回来，超时才判死跳歌
  log = () => {},
}) {
  const clients = new Set();  // http.ServerResponse
  let active = false;         // mock 是否为 ws.js 当前播放端
  let upstream = null;        // { ac: AbortController, rs: Readable }
  let currentSong = null;     // resume 时重解析用（song.duration_ms 驱动节流推送）
  let feeds = null;           // 喂送状态（含冻结断点）；null=无喂送
  let silenceTimer = null;
  let stallTimer = null;
  let graceTimer = null;      // 宽限期定时器（最后一客户端断开后计时）
  let graceFrozen = false;    // 宽限冻结是本端发起（外部暂停不置位，到期不代清）

  const mockSocket = {
    isStream: true,
    readyState: 1,             // ws.js sendToPlayer/player_replaced 都要求 ===1
    send(jsonStr) { onPlayerMsg(JSON.parse(jsonStr)); },
    close() {},                // 被顶替时 ws.js 会调用；收尾由 clearStreamPlayer 完成
  };

  // 宽限期状态作废：清定时器 + 清掉本端设的暂停语义（外部已接管/队列已前进，不会误触重播）
  function cancelGrace() {
    clearTimeout(graceTimer);
    graceTimer = null;
    if (graceFrozen) {
      graceFrozen = false;
      jukebox.resumeStream(); // 不发指令：仅清 paused + 平移进度，安全幂等
    }
  }

  function onPlayerMsg(msg) {
    if (msg.type === 'player_replaced') { // 桌面端/普通手机端抢走播放权
      active = false;
      cancelGrace();
      hold();                  // 断点作废（被顶替），转静音；不断流（手机保持连接，随时抢回）
      return;
    }
    const cmd = msg.cmd;
    if (!cmd || !cmd.action) return;
    switch (cmd.action) {
      case 'play':
        // 同一首歌已有喂送状态（含冻结中）：不重播——重连客户端直接从当前断点/进度续听
        if (feeds && cmd.song && feeds.song && cmd.song.song_id === feeds.song.song_id) break;
        currentSong = cmd.song;
        // 兜底：m4a 链不进流。队列解析已按流端选 mp3Only，此分支只覆盖
        // playerHello 解析竞态（普通端解析中流端接管）的边路，重取 mp3
        if (/\.m4a(\?|$)/i.test(String(cmd.url || ''))) { resumeSong(); break; }
        pipe(cmd.url);
        break;
      case 'pause': freezeFeed(); break;
      case 'stop': cancelGrace(); hold(); break;  // 切歌：断点作废
      case 'resume':
        // 宽限冻结期间外部恢复：尊重用户选择，取消到期跳歌
        cancelGrace();
        if (feeds && feeds.frozenAt != null) { feeds.resume(); break; }
        resumeSong();              // 无冻结状态（下载期暂停等）：重解析重播
        break;
      case 'volume':
      case 'mute': break;      // 音量由手机端 audio.volume 控制（state 广播驱动）
    }
  }

  function hold() {
    abortUpstream();
    if (feeds) { feeds.kill(); feeds = null; }
    startSilence();
  }

  // 暂停：喂送中 → 冻结断点；下载/间隙期 → 无断点可保，按原行为（恢复时重解析重播）
  function freezeFeed() {
    if (feeds) { feeds.freeze(); return; }
    hold();
  }

  function abortUpstream() {
    if (!upstream) return;
    const u = upstream; upstream = null;
    clearTimeout(stallTimer);
    try { u.ac.abort(); } catch {}
    try { u.rs && u.rs.destroy(); } catch {}
  }

  async function pipe(url) {
    cancelGrace(); // 新歌指令：宽限冻结作废（'stop' 已清则幂等）
    abortUpstream();
    if (feeds) { feeds.kill(); feeds = null; } // 换歌：旧断点作废
    // 静音不停：下载期间静音照常打点，客户端缓冲不断；首块音乐推到才停（见 startFeeding）
    const ac = new AbortController();
    upstream = { ac, rs: null };
    let res;
    try {
      res = await fetchImpl(url, { signal: ac.signal });
    } catch {
      if (!upstream || upstream.ac !== ac) return; // 已被新指令顶替
      upstream = null;
      emitError('加载失败');
      return;
    }
    if (!upstream || upstream.ac !== ac) return;
    if (!res || !res.ok || !res.body) { upstream = null; emitError('加载失败'); return; }
    let rs;
    try { rs = Readable.fromWeb(res.body); } catch { upstream = null; emitError('加载失败'); return; }
    upstream.rs = rs;
    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => onUpstreamError(new Error('upstream stalled')), stallMs);
      if (stallTimer.unref) stallTimer.unref();
    };
    armStall();
    // 全量下载（单曲 ≤ 几十 MB，内存可接受）：节流推送必须知道文件总长。
    // 若按「字节推完=播完」边下边推，办公室带宽几秒就把整首歌推光、服务器立刻切歌，
    // 手机端收到的是多首歌拼在一起的垃圾流，解码器直接卡死无声。
    const parts = [];
    try {
      for await (const chunk of rs) {
        if (!upstream || upstream.ac !== ac) return;
        armStall();
        parts.push(chunk);
      }
    } catch (e) {
      if (!upstream || upstream.ac !== ac) return;
      onUpstreamError(e); // 主动中止时 abortUpstream 已置 null upstream，走不到这；真错误发 error 让队列跳过
      return;
    }
    if (!upstream || upstream.ac !== ac) return;
    upstream = null;
    clearTimeout(stallTimer);
    const buf = Buffer.concat(parts.map((c) => Buffer.from(c)));
    if (!buf.length || !isMp3(buf)) { emitError('加载失败'); return; } // 非 mp3（flac/ogg/m4a）手机解码不了
    startFeeding(buf);
  }

  // 按歌曲真实时长节流推送：推速 ≈ 1x 实时播放 + 5 秒预冲缓冲垫（手机断网/卡顿的保险）。
  // 「播完」也按时长判定——到点即 finished，与手机端真实播放同步切歌。
  // 循环每写一块让出一次事件循环（setImmediate）：健康客户端趁隙排水，慢客户端背压立现被驱逐；
  // 没有让出点的话，大 burst 会同步塞爆所有客户端的 writableLength，健康端也遭误驱逐。
  function startFeeding(buf) {
    stopSilence();
    const durationMs = currentSong && currentSong.duration_ms > 0 ? currentSong.duration_ms : 240000;
    const feed = {
      buf, song: currentSong, durationMs, preloadMs: 5000,
      t0: Date.now(), pushed: 0,
      frozenAt: null, startedSent: false, gen: 0, timer: null,
      joinedWhileFrozen: false,  // 冻结期间有新客户端重连：恢复时回拨指针
    };
    feed.kill = () => {
      feed.gen++;                 // 在途 tick 在让出点收手
      clearTimeout(feed.timer);
      feed.timer = null;
    };
    feed.freeze = () => {
      if (feed.frozenAt != null) return;
      feed.frozenAt = Date.now();
      feed.kill();
      startSilence();
    };
    feed.resume = () => {
      if (feed.frozenAt == null) return;
      feed.t0 += Date.now() - feed.frozenAt; // 时钟平移：elapsed 停在断点处的播放进度
      feed.frozenAt = null;
      if (feed.joinedWhileFrozen) {
        // 冻结期间有客户端重连（缓冲已丢）：回拨推送指针到「播放位置」字节，
        // 否则重连端会从「播放位置+5 秒预冲」起播，跳过 5 秒内容
        const elapsed = Date.now() - feed.t0;
        const playOffset = Math.floor(feed.buf.length * elapsed / feed.durationMs);
        feed.pushed = Math.max(0, Math.min(feed.pushed, playOffset));
        feed.joinedWhileFrozen = false;
      }
      stopSilence();
      feed.loop();
    };
    feed.loop = () => {
      feed.gen++;
      feed.timer = setTimeout(tick, tickMs);
      if (feed.timer.unref) feed.timer.unref();
    };
    const feedFinish = () => {
      feed.kill();
      feeds = null;
      if (active) jukebox.playerEvent('finished'); // queue 接播下一首
      startSilence();                              // 歌曲间隙：静音垫底
    };
    const tick = async () => {
      feed.timer = null;
      const gen = feed.gen;
      const elapsed = Date.now() - feed.t0;
      if (elapsed >= feed.durationMs) { feedFinish(); return; } // 按时长切歌：手机播完的时刻（预冲 5s，字节会提前推完）
      if (feed.pushed < feed.buf.length) {
        const target = Math.min(feed.buf.length, Math.ceil(feed.buf.length * (elapsed + feed.preloadMs) / feed.durationMs));
        let budget = tickCap;
        while (feed.pushed < target && budget > 0) {
          const n = Math.min(64 * 1024, target - feed.pushed, budget);
          fanout(feed.buf.subarray(feed.pushed, feed.pushed + n));
          feed.pushed += n;
          budget -= n;
          if (!feed.startedSent) {
            feed.startedSent = true;
            if (active) jukebox.playerEvent('started'); // 真实起播点：首个音乐块推达手机，queue 据此重置 started_at
          }
          await new Promise((r) => setImmediate(r)); // 让出：健康客户端排水、慢客户端显背压
          if (gen !== feed.gen) return;               // 已被冻结/切歌/被顶：不再推、不再续定时器
        }
      } else {
        startSilence(); // 文件比 duration_ms 短：末尾静音垫到时长，防手机元素 buffer 干涸 stall
      }
      feed.loop();
    };
    feeds = feed;
    feed.loop();
  }

  function isMp3(buf) {
    if (buf.length >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true; // ID3 头
    if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true;            // MPEG 帧同步
    return false;
  }

  function fanout(chunk) {
    for (const res of [...clients]) write(res, chunk);
  }

  function onUpstreamError(e) {
    if (!upstream || (e && e.name === 'AbortError')) { hold(); return; } // 主动中止/被顶替
    upstream = null; clearTimeout(stallTimer);
    if (active) jukebox.playerEvent('error', { reason: '加载失败' }); // queue 跳过+toast+playNext(false)
    startSilence();
  }

  async function resumeSong() {
    if (!currentSong) { startSilence(); return; }
    let resolved;
    try { resolved = await resolveUrl(currentSong, { mp3Only: true }); } // 地址会过期，必须重解析
    catch { resolved = { error: 'unavailable' }; }
    if (!active) return; // 解析期间被顶替
    if (!resolved || resolved.error) {
      jukebox.playerEvent('error', {
        reason: resolved.error === 'vip' ? '版权受限' : '无法获取播放地址',
      });
      return;
    }
    pipe(resolved.url);  // 从头播；首块字节触发 'started' → started_at 重置
  }

  function emitError(reason) {
    if (active) jukebox.playerEvent('error', { reason });
    startSilence();
  }

  // ---------- 扇出 ----------
  function write(res, chunk) {
    if (res.destroyed || res.writableEnded) return;
    if (res.writableLength > evictLimit) { evict(res); return; } // 慢客户端驱逐，不拖累他人
    res.write(chunk);
  }
  function evict(res) {
    if (!clients.delete(res)) return;
    try { res.destroy(); } catch {} // 手机端断流后自己带退避重连
    if (!clients.size) deactivate();
  }

  // ---------- 静音节拍：只写不读，且仅在客户端缓冲低于上限时写，绝不预写 ----------
  function startSilence() {
    if (silenceTimer || !silence || !silence.length) return;
    const step = () => {
      silenceTimer = null;
      if (!clients.size) return;
      for (const res of [...clients]) {
        if (res.destroyed || res.writableEnded) { evict(res); continue; }
        if (res.writableLength > evictLimit) { evict(res); continue; }
        // 客户端已领先超过 2 块静音（约 1 秒）：本拍跳过——静音→音乐切换几乎瞬时
        if (res.writableLength >= 2 * silence.length) continue;
        res.write(silence);
      }
      silenceTimer = setTimeout(step, silenceIntervalMs);
      if (silenceTimer.unref) silenceTimer.unref();
    };
    step();
  }
  function stopSilence() {
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
  }

  // ---------- 客户端进出 ----------
  function addClient(req, res) {
    if (!isPlayerToken(String((req.query && req.query.token) || ''))) {
      res.status(403).json({ error: 'bad token' });
      return;
    }
    if (req.method === 'HEAD') { res.status(200).end(); return; } // 探活用：不占播放交椅
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store, no-cache',
      'Connection': 'keep-alive',
    });
    clients.add(res);
    // 只监听 res 'close'（连接中断必触发；流式响应永不正常结束）
    res.on('close', () => removeClient(res));
    res.on('error', () => {});
    if (feeds && feeds.frozenAt != null) feeds.joinedWhileFrozen = true; // 冻结期重连：恢复时回拨指针（须在 activate 续播前置位）
    if (!active) activate(); // 新连接即注册（含被顶掉后「抢回」的重连）
    if (!upstream && !feeds) startSilence(); // 喂送中不垫静音：半途加入的客户端直接收下一块音乐
  }
  function removeClient(res) {
    if (!clients.delete(res)) return;
    try { res.destroy(); } catch {}
    if (!clients.size) deactivate();
  }
  function activate() {
    active = true;
    setStreamPlayer(mockSocket); // playerHello → 重发 play/续播；顶掉桌面端（player_replaced）
    if (graceFrozen) {
      // 宽限期内回来：从断点续播（指针回拨到播放位置）+ 解冻（进度平移），不重解析不整首重播
      graceFrozen = false;
      clearTimeout(graceTimer);
      graceTimer = null;
      if (feeds && feeds.frozenAt != null) feeds.resume();
      jukebox.resumeStream();
    }
  }
  // 最后一客户端断开：先冻结断点宽限 graceMs——手机切后台/网络瞬断不必判死，
  // 期间回来无缝续播；超时才 hold + 下线（playerGone 只摘交椅不跳歌：current/队列
  // 保留，之后新客户端重连经 playerHello 重解析续播当前歌）
  function armGrace() {
    clearTimeout(graceTimer);
    graceTimer = setTimeout(() => {
      graceTimer = null;
      if (graceFrozen) {
        graceFrozen = false;
        jukebox.resumeStream(); // 清掉本端设的暂停语义，下一首不带 paused 出生
      }
      hold();
      clearStreamPlayer(mockSocket); // ws.js 内带 player===mock 守卫；被顶掉时是 no-op
    }, graceMs);
    if (graceTimer.unref) graceTimer.unref();
  }
  function deactivate() {
    active = false;
    if (feeds && feeds.frozenAt == null) {
      // 喂送中（含下载完待推）断线：冻结断点 + 队列侧冻结（进度/UI 一致），等宽限
      freezeFeed();
      jukebox.freezeStream(); // 不发指令：仅 paused + pausedAt，广播让页面显示暂停
      graceFrozen = true;
    }
    armGrace();
  }
  function reclaim() {            // ws.js onPlayerSlotFree：桌面端断开后抢回
    if (clients.size && !active) activate();
  }

  function destroy() {
    hold();
    for (const res of [...clients]) { try { res.destroy(); } catch {} }
    clients.clear();
    if (active) deactivate();
    clearTimeout(graceTimer); // deactivate 会重新布宽限：关停时不留尾巴
    graceFrozen = false;
  }

  return { addClient, reclaim, destroy, getClientCount: () => clients.size };
}

module.exports = { createStream };
