#!/usr/bin/env node
/*
 * server/ical.mjs 검사 (CI 에서도 실행):  node tools/ical-test.mjs
 * 종일·시간대·반복·예외·변경 회차·취소를 한 번에 확인
 */
import assert from "node:assert/strict";
import { expandCalendar } from "../server/ical.mjs";

const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Google Inc//Google Calendar 70.9054//EN
BEGIN:VTIMEZONE
TZID:Asia/Seoul
END:VTIMEZONE
BEGIN:VEVENT
DTSTART:20261028T050000Z
DTEND:20261028T060000Z
UID:utc@test
SUMMARY:UTC 회의\\, 본관
LOCATION:서울\\; 3층
DESCRIPTION:첫 줄\\n둘째 줄이 아주 길어서 줄이 접혀
  이어집니다
BEGIN:VALARM
ACTION:DISPLAY
SUMMARY:알림이라 무시
END:VALARM
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20261101
DTEND;VALUE=DATE:20261103
UID:allday@test
SUMMARY:이틀 행사
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=America/New_York:20261031T090000
DTEND;TZID=America/New_York:20261031T100000
RRULE:FREQ=WEEKLY;COUNT=3
UID:ny@test
SUMMARY:뉴욕 주간회의
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Asia/Seoul:20261102T100000
DTEND;TZID=Asia/Seoul:20261102T110000
RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261118T145959Z
EXDATE;TZID=Asia/Seoul:20261104T100000
UID:weekly@test
SUMMARY:월수 회의
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Asia/Seoul:20261111T150000
DTEND;TZID=Asia/Seoul:20261111T160000
RECURRENCE-ID;TZID=Asia/Seoul:20261111T100000
UID:weekly@test
SUMMARY:월수 회의 (시간 변경)
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Asia/Seoul:20261116T100000
RECURRENCE-ID;TZID=Asia/Seoul:20261116T100000
STATUS:CANCELLED
UID:weekly@test
SUMMARY:월수 회의
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Asia/Seoul:20260105T090000
DURATION:PT30M
RRULE:FREQ=MONTHLY;BYDAY=-1FR
UID:lastfri@test
SUMMARY:매달 마지막 금요일
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20200315
RRULE:FREQ=YEARLY
UID:bday@test
SUMMARY:기념일
END:VEVENT
BEGIN:VEVENT
DTSTART:20261029T150000Z
DTEND:20261029T160000Z
UID:midnight@test
SUMMARY:자정 넘김
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Asia/Seoul:20261130T230000
DTEND;TZID=Asia/Seoul:20261201T000000
UID:tomidnight@test
SUMMARY:자정에 끝남
END:VEVENT
BEGIN:VEVENT
DTSTART:20261029T010000Z
UID:cancel@test
STATUS:CANCELLED
SUMMARY:취소된 일정
END:VEVENT
END:VCALENDAR`.replace(/\n/g, "\r\n");

const list = expandCalendar(ics, { from: "2026-10-01", to: "2026-12-31" });
const by = (title) => list.filter((e) => e.title === title);
const one = (title) => { const l = by(title); assert.equal(l.length, 1, title); return l[0]; };

let e = one("UTC 회의, 본관");
assert.deepEqual([e.startDate, e.startTime, e.endTime, e.location], ["2026-10-28", "14:00", "15:00", "서울; 3층"]);
assert.equal(e.description, "첫 줄\n둘째 줄이 아주 길어서 줄이 접혀 이어집니다");

e = one("이틀 행사");
assert.deepEqual([e.allDay, e.startDate, e.endDate, e.startTime], [true, "2026-11-01", "2026-11-02", null]);

// 미국 서머타임이 11/1 에 끝남 → 한국 시각이 22:00 에서 23:00 으로
assert.deepEqual(by("뉴욕 주간회의").map((x) => `${x.startDate} ${x.startTime}`), ["2026-10-31 22:00", "2026-11-07 23:00", "2026-11-14 23:00"]);

// 11/2(월) 11/4(수,제외) 11/9 11/11(변경) 11/16(취소) 11/18
assert.deepEqual(by("월수 회의").map((x) => x.startDate), ["2026-11-02", "2026-11-09", "2026-11-18"]);
e = one("월수 회의 (시간 변경)");
assert.deepEqual([e.startDate, e.startTime, e.key], ["2026-11-11", "15:00", "T2026-11-11T01:00:00Z"]);

assert.deepEqual(by("매달 마지막 금요일").map((x) => `${x.startDate} ${x.startTime}-${x.endTime}`), ["2026-10-30 09:00-09:30", "2026-11-27 09:00-09:30", "2026-12-25 09:00-09:30"]);
assert.deepEqual(by("기념일").map((x) => x.startDate), []); // 3월이라 기간 밖
assert.equal(expandCalendar(ics, { from: "2026-03-01", to: "2026-03-31" }).filter((x) => x.title === "기념일")[0].startDate, "2026-03-15");

e = one("자정 넘김");
assert.deepEqual([e.startDate, e.startTime, e.endDate, e.endTime], ["2026-10-30", "00:00", "2026-10-30", "01:00"]);
e = one("자정에 끝남");
assert.deepEqual([e.startDate, e.startTime, e.endDate, e.endTime], ["2026-11-30", "23:00", "2026-11-30", "24:00"]);
assert.equal(by("취소된 일정").length, 0);

// 키가 겹치지 않아야 함 (다시 읽을 때 같은 일정으로 갱신)
assert.equal(new Set(list.map((x) => x.uid + "|" + x.key)).size, list.length);
assert.throws(() => expandCalendar("<html>로그인</html>", { from: "2026-01-01", to: "2026-01-31" }));

// 구글 캘린더가 보내는 HTML 설명은 글자만, 방 번호 같은 '<A311>' 은 그대로
const html = expandCalendar(`BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20261201\r\nUID:h@t\r\nSUMMARY:<A311>주교단 회의\r\nDESCRIPTION:<p>이재호\\, 이유담</p><br>안건 &amp\\; 일정<ul><li>하나</li></ul>\r\nEND:VEVENT\r\nEND:VCALENDAR`, { from: "2026-12-01", to: "2026-12-31" })[0];
assert.equal(html.title, "<A311>주교단 회의");
assert.equal(html.description, "이재호, 이유담\n\n안건 & 일정\n• 하나");

console.log(`iCal 검사 통과 (${list.length}개)`);
