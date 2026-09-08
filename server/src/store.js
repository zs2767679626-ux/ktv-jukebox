'use strict';

// Task 1 临时空壳：bin/server.js 在 require 阶段就需要本模块，先保证能启动。
// Task 2 会整体替换为 sql.js 真实实现（含 add/update/list/close）。
function createStore(dbPath) {
  return {
    add() { return 1; },
    update() {},
    list() { return []; },
    close() {},
  };
}
module.exports = { createStore };
