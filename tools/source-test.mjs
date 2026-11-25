#!/usr/bin/env node
// 구글 원본이 지워졌는지 판단 검사 (server/event-source.mjs · calendars.mjs). 지어낸 일정만 씀
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../server/db.mjs";
import { createEventEdits } from "../server/event-edits.mjs";
import { createEventSources, family, instDay } from "../server/event-source.mjs";
import { createCalendarSync } from "../server/calendars.mjs";

const dir = mkdtempSync(join(tmpdir(), "ps-source-"));
const db = openDb(join(dir, "t.db"));
let feed = "", fail = "", n = 0;
const sources = createEventSources(db);
const sync = createCalendarSync(db, { edits: createEventEdits(db, { log: () => {} }), sources, log: () => {}, download: async () => { if (fail) throw new Error(fail); return feed; } });
const ymd = (off) => new Date(Date.now() + 9 * 36e5 + off * 864e5).toISOString().slice(0, 10);
const st = (off, hm) => ymd(off).replace(/-/g, "") + "T" + hm + "00";
const ev = (uid, off, hm, extra = "") => `BEGIN:VEVENT\nUID:${uid}\nDTSTART;TZID=Asia/Seoul:${st(off, hm)}\nDTEND;TZID=Asia/Seoul:${st(off, String(Number(hm) + 100).padStart(4, "0"))}\nSUMMARY:시험\n${extra ? extra + "\n" : ""}END:VEVENT`;
const key = (off, hm) => "T" + new Date(`${ymd(off)}T${hm.slice(0, 2)}:${hm.slice(2)}:00+09:00`).toISOString().replace(/\.\d+Z$/, "Z");
const c = Number(db.prepare("INSERT INTO calendars (name, url, color) VALUES ('시험', 'https://example.com/a', 1)").run().lastInsertRowid);
const rest = Array.from({ length: 6 }, (_, i) => ev("k" + i, 20, "0900"));
const read = async (...l) => { feed = `BEGIN:VCALENDAR\n${l.join("\n")}\nEND:VCALENDAR`; return sync.syncOne(c); };
const copy = (uid, inst, off = 5) => Number(db.prepare("INSERT INTO events (kind, title, start_date, end_date, src_calendar_id, src_uid, src_inst, src_base) VALUES ('meeting', '사본', ?, ?, ?, ?, ?, (SELECT edit_base FROM calendars WHERE id = ?))").run(ymd(off), ymd(off), c, uid, inst, c).lastInsertRowid);
const state = (id) => db.prepare("SELECT src_state AS s FROM events WHERE id = ?").get(id).s;
const rowKey = (id) => { const r = db.prepare("SELECT x.uid, x.inst FROM events e JOIN calendar_events x ON x.id = e.src_row WHERE e.id = ?").get(id); return r ? r.uid + "|" + r.inst : null; };
const eq = (a, b, m) => { n++; assert.deepEqual(a, b, m); };
try {
  eq([family("abc_R20261112T050000@google.com"), family("abc@google.com"), instDay("T2026-11-05T16:00:00Z"), instDay("D2026-11-05")], ["abc@google.com", "abc@google.com", "2026-11-06", "2026-11-05"]);
  const R = (until, x = "") => ev("r@google.com", 1, "1000", `RRULE:FREQ=DAILY;${until != null ? "UNTIL=" + ymd(until).replace(/-/g, "") + "T145959Z" : "COUNT=10"}${x ? "\n" + x : ""}`);
  await read(ev("s", 5, "1000"), R(), ...rest);
  const s = copy("s", key(5, "1000")), r3 = copy("r@google.com", key(3, "1000")), r6 = copy("r@google.com", key(6, "1000")), old = copy("gone-before", key(5, "1000"));
  await read(ev("s", 5, "1000"), R(), ...rest); eq([state(s), state(r3), state(r6), state(old)], ["ok", "ok", "ok", "gone"], "배포 전에 지워진 것도");
  // 읽기 실패·덜 읽음·빈 캘린더: 그대로
  fail = "끊김"; await read(...rest); fail = ""; feed = `BEGIN:VCALENDAR\n${rest.join("\n")}`; await sync.syncOne(c); await read(); eq([state(s), state(r3)], ["ok", "ok"]);
  await read(ev("s", 5, "1000"), R(), ...rest);
  // 단발의 시각·날짜를 옮김: 지워짐이 아니라 바뀜, 지금 원본 줄을 앎. 되돌리면 ok
  await read(ev("s", 5, "1500"), R(), ...rest); eq([state(s), rowKey(s)], ["moved", "s|" + key(5, "1500")]);
  await read(ev("s", 9, "1500"), R(), ...rest); eq([state(s), rowKey(s)], ["moved", "s|" + key(9, "1500")]);
  await read(ev("s", 5, "1000"), R(), ...rest); eq(state(s), "ok");
  // 가져오는 기간 밖으로 옮김: 지워짐 아님
  await read(ev("s", 800, "1000"), R(), ...rest); eq(state(s), "out");
  // 지움 → 되살아남 → 취소 상태
  await read(R(), ...rest); eq(state(s), "gone"); await read(R(), ...rest); eq(state(s), "gone");
  await read(ev("s", 5, "1000"), R(), ...rest); eq(state(s), "ok");
  await read(ev("s", 5, "1000", "STATUS:CANCELLED"), R(), ...rest); eq(state(s), "gone");
  await read(ev("s", 800, "1000"), R(), ...rest); eq(state(s), "out", "기간 밖에 되살아남");
  await read(ev("s", 5, "1000"), R(), ...rest); eq(state(s), "ok");
  // 반복: 그 회차만 지움 / 그 회차만 취소 / 그 앞에서 끝남 / 전체 시각을 옮김 / 통째로 지움
  await read(R(null, `EXDATE;TZID=Asia/Seoul:${st(3, "1000")}`), ev("s", 5, "1000"), ...rest); eq([state(r3), state(r6)], ["gone", "ok"]);
  await read(R(), ev("r@google.com", 3, "1000", `RECURRENCE-ID;TZID=Asia/Seoul:${st(3, "1000")}\nSTATUS:CANCELLED`), ev("s", 5, "1000"), ...rest); eq([state(r3), state(r6)], ["gone", "ok"]);
  await read(R(), ev("r@google.com", 4, "1500", `RECURRENCE-ID;TZID=Asia/Seoul:${st(3, "1000")}`), ev("s", 5, "1000"), ...rest); eq([state(r3), state(r6)], ["ok", "ok"], "이 회차만 옮김");
  await read(R(4), ev("s", 5, "1000"), ...rest); eq([state(r3), state(r6)], ["ok", "gone"]);
  await read(ev("r@google.com", 1, "1100", "RRULE:FREQ=DAILY;COUNT=10"), ev("s", 5, "1000"), ...rest); eq([state(r3), state(r6)], ["lost", "lost"]);
  await read(ev("s", 5, "1000"), ...rest); eq([state(r3), state(r6)], ["gone", "gone"]);
  await read(R(), ev("s", 5, "1000"), ...rest); eq([state(r3), state(r6)], ["ok", "ok"]);
  // 구글이 '이 일정과 다음'을 나눔: 같은 회차가 새 UID 에 있으면 이어짐, 시각까지 바뀌었으면 모름
  const tail = (hm) => ev(`r_R${st(5, "0100")}@google.com`, 5, hm, "RRULE:FREQ=DAILY;COUNT=6");
  await read(R(4), tail("1000"), ev("s", 5, "1000"), ...rest); eq([state(r3), state(r6), rowKey(r6)], ["ok", "moved", `r_R${st(5, "0100")}@google.com|` + key(6, "1000")]);
  await read(R(4), tail("1300"), ev("s", 5, "1000"), ...rest); eq([state(r3), state(r6)], ["ok", "lost"]);
  // 반복이 단발로 바뀐 것은 잇지 않음
  await read(ev("r@google.com", 2, "1000"), ev("s", 5, "1000"), ...rest); eq([state(r3), state(r6)], ["lost", "lost"]);
  await read(R(), ev("s", 5, "1000"), ...rest);
  // 기간 밖 옛 회차: 모름. 한꺼번에 많이 사라짐: 미룸
  const past = copy("past", key(-300, "1000"), -300); await read(R(), ev("s", 5, "1000"), ...rest); eq(state(past), "out");
  await read(R()); eq(state(s), "ok", "한꺼번에 많이"); await read(R(), ev("s", 5, "1000"), ...rest);
  // 같은 캘린더의 새 주소: 이어서 판단. 다른 캘린더로 바꾼 주소: 판단하지 않음(앞서 지워진 것도)
  db.prepare("UPDATE calendars SET url = 'https://example.com/b' WHERE id = ?").run(c);
  await read(R(), ...rest); eq([state(s), state(r3), state(old)], ["gone", "ok", "gone"]);
  db.prepare("UPDATE calendars SET url = 'https://example.com/other' WHERE id = ?").run(c);
  const other = Array.from({ length: 6 }, (_, i) => ev("o" + i, 3, "0900"));
  await read(...other); eq([state(s), state(r3), state(old)], [null, null, null]); await read(...other); eq([state(s), state(r3), state(old)], [null, null, null]);
  // 다시 원래 캘린더 주소: 찾은 것은 ok
  db.prepare("UPDATE calendars SET url = 'https://example.com/b' WHERE id = ?").run(c); await read(R(), ev("s", 5, "1000"), ...rest); eq([state(s), state(r3)], ["ok", "ok"]);
  // 캘린더 등록을 지움: 모름. 같은 번호로 다른 캘린더를 새로 달아도 잇지 않음
  sources.forget(c); db.prepare("DELETE FROM calendars WHERE id = ?").run(c); eq([state(s), state(old)], [null, null]);
  db.prepare("INSERT INTO calendars (id, name, url, color) VALUES (?, '새 것', 'https://example.com/n', 1)").run(c); await read(...other); await read(...other); eq([state(s), state(old)], [null, null]);
  console.log(`원본 지워짐 판단 검사 통과 (${n}개)`);
} finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
