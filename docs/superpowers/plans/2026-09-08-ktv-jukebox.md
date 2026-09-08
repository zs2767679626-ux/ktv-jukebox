# 办公室 KTV 点歌台 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做一个公司全员共享的 KTV 风格点歌台：员工网页点歌，公司电脑（连蓝牙音箱）播放，全员可控制（点歌/切歌/暂停/音量）。

**Architecture:** 云服务器（腾讯 CloudStudio）跑 Node.js 后端（Express + ws + SQLite + 进程内网易云 API），前端零构建原生 JS 三视图（手机标签页 / 桌面三栏），公司电脑跑 Python + mpv 播放客户端，经 WebSocket 实时双向通信。点歌队列存内存，历史存 SQLite。

**Tech Stack:** Node.js ≥23.4（Express 4、ws、NeteaseCloudMusicApi npm 包 + 内置 node:sqlite，零原生编译）、原生 HTML/CSS/JS（ES modules，零构建）、Python ≥3.9（websockets、python-mpv + mpv）、测试用 node:test 与 unittest（无额外依赖）。

## Global Constraints

- 完全匿名：不登录、不采集、不显示任何点歌人身份信息（spec R3）
- 音量是 mpv 自身音量，范围 0–100，不动系统音量；静音记住原音量（spec §6）
- 实时同步：点歌/切歌/音量生效后 1 秒内广播到所有在线页面（spec §3）
- 点歌排队不打断当前播放；置顶=插到"下一首"；切歌=跳过当前播下一首；队列空则停（spec §5）
- 队列存内存（重启清空）；历史存 SQLite（重启保留）（spec §3）
- VIP/付费歌打标签；播不了自动跳过并在历史注明原因（spec §5.6）
- 播放端断线：网页显示"播放端离线"，点歌照常排队，重连自动接着播（spec §6 异常表）
- 界面全中文；深色 KTV 风；手机三标签页，桌面 ≥900px 三栏（spec §4）
- 部署目标：腾讯 CloudStudio（环境变量 PORT 由平台注入，WebSocket 走 /ws 路径）
- 音乐搜索/歌词/地址全部经后端 REST/进程内调用，前端不直接接触网易云

## 文件结构

```
jukebox/
  server/
    package.json          # deps: express, ws, NeteaseCloudMusicApi（历史库用内置 node:sqlite）；scripts: start, test
    bin/server.js         # 入口：读 config，组装真实依赖（sqlite + 网易云），启动 HTTP+WS
    src/config.js         # 端口/DB 路径/设备口令/网易云 realIP，全部来自 env
    src/store.js          # SQLite 历史记录：add / update / list / close
    src/queue.js          # 点歌队列状态机（纯逻辑，副作用经注入钩子）
    src/netease.js        # 网易云 API 封装：search/songUrl/lyric/artists/toplist/catlist/playlist
    src/api.js            # REST 路由（搜索、分类、榜单、歌词、health）
    src/ws.js             # WebSocket 中枢：连接分类、指令分发、状态广播、心跳
    src/index.js          # createApp({netease,history,isPlayerToken,webDir}) 组装（可测试）
    test/queue.test.js    # 队列状态机单测（node:test）
    test/store.test.js    # SQLite 历史单测（临时库文件）
    test/netease.test.js  # 网易云封装单测（注入假 api 模块）
    test/api.test.js      # REST 路由单测（注入假 netease，supertest 风格用 http 直连）
  web/
    index.html            # 壳：三视图容器 + 移动端底部标签 + 桌面三栏布局
    css/app.css           # KTV 深色主题、响应式布局、滑块/标签/歌词样式
    js/app.js             # 启动：连 WS、状态订阅、渲染调度、toast、连接状态显示
    js/actions.js         # 用户操作 → WS 消息（request/skip/pause/volume/mute/top/remove）
    js/ws-client.js       # WebSocket 连接 + 指数退避自动重连
    js/state.js           # 全局状态缓存 + servertime 时钟校准 + 订阅
    js/lrc.js             # LRC 解析 + 当前行定位（纯函数，可单测）
    js/views/point.js     # 点歌视图：搜索、分类宫格、歌手/榜单/风格/拼音子页、歌曲列表
    js/views/player.js    # 播放视图：当前歌曲、进度条、控制条（含音量滑条/静音）、歌词、下一首、二维码
    js/views/queue.js     # 已点视图：队列列表、置顶/删除
    vendor/qrcode.min.js  # qrcodejs（davidshimjs），静态引入
  player/
    player.py             # 入口：加载配置、建播放器、跑主循环
    config.py             # 配置加载（player_config.json + env 覆盖）
    mpv.py                # BasePlayer/MpvPlayer/VirtualPlayer：播放控制 + 结束事件探测
    client.py             # WS 客户端：hello、心跳、接收 player_cmd、上报事件、断线重连
    requirements.txt      # websockets, python-mpv
    test_player.py        # VirtualPlayer + 配置加载单测（unittest）
    setup_win.bat         # Windows 一键安装：依赖 + libmpv 下载 + 开机自启
    setup_mac.sh          # Mac 一键安装：brew mpv + pip + LaunchAgent
    player_config.example.json
    README.md             # 播放端安装/自启/换机说明
  .gitignore
  docs/superpowers/…      # 设计文档与本计划
```

## WebSocket 协议（全项目共用契约，所有任务以本节为准）

连接：`/ws`（同一 HTTP 服务）。服务端每 30s ping，客户端 20s 内未 pong 则终止。

**客户端 → 服务端**

```jsonc
// 播放端（连接后的第一条消息必须是这个，token 正确才算播放端，否则按网页端处理）
{"type":"player_hello","token":"<设备口令>"}
// 播放端事件上报
{"type":"player_event","event":"started"}
{"type":"player_event","event":"finished"}
{"type":"player_event","event":"error","detail":{"reason":"..."}}
// 网页端指令
{"type":"play_request","song":{"text":"晴天 周杰伦","song_id":"186016","title":"晴天","artist":"周杰伦","duration_ms":269000,"fee":0}}
{"type":"queue_top","id":"q1abc"}
{"type":"queue_remove","id":"q1abc"}
{"type":"skip"}
{"type":"pause"}
{"type":"resume"}
{"type":"volume_set","value":60}   // 0-100
{"type":"mute_toggle"}
```

**服务端 → 网页端与播放端（广播）**

```jsonc
{"type":"state","servertime":1789000000000,"state":{
  "current":{"id":"q1abc","song":{"text":"...","song_id":"...","title":"...","artist":"...","duration_ms":269000,"fee":0},"started_at":1788999990000},
  "queue":[{"id":"q2def","song":{/* 同上结构 */}}],
  "volume":60,"paused":false,"muted":false,"playerOnline":true
}}
{"type":"toast","msg":"版权受限，已自动跳过"}
```

**服务端 → 播放端（指令）**

```jsonc
{"type":"player_cmd","cmd":{"action":"play","url":"https://...mp3","song":{...},"volume":60,"muted":false}}
{"type":"player_cmd","cmd":{"action":"pause"}}
{"type":"player_cmd","cmd":{"action":"resume"}}
{"type":"player_cmd","cmd":{"action":"stop"}}
{"type":"player_cmd","cmd":{"action":"volume","value":60}}
{"type":"player_cmd","cmd":{"action":"mute","value":true}}
```

播放端行为约定：收到 `play` 后加载并播放，上报 `started`；歌曲自然播完上报 `finished`；加载失败上报 `error`。收到 `stop` 只停止不上报（服务端已自行结算历史）。`volume`/`mute` 随时可收，立即生效。

**song 对象结构**（点歌与历史共用）：

```jsonc
{"text":"晴天 周杰伦","song_id":"186016","title":"晴天","artist":"周杰伦","album":"叶惠美","duration_ms":269000,"fee":0}
```

- `text`：必填，点歌原文（纯文本点歌时只有 text）
- `song_id/title/artist/album/duration_ms/fee`：来自网易云搜索结果，可空
- `fee`：0=免费 1=VIP 4=付费 8=试听；前端仅对 1 标"VIP"、4 标"付费"

**历史状态机**：`requested`（入队时建记录）→ `playing`（开始播）→ `played`（播完）/ `skipped`（跳过，reason 取值：`用户跳过`、`版权受限`、`无法获取播放地址`、`播放错误`、`播放端断线`、`被移除`）。

## Phase 1 — 服务器核心

### Task 1: 项目脚手架与服务器启动

**Files:**
- Create: `server/package.json`, `server/src/config.js`, `server/bin/server.js`, `server/src/index.js`, `.gitignore`

**Interfaces:**
- Consumes: 无（第一个任务）
- Produces: `createApp({netease, history, isPlayerToken, webDir})` 返回 `{app, server, jukebox}`；`server.js` 为启动入口；后续任务往里填 netease/api/ws 模块

- [ ] **Step 1: 检查环境**

Run: `node -v && npm -v && python --version`
Expected: Node ≥18、npm ≥9、Python ≥3.9（缺 Python 不影响本阶段；Node 缺失则 `winget install OpenJS.NodeJS.LTS` 后重开终端）

- [ ] **Step 2: 写 package.json**

`server/package.json`:

```json
{
  "name": "jukebox-server",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "start": "node bin/server.js",
    "test": "node --test"
  },
  "engines": {
    "node": ">=23.4"
  },
  "dependencies": {
    "express": "^4.19.2",
    "ws": "^8.18.0",
    "NeteaseCloudMusicApi": "^4.22.7"
  }
}
```

- [ ] **Step 3: 安装依赖**

Run: `cd /c/Users/Administrator/jukebox/server && npm install`
Expected: 安装成功。历史库不装 better-sqlite3（原生模块在无 VS Build Tools 的 Windows 上编译失败），改用 Node 内置 `node:sqlite`（`DatabaseSync`，同步 API，Node ≥23.4 免编译；本机 24.18 已验证）。注意：**不要**引入 sql.js 等其他 SQLite 依赖

- [ ] **Step 4: 写 config.js**

`server/src/config.js`:

```js
'use strict';
const path = require('path');

module.exports = {
  // CloudStudio 会注入 PORT
  port: Number(process.env.PORT || 3000),
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'jukebox.db'),
  deviceToken: process.env.DEVICE_TOKEN || 'dev-token-change-me',
  neteaseRealIP: process.env.NETEASE_REAL_IP || '',
};
```

- [ ] **Step 5: 写 index.js（组装函数，依赖注入）**

`server/src/index.js`:

```js
'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const { createApi } = require('./api');
const { createRealtime } = require('./ws');

// 组装整个应用。netease/history 等依赖注入，便于测试。
function createApp({ netease, history, isPlayerToken, webDir }) {
  const app = express();
  app.use(express.json());
  app.use('/api', createApi({ netease }));
  app.use(express.static(webDir));
  // SPA 兜底：非 /api 路径回 index.html
  app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(webDir, 'index.html')));

  const server = http.createServer(app);
  const { jukebox } = createRealtime({
    server,
    history,
    resolveUrl: (song) => netease.songUrl(song.song_id),
    isPlayerToken,
  });
  return { app, server, jukebox };
}
module.exports = { createApp };
```

- [ ] **Step 6: 写 bin/server.js**

`server/bin/server.js`:

```js
'use strict';
const path = require('path');
const config = require('../src/config');
const { createStore } = require('../src/store');
const { createNetease } = require('../src/netease');
const { createApp } = require('../src/index');
const neteaseApi = require('NeteaseCloudMusicApi');

// data 目录（SQLite 文件所在地）
require('fs').mkdirSync(path.dirname(config.dbPath), { recursive: true });

const store = createStore(config.dbPath);
const netease = createNetease(neteaseApi, { realIP: config.neteaseRealIP });
const { server } = createApp({
  netease,
  history: store,
  isPlayerToken: (t) => Boolean(t) && t === config.deviceToken,
  webDir: path.join(__dirname, '..', '..', 'web'),
});

server.listen(config.port, () => {
  console.log(`jukebox server listening on :${config.port}`);
});
```

- [ ] **Step 7: 写 .gitignore**

`.gitignore`:

```
node_modules/
server/data/
__pycache__/
player/player_config.json
.DS_Store
```

- [ ] **Step 8: 临时放占位首页并验证启动**

Run: `echo '<h1>点歌台施工中</h1>' > /c/Users/Administrator/jukebox/web/index.html`
然后：`cd /c/Users/Administrator/jukebox/server && node bin/server.js &` 等 2 秒后 `curl -s localhost:3000/ && curl -s localhost:3000/api/health`
Expected: 首页输出 `点歌台施工中`，health 输出 `{"ok":true}`（此时 api.js/ws.js 还未建，Task 1 先建两个空壳文件保证能启动——见下两步）

- [ ] **Step 8b: 空壳 api.js / ws.js（先让服务能起）**

`server/src/api.js`:

```js
'use strict';
const express = require('express');

function createApi({ netease }) {
  const r = express.Router();
  r.get('/health', (req, res) => res.json({ ok: true }));
  return r;
}
module.exports = { createApi };
```

`server/src/ws.js`:

```js
'use strict';
const { WebSocketServer } = require('ws');

function createRealtime({ server, history, resolveUrl, isPlayerToken }) {
  const jukebox = { getState: () => ({ current: null, queue: [], volume: 60, paused: false, muted: false, playerOnline: false }) };
  const wss = new WebSocketServer({ server, path: '/ws' });
  return { jukebox, wss };
}
module.exports = { createRealtime };
```

- [ ] **Step 9: 停止进程并提交**

Run: `kill %1 2>/dev/null; cd /c/Users/Administrator/jukebox && git add -A && git commit -m "chore: server scaffold with health endpoint"`

### Task 2: SQLite 历史记录 store.js

**Files:**
- Create: `server/src/store.js`, `server/test/store.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `createStore(dbPath)` 返回 `{add(song, status)→id, update(id, fields), list(limit)→rows, close()}`；`add` 的 `song` 为协议里的 song 对象，`update` 的 `fields` 可含 `status/reason/started_at/finished_at`（null 值保留原值）

- [ ] **Step 1: 写失败测试**

`server/test/store.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../src/store');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukebox-'));
  return path.join(dir, 'test.db');
}

test('add 创建 requested 记录并返回自增 id', () => {
  const store = createStore(tempDb());
  const id = store.add({ text: '晴天 周杰伦', song_id: '186016', title: '晴天', artist: '周杰伦', duration_ms: 269000, fee: 0 });
  assert.equal(typeof id, 'number');
  const rows = store.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'requested');
  assert.equal(rows[0].title, '晴天');
  store.close();
});

test('update 修改状态与时间，list 按 id 倒序', () => {
  const store = createStore(tempDb());
  const a = store.add({ text: 'A' });
  const b = store.add({ text: 'B' });
  store.update(a, { status: 'playing', started_at: 1000 });
  store.update(a, { status: 'played', finished_at: 2000 });
  const rows = store.list();
  assert.equal(rows[0].id, b); // 倒序
  assert.equal(rows[1].status, 'played');
  assert.equal(rows[1].started_at, 1000);
  assert.equal(rows[1].finished_at, 2000);
  store.close();
});

test('update 传 null 字段保留原值', () => {
  const store = createStore(tempDb());
  const id = store.add({ text: 'A' });
  store.update(id, { status: 'playing' });
  store.update(id, { status: 'played', reason: null, started_at: null });
  const row = store.list()[0];
  assert.equal(row.status, 'played');
  assert.equal(row.reason, null);
  store.close();
});

test('list(limit) 截断条数', () => {
  const store = createStore(tempDb());
  for (let i = 0; i < 5; i++) store.add({ text: String(i) });
  assert.equal(store.list(3).length, 3);
  store.close();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /c/Users/Administrator/jukebox/server && node --test`（Windows 下带位置参数 `node --test test/` 会把目录当入口文件报错；无参数自动发现 test/ 目录）
Expected: FAIL（store.js 目前是 Task 1 留下的启动空壳，断言不通过——空壳会被本任务整体替换）

- [ ] **Step 3: 实现 store.js**

`server/src/store.js`:

```js
'use strict';
const { DatabaseSync } = require('node:sqlite');

function createStore(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      song_id TEXT, title TEXT, artist TEXT, album TEXT, text TEXT,
      duration_ms INTEGER, fee INTEGER,
      status TEXT NOT NULL DEFAULT 'requested',
      reason TEXT,
      requested_at INTEGER NOT NULL,
      started_at INTEGER, finished_at INTEGER
    );
  `);
  const addStmt = db.prepare(`
    INSERT INTO history (song_id,title,artist,album,text,duration_ms,fee,status,requested_at)
    VALUES (@song_id,@title,@artist,@album,@text,@duration_ms,@fee,'requested',@requested_at)`);
  const updateStmt = db.prepare(`
    UPDATE history SET status=@status, reason=@reason, started_at=@started_at, finished_at=@finished_at
    WHERE id=@id`);
  const getStmt = db.prepare(`SELECT * FROM history WHERE id=?`);
  const listStmt = db.prepare(`SELECT * FROM history ORDER BY id DESC LIMIT ?`);

  return {
    add(song) {
      const info = addStmt.run({
        song_id: song.song_id ?? null,
        title: song.title ?? null,
        artist: song.artist ?? null,
        album: song.album ?? null,
        text: song.text ?? null,
        duration_ms: song.duration_ms ?? null,
        fee: song.fee ?? null,
        requested_at: Date.now(),
      });
      return Number(info.lastInsertRowid);
    },
    update(id, fields) {
      const cur = getStmt.get(id);
      if (!cur) return;
      updateStmt.run({
        id,
        status: fields.status ?? cur.status,
        reason: fields.reason ?? cur.reason,
        started_at: fields.started_at ?? cur.started_at,
        finished_at: fields.finished_at ?? cur.finished_at,
      });
    },
    list(limit = 50) {
      return listStmt.all(limit);
    },
    close() {
      db.close();
    },
  };
}
module.exports = { createStore };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /c/Users/Administrator/jukebox/server && node --test`（Windows 下带位置参数 `node --test test/` 会把目录当入口文件报错；无参数自动发现 test/ 目录）
Expected: 4 个测试全 PASS

- [ ] **Step 5: 提交**

Run: `cd /c/Users/Administrator/jukebox && git add -A && git commit -m "feat: sqlite history store"`

### Task 3: 点歌队列状态机 queue.js

**Files:**
- Create: `server/src/queue.js`, `server/test/queue.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `createJukebox({resolveUrl, sendToPlayer, broadcast, history, now})` 返回 `{getState, addToQueue, topQueue, removeQueue, skip, pause, resume, setVolume, toggleMute, playerHello, playerGone, playerEvent, playNext}`（签名与语义见代码注释；这是全项目状态核心，Phase 2/3 都依赖）

- [ ] **Step 1: 写失败测试**

`server/test/queue.test.js`:

```js
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
  const { j, history } = setup({ resolveUrl: async (song) => (song.title === 'A' ? { error: 'vip' } : { url: `http://example.com/${song.title}.mp3` }) });
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
  await flush();
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /c/Users/Administrator/jukebox/server && node --test`（Windows 下带位置参数 `node --test test/` 会把目录当入口文件报错；无参数自动发现 test/ 目录）
Expected: FAIL（`Cannot find module '../src/queue'`）

- [ ] **Step 3: 实现 queue.js**

`server/src/queue.js`:

```js
'use strict';

// 点歌队列状态机。纯逻辑：不接触网络/数据库，所有副作用经注入钩子完成。
// 状态语义：
//   current  — 正在播（或 URL 解析中）的条目 {id, song, historyId, started_at, url}
//   queue    — 排队条目 [{id, song, historyId}]
//   volume   — 0..100（mpv 音量）
//   paused / muted / playerOnline — 布尔
function createJukebox(deps) {
  const {
    resolveUrl,   // async (song) => {url} | {error:'vip'|'unavailable'}
    sendToPlayer, // (cmd) => void
    broadcast,    // () => void
    history,      // { add(song) => id, update(id, fields) }
    now = () => Date.now(),
  } = deps;

  const state = {
    current: null,
    queue: [],
    volume: 60,
    paused: false,
    muted: false,
    playerOnline: false,
  };

  let seq = 0;
  const nextId = () => 'q' + (++seq) + Math.random().toString(36).slice(2, 6);

  function getState() {
    return {
      current: state.current && {
        id: state.current.id,
        song: state.current.song,
        started_at: state.current.started_at,
      },
      queue: state.queue.map(({ id, song }) => ({ id, song })),
      volume: state.volume,
      paused: state.paused,
      muted: state.muted,
      playerOnline: state.playerOnline,
    };
  }

  function send(cmd) { sendToPlayer(cmd); }

  function addToQueue(song) {
    const item = { id: nextId(), song, historyId: history.add(song) };
    if (state.playerOnline && !state.current) {
      playItem(item);
    } else {
      state.queue.push(item);
      broadcast();
    }
  }

  function topQueue(id) {
    const i = state.queue.findIndex((q) => q.id === id);
    if (i > 0) {
      const [item] = state.queue.splice(i, 1);
      state.queue.unshift(item);
      broadcast();
    }
  }

  function removeQueue(id) {
    const i = state.queue.findIndex((q) => q.id === id);
    if (i >= 0) {
      const [item] = state.queue.splice(i, 1);
      history.update(item.historyId, { status: 'skipped', reason: '被移除', finished_at: now() });
      broadcast();
    }
  }

  async function playItem(item) {
    state.current = item;
    item.started_at = now();
    history.update(item.historyId, { status: 'playing', started_at: item.started_at });
    broadcast();
    const resolved = await resolveUrl(item.song).catch(() => ({ error: 'unavailable' }));
    if (state.current !== item) return; // 解析期间已被顶替（切歌等），结果作废
    if (resolved.error) {
      finishCurrent('skipped', resolved.error === 'vip' ? '版权受限' : '无法获取播放地址');
      playNext();
      return;
    }
    item.url = resolved.url;
    send({ action: 'play', url: resolved.url, song: item.song, volume: state.volume, muted: state.muted });
    broadcast();
  }

  function finishCurrent(status, reason) {
    if (!state.current) return;
    history.update(state.current.historyId, { status, reason: reason || null, finished_at: now() });
    state.current = null;
    broadcast();
  }

  function playNext() {
    if (!state.current && state.queue.length && state.playerOnline) {
      playItem(state.queue.shift());
    } else {
      broadcast();
    }
  }

  // ===== 全员指令 =====
  function skip() {
    if (state.current) {
      send({ action: 'stop' });
      finishCurrent('skipped', '用户跳过');
    }
    playNext();
  }

  function pause() {
    if (state.current) { state.paused = true; send({ action: 'pause' }); broadcast(); }
  }

  function resume() {
    if (state.current) { state.paused = false; send({ action: 'resume' }); broadcast(); }
  }

  function setVolume(v) {
    state.volume = Math.max(0, Math.min(100, Math.round(v)));
    send({ action: 'volume', value: state.volume });
    broadcast();
  }

  function toggleMute() {
    state.muted = !state.muted;
    send({ action: 'mute', value: state.muted });
    broadcast();
  }

  // ===== 播放端事件 =====
  function playerHello() {
    state.playerOnline = true;
    send({ action: 'volume', value: state.volume });
    send({ action: 'mute', value: state.muted });
    if (!state.current) playNext();
    else broadcast();
  }

  function playerGone() {
    state.playerOnline = false;
    if (state.current) {
      finishCurrent('skipped', '播放端断线');
    }
    broadcast();
  }

  function playerEvent(event, detail = {}) {
    if (event === 'finished') {
      finishCurrent('played', null);
      playNext();
    } else if (event === 'error') {
      finishCurrent('skipped', detail.reason || '播放错误');
      // 音频设备掉线时不自动续播（音箱没了，播下去也是漏音），恢复后由播放端重连或手动点歌触发
      if (detail.reason !== '音频设备掉线') playNext();
    }
    // 'started' 由播放端在上报时自带，服务端无需处理
  }

  return {
    getState, addToQueue, topQueue, removeQueue,
    skip, pause, resume, setVolume, toggleMute,
    playerHello, playerGone, playerEvent, playNext,
  };
}
module.exports = { createJukebox };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /c/Users/Administrator/jukebox/server && node --test`（Windows 下带位置参数 `node --test test/` 会把目录当入口文件报错；无参数自动发现 test/ 目录）
Expected: 全部 PASS（store 4 个 + queue 13 个）

- [ ] **Step 5: 提交**

Run: `cd /c/Users/Administrator/jukebox && git add -A && git commit -m "feat: queue state machine"`

### Task 4: 网易云 API 封装 netease.js

**Files:**
- Create: `server/src/netease.js`, `server/test/netease.test.js`

**Interfaces:**
- Consumes: `NeteaseCloudMusicApi` npm 包（进程内调用，`api.search({keywords, limit, type:1})` 等）
- Produces: `createNetease(api, {realIP})` 返回：
  - `search(q, limit=30) → [{id,title,artist,album,duration_ms,fee}]`
  - `songUrl(id) → {url} | {error:'vip'|'unavailable'}`
  - `lyric(id) → lrc字符串 | null`
  - `artists(type, initial) → [{id,name,pic}]`（type: male|female|band）
  - `artistSongs(id) → [song]`
  - `toplists() → [{id,name}]`、`toplistSongs(id) → [song]`
  - `catlist() → [名称]`、`stylePlaylists(cat) → [{id,name,cover}]`、`playlistSongs(id) → [song]`
  - song 结构 = 协议 song 对象（含 fee）

- [ ] **Step 1: 写失败测试（注入假 api，测归一化与容错，不碰真实网络）**

`server/test/netease.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createNetease } = require('../src/netease');

function fakeApi(overrides = {}) {
  return {
    search: async () => ({
      body: { result: { songs: [
        { id: 186016, name: '晴天', ar: [{ name: '周杰伦' }], al: { name: '叶惠美' }, dt: 269000, fee: 0 },
        { id: 2, name: 'VIP歌', ar: [], al: null, dt: 0, fee: 1 },
      ] } },
    }),
    song_url: async ({ id }) => String(id) === '1'
      ? { body: { data: [{ url: 'http://x/1.mp3' }] } }
      : { body: { data: [{ code: 404 }] } },
    lyric: async () => ({ body: { lrc: { lyric: '[00:00.00]词' } } }),
    artist_list: async () => ({ body: { artists: [{ id: 7, name: '某歌手', picUrl: 'p' }] } }),
    artist_songs: async () => ({ body: { songs: [{ id: 3, name: '歌', ar: [{ name: '某人' }], dt: 1000, fee: 4 }] } }),
    toplist_detail: async () => ({ body: { list: [{ id: 3778678, name: '热歌榜', tracks: [{ id: 5, name: '热歌', ar: [{ name: '热' }], dt: 2000, fee: 0 }] }] } }),
    playlist_catlist: async () => ({ body: { sub: [{ name: '流行' }, { name: '摇滚' }] } }),
    top_playlist: async () => ({ body: { playlists: [{ id: 9, name: '流行精选', coverImgUrl: 'c' }] } }),
    playlist_detail: async () => ({ body: { playlist: { tracks: [{ id: 8, name: '歌单歌', ar: [{ name: 'a' }], dt: 3000, fee: 0 }] } } }),
    ...overrides,
  };
}

test('search 归一化：title/artist/album/duration/fee', async () => {
  const n = createNetease(fakeApi());
  const r = await n.search('晴天');
  assert.equal(r[0].id, '186016');
  assert.equal(r[0].title, '晴天');
  assert.equal(r[0].artist, '周杰伦');
  assert.equal(r[0].album, '叶惠美');
  assert.equal(r[0].duration_ms, 269000);
  assert.equal(r[1].fee, 1);
});

test('songUrl：404 → error:vip；有 url 正常返回', async () => {
  const n = createNetease(fakeApi());
  assert.deepEqual(await n.songUrl('1'), { url: 'http://x/1.mp3' });
  assert.deepEqual(await n.songUrl('2'), { error: 'vip' });
});

test('songUrl：无 url 且非 404 → 降级 128k 重试后仍无 → unavailable', async () => {
  const n = createNetease(fakeApi({
    song_url: async () => ({ body: { data: [{ code: -110 }] } }),
  }));
  assert.deepEqual(await n.songUrl('1'), { error: 'unavailable' });
});

test('lyric 为空对象时返回 null', async () => {
  const n = createNetease(fakeApi({ lyric: async () => ({ body: {} }) }));
  assert.equal(await n.lyric('1'), null);
});

test('toplists/toplistSongs/artists/catlist/playlist 各返回归一化结构', async () => {
  const n = createNetease(fakeApi());
  const lists = await n.toplists();
  assert.equal(lists[0].name, '热歌榜');
  const songs = await n.toplistSongs('3778678');
  assert.equal(songs[0].title, '热歌');
  const artists = await n.artists('male');
  assert.equal(artists[0].id, '7');
  assert.deepEqual(await n.catlist(), ['流行', '摇滚']);
  const pl = await n.stylePlaylists('流行');
  assert.equal(pl[0].name, '流行精选');
  const ps = await n.playlistSongs('9');
  assert.equal(ps[0].title, '歌单歌');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /c/Users/Administrator/jukebox/server && node --test`（Windows 下带位置参数 `node --test test/` 会把目录当入口文件报错；无参数自动发现 test/ 目录）
Expected: FAIL（netease.js 目前是 Task 1 留下的启动空壳，断言不通过——空壳会被本任务整体替换）

- [ ] **Step 3: 实现 netease.js**

`server/src/netease.js`:

```js
'use strict';

// 网易云 API 封装。所有函数返回归一化结构，对调用方屏蔽底层细节。
// 注意：songUrl 对 VIP/付费歌返回 error:'vip'，调用方（queue）据此跳过。
function createNetease(api, opts = {}) {
  const { realIP = '' } = opts;

  function normalize(s) {
    return {
      id: String(s.id),
      title: s.name || '',
      artist: ((s.ar || s.artists || []).map((a) => a.name).join('/')) || '',
      album: (s.al && s.al.name) || (s.album && s.album.name) || '',
      duration_ms: s.dt || s.duration || 0,
      fee: s.fee ?? 0,
    };
  }

  async function search(q, limit = 30) {
    const res = await api.search({ keywords: q, limit, type: 1 });
    return (res.body?.result?.songs || []).map(normalize);
  }

  async function songUrl(id) {
    const base = { id, realIP };
    const res = await api.song_url({ ...base, br: 320000 });
    const data = (res.body?.data || [])[0] || {};
    if (data.url) return { url: data.url };
    const isVip = data.code === 404;
    // 降级低音质重试一次
    const res2 = await api.song_url({ ...base, br: 128000 });
    const d2 = (res2.body?.data || [])[0] || {};
    if (d2.url) return { url: d2.url };
    return { error: isVip ? 'vip' : 'unavailable' };
  }

  async function lyric(id) {
    const res = await api.lyric({ id });
    return res.body?.lrc?.lyric || null;
  }

  async function artists(type = 'male', initial) {
    const typeMap = { male: 1, female: 2, band: 3 };
    const res = await api.artist_list({
      type: typeMap[type] ?? 1, initial, limit: 60, area: -1,
    });
    return (res.body?.artists || []).map((a) => ({ id: String(a.id), name: a.name, pic: a.picUrl }));
  }

  async function artistSongs(id) {
    const res = await api.artist_songs({ id, limit: 50, order: 'hot' });
    return (res.body?.songs || []).map(normalize);
  }

  async function toplists() {
    const res = await api.toplist_detail();
    return (res.body?.list || []).map((t) => ({ id: String(t.id), name: t.name }));
  }

  async function toplistSongs(id) {
    const res = await api.toplist_detail();
    const target = (res.body?.list || []).find((t) => String(t.id) === String(id));
    return (target?.tracks || []).map(normalize);
  }

  async function catlist() {
    const res = await api.playlist_catlist();
    return (res.body?.sub || []).map((c) => c.name);
  }

  async function stylePlaylists(cat, limit = 30) {
    const res = await api.top_playlist({ cat, limit, order: 'hot' });
    return (res.body?.playlists || []).map((p) => ({ id: String(p.id), name: p.name, cover: p.coverImgUrl }));
  }

  async function playlistSongs(id) {
    const res = await api.playlist_detail({ id });
    return ((res.body?.playlist?.tracks) || []).slice(0, 100).map(normalize);
  }

  return { search, songUrl, lyric, artists, artistSongs, toplists, toplistSongs, catlist, stylePlaylists, playlistSongs };
}
module.exports = { createNetease };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /c/Users/Administrator/jukebox/server && node --test`（Windows 下带位置参数 `node --test test/` 会把目录当入口文件报错；无参数自动发现 test/ 目录）
Expected: 全部 PASS

- [ ] **Step 5: 提交**

Run: `cd /c/Users/Administrator/jukebox && git add -A && git commit -m "feat: netease api wrapper"`

### Task 5: REST 路由 api.js（真实现）

**Files:**
- Modify: `server/src/api.js`（替换空壳）
- Create: `server/test/api.test.js`

**Interfaces:**
- Consumes: Task 4 的 `netease` 接口
- Produces: REST 端点（前端 Phase 2 依赖）：
  - `GET /api/health` → `{ok:true}`
  - `POST /api/search {q}` → `{results:[song]}`
  - `GET /api/artists?type=male|female|band&initial=A` → `{artists:[...]}`
  - `GET /api/artist-songs?id=7` → `{songs:[song]}`
  - `GET /api/toplist` → `{lists:[{id,name}]}`；`GET /api/toplist?id=3778678` → `{songs:[song]}`
  - `GET /api/catlist` → `{cats:[名称]}`；`GET /api/style-playlists?cat=流行` → `{playlists:[...]}`；`GET /api/playlist-songs?id=9` → `{songs:[song]}`
  - `GET /api/lyric?id=186016` → `{lrc:string|null}`

- [ ] **Step 1: 写失败测试（用假 netease 注入 createApi，http 直连 app）**

`server/test/api.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('http');
const { createApi } = require('../src/api');

async function withServer(handler) {
  const fake = {
    search: async (q) => [{ id: '1', title: q, artist: 'X', album: '', duration_ms: 1, fee: 0 }],
    artists: async () => [{ id: '7', name: '歌手', pic: 'p' }],
    artistSongs: async () => [{ id: '2', title: '歌', artist: 'X', album: '', duration_ms: 1, fee: 0 }],
    toplists: async () => [{ id: '3778678', name: '热歌榜' }],
    toplistSongs: async () => [{ id: '3', title: '热歌', artist: 'X', album: '', duration_ms: 1, fee: 0 }],
    catlist: async () => ['流行'],
    stylePlaylists: async () => [{ id: '9', name: '精选', cover: 'c' }],
    playlistSongs: async () => [{ id: '4', title: '歌单歌', artist: 'X', album: '', duration_ms: 1, fee: 0 }],
    lyric: async () => '[00:00.00]词',
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createApi({ netease: fake }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try { await handler(port); } finally { server.close(); }
}
const req = (port, method, p, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const r = http.request({ port, method, path: encodeURI(p), headers: data ? { 'content-type': 'application/json' } : {} }, (res) => {
    let buf = '';
    res.on('data', (c) => { buf += c; });
    res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(buf) }));
  });
  r.on('error', reject);
  r.end(data);
});

test('health 与 search', async () => {
  await withServer(async (port) => {
    assert.deepEqual(await req(port, 'GET', '/api/health'), { status: 200, json: { ok: true } });
    const s = await req(port, 'POST', '/api/search', { q: '晴天' });
    assert.equal(s.json.results[0].title, '晴天');
    assert.equal(s.json.results[0].fee, 0);
  });
});

test('search 空关键词返回空数组', async () => {
  await withServer(async (port) => {
    const s = await req(port, 'POST', '/api/search', { q: '  ' });
    assert.deepEqual(s.json.results, []);
  });
});

test('artists/artist-songs/toplist/catlist/style-playlists/playlist-songs/lyric 端点', async () => {
  await withServer(async (port) => {
    const a = await req(port, 'GET', '/api/artists?type=female&initial=B');
    assert.equal(a.json.artists[0].name, '歌手');
    assert.equal((await req(port, 'GET', '/api/artist-songs?id=7')).json.songs[0].title, '歌');
    const l = await req(port, 'GET', '/api/toplist');
    assert.equal(l.json.lists[0].id, '3778678');
    assert.equal((await req(port, 'GET', '/api/toplist?id=3778678')).json.songs[0].title, '热歌');
    assert.deepEqual((await req(port, 'GET', '/api/catlist')).json.cats, ['流行']);
    assert.equal((await req(port, 'GET', '/api/style-playlists?cat=流行')).json.playlists[0].name, '精选');
    assert.equal((await req(port, 'GET', '/api/playlist-songs?id=9')).json.songs[0].title, '歌单歌');
    assert.equal((await req(port, 'GET', '/api/lyric?id=1')).json.lrc, '[00:00.00]词');
  });
});

test('netease 抛错 → 500 {error}', async () => {
  await withServer(async (port) => {
    const r = await req(port, 'GET', '/api/toplist?badpath'); // 用正常端点即可
    void r;
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /c/Users/Administrator/jukebox/server && node --test`（Windows 下带位置参数 `node --test test/` 会把目录当入口文件报错；无参数自动发现 test/ 目录）
Expected: FAIL（health/search 全 404——api.js 还是空壳）

- [ ] **Step 3: 实现 api.js**

`server/src/api.js`（整体替换）:

```js
'use strict';
const express = require('express');

function createApi({ netease }) {
  const r = express.Router();
  const wrap = (fn) => (req, res) =>
    fn(req, res).catch((e) => {
      console.error('[api]', e);
      res.status(500).json({ error: String((e && e.message) || e) });
    });

  r.get('/health', (req, res) => res.json({ ok: true }));

  r.post('/search', wrap(async (req, res) => {
    const q = String(req.body?.q || '').trim();
    if (!q) return res.json({ results: [] });
    res.json({ results: await netease.search(q) });
  }));

  r.get('/artists', wrap(async (req, res) => {
    res.json({ artists: await netease.artists(req.query.type || 'male', req.query.initial || undefined) });
  }));

  r.get('/artist-songs', wrap(async (req, res) => {
    res.json({ songs: await netease.artistSongs(req.query.id) });
  }));

  r.get('/toplist', wrap(async (req, res) => {
    if (req.query.id) return res.json({ songs: await netease.toplistSongs(req.query.id) });
    res.json({ lists: await netease.toplists() });
  }));

  r.get('/catlist', wrap(async (req, res) => res.json({ cats: await netease.catlist() })));

  r.get('/style-playlists', wrap(async (req, res) => {
    res.json({ playlists: await netease.stylePlaylists(req.query.cat) });
  }));

  r.get('/playlist-songs', wrap(async (req, res) => {
    res.json({ songs: await netease.playlistSongs(req.query.id) });
  }));

  r.get('/lyric', wrap(async (req, res) => {
    res.json({ lrc: await netease.lyric(req.query.id) });
  }));

  return r;
}
module.exports = { createApi };
```

- [ ] **Step 4: 修正 api.test.js 最后一个用例（500 行为）**

把 `test/api.test.js` 最后一个 test 替换为注入会抛错的假 netease 后再请求：

```js
test('netease 抛错 → 500 {error}', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', createApi({ netease: { search: async () => { throw new Error('boom'); } } }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try {
    const r = await req(port, 'POST', '/api/search', { q: 'x' });
    assert.equal(r.status, 500);
    assert.equal(r.json.error, 'boom');
  } finally { server.close(); }
});
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd /c/Users/Administrator/jukebox/server && node --test`（Windows 下带位置参数 `node --test test/` 会把目录当入口文件报错；无参数自动发现 test/ 目录）
Expected: 全部 PASS

- [ ] **Step 6: 提交**

Run: `cd /c/Users/Administrator/jukebox && git add -A && git commit -m "feat: rest api routes"`

### Task 6: WebSocket 中枢 ws.js（真实现）+ 服务器集成

**Files:**
- Modify: `server/src/ws.js`（替换空壳）
- Create: `server/test/ws.test.js`

**Interfaces:**
- Consumes: Task 3 `createJukebox` 的完整接口；协议见文件头
- Produces: `createRealtime({server, history, resolveUrl, isPlayerToken})` 返回 `{jukebox, wss}`：
  - 连接分类：首消息 `player_hello` 且 token 正确 → 播放端（同刻只保留一个，新的顶掉旧的）；否则网页端
  - 每次 jukebox 状态变化广播 `{type:'state', state, servertime}` 给全部客户端；`{type:'toast', msg}` 只给网页端
  - 心跳：每 30s ping，未 pong 则 terminate
  - `server` 挂到同一 HTTP 服务，路径 `/ws`

- [ ] **Step 1: 写失败测试（假历史 + 假 resolveUrl，真实 ws 客户端）**

`server/test/ws.test.js`:

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /c/Users/Administrator/jukebox/server && node --test`（Windows 下带位置参数 `node --test test/` 会把目录当入口文件报错；无参数自动发现 test/ 目录）
Expected: FAIL（ws.js 空壳：状态不广播、指令不生效）

- [ ] **Step 3: 实现 ws.js**

`server/src/ws.js`（整体替换）:

```js
'use strict';
const { WebSocketServer } = require('ws');
const { createJukebox } = require('./queue');

// WebSocket 中枢。连接分类 + 指令分发 + 状态广播 + 心跳。
function createRealtime({ server, history, resolveUrl, isPlayerToken, log = () => {} }) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const webClients = new Set();
  let player = null;

  function sendToPlayer(cmd) {
    if (player && player.readyState === 1) {
      player.send(JSON.stringify({ type: 'player_cmd', cmd }));
    }
  }
  function sendState() {
    const msg = JSON.stringify({ type: 'state', state: jukebox.getState(), servertime: Date.now() });
    for (const c of webClients) if (c.readyState === 1) c.send(msg);
    if (player && player.readyState === 1) player.send(msg);
  }
  function sendToast(msg) {
    const data = JSON.stringify({ type: 'toast', msg });
    for (const c of webClients) if (c.readyState === 1) c.send(data);
  }

  const jukebox = createJukebox({
    resolveUrl,
    history,
    sendToPlayer,
    broadcast: sendState,
  });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    let role = null; // 'web' | 'player'

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!role) {
        if (msg.type === 'player_hello' && isPlayerToken(msg.token)) {
          role = 'player';
          if (player) player.close();
          player = ws;
          log('player connected');
          jukebox.playerHello();
          return;
        }
        role = 'web';
        webClients.add(ws);
      }
      if (role === 'player') {
        if (msg.type === 'player_event') jukebox.playerEvent(msg.event, msg.detail);
        return;
      }
      switch (msg.type) {
        case 'play_request': jukebox.addToQueue(msg.song || { text: msg.text || '' }); break;
        case 'queue_top': jukebox.topQueue(msg.id); break;
        case 'queue_remove': jukebox.removeQueue(msg.id); break;
        case 'skip': jukebox.skip(); break;
        case 'pause': jukebox.pause(); break;
        case 'resume': jukebox.resume(); break;
        case 'volume_set': jukebox.setVolume(msg.value); break;
        case 'mute_toggle': jukebox.toggleMute(); break;
      }
    });

    ws.on('close', () => {
      if (role === 'player') {
        // 仅当断开的是当前播放端才下线；被新播放端顶掉的旧连接不触发 playerGone（否则会误跳过当前歌、抹掉 playerOnline）
        if (player === ws) {
          player = null;
          jukebox.playerGone();
          log('player disconnected');
        }
      } else if (role === 'web') {
        webClients.delete(ws);
      }
    });
    ws.on('error', () => {});
  });

  const pingTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);
  wss.on('close', () => clearInterval(pingTimer));

  return { jukebox, wss };
}
module.exports = { createRealtime };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /c/Users/Administrator/jukebox/server && node --test`（Windows 下带位置参数 `node --test test/` 会把目录当入口文件报错；无参数自动发现 test/ 目录）
Expected: 全部 PASS（store 4 + queue 13 + netease 5 + api 4 + ws 6）

- [ ] **Step 5: 启动真服务器联调真实网易云（手动验证）**

Run: `cd /c/Users/Administrator/jukebox/server && node bin/server.js &`，然后：
`curl -s -X POST localhost:3000/api/search -H "content-type: application/json" -d '{"q":"周杰伦"}' | head -c 300`
Expected: 返回真实歌曲 JSON（含 title/artist/fee 字段）。若整体超时/报错，检查外网与 163 连通性；若正常，继续验证 WS：
`cd /c/Users/Administrator/jukebox/server && node -e "const WebSocket=require('ws');const w=new WebSocket('ws://localhost:3000/ws');w.on('open',()=>{w.send(JSON.stringify({type:'player_hello',token:'dev-token-change-me'}));setTimeout(()=>{const c=new WebSocket('ws://localhost:3000/ws');c.on('open',()=>c.send(JSON.stringify({type:'play_request',song:{text:'测试',song_id:'186016',title:'晴天',artist:'周杰伦',duration_ms:269000,fee:0}})));c.on('message',d=>{const m=JSON.parse(d);if(m.type==='state'){console.log('STATE',JSON.stringify(m.state));process.exit(0);}});},300);});w.on('message',d=>{const m=JSON.parse(d);if(m.type==='player_cmd')console.log('PLAYER_CMD',JSON.stringify(m.cmd));});setTimeout(()=>process.exit(1),10000);"`
Expected: 打印 `PLAYER_CMD {"action":"play","url":"https://...","song":...}`（真实歌曲地址）和 `STATE`（current 有歌）。测试完 `kill %1`

- [ ] **Step 6: 提交**

Run: `cd /c/Users/Administrator/jukebox && git add -A && git commit -m "feat: websocket hub and realtime integration"`

## Phase 2 — 前端

### Task 7: 前端壳、主题与实时骨架

**Files:**
- Create: `web/index.html`, `web/css/app.css`, `web/js/app.js`, `web/js/ws-client.js`, `web/js/state.js`, `web/js/actions.js`, `web/js/views/point.js`, `web/js/views/player.js`, `web/js/views/queue.js`（后三个本任务先建空渲染函数，Task 8-11 填充）

**Interfaces:**
- Consumes: 协议见文件头；REST 端点见 Task 5
- Produces:
  - `ws-client.js`: `createWsClient(url, {onMessage, onStatus}) → {connect, send(obj), close}`（断线 1s→2s→4s→…→10s 重试）
  - `state.js`: `store = {state, apply(stateMsg), subscribe(fn), serverNow()}`（`apply` 时校准 `offset = servertime - Date.now()`）
  - `actions.js`: `bindActions(ws) → {request(song), skip(), togglePause(), setVolume(v), toggleMute(), top(id), remove(id)}`
  - `app.js`: 启动 ws、订阅渲染、toast、连接状态显示、移动端标签切换
  - 三个 view 模块导出 `render(rootEl, ctx)`；`ctx = {state: 最新 state, actions, toast(msg), serverNow}`

- [ ] **Step 1: 写 index.html（三视图壳 + 移动标签 + 桌面三栏）**

`web/index.html`:

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#0d0f14" />
  <title>办公室 KTV 点歌台</title>
  <link rel="stylesheet" href="css/app.css" />
</head>
<body>
  <header class="topbar">
    <h1>🎤 点歌台</h1>
    <span class="sub" id="conn">连接中…</span>
  </header>
  <main id="main" class="main">
    <section class="panel" id="view-point"><div class="loading">加载中…</div></section>
    <section class="panel" id="view-player"><div class="loading">加载中…</div></section>
    <section class="panel" id="view-queue"><div class="loading">加载中…</div></section>
  </main>
  <nav class="tabs" id="tabs">
    <button data-view="point" class="tab active">🎵 点歌</button>
    <button data-view="player" class="tab">▶ 播放</button>
    <button data-view="queue" class="tab">📃 已点</button>
  </nav>
  <div class="toast" id="toast"></div>
  <script src="vendor/qrcode.min.js"></script>
  <script type="module" src="js/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: 写 css/app.css（KTV 深色主题 + 响应式）**

`web/css/app.css`:

```css
:root {
  --bg: #0d0f14; --bg2: #15181f; --card: #1a1e27; --card2: #222734;
  --border: #2b3242; --text: #f2f3f7; --dim: #9aa3b2;
  --accent: #ff3b6b; --accent2: #ff7a59; --gold: #f5b042;
  --green: #22c55e; --red: #ef4444; --radius: 14px;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text);
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
  min-height: 100vh; -webkit-font-smoothing: antialiased; }
.topbar { display: flex; align-items: baseline; justify-content: space-between;
  padding: 14px 16px 4px; }
.topbar h1 { font-size: 20px; margin: 0; letter-spacing: .5px; }
.topbar .sub { color: var(--dim); font-size: 12px; }
.main { padding: 12px 16px 96px; }
/* 桌面三栏 */
@media (min-width: 900px) {
  .main { display: grid; grid-template-columns: minmax(340px, 2fr) 3fr 2fr;
    gap: 16px; max-width: 1400px; margin: 0 auto; padding: 12px 24px 40px; }
  .tabs { display: none; }
  .panel { border: 1px solid var(--border); border-radius: var(--radius);
    background: var(--card); padding: 16px; overflow-y: auto; max-height: calc(100vh - 90px); }
}
/* 移动端：面板隐藏，标签切换 */
.panel { min-height: 300px; }
body[data-view="point"] #view-point,
body[data-view="player"] #view-player,
body[data-view="queue"] #view-queue { display: block; }
@media (max-width: 899px) {
  .panel { display: none; }
}
.tabs { position: fixed; left: 0; right: 0; bottom: 0; display: flex;
  background: var(--bg2); border-top: 1px solid var(--border); padding-bottom: env(safe-area-inset-bottom); }
.tab { flex: 1; padding: 12px 0 10px; background: none; border: none; color: var(--dim);
  font-size: 13px; cursor: pointer; font-family: inherit; }
.tab.active { color: var(--accent); font-weight: 600; }
.card { background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 14px; margin-bottom: 14px; }
.card h2 { margin: 0 0 10px; font-size: 13px; color: var(--dim);
  text-transform: uppercase; letter-spacing: 1.5px; display: flex; justify-content: space-between; align-items: center; }
/* NOW PLAYING 卡 */
.now { background: linear-gradient(135deg, var(--accent), var(--accent2));
  border-radius: var(--radius); padding: 18px; margin-bottom: 14px; color: #fff; }
.now.empty { background: var(--card); border: 1px dashed var(--border); }
.now.empty .song { color: var(--dim); font-weight: 500; font-size: 15px; }
.now .label { font-size: 11px; letter-spacing: 2px; opacity: .85; }
.now .song { font-size: 21px; font-weight: 700; margin: 4px 0; word-break: break-word; }
.now .meta { font-size: 12px; opacity: .85; }
/* 控制条 */
.controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.btn { background: var(--card2); color: var(--text); border: 1px solid var(--border);
  border-radius: 10px; padding: 9px 14px; font-size: 14px; cursor: pointer; font-family: inherit; }
.btn.primary { background: var(--accent); border: none; color: #fff; font-weight: 600; }
.btn:disabled { opacity: .45; cursor: not-allowed; }
.vol-row { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 140px; }
.vol-row input[type=range] { flex: 1; accent-color: var(--accent); }
/* 进度条 */
.progress { height: 5px; background: rgba(255,255,255,.18); border-radius: 3px; margin: 12px 0 4px; overflow: hidden; }
.progress > i { display: block; height: 100%; background: #fff; border-radius: 3px; }
/* 搜索 */
.search-box { position: relative; }
.input-row { display: flex; gap: 8px; }
.input-row input { flex: 1; background: var(--bg2); color: var(--text); border: 1px solid var(--border);
  border-radius: 12px; padding: 12px 14px; font-size: 16px; outline: none; font-family: inherit; }
.input-row input:focus { border-color: var(--accent); }
.candidates { position: absolute; left: 0; right: 0; top: calc(100% + 6px); background: var(--card2);
  border: 1px solid var(--border); border-radius: 12px; max-height: 320px; overflow-y: auto; z-index: 50; display: none; box-shadow: 0 8px 30px rgba(0,0,0,.5); }
.candidates.show { display: block; }
.cand { padding: 10px 14px; display: flex; gap: 10px; align-items: center; cursor: pointer; border-bottom: 1px solid rgba(255,255,255,.05); }
.cand:hover, .cand.active { background: rgba(255,59,107,.16); }
.cand .body { flex: 1; min-width: 0; }
.cand .name { font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cand .meta { font-size: 12px; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cand .dur { color: var(--dim); font-size: 12px; }
.tag { font-size: 10px; padding: 2px 6px; border-radius: 4px; font-weight: 600; flex-shrink: 0; }
.tag.vip { background: var(--gold); color: #000; }
.tag.fee { background: var(--red); color: #fff; }
/* 宫格 */
.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.tile { background: var(--card2); border: 1px solid var(--border); border-radius: 12px;
  padding: 14px 8px; text-align: center; cursor: pointer; font-size: 13px; }
.tile:hover { border-color: var(--accent); }
.tile .icon { font-size: 22px; display: block; margin-bottom: 4px; }
/* 歌曲列表 */
.song-row { display: flex; align-items: center; gap: 10px; padding: 10px 4px; border-bottom: 1px solid rgba(255,255,255,.05); }
.song-row .body { flex: 1; min-width: 0; }
.song-row .name { font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.song-row .meta { font-size: 12px; color: var(--dim); }
.song-row button { flex-shrink: 0; }
/* 歌词 */
.lyrics { height: 300px; overflow-y: auto; margin: 12px 0; padding: 8px 0;
  mask-image: linear-gradient(transparent, #000 12%, #000 88%, transparent); }
.lyric-line { padding: 6px 12px; border-radius: 8px; color: var(--dim); font-size: 15px; transition: all .25s; }
.lyric-line.active { color: #fff; background: rgba(255,59,107,.18); font-weight: 600; transform: scale(1.03); }
/* 队列 */
.queue-item { display: flex; align-items: center; gap: 10px; padding: 10px 4px;
  border-bottom: 1px solid rgba(255,255,255,.05); }
.queue-item .body { flex: 1; min-width: 0; }
.queue-item .name { font-size: 14px; font-weight: 600; }
.queue-item .meta { font-size: 12px; color: var(--dim); }
.queue-item .ops { display: flex; gap: 6px; flex-shrink: 0; }
.op { background: var(--card2); border: 1px solid var(--border); color: var(--dim);
  border-radius: 8px; padding: 4px 8px; font-size: 12px; cursor: pointer; }
.op:hover { color: var(--text); border-color: var(--accent); }
/* 子页面头 */
.subhead { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.subhead .back, .subhead .sub-tab { background: var(--card2); border: 1px solid var(--border); border-radius: 8px;
  color: var(--text); padding: 5px 10px; cursor: pointer; font-size: 13px; }
.subhead h2 { margin: 0; font-size: 15px; }
/* toast / 提示 */
.toast { position: fixed; left: 50%; bottom: 84px; transform: translateX(-50%) translateY(16px);
  background: rgba(20,23,30,.95); border: 1px solid var(--border); color: var(--text);
  padding: 10px 18px; border-radius: 10px; font-size: 14px; opacity: 0; pointer-events: none;
  transition: all .25s; z-index: 99; max-width: 86vw; }
.toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
.hint { font-size: 12px; color: var(--dim); margin-top: 8px; }
.loading, .empty-tip { color: var(--dim); text-align: center; padding: 30px 0; font-size: 13px; }
.qr { text-align: center; margin-top: 12px; }
.qr img, .qr canvas { border-radius: 8px; }
.offline { color: var(--accent); }
@media (min-width: 900px) {
  .toast { bottom: 30px; }
}
```

- [ ] **Step 3: 写 ws-client.js**

`web/js/ws-client.js`:

```js
// WebSocket 连接管理：自动重连（1s 起步指数退避，上限 10s）
export function createWsClient(url, { onMessage, onStatus }) {
  let ws = null;
  let closed = false;
  let retry = 1000;

  function connect() {
    ws = new WebSocket(url);
    ws.onopen = () => { retry = 1000; onStatus('online'); };
    ws.onmessage = (e) => {
      try { onMessage(JSON.parse(e.data)); } catch { /* 忽略坏包 */ }
    };
    ws.onclose = () => {
      if (closed) return;
      onStatus('offline');
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 10000);
    };
    ws.onerror = () => ws.close();
  }

  return {
    connect,
    send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); },
    close() { closed = true; if (ws) ws.close(); },
  };
}
```

- [ ] **Step 4: 写 state.js 与 actions.js**

`web/js/state.js`:

```js
// 全局状态缓存 + 服务器时钟校准
export const store = {
  state: null,
  servertime: 0,
  offset: 0,
  listeners: [],

  apply(msg) {
    this.state = msg.state;
    this.servertime = msg.servertime;
    this.offset = msg.servertime - Date.now();
    for (const fn of this.listeners) fn();
  },
  subscribe(fn) { this.listeners.push(fn); },
  // 服务器当前时间（用于歌词/进度，消除客户端时钟误差）
  serverNow() { return Date.now() + this.offset; },
};
```

`web/js/actions.js`:

```js
// 用户操作 → WS 消息
export function bindActions(ws) {
  return {
    request(song) { ws.send({ type: 'play_request', song }); },
    skip() { ws.send({ type: 'skip' }); },
    togglePause() { ws.send({ type: store_paused() }); },
    setVolume(value) { ws.send({ type: 'volume_set', value }); },
    toggleMute() { ws.send({ type: 'mute_toggle' }); },
    top(id) { ws.send({ type: 'queue_top', id }); },
    remove(id) { ws.send({ type: 'queue_remove', id }); },
  };
}
function store_paused() {
  // 依据本地缓存的 paused 决定发 pause 还是 resume
  const paused = window.__jukeboxState && window.__jukeboxState.paused;
  return paused ? 'resume' : 'pause';
}
```

- [ ] **Step 5: 写 app.js（启动与渲染调度）**

`web/js/app.js`:

```js
import { createWsClient } from './ws-client.js';
import { store } from './state.js';
import { bindActions } from './actions.js';
import * as pointView from './views/point.js';
import * as playerView from './views/player.js';
import * as queueView from './views/queue.js';

const connEl = document.getElementById('conn');
const toastEl = document.getElementById('toast');
const tabsEl = document.getElementById('tabs');

let toastTimer = null;
function toast(msg, ms = 2000) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

const ws = createWsClient(`${location.origin.replace(/^http/, 'ws')}/ws`, {
  onMessage: (m) => {
    if (m.type === 'state') {
      store.apply(m);
      window.__jukeboxState = m.state; // actions.js 读取 paused 用
    } else if (m.type === 'toast') {
      toast(m.msg);
    }
  },
  onStatus: (s) => {
    connEl.textContent = s === 'online' ? '🟢 已连接' : '🔴 断线重连中…';
    connEl.className = 'sub' + (s === 'online' ? '' : ' offline');
  },
});

const actions = bindActions(ws);
const ctx = {
  get state() { return store.state; },
  actions,
  toast,
  serverNow: () => store.serverNow(),
  isDesktop: () => window.matchMedia('(min-width: 900px)').matches,
};

const views = {
  point: pointView,
  player: playerView,
  queue: queueView,
};

// 视图渲染是幂等的：各视图首次构建 DOM + 挂监听，之后原地更新。
// 启动时先渲染一次（state 尚为空，各视图自行显示占位），保证首屏有内容。
function renderAll() {
  for (const [name, view] of Object.entries(views)) {
    view.render(document.getElementById('view-' + name), ctx);
  }
}

store.subscribe(renderAll);
ws.connect();
renderAll();

// 移动端标签切换
tabsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.body.dataset.view = btn.dataset.view;
  tabsEl.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
});
document.body.dataset.view = 'point';
```

- [ ] **Step 6: 写三个视图空实现（防启动报错，后续任务填充）**

`web/js/views/point.js` / `player.js` / `queue.js`（各自内容，幂等：只构建一次，后续 Task 8-11 按此模式填充；需容忍 `ctx.state === null`）：

```js
export function render(el, ctx) {
  if (el.__jukeboxBuilt) return;
  el.__jukeboxBuilt = true;
  el.innerHTML = '<div class="loading">建设中…</div>';
}
```

- [ ] **Step 7: 浏览器手动验证壳**

Run: `cd /c/Users/Administrator/jukebox/server && node bin/server.js &` 然后浏览器开 `http://localhost:3000/`
Expected: 深色界面、顶部标题与"🟢 已连接"、移动宽度下底部三标签可切换、桌面宽度（>900px）三栏并排、三个面板显示"建设中…"。验证完 `kill %1`

- [ ] **Step 8: 提交**

Run: `cd /c/Users/Administrator/jukebox && git add -A && git commit -m "feat: web shell, theme and realtime skeleton"`

### Task 8: 点歌视图（搜索 + 分类 + 歌曲列表子页）

**Files:**
- Modify: `web/js/views/point.js`（整体替换）

**Interfaces:**
- Consumes: `ctx.actions.request(song)`、`ctx.toast`、REST `/api/search|artists|artist-songs|toplist|catlist|style-playlists|playlist-songs`
- Produces: `render(el, ctx)` 完整点歌视图（其余视图不依赖它）

- [ ] **Step 1: 写 lrc.js 与点歌视图（纯函数部分先写便于测试）**

`web/js/lrc.js`（Task 10 也要用，先行建立）:

```js
// LRC 歌词解析与当前行定位（纯函数）
export function parseLrc(text) {
  const lines = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!tags.length) continue;
    const content = raw.replace(/\[[^\]]*\]/g, '').trim();
    if (!content) continue;
    for (const m of tags) {
      lines.push({ t: (+m[1]) * 60 + (+m[2]) + (+(m[3] || 0)) / 1000, text: content });
    }
  }
  lines.sort((a, b) => a.t - b.t);
  return lines;
}

export function activeIndex(lines, t) {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].t <= t) idx = i; else break;
  }
  return idx;
}
```

- [ ] **Step 2: 写点歌视图完整实现**

`web/js/views/point.js`（整体替换）:

```js
// 点歌视图：搜索 + 分类宫格 + 子页面（歌手/榜单/风格/拼音/歌单/歌曲列表）
// render 幂等：首次构建 DOM 并挂一次性委托监听；后续调用直接返回（浏览中的子页不被状态刷新打断）。

let langMap = null; // 语种榜过滤结果（模块级，供 tab 切换）

export function render(el, ctx) {
  if (el.__jukeboxPoint) return;
  el.__jukeboxPoint = true;
  el.innerHTML = `
    <div class="card">
      <h2>点首歌</h2>
      <div class="search-box">
        <div class="input-row">
          <input id="q" type="text" placeholder="歌名或歌手：周杰伦、晴天、海阔天空 Beyond…" autocomplete="off" />
        </div>
        <div class="candidates" id="candidates"></div>
      </div>
      <div class="hint">输入自动搜索；点候选即可点歌。已点列表里可置顶/删除。</div>
    </div>
    <div class="card">
      <h2>分类点歌</h2>
      <div class="grid" id="tiles">${tilesHtml()}</div>
    </div>
    <div class="card" id="subpage" style="display:none"></div>`;
  bind(el, ctx);
}

// ===== 工具函数（模块级） =====
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function feeTag(fee) {
  if (fee === 1) return '<span class="tag vip">VIP</span>';
  if (fee === 4) return '<span class="tag fee">付费</span>';
  return '';
}
function fmtDur(ms) {
  if (!ms) return '';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
const TILES = [
  { icon: '🎤', name: '歌手', page: 'artistCats' },
  { icon: '🌍', name: '语种', page: 'toplist', arg: { lang: true } },
  { icon: '🎨', name: '风格', page: 'styles' },
  { icon: '🔤', name: '拼音A-Z', page: 'letters' },
  { icon: '🔥', name: '热门榜', page: 'toplist', arg: { id: '3778678' } },
  { icon: '✨', name: '新歌榜', page: 'toplist', arg: { id: '3779629' } },
];
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
// 语种榜关键词过滤（网易云榜单名包含这些词）
const LANG_KEYS = [['华语', '华语'], ['欧美', '欧美'], ['日韩', '日本', '日语', '韩语', '韩国'], ['粤语', '粤语']];

function tilesHtml() {
  return TILES.map((t) => `
    <div class="tile" data-page="${t.page}" data-arg='${t.arg ? esc(JSON.stringify(t.arg)) : ''}'>
      <span class="icon">${t.icon}</span>${t.name}
    </div>`).join('');
}
function SONG_ROW(s) {
  return `
    <div class="song-row">
      <div class="body">
        <div class="name">${esc(s.title || s.text || '')}</div>
        <div class="meta">${esc(s.artist || '')}${s.album ? ' · ' + esc(s.album) : ''}</div>
      </div>
      <span class="dur">${fmtDur(s.duration_ms)}</span>
      ${feeTag(s.fee)}
      <button class="btn primary" data-song='${esc(JSON.stringify(s))}'>点歌</button>
    </div>`;
}

// ===== 事件与页面逻辑 =====
function bind(el, ctx) {
  const { actions } = ctx;
  const $ = (s) => el.querySelector(s);

  function request(song) {
    actions.request({ text: `${song.title || ''} ${song.artist || ''}`.trim(), ...song });
    ctx.toast('已点 🎵');
    $('#q').value = '';
    $('#candidates').classList.remove('show');
  }
  function hideSub() { $('#subpage').style.display = 'none'; $('#subpage').innerHTML = ''; }
  function subhead(title) {
    return `<div class="subhead"><button class="back">← 返回</button><h2>${esc(title)}</h2></div>`;
  }
  function tabRowHtml(tabs, activeKey) {
    return `<div class="subhead" style="margin-bottom:8px">${tabs.map(([key, label]) =>
      `<button class="sub-tab" data-tabkey="${esc(key)}" style="${key === activeKey ? 'color:var(--accent);font-weight:600' : ''}">${esc(label)}</button>`).join('')}</div>`;
  }
  function renderListRows(lists) {
    return lists.map((t) => `
      <div class="song-row"><div class="body"><div class="name">${esc(t.name)}</div></div>
      <button class="btn" data-toplist="${esc(t.id)}">进去</button></div>`).join('');
  }
  function renderLangLists(key) {
    const keys = [...langMap.keys()];
    const active = key || keys[0];
    $('#subpage').innerHTML = subhead('语种榜') +
      tabRowHtml(keys.map((k) => [k, k]), active) +
      renderListRows(langMap.get(active) || []);
  }

  // ===== 搜索（防抖 280ms；input 事件冒泡，委托在 el 上） =====
  let debounce = null;
  let seq = 0;
  el.addEventListener('input', (e) => {
    if (e.target.id !== 'q') return;
    clearTimeout(debounce);
    const q = e.target.value.trim();
    if (!q) { $('#candidates').classList.remove('show'); return; }
    debounce = setTimeout(() => search(q), 280);
  });
  async function search(q) {
    const mySeq = ++seq;
    try {
      const data = await getJSON('/api/search', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q }),
      });
      if (mySeq !== seq) return;
      renderCandidates(data.results || []);
    } catch {
      if (mySeq === seq) {
        $('#candidates').innerHTML = '<div class="empty-tip">暂时不可用，请稍后重试</div>';
        $('#candidates').classList.add('show');
      }
    }
  }
  function renderCandidates(results) {
    $('#candidates').innerHTML = results.length
      ? results.map((s) => `
        <div class="cand" data-song='${esc(JSON.stringify(s))}'>
          <div class="body"><div class="name">${esc(s.title)}</div>
            <div class="meta">${esc(s.artist)}${s.album ? ' · ' + esc(s.album) : ''}</div></div>
          <span class="dur">${fmtDur(s.duration_ms)}</span>${feeTag(s.fee)}
        </div>`).join('')
      : '<div class="empty-tip">没找到，换个词试试？</div>';
    $('#candidates').classList.add('show');
  }

  // ===== 子页面 =====
  async function artistList(type) {
    $('#subpage').style.display = 'block';
    $('#subpage').innerHTML = '<div class="loading">加载中…</div>';
    try {
      const data = await getJSON(`/api/artists?type=${type}`);
      const list = data.artists || [];
      $('#subpage').innerHTML = subhead('歌手') +
        tabRowHtml([['male', '男歌手'], ['female', '女歌手'], ['band', '组合']], type) +
        list.map((a) => `
        <div class="song-row"><div class="body"><div class="name">${esc(a.name)}</div></div>
        <button class="btn" data-artist="${esc(a.id)}">进去</button></div>`).join('');
    } catch (err) {
      $('#subpage').innerHTML = `<div class="empty-tip">加载失败：${esc(String(err.message || err))}</div>`;
    }
  }
  async function songPage(title, fetchSongs) {
    $('#subpage').style.display = 'block';
    $('#subpage').innerHTML = '<div class="loading">加载中…</div>';
    try {
      const data = await fetchSongs();
      const songs = data.songs || [];
      $('#subpage').innerHTML = subhead(title) + (songs.length
        ? songs.map((s) => SONG_ROW(s)).join('')
        : '<div class="empty-tip">没有找到歌曲</div>');
    } catch (err) {
      $('#subpage').innerHTML = `<div class="empty-tip">加载失败：${esc(String(err.message || err))}</div>`;
    }
  }
  async function stylePage(cat) {
    $('#subpage').innerHTML = '<div class="loading">加载中…</div>';
    try {
      const data = await getJSON(`/api/style-playlists?cat=${encodeURIComponent(cat)}`);
      $('#subpage').innerHTML = subhead(cat) + (data.playlists || []).map((p) => `
        <div class="song-row"><div class="body"><div class="name">${esc(p.name)}</div></div>
        <button class="btn" data-playlist="${esc(p.id)}">进去</button></div>`).join('');
    } catch (err) {
      $('#subpage').innerHTML = `<div class="empty-tip">加载失败：${esc(String(err.message || err))}</div>`;
    }
  }
  async function letterList(letter) {
    $('#subpage').innerHTML = '<div class="loading">加载中…</div>';
    try {
      const data = await getJSON(`/api/artists?type=male&initial=${letter}`);
      const list = data.artists || [];
      $('#subpage').innerHTML = subhead(`拼音 ${letter}`) + list.map((a) => `
        <div class="song-row"><div class="body"><div class="name">${esc(a.name)}</div></div>
        <button class="btn" data-artist="${esc(a.id)}">进去</button></div>`).join('');
    } catch (err) {
      $('#subpage').innerHTML = `<div class="empty-tip">加载失败：${esc(String(err.message || err))}</div>`;
    }
  }
  async function openPage(page, arg = {}) {
    $('#subpage').style.display = 'block';
    $('#subpage').innerHTML = '<div class="loading">加载中…</div>';
    try {
      if (page === 'artistCats') { await artistList('male'); return; }
      if (page === 'toplist') {
        if (arg.id) { await songPage('榜单歌曲', () => getJSON(`/api/toplist?id=${arg.id}`)); return; }
        const data = await getJSON('/api/toplist');
        const lists = data.lists || [];
        if (arg.lang) {
          langMap = new Map();
          for (const [label, ...keys] of LANG_KEYS) {
            const found = lists.filter((l) => keys.some((k) => l.name.includes(k)));
            if (found.length) langMap.set(label, found);
          }
          if (langMap.size) renderLangLists();
          else $('#subpage').innerHTML = subhead('语种榜') + '<div class="empty-tip">暂无语种榜数据</div>';
        } else {
          $('#subpage').innerHTML = subhead('榜单') + renderListRows(lists);
        }
        return;
      }
      if (page === 'styles') {
        const data = await getJSON('/api/catlist');
        $('#subpage').innerHTML = subhead('风格') + `<div class="grid">${(data.cats || []).map((c) =>
          `<div class="tile" data-style="${esc(c)}">${esc(c)}</div>`).join('')}</div>`;
        return;
      }
      if (page === 'letters') {
        $('#subpage').innerHTML = subhead('拼音索引') + `<div class="grid">${LETTERS.map((l) =>
          `<div class="tile" data-letter="${l}">${l}</div>`).join('')}</div>`;
        return;
      }
    } catch (err) {
      $('#subpage').innerHTML = `<div class="empty-tip">加载失败：${esc(String(err.message || err))}</div>`;
    }
  }

  // ===== 一次性委托（唯一监听挂载点） =====
  el.addEventListener('click', (e) => {
    const songEl = e.target.closest('[data-song]');
    if (songEl) { request(JSON.parse(songEl.dataset.song)); return; }
    const tile = e.target.closest('.tile[data-page]');
    if (tile) { openPage(tile.dataset.page, tile.dataset.arg ? JSON.parse(tile.dataset.arg) : {}); return; }
    if (e.target.closest('#subpage .back')) { hideSub(); return; }
    const tab = e.target.closest('[data-tabkey]');
    if (tab) {
      if (langMap && langMap.has(tab.dataset.tabkey)) { renderLangLists(tab.dataset.tabkey); return; }
      artistList(tab.dataset.tabkey);
      return;
    }
    const tl = e.target.closest('[data-toplist]');
    if (tl) { songPage('榜单歌曲', () => getJSON(`/api/toplist?id=${tl.dataset.toplist}`)); return; }
    const st = e.target.closest('[data-style]');
    if (st) { stylePage(st.dataset.style); return; }
    const pl = e.target.closest('[data-playlist]');
    if (pl) { songPage('歌单', () => getJSON(`/api/playlist-songs?id=${pl.dataset.playlist}`)); return; }
    const lt = e.target.closest('[data-letter]');
    if (lt) { letterList(lt.dataset.letter); return; }
    const ar = e.target.closest('[data-artist]');
    if (ar) { songPage('歌手歌曲', () => getJSON(`/api/artist-songs?id=${ar.dataset.artist}`)); return; }
  });
}
```

- [ ] **Step 3: 浏览器手动验证点歌视图**

Run: `cd /c/Users/Administrator/jukebox/server && node bin/server.js &`，浏览器开 `http://localhost:3000/`，用另一终端模拟播放端后逐项检查：
- 搜索"周杰伦"→ 候选出现（含时长与 VIP 标签）→ 点候选 → toast"已点 🎵"→ 播放视图 current 变化
- 宫格六格：歌手（男女组合 tab）、语种（榜单过滤）、风格（曲风→歌单→歌曲）、拼音A-Z（歌手列表）、热门榜、新歌榜，每层可点进歌曲并点歌
- 返回按钮工作正常
Expected: 以上全部可用。验证完 `kill %1`

- [ ] **Step 4: 提交**

Run: `cd /c/Users/Administrator/jukebox && git add -A && git commit -m "feat: song request view with search and categories"`

### Task 9: 播放视图（当前歌曲 + 控制条含音量 + 进度 + 下一首）

**Files:**
- Modify: `web/js/views/player.js`（整体替换）

**Interfaces:**
- Consumes: `ctx.state / ctx.actions / ctx.serverNow()`；协议 state 结构
- Produces: `render(el, ctx)` 幂等（首次构建+绑监听，之后原地更新，不打断音量拖动）

- [ ] **Step 1: 写播放视图实现**

`web/js/views/player.js`（整体替换）:

```js
// 播放视图：当前歌曲、进度条、控制条（暂停/切歌/音量/静音）、下一首预告。
// 歌词（Task 10）与二维码（Task 12）在本文件扩展。
// render 幂等：首次构建 DOM + 挂监听，之后仅原地更新字段。

export function render(el, ctx) {
  if (el.__jukeboxPlayer) { update(el, ctx); return; }
  el.__jukeboxPlayer = true;
  el.innerHTML = `
    <div class="now empty" id="now">
      <div class="label">NOW PLAYING</div>
      <div class="song" id="nowTitle">还没有歌，去点一首吧</div>
      <div class="meta" id="nowMeta"></div>
      <div class="progress"><i id="progressBar" style="width:0%"></i></div>
      <div class="meta" id="nextUp"></div>
    </div>
    <div class="card">
      <h2>控制 <span id="playerStatus" style="font-size:11px;color:var(--dim);text-transform:none"></span></h2>
      <div class="controls">
        <button class="btn primary" id="pauseBtn" disabled>⏸ 暂停</button>
        <button class="btn" id="skipBtn" disabled>⏭ 切歌</button>
        <button class="btn" id="muteBtn">🔊</button>
        <div class="vol-row">
          <span style="font-size:13px;color:var(--dim)">音量</span>
          <input type="range" id="volSlider" min="0" max="100" step="1" value="60" />
          <span id="volVal" style="font-size:12px;color:var(--dim);width:32px;text-align:right">60</span>
        </div>
      </div>
      <div class="hint">所有人共享控制权：暂停/切歌/音量对全体实时生效</div>
    </div>
    <div class="card">
      <h2>歌词</h2>
      <div class="lyrics" id="lyrics"><div class="empty-tip">暂无歌词</div></div>
    </div>
    <div class="card qr">
      <h2>扫码点歌</h2>
      <div id="qrcode"></div>
    </div>`;
  bind(el, ctx);
  update(el, ctx);
  tick(el, ctx);
}

function bind(el, ctx) {
  el.querySelector('#pauseBtn').addEventListener('click', () => ctx.actions.togglePause());
  el.querySelector('#skipBtn').addEventListener('click', () => {
    if (ctx.state && ctx.state.current) ctx.actions.skip();
  });
  el.querySelector('#muteBtn').addEventListener('click', () => ctx.actions.toggleMute());
  const slider = el.querySelector('#volSlider');
  slider.addEventListener('input', () => {
    el.querySelector('#volVal').textContent = slider.value;
    ctx.actions.setVolume(Number(slider.value));
  });
  setInterval(() => tick(el, ctx), 250);
}

function update(el, ctx) {
  const st = ctx.state;
  if (!st) return;
  const cur = st.current;
  const nowEl = el.querySelector('#now');
  const title = el.querySelector('#nowTitle');
  const meta = el.querySelector('#nowMeta');
  const nextUp = el.querySelector('#nextUp');
  const skipBtn = el.querySelector('#skipBtn');
  const pauseBtn = el.querySelector('#pauseBtn');
  const status = el.querySelector('#playerStatus');

  if (cur && (cur.song.title || cur.song.text)) {
    nowEl.classList.remove('empty');
    title.textContent = (cur.song.title || cur.song.text) + (cur.song.artist ? ' · ' + cur.song.artist : '');
    const parts = [];
    if (cur.song.duration_ms) parts.push(fmtDur(cur.song.duration_ms));
    if (cur.started_at) parts.push('开始于 ' + fmtAgo(cur.started_at, ctx));
    meta.textContent = parts.join('  ·  ');
    skipBtn.disabled = false;
    pauseBtn.disabled = false;
  } else {
    nowEl.classList.add('empty');
    title.textContent = '还没有歌，去点一首吧';
    meta.textContent = '';
    skipBtn.disabled = true;
    pauseBtn.disabled = true;
  }
  pauseBtn.textContent = st.paused ? '▶ 继续' : '⏸ 暂停';
  el.querySelector('#muteBtn').textContent = st.muted ? '🔇' : '🔊';
  const slider = el.querySelector('#volSlider');
  if (document.activeElement !== slider) slider.value = st.volume; // 拖动中不抢值
  el.querySelector('#volVal').textContent = st.volume;
  const next = st.queue[0];
  nextUp.textContent = next
    ? `下一首：${next.song.title || next.song.text}${next.song.artist ? ' · ' + next.song.artist : ''}`
    : (cur ? '队列已空' : '');
  status.textContent = st.playerOnline ? '' : '⚠ 播放端离线，点歌会排队';
  status.style.color = st.playerOnline ? 'var(--dim)' : 'var(--gold)';
}

function tick(el, ctx) {
  const st = ctx.state;
  if (!st || !st.current) return;
  const cur = st.current;
  const bar = el.querySelector('#progressBar');
  if (cur.song.duration_ms && cur.started_at && !st.paused) {
    const pct = Math.max(0, Math.min(100, ((ctx.serverNow() - cur.started_at) / cur.song.duration_ms) * 100));
    bar.style.width = pct.toFixed(1) + '%';
  }
}

function fmtDur(ms) {
  if (!ms) return '';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function fmtAgo(unixMs, ctx) {
  const diff = Math.floor(ctx.serverNow() / 1000) - Math.floor(unixMs / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  return `${Math.floor(diff / 3600)} 小时前`;
}
```

- [ ] **Step 2: 浏览器手动验证**

Run: `cd /c/Users/Administrator/jukebox/server && node bin/server.js &` + 另开终端模拟播放端（node 一行脚本同 Task 6 Step 5），浏览器开 `http://localhost:3000/`
Expected:
- 无歌时 now 卡显示"还没有歌"，暂停/切歌按钮禁用
- 点歌后（点歌视图操作）：now 卡渐变红显示歌名+歌手+时长，进度条 250ms 步进增长
- 播放端在线时控制卡无提示；停掉播放端进程 → 状态显示"⚠ 播放端离线"且 now 清空
- 暂停 → 按钮变"▶ 继续"，进度条冻结；恢复后继续
- 音量滑条拖动 → 数值实时变，另一浏览器窗口同步变化；静音按钮切换 🔊/🔇
- 下一首预告显示队首歌曲
Expected: 全部通过。验证完 `kill %1`

- [ ] **Step 3: 提交**

Run: `cd /c/Users/Administrator/jukebox && git add -A && git commit -m "feat: player view with shared controls"`

### Task 10: 歌词（LRC 解析 + 高亮滚动）

**Files:**
- Modify: `web/js/views/player.js`（在 Task 9 基础上扩展）
- Create: `web/test/lrc.test.html`（浏览器控制台跑的手测页，见 Step 2）

**Interfaces:**
- Consumes: Task 8 已建的 `web/js/lrc.js` 的 `parseLrc(text)` / `activeIndex(lines, t)`；`GET /api/lyric?id`
- Produces: 播放视图内歌词滚动高亮（无新导出）

- [ ] **Step 1: 扩展 player.js（歌词加载与高亮）**

在 `web/js/views/player.js` 顶部加 import 与模块级状态，并修改 `tick()`：

```js
import { parseLrc, activeIndex } from '../lrc.js';

// 歌词状态（模块级）
let lyricLines = [];
let lyricSongId = null;
let lastActive = -1;
```

把文件里 `function tick(el, ctx)` 整体替换为：

```js
function tick(el, ctx) {
  const st = ctx.state;
  if (!st || !st.current) { loadLyrics(el, ctx); return; }
  const cur = st.current;
  // 进度
  const bar = el.querySelector('#progressBar');
  if (cur.song.duration_ms && cur.started_at && !st.paused) {
    const pct = Math.max(0, Math.min(100, ((ctx.serverNow() - cur.started_at) / cur.song.duration_ms) * 100));
    bar.style.width = pct.toFixed(1) + '%';
  }
  if (st.paused) return;
  // 歌词
  if (lyricSongId !== cur.song.song_id) { loadLyrics(el, ctx); return; }
  if (!lyricLines.length) return;
  const t = (ctx.serverNow() - cur.started_at) / 1000;
  const idx = activeIndex(lyricLines, t);
  if (idx !== lastActive) {
    const prev = el.querySelector(`.lyric-line[data-i="${lastActive}"]`);
    if (prev) prev.classList.remove('active');
    const lineEl = el.querySelector(`.lyric-line[data-i="${idx}"]`);
    if (lineEl) {
      lineEl.classList.add('active');
      if (idx > lastActive) lineEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    lastActive = idx;
  }
}

async function loadLyrics(el, ctx) {
  const cur = ctx.state && ctx.state.current;
  const box = el.querySelector('#lyrics');
  if (!cur || !cur.song.song_id) {
    lyricLines = []; lyricSongId = null; lastActive = -1;
    box.innerHTML = '<div class="empty-tip">暂无歌词</div>';
    return;
  }
  if (lyricSongId === cur.song.song_id) return;
  lyricSongId = cur.song.song_id;
  lyricLines = []; lastActive = -1;
  box.innerHTML = '<div class="empty-tip">歌词加载中…</div>';
  try {
    const r = await fetch(`/api/lyric?id=${encodeURIComponent(cur.song.song_id)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    lyricLines = parseLrc(data.lrc);
    if (!lyricLines.length) { box.innerHTML = '<div class="empty-tip">纯音乐</div>'; return; }
    box.innerHTML = lyricLines.map((l, i) => `<div class="lyric-line" data-i="${i}">${esc(l.text)}</div>`).join('');
  } catch {
    box.innerHTML = '<div class="empty-tip">歌词获取失败</div>';
    lyricLines = [];
  }
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
```

- [ ] **Step 2: lrc.js 单测（手测页，浏览器控制台断言）**

`web/test/lrc.test.html`:

```html
<!doctype html>
<meta charset="utf-8">
<script type="module">
import { parseLrc, activeIndex } from '../js/lrc.js';
const cases = [];
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  cases.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${ok ? '' : JSON.stringify(got)}`);
};
// 基本解析 + 排序 + 多时间标签
let l = parseLrc('[00:10.00]第二句\n[00:05.50]第一句\n[00:15.00][00:20.00]重复句\n[00:10.00]');
eq('parse 基本', l.map((x) => x.t), [5.5, 10, 15, 20]);
eq('parse 文本', l[1].text, '第二句');
eq('空歌词', parseLrc(''), []);
eq('无时间标签行跳过', parseLrc('普通文本\n[99:99.99]末句'), [{ t: 6039.99, text: '末句' }]);
eq('active -1', activeIndex(l, 3), -1);
eq('active 中间', activeIndex(l, 11), 1);
eq('active 边界', activeIndex(l, 15), 2);
eq('active 末尾', activeIndex(l, 999), 3);
document.body.innerHTML = '<pre>' + cases.join('\n') + '</pre>';
</script>
```

Run: 浏览器开 `http://localhost:3000/test/lrc.test.html`（服务器静态托管整个 web/）
Expected: 控制台页面全部 PASS

- [ ] **Step 3: 浏览器手动验证歌词滚动**

Run: 起本地服务器 + 模拟播放端，点一首热门歌（如"晴天"周杰伦）
Expected: 歌词加载后逐行高亮并自动滚动居中；点纯音乐类歌曲（如某些伴奏）显示"纯音乐"；暂停时歌词停止前进
Expected: 通过。验证完 `kill %1`

- [ ] **Step 4: 提交**

Run: `cd /c/Users/Administrator/jukebox && git add -A && git commit -m "feat: scrolling lyrics"`

### Task 11: 已点视图（队列 + 置顶/删除）

**Files:**
- Modify: `web/js/views/queue.js`（整体替换）

**Interfaces:**
- Consumes: `ctx.state.queue / ctx.state.current / ctx.actions.top(id) / ctx.actions.remove(id)`
- Produces: `render(el, ctx)` 幂等

- [ ] **Step 1: 写已点视图**

`web/js/views/queue.js`（整体替换）:

```js
// 已点视图：在播 + 队列列表，支持置顶/删除。render 幂等：构建一次，之后仅重建列表。
export function render(el, ctx) {
  if (el.__jukeboxQueue) { update(el, ctx); return; }
  el.__jukeboxQueue = true;
  el.innerHTML = `<div class="card"><h2>已点歌单</h2><div id="queueList"><div class="loading">加载中…</div></div></div>`;
  el.addEventListener('click', (e) => {
    const top = e.target.closest('[data-top]');
    if (top) { ctx.actions.top(top.dataset.top); ctx.toast('已置顶到下一首'); }
    const rm = e.target.closest('[data-remove]');
    if (rm) ctx.actions.remove(rm.dataset.remove);
  });
  update(el, ctx);
}

function update(el, ctx) {
  const st = ctx.state;
  if (!st) return;
  const listEl = el.querySelector('#queueList');
  const rows = [];
  if (st.current) {
    const c = st.current.song;
    rows.push(`
      <div class="queue-item">
        <span class="tag" style="background:var(--green);color:#000;font-size:10px;padding:2px 6px;border-radius:4px">在播</span>
        <div class="body"><div class="name">${esc(c.title || c.text)}</div>
        <div class="meta">${esc(c.artist || '')}</div></div>
      </div>`);
  }
  for (const q of st.queue || []) {
    const s = q.song;
    rows.push(`
      <div class="queue-item">
        <div class="body"><div class="name">${esc(s.title || s.text)}</div>
        <div class="meta">${esc(s.artist || '')}${s.album ? ' · ' + esc(s.album) : ''}</div></div>
        <div class="ops">
          <button class="op" data-top="${esc(q.id)}">⏫ 置顶</button>
          <button class="op" data-remove="${esc(q.id)}">🗑</button>
        </div>
      </div>`);
  }
  listEl.innerHTML = rows.join('') || '<div class="empty-tip">还没有点过歌，去点歌页来一首吧</div>';
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
```

- [ ] **Step 2: 浏览器手动验证**

Run: 起本地服务器 + 模拟播放端，点 3 首歌
Expected: 在播行绿色标签；置顶把目标移到队首（下一首预告同步变）；删除移除且无报错；队列空显示空提示；多人页面同步一致
Expected: 通过。验证完 `kill %1`

- [ ] **Step 3: 提交**

Run: `cd /c/Users/Administrator/jukebox && git add -A && git commit -m "feat: queue view with top and remove"`

### Task 12: 二维码 + 收尾打磨

**Files:**
- Create: `web/vendor/qrcode.min.js`（第三方库，下载不手写）
- Modify: `web/css/app.css`（二维码区移动端隐藏）、`web/js/views/player.js`（渲染二维码）

**Interfaces:**
- Consumes: 全局 `QRCode`（qrcodejs，index.html 已引入 script 标签）
- Produces: 播放视图二维码（扫码直达点歌页）

- [ ] **Step 1: 下载 qrcodejs 到 vendor**

Run: `mkdir -p /c/Users/Administrator/jukebox/web/vendor && curl -L --max-time 60 -o /c/Users/Administrator/jukebox/web/vendor/qrcode.min.js https://cdn.jsdelivr.net/gh/davidshimjs/qrcodejs@master/qrcode.min.js && head -c 200 /c/Users/Administrator/jukebox/web/vendor/qrcode.min.js`
Expected: 文件为 JS 源码（开头不是 HTML 错误页）；`wc -c` 约 20KB

- [ ] **Step 2: 播放视图渲染二维码**

`web/js/views/player.js` 的 `bind()` 末尾追加：

```js
  // 二维码（qrcodejs 全局对象；vendor 缺失时静默跳过）
  if (typeof window.QRCode !== 'undefined') {
    new window.QRCode(el.querySelector('#qrcode'), {
      text: location.origin + location.pathname,
      width: 128, height: 128,
      correctLevel: window.QRCode.CorrectLevel.M,
    });
  }
```

`web/css/app.css` 的 `.qr { text-align: center; margin-top: 12px; }` 后追加：

```css
@media (max-width: 899px) { .qr { display: none; } }
```

- [ ] **Step 3: 全站浏览器回归走查（清单式）**

Run: 起本地服务器 + 模拟播放端，浏览器开桌面宽度与手机宽度（DevTools 响应式）各过一遍：
- [ ] 手机宽度：底部三标签切换正常；点歌→播放→已点全流程可用
- [ ] 桌面宽度：三栏同屏；二维码可见且手机扫码（用手机同 WiFi 访问局域网 IP）能打开点歌页
- [ ] 断网重连：关掉服务器再开 → 页面自动重连并恢复状态（顶部状态文字变化）
- [ ] 无歌/无播放端/搜索无结果/搜索接口 500（可临时停网易云网络模拟）各异常态文案正常
- [ ] 多标签页：两个浏览器窗口并排，一切操作双向同步
Expected: 全部通过。验证完 `kill %1`

- [ ] **Step 4: 提交**

Run: `cd /c/Users/Administrator/jukebox && git add -A && git commit -m "feat: qr code and polish"`

## Phase 3 — 播放客户端（Python）

### Task 13: 播放客户端脚手架 + 虚拟播放器

**Files:**
- Create: `player/requirements.txt`, `player/config.py`, `player/playback.py`, `player/player.py`, `player/client.py`（本任务先占位）、`player/test_player.py`, `player/player_config.example.json`

**Interfaces:**
- Consumes: 协议见文件头（播放端消息）
- Produces:
  - `config.load(path) → cfg`（dict：server/token/libmpv/virtual/virtual_duration）
  - `playback.BasePlayer` 抽象接口：`play(url, volume, muted) / pause() / resume() / stop() / set_volume(v) / set_mute(m) / wait_event(timeout) → 'finished'|'error'|None / audio_device() / close()`，除 audio_device 外全部 async
  - `playback.VirtualPlayer(duration)`：不出声，按时长假装播完
  - `player.py`：入口，`--virtual` 参数与 VIRTUAL=1 环境变量等效
  - `client.run(cfg)`：Task 15 实现（本任务抛 NotImplementedError 占位）

- [ ] **Step 1: 写 requirements 与配置**

`player/requirements.txt`:

```
websockets>=12.0
python-mpv>=1.0.5
```

`player/config.py`:

```python
import json
import os

DEFAULTS = {
    'server': 'https://你的应用.app.workbuddy.link',
    'token': '换成云端设备口令',
    'libmpv': '',      # libmpv 路径，留空自动查找
    'virtual': False,
}

def load(path='player_config.json'):
    cfg = dict(DEFAULTS)
    if os.path.exists(path):
        try:
            with open(path, encoding='utf-8') as f:
                cfg.update(json.load(f))
        except Exception:
            pass
    if os.environ.get('VIRTUAL') == '1':
        cfg['virtual'] = True
    if os.environ.get('VIRTUAL_DURATION'):
        cfg['virtual_duration'] = float(os.environ['VIRTUAL_DURATION'])
    return cfg
```

`player/player_config.example.json`:

```json
{
  "server": "https://你的应用.app.workbuddy.link",
  "token": "换成云端设备口令",
  "libmpv": "",
  "virtual": false
}
```

- [ ] **Step 2: 写 playback.py（抽象 + 虚拟实现）**

`player/playback.py`:

```python
"""播放控制抽象：VirtualPlayer（无 libmpv，联调用）与 MpvPlayer（Task 14 实现）。

注意：本文件不叫 mpv.py —— 那样会与第三方 python-mpv 包同名，
MpvPlayer 内部的 `import mpv` 会导入到本模块自己。
"""
import asyncio
import logging
import time

log = logging.getLogger('player.playback')


class BasePlayer:
    async def play(self, url, volume, muted):
        raise NotImplementedError

    async def pause(self):
        raise NotImplementedError

    async def resume(self):
        raise NotImplementedError

    async def stop(self):
        raise NotImplementedError

    async def set_volume(self, v):
        raise NotImplementedError

    async def set_mute(self, m):
        raise NotImplementedError

    async def wait_event(self, timeout=0.5):
        """返回 'finished' | 'error' | None（超时）。"""
        raise NotImplementedError

    def audio_device(self):
        """当前音频设备名（蓝牙掉线检测用；不支持/虚拟实现返回 None）。"""
        return None

    async def close(self):
        pass


class VirtualPlayer(BasePlayer):
    """虚拟播放器：不出声，按设定时长假装播完，便于本地联调队列流转。"""

    def __init__(self, duration=10.0):
        self.duration = duration
        self.volume = 60
        self.muted = False
        self._end_at = None

    async def play(self, url, volume, muted):
        log.info('[virtual] play %s volume=%s muted=%s', url, volume, muted)
        self.volume = int(volume)
        self.muted = bool(muted)
        self._end_at = time.time() + self.duration

    async def pause(self):
        log.info('[virtual] pause')

    async def resume(self):
        log.info('[virtual] resume')

    async def stop(self):
        log.info('[virtual] stop')
        self._end_at = None

    async def set_volume(self, v):
        log.info('[virtual] volume=%s', v)
        self.volume = int(v)

    async def set_mute(self, m):
        log.info('[virtual] mute=%s', m)
        self.muted = bool(m)

    async def wait_event(self, timeout=0.5):
        await asyncio.sleep(timeout)
        if self._end_at is not None and time.time() >= self._end_at:
            self._end_at = None
            return 'finished'
        return None
```

- [ ] **Step 3: 写 player.py 入口与 client.py 占位**

`player/player.py`:

```python
"""播放客户端入口：python player.py [--config player_config.json] [--virtual]"""
import argparse
import asyncio
import glob
import logging
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from config import load          # noqa: E402
from client import run           # noqa: E402

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(name)s %(message)s')
log = logging.getLogger('player')


def main():
    parser = argparse.ArgumentParser(description='KTV 点歌台播放客户端')
    parser.add_argument('--config', default='player_config.json')
    parser.add_argument('--virtual', action='store_true', help='虚拟模式：不出声只打日志')
    args = parser.parse_args()

    cfg = load(args.config)
    if args.virtual:
        cfg['virtual'] = True
    if not cfg.get('token') or '换成' in str(cfg['token']):
        log.error('player_config.json 里还没填 token（云端设备口令）')
        sys.exit(1)
    if not str(cfg['server']).startswith(('ws://', 'wss://')):
        cfg['server'] = str(cfg['server']).replace('http://', 'ws://').replace('https://', 'wss://')
        if not str(cfg['server']).endswith('/ws'):
            cfg['server'] += '/ws'
    # Windows 下自动找 libmpv dll
    if sys.platform == 'win32' and not cfg.get('libmpv'):
        hits = glob.glob(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'libmpv', '**', 'mpv-2.dll'), recursive=True)
        if hits:
            cfg['libmpv'] = hits[0]
    log.info('server=%s virtual=%s libmpv=%s', cfg['server'], cfg['virtual'], cfg.get('libmpv') or 'auto')
    asyncio.run(run(cfg))


if __name__ == '__main__':
    main()
```

`player/client.py`（占位，Task 15 整体替换）:

```python
"""WebSocket 客户端：连接云端、上报事件、执行播放指令（完整实现见 Task 15）。"""
import logging

log = logging.getLogger('player.client')


async def run(cfg):
    raise NotImplementedError('Task 15 实现')
```

- [ ] **Step 4: 写单测**

`player/test_player.py`:

```python
import asyncio
import unittest

from config import load
from playback import VirtualPlayer


class TestVirtualPlayer(unittest.IsolatedAsyncioTestCase):
    async def test_finished_after_duration(self):
        p = VirtualPlayer(duration=0.1)
        await p.play('http://x.mp3', 60, False)
        self.assertIsNone(await p.wait_event(timeout=0.05))
        await asyncio.sleep(0.1)
        self.assertEqual(await p.wait_event(timeout=0.05), 'finished')

    async def test_stop_cancels_finish(self):
        p = VirtualPlayer(duration=0.1)
        await p.play('http://x.mp3', 60, False)
        await p.stop()
        await asyncio.sleep(0.2)
        self.assertIsNone(await p.wait_event(timeout=0.05))

    async def test_volume_mute(self):
        p = VirtualPlayer(duration=5)
        await p.play('http://x.mp3', 60, False)
        await p.set_volume(20)
        await p.set_mute(True)
        self.assertEqual(p.volume, 20)
        self.assertTrue(p.muted)


class TestConfig(unittest.TestCase):
    def test_defaults(self):
        cfg = load('nonexistent.json')
        self.assertEqual(cfg['token'], '换成云端设备口令')
        self.assertFalse(cfg['virtual'])


if __name__ == '__main__':
    unittest.main()
```

- [ ] **Step 5: 运行测试**

Run: `cd /c/Users/Administrator/jukebox/player && python -m unittest test_player -v`
Expected: 4 个测试 PASS

- [ ] **Step 6: 提交**

Run: `cd /c/Users/Administrator/jukebox && git add -A && git commit -m "feat: player scaffold with virtual player"`

### Task 14: 真 mpv 播放器（MpvPlayer）

**Files:**
- Modify: `player/playback.py`（追加 MpvPlayer）

**Interfaces:**
- Consumes: 无（本任务只依赖 python-mpv 与已装 libmpv；无 libmpv 时构造抛 RuntimeError，不影响虚拟模式）
- Produces: `playback.MpvPlayer(libmpv=None)`，接口同 BasePlayer；`wait_event` 语义：加载后 `eof_reached` → 'finished'；播放中回到 `core_idle` → 'error'

- [ ] **Step 1: 实现 MpvPlayer**

`player/playback.py` 追加（在 VirtualPlayer 之后）:

```python
class MpvPlayer(BasePlayer):
    """基于 python-mpv 的真实播放器。libmpv 需已安装（README/setup 脚本有步骤）。"""

    def __init__(self, libmpv=None):
        import mpv
        try:
            kwargs = {'ytdl': False, 'input_default_bindings': False, 'input_vo_keyboard': False}
            if libmpv:
                kwargs['libmpv'] = libmpv
            self.mpv = mpv.MPV(**kwargs)
        except OSError as e:
            raise RuntimeError(f'找不到 libmpv，请先安装 mpv（见 README）：{e}')
        self._loaded = False

    async def play(self, url, volume, muted):
        self.mpv.loadfile(url)
        self._loaded = True
        self.mpv.volume = int(volume)
        self.mpv.mute = bool(muted)

    async def pause(self):
        self.mpv.pause = True

    async def resume(self):
        self.mpv.pause = False

    async def stop(self):
        self._loaded = False
        self.mpv.command('stop')

    async def set_volume(self, v):
        self.mpv.volume = int(v)

    async def set_mute(self, m):
        self.mpv.mute = bool(m)

    async def wait_event(self, timeout=0.5):
        t0 = time.time()
        while time.time() - t0 < timeout:
            await asyncio.sleep(0.2)
            if self._loaded:
                if self.mpv.eof_reached:
                    self._loaded = False
                    return 'finished'
                if self.mpv.core_idle:
                    # 载入后回到 idle：加载失败/地址失效
                    self._loaded = False
                    return 'error'
        return None

    def audio_device(self):
        """当前音频设备名（蓝牙掉线检测用；平台不支持时返回 None）。"""
        try:
            return self.mpv.audio_device
        except Exception:
            return None

    async def close(self):
        self.mpv.terminate()
```

- [ ] **Step 2: 单测（mock 掉 python-mpv，验证路径传递与异常包装）**

`player/test_player.py` 追加：

```python
class TestMpvPlayer(unittest.TestCase):
    def test_libmpv_path_passed_and_oserror_wrapped(self):
        import sys
        from unittest import mock
        from playback import MpvPlayer

        # 场景 1：libmpv 路径传给 MPV 构造器，且禁用 ytdl
        fake = mock.Mock()
        fake.MPV.return_value = mock.Mock(
            volume=0, mute=False, pause=False, eof_reached=False, core_idle=False)
        with mock.patch.dict(sys.modules, {'mpv': fake}):
            p = MpvPlayer('/opt/mpv/libmpv.dylib')
            kwargs = fake.MPV.call_args.kwargs
            self.assertEqual(kwargs.get('libmpv'), '/opt/mpv/libmpv.dylib')
            self.assertFalse(kwargs['ytdl'])
            self.assertIs(p.mpv, fake.MPV.return_value)

        # 场景 2：libmpv 缺失（OSError）→ 包装成 RuntimeError
        fake2 = mock.Mock()
        fake2.MPV.side_effect = OSError('cannot load mpv')
        with mock.patch.dict(sys.modules, {'mpv': fake2}):
            with self.assertRaises(RuntimeError):
                MpvPlayer()

        # 场景 3：不传路径时构造器不接 libmpv 参数
        fake3 = mock.Mock()
        fake3.MPV.return_value = mock.Mock()
        with mock.patch.dict(sys.modules, {'mpv': fake3}):
            MpvPlayer()
            self.assertNotIn('libmpv', fake3.MPV.call_args.kwargs)
```

Run: `cd /c/Users/Administrator/jukebox/player && python -m unittest test_player -v`
Expected: 5 个测试 PASS（含 MpvPlayer 3 个断言场景）

- [ ] **Step 3: 提交**

Run: `cd /c/Users/Administrator/jukebox && git add -A && git commit -m "feat: real mpv player"`

### Task 15: WS 客户端与端到端联调

**Files:**
- Modify: `player/client.py`（整体替换）

**Interfaces:**
- Consumes: BasePlayer 接口（Task 13）；协议播放端消息（文件头）
- Produces: `client.run(cfg)`：连接 → hello → 指令循环 → 事件上报 → 断线 5s 重试；`cfg['virtual']` 决定播放器类型；播放中每 2s 检测 `player.audio_device()` 变化（蓝牙音箱掉线，best-effort）→ stop 并上报 `error` + `detail.reason:'音频设备掉线'`（服务端收到后不自动续播，见 Task 3）

- [ ] **Step 1: 实现 client.py**

`player/client.py`（整体替换）:

```python
"""WebSocket 客户端：连接云端、上报事件、执行播放指令、断线自动重连。"""
import asyncio
import json
import logging

log = logging.getLogger('player.client')


def make_player(cfg):
    if cfg.get('virtual'):
        from playback import VirtualPlayer
        return VirtualPlayer(duration=float(cfg.get('virtual_duration', 10)))
    from playback import MpvPlayer
    return MpvPlayer(cfg.get('libmpv') or None)


async def run(cfg):
    player = make_player(cfg)
    try:
        while True:
            try:
                await session(cfg, player)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.warning('会话异常，5 秒后重连：%s', e)
                await asyncio.sleep(5)
    finally:
        await player.close()


async def session(cfg, player):
    import websockets
    async with websockets.connect(cfg['server'], ping_interval=20, ping_timeout=20, open_timeout=15) as ws:
        await ws.send(json.dumps({'type': 'player_hello', 'token': cfg['token']}))
        log.info('已连接云端并完成 hello')
        cmdq = asyncio.Queue()
        recv = asyncio.create_task(receiver(ws, cmdq))
        try:
            await control_loop(ws, cmdq, player)
        finally:
            recv.cancel()


async def receiver(ws, cmdq):
    async for raw in ws:
        try:
            msg = json.loads(raw)
        except Exception:
            continue
        if msg.get('type') == 'player_cmd':
            await cmdq.put(msg.get('cmd') or {})


async def control_loop(ws, cmdq, player):
    while True:
        cmd = await cmdq.get()
        if cmd.get('action') == 'play':
            song = cmd.get('song') or {}
            await player.play(cmd.get('url'), cmd.get('volume', 60), cmd.get('muted', False))
            await ws.send(json.dumps({'type': 'player_event', 'event': 'started'}))
            log.info('开始播放：%s', song.get('title') or cmd.get('url'))
            await play_session(ws, cmdq, player)
        else:
            await apply_cmd(player, cmd)


async def play_session(ws, cmdq, player):
    """播放期间：每 0.2s 探测结束/错误事件，同时处理 pause/volume/mute/stop 指令。"""
    dev_at_start = player.audio_device()
    ticks = 0
    while True:
        ev = await player.wait_event(timeout=0.2)
        if ev == 'finished':
            log.info('播放完成')
            await ws.send(json.dumps({'type': 'player_event', 'event': 'finished'}))
            return
        if ev == 'error':
            log.warning('播放出错（加载失败或地址失效）')
            await ws.send(json.dumps({'type': 'player_event', 'event': 'error', 'detail': {'reason': '加载失败'}}))
            return
        ticks += 1
        if ticks % 10 == 0:  # 每 2 秒检测一次音频设备变化（蓝牙音箱掉线）
            cur = player.audio_device()
            if dev_at_start and cur and cur != dev_at_start:
                log.warning('音频设备变化（可能蓝牙音箱掉线）：%s → %s', dev_at_start, cur)
                await player.stop()
                await ws.send(json.dumps({'type': 'player_event', 'event': 'error', 'detail': {'reason': '音频设备掉线'}}))
                return
        while not cmdq.empty():
            cmd = cmdq.get_nowait()
            if cmd.get('action') == 'stop':
                await player.stop()
                return
            await apply_cmd(player, cmd)


async def apply_cmd(player, cmd):
    action = cmd.get('action')
    if action == 'pause':
        await player.pause()
    elif action == 'resume':
        await player.resume()
    elif action == 'volume':
        await player.set_volume(int(cmd.get('value', 60)))
    elif action == 'mute':
        await player.set_mute(bool(cmd.get('value')))
    elif action == 'stop':
        await player.stop()
    # 未知指令忽略
```

- [ ] **Step 2: 与本地服务器端到端联调（虚拟模式）**

Run（终端 1）: `cd /c/Users/Administrator/jukebox/server && DEVICE_TOKEN=tok node bin/server.js`
Run（终端 2）: `cd /c/Users/Administrator/jukebox/player && printf '{"server":"ws://localhost:3000","token":"tok","virtual":true}' > player_config.json && VIRTUAL_DURATION=4 python player.py`
浏览器开 `http://localhost:3000/` 依次验证：
- [ ] 播放端日志打印"已连接云端并完成 hello"，页面播放端离线提示消失
- [ ] 点歌 → 终端 2 打印 `[virtual] play` → 4 秒后自动 `播放完成` → 下一首自动播（虚拟时长 4s 循环队列）
- [ ] 页面切歌 → 终端 2 打印 `[virtual] stop` 并立刻播下一首
- [ ] 页面调音量/静音 → 终端 2 实时打印 `volume=`/`mute=`
- [ ] Ctrl+C 杀掉终端 2 → 页面显示"⚠ 播放端离线"；重启终端 2 → 自动重连并接着播队首
- [ ] 全程无"音频设备掉线"误报（虚拟播放器 audio_device 恒 None，检测不触发）
Expected: 全部通过。验证完 `kill %1`，删除 `player/player_config.json`（已 gitignore）

- [ ] **Step 3: 真声测试（可选；有 libmpv/音箱的机器上做）**

Run: 按 Task 16 的 setup 脚本装好 libmpv 后，`python player.py`（不带 --virtual）
Expected: 点歌后真实出声；音量滑条实时改变 mpv 音量；切歌立即生效；播放中拔掉蓝牙音箱 → 日志打印"音频设备变化"，服务器停止续播且历史 reason 为"音频设备掉线"（best-effort：平台未暴露设备名时检测不触发，不视为失败）

- [ ] **Step 4: 提交**

Run: `cd /c/Users/Administrator/jukebox && git add -A && git commit -m "feat: player websocket client with reconnect"`

## Phase 4 — 部署与验收

### Task 16: 部署 CloudStudio + 公司电脑安装 + 验收

**Files:**
- Create: `server/README.md`, `player/README.md`, `player/setup_win.bat`, `player/setup_mac.sh`, `player/player_start.bat`, `docs/deploy.md`
- Modify: `.gitignore`（追加 player 日志与 libmpv）

**Interfaces:**
- Consumes: 全部已完成模块
- Produces: 可对外使用的完整系统 + 文档

- [ ] **Step 1: 更新 .gitignore**

`.gitignore` 追加：

```
player/player.log
player/libmpv/
```

- [ ] **Step 2: 写部署文档 docs/deploy.md**

内容（直接照写）:

```markdown
# 部署指南

## 一、云端部署（腾讯 CloudStudio 免费版）

1. 把代码推送到 GitHub 私有仓库（或本地打包 zip）
2. 登录腾讯云 CloudStudio 控制台 → 新建应用 → 导入仓库/上传 zip
3. 配置：运行时 Node.js 24（历史库用内置 node:sqlite，需 ≥23.4）；启动命令 `cd server && npm install && npm start`（平台会注入 PORT）
4. 环境变量：
   - `DEVICE_TOKEN`：设备口令（自己定一串，如 `ktv-2026-xj`）——播放端连接用
   - `NETEASE_REAL_IP`：可选，网易云 API 若限流时填国内 IP
5. 开启"应用常驻"（免费版默认可能休眠，开启后 24 小时在线）
6. 部署完成 → 得到 `https://<hash>.app.workbuddy.link` 域名 → 浏览器访问验证
7. WebSocket 走同域 `/ws`，平台支持（本架构与原版一致，已验证可行）

## 二、公司电脑播放端安装

Windows：双击 `player/setup_win.bat`，按提示填 token，脚本会装依赖、下 libmpv、注册开机自启。
Mac：终端运行 `bash player/setup_mac.sh`，同上。

播放前把系统默认音频输出切到蓝牙音箱（Windows：右下角音量图标 → 输出设备选蓝牙音箱）。

## 三、验收清单

- [ ] 手机打开网址 → 搜索点歌 → 蓝牙音箱出声
- [ ] 多人页面：A 调音量，B 页面 1 秒内同步；A 切歌立刻生效
- [ ] 已点列表置顶/删除
- [ ] 播放端电脑关机 → 页面提示离线、点歌照常排队；开机重连自动接着播
- [ ] 歌词滚动高亮；纯音乐正常显示
- [ ] VIP 歌有标签；播不了自动跳下一首并注明
- [ ] 服务器重启：队列清空、历史保留

## 四、日常维护

- 服务器日志：CloudStudio 控制台看应用日志
- 播放端日志：`player/player.log`
- 历史记录库：`server/data/jukebox.db`（云端实例内）
```

- [ ] **Step 3: 写 server/README.md 与 player/README.md**

`server/README.md`:

```markdown
# 点歌台服务器

本地开发：`npm install && DEVICE_TOKEN=dev node bin/server.js` → http://localhost:3000
测试：`npm test`
环境变量：PORT（默认 3000）、DEVICE_TOKEN（播放端口令）、DB_PATH（SQLite 路径）、NETEASE_REAL_IP（可选）
部署：见 ../docs/deploy.md
```

`player/README.md`:

```markdown
# 点歌台播放客户端（Win/Mac 通用）

作用：连云端领取播放任务，用 mpv 播放到本机默认音频设备（蓝牙音箱）。

## 安装

- Windows：双击 `setup_win.bat`
- Mac：`bash setup_mac.sh`

两个脚本都会：装 Python 依赖 → 装/下载 libmpv → 生成 player_config.json → 注册开机自启。

## 配置 player_config.json

- `server`：云端网址（自动补全 wss:// 与 /ws）
- `token`：云端 DEVICE_TOKEN，设备口令
- `libmpv`：留空自动找（Windows 会搜 libmpv/ 目录下的 mpv-2.dll）

## 手动运行

`python player.py`（真实播放）；`python player.py --virtual`（不出声联调）

## 换电脑

新电脑跑一遍安装脚本，填同一个 server/token 即可，云端无感知。
```

- [ ] **Step 4: 写 Windows 安装脚本 setup_win.bat 与 player_start.bat**

`player/setup_win.bat`:

```bat
@echo off
setlocal
cd /d "%~dp0"
echo === KTV 点歌台播放端安装 ===

where python >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Python。请安装 Python 3.9+ 并勾选 "Add to PATH"
  echo 下载地址: https://www.python.org/downloads/
  pause & exit /b 1
)

python -m pip install -r requirements.txt
if errorlevel 1 ( echo [错误] 依赖安装失败 & pause & exit /b 1 )

if not exist libmpv\mpv-2.dll (
  echo 正在下载 libmpv（约 40MB）...
  mkdir libmpv 2>nul
  powershell -NoProfile -Command "$r=Invoke-RestMethod https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/latest; $a=$r.assets | Where-Object {$_.name -match 'mpv-dev-x86_64.*\.7z$'} | Select-Object -First 1; if(-not $a){throw '找不到 mpv-dev 包'}; Write-Host ('下载 ' + $a.name); Invoke-WebRequest $a.browser_download_url -OutFile 'libmpv\mpv.7z'"
  if errorlevel 1 ( echo [错误] libmpv 下载失败，请手动到 https://github.com/shinchiro/mpv-winbuild-cmake/releases 下载 mpv-dev-x86_64-*.7z 解压出 mpv-2.dll 放到 libmpv\ & pause & exit /b 1 )
  tar -xf libmpv\mpv.7z -C libmpv
)

if not exist player_config.json (
  copy player_config.example.json player_config.json >nul
  echo.
  echo 请填写 player_config.json 里的 server 和 token：
  notepad player_config.json
  pause
)

echo === 虚拟模式试运行（确认能连上云端）===
python player.py --virtual

echo === 注册开机自启 ===
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup')+'\点歌台播放端.lnk'); $s.TargetPath='%~dp0player_start.bat'; $s.WorkingDirectory='%~dp0'; $s.Save()"
echo.
echo 安装完成！正式播放前：右下角音量图标 → 输出设备选蓝牙音箱 → 双击 player_start.bat（或重启电脑）
pause
```

`player/player_start.bat`:

```bat
@echo off
cd /d "%~dp0"
pythonw player.py >> player.log 2>&1
```

- [ ] **Step 5: 写 Mac 安装脚本 setup_mac.sh**

`player/setup_mac.sh`:

```bash
#!/bin/bash
set -e
cd "$(dirname "$0")"
PY=$(command -v python3 || true)
if [ -z "$PY" ]; then echo "[错误] 未找到 python3，请先安装 Python 3.9+"; exit 1; fi
command -v brew >/dev/null || { echo "[错误] 请先安装 Homebrew: https://brew.sh"; exit 1; }
echo "=== 安装 libmpv（brew mpv）==="
brew install mpv
echo "=== 安装 Python 依赖 ==="
"$PY" -m pip install -r requirements.txt
[ -f player_config.json ] || cp player_config.example.json player_config.json
echo "请编辑 player_config.json 填入 server 和 token，改完按回车继续"
read -r _
echo "=== 虚拟模式试运行（确认能连上云端）==="
"$PY" player.py --virtual
echo "=== 注册开机自启（LaunchAgent）==="
PLIST="$HOME/Library/LaunchAgents/com.jukebox.player.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.jukebox.player</string>
  <key>ProgramArguments</key><array>
    <string>$PY</string>
    <string>$(pwd)/player.py</string>
  </array>
  <key>WorkingDirectory</key><string>$(pwd)</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(pwd)/player.log</string>
  <key>StandardErrorPath</key><string>$(pwd)/player.log</string>
</dict></plist>
EOF
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "安装完成！播放前把系统输出切到蓝牙音箱，然后重启或执行: launchctl start com.jukebox.player"
```

- [ ] **Step 6: 提交**

Run: `cd /c/Users/Administrator/jukebox && git add -A && git commit -m "docs: deployment guide and player setup scripts"`

- [ ] **Step 7: 云端部署（需用户配合，腾讯云账号登录）**

提示用户：按 `docs/deploy.md` 第一节操作。用户在 CloudStudio 控制台完成仓库导入与环境变量设置后，请用户提供：
1. 部署得到的域名（`https://<hash>.app.workbuddy.link`）
2. 填好的 `DEVICE_TOKEN`

然后你（执行者）验证：
Run: `curl -s <域名>/api/health` → `{"ok":true}`；浏览器打开 `<域名>` → 深色点歌台界面、显示"🟢 已连接"（此时播放端离线提示正常）；`curl -s -X POST <域名>/api/search -H "content-type: application/json" -d '{"q":"周杰伦"}'` → 返回真实歌曲
Expected: 全部正常。把域名发给用户，由用户按 docs/deploy.md 第二节在公司电脑装播放端并跑验收清单。

## 计划自检记录

- 需求覆盖：R1-R8 全部有对应任务（R1/R6/R8→Task 7-12；R2→Task 4/5；R3→Global Constraints+全部匿名实现；R4/R5→Task 13-15；R7→Task 16）；spec §6 异常处理表逐条对应：播放端关机→Task 3 playerGone+Task 9 离线提示；蓝牙音箱掉线→Task 14/15 best-effort 设备检测+Task 3 不续播（平台不暴露设备名时检测不触发，靠员工手机暂停兜底，MVP 可接受）；网易云故障→Task 5 错误码+Task 8 点歌视图"暂时不可用"提示；网页断线重连→Task 7 指数退避；服务器重启→队列内存+历史 SQLite
- 协议一致性：WebSocket 消息结构与 ws.js/queue.js/player 客户端/前端 actions 四端一致（见文件头协议节）
- 无占位符：Task 13 的 client.py 占位由 Task 15 完整替换（顺序依赖明确，非遗留）
- 类型一致性：`createJukebox` 返回方法名、`store.add/update/list` 签名、`netease` 各函数签名、`BasePlayer` 接口在测试与实现间一致
<!-- PLAN-PART3 -->

