/*
 * 회의실 읽기 규칙 ('오늘' 화면의 회의실 예약 현황)
 * 화면(app.js)과 검사(tools/rooms-test.mjs)가 같이 씀. 화면·서버에 기대지 않는 계산만 둠.
 *
 *  - 일정의 방: 제목 대괄호 [A501] → 제목 맨 앞 'A602 …' → 제목 괄호 (A501) → 장소 칸 순서. 앞에서 찾으면 뒤는 안 봄
 *  - 관리자 설정 한 줄: '방 이름' 또는 '방 이름 = 다른 표기, 다른 표기'
 *  - 잘 모르겠으면 방으로 잡지 않고 '읽지 못한 표기'(관리자에게만)로 남김
 */
(function (root) {
  "use strict";

  const A4 = "A4 소회의실";
  // 띄어쓰기·대소문자·전각 차이를 없앤 비교용 이름
  const key = (x) => String(x || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  const tidy = (x) => String(x || "").normalize("NFKC").replace(/\s+/g, " ").trim();
  const isCode = (c) => /^[A-Z]\d{3}$/.test(c);

  // 방이 아닌 것이 분명한 말 (읽지 못한 표기에도 안 올림)
  const NOT = new RegExp("^(?:" + [
    "참고", "답사", "외부", "외근", "출장", "휴가", "연차", "반차", "오전반차", "오후반차", "병가", "휴무", "재택", "재택근무", "부재", "조퇴", "공가", "대휴", "휴직", "교육", "연수",
    "국회", "서울시", "서울시청", "시청", "온라인", "비대면", "대면", "화상", "화상회의", "온라인회의", "zoom", "줌", "teams", "ms?teams", "팀즈", "구글밋", "meet",
    "wyd(?:\\d{2,4})?", "미정", "확정", "취소", "변경", "연기", "중요", "긴급", "필수", "공지", "마감", "회의", "미팅", "행사", "예정", "보류", "내부", "공통", "전체"
  ].join("|") + ")$");
  // 기관·바깥 장소: 방 말이 없으면 조용히 빼고, 방 말이 함께 있으면(○○성당 강당) 애매한 것으로 남김
  const ORG = /(?:수도회|수녀회|수도원|수녀원|교구|교구청|성당|본당|대학|대학교|학교|병원|호텔|위원회|재단|협회|공사|구청|시청|대사관|국회|방송|신문|은행|주식회사)/;
  const VENUE = /(?:공연|극장|아트|콘서트|뮤직|올림픽|경기장|체육관|스타디움|컨벤션|코엑스|돔$)/;
  // 방 이름이 아니라 방에 대한 말
  const ABOUT = /(?:예약|변경|미정|필요|취소|확인|요청|문의|사용|이동|공사|청소|점검)/;
  const TIME = /^(?:오전|오후|am|pm)?\d{1,2}(?::\d{2}|시\d{0,2}분?|시반)?(?:am|pm|시)?(?:[~-](?:오전|오후|am|pm)?\d{1,2}(?::\d{2}|시\d{0,2}분?|시반)?(?:am|pm|시)?)?$/;
  // 방 이름의 끝: 회의실·층·호 … (뒤에 번호 하나까지)
  const ROOM_END = /(?:회의실|회의장|미팅룸|세미나실|집무실|강의실|교육실|상담실|접견실|다목적실|강당|경당|홀|라운지)[a-z가-라]?\d{0,2}호?$|(?:^|[^\d])(?:지하|b)?\d{1,2}층$|\d{3,4}호$/;
  const ROOM_ONLY = /^(?:회의실|회의장|미팅룸|세미나실|강의실|교육실|홀|라운지)$/; // 어느 방인지 모름

  // 소회의실 꼴 짧은 표기: A·4·소가 모두 → A4 소회의실 / 일부만(소4, A소, A4, 소401) → 적힌 그대로
  function shortRoom(k, raw) {
    const t = k.replace(/회의실|회의|미팅룸|층|동|호|[-_.·\s]/g, "");
    if (/^[a4소]{3}$/.test(t) && new Set(t).size === 3) return A4;
    const core = k.replace(/회의실|회의/g, "");
    if (/^[abc][1-9]$/.test(core) || /^소\d{1,3}$/.test(core) || /^[abc][소대중]$|^[소대중][abc]$/.test(core) ||
        /^(?:[abc][1-9][소대중]|[1-9][abc][소대중]|[abc][소대중][1-9]|[소대중][abc][1-9])$/.test(core)) return raw.toUpperCase();
    return "";
  }

  // 표기 하나 → { room } 방 · { code } 방 번호('A501' 또는 글자 없는 '501') · { no } 방 아님 · { unread } 모름
  function classify(raw0, letter) {
    const raw = tidy(raw0), k = key(raw);
    if (!k) return { no: true };
    // D-100 처럼 '남은 날'은 방이 아님
    if (/^d[-+]\d+$/.test(k)) return { no: true };
    const c = raw.match(/(?:^|[^A-Za-z0-9])([A-Za-z])\s*-?\s*(\d{3})(?!\d)/);
    if (c && !/d\s*[-+]\s*\d{3}/i.test(c[0])) return { code: c[1].toUpperCase() + c[2] };
    const n = raw.match(/^(\d{3})\s*호?$/);
    if (n) return { code: (letter || "") + n[1] };
    if (NOT.test(k) || TIME.test(k) || /^[\d\W_]+$/.test(k.replace(/[가-힣]/g, "x"))) return { no: true };
    const s = shortRoom(k, raw);
    if (s) return { room: s };
    const org = ORG.test(k), roomy = ROOM_END.test(k);
    const venue = VENUE.test(k);
    if (venue && (!roomy || /홀[a-z]?\d?$/.test(k))) return { no: true };
    if (roomy && !org && !venue && !ABOUT.test(k) && !ROOM_ONLY.test(k) && raw.length <= 30) return { room: raw };
    if (org && !roomy) return { no: true };
    return { unread: raw };
  }

  // 제목의 대괄호 안 표기들 [A, B/C] (전각 괄호도)
  const SPLIT = /[,/·&+]|\bor\b|\s및\s/i;
  const brackets = (title) => [...String(title || "").matchAll(/[[［【]([^\]］】]+)[\]］】]/g)].map((m) => m[1]);

  // 관리자 설정 한 줄 읽기
  function parseLine(line) {
    const [name, ...rest] = String(line || "").split("=");
    return { name: tidy(name), alias: [...new Set(rest.join(",").split(/[,，]/).map(tidy).filter(Boolean))] };
  }

  // 방 이름 → 층 (모르면 null): 번호 첫 자리 · 'n층'(지하는 음수) · A4 소회의실은 4층
  function floorOf(name) {
    const k = key(name);
    if (k === key(A4)) return 4;
    const f = k.match(/(지하|b)?(\d{1,2})층/);
    if (f) return (f[1] ? -1 : 1) * Number(f[2]);
    const n = k.match(/(?:^|\D)(\d)\d{2}(?!\d)/);
    return n ? Number(n[1]) : null;
  }
  // 층 → 번호 → 앞 글자 → 목록 순서. 번호 없는 방은 그 층의 뒤, 층을 모르는 방은 맨 뒤
  function sortRooms(names, floors) {
    const info = names.map((name, i) => { const m = key(name).match(/([a-z]?)(\d{3})(?!\d)/); return { name, i, f: floors(name) ?? floorOf(name), n: m ? Number(m[2]) : Infinity, l: m ? m[1] : "" }; });
    const cmp = (a, b) => (a === b ? 0 : a < b ? -1 : 1);
    return info.sort((a, b) => cmp(a.f ?? Infinity, b.f ?? Infinity) || cmp(a.n, b.n) || cmp(a.l, b.l) || a.i - b.i).map((x) => x.name);
  }

  // 설정 → 읽개. rooms: 줄 목록, skip: '회의실 아님'으로 기억한 표기
  // info: 방 정보 [{ name, floor, monitor, seats, note }]. 이름은 목록에 적은 이름이나 별명
  function makeReader(rooms, skip, info) {
    const rows = (rooms || []).map(parseLine).filter((r) => r.name);
    const skipSet = new Set((skip || []).map(key));
    const alias = new Map();   // 비교용 이름 → 보여 줄 방 이름
    const listed = rows.map((r) => {
      const c = classify(r.name);
      return { row: r, name: c.code || (c.room === A4 ? A4 : r.name), byCode: !!c.code };
    });
    // 별명이 흔한 표기(A4소 …)이면 같은 방으로 읽히는 다른 표기도 함께 모음. 적힌 그대로의 이름이 먼저
    for (const l of listed) for (const x of [l.row.name, l.name]) alias.set(key(x), l.name);
    for (const l of listed) for (const x of l.row.alias) alias.set(key(x), l.name);
    for (const l of listed) for (const x of l.row.alias) {
      const c = classify(x), y = c.code || c.room;
      if (y && !alias.has(key(y))) alias.set(key(y), l.name);
    }
    const namesOf = (r) => [r.name, ...r.alias];
    const aliasName = (n) => alias.get(key(n)) || n;

    function token(raw, letter) {
      const k = key(raw);
      if (alias.has(k)) { const c = classify(raw, letter); return { room: alias.get(k), letter: c.code && isCode(c.code) ? c.code[0] : letter }; }
      if (skipSet.has(k)) return { no: true, letter };
      const c = classify(raw, letter);
      if (c.code) return { room: aliasName(c.code), letter: isCode(c.code) ? c.code[0] : letter };
      if (c.room) return { room: aliasName(c.room), letter };
      return { ...c, letter };
    }

    function group(text, out) {
      const k = key(text);
      if (alias.has(k)) { out.rooms.push(alias.get(k)); return; }
      if (skipSet.has(k)) return;
      let letter = "";
      for (const part of String(text).split(SPLIT)) {
        const t = token(part, letter);
        letter = t.letter || letter;
        if (t.room) out.rooms.push(t.room);
        else if (t.unread) out.unread.push(t.unread);
      }
    }

    // 일정 하나 → { rooms: [방 이름…], unread: [읽지 못한 표기…] }
    function read(e) {
      const out = { rooms: [], unread: [] };
      const title = tidy(e.title);
      for (const b of brackets(title)) group(b, out);
      if (!out.rooms.length) {
        // 대괄호 없이: 맨 앞의 방 번호 (A602 …, A501·A502 …) — 글자 A~H + 숫자 3개로 끊겨 있을 때만
        const bare = title.replace(/[[［【][^\]］】]*[\]］】]/g, " ").trim();
        const head = bare.match(/^((?:[A-Ha-h]\d{3}호?)(?:\s*[,/·&]\s*(?:[A-Ha-h]?\d{3}호?))*)(?=$|[\s:,)\]_-])/);
        if (head) group(head[1], out);
        // 괄호 안이 방 번호뿐일 때 (A501)
        if (!out.rooms.length) for (const m of bare.matchAll(/\(([^()]+)\)/g)) {
          if (/^\s*[A-Ha-h]-?\d{3}\s*호?(?:\s*[,/·&]\s*[A-Ha-h]?\d{3}\s*호?)*\s*$/.test(m[1]) && !/^\s*d-/i.test(m[1])) group(m[1], out);
        }
      }
      if (!out.rooms.length) out.rooms.push(...place(e.location));
      out.rooms = [...new Set(out.rooms)];
      out.unread = [...new Set(out.unread)].filter((x) => x.length <= 40);
      return out;
    }

    // 장소 칸: 번호가 있으면 번호, 아니면 방 이름 꼴일 때만 (온라인 주소·바깥 주소·사람 이름은 뺌)
    function place(location) {
      const loc = tidy(String(location || "").replace(/https?:\S+/gi, " "));
      if (!loc || skipSet.has(key(loc))) return [];
      if (alias.has(key(loc))) return [alias.get(key(loc))];
      const inner = loc.replace(/[[\]［］【】]/g, "");
      const codes = [];
      let letter = "";
      for (const part of inner.split(SPLIT)) {
        if (skipSet.has(key(part))) continue;
        const c = classify(part, letter);
        if (c.code) { if (isCode(c.code)) letter = c.code[0]; codes.push(aliasName(c.code)); }
      }
      if (codes.length) return codes;
      const k = key(loc);
      for (const l of listed) for (const n of namesOf(l.row)) { const x = key(n); if (x.length >= (/[가-힣]/.test(x) ? 2 : 3) && k.includes(x)) return [l.name]; }
      if (/teams|zoom|온라인|대한민국/i.test(loc) || loc.length > 30) return [];
      const c = classify(loc);
      return c.room ? [aliasName(c.room)] : [];
    }

    // 일정 목록 → 방마다 모음. 글자 없는 '501' 은 그날 A501 하나뿐이면 그 방으로
    function board(events, opts) {
      const none = (opts && opts.noRoom) || (() => false); // 부재 캘린더처럼 방을 찾지 않을 일정
      const reads = events.map((e) => (none(e) ? { e, rooms: [], unread: [] } : { e, ...read(e) }));
      const lettered = new Set([...listed.map((l) => l.name), ...reads.flatMap((r) => r.rooms)].filter(isCode));
      const fix = (c) => { if (!/^\d{3}$/.test(c)) return c; const m = [...lettered].filter((x) => x.endsWith(c)); return m.length === 1 ? aliasName(m[0]) : c; };
      const shown = new Map(); // 비교용 이름 → 보여 줄 이름 (띄어쓰기만 다른 것은 하나로, 띄어 쓴 쪽을 보여 줌)
      for (const n of reads.flatMap((r) => r.rooms.map(fix))) { const k = key(n), old = shown.get(k); if (!old || n.length > old.length || (n.length === old.length && n < old)) shown.set(k, n); }
      const listedNames = [...new Set(listed.map((l) => fix(l.name)))];
      for (const n of listedNames) shown.set(key(n), n);
      const found = [...new Set([...shown.values()])].filter((n) => !listedNames.includes(n)).sort((a, b) => isCode(b) - isCode(a) || a.localeCompare(b, "ko"));
      const rooms = sortRooms([...listedNames, ...found], (n) => infoOf(n)?.floor ?? null), byRoom = new Map(rooms.map((r) => [r, []]));
      const used = new Set(), unread = new Map();
      for (const r of reads) {
        for (const n of new Set(r.rooms.map((x) => shown.get(key(fix(x)))))) { byRoom.get(n).push(r.e); used.add(r.e); }
        for (const u of r.unread) unread.set(key(u), { name: unread.get(key(u))?.name || u, n: (unread.get(key(u))?.n || 0) + 1 });
      }
      return {
        rooms, byRoom, events: used.size, usedRooms: [...byRoom.values()].filter((l) => l.length).length,
        unread: [...unread.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, "ko"))
      };
    }

    const infoBy = new Map();
    for (const x of info || []) { const c = classify(x.name); infoBy.set(key(alias.get(key(x.name)) || aliasName(c.code || c.room || x.name)), x); }
    const infoOf = (name) => infoBy.get(key(name)) || null;

    return { read, board, infoOf, listed: listed.map((l) => l.name) };
  }

  const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ""); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  /*
   * 한 방의 일정들 → 겹침. 끝과 시작이 맞닿은 것은 겹침이 아님. 끝 시간이 없으면 30분으로 봄(이름으로 모아 보기와 같음)
   * 제목과 시간이 모두 같으면 '중복일 수 있음'. { of: Map(일정 → "clash" | "dup"), clash: 겹친 묶음 수, dup: 중복 묶음 수 }
   */
  function overlaps(events, day) {
    const list = events.filter((e) => e.startTime && e.startDate === day).map((e) => {
      const a = toMin(e.startTime), b = e.endDate && e.endDate > day ? 1440 : toMin(e.endTime);
      return { e, a, b: b != null && b > a ? b : a + 30 };
    }).sort((x, y) => x.a - y.a || x.b - y.b);
    const of = new Map();
    let clash = 0, dup = 0, cluster = [], end = -1;
    const close = () => {
      if (cluster.length > 1) {
        for (const x of cluster) for (const y of cluster) {
          if (x === y || !(x.a < y.b && y.a < x.b)) continue;
          const same = x.a === y.a && x.b === y.b && key(x.e.title) === key(y.e.title);
          if (!same) of.set(x.e, "clash"); else if (!of.has(x.e)) of.set(x.e, "dup");
        }
        if (cluster.some((x) => of.get(x.e) === "clash")) clash++; else dup++;
      }
      cluster = [];
    };
    for (const x of list) {
      if (cluster.length && x.a >= end) close();
      end = cluster.length ? Math.max(end, x.b) : x.b;
      cluster.push(x);
    }
    close();
    return { of, clash, dup };
  }

  // 부재·휴가 캘린더: 제목에 무엇이 있든 방을 찾지 않음
  const isAbsenceCalendar = (name) => /부재|휴가|연차|근태|오프\s*알림/.test(String(name || ""));

  root.PSRooms = { A4, key, classify, floorOf, sortRooms, parseLine, makeReader, overlaps, isAbsenceCalendar };
})(globalThis);
