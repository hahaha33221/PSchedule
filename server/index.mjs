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
import { parseOutline, importOutline, cleanContact, openDb, ensureAdmin, verifyPassword, hashPassword, tempPassword } from "./db.mjs";
import { eduStatus, EDU_STATUS_SQL, setEduStatus } from "./edu-status.mjs";
import { createCalendarSync, checkUrl, maskUrl } from "./calendars.mjs";
import { startAutoBackup, listBackups, backupNow, pruneBackups } from "./backup.mjs";
import { vapidKeys, sendPush, pushEndpointOk } from "./push.mjs";

const PORT = Number(process.env.PORT) || 8787;
const DATA_DIR = resolve(process.env.DATA_DIR || "data");
const STATIC_DIR = process.env.STATIC_DIR ? resolve(process.env.STATIC_DIR) : null;
const DEV = process.env.DEV === "1";
// 새로 만드는 DB·백업 파일은 소유자만 읽고 쓰게 (같은 서버의 다른 계정이 못 읽음)
process.umask(0o077);
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString("hex"));
// 화면 보안 정책: Vercel(vercel.json)과 같게. 로컬 개발만 자동 새로고침 스크립트 허용
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net data:; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
const BACKUP_DIR = resolve(process.env.BACKUP_DIR || join(DATA_DIR, "backups"));
const BACKUP_KEEP_DAYS = process.env.BACKUP_KEEP_DAYS === undefined ? 30 : Number(process.env.BACKUP_KEEP_DAYS) || 0;
const BACKUP_HOUR = Number(process.env.BACKUP_HOUR ?? 4);

const SESSION_DAYS = 30; // 자동 로그인 유지 기간 (쓰는 동안 계속 늘어남)
const SESSION_SHORT_HOURS = 12; // 자동 로그인을 끈 로그인 (창을 닫으면 화면에서도 지움)
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
// 알림(웹 푸시): 서버 키는 처음 한 번 만들어 설정에 둠
const VAPID = vapidKeys(db);
const PUSH_SUBJECT = process.env.PUSH_SUBJECT || "https://pschedule.vercel.app";

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
    SELECT u.id, u.login, u.role, u.director, u.volunteer, u.vol_kind, u.vol_leader, s.vol_mode, s.remember, s.expires_at, u.name, u.unit_id, u.pw_changed, u.pw_hash FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`),
  addSession: db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, vol_mode, remember) VALUES (?, ?, ?, ?, ?)"),
  extendSession: db.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?"),
  setSessionMode: db.prepare("UPDATE sessions SET vol_mode = ? WHERE token_hash = ?"),
  delSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
  delOtherSessions: db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?"),
  delUserSessions: db.prepare("DELETE FROM sessions WHERE user_id = ?"),
  purgeSessions: db.prepare("DELETE FROM sessions WHERE expires_at <= ?"),
  setPassword: db.prepare("UPDATE users SET pw_hash = ?, pw_changed = 1 WHERE id = ?"),
  resetPassword: db.prepare("UPDATE users SET pw_hash = ?, pw_changed = 2 WHERE id = ?"),
  touchLogin: db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?"),
  team: db.prepare("SELECT id, name, unit_id FROM users WHERE volunteer = 0 ORDER BY name, id"),
  userExists: db.prepare("SELECT 1 FROM users WHERE id = ? AND volunteer = 0"), // 담당자·책임자·자리 연결: 직원만

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
  contactUsers: db.prepare("SELECT id, name, role, unit_id FROM users WHERE volunteer = 0 ORDER BY id"),
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
  addAttendee: db.prepare("INSERT OR IGNORE INTO event_attendees (event_id, user_id) SELECT ?, id FROM users WHERE id = ? AND volunteer = 0"),
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
  setTaskStart: db.prepare("UPDATE tasks SET start_date = ? WHERE id = ?"),
  // 프로젝트
  projects: db.prepare("SELECT * FROM projects ORDER BY id"),
  project: db.prepare("SELECT * FROM projects WHERE id = ?"),
  addProject: db.prepare("INSERT INTO projects (unit_id, name, note, created_by) VALUES (?, ?, ?, ?)"),
  setProject: db.prepare("UPDATE projects SET unit_id = ?, name = ?, note = ?, updated_at = datetime('now') WHERE id = ?"),
  delProject: db.prepare("DELETE FROM projects WHERE id = ?"),
  projectItems: db.prepare("SELECT * FROM project_items WHERE project_id = ? ORDER BY id"),
  allProjectItems: db.prepare("SELECT project_id, kind, status, due_date FROM project_items"),
  projectItem: db.prepare("SELECT * FROM project_items WHERE id = ?"),
  addProjectItem: db.prepare("INSERT INTO project_items (project_id, parent_id, kind, name, status, assignee_id, due_date, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
  areaInfo: db.prepare("SELECT area, partner, note FROM project_area_info WHERE project_id = ? ORDER BY area"),
  setAreaInfo: db.prepare("INSERT INTO project_area_info (project_id, area, partner, note) VALUES (?, ?, ?, ?) ON CONFLICT (project_id, area) DO UPDATE SET partner = excluded.partner, note = excluded.note"),
  setItemQty: db.prepare("UPDATE project_items SET qty = ? WHERE id = ?"),
  itemImagesOfProject: db.prepare("SELECT g.item_id, g.updated_at FROM project_item_images g JOIN project_items i ON i.id = g.item_id WHERE i.project_id = ?"),
  itemImage: db.prepare("SELECT * FROM project_item_images WHERE item_id = ?"),
  setItemImage: db.prepare("INSERT INTO project_item_images (item_id, mime, data, updated_by, updated_at) VALUES (?, ?, ?, ?, datetime('now')) ON CONFLICT (item_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_by = excluded.updated_by, updated_at = excluded.updated_at"),
  delItemImage: db.prepare("DELETE FROM project_item_images WHERE item_id = ?"),
  setItemPartner: db.prepare("UPDATE project_items SET partner_related = ? WHERE id = ?"),
  setProcessPartner: db.prepare("UPDATE project_processes SET partner_related = ? WHERE id = ?"),
  setProjectItemArea: db.prepare("UPDATE project_items SET area = ? WHERE id = ?"),
  setImportedArea: db.prepare("UPDATE project_items SET area = ? WHERE project_id = ? AND parent_id IS NULL AND id > ?"),
  maxItemId: db.prepare("SELECT coalesce(max(id), 0) AS n FROM project_items"),
  setProjectItem: db.prepare("UPDATE project_items SET name = ?, status = ?, assignee_id = ?, due_date = ?, note = ?, updated_at = datetime('now') WHERE id = ?"),
  delProjectItem: db.prepare("DELETE FROM project_items WHERE id = ?"),
  // 입출고 현황
  ledger: db.prepare("SELECT * FROM stock_ledgers WHERE id = ?"),
  ledgersOfProject: db.prepare(`SELECT l.*, i.project_id,
      (SELECT coalesce(sum(q.qty), 0) FROM stock_qty q JOIN stock_moves m ON m.id = q.move_id WHERE m.ledger_id = l.id AND m.type = 'in') AS in_total,
      (SELECT coalesce(sum(q.qty), 0) FROM stock_qty q JOIN stock_moves m ON m.id = q.move_id WHERE m.ledger_id = l.id AND m.type = 'out') AS out_total
    FROM stock_ledgers l JOIN project_items i ON i.id = l.item_id WHERE i.project_id = ? ORDER BY l.id`),
  // 봉사자: 기념품팀 프로젝트(읽기), 일정, 기본 교육
  volProjects: db.prepare("SELECT p.* FROM projects p JOIN org_units u ON u.id = p.unit_id WHERE u.name = ? ORDER BY p.id"),
  volProject: db.prepare("SELECT p.* FROM projects p JOIN org_units u ON u.id = p.unit_id WHERE u.name = ? AND p.id = ?"),
  volSchedulesFor: db.prepare(`SELECT s.* FROM vol_schedules s WHERE s.audience = 'all' OR EXISTS (SELECT 1 FROM vol_schedule_users x WHERE x.schedule_id = s.id AND x.user_id = ?) ORDER BY s.date, s.start_time, s.id`),
  volSchedulesAll: db.prepare("SELECT * FROM vol_schedules ORDER BY date DESC, start_time, id"),
  volSchedule: db.prepare("SELECT * FROM vol_schedules WHERE id = ?"),
  addVolSchedule: db.prepare("INSERT INTO vol_schedules (title, date, start_time, end_time, place, note, audience, qty, project_item_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
  setVolSchedule: db.prepare("UPDATE vol_schedules SET title = ?, date = ?, start_time = ?, end_time = ?, place = ?, note = ?, audience = ?, qty = ?, project_item_id = ? WHERE id = ?"),
  setVolQty: db.prepare("UPDATE vol_schedules SET qty = ? WHERE id = ?"),
  markVolQty: db.prepare("UPDATE vol_schedules SET qty_by = ?, qty_at = datetime('now') WHERE id = ?"),
  setVolMat: db.prepare("UPDATE vol_schedules SET thread_qty = ?, cross_qty = ?, mat_by = ?, mat_at = datetime('now') WHERE id = ?"),
  setVolEdu: db.prepare("UPDATE vol_schedules SET edu_qty = ?, edu_by = ?, edu_at = datetime('now') WHERE id = ?"),
  delVolSchedule: db.prepare("DELETE FROM vol_schedules WHERE id = ?"),
  setVolTableOnly: db.prepare("UPDATE vol_schedules SET table_only = ? WHERE id = ?"),
  volRecords: db.prepare("SELECT r.*, u.name AS author FROM vol_records r LEFT JOIN users u ON u.id = r.created_by WHERE r.item_id = ? AND r.kind = ? ORDER BY r.date DESC, r.id DESC"),
  volRecord: db.prepare("SELECT * FROM vol_records WHERE id = ?"),
  addVolRecord: db.prepare("INSERT INTO vol_records (item_id, kind, date, name, qty, note, created_by, stage) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
  setVolRecord: db.prepare("UPDATE vol_records SET date = ?, name = ?, qty = ?, note = ?, stage = ?, updated_at = datetime('now') WHERE id = ?"),
  delVolRecord: db.prepare("DELETE FROM vol_records WHERE id = ?"),
  volScheduleUsers: db.prepare("SELECT x.user_id FROM vol_schedule_users x JOIN users u ON u.id = x.user_id AND u.volunteer = 1 WHERE x.schedule_id = ?"),
  clearVolScheduleUsers: db.prepare("DELETE FROM vol_schedule_users WHERE schedule_id = ?"),
  addVolScheduleUser: db.prepare("INSERT OR IGNORE INTO vol_schedule_users (schedule_id, user_id) VALUES (?, ?)"),
  isVolunteer: db.prepare("SELECT 1 FROM users WHERE id = ? AND volunteer = 1"),
  volTrainings: db.prepare("SELECT * FROM vol_trainings ORDER BY date = '', date, start_time, id"),
  volTraining: db.prepare("SELECT * FROM vol_trainings WHERE id = ?"),
  addVolTraining: db.prepare("INSERT INTO vol_trainings (title, body, date, start_time, place, link, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)"),
  setVolTraining: db.prepare("UPDATE vol_trainings SET title = ?, body = ?, date = ?, start_time = ?, place = ?, link = ? WHERE id = ?"),
  delVolTraining: db.prepare("DELETE FROM vol_trainings WHERE id = ?"),
  volDoneOfUser: db.prepare("SELECT training_id, done_at FROM vol_training_done WHERE user_id = ?"),
  volDoneOfTraining: db.prepare("SELECT d.user_id, u.name, d.done_at FROM vol_training_done d JOIN users u ON u.id = d.user_id AND u.volunteer = 1 WHERE d.training_id = ? ORDER BY d.done_at"),
  setVolDone: db.prepare("INSERT OR IGNORE INTO vol_training_done (training_id, user_id) VALUES (?, ?)"),
  clearVolDone: db.prepare("DELETE FROM vol_training_done WHERE training_id = ? AND user_id = ?"),
  lastStockMove: db.prepare("SELECT m.date, m.type, u.name AS author FROM stock_moves m LEFT JOIN users u ON u.id = m.created_by WHERE m.ledger_id = ? ORDER BY m.id DESC LIMIT 1"),
  volStockMoves: db.prepare(`SELECT m.id, m.type, m.date, m.note, m.handler, m.issue, m.inspect_ok, m.inspect_bad, m.created_at, u.name AS author, l.id AS ledger_id, l.name AS ledger_name, l.unit,
      (SELECT coalesce(sum(x.qty), 0) FROM stock_qty x WHERE x.move_id = m.id) AS total,
      (SELECT count(*) FROM stock_move_photos p WHERE p.move_id = m.id) AS photos
    FROM stock_moves m JOIN users u ON u.id = m.created_by AND u.volunteer = 1 JOIN stock_ledgers l ON l.id = m.ledger_id ORDER BY m.id DESC LIMIT 100`),
  processes: db.prepare("SELECT * FROM project_processes WHERE project_id = ? ORDER BY sort_order, id"),
  process: db.prepare("SELECT * FROM project_processes WHERE id = ?"),
  addProcess: db.prepare("INSERT INTO project_processes (project_id, section, phase, task, detail, output, label, start_date, due_date, status, note, area, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT coalesce(max(sort_order), 0) + 1 FROM project_processes WHERE project_id = ?))"),
  setProcess: db.prepare("UPDATE project_processes SET section = ?, phase = ?, task = ?, detail = ?, output = ?, label = ?, start_date = ?, due_date = ?, status = ?, note = ?, area = ?, updated_at = datetime('now') WHERE id = ?"),
  delProcess: db.prepare("DELETE FROM project_processes WHERE id = ?"),
  ledgersAll: db.prepare(`SELECT l.*, i.project_id, i.name AS item_name,
      (SELECT count(*) FROM stock_options o WHERE o.ledger_id = l.id) AS option_count,
      (SELECT coalesce(sum(q.qty), 0) FROM stock_qty q JOIN stock_moves m ON m.id = q.move_id WHERE m.ledger_id = l.id AND m.type = 'in') AS in_total,
      (SELECT coalesce(sum(q.qty), 0) FROM stock_qty q JOIN stock_moves m ON m.id = q.move_id WHERE m.ledger_id = l.id AND m.type = 'out') AS out_total
    FROM stock_ledgers l JOIN project_items i ON i.id = l.item_id ORDER BY i.project_id, l.id`),
  ledgersUnderItem: db.prepare(`WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT pi.id FROM project_items pi JOIN t ON pi.parent_id = t.id)
    SELECT count(*) AS n FROM stock_ledgers WHERE item_id IN (SELECT id FROM t)`),
  addLedger: db.prepare("INSERT INTO stock_ledgers (item_id, name, unit, in_label, out_label, contract, after) VALUES (?, ?, ?, ?, ?, ?, ?)"),
  setLedger: db.prepare("UPDATE stock_ledgers SET name = ?, unit = ?, in_label = ?, out_label = ?, contract = ?, after = ? WHERE id = ?"),
  delLedger: db.prepare("DELETE FROM stock_ledgers WHERE id = ?"),
  stockOptions: db.prepare("SELECT id, name FROM stock_options WHERE ledger_id = ? ORDER BY id"),
  addStockOption: db.prepare("INSERT INTO stock_options (ledger_id, name) VALUES (?, ?)"),
  setStockOption: db.prepare("UPDATE stock_options SET name = ? WHERE id = ? AND ledger_id = ?"),
  delStockOption: db.prepare("DELETE FROM stock_options WHERE id = ?"),
  stockOptionUsed: db.prepare("SELECT 1 FROM stock_qty WHERE option_id = ? LIMIT 1"),
  stockMoves: db.prepare("SELECT * FROM stock_moves WHERE ledger_id = ? ORDER BY id"),
  stockMove: db.prepare("SELECT * FROM stock_moves WHERE id = ?"),
  addStockMove: db.prepare("INSERT INTO stock_moves (ledger_id, type, date, handler, note, created_by) VALUES (?, ?, ?, ?, ?, ?)"),
  setStockMove: db.prepare("UPDATE stock_moves SET date = ?, handler = ?, note = ? WHERE id = ?"),
  delStockMove: db.prepare("DELETE FROM stock_moves WHERE id = ?"),
  setMoveIssue: db.prepare("UPDATE stock_moves SET issue = ? WHERE id = ?"),
  boardPosts: db.prepare("SELECT b.*, u.name AS author, (SELECT count(*) FROM board_comments c WHERE c.post_id = b.id) AS comments FROM board_posts b LEFT JOIN users u ON u.id = b.created_by ORDER BY b.id DESC"),
  boardPost: db.prepare("SELECT b.*, u.name AS author FROM board_posts b LEFT JOIN users u ON u.id = b.created_by WHERE b.id = ?"),
  addBoardPost: db.prepare("INSERT INTO board_posts (category, title, body, secret, created_by) VALUES (?, ?, ?, ?, ?)"),
  setBoardPost: db.prepare("UPDATE board_posts SET category = ?, title = ?, body = ?, secret = ?, updated_at = datetime('now') WHERE id = ?"),
  delBoardPost: db.prepare("DELETE FROM board_posts WHERE id = ?"),
  boardComments: db.prepare("SELECT c.*, u.name AS author, u.role AS author_role FROM board_comments c LEFT JOIN users u ON u.id = c.created_by WHERE c.post_id = ? ORDER BY c.id"),
  boardComment: db.prepare("SELECT * FROM board_comments WHERE id = ?"),
  addBoardComment: db.prepare("INSERT INTO board_comments (post_id, body, created_by) VALUES (?, ?, ?)"),
  delBoardComment: db.prepare("DELETE FROM board_comments WHERE id = ?"),
  inspections: db.prepare("SELECT x.*, u.name AS author, i.name AS group_name, (SELECT group_concat(p.id) FROM inspection_photos p WHERE p.inspection_id = x.id) AS photo_ids FROM inspections x JOIN project_items i ON i.id = x.item_id LEFT JOIN users u ON u.id = x.created_by ORDER BY x.date DESC, x.id DESC"),
  inspection: db.prepare("SELECT * FROM inspections WHERE id = ?"),
  addInspection: db.prepare("INSERT INTO inspections (item_id, stage, date, source, checked_qty, sampled, sample_qty, defects, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
  setInspection: db.prepare("UPDATE inspections SET item_id = ?, stage = ?, date = ?, source = ?, checked_qty = ?, sampled = ?, sample_qty = ?, defects = ?, note = ?, updated_at = datetime('now') WHERE id = ?"),
  delInspection: db.prepare("DELETE FROM inspections WHERE id = ?"),
  inspPhoto: db.prepare("SELECT * FROM inspection_photos WHERE id = ?"),
  inspPhotoCount: db.prepare("SELECT count(*) AS n FROM inspection_photos WHERE inspection_id = ?"),
  addInspPhoto: db.prepare("INSERT INTO inspection_photos (inspection_id, mime, data, created_by) VALUES (?, ?, ?, ?)"),
  delInspPhoto: db.prepare("DELETE FROM inspection_photos WHERE id = ?"),
  setInspRework: db.prepare("UPDATE inspections SET rework = ? WHERE id = ?"),
  // 팀 봉사자(교육·검수)
  teamOrgInfo: db.prepare("SELECT * FROM team_org_info WHERE schedule_id = ?"),
  teamOrgInfos: db.prepare("SELECT * FROM team_org_info"),
  teamOrgUpsert: db.prepare(`INSERT INTO team_org_info (schedule_id, contact, helper, status, attend, result_note, made_qty, made_due, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(schedule_id) DO UPDATE SET contact = excluded.contact, helper = excluded.helper, status = excluded.status, attend = excluded.attend, result_note = excluded.result_note, made_qty = excluded.made_qty, made_due = excluded.made_due, updated_by = excluded.updated_by, updated_at = excluded.updated_at`),
  teamInqCounts: db.prepare("SELECT schedule_id, COUNT(*) AS n, SUM(done = 0) AS open FROM team_inquiries GROUP BY schedule_id"),
  teamInqs: db.prepare("SELECT x.*, u.name AS author FROM team_inquiries x LEFT JOIN users u ON u.id = x.created_by WHERE x.schedule_id = ? ORDER BY x.date DESC, x.id DESC"),
  teamInq: db.prepare("SELECT * FROM team_inquiries WHERE id = ?"),
  addTeamInq: db.prepare("INSERT INTO team_inquiries (schedule_id, date, question, answer, done, created_by) VALUES (?, ?, ?, ?, ?, ?)"),
  setTeamInq: db.prepare("UPDATE team_inquiries SET date = ?, question = ?, answer = ?, done = ?, updated_at = datetime('now') WHERE id = ?"),
  delTeamInq: db.prepare("DELETE FROM team_inquiries WHERE id = ?"),
  teamIssues: db.prepare("SELECT x.*, u.name AS author, s.title AS org_title, (SELECT group_concat(p.id) FROM team_issue_photos p WHERE p.issue_id = x.id) AS photo_ids FROM team_issues x LEFT JOIN users u ON u.id = x.created_by LEFT JOIN vol_schedules s ON s.id = x.schedule_id ORDER BY (x.status = 'done'), x.created_at DESC, x.id DESC"),
  teamIssue: db.prepare("SELECT * FROM team_issues WHERE id = ?"),
  addTeamIssue: db.prepare("INSERT INTO team_issues (kind, schedule_id, title, body, created_by) VALUES (?, ?, ?, ?, ?)"),
  setTeamIssue: db.prepare("UPDATE team_issues SET kind = ?, schedule_id = ?, title = ?, body = ?, updated_at = datetime('now') WHERE id = ?"),
  setTeamIssueStatus: db.prepare("UPDATE team_issues SET status = ?, reply = ?, updated_at = datetime('now') WHERE id = ?"),
  delTeamIssue: db.prepare("DELETE FROM team_issues WHERE id = ?"),
  teamIssuePhoto: db.prepare("SELECT * FROM team_issue_photos WHERE id = ?"),
  teamIssuePhotoCount: db.prepare("SELECT count(*) AS n FROM team_issue_photos WHERE issue_id = ?"),
  addTeamIssuePhoto: db.prepare("INSERT INTO team_issue_photos (issue_id, mime, data, created_by) VALUES (?, ?, ?, ?)"),
  delTeamIssuePhoto: db.prepare("DELETE FROM team_issue_photos WHERE id = ?"),
  teamDaily: db.prepare("SELECT x.*, u.name AS author FROM team_daily x LEFT JOIN users u ON u.id = x.created_by ORDER BY x.date DESC, x.id DESC LIMIT 500"),
  teamDailyOne: db.prepare("SELECT * FROM team_daily WHERE id = ?"),
  addTeamDaily: db.prepare("INSERT INTO team_daily (date, qty, workers, note, created_by) VALUES (?, ?, ?, ?, ?)"),
  setTeamDaily: db.prepare("UPDATE team_daily SET date = ?, qty = ?, workers = ?, note = ?, updated_at = datetime('now') WHERE id = ?"),
  delTeamDaily: db.prepare("DELETE FROM team_daily WHERE id = ?"),
  teamShifts: db.prepare("SELECT * FROM team_shifts WHERE date >= ? ORDER BY date, start_time, id"),
  teamShift: db.prepare("SELECT * FROM team_shifts WHERE id = ?"),
  teamShiftUsers: db.prepare("SELECT x.shift_id, u.id, u.name FROM team_shift_users x JOIN users u ON u.id = x.user_id ORDER BY u.name"),
  addTeamShift: db.prepare("INSERT INTO team_shifts (date, start_time, need, note, created_by) VALUES (?, ?, ?, ?, ?)"),
  delTeamShift: db.prepare("DELETE FROM team_shifts WHERE id = ?"),
  teamShiftJoin: db.prepare("INSERT OR IGNORE INTO team_shift_users (shift_id, user_id) VALUES (?, ?)"),
  teamShiftLeave: db.prepare("DELETE FROM team_shift_users WHERE shift_id = ? AND user_id = ?"),
  teamAvailMine: db.prepare("SELECT date FROM team_avail WHERE user_id = ? AND date >= ? ORDER BY date"),
  teamAvailCounts: db.prepare("SELECT date, COUNT(*) AS n FROM team_avail WHERE date >= ? GROUP BY date"),
  teamAvailPeople: db.prepare("SELECT a.date, u.name FROM team_avail a JOIN users u ON u.id = a.user_id WHERE a.date >= ? ORDER BY a.date, u.name"),
  addTeamAvail: db.prepare("INSERT OR IGNORE INTO team_avail (user_id, date) VALUES (?, ?)"),
  delTeamAvail: db.prepare("DELETE FROM team_avail WHERE user_id = ? AND date = ?"),
  teamDocs: db.prepare("SELECT * FROM team_docs ORDER BY category, id"),
  teamDayNeeds: db.prepare("SELECT * FROM team_day_need WHERE date >= ?"),
  setTeamDayNeed: db.prepare("INSERT INTO team_day_need (date, need, note, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(date) DO UPDATE SET need = excluded.need, note = excluded.note, updated_by = excluded.updated_by, updated_at = datetime('now')"),
  delTeamDayNeed: db.prepare("DELETE FROM team_day_need WHERE date = ?"),
  teamRecoveries: db.prepare("SELECT x.*, u.name AS author, s.title AS org_title FROM team_recovery x JOIN vol_schedules s ON s.id = x.schedule_id LEFT JOIN users u ON u.id = x.created_by ORDER BY x.date DESC, x.id DESC"),
  teamRecovery: db.prepare("SELECT * FROM team_recovery WHERE id = ?"),
  addTeamRecovery: db.prepare("INSERT INTO team_recovery (schedule_id, date, qty, method, note, created_by) VALUES (?, ?, ?, ?, ?, ?)"),
  setTeamRecovery: db.prepare("UPDATE team_recovery SET schedule_id = ?, date = ?, qty = ?, method = ?, note = ?, updated_at = datetime('now') WHERE id = ?"),
  delTeamRecovery: db.prepare("DELETE FROM team_recovery WHERE id = ?"),
  teamDoc: db.prepare("SELECT * FROM team_docs WHERE id = ?"),
  addTeamDoc: db.prepare("INSERT INTO team_docs (category, title, url, note) VALUES (?, ?, ?, ?)"),
  setTeamDoc: db.prepare("UPDATE team_docs SET category = ?, title = ?, url = ?, note = ? WHERE id = ?"),
  delTeamDoc: db.prepare("DELETE FROM team_docs WHERE id = ?"),
  setMoveInspect: db.prepare("UPDATE stock_moves SET inspect_ok = ?, inspect_bad = ? WHERE id = ?"),
  // 직원 프로젝트 '봉사자 현황': 묶음별 일정·신청·기록·변동
  volSchedulesOfItems: db.prepare("SELECT * FROM vol_schedules WHERE project_item_id IS NOT NULL ORDER BY date, start_time"),
  volRequestsOf: db.prepare("SELECT * FROM vol_requests WHERE item_id = ? ORDER BY req_date, req_time, no"),
  volRecordsOfItem: db.prepare("SELECT r.*, u.name AS author FROM vol_records r LEFT JOIN users u ON u.id = r.created_by WHERE r.item_id = ? ORDER BY r.date DESC, r.id DESC"),
  stockMonthly: db.prepare("SELECT substr(m.date, 1, 7) AS month, m.type, sum(q.qty) AS total FROM stock_moves m JOIN stock_qty q ON q.move_id = m.id WHERE m.ledger_id = ? AND m.date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]*' GROUP BY month, m.type"),
  stockHistoryRecent: db.prepare("SELECT h.*, l.name AS ledger_name, coalesce(u.volunteer, 0) AS by_volunteer FROM stock_history h JOIN stock_ledgers l ON l.id = h.ledger_id LEFT JOIN users u ON u.id = h.user_id WHERE h.ledger_id = ? ORDER BY h.id DESC LIMIT 60"),
  volRecordsAll: db.prepare("SELECT r.*, u.name AS author, i.name AS group_name FROM vol_records r LEFT JOIN users u ON u.id = r.created_by JOIN project_items i ON i.id = r.item_id ORDER BY r.date DESC, r.id DESC LIMIT 300"),
  photoIdsOfLedger: db.prepare("SELECT p.id, p.move_id FROM stock_move_photos p JOIN stock_moves m ON m.id = p.move_id WHERE m.ledger_id = ? ORDER BY p.id"),
  photoCount: db.prepare("SELECT count(*) AS n FROM stock_move_photos WHERE move_id = ?"),
  photo: db.prepare("SELECT * FROM stock_move_photos WHERE id = ?"),
  addPhoto: db.prepare("INSERT INTO stock_move_photos (move_id, mime, data, created_by) VALUES (?, ?, ?, ?)"),
  delPhoto: db.prepare("DELETE FROM stock_move_photos WHERE id = ?"),
  stockQtyOfMove: db.prepare("SELECT option_id, qty FROM stock_qty WHERE move_id = ?"),
  addStockHistory: db.prepare("INSERT INTO stock_history (ledger_id, action, summary, user_id, user_name) VALUES (?, ?, ?, ?, ?)"),
  stockHistory: db.prepare("SELECT * FROM stock_history WHERE ledger_id = ? ORDER BY id DESC LIMIT 100"),
  stockQtyOfLedger: db.prepare("SELECT q.move_id, q.option_id, q.qty FROM stock_qty q JOIN stock_moves m ON m.id = q.move_id WHERE m.ledger_id = ?"),
  clearStockQty: db.prepare("DELETE FROM stock_qty WHERE move_id = ?"),
  addStockQty: db.prepare("INSERT INTO stock_qty (move_id, option_id, qty) VALUES (?, ?, ?)"),
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
    SELECT n.id, n.title, substr(n.body, 1, 200) AS preview, n.pinned, n.audience, n.created_at, n.updated_at, u.name AS author,
      (SELECT count(*) FROM comments c WHERE c.target_type = 'notice' AND c.target_id = n.id) AS comments,
      NOT EXISTS (SELECT 1 FROM notice_reads r WHERE r.notice_id = n.id AND r.user_id = ?) AS unread
    FROM notices n LEFT JOIN users u ON u.id = n.created_by
    ORDER BY n.pinned DESC, n.created_at DESC, n.id DESC`),
  notice: db.prepare("SELECT n.*, u.name AS author FROM notices n LEFT JOIN users u ON u.id = n.created_by WHERE n.id = ?"),
  unreadNotices: db.prepare("SELECT count(*) AS n FROM notices n WHERE n.audience IN (SELECT value FROM json_each(?)) AND NOT EXISTS (SELECT 1 FROM notice_reads r WHERE r.notice_id = n.id AND r.user_id = ?)"),
  readNotice: db.prepare("INSERT OR IGNORE INTO notice_reads (user_id, notice_id) VALUES (?, ?)"),
  addNotice: db.prepare("INSERT INTO notices (title, body, pinned, audience, created_by) VALUES (?, ?, ?, ?, ?)"),
  setNotice: db.prepare("UPDATE notices SET title = ?, body = ?, pinned = ?, audience = ?, updated_at = datetime('now') WHERE id = ?"),
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
  setUserVolunteer: db.prepare("UPDATE users SET volunteer = ? WHERE id = ?"),
  setUserVolKind: db.prepare("UPDATE users SET vol_kind = ? WHERE id = ?"),
  setUserVolLeader: db.prepare("UPDATE users SET vol_leader = ? WHERE id = ?"),
  unlinkUserPositions: db.prepare("UPDATE org_positions SET user_id = NULL WHERE user_id = ?"),
  positionUnitsOf: db.prepare("SELECT DISTINCT unit_id AS id FROM org_positions WHERE user_id = ?"),
  users: db.prepare("SELECT id, login, role, director, volunteer, vol_kind, vol_leader, name, unit_id, note, pw_changed, created_at, last_login_at FROM users ORDER BY role = 'admin' DESC, name, id"),
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
  // 그날 할 일: 마감이 그날 / 시작일~마감일 기간 안 / 마감 지난 미완료 / 마감 없이 그날 회의에 연결된 것
  tasksDay: db.prepare(`SELECT ${q.taskCols} ${TASK_FROM}
    WHERE (t.due_date = :day
       OR (t.start_date <= :day AND t.due_date >= :day)
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

/* ---------- 로그인 시도 제한 ----------
 * 키마다 10분 동안 허용 횟수: 'id+ip:' 10회(아이디+접속 IP), 'id:' 30회(아이디 전체, IP를 바꿔도), 'real:' 100회(프록시가 확인한 실제 접속지)
 * 접속 IP 헤더는 꾸밀 수 있어서 그것만으로는 막지 않음 */
const attempts = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const limitOf = (k) => (k.startsWith("real:") ? 100 : k.startsWith("id:") ? 30 : 10);
function tooMany(...keys) {
  const now = Date.now();
  return keys.some((k) => {
    const a = attempts.get(k);
    return a && a.until > now && a.count >= limitOf(k);
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

// nginx 가 직접 넣는 접속지 (요청자가 보낸 같은 이름 헤더는 nginx 가 덮어씀). 로컬 개발에는 nginx 가 없어 소켓 주소
const realIp = (req) => String(req.headers["x-real-ip"] || req.socket.remoteAddress || "");
// 화면에 보이는 사용자 IP (Vercel 을 거치면 그 값). 요청자가 꾸밀 수 있으니 제한의 보조 값으로만 씀
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
  const hash = sha256(m[1]), now = Date.now();
  const u = q.session.get(hash, now);
  if (!u) return null;
  // 자동 로그인: 쓰는 동안은 끊기지 않게, 남은 기간이 절반 아래면 다시 30일로
  if (u.remember && u.expires_at - now < (SESSION_DAYS / 2) * 86400 * 1000) q.extendSession.run(now + SESSION_DAYS * 86400 * 1000, hash);
  delete u.remember; delete u.expires_at;
  u.vol_kinds = volKindsOf(u);
  if (u.volunteer) u.vol_kind = u.vol_kinds.includes(u.vol_mode) ? u.vol_mode : u.vol_kinds[0]; // 지금 쓰는 쪽 하나만 권한으로
  return u;
}
const tokenOf = (req) => String(req.headers.authorization).split(/\s+/)[1];

const roleOut = (u) => (u.volunteer ? "volunteer" : u.director ? "director" : u.role); // 화면·API 에서는 봉사자 / 멤버 / 본부장 / 관리자
const volKindOf = (u) => (u.volunteer ? (u.vol_kind === "team" ? "team" : "dept") : null); // 봉사자 구분(지금 쓰는 쪽): dept 부서 봉사자(물류) · team 팀 봉사자(교육·검수)
// 계정에 있는 봉사자 권한 전부 (users.vol_kind: dept · team · both). 세션에서 덮어쓴 vol_kind 가 아니라 vol_kinds 를 봄
const volKindsOf = (u) => (!u.volunteer ? [] : u.vol_kinds || (u.vol_kind === "both" ? ["dept", "team"] : u.vol_kind === "team" ? ["team"] : ["dept"]));
// 발급·수정 때 봉사자 권한: volKinds 배열(부서·팀 하나 이상) 또는 예전 방식 role "team"
const volKindsInput = (b) => {
  if (Array.isArray(b.volKinds)) {
    const k = b.volKinds.filter((x) => x === "dept" || x === "team");
    if (!k.length) throw bad("봉사자 권한을 하나 이상 골라 주세요.");
    return volKindStore(k);
  }
  return b.role === "team" ? "team" : "dept";
};
const volKindStore = (kinds) => (kinds.includes("dept") && kinds.includes("team") ? "both" : kinds.includes("team") ? "team" : "dept");
const publicUser = (u) => ({ id: u.id, login: u.login, role: roleOut(u), volKind: volKindOf(u), volKinds: volKindsOf(u), volLeader: !!(u.volunteer && u.vol_leader && volKindsOf(u).includes("team")), name: u.name, unitId: u.unit_id, viewUnits: viewUnitsOut(u.id), mustChangePassword: u.pw_changed !== 1 });
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
// 묶음 저장: 안에서 또 부르면 저장점(SAVEPOINT)으로 (실자르기 → 입출고 기록처럼 겹쳐 씀)
let txDepth = 0;
function inTx(fn) {
  const sp = `sp${txDepth}`;
  db.exec(txDepth ? `SAVEPOINT ${sp}` : "BEGIN");
  txDepth++;
  try { const r = fn(); txDepth--; db.exec(txDepth ? `RELEASE ${sp}` : "COMMIT"); return r; }
  catch (e) { txDepth--; db.exec(txDepth ? `ROLLBACK TO ${sp}` : "ROLLBACK"); if (txDepth) db.exec(`RELEASE ${sp}`); throw e; }
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
// 시작일: 새 할 일은 보내지 않으면 오늘. 마감보다 늦으면 직접 정한 값은 오류, 아니면 마감일에 맞춤
function taskStart(b, cur, due) {
  let start = has(b, "startDate") ? b.startDate || null : cur ? cur.start_date : new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  if (start && !isDate(start)) throw bad("시작일을 확인해 주세요.");
  if (start && due && start > due) {
    if (has(b, "startDate")) throw bad("시작일이 마감일보다 늦어요.");
    start = due;
  }
  return start;
}
function saveTaskTags(id, b) {
  if (has(b, "tagIds")) { q.clearTaskTags.run(id); for (const t of ids(b.tagIds)) q.addTaskTag.run(id, t); }
}
function tasksOut(rows, user) {
  const tags = groupBy(q.taskTags, rows, "tag_id");
  return rows.map((t) => ({
    id: t.id, title: t.title, startDate: t.start_date, dueDate: t.due_date, status: t.status, assigneeId: t.assignee_id,
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
// '오늘' 화면에 모든 직원이 함께 보는 검색어
const TODAY_COMMON_KEYWORDS = ["이재호", "운영총괄부", "권구택"];
const todayListOf = (userId, col) => { try { const v = JSON.parse(db.prepare(`SELECT ${col} FROM users WHERE id = ?`).get(userId)?.[col] || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };
const todayKeywordsOf = (userId) => todayListOf(userId, "today_keywords");
const todayExcludesOf = (userId) => todayListOf(userId, "today_excludes");
const searchKey = (r) => `${r.type}:${r.id}`;
// day 를 주면 그날에 걸친 것만 (일정은 시작~끝, 할 일은 마감일, 메모는 날짜)
function runSearch(q, kind, v, day) {
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
  if (day) { const keep = out.filter((r) => r.date && r.date <= day && (r.endDate || r.date) >= day); out.length = 0; out.push(...keep); }
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

/* ----- 프로젝트: 볼 수 있는 조직(소속·아래 조직·추가로 볼 조직·본부장 범위)의 것을 보고 고침. 관리자는 전부 ----- */
const PROJECT_STATUS = ["none", "idea", "review", "doing", "fixed", "hold", "done"];
const projectAllowed = (user, p) => user.role === "admin" || p.created_by === user.id || (p.unit_id !== null && visibleUnits(user).includes(p.unit_id));
const projectOut = (p, items, user) => {
  const list = items.filter((i) => i.kind === "item");
  const counts = {};
  for (const i of list) counts[i.status] = (counts[i.status] || 0) + 1;
  const dues = list.filter((i) => i.due_date && i.status !== "done").map((i) => i.due_date).sort();
  return { id: p.id, unitId: p.unit_id, name: p.name, note: p.note, createdBy: p.created_by, updatedAt: p.updated_at, total: list.length, done: counts.done || 0, counts, nextDue: dues[0] || null, canDelete: user.role === "admin" || p.created_by === user.id };
};
const projectItemOut = (i) => ({ id: i.id, parentId: i.parent_id, kind: i.kind, name: i.name, status: i.status, assigneeId: i.assignee_id, dueDate: i.due_date, note: i.note, area: i.area });
const projectDetail = (p, user) => {
  const items = q.projectItems.all(p.id);
  return {
    project: projectOut(p, items, user),
    // 협력업체 관련 체크·구역 정보는 우선 관리자에게만
    items: (() => {
      if (user.role !== "admin") return items.map(projectItemOut);
      const img = new Map(q.itemImagesOfProject.all(p.id).map((x) => [x.item_id, x.updated_at]));
      return items.map((i) => ({ ...projectItemOut(i), partnerRelated: !!i.partner_related, qty: i.qty, image: img.get(i.id) || null }));
    })(),
    ...(user.role === "admin" ? { areas: q.areaInfo.all(p.id) } : {}),
    ledgers: q.ledgersOfProject.all(p.id).map((l) => ({ id: l.id, itemId: l.item_id, name: l.name, unit: l.unit, contract: l.contract, inTotal: l.in_total, outTotal: l.out_total }))
  };
};
// 봉사자에게 보여 줄 범위: 기념품팀 프로젝트의 '묵주'·'손십자가' 묶음과 그 아래만, 읽기 전용 (만든 사람·담당 직원·프로젝트 설명은 뺌)
const VOLUNTEER_PROJECT_TEAM = "기념품팀";
const VOLUNTEER_GROUP = "묵주"; // 방문 일정(요청 수량)을 잇는 묶음
const VOLUNTEER_GROUPS = [VOLUNTEER_GROUP, "손십자가"];
function volItems(p) {
  const items = q.projectItems.all(p.id);
  const shown = new Set(items.filter((i) => i.kind === "group" && VOLUNTEER_GROUPS.includes(i.name)).map((i) => i.id));
  for (let grew = shown.size > 0; grew;) {
    grew = false;
    for (const i of items) if (i.parent_id && shown.has(i.parent_id) && !shown.has(i.id)) { shown.add(i.id); grew = true; }
  }
  return { items: items.filter((i) => shown.has(i.id)), shown };
}
const volProjectsShown = () => q.volProjects.all(VOLUNTEER_PROJECT_TEAM).filter((p) => volItems(p).items.length);
const volProjectSummary = (p) => {
  const list = volItems(p).items.filter((i) => i.kind === "item");
  return { id: p.id, name: p.name, total: list.length, done: list.filter((i) => i.status === "done").length };
};
// 대장도 묵주 묶음 아래 것만 (보이면 프로젝트를 돌려줌)
function volLedgerProject(l) {
  const p = l && q.volProject.get(VOLUNTEER_PROJECT_TEAM, q.projectItem.get(l.item_id).project_id);
  return p && volItems(p).shown.has(l.item_id) ? p : null;
}
const volItemOut = (i, shown) => ({ id: i.id, parentId: shown.has(i.parent_id) ? i.parent_id : null, kind: i.kind, name: i.name, status: i.status, dueDate: i.due_date, note: i.note });
// 합계에서 빼는 줄(sum_note)은 qty 를 비우고 noteQty 로 따로 줌 (화면 합계에 섞이지 않게)
const volScheduleOut = (s) => ({ id: s.id, title: s.title, date: s.date, startTime: s.start_time, endTime: s.end_time, place: s.place, note: s.note, qty: s.sum_note ? null : s.qty, noteQty: s.sum_note ? s.qty : null, sumNote: s.sum_note || "", tableOnly: !!s.table_only, fromForm: s.request_id != null, qtyBy: s.qty_by, qtyAt: s.qty_at, eduQty: s.edu_qty ?? null, eduBy: s.edu_by || "", eduAt: s.edu_at || null, threadQty: s.thread_qty ?? null, crossQty: s.cross_qty ?? null, matBy: s.mat_by || "", matAt: s.mat_at || null, project: !!s.project_item_id, itemId: s.project_item_id || null });
// 봉사자에게 보이는 '묵주' 묶음 (방문 일정을 이 묶음에 연결)
function rosaryGroupId() {
  for (const p of volProjectsShown()) {
    const g = volItems(p).items.find((i) => i.kind === "group" && i.name === VOLUNTEER_GROUP);
    if (g) return g.id;
  }
  return null;
}
const itemQtyInput = (v) => {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 100000000) throw bad("수량은 0 이상의 숫자로 적어 주세요.");
  return n;
};
// 이미지 파일 앞부분으로 형식 확인 (이름·형식 주장은 믿지 않음)
function imageMime(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length > 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}
const ITEM_IMAGE_MAX = 60 * 1024;
// 프로젝트 안의 봉사자 묶음 (기념품팀 프로젝트의 묵주·손십자가)
function volGroupsOf(p) {
  if (!q.volProject.get(VOLUNTEER_PROJECT_TEAM, p.id)) return [];
  return volItems(p).items.filter((i) => i.kind === "group" && VOLUNTEER_GROUPS.includes(i.name));
}
function volGroupStatus(p, g) {
  const items = q.projectItems.all(p.id);
  const ids = new Set([g.id]);
  for (let grew = true; grew;) { grew = false; for (const i of items) if (i.parent_id && ids.has(i.parent_id) && !ids.has(i.id)) { ids.add(i.id); grew = true; } }
  const ledgers = q.ledgersOfProject.all(p.id).filter((l) => ids.has(l.item_id));
  const visits = q.volSchedulesOfItems.all().filter((s) => ids.has(s.project_item_id));
  const records = q.volRecordsOfItem.all(g.id);
  const requests = q.volRequestsOf.all(g.id);
  const volNames = new Set(db.prepare("SELECT name FROM users WHERE volunteer = 1").all().map((u) => u.name)); // 요청수량은 고친 사람 이름만 남아 있음
  // 최근 변동: 입출고 수정 기록 + 요청수량 수정 + 원자재·회수 기록 (시각은 UTC)
  const changes = [
    ...ledgers.flatMap((l) => q.stockHistoryRecent.all(l.id).map((h) => ({ at: h.created_at, who: h.user_name, volunteer: !!h.by_volunteer, kind: "stock", where: l.name, ledgerId: l.id, what: h.summary }))),
    ...visits.filter((s) => s.qty_at).map((s) => ({ at: s.qty_at, who: s.qty_by, volunteer: volNames.has(s.qty_by), kind: "qty", where: s.title, what: `요청수량 ${s.qty ?? "(없음)"}` })),
    ...visits.filter((s) => s.edu_at).map((s) => ({ at: s.edu_at, who: s.edu_by, volunteer: volNames.has(s.edu_by), kind: "edu", where: s.title, what: `교육물량 ${s.edu_qty ?? "(없음)"}` })),
    ...visits.filter((s) => s.mat_at).map((s) => ({ at: s.mat_at, who: s.mat_by, volunteer: volNames.has(s.mat_by), kind: "mat", where: s.title, what: `실 출고 ${s.thread_qty ?? "-"} · 십자가 출고 ${s.cross_qty ?? "-"}` })),
    ...records.map((r) => ({ at: r.updated_at, who: r.author || "", volunteer: true, kind: r.kind, where: r.kind === "material" ? "원자재 보유물량" : "제품 회수물량", what: `${r.date} ${r.name || ""} ${r.qty}`.trim() }))
  ].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 60);
  const latest = new Map();
  for (const r of records.filter((x) => x.kind === "material")) if (!latest.has(r.name)) latest.set(r.name, r);
  // 월별: 입고·출고(날짜가 'YYYY-MM-' 인 기록만), 요청수량·교육물량(일정 날짜 기준)
  const monthly = new Map();
  const mrow = (k) => { if (!monthly.has(k)) monthly.set(k, { month: k, in: 0, out: 0, req: 0, edu: 0 }); return monthly.get(k); };
  for (const l of ledgers) for (const r of q.stockMonthly.all(l.id)) mrow(r.month)[r.type] += r.total;
  for (const v of visits) { const m = mrow(v.date.slice(0, 7)); m.req += v.sum_note ? 0 : v.qty || 0; m.edu += v.edu_qty || 0; }
  return {
    id: g.id, name: g.name,
    ledgers: ledgers.map((l) => ({ id: l.id, name: l.name, unit: l.unit, contract: l.contract, inTotal: l.in_total, outTotal: l.out_total })),
    visits: visits.map((s) => ({ id: s.id, date: s.date, startTime: s.start_time, title: s.title, place: s.place, qty: s.sum_note ? null : s.qty, noteQty: s.sum_note ? s.qty : null, sumNote: s.sum_note || "", tableOnly: !!s.table_only, fromForm: s.request_id != null, qtyBy: s.qty_by, qtyAt: s.qty_at, eduQty: s.edu_qty ?? null, eduBy: s.edu_by || "", eduAt: s.edu_at || null, threadQty: s.thread_qty ?? null, crossQty: s.cross_qty ?? null, matBy: s.mat_by || "", matAt: s.mat_at || null })),
    requests: requests.map((r) => ({ id: r.id, no: r.no, org: r.org, date: r.req_date, time: r.req_time, qty: r.qty })),
    monthly: [...monthly.values()].sort((a, b) => a.month.localeCompare(b.month)),
    material: { total: [...latest.values()].reduce((n, r) => n + r.qty, 0), kinds: latest.size, count: records.filter((x) => x.kind === "material").length },
    recovery: { total: records.filter((x) => x.kind === "recovery" && (x.stage || "in") === "in").reduce((n, r) => n + r.qty, 0), count: records.filter((x) => x.kind === "recovery").length,
      stages: Object.fromEntries(VOL_STAGES.map((st) => [st, records.filter((x) => x.kind === "recovery" && (x.stage || "in") === st).reduce((n, r) => n + r.qty, 0)])) },
    changes
  };
}
// 게시판: 봉사자·관리자만. 비밀글은 쓴 사람과 관리자만 내용을 봄 (다른 사람에게는 '비밀글입니다'만)
const BOARD_CATS = ["request", "suggest", "free"];
const boardCan = (user) => user.volunteer || user.role === "admin";
const boardSees = (user, b) => !b.secret || b.created_by === user.id || user.role === "admin";
const boardPostOut = (b, user) => {
  const see = boardSees(user, b);
  return { id: b.id, category: b.category, secret: !!b.secret, title: see ? b.title : "비밀글입니다", body: see ? b.body : "", author: see ? b.author || "" : "", mine: b.created_by === user.id, canSee: see, canEdit: b.created_by === user.id || user.role === "admin", comments: b.comments ?? 0, createdAt: b.created_at, updatedAt: b.updated_at };
};
function boardInput(b) {
  const category = BOARD_CATS.includes(b.category) ? b.category : "free";
  return [category, text(b.title, 100, "제목", true), text(b.body, 5000, "내용") || "", b.secret ? 1 : 0];
}
// 봉사자 입구와 관리자 쪽에서 같이 씀. 처리했으면 true
async function boardRoute(req, res, user, path, method) {
  if (path === "/api/board" && method === "GET") { send(res, 200, { posts: q.boardPosts.all().map((b) => boardPostOut(b, user)) }); return true; }
  if (path === "/api/board" && method === "POST") {
    const v = boardInput(await readJson(req));
    const id = Number(q.addBoardPost.run(...v, user.id).lastInsertRowid);
    // 새 글: 봉사자·관리자에게 (비밀글은 관리자에게만, 제목도 숨김)
    notify(allUsers().filter((u) => u.id !== user.id && boardCan(u) && (!v[3] || u.role === "admin")).map((u) => u.id), "게시판 새 글", v[3] ? "비밀글이 올라왔어요" : v[1], (s) => (s.volunteer ? `/#/vboard/${id}` : `/#/board/${id}`), "board");
    send(res, 201, { id }); return true;
  }
  const m = path.match(/^\/api\/board\/(\d+)(\/comments)?$/);
  const cm = path.match(/^\/api\/board-comments\/(\d+)$/);
  if (m) {
    const b = q.boardPost.get(Number(m[1]));
    if (!b) throw notFound("글");
    const see = boardSees(user, b);
    if (m[2]) {
      if (method !== "POST") { send(res, 405, { error: "Method not allowed" }); return true; }
      if (!see) { send(res, 403, { error: "비밀글에는 댓글을 달 수 없어요." }); return true; }
      q.addBoardComment.run(b.id, text((await readJson(req)).body, 1000, "댓글", true), user.id);
      if (b.created_by && b.created_by !== user.id) notify([b.created_by], "내 글에 댓글", b.secret ? "비밀글에 댓글이 달렸어요" : b.title, (s) => (s.volunteer ? `/#/vboard/${b.id}` : `/#/board/${b.id}`), "comment");
    } else if (method === "PATCH" || method === "DELETE") {
      if (b.created_by !== user.id && user.role !== "admin") { send(res, 403, { error: "쓴 사람과 관리자만 고치거나 지울 수 있어요." }); return true; }
      if (method === "DELETE") { q.delBoardPost.run(b.id); send(res, 200, { ok: true }); return true; }
      q.setBoardPost.run(...boardInput(await readJson(req)), b.id);
    } else if (method !== "GET") { send(res, 405, { error: "Method not allowed" }); return true; }
    const fresh = { ...q.boardPost.get(b.id), comments: 0 };
    send(res, 200, { post: boardPostOut(fresh, user), comments: see ? q.boardComments.all(b.id).map((c) => ({ id: c.id, body: c.body, author: c.author || "", admin: c.author_role === "admin", mine: c.created_by === user.id, canDelete: c.created_by === user.id || user.role === "admin", createdAt: c.created_at })) : [] });
    return true;
  }
  if (cm && method === "DELETE") {
    const c = q.boardComment.get(Number(cm[1]));
    if (!c) throw notFound("댓글");
    if (c.created_by !== user.id && user.role !== "admin") { send(res, 403, { error: "쓴 사람과 관리자만 지울 수 있어요." }); return true; }
    q.delBoardComment.run(c.id); send(res, 200, { ok: true }); return true;
  }
  return false;
}
// 검수 (관리자 전용으로 먼저): 단계 1·2·3, 불량 유형별 수량, 샘플링, 사진 4장
const DEFECT_TYPES = ["색상 차이", "굵기", "길이", "매듭", "파손·오염", "기타"];
const inspGroups = () => volProjectsShown().flatMap((p) => volGroupsOf(p).map((g) => ({ id: g.id, name: g.name })));
function inspectionInput(b) {
  const groups = inspGroups();
  const itemId = Number(b.itemId);
  if (!groups.some((g) => g.id === itemId)) throw bad("묶음(묵주·손십자가)을 골라 주세요.");
  const stage = Number(b.stage);
  if (![1, 2, 3].includes(stage)) throw bad("검수 단계를 골라 주세요.");
  if (!isDate(b.date)) throw bad("날짜를 확인해 주세요.");
  const n = (v, label, opt) => { if ((v === "" || v == null) && opt) return null; const x = Number(v); if (!Number.isInteger(x) || x < 0 || x > 100000000) throw bad(`${label}을 0 이상의 숫자로 적어 주세요.`); return x; };
  const checked = n(b.checkedQty, "검수 수량");
  const defects = {};
  const okKeys = defectKeysAll();
  for (const [k, v] of Object.entries(b.defects || {})) { if (!okKeys.has(k)) throw bad("불량 유형을 확인해 주세요."); const x = n(v, `${k} 불량 수량`, true); if (x) defects[k] = x; }
  const sampled = b.sampled ? 1 : 0;
  return [itemId, stage, b.date, text(b.source, 80, "대상") || "", checked, sampled, sampled ? n(b.sampleQty, "샘플 수량", true) : null, JSON.stringify(defects), text(b.note, 500, "메모") || ""];
}
const inspectionOut = (x) => {
  const defects = JSON.parse(x.defects || "{}");
  return { id: x.id, itemId: x.item_id, group: x.group_name, groupId: x.group_id ?? null, scheduleId: x.schedule_id ?? null, recoveryId: x.recovery_id ?? null, criteriaVersion: x.criteria_version ?? null, stage: x.stage, date: x.date, source: x.source, checkedQty: x.checked_qty, sampled: !!x.sampled, sampleQty: x.sample_qty, defects, defectTotal: Object.values(defects).reduce((a, b) => a + b, 0), note: x.note, rework: x.rework || "", author: x.author || "", photos: x.photo_ids ? String(x.photo_ids).split(",").map(Number) : [], updatedAt: x.updated_at };
};
// 검수 기록 API: 관리자(/api/admin)와 팀 봉사자(/api/team)가 같은 기록을 씀. 사진은 선택(4장까지), 불합격품 처리(반송·재작업)
const REWORK = ["", "return", "fix", "hold", "discard"]; // F13: hold 보관 · discard 폐기
// 검수 기록을 조·수도회 방문 일정·회수 건과 잇기 (F05). 회수 건을 고르면 방문 일정은 그 회수의 일정으로
function inspectionLinks(b, old) {
  const id = (k, ok2, label) => { if (!has(b, k)) return old ? old : undefined; const v = optId(b[k]); if (v && !ok2(v)) throw bad(`${label}을(를) 확인해 주세요.`); return v; };
  const groupId = has(b, "groupId") ? (() => { const v = optId(b.groupId); if (v && !db.prepare("SELECT 1 FROM inspection_groups WHERE id = ?").get(v)) throw bad("검수 조를 확인해 주세요."); return v; })() : old?.group_id ?? null;
  const recoveryId = has(b, "recoveryId") ? (() => { const v = optId(b.recoveryId); if (v && !q.teamRecovery.get(v)) throw bad("회수 건을 확인해 주세요."); return v; })() : old?.recovery_id ?? null;
  let scheduleId = has(b, "scheduleId") ? (() => { const v = optId(b.scheduleId); if (v) teamOrgOf(v); return v; })() : old?.schedule_id ?? null;
  if (recoveryId && !scheduleId) scheduleId = q.teamRecovery.get(recoveryId).schedule_id;
  void id;
  return [groupId, scheduleId, recoveryId];
}
const setInspLinks = (links, version, id) => { db.prepare("UPDATE inspections SET group_id = ?, schedule_id = ?, recovery_id = ?, criteria_version = coalesce(?, criteria_version) WHERE id = ?").run(...links, version, id); syncAfterInspection(links[1], links[0]); };
const reworkInput = (v) => { const r = v == null ? "" : String(v); if (!REWORK.includes(r)) throw bad("불합격품 처리를 확인해 주세요."); return r; };
async function inspectionRoute(req, res, user, path, method, base) {
  const list = () => q.inspections.all().map(inspectionOut);
  const crit = () => { const c = criteriaOut(); const cur = c.versions.find((v) => v.version === c.current); return { current: c.current, items: cur ? cur.items : [] }; };
  if (path === `${base}/inspections` && method === "GET") { const c = crit(); send(res, 200, { groups: inspGroups(), types: c.items.length ? c.items.map((x) => x.defectKey) : DEFECT_TYPES, criteria: c, inspections: list() }); return true; }
  if (path === `${base}/inspections` && method === "POST") {
    const b = await readJson(req), rw = reworkInput(b.rework);
    const links = inspectionLinks(b, null);
    const id = inTx(() => { const id = Number(q.addInspection.run(...inspectionInput(b), user.id).lastInsertRowid); q.setInspRework.run(rw, id); setInspLinks(links, crit().current, id); return id; });
    send(res, 201, { id, inspections: list() }); return true;
  }
  const m = path.startsWith(`${base}/inspections/`) && path.slice(base.length).match(/^\/inspections\/(\d+)(\/photos)?$/);
  if (m) {
    const x = q.inspection.get(Number(m[1]));
    if (!x) throw notFound("검수 기록");
    if (m[2]) {
      if (method !== "POST") { send(res, 405, { error: "Method not allowed" }); return true; }
      const b = await readJson(req), buf = Buffer.from(String(b.data || ""), "base64");
      if (!buf.length || buf.length > ITEM_IMAGE_MAX) throw bad("사진을 확인해 주세요.");
      const mime = imageMime(buf);
      if (!mime) throw bad("JPG, PNG, WEBP 사진만 올릴 수 있어요.");
      if (q.inspPhotoCount.get(x.id).n >= 4) throw bad("사진은 기록마다 4장까지 올릴 수 있어요.");
      q.addInspPhoto.run(x.id, mime, buf, user.id);
      send(res, 201, { inspections: list() }); return true;
    }
    if (method === "PATCH") { const b = await readJson(req), v = inspectionInput(b), rw = has(b, "rework") ? reworkInput(b.rework) : x.rework || "", links = inspectionLinks(b, x); inTx(() => { q.setInspection.run(...v, x.id); q.setInspRework.run(rw, x.id); setInspLinks(links, null, x.id); }); send(res, 200, { inspections: list() }); return true; }
    if (method === "DELETE") { q.delInspection.run(x.id); send(res, 200, { inspections: list() }); return true; }
    send(res, 405, { error: "Method not allowed" }); return true;
  }
  const pm = path === `${base}/inspection-photos/${path.split("/").pop()}` && path.match(/\/inspection-photos\/(\d+)$/);
  if (pm) {
    const ph = q.inspPhoto.get(Number(pm[1]));
    if (!ph) throw notFound("사진");
    if (method === "GET") { sendPhoto(res, ph); return true; }
    if (method === "DELETE") { q.delInspPhoto.run(ph.id); send(res, 200, { inspections: list() }); return true; }
    send(res, 405, { error: "Method not allowed" }); return true;
  }
  return false;
}

// ---- 팀 봉사자(교육·검수): 담당 수도회·교육·문의·제작 진행, 검수(기록·하루 검수 기록·봉사), 이슈, 자료실, 봉사 가능한 날
// 관리자도 같은 API 를 씀 (연락처 입력·이슈 처리·자료실 관리는 관리자만)
const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); // 한국 날짜
const TEAM_STATUS = ["plan", "done", "delay"];
// 성 빼고 이름만: 띄어 쓴 한글 이름은 마지막 낱말(영문은 첫 낱말), 한글 2~3자는 첫 글자, 4자 이상은 앞 두 글자(남궁·선우 같은 두 글자 성)를 뺌
const givenName = (name) => {
  const n = String(name || "").trim();
  if (/\s/.test(n)) { const w = n.split(/\s+/); return /[A-Za-z]/.test(n) ? w[0] : w.pop(); } // 영문은 앞 낱말이 이름
  if (!/^[가-힣]+$/.test(n) || n.length < 2) return n;
  return n.length >= 4 ? n.slice(2) : n.slice(1);
};
const teamQty = (v, label) => { if (v === "" || v == null) return null; const n = Number(v); if (!Number.isInteger(n) || n < 0 || n > 100000000) throw bad(`${label}은 0 이상의 숫자로 적어 주세요.`); return n; };
const optDate = (v, label) => { if (v === "" || v == null) return ""; if (!isDate(v)) throw bad(`${label}를 확인해 주세요.`); return v; };
const optTime = (v) => { const t = v == null ? "" : String(v); if (t && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw bad("시간을 확인해 주세요."); return t; };
// 담당 수도회 = 묵주에 이어진 방문 일정(추가 전달 물량의 줄). 교육 순서는 날짜순 번호
function teamOrgRows(admin) {
  const gid = rosaryGroupId();
  if (!gid) return [];
  const infos = new Map(q.teamOrgInfos.all().map((x) => [x.schedule_id, x]));
  const inq = new Map(q.teamInqCounts.all().map((x) => [x.schedule_id, x]));
  const mons = new Map(db.prepare("SELECT id, name, phone, status FROM monasteries").all().map((m) => [m.id, m]));
  return q.volSchedulesOfItems.all().filter((s) => s.project_item_id === gid).map((s, i) => {
    const f = infos.get(s.id) || {}, c = inq.get(s.id), mon = mons.get(s.monastery_id);
    return {
      id: s.id, no: i + 1, org: s.title.split(" · ").pop(), date: s.date, startTime: s.start_time, place: s.place, tableOnly: !!s.table_only, fromForm: s.request_id != null,
      reqQty: s.qty, sumNote: s.sum_note || "", eduQty: s.edu_qty ?? null, threadQty: s.thread_qty ?? null, crossQty: s.cross_qty ?? null,
      monasteryId: s.monastery_id ?? null, monasteryStatus: mon?.status || "", contact: mon?.phone || f.contact || "", helper: f.helper || "", status: eduStatus(s.progress, f.status), attend: f.attend ?? null, resultNote: f.result_note || "", madeQty: f.made_qty ?? null, madeDue: f.made_due || "",
      updatedBy: f.updated_by || "", updatedAt: f.updated_at || null, inquiries: c?.n || 0, openInquiries: c?.open || 0, canContact: !!admin,
      deletable: s.request_id == null && s.thread_qty == null && s.cross_qty == null && s.edu_qty == null
    };
  });
}
const teamOrgOf = (id) => { const s = q.volSchedule.get(Number(id)); if (!s || !s.project_item_id || s.project_item_id !== rosaryGroupId()) throw notFound("수도회"); return s; };
const teamIssueOut = (x) => ({ id: x.id, kind: x.kind, scheduleId: x.schedule_id, org: x.org_title ? x.org_title.split(" · ").pop() : "", title: x.title, body: x.body, status: x.status, reply: x.reply, author: x.author || "", mine: false, createdBy: x.created_by, photos: x.photo_ids ? String(x.photo_ids).split(",").map(Number) : [], createdAt: x.created_at, updatedAt: x.updated_at });
async function teamRoute(req, res, user, path, method) {
  const admin = user.role === "admin";
  const leader = admin || !!user.vol_leader; // 리더 봉사자: 교육 추가·지우기
  const ok = (code, body) => { send(res, code, body); return true; };
  const issues = () => q.teamIssues.all().map((x) => ({ ...teamIssueOut(x), mine: x.created_by === user.id }));
  if (await inspectionRoute(req, res, user, path, method, "/api/team")) return true;
  if (path === "/api/team/home" && method === "GET") {
    const orgs = teamOrgRows(admin), t = today();
    const ins = q.inspections.all().map(inspectionOut);
    const shifts = q.teamShifts.all(t), su = q.teamShiftUsers.all();
    return ok(200, {
      orgs: { total: orgs.length, done: orgs.filter((o) => o.status === "done").length, delay: orgs.filter((o) => o.status === "delay").length, undated: orgs.filter((o) => o.tableOnly).length, openInquiries: orgs.reduce((n, o) => n + o.openInquiries, 0), made: orgs.reduce((n, o) => n + (o.madeQty || 0), 0) },
      nextEdu: orgs.filter((o) => !o.tableOnly && o.date >= t).slice(0, 5),
      inspect: { count: ins.length, checked: ins.reduce((n, x) => n + x.checkedQty, 0), bad: ins.reduce((n, x) => n + x.defectTotal, 0) },
      daily: q.teamDaily.all().reduce((n, x) => n + x.qty, 0),
      recovered: q.teamRecoveries.all().reduce((n, x) => n + x.qty, 0),
      myShifts: shifts.filter((s) => su.some((x) => x.shift_id === s.id && x.id === user.id)).map((s) => ({ id: s.id, date: s.date, startTime: s.start_time })),
      openIssues: q.teamIssues.all().filter((x) => x.status !== "done").length
    });
  }
  // 담당 수도회
  if (path === "/api/team/orgs" && method === "GET") return ok(200, { orgs: teamOrgRows(admin), canAdd: leader });
  // 교육 추가 (리더·관리자): 묵주 방문 일정 한 줄. 날짜가 없으면 달력 미정으로 표에만
  if (path === "/api/team/orgs" && method === "POST") {
    if (!leader) return ok(403, { error: "교육 추가는 리더 봉사자와 관리자만 해요." });
    const gid = rosaryGroupId();
    if (!gid) throw notFound("묵주 프로젝트");
    const b = await readJson(req);
    const org = text(b.org, 80, "수도회 이름", true).replace(/·/g, " ").trim();
    const date = optDate(b.date, "교육 날짜");
    const id = inTx(() => {
      const id = Number(db.prepare("INSERT INTO vol_schedules (title, date, start_time, place, audience, qty, project_item_id, created_by, table_only) VALUES (?, ?, ?, ?, 'all', ?, ?, ?, ?)")
        .run(`묵주 교육 · ${org}`, date || today(), optTime(b.startTime), text(b.place, 120, "장소") || "", teamQty(b.qty, "요청수량"), gid, user.id, date ? 0 : 1).lastInsertRowid);
      if (b.qty !== "" && b.qty != null) q.markVolQty.run(user.name, id);
      q.teamOrgUpsert.run(id, "", text(b.helper, 80, "담당 봉사자") || "", "plan", null, "", null, "", user.name);
      db.prepare("UPDATE vol_schedules SET monastery_id = ? WHERE id = ?").run(monasteryIdOf(org), id);
      return id;
    });
    if (date) notify(teamVolunteerIds().filter((x) => x !== user.id), "새 교육 일정", `${date.slice(5).replace("-", "/")} ${org}`, "/#/tcal", "edu");
    return ok(201, { id, orgs: teamOrgRows(admin) });
  }
  const om = path.match(/^\/api\/team\/orgs\/(\d+)(\/inquiries)?$/);
  if (om) {
    const s = teamOrgOf(om[1]);
    if (om[2]) {
      if (method === "GET") return ok(200, { inquiries: q.teamInqs.all(s.id).map((x) => ({ id: x.id, date: x.date, question: x.question, answer: x.answer, done: !!x.done, author: x.author || "", updatedAt: x.updated_at })) });
      if (method === "POST") {
        const b = await readJson(req);
        if (!isDate(b.date)) throw bad("날짜를 확인해 주세요.");
        q.addTeamInq.run(s.id, b.date, text(b.question, 1000, "문의 내용", true), text(b.answer, 1000, "답변") || "", b.done ? 1 : 0, user.id);
        return ok(201, { ok: true });
      }
      return ok(405, { error: "Method not allowed" });
    }
    // 지우기 (리더·관리자): 네이버폼 신청이나 출고·교육물량 기록이 있는 줄은 지우지 않음
    if (!om[2] && method === "DELETE") {
      if (!leader) return ok(403, { error: "교육 지우기는 리더 봉사자와 관리자만 해요." });
      if (s.request_id != null || s.thread_qty != null || s.cross_qty != null || s.edu_qty != null) return ok(400, { error: "네이버폼 신청이나 출고·교육물량 기록이 있는 교육은 지울 수 없어요. 관리자에게 알려 주세요." });
      q.delVolSchedule.run(s.id);
      return ok(200, { orgs: teamOrgRows(admin) });
    }
    if (method === "PATCH") {
      const b = await readJson(req), f = q.teamOrgInfo.get(s.id) || {};
      if (has(b, "contact") && !admin) return ok(403, { error: "연락처는 관리자만 적어요." });
      const now = eduStatus(s.progress, f.status);
      let status = has(b, "status") ? String(b.status) : now;
      if (!TEAM_STATUS.includes(status)) throw bad("교육 상태를 확인해 주세요.");
      // 화면을 연 뒤 다른 사람이 상태를 바꿨으면(statusFrom 이 지금과 다름) 상태는 그대로 둠.
      // statusFrom 을 모르는 예전 화면은 늘 상태를 같이 보내므로, 완료를 예정으로 되돌리는 것만 막음
      if (has(b, "statusFrom") ? b.statusFrom !== now : now === "done" && status === "plan") status = now;
      inTx(() => {
        // 교육 날짜를 정하면 달력에도 보이게 (달력 미정 → 일정)
        // 수도회 이름·장소 (팀 봉사자 모두)
        if (has(b, "org") || has(b, "place")) {
          const org = has(b, "org") ? text(b.org, 80, "수도회 이름", true).replace(/·/g, " ").trim() : s.title.split(" · ").pop();
          db.prepare("UPDATE vol_schedules SET title = ?, place = ?, monastery_id = ? WHERE id = ?").run(`묵주 교육 · ${org}`, has(b, "place") ? text(b.place, 120, "장소") || "" : s.place, monasteryIdOf(org), s.id);
        }
        if (has(b, "date")) {
          if (!isDate(b.date)) throw bad("교육 날짜를 확인해 주세요.");
          db.prepare("UPDATE vol_schedules SET date = ?, start_time = ?, table_only = 0 WHERE id = ?").run(b.date, has(b, "startTime") ? optTime(b.startTime) : s.start_time, s.id);
          if (b.date !== s.date || s.table_only) notify(teamVolunteerIds().filter((x) => x !== user.id), "교육 일정 변경", `${b.date.slice(5).replace("-", "/")} ${s.title.split(" · ").pop()}`, "/#/tcal", "edu");
        }
        // 연락처는 수도회(monasteries.phone)에 둠. team_org_info.contact 는 예전 값만 남김
        if (has(b, "contact")) { const mid = db.prepare("SELECT monastery_id FROM vol_schedules WHERE id = ?").get(s.id).monastery_id || monasteryIdOf(s.title.split(" · ").pop()); db.prepare("UPDATE vol_schedules SET monastery_id = ? WHERE id = ?").run(mid, s.id); db.prepare("UPDATE monasteries SET phone = ?, updated_at = datetime('now') WHERE id = ?").run(text(b.contact, 300, "연락처") || "", mid); }
        q.teamOrgUpsert.run(s.id, f.contact || "", has(b, "helper") ? text(b.helper, 80, "담당 봉사자") || "" : f.helper || "", status,
          has(b, "attend") ? teamQty(b.attend, "참석 인원") : f.attend ?? null, has(b, "resultNote") ? text(b.resultNote, 1000, "특이사항") || "" : f.result_note || "",
          has(b, "madeQty") ? teamQty(b.madeQty, "예상 완성 수량") : f.made_qty ?? null, has(b, "madeDue") ? text(b.madeDue, 40, "완성 예정 시기") || "" : f.made_due || "", user.name);
        if (status !== now) setEduStatus(db, s.id, status); // 관리자 '교육 기록'의 진행상태도 같이
      });
      return ok(200, { org: teamOrgRows(admin).find((o) => o.id === s.id) });
    }
    return ok(405, { error: "Method not allowed" });
  }
  const iqm = path.match(/^\/api\/team\/inquiries\/(\d+)$/);
  if (iqm) {
    const x = q.teamInq.get(Number(iqm[1]));
    if (!x) throw notFound("문의");
    if (method === "PATCH") {
      const b = await readJson(req);
      if (has(b, "date") && !isDate(b.date)) throw bad("날짜를 확인해 주세요.");
      q.setTeamInq.run(has(b, "date") ? b.date : x.date, has(b, "question") ? text(b.question, 1000, "문의 내용", true) : x.question, has(b, "answer") ? text(b.answer, 1000, "답변") || "" : x.answer, has(b, "done") ? (b.done ? 1 : 0) : x.done, x.id);
      return ok(200, { ok: true });
    }
    if (method === "DELETE") { if (x.created_by !== user.id && !admin) return ok(403, { error: "적은 사람과 관리자만 지울 수 있어요." }); q.delTeamInq.run(x.id); return ok(200, { ok: true }); }
    return ok(405, { error: "Method not allowed" });
  }
  // 입고 완성품 (부서 봉사자가 적은 묵주 완제품 기록, 조회만)
  if (path === "/api/team/products" && method === "GET") {
    const gid = rosaryGroupId();
    return ok(200, { records: gid ? q.volRecords.all(gid, "recovery").map((r) => ({ id: r.id, date: r.date, name: r.name, qty: r.qty, note: r.note, stage: r.stage || "in" })) : [] });
  }
  // 하루 검수 기록
  const dailyIn = async () => { const b = await readJson(req); if (!isDate(b.date)) throw bad("날짜를 확인해 주세요."); return [b.date, teamQty(b.qty, "검수 수량") ?? 0, text(b.workers, 300, "함께한 봉사자") || "", text(b.note, 500, "메모") || ""]; };
  const dailyList = () => q.teamDaily.all().map((x) => ({ id: x.id, date: x.date, qty: x.qty, workers: x.workers, note: x.note, author: x.author || "", mine: x.created_by === user.id }));
  if (path === "/api/team/daily" && method === "GET") return ok(200, { daily: dailyList() });
  if (path === "/api/team/daily" && method === "POST") { q.addTeamDaily.run(...(await dailyIn()), user.id); return ok(201, { daily: dailyList() }); }
  const dm = path.match(/^\/api\/team\/daily\/(\d+)$/);
  if (dm) {
    const x = q.teamDailyOne.get(Number(dm[1]));
    if (!x) throw notFound("작업 기록");
    if (method === "PATCH") { q.setTeamDaily.run(...(await dailyIn()), x.id); return ok(200, { daily: dailyList() }); }
    if (method === "DELETE") { if (x.created_by !== user.id && !admin) return ok(403, { error: "적은 사람과 관리자만 지울 수 있어요." }); q.delTeamDaily.run(x.id); return ok(200, { daily: dailyList() }); }
    return ok(405, { error: "Method not allowed" });
  }
  // 검수 봉사일(필요 인원)과 신청
  const shiftList = () => { const su = q.teamShiftUsers.all(); return q.teamShifts.all(today()).map((s) => { const us = su.filter((x) => x.shift_id === s.id); return { id: s.id, date: s.date, startTime: s.start_time, need: s.need, note: s.note, people: us.map((x) => x.name), mine: us.some((x) => x.id === user.id), canDelete: admin || s.created_by === user.id }; }); };
  if (path === "/api/team/shifts" && method === "GET") return ok(200, { shifts: shiftList() });
  if (path === "/api/team/shifts" && method === "POST") {
    const b = await readJson(req);
    if (!isDate(b.date)) throw bad("날짜를 확인해 주세요.");
    const need = teamQty(b.need, "필요 인원");
    if (!need || need > 200) throw bad("필요 인원은 1~200명으로 적어 주세요.");
    q.addTeamShift.run(b.date, optTime(b.startTime), need, text(b.note, 300, "메모") || "", user.id);
    return ok(201, { shifts: shiftList() });
  }
  const sm = path.match(/^\/api\/team\/shifts\/(\d+)(\/signup)?$/);
  if (sm) {
    const s = q.teamShift.get(Number(sm[1]));
    if (!s) throw notFound("봉사일");
    if (sm[2] && method === "POST") { if (admin && !user.volunteer) return ok(403, { error: "봉사 신청은 봉사자가 해요." }); const b = await readJson(req); if (b.on) q.teamShiftJoin.run(s.id, user.id); else q.teamShiftLeave.run(s.id, user.id); return ok(200, { shifts: shiftList() }); }
    if (!sm[2] && method === "DELETE") { if (!admin && s.created_by !== user.id) return ok(403, { error: "만든 사람과 관리자만 지울 수 있어요." }); q.delTeamShift.run(s.id); return ok(200, { shifts: shiftList() }); }
    return ok(405, { error: "Method not allowed" });
  }
  // 봉사 가능한 날 (내 것만 고침, 다른 사람은 날짜별 인원 수만)
  // 교육 일정이 있는 날 (달력에 보이는 묵주 교육): 봉사 가능 신청·필요 인원은 이 날만
  const eduDays = () => new Set(teamOrgRows(admin).filter((o) => !o.tableOnly).map((o) => o.date));
  // 봉사 가능한 날: 날짜별로 성을 뺀 이름만 (팀 봉사자와 관리자에게만)
  const availOut = () => {
    const people = {};
    for (const x of q.teamAvailPeople.all(today())) (people[x.date] ||= []).push(givenName(x.name));
    const needs = Object.fromEntries(q.teamDayNeeds.all(today()).map((x) => [x.date, { need: x.need, note: x.note, by: x.updated_by }]));
    return { mine: q.teamAvailMine.all(user.id, today()).map((x) => x.date), counts: Object.fromEntries(Object.entries(people).map(([d, l]) => [d, l.length])), people, needs, canSetNeed: leader, eduDays: [...eduDays()].filter((d) => d >= today()).sort() };
  };
  if (path === "/api/team/avail" && method === "GET") return ok(200, availOut());
  if (path === "/api/team/avail" && method === "PUT") {
    const b = await readJson(req);
    if (!isDate(b.date)) throw bad("날짜를 확인해 주세요.");
    if (b.date < today()) throw bad("지난 날은 바꿀 수 없어요.");
    if (b.on && !eduDays().has(b.date)) throw bad("교육 일정이 있는 날만 봉사 가능을 신청할 수 있어요.");
    if (b.on) q.addTeamAvail.run(user.id, b.date); else q.delTeamAvail.run(user.id, b.date);
    return ok(200, availOut());
  }
  // 날짜별 필요 인원 (리더·관리자): 0 이나 빈 값이면 지움
  if (path === "/api/team/day-need" && method === "PUT") {
    if (!leader) return ok(403, { error: "필요 인원은 리더 봉사자와 관리자가 정해요." });
    const b = await readJson(req);
    if (!isDate(b.date)) throw bad("날짜를 확인해 주세요.");
    const need = teamQty(b.need, "필요 인원");
    if (need != null && need > 500) throw bad("필요 인원은 500명까지 적을 수 있어요.");
    if (need && !eduDays().has(b.date)) throw bad("교육 일정이 있는 날만 필요 인원을 정할 수 있어요.");
    const had = q.teamDayNeeds.all(b.date).find((x) => x.date === b.date);
    if (!need) q.delTeamDayNeed.run(b.date); else q.setTeamDayNeed.run(b.date, need, text(b.note, 200, "메모") || "", user.name);
    if (need && (!had || had.need !== need)) notify(teamVolunteerIds().filter((x) => x !== user.id), "봉사자를 찾아요", `${b.date.slice(5).replace("-", "/")} ${need}명 필요`, "/#/thome", "need");
    return ok(200, availOut());
  }
  // 제품 회수: 수도회에서 완성품을 받은 기록 (팀 봉사자 입력, 지우기는 적은 사람·리더·관리자)
  const RECOVERY_METHODS = ["", "parcel", "visit", "bring"];
  const recoveryOut = () => {
    const list = q.teamRecoveries.all().map((x) => ({ id: x.id, scheduleId: x.schedule_id, org: x.org_title.split(" · ").pop(), date: x.date, qty: x.qty, method: x.method, note: x.note, shipmentId: x.shipment_id ?? null, author: x.author || "", mine: x.created_by === user.id }));
    const byOrg = {};
    for (const x of list) byOrg[x.scheduleId] = (byOrg[x.scheduleId] || 0) + x.qty;
    return { records: list, byOrg, total: list.reduce((n, x) => n + x.qty, 0) };
  };
  const recoveryIn = async () => {
    const b = await readJson(req);
    const s = teamOrgOf(b.scheduleId);
    if (!isDate(b.date)) throw bad("회수 날짜를 확인해 주세요.");
    const qty = teamQty(b.qty, "회수 수량");
    if (qty == null) throw bad("회수 수량을 적어 주세요.");
    const m = b.method == null ? "" : String(b.method);
    if (!RECOVERY_METHODS.includes(m)) throw bad("회수 방법을 확인해 주세요.");
    return [s.id, b.date, qty, m, text(b.note, 500, "메모") || ""];
  };
  if (path === "/api/team/recovery" && method === "GET") return ok(200, recoveryOut());
  if (path === "/api/team/recovery" && method === "POST") { q.addTeamRecovery.run(...(await recoveryIn()), user.id); return ok(201, recoveryOut()); }
  const rcm = path.match(/^\/api\/team\/recovery\/(\d+)$/);
  if (rcm) {
    const x = q.teamRecovery.get(Number(rcm[1]));
    if (!x) throw notFound("회수 기록");
    if (method === "PATCH") { q.setTeamRecovery.run(...(await recoveryIn()), x.id); return ok(200, recoveryOut()); }
    if (method === "DELETE") { if (x.created_by !== user.id && !leader) return ok(403, { error: "적은 사람과 리더·관리자만 지울 수 있어요." }); q.delTeamRecovery.run(x.id); return ok(200, recoveryOut()); }
    return ok(405, { error: "Method not allowed" });
  }
  // 이슈: 봉사자가 등록(사진 4장), 관리자가 처리 상태·답
  const issueIn = (b) => {
    const kind = b.kind === "thread" ? "thread" : "general";
    const sid = b.scheduleId ? teamOrgOf(b.scheduleId).id : null;
    return [kind, sid, text(b.title, 120, "제목", true), text(b.body, 2000, "내용") || ""];
  };
  if (path === "/api/team/issues" && method === "GET") return ok(200, { issues: issues() });
  if (path === "/api/team/issues" && method === "POST") {
    const v = issueIn(await readJson(req));
    const id = Number(q.addTeamIssue.run(...v, user.id).lastInsertRowid);
    notify(adminIds().filter((x) => x !== user.id), "새 이슈", v[2], "/#/volunteers/team", "issue_new");
    return ok(201, { id, issues: issues() });
  }
  const im = path.match(/^\/api\/team\/issues\/(\d+)(\/photos)?$/);
  if (im) {
    const x = q.teamIssue.get(Number(im[1]));
    if (!x) throw notFound("이슈");
    const own = x.created_by === user.id;
    if (im[2]) {
      if (method !== "POST") return ok(405, { error: "Method not allowed" });
      if (!own && !admin) return ok(403, { error: "올린 사람과 관리자만 사진을 붙여요." });
      const b = await readJson(req), buf = Buffer.from(String(b.data || ""), "base64");
      if (!buf.length || buf.length > ITEM_IMAGE_MAX) throw bad("사진을 확인해 주세요.");
      const mime = imageMime(buf);
      if (!mime) throw bad("JPG, PNG, WEBP 사진만 올릴 수 있어요.");
      if (q.teamIssuePhotoCount.get(x.id).n >= 4) throw bad("사진은 이슈마다 4장까지 올릴 수 있어요.");
      q.addTeamIssuePhoto.run(x.id, mime, buf, user.id);
      return ok(201, { issues: issues() });
    }
    if (method === "PATCH") {
      const b = await readJson(req);
      if (has(b, "status")) {
        if (!admin) return ok(403, { error: "처리 상태는 관리자가 바꿔요." });
        if (!["new", "doing", "done"].includes(b.status)) throw bad("처리 상태를 확인해 주세요.");
        const reply = has(b, "reply") ? text(b.reply, 1000, "답") || "" : x.reply;
        q.setTeamIssueStatus.run(b.status, reply, x.id);
        if (x.created_by && x.created_by !== user.id && (b.status !== x.status || reply !== x.reply)) notify([x.created_by], `이슈 ${{ new: "접수", doing: "처리 중", done: "완료" }[b.status]}`, x.title, (sub) => (sub.vol_kind === "team" ? "/#/tissues" : "/#/vissues"), "issue_reply");
        return ok(200, { issues: issues() });
      }
      if (!own && !admin) return ok(403, { error: "올린 사람과 관리자만 고칠 수 있어요." });
      q.setTeamIssue.run(...issueIn(b), x.id);
      return ok(200, { issues: issues() });
    }
    if (method === "DELETE") { if (!admin && !(own && x.status === "new")) return ok(403, { error: "처리 전인 내 이슈만 지울 수 있어요." }); q.delTeamIssue.run(x.id); return ok(200, { issues: issues() }); }
    return ok(405, { error: "Method not allowed" });
  }
  const ipm = path.match(/^\/api\/team\/issue-photos\/(\d+)$/);
  if (ipm) {
    const ph = q.teamIssuePhoto.get(Number(ipm[1]));
    if (!ph) throw notFound("사진");
    if (method === "GET") { sendPhoto(res, ph); return true; }
    if (method === "DELETE") { const x = q.teamIssue.get(ph.issue_id); if (!admin && x?.created_by !== user.id) return ok(403, { error: "올린 사람과 관리자만 지울 수 있어요." }); q.delTeamIssuePhoto.run(ph.id); return ok(200, { issues: issues() }); }
    return ok(405, { error: "Method not allowed" });
  }
  // 자료실 (링크): 보기는 모두, 등록·수정은 관리자
  const docList = () => q.teamDocs.all().map((d) => ({ id: d.id, category: d.category, title: d.title, url: d.url, note: d.note }));
  const docIn = async () => {
    const b = await readJson(req);
    const url = text(b.url, 500, "링크") || "";
    if (url && !/^https:\/\//.test(url)) throw bad("링크는 https:// 로 시작해야 해요.");
    return [["edu", "inspect", "etc"].includes(b.category) ? b.category : "etc", text(b.title, 120, "제목", true), url, text(b.note, 2000, "내용") || ""];
  };
  if (path === "/api/team/docs" && method === "GET") return ok(200, { docs: docList() });
  if (path === "/api/team/docs" && method === "POST") { if (!admin) return ok(403, { error: "자료실은 관리자가 올려요." }); q.addTeamDoc.run(...(await docIn())); return ok(201, { docs: docList() }); }
  const dcm = path.match(/^\/api\/team\/docs\/(\d+)$/);
  if (dcm) {
    if (!admin) return ok(403, { error: "자료실은 관리자가 고쳐요." });
    const d = q.teamDoc.get(Number(dcm[1]));
    if (!d) throw notFound("자료");
    if (method === "PATCH") { q.setTeamDoc.run(...(await docIn()), d.id); return ok(200, { docs: docList() }); }
    if (method === "DELETE") { q.delTeamDoc.run(d.id); return ok(200, { docs: docList() }); }
    return ok(405, { error: "Method not allowed" });
  }
  return false;
}
// 봉사자에게 보이는 묶음(묵주·손십자가)인지
function volGroupItem(id) {
  const i = Number.isInteger(id) && q.projectItem.get(id);
  const p = i && i.kind === "group" && VOLUNTEER_GROUPS.includes(i.name) && q.volProject.get(VOLUNTEER_PROJECT_TEAM, i.project_id);
  if (!p || !volItems(p).shown.has(i.id)) throw notFound("묶음");
  return i;
}
const volRecordKind = (k) => { if (k !== "material" && k !== "recovery") throw bad("기록 종류를 확인해 주세요."); return k; };
function volRecordInput(b) {
  if (!isDate(b.date)) throw bad("날짜를 확인해 주세요.");
  const qty = Number(b.qty);
  if (!Number.isInteger(qty) || qty < 0 || qty > 100000000) throw bad("수량은 0 이상의 숫자로 적어 주세요.");
  const stage = b.stage === undefined ? "in" : String(b.stage);
  if (!VOL_STAGES.includes(stage)) throw bad("단계를 확인해 주세요.");
  return { date: b.date, name: text(b.name, 80, "이름") || "", qty, note: text(b.note, 300, "메모") || "", stage };
}
// 완제품(묵주 회수 · 손십자가) 단계: 입고 → 검수완료 → 패키징완료 → 출고
const VOL_STAGES = ["in", "checked", "packed", "out"];
const volRecordOut = (r, user) => ({ id: r.id, date: r.date, name: r.name, qty: r.qty, note: r.note, stage: r.stage || "in", author: r.author || "", mine: r.created_by === user.id, updatedAt: r.updated_at });
const volQtyInput = (v) => {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 10000000) throw bad("수량은 0 이상의 숫자로 적어 주세요.");
  return n;
};
const volScheduleAdminOut = (s) => {
  const by = s.created_by ? q.userById.get(s.created_by) : null;
  return { ...volScheduleOut(s), qty: s.qty, audience: s.audience, userIds: q.volScheduleUsers.all(s.id).map((x) => x.user_id), enteredBy: by?.name || "", byVolunteer: !!by?.volunteer };
};
const volTrainingOut = (t) => ({ id: t.id, title: t.title, body: t.body, date: t.date, startTime: t.start_time, place: t.place, link: t.link });
function volScheduleFields(b) {
  const title = text(b.title, 120, "제목", true);
  if (!isDate(b.date)) throw bad("날짜를 확인해 주세요.");
  const st = String(b.startTime || ""), et = String(b.endTime || "");
  if (st && !isTime(st)) throw bad("시작 시간을 확인해 주세요.");
  if (et && !isTime(et)) throw bad("끝나는 시간을 확인해 주세요.");
  if (et && !st) throw bad("시작 시간도 적어 주세요.");
  if (et && et <= st) throw bad("끝나는 시간은 시작 시간보다 늦어야 해요.");
  const audience = b.audience === "some" ? "some" : "all";
  const users = audience === "some" ? [...new Set(Array.isArray(b.userIds) ? b.userIds : [])] : [];
  if (audience === "some" && !users.length) throw bad("봉사자를 한 명 이상 골라 주세요.");
  for (const id of users) if (!Number.isInteger(id) || !q.isVolunteer.get(id)) throw bad("봉사자를 다시 골라 주세요.");
  return { fields: [title, b.date, st, et, text(b.place, 120, "장소"), text(b.note, 1000, "메모"), audience, volQtyInput(b.qty), b.projectItemId ?? null], users };
}
function volTrainingFields(b) {
  const title = text(b.title, 120, "제목", true);
  const date = String(b.date || ""), st = String(b.startTime || "");
  if (date && !isDate(date)) throw bad("날짜를 확인해 주세요.");
  if (st && !isTime(st)) throw bad("시작 시간을 확인해 주세요.");
  const link = text(b.link, 500, "자료 링크");
  if (link && !/^https?:\/\/\S+$/i.test(link)) throw bad("자료 링크는 http 또는 https 주소로 적어 주세요.");
  return [title, text(b.body, 5000, "내용"), date, st, text(b.place, 120, "장소"), link];
}
// 상세 프로세스 (빠진 값은 그대로 두기: 상태만 바꿀 때)
const processOut = (r) => ({ id: r.id, section: r.section, phase: r.phase, task: r.task, detail: r.detail, output: r.output, label: r.label, startDate: r.start_date, dueDate: r.due_date, status: r.status, note: r.note, area: r.area, partnerRelated: !!r.partner_related });
const processList = (projectId) => ({ processes: q.processes.all(projectId).map(processOut) });
function processFields(b, cur) {
  const pick = (k, col) => (has(b, k) ? b[k] : cur?.[col ?? k]);
  const start = pick("startDate", "start_date") || null, due = pick("dueDate", "due_date") || null;
  if (start && !isDate(start)) throw bad("시작일을 확인해 주세요.");
  if (due && !isDate(due)) throw bad("예정일을 확인해 주세요.");
  if (start && due && start > due) throw bad("시작일은 예정일보다 늦을 수 없어요.");
  const status = pick("status") || "todo";
  if (!["todo", "doing", "done", "hold"].includes(status)) throw bad("상태를 확인해 주세요.");
  return [text(pick("section"), 60, "구분"), text(pick("phase"), 60, "단계"), text(pick("task"), 120, "세부 업무", true), text(pick("detail"), 500, "진행 상세"), text(pick("output"), 200, "산출물"), text(pick("label"), 40, "표시 이름"), start, due, status, text(pick("note"), 1000, "메모"), text(pick("area"), 60, "구역")];
}
// 입출고 현황
function ledgerFields(b, cur) {
  const get = (k, curVal) => (has(b, k) ? b[k] : curVal);
  const contract = get("contract", cur?.contract);
  const contractN = contract === null || contract === undefined || contract === "" ? null : Number(contract);
  if (contractN !== null && (!Number.isInteger(contractN) || contractN < 0)) throw bad("계약 수량은 0 이상의 숫자로 적어 주세요.");
  const a = get("after", cur ? JSON.parse(cur.after) : {}) || {};
  const lengths = (Array.isArray(a.lengths) ? a.lengths : []).map(Number).filter((n) => n > 0).slice(0, 8);
  const after = { label: text(a.label, 40, "전달 이름"), unit: text(a.unit, 20, "전달 단위"), qty: Math.max(0, Math.floor(Number(a.qty) || 0)), perLength: Math.max(0, Number(a.perLength) || 0), lengths };
  return [text(get("name", cur?.name), 60, "대장 이름", true), text(get("unit", cur?.unit ?? "개"), 10, "단위") || "개", text(get("inLabel", cur?.in_label), 80, "입고 경로"), text(get("outLabel", cur?.out_label), 80, "출고 경로"), contractN, JSON.stringify(after)];
}
function saveStockOptions(ledgerId, list) {
  if (!Array.isArray(list) || list.length > 40) throw bad("품목은 40개까지 정할 수 있어요.");
  const now = q.stockOptions.all(ledgerId);
  const keep = new Set(list.map((o) => idOrNull(o?.id)).filter(Boolean));
  for (const o of now) if (!keep.has(o.id)) {
    if (q.stockOptionUsed.get(o.id)) throw bad(`'${o.name}' 은(는) 기록이 있어서 뺄 수 없어요.`);
    q.delStockOption.run(o.id);
  }
  for (const o of list) {
    const name = text(o?.name, 30, "품목 이름", true), id = idOrNull(o?.id);
    if (id) q.setStockOption.run(name, id, ledgerId); else q.addStockOption.run(ledgerId, name);
  }
}
function ledgerOut(l, p, user) {
  const qty = new Map();
  for (const r of q.stockQtyOfLedger.all(l.id)) { if (!qty.has(r.move_id)) qty.set(r.move_id, {}); qty.get(r.move_id)[r.option_id] = r.qty; }
  const item = q.projectItem.get(l.item_id);
  const photos = new Map();
  for (const r of q.photoIdsOfLedger.all(l.id)) { if (!photos.has(r.move_id)) photos.set(r.move_id, []); photos.get(r.move_id).push(r.id); }
  return {
    ledger: { id: l.id, name: l.name, unit: l.unit, inLabel: l.in_label, outLabel: l.out_label, contract: l.contract, after: JSON.parse(l.after), canDelete: user.role === "admin" || p.created_by === user.id, volunteerEntry: !!volLedgerProject(l) },
    project: { id: p.id, name: p.name, unitId: p.unit_id }, itemName: item.name,
    options: q.stockOptions.all(l.id),
    moves: q.stockMoves.all(l.id).map((m) => ({
      id: m.id, type: m.type, date: m.date, handler: m.handler, note: m.note, issue: m.issue || "", photos: photos.get(m.id) || [], inspectOk: m.inspect_ok ?? null, inspectBad: m.inspect_bad ?? null, qty: qty.get(m.id) || {}, mine: m.created_by === user.id,
      ...(user.volunteer ? {} : { enteredBy: (m.created_by && q.userById.get(m.created_by)?.name) || "" }) // 입력한 사람: 직원 화면만
    })),
    ...(user.volunteer ? {} : { history: q.stockHistory.all(l.id).map((h) => ({ id: h.id, action: h.action, summary: h.summary, by: h.user_name, at: h.created_at })) }) // 수정 기록: 직원 화면만
  };
}
// 공지 공개 범위: 권한마다 볼 수 있는 값
// 부서 봉사자 화면 API (봉사자와, 미리보기 하는 관리자가 씀)
async function volunteerRoute(req, res, user, path, method, url) {
  const param = (k) => url.searchParams.get(k);
  const sendT = (...a) => { send(...a); return true; };
  if (path === "/api/volunteer/home" && method === "GET") {
    const done = new Map(q.volDoneOfUser.all(user.id).map((d) => [d.training_id, d.done_at]));
    return sendT(res, 200, {
      schedules: q.volSchedulesFor.all(user.id).filter((s) => !s.table_only).map((s) => ({ ...volScheduleOut(s), mine: s.created_by === user.id, shared: s.audience === "all" })),
      trainings: q.volTrainings.all().map((t) => ({ ...volTrainingOut(t), done: done.has(t.id), doneAt: done.get(t.id) || null }))
    });
  }
  if (path === "/api/volunteer/menu" && method === "GET") return sendT(res, 200, { menu: volMenu() });
  if (path === "/api/volunteer/projects" && method === "GET") return sendT(res, 200, { projects: volProjectsShown().map(volProjectSummary) });
  const vpm = path.match(/^\/api\/volunteer\/projects\/(\d+)$/);
  if (vpm && method === "GET") {
    const p = q.volProject.get(VOLUNTEER_PROJECT_TEAM, Number(vpm[1]));
    const shown = p && volItems(p);
    if (!shown?.items.length) throw notFound("프로젝트");
    const visits = q.volSchedulesFor.all(user.id).filter((x) => x.project_item_id && shown.shown.has(x.project_item_id)).map((x) => ({ ...volScheduleOut(x), mine: x.created_by === user.id }));
    return sendT(res, 200, { project: volProjectSummary(p), items: shown.items.map((i) => volItemOut(i, shown.shown)), visits });
  }
  // 일정: 봉사자가 직접 입력 (자기에게만 보임), 고치기·지우기는 자기가 입력한 일정만
  // 프로젝트에 묶인 방문 일정의 수량: 그 일정을 볼 수 있는 봉사자가 고침 (누가 언제 고쳤는지 남김)
  const vqm = path.match(/^\/api\/volunteer\/schedules\/(\d+)\/qty$/);
  if (vqm && method === "PATCH") {
    const s = q.volSchedule.get(Number(vqm[1]));
    const visible = s && (s.audience === "all" || q.volScheduleUsers.all(s.id).some((x) => x.user_id === user.id));
    const linked = s?.project_item_id && rosaryGroupId() === s.project_item_id;
    if (!visible || !linked) throw notFound("일정");
    // 요청수량(qty)·교육물량(eduQty) 중 보낸 것만 고침
    const b = await readJson(req);
    const qty = has(b, "qty") ? volQtyInput(b.qty) : s.qty, edu = has(b, "eduQty") ? volQtyInput(b.eduQty) : s.edu_qty ?? null;
    const th = has(b, "threadQty") ? volQtyInput(b.threadQty) : s.thread_qty ?? null, cr = has(b, "crossQty") ? volQtyInput(b.crossQty) : s.cross_qty ?? null;
    inTx(() => {
      if (qty !== s.qty) { q.setVolQty.run(qty, s.id); q.markVolQty.run(user.name, s.id); }
      if (edu !== (s.edu_qty ?? null)) q.setVolEdu.run(edu, user.name, s.id);
      if (th !== (s.thread_qty ?? null) || cr !== (s.cross_qty ?? null)) q.setVolMat.run(th, cr, user.name, s.id);
    });
    return sendT(res, 200, { schedule: { ...volScheduleOut(q.volSchedule.get(s.id)), mine: s.created_by === user.id } });
  }
  if (path === "/api/volunteer/schedules" && method === "POST") {
    const b = await readJson(req);
    const { fields } = volScheduleFields({ ...b, audience: "some", userIds: [user.id], projectItemId: null });
    const id = inTx(() => {
      const id = Number(q.addVolSchedule.run(...fields, user.id).lastInsertRowid);
      q.addVolScheduleUser.run(id, user.id);
      if (fields[7] !== null) q.markVolQty.run(user.name, id);
      return id;
    });
    return sendT(res, 201, { schedule: volScheduleOut(q.volSchedule.get(id)) });
  }
  const vsem = path.match(/^\/api\/volunteer\/schedules\/(\d+)$/);
  if (vsem) {
    const s = q.volSchedule.get(Number(vsem[1]));
    if (!s) throw notFound("일정");
    if (s.created_by !== user.id) return sendT(res, 403, { error: "직접 입력한 일정만 고칠 수 있어요." });
    if (method === "PATCH") {
      // 대상은 그대로 (관리자가 전체로 바꿨으면 유지)
      const { fields } = volScheduleFields({ ...(await readJson(req)), audience: s.audience, userIds: q.volScheduleUsers.all(s.id).map((x) => x.user_id), projectItemId: s.project_item_id });
      inTx(() => { q.setVolSchedule.run(...fields, s.id); if (fields[7] !== s.qty) q.markVolQty.run(user.name, s.id); });
      return sendT(res, 200, { schedule: volScheduleOut(q.volSchedule.get(s.id)) });
    }
    if (method === "DELETE") { q.delVolSchedule.run(s.id); return sendT(res, 204); }
    return sendT(res, 405, { error: "Method not allowed" });
  }
  // 입출고: 묵주 묶음 대장에 기록 입력. 대장·품목은 못 바꾸고, 고치기·지우기는 자기가 입력한 기록만
  if (path === "/api/volunteer/stock" && method === "GET") {
    const ledgers = [];
    for (const l of q.ledgersAll.all()) {
      const p = volLedgerProject(l);
      if (p) ledgers.push(stockListRow(l, p));
    }
    return sendT(res, 200, { ledgers });
  }
  const vstm = path.match(/^\/api\/volunteer\/stock\/(\d+)(\/moves)?$/);
  if (vstm) {
    const l = q.ledger.get(Number(vstm[1]));
    const p = volLedgerProject(l);
    if (!p) throw notFound("입출고 현황");
    if (vstm[2] && method === "POST") { const newMoveId = addStockMoveFrom(l, await readJson(req), user); return sendT(res, 201, { ...ledgerOut(l, p, user), newMoveId }); }
    if (!vstm[2] && method === "GET") return sendT(res, 200, ledgerOut(l, p, user));
    return sendT(res, 405, { error: "Method not allowed" });
  }
  // 기록 사진·고치기·지우기: 봉사자는 그 대장을 볼 수 있으면 누가 적은 기록이든 (수정 기록에 고친 사람이 남음)
  const vsmpm = path.match(/^\/api\/volunteer\/stock-moves\/(\d+)\/photos$/);
  if (vsmpm && method === "POST") {
    const m = q.stockMove.get(Number(vsmpm[1]));
    const l = m && q.ledger.get(m.ledger_id);
    const p = volLedgerProject(l);
    if (!p) throw notFound("기록");
    addMovePhoto(m, l, await readJson(req), user);
    return sendT(res, 201, ledgerOut(l, p, user));
  }
  const vsphm = path.match(/^\/api\/volunteer\/stock-photos\/(\d+)$/);
  if (vsphm) {
    const ph = q.photo.get(Number(vsphm[1]));
    const m = ph && q.stockMove.get(ph.move_id);
    const l = m && q.ledger.get(m.ledger_id);
    const p = volLedgerProject(l);
    if (!p) throw notFound("사진");
    if (method === "GET") return sendPhoto(res, ph);
    if (method === "DELETE") {
      delMovePhoto(ph, m, l, user); return sendT(res, 200, ledgerOut(l, p, user));
    }
    return sendT(res, 405, { error: "Method not allowed" });
  }
  const vsmm = path.match(/^\/api\/volunteer\/stock-moves\/(\d+)$/);
  if (vsmm) {
    const m = q.stockMove.get(Number(vsmm[1]));
    const l = m && q.ledger.get(m.ledger_id);
    const p = volLedgerProject(l);
    if (!p) throw notFound("기록");
    if (method === "PATCH") { patchStockMoveFrom(m, l, await readJson(req), user); return sendT(res, 200, ledgerOut(l, p, user)); }
    if (method === "DELETE") { deleteStockMoveBy(m, l, user); return sendT(res, 200, ledgerOut(l, p, user)); }
    return sendT(res, 405, { error: "Method not allowed" });
  }
  // 원자재 보유물량 · 제품 회수물량: 묶음마다 봉사자가 직접 적는 기록 (모두 보고, 고치기·지우기는 자기가 적은 것만)
  if (path === "/api/volunteer/records" && method === "GET") {
    const g = volGroupItem(Number(param("item"))), kind = volRecordKind(param("kind"));
    return sendT(res, 200, { records: q.volRecords.all(g.id, kind).map((r) => volRecordOut(r, user)) });
  }
  if (path === "/api/volunteer/records" && method === "POST") {
    const b = await readJson(req);
    const g = volGroupItem(Number(b.itemId)), kind = volRecordKind(b.kind), v = volRecordInput(b);
    q.addVolRecord.run(g.id, kind, v.date, v.name, v.qty, v.note, user.id, kind === "recovery" ? v.stage : "in");
    return sendT(res, 201, { records: q.volRecords.all(g.id, kind).map((r) => volRecordOut(r, user)) });
  }
  const vrm = path.match(/^\/api\/volunteer\/records\/(\d+)$/);
  if (vrm) {
    const r = q.volRecord.get(Number(vrm[1]));
    if (!r) throw notFound("기록");
    volGroupItem(r.item_id);
    if (r.created_by !== user.id) return sendT(res, 403, { error: "직접 적은 기록만 고칠 수 있어요." });
    if (method === "PATCH") { const v = volRecordInput(await readJson(req)); q.setVolRecord.run(v.date, v.name, v.qty, v.note, r.kind === "recovery" ? v.stage : "in", r.id); }
    else if (method === "DELETE") q.delVolRecord.run(r.id);
    else return sendT(res, 405, { error: "Method not allowed" });
    return sendT(res, 200, { records: q.volRecords.all(r.item_id, r.kind).map((x) => volRecordOut(x, user)) });
  }
  const vtm = path.match(/^\/api\/volunteer\/trainings\/(\d+)\/done$/);
  if (vtm && method === "POST") {
    const t = q.volTraining.get(Number(vtm[1]));
    if (!t) throw notFound("교육");
    const b = await readJson(req);
    if (b.done === false) q.clearVolDone.run(t.id, user.id); else q.setVolDone.run(t.id, user.id);
    return sendT(res, 200, { done: b.done !== false });
  }
  return false;
}

// ---- DB 설계 v2 1차 (F01~F06): 수도회·택배·업무 담당·검수 기준·검수 조·연락 기록
// 관리자와 봉사자(부서·팀)가 같이 씀. 권한은 기능마다 아래에서 나눔
const MON_STATUS = ["new", "edu_done", "making", "recovered", "checked", "issue"];
const SHIP_STATUS = ["ready", "sent", "arrived", "returned"];
const PARTY_TYPES = ["monastery", "volunteer", "vendor", "etc"];
const DUTIES = ["parcel_out", "parcel_in", "storage", "inspect_place", "purchase", "thread", "etc"];
const ASSIGN_STATUS = ["wait", "doing", "done"];
const CONTACT_TARGETS = ["monastery", "vendor", "volunteer", "etc"];
const CONTACT_METHODS = ["phone", "sms", "email", "visit", "etc"];
const CONTACT_PURPOSES = ["", "recovery", "inspect", "thread", "purchase", "etc"];
const pick = (v, list, label, dflt) => { const x = v == null || v === "" ? (dflt ?? "") : String(v); if (!list.includes(x)) throw bad(`${label}을(를) 골라 주세요.`); return x; };
const optId = (v) => (v === "" || v == null ? null : Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : (() => { throw bad("고른 항목을 확인해 주세요."); })());
const monasteryIdOf = (name) => {
  const n = String(name || "").trim();
  if (!n) return null;
  const r = db.prepare("SELECT id FROM monasteries WHERE name = ?").get(n);
  return r ? r.id : Number(db.prepare("INSERT INTO monasteries (name) VALUES (?)").run(n).lastInsertRowid);
};
// F14 메뉴×역할 권한 (settings.role_perms). 역할: staff 직원 · dept 부서 봉사자 · team 팀 봉사자 (관리자는 늘 모두)
// 기본값은 화면안의 MENU 표(v 조회·e 등록). 직원(staff)은 관리자가 '직원도 쓰기'를 켜야 씀 (기본 꺼짐)
const PERM_KEYS = ["dashboard", "monasteries", "contacts", "duties", "criteria", "groups", "inspect", "cutting", "shipments", "stock", "purchases"];
const PERM_ROLES = ["staff", "dept", "team"];
const PERM_DEFAULT = {
  dashboard: { v: ["staff"], e: [] },
  monasteries: { v: ["staff", "dept", "team"], e: ["staff", "dept", "team"] }, // 화면안은 직원만 등록이지만, 팀 봉사자의 '수도회 확인'(진행 상태·문제 표시)을 그대로 둠
  contacts: { v: ["staff", "dept", "team"], e: ["staff", "dept", "team"] },
  duties: { v: ["staff", "dept", "team"], e: [] },
  criteria: { v: ["staff", "dept", "team"], e: ["team"] },
  groups: { v: ["staff", "dept", "team"], e: ["team"] },
  inspect: { v: ["staff", "dept", "team"], e: ["team"] },
  cutting: { v: ["staff", "dept", "team"], e: ["staff", "dept", "team"] },
  shipments: { v: ["staff", "dept", "team"], e: ["staff", "dept"] },
  stock: { v: ["staff", "dept", "team"], e: ["staff", "dept"] },
  purchases: { v: ["staff", "dept"], e: ["staff", "dept"] }
};
function rolePerms() {
  let v = {};
  try { v = JSON.parse(q.setting.get("role_perms")?.value || "{}") || {}; } catch { v = {}; }
  const perms = {};
  for (const k of PERM_KEYS) {
    const x = v.perms?.[k] || PERM_DEFAULT[k];
    const clean = (a) => (Array.isArray(a) ? a.filter((r) => PERM_ROLES.includes(r)) : []);
    perms[k] = { v: clean(x.v), e: clean(x.e).filter((r) => clean(x.v).includes(r)) };
  }
  return { staffOn: !!v.staffOn, perms };
}
const opsRole = (user) => {
  const admin = user.role === "admin";
  const role = admin ? "admin" : user.volunteer ? (user.vol_kind === "team" ? "team" : "dept") : "staff";
  const rp = rolePerms();
  const can = (key, mode) => admin || ((role !== "staff" || rp.staffOn) && rp.perms[key][mode].includes(role));
  const lead = (key) => can(key, "e") && (role !== "team" || !!user.vol_leader); // 팀 봉사자는 리더만 (기준·조)
  // 수도회 연락처(전화·주소)를 보는 사람: 관리자·직원·팀 봉사자 (팀 공개는 사용자 확인 전까지 지금처럼)
  return { admin, role, can, lead, team: admin || role === "team" || role === "staff", dept: admin || role === "dept" || role === "staff", leader: lead("groups") };
};
function monasteriesOut(r) {
  const rows = db.prepare(`SELECT m.*,
      (SELECT count(*) FROM vol_schedules s WHERE s.monastery_id = m.id) AS visits,
      (SELECT count(*) FROM vol_requests x WHERE x.monastery_id = m.id) + (SELECT count(*) FROM shipments x WHERE x.monastery_id = m.id) + (SELECT count(*) FROM contact_logs x WHERE x.monastery_id = m.id) + (SELECT count(*) FROM thread_handouts x WHERE x.monastery_id = m.id) AS other_links,
      (SELECT count(*) FROM vol_schedules s LEFT JOIN team_org_info t ON t.schedule_id = s.id WHERE s.monastery_id = m.id AND ${EDU_STATUS_SQL} = 'done') AS edu_done_n,
      (SELECT coalesce(sum(s.qty), 0) FROM vol_schedules s WHERE s.monastery_id = m.id AND s.sum_note = '') AS req_qty,
      (SELECT coalesce(sum(x.qty), 0) FROM team_recovery x JOIN vol_schedules s ON s.id = x.schedule_id WHERE s.monastery_id = m.id) AS recovered_qty,
      (SELECT coalesce(sum(i.checked_qty), 0) FROM inspections i JOIN vol_schedules s ON s.id = i.schedule_id WHERE s.monastery_id = m.id) AS checked_qty
    FROM monasteries m ORDER BY m.name`).all();
  return rows.map((m) => ({ id: m.id, name: m.name, shortName: m.short_name, contactName: m.contact_name, phone: r.team ? m.phone : "", address: m.address, status: m.status, issueNote: m.issue_note, note: m.note,
    visits: m.visits, deletable: !m.visits && !m.other_links, eduDone: m.edu_done_n, reqQty: m.req_qty, recoveredQty: m.recovered_qty, checkedQty: m.checked_qty, updatedAt: m.updated_at }));
}
const nameOfUser = (id) => (id ? db.prepare("SELECT name FROM users WHERE id = ?").get(id)?.name || "" : "");
function shipmentsOut() {
  return db.prepare(`SELECT x.*, m.name AS monastery, u.name AS party_user, e.name AS vendor, h.name AS handler, s.title AS schedule_title, c.name AS author,
      (SELECT id FROM team_recovery r WHERE r.shipment_id = x.id LIMIT 1) AS recovery_id
    FROM shipments x LEFT JOIN monasteries m ON m.id = x.monastery_id LEFT JOIN users u ON u.id = x.user_id LEFT JOIN external_contacts e ON e.id = x.external_contact_id
    LEFT JOIN users h ON h.id = x.handler_id LEFT JOIN vol_schedules s ON s.id = x.schedule_id LEFT JOIN users c ON c.id = x.created_by
    ORDER BY CASE x.status WHEN 'ready' THEN 0 WHEN 'sent' THEN 1 ELSE 2 END, coalesce(x.arrived_date, x.sent_date, x.created_at) DESC, x.id DESC`).all()
    .map((x) => ({ id: x.id, direction: x.direction, partyType: x.party_type, monasteryId: x.monastery_id, userId: x.user_id, externalContactId: x.external_contact_id,
      party: x.monastery || x.party_user || x.vendor || x.party_name || "", partyName: x.party_name, address: x.address, carrier: x.carrier, trackingNo: x.tracking_no, contents: x.contents, qty: x.qty,
      status: x.status, sentDate: x.sent_date || "", arrivedDate: x.arrived_date || "", handlerId: x.handler_id, handler: x.handler || "", scheduleId: x.schedule_id,
      schedule: x.schedule_title ? x.schedule_title.split(" · ").pop() : "", note: x.note, author: x.author || "", createdBy: x.created_by, recoveryId: x.recovery_id || null, updatedAt: x.updated_at }));
}
// 택배 수신(도착)이 수도회 물량이면 회수 기록을 하나 만들어 검수 대기 목록에 보이게 (이미 이어진 회수가 있으면 그대로)
function recoveryFromShipment(sh, user) {
  if (sh.direction !== "in" || sh.status !== "arrived" || !sh.monastery_id) return null;
  if (db.prepare("SELECT 1 FROM team_recovery WHERE shipment_id = ?").get(sh.id)) return null;
  // 수도회 상태: 아직 회수 전 단계면 '회수완료'로 (문제 있음·검수완료는 그대로)
  db.prepare("UPDATE monasteries SET status = 'recovered', updated_at = datetime('now') WHERE id = ? AND status IN ('new', 'edu_done', 'making')").run(sh.monastery_id);
  const gid = rosaryGroupId();
  const sid = sh.schedule_id || db.prepare("SELECT id FROM vol_schedules WHERE monastery_id = ? AND project_item_id = ? ORDER BY date DESC LIMIT 1").get(sh.monastery_id, gid)?.id;
  if (!sid) return null;
  return Number(db.prepare("INSERT INTO team_recovery (schedule_id, date, qty, method, note, created_by, shipment_id) VALUES (?, ?, ?, 'parcel', ?, ?, ?)")
    .run(sid, sh.arrived_date || today(), sh.qty || 0, sh.contents ? `택배: ${sh.contents}`.slice(0, 500) : "택배 수신", user.id, sh.id).lastInsertRowid);
}
function shipmentInput(b, old) {
  const g = (k, f) => (has(b, k) ? f(b[k]) : old ? old[k] : f(undefined));
  const direction = old ? old.direction : pick(b.direction, ["out", "in"], "보내기·받기");
  const party_type = has(b, "partyType") ? pick(b.partyType, PARTY_TYPES, "상대 종류") : old ? old.party_type : pick(undefined, PARTY_TYPES, "상대 종류", "monastery");
  const status = has(b, "status") ? pick(b.status, SHIP_STATUS, "택배 상태") : old ? old.status : "ready";
  const date = (v, label) => { if (v === "" || v == null) return null; if (!isDate(v)) throw bad(`${label}을 확인해 주세요.`); return v; };
  const v = {
    direction, party_type,
    monastery_id: has(b, "monasteryId") ? optId(b.monasteryId) : old ? old.monastery_id : null,
    user_id: has(b, "userId") ? optId(b.userId) : old ? old.user_id : null,
    external_contact_id: has(b, "externalContactId") ? optId(b.externalContactId) : old ? old.external_contact_id : null,
    party_name: has(b, "partyName") ? text(b.partyName, 80, "상대 이름") || "" : old ? old.party_name : "",
    address: has(b, "address") ? text(b.address, 200, "주소") || "" : old ? old.address : "",
    carrier: has(b, "carrier") ? text(b.carrier, 40, "택배사") || "" : old ? old.carrier : "",
    tracking_no: has(b, "trackingNo") ? text(b.trackingNo, 40, "송장번호") || "" : old ? old.tracking_no : "",
    contents: has(b, "contents") ? text(b.contents, 200, "내용물") || "" : old ? old.contents : "",
    qty: has(b, "qty") ? teamQty(b.qty, "수량") : old ? old.qty : null,
    status,
    sent_date: g("sentDate", (x) => date(x, "발송일")),
    arrived_date: g("arrivedDate", (x) => date(x, "도착일")),
    handler_id: has(b, "handlerId") ? optId(b.handlerId) : old ? old.handler_id : null,
    schedule_id: has(b, "scheduleId") ? optId(b.scheduleId) : old ? old.schedule_id : null,
    note: has(b, "note") ? text(b.note, 500, "메모") || "" : old ? old.note : ""
  };
  if (old && has(b, "sentDate") === false) v.sent_date = old.sent_date;
  if (old && has(b, "arrivedDate") === false) v.arrived_date = old.arrived_date;
  if (v.party_type === "monastery" && !v.monastery_id) throw bad("수도회를 골라 주세요.");
  if (v.party_type === "etc" && !v.party_name && !v.user_id && !v.external_contact_id) throw bad("상대 이름을 적어 주세요.");
  if (v.monastery_id && !db.prepare("SELECT 1 FROM monasteries WHERE id = ?").get(v.monastery_id)) throw bad("수도회를 확인해 주세요.");
  if (v.status === "sent" && !v.sent_date) v.sent_date = today();
  if (v.status === "arrived" && !v.arrived_date) v.arrived_date = today();
  return v;
}
const dutiesOut = () => db.prepare("SELECT d.*, u.name, u.volunteer, u.vol_kind, u.role FROM duty_assignments d JOIN users u ON u.id = d.user_id ORDER BY d.duty, d.start_date, u.name").all()
  .map((d) => ({ id: d.id, duty: d.duty, userId: d.user_id, name: d.name, who: d.role === "admin" ? "관리자" : !d.volunteer ? "직원" : d.vol_kind === "team" ? "팀 봉사자" : d.vol_kind === "both" ? "부서·팀 봉사자" : "부서 봉사자",
    startDate: d.start_date, endDate: d.end_date, note: d.note, active: (!d.start_date || d.start_date <= today()) && (!d.end_date || d.end_date >= today()) }));
function criteriaOut() {
  const rows = db.prepare("SELECT * FROM inspection_criteria ORDER BY version, sort, id").all();
  const versions = [...new Set(rows.map((r) => r.version))];
  const t = today();
  const current = [...versions].reverse().find((v) => rows.find((r) => r.version === v).valid_from <= t) ?? versions[0] ?? null;
  const used = new Map(db.prepare("SELECT criteria_version AS v, count(*) AS n FROM inspections WHERE criteria_version IS NOT NULL GROUP BY criteria_version").all().map((x) => [x.v, x.n]));
  return { current, versions: versions.map((v) => { const it = rows.filter((r) => r.version === v); return { version: v, validFrom: it[0].valid_from, approvedBy: it[0].approved_by, used: used.get(v) || 0,
    items: it.map((r) => ({ id: r.id, sort: r.sort, item: r.item, method: r.method, passRule: r.pass_rule, defectKey: r.defect_key, defectName: r.defect_name })) }; }) };
}
// 검수 입력에서 고를 수 있는 불량 코드: 지금 기준 판 (예전 기록을 고칠 때를 위해 모든 판의 코드와 예전 유형도 받음)
const defectKeysAll = () => new Set([...DEFECT_TYPES, ...db.prepare("SELECT defect_key FROM inspection_criteria").all().map((r) => r.defect_key)]);
function groupsOut(userId) {
  const groups = db.prepare("SELECT g.*, u.name AS leader FROM inspection_groups g LEFT JOIN users u ON u.id = g.leader_id ORDER BY g.active DESC, g.name").all();
  const mem = db.prepare("SELECT m.group_id, u.id, u.name FROM inspection_group_members m JOIN users u ON u.id = m.user_id ORDER BY u.name").all();
  const asg = db.prepare(`SELECT a.*, s.title, s.qty AS req_qty, m.name AS monastery,
      (SELECT coalesce(sum(i.checked_qty), 0) FROM inspections i WHERE i.group_id = a.group_id AND i.schedule_id = a.schedule_id) AS checked
    FROM inspection_group_assigns a JOIN vol_schedules s ON s.id = a.schedule_id LEFT JOIN monasteries m ON m.id = s.monastery_id ORDER BY a.status = 'done', a.due_date IS NULL, a.due_date, a.id`).all();
  return groups.map((g) => ({ id: g.id, name: g.name, leaderId: g.leader_id, leader: g.leader || "", active: !!g.active, note: g.note,
    members: mem.filter((m) => m.group_id === g.id).map((m) => ({ id: m.id, name: m.name })), mine: g.leader_id === userId || mem.some((m) => m.group_id === g.id && m.id === userId),
    assigns: asg.filter((a) => a.group_id === g.id).map((a) => ({ id: a.id, scheduleId: a.schedule_id, org: a.monastery || a.title.split(" · ").pop(), qty: a.qty, dueDate: a.due_date || "", status: a.status, note: a.note, checked: a.checked })) }));
}
function contactLogsOut(userId) {
  return db.prepare(`SELECT c.*, m.name AS monastery, e.name AS vendor, u.name AS person, a.name AS author, s.title AS schedule_title FROM contact_logs c
      LEFT JOIN monasteries m ON m.id = c.monastery_id LEFT JOIN external_contacts e ON e.id = c.external_contact_id LEFT JOIN users u ON u.id = c.user_id
      LEFT JOIN users a ON a.id = c.created_by LEFT JOIN vol_schedules s ON s.id = c.schedule_id
    ORDER BY c.done, c.due_date IS NULL, c.due_date, c.date DESC, c.id DESC`).all()
    .map((c) => ({ id: c.id, targetType: c.target_type, monasteryId: c.monastery_id, externalContactId: c.external_contact_id, userId: c.user_id, target: c.monastery || c.vendor || c.person || c.target_name || "",
      targetName: c.target_name, scheduleId: c.schedule_id, date: c.date, method: c.method, purpose: c.purpose, content: c.content, followUp: c.follow_up, dueDate: c.due_date || "", done: !!c.done,
      author: c.author || "", mine: c.created_by === userId, overdue: !c.done && !!c.follow_up && !!c.due_date && c.due_date <= today() }));
}
// 검수 대기: 회수(택배 수신 포함)했는데 아직 검수 기록이 이어지지 않은 건
const inspectWaiting = () => db.prepare(`SELECT r.*, s.title, s.monastery_id, m.name AS monastery, x.tracking_no, x.carrier,
    (SELECT coalesce(sum(i.checked_qty), 0) FROM inspections i WHERE i.recovery_id = r.id) AS checked
  FROM team_recovery r JOIN vol_schedules s ON s.id = r.schedule_id LEFT JOIN monasteries m ON m.id = s.monastery_id LEFT JOIN shipments x ON x.id = r.shipment_id
  ORDER BY r.date, r.id`).all().filter((r) => r.checked < r.qty || (!r.qty && !r.checked))
  .map((r) => ({ id: r.id, scheduleId: r.schedule_id, monasteryId: r.monastery_id ?? null, org: r.monastery || r.title.split(" · ").pop(), date: r.date, qty: r.qty, checked: r.checked, method: r.method, shipmentId: r.shipment_id, trackingNo: r.tracking_no || "", carrier: r.carrier || "" }));
// 메뉴 단계 옆에 보여 줄 '처리할 건수'
function opsCounts(user) {
  const r = opsRole(user), t = today(), c = {};
  const one = (sql, ...a) => db.prepare(sql).get(...a).n;
  if (r.team) {
    const orgs = teamOrgRows(r.admin);
    c.tedu1 = one("SELECT count(*) AS n FROM monasteries WHERE status = 'issue'");
    c.tedu2 = orgs.filter((o) => o.tableOnly && o.status !== "done").length;
    c.tedu3 = orgs.filter((o) => !o.tableOnly && o.date < t && o.status === "plan").length;
    c.tedu4 = orgs.reduce((n, o) => n + o.openInquiries, 0) + one("SELECT count(*) AS n FROM contact_logs WHERE done = 0 AND follow_up <> '' AND due_date IS NOT NULL AND due_date <= ?", t);
    c.tmake1 = orgs.filter((o) => o.status === "done" && o.madeQty == null).length;
    c.tmake2 = one("SELECT count(*) AS n FROM monasteries m WHERE m.status IN ('edu_done', 'making') AND NOT EXISTS (SELECT 1 FROM team_recovery r JOIN vol_schedules s ON s.id = r.schedule_id WHERE s.monastery_id = m.id)");
    c.tmake3 = one("SELECT count(*) AS n FROM shipments WHERE direction = 'in' AND status = 'sent'");
    c.tins3 = inspectWaiting().length;
    c.tins4 = q.inspections.all().filter((x) => x.defects && x.defects !== "{}" && !x.rework).length;
    c.tins2 = one("SELECT count(*) AS n FROM inspection_group_assigns a WHERE a.status <> 'done' AND a.group_id IN (SELECT group_id FROM inspection_group_members WHERE user_id = ? UNION SELECT id FROM inspection_groups WHERE leader_id = ?)", user.id, user.id);
  }
  if (r.dept) {
    c.dr1 = one("SELECT count(*) AS n FROM shipments WHERE direction = 'in' AND status = 'sent'");
    c.ds3 = one("SELECT count(*) AS n FROM shipments WHERE direction = 'out' AND status = 'ready'");
  }
  c.followups = one("SELECT count(*) AS n FROM contact_logs WHERE done = 0 AND follow_up <> '' AND due_date IS NOT NULL AND due_date <= ? AND created_by = ?", t, user.id);
  return c;
}
async function opsRoute(req, res, user, path, method) {
  const r = opsRole(user);
  const ok = (code, body) => { send(res, code, body); return true; };
  const deny = (msg) => ok(403, { error: msg });
  if (r.role === "staff" && !rolePerms().staffOn && path !== "/api/ops/perms") return deny("직원 계정은 관리자가 '직원도 쓰기'를 켜야 써요.");
  if (path === "/api/ops/counts" && method === "GET") return ok(200, { counts: opsCounts(user) });
  if (path === "/api/ops/menu" && method === "GET") return ok(200, { menu: volMenu() }); // 팀 봉사자도 메뉴 공개 설정(단계형 메뉴)을 읽음
  // F01 수도회
  if (path === "/api/ops/monasteries" && method === "GET") { if (!r.can("monasteries", "v")) return deny("볼 수 없는 메뉴예요."); return ok(200, { monasteries: monasteriesOut(r), canEdit: r.can("monasteries", "e"), canPhone: r.admin }); }
  const monName = (v) => text(v, 80, "수도회 이름", true).replace(/·/g, " ").replace(/\s+/g, " ").trim();
  if (path === "/api/ops/monasteries" && method === "POST") {
    if (!r.can("monasteries", "e")) return deny("수도회를 추가할 수 없는 계정이에요.");
    const b = await readJson(req), name = monName(b.name);
    if (db.prepare("SELECT 1 FROM monasteries WHERE name = ?").get(name)) throw bad("이미 있는 수도회예요.");
    db.prepare("INSERT INTO monasteries (name) VALUES (?)").run(name);
    return ok(201, { monasteries: monasteriesOut(r) });
  }
  const mm = path.match(/^\/api\/ops\/monasteries\/(\d+)$/);
  if (mm && method === "PATCH") {
    if (!r.can("monasteries", "e")) return deny("수도회 정보를 고칠 수 없는 계정이에요.");
    const m = db.prepare("SELECT * FROM monasteries WHERE id = ?").get(Number(mm[1]));
    if (!m) throw notFound("수도회");
    const b = await readJson(req);
    if (has(b, "phone") && !r.admin) return deny("연락처는 관리자만 적어요.");
    const v = {
      short_name: has(b, "shortName") ? text(b.shortName, 40, "약칭") || "" : m.short_name,
      contact_name: has(b, "contactName") ? text(b.contactName, 80, "담당 수녀·수사") || "" : m.contact_name,
      phone: has(b, "phone") ? text(b.phone, 300, "연락처") || "" : m.phone,
      address: has(b, "address") ? text(b.address, 200, "주소") || "" : m.address,
      status: has(b, "status") ? pick(b.status, MON_STATUS, "진행 상태") : m.status,
      issue_note: has(b, "issueNote") ? text(b.issueNote, 500, "문제 내용") || "" : m.issue_note,
      note: has(b, "note") ? text(b.note, 1000, "메모") || "" : m.note
    };
    if (v.status === "issue" && !v.issue_note) throw bad("문제 내용을 적어 주세요.");
    // 이름 바꾸기: 같은 이름이 있으면 막음. 이어진 방문 일정 제목('묵주 교육 · 이름')도 같이 바꿔 팀 화면과 맞춤 (네이버폼 신청의 원문 이름은 그대로)
    const name = has(b, "name") ? monName(b.name) : m.name;
    if (name !== m.name && db.prepare("SELECT 1 FROM monasteries WHERE name = ? AND id <> ?").get(name, m.id)) throw bad("같은 이름의 수도회가 있어요.");
    inTx(() => {
      db.prepare("UPDATE monasteries SET name = ?, short_name = ?, contact_name = ?, phone = ?, address = ?, status = ?, issue_note = ?, note = ?, updated_at = datetime('now') WHERE id = ?")
        .run(name, v.short_name, v.contact_name, v.phone, v.address, v.status, v.issue_note, v.note, m.id);
      if (name !== m.name) for (const s2 of db.prepare("SELECT id, title FROM vol_schedules WHERE monastery_id = ? AND project_item_id IS NOT NULL").all(m.id)) {
        const parts = s2.title.split(" · ");
        if (parts.length > 1 && parts[parts.length - 1].trim() === m.name) db.prepare("UPDATE vol_schedules SET title = ? WHERE id = ?").run([...parts.slice(0, -1), name].join(" · "), s2.id);
      }
    });
    return ok(200, { monasteries: monasteriesOut(r) });
  }
  // 지우기: 방문 일정·신청·택배·연락 기록·타래 배분이 이어진 수도회는 막음 (잘못 만든 수도회만 지움)
  if (mm && method === "DELETE") {
    if (!r.can("monasteries", "e")) return deny("수도회를 지울 수 없는 계정이에요.");
    const m = db.prepare("SELECT * FROM monasteries WHERE id = ?").get(Number(mm[1]));
    if (!m) throw notFound("수도회");
    const used = [["vol_schedules", "방문 일정"], ["vol_requests", "네이버폼 신청"], ["shipments", "택배"], ["contact_logs", "연락 기록"], ["thread_handouts", "타래 배분"]]
      .map(([t, l]) => [l, db.prepare(`SELECT count(*) AS n FROM ${t} WHERE monastery_id = ?`).get(m.id).n]).filter(([, n]) => n);
    if (used.length) throw bad(`${used.map(([l, n]) => `${l} ${n}건`).join(", ")}이 이어져 있어 지울 수 없어요. 이름을 고치거나 메모로 남겨 주세요.`);
    db.prepare("DELETE FROM monasteries WHERE id = ?").run(m.id);
    return ok(200, { monasteries: monasteriesOut(r) });
  }
  // F02 택배 (부서 봉사자·관리자가 입력, 팀 봉사자는 조회)
  if (path === "/api/ops/shipments" && method === "GET") { if (!r.can("shipments", "v")) return deny("볼 수 없는 메뉴예요."); return ok(200, { shipments: shipmentsOut(), canEdit: r.can("shipments", "e") }); }
  if (path === "/api/ops/shipments" && method === "POST") {
    if (!r.can("shipments", "e")) return deny("택배 기록은 부서 봉사자·직원과 관리자가 적어요.");
    const v = shipmentInput(await readJson(req));
    const id = inTx(() => {
      const id = Number(db.prepare(`INSERT INTO shipments (direction, party_type, monastery_id, user_id, external_contact_id, party_name, address, carrier, tracking_no, contents, qty, status, sent_date, arrived_date, handler_id, schedule_id, note, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(v.direction, v.party_type, v.monastery_id, v.user_id, v.external_contact_id, v.party_name, v.address, v.carrier, v.tracking_no, v.contents, v.qty, v.status, v.sent_date, v.arrived_date, v.handler_id, v.schedule_id, v.note, user.id).lastInsertRowid);
      recoveryFromShipment(db.prepare("SELECT * FROM shipments WHERE id = ?").get(id), user);
      return id;
    });
    return ok(201, { id, shipments: shipmentsOut() });
  }
  const shm = path.match(/^\/api\/ops\/shipments\/(\d+)$/);
  if (shm) {
    const x = db.prepare("SELECT * FROM shipments WHERE id = ?").get(Number(shm[1]));
    if (!x) throw notFound("택배 기록");
    if (!r.can("shipments", "e")) return deny("택배 기록은 부서 봉사자·직원과 관리자가 고쳐요.");
    if (method === "PATCH") {
      const v = shipmentInput(await readJson(req), x);
      inTx(() => {
        db.prepare(`UPDATE shipments SET party_type = ?, monastery_id = ?, user_id = ?, external_contact_id = ?, party_name = ?, address = ?, carrier = ?, tracking_no = ?, contents = ?, qty = ?, status = ?, sent_date = ?, arrived_date = ?, handler_id = ?, schedule_id = ?, note = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(v.party_type, v.monastery_id, v.user_id, v.external_contact_id, v.party_name, v.address, v.carrier, v.tracking_no, v.contents, v.qty, v.status, v.sent_date, v.arrived_date, v.handler_id, v.schedule_id, v.note, x.id);
        recoveryFromShipment(db.prepare("SELECT * FROM shipments WHERE id = ?").get(x.id), user);
      });
      return ok(200, { shipments: shipmentsOut() });
    }
    if (method === "DELETE") {
      if (!r.admin && x.created_by !== user.id) return deny("적은 사람과 관리자만 지울 수 있어요.");
      if (db.prepare("SELECT 1 FROM team_recovery WHERE shipment_id = ?").get(x.id) && !r.admin) return deny("회수 기록과 이어진 택배는 관리자만 지울 수 있어요.");
      db.prepare("DELETE FROM shipments WHERE id = ?").run(x.id);
      return ok(200, { shipments: shipmentsOut() });
    }
    return ok(405, { error: "Method not allowed" });
  }
  // F03 업무 담당자 (관리자가 넣고, 모두 봄)
  if (path === "/api/ops/duties" && method === "GET") {
    if (!r.can("duties", "v")) return deny("볼 수 없는 메뉴예요.");
    const people = r.can("duties", "e") ? db.prepare("SELECT id, name, role, volunteer, vol_kind FROM users ORDER BY volunteer, name").all().map((u) => ({ id: u.id, name: u.name, who: u.role === "admin" ? "관리자" : !u.volunteer ? "직원" : u.vol_kind === "team" ? "팀 봉사자" : "부서 봉사자" })) : undefined;
    return ok(200, { duties: dutiesOut(), canEdit: r.can("duties", "e"), people });
  }
  const dutyIn = (b) => {
    const uid = optId(b.userId);
    if (!uid || !db.prepare("SELECT 1 FROM users WHERE id = ?").get(uid)) throw bad("담당자를 골라 주세요.");
    const d = (v, l) => { if (!v) return ""; if (!isDate(v)) throw bad(`${l}을 확인해 주세요.`); return v; };
    const s = d(b.startDate, "시작일"), e = d(b.endDate, "종료일");
    if (s && e && e < s) throw bad("종료일이 시작일보다 빨라요.");
    return [pick(b.duty, DUTIES, "업무"), uid, s, e, text(b.note, 300, "메모") || ""];
  };
  if (path === "/api/ops/duties" && method === "POST") {
    if (!r.can("duties", "e")) return deny("업무 담당자는 관리자가 정해요.");
    db.prepare("INSERT INTO duty_assignments (duty, user_id, start_date, end_date, note, created_by) VALUES (?, ?, ?, ?, ?, ?)").run(...dutyIn(await readJson(req)), user.id);
    return ok(201, { duties: dutiesOut() });
  }
  const dm = path.match(/^\/api\/ops\/duties\/(\d+)$/);
  if (dm) {
    if (!r.can("duties", "e")) return deny("업무 담당자는 관리자가 정해요.");
    const x = db.prepare("SELECT * FROM duty_assignments WHERE id = ?").get(Number(dm[1]));
    if (!x) throw notFound("업무 담당");
    if (method === "PATCH") { db.prepare("UPDATE duty_assignments SET duty = ?, user_id = ?, start_date = ?, end_date = ?, note = ? WHERE id = ?").run(...dutyIn(await readJson(req)), x.id); return ok(200, { duties: dutiesOut() }); }
    if (method === "DELETE") { db.prepare("DELETE FROM duty_assignments WHERE id = ?").run(x.id); return ok(200, { duties: dutiesOut() }); }
    return ok(405, { error: "Method not allowed" });
  }
  // F04 검수 기준: 바꾸면 새 판으로 쌓음 (예전 판은 그대로 남아 예전 결과를 그 기준으로 봄)
  if (path === "/api/ops/criteria" && method === "GET") { if (!r.can("criteria", "v")) return deny("볼 수 없는 메뉴예요."); return ok(200, { ...criteriaOut(), canEdit: r.lead("criteria") }); }
  const crm = path.match(/^\/api\/ops\/criteria\/(\d+)$/);
  if ((path === "/api/ops/criteria" && method === "POST") || (crm && method === "PUT")) {
    if (!r.lead("criteria")) return deny("검수 기준은 리더 봉사자와 관리자가 정해요.");
    const b = await readJson(req);
    const editV = crm ? Number(crm[1]) : null;
    if (editV != null) {
      if (!db.prepare("SELECT 1 FROM inspection_criteria WHERE version = ?").get(editV)) throw notFound("검수 기준 판");
      const n = db.prepare("SELECT count(*) AS n FROM inspections WHERE criteria_version = ?").get(editV).n;
      if (n) throw bad(`이 판으로 적은 검수 기록이 ${n}건 있어 고칠 수 없어요. 새 판을 만들어 주세요.`);
    }
    if (!isDate(b.validFrom)) throw bad("적용 시작일을 확인해 주세요.");
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length || items.length > 40) throw bad("검수 항목을 1개 이상 적어 주세요.");
    const keys = new Set();
    const rows = items.map((it, i) => {
      const item = text(it.item, 80, "검수 항목", true), name = text(it.defectName, 40, "불량 이름", true);
      const key = (text(it.defectKey, 40, "불량 코드") || name).trim();
      if (keys.has(key)) throw bad(`불량 코드 '${key}' 가 두 번 들어갔어요.`);
      keys.add(key);
      return [i, item, text(it.method, 300, "확인 방법") || "", text(it.passRule, 300, "합격 기준") || "", key, name];
    });
    const version = editV ?? (db.prepare("SELECT max(version) AS v FROM inspection_criteria").get().v || 0) + 1;
    inTx(() => { if (editV != null) db.prepare("DELETE FROM inspection_criteria WHERE version = ?").run(editV); const add = db.prepare("INSERT INTO inspection_criteria (version, sort, item, method, pass_rule, defect_key, defect_name, valid_from, approved_by, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const x of rows) add.run(version, ...x, b.validFrom, text(b.approvedBy, 80, "확인한 사람") || "", user.id); });
    return ok(editV != null ? 200 : 201, { ...criteriaOut(), canEdit: r.lead("criteria") });
  }
  // 판 지우기: 그 판으로 적은 검수 기록이 있으면 막음, 하나 남은 판은 지우지 않음
  if (crm && method === "DELETE") {
    if (!r.lead("criteria")) return deny("검수 기준은 리더 봉사자와 관리자가 정해요.");
    const v = Number(crm[1]);
    if (!db.prepare("SELECT 1 FROM inspection_criteria WHERE version = ?").get(v)) throw notFound("검수 기준 판");
    const n = db.prepare("SELECT count(*) AS n FROM inspections WHERE criteria_version = ?").get(v).n;
    if (n) throw bad(`이 판으로 적은 검수 기록이 ${n}건 있어 지울 수 없어요.`);
    if (db.prepare("SELECT count(DISTINCT version) AS n FROM inspection_criteria").get().n <= 1) throw bad("하나 남은 판은 지울 수 없어요.");
    db.prepare("DELETE FROM inspection_criteria WHERE version = ?").run(v);
    return ok(200, { ...criteriaOut(), canEdit: r.lead("criteria") });
  }
  // F05 검수 조
  const people = () => db.prepare("SELECT id, name FROM users WHERE volunteer = 1 AND vol_kind IN ('team', 'both') ORDER BY name").all();
  if (path === "/api/ops/groups" && method === "GET") return !r.can("groups", "v") ? deny("볼 수 없는 메뉴예요.") : ok(200, { waiting: r.leader ? inspectWaiting() : undefined, groups: groupsOut(user.id), canEdit: r.leader, people: r.leader ? people() : undefined,
    schedules: r.leader ? teamOrgRows(r.admin).map((o) => ({ id: o.id, org: o.org, date: o.tableOnly ? "" : o.date, reqQty: o.reqQty })) : undefined });
  const groupIn = (b) => {
    const lid = optId(b.leaderId);
    if (lid && !people().some((p) => p.id === lid) && !db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'admin'").get(lid)) throw bad("조장을 확인해 주세요.");
    return [text(b.name, 40, "조 이름", true), lid, b.active === false || b.active === 0 ? 0 : 1, text(b.note, 300, "메모") || ""];
  };
  const setMembers = (gid, ids) => {
    if (!Array.isArray(ids)) return;
    const ok2 = new Set(people().map((p) => p.id));
    db.prepare("DELETE FROM inspection_group_members WHERE group_id = ?").run(gid);
    for (const id of [...new Set(ids.map(Number))].filter((x) => ok2.has(x))) db.prepare("INSERT INTO inspection_group_members (group_id, user_id) VALUES (?, ?)").run(gid, id);
  };
  if (path === "/api/ops/groups" && method === "POST") {
    if (!r.leader) return deny("검수 조는 리더 봉사자와 관리자가 만들어요.");
    const b = await readJson(req), v = groupIn(b);
    if (db.prepare("SELECT 1 FROM inspection_groups WHERE name = ?").get(v[0])) throw bad("같은 이름의 조가 있어요.");
    inTx(() => { const id = Number(db.prepare("INSERT INTO inspection_groups (name, leader_id, active, note, created_by) VALUES (?, ?, ?, ?, ?)").run(...v, user.id).lastInsertRowid); setMembers(id, b.memberIds); });
    return ok(201, { groups: groupsOut(user.id) });
  }
  const gm = path.match(/^\/api\/ops\/groups\/(\d+)(\/assigns)?$/);
  if (gm) {
    if (!r.leader) return deny("검수 조는 리더 봉사자와 관리자가 고쳐요.");
    const g = db.prepare("SELECT * FROM inspection_groups WHERE id = ?").get(Number(gm[1]));
    if (!g) throw notFound("검수 조");
    if (gm[2] && method === "POST") {
      const b = await readJson(req), s = teamOrgOf(b.scheduleId);
      if (b.dueDate && !isDate(b.dueDate)) throw bad("완료 예정일을 확인해 주세요.");
      db.prepare("INSERT INTO inspection_group_assigns (group_id, schedule_id, qty, due_date, status, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(g.id, s.id, teamQty(b.qty, "배정 수량"), b.dueDate || null, pick(b.status, ASSIGN_STATUS, "상태", "wait"), text(b.note, 300, "메모") || "", user.id);
      return ok(201, { groups: groupsOut(user.id) });
    }
    if (!gm[2] && method === "PATCH") {
      const b = await readJson(req), v = groupIn({ name: g.name, leaderId: g.leader_id, active: !!g.active, note: g.note, ...b });
      if (v[0] !== g.name && db.prepare("SELECT 1 FROM inspection_groups WHERE name = ? AND id <> ?").get(v[0], g.id)) throw bad("같은 이름의 조가 있어요.");
      inTx(() => { db.prepare("UPDATE inspection_groups SET name = ?, leader_id = ?, active = ?, note = ? WHERE id = ?").run(...v, g.id); setMembers(g.id, b.memberIds); });
      return ok(200, { groups: groupsOut(user.id) });
    }
    if (!gm[2] && method === "DELETE") { db.prepare("DELETE FROM inspection_groups WHERE id = ?").run(g.id); return ok(200, { groups: groupsOut(user.id) }); }
    return ok(405, { error: "Method not allowed" });
  }
  const am = path.match(/^\/api\/ops\/assigns\/(\d+)$/);
  if (am) {
    const a = db.prepare("SELECT * FROM inspection_group_assigns WHERE id = ?").get(Number(am[1]));
    if (!a) throw notFound("물량 배정");
    const mine = db.prepare("SELECT 1 FROM inspection_group_members WHERE group_id = ? AND user_id = ? UNION SELECT 1 FROM inspection_groups WHERE id = ? AND leader_id = ?").get(a.group_id, user.id, a.group_id, user.id);
    if (method === "PATCH") {
      const b = await readJson(req);
      if (!r.leader && !(mine && Object.keys(b).every((k) => k === "status"))) return deny("조원은 상태만 바꿀 수 있어요.");
      if (has(b, "dueDate") && b.dueDate && !isDate(b.dueDate)) throw bad("완료 예정일을 확인해 주세요.");
      db.prepare("UPDATE inspection_group_assigns SET qty = ?, due_date = ?, status = ?, note = ?, updated_at = datetime('now') WHERE id = ?")
        .run(has(b, "qty") ? teamQty(b.qty, "배정 수량") : a.qty, has(b, "dueDate") ? b.dueDate || null : a.due_date, has(b, "status") ? pick(b.status, ASSIGN_STATUS, "상태") : a.status, has(b, "note") ? text(b.note, 300, "메모") || "" : a.note, a.id);
      return ok(200, { groups: groupsOut(user.id) });
    }
    if (method === "DELETE") { if (!r.leader) return deny("배정은 리더 봉사자와 관리자가 지워요."); db.prepare("DELETE FROM inspection_group_assigns WHERE id = ?").run(a.id); return ok(200, { groups: groupsOut(user.id) }); }
    return ok(405, { error: "Method not allowed" });
  }
  if (path === "/api/ops/inspect-waiting" && method === "GET") { if (!r.can("inspect", "v")) return deny("볼 수 없는 메뉴예요."); return ok(200, { waiting: inspectWaiting() }); }
  // F06 연락 기록 (모두 적고 봄, 고치기·지우기는 적은 사람과 관리자)
  if (path === "/api/ops/contacts" && method === "GET") return !r.can("contacts", "v") ? deny("볼 수 없는 메뉴예요.") : ok(200, { logs: contactLogsOut(user.id), monasteries: monasteriesOut(r).map((m) => ({ id: m.id, name: m.name })) });
  const contactIn = (b, old = {}) => {
    const g = (k, ok2) => (has(b, k) ? ok2(b[k]) : old[k]);
    const target_type = has(b, "targetType") ? pick(b.targetType, CONTACT_TARGETS, "연락 대상") : old.target_type || "monastery";
    const v = {
      target_type, monastery_id: has(b, "monasteryId") ? optId(b.monasteryId) : old.monastery_id ?? null, external_contact_id: has(b, "externalContactId") ? optId(b.externalContactId) : old.external_contact_id ?? null,
      user_id: has(b, "userId") ? optId(b.userId) : old.user_id ?? null, target_name: has(b, "targetName") ? text(b.targetName, 80, "대상 이름") || "" : old.target_name || "",
      schedule_id: has(b, "scheduleId") ? optId(b.scheduleId) : old.schedule_id ?? null,
      date: has(b, "date") ? b.date : old.date, method: has(b, "method") ? pick(b.method, CONTACT_METHODS, "연락 방법") : old.method || "phone",
      purpose: has(b, "purpose") ? pick(b.purpose, CONTACT_PURPOSES, "목적") : old.purpose || "", content: has(b, "content") ? text(b.content, 1000, "연락 내용") || "" : old.content || "",
      follow_up: has(b, "followUp") ? text(b.followUp, 500, "후속 조치") || "" : old.follow_up || "", due_date: has(b, "dueDate") ? b.dueDate || null : old.due_date ?? null,
      done: has(b, "done") ? (b.done ? 1 : 0) : old.done || 0
    };
    if (!isDate(v.date)) throw bad("연락한 날짜를 확인해 주세요.");
    if (v.due_date && !isDate(v.due_date)) throw bad("후속 조치 기한을 확인해 주세요.");
    if (v.target_type === "monastery" && !v.monastery_id) throw bad("수도회를 골라 주세요.");
    if (v.target_type !== "monastery" && !v.target_name && !v.user_id && !v.external_contact_id) throw bad("누구에게 연락했는지 적어 주세요.");
    void g;
    return v;
  };
  const cols = "target_type, monastery_id, external_contact_id, user_id, target_name, schedule_id, date, method, purpose, content, follow_up, due_date, done";
  const vals = (v) => [v.target_type, v.monastery_id, v.external_contact_id, v.user_id, v.target_name, v.schedule_id, v.date, v.method, v.purpose, v.content, v.follow_up, v.due_date, v.done];
  if (path === "/api/ops/contacts" && method === "POST") {
    if (!r.can("contacts", "e")) return deny("연락 기록을 적을 수 없는 계정이에요.");
    db.prepare(`INSERT INTO contact_logs (${cols}, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...vals(contactIn(await readJson(req))), user.id);
    return ok(201, { logs: contactLogsOut(user.id) });
  }
  const cm2 = path.match(/^\/api\/ops\/contacts\/(\d+)$/);
  if (cm2) {
    const x = db.prepare("SELECT * FROM contact_logs WHERE id = ?").get(Number(cm2[1]));
    if (!x) throw notFound("연락 기록");
    if (method === "PATCH") {
      const b = await readJson(req);
      // 후속 조치 완료 표시는 누구나, 나머지 고치기는 적은 사람·관리자
      if (x.created_by !== user.id && !r.admin && !Object.keys(b).every((k) => k === "done")) return deny("적은 사람과 관리자만 고칠 수 있어요.");
      db.prepare(`UPDATE contact_logs SET ${cols.split(", ").map((c) => `${c} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`).run(...vals(contactIn(b, x)), x.id);
      return ok(200, { logs: contactLogsOut(user.id) });
    }
    if (method === "DELETE") { if (x.created_by !== user.id && !r.admin) return deny("적은 사람과 관리자만 지울 수 있어요."); db.prepare("DELETE FROM contact_logs WHERE id = ?").run(x.id); return ok(200, { logs: contactLogsOut(user.id) }); }
    return ok(405, { error: "Method not allowed" });
  }
  // ---- 데드라인 일정: 관리자만 적고 고치고 지움, 봉사자는 자기 쪽(모두·부서·팀) 것만 봄
  if (path === "/api/ops/deadlines" && method === "GET") return ok(200, { deadlines: deadlinesOut(r), canEdit: r.admin });
  if (path === "/api/ops/deadlines" && method === "POST") {
    if (!r.admin) return deny("데드라인 일정은 관리자가 적어요.");
    const v = deadlineIn(await readJson(req));
    db.prepare("INSERT INTO deadlines (date, title, note, audience, done, created_by) VALUES (?, ?, ?, ?, ?, ?)").run(v.date, v.title, v.note, v.audience, v.done, user.id);
    return ok(201, { deadlines: deadlinesOut(r), canEdit: true });
  }
  const dlm = path.match(/^\/api\/ops\/deadlines\/(\d+)$/);
  if (dlm) {
    if (!r.admin) return deny("데드라인 일정은 관리자가 고쳐요.");
    const x = db.prepare("SELECT * FROM deadlines WHERE id = ?").get(Number(dlm[1]));
    if (!x) throw notFound("데드라인 일정");
    if (method === "PATCH") { const v = deadlineIn({ date: x.date, title: x.title, note: x.note, audience: x.audience, done: !!x.done, ...(await readJson(req)) }); db.prepare("UPDATE deadlines SET date = ?, title = ?, note = ?, audience = ?, done = ?, updated_at = datetime('now') WHERE id = ?").run(v.date, v.title, v.note, v.audience, v.done, x.id); return ok(200, { deadlines: deadlinesOut(r), canEdit: true }); }
    if (method === "DELETE") { db.prepare("DELETE FROM deadlines WHERE id = ?").run(x.id); return ok(200, { deadlines: deadlinesOut(r), canEdit: true }); }
    return ok(405, { error: "Method not allowed" });
  }
  // ---- 묵주 WBS: 보기는 모두, 고치기는 관리자만 (저장 전에는 화면에 들어 있는 기본 공정표를 씀)
  if (path === "/api/ops/wbs" && method === "GET") { let wbs = null; try { wbs = JSON.parse(q.setting.get("rosary_wbs")?.value || "null"); } catch { wbs = null; } return ok(200, { wbs, canEdit: r.admin }); }
  if (path === "/api/ops/wbs" && method === "PUT") {
    if (!r.admin) return deny("WBS 는 관리자만 고쳐요.");
    const wbs = wbsIn(await readJson(req));
    q.setSetting.run("rosary_wbs", JSON.stringify(wbs));
    return ok(200, { wbs, canEdit: true });
  }
  // ---- F14 권한표 (관리자가 고침)
  if (path === "/api/ops/perms" && method === "GET") {
    const rp = rolePerms(), mine = Object.fromEntries(PERM_KEYS.map((k) => [k, { v: r.can(k, "v"), e: r.can(k, "e") }]));
    return ok(200, { role: r.role, mine, ...(r.admin ? { staffOn: rp.staffOn, perms: rp.perms, keys: PERM_KEYS, roles: PERM_ROLES, defaults: PERM_DEFAULT } : {}) });
  }
  if (path === "/api/ops/perms" && method === "PUT") {
    if (!r.admin) return deny("권한은 관리자가 정해요.");
    const b = await readJson(req), perms = {};
    for (const k of PERM_KEYS) {
      const x = b.perms?.[k] || PERM_DEFAULT[k], cl = (a) => (Array.isArray(a) ? [...new Set(a)].filter((y) => PERM_ROLES.includes(y)) : []);
      const v = cl(x.v); perms[k] = { v, e: cl(x.e).filter((y) => v.includes(y)) };
    }
    q.setSetting.run("role_perms", JSON.stringify({ staffOn: !!b.staffOn, perms }));
    const rp = rolePerms();
    return ok(200, { role: r.role, staffOn: rp.staffOn, perms: rp.perms, keys: PERM_KEYS, roles: PERM_ROLES, defaults: PERM_DEFAULT });
  }
  // ---- 관리 대시보드 (직원·관리자)
  if (path === "/api/ops/dashboard" && method === "GET") {
    if (!r.can("dashboard", "v")) return deny("볼 수 없는 메뉴예요.");
    const t = today();
    const mons = monasteriesOut(r);
    const made = new Map(db.prepare("SELECT s.monastery_id AS mid, sum(t.made_qty) AS n FROM team_org_info t JOIN vol_schedules s ON s.id = t.schedule_id WHERE s.monastery_id IS NOT NULL GROUP BY s.monastery_id").all().map((x) => [x.mid, x.n || 0]));
    const insp = db.prepare("SELECT i.checked_qty, i.defects, s.monastery_id AS mid FROM inspections i LEFT JOIN vol_schedules s ON s.id = i.schedule_id").all();
    const defectOf = (x) => Object.values(JSON.parse(x.defects || "{}")).reduce((a, b) => a + b, 0);
    const passBy = new Map();
    for (const x of insp) if (x.mid) passBy.set(x.mid, (passBy.get(x.mid) || 0) + x.checked_qty - defectOf(x));
    const checked = insp.reduce((a, x) => a + x.checked_qty, 0), bad = insp.reduce((a, x) => a + defectOf(x), 0);
    const assignsLeft = db.prepare(`SELECT a.qty, (SELECT coalesce(sum(i.checked_qty), 0) FROM inspections i WHERE i.group_id = a.group_id AND i.schedule_id = a.schedule_id) AS done FROM inspection_group_assigns a WHERE a.status <> 'done'`).all().reduce((n, a) => n + Math.max(0, (a.qty || 0) - a.done), 0);
    const waiting = inspectWaiting();
    const late = contactLogsOut(user.id).filter((c) => c.overdue);
    const low = stockOut().ledgers.flatMap((l) => l.options.filter((o) => o.safety != null && o.qty < o.safety).map((o) => ({ ledger: l.name, name: o.name, qty: o.qty, safety: o.safety, unit: l.unit })));
    const stages = Object.fromEntries(["new", "edu_done", "making", "recovered", "checked", "issue"].map((k) => [k, mons.filter((m) => m.status === k).length]));
    return ok(200, {
      date: t,
      kpi: { reqQty: mons.reduce((n, m) => n + m.reqQty, 0), inspectLeft: assignsLeft + waiting.reduce((n, w) => n + Math.max(0, w.qty - w.checked), 0), checked, bad, lateFollowups: late.length, lowStock: low.length },
      stages,
      monasteries: mons.filter((m) => m.status !== "new").map((m) => ({ id: m.id, name: m.name, status: m.status, req: m.reqQty, made: made.get(m.id) || 0, rec: m.recoveredQty, chk: m.checkedQty, pass: passBy.get(m.id) || 0 })),
      incoming: shipmentsOut().filter((s) => s.direction === "in" && s.status === "sent"),
      late, low
    });
  }
  // ---- F09·F10 재고·보관
  if (path === "/api/ops/stock" && method === "GET") { if (!r.can("stock", "v")) return deny("볼 수 없는 메뉴예요."); return ok(200, { ...stockOut(), canEdit: r.can("stock", "e"), canLocations: r.admin }); }
  if (path === "/api/ops/locations" && method === "POST") {
    if (!r.admin) return deny("보관 위치는 관리자가 등록해요.");
    const b = await readJson(req), name = text(b.name, 60, "위치 이름", true);
    if (db.prepare("SELECT 1 FROM storage_locations WHERE name = ?").get(name)) throw bad("같은 이름의 위치가 있어요.");
    db.prepare("INSERT INTO storage_locations (name, place, kind, sort, note) VALUES (?, ?, ?, ?, ?)").run(name, text(b.place, 80, "건물·방") || "", pick(b.kind, LOC_KINDS, "용도", "all"), Number(b.sort) || 0, text(b.note, 300, "메모") || "");
    return ok(201, { ...stockOut(), canEdit: r.can("stock", "e"), canLocations: true });
  }
  const lm = path.match(/^\/api\/ops\/locations\/(\d+)$/);
  if (lm && method === "PATCH") {
    if (!r.admin) return deny("보관 위치는 관리자가 고쳐요.");
    const x = db.prepare("SELECT * FROM storage_locations WHERE id = ?").get(Number(lm[1]));
    if (!x) throw notFound("보관 위치");
    const b = await readJson(req), name = has(b, "name") ? text(b.name, 60, "위치 이름", true) : x.name;
    if (name !== x.name && db.prepare("SELECT 1 FROM storage_locations WHERE name = ? AND id <> ?").get(name, x.id)) throw bad("같은 이름의 위치가 있어요.");
    db.prepare("UPDATE storage_locations SET name = ?, place = ?, kind = ?, sort = ?, active = ?, note = ? WHERE id = ?").run(name, has(b, "place") ? text(b.place, 80, "건물·방") || "" : x.place,
      has(b, "kind") ? pick(b.kind, LOC_KINDS, "용도") : x.kind, has(b, "sort") ? Number(b.sort) || 0 : x.sort, has(b, "active") ? (b.active ? 1 : 0) : x.active, has(b, "note") ? text(b.note, 300, "메모") || "" : x.note, x.id);
    return ok(200, { ...stockOut(), canEdit: r.can("stock", "e"), canLocations: true });
  }
  if (lm && method === "DELETE") {
    if (!r.admin) return deny("보관 위치는 관리자가 지워요.");
    const x = db.prepare("SELECT * FROM storage_locations WHERE id = ?").get(Number(lm[1]));
    if (!x) throw notFound("보관 위치");
    const n = db.prepare("SELECT (SELECT count(*) FROM stock_moves WHERE location_id = ? OR to_location_id = ?) + (SELECT count(*) FROM cutting_jobs WHERE location_id = ?) + (SELECT count(*) FROM vol_records WHERE location_id = ?) AS n").get(x.id, x.id, x.id, x.id).n;
    if (n) throw bad(`입출고·실자르기·완제품 기록 ${n}건에 쓰인 위치라 지울 수 없어요. '쓰는 위치'를 꺼 주세요.`);
    db.prepare("DELETE FROM storage_locations WHERE id = ?").run(x.id);
    return ok(200, { ...stockOut(), canEdit: r.can("stock", "e"), canLocations: true });
  }
  const om2 = path.match(/^\/api\/ops\/stock-options\/(\d+)$/);
  if (om2 && method === "PATCH") {
    if (!r.can("stock", "e")) return deny("안전재고는 직원·부서 봉사자와 관리자가 정해요.");
    const o = db.prepare("SELECT * FROM stock_options WHERE id = ?").get(Number(om2[1]));
    if (!o) throw notFound("품목");
    db.prepare("UPDATE stock_options SET safety_qty = ? WHERE id = ?").run(teamQty((await readJson(req)).safetyQty, "안전재고"), o.id);
    return ok(200, { ...stockOut(), canEdit: true, canLocations: r.admin });
  }
  if ((path === "/api/ops/stock/move" || path === "/api/ops/stock/adjust") && method === "POST") {
    if (!r.can("stock", "e")) return deny("재고는 직원·부서 봉사자와 관리자가 고쳐요.");
    const b = await readJson(req), { l, o } = ledgerOption(b.ledgerId, b.optionId);
    const date = b.date && isDate(b.date) ? b.date : today(), note = text(b.note, 300, "메모") || "";
    if (path.endsWith("/move")) {
      const qty = teamQty(b.qty, "옮길 수량"), from = optLoc(b.fromLocationId), to = optLoc(b.toLocationId);
      if (!qty) throw bad("옮길 수량을 적어 주세요.");
      if (!to || from === to) throw bad("옮길 위치를 골라 주세요.");
      inTx(() => {
        const out = refMove(l, o, "out", qty, date, `위치 이동${note ? ` · ${note}` : ""}`, user, { location: from, to, refType: "move" });
        refMove(l, o, "in", qty, date, `위치 이동${note ? ` · ${note}` : ""}`, user, { location: to, refType: "move", refId: out });
        db.prepare("UPDATE stock_moves SET ref_id = ? WHERE id = ?").run(out, out);
      });
    } else {
      const actual = teamQty(b.actualQty, "실제 센 수량");
      if (actual == null) throw bad("실제 센 수량을 적어 주세요.");
      const loc = optLoc(b.locationId), cur = optionQty(o.id, loc), diff = actual - cur;
      if (!diff) throw bad("지금 기록과 같아요. 조정할 차이가 없어요.");
      refMove(l, o, diff > 0 ? "in" : "out", Math.abs(diff), date, `실사 조정 (기록 ${cur} → 실제 ${actual})${note ? ` · ${note}` : ""}`, user, { location: loc, refType: "adjust" });
    }
    return ok(201, { ...stockOut(), canEdit: true, canLocations: r.admin });
  }
  // ---- F07·F08 실자르기·타래 배분
  if (path === "/api/ops/cutting" && method === "GET") {
    if (!r.can("cutting", "v")) return deny("볼 수 없는 메뉴예요.");
    return ok(200, { ...cuttingOut(), canEdit: r.can("cutting", "e"), canShip: r.can("shipments", "e") || r.can("cutting", "e"), ledgers: stockOut().ledgers.map((l) => ({ id: l.id, name: l.name, unit: l.unit, options: l.options.map((o) => ({ id: o.id, name: o.name, qty: o.qty })) })),
      locations: stockOut().locations.filter((x) => x.active), monasteries: db.prepare("SELECT id, name, address FROM monasteries ORDER BY name").all(),
      volunteers: db.prepare("SELECT id, name FROM users WHERE volunteer = 1 ORDER BY name").all() });
  }
  if (path === "/api/ops/cutting" && method === "POST") {
    if (!r.can("cutting", "e")) return deny("실자르기 기록을 적을 수 없는 계정이에요.");
    const v = cuttingIn(await readJson(req));
    const id = inTx(() => writeCutting(null, v, user));
    return ok(201, { id, ...cuttingOut() });
  }
  const cjm = path.match(/^\/api\/ops\/cutting\/(\d+)$/);
  if (cjm) {
    const x = db.prepare("SELECT * FROM cutting_jobs WHERE id = ?").get(Number(cjm[1]));
    if (!x) throw notFound("실자르기 기록");
    if (!r.can("cutting", "e") || (!r.admin && x.created_by !== user.id)) return deny("적은 사람과 관리자만 고치거나 지울 수 있어요.");
    // 고치기: 이 작업으로 쌓인 입출고를 지우고 새 값으로 다시 쌓음 (수정 기록에 지움·추가로 남음)
    if (method === "PATCH") { const v = cuttingIn(await readJson(req)); inTx(() => writeCutting(x.id, v, user)); return ok(200, cuttingOut()); }
    if (method === "DELETE") { inTx(() => { delRefMoves("cutting", x.id, user); db.prepare("DELETE FROM cutting_jobs WHERE id = ?").run(x.id); }); return ok(200, cuttingOut()); }
    return ok(405, { error: "Method not allowed" });
  }
  if (path === "/api/ops/handouts" && method === "POST") {
    if (!r.can("cutting", "e")) return deny("타래 배분을 적을 수 없는 계정이에요.");
    const v = handoutIn(await readJson(req));
    const id = inTx(() => writeHandout(null, v, user));
    return ok(201, { id, ...cuttingOut() });
  }
  const hm = path.match(/^\/api\/ops\/handouts\/(\d+)$/);
  if (hm) {
    const x = db.prepare("SELECT * FROM thread_handouts WHERE id = ?").get(Number(hm[1]));
    if (!x) throw notFound("타래 배분");
    if (!r.can("cutting", "e") || (!r.admin && x.created_by !== user.id)) return deny("적은 사람과 관리자만 고치거나 지울 수 있어요.");
    const ship = x.shipment_id ? db.prepare("SELECT * FROM shipments WHERE id = ?").get(x.shipment_id) : null;
    if (method === "PATCH") {
      const v = handoutIn(await readJson(req));
      if (ship && ship.status !== "ready") throw bad("이미 발송한 택배가 이어져 있어 고칠 수 없어요. 택배 기록에서 처리해 주세요.");
      inTx(() => writeHandout(x.id, v, user));
      return ok(200, cuttingOut());
    }
    if (method === "DELETE") {
      inTx(() => {
        delRefMoves("handout", x.id, user);
        if (ship && ship.status === "ready") db.prepare("DELETE FROM shipments WHERE id = ?").run(ship.id);
        db.prepare("DELETE FROM thread_handouts WHERE id = ?").run(x.id);
      });
      return ok(200, cuttingOut());
    }
    return ok(405, { error: "Method not allowed" });
  }
  // ---- 위치 이동·실사 조정 고치기·지우기 (이동은 출고·입고 두 줄을 함께)
  const smm = path.match(/^\/api\/ops\/stock\/moves\/(\d+)$/);
  if (smm) {
    if (!r.can("stock", "e")) return deny("재고는 직원·부서 봉사자와 관리자가 고쳐요.");
    const m = db.prepare("SELECT * FROM stock_moves WHERE id = ?").get(Number(smm[1]));
    if (!m || !["move", "adjust"].includes(m.ref_type)) throw notFound("위치 이동·실사 조정 기록");
    const rows = m.ref_type === "move" ? db.prepare("SELECT * FROM stock_moves WHERE ref_type = 'move' AND (id = ? OR ref_id = ?)").all(m.ref_id || m.id, m.ref_id || m.id) : [m];
    const out = rows.find((x) => x.type === "out") || rows[0], inn = rows.find((x) => x.type === "in");
    const opt = db.prepare("SELECT option_id, qty FROM stock_qty WHERE move_id = ?").get(m.id);
    const l = q.ledger.get(m.ledger_id), o = db.prepare("SELECT * FROM stock_options WHERE id = ?").get(opt?.option_id);
    const drop = () => { for (const x of rows) { logStock(x.ledger_id, "delete", `${x.type === "in" ? "입고" : "출고"} 지움 (${x.date}, ${m.ref_type === "move" ? "위치 이동" : "실사 조정"})`, user); q.delStockMove.run(x.id); } };
    if (method === "DELETE") { inTx(drop); return ok(200, { ...stockOut(), canEdit: true, canLocations: r.admin }); }
    if (method === "PATCH") {
      if (!l || !o) throw bad("품목을 찾을 수 없어요.");
      const b = await readJson(req), date = b.date && isDate(b.date) ? b.date : m.date, note = has(b, "note") ? text(b.note, 300, "메모") || "" : "";
      inTx(() => {
        drop();
        if (m.ref_type === "move") {
          const qty = teamQty(b.qty, "옮길 수량"), from = has(b, "fromLocationId") ? optLoc(b.fromLocationId) : out.location_id, to = has(b, "toLocationId") ? optLoc(b.toLocationId) : inn?.location_id;
          if (!qty) throw bad("옮길 수량을 적어 주세요.");
          if (!to || from === to) throw bad("옮길 위치를 골라 주세요.");
          const o1 = refMove(l, o, "out", qty, date, `위치 이동${note ? ` · ${note}` : ""}`, user, { location: from, to, refType: "move" });
          refMove(l, o, "in", qty, date, `위치 이동${note ? ` · ${note}` : ""}`, user, { location: to, refType: "move", refId: o1 });
          db.prepare("UPDATE stock_moves SET ref_id = ? WHERE id = ?").run(o1, o1);
        } else {
          const diff = Number(b.diff);
          if (!Number.isInteger(diff) || !diff || Math.abs(diff) > 100000000) throw bad("조정 수량을 + 또는 − 숫자로 적어 주세요.");
          refMove(l, o, diff > 0 ? "in" : "out", Math.abs(diff), date, `실사 조정 (고침)${note ? ` · ${note}` : ""}`, user, { location: has(b, "locationId") ? optLoc(b.locationId) : m.location_id, refType: "adjust" });
        }
      });
      return ok(200, { ...stockOut(), canEdit: true, canLocations: r.admin });
    }
    return ok(405, { error: "Method not allowed" });
  }
  // ---- F12 업체 구매: 요청 → 승인(관리자) → 주문 → 입고(입출고 한 건과 연결) · 취소
  if (path === "/api/ops/purchases" && method === "GET") {
    if (!r.can("purchases", "v")) return deny("볼 수 없는 메뉴예요.");
    return ok(200, { purchases: purchasesOut(), canEdit: r.can("purchases", "e"), canApprove: r.admin, vendors: db.prepare("SELECT e.id, e.name, e.org, c.name AS cat FROM external_contacts e LEFT JOIN contact_categories c ON c.id = e.category_id ORDER BY e.name").all(),
      ledgers: stockOut().ledgers.map((l) => ({ id: l.id, name: l.name, unit: l.unit, options: l.options.map((o) => ({ id: o.id, name: o.name })) })), locations: stockOut().locations.filter((x) => x.active) });
  }
  if (path === "/api/ops/purchases" && method === "POST") {
    if (!r.can("purchases", "e")) return deny("구매 요청을 적을 수 없는 계정이에요.");
    const b = await readJson(req);
    const v = purchaseIn(b);
    db.prepare("INSERT INTO purchases (status, external_contact_id, item_name, ledger_id, qty, unit, amount, reason, requested_by, expected_date, note) VALUES ('request', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(v.vendor, v.item, v.ledger, v.qty, v.unit, v.amount, v.reason, user.id, v.expected, v.note);
    return ok(201, { purchases: purchasesOut() });
  }
  const pm2 = path.match(/^\/api\/ops\/purchases\/(\d+)$/);
  if (pm2) {
    const x = db.prepare("SELECT * FROM purchases WHERE id = ?").get(Number(pm2[1]));
    if (!x) throw notFound("구매");
    if (!r.can("purchases", "e")) return deny("구매를 고칠 수 없는 계정이에요.");
    if (method === "PATCH") {
      const b = await readJson(req);
      const next = has(b, "status") ? pick(b.status, PURCHASE_STATUS, "구매 상태") : x.status;
      const flow = { request: ["approved", "canceled"], approved: ["ordered", "canceled"], ordered: ["received", "canceled"], received: [], canceled: [] };
      if (next !== x.status && !flow[x.status].includes(next)) throw bad("그 상태로 바꿀 수 없어요. 요청 → 승인 → 주문 → 입고 순서예요.");
      if (next === "approved" && x.status !== "approved" && !r.admin) return deny("구매 승인은 관리자가 해요.");
      if (x.status === "received") throw bad("입고를 마친 구매는 고칠 수 없어요.");
      const v = purchaseIn({ ...purchaseRaw(x), ...b });
      inTx(() => {
        db.prepare("UPDATE purchases SET status = ?, external_contact_id = ?, item_name = ?, ledger_id = ?, qty = ?, unit = ?, amount = ?, reason = ?, order_date = ?, expected_date = ?, note = ?, updated_at = datetime('now') WHERE id = ?")
          .run(next, v.vendor, v.item, v.ledger, v.qty, v.unit, v.amount, v.reason, next === "ordered" && !x.order_date ? (b.orderDate && isDate(b.orderDate) ? b.orderDate : today()) : x.order_date, v.expected, v.note, x.id);
        if (next === "received") {
          if (!v.ledger) throw bad("입고할 입출고 대장을 골라 주세요.");
          if (!v.qty) throw bad("입고 수량을 적어 주세요.");
          const { l, o } = ledgerOption(v.ledger, b.optionId ?? db.prepare("SELECT id FROM stock_options WHERE ledger_id = ? AND name = ?").get(v.ledger, v.item)?.id);
          const mid = refMove(l, o, "in", v.qty, b.receivedDate && isDate(b.receivedDate) ? b.receivedDate : today(), `구매 입고 · ${v.item}`, user, { location: optLoc(b.locationId), refType: "purchase", refId: x.id });
          db.prepare("UPDATE purchases SET move_id = ? WHERE id = ?").run(mid, x.id);
        }
      });
      return ok(200, { purchases: purchasesOut() });
    }
    if (method === "DELETE") {
      if (x.status !== "request" && !r.admin) return deny("요청 상태일 때만 지울 수 있어요. 그 뒤로는 '취소'로 바꿔 주세요.");
      if (x.move_id) throw bad("입고된 구매는 지울 수 없어요.");
      if (!r.admin && x.requested_by !== user.id) return deny("요청한 사람과 관리자만 지울 수 있어요.");
      db.prepare("DELETE FROM purchases WHERE id = ?").run(x.id);
      return ok(200, { purchases: purchasesOut() });
    }
    return ok(405, { error: "Method not allowed" });
  }
  return false;
}

// 실자르기 입력: 사용한 실(대장·품목·수량) · 만든 타래(대장·품목·수)
function cuttingIn(b) {
  if (!isDate(b.date)) throw bad("작업일을 확인해 주세요.");
  const raw = b.ledgerId ? ledgerOption(b.ledgerId, b.optionId) : null, sk = b.skeinLedgerId ? ledgerOption(b.skeinLedgerId, b.skeinOptionId) : null;
  const skeinQty = teamQty(b.skeinQty, "만든 타래") || 0;
  if (!skeinQty) throw bad("만든 타래 수를 적어 주세요.");
  return { date: b.date, raw, sk, rawQty: teamQty(b.rawQty, "사용한 실"), skeinQty, loc: optLoc(b.locationId), workers: text(b.workers, 200, "함께한 봉사자") || "", note: text(b.note, 300, "메모") || "" };
}
function writeCutting(id, v, user) {
  if (id) {
    delRefMoves("cutting", id, user);
    db.prepare("UPDATE cutting_jobs SET date = ?, ledger_id = ?, option_id = ?, raw_qty = ?, skein_qty = ?, workers = ?, location_id = ?, note = ?, updated_at = datetime('now') WHERE id = ?")
      .run(v.date, v.raw?.l.id ?? null, v.raw?.o.id ?? null, v.rawQty, v.skeinQty, v.workers, v.loc, v.note, id);
  } else {
    id = Number(db.prepare("INSERT INTO cutting_jobs (date, ledger_id, option_id, raw_qty, skein_qty, workers, location_id, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(v.date, v.raw?.l.id ?? null, v.raw?.o.id ?? null, v.rawQty, v.skeinQty, v.workers, v.loc, v.note, user.id).lastInsertRowid);
  }
  if (v.raw && v.rawQty) refMove(v.raw.l, v.raw.o, "out", v.rawQty, v.date, `실자르기 사용 (타래 ${v.skeinQty})`, user, { refType: "cutting", refId: id });
  if (v.sk) refMove(v.sk.l, v.sk.o, "in", v.skeinQty, v.date, `실자르기 ${v.skeinQty}타래`, user, { location: v.loc, refType: "cutting", refId: id });
  return id;
}
function handoutIn(b) {
  if (!isDate(b.date)) throw bad("전달일을 확인해 주세요.");
  const type = pick(b.receiverType, ["volunteer", "monastery"], "받는 쪽");
  const mid = type === "monastery" ? optId(b.monasteryId) : null, uid = type === "volunteer" ? optId(b.userId) : null, rname = text(b.receiverName, 80, "받는 사람") || "";
  if (type === "monastery" && !(mid && db.prepare("SELECT 1 FROM monasteries WHERE id = ?").get(mid))) throw bad("수도회를 골라 주세요.");
  if (type === "volunteer" && !uid && !rname) throw bad("받는 사람을 골라 주거나 이름을 적어 주세요.");
  const qty = teamQty(b.skeinQty, "타래 수") || 0;
  const supplies = {};
  for (const [k, v] of Object.entries(b.supplies && typeof b.supplies === "object" ? b.supplies : {})) { const n = teamQty(v, "자재 수량"); if (n) supplies[text(k, 40, "자재 이름", true)] = n; }
  if (!qty && !Object.keys(supplies).length) throw bad("타래 수나 자재를 적어 주세요.");
  const cj = optId(b.cuttingJobId);
  return { date: b.date, type, mid, uid, rname, qty, supplies, sk: b.skeinLedgerId ? ledgerOption(b.skeinLedgerId, b.skeinOptionId) : null, loc: optLoc(b.locationId),
    cj: cj && db.prepare("SELECT 1 FROM cutting_jobs WHERE id = ?").get(cj) ? cj : null, parcel: !!b.parcel, address: text(b.address, 200, "주소") || "", note: text(b.note, 300, "메모") || "" };
}
// 배분 저장: 타래·자재 출고를 (다시) 쌓고, 택배면 발송 '준비' 건을 만들거나 맞춤, 택배를 끄면 준비 건을 지움
function writeHandout(id, v, user) {
  const old = id ? db.prepare("SELECT * FROM thread_handouts WHERE id = ?").get(id) : null;
  if (old) {
    delRefMoves("handout", id, user);
    db.prepare("UPDATE thread_handouts SET date = ?, cutting_job_id = ?, receiver_type = ?, user_id = ?, monastery_id = ?, receiver_name = ?, skein_qty = ?, supplies = ?, note = ? WHERE id = ?")
      .run(v.date, v.cj, v.type, v.uid, v.mid, v.rname, v.qty, JSON.stringify(v.supplies), v.note, id);
  } else {
    id = Number(db.prepare("INSERT INTO thread_handouts (date, cutting_job_id, receiver_type, user_id, monastery_id, receiver_name, skein_qty, supplies, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(v.date, v.cj, v.type, v.uid, v.mid, v.rname, v.qty, JSON.stringify(v.supplies), v.note, user.id).lastInsertRowid);
  }
  const who = v.type === "monastery" ? db.prepare("SELECT name FROM monasteries WHERE id = ?").get(v.mid).name : v.uid ? nameOfUser(v.uid) : v.rname;
  if (v.sk && v.qty) refMove(v.sk.l, v.sk.o, "out", v.qty, v.date, `타래 배분 → ${who}`, user, { location: v.loc, refType: "handout", refId: id });
  for (const [name, n] of Object.entries(v.supplies)) {
    const o = db.prepare("SELECT * FROM stock_options WHERE name = ? ORDER BY id LIMIT 1").get(name);
    if (o) refMove(q.ledger.get(o.ledger_id), o, "out", n, v.date, `타래 배분 자재 → ${who}`, user, { refType: "handout", refId: id });
  }
  const sid = old?.shipment_id || null;
  if (v.parcel) {
    const contents = [v.qty ? `자른 실 ${v.qty}타래` : "", ...Object.entries(v.supplies).map(([k, n]) => `${k} ${n}`)].filter(Boolean).join(", ").slice(0, 200);
    const addr = v.address || (v.mid ? db.prepare("SELECT address FROM monasteries WHERE id = ?").get(v.mid).address : "");
    const party = [v.type === "monastery" ? "monastery" : v.uid ? "volunteer" : "etc", v.mid, v.uid, v.type === "monastery" ? "" : v.rname || who, addr, contents, v.qty || null];
    if (sid) db.prepare("UPDATE shipments SET party_type = ?, monastery_id = ?, user_id = ?, party_name = ?, address = ?, contents = ?, qty = ?, updated_at = datetime('now') WHERE id = ?").run(...party, sid);
    else db.prepare("UPDATE thread_handouts SET shipment_id = ? WHERE id = ?").run(Number(db.prepare("INSERT INTO shipments (direction, party_type, monastery_id, user_id, party_name, address, contents, qty, status, note, created_by) VALUES ('out', ?, ?, ?, ?, ?, ?, ?, 'ready', '타래 배분', ?)").run(...party, user.id).lastInsertRowid), id);
  } else if (sid) {
    db.prepare("UPDATE thread_handouts SET shipment_id = NULL WHERE id = ?").run(id);
    db.prepare("DELETE FROM shipments WHERE id = ? AND status = 'ready'").run(sid);
  }
  return id;
}
// 데드라인 일정
const DEADLINE_AUD = ["all", "dept", "team"];
function deadlineIn(b) {
  if (!isDate(b.date)) throw bad("날짜를 확인해 주세요.");
  return { date: b.date, title: text(b.title, 120, "할 일", true), note: text(b.note, 1000, "메모") || "", audience: pick(b.audience, DEADLINE_AUD, "보는 사람", "all"), done: b.done ? 1 : 0 };
}
const deadlinesOut = (r) => db.prepare("SELECT * FROM deadlines ORDER BY done, date, id").all()
  .filter((x) => r.admin || r.role === "staff" || x.audience === "all" || x.audience === r.role)
  .map((x) => ({ id: x.id, date: x.date, title: x.title, note: x.note, audience: x.audience, done: !!x.done, updatedAt: x.updated_at }));
// 묵주 WBS 저장 값 검사: 마일스톤(이름·주 업무·연결·공정 번호들)과 공정(이름·확정·공동 작업·특징·연결·추가 과업)
function wbsIn(b) {
  const ms = Array.isArray(b.milestones) ? b.milestones : null, ps = b.procs && typeof b.procs === "object" ? b.procs : null;
  if (!ms || !ps || !ms.length || ms.length > 20) throw bad("마일스톤을 1개 이상 적어 주세요.");
  const procs = {};
  for (const [k, p] of Object.entries(ps)) {
    const id = Number(k);
    if (!Number.isInteger(id) || id < 1 || id > 200) throw bad("공정 번호를 확인해 주세요.");
    procs[id] = { name: text(p.name, 80, "공정 이름", true), ...(p.fixed ? { fixed: true } : {}), ...(p.joint ? { joint: text(p.joint, 200, "공동 작업") } : {}), feat: text(p.feat, 300, "특징") || "", link: text(p.link, 200, "연결 업무") || "",
      ...(Array.isArray(p.tasks) && p.tasks.length ? { tasks: p.tasks.slice(0, 20).map((t) => text(t, 120, "추가 과업", true)) } : {}) };
  }
  if (Object.keys(procs).length > 80) throw bad("공정이 너무 많아요.");
  const milestones = ms.map((m) => {
    const list = Array.isArray(m.procs) ? [...new Set(m.procs.map(Number))] : [];
    if (list.some((n) => !procs[n])) throw bad("마일스톤에 없는 공정 번호가 있어요.");
    return { name: text(m.name, 60, "마일스톤 이름", true), main: text(m.main, 200, "주 업무") || "", link: text(m.link, 200, "연결 업무") || "", procs: list };
  });
  return { milestones, procs };
}
// ---- 2차 도우미: 재고(위치별)·원천이 붙은 입출고·실자르기·구매
const LOC_KINDS = ["raw", "finished", "inspect", "all"];
const PURCHASE_STATUS = ["request", "approved", "ordered", "received", "canceled"];
const optLoc = (v) => { const id = optId(v); if (id && !db.prepare("SELECT 1 FROM storage_locations WHERE id = ?").get(id)) throw bad("보관 위치를 확인해 주세요."); return id; };
function ledgerOption(ledgerId, optionId) {
  const l = q.ledger.get(Number(ledgerId));
  if (!l) throw bad("입출고 대장을 골라 주세요.");
  const o = db.prepare("SELECT * FROM stock_options WHERE id = ? AND ledger_id = ?").get(Number(optionId), l.id);
  if (!o) throw bad("품목(색상·종류)을 골라 주세요.");
  return { l, o };
}
// 품목 한 열의 재고 (위치를 주면 그 위치만: 위치가 붙은 입고 − 출고)
const optionQty = (optionId, locationId) => db.prepare(`SELECT coalesce(sum(CASE m.type WHEN 'in' THEN q.qty ELSE -q.qty END), 0) AS n FROM stock_qty q JOIN stock_moves m ON m.id = q.move_id WHERE q.option_id = ?${locationId ? " AND m.location_id = ?" : ""}`).get(...(locationId ? [optionId, locationId] : [optionId])).n;
// 원천(ref)이 붙은 입출고 한 줄: 기존 입출고 기록·수정 기록 방식 그대로 쌓음
function refMove(l, o, type, qty, date, note, user, { location = null, to = null, refType = "", refId = null } = {}) {
  const id = addStockMoveFrom(l, { type, date, note, qty: { [o.id]: qty } }, user);
  db.prepare("UPDATE stock_moves SET location_id = ?, to_location_id = ?, ref_type = ?, ref_id = ? WHERE id = ?").run(location, to, refType, refId, id);
  return id;
}
function delRefMoves(refType, refId, user) {
  for (const m of db.prepare("SELECT * FROM stock_moves WHERE ref_type = ? AND ref_id = ?").all(refType, refId)) {
    logStock(m.ledger_id, "delete", `${m.type === "in" ? "입고" : "출고"} 지움 (${m.date}, ${{ cutting: "실자르기", handout: "타래 배분" }[refType] || refType} 기록을 고치거나 지워서)`, user);
    q.delStockMove.run(m.id);
  }
}
function stockOut() {
  const locations = db.prepare("SELECT * FROM storage_locations ORDER BY active DESC, sort, name").all().map((x) => ({ id: x.id, name: x.name, place: x.place, kind: x.kind, sort: x.sort, active: !!x.active, note: x.note }));
  const byLoc = db.prepare(`SELECT q.option_id AS oid, m.location_id AS lid, sum(CASE m.type WHEN 'in' THEN q.qty ELSE -q.qty END) AS n FROM stock_qty q JOIN stock_moves m ON m.id = q.move_id GROUP BY q.option_id, m.location_id`).all();
  const ledgers = db.prepare("SELECT l.*, i.name AS item FROM stock_ledgers l JOIN project_items i ON i.id = l.item_id ORDER BY l.id").all().map((l) => ({
    id: l.id, name: l.name, unit: l.unit, item: l.item,
    options: db.prepare("SELECT * FROM stock_options WHERE ledger_id = ? ORDER BY id").all(l.id).map((o) => {
      const rows = byLoc.filter((x) => x.oid === o.id);
      return { id: o.id, name: o.name, safety: o.safety_qty ?? null, qty: rows.reduce((n, x) => n + x.n, 0), byLoc: rows.filter((x) => x.n).map((x) => ({ locationId: x.lid, qty: x.n })) };
    })
  }));
  const moves = db.prepare(`SELECT m.*, l.name AS ledger, l.unit, a.name AS loc, b.name AS to_loc, (SELECT group_concat(o.name || ' ' || q.qty, ', ') FROM stock_qty q JOIN stock_options o ON o.id = q.option_id WHERE q.move_id = m.id) AS items,
      (SELECT q.option_id FROM stock_qty q WHERE q.move_id = m.id LIMIT 1) AS option_id, (SELECT q.qty FROM stock_qty q WHERE q.move_id = m.id LIMIT 1) AS qty1
    FROM stock_moves m JOIN stock_ledgers l ON l.id = m.ledger_id LEFT JOIN storage_locations a ON a.id = m.location_id LEFT JOIN storage_locations b ON b.id = m.to_location_id ORDER BY m.id DESC LIMIT 30`).all()
    .map((m) => ({ id: m.id, date: m.date, type: m.type, ledger: m.ledger, ledgerId: m.ledger_id, optionId: m.option_id, qty: m.qty1, unit: m.unit, items: m.items || "", note: m.note, location: m.loc || "", locationId: m.location_id, toLocation: m.to_loc || "", toLocationId: m.to_location_id, refType: m.ref_type || "", refId: m.ref_id }));
  return { locations, ledgers, moves };
}
// 원천(ref)이 붙은 입출고에서 품목 한 줄 찾기 (고치기 창에 지금 값을 채우려고)
const refQtyOf = (refType, refId, type, noteRe) => db.prepare("SELECT m.ledger_id, m.location_id, m.note, q.option_id, q.qty FROM stock_moves m JOIN stock_qty q ON q.move_id = m.id WHERE m.ref_type = ? AND m.ref_id = ? AND m.type = ? ORDER BY m.id").all(refType, refId, type).find((x) => !noteRe || noteRe.test(x.note));
function cuttingOut() {
  const jobs = db.prepare(`SELECT c.*, o.name AS thread, l.name AS ledger, s.name AS loc, u.name AS author FROM cutting_jobs c LEFT JOIN stock_options o ON o.id = c.option_id LEFT JOIN stock_ledgers l ON l.id = c.ledger_id
    LEFT JOIN storage_locations s ON s.id = c.location_id LEFT JOIN users u ON u.id = c.created_by ORDER BY c.date DESC, c.id DESC`).all()
    .map((c) => { const sk = refQtyOf("cutting", c.id, "in");
      return { id: c.id, date: c.date, thread: c.thread || "", ledger: c.ledger || "", ledgerId: c.ledger_id, optionId: c.option_id, skeinLedgerId: sk?.ledger_id ?? null, skeinOptionId: sk?.option_id ?? null,
        rawQty: c.raw_qty, skeinQty: c.skein_qty, workers: c.workers, locationId: c.location_id, location: c.loc || "", note: c.note, author: c.author || "", createdBy: c.created_by }; });
  const handouts = db.prepare(`SELECT h.*, m.name AS monastery, u.name AS person, x.status AS ship_status, x.tracking_no, x.address AS ship_address FROM thread_handouts h LEFT JOIN monasteries m ON m.id = h.monastery_id
    LEFT JOIN users u ON u.id = h.user_id LEFT JOIN shipments x ON x.id = h.shipment_id ORDER BY h.date DESC, h.id DESC`).all()
    .map((h) => ({ id: h.id, date: h.date, receiverType: h.receiver_type, receiver: h.monastery || h.person || h.receiver_name, userId: h.user_id, monasteryId: h.monastery_id, receiverName: h.receiver_name,
      ...(() => { const sk = refQtyOf("handout", h.id, "out", /^타래 배분 →/); return { skeinLedgerId: sk?.ledger_id ?? null, skeinOptionId: sk?.option_id ?? null, locationId: sk?.location_id ?? null }; })(), address: h.ship_address || "", skeinQty: h.skein_qty, supplies: JSON.parse(h.supplies || "{}"), shipmentId: h.shipment_id, shipStatus: h.ship_status || "", trackingNo: h.tracking_no || "", note: h.note, createdBy: h.created_by, cuttingJobId: h.cutting_job_id }));
  const month = today().slice(0, 7);
  return { jobs, handouts, monthSkeins: jobs.filter((j) => j.date.startsWith(month)).reduce((n, j) => n + j.skeinQty, 0) };
}
const purchaseRaw = (x) => ({ vendorId: x.external_contact_id, itemName: x.item_name, ledgerId: x.ledger_id, qty: x.qty, unit: x.unit, amount: x.amount, reason: x.reason, expectedDate: x.expected_date || "", note: x.note });
function purchaseIn(b) {
  const vendor = optId(b.vendorId);
  if (vendor && !db.prepare("SELECT 1 FROM external_contacts WHERE id = ?").get(vendor)) throw bad("업체를 확인해 주세요.");
  const ledger = optId(b.ledgerId);
  if (ledger && !q.ledger.get(ledger)) throw bad("입출고 대장을 확인해 주세요.");
  if (b.expectedDate && !isDate(b.expectedDate)) throw bad("입고 예정일을 확인해 주세요.");
  return { vendor, item: text(b.itemName, 80, "품목", true), ledger, qty: teamQty(b.qty, "수량"), unit: text(b.unit, 20, "단위") || "", amount: teamQty(b.amount, "금액"), reason: text(b.reason, 300, "요청 이유") || "", expected: b.expectedDate || null, note: text(b.note, 500, "메모") || "" };
}
const purchasesOut = () => db.prepare(`SELECT p.*, e.name AS vendor, l.name AS ledger, u.name AS requester FROM purchases p LEFT JOIN external_contacts e ON e.id = p.external_contact_id LEFT JOIN stock_ledgers l ON l.id = p.ledger_id
  LEFT JOIN users u ON u.id = p.requested_by ORDER BY CASE p.status WHEN 'request' THEN 0 WHEN 'approved' THEN 1 WHEN 'ordered' THEN 2 ELSE 3 END, p.id DESC`).all()
  .map((p) => ({ id: p.id, status: p.status, vendorId: p.external_contact_id, vendor: p.vendor || "", itemName: p.item_name, ledgerId: p.ledger_id, ledger: p.ledger || "", qty: p.qty, unit: p.unit, amount: p.amount, reason: p.reason,
    requester: p.requester || "", requestedBy: p.requested_by, orderDate: p.order_date || "", expectedDate: p.expected_date || "", moveId: p.move_id, note: p.note, updatedAt: p.updated_at }));
// 검수 저장 뒤: 조 배정의 진행(검수 중·완료)과 수도회 상태(회수완료 → 검수완료)를 맞춤
function syncAfterInspection(scheduleId, groupId) {
  if (scheduleId && groupId) {
    for (const a of db.prepare("SELECT * FROM inspection_group_assigns WHERE group_id = ? AND schedule_id = ?").all(groupId, scheduleId)) {
      const done = db.prepare("SELECT coalesce(sum(checked_qty), 0) AS n FROM inspections WHERE group_id = ? AND schedule_id = ?").get(groupId, scheduleId).n;
      const st = a.qty && done >= a.qty ? "done" : done > 0 ? "doing" : a.status;
      if (st !== a.status) db.prepare("UPDATE inspection_group_assigns SET status = ?, updated_at = datetime('now') WHERE id = ?").run(st, a.id);
    }
  }
  const mid = scheduleId ? db.prepare("SELECT monastery_id FROM vol_schedules WHERE id = ?").get(scheduleId)?.monastery_id : null;
  if (mid) {
    const rec = db.prepare("SELECT coalesce(sum(r.qty), 0) AS n FROM team_recovery r JOIN vol_schedules s ON s.id = r.schedule_id WHERE s.monastery_id = ?").get(mid).n;
    const chk = db.prepare("SELECT coalesce(sum(i.checked_qty), 0) AS n FROM inspections i JOIN vol_schedules s ON s.id = i.schedule_id WHERE s.monastery_id = ?").get(mid).n;
    if (rec > 0 && chk >= rec) db.prepare("UPDATE monasteries SET status = 'checked', updated_at = datetime('now') WHERE id = ? AND status = 'recovered'").run(mid);
  }
}

// 기한이 된 연락 후속 조치: 하루 한 번(한국 시각 9시 뒤) 적은 사람에게 알림
function followupReminders() {
  const kst = new Date(Date.now() + 9 * 3600e3);
  if (kst.getUTCHours() < 9) return;
  const t = today();
  if (q.setting.get("followup_push_date")?.value === t) return;
  q.setSetting.run("followup_push_date", t);
  const rows = db.prepare("SELECT created_by AS uid, count(*) AS n FROM contact_logs WHERE done = 0 AND follow_up <> '' AND due_date IS NOT NULL AND due_date <= ? AND created_by IS NOT NULL GROUP BY created_by").all(t);
  for (const x of rows) notify([x.uid], "연락 후속 조치", `오늘까지 할 후속 조치 ${x.n}건이 있어요.`, (s) => (s.volunteer ? (s.vol_kind === "team" ? "/#/tedu4" : "/#/vcontacts") : "/"), "followup");
}

const NOTICE_AUDIENCES = ["all", "staff", "lead", "admin"];
const noticeAudiences = (u) => (u.volunteer ? ["all"] : u.role === "admin" ? NOTICE_AUDIENCES : u.director ? ["all", "staff", "lead"] : ["all", "staff"]);
const noticeVisible = (u, n) => noticeAudiences(u).includes(n.audience);
// ---- 알림 보내기: 받는 사람(계정 id)마다 그 사람 화면에 맞는 주소로. 기다리지 않고 뒤에서 보냄
// url(u) 은 받는 사람 계정으로 주소를 고름 (직원 화면 #/notices · 봉사자 화면 #/vnotices 등)
// 알림 종류: 사람마다 끈 종류(users.push_off)는 보내지 않음. kind 가 없으면(시험 알림) 늘 보냄
const PUSH_KINDS = ["notice", "board", "comment", "edu", "need", "issue_new", "issue_reply", "followup"];
const pushOffOf = (u) => { try { const v = JSON.parse(u.push_off || "[]"); return Array.isArray(v) ? v.filter((k) => PUSH_KINDS.includes(k)) : []; } catch { return []; } };
// 계정마다 받을 수 있는 알림 종류 (화면에 보여 줄 것)
const pushKindsFor = (u) => {
  if (u.role === "admin" && !u.volunteer) return ["notice", "board", "comment", "issue_new", "followup"];
  if (!u.volunteer) return ["notice"];
  const team = volKindsOf(u).includes("team");
  return ["notice", "board", "comment", ...(team ? ["edu", "need", "issue_reply"] : []), "followup"];
};
function notify(userIds, title, body, url, kind) {
  let ids = [...new Set(userIds)].filter(Boolean);
  if (kind && ids.length) {
    const off = new Set(db.prepare(`SELECT id, push_off FROM users WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids).filter((u) => pushOffOf(u).includes(kind)).map((u) => u.id));
    ids = ids.filter((id) => !off.has(id));
  }
  if (!ids.length) return;
  const subs = db.prepare(`SELECT s.*, u.volunteer, u.vol_kind FROM push_subs s JOIN users u ON u.id = s.user_id WHERE s.user_id IN (${ids.map(() => "?").join(",")})`).all(...ids);
  if (!subs.length) return;
  Promise.all(subs.map((s) => sendPush(db, VAPID, s, { title, body: String(body || "").slice(0, 140), url: typeof url === "function" ? url(s) : url || "/", tag: title }, PUSH_SUBJECT)))
    .then((r) => {
      const codes = Object.entries(r.reduce((m, c) => ((m[c] = (m[c] || 0) + 1), m), {})).map(([c, n]) => `${c === "0" ? "연결 실패" : c}×${n}`).join(", ");
      console.log(`[push] ${title}: ${r.filter((c) => c >= 200 && c < 300).length}/${r.length} 성공 (${codes})`);
    })
    .catch(() => {});
}
const allUsers = () => db.prepare("SELECT * FROM users").all();
const teamVolunteerIds = () => allUsers().filter((u) => u.volunteer && (u.vol_kind === "team" || u.vol_kind === "both")).map((u) => u.id);
const adminIds = () => allUsers().filter((u) => u.role === "admin").map((u) => u.id);
const unreadOf = (u) => q.unreadNotices.get(JSON.stringify(noticeAudiences(u)), u.id).n;
// 수정 기록: 사람이 읽는 한 줄로 남김
const logStock = (ledgerId, action, summary, user) => q.addStockHistory.run(ledgerId, action, String(summary).slice(0, 500), user.id, user.name);
const moveKind = (m) => (m.type === "in" ? "입고" : "출고");
const moveQty = (moveId) => new Map(q.stockQtyOfMove.all(moveId).map((x) => [x.option_id, x.qty]));
const optionNames = (ledgerId) => new Map(q.stockOptions.all(ledgerId).map((o) => [o.id, o.name]));
const qtyText = (qty, names) => [...qty].filter(([, n]) => n).map(([o, n]) => `${names.get(o) || "품목"} ${n}`).join(", ") || "수량 없음";
const changeText = (label, a, b) => (String(a ?? "") === String(b ?? "") ? null : `${label} ${a === "" || a == null ? "(없음)" : a} → ${b === "" || b == null ? "(없음)" : b}`);
function addStockMoveFrom(l, b, user) {
  if (b.type !== "in" && b.type !== "out") throw bad("입고·출고를 골라 주세요.");
  const date = text(b.date, 20, "날짜", true), handler = text(b.handler, 40, "전달자"), note = text(b.note, 500, "비고"), issue = text(b.issue, 500, "이슈");
  const rows = stockQtyInput(l.id, b.qty);
  const ok = b.type === "in" ? inspectInput(b.inspectOk, "합격") : null, badN = b.type === "in" ? inspectInput(b.inspectBad, "불량") : null;
  return inTx(() => {
    const id = Number(q.addStockMove.run(l.id, b.type, date, handler, note, user.id).lastInsertRowid);
    for (const [o, n] of rows) q.addStockQty.run(id, o, n);
    if (issue) q.setMoveIssue.run(issue, id);
    if (ok != null || badN != null) q.setMoveInspect.run(ok, badN, id);
    logStock(l.id, "add", `${moveKind(b)} 추가 (${date}): ${qtyText(moveQty(id), optionNames(l.id))}${issue ? ` · 이슈: ${issue}` : ""}`, user);
    return id;
  });
}
// 입고 검수 수량: 비우면 검수 안 함
function inspectInput(v, label) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 100000000) throw bad(`검수 ${label} 수량은 0 이상의 숫자로 적어 주세요.`);
  return n;
}
// 봉사자에게 보일 메뉴 (관리자가 단계적으로 엶). 저장 안 했으면 입고·출고 중심
const VOL_MENU_KEYS = ["home", "schedule", "training", "notices", "wbs", "req", "in", "out", "recovery", "moves2", "steps2"]; // moves2: 새 입고·출고 화면 (기본은 꺼 둠, 관리자가 켬) // 원자재 보유물량(material)은 없앰
const VOL_MENU_DEFAULT = ["home", "notices", "in", "out"];
// 회의실 목록 (관리자가 등록). 일정 장소 글자에 이름이 들어 있으면 그 회의실 예약으로 봄
const meetingRooms = () => { try { const v = JSON.parse(q.setting.get("meeting_rooms")?.value || "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; } };
const volMenu = () => { try { const v = JSON.parse(q.setting.get("vol_menu")?.value || "null"); return Array.isArray(v) ? v.filter((k) => VOL_MENU_KEYS.includes(k)) : VOL_MENU_DEFAULT; } catch { return VOL_MENU_DEFAULT; } };
// 기록 사진: 줄여 올린 JPG·PNG·WEBP 만, 기록당 4장까지
const MOVE_PHOTO_MAX = 4;
function addMovePhoto(m, l, b, user) {
  const buf = Buffer.from(String(b.data || ""), "base64");
  if (!buf.length) throw bad("사진을 골라 주세요.");
  if (buf.length > ITEM_IMAGE_MAX) throw bad("사진이 너무 커요.");
  const mime = imageMime(buf);
  if (!mime) throw bad("JPG, PNG, WEBP 사진만 올릴 수 있어요.");
  if (q.photoCount.get(m.id).n >= MOVE_PHOTO_MAX) throw bad(`사진은 기록마다 ${MOVE_PHOTO_MAX}장까지 올릴 수 있어요.`);
  inTx(() => { q.addPhoto.run(m.id, mime, buf, user.id); logStock(l.id, "photo", `${moveKind(m)} 사진 추가 (${m.date})`, user); });
}
function sendPhoto(res, ph) {
  res.writeHead(200, { "Content-Type": ph.mime, "Content-Length": ph.data.length, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'" });
  return res.end(Buffer.from(ph.data));
}
function delMovePhoto(ph, m, l, user) { inTx(() => { q.delPhoto.run(ph.id); logStock(l.id, "photo", `${moveKind(m)} 사진 삭제 (${m.date})`, user); }); }
function deleteStockMoveBy(m, l, user) {
  inTx(() => {
    logStock(l.id, "delete", `${moveKind(m)} 삭제 (${m.date}): ${qtyText(moveQty(m.id), optionNames(l.id))}`, user);
    q.delStockMove.run(m.id);
  });
}
function patchStockMoveFrom(m, l, b, user) {
  const date = text(has(b, "date") ? b.date : m.date, 20, "날짜", true), handler = text(has(b, "handler") ? b.handler : m.handler, 40, "전달자"), note = text(has(b, "note") ? b.note : m.note, 500, "비고");
  const issue = text(has(b, "issue") ? b.issue : m.issue, 500, "이슈");
  const okN = m.type === "in" ? (has(b, "inspectOk") ? inspectInput(b.inspectOk, "합격") : m.inspect_ok ?? null) : null;
  const badN = m.type === "in" ? (has(b, "inspectBad") ? inspectInput(b.inspectBad, "불량") : m.inspect_bad ?? null) : null;
  const rows = has(b, "qty") ? stockQtyInput(l.id, b.qty) : null;
  inTx(() => {
    const before = moveQty(m.id), names = optionNames(l.id);
    q.setStockMove.run(date, handler, note, m.id);
    q.setMoveIssue.run(issue, m.id);
    q.setMoveInspect.run(okN, badN, m.id);
    if (rows) { q.clearStockQty.run(m.id); for (const [o, n] of rows) q.addStockQty.run(m.id, o, n); }
    const after = moveQty(m.id);
    const changes = [
      changeText("날짜", m.date, date), changeText("전달자", m.handler, handler), changeText("비고", m.note, note), changeText("이슈", m.issue || "", issue), changeText("검수 합격", m.inspect_ok ?? "", okN ?? ""), changeText("검수 불량", m.inspect_bad ?? "", badN ?? ""),
      ...[...new Set([...before.keys(), ...after.keys()])].map((o) => changeText(names.get(o) || "품목", before.get(o) || 0, after.get(o) || 0))
    ].filter(Boolean);
    if (changes.length) logStock(l.id, "edit", `${moveKind(m)} 수정 (${m.date}): ${changes.join(", ")}`, user);
  });
}
const stockListRow = (l, p, staff) => {
  const row = {
    id: l.id, name: l.name, unit: l.unit, contract: l.contract, itemId: l.item_id, itemName: l.item_name, projectId: p.id, projectName: p.name, unitId: p.unit_id,
    options: l.option_count, inTotal: l.in_total, outTotal: l.out_total, hasAfter: !!JSON.parse(l.after).label
  };
  if (staff) { // 직원 화면: 봉사자가 입력하는 대장인지, 마지막 입력
    const last = q.lastStockMove.get(l.id);
    row.volunteerEntry = !!volLedgerProject(l);
    row.last = last ? { date: last.date, type: last.type, enteredBy: last.author || "" } : null;
  }
  return row;
};
function stockQtyInput(ledgerId, raw) {
  const allowed = new Set(q.stockOptions.all(ledgerId).map((o) => o.id));
  const out = [];
  for (const [k, v] of Object.entries(raw && typeof raw === "object" ? raw : {})) {
    const n = v === "" || v === null ? 0 : Number(v);
    if (!allowed.has(Number(k))) throw bad("품목을 찾을 수 없어요.");
    if (!Number.isInteger(n) || n < 0 || n > 100000000) throw bad("수량은 0 이상의 숫자로 적어 주세요.");
    if (n) out.push([Number(k), n]);
  }
  return out;
}
function projectUnit(v, user) {
  const unit = unitIdOrNull(v);
  if (!unit) throw bad("팀을 골라 주세요.");
  if (user.role !== "admin" && !visibleUnits(user).includes(unit)) throw bad("볼 수 있는 팀만 고를 수 있어요.");
  return unit;
}
function projectItemFields(b, cur) {
  const get = (k, curVal) => (has(b, k) ? b[k] : curVal);
  const status = get("status", cur?.status ?? "none");
  if (!PROJECT_STATUS.includes(status)) throw bad("상태를 확인해 주세요.");
  const assignee = idOrNull(get("assigneeId", cur?.assignee_id));
  if (assignee && !q.userExists.get(assignee)) throw bad("담당자를 찾을 수 없어요.");
  const due = get("dueDate", cur?.due_date) || null;
  if (due && !isDate(due)) throw bad("마감일을 확인해 주세요.");
  return [text(get("name", cur?.name), 80, "이름", true), status, assignee, due, text(get("note", cur?.note), 1000, "메모")];
}

/* ---------- API ---------- */
async function api(req, res, path) {
  const method = req.method;
  const url = new URL(req.url, "http://localhost");
  const param = (k) => url.searchParams.get(k);

  if (path === "/api/health" && method === "GET") return send(res, 200, { ok: true });

  if (path === "/api/login" && method === "POST") {
    const { login, password, as, remember: rememberIn } = await readJson(req);
    const remember = rememberIn !== false; // 예전 화면(값 없음)은 자동 로그인처럼
    const id = normalizeLogin(login);
    const keys = [`id+ip:${id}|${clientIp(req)}`, "id:" + id, "real:" + realIp(req)];
    if (tooMany(...keys)) return send(res, 429, { error: "로그인 시도가 너무 많아요. 10분 뒤에 다시 시도해 주세요." });
    const user = id && q.userByLogin.get(id);
    // 없는 아이디도 같은 시간이 걸리게 (응답 속도로 아이디가 있는지 알 수 없게)
    const ok = typeof password === "string" && verifyPassword(password.trim(), user ? user.pw_hash : DUMMY_HASH) && !!user;
    if (!ok) {
      recordFail(...keys);
      return send(res, 401, { error: "아이디 또는 비밀번호를 다시 확인해 주세요." });
    }
    // 직원·봉사자 로그인 구분: 비밀번호가 맞을 때만 알려 줌 (아이디만으로 계정 종류를 알 수 없게)
    // 직원 · 부서 봉사자(물류) · 팀 봉사자(교육·검수): 고른 쪽과 계정이 다르면 맞는 쪽을 알려 줌
    // 봉사자 권한이 둘이면 부서·팀 어느 쪽으로든 들어옴
    const kinds = volKindsOf(user), allowed = !user.volunteer ? ["staff"] : kinds.map((k) => (k === "team" ? "team" : "volunteer"));
    if (["staff", "volunteer", "team"].includes(as) && !allowed.includes(as)) {
      const kindOf = allowed[0];
      return send(res, 403, { error: { staff: "직원 계정이에요.", volunteer: "부서 봉사자 계정이에요.", team: "팀 봉사자 계정이에요." }[kindOf], field: "as", as: kindOf });
    }
    const volMode = !user.volunteer ? "" : as === "team" ? "team" : as === "volunteer" ? "dept" : kinds[0];
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + (remember ? SESSION_DAYS * 86400 * 1000 : SESSION_SHORT_HOURS * 3600 * 1000);
    q.addSession.run(sha256(token), user.id, expiresAt, volMode, remember ? 1 : 0);
    q.touchLogin.run(user.id);
    return send(res, 200, { token, expiresAt, user: publicUser({ ...user, vol_kinds: kinds, vol_kind: volMode || user.vol_kind }) });
  }

  // 기기 서비스 워커의 알림 보고: 받은 알림을 띄웠는지. 등록된 구독 주소만, 접속지마다 10분에 10번까지 (로그인 없이: 서비스 워커는 토큰이 없음)
  if (path === "/api/push/report" && method === "POST") {
    const b = await readJson(req);
    const sub = typeof b.endpoint === "string" && db.prepare("SELECT id FROM push_subs WHERE endpoint = ?").get(b.endpoint);
    const key = "push-report:" + realIp(req);
    if (sub && !tooMany(key)) {
      recordFail(key);
      const stage = ["shown", "retry", "fail"].includes(b.stage) ? b.stage : "?";
      console.log(`[push] 기기 #${sub.id} ${stage} ${String(b.msg || "").replace(/[^\w .:=()-]/g, "").slice(0, 160)}`);
    }
    return send(res, 204);
  }
  const user = auth(req);
  if (!user) return send(res, 401, { error: "로그인이 필요해요." });
  // 알림 구독 (직원·봉사자 모두): 기기마다 하나, 같은 주소는 지금 계정으로 옮김
  if (path === "/api/push/key" && method === "GET") return send(res, 200, { key: VAPID.publicKey });
  if (path === "/api/push/subscribe" && method === "POST") {
    const b = await readJson(req);
    const endpoint = String(b.endpoint || ""), p256dh = String(b.keys?.p256dh || ""), authKey = String(b.keys?.auth || "");
    if (!pushEndpointOk(endpoint)) throw bad("알림 주소를 확인할 수 없어요.");
    if (!/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,40}$/.test(authKey)) throw bad("알림 키를 확인할 수 없어요.");
    db.prepare("INSERT INTO push_subs (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth").run(user.id, endpoint, p256dh, authKey);
    return send(res, 200, { ok: true });
  }
  if (path === "/api/push/unsubscribe" && method === "POST") {
    db.prepare("DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?").run(String((await readJson(req)).endpoint || ""), user.id);
    return send(res, 200, { ok: true });
  }
  // 알림 종류별 켜기·끄기 (계정마다, 모든 기기에 적용)
  if (path === "/api/push/prefs" && method === "GET") {
    const me = q.userById.get(user.id); // 봉사자 권한 둘이면 지금 쓰는 쪽과 상관없이 둘 다의 알림
    return send(res, 200, { kinds: pushKindsFor(me), off: pushOffOf(me) });
  }
  if (path === "/api/push/prefs" && method === "PUT") {
    const b = await readJson(req);
    if (!Array.isArray(b.off)) throw bad("알림 설정을 확인해 주세요.");
    const off = [...new Set(b.off.map(String))].filter((k) => PUSH_KINDS.includes(k));
    db.prepare("UPDATE users SET push_off = ? WHERE id = ?").run(JSON.stringify(off), user.id);
    return send(res, 200, { kinds: pushKindsFor(q.userById.get(user.id)), off });
  }
  if (path === "/api/push/test" && method === "POST") {
    const n = db.prepare("SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?").get(user.id).n;
    if (!n) return send(res, 400, { error: "이 계정에 켜 둔 알림이 없어요." });
    notify([user.id], "P-Schedule 알림 시험", "알림이 잘 와요.", "/");
    return send(res, 200, { ok: true, devices: n });
  }
  // 봉사자: 내 계정 정보·비밀번호·로그아웃과 봉사자 전용 API 만. 직원 데이터(조직도·연락처·일정 등)는 입구에서 막음
  if (user.volunteer) {
    // 부서·팀 봉사자 권한이 둘 다 있으면 다시 로그인 없이 쪽을 바꿈 (이 세션만)
    if (path === "/api/vol-mode" && method === "POST") {
      const b = await readJson(req);
      const mode = b.mode === "team" ? "team" : b.mode === "dept" ? "dept" : null;
      if (!mode || !user.vol_kinds.includes(mode)) return send(res, 403, { error: "이 계정에는 그 봉사자 권한이 없어요." });
      q.setSessionMode.run(mode, sha256(tokenOf(req)));
      return send(res, 200, { user: publicUser({ ...user, vol_kind: mode }) });
    }
    if (path.startsWith("/api/ops/")) { if (await opsRoute(req, res, user, path, method)) return; return send(res, 404, { error: "찾을 수 없어요." }); }
    if (user.vol_kind === "team") {
      if (path.startsWith("/api/team/")) { if (await teamRoute(req, res, user, path, method)) return; return send(res, 404, { error: "찾을 수 없어요." }); }
      if (path.startsWith("/api/volunteer/")) return send(res, 403, { error: "팀 봉사자 계정으로는 볼 수 없어요." });
    } else if (path.startsWith("/api/team/issue")) { if (await teamRoute(req, res, user, path, method)) return; return send(res, 404, { error: "찾을 수 없어요." }); } // 이슈는 부서 봉사자도 (단계형 메뉴 '소통')
    else if (path.startsWith("/api/team/")) return send(res, 403, { error: "부서 봉사자 계정으로는 볼 수 없어요." });
    if (path.startsWith("/api/volunteer/") && await volunteerRoute(req, res, user, path, method, url)) return;
    if (path === "/api/me" && method === "GET") return send(res, 200, { user: publicUser(user), team: [], units: [], tags: [], categories: [], calendars: [], unreadNotices: unreadOf(user) });
    // 공지: 봉사자에게 공개된 것만 읽기 (댓글·작성자 이름 없음)
    if (path === "/api/notices" && method === "GET") {
      return send(res, 200, { notices: q.notices.all(user.id).filter((n) => noticeVisible(user, n)).map((n) => ({ id: n.id, title: n.title, preview: n.preview, pinned: !!n.pinned, createdAt: n.created_at, unread: !!n.unread })), unreadNotices: unreadOf(user) });
    }
    if (path === "/api/notices/unread" && method === "GET") return send(res, 200, { unreadNotices: unreadOf(user) });
    const vnm = path.match(/^\/api\/notices\/(\d+)$/);
    if (vnm && method === "GET") {
      const n = q.notice.get(Number(vnm[1]));
      if (!n || !noticeVisible(user, n)) throw notFound("공지");
      q.readNotice.run(user.id, n.id);
      return send(res, 200, { notice: { id: n.id, title: n.title, body: n.body, pinned: !!n.pinned, createdAt: n.created_at }, unreadNotices: unreadOf(user) });
    }
    if ((path === "/api/board" || path.startsWith("/api/board/") || path.startsWith("/api/board-comments/")) && await boardRoute(req, res, user, path, method)) return;
    if (!((path === "/api/logout" || path === "/api/password") && method === "POST")) return send(res, 403, { error: "봉사자 계정으로는 볼 수 없어요." });
  }
  const isAdmin = user.role === "admin";
  // 팀 봉사자 화면 API: 관리자도 씀 (연락처·이슈 처리·자료실)
  if (path.startsWith("/api/team/")) {
    if (!isAdmin) return send(res, 403, { error: "관리자만 볼 수 있어요." });
    if (await teamRoute(req, res, user, path, method)) return;
    return send(res, 404, { error: "찾을 수 없어요." });
  }
  // 관리자 미리보기: 봉사자 화면 API (부서 봉사자 화면·수도회·택배·검수 조 등)
  // 직원: /api/ops 는 권한표(role_perms)로 (기본 꺼짐), 봉사자 화면 API 는 관리자만
  if (path.startsWith("/api/ops/") && !isAdmin) { if (await opsRoute(req, res, user, path, method)) return; return send(res, 404, { error: "찾을 수 없어요." }); }
  if (path.startsWith("/api/ops/") || path.startsWith("/api/volunteer/")) {
    if (!isAdmin) return send(res, 404, { error: "찾을 수 없어요." });
    if (path.startsWith("/api/ops/") ? await opsRoute(req, res, user, path, method) : await volunteerRoute(req, res, user, path, method, url)) return;
    return send(res, 404, { error: "찾을 수 없어요." });
  }
  // 게시판: 직원은 쓰지 않음 (봉사자·관리자만)
  if (path === "/api/board" || path.startsWith("/api/board/") || path.startsWith("/api/board-comments/")) {
    if (!boardCan(user)) return send(res, 403, { error: "게시판은 봉사자와 관리자만 써요." });
    if (await boardRoute(req, res, user, path, method)) return;
  }
  // 보이는 범위 조건 값 (?scope=mine 이면 관리자도 멤버처럼)
  const V = viewer(user, url.searchParams.get("scope") === "mine");

  if (path === "/api/logout" && method === "POST") {
    q.delSession.run(sha256(tokenOf(req)));
    return send(res, 204);
  }

  // 화면을 그리는 데 늘 필요한 것: 나, 팀원, 태그, 분류
  if (path === "/api/me" && method === "GET") {
    return send(res, 200, { user: publicUser(user), team: teamOut(), units: unitsOut(), tags: q.tags.all(), categories: categoriesOut(), calendars: calendarsPublic(), rooms: meetingRooms(), unreadNotices: unreadOf(user) });
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
    const start = taskStart(b, null, input[1]);
    const id = inTx(() => {
      const r = q.addTask.run(...input, user.id, input[2]);
      const id = Number(r.lastInsertRowid);
      q.setTaskStart.run(start, id);
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
      const start = taskStart(b, t, input[1]);
      inTx(() => { q.setTask.run(...input, input[2], t.id); q.setTaskStart.run(start, t.id); q.setTaskUnit.run(itemUnit(b, user, t, input[4]), t.id); saveTaskTags(t.id, b); });
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
      const input = taskInput({ title: b.title || m.body.split("\n")[0].slice(0, LIMITS.title), dueDate: b.dueDate, assigneeId: b.assigneeId, meetingId: m.meeting_id, phase: b.phase === "before" ? "before" : "after", note: m.body.includes("\n") ? m.body : "", categoryId: has(b, "categoryId") ? b.categoryId : m.category_id });
      const start = taskStart({ startDate: b.startDate }, null, input[1]);
      const id = inTx(() => {
        const id = Number(q.addTask.run(...input, user.id, input[2]).lastInsertRowid);
        q.setTaskStart.run(start, id);
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

  // '오늘' 화면 검색 모아 보기: 공통 검색어 + 내 검색어로 그날 걸린 것 (볼 수 있는 것만)
  if (path === "/api/today-search" && method === "GET") {
    const day = param("date");
    if (!isDate(day)) throw bad("날짜를 확인해 주세요.");
    const mine = todayKeywordsOf(user.id), excludes = todayExcludesOf(user.id);
    const words = [...new Set([...TODAY_COMMON_KEYWORDS, ...mine])];
    // 제외어: 같은 방식으로 찾아서 걸린 항목은 모든 묶음에서 뺌
    const drop = new Set(excludes.flatMap((x) => runSearch(x, "all", V, day).results.map(searchKey)));
    return send(res, 200, { common: TODAY_COMMON_KEYWORDS, mine, excludes, groups: words.map((k) => {
      const all = runSearch(k, "all", V, day).results;
      const results = all.filter((r) => !drop.has(searchKey(r)));
      return { keyword: k, results, excluded: all.length - results.length };
    }) });
  }
  if (path === "/api/today-keywords" && method === "PUT") {
    const b = await readJson(req);
    if (b.keywords !== undefined) {
      if (!Array.isArray(b.keywords) || b.keywords.length > 10) throw bad("검색어는 10개까지 정할 수 있어요.");
      const list = [...new Set(b.keywords.map((k) => text(k, 30, "검색어", true)))].filter((k) => !TODAY_COMMON_KEYWORDS.includes(k));
      db.prepare("UPDATE users SET today_keywords = ? WHERE id = ?").run(JSON.stringify(list), user.id);
    }
    if (b.excludes !== undefined) {
      if (!Array.isArray(b.excludes) || b.excludes.length > 10) throw bad("제외어는 10개까지 정할 수 있어요.");
      const list = [...new Set(b.excludes.map((k) => text(k, 30, "제외어", true)))];
      db.prepare("UPDATE users SET today_excludes = ? WHERE id = ?").run(JSON.stringify(list), user.id);
    }
    return send(res, 200, { common: TODAY_COMMON_KEYWORDS, mine: todayKeywordsOf(user.id), excludes: todayExcludesOf(user.id) });
  }
  if (path === "/api/search" && method === "GET") {
    const qv = String(param("q") || "").slice(0, 100);
    const kind = ["meeting", "task", "memo"].includes(param("kind")) ? param("kind") : "all";
    return send(res, 200, { q: qv, kind, limit: SEARCH_LIMIT, ...runSearch(qv, kind, V) });
  }

  /* ----- 공지 ----- */
  if (path === "/api/notices" && method === "GET") {
    return send(res, 200, {
      notices: q.notices.all(user.id).filter((n) => noticeVisible(user, n)).map((n) => ({
        id: n.id, title: n.title, preview: n.preview, pinned: !!n.pinned, author: n.author, audience: n.audience,
        comments: n.comments, createdAt: n.created_at, updatedAt: n.updated_at, unread: !!n.unread
      })),
      unreadNotices: unreadOf(user)
    });
  }
  // 사이드바 '공지' 옆 숫자 (안 읽은 공지 수)
  if (path === "/api/notices/unread" && method === "GET") return send(res, 200, { unreadNotices: unreadOf(user) });
  const noticeInput = (b, cur) => {
    const audience = has(b, "audience") ? b.audience : cur?.audience ?? "staff";
    if (!NOTICE_AUDIENCES.includes(audience)) throw bad("공개 범위를 확인해 주세요.");
    return [text(b.title, LIMITS.title, "제목", true), text(b.body, LIMITS.notice, "내용", true), b.pinned ? 1 : 0, audience];
  };
  if (path === "/api/notices" && method === "POST") {
    if (!isAdmin) return send(res, 403, { error: "공지는 관리자만 쓸 수 있어요." });
    const r = q.addNotice.run(...noticeInput(await readJson(req)), user.id);
    q.readNotice.run(user.id, Number(r.lastInsertRowid)); // 쓴 사람은 읽은 것으로
    { const n = q.notice.get(Number(r.lastInsertRowid)); if (n) notify(allUsers().filter((u) => u.id !== user.id && noticeVisible(u, n)).map((u) => u.id), "새 공지", n.title, (s) => (s.volunteer ? `/#/vnotices/${n.id}` : `/#/notices/${n.id}`), "notice"); }
    return send(res, 201, { id: Number(r.lastInsertRowid) });
  }
  const nm = path.match(/^\/api\/notices\/(\d+)(\/comments)?$/);
  if (nm) {
    const n = q.notice.get(Number(nm[1]));
    if (n && !noticeVisible(user, n)) throw notFound("공지");
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
        notice: { id: n.id, title: n.title, body: n.body, pinned: !!n.pinned, author: n.author, audience: n.audience, createdAt: n.created_at, updatedAt: n.updated_at, canEdit: isAdmin },
        comments: q.comments.all("notice", n.id).map((c) => commentOut(c, user)),
        unreadNotices: unreadOf(user)
      });
    }
    if (!isAdmin) return send(res, 403, { error: "공지는 관리자만 고칠 수 있어요." });
    if (method === "PUT") {
      q.setNotice.run(...noticeInput(await readJson(req), n), n.id);
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
  /* 프로젝트 */
  if (path === "/api/projects" && method === "GET") {
    const items = new Map();
    for (const i of q.allProjectItems.all()) { if (!items.has(i.project_id)) items.set(i.project_id, []); items.get(i.project_id).push(i); }
    return send(res, 200, { projects: q.projects.all().filter((p) => projectAllowed(user, p)).map((p) => projectOut(p, items.get(p.id) || [], user)) });
  }
  if (path === "/api/projects" && method === "POST") {
    const b = await readJson(req);
    const id = Number(q.addProject.run(projectUnit(b.unitId, user), text(b.name, 80, "프로젝트 이름", true), text(b.note, 1000, "설명"), user.id).lastInsertRowid);
    return send(res, 201, projectDetail(q.project.get(id), user));
  }
  // 직원 프로젝트 목록 위 '묵주 봉사자 대시보드': 볼 수 있는 기념품팀 프로젝트의 묵주 묶음 현황
  if (path === "/api/projects/volunteer-dashboard" && method === "GET") {
    const out = [];
    for (const p of q.projects.all()) {
      if (!projectAllowed(user, p)) continue;
      for (const g of volGroupsOf(p).filter((x) => x.name === VOLUNTEER_GROUP)) out.push({ projectId: p.id, projectName: p.name, ...volGroupStatus(p, g) });
    }
    return send(res, 200, { groups: out });
  }
  // 직원 프로젝트 '봉사자 현황': 봉사자 묶음(묵주·손십자가)마다 요청·입출고·기록 요약과 최근 변동
  const pvm = path.match(/^\/api\/projects\/(\d+)\/volunteer-status$/);
  if (pvm && method === "GET") {
    const p = q.project.get(Number(pvm[1]));
    if (!p || !projectAllowed(user, p)) throw notFound("프로젝트");
    return send(res, 200, { groups: volGroupsOf(p).map((g) => volGroupStatus(p, g)) });
  }
  const pjm = path.match(/^\/api\/projects\/(\d+)(\/items|\/import|\/processes|\/areas)?$/);
  if (pjm) {
    if (pjm[2] === "/areas" && !isAdmin) return send(res, 403, { error: "구역 정보는 관리자만 고칠 수 있어요." }); // 우선 관리자만
    if (pjm[2] === "/processes" && !isAdmin) return send(res, 403, { error: "상세 프로세스는 관리자만 볼 수 있어요." }); // 우선 관리자만
    const p = q.project.get(Number(pjm[1]));
    if (!p || !projectAllowed(user, p)) throw notFound("프로젝트");
    if (!pjm[2] && method === "GET") return send(res, 200, { ...projectDetail(p, user), volGroups: volGroupsOf(p).map((g) => ({ id: g.id, name: g.name })) });
    if (!pjm[2] && method === "PATCH") {
      const b = await readJson(req);
      q.setProject.run(has(b, "unitId") ? projectUnit(b.unitId, user) : p.unit_id, has(b, "name") ? text(b.name, 80, "프로젝트 이름", true) : p.name, has(b, "note") ? text(b.note, 1000, "설명") : p.note, p.id);
      return send(res, 200, projectDetail(q.project.get(p.id), user));
    }
    if (!pjm[2] && method === "DELETE") {
      if (!isAdmin && p.created_by !== user.id) return send(res, 403, { error: "직접 만든 프로젝트만 지울 수 있어요." });
      if (q.ledgersOfProject.all(p.id).length) return send(res, 409, { error: "이 프로젝트에 입출고 현황이 있어요. 입출고 관리에서 먼저 지워 주세요." });
      q.delProject.run(p.id);
      return send(res, 204);
    }
    if (pjm[2] === "/areas") {
      if (method !== "PUT") return send(res, 405, { error: "Method not allowed" });
      const b = await readJson(req);
      const area = text(b.area, 60, "구역", true);
      q.setAreaInfo.run(p.id, area, text(b.partner, 60, "협력업체"), text(b.note, 500, "메모"));
      return send(res, 200, projectDetail(p, user));
    }
    if (pjm[2] === "/processes") {
      if (method === "GET") return send(res, 200, processList(p.id));
      if (method === "POST") {
        q.addProcess.run(p.id, ...processFields(await readJson(req), null), p.id);
        return send(res, 201, processList(p.id));
      }
      return send(res, 405, { error: "Method not allowed" });
    }
    if (pjm[2] === "/items" && method === "POST") {
      const b = await readJson(req);
      const kind = b.kind === "group" ? "group" : "item";
      const parent = idOrNull(b.parentId);
      const up = parent && q.projectItem.get(parent);
      if (parent && (!up || up.project_id !== p.id || up.kind !== "group")) throw bad("넣을 묶음을 찾을 수 없어요.");
      const area = parent ? "" : text(b.area, 60, "구역"); // 구역은 맨 위 줄에만
      inTx(() => {
        const nid = Number(q.addProjectItem.run(p.id, parent, kind, ...projectItemFields(b, null)).lastInsertRowid);
        if (area) q.setProjectItemArea.run(area, nid);
        if (has(b, "qty") && isAdmin) q.setItemQty.run(itemQtyInput(b.qty), nid); // 관리자 전용
      });
      return send(res, 201, projectDetail(p, user));
    }
    if (pjm[2] === "/import" && method === "POST") {
      const b = await readJson(req);
      const source = String(b.text ?? "");
      if (source.length > 20000) throw bad("한 번에 20,000자까지 넣을 수 있어요.");
      const { rows } = parseOutline(source);
      if (!rows.length) throw bad("넣을 항목이 없어요.");
      const area = text(b.area, 60, "구역");
      inTx(() => {
        const before = q.maxItemId.get().n;
        importOutline(db, p.id, rows);
        if (area) q.setImportedArea.run(area, p.id, before);
      });
      return send(res, 200, projectDetail(p, user));
    }
    return send(res, 405, { error: "Method not allowed" });
  }
  const pim = path.match(/^\/api\/project-items\/(\d+)(\/ledgers|\/image)?$/);
  if (pim) {
    if (pim[2] === "/image" && !isAdmin) return send(res, 403, { error: "항목 이미지는 관리자만 볼 수 있어요." }); // 우선 관리자만
    const i = q.projectItem.get(Number(pim[1]));
    const p = i && q.project.get(i.project_id);
    if (!p || !projectAllowed(user, p)) throw notFound("항목");
    if (pim[2] === "/image") {
      if (method === "GET") {
        const g = q.itemImage.get(i.id);
        if (!g) throw notFound("이미지");
        res.writeHead(200, { "Content-Type": g.mime, "Content-Length": g.data.length, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'" });
        return res.end(Buffer.from(g.data));
      }
      if (method === "PUT") {
        const b = await readJson(req);
        const buf = Buffer.from(String(b.data || ""), "base64");
        if (!buf.length) throw bad("이미지를 골라 주세요.");
        if (buf.length > ITEM_IMAGE_MAX) throw bad("이미지가 너무 커요.");
        const mime = imageMime(buf);
        if (!mime) throw bad("JPG, PNG, WEBP 이미지만 올릴 수 있어요.");
        q.setItemImage.run(i.id, mime, buf, user.id);
        return send(res, 200, projectDetail(p, user));
      }
      if (method === "DELETE") { q.delItemImage.run(i.id); return send(res, 200, projectDetail(p, user)); }
      return send(res, 405, { error: "Method not allowed" });
    }
    if (pim[2]) {
      if (method !== "POST") return send(res, 405, { error: "Method not allowed" });
      const b = await readJson(req);
      const fields = ledgerFields(b, null);
      const id = inTx(() => {
        const id = Number(q.addLedger.run(i.id, ...fields).lastInsertRowid);
        saveStockOptions(id, (Array.isArray(b.options) ? b.options : []).map((name) => ({ name })));
        logStock(id, "ledger", `대장 만듦: ${fields[0]}`, user);
        return id;
      });
      return send(res, 201, ledgerOut(q.ledger.get(id), p, user));
    }
    if (method === "PATCH") {
      const b = await readJson(req);
      const fields = projectItemFields(b, i);
      const area = has(b, "area") && !i.parent_id ? text(b.area, 60, "구역") : null;
      inTx(() => {
        q.setProjectItem.run(...fields, i.id);
        if (area !== null) q.setProjectItemArea.run(area, i.id);
        if (has(b, "partnerRelated") && isAdmin) q.setItemPartner.run(b.partnerRelated ? 1 : 0, i.id); // 관리자 전용
        if (has(b, "qty") && isAdmin) q.setItemQty.run(itemQtyInput(b.qty), i.id); // 관리자 전용
      });
      return send(res, 200, projectDetail(p, user));
    }
    if (method === "DELETE") {
      if (q.ledgersUnderItem.get(i.id).n) return send(res, 409, { error: "이 묶음에 입출고 현황이 있어요. 입출고 관리에서 먼저 지워 주세요." });
      q.delProjectItem.run(i.id); // 묶음이면 안의 것도 함께
      return send(res, 200, projectDetail(p, user));
    }
    return send(res, 405, { error: "Method not allowed" });
  }

  const prm = path.match(/^\/api\/project-processes\/(\d+)$/);
  if (prm) {
    if (!isAdmin) return send(res, 403, { error: "상세 프로세스는 관리자만 볼 수 있어요." });
    const r = q.process.get(Number(prm[1]));
    const p = r && q.project.get(r.project_id);
    if (!p || !projectAllowed(user, p)) throw notFound("프로세스");
    if (method === "PATCH") {
      const b = await readJson(req);
      inTx(() => {
        q.setProcess.run(...processFields(b, r), r.id);
        if (has(b, "partnerRelated")) q.setProcessPartner.run(b.partnerRelated ? 1 : 0, r.id);
      });
      return send(res, 200, processList(p.id));
    }
    if (method === "DELETE") {
      q.delProcess.run(r.id);
      return send(res, 200, processList(p.id));
    }
    return send(res, 405, { error: "Method not allowed" });
  }

  /* 입출고 현황: 볼 수 있는 프로젝트의 것 */
  if (path === "/api/stock") {
    if (method !== "GET") return send(res, 405, { error: "Method not allowed" });
    const ledgers = [];
    for (const l of q.ledgersAll.all()) {
      const p = q.project.get(l.project_id);
      if (!projectAllowed(user, p)) continue;
      ledgers.push(stockListRow(l, p, true));
    }
    return send(res, 200, { ledgers });
  }
  const stm = path.match(/^\/api\/stock\/(\d+)(\/moves)?$/);
  if (stm) {
    const l = q.ledger.get(Number(stm[1]));
    const p = l && q.project.get(q.projectItem.get(l.item_id).project_id);
    if (!p || !projectAllowed(user, p)) throw notFound("입출고 현황");
    if (stm[2]) {
      if (method !== "POST") return send(res, 405, { error: "Method not allowed" });
      const newMoveId = addStockMoveFrom(l, await readJson(req), user);
      return send(res, 201, { ...ledgerOut(l, p, user), newMoveId });
    }
    if (method === "GET") return send(res, 200, ledgerOut(l, p, user));
    if (method === "PATCH") {
      const b = await readJson(req);
      const fields = ledgerFields(b, l);
      inTx(() => {
        const beforeOpts = q.stockOptions.all(l.id);
        q.setLedger.run(...fields, l.id);
        if (has(b, "options")) saveStockOptions(l.id, b.options);
        const now = q.ledger.get(l.id), afterOpts = q.stockOptions.all(l.id);
        const changes = [
          changeText("이름", l.name, now.name), changeText("단위", l.unit, now.unit), changeText("계약 수량", l.contract, now.contract),
          changeText("입고 경로", l.in_label, now.in_label), changeText("출고 경로", l.out_label, now.out_label),
          l.after !== now.after ? "전달 후 현황 변경" : null,
          ...afterOpts.map((o) => { const was = beforeOpts.find((x) => x.id === o.id); return !was ? `품목 추가 ${o.name}` : changeText("품목", was.name, o.name); }),
          ...beforeOpts.filter((o) => !afterOpts.some((x) => x.id === o.id)).map((o) => `품목 삭제 ${o.name}`)
        ].filter(Boolean);
        if (changes.length) logStock(l.id, "ledger", `대장 수정: ${changes.join(", ")}`, user);
      });
      return send(res, 200, ledgerOut(q.ledger.get(l.id), p, user));
    }
    if (method === "DELETE") {
      if (!isAdmin && p.created_by !== user.id) return send(res, 403, { error: "프로젝트를 만든 사람과 관리자만 지울 수 있어요." });
      q.delLedger.run(l.id);
      return send(res, 200, { projectId: p.id });
    }
    return send(res, 405, { error: "Method not allowed" });
  }
  // 입출고 기록 사진: 그 대장을 볼 수 있는 직원이 올리고 보고 지움
  const smpm = path.match(/^\/api\/stock-moves\/(\d+)\/photos$/);
  if (smpm && method === "POST") {
    const m = q.stockMove.get(Number(smpm[1]));
    const l = m && q.ledger.get(m.ledger_id);
    const p = l && q.project.get(q.projectItem.get(l.item_id).project_id);
    if (!p || !projectAllowed(user, p)) throw notFound("기록");
    addMovePhoto(m, l, await readJson(req), user);
    return send(res, 201, ledgerOut(l, p, user));
  }
  const sphm = path.match(/^\/api\/stock-photos\/(\d+)$/);
  if (sphm) {
    const ph = q.photo.get(Number(sphm[1]));
    const m = ph && q.stockMove.get(ph.move_id);
    const l = m && q.ledger.get(m.ledger_id);
    const p = l && q.project.get(q.projectItem.get(l.item_id).project_id);
    if (!p || !projectAllowed(user, p)) throw notFound("사진");
    if (method === "GET") return sendPhoto(res, ph);
    if (method === "DELETE") { delMovePhoto(ph, m, l, user); return send(res, 200, ledgerOut(l, p, user)); }
    return send(res, 405, { error: "Method not allowed" });
  }
  const smm = path.match(/^\/api\/stock-moves\/(\d+)$/);
  if (smm) {
    const m = q.stockMove.get(Number(smm[1]));
    const l = m && q.ledger.get(m.ledger_id);
    const p = l && q.project.get(q.projectItem.get(l.item_id).project_id);
    if (!p || !projectAllowed(user, p)) throw notFound("기록");
    if (method === "PATCH") {
      patchStockMoveFrom(m, l, await readJson(req), user);
      return send(res, 200, ledgerOut(l, p, user));
    }
    if (method === "DELETE") {
      deleteStockMoveBy(m, l, user);
      return send(res, 200, ledgerOut(l, p, user));
    }
    return send(res, 405, { error: "Method not allowed" });
  }

  if (path.startsWith("/api/admin/")) {
    if (!isAdmin) return send(res, 403, { error: "관리자만 볼 수 있어요." });

    /* 봉사자 일정·기본 교육 */
    if (path === "/api/admin/vol-schedules" && method === "GET") return send(res, 200, { schedules: q.volSchedulesAll.all().map(volScheduleAdminOut) });
    // 관리자: '묵주 프로젝트 일정'을 고르면 묵주 묶음에 연결 (봉사자 프로젝트 관리에서 수량을 고침)
    const adminVolFields = (b) => {
      const projectItemId = b.project ? rosaryGroupId() : null;
      if (b.project && !projectItemId) throw bad("연결할 묵주 묶음을 찾을 수 없어요.");
      return volScheduleFields({ ...b, projectItemId });
    };
    if (path === "/api/admin/vol-schedules" && method === "POST") {
      const b2 = await readJson(req);
      const { fields, users } = adminVolFields(b2);
      const edu = has(b2, "eduQty") ? volQtyInput(b2.eduQty) : null;
      const id = inTx(() => {
        const id = Number(q.addVolSchedule.run(...fields, user.id).lastInsertRowid);
        if (fields[7] !== null) q.markVolQty.run(user.name, id);
        if (edu !== null) q.setVolEdu.run(edu, user.name, id);
        if (has(b2, "threadQty") || has(b2, "crossQty")) q.setVolMat.run(has(b2, "threadQty") ? volQtyInput(b2.threadQty) : null, has(b2, "crossQty") ? volQtyInput(b2.crossQty) : null, user.name, id);
        if (b2.tableOnly) q.setVolTableOnly.run(1, id);
        for (const u of users) q.addVolScheduleUser.run(id, u);
        return id;
      });
      console.log(`[admin] ${user.login} → 봉사 일정 #${id} 등록`);
      return send(res, 201, { schedule: volScheduleAdminOut(q.volSchedule.get(id)) });
    }
    const vsm = path.match(/^\/api\/admin\/vol-schedules\/(\d+)$/);
    if (vsm) {
      const s = q.volSchedule.get(Number(vsm[1]));
      if (!s) throw notFound("일정");
      if (method === "PATCH") {
        const b2 = await readJson(req);
        const { fields, users } = adminVolFields(b2);
        inTx(() => {
          q.setVolSchedule.run(...fields, s.id);
          if (fields[7] !== s.qty) q.markVolQty.run(user.name, s.id);
          if (has(b2, "eduQty")) { const e = volQtyInput(b2.eduQty); if (e !== (s.edu_qty ?? null)) q.setVolEdu.run(e, user.name, s.id); }
          if (has(b2, "threadQty") || has(b2, "crossQty")) {
            const th = has(b2, "threadQty") ? volQtyInput(b2.threadQty) : s.thread_qty ?? null, cr = has(b2, "crossQty") ? volQtyInput(b2.crossQty) : s.cross_qty ?? null;
            if (th !== (s.thread_qty ?? null) || cr !== (s.cross_qty ?? null)) q.setVolMat.run(th, cr, user.name, s.id);
          }
          if (has(b2, "tableOnly")) q.setVolTableOnly.run(b2.tableOnly ? 1 : 0, s.id);
          q.clearVolScheduleUsers.run(s.id);
          for (const u of users) q.addVolScheduleUser.run(s.id, u);
        });
        return send(res, 200, { schedule: volScheduleAdminOut(q.volSchedule.get(s.id)) });
      }
      if (method === "DELETE") {
        q.delVolSchedule.run(s.id);
        console.log(`[admin] ${user.login} → 봉사 일정 #${s.id} 삭제`);
        return send(res, 204);
      }
      return send(res, 405, { error: "Method not allowed" });
    }
    /* 묵주 교육 기록 · 봉사자 명단 (관리자 전용으로 시작) */
    if (path.startsWith("/api/admin/vol-roster") || path.startsWith("/api/admin/vol-edu")) return await rosaryAdminRoute(req, res, path, method, user);
    if (path === "/api/admin/vol-stock-moves" && method === "GET") {
      return send(res, 200, { moves: q.volStockMoves.all().map((m) => ({ id: m.id, type: m.type, date: m.date, note: m.note, handler: m.handler, issue: m.issue || "", photos: m.photos, inspectOk: m.inspect_ok ?? null, inspectBad: m.inspect_bad ?? null, createdAt: m.created_at, enteredBy: m.author, ledgerId: m.ledger_id, ledgerName: m.ledger_name, unit: m.unit, total: m.total })) });
    }
    // 봉사자가 적은 원자재 보유물량 · 제품 회수물량 (최근 300건)
    if (await inspectionRoute(req, res, user, path, method, "/api/admin")) return;
    if (path === "/api/admin/vol-records" && method === "GET") {
      return send(res, 200, { records: q.volRecordsAll.all().map((r) => ({ id: r.id, kind: r.kind, stage: r.stage || "in", group: r.group_name, date: r.date, name: r.name, qty: r.qty, note: r.note, author: r.author || "", updatedAt: r.updated_at })) });
    }
    // 회의실 목록: 한 줄에 하나, 30자·30개까지, 같은 이름은 하나로
    if (path === "/api/admin/rooms" && method === "PUT") {
      const b = await readJson(req);
      if (!Array.isArray(b.rooms) || b.rooms.length > 30) throw bad("회의실은 30개까지 등록할 수 있어요.");
      const rooms = [...new Set(b.rooms.map((x) => text(x, 30, "회의실 이름")).filter(Boolean))];
      q.setSetting.run("meeting_rooms", JSON.stringify(rooms));
      console.log(`[admin] ${user.login} → 회의실 목록 ${rooms.length}개`);
      return send(res, 200, { rooms });
    }
    // 봉사자 메뉴 공개 범위
    if (path === "/api/admin/vol-menu" && method === "GET") return send(res, 200, { menu: volMenu(), keys: VOL_MENU_KEYS });
    if (path === "/api/admin/vol-menu" && method === "PUT") {
      const b = await readJson(req);
      if (!Array.isArray(b.menu)) throw bad("메뉴를 확인해 주세요.");
      const menu = VOL_MENU_KEYS.filter((k) => b.menu.includes(k));
      q.setSetting.run("vol_menu", JSON.stringify(menu));
      console.log(`[admin] ${user.login} → 봉사자 메뉴 공개: ${menu.join(",")}`);
      return send(res, 200, { menu, keys: VOL_MENU_KEYS });
    }
    const volTrainingAdminOut = (t) => ({ ...volTrainingOut(t), doneBy: q.volDoneOfTraining.all(t.id).map((d) => ({ id: d.user_id, name: d.name, doneAt: d.done_at })) });
    if (path === "/api/admin/vol-trainings" && method === "GET") return send(res, 200, { trainings: q.volTrainings.all().map(volTrainingAdminOut) });
    if (path === "/api/admin/vol-trainings" && method === "POST") {
      const id = Number(q.addVolTraining.run(...volTrainingFields(await readJson(req)), user.id).lastInsertRowid);
      console.log(`[admin] ${user.login} → 기본 교육 #${id} 등록`);
      return send(res, 201, { training: volTrainingAdminOut(q.volTraining.get(id)) });
    }
    const vtam = path.match(/^\/api\/admin\/vol-trainings\/(\d+)$/);
    if (vtam) {
      const t = q.volTraining.get(Number(vtam[1]));
      if (!t) throw notFound("교육");
      if (method === "PATCH") {
        q.setVolTraining.run(...volTrainingFields(await readJson(req)), t.id);
        return send(res, 200, { training: volTrainingAdminOut(q.volTraining.get(t.id)) });
      }
      if (method === "DELETE") {
        q.delVolTraining.run(t.id);
        console.log(`[admin] ${user.login} → 기본 교육 #${t.id} 삭제`);
        return send(res, 204);
      }
      return send(res, 405, { error: "Method not allowed" });
    }

    if (path === "/api/admin/users" && method === "GET") {
      return send(res, 200, {
        users: q.users.all().map((u) => ({
          id: u.id, login: u.login, role: roleOut(u), volKind: volKindOf(u), volKinds: volKindsOf(u), volLeader: !!(u.volunteer && u.vol_leader && volKindsOf(u).includes("team")), name: u.name, unitId: u.unit_id, viewUnits: viewUnitsOut(u.id), note: u.note, pwChanged: u.pw_changed === 1,
          createdAt: u.created_at, lastLoginAt: u.last_login_at, me: u.id === user.id
        }))
      });
    }
    if (path === "/api/admin/users" && method === "POST") {
      const b = await readJson(req);
      const login = normalizeLogin(b.login);
      if (!/^[a-z0-9._-]{3,20}$/.test(login)) throw bad("아이디는 영문 소문자·숫자·._- 로 3~20자로 정해 주세요.", "login");
      const name = text(b.name, LIMITS.name, "이름", true);
      const volunteer = b.role === "volunteer" || b.role === "team" ? 1 : 0;
      const kindsNew = volunteer ? volKindsInput(b) : "dept";
      const unit = volunteer ? null : unitIdOrNull(b.unitId);
      const role = b.role === "admin" ? "admin" : "member";
      const director = b.role === "director" ? 1 : 0;
      if (q.userByLogin.get(login)) throw bad("이미 있는 아이디예요.", "login");
      const password = tempPassword();
      const note = text(b.note, LIMITS.userNote, "메모"), hash = hashPassword(password);
      inTx(() => {
        const id = Number(q.addUser.run(login, hash, role, name, unit, note).lastInsertRowid);
        if (director) q.setUserDirector.run(1, id);
        if (volunteer) q.setUserVolunteer.run(1, id);
        if (volunteer) q.setUserVolKind.run(kindsNew, id);
        if (volunteer && b.volLeader && kindsNew !== "dept") q.setUserVolLeader.run(1, id);
      });
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
      inTx(() => { for (const id of list) if (!q.userById.get(id)?.volunteer) q.setUserUnit.run(unit, id); });
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
        const isVol = b.role === "volunteer" || b.role === "team";
        const role = b.role === "admin" ? "admin" : b.role === "member" || b.role === "director" || isVol ? "member" : target.role;
        const director = b.role === "director" ? 1 : b.role === "admin" || b.role === "member" || isVol ? 0 : target.director;
        const volunteer = isVol ? 1 : b.role === "admin" || b.role === "member" || b.role === "director" ? 0 : target.volunteer;
        // volKinds 를 안 보내면(예전 화면) 봉사자 권한은 그대로
        const volKind = isVol ? (Array.isArray(b.volKinds) || b.role === "team" || !target.volunteer ? volKindsInput(b) : target.vol_kind || "dept") : target.vol_kind || "dept";
        if (lastAdmin && role !== "admin") throw bad("관리자가 한 명은 있어야 해요.");
        // 추가로 볼 수 있는 조직: [{ unitId, sub }] 로 통째로 바꿈
        let grants = null;
        if (has(b, "viewUnits")) {
          if (!Array.isArray(b.viewUnits) || b.viewUnits.length > 20) throw bad("추가로 볼 조직은 20개까지 정할 수 있어요.");
          grants = b.viewUnits.map((g) => ({ unit: unitIdOrNull(g?.unitId), sub: g?.sub === false ? 0 : 1 })).filter((g) => g.unit);
        }
        inTx(() => {
          q.setUser.run(name, volunteer ? null : unit, note, role, target.id);
          q.setUserDirector.run(director, target.id);
          q.setUserVolunteer.run(volunteer, target.id);
          q.setUserVolKind.run(volKind, target.id);
          // 리더는 팀 봉사자만. 보내지 않으면 그대로, 봉사자가 아니거나 팀 권한이 없어지면 끔
          q.setUserVolLeader.run(volunteer && volKind !== "dept" ? (has(b, "volLeader") ? (b.volLeader ? 1 : 0) : target.vol_leader || 0) : 0, target.id);
          if (grants || volunteer) q.clearViewUnits.run(target.id);
          if (grants && !volunteer) for (const g of grants) q.addViewUnit.run(target.id, g.unit, g.sub);
          if (volunteer) q.unlinkUserPositions.run(target.id); // 봉사자는 조직도 자리에 연결하지 않음
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
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", ...(type.startsWith("text/html") ? { "Content-Security-Policy": DEV ? CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'") : CSP, "X-Frame-Options": "DENY" } : {}) });
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
  console.log(`P-Schedule 서버: http://localhost:${PORT}${STATIC_DIR ? " (정적 파일 포함)" : ""}`);
});
// 연락 후속 조치 알림: 한 시간마다 확인 (하루 한 번만 보냄)
setInterval(() => { try { followupReminders(); } catch (e) { console.log(`[followup] ${e.message}`); } }, 60 * 60 * 1000).unref();

// ---- 묵주 교육 기록 (교육 회차·진행상태·출납 상세·참여 봉사자) · 계정 없는 봉사자 명단 · 봉사자별 집계. 관리자만
const ROSTER_KIND = new Set(["making", "cutting", "etc"]);
const rosterOut = () => {
  const stats = new Map(db.prepare(`SELECT h.roster_id AS id,
      COUNT(DISTINCT CASE WHEN ${EDU_STATUS_SQL} = 'done' THEN (CASE WHEN s.edu_code <> '' THEN s.edu_code ELSE 'id' || s.id END) END) AS done,
      COUNT(DISTINCT CASE WHEN ${EDU_STATUS_SQL} <> 'done' THEN (CASE WHEN s.edu_code <> '' THEN s.edu_code ELSE 'id' || s.id END) END) AS planned,
      MIN(s.date) AS first, MAX(s.date) AS last
    FROM vol_edu_helpers h JOIN vol_schedules s ON s.id = h.schedule_id LEFT JOIN team_org_info t ON t.schedule_id = s.id GROUP BY h.roster_id`).all().map((r) => [r.id, r]));
  return db.prepare("SELECT r.*, u.name AS user_name FROM vol_roster r LEFT JOIN users u ON u.id = r.user_id ORDER BY r.kind, r.call_name").all().map((r) => {
    const st = stats.get(r.id) || {};
    return { id: r.id, call: r.call_name, name: r.name, kind: r.kind, affiliation: r.affiliation, userId: r.user_id, userName: r.user_name || "", note: r.note, done: st.done || 0, planned: st.planned || 0, first: st.first || null, last: st.last || null };
  });
};
const rosterUsers = () => db.prepare("SELECT id, name FROM users WHERE volunteer = 1 ORDER BY name").all();
const eduRowOut = (s, helpers) => {
  const st = eduStatus(s.progress, q.teamOrgInfo.get(s.id)?.status);
  const unT = s.alloc_qty != null && s.thread_qty != null ? s.alloc_qty - s.thread_qty : null;
  const unC = s.alloc_qty != null && s.cross_qty != null ? s.alloc_qty - s.cross_qty : null;
  const mismatch = [];
  if (s.send_thread != null && unT != null && s.send_thread !== unT) mismatch.push(`보낼 실 ${s.send_thread} ≠ 미지급 ${unT}`);
  if (s.send_cross != null && unC != null && s.send_cross !== unC) mismatch.push(`보낼 십자가 ${s.send_cross} ≠ 미지급 ${unC}`);
  return {
    id: s.id, code: s.edu_code || "", date: s.date, startTime: s.start_time, title: s.title, org: String(s.title || "").split(" · ").pop(), tableOnly: !!s.table_only, progress: st === "done" ? "done" : "planned", delay: st === "delay",
    qty: s.qty ?? null, alloc: s.alloc_qty ?? null, thread: s.thread_qty ?? null, cross: s.cross_qty ?? null, unpaidThread: unT, unpaidCross: unC,
    sendThread: s.send_thread ?? null, sendCross: s.send_cross ?? null, sample: s.sample_qty ?? null, done: s.done_qty ?? null, loss: s.loss_qty ?? null,
    handler: s.mat_handler || "", matNote: s.mat_note || "", mismatch, helpers: helpers.get(s.id) || []
  };
};
const eduRows = (id) => {
  const g = db.prepare("SELECT project_item_id AS id FROM vol_schedules WHERE title LIKE '묵주 교육 · %' AND project_item_id IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC LIMIT 1").get();
  if (!g) return [];
  const list = id ? db.prepare("SELECT * FROM vol_schedules WHERE id = ?").all(id) : db.prepare("SELECT * FROM vol_schedules WHERE project_item_id = ? ORDER BY table_only, date, start_time, id").all(g.id);
  const helpers = new Map();
  for (const h of db.prepare(`SELECT h.schedule_id, h.role, r.id, r.call_name FROM vol_edu_helpers h JOIN vol_roster r ON r.id = h.roster_id ${id ? "WHERE h.schedule_id = ?" : ""} ORDER BY r.call_name`).all(...(id ? [id] : []))) {
    if (!helpers.has(h.schedule_id)) helpers.set(h.schedule_id, []);
    helpers.get(h.schedule_id).push({ id: h.id, call: h.call_name, role: h.role });
  }
  return list.map((s) => eduRowOut(s, helpers));
};
const rosterIn = (b) => {
  const call = text(b.call, 40, "호칭", true);
  const kind = ROSTER_KIND.has(b.kind) ? b.kind : "etc";
  const userId = b.userId === null || b.userId === "" || b.userId === undefined ? null : Number(b.userId);
  if (userId !== null && !rosterUsers().some((u) => u.id === userId)) throw bad("연결할 봉사자 계정을 찾을 수 없어요.");
  return [call, text(b.name, 40, "이름") || "", kind, text(b.affiliation, 100, "소속") || "", userId, text(b.note, 300, "메모") || ""];
};
async function rosaryAdminRoute(req, res, path, method, user) {
  if (path === "/api/admin/vol-roster") {
    if (method === "GET") return send(res, 200, { roster: rosterOut(), users: rosterUsers() });
    if (method === "POST") {
      const f = rosterIn(await readJson(req));
      if (db.prepare("SELECT 1 FROM vol_roster WHERE call_name = ?").get(f[0])) throw bad("같은 호칭이 이미 있어요.");
      db.prepare("INSERT INTO vol_roster (call_name, name, kind, affiliation, user_id, note) VALUES (?, ?, ?, ?, ?, ?)").run(...f);
      console.log(`[admin] ${user.login} → 봉사자 명단 추가`);
      return send(res, 201, { roster: rosterOut() });
    }
    return send(res, 405, { error: "Method not allowed" });
  }
  const rm = path.match(/^\/api\/admin\/vol-roster\/(\d+)$/);
  if (rm) {
    const r = db.prepare("SELECT * FROM vol_roster WHERE id = ?").get(Number(rm[1]));
    if (!r) throw notFound("봉사자");
    if (method === "PATCH") {
      const f = rosterIn(await readJson(req));
      if (db.prepare("SELECT 1 FROM vol_roster WHERE call_name = ? AND id <> ?").get(f[0], r.id)) throw bad("같은 호칭이 이미 있어요.");
      db.prepare("UPDATE vol_roster SET call_name = ?, name = ?, kind = ?, affiliation = ?, user_id = ?, note = ?, updated_at = datetime('now') WHERE id = ?").run(...f, r.id);
      return send(res, 200, { roster: rosterOut() });
    }
    if (method === "DELETE") {
      const n = db.prepare("SELECT count(*) AS n FROM vol_edu_helpers WHERE roster_id = ?").get(r.id).n;
      if (n) return send(res, 400, { error: `교육 참여 기록 ${n}건이 있어 지울 수 없어요. 먼저 교육 기록에서 빼 주세요.` });
      db.prepare("DELETE FROM vol_roster WHERE id = ?").run(r.id);
      console.log(`[admin] ${user.login} → 봉사자 명단 #${r.id} 삭제`);
      return send(res, 200, { roster: rosterOut() });
    }
    return send(res, 405, { error: "Method not allowed" });
  }
  if (path === "/api/admin/vol-edu" && method === "GET") return send(res, 200, { rows: eduRows(), roster: rosterOut() });
  const em = path.match(/^\/api\/admin\/vol-edu\/(\d+)$/);
  if (em && method === "PATCH") {
    const s = db.prepare("SELECT * FROM vol_schedules WHERE id = ? AND project_item_id IS NOT NULL").get(Number(em[1]));
    if (!s) throw notFound("교육 일정");
    const b = await readJson(req);
    const q2 = (k) => (has(b, k) ? volQtyInput(b[k]) : undefined);
    const set = {};
    if (has(b, "progress")) { if (!["planned", "done"].includes(b.progress)) throw bad("진행상태를 확인해 주세요."); }
    if (has(b, "code")) set.edu_code = text(b.code, 20, "교육 회차") || "";
    for (const [k, c] of [["alloc", "alloc_qty"], ["sendThread", "send_thread"], ["sendCross", "send_cross"], ["sample", "sample_qty"], ["done", "done_qty"], ["loss", "loss_qty"]]) { const v = q2(k); if (v !== undefined) set[c] = v; }
    if (has(b, "handler")) set.mat_handler = text(b.handler, 100, "담당") || "";
    if (has(b, "matNote")) set.mat_note = text(b.matNote, 500, "비고") || "";
    let helpers = null;
    if (has(b, "helpers")) {
      if (!Array.isArray(b.helpers) || b.helpers.length > 30) throw bad("참여 봉사자를 확인해 주세요.");
      helpers = b.helpers.map((h) => ({ id: Number(h.id), role: text(h.role, 20, "구분") || "" }));
      for (const h of helpers) if (!db.prepare("SELECT 1 FROM vol_roster WHERE id = ?").get(h.id)) throw bad("명단에 없는 봉사자가 있어요.");
    }
    inTx(() => {
      const keys = Object.keys(set);
      if (keys.length) db.prepare(`UPDATE vol_schedules SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => set[k]), s.id);
      if (has(b, "thread") || has(b, "cross")) {
        const th = has(b, "thread") ? volQtyInput(b.thread) : s.thread_qty ?? null, cr = has(b, "cross") ? volQtyInput(b.cross) : s.cross_qty ?? null;
        if (th !== (s.thread_qty ?? null) || cr !== (s.cross_qty ?? null)) q.setVolMat.run(th, cr, user.name, s.id);
      }
      if (helpers) {
        db.prepare("DELETE FROM vol_edu_helpers WHERE schedule_id = ?").run(s.id);
        const add = db.prepare("INSERT OR IGNORE INTO vol_edu_helpers (schedule_id, roster_id, role) VALUES (?, ?, ?)");
        for (const h of helpers) add.run(s.id, h.id, h.role);
      }
      // 진행상태가 바뀔 때만 팀 봉사자 쪽 상태도 같이 (그대로 저장하면 '연기'를 덮어쓰지 않음)
      if (has(b, "progress") && b.progress !== (eduStatus(s.progress, q.teamOrgInfo.get(s.id)?.status) === "done" ? "done" : "planned")) setEduStatus(db, s.id, b.progress === "done" ? "done" : "plan");
    });
    return send(res, 200, { row: eduRows(s.id)[0], roster: rosterOut() });
  }
  return send(res, 404, { error: "Not found" });
}
