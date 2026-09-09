'use strict';
const express = require('express');

function createApi({ netease, store }) {
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

  // —— 网易云登录：扫码登录/状态/登出 ——
  r.get('/netease/login-status', wrap(async (req, res) => {
    res.json({ status: await netease.loginStatus() });
  }));

  r.post('/netease/qr-login', wrap(async (req, res) => {
    const qrKey = await netease.qrKey();
    if (!qrKey) throw new Error('获取登录二维码失败');
    const qrImg = await netease.qrCreate(qrKey);
    if (!qrImg) throw new Error('生成登录二维码失败');
    res.json({ qrKey, qrImg });
  }));

  r.post('/netease/qr-check', wrap(async (req, res) => {
    const key = String(req.body?.qrKey || '');
    if (!key) return res.json({ code: -1 });
    const body = await netease.qrCheck(key);
    if (body.code === 803 && body.cookie) {
      netease.setCookie(body.cookie);
      store.setSetting('netease_cookie', body.cookie);
      const status = (await netease.loginStatus()) || {};
      return res.json({ code: 803, ...status });
    }
    res.json({ code: body.code ?? -1 });
  }));

  r.post('/netease/logout', wrap(async (req, res) => {
    netease.clearCookie();
    store.deleteSetting('netease_cookie');
    res.json({ ok: true });
  }));

  return r;
}
module.exports = { createApi };
