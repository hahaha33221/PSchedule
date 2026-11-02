#!/usr/bin/env node
/*
 * 관리자 도구 (웹 관리 화면에 들어갈 수 없을 때)
 *
 *   node server/admin.mjs list                              계정 목록
 *   node server/admin.mjs add <아이디> <이름> [admin]        계정 발급 (임시 비밀번호 6자리)
 *   node server/admin.mjs reset-password <아이디>            임시 비밀번호 새로 발급
 *   node server/admin.mjs backup                            지금 백업 (BACKUP_DIR, 기본 data/backups)
 *   node server/admin.mjs backups                           백업 목록
 *
 * VPS 에서:  ssh root@srv1809055.hstgr.cloud 'cd /opt/pschedule && docker compose exec -T api node --disable-warning=ExperimentalWarning server/admin.mjs list'
 */
import { join, resolve } from "node:path";
import { openDb, hashPassword, tempPassword } from "./db.mjs";
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
      console.log([u.login.padEnd(12), ROLE[u.role], u.name.padEnd(8, "　"), ["처음 비밀번호", "직접 변경함", "임시 비밀번호 발급됨"][u.pw_changed] || "?"].join("  "));
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
    console.log("사용법: node server/admin.mjs list | add <아이디> <이름> [admin] | reset-password <아이디> | backup | backups");
    process.exit(cmd ? 1 : 0);
}
