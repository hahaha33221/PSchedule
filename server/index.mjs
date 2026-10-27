/*
 * PSchedule API 서버 (의존성 없음: node:http + node:sqlite)
 *
 *   환경 변수
 *   - PORT            기본 8787
 *   - DATA_DIR        DB 위치, 기본 ./data
 *   - STATIC_DIR      지정하면 정적 파일도 함께 제공 (로컬 개발용: public)
 *   - DEV=1           정적 HTML에 자동 새로고침 스크립트 삽입
 *   - ADMIN_PASSWORD  처음 실행 때 만드는 master 계정 비밀번호 (없으면 임시 비밀번호를 로그에 출력)
 */
import { createServer } from "node:http";
import { createReadStream, statSync, watch } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import crypto from "node:crypto";
import { openDb, ensureAdmin, verifyPassword, hashPassword, tempPassword } from "./db.mjs";

const PORT = Number(process.env.PORT) || 8787;
const DATA_DIR = resolve(process.env.DATA_DIR || "data");
const STATIC_DIR = process.env.STATIC_DIR ? resolve(process.env.STATIC_DIR) : null;
const DEV = process.env.DEV === "1";

const SESSION_DAYS = 14; // 로그인 유지 기간
const PASSWORD_MIN = 6, PASSWORD_MAX = 64;
const MAX_BODY = 64 * 1024;
const LIMITS = { title: 80, location: 80, description: 3000, notice: 5000, comment: 1000, name: 20 };
const COLORS = 6; // 일정 색 개수 (public/styles.css 의 --c0 ~ --c5)

const db = openDb(join(DATA_DIR, "pschedule.db"));
const created = ensureAdmin(db);
if (created) console.log(`관리자 계정을 만들었어요 → 아이디 ${created.login} / 비밀번호 ${created.password} (로그인 후 바로 바꿔 주세요)`);

const q = {
  userByLogin: db.prepare("SELECT * FROM users WHERE login = ?"),
  userById: db.prepare("SELECT * FROM users WHERE id = ?"),
  session: db.prepare(`
    SELECT u.id, u.login, u.role, u.name, u.pw_changed, u.pw_hash FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`),
  addSession: db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)"),
  delSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
  delOtherSessions: db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?"),
  delUserSessions: db.prepare("DELETE FROM sessions WHERE user_id = ?"),
  purgeSessions: db.prepare("DELETE FROM sessions WHERE expires_at <= ?"),
  setPassword: db.prepare("UPDATE users SET pw_hash = ?, pw_changed = 1 WHERE id = ?"),
  resetPassword: db.prepare("UPDATE users SET pw_hash = ?, pw_changed = 2 WHERE id = ?"),
  touchLogin: db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?"),

  // 일정 (기간이 겹치는 것)
  events: db.prepare(`
    SELECT e.*, u.name AS author,
      (SELECT count(*) FROM comments c WHERE c.target_type = 'event' AND c.target_id = e.id) AS comments
    FROM events e LEFT JOIN users u ON u.id = e.created_by
    WHERE e.start_date <= ? AND e.end_date >= ?
    ORDER BY e.start_date, e.start_time IS NOT NULL, e.start_time, e.id`),
  event: db.prepare("SELECT e.*, u.name AS author FROM events e LEFT JOIN users u ON u.id = e.created_by WHERE e.id = ?"),
  addEvent: db.prepare(`INSERT INTO events (title, start_date, end_date, start_time, end_time, location, description, color, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  setEvent: db.prepare(`UPDATE events SET title = ?, start_date = ?, end_date = ?, start_time = ?, end_time = ?,
    location = ?, description = ?, color = ?, updated_at = datetime('now') WHERE id = ?`),
  delEvent: db.prepare("DELETE FROM events WHERE id = ?"),

  // 공지
  notices: db.prepare(`
    SELECT n.id, n.title, substr(n.body, 1, 200) AS preview, n.pinned, n.created_at, n.updated_at, u.name AS author,
      (SELECT count(*) FROM comments c WHERE c.target_type = 'notice' AND c.target_id = n.id) AS comments
    FROM notices n LEFT JOIN users u ON u.id = n.created_by
    ORDER BY n.pinned DESC, n.created_at DESC, n.id DESC`),
  notice: db.prepare("SELECT n.*, u.name AS author FROM notices n LEFT JOIN users u ON u.id = n.created_by WHERE n.id = ?"),
  addNotice: db.prepare("INSERT INTO notices (title, body, pinned, created_by) VALUES (?, ?, ?, ?)"),
  setNotice: db.prepare("UPDATE notices SET title = ?, body = ?, pinned = ?, updated_at = datetime('now') WHERE id = ?"),
  delNotice: db.prepare("DELETE FROM notices WHERE id = ?"),

  // 댓글
  comments: db.prepare(`
    SELECT c.id, c.body, c.created_at, c.user_id, u.name AS author FROM comments c
    LEFT JOIN users u ON u.id = c.user_id
    WHERE c.target_type = ? AND c.target_id = ? ORDER BY c.created_at, c.id`),
  comment: db.prepare("SELECT * FROM comments WHERE id = ?"),
  addComment: db.prepare("INSERT INTO comments (target_type, target_id, user_id, body) VALUES (?, ?, ?, ?)"),
  delComment: db.prepare("DELETE FROM comments WHERE id = ?"),
  delComments: db.prepare("DELETE FROM comments WHERE target_type = ? AND target_id = ?"),

  // 멤버 (관리자)
  users: db.prepare("SELECT id, login, role, name, pw_changed, created_at, last_login_at FROM users ORDER BY role = 'admin' DESC, name, id"),
  addUser: db.prepare("INSERT INTO users (login, pw_hash, role, name) VALUES (?, ?, ?, ?)"),
  setUser: db.prepare("UPDATE users SET name = ?, role = ? WHERE id = ?"),
  delUser: db.prepare("DELETE FROM users WHERE id = ?"),
  adminCount: db.prepare("SELECT count(*) AS n FROM users WHERE role = 'admin'")
};

/* ---------- 로그인 시도 제한 (IP별, 아이디별) ---------- */
const attempts = new Map();
const LIMIT = 10, WINDOW_MS = 10 * 60 * 1000;
function tooMany(...keys) {
  const now = Date.now();
  return keys.some((k) => {
    const a = attempts.get(k);
    return a && a.until > now && a.count >= LIMIT;
  });
}
function recordFail(...keys) {
  const now = Date.now();
  for (const k of keys) {
    const a = attempts.get(k);
    if (!a || a.until <= now) attempts.set(k, { count: 1, until: now + WINDOW_MS });
    else a.count++;
  }
}
setInterval(() => {
  const now = Date.now();
  for (const [k, a] of attempts) if (a.until <= now) attempts.delete(k);
  q.purgeSessions.run(now);
}, 10 * 60 * 1000).unref();

/* ---------- 유틸 ---------- */
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const normalizeLogin = (s) => String(s || "").normalize("NFC").trim().toLowerCase();
const bad = (message, field) => Object.assign(new Error(message), { status: 400, expose: true, field });

function clientIp(req) {
  return (
    req.headers["x-vercel-forwarded-for"] ||
    req.headers["x-real-ip"] ||
    String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket.remoteAddress
  );
}

function send(res, status, data) {
  const body = data === undefined ? "" : JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { fail(Object.assign(new Error("too large"), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => {
      try {
        const v = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
        ok(v && typeof v === "object" ? v : {});
      } catch { fail(Object.assign(new Error("bad json"), { status: 400 })); }
    });
    req.on("error", fail);
  });
}

function auth(req) {
  const m = String(req.headers.authorization || "").match(/^Bearer\s+(\S+)$/i);
  if (!m) return null;
  return q.session.get(sha256(m[1]), Date.now()) || null;
}
const tokenOf = (req) => String(req.headers.authorization).split(/\s+/)[1];

const publicUser = (u) => ({ id: u.id, login: u.login, role: u.role, name: u.name, mustChangePassword: u.pw_changed !== 1 });

// 입력 정리
const text = (v, max, label, required) => {
  const s = String(v ?? "").replace(/\r\n?/g, "\n").trim();
  if (required && !s) throw bad(`${label}을(를) 적어 주세요.`);
  if (s.length > max) throw bad(`${label}은(는) ${max}자까지 쓸 수 있어요.`);
  return s;
};
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z")) && new Date(s + "T00:00:00Z").toISOString().startsWith(s);
const isTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

function eventInput(b) {
  const title = text(b.title, LIMITS.title, "제목", true);
  const start = String(b.startDate || "");
  const end = String(b.endDate || start);
  if (!isDate(start)) throw bad("시작 날짜를 확인해 주세요.");
  if (!isDate(end) || end < start) throw bad("끝나는 날짜는 시작 날짜와 같거나 뒤여야 해요.");
  const st = b.startTime ? String(b.startTime) : null;
  const et = st && b.endTime ? String(b.endTime) : null;
  if (st && !isTime(st)) throw bad("시작 시간을 확인해 주세요.");
  if (et && !isTime(et)) throw bad("끝나는 시간을 확인해 주세요.");
  if (st && et && start === end && et < st) throw bad("끝나는 시간이 시작 시간보다 빨라요.");
  const color = Number.isInteger(b.color) && b.color >= 0 && b.color < COLORS ? b.color : 0;
  return [title, start, end, st, et, text(b.location, LIMITS.location, "장소"), text(b.description, LIMITS.description, "설명"), color];
}

const eventOut = (e, user) => ({
  id: e.id, title: e.title, startDate: e.start_date, endDate: e.end_date, startTime: e.start_time, endTime: e.end_time,
  location: e.location, description: e.description, color: e.color, author: e.author, comments: e.comments,
  createdAt: e.created_at, updatedAt: e.updated_at, canEdit: user.role === "admin" || e.created_by === user.id
});
const commentOut = (c, user) => ({
  id: c.id, body: c.body, author: c.author || "(탈퇴한 멤버)", createdAt: c.created_at, mine: c.user_id === user.id,
  canDelete: user.role === "admin" || c.user_id === user.id
});

/* ---------- API ---------- */
async function api(req, res, path) {
  const method = req.method;

  if (path === "/api/health" && method === "GET") return send(res, 200, { ok: true });

  if (path === "/api/login" && method === "POST") {
    const { login, password } = await readJson(req);
    const id = normalizeLogin(login);
    const ip = "ip:" + clientIp(req), key = "id:" + id;
    if (tooMany(ip, key)) return send(res, 429, { error: "로그인 시도가 너무 많아요. 10분 뒤에 다시 시도해 주세요." });
    const user = id && q.userByLogin.get(id);
    const ok = user && typeof password === "string" && verifyPassword(password.trim(), user.pw_hash);
    if (!ok) {
      recordFail(ip, key);
      return send(res, 401, { error: "아이디 또는 비밀번호를 다시 확인해 주세요." });
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + SESSION_DAYS * 86400 * 1000;
    q.addSession.run(sha256(token), user.id, expiresAt);
    q.touchLogin.run(user.id);
    return send(res, 200, { token, expiresAt, user: publicUser(user) });
  }

  const user = auth(req);
  if (!user) return send(res, 401, { error: "로그인이 필요해요." });
  const isAdmin = user.role === "admin";

  if (path === "/api/logout" && method === "POST") {
    q.delSession.run(sha256(tokenOf(req)));
    return send(res, 204);
  }

  if (path === "/api/me" && method === "GET") return send(res, 200, { user: publicUser(user) });

  // 비밀번호 변경 (본인)
  if (path === "/api/password" && method === "POST") {
    const { current, next } = await readJson(req);
    const key = "pw:" + user.id;
    if (tooMany(key)) return send(res, 429, { error: "시도가 너무 많아요. 10분 뒤에 다시 시도해 주세요." });
    if (typeof current !== "string" || !verifyPassword(current.trim(), user.pw_hash)) {
      recordFail(key);
      return send(res, 400, { error: "지금 비밀번호가 맞지 않아요.", field: "current" });
    }
    const pw = typeof next === "string" ? next.trim() : "";
    if (pw.length < PASSWORD_MIN || pw.length > PASSWORD_MAX) {
      return send(res, 400, { error: `새 비밀번호는 ${PASSWORD_MIN}자 이상으로 정해 주세요.`, field: "next" });
    }
    if (pw === current.trim()) return send(res, 400, { error: "지금 비밀번호와 다른 비밀번호로 정해 주세요.", field: "next" });
    q.setPassword.run(hashPassword(pw), user.id);
    q.delOtherSessions.run(user.id, sha256(tokenOf(req))); // 다른 기기 로그인은 끊기
    return send(res, 200, { ok: true });
  }

  /* ----- 일정 ----- */
  if (path === "/api/events" && method === "GET") {
    const url = new URL(req.url, "http://localhost");
    const from = url.searchParams.get("from"), to = url.searchParams.get("to");
    if (!isDate(from || "") || !isDate(to || "") || to < from) return send(res, 400, { error: "기간을 확인해 주세요." });
    return send(res, 200, { events: q.events.all(to, from).map((e) => eventOut(e, user)) });
  }
  if (path === "/api/events" && method === "POST") {
    const r = q.addEvent.run(...eventInput(await readJson(req)), user.id);
    return send(res, 201, { event: eventOut(q.event.get(r.lastInsertRowid), user) });
  }
  const em = path.match(/^\/api\/events\/(\d+)(\/comments)?$/);
  if (em) {
    const e = q.event.get(Number(em[1]));
    if (!e) return send(res, 404, { error: "일정을 찾을 수 없어요. 지워졌을 수 있어요." });
    if (em[2]) {
      if (method !== "POST") return send(res, 405, { error: "Method not allowed" });
      const body = text((await readJson(req)).body, LIMITS.comment, "댓글", true);
      q.addComment.run("event", e.id, user.id, body);
      return send(res, 201, { comments: q.comments.all("event", e.id).map((c) => commentOut(c, user)) });
    }
    if (method === "GET") {
      return send(res, 200, { event: eventOut(e, user), comments: q.comments.all("event", e.id).map((c) => commentOut(c, user)) });
    }
    if (!isAdmin && e.created_by !== user.id) return send(res, 403, { error: "직접 올린 일정만 고칠 수 있어요." });
    if (method === "PUT") {
      q.setEvent.run(...eventInput(await readJson(req)), e.id);
      return send(res, 200, { event: eventOut(q.event.get(e.id), user) });
    }
    if (method === "DELETE") {
      q.delComments.run("event", e.id);
      q.delEvent.run(e.id);
      return send(res, 204);
    }
    return send(res, 405, { error: "Method not allowed" });
  }

  /* ----- 공지 ----- */
  if (path === "/api/notices" && method === "GET") {
    return send(res, 200, {
      notices: q.notices.all().map((n) => ({
        id: n.id, title: n.title, preview: n.preview, pinned: !!n.pinned, author: n.author,
        comments: n.comments, createdAt: n.created_at, updatedAt: n.updated_at
      }))
    });
  }
  const noticeInput = (b) => [text(b.title, LIMITS.title, "제목", true), text(b.body, LIMITS.notice, "내용", true), b.pinned ? 1 : 0];
  if (path === "/api/notices" && method === "POST") {
    if (!isAdmin) return send(res, 403, { error: "공지는 관리자만 쓸 수 있어요." });
    const r = q.addNotice.run(...noticeInput(await readJson(req)), user.id);
    return send(res, 201, { id: Number(r.lastInsertRowid) });
  }
  const nm = path.match(/^\/api\/notices\/(\d+)(\/comments)?$/);
  if (nm) {
    const n = q.notice.get(Number(nm[1]));
    if (!n) return send(res, 404, { error: "공지를 찾을 수 없어요. 지워졌을 수 있어요." });
    if (nm[2]) {
      if (method !== "POST") return send(res, 405, { error: "Method not allowed" });
      const body = text((await readJson(req)).body, LIMITS.comment, "댓글", true);
      q.addComment.run("notice", n.id, user.id, body);
      return send(res, 201, { comments: q.comments.all("notice", n.id).map((c) => commentOut(c, user)) });
    }
    if (method === "GET") {
      return send(res, 200, {
        notice: { id: n.id, title: n.title, body: n.body, pinned: !!n.pinned, author: n.author, createdAt: n.created_at, updatedAt: n.updated_at, canEdit: isAdmin },
        comments: q.comments.all("notice", n.id).map((c) => commentOut(c, user))
      });
    }
    if (!isAdmin) return send(res, 403, { error: "공지는 관리자만 고칠 수 있어요." });
    if (method === "PUT") {
      q.setNotice.run(...noticeInput(await readJson(req)), n.id);
      return send(res, 200, { ok: true });
    }
    if (method === "DELETE") {
      q.delComments.run("notice", n.id);
      q.delNotice.run(n.id);
      return send(res, 204);
    }
    return send(res, 405, { error: "Method not allowed" });
  }

  const cm = path.match(/^\/api\/comments\/(\d+)$/);
  if (cm && method === "DELETE") {
    const c = q.comment.get(Number(cm[1]));
    if (!c) return send(res, 204);
    if (!isAdmin && c.user_id !== user.id) return send(res, 403, { error: "직접 쓴 댓글만 지울 수 있어요." });
    q.delComment.run(c.id);
    return send(res, 204);
  }

  /* ----- 관리자: 멤버 계정 ----- */
  if (path.startsWith("/api/admin/")) {
    if (!isAdmin) return send(res, 403, { error: "관리자만 볼 수 있어요." });

    if (path === "/api/admin/users" && method === "GET") {
      return send(res, 200, {
        users: q.users.all().map((u) => ({
          id: u.id, login: u.login, role: u.role, name: u.name, pwChanged: u.pw_changed === 1, tempIssued: u.pw_changed !== 1,
          createdAt: u.created_at, lastLoginAt: u.last_login_at, me: u.id === user.id
        }))
      });
    }
    if (path === "/api/admin/users" && method === "POST") {
      const b = await readJson(req);
      const login = normalizeLogin(b.login);
      if (!/^[a-z0-9._-]{3,20}$/.test(login)) throw bad("아이디는 영문 소문자·숫자·._- 로 3~20자로 정해 주세요.", "login");
      const name = text(b.name, LIMITS.name, "이름", true);
      const role = b.role === "admin" ? "admin" : "member";
      if (q.userByLogin.get(login)) throw bad("이미 있는 아이디예요.", "login");
      const password = tempPassword();
      q.addUser.run(login, hashPassword(password), role, name);
      console.log(`[admin] ${user.login} → ${login} 계정 발급`);
      return send(res, 201, { login, name, password });
    }
    const um = path.match(/^\/api\/admin\/users\/(\d+)(\/reset-password)?$/);
    if (um) {
      const target = q.userById.get(Number(um[1]));
      if (!target) return send(res, 404, { error: "계정을 찾을 수 없어요." });
      if (um[2] && method === "POST") {
        const password = tempPassword();
        q.resetPassword.run(hashPassword(password), target.id);
        q.delUserSessions.run(target.id);
        console.log(`[admin] ${user.login} → ${target.login} 임시 비밀번호 발급`);
        return send(res, 200, { login: target.login, name: target.name, password });
      }
      const lastAdmin = target.role === "admin" && q.adminCount.get().n <= 1;
      if (!um[2] && method === "PATCH") {
        const b = await readJson(req);
        const name = b.name === undefined ? target.name : text(b.name, LIMITS.name, "이름", true);
        const role = b.role === "admin" || b.role === "member" ? b.role : target.role;
        if (lastAdmin && role !== "admin") throw bad("관리자가 한 명은 있어야 해요.");
        q.setUser.run(name, role, target.id);
        return send(res, 200, { ok: true });
      }
      if (!um[2] && method === "DELETE") {
        if (target.id === user.id) throw bad("내 계정은 지울 수 없어요.");
        if (lastAdmin) throw bad("관리자가 한 명은 있어야 해요.");
        q.delUser.run(target.id); // 쓴 일정·공지·댓글은 남고 작성자만 비워짐
        return send(res, 204);
      }
    }
    return send(res, 404, { error: "Not found" });
  }

  return send(res, 404, { error: "Not found" });
}

/* ---------- 정적 파일 (로컬 개발용) ---------- */
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json"
};
const reloadClients = new Set();
if (STATIC_DIR && DEV) {
  let t;
  watch(STATIC_DIR, { recursive: true }, () => {
    clearTimeout(t);
    t = setTimeout(() => { for (const r of reloadClients) r.write("data: reload\n\n"); }, 80);
  });
}

function serveStatic(req, res, pathname) {
  if (DEV && pathname === "/__reload") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.write(": connected\n\n");
    reloadClients.add(res);
    req.on("close", () => reloadClients.delete(res));
    return;
  }
  let file = normalize(join(STATIC_DIR, decodeURIComponent(pathname)));
  if (!file.startsWith(STATIC_DIR)) return res.writeHead(403).end();
  try {
    if (statSync(file).isDirectory()) file = join(file, "index.html");
    statSync(file);
  } catch {
    return res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }
  const type = TYPES[extname(file).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
  if (DEV && type.startsWith("text/html")) {
    let html = "";
    createReadStream(file, "utf8").on("data", (c) => (html += c)).on("end", () =>
      res.end(html.replace("</body>", '<script>new EventSource("/__reload").onmessage=()=>location.reload()</script></body>'))
    );
  } else createReadStream(file).pipe(res);
}

/* ---------- 서버 ---------- */
createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  try {
    if (pathname.startsWith("/api/")) return await api(req, res, pathname);
    if (STATIC_DIR) return serveStatic(req, res, pathname);
    send(res, 404, { error: "Not found" });
  } catch (e) {
    if (!res.headersSent) {
      send(res, e.status || 500, e.expose ? { error: e.message, field: e.field } : { error: e.status ? "잘못된 요청이에요." : "서버 오류가 났어요." });
    }
    if (!e.status) console.error(e);
  }
}).listen(PORT, () => {
  console.log(`PSchedule 서버: http://localhost:${PORT}${STATIC_DIR ? " (정적 파일 포함)" : ""}`);
});
