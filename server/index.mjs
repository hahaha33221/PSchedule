/*
 * PSchedule API 서버 (의존성 없음: node:http + node:sqlite)
 *   회의·일정, 할 일, 메모, 태그를 서로 연결해 한 화면에서 보고 고치는 팀 업무 관리
 *
 *   환경 변수
 *   - PORT            기본 8787
 *   - DATA_DIR        DB 위치, 기본 ./data
 *   - STATIC_DIR      지정하면 정적 파일도 함께 제공 (로컬 개발용: public)
 *   - DEV=1           정적 HTML에 자동 새로고침 스크립트 삽입
 *   - ADMIN_PASSWORD  처음 실행 때 만드는 master 계정 비밀번호 (없으면 임시 비밀번호를 로그에 출력)
 */
import { createServer } from "node:http";
import { createReadStream, statSync, watch } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import crypto from "node:crypto";
import { openDb, ensureAdmin, verifyPassword, hashPassword, tempPassword } from "./db.mjs";

const PORT = Number(process.env.PORT) || 8787;
const DATA_DIR = resolve(process.env.DATA_DIR || "data");
const STATIC_DIR = process.env.STATIC_DIR ? resolve(process.env.STATIC_DIR) : null;
const DEV = process.env.DEV === "1";

const SESSION_DAYS = 14; // 로그인 유지 기간
const PASSWORD_MIN = 6, PASSWORD_MAX = 64;
const MAX_BODY = 64 * 1024;
const LIMITS = {
  title: 80, location: 80, description: 3000, agendaItem: 200, agendaItems: 30, notice: 5000,
  comment: 1000, name: 20, userTitle: 20, memo: 3000, tag: 20, taskNote: 2000, linkTitle: 80, url: 1000
};
const COLORS = 6; // 태그 색 개수 (public/styles.css 의 --c0 ~ --c5)
const STATUSES = ["todo", "doing", "done"];

const db = openDb(join(DATA_DIR, "pschedule.db"));
const created = ensureAdmin(db);
if (created) console.log(`관리자 계정을 만들었어요 → 아이디 ${created.login} / 비밀번호 ${created.password} (로그인 후 바로 바꿔 주세요)`);

const q = {
  userByLogin: db.prepare("SELECT * FROM users WHERE login = ?"),
  userById: db.prepare("SELECT * FROM users WHERE id = ?"),
  session: db.prepare(`
    SELECT u.id, u.login, u.role, u.name, u.title, u.pw_changed, u.pw_hash FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`),
  addSession: db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)"),
  delSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
  delOtherSessions: db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?"),
  delUserSessions: db.prepare("DELETE FROM sessions WHERE user_id = ?"),
  purgeSessions: db.prepare("DELETE FROM sessions WHERE expires_at <= ?"),
  setPassword: db.prepare("UPDATE users SET pw_hash = ?, pw_changed = 1 WHERE id = ?"),
  resetPassword: db.prepare("UPDATE users SET pw_hash = ?, pw_changed = 2 WHERE id = ?"),
  touchLogin: db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?"),
  team: db.prepare("SELECT id, name, title FROM users ORDER BY name, id"),
  userExists: db.prepare("SELECT 1 FROM users WHERE id = ?"),

  // 태그
  tags: db.prepare("SELECT id, name, color FROM tags ORDER BY sort, id"),
  tag: db.prepare("SELECT * FROM tags WHERE id = ?"),
  tagByName: db.prepare("SELECT * FROM tags WHERE name = ?"),
  addTag: db.prepare("INSERT INTO tags (name, color, sort) VALUES (?, ?, (SELECT coalesce(max(sort), 0) + 1 FROM tags))"),
  setTag: db.prepare("UPDATE tags SET name = ?, color = ? WHERE id = ?"),
  delTag: db.prepare("DELETE FROM tags WHERE id = ?"),

  // 일정 (기간이 겹치는 것)
  events: db.prepare(`
    SELECT e.*, u.name AS author,
      (SELECT count(*) FROM tasks t WHERE t.meeting_id = e.id AND t.status <> 'done') AS open_tasks,
      (SELECT count(*) FROM memos m WHERE m.meeting_id = e.id AND m.important = 1) AS important_memos,
      (SELECT count(*) FROM comments c WHERE c.target_type = 'event' AND c.target_id = e.id) AS comments
    FROM events e LEFT JOIN users u ON u.id = e.created_by
    WHERE e.start_date <= ? AND e.end_date >= ?
    ORDER BY e.start_date, e.start_time IS NOT NULL, e.start_time, e.id`),
  event: db.prepare(`
    SELECT e.*, u.name AS author,
      (SELECT count(*) FROM tasks t WHERE t.meeting_id = e.id AND t.status <> 'done') AS open_tasks,
      (SELECT count(*) FROM memos m WHERE m.meeting_id = e.id AND m.important = 1) AS important_memos,
      (SELECT count(*) FROM comments c WHERE c.target_type = 'event' AND c.target_id = e.id) AS comments
    FROM events e LEFT JOIN users u ON u.id = e.created_by WHERE e.id = ?`),
  // 회의 고르기 (빠른 메모·할 일 연결용): 오늘 기준 앞뒤
  meetingChoices: db.prepare(`
    SELECT id, title, start_date, start_time FROM events
    WHERE kind = 'meeting' AND end_date >= ? AND start_date <= ?
    ORDER BY abs(julianday(start_date) - julianday(?)), start_time, id LIMIT 40`),
  addEvent: db.prepare(`INSERT INTO events (kind, title, start_date, end_date, start_time, end_time, location, description, agenda, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  setEvent: db.prepare(`UPDATE events SET kind = ?, title = ?, start_date = ?, end_date = ?, start_time = ?, end_time = ?,
    location = ?, description = ?, agenda = ?, updated_at = datetime('now') WHERE id = ?`),
  delEvent: db.prepare("DELETE FROM events WHERE id = ?"),
  eventTags: db.prepare("SELECT event_id AS id, tag_id FROM event_tags WHERE event_id IN (SELECT value FROM json_each(?))"),
  eventAttendees: db.prepare("SELECT event_id AS id, user_id FROM event_attendees WHERE event_id IN (SELECT value FROM json_each(?))"),
  clearEventTags: db.prepare("DELETE FROM event_tags WHERE event_id = ?"),
  addEventTag: db.prepare("INSERT OR IGNORE INTO event_tags (event_id, tag_id) SELECT ?, id FROM tags WHERE id = ?"),
  clearAttendees: db.prepare("DELETE FROM event_attendees WHERE event_id = ?"),
  addAttendee: db.prepare("INSERT OR IGNORE INTO event_attendees (event_id, user_id) SELECT ?, id FROM users WHERE id = ?"),
  links: db.prepare("SELECT id, title, url, created_at FROM event_links WHERE event_id = ? ORDER BY id"),
  link: db.prepare("SELECT * FROM event_links WHERE id = ?"),
  addLink: db.prepare("INSERT INTO event_links (event_id, title, url) VALUES (?, ?, ?)"),
  delLink: db.prepare("DELETE FROM event_links WHERE id = ?"),

  // 할 일
  taskCols: `t.*, e.title AS meeting_title, e.start_date AS meeting_date, e.start_time AS meeting_time`,
  task: null, // 아래에서
  addTask: db.prepare(`INSERT INTO tasks (title, due_date, status, assignee_id, meeting_id, phase, note, created_by, done_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'done' THEN datetime('now') END)`),
  setTask: db.prepare(`UPDATE tasks SET title = ?, due_date = ?, status = ?, assignee_id = ?, meeting_id = ?, phase = ?, note = ?,
    done_at = CASE WHEN ? = 'done' THEN coalesce(done_at, datetime('now')) END, updated_at = datetime('now') WHERE id = ?`),
  delTask: db.prepare("DELETE FROM tasks WHERE id = ?"),
  taskTags: db.prepare("SELECT task_id AS id, tag_id FROM task_tags WHERE task_id IN (SELECT value FROM json_each(?))"),
  clearTaskTags: db.prepare("DELETE FROM task_tags WHERE task_id = ?"),
  addTaskTag: db.prepare("INSERT OR IGNORE INTO task_tags (task_id, tag_id) SELECT ?, id FROM tags WHERE id = ?"),

  // 메모
  memoCols: `m.*, u.name AS author, e.title AS meeting_title, e.start_date AS meeting_date`,
  addMemo: db.prepare("INSERT INTO memos (body, memo_date, meeting_id, important, created_by) VALUES (?, ?, ?, ?, ?)"),
  setMemo: db.prepare("UPDATE memos SET body = ?, memo_date = ?, meeting_id = ?, important = ?, updated_at = datetime('now') WHERE id = ?"),
  setMemoTask: db.prepare("UPDATE memos SET task_id = ? WHERE id = ?"),
  delMemo: db.prepare("DELETE FROM memos WHERE id = ?"),

  // 공지
  notices: db.prepare(`
    SELECT n.id, n.title, substr(n.body, 1, 200) AS preview, n.pinned, n.created_at, n.updated_at, u.name AS author,
      (SELECT count(*) FROM comments c WHERE c.target_type = 'notice' AND c.target_id = n.id) AS comments
    FROM notices n LEFT JOIN users u ON u.id = n.created_by
    ORDER BY n.pinned DESC, n.created_at DESC, n.id DESC`),
  notice: db.prepare("SELECT n.*, u.name AS author FROM notices n LEFT JOIN users u ON u.id = n.created_by WHERE n.id = ?"),
  addNotice: db.prepare("INSERT INTO notices (title, body, pinned, created_by) VALUES (?, ?, ?, ?)"),
  setNotice: db.prepare("UPDATE notices SET title = ?, body = ?, pinned = ?, updated_at = datetime('now') WHERE id = ?"),
  delNotice: db.prepare("DELETE FROM notices WHERE id = ?"),

  // 댓글
  comments: db.prepare(`
    SELECT c.id, c.body, c.created_at, c.user_id, u.name AS author FROM comments c
    LEFT JOIN users u ON u.id = c.user_id
    WHERE c.target_type = ? AND c.target_id = ? ORDER BY c.created_at, c.id`),
  comment: db.prepare("SELECT * FROM comments WHERE id = ?"),
  addComment: db.prepare("INSERT INTO comments (target_type, target_id, user_id, body) VALUES (?, ?, ?, ?)"),
  delComment: db.prepare("DELETE FROM comments WHERE id = ?"),
  delComments: db.prepare("DELETE FROM comments WHERE target_type = ? AND target_id = ?"),

  // 멤버 (관리자)
  users: db.prepare("SELECT id, login, role, name, title, pw_changed, created_at, last_login_at FROM users ORDER BY role = 'admin' DESC, name, id"),
  addUser: db.prepare("INSERT INTO users (login, pw_hash, role, name, title) VALUES (?, ?, ?, ?, ?)"),
  setUser: db.prepare("UPDATE users SET name = ?, title = ?, role = ? WHERE id = ?"),
  delUser: db.prepare("DELETE FROM users WHERE id = ?"),
  adminCount: db.prepare("SELECT count(*) AS n FROM users WHERE role = 'admin'")
};

const TASK_FROM = `FROM tasks t LEFT JOIN events e ON e.id = t.meeting_id`;
const TASK_ORDER = `ORDER BY t.status = 'done', t.due_date IS NULL, t.due_date, t.id`;
Object.assign(q, {
  task: db.prepare(`SELECT ${q.taskCols} ${TASK_FROM} WHERE t.id = ?`),
  tasksAll: db.prepare(`SELECT ${q.taskCols} ${TASK_FROM} ${TASK_ORDER} LIMIT 2000`),
  tasksRange: db.prepare(`SELECT ${q.taskCols} ${TASK_FROM} WHERE t.due_date BETWEEN ? AND ? ${TASK_ORDER}`),
  tasksMeeting: db.prepare(`SELECT ${q.taskCols} ${TASK_FROM} WHERE t.meeting_id = ? ORDER BY t.phase = 'after', t.status = 'done', t.due_date IS NULL, t.due_date, t.id`),
  // 그날 할 일: 마감이 그날 / 마감 지난 미완료 / 마감 없이 그날 회의에 연결된 것
  tasksDay: db.prepare(`SELECT ${q.taskCols} ${TASK_FROM}
    WHERE t.due_date = :day
       OR (t.due_date < :day AND t.status <> 'done' AND :day = :today)
       OR (t.due_date IS NULL AND e.start_date <= :day AND e.end_date >= :day)
    ${TASK_ORDER}`),
  memo: db.prepare(`SELECT ${q.memoCols} FROM memos m LEFT JOIN users u ON u.id = m.created_by LEFT JOIN events e ON e.id = m.meeting_id WHERE m.id = ?`),
  memosDay: db.prepare(`SELECT ${q.memoCols} FROM memos m LEFT JOIN users u ON u.id = m.created_by LEFT JOIN events e ON e.id = m.meeting_id
    WHERE m.memo_date = ? ORDER BY m.important DESC, m.created_at DESC, m.id DESC`),
  memosMeeting: db.prepare(`SELECT ${q.memoCols} FROM memos m LEFT JOIN users u ON u.id = m.created_by LEFT JOIN events e ON e.id = m.meeting_id
    WHERE m.meeting_id = ? ORDER BY m.important DESC, m.created_at, m.id`),
  memosAll: db.prepare(`SELECT ${q.memoCols} FROM memos m LEFT JOIN users u ON u.id = m.created_by LEFT JOIN events e ON e.id = m.meeting_id
    WHERE (:important = 0 OR m.important = 1) ORDER BY m.memo_date DESC, m.created_at DESC, m.id DESC LIMIT 1000`)
});

/* ---------- 로그인 시도 제한 (IP별, 아이디별) ---------- */
const attempts = new Map();
const LIMIT = 10, WINDOW_MS = 10 * 60 * 1000;
function tooMany(...keys) {
  const now = Date.now();
  return keys.some((k) => {
    const a = attempts.get(k);
    return a && a.until > now && a.count >= LIMIT;
  });
}
function recordFail(...keys) {
  const now = Date.now();
  for (const k of keys) {
    const a = attempts.get(k);
    if (!a || a.until <= now) attempts.set(k, { count: 1, until: now + WINDOW_MS });
    else a.count++;
  }
}
setInterval(() => {
  const now = Date.now();
  for (const [k, a] of attempts) if (a.until <= now) attempts.delete(k);
  q.purgeSessions.run(now);
}, 10 * 60 * 1000).unref();

/* ---------- 유틸 ---------- */
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const normalizeLogin = (s) => String(s || "").normalize("NFC").trim().toLowerCase();
const bad = (message, field) => Object.assign(new Error(message), { status: 400, expose: true, field });

function clientIp(req) {
  return (
    req.headers["x-vercel-forwarded-for"] ||
    req.headers["x-real-ip"] ||
    String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket.remoteAddress
  );
}

function send(res, status, data) {
  const body = data === undefined ? "" : JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { fail(Object.assign(new Error("too large"), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => {
      try {
        const v = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
        ok(v && typeof v === "object" ? v : {});
      } catch { fail(Object.assign(new Error("bad json"), { status: 400 })); }
    });
    req.on("error", fail);
  });
}

function auth(req) {
  const m = String(req.headers.authorization || "").match(/^Bearer\s+(\S+)$/i);
  if (!m) return null;
  return q.session.get(sha256(m[1]), Date.now()) || null;
}
const tokenOf = (req) => String(req.headers.authorization).split(/\s+/)[1];

const publicUser = (u) => ({ id: u.id, login: u.login, role: u.role, name: u.name, title: u.title, mustChangePassword: u.pw_changed !== 1 });

// 입력 정리
const text = (v, max, label, required) => {
  const s = String(v ?? "").replace(/\r\n?/g, "\n").trim();
  if (required && !s) throw bad(`${label}을(를) 적어 주세요.`);
  if (s.length > max) throw bad(`${label}은(는) ${max}자까지 쓸 수 있어요.`);
  return s;
};
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z")) && new Date(s + "T00:00:00Z").toISOString().startsWith(s);
const isTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const ids = (v) => [...new Set((Array.isArray(v) ? v : []).filter((x) => Number.isInteger(x) && x > 0))].slice(0, 50);
const idOrNull = (v) => (Number.isInteger(v) && v > 0 ? v : null);
const has = (b, k) => Object.prototype.hasOwnProperty.call(b, k);
const parseAgenda = (s) => { try { const a = JSON.parse(s); return Array.isArray(a) ? a.filter((x) => typeof x === "string") : []; } catch { return []; } };

// 여러 행의 태그/참석자를 한 번에
function groupBy(stmt, list, key) {
  const map = new Map(list.map((r) => [r.id, []]));
  if (!list.length) return map;
  for (const r of stmt.all(JSON.stringify(list.map((x) => x.id)))) map.get(r.id)?.push(r[key]);
  return map;
}
function inTx(fn) {
  db.exec("BEGIN");
  try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; }
}

/* ----- 일정 ----- */
// PATCH 는 기존 값에 바뀐 값만 덮어써서 전체를 다시 검사
function eventInput(b, cur) {
  const get = (k, curVal) => (has(b, k) ? b[k] : curVal);
  const kind = get("kind", cur?.kind ?? "meeting") === "event" ? "event" : "meeting";
  const title = text(get("title", cur?.title), LIMITS.title, "제목", true);
  const start = get("startDate", cur?.start_date);
  const end = get("endDate", has(b, "startDate") && !has(b, "endDate") && cur && cur.start_date === cur.end_date ? start : cur?.end_date ?? start) || start;
  if (!isDate(start)) throw bad("시작 날짜를 확인해 주세요.");
  if (!isDate(end) || end < start) throw bad("끝나는 날짜는 시작 날짜와 같거나 뒤여야 해요.");
  const st = get("startTime", cur?.start_time) || null;
  const et = st ? get("endTime", cur?.end_time) || null : null;
  if (st && !isTime(st)) throw bad("시작 시간을 확인해 주세요.");
  if (et && !isTime(et)) throw bad("끝나는 시간을 확인해 주세요.");
  if (st && et && start === end && et < st) throw bad("끝나는 시간이 시작 시간보다 빨라요.");
  const agendaRaw = has(b, "agenda") ? b.agenda : parseAgenda(cur?.agenda ?? "[]");
  if (!Array.isArray(agendaRaw)) throw bad("안건을 확인해 주세요.");
  const agenda = agendaRaw.map((x) => text(x, LIMITS.agendaItem, "안건")).filter(Boolean);
  if (agenda.length > LIMITS.agendaItems) throw bad(`안건은 ${LIMITS.agendaItems}개까지 적을 수 있어요.`);
  return [kind, title, start, end, st, et,
    text(get("location", cur?.location), LIMITS.location, "장소"),
    text(get("description", cur?.description), LIMITS.description, "개요"),
    JSON.stringify(agenda)];
}
function saveEventRelations(id, b) {
  if (has(b, "tagIds")) { q.clearEventTags.run(id); for (const t of ids(b.tagIds)) q.addEventTag.run(id, t); }
  if (has(b, "attendeeIds")) { q.clearAttendees.run(id); for (const u of ids(b.attendeeIds)) q.addAttendee.run(id, u); }
}
function eventsOut(rows, user) {
  const tags = groupBy(q.eventTags, rows, "tag_id");
  const att = groupBy(q.eventAttendees, rows, "user_id");
  return rows.map((e) => ({
    id: e.id, kind: e.kind, title: e.title, startDate: e.start_date, endDate: e.end_date, startTime: e.start_time, endTime: e.end_time,
    location: e.location, tagIds: tags.get(e.id), attendeeIds: att.get(e.id), author: e.author, createdBy: e.created_by,
    openTasks: e.open_tasks, importantMemos: e.important_memos, comments: e.comments,
    canDelete: user.role === "admin" || e.created_by === user.id
  }));
}

/* ----- 할 일 ----- */
function taskInput(b, cur) {
  const get = (k, curVal) => (has(b, k) ? b[k] : curVal);
  const title = text(get("title", cur?.title), LIMITS.title, "할 일", true);
  const due = get("dueDate", cur?.due_date) || null;
  if (due && !isDate(due)) throw bad("마감일을 확인해 주세요.");
  const status = get("status", cur?.status ?? "todo");
  if (!STATUSES.includes(status)) throw bad("상태를 확인해 주세요.");
  const assignee = idOrNull(get("assigneeId", cur?.assignee_id));
  if (assignee && !q.userExists.get(assignee)) throw bad("담당자를 찾을 수 없어요.");
  const meeting = idOrNull(get("meetingId", cur?.meeting_id));
  if (meeting && !q.event.get(meeting)) throw bad("연결할 회의를 찾을 수 없어요.");
  const phase = meeting ? (get("phase", cur?.phase) === "before" ? "before" : "after") : null;
  return [title, due, status, assignee, meeting, phase, text(get("note", cur?.note), LIMITS.taskNote, "메모")];
}
function saveTaskTags(id, b) {
  if (has(b, "tagIds")) { q.clearTaskTags.run(id); for (const t of ids(b.tagIds)) q.addTaskTag.run(id, t); }
}
function tasksOut(rows, user) {
  const tags = groupBy(q.taskTags, rows, "tag_id");
  return rows.map((t) => ({
    id: t.id, title: t.title, dueDate: t.due_date, status: t.status, assigneeId: t.assignee_id,
    meetingId: t.meeting_id, meetingTitle: t.meeting_title, meetingDate: t.meeting_date, meetingTime: t.meeting_time,
    phase: t.phase, note: t.note, tagIds: tags.get(t.id), doneAt: t.done_at, createdBy: t.created_by,
    canDelete: user.role === "admin" || t.created_by === user.id || t.assignee_id === user.id
  }));
}

/* ----- 메모 ----- */
const memoOut = (m, user) => ({
  id: m.id, body: m.body, date: m.memo_date, meetingId: m.meeting_id, meetingTitle: m.meeting_title, meetingDate: m.meeting_date,
  important: !!m.important, taskId: m.task_id, author: m.author || "(탈퇴한 멤버)", createdAt: m.created_at, updatedAt: m.updated_at,
  canEdit: user.role === "admin" || m.created_by === user.id
});
function memoInput(b, cur) {
  const get = (k, curVal) => (has(b, k) ? b[k] : curVal);
  const body = text(get("body", cur?.body), LIMITS.memo, "메모", true);
  const date = get("date", cur?.memo_date);
  if (!isDate(date)) throw bad("메모 날짜를 확인해 주세요.");
  const meeting = idOrNull(get("meetingId", cur?.meeting_id));
  if (meeting && !q.event.get(meeting)) throw bad("연결할 회의를 찾을 수 없어요.");
  return [body, date, meeting, get("important", !!cur?.important) ? 1 : 0];
}

const commentOut = (c, user) => ({
  id: c.id, body: c.body, author: c.author || "(탈퇴한 멤버)", createdAt: c.created_at, mine: c.user_id === user.id,
  canDelete: user.role === "admin" || c.user_id === user.id
});

function eventDetail(e, user) {
  return {
    event: { ...eventsOut([e], user)[0], description: e.description, agenda: parseAgenda(e.agenda), createdAt: e.created_at, updatedAt: e.updated_at },
    tasks: tasksOut(q.tasksMeeting.all(e.id), user),
    memos: q.memosMeeting.all(e.id).map((m) => memoOut(m, user)),
    links: q.links.all(e.id).map((l) => ({ id: l.id, title: l.title, url: l.url, createdAt: l.created_at })),
    comments: q.comments.all("event", e.id).map((c) => commentOut(c, user))
  };
}

/* ---------- API ---------- */
async function api(req, res, path) {
  const method = req.method;
  const url = new URL(req.url, "http://localhost");
  const param = (k) => url.searchParams.get(k);

  if (path === "/api/health" && method === "GET") return send(res, 200, { ok: true });

  if (path === "/api/login" && method === "POST") {
    const { login, password } = await readJson(req);
    const id = normalizeLogin(login);
    const ip = "ip:" + clientIp(req), key = "id:" + id;
    if (tooMany(ip, key)) return send(res, 429, { error: "로그인 시도가 너무 많아요. 10분 뒤에 다시 시도해 주세요." });
    const user = id && q.userByLogin.get(id);
    const ok = user && typeof password === "string" && verifyPassword(password.trim(), user.pw_hash);
    if (!ok) {
      recordFail(ip, key);
      return send(res, 401, { error: "아이디 또는 비밀번호를 다시 확인해 주세요." });
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + SESSION_DAYS * 86400 * 1000;
    q.addSession.run(sha256(token), user.id, expiresAt);
    q.touchLogin.run(user.id);
    return send(res, 200, { token, expiresAt, user: publicUser(user) });
  }

  const user = auth(req);
  if (!user) return send(res, 401, { error: "로그인이 필요해요." });
  const isAdmin = user.role === "admin";

  if (path === "/api/logout" && method === "POST") {
    q.delSession.run(sha256(tokenOf(req)));
    return send(res, 204);
  }

  // 화면을 그리는 데 늘 필요한 것: 나, 팀원, 태그
  if (path === "/api/me" && method === "GET") {
    return send(res, 200, { user: publicUser(user), team: q.team.all(), tags: q.tags.all() });
  }

  // 비밀번호 변경 (본인)
  if (path === "/api/password" && method === "POST") {
    const { current, next } = await readJson(req);
    const key = "pw:" + user.id;
    if (tooMany(key)) return send(res, 429, { error: "시도가 너무 많아요. 10분 뒤에 다시 시도해 주세요." });
    if (typeof current !== "string" || !verifyPassword(current.trim(), user.pw_hash)) {
      recordFail(key);
      return send(res, 400, { error: "지금 비밀번호가 맞지 않아요.", field: "current" });
    }
    const pw = typeof next === "string" ? next.trim() : "";
    if (pw.length < PASSWORD_MIN || pw.length > PASSWORD_MAX) {
      return send(res, 400, { error: `새 비밀번호는 ${PASSWORD_MIN}자 이상으로 정해 주세요.`, field: "next" });
    }
    if (pw === current.trim()) return send(res, 400, { error: "지금 비밀번호와 다른 비밀번호로 정해 주세요.", field: "next" });
    q.setPassword.run(hashPassword(pw), user.id);
    q.delOtherSessions.run(user.id, sha256(tokenOf(req))); // 다른 기기 로그인은 끊기
    return send(res, 200, { ok: true });
  }

  /* ----- 태그 (팀 공용, 누구나 관리) ----- */
  if (path === "/api/tags" && method === "POST") {
    const b = await readJson(req);
    const name = text(b.name, LIMITS.tag, "태그 이름", true);
    if (q.tagByName.get(name)) throw bad("이미 있는 태그예요.");
    const color = Number.isInteger(b.color) && b.color >= 0 && b.color < COLORS ? b.color : 0;
    const r = q.addTag.run(name, color);
    return send(res, 201, { tag: { id: Number(r.lastInsertRowid), name, color }, tags: q.tags.all() });
  }
  const tm = path.match(/^\/api\/tags\/(\d+)$/);
  if (tm) {
    const t = q.tag.get(Number(tm[1]));
    if (!t) return send(res, 404, { error: "태그를 찾을 수 없어요." });
    if (method === "PATCH") {
      const b = await readJson(req);
      const name = has(b, "name") ? text(b.name, LIMITS.tag, "태그 이름", true) : t.name;
      const other = q.tagByName.get(name);
      if (other && other.id !== t.id) throw bad("이미 있는 태그예요.");
      const color = Number.isInteger(b.color) && b.color >= 0 && b.color < COLORS ? b.color : t.color;
      q.setTag.run(name, color, t.id);
      return send(res, 200, { tags: q.tags.all() });
    }
    if (method === "DELETE") {
      q.delTag.run(t.id); // 붙어 있던 곳에서도 빠짐
      return send(res, 200, { tags: q.tags.all() });
    }
    return send(res, 405, { error: "Method not allowed" });
  }

  /* ----- 일정·회의 ----- */
  if (path === "/api/events" && method === "GET") {
    const from = param("from"), to = param("to");
    if (!isDate(from) || !isDate(to) || to < from) return send(res, 400, { error: "기간을 확인해 주세요." });
    return send(res, 200, { events: eventsOut(q.events.all(to, from), user) });
  }
  if (path === "/api/meetings/choices" && method === "GET") {
    const d = isDate(param("date")) ? param("date") : new Date().toISOString().slice(0, 10);
    const day = (n) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
    return send(res, 200, {
      meetings: q.meetingChoices.all(day(-30), day(60), d).map((m) => ({ id: m.id, title: m.title, startDate: m.start_date, startTime: m.start_time }))
    });
  }
  if (path === "/api/events" && method === "POST") {
    const b = await readJson(req);
    const id = inTx(() => {
      const r = q.addEvent.run(...eventInput(b), user.id);
      const id = Number(r.lastInsertRowid);
      if (!has(b, "attendeeIds")) b.attendeeIds = [user.id];
      saveEventRelations(id, b);
      return id;
    });
    return send(res, 201, eventDetail(q.event.get(id), user));
  }
  const em = path.match(/^\/api\/events\/(\d+)(?:\/(comments|links))?$/);
  if (em) {
    const e = q.event.get(Number(em[1]));
    if (!e) return send(res, 404, { error: "일정을 찾을 수 없어요. 지워졌을 수 있어요." });
    if (em[2] === "comments") {
      if (method !== "POST") return send(res, 405, { error: "Method not allowed" });
      const body = text((await readJson(req)).body, LIMITS.comment, "댓글", true);
      q.addComment.run("event", e.id, user.id, body);
      return send(res, 201, { comments: q.comments.all("event", e.id).map((c) => commentOut(c, user)) });
    }
    if (em[2] === "links") {
      if (method !== "POST") return send(res, 405, { error: "Method not allowed" });
      const b = await readJson(req);
      const link = text(b.url, LIMITS.url, "주소", true);
      if (!/^https?:\/\//i.test(link)) throw bad("http:// 또는 https:// 로 시작하는 주소를 넣어 주세요.");
      q.addLink.run(e.id, text(b.title, LIMITS.linkTitle, "이름") || link.replace(/^https?:\/\//i, "").slice(0, 60), link);
      return send(res, 201, { links: q.links.all(e.id).map((l) => ({ id: l.id, title: l.title, url: l.url, createdAt: l.created_at })) });
    }
    if (method === "GET") return send(res, 200, eventDetail(e, user));
    // 고치기는 팀 누구나 (회의록을 함께 채우므로), 지우기는 올린 사람·관리자
    if (method === "PATCH") {
      const b = await readJson(req);
      inTx(() => {
        q.setEvent.run(...eventInput(b, e), e.id);
        saveEventRelations(e.id, b);
      });
      return send(res, 200, eventDetail(q.event.get(e.id), user));
    }
    if (method === "DELETE") {
      if (!isAdmin && e.created_by !== user.id) return send(res, 403, { error: "직접 올린 일정만 지울 수 있어요." });
      inTx(() => { q.delComments.run("event", e.id); q.delEvent.run(e.id); });
      return send(res, 204);
    }
    return send(res, 405, { error: "Method not allowed" });
  }
  const lm = path.match(/^\/api\/links\/(\d+)$/);
  if (lm && method === "DELETE") {
    q.delLink.run(Number(lm[1]));
    return send(res, 204);
  }

  /* ----- 할 일 ----- */
  if (path === "/api/tasks" && method === "GET") {
    let rows;
    if (isDate(param("date"))) rows = q.tasksDay.all({ day: param("date"), today: isDate(param("today")) ? param("today") : "" });
    else if (isDate(param("from")) && isDate(param("to"))) rows = q.tasksRange.all(param("from"), param("to"));
    else rows = q.tasksAll.all();
    return send(res, 200, { tasks: tasksOut(rows, user) });
  }
  if (path === "/api/tasks" && method === "POST") {
    const b = await readJson(req);
    const input = taskInput(b);
    const id = inTx(() => {
      const r = q.addTask.run(...input, user.id, input[2]);
      const id = Number(r.lastInsertRowid);
      saveTaskTags(id, b);
      return id;
    });
    return send(res, 201, { task: tasksOut([q.task.get(id)], user)[0] });
  }
  const km = path.match(/^\/api\/tasks\/(\d+)$/);
  if (km) {
    const t = q.task.get(Number(km[1]));
    if (!t) return send(res, 404, { error: "할 일을 찾을 수 없어요. 지워졌을 수 있어요." });
    if (method === "GET") return send(res, 200, { task: tasksOut([t], user)[0] });
    if (method === "PATCH") {
      const b = await readJson(req);
      const input = taskInput(b, t);
      inTx(() => { q.setTask.run(...input, input[2], t.id); saveTaskTags(t.id, b); });
      return send(res, 200, { task: tasksOut([q.task.get(t.id)], user)[0] });
    }
    if (method === "DELETE") {
      if (!isAdmin && t.created_by !== user.id && t.assignee_id !== user.id) return send(res, 403, { error: "직접 만들었거나 맡은 할 일만 지울 수 있어요." });
      q.delTask.run(t.id);
      return send(res, 204);
    }
    return send(res, 405, { error: "Method not allowed" });
  }

  /* ----- 메모 ----- */
  if (path === "/api/memos" && method === "GET") {
    let rows;
    if (isDate(param("date"))) rows = q.memosDay.all(param("date"));
    else if (Number(param("meeting")) > 0) rows = q.memosMeeting.all(Number(param("meeting")));
    else rows = q.memosAll.all({ important: param("important") === "1" ? 1 : 0 });
    return send(res, 200, { memos: rows.map((m) => memoOut(m, user)) });
  }
  if (path === "/api/memos" && method === "POST") {
    const r = q.addMemo.run(...memoInput(await readJson(req)), user.id);
    return send(res, 201, { memo: memoOut(q.memo.get(Number(r.lastInsertRowid)), user) });
  }
  const mm = path.match(/^\/api\/memos\/(\d+)(\/task)?$/);
  if (mm) {
    const m = q.memo.get(Number(mm[1]));
    if (!m) return send(res, 404, { error: "메모를 찾을 수 없어요. 지워졌을 수 있어요." });
    // 메모 → 할 일로 만들기 (원래 회의에 자동 연결)
    if (mm[2]) {
      if (method !== "POST") return send(res, 405, { error: "Method not allowed" });
      const b = await readJson(req);
      const input = taskInput({ title: b.title || m.body.split("\n")[0].slice(0, LIMITS.title), dueDate: b.dueDate, assigneeId: b.assigneeId, meetingId: m.meeting_id, phase: "after", note: m.body.includes("\n") ? m.body : "" });
      const id = inTx(() => {
        const id = Number(q.addTask.run(...input, user.id, input[2]).lastInsertRowid);
        saveTaskTags(id, b);
        q.setMemoTask.run(id, m.id);
        return id;
      });
      return send(res, 201, { task: tasksOut([q.task.get(id)], user)[0], memo: memoOut(q.memo.get(m.id), user) });
    }
    if (method === "PATCH" || method === "DELETE") {
      if (!isAdmin && m.created_by !== user.id) return send(res, 403, { error: "직접 쓴 메모만 고칠 수 있어요." });
    }
    if (method === "PATCH") {
      q.setMemo.run(...memoInput(await readJson(req), m), m.id);
      return send(res, 200, { memo: memoOut(q.memo.get(m.id), user) });
    }
    if (method === "DELETE") {
      q.delMemo.run(m.id);
      return send(res, 204);
    }
    return send(res, 405, { error: "Method not allowed" });
  }

  /* ----- 공지 ----- */
  if (path === "/api/notices" && method === "GET") {
    return send(res, 200, {
      notices: q.notices.all().map((n) => ({
        id: n.id, title: n.title, preview: n.preview, pinned: !!n.pinned, author: n.author,
        comments: n.comments, createdAt: n.created_at, updatedAt: n.updated_at
      }))
    });
  }
  const noticeInput = (b) => [text(b.title, LIMITS.title, "제목", true), text(b.body, LIMITS.notice, "내용", true), b.pinned ? 1 : 0];
  if (path === "/api/notices" && method === "POST") {
    if (!isAdmin) return send(res, 403, { error: "공지는 관리자만 쓸 수 있어요." });
    const r = q.addNotice.run(...noticeInput(await readJson(req)), user.id);
    return send(res, 201, { id: Number(r.lastInsertRowid) });
  }
  const nm = path.match(/^\/api\/notices\/(\d+)(\/comments)?$/);
  if (nm) {
    const n = q.notice.get(Number(nm[1]));
    if (!n) return send(res, 404, { error: "공지를 찾을 수 없어요. 지워졌을 수 있어요." });
    if (nm[2]) {
      if (method !== "POST") return send(res, 405, { error: "Method not allowed" });
      const body = text((await readJson(req)).body, LIMITS.comment, "댓글", true);
      q.addComment.run("notice", n.id, user.id, body);
      return send(res, 201, { comments: q.comments.all("notice", n.id).map((c) => commentOut(c, user)) });
    }
    if (method === "GET") {
      return send(res, 200, {
        notice: { id: n.id, title: n.title, body: n.body, pinned: !!n.pinned, author: n.author, createdAt: n.created_at, updatedAt: n.updated_at, canEdit: isAdmin },
        comments: q.comments.all("notice", n.id).map((c) => commentOut(c, user))
      });
    }
    if (!isAdmin) return send(res, 403, { error: "공지는 관리자만 고칠 수 있어요." });
    if (method === "PUT") {
      q.setNotice.run(...noticeInput(await readJson(req)), n.id);
      return send(res, 200, { ok: true });
    }
    if (method === "DELETE") {
      inTx(() => { q.delComments.run("notice", n.id); q.delNotice.run(n.id); });
      return send(res, 204);
    }
    return send(res, 405, { error: "Method not allowed" });
  }

  const cm = path.match(/^\/api\/comments\/(\d+)$/);
  if (cm && method === "DELETE") {
    const c = q.comment.get(Number(cm[1]));
    if (!c) return send(res, 204);
    if (!isAdmin && c.user_id !== user.id) return send(res, 403, { error: "직접 쓴 댓글만 지울 수 있어요." });
    q.delComment.run(c.id);
    return send(res, 204);
  }

  /* ----- 관리자: 멤버 계정 ----- */
  if (path.startsWith("/api/admin/")) {
    if (!isAdmin) return send(res, 403, { error: "관리자만 볼 수 있어요." });

    if (path === "/api/admin/users" && method === "GET") {
      return send(res, 200, {
        users: q.users.all().map((u) => ({
          id: u.id, login: u.login, role: u.role, name: u.name, title: u.title, pwChanged: u.pw_changed === 1,
          createdAt: u.created_at, lastLoginAt: u.last_login_at, me: u.id === user.id
        }))
      });
    }
    if (path === "/api/admin/users" && method === "POST") {
      const b = await readJson(req);
      const login = normalizeLogin(b.login);
      if (!/^[a-z0-9._-]{3,20}$/.test(login)) throw bad("아이디는 영문 소문자·숫자·._- 로 3~20자로 정해 주세요.", "login");
      const name = text(b.name, LIMITS.name, "이름", true);
      const title = text(b.title, LIMITS.userTitle, "직책");
      const role = b.role === "admin" ? "admin" : "member";
      if (q.userByLogin.get(login)) throw bad("이미 있는 아이디예요.", "login");
      const password = tempPassword();
      q.addUser.run(login, hashPassword(password), role, name, title);
      console.log(`[admin] ${user.login} → ${login} 계정 발급`);
      return send(res, 201, { login, name, password });
    }
    const um = path.match(/^\/api\/admin\/users\/(\d+)(\/reset-password)?$/);
    if (um) {
      const target = q.userById.get(Number(um[1]));
      if (!target) return send(res, 404, { error: "계정을 찾을 수 없어요." });
      if (um[2] && method === "POST") {
        const password = tempPassword();
        q.resetPassword.run(hashPassword(password), target.id);
        q.delUserSessions.run(target.id);
        console.log(`[admin] ${user.login} → ${target.login} 임시 비밀번호 발급`);
        return send(res, 200, { login: target.login, name: target.name, password });
      }
      const lastAdmin = target.role === "admin" && q.adminCount.get().n <= 1;
      if (!um[2] && method === "PATCH") {
        const b = await readJson(req);
        const name = b.name === undefined ? target.name : text(b.name, LIMITS.name, "이름", true);
        const title = b.title === undefined ? target.title : text(b.title, LIMITS.userTitle, "직책");
        const role = b.role === "admin" || b.role === "member" ? b.role : target.role;
        if (lastAdmin && role !== "admin") throw bad("관리자가 한 명은 있어야 해요.");
        q.setUser.run(name, title, role, target.id);
        return send(res, 200, { ok: true });
      }
      if (!um[2] && method === "DELETE") {
        if (target.id === user.id) throw bad("내 계정은 지울 수 없어요.");
        if (lastAdmin) throw bad("관리자가 한 명은 있어야 해요.");
        q.delUser.run(target.id); // 쓴 일정·할 일·메모는 남고 작성자·담당자만 비워짐
        return send(res, 204);
      }
    }
    return send(res, 404, { error: "Not found" });
  }

  return send(res, 404, { error: "Not found" });
}

/* ---------- 정적 파일 (로컬 개발용) ---------- */
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json"
};
const reloadClients = new Set();
if (STATIC_DIR && DEV) {
  let t;
  watch(STATIC_DIR, { recursive: true }, () => {
    clearTimeout(t);
    t = setTimeout(() => { for (const r of reloadClients) r.write("data: reload\n\n"); }, 80);
  });
}

function serveStatic(req, res, pathname) {
  if (DEV && pathname === "/__reload") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.write(": connected\n\n");
    reloadClients.add(res);
    req.on("close", () => reloadClients.delete(res));
    return;
  }
  let file = normalize(join(STATIC_DIR, decodeURIComponent(pathname)));
  if (!file.startsWith(STATIC_DIR)) return res.writeHead(403).end();
  try {
    if (statSync(file).isDirectory()) file = join(file, "index.html");
    statSync(file);
  } catch {
    return res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }
  const type = TYPES[extname(file).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
  if (DEV && type.startsWith("text/html")) {
    let html = "";
    createReadStream(file, "utf8").on("data", (c) => (html += c)).on("end", () =>
      res.end(html.replace("</body>", '<script>new EventSource("/__reload").onmessage=()=>location.reload()</script></body>'))
    );
  } else createReadStream(file).pipe(res);
}

/* ---------- 서버 ---------- */
createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  try {
    if (pathname.startsWith("/api/")) return await api(req, res, pathname);
    if (STATIC_DIR) return serveStatic(req, res, pathname);
    send(res, 404, { error: "Not found" });
  } catch (e) {
    if (!res.headersSent) {
      send(res, e.status || 500, e.expose ? { error: e.message, field: e.field } : { error: e.status ? "잘못된 요청이에요." : "서버 오류가 났어요." });
    }
    if (!e.status) console.error(e);
  }
}).listen(PORT, () => {
  console.log(`PSchedule 서버: http://localhost:${PORT}${STATIC_DIR ? " (정적 파일 포함)" : ""}`);
});
