// 묵주 데이터베이스(xlsx → tools/rosary-xlsx-to-json.py → JSON)를 DB 에 반영
//   node server/admin.mjs rosary-import [--dry] [--rename] [--qty=list|table|keep] [--contacts] [--dates] < rosary.json
// 기본: 교육 회차·진행상태·배당물량·출납 상세·봉사자 명단·교육별 참여 봉사자·빠진 교육·봉사자 모임만 넣음
//   --rename    수도회 이름을 엑셀 이름으로 (일정 제목도 같이)
//   --qty=…     요청수량을 명단(list) / 일정표(table, 비면 명단) 값으로. keep(기본)은 그대로
//   --contacts  수도회 담당자·전화·주소가 비었으면 엑셀 값으로 채움
//   --dates     날짜·시간을 엑셀(일정표 시간, 비면 명단 시간) 값으로 (달력 미정 줄은 그대로)
//   --pin=27:28 엑셀 번호 27 을 DB 일정 #28 에 맞춤 (--pin=27:new 는 새로 넣음). 여러 번 써도 됨
// 오늘까지의 교육은 모두 진행완료로 봄. 출력에는 봉사자 이름·연락처를 넣지 않음
const TITLE = "묵주 교육 · ";

const norm = (s) => String(s || "").replace(/[\s·.,()（）\[\]_-]/g, "").replace(/수녀회|수도회|수녀원|수녀$/g, "");
function dice(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const grams = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
  const x = grams(a), y = grams(b);
  let n = 0;
  for (const [g, c] of x) n += Math.min(c, y.get(g) || 0);
  const tot = Math.max(1, a.length - 1) + Math.max(1, b.length - 1);
  return (2 * n) / tot;
}
const days = (a, b) => (a && b ? Math.abs(Date.parse(a) - Date.parse(b)) / 86400000 : 999);
const orgOf = (title) => String(title || "").split(" · ").pop().trim();
const md = (d) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : "날짜 없음");
const intOrNull = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

export function importRosary(db, data, opts = {}) {
  const { dry = true, rename = false, qty = "keep", contacts = false, dates = false, today = new Date().toISOString().slice(0, 10) } = opts;
  if (!data || !Array.isArray(data.schedules) || !data.schedules.length) throw new Error("수업일정이 비어 있어요.");
  if (!["keep", "list", "table"].includes(qty)) throw new Error("--qty 는 list · table · keep 중 하나예요.");
  const lines = [], warn = [];
  const sum = { matched: 0, added: 0, done: 0, planned: 0, dateFix: 0, timeFix: 0, qtyFix: 0, renamed: 0, renameSkip: 0, contacts: 0, ledger: 0, ledgerMiss: 0, matFix: 0, rosterNew: 0, rosterFix: 0, rosterLink: 0, helpers: 0, eduDone: 0, meetings: 0 };

  const g = db.prepare("SELECT project_item_id AS id, count(*) AS n FROM vol_schedules WHERE title LIKE ? AND project_item_id IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 1").get(TITLE + "%");
  if (!g) throw new Error("묵주 교육 일정을 찾을 수 없어요.");
  const dbRows = db.prepare("SELECT * FROM vol_schedules WHERE project_item_id = ? ORDER BY date, id").all(g.id);

  db.exec("BEGIN");
  try {
    // 1) 엑셀 수업 ↔ DB 일정 짝짓기 (이름 비슷함 + 날짜, 이미 회차가 적힌 줄은 회차도)
    //    날짜가 다르면 이름이 거의 같아야 함 (한쪽이 다른 쪽을 품거나 0.85 이상). --pin=<엑셀 번호>:<DB id|new> 로 직접 정할 수 있음
    const pairs = [];
    const mapX = new Map(), usedDb = new Set();
    const pins = opts.pins || {};
    data.schedules.forEach((x, i) => {
      const pin = pins[x.no];
      if (pin === "new") { mapX.set(i, null); return; }
      if (pin) { const s = dbRows.find((r) => r.id === Number(pin)); if (!s) throw new Error(`--pin ${x.no}:${pin}: 그 DB 일정이 없어요.`); mapX.set(i, s); usedDb.add(s.id); }
    });
    data.schedules.forEach((x, i) => {
      if (mapX.has(i)) return;
      for (const s of dbRows) {
        if (usedDb.has(s.id)) continue;
        const d = dice(x.org, orgOf(s.title));
        if (d < 0.35) continue;
        const dd = days(x.date, s.date);
        const a = norm(x.org), b = norm(orgOf(s.title));
        if (dd > 0 && d < 0.85 && !a.includes(b) && !b.includes(a)) continue;
        let score = d + (dd === 0 ? 0.6 : dd <= 31 ? 0.2 : 0) - (s.table_only ? 0.1 : 0);
        if (s.edu_code && s.edu_code === x.code) score += 0.5;
        pairs.push({ i, s, score });
      }
    });
    pairs.sort((a, b) => b.score - a.score);
    for (const p of pairs) {
      if (mapX.has(p.i) || usedDb.has(p.s.id) || p.score < 0.75) continue;
      mapX.set(p.i, p.s); usedDb.add(p.s.id);
    }

    const monByName = db.prepare("SELECT * FROM monasteries WHERE name = ?");
    const monById = db.prepare("SELECT * FROM monasteries WHERE id = ?");
    const addMon = db.prepare("INSERT INTO monasteries (name) VALUES (?)");
    const monFor = (name) => { const m = monByName.get(name); return m ? m.id : Number(addMon.run(name).lastInsertRowid); };
    const setCol = (col, v, id) => db.prepare(`UPDATE vol_schedules SET ${col} = ? WHERE id = ?`).run(v, id);
    const progressOf = (x) => (x.date && x.date <= today ? "done" : x.status === "진행완료" ? "done" : "planned");
    const qtyOf = (x) => (qty === "table" ? x.qtyTable ?? x.qtyList : x.qtyList ?? x.qtyTable);
    const idOfX = new Map(); // 엑셀 줄 → DB 일정 id

    data.schedules.forEach((x, i) => {
      let s = mapX.get(i) || null;
      const prog = progressOf(x), time = x.timeTable || x.timeList || "";
      if (!s) {
        // 엑셀에만 있는 수업 → 새로 넣음
        const q0 = intOrNull(qtyOf(x));
        const id = Number(db.prepare("INSERT INTO vol_schedules (title, date, start_time, place, audience, qty, project_item_id, edu_code, progress, alloc_qty, monastery_id, qty_by, qty_at) VALUES (?, ?, ?, ?, 'all', ?, ?, ?, ?, ?, ?, '엑셀 반영', datetime('now'))")
          .run(TITLE + x.org, x.date, time, x.region || "", q0, g.id, x.code, prog, intOrNull(x.alloc), monFor(x.org)).lastInsertRowid);
        idOfX.set(i, id); sum.added++; sum[prog]++;
        lines.push(`+ [${x.no}] ${x.code} ${md(x.date)} ${x.org}: 새 교육 일정 (요청 ${q0 ?? "-"}, ${prog === "done" ? "진행완료" : "진행예정"})`);
        return;
      }
      sum.matched++; idOfX.set(i, s.id);
      const ch = [];
      const dbOrg = orgOf(s.title);
      if (s.edu_code !== x.code) setCol("edu_code", x.code, s.id);
      if (s.progress !== prog) { setCol("progress", prog, s.id); ch.push(prog === "done" ? "진행완료" : "진행예정"); }
      sum[prog]++;
      if (intOrNull(x.alloc) !== null && s.alloc_qty !== x.alloc) setCol("alloc_qty", x.alloc, s.id);
      if (dates && !s.table_only) {
        if (x.date && x.date !== s.date) { setCol("date", x.date, s.id); ch.push(`날짜 ${md(s.date)}→${md(x.date)}`); sum.dateFix++; }
        if (time && time !== s.start_time) { setCol("start_time", time, s.id); ch.push(`시간 ${s.start_time || "없음"}→${time}`); sum.timeFix++; }
      } else {
        if (x.date && x.date !== s.date) ch.push(`(날짜 다름: DB ${md(s.date)} · 엑셀 ${md(x.date)})`);
        if (time && s.start_time && time !== s.start_time) ch.push(`(시간 다름: DB ${s.start_time} · 엑셀 ${time})`);
      }
      const q1 = intOrNull(qtyOf(x));
      if (qty !== "keep" && q1 !== null && q1 !== s.qty && !s.sum_note) {
        db.prepare("UPDATE vol_schedules SET qty = ?, qty_by = '엑셀 반영', qty_at = datetime('now') WHERE id = ?").run(q1, s.id);
        ch.push(`요청 ${s.qty ?? "-"}→${q1}`); sum.qtyFix++;
      } else if (q1 !== null && q1 !== s.qty) ch.push(`(요청수량 다름: DB ${s.qty ?? "-"} · 엑셀 ${q1})`);
      if (rename && dbOrg !== x.org) {
        const other = monByName.get(x.org);
        if (s.monastery_id && (!other || other.id === s.monastery_id)) {
          const m = monById.get(s.monastery_id);
          if (m && m.name !== x.org) { db.prepare("UPDATE monasteries SET name = ?, updated_at = datetime('now') WHERE id = ?").run(x.org, m.id); }
          db.prepare("UPDATE vol_schedules SET title = ? WHERE monastery_id = ? AND title = ?").run(TITLE + x.org, s.monastery_id, s.title);
          setCol("title", TITLE + x.org, s.id);
          ch.push(`이름 '${dbOrg}'→'${x.org}'`); sum.renamed++;
        } else if (other && other.id !== s.monastery_id) {
          // 엑셀 이름의 수도회가 이미 따로 있으면 이 일정을 그 수도회에 연결
          db.prepare("UPDATE vol_schedules SET title = ?, monastery_id = ? WHERE id = ?").run(TITLE + x.org, other.id, s.id);
          ch.push(`이름 '${dbOrg}'→'${x.org}' (있던 수도회에 연결)`); sum.renamed++;
        } else { sum.renameSkip++; ch.push(`(이름 못 바꿈: '${dbOrg}')`); }
      } else if (dbOrg !== x.org) ch.push(`(이름 다름: DB '${dbOrg}')`);
      if (contacts && s.monastery_id) {
        const m = monById.get(s.monastery_id);
        const fill = { contact_name: x.contactName, phone: x.phone, address: x.address };
        let n = 0;
        for (const [k, v] of Object.entries(fill)) if (m && v && !m[k]) { db.prepare(`UPDATE monasteries SET ${k} = ?, updated_at = datetime('now') WHERE id = ?`).run(String(v).slice(0, 300), m.id); m[k] = v; n++; }
        if (n) sum.contacts++;
      }
      if (ch.length) lines.push(`· [${x.no}] ${x.code} ${md(x.date)} ${x.org} ↔ #${s.id}: ${ch.join(", ")}`);
    });
    // 합동 교육: 같은 회차에서 일부는 DB 일정과 맞고 일부는 새로 넣으면, DB 쪽 수량이 합계일 수 있음
    const codeState = new Map();
    data.schedules.forEach((x, i) => { const st = codeState.get(x.code) || { m: [], a: [] }; (mapX.get(i) ? st.m : st.a).push(x.no); codeState.set(x.code, st); });
    for (const [code, st] of codeState) if (st.m.length && st.a.length) warn.push(`${code}: 일부만 DB 일정과 맞아요 (맞음 ${st.m.join("·")}번, 새로 ${st.a.join("·")}번). DB 일정의 요청수량이 두 수도회 합계면 요청수량 기준을 정해 맞춰야 합계가 겹치지 않아요`);
    for (const s of dbRows) if (!usedDb.has(s.id)) lines.push(`? DB 에만 있음 #${s.id} ${md(s.date)} ${orgOf(s.title)}${s.table_only ? " (달력 미정)" : ""} (그대로 둠)`);

    // 2) 출납 상세: 같은 날짜의 엑셀 수업 중 이름이 가장 비슷한 줄
    for (const l of data.ledger || []) {
      let best = null;
      data.schedules.forEach((x, i) => { if (x.date !== l.date) return; const d = dice(l.org, x.org); if (!best || d > best.d) best = { d, i }; });
      if (!best || best.d < 0.3) { sum.ledgerMiss++; warn.push(`출납 ${md(l.date)} ${l.org}: 맞는 수업을 못 찾음`); continue; }
      const id = idOfX.get(best.i), s = db.prepare("SELECT * FROM vol_schedules WHERE id = ?").get(id);
      const th = intOrNull(l.thread), cr = intOrNull(l.cross);
      if (th !== (s.thread_qty ?? null) || cr !== (s.cross_qty ?? null)) {
        db.prepare("UPDATE vol_schedules SET thread_qty = ?, cross_qty = ?, mat_by = '엑셀 반영', mat_at = datetime('now') WHERE id = ?").run(th, cr, id);
        lines.push(`· 출납 ${md(l.date)} ${orgOf(s.title)}: 실·십자가 지급 ${s.thread_qty ?? "-"}·${s.cross_qty ?? "-"} → ${th ?? "-"}·${cr ?? "-"}`); sum.matFix++;
      }
      db.prepare("UPDATE vol_schedules SET alloc_qty = ?, send_thread = ?, send_cross = ?, sample_qty = ?, done_qty = ?, loss_qty = ?, mat_handler = ?, mat_note = ? WHERE id = ?")
        .run(intOrNull(l.alloc) ?? s.alloc_qty, intOrNull(l.sendThread), intOrNull(l.sendCross), intOrNull(l.sample), intOrNull(l.done), intOrNull(l.loss), String(l.handler || "").slice(0, 100), [l.note, l.check].filter(Boolean).join(" / ").slice(0, 500), id);
      sum.ledger++;
    }

    // 3) 봉사자 명단 (호칭으로 찾음) · 계정 연결 (이름이 같은 봉사자 계정이 하나뿐일 때)
    const rByCall = db.prepare("SELECT * FROM vol_roster WHERE call_name = ?");
    const addR = db.prepare("INSERT INTO vol_roster (call_name, name, kind, affiliation, note) VALUES (?, ?, ?, ?, ?)");
    for (const r of data.roster || []) {
      const call = String(r.call || "").trim().slice(0, 40); if (!call) continue;
      const kind = ["making", "cutting"].includes(r.kind) ? r.kind : "etc";
      const old = rByCall.get(call);
      if (!old) { addR.run(call, String(r.name || "").slice(0, 40), kind, String(r.affiliation || "").slice(0, 100), ""); sum.rosterNew++; continue; }
      if (old.name !== (r.name || "") || old.kind !== kind || old.affiliation !== (r.affiliation || "")) {
        db.prepare("UPDATE vol_roster SET name = ?, kind = ?, affiliation = ?, updated_at = datetime('now') WHERE id = ?").run(String(r.name || "").slice(0, 40), kind, String(r.affiliation || "").slice(0, 100), old.id); sum.rosterFix++;
      }
    }
    for (const r of db.prepare("SELECT * FROM vol_roster WHERE user_id IS NULL AND name <> ''").all()) {
      const u = db.prepare("SELECT id FROM users WHERE volunteer = 1 AND name = ?").all(r.name);
      if (u.length === 1) { db.prepare("UPDATE vol_roster SET user_id = ? WHERE id = ?").run(u[0].id, r.id); sum.rosterLink++; }
    }

    // 4) 교육별 참여 봉사자: 같은 회차(합동 교육)의 모든 일정에 넣음. 엑셀에 나온 일정의 참여 기록은 통째로 바꿈
    const idsByCode = new Map();
    data.schedules.forEach((x, i) => { const id = idOfX.get(i); if (!idsByCode.has(x.code)) idsByCode.set(x.code, []); idsByCode.get(x.code).push(id); });
    const del = db.prepare("DELETE FROM vol_edu_helpers WHERE schedule_id = ?");
    for (const id of idOfX.values()) del.run(id);
    const addH = db.prepare("INSERT OR IGNORE INTO vol_edu_helpers (schedule_id, roster_id, role) VALUES (?, ?, ?)");
    let unknown = 0;
    for (const p of data.participation || []) {
      const call = String(p.call || "").trim().slice(0, 40); const ids = idsByCode.get(p.code);
      if (!call || !ids) { warn.push(`참여 ${p.code}: 맞는 수업이 없음`); continue; }
      let r = rByCall.get(call);
      if (!r) { addR.run(call, "", "etc", "", "명단에 없음 (참여 기록에서 추가)"); r = rByCall.get(call); unknown++; sum.rosterNew++; }
      for (const id of ids) addH.run(id, r.id, String(p.role || "").slice(0, 20));
      sum.helpers++;
    }
    if (unknown) warn.push(`참여 기록에만 있는 사람 ${unknown}명을 명단에 '기타'로 넣음`);

    // 5) 진행완료 교육의 수도회는 '교육완료' (이미 그 다음 단계면 그대로)
    sum.eduDone = db.prepare("UPDATE monasteries SET status = 'edu_done', updated_at = datetime('now') WHERE status = 'new' AND id IN (SELECT monastery_id FROM vol_schedules WHERE project_item_id = ? AND progress = 'done' AND monastery_id IS NOT NULL)").run(g.id).changes;

    // 6) 기타 일정 (봉사자 모임): 같은 날 같은 제목이 없으면 넣음
    for (const o of data.other || []) {
      const t = String(o.title || "").trim(); if (!t || !o.date) continue;
      const same = db.prepare("SELECT id FROM vol_schedules WHERE date = ? AND replace(title, ' ', '') = ?").get(o.date, t.replace(/\s/g, ""));
      if (same) continue;
      db.prepare("INSERT INTO vol_schedules (title, date, start_time, audience) VALUES (?, ?, ?, 'all')").run(t.slice(0, 120), o.date, o.time || "");
      lines.push(`+ ${md(o.date)} ${o.time || ""} ${t}: 새 일정`); sum.meetings++;
    }

    db.exec(dry ? "ROLLBACK" : "COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }

  const head = [
    `${dry ? "[미리보기, 저장 안 함] " : ""}묵주 교육 ${data.schedules.length}건: 맞춘 일정 ${sum.matched} · 새로 넣음 ${sum.added} · 진행완료 ${sum.done} · 진행예정 ${sum.planned}`,
    `옵션: 이름 ${rename ? "엑셀로" : "그대로"} · 요청수량 ${{ keep: "그대로", list: "명단 기준", table: "일정표 기준" }[qty]} · 수도회 연락처 ${contacts ? "빈 곳 채움" : "안 넣음"} · 날짜·시간 ${dates ? "엑셀로" : "그대로"}`,
    `바꾼 것: 날짜 ${sum.dateFix} · 시간 ${sum.timeFix} · 요청수량 ${sum.qtyFix} · 이름 ${sum.renamed}${sum.renameSkip ? ` (못 바꿈 ${sum.renameSkip})` : ""} · 연락처 넣은 수도회 ${sum.contacts}`,
    `출납 ${sum.ledger}건 (실·십자가 지급 바뀜 ${sum.matFix}${sum.ledgerMiss ? `, 못 맞춤 ${sum.ledgerMiss}` : ""}) · 봉사자 명단 새로 ${sum.rosterNew} · 고침 ${sum.rosterFix} · 계정 연결 ${sum.rosterLink} · 참여 기록 ${sum.helpers}줄 · 교육완료로 바뀐 수도회 ${sum.eduDone} · 새 모임 일정 ${sum.meetings}`
  ];
  return { lines: [...head, ...warn.map((w) => `! ${w}`), ...lines], sum };
}
