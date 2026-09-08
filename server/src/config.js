'use strict';
const path = require('path');

module.exports = {
  // CloudStudio 会注入 PORT
  port: Number(process.env.PORT || 3000),
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'jukebox.db'),
  deviceToken: process.env.DEVICE_TOKEN || 'dev-token-change-me',
  neteaseRealIP: process.env.NETEASE_REAL_IP || '',
};
