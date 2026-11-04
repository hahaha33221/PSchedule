import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import crypto from "node:crypto";
import { htmlToText } from "./ical.mjs";

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

    -- 조직도: 조직 단위 (위원회 › 본부 › 부 › 분과 › 팀, 5단계까지, 관리자가 관리). 멤버의 '소속' (users.unit_id) 이 됨. 분류(업무 주제)와는 따로
    CREATE TABLE IF NOT EXISTS org_units (
      id         INTEGER PRIMARY KEY,
      parent_id  INTEGER REFERENCES org_units(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      short_name TEXT NOT NULL DEFAULT '', -- 약칭 (참석자·담당자 옆 등 짧게)
      lead_id    INTEGER REFERENCES users(id) ON DELETE SET NULL, -- 책임자
      sort       INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS org_units_parent ON org_units (parent_id);
    -- 조직도의 자리 (직함·이름). PSchedule 계정과는 따로 (대부분 계정 없음), user_id 로 골라서 연결
    -- 한 사람이 여러 자리를 겸할 수 있음. name 이 비면 공석
    CREATE TABLE IF NOT EXISTS org_positions (
      id      INTEGER PRIMARY KEY,
      unit_id INTEGER NOT NULL REFERENCES org_units(id) ON DELETE CASCADE,
      title   TEXT NOT NULL DEFAULT '',
      name    TEXT NOT NULL DEFAULT '',
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      note    TEXT NOT NULL DEFAULT '',
      sort    INTEGER NOT NULL DEFAULT 0 -- 표의 순번
    );
    CREATE INDEX IF NOT EXISTS org_positions_unit ON org_positions (unit_id);
    -- 연락처 (개인정보): 다른 표와 분리해 /api/contacts 만 읽음. 조직도 자리 또는 (자리가 없는) 계정에 붙음
    -- 겸직이면 그 사람의 자리마다 같은 값을 둠 → 자리가 지워지면 함께 지워짐
    CREATE TABLE IF NOT EXISTS contacts (
      id          INTEGER PRIMARY KEY,
      position_id INTEGER UNIQUE REFERENCES org_positions(id) ON DELETE CASCADE,
      user_id     INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      mobile      TEXT NOT NULL DEFAULT '',
      office      TEXT NOT NULL DEFAULT '',
      email       TEXT NOT NULL DEFAULT '',
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- 외부 조직 연락처: 관리자가 입력, 카테고리로 묶음
    CREATE TABLE IF NOT EXISTS contact_categories (
      id   INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS external_contacts (
      id          INTEGER PRIMARY KEY,
      category_id INTEGER REFERENCES contact_categories(id) ON DELETE SET NULL,
      name        TEXT NOT NULL,
      org         TEXT NOT NULL DEFAULT '',
      title       TEXT NOT NULL DEFAULT '',
      mobile      TEXT NOT NULL DEFAULT '',
      office      TEXT NOT NULL DEFAULT '',
      email       TEXT NOT NULL DEFAULT '',
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    -- 공지를 읽은 사람 (사이드바 '공지' 옆 안 읽은 숫자)
    CREATE TABLE IF NOT EXISTS notice_reads (
      user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      notice_id INTEGER NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
      read_at   TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, notice_id)
    );
    -- 추가로 볼 수 있는 조직 (관리자가 멤버마다 지정): 소속 말고도 이 조직의 항목을 봄. sub = 1 이면 그 아래 팀까지
    CREATE TABLE IF NOT EXISTS user_view_units (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      unit_id INTEGER NOT NULL REFERENCES org_units(id) ON DELETE CASCADE,
      sub     INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (user_id, unit_id)
    );

    -- 분류: 대분류 › 중분류 › 소분류 (parent_id 로 3단계까지, 관리자가 관리). 회의·할 일·메모에 하나씩
    CREATE TABLE IF NOT EXISTS categories (
      id        INTEGER PRIMARY KEY,
      parent_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
      name      TEXT NOT NULL,
      sort      INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS categories_parent ON categories (parent_id);

    -- 외부 캘린더 (구글 캘린더 '비공개 주소(iCal 형식)'). url 은 비밀번호처럼: 관리자 화면에도 가려서만 보여 줌
    CREATE TABLE IF NOT EXISTS calendars (
      id           INTEGER PRIMARY KEY,
      name         TEXT NOT NULL,
      url          TEXT NOT NULL,
      color        INTEGER NOT NULL DEFAULT 5,
      category_id  INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      last_sync_at TEXT,    -- 마지막으로 읽으려고 한 때
      last_ok_at   TEXT,    -- 마지막으로 성공한 때
      last_error   TEXT,
      event_count  INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- 외부 캘린더에서 읽어 온 일정 (읽기 전용, 다시 읽을 때마다 통째로 바뀜). 반복 일정은 회차마다 한 줄
    CREATE TABLE IF NOT EXISTS calendar_events (
      id          INTEGER PRIMARY KEY,
      calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
      uid         TEXT NOT NULL,
      inst        TEXT NOT NULL, -- 회차 (시작 시각)
      title       TEXT NOT NULL,
      start_date  TEXT NOT NULL,
      end_date    TEXT NOT NULL,
      start_time  TEXT,
      end_time    TEXT,
      location    TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      UNIQUE (calendar_id, uid, inst)
    );
    CREATE INDEX IF NOT EXISTS calendar_events_range ON calendar_events (start_date, end_date);

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
    -- 외부 참석자 (PSchedule 계정이 없는 사람): 이름, 소속·기관, 연락처(선택)
    CREATE TABLE IF NOT EXISTS event_guests (
      id         INTEGER PRIMARY KEY,
      event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      org        TEXT NOT NULL DEFAULT '',
      contact    TEXT NOT NULL DEFAULT '',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS event_guests_event ON event_guests (event_id);
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
  addCategoryColumns(db);
  addUnitColumns(db);
  cleanCalendarHtml(db);
  seedTags(db);
  return db;
}

// 구글 캘린더에서 HTML 그대로 들어온 글 정리 (가져온 일정, 그리고 거기서 넣은 우리 일정 + 비교용 원본 내용)
export const CONTACTS_PRIVATE_DEFAULT = ["운영총괄팀", "기부후원팀"];
// 연락처 값 검사 (화면 저장·일괄 입력 공통). 오류 문구에 값을 넣지 않음
export function cleanContact(b) {
  const phone = (v, label) => {
    const s = String(v ?? "").trim();
    if (s.length > 30 || !/^[0-9+()\-.\s,/#~]*(내선\s*[0-9]*)?$/.test(s)) throw new Error(`${label} 번호를 확인해 주세요. 숫자와 - 만 써 주세요.`);
    return s;
  };
  const email = String(b.email ?? "").trim();
  if (email.length > 120 || (email && !/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(email))) throw new Error("이메일 주소를 확인해 주세요.");
  return { mobile: phone(b.mobile, "휴대전화"), office: phone(b.office, "사무실 전화"), email };
}

function cleanCalendarHtml(db) {
  const dirty = "(title LIKE '%<%>%' OR description LIKE '%<%>%' OR title LIKE '%&%;%' OR description LIKE '%&%;%')";
  const fix = (v) => (typeof v === "string" ? htmlToText(v) : v);
  for (const r of db.prepare(`SELECT id, title, description, location FROM calendar_events WHERE ${dirty}`).all()) {
    db.prepare("UPDATE calendar_events SET title = ?, description = ?, location = ? WHERE id = ?").run(fix(r.title), fix(r.description), fix(r.location), r.id);
  }
  for (const r of db.prepare(`SELECT id, title, description, src_snapshot FROM events WHERE src_calendar_id IS NOT NULL AND (${dirty} OR src_snapshot LIKE '%<%>%')`).all()) {
    let snap = r.src_snapshot;
    try { const o = JSON.parse(snap || "{}"); for (const k of ["title", "location"]) if (o[k]) o[k] = fix(o[k]); snap = JSON.stringify(o); } catch {}
    db.prepare("UPDATE events SET title = ?, description = ?, src_snapshot = ? WHERE id = ?").run(fix(r.title), fix(r.description), snap, r.id);
  }
}

// 조직도가 생기기 전에 만든 DB: users 에 소속(unit_id)·메모(note), calendars 에 소속 붙이기
// 예전 '직책'(title) 글자는 지우지 않고 메모로 옮겨 둠
function addUnitColumns(db) {
  const has = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c);
  if (!has("users", "unit_id")) db.exec("ALTER TABLE users ADD COLUMN unit_id INTEGER REFERENCES org_units(id) ON DELETE SET NULL");
  // 본부장 권한: role 은 그대로 'member' (관리자 기능 없음), 아래 조직을 보는 범위만 넓음
  if (!has("users", "director")) db.exec("ALTER TABLE users ADD COLUMN director INTEGER NOT NULL DEFAULT 0");
  if (!has("users", "note")) {
    db.exec("ALTER TABLE users ADD COLUMN note TEXT NOT NULL DEFAULT ''");
    db.exec("UPDATE users SET note = '직책: ' || title WHERE title <> ''");
  }
  if (!has("calendars", "unit_id")) db.exec("ALTER TABLE calendars ADD COLUMN unit_id INTEGER REFERENCES org_units(id) ON DELETE SET NULL");
  // 항목의 팀 (보이는 범위): 기존 항목은 만든 사람의 지금 소속, 회의에 연결된 할 일·메모는 그 회의의 팀
  for (const t of ["events", "tasks", "memos"]) {
    if (!has(t, "unit_id")) {
      db.exec(`ALTER TABLE ${t} ADD COLUMN unit_id INTEGER REFERENCES org_units(id) ON DELETE SET NULL`);
      db.exec(`UPDATE ${t} SET unit_id = (SELECT u.unit_id FROM users u WHERE u.id = ${t}.created_by)`);
      if (t !== "events") db.exec(`UPDATE ${t} SET unit_id = (SELECT e.unit_id FROM events e WHERE e.id = ${t}.meeting_id) WHERE meeting_id IS NOT NULL`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS ${t}_unit ON ${t} (unit_id)`);
  }
  // 구글 캘린더에서 '우리 소속으로 넣은' 일정: 원본 (캘린더, UID, 회차) 와 넣을 때의 원본 내용 (바뀌었는지 비교용)
  if (!has("events", "src_calendar_id")) {
    db.exec("ALTER TABLE events ADD COLUMN src_calendar_id INTEGER");
    db.exec("ALTER TABLE events ADD COLUMN src_uid TEXT");
    db.exec("ALTER TABLE events ADD COLUMN src_inst TEXT");
    db.exec("ALTER TABLE events ADD COLUMN src_snapshot TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS events_src ON events (src_calendar_id, src_uid, src_inst)");
  // 같은 이름 자리 구분: '' 아직 안 정함(같은 사람으로 셈), 이름과 같으면 같은 사람(겸직) 확인, '이름#자리id' 면 다른 사람(동명이인)
  if (!has("org_positions", "person")) db.exec("ALTER TABLE org_positions ADD COLUMN person TEXT NOT NULL DEFAULT ''");
  // 연락처 비공개 조직: 처음 한 번 두 팀을 켜 둠, 이후는 관리자가 조직 편집에서 켜고 끔
  if (!has("org_units", "contacts_private")) {
    db.exec("ALTER TABLE org_units ADD COLUMN contacts_private INTEGER NOT NULL DEFAULT 0");
    db.exec(`UPDATE org_units SET contacts_private = 1 WHERE name IN (${CONTACTS_PRIVATE_DEFAULT.map((n) => `'${n}'`).join(", ")})`);
  }
}

// 분류가 생기기 전에 만든 DB 에 category_id 열 붙이기
function addCategoryColumns(db) {
  for (const table of ["events", "tasks", "memos"]) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === "category_id")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS ${table}_category ON ${table} (category_id)`);
  }
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
