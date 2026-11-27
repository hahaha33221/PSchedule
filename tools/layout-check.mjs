// 반응형 검사: 역할마다 화면·입력 판을 360·390·768·1024·1440px 로 열어 화면 밖으로 넘치거나 잘리는 것이 있는지 봄
//   node tools/layout-check.mjs [--shots=폴더] [--role=dept] [--only=글자] [--widths=360,390] [--focus=css] [--ls=키=값]
//   --focus: 찍기 전에 그 칸이 보이게 내림 · --ls: 찍기 전에 이 기기 설정(localStorage)을 넣음 (예: ps.findOpen=0)
// 크롬(headless)이 있어야 함. 임시 DB 에 지어낸 긴 글자 자료를 넣고 검사한 뒤 지움 (운영·내 개발 DB 는 건드리지 않음)
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const opt = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const WIDTHS = (opt("widths") || "360,390,768,1024,1440").split(",").map(Number);
const SHOTS = opt("shots"), ONLY = opt("only"), ROLE = opt("role"), FOCUS = opt("focus"), LS = opt("ls"); // --role=dept (예전 화면은 dept0, 새 메뉴는 dept3)
const CHROME = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => p && existsSync(p));
if (!CHROME) { console.error("크롬을 찾을 수 없어요. CHROME_PATH 로 알려 주세요."); process.exit(2); }
const ROOT = resolve(import.meta.dirname, ".."), TMP = mkdtempSync(join(tmpdir(), "ps-layout-"));
const PORT = 18000 + Math.floor(Math.random() * 1000), B = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server/index.mjs"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, PORT: String(PORT), DATA_DIR: join(TMP, "db"), STATIC_DIR: join(ROOT, "public"), ADMIN_PASSWORD: "layout-check-1", BACKUP_KEEP_DAYS: "0" } });
let chrome, done = false;
const stop = () => { if (done) return; done = true; server.kill(); chrome?.kill("SIGKILL"); try { rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 임시 폴더 */ } };
process.on("exit", stop);
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => process.exit(1));

for (let i = 0; ; i++) { try { if ((await fetch(`${B}/api/health`)).ok) break; } catch { /* 아직 */ } if (i > 60) throw new Error("서버가 안 떠요"); await sleep(200); }
const db = new DatabaseSync(join(TMP, "db/pschedule.db"));
db.exec("PRAGMA busy_timeout = 5000");
let admin;
const call = async (path, method = "GET", body, token = admin) => {
  const r = await fetch(`${B}/api${path}`, { method, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
};
const post = (p, b, t) => call(p, "POST", b, t);
admin = (await (await fetch(`${B}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "master", password: "layout-check-1" }) })).json()).token;

/* ---- 지어낸 자료 (긴 이름·큰 수) ---- */
const LONG = "아주긴이름의거룩한시험수도자매공동체서울관구분원", PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const unit = (await call("/me")).units.find((u) => u.name === "기념품팀")?.id ?? (await post("/admin/units", { name: "기념품팀", parentId: null })).id;
const mk = async (login, name, kinds, leader) => {
  await post("/admin/users", { login, name, ...(kinds ? { role: "volunteer" } : { unitId: unit }) });
  const id = (await call("/admin/users")).users.find((u) => u.login === login).id;
  if (kinds) await call(`/admin/users/${id}`, "PATCH", { role: "volunteer", volKinds: kinds, volLeader: !!leader });
  db.prepare("UPDATE users SET pw_changed = 1 WHERE id = ?").run(id);
  return id;
};
const ids = { admin: 1, staff: await mk("lc-staff", "직원시험"), dept: await mk("lc-dept", "부서봉사자시험긴이름", ["dept"]), team: await mk("lc-team", "팀봉사자시험", ["team"]), leader: await mk("lc-lead", "리더시험", ["team"], true) };
db.exec("UPDATE users SET pw_changed = 1");
const tok = {};
for (const [k, id] of Object.entries(ids)) {
  tok[k] = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, vol_mode, remember) VALUES (?, ?, ?, ?, 1)").run(createHash("sha256").update(tok[k]).digest("hex"), id, Date.now() + 864e5, k === "dept" ? "dept" : k === "team" || k === "leader" ? "team" : "");
}
const pj = (await post("/projects", { name: "기념품 시험 프로젝트", unitId: unit })).project.id;
const item = async (name) => (await post(`/projects/${pj}/items`, { kind: "group", name })).items.find((i) => i.name === name).id;
const gid = await item("묵주"); const cross = await item("손십자가");
const led = await post(`/project-items/${gid}/ledgers`, { name: "묵주 실타래 입출고 대장", unit: "타래", contract: 100000, options: ["빨강", "진한 파랑", "흰색", "초록", "노랑", "보라", "아주 긴 품목 이름의 특수 색상"] });
const day = (n) => new Date(Date.now() + 9 * 36e5 + n * 864e5).toISOString().slice(0, 10);
const opts = led.options || (await call(`/stock/${led.ledger.id}`)).options;
for (let i = 0; i < 8; i++) await post(`/stock/${led.ledger.id}/moves`, { type: i < 5 ? "in" : "out", date: day(-i), qty: Object.fromEntries(opts.slice(0, 3).map((o) => [o.id, 12345 - i * 1000])), handler: "전달자 긴 이름 시험", note: "길고 긴 비고 글자가 여러 줄로 이어지는 경우를 보려는 시험 글", issue: i === 1 ? "이슈가 있어요. 박스가 젖어 왔어요." : "" });
const edu = [];
for (let i = 0; i < 6; i++) edu.push((await post("/team/orgs", { org: i ? `시험수도회${i}` : LONG, date: day(i < 3 ? -20 + i : 5 + i), startTime: "14:00", qty: 1234 * (i + 1) })).id);
const org = async (id) => (await call("/team/orgs")).orgs.find((o) => o.id === id);
await call(`/team/orgs/${edu[0]}`, "PATCH", { status: "done", attend: 23, resultNote: "특이사항 긴 글", madeQty: 1200, madeDue: "다음 달 초" });
await call(`/team/orgs/${edu[1]}`, "PATCH", { status: "delay" });
await post(`/team/orgs/${edu[0]}/inquiries`, { date: day(0), question: "완성 묵주를 언제까지 보내야 하는지 물어보셨어요. 길게 적은 문의예요." });
const mid = (await org(edu[0])).monasteryId ?? db.prepare("SELECT monastery_id AS m FROM vol_schedules WHERE id = ?").get(edu[0]).m;
await call(`/ops/monasteries/${mid}`, "PATCH", { phone: "02-0000-0000", contactName: "담당자 시험 이름", address: "서울특별시 어느구 어느길 123-45 아주 긴 건물 이름 3층 301호", note: "메모" });
for (const [dir, kind, status] of [["in", "inspect", "sent"], ["in", "inspect", "arrived"], ["in", "material_done", "ready"], ["in", "vendor", "returned"], ["out", "material_make", "ready"], ["out", "return", "sent"]])
  await post("/ops/shipments", { direction: dir, kind, partyType: kind === "vendor" ? "etc" : "monastery", partyName: kind === "vendor" ? "어느업체" : "", monasteryId: kind === "vendor" ? null : mid, status, qty: 1234, contents: "완성 묵주와 남은 실, 십자가 여러 상자", carrier: "아주긴택배회사이름", trackingNo: "123456789012345678", address: "서울특별시 어느구 어느길 123-45 아주 긴 건물 이름 3층 301호", note: "긴 메모 글자" });
await post("/team/recovery", { scheduleId: edu[0], date: day(-3), qty: 900, method: "visit", note: "직접 받음" });
await post("/ops/criteria-photos", { kind: "good", key: "knot", data: PNG }).catch(() => {});
const grp = (await post("/ops/groups", { name: "1조", leaderId: ids.leader, memberIds: [ids.team, ids.leader], active: true, note: "월요일 오전" })).groups[0].id;
await post(`/ops/groups/${grp}/assigns`, { scheduleId: edu[0], qty: 500, dueDate: day(7), note: "먼저" }).catch(() => {});
await post("/team/shifts", { date: day(4), startTime: "10:00", need: 5, note: "장소: 시험 건물 2층" });
await post("/team/daily", { date: day(-1), qty: 321, workers: "시험하나, 시험둘, 시험셋", note: "메모" });
await post("/admin/inspections", { itemId: gid, stage: 3, date: day(-1), source: LONG, checkedQty: 300, defects: { knot: 7 }, note: "불량 메모" }).catch(() => post("/admin/inspections", { itemId: gid, stage: 3, date: day(-1), source: LONG, checkedQty: 300 }));
await post("/team/issues", { kind: "thread", title: "실이 자주 끊어진다는 연락이 여러 곳에서 왔어요", body: "긴 내용" });
await post("/ops/contacts", { targetType: "monastery", monasteryId: mid, date: day(-2), method: "phone", purpose: "recovery", content: "묵주를 보내 달라고 안내", followUp: "도착하면 확인 전화", dueDate: day(-1) });
await post("/ops/purchases", { itemName: "대형 비닐팩", qty: 1000, unit: "장", amount: 1234567 }).catch(() => {});
await post("/volunteer/records", { itemId: gid, kind: "recovery", stage: "in", date: day(-1), name: LONG, qty: 12345, note: "메모" });
await post("/volunteer/records", { itemId: cross, kind: "recovery", stage: "in", date: day(-1), name: "", qty: 123, note: "" });
await post("/notices", { title: "긴 제목의 공지입니다 모두 읽어 주세요", body: "내용", audience: "all" });
const bp = (await post("/board", { title: "게시판 글 제목", body: "내용" })).id;
await post("/admin/vol-trainings", { title: "기본 교육", body: "내용", date: day(3) });
await post("/admin/vol-schedules", { title: "포장 봉사", date: day(2), startTime: "10:00", audience: "all", place: "시험 건물" });
await post("/team/docs", { category: "inspect", title: "검수 기준 자료", url: "https://example.com/a/very/long/path/that/does/not/break/easily", note: "설명" });
await call("/ops/perms", "PUT", { staffOn: true });
// 회의실 예약 현황: 방 12곳 이상·시간 겹침·중복·읽지 못한 표기·부재 캘린더
const rv = (title, startTime, endTime, location = "") => post("/events", { kind: "meeting", title, startDate: day(0), endDate: day(0), startTime, endTime, location, unitId: unit });
for (const [t, a, b] of [["[A501] 첫 회의 이름이 아주 길어서 잘려야 하는 시험 회의", "13:30", "15:30"], ["[A501호] 두 번째 시험 회의", "14:00", "17:00"], ["[A602] 같은 시험 회의", "10:00", "11:00"], ["[A602] 같은 시험 회의", "10:00", "11:00"], ["[A301] 앞", "06:00", "07:00"], ["[A301] 뒤", "07:00", "08:00"], ["[A4소] 짧은 회의", "08:00", "08:15"], ["[4A소회의실] 겹치는 짧은 회의", "08:00", "08:15"], ["[A311, A601] 두 방", "09:00", "10:00"],
  ["[A603][가나다라마바사] 시험", "11:00", "12:00"], ["A604 앞에 적은 방", "", ""], ["괄호에 적은 방 (B204)", "12:00", "13:00"], ["[본관 아주긴이름의시험용건물 지하1층] 시험", "", ""], ["[커뮤회의실] 시험", "17:00", "18:00"], ["[경당] 시험", "", ""], ["[대회의실] 시험", "18:00", "21:30"], ["[읽지못하는아주긴표기이름의시험건물과사제관] 시험", "", ""]]) await rv(t, a || null, b || null);
const cal = Number(db.prepare("INSERT INTO calendars (name, url, color) VALUES ('부재 알림', 'https://example.com/none.ics', 3)").run().lastInsertRowid);
for (const [t, i] of [["[A302] 부재 시험", 1], ["[가나다] 부재 시험", 2]]) db.prepare("INSERT INTO calendar_events (calendar_id, uid, inst, title, start_date, end_date, start_time, end_time) VALUES (?, ?, 'x', ?, ?, ?, NULL, NULL)").run(cal, "u" + i, t, day(0), day(0));
// 부재 0건(오늘+6)·5건(+1)·20건(+2): 종일·여러 날·시간 지정·여러 명·못 나누는 제목
const abs = (d, i, t, o = {}) => db.prepare("INSERT INTO calendar_events (calendar_id, uid, inst, title, start_date, end_date, start_time, end_time) VALUES (?, ?, 'x', ?, ?, ?, ?, ?)").run(cal, `ab${d}-${i}`, t, day(d + (o.from || 0)), day(d + (o.to || 0)), o.a || null, o.b || null);
for (const d of [1, 2]) for (let i = 0; i < (d === 1 ? 5 : 20); i++) {
  if (i === 0) abs(d, i, "이재호_연차"); else if (i === 1) abs(d, i, "시험가나, 시험다라, 시험마바, 시험사아, 시험자차, 시험카타_오후 반반차", { a: "21:00", b: "23:00" });
  else if (i === 2) abs(d, i, "Fr. 시험파하 휴가", { from: 0, to: 0 }); else if (i === 3) abs(d, i, "[시험]나눌 수 없는 아주 긴 제목의 부재 알림 한 줄-어디어디 다녀옴(09~18)"); else abs(d, i, `시험사람${"가나다라"[i % 4]}_오전반차`, i === 4 ? { a: "06:00", b: "08:00" } : {});
}
db.prepare("UPDATE calendar_events SET start_date = ?, end_date = ? WHERE uid = 'ab2-2'").run(day(2), day(4));
// 구글 원본이 지워진 일정: 오늘·내일, 시각 있음·종일·겹침·짧음
for (const [d, t, a, b] of [[0, "[A204] 원본이 지워진 아주 긴 이름의 회의라서 좁은 칸에서는 잘려야 하는 시험", "20:00", "21:00"], [0, "이재호 원본 지워진 종일", null, null], [1, "[A204] 원본이 지워진 아주 긴 이름의 회의라서 잘려야 함", "13:00", "14:00"], [1, "[A205] 짧게 지워짐", "08:00", "08:20"], [1, "[A205] 겹친 짧은 것", "08:00", "08:20"], [1, "이재호 원본 지워진 종일", null, null]]) {
  const x = (await post("/events", { kind: "meeting", title: t, startDate: day(d), endDate: day(d), startTime: a, endTime: b, unitId: unit, attendeeIds: [ids.staff] })).event.id;
  if (!t.includes("겹친")) db.prepare("UPDATE events SET src_calendar_id = ?, src_uid = ?, src_inst = 'x', src_state = 'gone', src_snapshot = ? WHERE id = ?").run(cal, "gone" + x, JSON.stringify({ calendarName: "WYD" }), x);
}
// 수정된 일정: 수정됨·날짜 바뀜, 시간 겹침과 함께, 옮김·취소 줄
const evs = (await call(`/events?from=${day(0)}&to=${day(0)}`)).events, evId = (t) => evs.find((e) => e.title.includes(t)).id;
await call(`/events/${evId("두 번째 시험")}`, "PATCH", { location: "본관 5층" });
await call(`/events/${evId("겹치는 짧은")}`, "PATCH", { title: "[4A소회의실] 겹치는 짧은 회의 제목도 고침" });
await call(`/events/${evId("[경당]")}`, "PATCH", { title: "[경당] 시험 제목 바꿈" });
const mv = async (title, from, b, extra) => { const id = (await post("/events", { kind: "meeting", title, startDate: from, endDate: from, startTime: "19:00", endTime: "20:00", unitId: unit, ...extra })).event.id; if (b) await call(`/events/${id}`, "PATCH", b); else await call(`/events/${id}`, "DELETE"); return id; };
// 내일 화면: 아직 안 끝난 일정이라 표시가 늘 보임 (오늘은 검사하는 시각에 따라 다름)
for (const [t, a, b, p2] of [["[A501] 겹치고 고친 회의 이름이 아주 길어서 잘려야 함", "10:00", "11:00", { location: "본관 5층" }], ["[A501] 겹친 다른 회의", "10:30", "12:00", { endTime: "12:30" }], ["[A602] 같은 시험", "14:00", "15:00", { location: "본관" }], ["[A602] 같은 시험", "14:00", "15:00", null], ["[A301] 짧은 시험", "16:00", "16:15", { endTime: "16:20" }], ["[경당] 종일 시험", null, null, { title: "[경당] 종일 시험 이름 바꿈" }]]) {
  const x = (await post("/events", { kind: "meeting", title: t, startDate: day(1), endDate: day(1), startTime: a, endTime: b, unitId: unit })).event.id;
  if (p2) await call(`/events/${x}`, "PATCH", p2);
}
// 오늘의 일정: 긴 장소 이름(넓은 칸·짧은 칸, 오늘·내일) — 칸 안에서 … 로 줄어야 함
for (const d of [0, 1]) for (const [t, a, b] of [["장소 긴 시험", "21:30", "23:00"], ["장소 긴 짧은 시험", "23:00", "23:15"]])
  await post("/events", { kind: "meeting", title: t, startDate: day(d), endDate: day(d), startTime: a, endTime: b, unitId: unit, location: "본관 아주긴이름의시험용건물 지하1층 대강당 옆 작은 회의실과 그 옆방" });
// 이름으로 모아 보기(내일): 시간이 겹치고 고친 일정(바뀐 것 3가지 → '외 1'), 겹치지 않고 고친 일정
for (const t of [admin, tok.staff]) await call("/today-keywords", "PUT", { keywords: ["시험검색"] }, t);
for (const [t, a, b, p2] of [["시험검색 겹치고 고친 회의", "15:30", "16:30", { startTime: "16:30", endTime: "17:30", location: "본관 시험실", title: "시험검색 겹치고 고친 회의 제목 바꿈 잘려야 함" }], ["시험검색 겹친 다른 회의", "17:00", "18:00"], ["시험검색 따로 고친 회의", "08:00", "09:00", { location: "별관" }]]) {
  const x = (await post("/events", { kind: "meeting", title: t, startDate: day(1), endDate: day(1), startTime: a, endTime: b, unitId: unit })).event.id;
  if (p2) await call(`/events/${x}`, "PATCH", p2);
}
await mv("[A103] 내일로 옮겨 온 이재호 회의", day(5), { startDate: day(1), endDate: day(1) });
await mv("내일에서 다른 날로 옮긴 아주 긴 제목의 회의 이름이 두 줄로 넘어가는지 보는 시험", day(1), { startDate: day(3), endDate: day(3) });
await mv("내일 취소한 회의 시험", day(1));
await mv("[A103] 옮겨 온 이재호 회의", day(2), { startDate: day(0), endDate: day(0), startTime: "21:00", endTime: "21:30" });
await mv("다른 날로 옮긴 아주 긴 제목의 회의 이름이 두 줄로 넘어가는지 보는 시험", day(0), { startDate: day(3), endDate: day(3) }, { startTime: "23:00", endTime: "23:50" });
await mv("취소한 회의 시험", day(0), null, { startTime: "23:00", endTime: "23:50" });
await call("/admin/rooms", "PUT", { rooms: ["A604호", "A4 소회의실 = 4층 소회의실", "비어 있는 아주 긴 이름의 회의실 이름", "A501", "A602", "B204"], skip: [], info: [{ name: "A604호", floor: 6, monitor: "yes", seats: "40명 이상", note: "빔프로젝터" }, { name: "A4 소회의실", floor: 4, monitor: "no", seats: "12명", note: "화이트보드 있음, 아주 긴 비고를 적었을 때도 화면 밖으로 넘치지 않는지 보는 시험" }, { name: "A501", monitor: "check", seats: "", note: "미방문" }, { name: "B204", monitor: "yes", seats: "20명 이상 30명까지도 가능함", note: "" }] });
// steps: true 단계형 메뉴 · false 예전 메뉴 · "nav3" 새 메뉴(묵주 관리 분류)
const setMenu = (steps) => call("/admin/vol-menu", "PUT", { menu: ["home", "schedule", "training", "notices", "wbs", "req", "in", "out", "recovery", "moves2", ...(steps ? ["steps2"] : []), ...(steps === "nav3" ? ["nav3"] : [])] });
const sfx = (steps) => (steps === "nav3" ? "3" : steps ? "" : "0"), tag = (steps) => (steps === "nav3" ? "(새 메뉴)" : steps ? "" : "(예전)");

/* ---- 볼 화면: 주소와 눌러 열 것(글자) ---- */
const TEAM = ["thome", "alerts", "tcal", "tedu1", "tedu2", "tmake1", "tmake2", "tins1", "tins2", "tins3", "tins4", "tins5", "vschedule", "tissues", "vboard", `vboard/${bp}`, "vnotices", "vcontacts"];
const DEPT3 = ["vhome", "n3-thread-in", "n3-cut-in", "n3-cross-in", "ds1", "n3-thread-out", "n3-cut-out", "n3-cross-out", "df1", "n3-r-ins", "n3-r-ins/bad", "n3-r-pack", "n3-r-out", "df2", "n3-c-ins", "n3-c-ins/bad", "n3-c-pack", "n3-c-out", "dr1", "ds3", "dr2", "ds2", "vcontacts", "vissues"]; // vissues: 새 메뉴에는 없지만 주소로는 열림
const DEPT = ["vhome", "alerts", "dr1", "dr2", "ds1", "ds2", "ds3", "df1", "df2", "vcontacts", "vtraining", "vissues", "vboard", "vnotices"];
const OPS = ["dash", "mon", "ship-in", "ship-out", "stock", "cut", "buy", "contacts", "groups", "criteria", "duties"].map((k) => `ops/${k}`);
const STAFF = ["today", `today/${day(1)}`, `today/${day(2)}`, `today/${day(6)}`, "dashboard", "tasks", "meetings", "memos", "projects", `projects/${pj}`, "stock", `stock/${led.ledger.id}`, "alerts", "notices", "orgchart", "contacts"];
const RUNS = [
  ["leader", true, TEAM], ["team", true, ["tedu1", "tedu2", "tmake2", "tins1"]], ["dept", true, DEPT], ["dept", "nav3", DEPT3], ["leader", "nav3", ["thome", "tedu1", "tmake1", "tins3", "tins5", "tissues"]],
  ["admin", true, ["alerts", "members", "org", "backup", "board", "volunteers", ...["edu", "roster", "issue", "training", "stock", "records", "inspect", "team", "wbs", "menu"].map((k) => `volunteers/${k}`), ...OPS, "ops/perms", ...STAFF.slice(0, 9)]],
  ["staff", true, [...STAFF, ...OPS.slice(0, 5)]],
  ["leader", false, ["thome", "alerts", "torgs", "trecov", "tinsp/records", "tinsp/shifts", "tissues", "tinsp/guide"]],
  ["dept", false, ["vhome", "alerts", "vschedule", "vp/rosary", "vp/rosary/in", "vp/rosary/out", "vp/rosary/req", "vp/rosary/wbs", "vp/rosary/recovery", "vp/cross/recovery", "vstock"]]
];

// 없앤 화면의 예전 주소는 홈으로
const GONE = { leader: ["tdocs", "vdeadlines"], dept: ["tdocs", "vdeadlines"], admin: ["volunteers/deadlines"] }, HOME = { leader: "#/thome", dept: "#/vhome", admin: "#/volunteers" };

/* ---- 크롬 (CDP) ---- */
chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${join(TMP, "chrome")}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const wsUrl = await new Promise((ok, no) => { let t = ""; chrome.stderr.on("data", (c) => { t += c; const m = t.match(/ws:\/\/\S+/); if (m) ok(m[0]); }); setTimeout(() => no(new Error("크롬이 안 떠요")), 20000); });
const port = new URL(wsUrl).port;
const page = (await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json()).webSocketDebuggerUrl;
const ws = new WebSocket(page);
await new Promise((r) => ws.addEventListener("open", r));
let seq = 0; const wait = new Map(), errors = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id) { wait.get(m.id)?.(m.result || {}); wait.delete(m.id); }
  else if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  else if (m.method === "Page.javascriptDialogOpening") cdp("Page.handleJavaScriptDialog", { accept: false });
});
const cdp = (method, params = {}) => new Promise((ok) => { const id = ++seq; wait.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval"); return r.result?.value; };
await cdp("Page.enable"); await cdp("Runtime.enable");
// 화면 밖으로 나간 요소: 옆으로 밀어 보는 칸(표·단계 띠) 안의 것은 뺌. 글자가 칸 밖으로 잘린 단추·입력 칸도 봄
const FIND = `(() => {
  const W = document.documentElement.clientWidth, out = [];
  const dlg = document.querySelector("dialog[open]");
  const root = dlg || document.querySelector(".content") || document.body;
  if (document.documentElement.scrollWidth > W + 1) out.push("가로 스크롤 " + document.documentElement.scrollWidth + "px");
  const name = (e) => e.tagName.toLowerCase() + (typeof e.className === "string" && e.className ? "." + e.className.trim().split(/\\s+/).slice(0, 2).join(".") : "") + " '" + (e.innerText || e.value || e.placeholder || "").replace(/\\s+/g, " ").slice(0, 18) + "'";
  const scrolls = (e) => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if ((o === "auto" || o === "scroll") && p.scrollWidth > p.clientWidth + 1 && !p.matches(".content, main, dialog, .dialog, .modal")) return true; if (o === "hidden" || o === "clip") { const r = p.getBoundingClientRect(); if (r.right <= W + 1 && r.left >= -1) return "clip"; } } return false; };
  for (const e of root.querySelectorAll("*")) {
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height || e.closest("[hidden], .sr-only, svg")) continue;
    const cs = getComputedStyle(e);
    if (cs.visibility === "hidden" || cs.position === "fixed") continue;
    if ((r.right > W + 1.5 || r.left < -1.5) && !scrolls(e)) { out.push("밖으로 " + Math.round(r.left) + "~" + Math.round(r.right) + " " + name(e)); }
    else if (e.matches("button, .btn, .pick-tile, .seg__link, h1, h2, .vm-tag, .nav-badge") && e.scrollWidth > e.clientWidth + 2 && cs.overflowX !== "visible" && cs.textOverflow !== "ellipsis" && cs.overflowX !== "auto" && e.clientWidth > 0 && cs.display !== "inline") out.push("글자 잘림 " + name(e));
    if (out.length > 5) break;
  }
  if (dlg) { const r = dlg.getBoundingClientRect(); if (r.left < -1 || r.right > W + 1) out.push("창이 밖으로"); if (r.bottom > innerHeight + 1 && getComputedStyle(dlg).overflowY !== "auto" && !dlg.querySelector("*")) out.push("창 아래가 잘림"); }
  return out;
})()`;
const settle = async () => { let prev = ""; for (let i = 0; i < 25; i++) { await sleep(90); const cur = await ev(`document.querySelector("main")?.querySelector(".loading, .spinner") ? "..." + Math.random() : String(document.querySelector("main")?.innerHTML.length || 0)`); if (cur === prev && cur !== "0") return; prev = cur; } };
const problems = new Map(); let views = 0, dialogs = 0, clicks = 0;
const note = (key, w, list) => { for (const p of new Set(list)) { const k = `${key} │ ${p.replace(/밖으로 -?\\d+~-?\\d+/, "밖으로")}`; problems.set(k, [...(problems.get(k) || []), w]); } };
// 부서 봉사자의 검수 기록: 새 메뉴(nav3)를 켰을 때만 팀과 같은 검수 기록을 보고 적음
{
  const st = async (path, method = "GET", body) => (await fetch(`${B}/api${path}`, { method, headers: { Authorization: `Bearer ${tok.dept}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).status;
  await setMenu(true);
  const off = [await st("/team/inspections"), await st("/team/inspections", "POST", {})];
  await setMenu("nav3");
  const on = [await st("/team/inspections"), await st("/team/inspections", "POST", {}), await st("/team/daily")];
  if (off.some((x) => x !== 403)) note("부서 봉사자 검수 API(새 메뉴 꺼짐)", 0, [`막히지 않음 ${off}`]);
  // 손십자가 검수: 부서도 적을 수 있고, 변경 숫자는 부서 '완제품 › 손십자가 › 검수'(n3-c-ins)에, 묵주는 n3-r-ins 에
  const mineCross = await st("/team/inspections", "POST", { itemId: cross, stage: 3, date: day(0), source: "시험 손십자가 검수", checkedQty: 40, defects: {} });
  await post("/admin/inspections", { itemId: cross, stage: 3, date: day(0), source: "관리자 손십자가 검수", checkedQty: 20, defects: {} });
  await post("/admin/inspections", { itemId: gid, stage: 3, date: day(0), source: "관리자 묵주 검수", checkedQty: 20, defects: {} });
  const cnt = (await call("/changes", "GET", null, tok.dept)).counts;
  if (mineCross !== 201 || !cnt["n3-c-ins"] || !cnt["n3-r-ins"]) note("부서 봉사자 손십자가 검수(새 메뉴)", 0, [`적기 ${mineCross} · 숫자 손십자가 ${cnt["n3-c-ins"] || 0} · 묵주 ${cnt["n3-r-ins"] || 0}`]);
  if (on[0] !== 200 || on[1] !== 400 || on[2] !== 403) note("부서 봉사자 검수 API(새 메뉴 켬)", 0, [`보기 ${on[0]} · 적기 ${on[1]}(빈 값이면 400) · 다른 팀 API ${on[2]}`]);
}
const shot = async (file) => { if (!SHOTS) return; mkdirSync(SHOTS, { recursive: true }); if (FOCUS) { await ev(`document.querySelector(${JSON.stringify(FOCUS)})?.scrollIntoView({ block: "start" }); scrollBy(0, -64); 1`); await sleep(150); } const r = await cdp("Page.captureScreenshot", { format: "jpeg", quality: 60 }); writeFileSync(join(SHOTS, `${file.replace(/[^\w가-힣.-]+/g, "_")}.jpg`), Buffer.from(r.data, "base64")); };
for (const [role, steps, list] of RUNS) {
  if (ROLE && ROLE !== role + sfx(steps)) continue;
  await setMenu(steps);
  await cdp("Page.navigate", { url: `${B}/manifest.webmanifest` }); await sleep(150);
  await ev(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem("ps.token", ${JSON.stringify(tok[role])}); ${LS ? `localStorage.setItem(${JSON.stringify(LS.split("=")[0])}, ${JSON.stringify(LS.split("=").slice(1).join("="))});` : ""} 1`);
  for (const w of WIDTHS) {
    await cdp("Emulation.setDeviceMetricsOverride", { width: w, height: w < 600 ? 800 : 900, deviceScaleFactor: 1, mobile: w < 600 });
    await cdp("Page.navigate", { url: `${B}/` }); await sleep(500);
    for (const path of list) {
      const key = `${role}${tag(steps)} ${path}`;
      if (ONLY && !key.includes(ONLY)) continue;
      await ev(`location.hash = "#/${path}"; document.querySelector(".push-ask")?.remove(); 1`); await settle();
      await ev(`for (const d of document.querySelectorAll("main details")) d.open = true; 1`); await sleep(120); // 접힌 칸도 펼쳐서
      views++;
      note(key, w, await ev(FIND));
      await shot(`${role}${sfx(steps)}-${path}-${w}`);
      // 입력 판: 이 화면의 적기·추가 단추와 첫 줄·첫 카드를 눌러 봄 (저장하지 않고 닫음)
      const pick = `(() => { const m = document.querySelector("main"); if (!m) return 0; const b = [...m.querySelectorAll("button")].filter((x) => x.getClientRects().length && !x.disabled && !x.matches(".pick-tile, .vm-card, .alert, [role=tab]") && /회의실 관리|^읽지못하는|적기|추가|등록|만들기|기록$|배분$|요청$|올리기|고치기|입력$|알려|물량 배정/.test(x.textContent.trim()) && !/지우기|모두 읽음|사진 올리기/.test(x.textContent)).slice(0, 4); const r = [...m.querySelectorAll("tr.stock-row, button.vm-card, li.stock-row")].filter((x) => x.getClientRects().length).slice(0, 2); window.__t = [...new Set([...b, ...r])]; return window.__t.length; })()`; // 다시 그려지면 단추가 바뀌므로 누를 때마다 다시 찾음
      const n = await ev(pick);
      for (let i = 0; i < n; i++) {
        await ev(pick);
        const label = await ev(`(() => { const t = window.__t[${i}]; if (!t?.isConnected) return ""; const s = t.textContent.trim().slice(0, 14); t.click(); return s || "-"; })()`);
        if (!label) continue;
        await sleep(160);
        const open = await ev(`!!document.querySelector("dialog[open]")`);
        if (open) { dialogs++; note(`${key} › '${label}'`, w, await ev(FIND)); await shot(`${role}${sfx(steps)}-${path}-${w}-창${i}`); }
        await ev(`(() => { document.querySelector("dialog[open]")?.close(); return 1; })()`);
        await sleep(60);
        if ((await ev("location.hash")) !== `#/${path}`) break;
      }
    }
  }
  if (!ONLY) for (const g of GONE[role] || []) { await ev(`location.hash = "#/${g}"; 1`); await sleep(700); const at = await ev("location.hash"); if (at !== HOME[role]) note(`${role}${tag(steps)} 없앤 주소 ${g}`, 360, [`${at} 로 감`]); }
  // 알림을 눌러 그 기록까지 가는지: 종류마다 하나씩 (지운 기록은 안내만)
  if (!ONLY || ONLY === "alerts") {
    await cdp("Emulation.setDeviceMetricsOverride", { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false });
    const list0 = (await call("/changes", "GET", null, tok[role])).changes, seen = new Set();
    for (const [i, c] of list0.entries()) {
      if (seen.has(c.topic + c.action)) continue; seen.add(c.topic + c.action);
      await ev(`sessionStorage.removeItem("ps.volPreview"); location.hash = "#/today"; 1`); await cdp("Page.reload"); await sleep(700);
      await ev(`location.hash = "#/alerts"; document.querySelector(".push-ask")?.remove(); 1`); await settle();
      const ok = await ev(`(() => { const b = document.querySelectorAll(".alert")[${i}]; if (!b) return 0; b.click(); return 1; })()`);
      if (!ok) break;
      let r; for (let k = 0; k < 60; k++) { await sleep(150); r = await ev(`({ hash: location.hash, open: !!document.querySelector("dialog[open]"), flash: !!document.querySelector(".is-flash"), toast: [...document.querySelectorAll(".toast")].map((x) => x.textContent).join("/") })`); if (r.open || r.flash || /찾을 수/.test(r.toast)) break; if (k > 8 && (!c.refId || ["board", "proj", "ledger", "stockops", "criteria", "need"].includes(c.topic) || c.action === "delete" || c.link.startsWith("projects/"))) break; }
      clicks++;
      if (opt("verbose")) console.log(`${role}${sfx(steps)} 알림 ${c.label}(${c.topic}·${c.action}) '${c.title}' → ${r.hash} ${r.open ? "창" : r.flash ? "표시" : ""} ${r.toast}`);
      if (/찾을 수/.test(r.toast) || r.hash === "#/alerts" || (c.refId && !r.open && !r.flash && !r.toast && !["board", "proj", "ledger", "stockops", "criteria", "need"].includes(c.topic) && !c.link.startsWith("projects/"))) note(`${role}${tag(steps)} 알림 '${c.label}' ${c.topic} → ${r.hash}`, 1024, [r.toast || "기록이 안 열림"]);
    }
    await ev(`sessionStorage.removeItem("ps.volPreview"); document.querySelector("dialog[open]")?.close(); 1`); await cdp("Page.reload"); await sleep(600);
  }
  // 왼쪽 메뉴 서랍 (휴대폰)
  if (!ONLY) { await cdp("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: true }); await ev(`document.querySelector(".mobilebar .icon-btn")?.click(); 1`); await sleep(350);
    note(`${role}${tag(steps)} 메뉴`, 360, await ev(`(() => { const s = document.querySelector(".side"); const W = innerWidth; return [...s.querySelectorAll(".side__link, .nav-badge")].filter((e) => e.getClientRects().length && e.getBoundingClientRect().right > Math.min(W, s.getBoundingClientRect().right) + 1).map((e) => "메뉴 밖으로 '" + e.innerText.slice(0, 14) + "'"); })()`)); await shot(`${role}${sfx(steps)}-메뉴-360`); }
}
for (const e of new Set(errors)) console.log(`오류 │ ${e.split("\n").slice(0, 2).join(" ")}`);
for (const [k, w] of problems) console.log(`${k} │ ${[...new Set(w)].join("·")}px`);
console.log(`화면 ${views}번, 입력 판 ${dialogs}번, 알림 ${clicks}번 확인 · 문제 ${problems.size}가지${errors.length ? ` · 스크립트 오류 ${new Set(errors).size}가지` : ""}`);
process.exit(problems.size || errors.length ? 1 : 0);
