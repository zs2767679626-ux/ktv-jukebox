'use strict';
const express = require('express');

function createApi({ netease }) {
  const r = express.Router();
  r.get('/health', (req, res) => res.json({ ok: true }));
  return r;
}
module.exports = { createApi };
