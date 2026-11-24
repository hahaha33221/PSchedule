/*
 * 수정된 일정 표시 — 제목·날짜·시각·장소가 바뀐 일정을 잠깐 기억해 '오늘' 화면에 '수정됨'으로 보여 줌
 *
 *   - 구글에서 읽은 일정: 다시 읽을 때 바꿔 넣기 전과 후를 견줌. 사이트 일정: 고치거나 지울 때 남김
 *   - 보이는 때: 바뀐 것을 안 때부터 3일, 그 일정이 끝나면 그전이라도 사라짐. 기록은 30일 뒤 지움
 *   - 보이는 사람: 지금 그 일정을 볼 수 있고, 바뀌기 전에도 볼 수 있던 사람 (vis 에 그때의 소속·올린 사람·참석자)
 *   - 조용히 넘기는 것: 캘린더를 처음 읽을 때, 주소를 바꾼 뒤 첫 읽기, 한꺼번에 많이 바뀐 때(공유 설정이 바뀐 것일 수 있음),
 *     반복 전체의 시각을 옮긴 것처럼 어느 회차가 어느 회차가 되었는지 알 수 없는 것
 */
import { createHash } from "node:crypto";

export const SHOW_DAYS = 3, KEEP_DAYS = 30;
const FIELDS = ["title", "startDate", "endDate", "startTime", "endTime", "location"];
const DAY_MS = 86400 * 1000;
const WD = ["일", "월", "화", "수", "목", "금", "토"];

const tidy = (x) => String(x ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
const pick = (r) => ({ title: r.title, startDate: r.start_date ?? r.startDate, endDate: r.end_date ?? r.endDate, startTime: (r.start_time ?? r.startTime) || null, endTime: (r.end_time ?? r.endTime) || null, location: r.location || "" });
const differs = (a, b) => FIELDS.some((k) => tidy(a[k]) !== tidy(b[k]));
export const isAbsence = (c) => (c.absence == null ? /부재/.test(c.name || "") : !!c.absence);
export const urlMark = (url) => createHash("sha256").update(String(url)).digest("hex").slice(0, 16);

const dayLabel = (d) => { const t = new Date(d + "T00:00:00Z"); return `${t.getUTCMonth() + 1}월 ${t.getUTCDate()}일(${WD[t.getUTCDay()]})`; };
const dates = (v) => (v.endDate && v.endDate !== v.startDate ? `${dayLabel(v.startDate)} ~ ${dayLabel(v.endDate)}` : dayLabel(v.startDate));
const times = (v) => (v.startTime ? (v.endTime ? `${v.startTime}~${v.endTime}` : v.startTime) : "종일");
// 무엇이 어떻게 바뀌었는지
export function changesOf(a, b) {
  const out = [];
  const add = (kind, label, from, to) => { if (from !== to) out.push({ kind, label, from, to }); };
  add("title", "제목", tidy(a.title), tidy(b.title));
  add("date", "날짜", dates(a), dates(b));
  add("time", "시간", times(a), times(b));
  add("place", "장소", tidy(a.location) || "없음", tidy(b.location) || "없음");
  return out;
}

export function addEventEditTables(db) {
  const has = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c);
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_edits (
      id          INTEGER PRIMARY KEY,
      event_id    INTEGER,           -- 사이트 일정 (지워져도 남음)
      calendar_id INTEGER REFERENCES calendars(id) ON DELETE CASCADE, -- 구글 일정
      uid         TEXT,
      inst        TEXT,              -- 바뀌기 전 회차
      recur       INTEGER NOT NULL DEFAULT 0,
      kind        TEXT NOT NULL,     -- 'edit' | 'gone'
      before      TEXT NOT NULL,     -- 바뀌기 전 값 JSON
      vis         TEXT NOT NULL,     -- 그때 볼 수 있던 범위 JSON { unit, by, att }
      at          TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS event_edits_at ON event_edits (at);`);
  // 마지막으로 견준 주소 표시(주소 자체는 아님). 비었거나 다르면 다음 읽기는 조용히 기준만 잡음
  if (!has("calendars", "edit_base")) db.exec("ALTER TABLE calendars ADD COLUMN edit_base TEXT");
  // 부재 캘린더: NULL 이름으로 정함('부재'가 들어가면) · 1 부재 · 0 아님
  if (!has("calendars", "absence")) db.exec("ALTER TABLE calendars ADD COLUMN absence INTEGER");
  // 0 단발 · 1 반복 · 2 이어 볼 수 없음(UID 없음)
  if (!has("calendar_events", "recur")) db.exec("ALTER TABLE calendar_events ADD COLUMN recur INTEGER NOT NULL DEFAULT 0");
}

export function createEventEdits(db, opts = {}) {
  const now = opts.now || (() => Date.now());
  const log = opts.log || console.log;
  const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
  const seoul = () => new Date(now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
  const q = {
    add: db.prepare("INSERT INTO event_edits (event_id, calendar_id, uid, inst, recur, kind, before, vis, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"),
    recent: db.prepare("SELECT * FROM event_edits WHERE at >= ? ORDER BY id"),
    back: db.prepare("UPDATE event_edits SET kind = 'edit' WHERE kind = 'gone' AND calendar_id = ? AND uid = ? AND (recur = 0 OR inst = ?)"),
    prune: db.prepare("DELETE FROM event_edits WHERE at < ?"),
    dropCal: db.prepare("DELETE FROM event_edits WHERE calendar_id = ?"),
    calendars: db.prepare("SELECT * FROM calendars"),
    single: db.prepare("SELECT * FROM calendar_events WHERE calendar_id = ? AND uid = ? AND recur = 0"),
    inst: db.prepare("SELECT * FROM calendar_events WHERE calendar_id = ? AND uid = ? AND inst = ?"),
    event: db.prepare("SELECT * FROM events WHERE id = ?"),
    att: db.prepare("SELECT user_id FROM event_attendees WHERE event_id = ?"),
    copies: db.prepare("SELECT id, inst, unit_id, created_by FROM (SELECT id, src_inst AS inst, unit_id, created_by FROM events WHERE src_calendar_id = ? AND src_uid = ?)"),
    sourceThere: db.prepare("SELECT 1 FROM calendar_events WHERE calendar_id = ? AND uid = ? AND inst = ?")
  };
  const endOf = (v) => `${v.endDate || v.startDate} ${v.startTime ? v.endTime || "24:00" : "24:00"}`;
  const ended = (v) => endOf(v) <= seoul();
  const ownVis = (e) => ({ unit: e.unit_id ?? null, by: e.created_by ?? null, att: q.att.all(e.id).map((x) => x.user_id) });

  /* ----- 남기기 ----- */
  // 사이트 일정을 고친 뒤 (before: 고치기 전 줄과 그때의 범위 — mark(e) 로 미리 받아 둠)
  const mark = (e) => ({ e, vis: ownVis(e) });
  function edited(m) {
    const cur = q.event.get(m.e.id), before = pick(m.e);
    if (!cur || !differs(before, pick(cur)) || (ended(before) && ended(pick(cur)))) return;
    q.add.run(cur.id, null, null, null, 0, "edit", JSON.stringify(before), JSON.stringify(m.vis), sqlTime(now()));
  }
  // 사이트 일정을 지우기 전. 구글 원본이 남아 있는 사본을 지운 것은 취소가 아님 (원본이 다시 보임)
  function removed(e) {
    if (e.src_calendar_id && q.sourceThere.get(e.src_calendar_id, e.src_uid, e.src_inst)) return;
    const before = { ...pick(e), kind: e.kind, categoryId: e.category_id ?? null };
    if (!ended(before)) q.add.run(e.id, null, null, null, 0, "gone", JSON.stringify(before), JSON.stringify(ownVis(e)), sqlTime(now()));
  }

  // 구글 캘린더를 바꿔 넣기 전: 예전 줄과 새 목록을 견줌 (같은 거래 안에서 부름)
  // feed: { uids: 원본에 있는(취소 아닌) UID, cancelled: 지운 회차 'uid|key' } · range: 가져오는 기간
  function synced(cal, old, list, feed, range) {
    const base = urlMark(cal.url);
    if (cal.edit_base !== base) { q.dropCal.run(cal.id); return { quiet: "base", moves: [] }; }
    const group = (rows, key) => { const m = new Map(); for (const r of rows) { const k = r[key].slice(0, 500); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
    const was = group(old, "uid"), is = group(list, "uid");
    const rows = [], gone = [], moves = [];
    const vis = JSON.stringify({ unit: cal.unit_id ?? null });
    let live = 0;
    for (const [uid, a] of was) {
      const b = is.get(uid) || [];
      const single = a.length === 1 && a[0].recur === 0;
      if (single && b.length === 1 && b[0].recur === 0) {
        // 단발: 시각이 바뀌어 회차 키가 달라도 같은 일정
        if (a[0].inst !== b[0].key) moves.push({ id: a[0].id, inst: b[0].key });
        const x = pick(a[0]), y = pick(b[0]);
        if (ended(x) && ended(y)) continue;
        live++;
        if (differs(x, y)) rows.push({ uid, inst: a[0].inst, recur: 0, before: x });
      } else if (single && !b.length) {
        const x = pick(a[0]);
        if (ended(x)) continue;
        live++;
        // 원본에 아직 있으면(가져오는 기간 밖으로 옮김) 취소가 아님. 기간을 벗어난 것도 아님
        if (!feed.uids.has(uid) && x.startDate <= range.to && x.endDate >= range.from) gone.push({ uid, inst: a[0].inst, recur: 0, before: x });
      } else {
        // 반복: 같은 회차 키끼리만. 없어진 회차는 원본이 '이 회차만 지움'이라고 적은 것만
        const now2 = new Map(b.filter((y) => y.recur === 1).map((y) => [y.key, y]));
        for (const r of a) {
          if (r.recur !== 1) continue;
          const x = pick(r), y0 = now2.get(r.inst), y = y0 && pick(y0);
          if (ended(x) && (!y || ended(y))) continue;
          live++;
          if (y) { if (differs(x, y)) rows.push({ uid, inst: r.inst, recur: 1, before: x }); }
          else if (feed.cancelled.has(uid + "|" + r.inst)) gone.push({ uid, inst: r.inst, recur: 1, before: x });
        }
      }
    }
    // 사라졌다가 다시 나타난 것은 취소가 아님
    const had = new Set(old.map((r) => r.uid + "|" + r.inst));
    for (const y of list) if (!had.has(y.uid + "|" + y.key)) q.back.run(cal.id, y.uid, y.key);
    // 한꺼번에 많이 바뀌면 표시하지 않음: 공유 설정('한가함/바쁨만')이 바뀌었거나 원본을 덜 읽은 것일 수 있음
    const many = (n) => n > Math.max(30, live * 0.4);
    if (many(rows.length)) { log(`[calendar] #${cal.id} 한꺼번에 ${rows.length}건이 바뀌어 수정 표시를 남기지 않음`); rows.length = 0; }
    if (many(gone.length) || !list.length) { if (gone.length) log(`[calendar] #${cal.id} 한꺼번에 ${gone.length}건이 사라져 취소 표시를 남기지 않음`); gone.length = 0; }
    const at = sqlTime(now());
    for (const [kind, l] of [["edit", rows], ["gone", gone]]) for (const r of l) q.add.run(null, cal.id, r.uid, r.inst, r.recur, kind, JSON.stringify(r.before), vis, at);
    return { edits: rows.length, gone: gone.length, moves };
  }

  /* ----- 보여 주기 ----- */
  // v: { admin, uid, units } 지금 보는 사람의 범위 → { own, ext, source, lines(day) }
  function view(v) {
    const own = new Map(), ext = new Map(), source = new Map(), lines = [];
    const extKey = (cal, uid, inst) => `${cal}|${uid}|${inst}`;
    const out = {
      event: (id) => own.get(id) || null, external: (x) => ext.get(extKey(x.calendar_id, x.uid, x.inst)) || null,
      // 우리 소속으로 넣은 일정의 원본이 바뀜
      // 이미 원본대로 맞췄으면(값이 같으면) 없음
      source: (e) => {
        const s = e.src_calendar_id && source.get(extKey(e.src_calendar_id, e.src_uid, e.src_inst));
        if (!s) return null;
        const { val, ...info } = s, fit = (t) => (t === "24:00" ? "23:59" : t);
        return val && !differs({ ...val, endTime: fit(val.endTime) }, pick(e)) ? null : info;
      },
      lines: (day) => lines.filter((l) => l.from <= day && l.to >= day && !(l.live && l.live.startDate <= day && l.live.endDate >= day)).map(({ from, to, live, ...l }) => l)
    };
    const rows = q.recent.all(sqlTime(now() - SHOW_DAYS * DAY_MS));
    if (!rows.length) return out;
    const units = new Set(JSON.parse(v.units));
    const seeOwn = (x) => !!v.admin || (x.unit != null && units.has(x.unit)) || (x.by != null && x.by === v.uid) || (x.att || []).includes(v.uid);
    const seeExt = (unit) => !!v.admin || unit == null || units.has(unit);
    const cals = new Map(q.calendars.all().map((c) => [c.id, c]));
    const groups = new Map();
    for (const r of rows) {
      const vis = JSON.parse(r.vis);
      if (r.calendar_id == null ? !seeOwn(vis) : !cals.has(r.calendar_id) || !seeExt(cals.get(r.calendar_id).unit_id) || !seeExt(vis.unit)) continue;
      const k = r.calendar_id == null ? `e${r.event_id}` : `c${r.calendar_id}|${r.uid}${r.recur ? "|" + r.inst : ""}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push({ ...r, before: JSON.parse(r.before) });
    }
    function gone(r, cal, copies) {
      if (ended(r.before)) return;
      const at = r.at;
      if (cal) for (const c of copies) source.set(extKey(cal.id, r.uid, c.inst), { at, gone: true, changes: [] });
      if (cal && (isAbsence(cal) || copies.length)) return; // 부재는 회의가 아님
      lines.push({ what: "gone", id: null, ...(cal ? { calendarId: cal.id, calendarName: cal.name, color: cal.color, categoryId: cal.category_id, ext: true } : { kind: r.before.kind || "meeting", unitId: JSON.parse(r.vis).unit, categoryId: r.before.categoryId ?? null }), at, title: tidy(r.before.title), time: times(r.before), from: r.before.startDate, to: r.before.endDate, live: null });
    }
    for (let g of groups.values()) {
      if (g[0].calendar_id == null) {
        // 지운 사이트 일정은 되살아나지 않음: 지움 앞쪽은 끝난 이야기, 뒤쪽은 번호를 이어 쓴 다른 일정
        const i = g.findLastIndex((r) => r.kind === "gone");
        if (i >= 0) { gone(g[i], null, []); g = g.slice(i + 1); if (!g.length) continue; }
      }
      const first = g[0], last = g[g.length - 1], cal = first.calendar_id == null ? null : cals.get(first.calendar_id);
      let cur = null, key = null;
      if (!cal) {
        cur = q.event.get(first.event_id) || null;
        if (cur && !seeOwn({ ...ownVis(cur) })) continue; // 지금은 볼 수 없는 일정
      } else {
        const live = first.recur ? [q.inst.get(cal.id, first.uid, first.inst)].filter(Boolean) : q.single.all(cal.id, first.uid);
        if (live.length > 1) continue;
        cur = live[0] || null;
        if (cur) key = extKey(cal.id, cur.uid, cur.inst);
      }
      const at = last.at;
      const meta = cal ? { calendarId: cal.id, calendarName: cal.name, color: cal.color, categoryId: cal.category_id, ext: true } : { kind: cur?.kind || "meeting", unitId: cur?.unit_id ?? null, categoryId: cur?.category_id ?? null };
      const copies = cal ? q.copies.all(cal.id, first.uid).filter((c) => c.inst === first.inst || c.inst === cur?.inst || g.some((r) => r.inst === c.inst)) : [];
      const seenCopy = copies.filter((c) => seeOwn(ownVis({ id: c.id, unit_id: c.unit_id, created_by: c.created_by })));
      if (cur) {
        const val = pick(cur), changes = changesOf(first.before, val);
        if (!changes.length) continue;
        const info = { at, changes };
        if (!ended(val)) { if (cal) ext.set(key, info); else own.set(cur.id, info); }
        if (cal) for (const c of seenCopy) if (!ended(val) || !ended(first.before)) source.set(extKey(cal.id, first.uid, c.inst), { ...info, val });
        // 옮김 줄: 바뀌기 전 날에. 부재는 회의가 아니라 넣지 않음
        if (cal && (isAbsence(cal) || seenCopy.some((c) => c.inst === cur.inst))) continue;
        for (const r of g) if (!ended(r.before)) lines.push({ what: "moved", id: cur.id, ...meta, at, title: tidy(r.before.title), time: times(r.before), toDate: dates(val), toTime: times(val), from: r.before.startDate, to: r.before.endDate, live: val });
      } else if (last.kind === "gone") gone(last, cal, seenCopy);
    }
    // 같은 일정이 같은 날 두 줄로 나오지 않게 (하루에 두 번 고친 것)
    const seen = new Set();
    for (let i = lines.length - 1; i >= 0; i--) { const k = `${lines[i].what}|${lines[i].ext ? "x" : "e"}|${lines[i].id}|${lines[i].from}|${lines[i].to}`; if (lines[i].id && seen.has(k)) lines.splice(i, 1); else seen.add(k); }
    return out;
  }

  const prune = () => q.prune.run(sqlTime(now() - KEEP_DAYS * DAY_MS));
  return { mark, edited, removed, synced, view, prune };
}
