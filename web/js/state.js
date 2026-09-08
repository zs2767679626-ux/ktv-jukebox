// 全局状态缓存 + 服务器时钟校准
export const store = {
  state: null,
  servertime: 0,
  offset: 0,
  listeners: [],

  apply(msg) {
    this.state = msg.state;
    this.servertime = msg.servertime;
    this.offset = msg.servertime - Date.now();
    for (const fn of this.listeners) fn();
  },
  subscribe(fn) { this.listeners.push(fn); },
  // 服务器当前时间（用于歌词/进度，消除客户端时钟误差）
  serverNow() { return Date.now() + this.offset; },
};
