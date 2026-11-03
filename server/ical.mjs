/*
 * iCal(.ics) 읽기 — 구글 캘린더 '비공개 주소(iCal 형식)' 가져오기용 (의존성 없음)
 *
 *   expandCalendar(text, { from, to }) → 기간 안의 일정 목록 (반복 일정은 하나씩 펼침)
 *   시각은 모두 Asia/Seoul 기준 'YYYY-MM-DD' / 'HH:MM' 으로 돌려줌
 *
 *   지원: VEVENT, 종일(VALUE=DATE)·UTC·TZID·floating 시각, DTEND/DURATION,
 *         RRULE (DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY, BYMONTH, BYSETPOS, WKST),
 *         EXDATE, RDATE, RECURRENCE-ID (반복 중 한 번만 바뀐 일정), STATUS:CANCELLED
 */

const SEOUL = "Asia/Seoul";
const SEOUL_OFFSET = 9 * 3600 * 1000; // 한국은 일광 절약 시간이 없음
const DAY = 86400 * 1000;
const MAX_INSTANCES = 3000; // 일정 하나가 펼쳐질 수 있는 최대 개수
const MAX_STEPS = 20000;    // 반복 계산 안전장치

/* ---------- 줄 읽기 ---------- */
function unfold(text) {
  return String(text).replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

// 'DTSTART;TZID=Asia/Seoul:20261028T140000' → { name, params, value }
function parseLine(line) {
  let i = 0, inQuote = false;
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ":" && !inQuote) break;
  }
  const head = line.slice(0, i), value = line.slice(i + 1);
  const parts = head.match(/(?:[^;"]|"[^"]*")+/g) || [""];
  const params = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: parts[0].toUpperCase(), params, value };
}

const unescapeText = (s) => s.replace(/\\([\\;,nN])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));

// 구글 캘린더는 설명을 HTML 로 보내기도 함 (<p>, <br>, <table>…) → 글자만 남김
// 이름이 있는 실제 태그만 바꿔서 '<A311>회의' 처럼 일부러 쓴 꺾쇠 글자는 그대로 둠
const HTML_TAGS = "p|br|div|span|b|strong|i|em|u|s|strike|a|ul|ol|li|table|tbody|thead|tfoot|tr|td|th|colgroup|col|caption|h[1-6]|time|font|img|hr|blockquote|pre|code|sup|sub|small|big|center|label|section|article";
const TAG_RE = new RegExp(`<\\/?(?:${HTML_TAGS})(?:\\s[^<>]*)?\\/?>`, "gi");
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function htmlToText(input) {
  let s = String(input ?? "");
  if (!new RegExp(`<\\/?(?:${HTML_TAGS})\\b`, "i").test(s) && !/&(?:#\d+|#x[0-9a-f]+|[a-z]+);/i.test(s)) return s;
  s = s.replace(/\r\n?/g, "\n")
    // 링크: 글자와 주소가 다르면 '글자 (주소)'
    .replace(/<a\b[^<>]*href\s*=\s*["']([^"']*)["'][^<>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
      const t = label.replace(TAG_RE, "").trim();
      return !t || t === href ? href : `${t} (${href})`;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/t[dh]>\s*(?=<t[dh][\s>])/gi, " | ")
    .replace(/<li[\s>][^<>]*>|<li>/gi, "• ")
    .replace(/<\/(?:p|div|li|tr|h[1-6]|table|ul|ol|blockquote|pre|section|article)>/gi, "\n")
    .replace(/<(?:hr)[^<>]*>/gi, "\n")
    .replace(/<(?:p|div|ul|ol|table|h[1-6]|blockquote|pre|section|article)(?:\s[^<>]*)?>/gi, "\n")
    .replace(TAG_RE, "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
  return s.split("\n").map((l) => l.replace(/[ \t\u00a0]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// VEVENT 만 모음 (안에 든 VALARM 등은 건너뜀)
function readEvents(text) {
  const events = [];
  const stack = [];
  let cur = null;
  for (const line of unfold(text)) {
    if (!line) continue;
    const { name, params, value } = parseLine(line);
    if (name === "BEGIN") {
      stack.push(value.toUpperCase());
      if (value.toUpperCase() === "VEVENT" && stack.length === 2) cur = { props: {} };
      continue;
    }
    if (name === "END") {
      if (stack.pop() === "VEVENT" && cur && stack.length === 1) { events.push(cur.props); cur = null; }
      continue;
    }
    if (!cur || stack[stack.length - 1] !== "VEVENT") continue;
    (cur.props[name] ||= []).push({ params, value });
  }
  return events;
}

/* ---------- 시간대 ---------- */
const fmtCache = new Map();
function validZone(tz) {
  if (!tz) return null;
  if (fmtCache.has(tz)) return tz;
  try {
    fmtCache.set(tz, new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    return tz;
  } catch { return null; }
}
// 그 시각에 tz 가 UTC 보다 몇 ms 빠른지
function zoneOffset(ms, tz) {
  const p = Object.fromEntries(fmtCache.get(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}
// tz 의 벽시계 시각 → UTC ms
function zonedToUtc(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  if (tz === SEOUL || !tz) return guess - SEOUL_OFFSET;
  let utc = guess - zoneOffset(guess, tz);
  const again = guess - zoneOffset(utc, tz);
  if (again !== utc) utc = again;
  return utc;
}

/* ---------- 날짜 계산 (벽시계 날짜 y/m/d 를 정수 '일'로) ---------- */
const dayNum = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / DAY);
function fromDayNum(n) {
  const t = new Date(n * DAY);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), wd: t.getUTCDay() };
}
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n) => String(n).padStart(2, "0");
const ymdOf = (n) => { const t = fromDayNum(n); return `${t.y}-${pad(t.m)}-${pad(t.d)}`; };

// 날짜·시각 값 → { allDay, day(벽시계 일), sec(하루 중 초), tz, utc }
function parseDateValue(value, params) {
  const v = value.trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss, z] = m;
  const day = dayNum(+y, +mo, +d);
  if (params.VALUE === "DATE" || hh === undefined) return { allDay: true, day, sec: 0, tz: null, utc: day * DAY };
  const sec = +hh * 3600 + +mi * 60 + +(ss || 0);
  if (z) return { allDay: false, day, sec, tz: "UTC", utc: Date.UTC(+y, +mo - 1, +d, +hh, +mi, +(ss || 0)) };
  const tz = validZone(params.TZID) || SEOUL; // 시간대 없는 시각(floating)은 한국 시각으로
  return { allDay: false, day, sec, tz, utc: zonedToUtc(+y, +mo, +d, +hh, +mi, +(ss || 0), tz) };
}
// 같은 시간대·같은 하루 중 시각으로 다른 날짜의 UTC 를 구함
function atDay(base, day) {
  if (base.allDay) return day * DAY;
  if (base.tz === "UTC") return day * DAY + base.sec * 1000;
  const t = fromDayNum(day);
  return zonedToUtc(t.y, t.m, t.d, Math.floor(base.sec / 3600), Math.floor(base.sec / 60) % 60, base.sec % 60, base.tz);
}

// 'P1D', 'PT1H30M', 'P1W' → ms
function parseDuration(s) {
  const m = String(s || "").trim().match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const ms = ((+m[2] || 0) * 7 * 86400 + (+m[3] || 0) * 86400 + (+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) * 1000;
  return m[1] === "-" ? -ms : ms;
}

/* ---------- 반복 (RRULE) ---------- */
const WEEKDAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
function parseRule(value) {
  const r = {};
  for (const part of value.split(";")) {
    const [k, v] = part.split("=");
    if (k && v !== undefined) r[k.toUpperCase()] = v.toUpperCase();
  }
  const list = (k) => (r[k] ? r[k].split(",").filter(Boolean) : null);
  return {
    freq: r.FREQ,
    interval: Math.max(1, parseInt(r.INTERVAL, 10) || 1),
    count: r.COUNT ? parseInt(r.COUNT, 10) : null,
    until: r.UNTIL || null,
    byday: list("BYDAY")?.map((x) => { const m = x.match(/^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/); return m ? { n: m[1] ? parseInt(m[1], 10) : 0, wd: WEEKDAYS[m[2]] } : null; }).filter(Boolean) || null,
    bymonthday: list("BYMONTHDAY")?.map((x) => parseInt(x, 10)).filter((x) => x) || null,
    bymonth: list("BYMONTH")?.map((x) => parseInt(x, 10)).filter((x) => x >= 1 && x <= 12) || null,
    bysetpos: list("BYSETPOS")?.map((x) => parseInt(x, 10)).filter((x) => x) || null,
    wkst: WEEKDAYS[r.WKST] ?? 1
  };
}

// 한 달 안에서 규칙에 맞는 날(일 번호) 목록
function monthDays(y, m, rule, startDay) {
  const dim = daysInMonth(y, m);
  let out = [];
  if (rule.bymonthday) {
    for (const md of rule.bymonthday) { const d = md > 0 ? md : dim + md + 1; if (d >= 1 && d <= dim) out.push(dayNum(y, m, d)); }
  } else if (rule.byday) {
    for (const { n, wd } of rule.byday) {
      const all = [];
      for (let d = 1; d <= dim; d++) if (fromDayNum(dayNum(y, m, d)).wd === wd) all.push(dayNum(y, m, d));
      if (!n) out.push(...all);
      else { const x = n > 0 ? all[n - 1] : all[all.length + n]; if (x !== undefined) out.push(x); }
    }
  } else {
    const d = fromDayNum(startDay).d;
    if (d <= dim) out.push(dayNum(y, m, d));
  }
  out = [...new Set(out)].sort((a, b) => a - b);
  if (rule.bysetpos) out = rule.bysetpos.map((p) => (p > 0 ? out[p - 1] : out[out.length + p])).filter((x) => x !== undefined).sort((a, b) => a - b);
  return out;
}

// 반복 규칙에 따라 시작 '일' 번호를 차례로 (DTSTART 포함)
function* ruleDays(rule, start, lastDay) {
  const s = fromDayNum(start.day);
  let steps = 0;
  if (rule.freq === "DAILY") {
    for (let d = start.day; d <= lastDay && steps++ < MAX_STEPS; d += rule.interval) {
      if (rule.byday && !rule.byday.some((b) => b.wd === fromDayNum(d).wd)) continue;
      if (rule.bymonth && !rule.bymonth.includes(fromDayNum(d).m)) continue;
      yield d;
    }
  } else if (rule.freq === "WEEKLY") {
    const days = (rule.byday ? rule.byday.map((b) => b.wd) : [s.wd]);
    const weekStart = start.day - ((s.wd - rule.wkst + 7) % 7);
    for (let w = weekStart; w <= lastDay && steps++ < MAX_STEPS; w += 7 * rule.interval) {
      const list = days.map((wd) => w + ((wd - rule.wkst + 7) % 7)).sort((a, b) => a - b);
      for (const d of list) if (d >= start.day && d <= lastDay) yield d;
    }
  } else if (rule.freq === "MONTHLY") {
    for (let i = 0; steps++ < MAX_STEPS; i += rule.interval) {
      const mi = s.m - 1 + i, y = s.y + Math.floor(mi / 12), m = (mi % 12) + 1;
      if (dayNum(y, m, 1) > lastDay) break;
      if (rule.bymonth && !rule.bymonth.includes(m)) continue;
      for (const d of monthDays(y, m, rule, start.day)) if (d >= start.day && d <= lastDay) yield d;
    }
  } else if (rule.freq === "YEARLY") {
    for (let y = s.y; steps++ < MAX_STEPS; y += rule.interval) {
      if (dayNum(y, 1, 1) > lastDay) break;
      const months = rule.bymonth || [s.m];
      const sub = rule.byday || rule.bymonthday ? rule : { ...rule, bymonthday: [s.d] };
      for (const m of months) for (const d of monthDays(y, m, sub, start.day)) if (d >= start.day && d <= lastDay) yield d;
    }
  }
}

/* ---------- 일정 하나 → 기간 안의 회차들 ---------- */
const first = (p, k) => p[k]?.[0];
const text = (p, k) => (first(p, k) ? htmlToText(unescapeText(first(p, k).value)).trim() : "");

function instanceKey(start) {
  return start.allDay ? "D" + ymdOf(start.day) : "T" + new Date(start.utc).toISOString().replace(/\.\d+Z$/, "Z");
}

// 한국 시각으로 바꿔 날짜·시각 문자열로
function toSeoul(startUtc, endUtc, allDay) {
  if (allDay) {
    const sd = Math.floor(startUtc / DAY);
    const ed = Math.max(sd, Math.floor(endUtc / DAY) - 1); // DTEND 는 그날을 포함하지 않음
    return { startDate: ymdOf(sd), endDate: ymdOf(ed), startTime: null, endTime: null };
  }
  const s = new Date(startUtc + SEOUL_OFFSET), e = new Date(Math.max(endUtc, startUtc) + SEOUL_OFFSET);
  const d = (t) => `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  const hm = (t) => `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
  let endDate = d(e), endTime = hm(e);
  // 자정에 끝나면 전날 24:00 으로
  if (endTime === "00:00" && endUtc > startUtc && endDate > d(s)) { endDate = d(new Date(e.getTime() - DAY)); endTime = "24:00"; }
  return { startDate: d(s), endDate, startTime: hm(s), endTime: endUtc > startUtc ? endTime : null };
}

function eventLength(p, start) {
  const end = first(p, "DTEND") && parseDateValue(first(p, "DTEND").value, first(p, "DTEND").params);
  if (end) return Math.max(0, end.utc - start.utc);
  const dur = first(p, "DURATION") && parseDuration(first(p, "DURATION").value);
  if (dur != null) return Math.max(0, dur);
  return start.allDay ? DAY : 0;
}

function dateList(p, k) {
  const out = [];
  for (const { params, value } of p[k] || []) {
    for (const v of value.split(",")) { const d = parseDateValue(v, params); if (d) out.push(d); }
  }
  return out;
}

/**
 * @param {string} icsText
 * @param {{ from: string, to: string }} range  'YYYY-MM-DD' (한국 날짜, 둘 다 포함)
 */
export function expandCalendar(icsText, range) {
  if (!/BEGIN:VCALENDAR/i.test(icsText)) throw new Error("iCal 형식이 아니에요.");
  const fromUtc = Date.parse(range.from + "T00:00:00Z") - SEOUL_OFFSET;
  const toUtc = Date.parse(range.to + "T00:00:00Z") - SEOUL_OFFSET + DAY;
  const all = readEvents(icsText);

  // 반복 중 한 번만 바뀐 일정: UID + 원래 회차 → 바뀐 내용
  const overrides = new Map();
  const masters = [];
  for (const p of all) {
    if (first(p, "RECURRENCE-ID")) {
      const rid = parseDateValue(first(p, "RECURRENCE-ID").value, first(p, "RECURRENCE-ID").params);
      if (rid) overrides.set(text(p, "UID") + "|" + instanceKey(rid), p);
    } else masters.push(p);
  }

  const out = [];
  const push = (p, uid, key, startUtc, len, allDay) => {
    if (startUtc + Math.max(len, 1) <= fromUtc || startUtc >= toUtc) return;
    out.push({
      uid, key, title: text(p, "SUMMARY") || "(제목 없음)", location: text(p, "LOCATION"), description: text(p, "DESCRIPTION"),
      allDay, ...toSeoul(startUtc, startUtc + len, allDay)
    });
  };
  const emitOverride = (ov, uid, key) => {
    if (/^CANCELLED$/i.test(text(ov, "STATUS"))) return;
    const s = parseDateValue(first(ov, "DTSTART")?.value || "", first(ov, "DTSTART")?.params || {});
    if (s) push(ov, uid, key, s.utc, eventLength(ov, s), s.allDay);
  };

  for (const p of masters) {
    if (/^CANCELLED$/i.test(text(p, "STATUS"))) continue;
    const ds = first(p, "DTSTART");
    const start = ds && parseDateValue(ds.value, ds.params);
    if (!start) continue;
    const uid = text(p, "UID") || `${text(p, "SUMMARY")}@${ds.value}`;
    const len = eventLength(p, start);
    const rr = first(p, "RRULE");
    if (!rr) {
      const key = instanceKey(start);
      const ov = overrides.get(uid + "|" + key);
      if (ov) emitOverride(ov, uid, key); else push(p, uid, key, start.utc, len, start.allDay);
      continue;
    }

    const rule = parseRule(rr.value);
    if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(rule.freq)) continue;
    const until = rule.until && parseDateValue(rule.until, start.allDay ? { VALUE: "DATE" } : {});
    const untilUtc = until ? (until.allDay && !start.allDay ? until.utc + DAY - 1 : until.utc) : Infinity;
    const exdates = new Set(dateList(p, "EXDATE").map(instanceKey));
    const lastDay = Math.floor(Math.min(toUtc + SEOUL_OFFSET, untilUtc + 2 * DAY) / DAY) + 1;

    const starts = [];
    let n = 0;
    for (const d of ruleDays(rule, start, lastDay)) {
      const utc = atDay(start, d);
      if (utc > untilUtc) break;
      if (rule.count != null && n >= rule.count) break;
      n++;
      if (utc >= toUtc) break;
      if (utc + Math.max(len, 1) <= fromUtc) continue; // 기간 전 회차는 COUNT 에만 셈
      starts.push({ ...start, day: d, utc });
      if (starts.length >= MAX_INSTANCES) break;
    }
    for (const r of dateList(p, "RDATE")) starts.push(r);
    const seen = new Set();
    for (const s of starts) {
      const key = instanceKey(s);
      if (seen.has(key) || exdates.has(key)) continue;
      seen.add(key);
      const ov = overrides.get(uid + "|" + key);
      if (ov) { overrides.delete(uid + "|" + key); emitOverride(ov, uid, key); }
      else push(p, uid, key, s.utc, len, start.allDay);
    }
  }
  // 원래 회차를 못 찾은 변경 일정 (다른 날로 옮겨진 회차 등)도 보여 줌
  for (const [k, ov] of overrides) {
    const [uid, key] = [k.slice(0, k.lastIndexOf("|")), k.slice(k.lastIndexOf("|") + 1)];
    if (masters.some((p) => text(p, "UID") === uid && first(p, "RRULE"))) emitOverride(ov, uid, key);
  }
  return out;
}
