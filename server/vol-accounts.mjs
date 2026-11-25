/*
 * 아이디 규칙과 봉사자 계정 일괄 발급
 *   - 직원·관리자 아이디: 영문 소문자·숫자·._- 3~20자. 봉사자는 완성형 한글도 (한글이 있으면 2~20자)
 *   - 맥에서 만든 엑셀의 풀어쓴 한글(NFD)도 NFC 로 맞춤
 *   - 일괄 발급: 이미 있는 계정은 고치지 않음. 모두 되거나 모두 안 됨. 세례명·연락처는 받지 않음(화면에서 결과 엑셀로만 옮김)
 *   - 임시 비밀번호는 응답으로 한 번만. 로그에는 건수만
 */
import crypto from "node:crypto";
import { hashPassword } from "./db.mjs";

export const normalizeLogin = (s) => String(s ?? "").normalize("NFC").trim().toLowerCase();
export const hasHangul = (s) => /[가-힣]/.test(s);
const ASCII = /^[a-z0-9._-]{3,20}$/, KOREAN = /^[가-힣a-z0-9._-]{2,20}$/;
// 쓸 수 없으면 이유, 쓸 수 있으면 ""
export function loginProblem(login, volunteer) {
  if (ASCII.test(login) || (volunteer && hasHangul(login) && KOREAN.test(login))) return "";
  return volunteer ? "아이디는 한글(2~20자)이나 영문 소문자·숫자·._- (3~20자)로 정해 주세요." : "아이디는 영문 소문자·숫자·._- 로 3~20자로 정해 주세요.";
}
// 로그에는 한글 아이디(이름)를 남기지 않음
export const logLogin = (u) => (hasHangul(u.login) ? `#${u.id}` : u.login);

export const MAX_ROWS = 100;
const tidy = (s) => String(s ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
const nameKey = (s) => tidy(s).replace(/\s/g, "").toLowerCase();
const GROUP = /(?:님들|분들|들|일동|단체|모임|공동체|수녀회|수도회|수도원|성당|본당|교구|위원회|봉사단|(?:봉사|검수|교육|운영|기념품)팀)$|외\s*\d+\s*(?:명|분)|[,/·&]|\d+\s*(?:명|분)/;
const kindsOf = (v) => {
  const k = (Array.isArray(v) ? v : []).filter((x) => x === "dept" || x === "team");
  return k.length ? [...new Set(k)].sort() : null;
};
const storeKind = (k) => (k.length === 2 ? "both" : k[0]);
// 헷갈리는 글자(0 o 1 l i)를 뺀 8자
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const password = () => Array.from({ length: 8 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("");

export function createVolAccounts(db, { fail }) {
  const q = {
    users: db.prepare("SELECT id, login, name, volunteer, vol_kind FROM users"),
    roster: db.prepare("SELECT id, call_name, name, user_id FROM vol_roster WHERE name <> ''"),
    add: db.prepare("INSERT INTO users (login, pw_hash, role, name, unit_id, note, volunteer, vol_kind, pw_changed) VALUES (?, ?, 'member', ?, NULL, ?, 1, ?, 0)"),
    link: db.prepare("UPDATE vol_roster SET user_id = ?, updated_at = datetime('now') WHERE id = ? AND user_id IS NULL")
  };

  /*
   * 줄마다 { name, login, affiliation, kinds, status, reason, account, roster }
   *   new 새로 만듦 · exists 이미 있음(건너뜀) · ask 관리자가 골라야 만듦 · fix 고쳐야 함
   */
  function plan(list) {
    if (!Array.isArray(list) || !list.length) throw fail("발급할 줄이 없어요.");
    if (list.length > MAX_ROWS) throw fail(`한 번에 ${MAX_ROWS}명까지 할 수 있어요.`);
    const users = q.users.all(), byLogin = new Map(users.map((u) => [normalizeLogin(u.login), u]));
    const volsByName = new Map();
    for (const u of users) if (u.volunteer) { const k = nameKey(u.name); volsByName.set(k, [...(volsByName.get(k) || []), u]); }
    const rosterByName = new Map();
    for (const r of q.roster.all()) { const k = nameKey(r.name); rosterByName.set(k, [...(rosterByName.get(k) || []), r]); }
    const rows = list.map((r) => {
      const name = tidy(r?.name), given = normalizeLogin(r?.login);
      return { name, login: given || normalizeLogin(name), given: !!given, affiliation: tidy(r?.affiliation).slice(0, 100), kinds: r?.kinds === undefined ? ["team"] : kindsOf(r.kinds) };
    });
    const count = (key) => { const m = new Map(); for (const r of rows) if (key(r)) m.set(key(r), (m.get(key(r)) || 0) + 1); return m; };
    const logins = count((r) => r.login), names = count((r) => nameKey(r.name));
    const acc = (u) => ({ login: u.login, kinds: u.vol_kind === "both" ? ["dept", "team"] : [u.vol_kind === "team" ? "team" : "dept"] });
    return rows.map(({ given, ...r }) => {
      const at = byLogin.get(r.login), same = volsByName.get(nameKey(r.name)) || [];
      const out = (status, reason, more) => ({ ...r, status, reason, account: null, roster: null, ...more });
      if (!r.name) return out("fix", "이름이 비어 있어요.");
      if (/^[=+\-@＝＋－＠]/.test(r.name)) return out("fix", "이름이 기호로 시작해요.");
      if (r.name.length > 20) return out("fix", "이름은 20자까지예요.");
      if (!r.kinds) return out("fix", "로그인 구분은 팀 봉사자·부서 봉사자로 적어 주세요.");
      // 이미 있음: 같은 아이디·같은 이름의 봉사자 계정
      if (at && at.volunteer && nameKey(at.name) === nameKey(r.name)) return out("exists", "같은 아이디의 봉사자 계정이 있어요. 그대로 둬요.", { account: acc(at) });
      const problem = !given && /\s/.test(r.name) ? "이름 칸에 띄어쓰기가 있어요. 세례명은 다른 칸에 적거나 아이디를 따로 적어 주세요." : loginProblem(r.login, true);
      if (problem) return out("fix", problem);
      if (at) return out("fix", "다른 계정이 이 아이디를 쓰고 있어요. 다른 아이디를 적어 주세요.");
      if (logins.get(r.login) > 1) return out("fix", "표 안에 같은 아이디가 또 있어요. 한쪽을 다르게 적어 주세요.");
      if (same.length) return out("ask", `이름이 같은 봉사자 계정이 ${same.length}개 있어요 (아이디 ${same.map((u) => u.login).join(", ")}). 다른 분이면 골라서 만들어 주세요.`, { account: same.length === 1 ? acc(same[0]) : null });
      if (GROUP.test(r.name)) return out("ask", "단체 이름 같아요. 한 사람 계정이면 골라서 만들어 주세요.");
      if (names.get(nameKey(r.name)) > 1) return out("ask", "표 안에 같은 이름이 또 있어요. 다른 분이면 골라서 만들어 주세요.");
      const ros = rosterByName.get(nameKey(r.name)) || [];
      const roster = ros.length === 1 && ros[0].user_id == null ? { id: ros[0].id, call: ros[0].call_name } : null;
      return out("new", "", { roster });
    });
  }

  // rows: [{ …, force: 물어볼 줄을 관리자가 고름, link: 명단과 이음 }]
  function issue(list) {
    const rows = plan(list);
    rows.forEach((r, i) => {
      if (r.status === "new" || (r.status === "ask" && list[i].force === true)) return;
      throw fail(`${i + 1}번째 줄(${r.name || "이름 없음"}): ${r.reason} 아무 계정도 만들지 않았어요. 다시 확인해 주세요.`);
    });
    const used = new Set();
    const made = rows.map((r, i) => {
      let pw; do pw = password(); while (used.has(pw)); used.add(pw);
      return { name: r.name, login: r.login, kinds: r.kinds, affiliation: r.affiliation, password: pw, hash: hashPassword(pw), roster: list[i].link === false ? null : r.roster };
    });
    let linked = 0;
    db.exec("BEGIN");
    try {
      for (const m of made) {
        const id = Number(q.add.run(m.login, m.hash, m.name, m.affiliation, storeKind(m.kinds)).lastInsertRowid);
        if (m.roster) linked += Number(q.link.run(id, m.roster.id).changes);
      }
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw /UNIQUE/.test(String(e.message)) ? fail("그사이 같은 아이디가 생겼어요. 아무 계정도 만들지 않았어요. 다시 확인해 주세요.") : e; }
    return { accounts: made.map(({ name, login, kinds, password: pw }) => ({ name, login, kinds, password: pw })), linked };
  }
  return { plan, issue };
}
