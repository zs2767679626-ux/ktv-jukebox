'use strict';
const express = require('express');

// provider 白名单：路由里的 provider 参数只认这两个值，其余回落 netease
const PROVIDERS = ['netease', 'qq'];

function createApi({ providers, store, lanUrls }) {
  const r = express.Router();
  const wrap = (fn) => (req, res) =>
    fn(req, res).catch((e) => {
      console.error('[api]', e);
      res.status(500).json({ error: String((e && e.message) || e) });
    });

  function pick(raw) {
    return PROVIDERS.includes(raw) ? raw : 'netease';
  }

  // 给结果统一盖 provider 章：点歌请求、历史记录都靠它分派
  function stamp(p, songs) {
    return songs.map((s) => ({ ...s, provider: p }));
  }

  r.get('/health', (req, res) => res.json({ ok: true }));

  // 网页端「扫码点歌」二维码内容：手机能访问的局域网地址
  r.get('/server-info', (req, res) => res.json({ lanUrls: lanUrls || [] }));

  r.post('/search', wrap(async (req, res) => {
    const q = String(req.body?.q || '').trim();
    if (!q) return res.json({ results: [] });
    const p = pick(String(req.body?.provider || ''));
    res.json({ results: stamp(p, await providers.get(p).search(q)) });
  }));

  r.get('/artists', wrap(async (req, res) => {
    const p = pick(String(req.query.provider || ''));
    res.json({ artists: await providers.get(p).artists(req.query.type || 'male', req.query.initial || undefined) });
  }));

  r.get('/artist-songs', wrap(async (req, res) => {
    const p = pick(String(req.query.provider || ''));
    res.json({ songs: stamp(p, await providers.get(p).artistSongs(req.query.id)) });
  }));

  r.get('/toplist', wrap(async (req, res) => {
    const p = pick(String(req.query.provider || ''));
    if (req.query.id) return res.json({ songs: stamp(p, await providers.get(p).toplistSongs(req.query.id)) });
    res.json({ lists: await providers.get(p).toplists() });
  }));

  r.get('/catlist', wrap(async (req, res) => {
    const p = pick(String(req.query.provider || ''));
    res.json({ cats: await providers.get(p).catlist() });
  }));

  r.get('/style-playlists', wrap(async (req, res) => {
    const p = pick(String(req.query.provider || ''));
    res.json({ playlists: await providers.get(p).stylePlaylists(req.query.cat) });
  }));

  r.get('/playlist-songs', wrap(async (req, res) => {
    const p = pick(String(req.query.provider || ''));
    res.json({ songs: stamp(p, await providers.get(p).playlistSongs(req.query.id)) });
  }));

  r.get('/lyric', wrap(async (req, res) => {
    const p = pick(String(req.query.provider || ''));
    res.json({ lrc: await providers.get(p).lyric(req.query.id) });
  }));

  // —— 双平台登录：扫码登录/状态/登出（provider 参数化）——
  // 登录态按平台分别存 settings：netease_cookie / qq_cookie
  const cookieKey = (p) => `${p}_cookie`;

  r.get('/auth/login-status', wrap(async (req, res) => {
    const p = pick(String(req.query.provider || ''));
    res.json({ provider: p, status: await providers.get(p).loginStatus() });
  }));

  r.post('/auth/qr-login', wrap(async (req, res) => {
    const p = pick(String(req.body?.provider || ''));
    const qrKey = await providers.get(p).qrKey();
    if (!qrKey) throw new Error('获取登录二维码失败');
    const qrImg = await providers.get(p).qrCreate(qrKey);
    if (!qrImg) throw new Error('生成登录二维码失败');
    res.json({ provider: p, qrKey, qrImg });
  }));

  r.post('/auth/qr-check', wrap(async (req, res) => {
    const p = pick(String(req.body?.provider || ''));
    const key = String(req.body?.qrKey || '');
    if (!key) return res.json({ code: -1 });
    const body = await providers.get(p).qrCheck(key);
    if (body.code === 803 && body.cookie) {
      providers.get(p).setCookie(body.cookie);
      store.setSetting(cookieKey(p), body.cookie);
      const status = (await providers.get(p).loginStatus()) || {};
      return res.json({ code: 803, provider: p, ...status });
    }
    res.json({ code: body.code ?? -1 });
  }));

  r.post('/auth/logout', wrap(async (req, res) => {
    const p = pick(String(req.body?.provider || ''));
    providers.get(p).clearCookie();
    store.deleteSetting(cookieKey(p));
    res.json({ ok: true });
  }));

  // —— 旧网易云路由兼容（老页面/缓存页面仍可用）——
  r.get('/netease/login-status', wrap(async (req, res) => {
    res.json({ status: await providers.netease.loginStatus() });
  }));

  r.post('/netease/qr-login', wrap(async (req, res) => {
    const qrKey = await providers.netease.qrKey();
    if (!qrKey) throw new Error('获取登录二维码失败');
    const qrImg = await providers.netease.qrCreate(qrKey);
    if (!qrImg) throw new Error('生成登录二维码失败');
    res.json({ qrKey, qrImg });
  }));

  r.post('/netease/qr-check', wrap(async (req, res) => {
    const key = String(req.body?.qrKey || '');
    if (!key) return res.json({ code: -1 });
    const body = await providers.netease.qrCheck(key);
    if (body.code === 803 && body.cookie) {
      providers.netease.setCookie(body.cookie);
      store.setSetting('netease_cookie', body.cookie);
      const status = (await providers.netease.loginStatus()) || {};
      return res.json({ code: 803, ...status });
    }
    res.json({ code: body.code ?? -1 });
  }));

  r.post('/netease/logout', wrap(async (req, res) => {
    providers.netease.clearCookie();
    store.deleteSetting('netease_cookie');
    res.json({ ok: true });
  }));

  return r;
}
module.exports = { createApi };
