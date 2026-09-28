'use strict';
const { Readable } = require('node:stream');

// 电台流：一个「虚拟播放端」。向 ws.js 注册 mock socket 领受 player_cmd，
// 把队列的歌串成一条不间断的 audio/mpeg 流发给所有 /stream 客户端。
// 手机只播这一条流：后台/锁屏不需要收任何指令，音乐自然不断。
//
// 关键设计：
// - 静音垫底：队列无歌/暂停/被电脑端接管时，按节拍写静音 mp3——音频元素永不 stall
//   （元素一停摆，iOS 会冻结后台页面、掐断连接）；静音→音乐切换在首个音乐块到达时瞬时完成。
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
  log = () => {},
}) {
  const clients = new Set();  // http.ServerResponse
  let active = false;         // mock 是否为 ws.js 当前播放端
  let upstream = null;        // { ac: AbortController, rs: Readable }
  let currentSong = null;     // resume 时重解析用
  let silenceTimer = null;
  let stallTimer = null;
  let startedSent = false;

  const mockSocket = {
    isStream: true,
    readyState: 1,             // ws.js sendToPlayer/player_replaced 都要求 ===1
    send(jsonStr) { onPlayerMsg(JSON.parse(jsonStr)); },
    close() {},                // 被顶替时 ws.js 会调用；收尾由 clearStreamPlayer 完成
  };

  function onPlayerMsg(msg) {
    if (msg.type === 'player_replaced') { // 桌面端/普通手机端抢走播放权
      active = false;
      hold();                  // 停上游、转静音；不断流（手机保持连接，随时抢回）
      return;
    }
    const cmd = msg.cmd;
    if (!cmd || !cmd.action) return;
    switch (cmd.action) {
      case 'play':
        currentSong = cmd.song;
        // 兜底：m4a 链不进流。队列解析已按流端选 mp3Only，此分支只覆盖
        // playerHello 解析竞态（普通端解析中流端接管）的边路，重取 mp3
        if (/\.m4a(\?|$)/i.test(String(cmd.url || ''))) { resumeSong(); break; }
        pipe(cmd.url);
        break;
      case 'pause':
      case 'stop': hold(); break;
      case 'resume': resumeSong(); break;
      case 'volume':
      case 'mute': break;      // 音量由手机端 audio.volume 控制（state 广播驱动）
    }
  }

  function hold() { abortUpstream(); startSilence(); }

  function abortUpstream() {
    if (!upstream) return;
    const u = upstream; upstream = null;
    clearTimeout(stallTimer);
    try { u.ac.abort(); } catch {}
    try { u.rs && u.rs.destroy(); } catch {}
  }

  async function pipe(url) {
    abortUpstream();
    // 静音不停：解析/取流期间静音照常打点，客户端缓冲不断；首个音乐块到达才停（见 data 分支）
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
    startedSent = false;
    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => onUpstreamError(new Error('upstream stalled')), stallMs);
      if (stallTimer.unref) stallTimer.unref();
    };
    armStall();
    rs.on('data', (chunk) => {
      if (!upstream || upstream.rs !== rs) return;
      armStall();
      if (!startedSent) {
        startedSent = true;
        stopSilence();
        if (active) jukebox.playerEvent('started'); // queue 据此重置 started_at
      }
      for (const res of [...clients]) write(res, chunk);
    });
    rs.on('end', () => {
      if (!upstream || upstream.rs !== rs) return;
      upstream = null; clearTimeout(stallTimer);
      if (active) jukebox.playerEvent('finished'); // queue 接播下一首
      startSilence();                              // 歌曲间隙：静音垫底
    });
    rs.on('error', (e) => onUpstreamError(e));
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
    if (!active) activate(); // 新连接即注册（含被顶掉后「抢回」的重连）
    if (!upstream) startSilence();
  }
  function removeClient(res) {
    if (!clients.delete(res)) return;
    try { res.destroy(); } catch {}
    if (!clients.size) deactivate();
  }
  function activate() {
    active = true;
    setStreamPlayer(mockSocket); // playerHello → 重发 play/续播；顶掉桌面端（player_replaced）
  }
  function deactivate() {
    active = false;
    hold();
    clearStreamPlayer(mockSocket); // ws.js 内带 player===mock 守卫；被顶掉时是 no-op
  }
  function reclaim() {            // ws.js onPlayerSlotFree：桌面端断开后抢回
    if (clients.size && !active) activate();
  }

  function destroy() {
    hold();
    for (const res of [...clients]) { try { res.destroy(); } catch {} }
    clients.clear();
    if (active) deactivate();
  }

  return { addClient, reclaim, destroy, getClientCount: () => clients.size };
}

module.exports = { createStream };
