'use strict';
const { WebSocketServer } = require('ws');

function createRealtime({ server, history, resolveUrl, isPlayerToken }) {
  const jukebox = { getState: () => ({ current: null, queue: [], volume: 60, paused: false, muted: false, playerOnline: false }) };
  const wss = new WebSocketServer({ server, path: '/ws' });
  return { jukebox, wss };
}
module.exports = { createRealtime };
