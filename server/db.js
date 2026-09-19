import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const DEFAULT_FILE = path.join(process.cwd(), 'data', 'apex.db');

/**
 * Open (and migrate) the SQLite database.
 * @param {string} file path, or ':memory:' for tests
 */
export function openDatabase(file = process.env.DATABASE_FILE || DEFAULT_FILE) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS races (
      id           TEXT PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      track_id     TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'open',
      started_at   INTEGER NOT NULL,
      finished_at  INTEGER,
      time_ms      INTEGER,
      best_lap_ms  INTEGER,
      lap_times    TEXT,
      tick_count   INTEGER,
      replay       TEXT,
      reject_reason TEXT
    );

    CREATE INDEX IF NOT EXISTS races_leaderboard
      ON races (track_id, status, time_ms);
    CREATE INDEX IF NOT EXISTS races_by_user
      ON races (user_id, finished_at);
  `);
}

/** Best finished run per user on a track, fastest first. */
export function leaderboard(db, trackId, limit = 20) {
  return db.prepare(`
    SELECT u.username, r.id AS race_id, r.time_ms, r.best_lap_ms, r.finished_at
    FROM races r
    JOIN users u ON u.id = r.user_id
    JOIN (
      SELECT user_id, MIN(time_ms) AS best
      FROM races
      WHERE track_id = ? AND status = 'verified'
      GROUP BY user_id
    ) b ON b.user_id = r.user_id AND b.best = r.time_ms
    WHERE r.track_id = ? AND r.status = 'verified'
    GROUP BY r.user_id
    ORDER BY r.time_ms ASC, r.finished_at ASC
    LIMIT ?
  `).all(trackId, trackId, limit);
}

/** Fastest verified run on a track, replay included — used for the ghost car. */
export function fastestRun(db, trackId) {
  return db.prepare(`
    SELECT r.id, r.user_id, r.time_ms, r.replay, u.username
    FROM races r JOIN users u ON u.id = r.user_id
    WHERE r.track_id = ? AND r.status = 'verified'
    ORDER BY r.time_ms ASC, r.finished_at ASC
    LIMIT 1
  `).get(trackId);
}

export function personalBest(db, userId, trackId) {
  return db.prepare(`
    SELECT id, time_ms, best_lap_ms, replay
    FROM races
    WHERE user_id = ? AND track_id = ? AND status = 'verified'
    ORDER BY time_ms ASC
    LIMIT 1
  `).get(userId, trackId);
}

export function rankOf(db, trackId, timeMs) {
  const row = db.prepare(`
    SELECT COUNT(*) AS faster FROM (
      SELECT MIN(time_ms) AS best
      FROM races
      WHERE track_id = ? AND status = 'verified'
      GROUP BY user_id
    ) WHERE best < ?
  `).get(trackId, timeMs);
  return row.faster + 1;
}
