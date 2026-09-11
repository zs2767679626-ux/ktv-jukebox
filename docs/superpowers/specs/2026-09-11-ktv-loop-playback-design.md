# 点歌台循环播放设计

日期：2026-09-11
状态：已批准

## 背景

点歌台现有暂停、切歌、音量、静音控制，缺循环播放。用户需求：**单曲循环**（练歌）+ **列表循环**（办公室背景音乐不冷场），不做随机。

## 目标

- 三种播放模式：顺序（现状默认）、单曲循环、列表循环。
- 模式经网页端控制条按钮切换，全员共享（与暂停/切歌一致）。
- 模式持久化到 SQLite settings，服务器重启不丢。
- 播放端（ktv-player.exe，含对外部署包）**零改动**——循环是服务端队列状态机的事。

## 非目标

- 不做随机播放（用户明确不要）。
- 不改对外部署包。

## 行为规则

| 场景 | 顺序（现状） | 单曲循环 | 列表循环 |
|---|---|---|---|
| 歌曲正常放完 | 播下一首 | 重播这首歌 | 播下一首 |
| 队列空了且无当前歌 | 停 | 停 | 自动回填已播歌曲（最早播过的优先）并续播 |
| 点「切歌」 | 下一首 | 跳出循环，播下一首 | 下一首 |
| 解析失败/版权受限/播放端掉线/音频设备掉线 | 跳过 | **不循环**，按现状跳过（防死循环） | 跳过 |

补充规则：

1. 单曲循环的实现：`finished` 时若 mode=single，先把当前歌正常记入 history（status=played），再以「重新点歌」路径加回（新 history 行、重新解析 URL）。若重播解析失败 → 走跳过分支，不会死循环。
2. 列表循环回填时机：`playNext()` 中「无 current、队列空、playerOnline、mode=list」时触发；回填来源为 history 中 status='played' 的**最近 100 条**记录，按 id 升序返回（窗口内最早播过优先）；回填的每首走正常点歌路径（新 history 行）。回填后立即续播。
3. 回填时若有人在点歌（队列非空）不触发——排队歌先播。
4. 切歌在单曲循环下跳出循环：skip 走现有「stop → finishCurrent(skipped) → playNext」路径，天然不重播。

## 改动范围

### 服务端

- `server/src/queue.js`：
  - state 增加 `mode: 'order'`（合法值 order/single/list）。
  - 新增 `setMode(m)`：非法值忽略；变更后 broadcast。
  - `playerEvent('finished')`：mode=single 时走「记 played → 重播」，否则现路径。
  - `playNext()`：按规则 2 回填。回填经注入的 `history.listPlayed(limit)` 取数（deps 新增）。
  - `getState()` 输出含 mode。
- `server/src/store.js`：history 新增 `listPlayed(limit)`（`SELECT * FROM history WHERE status='played' ORDER BY id ASC LIMIT ?`，行字段映射回 song 对象在 queue.js 内做）。
- `server/src/ws.js`：新增 `mode_set` 消息 → `jukebox.setMode(msg.value)`。
- `server/src/index.js`：启动时 `settings.getSetting('play_mode')` 注入 createJukebox 初始 mode（合法值才用）；挂接 `history.listPlayed` 到 deps。
- 测试（server/test）：新增 ~7 用例：单曲重播（含新 history 行、再次 send play）、切歌跳出单曲、单曲下解析失败不循环、列表回填（队列空触发、升序、100 条上限）、列表回填仅在 mode=list、mode_set 变更+广播、非法 mode 忽略。

### 网页端

- `web/js/actions.js`：新增 `setMode(mode)` → `{ type: 'mode_set', value: mode }`。
- `web/js/views/player.js`：控制条「⏭ 切歌」旁新增模式按钮，文案随状态：顺序播放 / 🔂 单曲循环 / 🔁 列表循环；点击循环切换 order→single→list→order；按钮随 state.mode 更新（state.js 整体透传 state 对象、无字段白名单，无需改动，已核实）。

### 不动

- 播放端（player/）、部署包、数据库结构（settings 表已有）。

## 测试

- 服务端单测全绿（58 + 新增用例）。
- 手工 E2E：网页切模式按钮 → 状态变化全员可见；列表循环在队列放空后自动续播；重启服务器模式保持。
