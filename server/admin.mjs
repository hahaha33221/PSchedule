#!/usr/bin/env node
/*
 * 관리자 도구 (웹 관리 화면에 들어갈 수 없을 때)
 *
 *   node server/admin.mjs list                              계정 목록
 *   node server/admin.mjs add <아이디> <이름> [admin]        계정 발급 (임시 비밀번호 6자리)
 *   node server/admin.mjs reset-password <아이디>            임시 비밀번호 새로 발급
 *   node server/admin.mjs backup                            지금 백업 (BACKUP_DIR, 기본 data/backups)
 *   node server/admin.mjs view <아이디>                       추가로 볼 수 있는 조직 보기
 *   node server/admin.mjs view-add <아이디> "<조직 경로>" [only]  추가로 볼 조직 넣기 (경로: '운영총괄부 > 기념품팀', only 면 그 조직만)
 *   node server/admin.mjs view-remove <아이디> "<조직 경로>"
 *   node server/admin.mjs notice-add "<제목>" [pin] < 본문.txt    공지 올리기 (본문은 표준 입력, 작성자는 관리자 계정)
 *   node server/admin.mjs backups                           백업 목록
 *   node server/admin.mjs contacts-import [--dry] < 명단.tsv  연락처 일괄 입력 (구역 | 이름 | 직함 | 내선 | 휴대폰, 조직도 자리의 이름으로 찾음)
 *     이미 값이 있으면 그대로 둠. 조직도에서 못 찾으면 넣지 않고 이름만 알려 줌. 번호는 출력하지 않음
 *
 * VPS 에서:  ssh root@srv1809055.hstgr.cloud 'cd /opt/pschedule && docker compose exec -T api node --disable-warning=ExperimentalWarning server/admin.mjs list'
 */
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { openDb, hashPassword, tempPassword, cleanContact } from "./db.mjs";
import { backupNow, listBackups } from "./backup.mjs";

const DATA_DIR = resolve(process.env.DATA_DIR || "data");
const BACKUP_DIR = resolve(process.env.BACKUP_DIR || join(DATA_DIR, "backups"));
const db = openDb(join(DATA_DIR, "pschedule.db"));
const [cmd, ...args] = process.argv.slice(2);
const ROLE = { member: "멤버", admin: "관리자" };

switch (cmd) {
  case "list": {
    const rows = db.prepare("SELECT * FROM users ORDER BY role = 'admin' DESC, name").all();
    if (!rows.length) console.log("(없음)");
    for (const u of rows) {
      console.log([u.login.padEnd(12), u.volunteer ? "봉사자" : u.director ? "본부장" : ROLE[u.role], u.name.padEnd(8, "　"), ["처음 비밀번호", "직접 변경함", "임시 비밀번호 발급됨"][u.pw_changed] || "?"].join("  "));
    }
    break;
  }

  case "add": {
    const [raw, name, role] = args;
    const login = String(raw || "").trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,20}$/.test(login) || !name) { console.error("사용법: add <아이디(영문 3~20자)> <이름> [admin]"); process.exit(1); }
    if (db.prepare("SELECT 1 FROM users WHERE login = ?").get(login)) { console.error(`'${login}' 은 이미 있는 아이디예요.`); process.exit(1); }
    const temp = tempPassword();
    db.prepare("INSERT INTO users (login, pw_hash, role, name) VALUES (?, ?, ?, ?)").run(login, hashPassword(temp), role === "admin" ? "admin" : "member", name);
    console.log(`${name} (아이디 ${login}) 임시 비밀번호: ${temp}`);
    break;
  }

  case "reset-password": {
    const login = String(args[0] || "").trim().toLowerCase();
    const user = login && db.prepare("SELECT * FROM users WHERE login = ?").get(login);
    if (!user) { console.error(`아이디 '${args[0] ?? ""}' 를 찾을 수 없어요.`); process.exit(1); }
    const temp = tempPassword();
    db.prepare("UPDATE users SET pw_hash = ?, pw_changed = 2 WHERE id = ?").run(hashPassword(temp), user.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
    console.log(`${user.name} (${ROLE[user.role]}, 아이디 ${user.login}) 임시 비밀번호: ${temp}`);
    console.log("→ 로그인하면 비밀번호를 바꾸라는 안내가 나와요. 기존 로그인은 모두 끊었어요.");
    break;
  }

  case "view":
  case "view-add":
  case "view-remove": {
    const u = db.prepare("SELECT * FROM users WHERE login = ?").get(String(args[0] || "").trim().toLowerCase());
    if (!u) { console.error(`아이디 '${args[0] ?? ""}' 를 찾을 수 없어요.`); process.exit(1); }
    const units = db.prepare("SELECT id, parent_id, name FROM org_units").all();
    const byId = new Map(units.map((x) => [x.id, x]));
    const label = (id) => { const o = []; for (let x = byId.get(id); x; x = byId.get(x.parent_id)) o.unshift(x.name); return o.join(" > "); };
    if (cmd !== "view") {
      // 경로 끝부분이 맞는 조직 (예: '운영총괄부 > 기념품팀' 또는 '기념품팀')
      const want = String(args[1] || "").split(/\s*[>›]\s*/).filter(Boolean).join(" > ");
      const hits = units.filter((x) => label(x.id) === want || label(x.id).endsWith(" > " + want));
      if (hits.length !== 1) { console.error(hits.length ? `'${want}' 에 맞는 조직이 여럿이에요: ${hits.map((x) => label(x.id)).join(" / ")}` : `'${want}' 조직을 찾을 수 없어요.`); process.exit(1); }
      if (cmd === "view-add") db.prepare("INSERT OR REPLACE INTO user_view_units (user_id, unit_id, sub) VALUES (?, ?, ?)").run(u.id, hits[0].id, args[2] === "only" ? 0 : 1);
      else db.prepare("DELETE FROM user_view_units WHERE user_id = ? AND unit_id = ?").run(u.id, hits[0].id);
    }
    console.log(`${u.name} (${u.login}) 소속: ${u.unit_id ? label(u.unit_id) : "(없음)"}`);
    const grants = db.prepare("SELECT unit_id, sub FROM user_view_units WHERE user_id = ? ORDER BY rowid").all(u.id);
    if (!grants.length) console.log("추가로 볼 조직: (없음)");
    for (const g of grants) console.log(`추가로 볼 조직: ${label(g.unit_id)} ${g.sub ? "(아래 팀 포함)" : "(그 조직만)"}`);
    break;
  }

  case "contacts-import": {
    const dry = args.includes("--dry");
    const rows = readFileSync(0, "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l) => { const [hint, name, , office, mobile] = l.split("\t"); return { hint: (hint || "").trim(), name: (name || "").trim(), office: office || "", mobile: mobile || "" }; });
    const plain = (n) => String(n).normalize("NFC").replace(/^(fr|sr|br)\.\s*/i, "").replace(/\s+/g, "").toLowerCase();
    const units = new Map(db.prepare("SELECT id, parent_id, name FROM org_units").all().map((u) => [u.id, u]));
    const chain = (id) => { const out = []; for (let u = units.get(id); u; u = u.parent_id ? units.get(u.parent_id) : null) out.push(u); return out; };
    const positions = db.prepare("SELECT * FROM org_positions WHERE name != ''").all();
    const count = new Map();
    for (const r of rows) count.set(plain(r.name), (count.get(plain(r.name)) || 0) + 1);
    const result = { done: 0, kept: 0, missing: [], unclear: [], invalid: [], split: [], seats: [] };
    db.exec("BEGIN");
    try {
      for (const r of rows) {
        let cand = positions.filter((p) => plain(p.name) === plain(r.name));
        if (!cand.length) { result.missing.push(r.name); continue; }
        // 명단에 같은 이름이 둘 이상: 구역으로 자리를 골라 다른 사람으로 나눔
        const namesake = count.get(plain(r.name)) > 1;
        if (namesake) cand = cand.filter((p) => r.hint && chain(p.unit_id).some((u) => u.name.includes(r.hint)));
        if (namesake && cand.length !== 1) { result.unclear.push(r.name); continue; }
        let v;
        try { v = cleanContact({ office: r.office, mobile: r.mobile }); } catch { result.invalid.push(r.name); continue; }
        const p = cand[0];
        if (namesake && !p.user_id && !p.person.includes("#")) {
          p.person = `${p.name}#${p.id}`;
          result.split.push(r.name);
          if (!dry) db.prepare("UPDATE org_positions SET person = ? WHERE id = ?").run(p.person, p.id);
        }
        // 같은 사람의 자리 전부 (겸직), 이미 입력한 값은 유지
        const seats = p.user_id ? positions.filter((x) => x.user_id === p.user_id) : namesake ? [p] : positions.filter((x) => !x.user_id && (x.person || x.name) === (p.person || p.name));
        if (seats.length > 1) result.seats.push(r.name);
        const had = seats.map((x) => db.prepare("SELECT * FROM contacts WHERE position_id = ?").get(x.id)).find(Boolean) || (p.user_id && db.prepare("SELECT * FROM contacts WHERE user_id = ?").get(p.user_id)) || {};
        for (const k of ["mobile", "office"]) if (had[k] && had[k] !== v[k]) result.kept++;
        const save = { mobile: had.mobile || v.mobile, office: had.office || v.office, email: had.email || "" };
        result.done++;
        if (dry) continue;
        for (const x of seats) {
          db.prepare("DELETE FROM contacts WHERE position_id = ?").run(x.id);
          db.prepare("INSERT INTO contacts (position_id, mobile, office, email) VALUES (?, ?, ?, ?)").run(x.id, save.mobile, save.office, save.email);
        }
        if (p.user_id) db.prepare("DELETE FROM contacts WHERE user_id = ?").run(p.user_id);
      }
      db.exec(dry ? "ROLLBACK" : "COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    console.log(`${dry ? "[미리보기, 저장 안 함] " : ""}명단 ${rows.length}줄 → 입력 ${result.done}명, 이미 있는 값이라 유지 ${result.kept}칸`);
    for (const [label, l] of [["조직도에서 못 찾음 (넣지 않음)", result.missing], ["같은 이름인데 자리를 못 고름 (넣지 않음)", result.unclear], ["번호 형식 오류 (넣지 않음)", result.invalid], ["동명이인으로 나눔", result.split], ["겸직 (자리마다 같은 값)", result.seats]]) if (l.length) console.log(`${label}: ${l.join(", ")}`);
    break;
  }

  case "notice-add": {
    const title = String(args[0] || "").trim();
    const body = readFileSync(0, "utf8").replace(/\r\n?/g, "\n").trim();
    if (!title || title.length > 80) { console.error("제목을 80자 안으로 적어 주세요."); process.exit(1); }
    if (!body || body.length > 5000) { console.error("본문(표준 입력)을 5000자 안으로 넣어 주세요."); process.exit(1); }
    const admin = db.prepare("SELECT id, login FROM users WHERE role = 'admin' ORDER BY login = 'admin' DESC, id LIMIT 1").get();
    const id = Number(db.prepare("INSERT INTO notices (title, body, pinned, created_by) VALUES (?, ?, ?, ?)").run(title, body, args[1] === "pin" ? 1 : 0, admin?.id ?? null).lastInsertRowid);
    if (admin) db.prepare("INSERT OR IGNORE INTO notice_reads (user_id, notice_id) VALUES (?, ?)").run(admin.id, id); // 쓴 사람은 읽은 것으로
    console.log(`공지 #${id} 를 올렸어요 (작성자 ${admin?.login ?? "-"}${args[1] === "pin" ? ", 맨 위 고정" : ""}).`);
    break;
  }

  case "backup": {
    console.log(`백업했어요 → ${backupNow(db, BACKUP_DIR)}`);
    break;
  }

  case "backups": {
    const list = listBackups(BACKUP_DIR);
    if (!list.length) console.log("(백업 없음)");
    for (const b of list) console.log(`${b.name}  ${(b.size / 1024).toFixed(0)}KB`);
    break;
  }

  default:
    console.log("사용법: node server/admin.mjs list | add <아이디> <이름> [admin] | reset-password <아이디> | backup | backups | view <아이디> | view-add <아이디> \"<조직 경로>\" [only] | view-remove <아이디> \"<조직 경로>\" | notice-add \"<제목>\" [pin] < 본문");
    process.exit(cmd ? 1 : 0);
}
