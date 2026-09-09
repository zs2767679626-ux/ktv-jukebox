'use strict';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('http');
const { createApi } = require('../src/api');

const fakeStore = { getSetting: () => null, setSetting() {}, deleteSetting() {} };

async function withServer(handler, extra = {}) {
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
    loginStatus: async () => null,
    qrKey: async () => null,
    qrCreate: async () => null,
    qrCheck: async () => ({ code: 800 }),
    setCookie() {},
    clearCookie() {},
  };
  Object.assign(fake, extra.netease);
  const app = express();
  app.use(express.json());
  app.use('/api', createApi({ netease: fake, store: extra.store || fakeStore }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try { await handler(port); } finally { server.close(); }
}
const req = (port, method, p, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  // Node http client rejects raw UTF-8 in request target (ERR_UNESCAPED_CHARACTERS);
  // percent-encode like a real HTTP client. ASCII paths are unaffected.
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

test('网易云扫码登录：qr-login/qr-check 803 保存 cookie，logout 清除', async () => {
  const settings = {};
  const holder = { cookie: '' };
  await withServer(async (port) => {
    // 初始未登录
    assert.deepEqual(await req(port, 'GET', '/api/netease/login-status'), { status: 200, json: { status: null } });
    // 生成二维码
    const qr = await req(port, 'POST', '/api/netease/qr-login', {});
    assert.deepEqual(qr.json, { qrKey: 'KEY1', qrImg: 'QRIMG' });
    // 未扫码轮询 → 801
    const wait = await req(port, 'POST', '/api/netease/qr-check', { qrKey: 'KEY1' });
    assert.equal(wait.json.code, 801);
    // 扫码成功 → 803 + 登录态 + cookie 持久化
    holder.scanned = true;
    const ok = await req(port, 'POST', '/api/netease/qr-check', { qrKey: 'KEY1' });
    assert.equal(ok.json.code, 803);
    assert.equal(ok.json.loggedIn, true);
    assert.equal(ok.json.nickname, '会员号');
    assert.equal(ok.json.vipType, 11);
    assert.equal(settings.netease_cookie, 'MUSIC_U=qq');
    // 登录态可查
    const st = await req(port, 'GET', '/api/netease/login-status');
    assert.equal(st.json.status.nickname, '会员号');
    // 登出
    assert.deepEqual(await req(port, 'POST', '/api/netease/logout', {}), { status: 200, json: { ok: true } });
    assert.equal('netease_cookie' in settings, false);
    assert.deepEqual(await req(port, 'GET', '/api/netease/login-status'), { status: 200, json: { status: null } });
  }, {
    netease: {
      qrKey: async () => 'KEY1',
      qrCreate: async () => 'QRIMG',
      qrCheck: async (key) => (key === 'KEY1' ? { code: holder.scanned ? 803 : 801, cookie: 'MUSIC_U=qq' } : { code: 800 }),
      loginStatus: async () => (holder.cookie ? { loggedIn: true, nickname: '会员号', vipType: 11 } : null),
      setCookie: (c) => { holder.cookie = c; },
      clearCookie: () => { holder.cookie = ''; },
    },
    store: {
      getSetting: (k) => settings[k] ?? null,
      setSetting: (k, v) => { settings[k] = v; },
      deleteSetting: (k) => { delete settings[k]; },
    },
  });
});
