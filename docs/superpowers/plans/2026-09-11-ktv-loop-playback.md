# 点歌台循环播放实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 播放模式三态（顺序/单曲循环/列表循环），网页控制条按钮切换，全员共享，模式持久化，播放端零改动。

**Architecture:** 服务端队列状态机（queue.js）加 mode 状态与 setMode 指令；finished 事件按模式分流（单曲重播/顺序续播）；playNext 在队列空且 mode=list 时从 history 已播记录（status='played'，id 升序，最多 100 条）回填续播。ws.js 新增 mode_set 消息；createRealtime 启动时读 settings.play_mode 作初始模式。网页端控制条加模式按钮循环切换。

**Tech Stack:** Node 24（node:test + node:sqlite）、原生 JS 前端（无构建、无框架）、WebSocket。

## Global Constraints

- 模式值固定 `order` | `single` | `list`；settings 键名 `play_mode`；setSetting 审计日志只记键名不记值（store.js 现有实现已满足）。
- queue.js 保持纯逻辑：所有副作用经注入钩子（history 是 store 对象本身：add/update/listPlayed/setSetting 都用注入的 history 调用）。
- 播放端（player/）与对外部署包**零改动**。
- 服务端测试命令：`cd C:\Users\Administrator\jukebox\server && npm test`（node --test，当前基线 58 通过）。
- 网页端无自动测试框架（web/test 只有 lrc.test.html 手工页），UI 改动走人工验证点。
- 改完服务端代码后需重启服务器才生效：找到 3000 端口 LISTENING 的 PID → `taskkill //PID <pid> //F` → `cscript //nologo C:\Users\Administrator\jukebox\server\server_start_hidden.vbs`。播放端不用动。
- git 提交信息中文，结尾带 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。

---

### Task 1: store.listPlayed + 单测

**Files:**
- Modify: `server/src/store.js`（新增 listPlayed）
- Test: `server/test/store.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `history.listPlayed(limit=100) => rows[]`，行=history 表原始字段（song_id/title/artist/album/text/duration_ms/fee/provider/status/...），SQL 保证 status='played'、id 升序、LIMIT limit。Task 2 依赖此接口。

- [ ] **Step 1: 写失败测试**

在 `server/test/store.test.js` 末尾追加（沿用 tempDb() fixture）：

```js
test('listPlayed 只回 played、按 id 升序、受 limit 限制', () => {
  const store = createStore(tempDb());
  const a = store.add({ text: 'A' });
  const b = store.add({ text: 'B' });
  const c = store.add({ text: 'C' });
  store.update(a, { status: 'played' });
  store.update(c, { status: 'played' });
  store.update(b, { status: 'skipped' }); // 非 played 不回
  const rows = store.listPlayed();
  assert.deepEqual(rows.map((r) => r.text), ['A', 'C']); // 升序：先播的在前
  assert.equal(store.listPlayed(1).length, 1); // limit 生效
  assert.equal(store.listPlayed(1)[0].text, 'A');
  store.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd C:\Users\Administrator\jukebox\server && npm test`
Expected: 该用例 FAIL（`store.listPlayed is not a function`），其余 58 通过。

- [ ] **Step 3: 实现**

`server/src/store.js`：在 `const listStmt = ...` 行后加：

```js
  const listPlayedStmt = db.prepare(`SELECT * FROM history WHERE status='played' ORDER BY id ASC LIMIT ?`);
```

在 return 对象里 `list(limit = 50) {` 方法后加：

```js
    listPlayed(limit = 100) {
      return listPlayedStmt.all(limit);
    },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`（在 server 目录）
Expected: 59 通过、0 失败。

- [ ] **Step 5: 提交**

```bash
git add server/src/store.js server/test/store.test.js
git commit -m "点歌台循环播放：store 新增 listPlayed（已播升序回填数据源）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: queue.js 状态机（TDD）

**Files:**
- Modify: `server/src/queue.js`
- Test: `server/test/queue.test.js`

**Interfaces:**
- Consumes: `history.listPlayed(limit)`（Task 1）、`history.setSetting(key,value)`、`initialMode`（deps 新增，Task 3 注入）
- Produces: `jukebox.setMode(m)`（ws.js 调用）、`getState().mode`（广播/前端用）、新 finished/playNext 语义

- [ ] **Step 1: 扩展测试 fixture 并写失败测试**

`server/test/queue.test.js` 的 `setup()` 改为：

```js
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
```

在文件末尾追加用例（`row` 辅助函数与 `song` 并列定义在 `const song = ...` 行后）：

```js
const row = (title) => ({ id: 1, song_id: 's' + title, title, artist: 'X', album: null, text: title, duration_ms: 60000, fee: 0, provider: 'netease', status: 'played' });

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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`（server 目录）
Expected: 新增 7 用例 FAIL（`j.setMode is not a function` 等），旧用例全过。

- [ ] **Step 3: 实现 queue.js**

按以下四处修改 `server/src/queue.js`：

3a. deps 解构加 `initialMode`（第 10-17 行的解构里加一行）：

```js
    initialMode = 'order', // 初始播放模式；非法值回落 order
```

3b. state 定义加 mode（第 19-26 行 state 对象里）：

```js
    mode: ['order', 'single', 'list'].includes(initialMode) ? initialMode : 'order',
```

3c. getState 返回对象加 `mode: state.mode,`（放在 `playerOnline: state.playerOnline,` 行后）。

3d. `function playNext()` 替换为：

```js
  function playNext() {
    if (!state.current && state.playerOnline) {
      if (!state.queue.length && state.mode === 'list') refillQueue();
      if (state.queue.length) { playItem(state.queue.shift()); return; }
    }
    broadcast();
  }

  // 列表循环：队列空时把已播过的歌按最早播放顺序接回来（每首新 history 行）
  function refillQueue() {
    for (const row of history.listPlayed(100)) {
      const s = {
        song_id: row.song_id, title: row.title, artist: row.artist, album: row.album,
        text: row.text, duration_ms: row.duration_ms, fee: row.fee, provider: row.provider,
      };
      state.queue.push({ id: nextId(), song: s, historyId: history.add(s) });
    }
  }
```

3e. `playerEvent` 的 finished 分支替换为：

```js
    if (event === 'finished') {
      if (state.mode === 'single' && state.current) {
        const song = state.current.song;
        finishCurrent('played', null);
        addToQueue(song); // 在线即重播；解析失败走跳过分支，不会死循环
        return;
      }
      finishCurrent('played', null);
      playNext();
    } else if (event === 'error') {
```

3f. 全员指令区加 setMode（放在 `function skip()` 之前）：

```js
  function setMode(m) {
    if (!['order', 'single', 'list'].includes(m) || state.mode === m) return;
    state.mode = m;
    history.setSetting('play_mode', m);
    broadcast();
  }
```

3g. return 对象加 `setMode`（加在 `skip, pause, resume` 行里）：

```js
    getState, addToQueue, topQueue, removeQueue,
    setMode, skip, pause, resume, setVolume, toggleMute,
    playerHello, playerGone, playerEvent, playNext,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: 66 通过（59 + 7 新增）、0 失败。

- [ ] **Step 5: 提交**

```bash
git add server/src/queue.js server/test/queue.test.js
git commit -m "点歌台循环播放：队列状态机三模式（单曲重播/列表回填/顺序），切歌跳出、失败不循环

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: ws.js 接线 + 模式初始化 + 集成测试

**Files:**
- Modify: `server/src/ws.js`
- Test: `server/test/ws.test.js`

**Interfaces:**
- Consumes: `jukebox.setMode(m)`（Task 2）、`history.getSetting('play_mode')`（store 现成）
- Produces: WS 消息 `{type:'mode_set', value}` → 模式变更 + state 广播（前端 Task 4 依赖）

- [ ] **Step 1: 写失败测试**

`server/test/ws.test.js`：`fakeHistory()` 加两行（return 对象里）：

```js
    listPlayed: () => [],
    getSetting: () => null,
    setSetting: () => {},
```

文件末尾追加用例：

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: 新用例 FAIL（mode_set 无路由 → 等不到 mode='list' 超时，其余通过）。

- [ ] **Step 3: 实现 ws.js**

两处修改 `server/src/ws.js`：

3a. createJukebox 调用（第 25-31 行）加一行：

```js
    initialMode: history.getSetting('play_mode'),
```

3b. switch（第 72 行起）在 `case 'mute_toggle'` 后加：

```js
        case 'mode_set': jukebox.setMode(msg.value); break;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: 67 通过、0 失败。

- [ ] **Step 5: 提交**

```bash
git add server/src/ws.js server/test/ws.test.js
git commit -m "点歌台循环播放：mode_set 消息路由 + 启动时读 play_mode 设置

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: 网页端模式按钮

**Files:**
- Modify: `web/js/actions.js`
- Modify: `web/js/views/player.js`

**Interfaces:**
- Consumes: 广播 `state.mode`（Task 2/3 已产出）
- Produces: `ctx.actions.setMode(mode)`；控制条 `#modeBtn` 按钮

- [ ] **Step 1: actions.js 加 setMode**

`web/js/actions.js` 的 return 对象里 `toggleMute()` 行后加：

```js
    setMode(mode) { ws.send({ type: 'mode_set', value: mode }); },
```

- [ ] **Step 2: player.js 控制条加按钮**

2a. HTML（第 27 行 skipBtn 之后）加：

```html
        <button class="btn" id="modeBtn" title="切换播放模式">🔁 顺序</button>
```

2b. bind（`el.querySelector('#skipBtn')...` 之后）加：

```js
  const modeBtn = el.querySelector('#modeBtn');
  modeBtn.addEventListener('click', () => {
    const order = ['order', 'single', 'list'];
    const cur = (ctx.state && ctx.state.mode) || 'order';
    const next = order[(order.indexOf(cur) + 1) % order.length];
    ctx.actions.setMode(next);
  });
```

2c. update（第 89 行 `const status = ...` 附近，与其他按钮文案更新并列）加：

```js
  const modeBtn = el.querySelector('#modeBtn');
  const modeLabels = { order: '🔁 顺序', single: '🔂 单曲循环', list: '🔁 列表循环' };
  modeBtn.textContent = modeLabels[st.mode] || modeLabels.order;
```

- [ ] **Step 3: 人工验证点（浏览器）**

打开 `http://192.168.140.67:3000`（或点桌面「点歌台」图标）：
1. 控制条出现「🔁 顺序」按钮；
2. 点击 → 变「🔂 单曲循环」；再点 → 「🔁 列表循环」；再点 → 回「🔁 顺序」；
3. 手机扫码打开同一页面，模式变化同步显示（共享控制）。

- [ ] **Step 4: 提交**

```bash
git add web/js/actions.js web/js/views/player.js
git commit -m "点歌台循环播放：控制条模式切换按钮（顺序/单曲循环/列表循环）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: 全量回归 + 重启服务 + 真机 E2E 验收

- [ ] **Step 1: 全量测试**

Run: `cd C:\Users\Administrator\jukebox\server && npm test`
Expected: 67 通过、0 失败。再跑 `cd ../player && python -m pytest test_player.py -q`：全绿（基线 5 通过，确认未波及）。

- [ ] **Step 2: 重启服务器（旧代码还在跑，必须换新）**

```bash
SERVER_PID=$(netstat -ano | grep -i listen | grep ":3000" | head -1 | awk '{print $NF}')
taskkill //PID $SERVER_PID //F
cscript //nologo 'C:\Users\Administrator\jukebox\server\server_start_hidden.vbs'
sleep 4
curl -s -m 5 -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:3000
```

Expected: HTTP 200；播放端会在 5 秒内自动重连（player.log 出现「已连接云端并完成 hello」）。

- [ ] **Step 3: 真机 E2E 验收清单（与用户一起过）**

1. 桌面「点歌台」图标 → APP 窗口正常；
2. 点歌 2-3 首 → 顺序播完；切到「🔂 单曲循环」→ 放完自动重播同一首；点「切歌」→ 跳出循环播下一首；
3. 切到「🔁 列表循环」→ 等队列放空 → 自动接回之前播过的歌；
4. 重启服务器（再执行一次 Step 2 的命令）→ 网页仍显示重启前选的模式（持久化生效）。

- [ ] **Step 4: 提交收尾（如 E2E 中发现修复）并推送**

```bash
git log --oneline -6   # 核对本计划 4 个提交
git push origin master # 直连 github 不稳时重试
```

- [ ] **Step 5: 更新项目记忆**

在 office-ktv-jukebox-project.md 补：循环播放三模式已上线（键 play_mode、播放端零改动、列表回填已播升序≤100 条、切歌跳出单曲、失败不循环）。
