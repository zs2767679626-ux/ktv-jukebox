# 点歌台 KTV榜设计（语种榜替换）

日期：2026-09-14
状态：已批准

## 背景

点歌台分类宫格里有「🌍 语种」入口（按华语/粤语/欧美/日韩关键词给榜单分组）。用户面向办公室 KTV 场景，不再需要语种分类搜索，要求把该分类整个换成 KTV 榜。网易云有官方「KTV唛榜」（id 21845217），QQ 音乐有「K歌金曲榜」（id 36，无「KTV」字样但同性质）。

前置修复（本日已改、已验证）：网易云榜单取歌此前走 `toplist_detail`，其 tracks 只是 `{first:歌名, second:歌手}` 名字对、无歌曲 id，所有榜单歌曲列表全空；已改为 `playlist_detail`（榜单 id 本质是歌单），70/70 测试全绿。

## 目标

- 宫格「🌍 语种」→「🎙️ KTV榜」，点击**直达**该平台 KTV 榜歌曲列表（与热门榜/新歌榜交互一致）。
- 语种分类相关代码全部删除。
- 网易云 KTV 数据源：官方「麦霸练歌房 | KTV必点华语金曲精选」歌单（id 2790812763，199 首）——官方 KTV唛榜全榜仅 11 首（trackCount 实测），撑不起点歌，用户已确认换歌单；QQ 保持 K歌金曲榜（id 36，55 首）。

## 非目标

- 不做 KTV 主题分组页/多榜列表页（用户已选直达单榜）。
- 不改服务端、播放端、对外部署包。

## 改动范围

### 网页端（唯一改动文件：`web/js/views/point.js`）

- `TILES`：语种项 `{ icon: '🌍', name: '语种', page: 'toplist', arg: { lang: true } }` → `{ icon: '🎙️', name: 'KTV榜', page: 'toplist', arg: { id: 'ktv' } }`。
- 新增 `KTV_SOURCES = { netease: { kind: 'playlist', id: '2790812763' }, qq: { kind: 'toplist', id: '36' } }`。
- `openPage` 的 toplist 分支：新增 `'ktv'` 分支，按 `kind` 走 `/api/playlist-songs` 或 `/api/toplist`（hot/new 保持原映射）。
- 删除语种逻辑：`LANG_KEYS` 常量、`langMap` 模块变量、`renderLangLists()`、`openPage` 里 `arg.lang` 分支、tab 点击处理里 langMap 分支（歌手页 tab 保留，简化后直接 `artistList(tabkey)`）。
- 保留：榜单页通用分支（`subhead('榜单') + renderListRows`）与 `renderListRows`——非本次目标，删了属多余动作。

### 不动

- 服务端（`/api/toplist` 两平台榜单接口均已实测可用）、播放端、部署包、数据库。

## 验证

- 接口实测（改前端前已完成）：网易云官方 KTV 歌单 2790812763 返回 100 首（歌单共 199 首，服务端截前 100）、QQ K歌金曲榜 55 首，均为 0 空字段。
- 服务端测试 70/70（不受本次改动影响）。
- 手工验收：刷新网页 → 点「🎙️ KTV榜」→ 两平台各点一首歌进队列可播。
