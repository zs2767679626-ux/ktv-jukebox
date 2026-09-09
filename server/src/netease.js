'use strict';

// 网易云 API 封装。所有函数返回归一化结构，对调用方屏蔽底层细节。
// 注意：songUrl 对 VIP/付费歌返回 error:'vip'，调用方（queue）据此跳过。
// 配置会员 Cookie（NETEASE_COOKIE）后，VIP 歌能拿到真实播放地址，正常播放。
function createNetease(api, opts = {}) {
  const { realIP = '', cookie = '' } = opts;

  function normalize(s) {
    return {
      song_id: String(s.id),
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
    if (cookie) base.cookie = cookie;
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
