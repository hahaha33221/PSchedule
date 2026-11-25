#!/usr/bin/env node
// 봉사자 계정 표 읽기·엑셀 만들기 검사 (public/vol-accounts.js). 이름·번호는 모두 지어낸 것
//   node tools/accounts-sheet-test.mjs [엑셀을 남길 폴더]
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { crc32 } from "node:zlib";
new Function(readFileSync(new URL("../public/vol-accounts.js", import.meta.url), "utf8"))();
const A = globalThis.PSAccounts;
const rows = A.parseRows([["봉사자 명단"], ["번호", "이름", "세례명", "연락처", "소속", "아이디", "로그인 구분", "비고"], ["1", "시험가람".normalize("NFD"), "요셉", "010-0000-0000", "어느 성당", "", "", "메모"], ["2", " 시험 나래 ", "", "01000000000", "02-000-0000", "나래", "부서 봉사자", ""], ["", "", "", "010-1111-2222", "", "", "", ""], ["3", "시험다솜", "마리아", "", "", "", "둘 다", ""], ["4", "시험라온", "", "", "", "", "관리자", ""]]);
assert.deepEqual(rows, [
  { name: "시험가람", baptism: "요셉", affiliation: "어느 성당", login: "", kinds: ["team"] }, { name: "시험 나래", baptism: "", affiliation: "", login: "나래", kinds: ["dept"] },
  { name: "시험다솜", baptism: "마리아", affiliation: "", login: "", kinds: ["dept", "team"] }, { name: "시험라온", baptism: "", affiliation: "", login: "", kinds: [] }]);
assert.ok(!/01[01]|메모/.test(JSON.stringify(rows)));
assert.deepEqual(A.parseRows([["시험가람"], [""], ["시험나래"]]).map((r) => r.name), ["시험가람", "시험나래"]);
for (const g of [[], [["", ""]], [["홍", "길동"], ["a", "b"]]]) assert.throws(() => A.parseRows(g));
for (const [v, w] of [["=1+1", "'=1+1"], ["+a", "'+a"], ["-a", "'-a"], ["@a", "'@a"], ["＠a", "'＠a"], [" =a", "' =a"], ["보통", "보통"], ["", ""]]) assert.equal(A.guard(v), w);
const list = [{ name: "시험가람", baptism: "요셉 <&\"", affiliation: "=HYPERLINK(\"x\")", login: "시험가람", password: "abcd2345", kinds: ["team"] }, { name: "기존시험", baptism: "", affiliation: "", login: "old", password: null, kinds: ["dept", "team"] }];
const bytes = (withPw) => Buffer.concat(A.makeXlsx(A.accountSheets(list, "https://pschedule.vercel.app", withPw)).map((x) => Buffer.from(x)));
const unzip = (b) => { const out = {}; let o = b.readUInt32LE(b.length - 6); for (let i = 0; i < b.readUInt16LE(b.length - 12); i++) { const crc = b.readUInt32LE(o + 16), size = b.readUInt32LE(o + 20), n = b.readUInt16LE(o + 28), loc = b.readUInt32LE(o + 42), name = b.toString("utf8", o + 46, o + 46 + n), at = loc + 30 + n, d = b.subarray(at, at + size); assert.equal(crc32(d), crc, name); out[name] = d.toString("utf8"); o += 46 + n; } return out; };
const ad = unzip(bytes(true)), sh = unzip(bytes(false));
assert.ok(ad["xl/worksheets/sheet1.xml"].includes("abcd2345") && ad["xl/worksheets/sheet1.xml"].includes("임시 비밀번호") && ad["xl/worksheets/sheet2.xml"].includes("단체방"));
assert.ok(!JSON.stringify(sh).includes("abcd2345") && !sh["xl/worksheets/sheet1.xml"].includes("비밀번호"));
for (const f of [ad, sh]) { const x = f["xl/worksheets/sheet1.xml"]; assert.ok(!x.includes("<f>") && x.includes("'=HYPERLINK(") && x.includes("요셉 &lt;&amp;&quot;") && f["xl/worksheets/_rels/sheet1.xml.rels"].includes('Target="https://pschedule.vercel.app"')); }
if (process.argv[2]) { writeFileSync(process.argv[2] + "/admin.xlsx", bytes(true)); writeFileSync(process.argv[2] + "/share.xlsx", bytes(false)); }
console.log("봉사자 계정 표·엑셀 검사 통과");
