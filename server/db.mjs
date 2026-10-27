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
      title         TEXT NOT NULL DEFAULT '', -- 직책·부서 (참석자·담당자 옆에 작게)
      pw_changed    INTEGER NOT NULL DEFAULT 0, -- 0 처음 비밀번호, 1 본인이 바꿈, 2 관리자가 임시 비밀번호 발급
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );

    -- 팀 공용 태그 (일정·할 일·메모에 붙임)
    CREATE TABLE IF NOT EXISTS tags (
      id    INTEGER PRIMARY KEY,
      name  TEXT NOT NULL UNIQUE,
      color INTEGER NOT NULL DEFAULT 0,
      sort  INTEGER NOT NULL DEFAULT 0
    );

    -- 일정: kind 'meeting'(회의) | 'event'(일반 일정). 날짜 'YYYY-MM-DD', 시간 'HH:MM' (없으면 종일)
    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY,
      kind        TEXT NOT NULL DEFAULT 'meeting' CHECK (kind IN ('meeting', 'event')),
      title       TEXT NOT NULL,
      start_date  TEXT NOT NULL,
      end_date    TEXT NOT NULL,
      start_time  TEXT,
      end_time    TEXT,
      location    TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '', -- 회의 개요
      agenda      TEXT NOT NULL DEFAULT '[]', -- 회의 안건 (문자열 배열 JSON)
      created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS events_range ON events (start_date, end_date);

    CREATE TABLE IF NOT EXISTS event_attendees (
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (event_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS event_tags (
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (event_id, tag_id)
    );
    -- 관련 문서 (링크)
    CREATE TABLE IF NOT EXISTS event_links (
      id         INTEGER PRIMARY KEY,
      event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      title      TEXT NOT NULL,
      url        TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 할 일: status todo(대기) | doing(진행중) | done(완료)
    --        meeting_id 가 있으면 phase before(회의 준비사항) | after(회의 후 할 일)
    CREATE TABLE IF NOT EXISTS tasks (
      id          INTEGER PRIMARY KEY,
      title       TEXT NOT NULL,
      due_date    TEXT,
      status      TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'done')),
      assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      meeting_id  INTEGER REFERENCES events(id) ON DELETE SET NULL,
      phase       TEXT CHECK (phase IN ('before', 'after')),
      note        TEXT NOT NULL DEFAULT '',
      created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      done_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS tasks_due ON tasks (due_date);
    CREATE INDEX IF NOT EXISTS tasks_meeting ON tasks (meeting_id);
    CREATE TABLE IF NOT EXISTS task_tags (
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, tag_id)
    );

    -- 메모: 작성한 날짜(memo_date) 기준. meeting_id 가 있으면 그 회의의 메모·참고사항
    CREATE TABLE IF NOT EXISTS memos (
      id         INTEGER PRIMARY KEY,
      body       TEXT NOT NULL,
      memo_date  TEXT NOT NULL,
      meeting_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
      important  INTEGER NOT NULL DEFAULT 0,
      task_id    INTEGER REFERENCES tasks(id) ON DELETE SET NULL, -- '할 일로 만들기' 로 생긴 할 일
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS memos_date ON memos (memo_date);
    CREATE INDEX IF NOT EXISTS memos_meeting ON memos (meeting_id);

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
  seedTags(db);
  return db;
}

// 처음 한 번, 자주 쓰는 태그 몇 개 (태그 관리에서 바꿀 수 있음)
function seedTags(db) {
  if (db.prepare("SELECT 1 FROM tags").get()) return;
  const add = db.prepare("INSERT INTO tags (name, color, sort) VALUES (?, ?, ?)");
  ["회의", "보고", "자료", "개인 업무"].forEach((name, i) => add.run(name, i, i));
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
