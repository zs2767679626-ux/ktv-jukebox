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
  assert.equal(r[0].song_id, '186016');
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
