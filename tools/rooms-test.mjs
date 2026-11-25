#!/usr/bin/env node
// 회의실 읽기 규칙 검사 (public/rooms.js). 사람 이름·실제 회의 제목은 넣지 않음
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
new Function(readFileSync(new URL("../public/rooms.js", import.meta.url), "utf8"))();
const R = globalThis.PSRooms;
let n = 0;
const plain = R.makeReader([], []);
const rooms = (title, want, o = {}) => { n++; assert.deepEqual((o.reader || plain).read({ title, location: o.location || "" }).rooms, want, title + " / " + (o.location || "")); };
const unread = (title, want, o = {}) => { n++; const r = (o.reader || plain).read({ title, location: "" }); assert.deepEqual([r.rooms, r.unread], [[], want], title); };

// 방 번호
for (const t of ["[A602] 회의", "[A602호] 회의", "[a602] 회의", "[A-602] 회의", "[A 602]회의", "회의 [A602]", "［A602］ 회의", "【A602】 회의", "[A602 대면] 회의"]) rooms(t, ["A602"]);
rooms("[A311, A301] 회의", ["A311", "A301"]); rooms("[A311, 301] 회의", ["A311", "A301"]); rooms("[A501/A502] 회의", ["A501", "A502"]); rooms("[A501][A502] 회의", ["A501", "A502"]);
rooms("[501] 회의", ["501"]); rooms("[A501호 및 A502호] 회의", ["A501", "A502"]);
// A4 소회의실: A·4·소가 모두 있는 표기
for (const t of ["A4소", "A4소회의실", "4A소", "A소4", "4A소회의실", "A4 소회의실", "a4 소", "소A4", "A-4 소회의실", "A4소회의"]) rooms(`[${t}] 회의`, ["A4 소회의실"]);
// 애매한 짧은 표기는 적힌 그대로 (묶지 않음)
for (const t of ["소4", "A소", "A4", "소401", "4층 소회의실", "4층소회의실"]) rooms(`[${t}] 회의`, [t]);
// 번호 없는 방
for (const t of ["경당", "본관 5층", "본관5층", "4층미팅룸", "커뮤회의실", "본관3층1회의실", "대회의실", "소회의실", "집무실", "강당", "대강당", "지하1층", "B동 401호", "소회의실 2"]) rooms(`[${t}] 회의`, [t]);
// 방이 아님 (조용히 뺌)
for (const t of ["참고", "답사", "서울시", "교구", "국회", "외부", "ZOOM", "Zoom", "Teams", "온라인", "2pm", "14:00", "오후 2시", "14시", "11/24", "D-100", "WYD2027", "WYD 2027", "○○수도회", "○○ 수녀회", "△△성당", "예술공연장", "아트홀", "콘서트홀", "부재", "연차", "오전반차", "출장", "재택", "미정", "취소"]) unread(`[${t}] 회의`, []);
// 모르면 읽지 못한 표기로
for (const t of ["명동사제관", "본5", "회의실", "회의실 예약", "강당 청소", "△△성당 강당", "○○대학교 3층 회의실", "다층 조사", "Q4", "중3", "홀리데이", "청년층"]) unread(`[${t}] 회의`, [t]);
unread("[가나다] [참고] 회의", ["가나다"]);
// 대괄호 없이 앞·괄호
rooms("A602 회의", ["A602"]); rooms("A602호 회의", ["A602"]); rooms("A602: 회의", ["A602"]); rooms("A501, A502 회의", ["A501", "A502"]); rooms("A501/502 회의", ["A501", "A502"]);
rooms("회의 (A501)", ["A501"]); rooms("(A501) 회의", ["A501"]); rooms("회의（A501호）", ["A501"]); rooms("회의 (A501, A502)", ["A501", "A502"]); rooms("[참고] A602 회의", ["A602"]);
for (const t of ["회의 A602 건", "2027 회의", "501 회의", "100명 모임", "A4 용지 구매", "A6021 회의", "AB602 회의", "K200 회의", "D-100 준비", "(501) 회의", "회의 (A501 논의)", "회의 (D-100)", "회의 (301명)", "A602건 정리", "WYD2027 회의", "B2 회의", "A501a 회의"]) rooms(t, []);
// 장소 칸
rooms("회의", ["A604"], { location: "A604호" }); rooms("회의", ["영성센터 B동 401호"], { location: "영성센터 B동 401호" }); rooms("회의", ["본관 5층"], { location: "본관 5층" }); rooms("회의", ["A4 소회의실"], { location: "A4소회의실" });
rooms("회의", ["A501"], { location: "A501 https://example.com/b602" });
for (const l of ["https://example.com/a123", "Microsoft Teams 모임", "○○호텔", "○○성당", "○○공원센터", "온라인 회의실", "대한민국 서울특별시 어디구 어디로 1 2층", "사람 이름"]) rooms("회의", [], { location: l });
rooms("[A501] 회의", ["A501"], { location: "A602" }); // 제목이 먼저

// 관리자 별명·회의실 아님
const ad = R.makeReader(["A604호", "A4 소회의실 = A4소, 4A소, 4층 소회의실, 소4", "본관 5층 = 본5", "사제관 = 명동사제관", "영성센터 B동 401호"], ["회의실 예약", "A4", "가나다"]);
assert.deepEqual(ad.listed, ["A604", "A4 소회의실", "본관 5층", "사제관", "영성센터 B동 401호"]);
for (const [t, w] of [["A604", "A604"], ["4층소회의실", "A4 소회의실"], ["소4", "A4 소회의실"], ["A소4", "A4 소회의실"], ["본5", "본관 5층"], ["본관5층", "본관 5층"], ["명동 사제관", "사제관"]]) rooms(`[${t}] 회의`, [w], { reader: ad });
rooms("[A소] 회의", ["A소"], { reader: ad });
for (const t of ["회의실예약", "A4", "가 나다"]) unread(`[${t}] 회의`, [], { reader: ad });
rooms("회의", ["사제관"], { reader: ad, location: "명동사제관 안" });
// 다른 이름의 방에 흔한 표기를 별명으로 적으면 같은 방으로 읽히는 표기도 따라감 / 번호도 별명이 됨
const ad2 = R.makeReader(["4층 작은방 = A4소", "대강당 = A501, 501호"], []);
for (const t of ["A4소", "4A소회의실", "A4 소회의실"]) rooms(`[${t}] 회의`, ["4층 작은방"], { reader: ad2 });
for (const t of ["A501", "a-501호", "501호"]) rooms(`[${t}] 회의`, ["대강당"], { reader: ad2 });
rooms("A501 회의", ["대강당"], { reader: ad2 });

// 하루 모음: 방·건수·읽지 못한 표기, 글자 없는 번호, 부재 캘린더
const E = (title, startTime, endTime, o = {}) => ({ title, startDate: "2026-01-05", endDate: "2026-01-05", startTime, endTime, location: "", ...o });
const day = [E("[A501, A502] 가", "10:00", "11:00"), E("[501] 나", "11:00", "12:00"), E("[본관 5층] 다", "", ""), E("[본관5층] 라", "", ""), E("[명동사제관] 마", "", ""), E("[A301] 부재", "09:00", "18:00", { calendarId: 2 }), E("[명동사제관][경당] 부재", "", "", { calendarId: 2 })];
const b = plain.board(day, { noRoom: (e) => R.isAbsenceCalendar(e.calendarId === 2 ? "부재 알림" : "") });
assert.deepEqual(b.rooms, ["A501", "A502", "본관 5층"]);
assert.deepEqual([b.events, b.usedRooms, b.byRoom.get("A501").length, b.byRoom.get("본관 5층").length], [4, 3, 2, 2]);
assert.deepEqual(b.unread, [{ name: "명동사제관", n: 1 }]);
const b2 = R.makeReader(["A603", "A501"], []).board([E("[501] 가", "10:00", "11:00")]);
assert.deepEqual([b2.rooms, b2.usedRooms, b2.events], [["A501", "A603"], 1, 1]);
for (const [x, w] of [["부재 알림", true], ["휴가", true], ["팀 일정", false], ["", false]]) assert.equal(R.isAbsenceCalendar(x), w);

// 층 → 번호 → 앞 글자. 번호 없는 방은 그 층 뒤, 층을 모르면 맨 뒤, 관리자가 적은 층이 먼저
for (const [x, w] of [["A501", 5], ["A 602호", 6], ["501", 5], ["A4 소회의실", 4], ["4A소회의실", null], ["본관 5층", 5], ["지하1층", -1], ["B동 401호", 4], ["소401", 4], ["4층미팅룸", 4], ["경당", null], ["소4", null], ["커뮤회의실", null], ["A1004", null]]) { n++; assert.equal(R.floorOf(x), w, x); }
assert.deepEqual(R.sortRooms(["경당", "A303", "B301", "A4 소회의실", "A301", "B204", "본관 5층", "A501", "B501", "지하1층", "커뮤회의실"], () => null), ["지하1층", "B204", "A301", "B301", "A303", "A4 소회의실", "A501", "B501", "본관 5층", "경당", "커뮤회의실"]);
assert.deepEqual(R.sortRooms(["경당", "A303", "A501"], (x) => ({ 경당: 4, A501: 2 })[x] ?? null), ["A501", "A303", "경당"]);
// 방 정보: 목록에 적은 이름·별명으로 이어지고, 층은 정렬에 씀
const inf = R.makeReader(["A604호", "A4소 = 4층 소회의실", "유리방 = 교구본관5층", "A301"], [], [{ name: "A604호", floor: null, monitor: "yes", seats: "40명 이상", note: "빔" }, { name: "A4소", floor: 4, monitor: "check", seats: "", note: "" }, { name: "유리방", floor: 5, monitor: "no", seats: "10명", note: "" }]);
assert.deepEqual([inf.infoOf("A604").seats, inf.infoOf("A4 소회의실").monitor, inf.infoOf("유리방").floor, inf.infoOf("A301"), inf.infoOf("A602")], ["40명 이상", "check", 5, null, null]);
assert.deepEqual(inf.board([E("[교구본관5층] 가", "", ""), E("[A4소] 나", "", ""), E("[A602] 다", "", "")]).rooms, ["A301", "A4 소회의실", "유리방", "A602", "A604"]);

// 겹침
const ov = (...l) => { const r = R.overlaps(l, "2026-01-05"); return [r.clash, r.dup, l.map((e) => r.of.get(e) || "")]; };
assert.deepEqual(ov(E("가", "13:30", "15:30"), E("나", "14:00", "17:00")), [1, 0, ["clash", "clash"]]);
assert.deepEqual(ov(E("가", "15:00", "16:00"), E("나", "16:00", "17:00")), [0, 0, ["", ""]]);
assert.deepEqual(ov(E("가 회의", "15:00", "16:00"), E("가회의", "15:00", "16:00")), [0, 1, ["dup", "dup"]]);
assert.deepEqual(ov(E("가", "15:00", "16:00"), E("가", "15:00", "16:00"), E("나", "15:30", "16:30")), [1, 0, ["clash", "clash", "clash"]]);
assert.deepEqual(ov(E("가", "15:00", "16:00"), E("가", "15:00", "17:00")), [1, 0, ["clash", "clash"]]);
assert.deepEqual(ov(E("가", "09:00", "10:00"), E("나", "09:30", "10:30"), E("다", "13:00", "14:00"), E("라", "13:30", "15:00")), [2, 0, ["clash", "clash", "clash", "clash"]]);
assert.deepEqual(ov(E("가", "09:00", ""), E("나", "09:30", "10:00"), E("다", "", "")), [0, 0, ["", "", ""]]);
console.log(`회의실 읽기 검사 통과 (${n}개 표기)`);
