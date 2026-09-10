'use strict';
const { createNetease } = require('./netease');
const { createQQ } = require('./qq');

// 双平台适配器工厂。netease/qq 实现同一接口（search/songUrl/lyric/…/qrKey/qrCreate/qrCheck/loginStatus）。
// resolveUrl 按 song.provider 分派（缺省 netease，兼容旧数据）。
function createProviders({ neteaseApi, realIP = '', initialNeteaseCookie = '', initialQQCredential = '' }) {
  const netease = createNetease(neteaseApi, { realIP, cookie: initialNeteaseCookie });
  const qq = createQQ({ credential: initialQQCredential });
  const providers = { netease, qq };

  function get(provider) {
    return providers[provider] || providers.netease;
  }

  function resolveUrl(song) {
    return get(song && song.provider).songUrl(song.song_id);
  }

  return { netease, qq, get, resolveUrl };
}

module.exports = { createProviders };
