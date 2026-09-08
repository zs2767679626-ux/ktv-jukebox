'use strict';

// Task 1 临时空壳：bin/server.js 在 require 阶段就需要本模块，先保证能启动。
// Task 4 会整体替换为真实网易云封装。
function createNetease(api, opts = {}) {
  return {
    search: async () => [],
    songUrl: async () => ({ error: 'unavailable' }),
    lyric: async () => null,
    artists: async () => [],
    artistSongs: async () => [],
    toplists: async () => [],
    toplistSongs: async () => [],
    catlist: async () => [],
    stylePlaylists: async () => [],
    playlistSongs: async () => [],
  };
}
module.exports = { createNetease };
