/*
 * 외부 캘린더 동기화 — 구글 캘린더 '비공개 주소(iCal 형식)' 를 주기적으로 읽어 calendar_events 에 저장
 *
 *   - 읽기 전용·한 방향 (PSchedule → 구글로는 아무것도 보내지 않음)
 *   - 다시 읽을 때마다 그 캘린더의 일정을 통째로 바꿔서, 고친 것·지운 것이 그대로 반영됨
 *   - 주소는 비밀번호처럼 다룸: 로그·오류 메시지·API 응답에 전체 주소를 넣지 않음 (maskUrl 로만 보여 줌)
 */
import { expandCalendar } from "./ical.mjs";

const FETCH_TIMEOUT_MS = 20_000;
const MAX_BYTES = 10 * 1024 * 1024;
const PAST_DAYS = 180, FUTURE_DAYS = 400; // 가져오는 기간 (오늘 기준)

// 'https://calendar.google.com/calendar/ical/<계정>/private-<비밀값>/basic.ics' → 'calendar.google.com · …ab12'
export function maskUrl(url) {
  try {
    const u = new URL(url);
    if (/\/public\/[^/]+\.ics$/.test(u.pathname)) return `${u.host} · 공개 주소`;
    const secret = u.pathname.split("/").find((s) => /^private-/.test(s)) || u.pathname.split("/").filter(Boolean).pop() || "";
    return `${u.host} · …${secret.slice(-4)}`;
  } catch { return "(주소 확인 필요)"; }
}

// 관리자가 넣은 주소 검사: https 만, 내부망 주소 금지
export function checkUrl(raw) {
  let s = String(raw ?? "").trim().replace(/^webcal:\/\//i, "https://");
  let u;
  try { u = new URL(s); } catch { return { error: "주소 형식이 아니에요. 구글 캘린더의 '비공개 주소(iCal 형식)'를 그대로 붙여 넣어 주세요." }; }
  if (u.protocol !== "https:") return { error: "https:// 로 시작하는 주소만 쓸 수 있어요." };
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || /^[\d.]+$/.test(host) || host.includes(":")) {
    return { error: "이 주소는 쓸 수 없어요." };
  }
  if (u.hostname === "calendar.google.com" && /\/public\/basic\.ics$/.test(u.pathname)) {
    return { url: u.href, warn: "공개 주소예요. 캘린더가 공개되어 있지 않으면 읽지 못해요 ('비공개 주소'를 권장해요)." };
  }
  return { url: u.href };
}

const seoulDay = (offsetDays) => new Date(Date.now() + 9 * 3600 * 1000 + offsetDays * 86400 * 1000).toISOString().slice(0, 10);

async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow", headers: { Accept: "text/calendar, */*" } });
  if (!res.ok) {
    throw new Error(res.status === 404 || res.status === 403 || res.status === 401
      ? `주소를 읽을 수 없어요 (HTTP ${res.status}). 비공개 주소가 바뀌었거나 재설정됐을 수 있어요.`
      : `캘린더 서버 응답 오류 (HTTP ${res.status})`);
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) { reader.cancel(); throw new Error("캘린더가 너무 커요 (10MB 초과)."); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// 오류 메시지에서 주소가 새어 나가지 않게
function safeError(e, url) {
  let msg = e?.name === "TimeoutError" || e?.name === "AbortError" ? "응답이 너무 늦어요 (20초)." : String(e?.message || e);
  if (msg === "fetch failed") msg = "캘린더 서버에 연결하지 못했어요" + (e.cause?.code ? ` (${e.cause.code})` : "") + ".";
  return msg.split(url).join("(비공개 주소)").slice(0, 300);
}

export function createCalendarSync(db, opts = {}) {
  const log = opts.log || console.log;
  const q = {
    all: db.prepare("SELECT * FROM calendars ORDER BY id"),
    one: db.prepare("SELECT * FROM calendars WHERE id = ?"),
    clear: db.prepare("DELETE FROM calendar_events WHERE calendar_id = ?"),
    add: db.prepare(`INSERT OR REPLACE INTO calendar_events (calendar_id, uid, inst, title, start_date, end_date, start_time, end_time, location, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    ok: db.prepare("UPDATE calendars SET last_sync_at = datetime('now'), last_ok_at = datetime('now'), last_error = NULL, event_count = ? WHERE id = ?"),
    fail: db.prepare("UPDATE calendars SET last_sync_at = datetime('now'), last_error = ? WHERE id = ?")
  };
  const running = new Map(); // 같은 캘린더를 동시에 두 번 읽지 않게

  async function syncOne(id) {
    if (running.has(id)) return running.get(id);
    const job = (async () => {
      const cal = q.one.get(id);
      if (!cal) return null;
      try {
        const text = await download(cal.url);
        const list = expandCalendar(text, { from: seoulDay(-PAST_DAYS), to: seoulDay(FUTURE_DAYS) });
        if (!q.one.get(id)) return null; // 읽는 사이 지워짐
        db.exec("BEGIN");
        try {
          q.clear.run(id);
          for (const e of list) {
            q.add.run(id, e.uid.slice(0, 500), e.key, e.title.slice(0, 200), e.startDate, e.endDate, e.startTime, e.endTime, e.location.slice(0, 200), e.description.slice(0, 5000));
          }
          q.ok.run(list.length, id);
          db.exec("COMMIT");
        } catch (err) { db.exec("ROLLBACK"); throw err; }
        return { ok: true, count: list.length };
      } catch (e) {
        // 실패하면 이전에 읽어 둔 일정은 그대로 둠
        const msg = safeError(e, cal.url);
        q.fail.run(msg, id);
        log(`[calendar] #${id} ${cal.name}: ${msg}`);
        return { ok: false, error: msg };
      }
    })().finally(() => running.delete(id));
    running.set(id, job);
    return job;
  }

  async function syncAll() {
    for (const c of q.all.all()) await syncOne(c.id);
  }

  function start(minutes) {
    const every = Math.max(5, Number(minutes) || 20);
    setTimeout(() => syncAll().catch(() => {}), 5000).unref();
    setInterval(() => syncAll().catch(() => {}), every * 60 * 1000).unref();
  }

  return { syncOne, syncAll, start };
}
