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
 *   - CALENDAR_SYNC_MINUTES  외부(구글) 캘린더 다시 읽는 간격, 기본 20분
 *   - BACKUP_DIR / BACKUP_KEEP_DAYS / BACKUP_HOUR  자동 백업 (server/backup.mjs 참고)
 */
import { createServer } from "node:http";
import { createReadStream, statSync, watch } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import crypto from "node:crypto";
import { cleanContact, openDb, ensureAdmin, verifyPassword, hashPassword, tempPassword } from "./db.mjs";
import { createCalendarSync, checkUrl, maskUrl } from "./calendars.mjs";
import { startAutoBackup, listBackups, backupNow, pruneBackups } from "./backup.mjs";

const PORT = Number(process.env.PORT) || 8787;
const DATA_DIR = resolve(process.env.DATA_DIR || "data");
const STATIC_DIR = process.env.STATIC_DIR ? resolve(process.env.STATIC_DIR) : null;
const DEV = process.env.DEV === "1";
const BACKUP_DIR = resolve(process.env.BACKUP_DIR || join(DATA_DIR, "backups"));
const BACKUP_KEEP_DAYS = process.env.BACKUP_KEEP_DAYS === undefined ? 30 : Number(process.env.BACKUP_KEEP_DAYS) || 0;
const BACKUP_HOUR = Number(process.env.BACKUP_HOUR ?? 4);

const SESSION_DAYS = 14; // 로그인 유지 기간
const PASSWORD_MIN = 6, PASSWORD_MAX = 64;
const MAX_BODY = 64 * 1024;
const LIMITS = {
  title: 80, location: 80, description: 3000, agendaItem: 200, agendaItems: 30, notice: 5000,
  comment: 1000, name: 20, userTitle: 20, memo: 3000, tag: 20, category: 30, calendarName: 30, unitName: 30, unitShort: 12, userNote: 200, guestName: 30, guestOrg: 40, guestContact: 60, guests: 50, posTitle: 30, posName: 30, posNote: 200, taskNote: 2000, linkTitle: 80, url: 1000
};
const COLORS = 6; // 태그 색 개수 (public/styles.css 의 --c0 ~ --c5)
const STATUSES = ["todo", "doing", "done"];
const CATEGORY_DEPTH = 3; // 대분류 › 중분류 › 소분류
const UNIT_DEPTH = 5;     // 조직도는 5단계까지 (위원회 › 본부 › 부 › 분과 › 팀)

const db = openDb(join(DATA_DIR, "pschedule.db"));

/* ---------- 보이는 범위 (팀별 제한) ----------
 * 멤버: 자기 소속 조직과 그 아래 팀의 항목 + 다른 팀이어도 내가 관련된 것 (만든 것, 참석하는 회의, 맡은 할 일, 쓴 메모,
 *       그리고 볼 수 있는 회의에 붙은 할 일·메모). 소속이 없으면 내 것만. 관리자는 모두.
 * 회의·일정·할 일·메모를 읽고 쓰는 쿼리는 모두 아래 조건을 :admin, :uid, :units (볼 수 있는 조직 id JSON) 로 씀
 */
const IN_UNITS = (col) => `${col} IN (SELECT value FROM json_each(:units))`;
const EV_VIS = (e) => `(:admin = 1 OR ${IN_UNITS(`${e}.unit_id`)} OR ${e}.created_by = :uid
  OR EXISTS (SELECT 1 FROM event_attendees va WHERE va.event_id = ${e}.id AND va.user_id = :uid))`;
const TASK_VIS = (t) => `(:admin = 1 OR ${IN_UNITS(`${t}.unit_id`)} OR ${t}.created_by = :uid OR ${t}.assignee_id = :uid
  OR EXISTS (SELECT 1 FROM events ve WHERE ve.id = ${t}.meeting_id AND ${EV_VIS("ve")}))`;
const MEMO_VIS = (m) => `(:admin = 1 OR ${IN_UNITS(`${m}.unit_id`)} OR ${m}.created_by = :uid
  OR EXISTS (SELECT 1 FROM events ve WHERE ve.id = ${m}.meeting_id AND ${EV_VIS("ve")}))`;
// 가져온 구글 캘린더: 팀을 안 정한 캘린더는 '공용' (모두)
const EXT_VIS = (c) => `(:admin = 1 OR ${c}.unit_id IS NULL OR ${IN_UNITS(`${c}.unit_id`)})`;
const extV = (v) => ({ admin: v.admin, units: v.units });
const created = ensureAdmin(db);
if (created) console.log(`관리자 계정을 만들었어요 → 아이디 ${created.login} / 비밀번호 ${created.password} (로그인 후 바로 바꿔 주세요)`);
const calendarSync = createCalendarSync(db);
calendarSync.start(process.env.CALENDAR_SYNC_MINUTES);
startAutoBackup(db, { dir: BACKUP_DIR, keepDays: BACKUP_KEEP_DAYS, hour: BACKUP_HOUR });

const q = {
  userByLogin: db.prepare("SELECT * FROM users WHERE login = ?"),
  userById: db.prepare("SELECT * FROM users WHERE id = ?"),
  session: db.prepare(`
    SELECT u.id, u.login, u.role, u.director, u.name, u.unit_id, u.pw_changed, u.pw_hash FROM sessions s
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
  team: db.prepare("SELECT id, name, unit_id FROM users ORDER BY name, id"),
  userExists: db.prepare("SELECT 1 FROM users WHERE id = ?"),

  // 태그
  // uses: 일정·할 일에 붙은 횟수 (사이드바 '자주 쓰는 태그' 순서)
  tags: db.prepare(`SELECT t.id, t.name, t.color,
    (SELECT count(*) FROM event_tags x WHERE x.tag_id = t.id) + (SELECT count(*) FROM task_tags x WHERE x.tag_id = t.id) AS uses
    FROM tags t ORDER BY t.sort, t.id`),
  tag: db.prepare("SELECT * FROM tags WHERE id = ?"),
  tagByName: db.prepare("SELECT * FROM tags WHERE name = ?"),
  addTag: db.prepare("INSERT INTO tags (name, color, sort) VALUES (?, ?, (SELECT coalesce(max(sort), 0) + 1 FROM tags))"),
  setTag: db.prepare("UPDATE tags SET name = ?, color = ? WHERE id = ?"),
  delTag: db.prepare("DELETE FROM tags WHERE id = ?"),

  // 조직도
  units: db.prepare("SELECT id, parent_id, name, short_name, lead_id FROM org_units ORDER BY sort, id"),
  contactUsers: db.prepare("SELECT id, name, role, unit_id FROM users ORDER BY id"),
  contacts: db.prepare("SELECT position_id, user_id, mobile, office, email FROM contacts ORDER BY updated_at DESC, id DESC"),
  addContact: db.prepare("INSERT INTO contacts (position_id, user_id, mobile, office, email) VALUES (?, ?, ?, ?, ?)"),
  delContactOfPosition: db.prepare("DELETE FROM contacts WHERE position_id = ?"),
  delContactOfUser: db.prepare("DELETE FROM contacts WHERE user_id = ?"),
  contactCategories: db.prepare("SELECT id, name FROM contact_categories ORDER BY sort, id"),
  contactCategory: db.prepare("SELECT * FROM contact_categories WHERE id = ?"),
  contactCategoryByName: db.prepare("SELECT id FROM contact_categories WHERE name = ?"),
  addContactCategory: db.prepare("INSERT INTO contact_categories (name, sort) VALUES (?, (SELECT coalesce(max(sort), 0) + 1 FROM contact_categories))"),
  setContactCategory: db.prepare("UPDATE contact_categories SET name = ? WHERE id = ?"),
  delContactCategory: db.prepare("DELETE FROM contact_categories WHERE id = ?"),
  externals: db.prepare("SELECT * FROM external_contacts ORDER BY name, id"),
  external: db.prepare("SELECT * FROM external_contacts WHERE id = ?"),
  addExternal: db.prepare("INSERT INTO external_contacts (category_id, name, org, title, mobile, office, email) VALUES (?, ?, ?, ?, ?, ?, ?)"),
  setExternal: db.prepare("UPDATE external_contacts SET category_id = ?, name = ?, org = ?, title = ?, mobile = ?, office = ?, email = ?, updated_at = datetime('now') WHERE id = ?"),
  delExternal: db.prepare("DELETE FROM external_contacts WHERE id = ?"),
  unit: db.prepare("SELECT * FROM org_units WHERE id = ?"),
  unitByName: db.prepare("SELECT * FROM org_units WHERE name = ? AND parent_id IS ?"),
  unitSiblings: db.prepare("SELECT * FROM org_units WHERE parent_id IS ? ORDER BY sort, id"),
  addUnit: db.prepare("INSERT INTO org_units (parent_id, name, short_name, lead_id, sort) VALUES (?, ?, ?, ?, (SELECT coalesce(max(sort), 0) + 1 FROM org_units WHERE parent_id IS ?))"),
  setUnit: db.prepare("UPDATE org_units SET name = ?, short_name = ?, lead_id = ? WHERE id = ?"),
  setUnitPlace: db.prepare("UPDATE org_units SET parent_id = ?, sort = ? WHERE id = ?"),
  delUnit: db.prepare("DELETE FROM org_units WHERE id = ?"),
  // 지우는 조직의 아래 조직·멤버·캘린더는 한 단계 위로
  liftUnitChildren: db.prepare("UPDATE org_units SET parent_id = ? WHERE parent_id = ?"),
  liftUnitUsers: db.prepare("UPDATE users SET unit_id = ? WHERE unit_id = ?"),
  liftUnitCalendars: db.prepare("UPDATE calendars SET unit_id = ? WHERE unit_id = ?"),
  liftUnitPositions: db.prepare("UPDATE org_positions SET unit_id = ? WHERE unit_id = ?"),
  liftUnitItems: ["events", "tasks", "memos"].map((t) => db.prepare(`UPDATE ${t} SET unit_id = ? WHERE unit_id = ?`)),
  // 조직도 자리
  positions: db.prepare("SELECT * FROM org_positions ORDER BY sort, id"),
  position: db.prepare("SELECT * FROM org_positions WHERE id = ?"),
  addPosition: db.prepare("INSERT INTO org_positions (unit_id, title, name, user_id, note, sort) VALUES (?, ?, ?, ?, ?, ?)"),
  setPosition: db.prepare("UPDATE org_positions SET unit_id = ?, title = ?, name = ?, user_id = ?, note = ? WHERE id = ?"),
  setPositionSort: db.prepare("UPDATE org_positions SET sort = ? WHERE id = ?"),
  setPositionPerson: db.prepare("UPDATE org_positions SET person = ? WHERE id = ?"),
  delPosition: db.prepare("DELETE FROM org_positions WHERE id = ?"),
  maxPositionSort: db.prepare("SELECT coalesce(max(sort), 0) AS n FROM org_positions"),
  linkedInUnits: db.prepare("SELECT DISTINCT user_id AS id FROM org_positions WHERE user_id IS NOT NULL AND unit_id IN (SELECT value FROM json_each(?))"),
  setting: db.prepare("SELECT value FROM settings WHERE key = ?"),
  setSetting: db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"),
  setUserUnitIfEmpty: db.prepare("UPDATE users SET unit_id = ? WHERE id = ? AND unit_id IS NULL"),
  setUserUnit: db.prepare("UPDATE users SET unit_id = ? WHERE id = ?"),
  viewUnits: db.prepare("SELECT unit_id, sub FROM user_view_units WHERE user_id = ? ORDER BY rowid"),
  allViewUnits: db.prepare("SELECT user_id, unit_id, sub FROM user_view_units ORDER BY rowid"),
  clearViewUnits: db.prepare("DELETE FROM user_view_units WHERE user_id = ?"),
  addViewUnit: db.prepare("INSERT OR REPLACE INTO user_view_units (user_id, unit_id, sub) VALUES (?, ?, ?)"),
  usersInUnits: db.prepare("SELECT id FROM users WHERE unit_id IN (SELECT value FROM json_each(?)) ORDER BY name, id"),
  calendarsInUnits: db.prepare("SELECT count(*) AS n FROM calendars WHERE unit_id IN (SELECT value FROM json_each(?))"),

  // 분류
  categories: db.prepare("SELECT id, parent_id, name FROM categories ORDER BY sort, id"),
  category: db.prepare("SELECT * FROM categories WHERE id = ?"),
  categoryByName: db.prepare("SELECT * FROM categories WHERE name = ? AND parent_id IS ?"),
  siblings: db.prepare("SELECT * FROM categories WHERE parent_id IS ? ORDER BY sort, id"),
  addCategory: db.prepare("INSERT INTO categories (parent_id, name, sort) VALUES (?, ?, (SELECT coalesce(max(sort), 0) + 1 FROM categories WHERE parent_id IS ?))"),
  setCategoryName: db.prepare("UPDATE categories SET name = ? WHERE id = ?"),
  setCategorySort: db.prepare("UPDATE categories SET sort = ? WHERE id = ?"),
  delCategory: db.prepare("DELETE FROM categories WHERE id = ?"),
  // 지우는 분류(와 그 아래)에 붙어 있던 회의·할 일·메모는 한 단계 위 분류로
  moveCategoryItems: ["events", "tasks", "memos"].map((t) => db.prepare(`UPDATE ${t} SET category_id = ? WHERE category_id IN (SELECT value FROM json_each(?))`)),

  // 외부 캘린더 (주소 url 은 관리자 API 에서도 maskUrl 로만 내보냄)
  calendars: db.prepare("SELECT * FROM calendars ORDER BY id"),
  calendar: db.prepare("SELECT * FROM calendars WHERE id = ?"),
  addCalendar: db.prepare("INSERT INTO calendars (name, url, color, category_id, unit_id) VALUES (?, ?, ?, ?, ?)"),
  setCalendar: db.prepare("UPDATE calendars SET name = ?, url = ?, color = ?, category_id = ?, unit_id = ? WHERE id = ?"),
  delCalendar: db.prepare("DELETE FROM calendars WHERE id = ?"),
  externalRange: db.prepare(`SELECT x.*, c.name AS calendar_name, c.color, c.category_id, c.unit_id FROM calendar_events x JOIN calendars c ON c.id = x.calendar_id
    WHERE x.start_date <= ? AND x.end_date >= ? AND ${EXT_VIS("c")}
      -- 우리 소속으로 넣은 원본은 숨김 (넣은 우리 일정이 보이는 사람에게만): 같은 일정이 두 번 보이지 않게
      AND NOT EXISTS (SELECT 1 FROM events ie WHERE ie.src_calendar_id = x.calendar_id AND ie.src_uid = x.uid AND ie.src_inst = x.inst AND ${EV_VIS("ie")})
    ORDER BY x.start_date, x.start_time IS NOT NULL, x.start_time, x.id LIMIT 3000`),
  // 검색에서 숨길 원본: 보이는 우리 일정으로 이미 넣은 것
  importedKeys: db.prepare(`SELECT e.src_calendar_id AS cal, e.src_uid AS uid_, e.src_inst AS inst FROM events e WHERE e.src_calendar_id IS NOT NULL AND ${EV_VIS("e")}`),
  external: db.prepare(`SELECT x.*, c.name AS calendar_name, c.color, c.category_id, c.unit_id, c.last_ok_at FROM calendar_events x JOIN calendars c ON c.id = x.calendar_id WHERE x.id = ?`),

  // 일정 (기간이 겹치는 것)
  events: db.prepare(`
    SELECT e.*, u.name AS author,
      (SELECT count(*) FROM tasks t WHERE t.meeting_id = e.id AND t.status <> 'done') AS open_tasks,
      (SELECT count(*) FROM memos m WHERE m.meeting_id = e.id AND m.important = 1) AS important_memos,
      (SELECT count(*) FROM comments c WHERE c.target_type = 'event' AND c.target_id = e.id) AS comments
    FROM events e LEFT JOIN users u ON u.id = e.created_by
    WHERE e.start_date <= ? AND e.end_date >= ? AND ${EV_VIS("e")}
    ORDER BY e.start_date, e.start_time IS NOT NULL, e.start_time, e.id`),
  // 이 사용자가 볼 수 있는지 (상세·수정 전에)
  eventVis: db.prepare(`SELECT 1 FROM events e WHERE e.id = :id AND ${EV_VIS("e")}`),
  taskVis: db.prepare(`SELECT 1 FROM tasks t WHERE t.id = :id AND ${TASK_VIS("t")}`),
  memoVis: db.prepare(`SELECT 1 FROM memos m WHERE m.id = :id AND ${MEMO_VIS("m")}`),
  extVis: db.prepare(`SELECT 1 FROM calendar_events x JOIN calendars c ON c.id = x.calendar_id WHERE x.id = :id AND ${EXT_VIS("c")}`),
  setEventUnit: db.prepare("UPDATE events SET unit_id = ? WHERE id = ?"),
  // 구글 캘린더 일정 → 우리 소속 일정 (원본 연결)
  importedFrom: db.prepare(`SELECT e.id, e.unit_id FROM events e WHERE e.src_calendar_id = :cal AND e.src_uid = :uid_ AND e.src_inst = :inst AND ${EV_VIS("e")}`),
  importedAny: db.prepare("SELECT id, unit_id FROM events WHERE src_calendar_id = ? AND src_uid = ? AND src_inst = ?"),
  sourceNow: db.prepare("SELECT x.*, c.name AS calendar_name FROM calendar_events x JOIN calendars c ON c.id = x.calendar_id WHERE x.calendar_id = ? AND x.uid = ? AND x.inst = ?"),
  setEventSource: db.prepare("UPDATE events SET src_calendar_id = ?, src_uid = ?, src_inst = ?, src_snapshot = ? WHERE id = ?"),
  setEventFromSource: db.prepare(`UPDATE events SET title = ?, start_date = ?, end_date = ?, start_time = ?, end_time = ?, location = ?, src_snapshot = ?, updated_at = datetime('now') WHERE id = ?`),
  setTaskUnit: db.prepare("UPDATE tasks SET unit_id = ? WHERE id = ?"),
  setMemoUnit: db.prepare("UPDATE memos SET unit_id = ? WHERE id = ?"),
  // 관리자 전체 대시보드: 팀별 요약 (항목의 팀 기준, 팀 없음은 null)
  overviewMeetings: db.prepare("SELECT unit_id, count(*) AS n FROM events WHERE kind = 'meeting' AND start_date <= ? AND end_date >= ? GROUP BY unit_id"),
  overviewTasks: db.prepare("SELECT unit_id, sum(status <> 'done') AS open, sum(status <> 'done' AND due_date < ?) AS late FROM tasks GROUP BY unit_id"),
  event: db.prepare(`
    SELECT e.*, u.name AS author,
      (SELECT count(*) FROM tasks t WHERE t.meeting_id = e.id AND t.status <> 'done') AS open_tasks,
      (SELECT count(*) FROM memos m WHERE m.meeting_id = e.id AND m.important = 1) AS important_memos,
      (SELECT count(*) FROM comments c WHERE c.target_type = 'event' AND c.target_id = e.id) AS comments
    FROM events e LEFT JOIN users u ON u.id = e.created_by WHERE e.id = ?`),
  // 회의 고르기 (빠른 메모·할 일 연결용): 오늘 기준 앞뒤
  meetingChoices: db.prepare(`
    SELECT e.id, e.title, e.start_date, e.start_time FROM events e
    WHERE e.kind = 'meeting' AND e.end_date >= ? AND e.start_date <= ? AND ${EV_VIS("e")}
    ORDER BY abs(julianday(e.start_date) - julianday(?)), e.start_time, e.id LIMIT 40`),
  addEvent: db.prepare(`INSERT INTO events (kind, title, start_date, end_date, start_time, end_time, location, description, agenda, category_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  setEvent: db.prepare(`UPDATE events SET kind = ?, title = ?, start_date = ?, end_date = ?, start_time = ?, end_time = ?,
    location = ?, description = ?, agenda = ?, category_id = ?, updated_at = datetime('now') WHERE id = ?`),
  delEvent: db.prepare("DELETE FROM events WHERE id = ?"),
  eventTags: db.prepare("SELECT event_id AS id, tag_id FROM event_tags WHERE event_id IN (SELECT value FROM json_each(?))"),
  eventAttendees: db.prepare("SELECT event_id AS id, user_id FROM event_attendees WHERE event_id IN (SELECT value FROM json_each(?))"),
  clearEventTags: db.prepare("DELETE FROM event_tags WHERE event_id = ?"),
  addEventTag: db.prepare("INSERT OR IGNORE INTO event_tags (event_id, tag_id) SELECT ?, id FROM tags WHERE id = ?"),
  clearAttendees: db.prepare("DELETE FROM event_attendees WHERE event_id = ?"),
  addAttendee: db.prepare("INSERT OR IGNORE INTO event_attendees (event_id, user_id) SELECT ?, id FROM users WHERE id = ?"),
  links: db.prepare("SELECT id, title, url, created_at FROM event_links WHERE event_id = ? ORDER BY id"),
  guests: db.prepare("SELECT id, name, org, contact FROM event_guests WHERE event_id = ? ORDER BY id"),
  guest: db.prepare("SELECT * FROM event_guests WHERE id = ?"),
  addGuest: db.prepare("INSERT INTO event_guests (event_id, name, org, contact, created_by) VALUES (?, ?, ?, ?, ?)"),
  delGuest: db.prepare("DELETE FROM event_guests WHERE id = ?"),
  guestCount: db.prepare("SELECT event_id AS id, name FROM event_guests WHERE event_id IN (SELECT value FROM json_each(?)) ORDER BY id"),
  link: db.prepare("SELECT * FROM event_links WHERE id = ?"),
  addLink: db.prepare("INSERT INTO event_links (event_id, title, url) VALUES (?, ?, ?)"),
  delLink: db.prepare("DELETE FROM event_links WHERE id = ?"),

  // 할 일
  taskCols: `t.*, e.title AS meeting_title, e.start_date AS meeting_date, e.start_time AS meeting_time`,
  task: null, // 아래에서
  addTask: db.prepare(`INSERT INTO tasks (title, due_date, status, assignee_id, meeting_id, phase, note, category_id, created_by, done_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'done' THEN datetime('now') END)`),
  setTask: db.prepare(`UPDATE tasks SET title = ?, due_date = ?, status = ?, assignee_id = ?, meeting_id = ?, phase = ?, note = ?, category_id = ?,
    done_at = CASE WHEN ? = 'done' THEN coalesce(done_at, datetime('now')) END, updated_at = datetime('now') WHERE id = ?`),
  delTask: db.prepare("DELETE FROM tasks WHERE id = ?"),
  taskTags: db.prepare("SELECT task_id AS id, tag_id FROM task_tags WHERE task_id IN (SELECT value FROM json_each(?))"),
  clearTaskTags: db.prepare("DELETE FROM task_tags WHERE task_id = ?"),
  addTaskTag: db.prepare("INSERT OR IGNORE INTO task_tags (task_id, tag_id) SELECT ?, id FROM tags WHERE id = ?"),

  // 메모
  memoCols: `m.*, u.name AS author, e.title AS meeting_title, e.start_date AS meeting_date`,
  addMemo: db.prepare("INSERT INTO memos (body, memo_date, meeting_id, important, category_id, created_by) VALUES (?, ?, ?, ?, ?, ?)"),
  setMemo: db.prepare("UPDATE memos SET body = ?, memo_date = ?, meeting_id = ?, important = ?, category_id = ?, updated_at = datetime('now') WHERE id = ?"),
  setMemoTask: db.prepare("UPDATE memos SET task_id = ? WHERE id = ?"),
  delMemo: db.prepare("DELETE FROM memos WHERE id = ?"),

  // 공지
  notices: db.prepare(`
    SELECT n.id, n.title, substr(n.body, 1, 200) AS preview, n.pinned, n.created_at, n.updated_at, u.name AS author,
      (SELECT count(*) FROM comments c WHERE c.target_type = 'notice' AND c.target_id = n.id) AS comments,
      NOT EXISTS (SELECT 1 FROM notice_reads r WHERE r.notice_id = n.id AND r.user_id = ?) AS unread
    FROM notices n LEFT JOIN users u ON u.id = n.created_by
    ORDER BY n.pinned DESC, n.created_at DESC, n.id DESC`),
  notice: db.prepare("SELECT n.*, u.name AS author FROM notices n LEFT JOIN users u ON u.id = n.created_by WHERE n.id = ?"),
  unreadNotices: db.prepare("SELECT count(*) AS n FROM notices n WHERE NOT EXISTS (SELECT 1 FROM notice_reads r WHERE r.notice_id = n.id AND r.user_id = ?)"),
  readNotice: db.prepare("INSERT OR IGNORE INTO notice_reads (user_id, notice_id) VALUES (?, ?)"),
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
  setUserDirector: db.prepare("UPDATE users SET director = ? WHERE id = ?"),
  positionUnitsOf: db.prepare("SELECT DISTINCT unit_id AS id FROM org_positions WHERE user_id = ?"),
  users: db.prepare("SELECT id, login, role, director, name, unit_id, note, pw_changed, created_at, last_login_at FROM users ORDER BY role = 'admin' DESC, name, id"),
  addUser: db.prepare("INSERT INTO users (login, pw_hash, role, name, unit_id, note) VALUES (?, ?, ?, ?, ?, ?)"),
  setUser: db.prepare("UPDATE users SET name = ?, unit_id = ?, note = ?, role = ? WHERE id = ?"),
  delUser: db.prepare("DELETE FROM users WHERE id = ?"),
  adminCount: db.prepare("SELECT count(*) AS n FROM users WHERE role = 'admin'")
};

const TASK_FROM = `FROM tasks t LEFT JOIN events e ON e.id = t.meeting_id`;
const TASK_ORDER = `ORDER BY t.status = 'done', t.due_date IS NULL, t.due_date, t.id`;
Object.assign(q, {
  task: db.prepare(`SELECT ${q.taskCols} ${TASK_FROM} WHERE t.id = ?`),
  tasksAll: db.prepare(`SELECT ${q.taskCols} ${TASK_FROM} WHERE ${TASK_VIS("t")} ${TASK_ORDER} LIMIT 2000`),
  tasksRange: db.prepare(`SELECT ${q.taskCols} ${TASK_FROM} WHERE t.due_date BETWEEN ? AND ? AND ${TASK_VIS("t")} ${TASK_ORDER}`),
  tasksMeeting: db.prepare(`SELECT ${q.taskCols} ${TASK_FROM} WHERE t.meeting_id = ? ORDER BY t.phase = 'after', t.status = 'done', t.due_date IS NULL, t.due_date, t.id`),
  // 그날 할 일: 마감이 그날 / 마감 지난 미완료 / 마감 없이 그날 회의에 연결된 것
  tasksDay: db.prepare(`SELECT ${q.taskCols} ${TASK_FROM}
    WHERE (t.due_date = :day
       OR (t.due_date < :day AND t.status <> 'done' AND :day = :today)
       OR (t.due_date IS NULL AND e.start_date <= :day AND e.end_date >= :day))
      AND ${TASK_VIS("t")}
    ${TASK_ORDER}`),
  memo: db.prepare(`SELECT ${q.memoCols} FROM memos m LEFT JOIN users u ON u.id = m.created_by LEFT JOIN events e ON e.id = m.meeting_id WHERE m.id = ?`),
  memosDay: db.prepare(`SELECT ${q.memoCols} FROM memos m LEFT JOIN users u ON u.id = m.created_by LEFT JOIN events e ON e.id = m.meeting_id
    WHERE m.memo_date = ? AND ${MEMO_VIS("m")} ORDER BY m.important DESC, m.created_at DESC, m.id DESC`),
  memosMeeting: db.prepare(`SELECT ${q.memoCols} FROM memos m LEFT JOIN users u ON u.id = m.created_by LEFT JOIN events e ON e.id = m.meeting_id
    WHERE m.meeting_id = ? ORDER BY m.important DESC, m.created_at, m.id`),
  memosAll: db.prepare(`SELECT ${q.memoCols} FROM memos m LEFT JOIN users u ON u.id = m.created_by LEFT JOIN events e ON e.id = m.meeting_id
    WHERE (:important = 0 OR m.important = 1) AND ${MEMO_VIS("m")} ORDER BY m.memo_date DESC, m.created_at DESC, m.id DESC LIMIT 1000`)
});

// 소속 화면: 팀원(json 배열)이 참석하는 회의 · 맡은 할 일 · 쓴 메모
const EVENT_COLS = `e.*, u.name AS author,
      (SELECT count(*) FROM tasks t WHERE t.meeting_id = e.id AND t.status <> 'done') AS open_tasks,
      (SELECT count(*) FROM memos m WHERE m.meeting_id = e.id AND m.important = 1) AS important_memos,
      (SELECT count(*) FROM comments c WHERE c.target_type = 'event' AND c.target_id = e.id) AS comments`;
const MEMO_FROM = `FROM memos m LEFT JOIN users u ON u.id = m.created_by LEFT JOIN events e ON e.id = m.meeting_id`;
Object.assign(q, {
  unitMeetings: db.prepare(`SELECT ${EVENT_COLS} FROM events e LEFT JOIN users u ON u.id = e.created_by
    WHERE e.kind = 'meeting' AND e.start_date <= :to AND e.end_date >= :from
      AND EXISTS (SELECT 1 FROM event_attendees a WHERE a.event_id = e.id AND a.user_id IN (SELECT value FROM json_each(:ids)))
      AND ${EV_VIS("e")}
    ORDER BY e.start_date, e.start_time IS NOT NULL, e.start_time, e.id`),
  unitTasks: db.prepare(`SELECT ${q.taskCols} ${TASK_FROM} WHERE t.status <> 'done' AND t.assignee_id IN (SELECT value FROM json_each(:ids)) AND ${TASK_VIS("t")} ${TASK_ORDER}`),
  unitMemos: db.prepare(`SELECT ${q.memoCols} ${MEMO_FROM} WHERE m.created_by IN (SELECT value FROM json_each(:ids)) AND ${MEMO_VIS("m")} ORDER BY m.important DESC, m.created_at DESC, m.id DESC LIMIT 30`),
  unitImportant: db.prepare(`SELECT count(*) AS n FROM memos m WHERE m.important = 1 AND m.created_by IN (SELECT value FROM json_each(:ids)) AND ${MEMO_VIS("m")}`),
  // 검색: 볼 수 있는 항목 id
  visEventIds: db.prepare(`SELECT e.id FROM events e WHERE ${EV_VIS("e")}`),
  visTaskIds: db.prepare(`SELECT t.id FROM tasks t WHERE ${TASK_VIS("t")}`),
  visMemoIds: db.prepare(`SELECT m.id FROM memos m WHERE ${MEMO_VIS("m")}`),
  visCalendarIds: db.prepare(`SELECT c.id FROM calendars c WHERE ${EXT_VIS("c")}`)
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

const roleOut = (u) => (u.director ? "director" : u.role); // 화면·API 에서는 멤버 / 본부장 / 관리자
const publicUser = (u) => ({ id: u.id, login: u.login, role: roleOut(u), name: u.name, unitId: u.unit_id, viewUnits: viewUnitsOut(u.id), mustChangePassword: u.pw_changed !== 1 });
const teamOut = () => q.team.all().map((u) => ({ id: u.id, name: u.name, unitId: u.unit_id }));

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

/* ----- 조직도 ----- */
const unitsOut = () => q.units.all().map((u) => ({ id: u.id, parentId: u.parent_id, name: u.name, short: u.short_name, leadId: u.lead_id }));
function unitDepth(id) { // 맨 위가 1
  let n = 0;
  for (let u = q.unit.get(id); u; u = u.parent_id ? q.unit.get(u.parent_id) : null) n++;
  return n;
}
function unitSubtree(id) {
  const all = q.units.all(), out = [id];
  for (let i = 0; i < out.length; i++) for (const u of all) if (u.parent_id === out[i]) out.push(u.id);
  return out;
}
function unitHeight(id) { // 자기 포함 아래로 몇 단계
  const kids = q.unitSiblings.all(id);
  return 1 + (kids.length ? Math.max(...kids.map((k) => unitHeight(k.id))) : 0);
}
const unitIdOrNull = (v) => {
  const id = idOrNull(v);
  if (id && !q.unit.get(id)) throw bad("조직을 찾을 수 없어요. 지워졌을 수 있어요.");
  return id;
};
function addUnit(parentId, raw, short = "", leadId = null) {
  const name = text(raw, LIMITS.unitName, "조직 이름", true);
  if (parentId && !q.unit.get(parentId)) throw bad("상위 조직을 찾을 수 없어요.");
  if (parentId && unitDepth(parentId) >= UNIT_DEPTH) throw bad(`조직은 ${UNIT_DEPTH}단계까지 만들 수 있어요.`);
  const same = q.unitByName.get(name, parentId);
  if (same) return { id: same.id, created: false };
  const id = Number(q.addUnit.run(parentId, name, text(short, LIMITS.unitShort, "약칭"), leadId, parentId).lastInsertRowid);
  return { id, created: true };
}
// 조직을 parentId 아래 index 번째로 옮기기 (끌어서 놓기)
function placeUnit(u, parentId, index) {
  if (parentId) {
    if (unitSubtree(u.id).includes(parentId)) throw bad("자기 아래 조직으로는 옮길 수 없어요.");
    if (unitDepth(parentId) + unitHeight(u.id) > UNIT_DEPTH) throw bad(`옮기면 ${UNIT_DEPTH}단계를 넘어요.`);
  }
  const sibs = q.unitSiblings.all(parentId).filter((x) => x.id !== u.id);
  const at = Number.isInteger(index) ? Math.max(0, Math.min(index, sibs.length)) : sibs.length;
  sibs.splice(at, 0, u);
  sibs.forEach((x, i) => q.setUnitPlace.run(parentId, i + 1, x.id));
}

// 조직의 사람: 소속(unit_id)으로 정한 계정 + 그 조직 자리에 연결한 계정
function unitUserIds(scopeIds) {
  const scope = JSON.stringify(scopeIds);
  const set = new Set(q.usersInUnits.all(scope).map((x) => x.id));
  for (const x of q.linkedInUnits.all(scope)) set.add(x.id);
  return [...set];
}

/* ----- 연락처 (개인정보): 로그인한 사람 모두 조직도 전체를 봄. 값은 로그에 남기지 않음 -----
 * 사람 = 화면의 personKey 와 같음: 연결한 계정 → 동명이인 구분(person) → 이름
 * 고치기는 관리자와 본인만. 공석 자리는 번호 없이 줄만 나옴 */
function contactPeople() {
  const people = new Map();
  const person = (key) => {
    if (!people.has(key)) people.set(key, { key, positions: [], user: null, contact: null });
    return people.get(key);
  };
  for (const p of q.positions.all()) {
    if (p.name) person(p.user_id ? "u" + p.user_id : "n" + (p.person || p.name)).positions.push(p);
  }
  for (const u of q.contactUsers.all()) person("u" + u.id).user = u;
  const atPosition = new Map(), atUser = new Map();
  for (const c of q.contacts.all()) { if (c.position_id) atPosition.set(c.position_id, c); else atUser.set(c.user_id, c); }
  for (const who of people.values()) {
    who.contact = who.positions.map((p) => atPosition.get(p.id)).find(Boolean) || (who.user && atUser.get(who.user.id)) || null;
  }
  return people;
}
const contactOut = (who) => ({ mobile: who.contact?.mobile || "", office: who.contact?.office || "", email: who.contact?.email || "" });
function contactsFor(viewer) {
  const people = contactPeople();
  const rows = [];
  for (const who of people.values()) {
    const mine = who.user?.id === viewer.id;
    const ref = who.user ? "u" + who.user.id : "p" + who.positions[0].id;
    for (const p of who.positions) rows.push({ ref, name: p.name, title: p.title, unitId: p.unit_id, sort: p.sort, mine, ...contactOut(who) });
    // 자리가 없는 계정: 소속으로 한 줄 (관리자 계정은 입력했거나 나일 때만)
    if (!who.positions.length && (who.user.role !== "admin" || mine || who.contact)) rows.push({ ref, name: who.user.name, title: "", unitId: who.user.unit_id, sort: Infinity, mine, ...contactOut(who) });
  }
  for (const p of q.positions.all()) if (!p.name) rows.push({ ref: null, vacant: true, name: "", title: p.title, unitId: p.unit_id, sort: p.sort, mine: false, mobile: "", office: "", email: "" });
  rows.sort((a, b) => a.sort - b.sort);
  // 외부 조직 연락처: 로그인한 사람 모두 (관리자가 입력)
  const external = q.externals.all().map((e) => ({ ref: "e" + e.id, external: true, categoryId: e.category_id, org: e.org, name: e.name, title: e.title, unitId: null, mine: false, mobile: e.mobile, office: e.office, email: e.email }));
  return { rows: [...rows.map(({ sort, ...r }) => r), ...external], categories: q.contactCategories.all(), me: { ref: "u" + viewer.id, ...contactOut(people.get("u" + viewer.id)) } };
}
function externalInput(b) {
  const category = idOrNull(b.categoryId);
  if (category && !q.contactCategory.get(category)) throw bad("카테고리를 찾을 수 없어요.");
  const v = contactInput(b);
  return [category, text(b.name, 40, "이름", true), text(b.org, 60, "소속"), text(b.title, 40, "직함"), v.mobile, v.office, v.email];
}
function contactInput(b) {
  try { return cleanContact(b); } catch (e) { throw bad(e.message); }
}
// 한 사람의 값을 그 사람의 자리마다 저장 (자리가 없으면 계정에)
function saveContact(who, v) {
  for (const p of who.positions) q.delContactOfPosition.run(p.id);
  if (who.user) q.delContactOfUser.run(who.user.id);
  if (!v.mobile && !v.office && !v.email) return;
  if (who.positions.length) for (const p of who.positions) q.addContact.run(p.id, null, v.mobile, v.office, v.email);
  else q.addContact.run(null, who.user.id, v.mobile, v.office, v.email);
}

/* ----- 조직도 자리 (엑셀 표: 본부 | 부서('부' 또는 '부 / 팀') | 직함 | 이름 | 비고) ----- */
const positionsOut = () => q.positions.all().map((p) => ({ id: p.id, unitId: p.unit_id, title: p.title, name: p.name, userId: p.user_id, note: p.note, sort: p.sort, person: p.person }));
const orgOut = () => ({ units: unitsOut(), positions: positionsOut(), baseDate: q.setting.get("org_base_date")?.value || "" });
const cleanName = (v) => String(v ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
function rootUnit() {
  const roots = q.unitSiblings.all(null);
  return roots[0] ? roots[0].id : addUnit(null, "조직위원회").id;
}
function findDescendant(parentId, name) { // 분과 아래로 옮겨 둔 팀도 찾음 (가까운 것 먼저)
  const queue = [parentId];
  while (queue.length) {
    const kids = q.unitSiblings.all(queue.shift());
    const hit = kids.find((k) => k.name === name);
    if (hit) return hit.id;
    queue.push(...kids.map((k) => k.id));
  }
  return null;
}
// 본부·부·팀 이름 → 조직 id (없으면 만듦). '공통'·'위원회 직속' 은 위원회, '본부 직속' 은 본부
function resolveUnit(hqRaw, deptRaw, teamRaw) {
  const hq = cleanName(hqRaw), dept = cleanName(deptRaw), team = cleanName(teamRaw);
  const root = rootUnit();
  if (!hq || hq === "공통" || hq === q.unit.get(root).name) {
    if (!dept || /직속$/.test(dept)) return root;
  }
  const hqId = !hq || hq === "공통" ? root : (q.unitByName.get(hq, root)?.id ?? addUnit(root, hq).id);
  if (!dept || /직속$/.test(dept)) return hqId;
  const deptId = q.unitByName.get(dept, hqId)?.id ?? addUnit(hqId, dept).id;
  if (!team) return deptId;
  return findDescendant(deptId, team) ?? addUnit(deptId, team).id;
}
// 엑셀 '부서' 칸: '재무부 / 재무관리팀'
const splitDept = (v) => { const [d, ...t] = String(v ?? "").split("/").map((x) => x.trim()); return [d || "", t.join(" / ")]; };
function positionInput(b, cur) {
  const get = (k, c) => (has(b, k) ? b[k] : c);
  let unit = cur?.unit_id;
  if (has(b, "path")) { const [d, t] = has(b.path, "team") ? [b.path.dept, b.path.team] : splitDept(b.path.dept); unit = resolveUnit(b.path.hq, d, t); }
  else if (has(b, "unitId")) unit = unitIdOrNull(b.unitId);
  if (!unit) unit = rootUnit();
  const user = idOrNull(get("userId", cur?.user_id));
  if (user && !q.userExists.get(user)) throw bad("계정을 찾을 수 없어요.");
  return [unit, text(get("title", cur?.title), LIMITS.posTitle, "직함"), cleanName(text(get("name", cur?.name), LIMITS.posName, "이름")), user, text(get("note", cur?.note), LIMITS.posNote, "비고")];
}
// 표의 순번 다시 매기기 (id 목록 순서대로)
function renumber(ids) { ids.forEach((id, i) => q.setPositionSort.run((i + 1) * 10, id)); }

// 엑셀 행과 지금 조직도 비교: 이름으로 맞추고, 조직·직함이 다르면 '이동', 없으면 '추가', 엑셀에 없는 이름은 '빠짐' (공석은 그대로 둠)
function orgDiff(rowsRaw) {
  if (!Array.isArray(rowsRaw) || !rowsRaw.length) throw bad("불러온 줄이 없어요.");
  if (rowsRaw.length > 2000) throw bad("2000줄까지 불러올 수 있어요.");
  const rows = rowsRaw.map((r, i) => {
    const [dept, team] = splitDept(r.dept);
    return { i, hq: cleanName(r.hq), dept: cleanName(dept), team: cleanName(team), title: cleanName(r.title).slice(0, LIMITS.posTitle), name: cleanName(r.name).slice(0, LIMITS.posName), note: String(r.note ?? "").trim().slice(0, LIMITS.posNote) };
  }).filter((r) => r.name || r.title);
  const units = q.units.all();
  const byId = new Map(units.map((u) => [u.id, u]));
  const pathOf = (id) => { const out = []; for (let u = byId.get(id); u; u = byId.get(u.parent_id)) out.unshift(u.name); return out; };
  // 지금 자리의 '엑셀식' 위치 (본부 / 부 / 팀 이름)
  const existing = q.positions.all().filter((p) => p.name);
  const placeOf = (p) => { const path = pathOf(p.unit_id); return { hq: path[1] || "", dept: path[2] || "", team: path.length > 3 ? path[path.length - 1] : "" }; };
  const label = (x) => [x.hq || "위원회", x.dept, x.team].filter(Boolean).join(" › ");
  const used = new Set(), out = { same: [], add: [], move: [], remove: [] };
  const samePlace = (p, r) => { const a = placeOf(p); return a.hq === (r.hq === "공통" ? "" : r.hq) && a.dept === (/직속$/.test(r.dept) ? "" : r.dept) && a.team === r.team; };
  // 1차: 이름·위치·직함 모두 같은 것, 2차: 이름·위치, 3차: 이름만
  const passes = [(p, r) => samePlace(p, r) && p.title === r.title, (p, r) => samePlace(p, r), () => true];
  const match = new Map();
  for (const test of passes) {
    for (const r of rows) {
      if (match.has(r.i) || !r.name) continue;
      const p = existing.find((x) => !used.has(x.id) && x.name === r.name && test(x, r));
      if (p) { match.set(r.i, p); used.add(p.id); }
    }
  }
  for (const r of rows) {
    const p = match.get(r.i);
    const to = { hq: r.hq === "공통" ? "" : r.hq, dept: /직속$/.test(r.dept) ? "" : r.dept, team: r.team };
    if (!p) out.add.push({ row: r.i, name: r.name || "(공석)", what: `${label(to)} ${r.title}`.trim() });
    else if (!samePlace(p, r) || p.title !== r.title || (r.note && r.note !== p.note)) {
      const from = placeOf(p);
      out.move.push({ row: r.i, id: p.id, name: r.name, what: samePlace(p, r) ? `${p.title} → ${r.title}${r.note && r.note !== p.note ? " (비고)" : ""}` : `${label(from)} ${p.title} → ${label(to)} ${r.title}` });
    } else out.same.push(r.i);
  }
  for (const p of existing) if (!used.has(p.id)) out.remove.push({ id: p.id, name: p.name, what: `${label(placeOf(p))} ${p.title}`.trim() });
  return { rows, match, out };
}

/* ----- 외부 캘린더 ----- */
const calendarsPublic = () => q.calendars.all().map((c) => ({ id: c.id, name: c.name, color: c.color, categoryId: c.category_id, unitId: c.unit_id }));
const calendarAdminOut = (c) => ({
  id: c.id, name: c.name, color: c.color, categoryId: c.category_id, unitId: c.unit_id, address: maskUrl(c.url),
  lastSyncAt: c.last_sync_at, lastOkAt: c.last_ok_at, lastError: c.last_error, eventCount: c.event_count
});
// 가져온 일정: 우리 일정과 같은 모양 + ext(읽기 전용) 표시
const externalOut = (x) => ({
  id: x.id, ext: true, kind: "external", calendarId: x.calendar_id, calendarName: x.calendar_name, color: x.color, categoryId: x.category_id,
  title: x.title, startDate: x.start_date, endDate: x.end_date, startTime: x.start_time, endTime: x.end_time, location: x.location,
  unitId: x.unit_id, tagIds: [], attendeeIds: []
});
// 가져온 일정에서 PSchedule 일정으로 옮길 값 (끝 시각 24:00 은 23:59 로)
const SOURCE_FIELDS = ["title", "startDate", "endDate", "startTime", "endTime", "location"];
const SOURCE_LABEL = { title: "제목", startDate: "날짜", endDate: "끝 날짜", startTime: "시간", endTime: "끝 시간", location: "장소" };
function sourceValues(x) {
  const end = x.end_time === "24:00" ? "23:59" : x.end_time;
  return { title: x.title.slice(0, LIMITS.title), startDate: x.start_date, endDate: x.end_date, startTime: x.start_time || null, endTime: x.start_time ? end || null : null, location: (x.location || "").slice(0, LIMITS.location), calendarName: x.calendar_name };
}
// 넣은 일정의 원본 캘린더 이름 (목록에 'WYD 캘린더' 로 표시)
function sourceName(e) {
  if (!e.src_calendar_id) return null;
  try { return JSON.parse(e.src_snapshot || "{}").calendarName || "구글 캘린더"; } catch { return "구글 캘린더"; }
}
// 넣은 일정의 원본 상태: 같음 / 바뀜(무엇이) / 원본에서 지워짐
function sourceInfo(e) {
  if (!e.src_calendar_id) return null;
  let snap = {};
  try { snap = JSON.parse(e.src_snapshot || "{}"); } catch {}
  const now = q.sourceNow.get(e.src_calendar_id, e.src_uid, e.src_inst);
  const calendarName = now?.calendar_name || snap.calendarName || "구글 캘린더";
  if (!now) return { calendarName, status: "deleted" };
  const cur = sourceValues(now);
  const changed = SOURCE_FIELDS.filter((k) => (cur[k] || "") !== (snap[k] || ""));
  return { calendarName, status: changed.length ? "changed" : "same", changed: changed.map((k) => SOURCE_LABEL[k]), current: cur, externalId: now.id };
}
// 이 팀에 넣을 수 있는지: 관리자는 아무 팀, 멤버는 볼 수 있는 팀(내 소속과 그 아래) 또는 팀 없음
const canUseUnit = (user, v, unitId) => user.role === "admin" || !unitId || JSON.parse(v.units).includes(unitId);

function calendarInput(b, cur) {
  const name = has(b, "name") || !cur ? text(b.name, LIMITS.calendarName, "캘린더 이름", true) : cur.name;
  let url = cur?.url, warn;
  if (has(b, "url") || !cur) {
    const r = checkUrl(b.url);
    if (r.error) throw bad(r.error, "url");
    url = r.url; warn = r.warn;
  }
  const color = has(b, "color") ? (Number.isInteger(b.color) && b.color >= 0 && b.color < COLORS ? b.color : 5) : cur?.color ?? 5;
  const category = has(b, "categoryId") ? idOrNull(b.categoryId) : cur?.category_id ?? null;
  if (category && !q.category.get(category)) throw bad("분류를 찾을 수 없어요.");
  const unit = has(b, "unitId") ? unitIdOrNull(b.unitId) : cur?.unit_id ?? null;
  return { values: [name, url, color, category, unit], warn };
}

/* ----- 분류 ----- */
const categoriesOut = () => q.categories.all().map((c) => ({ id: c.id, parentId: c.parent_id, name: c.name }));
function categoryDepth(id) {
  let n = 0;
  for (let c = q.category.get(id); c; c = c.parent_id ? q.category.get(c.parent_id) : null) n++;
  return n;
}
function subtreeIds(id) {
  const all = q.categories.all(), out = [id];
  for (let i = 0; i < out.length; i++) for (const c of all) if (c.parent_id === out[i]) out.push(c.id);
  return out;
}
function addCategory(parentId, raw) {
  const name = text(raw, LIMITS.category, "분류 이름", true);
  if (parentId && !q.category.get(parentId)) throw bad("위 분류를 찾을 수 없어요.");
  if (parentId && categoryDepth(parentId) >= CATEGORY_DEPTH) throw bad("분류는 대분류 › 중분류 › 소분류 3단계까지 만들 수 있어요.");
  const same = q.categoryByName.get(name, parentId);
  if (same) return { id: same.id, created: false };
  return { id: Number(q.addCategory.run(parentId, name, parentId).lastInsertRowid), created: true };
}
// 회의·할 일·메모의 분류: 안 보냈으면 고칠 땐 그대로, 새로 만들 땐 fallback (연결한 회의의 분류)
function categoryOf(b, cur, fallback) {
  if (!has(b, "categoryId")) return cur ? cur.category_id : fallback ?? null;
  const id = idOrNull(b.categoryId);
  if (id && !q.category.get(id)) throw bad("분류를 찾을 수 없어요. 지워졌을 수 있어요.");
  return id;
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
    JSON.stringify(agenda), categoryOf(b, cur)];
}
function saveEventRelations(id, b) {
  if (has(b, "tagIds")) { q.clearEventTags.run(id); for (const t of ids(b.tagIds)) q.addEventTag.run(id, t); }
  if (has(b, "attendeeIds")) { q.clearAttendees.run(id); for (const u of ids(b.attendeeIds)) q.addAttendee.run(id, u); }
}
function eventsOut(rows, user) {
  const tags = groupBy(q.eventTags, rows, "tag_id");
  const att = groupBy(q.eventAttendees, rows, "user_id");
  const guests = groupBy(q.guestCount, rows, "name");
  return rows.map((e) => ({
    id: e.id, kind: e.kind, title: e.title, startDate: e.start_date, endDate: e.end_date, startTime: e.start_time, endTime: e.end_time,
    location: e.location, categoryId: e.category_id, unitId: e.unit_id, tagIds: tags.get(e.id), attendeeIds: att.get(e.id), guestNames: guests.get(e.id), author: e.author, createdBy: e.created_by,
    openTasks: e.open_tasks, importantMemos: e.important_memos, comments: e.comments, fromCalendar: !!e.src_calendar_id, sourceName: sourceName(e),
    sourceKey: e.src_calendar_id ? `${e.src_calendar_id}|${e.src_uid}|${e.src_inst}` : null,
    canDelete: user.role === "admin" || e.created_by === user.id
  }));
}

/* ----- 할 일 ----- */
function taskInput(b, cur, v) {
  const get = (k, curVal) => (has(b, k) ? b[k] : curVal);
  const title = text(get("title", cur?.title), LIMITS.title, "할 일", true);
  const due = get("dueDate", cur?.due_date) || null;
  if (due && !isDate(due)) throw bad("마감일을 확인해 주세요.");
  const status = get("status", cur?.status ?? "todo");
  if (!STATUSES.includes(status)) throw bad("상태를 확인해 주세요.");
  const assignee = idOrNull(get("assigneeId", cur?.assignee_id));
  if (assignee && !q.userExists.get(assignee)) throw bad("담당자를 찾을 수 없어요.");
  const meeting = idOrNull(get("meetingId", cur?.meeting_id));
  const ev = meeting && q.event.get(meeting);
  // 볼 수 없는 회의에는 새로 연결할 수 없음 (이미 연결된 것은 그대로)
  if (meeting && (!ev || (v && meeting !== cur?.meeting_id && !q.eventVis.get({ id: meeting, ...v })))) throw bad("연결할 회의를 찾을 수 없어요.");
  const phase = meeting ? (get("phase", cur?.phase) === "before" ? "before" : "after") : null;
  return [title, due, status, assignee, meeting, phase, text(get("note", cur?.note), LIMITS.taskNote, "메모"), categoryOf(b, cur, ev?.category_id)];
}
function saveTaskTags(id, b) {
  if (has(b, "tagIds")) { q.clearTaskTags.run(id); for (const t of ids(b.tagIds)) q.addTaskTag.run(id, t); }
}
function tasksOut(rows, user) {
  const tags = groupBy(q.taskTags, rows, "tag_id");
  return rows.map((t) => ({
    id: t.id, title: t.title, dueDate: t.due_date, status: t.status, assigneeId: t.assignee_id,
    meetingId: t.meeting_id, meetingTitle: t.meeting_title, meetingDate: t.meeting_date, meetingTime: t.meeting_time,
    phase: t.phase, note: t.note, categoryId: t.category_id, unitId: t.unit_id, tagIds: tags.get(t.id), doneAt: t.done_at, createdBy: t.created_by,
    canDelete: user.role === "admin" || t.created_by === user.id || t.assignee_id === user.id
  }));
}

/* ----- 메모 ----- */
const memoOut = (m, user) => ({
  id: m.id, body: m.body, date: m.memo_date, meetingId: m.meeting_id, meetingTitle: m.meeting_title, meetingDate: m.meeting_date,
  important: !!m.important, categoryId: m.category_id, unitId: m.unit_id, createdBy: m.created_by, taskId: m.task_id, author: m.author || "(탈퇴한 멤버)", createdAt: m.created_at, updatedAt: m.updated_at,
  canEdit: user.role === "admin" || m.created_by === user.id
});
function memoInput(b, cur, v) {
  const get = (k, curVal) => (has(b, k) ? b[k] : curVal);
  const body = text(get("body", cur?.body), LIMITS.memo, "메모", true);
  const date = get("date", cur?.memo_date);
  if (!isDate(date)) throw bad("메모 날짜를 확인해 주세요.");
  const meeting = idOrNull(get("meetingId", cur?.meeting_id));
  const ev = meeting && q.event.get(meeting);
  if (meeting && (!ev || (v && meeting !== cur?.meeting_id && !q.eventVis.get({ id: meeting, ...v })))) throw bad("연결할 회의를 찾을 수 없어요.");
  return [body, date, meeting, get("important", !!cur?.important) ? 1 : 0, categoryOf(b, cur, ev?.category_id)];
}

/* ----- 보이는 범위: 요청한 사람 기준 조건 값 ----- */
// mine: 관리자도 '나의 대시보드'에서는 멤버와 같은 규칙으로
// 볼 수 있는 조직: 내 소속과 그 아래 + 관리자가 추가로 지정한 조직 (sub 면 그 아래까지, 아니면 그 조직만)
// 본부장이 맡은 조직과 그 아래: 계정 소속 + 조직도에 연결한 자리
function directorScope(user) {
  if (!user.director) return new Set();
  const roots = q.positionUnitsOf.all(user.id).map((x) => x.id);
  if (user.unit_id && q.unit.get(user.unit_id)) roots.push(user.unit_id);
  return new Set(roots.flatMap((id) => unitSubtree(id)));
}
function visibleUnits(user) {
  const set = new Set(user.unit_id && q.unit.get(user.unit_id) ? unitSubtree(user.unit_id) : []);
  for (const id of directorScope(user)) set.add(id);
  for (const g of q.viewUnits.all(user.id)) for (const id of g.sub ? unitSubtree(g.unit_id) : [g.unit_id]) set.add(id);
  return [...set];
}
function viewer(user, mine) {
  return { admin: user.role === "admin" && !mine ? 1 : 0, uid: user.id, units: JSON.stringify(visibleUnits(user)) };
}
const viewUnitsOut = (userId) => q.viewUnits.all(userId).map((g) => ({ unitId: g.unit_id, sub: !!g.sub }));
const notFound = (what) => Object.assign(new Error(`${what}을(를) 찾을 수 없어요. 지워졌거나 볼 수 없는 팀의 항목이에요.`), { status: 404, expose: true });
// 항목의 팀: 보내면 그 팀 (이미 있는 항목은 만든 사람·관리자만), 안 보내면 새로 만들 땐 연결한 회의의 팀 → 만든 사람의 소속
function itemUnit(b, user, cur, meetingId) {
  if (has(b, "unitId")) {
    if (cur && user.role !== "admin" && cur.created_by !== user.id) throw Object.assign(new Error("팀은 만든 사람이나 관리자만 바꿀 수 있어요."), { status: 403, expose: true });
    return unitIdOrNull(b.unitId);
  }
  if (cur) return meetingId && meetingId !== cur.meeting_id ? q.event.get(meetingId)?.unit_id ?? cur.unit_id : cur.unit_id;
  if (meetingId) return q.event.get(meetingId)?.unit_id ?? null;
  return user.unit_id && q.unit.get(user.unit_id) ? user.unit_id : null;
}

/* ----- 검색 (대시보드): 회의·일정·할 일·메모·가져온 일정의 안쪽 내용까지, 전체 기간 ----- */
const SEARCH_LIMIT = 300;
const searchQ = {
  events: db.prepare("SELECT id, kind, title, start_date, end_date, start_time, end_time, location, description, agenda, category_id, unit_id, created_by, src_calendar_id, src_snapshot FROM events"),
  attendees: db.prepare("SELECT a.event_id, a.user_id, u.name FROM event_attendees a JOIN users u ON u.id = a.user_id"),
  eventTags: db.prepare("SELECT x.event_id, t.name FROM event_tags x JOIN tags t ON t.id = x.tag_id"),
  links: db.prepare("SELECT event_id, title, url FROM event_links"),
  guests: db.prepare("SELECT event_id, name, org FROM event_guests"),
  comments: db.prepare("SELECT target_id AS event_id, body FROM comments WHERE target_type = 'event'"),
  tasks: db.prepare(`SELECT t.id, t.title, t.note, t.due_date, t.status, t.assignee_id, t.meeting_id, t.category_id, e.title AS meeting_title, u.name AS assignee
    FROM tasks t LEFT JOIN events e ON e.id = t.meeting_id LEFT JOIN users u ON u.id = t.assignee_id`),
  taskTags: db.prepare("SELECT x.task_id, t.name FROM task_tags x JOIN tags t ON t.id = x.tag_id"),
  memos: db.prepare(`SELECT m.id, m.body, m.memo_date, m.meeting_id, m.important, m.category_id, m.created_by, e.title AS meeting_title
    FROM memos m LEFT JOIN events e ON e.id = m.meeting_id`),
  external: db.prepare(`SELECT x.id, x.uid, x.inst, x.title, x.location, x.description, x.start_date, x.end_date, x.start_time, x.end_time, x.calendar_id, c.name AS calendar_name, c.color, c.category_id
    FROM calendar_events x JOIN calendars c ON c.id = x.calendar_id`)
};
const searchQ_vis = { events: q.visEventIds, tasks: q.visTaskIds, memos: q.visMemoIds, calendars: q.visCalendarIds, imported: q.importedKeys };
// 한글은 그대로, 영문은 대소문자 무시, 띄어쓰기 무시
const squash = (s) => String(s ?? "").normalize("NFC").toLowerCase().replace(/\s+/g, "");
function searchPattern(q) {
  const chars = [...squash(q)].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return chars.length ? new RegExp(chars.join("\\s*"), "iu") : null;
}
// 찾은 곳 앞뒤를 잘라 보여 줄 조각 + 강조할 위치
function snippet(text, re) {
  const t = String(text).replace(/\s+/g, " ").trim();
  const m = re.exec(t);
  if (!m) return null;
  const from = Math.max(0, m.index - 24), to = Math.min(t.length, m.index + m[0].length + 40);
  const pre = from > 0 ? "…" : "";
  return { text: pre + t.slice(from, to) + (to < t.length ? "…" : ""), hl: [pre.length + m.index - from, pre.length + m.index - from + m[0].length] };
}
function runSearch(q, kind, v) {
  const re = searchPattern(q);
  if (!re) return { results: [], total: 0 };
  // 볼 수 있는 항목만
  const seeEv = new Set(searchQ_vis.events.all(v).map((x) => x.id)), seeTask = new Set(searchQ_vis.tasks.all(v).map((x) => x.id));
  const seeMemo = new Set(searchQ_vis.memos.all(v).map((x) => x.id)), seeCal = new Set(searchQ_vis.calendars.all(extV(v)).map((x) => x.id));
  const needle = squash(q);
  const cats = new Map(q_categoriesPath());
  const group = (rows, key, val) => { const m = new Map(); for (const r of rows) { if (!m.has(r[key])) m.set(r[key], []); m.get(r[key]).push(val(r)); } return m; };
  // 필드 목록 [이름표, 글] 중 처음 맞는 곳
  const hit = (fields) => {
    for (const [label, value] of fields) {
      if (!value || !squash(value).includes(needle)) continue;
      const sn = snippet(value, re);
      if (sn) return { field: label, ...sn };
    }
    return null;
  };
  const out = [];
  if (kind === "all" || kind === "meeting") {
    const att = group(searchQ.attendees.all(), "event_id", (r) => r);
    const tags = group(searchQ.eventTags.all(), "event_id", (r) => r.name);
    const links = group(searchQ.links.all(), "event_id", (r) => r.title);
    const comments = group(searchQ.comments.all(), "event_id", (r) => r.body);
    const guests = group(searchQ.guests.all(), "event_id", (r) => (r.org ? `${r.name} (${r.org})` : r.name));
    for (const e of searchQ.events.all()) {
      if (!seeEv.has(e.id)) continue;
      const fields = [["제목", e.title], ["장소", e.location], ["개요", e.description],
        ...parseAgenda(e.agenda).map((a) => ["안건", a]), ...(links.get(e.id) || []).map((x) => ["관련 문서", x]),
        ...(comments.get(e.id) || []).map((x) => ["댓글", x]), ...(tags.get(e.id) || []).map((x) => ["태그", x]),
        ["분류", cats.get(e.category_id)], ...(att.get(e.id) || []).map((x) => ["참석자", x.name]), ...(guests.get(e.id) || []).map((x) => ["외부 참석자", x])];
      const h = hit(fields);
      if (h) out.push({ type: e.kind, id: e.id, title: e.title, date: e.start_date, endDate: e.end_date, time: e.start_time, endTime: e.end_time, sourceName: sourceName(e),
        categoryId: e.category_id, unitId: e.unit_id, createdBy: e.created_by, attendeeIds: (att.get(e.id) || []).map((x) => x.user_id), ...h });
    }
    const imported = new Set(searchQ_vis.imported.all(v).map((k) => `${k.cal}|${k.uid_}|${k.inst}`));
    for (const x of searchQ.external.all()) {
      if (!seeCal.has(x.calendar_id) || imported.has(`${x.calendar_id}|${x.uid}|${x.inst}`)) continue;
      const h = hit([["제목", x.title], ["장소", x.location], ["설명", x.description]]);
      if (h) out.push({ type: "ext", id: x.id, title: x.title, date: x.start_date, endDate: x.end_date, time: x.start_time, endTime: x.end_time,
        calendarId: x.calendar_id, calendarName: x.calendar_name, color: x.color, categoryId: x.category_id, ext: true, ...h });
    }
  }
  if (kind === "all" || kind === "task") {
    const tags = group(searchQ.taskTags.all(), "task_id", (r) => r.name);
    for (const t of searchQ.tasks.all()) {
      if (!seeTask.has(t.id)) continue;
      const h = hit([["제목", t.title], ["메모", t.note], ["관련 회의", t.meeting_title], ["담당자", t.assignee], ...(tags.get(t.id) || []).map((x) => ["태그", x]), ["분류", cats.get(t.category_id)]]);
      if (h) out.push({ type: "task", id: t.id, title: t.title, date: t.due_date, status: t.status, assigneeId: t.assignee_id, meetingId: t.meeting_id, categoryId: t.category_id, ...h });
    }
  }
  if (kind === "all" || kind === "memo") {
    for (const m of searchQ.memos.all()) {
      if (!seeMemo.has(m.id)) continue;
      const h = hit([["메모", m.body], ["분류", cats.get(m.category_id)]]);
      if (h) out.push({ type: "memo", id: m.id, title: m.body.split("\n")[0].slice(0, 80), date: m.memo_date, meetingId: m.meeting_id, meetingTitle: m.meeting_title,
        important: !!m.important, categoryId: m.category_id, createdBy: m.created_by, ...h });
    }
  }
  // 날짜 순서 (날짜 없는 할 일은 맨 끝), 같은 날은 종일 먼저 → 시간 순
  out.sort((a, b) => (a.date ? 0 : 1) - (b.date ? 0 : 1) || String(a.date).localeCompare(String(b.date)) || (a.time ? 1 : 0) - (b.time ? 1 : 0) || String(a.time).localeCompare(String(b.time)) || a.id - b.id);
  return { results: out.slice(0, SEARCH_LIMIT), total: out.length };
}
// 분류 id → '대분류 › 중분류' 이름
function q_categoriesPath() {
  const all = q.categories.all();
  const byId = new Map(all.map((c) => [c.id, c]));
  return all.map((c) => { const names = []; for (let x = c; x; x = byId.get(x.parent_id)) names.unshift(x.name); return [c.id, names.join(" › ")]; });
}

const commentOut = (c, user) => ({
  id: c.id, body: c.body, author: c.author || "(탈퇴한 멤버)", createdAt: c.created_at, mine: c.user_id === user.id,
  canDelete: user.role === "admin" || c.user_id === user.id
});

function eventDetail(e, user) {
  return {
    event: { ...eventsOut([e], user)[0], description: e.description, agenda: parseAgenda(e.agenda), createdAt: e.created_at, updatedAt: e.updated_at, source: sourceInfo(e) },
    tasks: tasksOut(q.tasksMeeting.all(e.id), user),
    memos: q.memosMeeting.all(e.id).map((m) => memoOut(m, user)),
    links: q.links.all(e.id).map((l) => ({ id: l.id, title: l.title, url: l.url, createdAt: l.created_at })),
    guests: q.guests.all(e.id),
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
  // 보이는 범위 조건 값 (?scope=mine 이면 관리자도 멤버처럼)
  const V = viewer(user, url.searchParams.get("scope") === "mine");

  if (path === "/api/logout" && method === "POST") {
    q.delSession.run(sha256(tokenOf(req)));
    return send(res, 204);
  }

  // 화면을 그리는 데 늘 필요한 것: 나, 팀원, 태그, 분류
  if (path === "/api/me" && method === "GET") {
    return send(res, 200, { user: publicUser(user), team: teamOut(), units: unitsOut(), tags: q.tags.all(), categories: categoriesOut(), calendars: calendarsPublic(), unreadNotices: q.unreadNotices.get(user.id).n });
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

  /* ----- 조직도 보기 (모두) ----- */
  if (path === "/api/org" && method === "GET") return send(res, 200, orgOut());

  if (path === "/api/contacts" && method === "GET") return send(res, 200, contactsFor(user));
  const contactm = path.match(/^\/api\/contacts\/([pu])(\d+)$/);
  if (contactm && method === "PUT") {
    // 나 또는 관리자만 고침 (다른 사람은 보이더라도 403)
    const id = Number(contactm[2]);
    const pos = contactm[1] === "p" ? q.position.get(id) : null;
    const key = contactm[1] === "u" ? "u" + id : pos ? (pos.user_id ? "u" + pos.user_id : "n" + (pos.person || pos.name)) : null;
    const who = key && contactPeople().get(key);
    const allowed = user.role === "admin" || who?.user?.id === user.id || (contactm[1] === "u" && id === user.id);
    if (!allowed) return send(res, 403, { error: "내 연락처만 고칠 수 있어요." });
    if (!who) return send(res, 404, { error: "그 사람을 찾을 수 없어요." });
    const v = contactInput(await readJson(req));
    inTx(() => saveContact(who, v));
    if (user.role === "admin" && who.user?.id !== user.id) console.log(`[admin] ${user.login} → 연락처 수정 (${key[0] === "u" ? key : "자리 #" + id})`);
    return send(res, 200, contactsFor(user));
  }
  // 사람 한 명: 앞으로 참석하는 회의 · 맡은 남은 할 일 (조직도에서 이름을 누르면)
  const pm = path.match(/^\/api\/people\/(\d+)$/);
  if (pm && method === "GET") {
    const target = q.userById.get(Number(pm[1]));
    if (!target) return send(res, 404, { error: "계정을 찾을 수 없어요." });
    const ids = JSON.stringify([target.id]);
    const day = isDate(param("today")) ? param("today") : new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    const until = new Date(Date.parse(day + "T00:00:00Z") + 30 * 86400e3).toISOString().slice(0, 10);
    return send(res, 200, {
      user: { id: target.id, name: target.name, unitId: target.unit_id },
      meetings: eventsOut(q.unitMeetings.all({ from: day, to: until, ids, ...V }), user),
      tasks: tasksOut(q.unitTasks.all({ ids, ...V }), user)
    });
  }

  /* ----- 소속 화면 (모두): 팀원이 참석하는 회의 · 맡은 할 일 · 쓴 메모 ----- */
  const om = path.match(/^\/api\/units\/(\d+)$/);
  if (om && method === "GET") {
    const u = q.unit.get(Number(om[1]));
    if (!u) return send(res, 404, { error: "조직을 찾을 수 없어요. 지워졌을 수 있어요." });
    const scope = param("sub") === "1" ? unitSubtree(u.id) : [u.id];
    const memberIds = unitUserIds(scope);
    const ids = JSON.stringify(memberIds);
    const day = isDate(param("today")) ? param("today") : new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    const d = new Date(day + "T00:00:00Z");
    const shift = (n) => new Date(d.getTime() + n * 86400e3).toISOString().slice(0, 10);
    const from = shift(-((d.getUTCDay() + 6) % 7)), to = shift(6 - ((d.getUTCDay() + 6) % 7)); // 이번 주 월~일
    const tasks = tasksOut(q.unitTasks.all({ ids, ...V }), user);
    const meetings = eventsOut(q.unitMeetings.all({ from, to, ids, ...V }), user);
    return send(res, 200, {
      unitId: u.id, scope, memberIds, week: { from, to },
      meetings, tasks, memos: q.unitMemos.all({ ids, ...V }).map((m) => memoOut(m, user)),
      stats: { weekMeetings: meetings.length, openTasks: tasks.length, lateTasks: tasks.filter((t) => t.dueDate && t.dueDate < day).length, importantMemos: q.unitImportant.get({ ids, ...V }).n }
    });
  }

  /* ----- 분류 (관리자만 고침) ----- */
  if (path.startsWith("/api/categories")) {
    if (!isAdmin) return send(res, 403, { error: "분류는 관리자만 고칠 수 있어요." });
    if (path === "/api/categories" && method === "POST") {
      const b = await readJson(req);
      const r = addCategory(idOrNull(b.parentId), b.name);
      if (!r.created) throw bad("같은 자리에 이미 있는 분류예요.");
      return send(res, 201, { id: r.id, categories: categoriesOut() });
    }
    // 여러 줄 한 번에: 한 줄에 '대분류 > 중분류 > 소분류', 없는 것만 만듦
    if (path === "/api/categories/bulk" && method === "POST") {
      const lines = String((await readJson(req)).text ?? "").split(/\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length > 500) throw bad("한 번에 500줄까지 넣을 수 있어요.");
      const added = inTx(() => {
        let n = 0;
        for (const line of lines) {
          const parts = line.split(/\s*[>›]\s*/).filter(Boolean);
          if (parts.length > CATEGORY_DEPTH) throw bad(`'${line}' — 분류는 3단계까지예요.`);
          let parent = null;
          for (const p of parts) { const r = addCategory(parent, p); parent = r.id; if (r.created) n++; }
        }
        return n;
      });
      return send(res, 200, { added, categories: categoriesOut() });
    }
    const cm = path.match(/^\/api\/categories\/(\d+)$/);
    const c = cm && q.category.get(Number(cm[1]));
    if (!c) return send(res, 404, { error: "분류를 찾을 수 없어요." });
    if (method === "PATCH") {
      const b = await readJson(req);
      inTx(() => {
        if (has(b, "name")) {
          const name = text(b.name, LIMITS.category, "분류 이름", true);
          const same = q.categoryByName.get(name, c.parent_id);
          if (same && same.id !== c.id) throw bad("같은 자리에 이미 있는 분류예요.");
          q.setCategoryName.run(name, c.id);
        }
        // 같은 단계 안에서 위·아래로
        if (b.move === -1 || b.move === 1) {
          const list = q.siblings.all(c.parent_id);
          const i = list.findIndex((x) => x.id === c.id), j = i + b.move;
          if (j >= 0 && j < list.length) {
            [list[i], list[j]] = [list[j], list[i]];
            list.forEach((x, k) => q.setCategorySort.run(k + 1, x.id));
          }
        }
      });
      return send(res, 200, { categories: categoriesOut() });
    }
    if (method === "DELETE") {
      inTx(() => {
        const ids = JSON.stringify(subtreeIds(c.id));
        for (const s of q.moveCategoryItems) s.run(c.parent_id, ids);
        q.delCategory.run(c.id); // 아래 분류도 함께 지워짐
      });
      return send(res, 200, { categories: categoriesOut() });
    }
    return send(res, 405, { error: "Method not allowed" });
  }

  /* ----- 일정·회의 ----- */
  if (path === "/api/events" && method === "GET") {
    const from = param("from"), to = param("to");
    if (!isDate(from) || !isDate(to) || to < from) return send(res, 400, { error: "기간을 확인해 주세요." });
    return send(res, 200, { events: eventsOut(q.events.all(V, to, from), user), external: q.externalRange.all(V, to, from).map(externalOut) });
  }
  if (path === "/api/meetings/choices" && method === "GET") {
    const d = isDate(param("date")) ? param("date") : new Date().toISOString().slice(0, 10);
    const day = (n) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
    return send(res, 200, {
      meetings: q.meetingChoices.all(V, day(-30), day(60), d).map((m) => ({ id: m.id, title: m.title, startDate: m.start_date, startTime: m.start_time }))
    });
  }
  if (path === "/api/events" && method === "POST") {
    const b = await readJson(req);
    const id = inTx(() => {
      const r = q.addEvent.run(...eventInput(b), user.id);
      const id = Number(r.lastInsertRowid);
      q.setEventUnit.run(itemUnit(b, user), id);
      if (!has(b, "attendeeIds")) b.attendeeIds = [user.id];
      saveEventRelations(id, b);
      return id;
    });
    return send(res, 201, eventDetail(q.event.get(id), user));
  }
  const em = path.match(/^\/api\/events\/(\d+)(?:\/(comments|links|guests|source-sync))?$/);
  if (em) {
    const e = q.event.get(Number(em[1]));
    if (!e || !q.eventVis.get({ id: e.id, ...V })) throw notFound("일정");
    if (em[2] === "comments") {
      if (method !== "POST") return send(res, 405, { error: "Method not allowed" });
      const body = text((await readJson(req)).body, LIMITS.comment, "댓글", true);
      q.addComment.run("event", e.id, user.id, body);
      return send(res, 201, { comments: q.comments.all("event", e.id).map((c) => commentOut(c, user)) });
    }
    // 원본(구글 캘린더)이 바뀌었을 때 원본대로 맞추기 (제목·날짜·시간·장소)
    if (em[2] === "source-sync") {
      if (method !== "POST") return send(res, 405, { error: "Method not allowed" });
      const info = sourceInfo(e);
      if (!info || info.status === "deleted") throw bad("원본 일정을 찾을 수 없어요.");
      const c = info.current;
      q.setEventFromSource.run(c.title, c.startDate, c.endDate, c.startTime, c.endTime, c.location, JSON.stringify(c), e.id);
      return send(res, 200, eventDetail(q.event.get(e.id), user));
    }
    // 외부 참석자 넣기 (회의를 볼 수 있는 사람 누구나, 회의록을 함께 채우듯)
    if (em[2] === "guests") {
      if (method !== "POST") return send(res, 405, { error: "Method not allowed" });
      const b = await readJson(req);
      if (q.guests.all(e.id).length >= LIMITS.guests) throw bad(`외부 참석자는 ${LIMITS.guests}명까지 넣을 수 있어요.`);
      q.addGuest.run(e.id, text(b.name, LIMITS.guestName, "이름", true), text(b.org, LIMITS.guestOrg, "소속·기관"), text(b.contact, LIMITS.guestContact, "연락처"), user.id);
      return send(res, 201, { guests: q.guests.all(e.id) });
    }
    if (em[2] === "links") {
      if (method !== "POST") return send(res, 405, { error: "Method not allowed" });
      const b = await readJson(req);
      const link = text(b.url, LIMITS.url, "주소", true);
      if (!/^https?:\/\//i.test(link)) throw bad("http:// 또는 https:// 로 시작하는 주소를 넣어 주세요.");
      q.addLink.run(e.id, text(b.title, LIMITS.linkTitle, "이름") || link.replace(/^https?:\/\//i, "").slice(0, 60), link);
      return send(res, 201, { links: q.links.all(e.id).map((l) => ({ id: l.id, title: l.title, url: l.url, createdAt: l.created_at })) });
    }
    if (method === "GET") {
      const d = eventDetail(e, user);
      // 같은 WYD 원본을 다른 팀도 넣었으면 (볼 수 있는 것만) 패널에서 서로 열 수 있게
      if (e.src_calendar_id) d.event.sameSource = q.importedFrom.all({ cal: e.src_calendar_id, uid_: e.src_uid, inst: e.src_inst, ...V }).filter((x) => x.id !== e.id).map((x) => ({ eventId: x.id, unitId: x.unit_id }));
      return send(res, 200, d);
    }
    // 고치기는 팀 누구나 (회의록을 함께 채우므로), 지우기는 올린 사람·관리자
    if (method === "PATCH") {
      const b = await readJson(req);
      inTx(() => {
        q.setEvent.run(...eventInput(b, e), e.id);
        if (has(b, "unitId")) q.setEventUnit.run(itemUnit(b, user, e), e.id);
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
  // 가져온 일정 → 우리 소속 일정으로 넣기 (여러 개 한 번에). 같은 원본을 같은 팀에 두 번 넣지 않음
  if (path === "/api/external/import" && method === "POST") {
    const b = await readJson(req);
    const list = ids(b.ids);
    if (!list.length) throw bad("넣을 일정을 골라 주세요.");
    const unit = has(b, "unitId") ? unitIdOrNull(b.unitId) : user.unit_id && q.unit.get(user.unit_id) ? user.unit_id : null;
    if (!canUseUnit(user, V, unit)) return send(res, 403, { error: "볼 수 있는 팀(내 소속과 그 아래 팀)에만 넣을 수 있어요." });
    const kind = b.kind === "event" ? "event" : "meeting";
    const result = inTx(() => {
      const created = [], skipped = [];
      for (const xid of list) {
        const x = q.external.get(xid);
        if (!x || !q.extVis.get({ id: x.id, ...extV(V) })) throw notFound("가져온 일정");
        const same = q.importedAny.all(x.calendar_id, x.uid, x.inst).find((e) => (e.unit_id ?? null) === unit);
        if (same) { skipped.push({ externalId: x.id, eventId: same.id }); continue; }
        const v = sourceValues(x);
        const input = eventInput({ kind, title: v.title, startDate: v.startDate, endDate: v.endDate, startTime: v.startTime, endTime: v.endTime, location: v.location, description: (x.description || "").slice(0, LIMITS.description), categoryId: x.category_id ?? null });
        const id = Number(q.addEvent.run(...input, user.id).lastInsertRowid);
        q.setEventUnit.run(unit, id);
        q.setEventSource.run(x.calendar_id, x.uid, x.inst, JSON.stringify(v), id);
        saveEventRelations(id, { attendeeIds: has(b, "attendeeIds") ? b.attendeeIds : [user.id] });
        created.push({ externalId: x.id, eventId: id });
      }
      return { created, skipped };
    });
    return send(res, 201, result);
  }

  // 외부(구글) 캘린더에서 가져온 일정 하나 (읽기 전용)
  const xm = path.match(/^\/api\/external\/(\d+)$/);
  if (xm && method === "GET") {
    const x = q.external.get(Number(xm[1]));
    if (!x || !q.extVis.get({ id: x.id, ...extV(V) })) return send(res, 404, { error: "가져온 일정을 찾을 수 없어요. 캘린더에서 지워졌을 수 있어요." });
    // 이미 우리 쪽에 넣은 것 (볼 수 있는 것만)
    const imported = q.importedFrom.all({ cal: x.calendar_id, uid_: x.uid, inst: x.inst, ...V }).map((e) => ({ eventId: e.id, unitId: e.unit_id }));
    return send(res, 200, { event: { ...externalOut(x), description: x.description, syncedAt: x.last_ok_at, imported } });
  }

  const gm = path.match(/^\/api\/guests\/(\d+)$/);
  if (gm && method === "DELETE") {
    const g = q.guest.get(Number(gm[1]));
    if (g && !q.eventVis.get({ id: g.event_id, ...V })) throw notFound("외부 참석자");
    q.delGuest.run(Number(gm[1]));
    return send(res, 200, { guests: g ? q.guests.all(g.event_id) : [] });
  }

  const lm = path.match(/^\/api\/links\/(\d+)$/);
  if (lm && method === "DELETE") {
    const l = q.link.get(Number(lm[1]));
    if (l && !q.eventVis.get({ id: l.event_id, ...V })) throw notFound("문서");
    q.delLink.run(Number(lm[1]));
    return send(res, 204);
  }

  /* ----- 할 일 ----- */
  if (path === "/api/tasks" && method === "GET") {
    let rows;
    if (isDate(param("date"))) rows = q.tasksDay.all({ day: param("date"), today: isDate(param("today")) ? param("today") : "", ...V });
    else if (isDate(param("from")) && isDate(param("to"))) rows = q.tasksRange.all(V, param("from"), param("to"));
    else rows = q.tasksAll.all(V);
    return send(res, 200, { tasks: tasksOut(rows, user) });
  }
  if (path === "/api/tasks" && method === "POST") {
    const b = await readJson(req);
    const input = taskInput(b, null, V);
    const id = inTx(() => {
      const r = q.addTask.run(...input, user.id, input[2]);
      const id = Number(r.lastInsertRowid);
      q.setTaskUnit.run(itemUnit(b, user, null, input[4]), id);
      saveTaskTags(id, b);
      return id;
    });
    return send(res, 201, { task: tasksOut([q.task.get(id)], user)[0] });
  }
  const km = path.match(/^\/api\/tasks\/(\d+)$/);
  if (km) {
    const t = q.task.get(Number(km[1]));
    if (!t || !q.taskVis.get({ id: t.id, ...V })) throw notFound("할 일");
    if (method === "GET") return send(res, 200, { task: tasksOut([t], user)[0] });
    if (method === "PATCH") {
      const b = await readJson(req);
      const input = taskInput(b, t, V);
      inTx(() => { q.setTask.run(...input, input[2], t.id); q.setTaskUnit.run(itemUnit(b, user, t, input[4]), t.id); saveTaskTags(t.id, b); });
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
    if (isDate(param("date"))) rows = q.memosDay.all(V, param("date"));
    else if (Number(param("meeting")) > 0) {
      if (!q.eventVis.get({ id: Number(param("meeting")), ...V })) throw notFound("회의");
      rows = q.memosMeeting.all(Number(param("meeting")));
    } else rows = q.memosAll.all({ important: param("important") === "1" ? 1 : 0, ...V });
    return send(res, 200, { memos: rows.map((m) => memoOut(m, user)) });
  }
  if (path === "/api/memos" && method === "POST") {
    const b = await readJson(req);
    const input = memoInput(b, null, V);
    const id = inTx(() => {
      const id = Number(q.addMemo.run(...input, user.id).lastInsertRowid);
      q.setMemoUnit.run(itemUnit(b, user, null, input[2]), id);
      return id;
    });
    return send(res, 201, { memo: memoOut(q.memo.get(id), user) });
  }
  const mm = path.match(/^\/api\/memos\/(\d+)(\/task)?$/);
  if (mm) {
    const m = q.memo.get(Number(mm[1]));
    if (!m || !q.memoVis.get({ id: m.id, ...V })) throw notFound("메모");
    // 메모 → 할 일로 만들기 (원래 회의에 자동 연결)
    if (mm[2]) {
      if (method !== "POST") return send(res, 405, { error: "Method not allowed" });
      const b = await readJson(req);
      const input = taskInput({ title: b.title || m.body.split("\n")[0].slice(0, LIMITS.title), dueDate: b.dueDate, assigneeId: b.assigneeId, meetingId: m.meeting_id, phase: "after", note: m.body.includes("\n") ? m.body : "", categoryId: has(b, "categoryId") ? b.categoryId : m.category_id });
      const id = inTx(() => {
        const id = Number(q.addTask.run(...input, user.id, input[2]).lastInsertRowid);
        q.setTaskUnit.run(m.unit_id ?? itemUnit({}, user, null, m.meeting_id), id); // 메모의 팀을 따름
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
      const b = await readJson(req);
      inTx(() => {
        const input = memoInput(b, m, V);
        q.setMemo.run(...input, m.id);
        q.setMemoUnit.run(itemUnit(b, user, m, input[2]), m.id);
      });
      return send(res, 200, { memo: memoOut(q.memo.get(m.id), user) });
    }
    if (method === "DELETE") {
      q.delMemo.run(m.id);
      return send(res, 204);
    }
    return send(res, 405, { error: "Method not allowed" });
  }

  if (path === "/api/search" && method === "GET") {
    const qv = String(param("q") || "").slice(0, 100);
    const kind = ["meeting", "task", "memo"].includes(param("kind")) ? param("kind") : "all";
    return send(res, 200, { q: qv, kind, limit: SEARCH_LIMIT, ...runSearch(qv, kind, V) });
  }

  /* ----- 공지 ----- */
  if (path === "/api/notices" && method === "GET") {
    return send(res, 200, {
      notices: q.notices.all(user.id).map((n) => ({
        id: n.id, title: n.title, preview: n.preview, pinned: !!n.pinned, author: n.author,
        comments: n.comments, createdAt: n.created_at, updatedAt: n.updated_at, unread: !!n.unread
      })),
      unreadNotices: q.unreadNotices.get(user.id).n
    });
  }
  // 사이드바 '공지' 옆 숫자 (안 읽은 공지 수)
  if (path === "/api/notices/unread" && method === "GET") return send(res, 200, { unreadNotices: q.unreadNotices.get(user.id).n });
  const noticeInput = (b) => [text(b.title, LIMITS.title, "제목", true), text(b.body, LIMITS.notice, "내용", true), b.pinned ? 1 : 0];
  if (path === "/api/notices" && method === "POST") {
    if (!isAdmin) return send(res, 403, { error: "공지는 관리자만 쓸 수 있어요." });
    const r = q.addNotice.run(...noticeInput(await readJson(req)), user.id);
    q.readNotice.run(user.id, Number(r.lastInsertRowid)); // 쓴 사람은 읽은 것으로
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
      q.readNotice.run(user.id, n.id); // 열어 보면 읽은 것으로 → 사이드바 숫자가 줄어듦
      return send(res, 200, {
        notice: { id: n.id, title: n.title, body: n.body, pinned: !!n.pinned, author: n.author, createdAt: n.created_at, updatedAt: n.updated_at, canEdit: isAdmin },
        comments: q.comments.all("notice", n.id).map((c) => commentOut(c, user)),
        unreadNotices: q.unreadNotices.get(user.id).n
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
          id: u.id, login: u.login, role: roleOut(u), name: u.name, unitId: u.unit_id, viewUnits: viewUnitsOut(u.id), note: u.note, pwChanged: u.pw_changed === 1,
          createdAt: u.created_at, lastLoginAt: u.last_login_at, me: u.id === user.id
        }))
      });
    }
    if (path === "/api/admin/users" && method === "POST") {
      const b = await readJson(req);
      const login = normalizeLogin(b.login);
      if (!/^[a-z0-9._-]{3,20}$/.test(login)) throw bad("아이디는 영문 소문자·숫자·._- 로 3~20자로 정해 주세요.", "login");
      const name = text(b.name, LIMITS.name, "이름", true);
      const unit = unitIdOrNull(b.unitId);
      const role = b.role === "admin" ? "admin" : "member";
      const director = b.role === "director" ? 1 : 0;
      if (q.userByLogin.get(login)) throw bad("이미 있는 아이디예요.", "login");
      const password = tempPassword();
      const added = q.addUser.run(login, hashPassword(password), role, name, unit, text(b.note, LIMITS.userNote, "메모"));
      if (director) q.setUserDirector.run(1, Number(added.lastInsertRowid));
      console.log(`[admin] ${user.login} → ${login} 계정 발급`);
      return send(res, 201, { login, name, password });
    }
    /* 외부 캘린더 (구글 캘린더 비공개 iCal 주소) — 주소는 응답·로그에 가려서만 */
    if (path === "/api/admin/calendars" && method === "GET") {
      return send(res, 200, { calendars: q.calendars.all().map(calendarAdminOut) });
    }
    if (path === "/api/admin/calendars" && method === "POST") {
      const { values, warn } = calendarInput(await readJson(req));
      const id = Number(q.addCalendar.run(...values).lastInsertRowid);
      console.log(`[admin] ${user.login} → 외부 캘린더 #${id} 등록`);
      const sync = await calendarSync.syncOne(id);
      return send(res, 201, { calendar: calendarAdminOut(q.calendar.get(id)), sync, warn });
    }
    const calm = path.match(/^\/api\/admin\/calendars\/(\d+)(\/sync)?$/);
    if (calm) {
      const c = q.calendar.get(Number(calm[1]));
      if (!c) return send(res, 404, { error: "캘린더를 찾을 수 없어요." });
      if (calm[2] && method === "POST") {
        const sync = await calendarSync.syncOne(c.id);
        return send(res, 200, { calendar: calendarAdminOut(q.calendar.get(c.id)), sync });
      }
      if (!calm[2] && method === "PATCH") {
        const b = await readJson(req);
        const { values, warn } = calendarInput(b, c);
        q.setCalendar.run(...values, c.id);
        const sync = has(b, "url") ? await calendarSync.syncOne(c.id) : null;
        return send(res, 200, { calendar: calendarAdminOut(q.calendar.get(c.id)), sync, warn });
      }
      if (!calm[2] && method === "DELETE") {
        q.delCalendar.run(c.id); // 가져온 일정도 함께 지워짐
        console.log(`[admin] ${user.login} → 외부 캘린더 #${c.id} 삭제`);
        return send(res, 204);
      }
      return send(res, 405, { error: "Method not allowed" });
    }

    /* 백업 */
    if (path === "/api/admin/backups" && method === "GET") {
      return send(res, 200, { backups: listBackups(BACKUP_DIR).map(({ name, size, date }) => ({ name, size, date })), keepDays: BACKUP_KEEP_DAYS, hour: BACKUP_HOUR });
    }
    if (path === "/api/admin/backups" && method === "POST") {
      backupNow(db, BACKUP_DIR);
      if (BACKUP_KEEP_DAYS) pruneBackups(BACKUP_DIR, BACKUP_KEEP_DAYS);
      console.log(`[admin] ${user.login} → 지금 백업`);
      return send(res, 200, { backups: listBackups(BACKUP_DIR), keepDays: BACKUP_KEEP_DAYS, hour: BACKUP_HOUR });
    }

    // 여러 명 한 번에 소속 바꾸기
    if (path === "/api/admin/users/unit" && method === "POST") {
      const b = await readJson(req);
      const unit = unitIdOrNull(b.unitId);
      const list = ids(b.userIds);
      inTx(() => { for (const id of list) q.setUserUnit.run(unit, id); });
      return send(res, 200, { changed: list.length, team: teamOut() });
    }

    /* 전체 대시보드: 팀별 이번 주 회의 · 남은 할 일 · 마감 지난 할 일 (항목의 팀 기준, 팀 없음은 unitId null) */
    if (path === "/api/admin/overview" && method === "GET") {
      const day = isDate(param("today")) ? param("today") : new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
      const d = new Date(day + "T00:00:00Z");
      const shift = (n) => new Date(d.getTime() + n * 86400e3).toISOString().slice(0, 10);
      const from = shift(-((d.getUTCDay() + 6) % 7)), to = shift(6 - ((d.getUTCDay() + 6) % 7));
      const rows = new Map();
      const row = (id) => { if (!rows.has(id)) rows.set(id, { unitId: id, weekMeetings: 0, openTasks: 0, lateTasks: 0 }); return rows.get(id); };
      for (const r of q.overviewMeetings.all(to, from)) row(r.unit_id).weekMeetings = r.n;
      for (const r of q.overviewTasks.all(day)) { row(r.unit_id).openTasks = r.open || 0; row(r.unit_id).lateTasks = r.late || 0; }
      return send(res, 200, { week: { from, to }, rows: [...rows.values()] });
    }

    /* 조직도 자리 (표로 편집) */
    if (path === "/api/admin/org/settings" && method === "PUT") {
      const b = await readJson(req);
      if (b.baseDate && !isDate(b.baseDate)) throw bad("기준일을 확인해 주세요.");
      q.setSetting.run("org_base_date", b.baseDate || "");
      return send(res, 200, orgOut());
    }
    if (path === "/api/admin/org/positions" && method === "POST") {
      const b = await readJson(req);
      const id = inTx(() => {
        const v = positionInput(b);
        const after = idOrNull(b.afterId) && q.position.get(b.afterId);
        const id = Number(q.addPosition.run(...v, q.maxPositionSort.get().n + 10).lastInsertRowid);
        if (after) { const ids = q.positions.all().map((p) => p.id).filter((x) => x !== id); ids.splice(ids.indexOf(after.id) + 1, 0, id); renumber(ids); }
        if (v[3]) q.setUserUnitIfEmpty.run(v[0], v[3]);
        return id;
      });
      return send(res, 201, { id, ...orgOut() });
    }
    const posm = path.match(/^\/api\/admin\/org\/positions\/(\d+)$/);
    if (posm) {
      const p = q.position.get(Number(posm[1]));
      if (!p) return send(res, 404, { error: "조직도에서 그 줄을 찾을 수 없어요." });
      if (method === "PATCH") {
        const b = await readJson(req);
        inTx(() => {
          const v = positionInput(b, p);
          q.setPosition.run(...v, p.id);
          if (v[3] && v[3] !== p.user_id) q.setUserUnitIfEmpty.run(v[0], v[3]); // 처음 연결하면 대표 소속으로
          // 자리의 사람이 바뀌면 그 자리의 연락처는 지움 (다른 사람 번호가 남지 않게)
          if (v[2] !== p.name || (p.user_id && v[3] !== p.user_id) || b.person === "other") q.delContactOfPosition.run(p.id);
          // 같은 이름 자리: 'same' 같은 사람(겸직), 'other' 다른 사람(동명이인), '' 다시 안 정함
          if (has(b, "person")) q.setPositionPerson.run(b.person === "same" ? v[2] : b.person === "other" ? `${v[2]}#${p.id}` : "", p.id);
          else if (v[2] !== p.name && p.person) q.setPositionPerson.run("", p.id); // 이름이 바뀌면 구분 다시
          if (Number.isInteger(b.index)) { // 끌어서 순서 바꾸기
            const ids = q.positions.all().map((x) => x.id).filter((x) => x !== p.id);
            ids.splice(Math.max(0, Math.min(b.index, ids.length)), 0, p.id);
            renumber(ids);
          }
        });
        return send(res, 200, orgOut());
      }
      if (method === "DELETE") { q.delPosition.run(p.id); return send(res, 200, orgOut()); }
      return send(res, 405, { error: "Method not allowed" });
    }
    // 엑셀 불러오기: 먼저 비교만 (preview), 확인하면 반영 (apply)
    if (path === "/api/admin/org/preview" && method === "POST") {
      const { out } = orgDiff((await readJson(req)).rows);
      return send(res, 200, { same: out.same.length, add: out.add, move: out.move, remove: out.remove });
    }
    if (path === "/api/admin/org/apply" && method === "POST") {
      const b = await readJson(req);
      if (b.baseDate && !isDate(b.baseDate)) throw bad("기준일을 확인해 주세요.");
      const result = inTx(() => {
        const { rows, match, out } = orgDiff(b.rows);
        const keep = b.removeIds === undefined ? null : new Set(ids(b.removeIds));
        const order = [];
        for (const r of rows) {
          const unit = resolveUnit(r.hq, r.dept, r.team);
          const p = match.get(r.i);
          if (p) { if (r.name !== p.name) q.delContactOfPosition.run(p.id); q.setPosition.run(unit, r.title, r.name, p.user_id, r.note || p.note, p.id); order.push(p.id); }
          else order.push(Number(q.addPosition.run(unit, r.title, r.name, null, r.note, 0).lastInsertRowid));
        }
        let removed = 0;
        for (const x of out.remove) if (!keep || keep.has(x.id)) { q.delPosition.run(x.id); removed++; }
        // 순번: 엑셀 순서대로, 공석·남긴 자리는 같은 조직 첫 줄 앞에
        const rest = q.positions.all().filter((p) => !order.includes(p.id));
        const all = order.slice();
        for (const p of rest) {
          const at = all.findIndex((id) => q.position.get(id).unit_id === p.unit_id);
          all.splice(at < 0 ? all.length : at, 0, p.id);
        }
        renumber(all);
        if (b.baseDate) q.setSetting.run("org_base_date", b.baseDate);
        return { added: out.add.length, moved: out.move.length, removed };
      });
      console.log(`[admin] ${user.login} → 조직도 불러오기 (추가 ${result.added}, 이동 ${result.moved}, 빠짐 ${result.removed})`);
      return send(res, 200, { ...result, ...orgOut() });
    }

    /* 조직도 */
    /* 연락처 카테고리·외부 연락처 (값은 로그에 남기지 않음) */
    if (path === "/api/admin/contact-categories" && method === "POST") {
      const name = text((await readJson(req)).name, 30, "카테고리 이름", true);
      if (q.contactCategoryByName.get(name)) throw bad("이미 있는 카테고리예요.");
      q.addContactCategory.run(name);
      return send(res, 201, contactsFor(user));
    }
    const ccm = path.match(/^\/api\/admin\/contact-categories\/(\d+)$/);
    if (ccm) {
      const c = q.contactCategory.get(Number(ccm[1]));
      if (!c) return send(res, 404, { error: "카테고리를 찾을 수 없어요." });
      if (method === "PATCH") {
        const name = text((await readJson(req)).name, 30, "카테고리 이름", true);
        const same = q.contactCategoryByName.get(name);
        if (same && same.id !== c.id) throw bad("이미 있는 카테고리예요.");
        q.setContactCategory.run(name, c.id);
        return send(res, 200, contactsFor(user));
      }
      if (method === "DELETE") { q.delContactCategory.run(c.id); return send(res, 200, contactsFor(user)); } // 연락처는 미분류로 남음
      return send(res, 405, { error: "Method not allowed" });
    }
    if (path === "/api/admin/external-contacts" && method === "POST") {
      q.addExternal.run(...externalInput(await readJson(req)));
      console.log(`[admin] ${user.login} → 외부 연락처 추가`);
      return send(res, 201, contactsFor(user));
    }
    const exm = path.match(/^\/api\/admin\/external-contacts\/(\d+)$/);
    if (exm) {
      const e = q.external.get(Number(exm[1]));
      if (!e) return send(res, 404, { error: "연락처를 찾을 수 없어요." });
      if (method === "PATCH") { q.setExternal.run(...externalInput(await readJson(req)), e.id); return send(res, 200, contactsFor(user)); }
      if (method === "DELETE") { q.delExternal.run(e.id); return send(res, 200, contactsFor(user)); }
      return send(res, 405, { error: "Method not allowed" });
    }

    if (path === "/api/admin/units" && method === "POST") {
      const b = await readJson(req);
      const lead = idOrNull(b.leadId);
      if (lead && !q.userExists.get(lead)) throw bad("책임자를 찾을 수 없어요.");
      const r = addUnit(idOrNull(b.parentId), b.name, b.short, lead);
      if (!r.created) throw bad("같은 자리에 이미 있는 조직이에요.");
      return send(res, 201, { id: r.id, units: unitsOut() });
    }
    // 여러 줄 한 번에: 한 줄에 '조직위원회 > 운영총괄부 > 식음료팀', 없는 것만 만듦
    if (path === "/api/admin/units/bulk" && method === "POST") {
      const lines = String((await readJson(req)).text ?? "").split(/\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length > 500) throw bad("한 번에 500줄까지 넣을 수 있어요.");
      const added = inTx(() => {
        let n = 0;
        for (const line of lines) {
          const parts = line.split(/\s*[>›]\s*/).filter(Boolean);
          if (parts.length > UNIT_DEPTH) throw bad(`'${line}' — 조직은 ${UNIT_DEPTH}단계까지예요.`);
          let parent = null;
          for (const p of parts) { const r = addUnit(parent, p); parent = r.id; if (r.created) n++; }
        }
        return n;
      });
      return send(res, 200, { added, units: unitsOut() });
    }
    const unm = path.match(/^\/api\/admin\/units\/(\d+)(\/stats)?$/);
    if (unm) {
      const u = q.unit.get(Number(unm[1]));
      if (!u) return send(res, 404, { error: "조직을 찾을 수 없어요." });
      // 이 조직(아래 조직 포함)과 연결된 것: 이번 달 회의, 남은 할 일, 구글 캘린더
      if (unm[2] && method === "GET") {
        const scope = JSON.stringify(unitSubtree(u.id));
        const ids = JSON.stringify(unitUserIds(unitSubtree(u.id)));
        const month = (isDate(param("today")) ? param("today") : new Date().toISOString().slice(0, 10)).slice(0, 7);
        return send(res, 200, {
          meetings: q.unitMeetings.all({ from: month + "-01", to: month + "-31", ids, ...V }).length,
          openTasks: q.unitTasks.all({ ids, ...V }).length,
          calendars: q.calendarsInUnits.get(scope).n
        });
      }
      if (!unm[2] && method === "PATCH") {
        const b = await readJson(req);
        inTx(() => {
          const name = has(b, "name") ? text(b.name, LIMITS.unitName, "조직 이름", true) : u.name;
          const parent = has(b, "parentId") ? idOrNull(b.parentId) : u.parent_id;
          if (parent && !q.unit.get(parent)) throw bad("상위 조직을 찾을 수 없어요.");
          const same = q.unitByName.get(name, parent);
          if (same && same.id !== u.id) throw bad("같은 자리에 이미 있는 조직이에요.");
          const lead = has(b, "leadId") ? idOrNull(b.leadId) : u.lead_id;
          if (lead && !q.userExists.get(lead)) throw bad("책임자를 찾을 수 없어요.");
          q.setUnit.run(name, has(b, "short") ? text(b.short, LIMITS.unitShort, "약칭") : u.short_name, lead, u.id);
          if (has(b, "parentId") || has(b, "index")) placeUnit(u, parent, b.index);
        });
        return send(res, 200, { units: unitsOut() });
      }
      if (!unm[2] && method === "DELETE") {
        inTx(() => {
          q.liftUnitChildren.run(u.parent_id, u.id);
          q.liftUnitUsers.run(u.parent_id, u.id);
          q.liftUnitCalendars.run(u.parent_id, u.id);
          if (u.parent_id) q.liftUnitPositions.run(u.parent_id, u.id); // 맨 위 조직이면 자리도 함께 지워짐
          for (const st of q.liftUnitItems) st.run(u.parent_id, u.id); // 항목의 팀도 한 단계 위로
          q.delUnit.run(u.id);
        });
        return send(res, 200, { units: unitsOut(), team: teamOut() });
      }
      return send(res, 405, { error: "Method not allowed" });
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
        const unit = has(b, "unitId") ? unitIdOrNull(b.unitId) : target.unit_id;
        const note = has(b, "note") ? text(b.note, LIMITS.userNote, "메모") : target.note;
        const role = b.role === "admin" ? "admin" : b.role === "member" || b.role === "director" ? "member" : target.role;
        const director = b.role === "director" ? 1 : b.role === "admin" || b.role === "member" ? 0 : target.director;
        if (lastAdmin && role !== "admin") throw bad("관리자가 한 명은 있어야 해요.");
        // 추가로 볼 수 있는 조직: [{ unitId, sub }] 로 통째로 바꿈
        let grants = null;
        if (has(b, "viewUnits")) {
          if (!Array.isArray(b.viewUnits) || b.viewUnits.length > 20) throw bad("추가로 볼 조직은 20개까지 정할 수 있어요.");
          grants = b.viewUnits.map((g) => ({ unit: unitIdOrNull(g?.unitId), sub: g?.sub === false ? 0 : 1 })).filter((g) => g.unit);
        }
        inTx(() => {
          q.setUser.run(name, unit, note, role, target.id);
          q.setUserDirector.run(director, target.id);
          if (grants) { q.clearViewUnits.run(target.id); for (const g of grants) q.addViewUnit.run(target.id, g.unit, g.sub); }
        });
        if (grants) console.log(`[admin] ${user.login} → ${target.login} 추가로 볼 조직 ${grants.length}개`);
        return send(res, 200, { ok: true, viewUnits: viewUnitsOut(target.id) });
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
