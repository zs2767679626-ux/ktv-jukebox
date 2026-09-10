'use strict';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('http');
const { createApi } = require('../src/api');

const fakeStore = { getSetting: () => null, setSetting() {}, deleteSetting() {} };

function makeFake() {
  return {
    search: async (q) => [{ song_id: '1', title: q, artist: 'X', album: '', duration_ms: 1, fee: 0 }],
    artists: async () => [{ id: '7', name: '歌手', pic: 'p' }],
    artistSongs: async () => [{ song_id: '2', title: '歌', artist: 'X', album: '', duration_ms: 1, fee: 0 }],
    toplists: async () => [{ id: '3778678', name: '热歌榜' }],
    toplistSongs: async () => [{ song_id: '3', title: '热歌', artist: 'X', album: '', duration_ms: 1, fee: 0 }],
    catlist: async () => ['流行'],
    stylePlaylists: async () => [{ id: '9', name: '精选', cover: 'c' }],
    playlistSongs: async () => [{ song_id: '4', title: '歌单歌', artist: 'X', album: '', duration_ms: 1, fee: 0 }],
    lyric: async () => '[00:00.00]词',
    loginStatus: async () => null,
    qrKey: async () => null,
    qrCreate: async () => null,
    qrCheck: async () => ({ code: 800 }),
    setCookie() {},
    clearCookie() {},
  };
}

async function withServer(handler, extra = {}) {
  const netease = makeFake();
  const qq = makeFake();
  Object.assign(netease, extra.netease);
  Object.assign(qq, extra.qq);
  const providers = { netease, qq, get: (p) => (p === 'qq' ? qq : netease) };
  const app = express();
  app.use(express.json());
  app.use('/api', createApi({ providers, store: extra.store || fakeStore, lanUrls: extra.lanUrls || [] }));
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

test('health 与 search（默认 netease，结果盖 provider 章）', async () => {
  await withServer(async (port) => {
    assert.deepEqual(await req(port, 'GET', '/api/health'), { status: 200, json: { ok: true } });
    const s = await req(port, 'POST', '/api/search', { q: '晴天' });
    assert.equal(s.json.results[0].title, '晴天');
    assert.equal(s.json.results[0].provider, 'netease');
  });
});

test('server-info 返回局域网地址（扫码点歌二维码用）', async () => {
  await withServer(async (port) => {
    const r = await req(port, 'GET', '/api/server-info');
    assert.deepEqual(r.json, { lanUrls: ['http://192.168.140.67:3000'] });
  }, { lanUrls: ['http://192.168.140.67:3000'] });
});

test('search 空关键词返回空数组', async () => {
  await withServer(async (port) => {
    const s = await req(port, 'POST', '/api/search', { q: '  ' });
    assert.deepEqual(s.json.results, []);
  });
});

test('provider=qq 时 search/lyric 走 QQ 适配器并盖章 provider:qq', async () => {
  await withServer(async (port) => {
    const s = await req(port, 'POST', '/api/search', { q: '七里香', provider: 'qq' });
    assert.equal(s.json.results[0].title, '七里香');
    assert.equal(s.json.results[0].provider, 'qq');
    const l = await req(port, 'GET', '/api/lyric?id=1&provider=qq');
    assert.equal(l.json.lrc, '[00:00.00]词');
  }, {
    qq: {
      search: async (q) => [{ song_id: 'qq1', title: q, artist: 'X', album: '', duration_ms: 1, fee: 0 }],
      lyric: async () => '[00:00.00]词',
    },
  });
});

test('非法 provider 回落 netease', async () => {
  await withServer(async (port) => {
    const s = await req(port, 'POST', '/api/search', { q: 'x', provider: 'kuwo' });
    assert.equal(s.json.results[0].provider, 'netease');
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
  const netease = makeFake();
  netease.search = async () => { throw new Error('boom'); };
  const qq = makeFake();
  const app = express();
  app.use(express.json());
  app.use('/api', createApi({ providers: { netease, qq, get: (p) => (p === 'qq' ? qq : netease) }, store: fakeStore }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try {
    const r = await req(port, 'POST', '/api/search', { q: 'x' });
    assert.equal(r.status, 500);
    assert.equal(r.json.error, 'boom');
  } finally { server.close(); }
});

test('网易云扫码登录：qr-login/qr-check 803 保存 cookie，logout 清除（旧路由兼容）', async () => {
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

test('QQ 音乐扫码登录（统一 auth 路由）：803 存 qq_cookie，logout 清除', async () => {
  const settings = {};
  const holder = { cookie: '' };
  await withServer(async (port) => {
    // 初始未登录
    assert.deepEqual(await req(port, 'GET', '/api/auth/login-status?provider=qq'), { status: 200, json: { provider: 'qq', status: null } });
    // 生成二维码
    const qr = await req(port, 'POST', '/api/auth/qr-login', { provider: 'qq' });
    assert.deepEqual(qr.json, { provider: 'qq', qrKey: 'QQKEY', qrImg: 'QQIMG' });
    // 已扫码待确认 → 802
    const wait = await req(port, 'POST', '/api/auth/qr-check', { provider: 'qq', qrKey: 'QQKEY' });
    assert.equal(wait.json.code, 802);
    // 扫码成功 → 803 + 登录态 + 凭证持久化
    holder.scanned = true;
    const ok = await req(port, 'POST', '/api/auth/qr-check', { provider: 'qq', qrKey: 'QQKEY' });
    assert.equal(ok.json.code, 803);
    assert.equal(ok.json.provider, 'qq');
    assert.equal(ok.json.loggedIn, true);
    assert.equal(ok.json.nickname, '绿钻号');
    assert.equal(settings.qq_cookie, '{"musicid":1,"musickey":"K"}');
    // 登出
    assert.deepEqual(await req(port, 'POST', '/api/auth/logout', { provider: 'qq' }), { status: 200, json: { ok: true } });
    assert.equal('qq_cookie' in settings, false);
  }, {
    qq: {
      qrKey: async () => 'QQKEY',
      qrCreate: async () => 'QQIMG',
      qrCheck: async (key) => (key === 'QQKEY' ? { code: holder.scanned ? 803 : 802, cookie: '{"musicid":1,"musickey":"K"}' } : { code: 800 }),
      loginStatus: async () => (holder.cookie ? { loggedIn: true, nickname: '绿钻号', vipType: 1 } : null),
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
