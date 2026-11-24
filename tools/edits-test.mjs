#!/usr/bin/env node
// 수정된 일정 표시 검사 (server/event-edits.mjs · calendars.mjs). 지어낸 일정만 씀
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../server/db.mjs";
import { createEventEdits } from "../server/event-edits.mjs";
import { createCalendarSync } from "../server/calendars.mjs";

const dir = mkdtempSync(join(tmpdir(), "ps-edits-"));
const db = openDb(join(dir, "t.db"));
let clock = Date.now(), n = 0;
const edits = createEventEdits(db, { now: () => clock, log: () => {} });
let feed = "", fail = "";
const sync = createCalendarSync(db, { edits, log: () => {}, download: async () => { if (fail) throw new Error(fail); return feed; } });
const DAY = 86400000;
const ymd = (off) => new Date(Date.now() + 9 * 36e5 + off * DAY).toISOString().slice(0, 10);
const st = (off, hm) => ymd(off).replace(/-/g, "") + "T" + hm + "00";
const ev = (uid, off, a, b, o = {}) => `BEGIN:VEVENT\nUID:${uid}\n${o.allDay ? `DTSTART;VALUE=DATE:${ymd(off).replace(/-/g, "")}\nDTEND;VALUE=DATE:${ymd(off + (o.days || 1)).replace(/-/g, "")}` : `DTSTART;TZID=Asia/Seoul:${st(off, a)}\nDTEND;TZID=Asia/Seoul:${st(off, b)}`}\nSUMMARY:${o.title || "시험 " + uid}\nLOCATION:${o.loc || ""}\nDESCRIPTION:${o.desc || ""}${o.extra ? "\n" + o.extra : ""}\nEND:VEVENT`;
const cal = (...l) => `BEGIN:VCALENDAR\nVERSION:2.0\n${l.join("\n")}\nEND:VCALENDAR`;
const addCal = (name, unit = null) => Number(db.prepare("INSERT INTO calendars (name, url, color, unit_id) VALUES (?, ?, 1, ?)").run(name, "https://example.com/" + name, unit).lastInsertRowid);
const read = async (id, ...l) => { feed = cal(...l); const r = await sync.syncOne(id); assert.ok(r && (r.ok || fail), JSON.stringify(r)); return r; };
const ADMIN = { admin: 1, uid: 1, units: "[]" }, NOBODY = { admin: 0, uid: 999, units: "[]" };
const rows = () => db.prepare("SELECT count(*) AS n FROM event_edits").get().n;
const of = (id, uid, v = ADMIN) => { const x = db.prepare("SELECT * FROM calendar_events WHERE calendar_id = ? AND uid = ? ORDER BY inst").all(id, uid); const ed = edits.view(v); return x.map((r) => ed.external(r)); };
const kinds = (id, uid, v) => of(id, uid, v).map((e) => (e ? e.changes.map((c) => c.kind).join() : ""));
const lines = (off, v = ADMIN) => edits.view(v).lines(ymd(off)).map((l) => `${l.what}:${l.title}`);
const eq = (a, b, m) => { n++; assert.deepEqual(a, b, m); };

try {
  const c = addCal("시험");
  const base = (o = {}) => [ev("a", 1, "1400", "1500", o.a), ev("b", 1, "1000", "1100", o.b), ev("c", 2, "", "", { allDay: true, ...o.c }), ...Array.from({ length: 8 }, (_, i) => ev("k" + i, 3, "0900", "1000"))];
  // 배포 뒤처럼 예전 줄이 있고 기준이 없을 때 첫 읽기는 조용함
  db.prepare("INSERT INTO calendar_events (calendar_id, uid, inst, title, start_date, end_date) VALUES (?, 'a', 'old', '옛 제목', ?, ?)").run(c, ymd(1), ymd(1));
  await read(c, ...base()); eq(rows(), 0, "첫 읽기");
  const idA = db.prepare("SELECT id FROM calendar_events WHERE uid = 'a'").get().id;
  await read(c, ...base()); eq(rows(), 0, "같은 내용");
  // 설명만·띄어쓰기만 바뀐 것은 표시하지 않음
  await read(c, ...base({ a: { desc: "새 설명" }, b: { title: "시험  b" } })); eq([rows(), kinds(c, "a")], [0, [""]]);
  // 제목·장소
  await read(c, ...base({ a: { title: "새 제목", loc: "A501" } })); eq(kinds(c, "a"), ["title,place"]);
  eq(of(c, "a")[0].changes, [{ kind: "title", label: "제목", from: "시험 a", to: "새 제목" }, { kind: "place", label: "장소", from: "없음", to: "A501" }]);
  // 되돌리면 표시도 사라짐
  await read(c, ...base()); eq(kinds(c, "a"), [""]);
  // 단발 시각: 회차 키가 달라져도 수정, 같은 줄(id)
  const time = [ev("a", 1, "1600", "1700"), ...base().slice(1)];
  await read(c, ...time); eq([kinds(c, "a"), lines(1), db.prepare("SELECT id FROM calendar_events WHERE uid = 'a'").get().id], [["time"], [], idA]);
  eq(of(c, "a")[0].changes[0], { kind: "time", label: "시간", from: "14:00~15:00", to: "16:00~17:00" });
  // 날짜: 옮겨 온 날에는 수정됨, 원래 날에는 옮김 줄. 종일 → 시각 있음
  await read(c, ev("a", 2, "1600", "1700"), ...base().slice(1)); eq([kinds(c, "a"), lines(1), lines(2)], [["date,time"], ["moved:시험 a"], []]);
  eq(edits.view(ADMIN).lines(ymd(1))[0].toTime, "16:00~17:00");
  await read(c, ev("a", 2, "1600", "1700"), ev("b", 1, "1000", "1100"), ev("c", 2, "0900", "1000"), ...base().slice(3)); eq(kinds(c, "c"), ["time"]);
  // 읽기 실패·덜 읽음: 그대로, 취소 아님
  const cur = [ev("a", 2, "1600", "1700"), ev("c", 2, "0900", "1000"), ...base().slice(3)], before = rows();
  fail = "끊김"; await read(c, ...cur); fail = "";
  feed = cal(...cur).replace("END:VCALENDAR", ""); eq((await sync.syncOne(c)).ok, false);
  feed = "BEGIN:VCALENDAR\nEND:VCALENDAR"; await sync.syncOne(c); eq([rows(), lines(1)], [before, []], "빈 캘린더는 취소로 보지 않음");
  await read(c, ...base());
  // 지움: 취소됨. 되살아나면 사라짐
  await read(c, base()[0], ...base().slice(2)); eq(lines(1), ["gone:시험 b"]);
  await read(c, ...base()); eq([lines(1), kinds(c, "b")], [[], [""]]);
  // 취소 상태로 바뀐 것도 취소, 먼 날로 옮겨 가져오는 기간을 벗어난 것은 취소 아님
  await read(c, base()[0], ev("b", 1, "1000", "1100", { extra: "STATUS:CANCELLED" }), ...base().slice(2)); eq(lines(1), ["gone:시험 b"]);
  await read(c, ...base());
  await read(c, base()[0], ev("b", 700, "1000", "1100"), ...base().slice(2)); eq(lines(1), []);
  await read(c, ...base());
  // 반복: 같은 회차의 제목·장소는 표시, 이 회차만 옮김·지움은 표시, 전체 시각을 옮긴 것은 표시하지 않음
  const r = addCal("반복");
  const rep = (hm, hm2, o = {}) => ev("r", 1, hm, hm2, { ...o, extra: ["RRULE:FREQ=DAILY;COUNT=5", ...(o.ex || [])].join("\n") });
  const ride = (off, newOff, hm, hm2) => ev("r", newOff, hm, hm2, { extra: `RECURRENCE-ID;TZID=Asia/Seoul:${st(off, "1000")}` });
  await read(r, rep("1000", "1100")); await read(r, rep("1000", "1100", { loc: "B204" })); eq(kinds(r, "r"), ["place", "place", "place", "place", "place"]);
  await read(r, rep("1000", "1100")); eq(kinds(r, "r").join(""), "");
  await read(r, rep("1000", "1100"), ride(2, 2, "1300", "1400")); eq(kinds(r, "r"), ["", "time", "", "", ""]);
  await read(r, rep("1000", "1100"), ride(2, 4, "1300", "1400")); eq([kinds(r, "r")[1], lines(2)], ["date,time", ["moved:시험 r"]]);
  await read(r, rep("1000", "1100")); eq(lines(2), []);
  await read(r, rep("1000", "1100", { ex: [`EXDATE;TZID=Asia/Seoul:${st(3, "1000")}`] })); eq(lines(3).filter((x) => x.endsWith(" r")), ["gone:시험 r"]);
  await read(r, rep("1000", "1100")); const n0 = rows();
  await read(r, rep("1500", "1600")); eq([rows(), kinds(r, "r").join(""), lines(2)], [n0, "", []], "반복 전체 시각");
  await read(r, ev("x", 5, "0900", "1000")); eq([rows(), lines(2)], [n0, []], "반복 통째로 없어짐");
  // 반복이 단발로 바뀜, UID 없는 일정: 잇지 않음
  await read(r, ev("x", 5, "0900", "1000", { extra: "RRULE:FREQ=DAILY;COUNT=2", title: "딴 이름" })); eq(rows(), n0);
  await read(r, ev("y", 5, "0900", "1000").replace("UID:y\n", "")); const n1 = rows(); await read(r, ev("y", 5, "1100", "1200").replace("UID:y\n", "")); eq(rows(), n1);
  // 한꺼번에 많이 바뀜·사라짐 (공유 설정이 바뀐 것일 수 있음): 남기지 않음
  const m = addCal("많이"), many = (t, k = 50) => Array.from({ length: k }, (_, i) => ev("m" + i, 2, "0900", "1000", { title: t ? t : "회의" + i }));
  await read(m, ...many()); const n2 = rows(); await read(m, ...many("바쁨")); eq(rows(), n2); await read(m, ...many("바쁨", 10)); eq(rows(), n2);
  // 주소를 바꾸면 첫 읽기는 조용하고 예전 표시는 지움
  await read(c, ...base({ a: { title: "또 새 제목" } })); eq(kinds(c, "a"), ["title"]);
  db.prepare("UPDATE calendars SET url = 'https://example.com/new' WHERE id = ?").run(c);
  await read(c, ev("a", 1, "1400", "1500", { title: "주소 바꾼 뒤" })); eq([kinds(c, "a"), lines(1), db.prepare("SELECT count(*) AS n FROM event_edits WHERE calendar_id = ?").get(c).n], [[""], [], 0]);
  await read(c, ev("a", 1, "1400", "1500", { title: "그다음" })); eq(kinds(c, "a"), ["title"]);
  // 소속 캘린더: 다른 소속은 못 봄. 예전에 못 보던 사람에게 바뀌기 전 값은 안 보임
  const u = Number(db.prepare("INSERT INTO org_units (name) VALUES ('시험팀')").run().lastInsertRowid), u2 = Number(db.prepare("INSERT INTO org_units (name) VALUES ('다른팀')").run().lastInsertRowid);
  const IN = { admin: 0, uid: 998, units: JSON.stringify([u]) }, OTHER = { admin: 0, uid: 997, units: JSON.stringify([u2]) };
  const p = addCal("소속", u), pl = (o, k = 2) => [ev("p", 1, "1400", "1500", o), ev("q", 1, "1600", "1700"), ev("z", 9, "1600", "1700")].slice(0, 3).filter((_, i) => i !== 1 || k === 2);
  await read(p, ...pl()); await read(p, ...pl({ title: "팀만" }, 1));
  eq([kinds(p, "p", IN), kinds(p, "p", OTHER), kinds(p, "p", NOBODY)], [["title"], [""], [""]]);
  const own = (v) => lines(1, v).filter((x) => x.endsWith(" q"));
  eq([own(IN), own(OTHER), own(NOBODY)], [["gone:시험 q"], [], []]);
  db.prepare("UPDATE calendars SET unit_id = NULL WHERE id = ?").run(p); eq([kinds(p, "p", IN), kinds(p, "p", OTHER), own(OTHER)], [["title"], [""], []]);
  // 부재 캘린더: 수정됨은 보이고 옮김·취소 줄에는 없음
  const ab = addCal("부재 알림"), abl = (k) => [ev("ab1", 1 + k, "0900", "1200"), ...(k ? [] : [ev("ab2", 1, "", "", { allDay: true })]), ev("ab3", 8, "0900", "1000")];
  const l0 = lines(1).length; await read(ab, ...abl(0)); await read(ab, ...abl(1)); eq([kinds(ab, "ab1"), lines(1).length], [["date"], l0]);
  // 사이트 일정
  const E = (o = {}) => Number(db.prepare("INSERT INTO events (kind, title, start_date, end_date, start_time, end_time, location, created_by, unit_id) VALUES ('meeting', ?, ?, ?, '10:00', '11:00', '', NULL, ?)").run(o.title || "사이트 회의", ymd(1), ymd(1), u).lastInsertRowid);
  const get = (id) => db.prepare("SELECT * FROM events WHERE id = ?").get(id);
  const e1 = E(); let mk = edits.mark(get(e1)); db.prepare("UPDATE events SET description = '설명' WHERE id = ?").run(e1); edits.edited(mk); eq(edits.view(ADMIN).event(e1), null);
  mk = edits.mark(get(e1)); db.prepare("UPDATE events SET start_date = ?, end_date = ?, location = 'A501' WHERE id = ?").run(ymd(2), ymd(2), e1); edits.edited(mk);
  eq([edits.view(IN).event(e1).changes.map((x) => x.kind).join(), edits.view(OTHER).event(e1), lines(1, IN).includes("moved:사이트 회의"), lines(1, OTHER).includes("moved:사이트 회의"), lines(2, IN).includes("moved:사이트 회의")], ["date,place", null, true, false, false]);
  const e2 = E({ title: "지울 회의" }); edits.removed(get(e2)); db.prepare("DELETE FROM events WHERE id = ?").run(e2);
  eq([lines(1, IN).includes("gone:지울 회의"), lines(1, OTHER).includes("gone:지울 회의"), lines(2, IN).includes("gone:지울 회의")], [true, false, false]);
  const e3 = E({ title: "번호 이어 쓴 회의" }); eq([e3 === e2, edits.view(ADMIN).event(e3)], [true, null]); // 지운 번호를 다시 써도 수정됨이 아님
  // 우리 소속으로 넣은 일정: 원본이 바뀌면 '원본 수정됨', 맞추면 사라짐, 넣은 것이 보이면 취소 줄은 없음
  const s = addCal("원본"), sl = (o, k = 1) => [...(k ? [ev("s", 1, "1400", "1500", o)] : []), ev("s2", 9, "1400", "1500")];
  await read(s, ...sl()); const sx = db.prepare("SELECT * FROM calendar_events WHERE calendar_id = ? AND uid = 's'").get(s); const e4 = E({ title: "시험 s" });
  db.prepare("UPDATE events SET start_time = '14:00', end_time = '15:00', src_calendar_id = ?, src_uid = 's', src_inst = ? WHERE id = ?").run(s, sx.inst, e4);
  await read(s, ...sl({ loc: "B204" })); eq(edits.view(ADMIN).source(get(e4)).changes.map((x) => x.kind), ["place"]);
  db.prepare("UPDATE events SET location = 'B204' WHERE id = ?").run(e4); eq(edits.view(ADMIN).source(get(e4)), null);
  await read(s, ...sl({}, 0)); eq([edits.view(ADMIN).source(get(e4)).gone, lines(1).includes("gone:시험 s"), lines(1, NOBODY).includes("gone:시험 s")], [true, false, true]);
  // 원본이 남은 사본을 지우는 것은 취소 아님
  await read(s, ...sl()); const n3 = rows(); edits.removed(get(e4)); eq(rows(), n3);
  // 기간: 일정이 끝나면, 3일이 지나면 사라지고 30일 뒤 지움
  await read(p, ...pl({ title: "끝나는 회의" }, 1)); const t0 = clock;
  clock = Date.parse(ymd(1) + "T14:59:00+09:00"); eq(kinds(p, "p"), ["title"]);
  clock = Date.parse(ymd(1) + "T15:00:00+09:00"); eq(kinds(p, "p"), [""]);
  clock = t0; await read(p, ev("p", 1, "1400", "1500", { title: "끝나는 회의" }), ev("z", 9, "1700", "1800")); eq(kinds(p, "z"), ["time"]);
  clock = t0 + 3 * DAY - 60000; eq(kinds(p, "z"), ["time"]); clock = t0 + 3 * DAY + 60000; eq([kinds(p, "z"), rows() > 0], [[""], true]);
  clock = t0 + 31 * DAY; edits.prune(); eq(rows(), 0);
  console.log(`수정된 일정 표시 검사 통과 (${n}개)`);
} finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
