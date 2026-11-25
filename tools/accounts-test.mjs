#!/usr/bin/env node
// 봉사자 아이디 규칙·계정 일괄 발급 검사 (server/vol-accounts.mjs). 이름은 모두 지어낸 것
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, verifyPassword } from "../server/db.mjs";
import { normalizeLogin, loginProblem, createVolAccounts, logLogin } from "../server/vol-accounts.mjs";

const dir = mkdtempSync(join(tmpdir(), "ps-acc-"));
const db = openDb(join(dir, "t.db"));
let n = 0;
const eq = (a, b, m) => { n++; assert.deepEqual(a, b, m); };
try {
  for (const x of ["홍길동", "길동", "홍길동2", "hong.길동", "가-나_다.1", "가".repeat(20), "abc"]) eq(loginProblem(x, true), "", x);
  for (const x of ["", "가", "ab", "가".repeat(21), "홍 길동", "홍길동!", "ㅎㄱㄷ", "홍길동A", "=홍길동", "홍길동".normalize("NFD"), "김​시험"]) eq(!!loginProblem(x, true), true, x);
  for (const x of ["홍길동", "길동", "a길동b"]) eq(!!loginProblem(x, false), true, x);
  eq([loginProblem("abc", false), normalizeLogin(" 홍길동 ".normalize("NFD")), normalizeLogin("Hong"), logLogin({ id: 7, login: "홍길동" }), logLogin({ id: 7, login: "hong" })], ["", "홍길동", "hong", "#7", "hong"]);

  const A = createVolAccounts(db, { fail: (m) => Object.assign(new Error(m), { status: 400 }) });
  const add = (login, name, vol, kind = "both") => Number(db.prepare("INSERT INTO users (login, pw_hash, role, name, volunteer, vol_kind, vol_leader, pw_changed) VALUES (?, 'x', 'member', ?, ?, ?, ?, 1)").run(login, name, vol, kind, vol).lastInsertRowid);
  add("oldone", "기존하나", 1); add("기존둘", "기존둘", 1, "team"); add("staff1", "직원하나", 0, "dept");
  const ros = (call, name, user) => Number(db.prepare("INSERT INTO vol_roster (call_name, name, user_id) VALUES (?, ?, ?)").run(call, name, user ?? null).lastInsertRowid);
  const r1 = ros("가람", "시험가람"); ros("나래1", "시험나래"); ros("나래2", "시험나래"); ros("다솜", "시험다솜", 1);
  const st = (rows) => A.plan(rows).map((r) => r.status);
  const plan = A.plan([{ name: "시험가람".normalize("NFD"), affiliation: "어느 성당" }, { name: "시험나래" }, { name: "시험다솜", kinds: ["dept", "team"] }]);
  eq(plan.map((r) => [r.status, r.login, r.roster?.id ?? null, r.kinds.join()]), [["new", "시험가람", r1, "team"], ["new", "시험나래", null, "team"], ["new", "시험다솜", null, "dept,team"]]);
  eq(st([{ name: "기존둘" }, { name: "기존하나" }, { name: "기존하나", login: "새아이디" }]), ["exists", "ask", "ask"]);
  eq([A.plan([{ name: "기존하나" }])[0].account, A.plan([{ name: "기존둘" }])[0].account], [{ login: "oldone", kinds: ["dept", "team"] }, { login: "기존둘", kinds: ["team"] }]);
  eq(st([{ name: "" }, { name: "  " }, { name: "가".repeat(21) }, { name: "홍 길동" }, { name: "시험=" }, { name: "=시험" }, { name: "시험라", login: "STAFF1" }, { name: "시험마", login: "x" }, { name: "시험바", kinds: [] }, { name: "시험사", kinds: ["admin"] }]), Array(10).fill("fix"));
  eq(st([{ name: "홍 길동", login: "홍길동" }]), ["new"]);
  eq(st([{ name: "시험아" }, { name: "시험아" }]), ["fix", "fix"]); eq(st([{ name: "시험아" }, { name: "시험아", login: "시험아2" }]), ["ask", "ask"]);
  eq(st([{ name: "시험자", login: "같음" }, { name: "시험차", login: "같음".normalize("NFD") }]), ["fix", "fix"]);
  eq(st(["수녀님들", "어느수녀회", "봉사자들", "검수팀", "홍길동외3명"].map((name) => ({ name }))), Array(5).fill("ask"));
  for (const bad of [[], null, "x", Array(101).fill({ name: "시험" })]) assert.throws(() => A.plan(bad));
  // 발급: 하나라도 안 되면 모두 안 됨, 고르지 않은 줄은 거절, 같은 요청을 다시 보내면 아무것도 안 만듦
  const before = db.prepare("SELECT count(*) AS n FROM users").get().n;
  for (const rows of [[{ name: "시험가람" }, { name: "" }], [{ name: "시험가람" }, { name: "기존둘" }], [{ name: "수녀님들" }], [{ name: "시험가람" }, { name: "기존하나", force: "예" }]]) assert.throws(() => A.issue(rows), /아무 계정도/);
  eq(db.prepare("SELECT count(*) AS n FROM users").get().n, before);
  const out = A.issue([{ name: "시험가람", affiliation: "어느 성당" }, { name: "시험나래", kinds: ["dept"] }, { name: "수녀님들", login: "수녀님방", force: true }, { name: "시험타", kinds: ["team", "dept"], volLeader: true, role: "admin" }]);
  eq([out.accounts.map((a) => a.login), out.linked, new Set(out.accounts.map((a) => a.password)).size], [["시험가람", "시험나래", "수녀님방", "시험타"], 1, 4]);
  for (const a of out.accounts) { const u = db.prepare("SELECT * FROM users WHERE login = ?").get(a.login); eq([u.volunteer, u.role, u.vol_leader, u.pw_changed, u.unit_id, verifyPassword(a.password, u.pw_hash), u.pw_hash.includes(a.password), /^[a-z2-9]{8}$/.test(a.password)], [1, "member", 0, 0, null, true, false, true]); }
  eq(["시험가람", "시험나래", "시험타"].map((l) => db.prepare("SELECT vol_kind AS k FROM users WHERE login = ?").get(l).k), ["team", "dept", "both"]);
  eq(db.prepare("SELECT u.login FROM vol_roster r JOIN users u ON u.id = r.user_id WHERE r.id = ?").get(r1).login, "시험가람");
  assert.throws(() => A.issue([{ name: "시험가람" }, { name: "시험파" }]), /아무 계정도/); eq(db.prepare("SELECT 1 FROM users WHERE login = '시험파'").get(), undefined);
  // 잇지 않기
  const r2 = ros("하늘", "시험하늘"); A.issue([{ name: "시험하늘", link: false }]); eq(db.prepare("SELECT user_id AS u FROM vol_roster WHERE id = ?").get(r2).u, null);
  // 있던 계정은 그대로
  eq(db.prepare("SELECT pw_hash, vol_kind, vol_leader, pw_changed FROM users WHERE login = 'oldone'").get().pw_hash, "x");
  console.log(`봉사자 계정 검사 통과 (${n}개)`);
} finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
