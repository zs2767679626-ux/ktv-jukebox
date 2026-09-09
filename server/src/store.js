'use strict';
const { DatabaseSync } = require('node:sqlite');

function createStore(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      song_id TEXT, title TEXT, artist TEXT, album TEXT, text TEXT,
      duration_ms INTEGER, fee INTEGER,
      status TEXT NOT NULL DEFAULT 'requested',
      reason TEXT,
      requested_at INTEGER NOT NULL,
      started_at INTEGER, finished_at INTEGER
    );
  `);
  // 简单键值表：网易云登录 Cookie 等运行配置（重启保留）
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  const addStmt = db.prepare(`
    INSERT INTO history (song_id,title,artist,album,text,duration_ms,fee,status,requested_at)
    VALUES (@song_id,@title,@artist,@album,@text,@duration_ms,@fee,'requested',@requested_at)`);
  const updateStmt = db.prepare(`
    UPDATE history SET status=@status, reason=@reason, started_at=@started_at, finished_at=@finished_at
    WHERE id=@id`);
  const getStmt = db.prepare(`SELECT * FROM history WHERE id=?`);
  const listStmt = db.prepare(`SELECT * FROM history ORDER BY id DESC LIMIT ?`);
  const getSetStmt = db.prepare(`SELECT value FROM settings WHERE key=?`);
  const putSetStmt = db.prepare(`INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  const delSetStmt = db.prepare(`DELETE FROM settings WHERE key=?`);

  return {
    add(song) {
      const info = addStmt.run({
        song_id: song.song_id ?? null,
        title: song.title ?? null,
        artist: song.artist ?? null,
        album: song.album ?? null,
        text: song.text ?? null,
        duration_ms: song.duration_ms ?? null,
        fee: song.fee ?? null,
        requested_at: Date.now(),
      });
      return Number(info.lastInsertRowid);
    },
    update(id, fields) {
      const cur = getStmt.get(id);
      if (!cur) return;
      updateStmt.run({
        id,
        status: fields.status ?? cur.status,
        reason: fields.reason ?? cur.reason,
        started_at: fields.started_at ?? cur.started_at,
        finished_at: fields.finished_at ?? cur.finished_at,
      });
    },
    list(limit = 50) {
      return listStmt.all(limit);
    },
    getSetting(key) {
      const row = getSetStmt.get(key);
      return row ? row.value : null;
    },
    setSetting(key, value) {
      putSetStmt.run(key, value);
    },
    deleteSetting(key) {
      delSetStmt.run(key);
    },
    close() {
      db.close();
    },
  };
}
module.exports = { createStore };
