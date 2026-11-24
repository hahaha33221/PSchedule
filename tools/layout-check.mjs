// 반응형 검사: 역할마다 화면·입력 판을 360·390·768·1024·1440px 로 열어 화면 밖으로 넘치거나 잘리는 것이 있는지 봄
//   node tools/layout-check.mjs [--shots=폴더] [--role=dept] [--only=글자] [--widths=360,390]
// 크롬(headless)이 있어야 함. 임시 DB 에 지어낸 긴 글자 자료를 넣고 검사한 뒤 지움 (운영·내 개발 DB 는 건드리지 않음)
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const opt = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const WIDTHS = (opt("widths") || "360,390,768,1024,1440").split(",").map(Number);
const SHOTS = opt("shots"), ONLY = opt("only"), ROLE = opt("role"); // --role=dept (예전 화면은 dept0)
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
const setMenu = (steps) => call("/admin/vol-menu", "PUT", { menu: ["home", "schedule", "training", "notices", "wbs", "req", "in", "out", "recovery", "moves2", ...(steps ? ["steps2"] : [])] });

/* ---- 볼 화면: 주소와 눌러 열 것(글자) ---- */
const TEAM = ["thome", "alerts", "tcal", "tedu1", "tedu2", "tmake1", "tmake2", "tins1", "tins2", "tins3", "tins4", "tins5", "vschedule", "tissues", "vboard", `vboard/${bp}`, "vnotices", "vcontacts"];
const DEPT = ["vhome", "alerts", "dr1", "dr2", "ds1", "ds2", "ds3", "df1", "df2", "vcontacts", "vtraining", "vissues", "vboard", "vnotices"];
const OPS = ["dash", "mon", "ship-in", "ship-out", "stock", "cut", "buy", "contacts", "groups", "criteria", "duties"].map((k) => `ops/${k}`);
const STAFF = ["today", "dashboard", "tasks", "meetings", "memos", "projects", `projects/${pj}`, "stock", `stock/${led.ledger.id}`, "alerts", "notices", "orgchart", "contacts"];
const RUNS = [
  ["leader", true, TEAM], ["team", true, ["tedu1", "tedu2", "tmake2", "tins1"]], ["dept", true, DEPT],
  ["admin", true, ["alerts", "members", "org", "backup", "board", "volunteers", ...["edu", "roster", "training", "stock", "records", "inspect", "team", "wbs", "menu"].map((k) => `volunteers/${k}`), ...OPS, "ops/perms", ...STAFF.slice(0, 9)]],
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
const shot = async (file) => { if (!SHOTS) return; mkdirSync(SHOTS, { recursive: true }); const r = await cdp("Page.captureScreenshot", { format: "jpeg", quality: 60 }); writeFileSync(join(SHOTS, `${file.replace(/[^\w가-힣.-]+/g, "_")}.jpg`), Buffer.from(r.data, "base64")); };
for (const [role, steps, list] of RUNS) {
  if (ROLE && ROLE !== role + (steps ? "" : "0")) continue;
  await setMenu(steps);
  await cdp("Page.navigate", { url: `${B}/manifest.webmanifest` }); await sleep(150);
  await ev(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem("ps.token", ${JSON.stringify(tok[role])}); 1`);
  for (const w of WIDTHS) {
    await cdp("Emulation.setDeviceMetricsOverride", { width: w, height: w < 600 ? 800 : 900, deviceScaleFactor: 1, mobile: w < 600 });
    await cdp("Page.navigate", { url: `${B}/` }); await sleep(500);
    for (const path of list) {
      const key = `${role}${steps ? "" : "(예전)"} ${path}`;
      if (ONLY && !key.includes(ONLY)) continue;
      await ev(`location.hash = "#/${path}"; document.querySelector(".push-ask")?.remove(); 1`); await settle();
      await ev(`for (const d of document.querySelectorAll("main details")) d.open = true; 1`); await sleep(120); // 접힌 칸도 펼쳐서
      views++;
      note(key, w, await ev(FIND));
      await shot(`${role}${steps ? "" : "0"}-${path}-${w}`);
      // 입력 판: 이 화면의 적기·추가 단추와 첫 줄·첫 카드를 눌러 봄 (저장하지 않고 닫음)
      const pick = `(() => { const m = document.querySelector("main"); if (!m) return 0; const b = [...m.querySelectorAll("button")].filter((x) => x.getClientRects().length && !x.disabled && !x.matches(".pick-tile, .vm-card, .alert, [role=tab]") && /적기|추가|등록|만들기|기록$|배분$|요청$|올리기|고치기|입력$|알려|물량 배정/.test(x.textContent.trim()) && !/지우기|모두 읽음|사진 올리기/.test(x.textContent)).slice(0, 4); const r = [...m.querySelectorAll("tr.stock-row, button.vm-card, li.stock-row")].filter((x) => x.getClientRects().length).slice(0, 2); window.__t = [...new Set([...b, ...r])]; return window.__t.length; })()`; // 다시 그려지면 단추가 바뀌므로 누를 때마다 다시 찾음
      const n = await ev(pick);
      for (let i = 0; i < n; i++) {
        await ev(pick);
        const label = await ev(`(() => { const t = window.__t[${i}]; if (!t?.isConnected) return ""; const s = t.textContent.trim().slice(0, 14); t.click(); return s || "-"; })()`);
        if (!label) continue;
        await sleep(160);
        const open = await ev(`!!document.querySelector("dialog[open]")`);
        if (open) { dialogs++; note(`${key} › '${label}'`, w, await ev(FIND)); await shot(`${role}${steps ? "" : "0"}-${path}-${w}-창${i}`); }
        await ev(`(() => { document.querySelector("dialog[open]")?.close(); return 1; })()`);
        await sleep(60);
        if ((await ev("location.hash")) !== `#/${path}`) break;
      }
    }
  }
  if (!ONLY) for (const g of GONE[role] || []) { await ev(`location.hash = "#/${g}"; 1`); await sleep(700); const at = await ev("location.hash"); if (at !== HOME[role]) note(`${role}${steps ? "" : "(예전)"} 없앤 주소 ${g}`, 360, [`${at} 로 감`]); }
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
      if (opt("verbose")) console.log(`${role}${steps ? "" : "0"} 알림 ${c.label}(${c.topic}·${c.action}) '${c.title}' → ${r.hash} ${r.open ? "창" : r.flash ? "표시" : ""} ${r.toast}`);
      if (/찾을 수/.test(r.toast) || r.hash === "#/alerts" || (c.refId && !r.open && !r.flash && !r.toast && !["board", "proj", "ledger", "stockops", "criteria", "need"].includes(c.topic) && !c.link.startsWith("projects/"))) note(`${role}${steps ? "" : "(예전)"} 알림 '${c.label}' ${c.topic} → ${r.hash}`, 1024, [r.toast || "기록이 안 열림"]);
    }
    await ev(`sessionStorage.removeItem("ps.volPreview"); document.querySelector("dialog[open]")?.close(); 1`); await cdp("Page.reload"); await sleep(600);
  }
  // 왼쪽 메뉴 서랍 (휴대폰)
  if (!ONLY) { await cdp("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: true }); await ev(`document.querySelector(".mobilebar .icon-btn")?.click(); 1`); await sleep(350);
    note(`${role}${steps ? "" : "(예전)"} 메뉴`, 360, await ev(`(() => { const s = document.querySelector(".side"); const W = innerWidth; return [...s.querySelectorAll(".side__link, .nav-badge")].filter((e) => e.getClientRects().length && e.getBoundingClientRect().right > Math.min(W, s.getBoundingClientRect().right) + 1).map((e) => "메뉴 밖으로 '" + e.innerText.slice(0, 14) + "'"); })()`)); await shot(`${role}${steps ? "" : "0"}-메뉴-360`); }
}
for (const e of new Set(errors)) console.log(`오류 │ ${e.split("\n").slice(0, 2).join(" ")}`);
for (const [k, w] of problems) console.log(`${k} │ ${[...new Set(w)].join("·")}px`);
console.log(`화면 ${views}번, 입력 판 ${dialogs}번, 알림 ${clicks}번 확인 · 문제 ${problems.size}가지${errors.length ? ` · 스크립트 오류 ${new Set(errors).size}가지` : ""}`);
process.exit(problems.size || errors.length ? 1 : 0);
