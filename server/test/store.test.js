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

test('settings 键值读写删（netease_cookie 场景）', () => {
  const store = createStore(tempDb());
  assert.equal(store.getSetting('netease_cookie'), null);
  store.setSetting('netease_cookie', 'MUSIC_U=abc');
  assert.equal(store.getSetting('netease_cookie'), 'MUSIC_U=abc');
  store.setSetting('netease_cookie', 'MUSIC_U=xyz'); // 覆盖
  assert.equal(store.getSetting('netease_cookie'), 'MUSIC_U=xyz');
  store.deleteSetting('netease_cookie');
  assert.equal(store.getSetting('netease_cookie'), null);
  store.close();
});

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
