import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import crypto from "node:crypto";

export function openDb(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY,
      login         TEXT NOT NULL UNIQUE,
      pw_hash       TEXT NOT NULL,
      role          TEXT NOT NULL CHECK (role IN ('member', 'admin')),
      name          TEXT NOT NULL,
      pw_changed    INTEGER NOT NULL DEFAULT 0, -- 0 처음 비밀번호, 1 본인이 바꿈, 2 관리자가 임시 비밀번호 발급
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );

    -- 일정: 날짜는 'YYYY-MM-DD', 시간은 'HH:MM' (없으면 종일)
    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY,
      title       TEXT NOT NULL,
      start_date  TEXT NOT NULL,
      end_date    TEXT NOT NULL,
      start_time  TEXT,
      end_time    TEXT,
      location    TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      color       INTEGER NOT NULL DEFAULT 0,
      created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS events_range ON events (start_date, end_date);

    CREATE TABLE IF NOT EXISTS notices (
      id         INTEGER PRIMARY KEY,
      title      TEXT NOT NULL,
      body       TEXT NOT NULL,
      pinned     INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 댓글: 일정(event) 또는 공지(notice) 에 달림
    CREATE TABLE IF NOT EXISTS comments (
      id          INTEGER PRIMARY KEY,
      target_type TEXT NOT NULL CHECK (target_type IN ('event', 'notice')),
      target_id   INTEGER NOT NULL,
      user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      body        TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS comments_target ON comments (target_type, target_id);
  `);
  return db;
}

/* ---------- 비밀번호 ---------- */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = crypto.scryptSync(password, Buffer.from(salt, "base64"), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export const tempPassword = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");

/*
 * 관리자 계정이 하나도 없으면 'master' 를 만듭니다.
 * 비밀번호는 ADMIN_PASSWORD 환경 변수, 없으면 임시 비밀번호를 만들어 로그에 한 번만 보여 줍니다.
 */
export function ensureAdmin(db) {
  if (db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) return null;
  const given = (process.env.ADMIN_PASSWORD || "").trim();
  const password = given || tempPassword();
  db.prepare("INSERT INTO users (login, pw_hash, role, name) VALUES ('master', ?, 'admin', '관리자')").run(hashPassword(password));
  return { login: "master", password: given ? "(ADMIN_PASSWORD 값)" : password };
}
