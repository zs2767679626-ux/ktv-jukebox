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
