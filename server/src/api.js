'use strict';
const express = require('express');

function createApi({ netease }) {
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

  return r;
}
module.exports = { createApi };
