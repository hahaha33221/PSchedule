(function () {
  "use strict";

  const TITLE = "PSchedule";
  const API = "/api";
  const app = document.getElementById("app");
  const dialog = document.getElementById("dialog");
  const dialogTitle = document.getElementById("dialog-title");
  const dialogBody = document.getElementById("dialog-body");
  const toastEl = document.getElementById("toast");

  const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
  const COLOR_NAMES = ["파랑", "초록", "주황", "분홍", "보라", "청록"];
  const MAX_CHIPS = 3; // 달력 칸 하나에 보여 줄 항목 수 (넘치면 +n)
  const HOUR_PX = 52;  // 오늘 화면 타임라인 1시간 높이
  // 달력 종류별 색 (태그 색과 같은 팔레트)
  const KIND = {
    meeting: { label: "회의", color: 4 },
    event: { label: "일정", color: 0 },
    task: { label: "할 일", color: 1 }
  };
  const STATUS = { todo: "대기", doing: "진행중", done: "완료" };

  const store = {
    get(key, fallback) {
      try { return localStorage.getItem(key) ?? fallback; } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, value); } catch (e) { /* 저장 불가 환경 무시 */ }
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch (e) { /* 무시 */ }
    }
  };

  const state = {
    token: store.get("ps.token", ""),
    user: null,
    team: [],
    tags: [],
    positions: [],    // 조직도 자리 [{ id, unitId, title, name, userId, note, sort }] — 계정과 따로, 겸직·공석 포함
    orgBaseDate: "",
    units: [],        // 조직도 [{ id, parentId, name, short, leadId }] — 멤버의 소속 (분류와는 따로)
    ourUnit: store.get("ps.ours", "0") === "1", // 대시보드·할 일·회의에서 '우리 소속'만
    calendars: [],    // 외부(구글) 캘린더 [{ id, name, color, categoryId }] — 가져온 일정은 읽기 전용
    categories: [],   // 분류 [{ id, parentId, name }] (대분류 › 중분류 › 소분류)
    cat: Number(store.get("ps.cat", "")) || null, // 왼쪽에서 고른 분류 (그 아래 분류까지 걸러 보기)
    catOpen: new Set(JSON.parse(store.get("ps.catOpen", "[]") || "[]")), // 펼친 분류
    month: null,      // 대시보드에서 보고 있는 달의 1일 (Date)
    view: store.get("ps.view", "month"),
    search: "",
    navDashOpen: store.get("ps.navDash", "") === "1",
    navProjOpen: store.get("ps.navProj", "") !== "0", // 입출고 관리를 찾기 쉽게 처음에는 펼침
    show: JSON.parse(store.get("ps.show", "null") || "null") || { meeting: true, event: true, task: true },
    peek: null,       // 측면 패널 { type: 'event' | 'task' | 'day', id }
    navOpen: false,
    unreadNotices: 0,  // 안 읽은 공지 수 (사이드바 '공지' 옆)
    sideW: Math.max(200, Math.min(380, Number(store.get("ps.sideW", "248")) || 248)), // 사이드바 폭 (끌어서 조절)
    sideMini: store.get("ps.sideMini", "0") === "1" // 사이드바 접기 (아이콘만)
  };
  let page = null;    // 지금 화면 { name, reload() }

  /* ---------- 유틸 ---------- */
  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k === "html") el.innerHTML = v;
      else if (k === "style") el.style.cssText = v;
      else if (k === "value") el.value = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of [].concat(children || [])) {
      if (c != null && c !== false) el.append(c);
    }
    return el;
  }

  // null·false 는 빼고 자식 바꾸기
  const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseYmd = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const shiftYmd = (s, n) => ymd(addDays(parseYmd(s), n));
  const today = () => ymd(new Date());
  const nowHm = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const minutes = (t) => { const [a, b] = t.split(":").map(Number); return a * 60 + b; };

  function dateLabel(s, opts) {
    const d = parseYmd(s);
    const y = (opts && opts.year) || d.getFullYear() !== new Date().getFullYear() ? `${d.getFullYear()}년 ` : "";
    return `${y}${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAYS[d.getDay()]})`;
  }
  const shortDate = (s) => { const d = parseYmd(s); return `${d.getMonth() + 1}/${d.getDate()}`; };
  function relDay(s) {
    const diff = Math.round((parseYmd(s) - parseYmd(today())) / 86400000);
    return { "-1": "어제", 0: "오늘", 1: "내일" }[diff] || null;
  }
  const hm = (t) => t || "";
  function timeRange(e) {
    if (!e.startTime) return e.startDate !== e.endDate ? `${shortDate(e.startDate)} ~ ${shortDate(e.endDate)}` : "종일";
    return e.endTime ? `${e.startTime} - ${e.endTime}` : e.startTime;
  }
  function whenLabel(e) {
    const range = e.startDate === e.endDate ? dateLabel(e.startDate) : `${dateLabel(e.startDate)} ~ ${dateLabel(e.endDate)}`;
    if (!e.startTime) return `${range} · 종일`;
    return `${range} · ${e.startTime}${e.endTime ? " - " + e.endTime : ""}`;
  }
  // 서버 시각은 UTC 'YYYY-MM-DD HH:MM:SS'
  function ago(s) {
    if (!s) return "";
    const t = new Date(s.replace(" ", "T") + "Z");
    const diff = (Date.now() - t) / 1000;
    if (diff < 60) return "방금";
    if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}일 전`;
    return `${t.getFullYear()}.${pad(t.getMonth() + 1)}.${pad(t.getDate())}`;
  }
  // 회의 진행 상태 (지금 시각 기준)
  function meetingState(e) {
    const t = today(), n = nowHm();
    if (e.endDate < t) return "done";
    if (e.startDate > t) return "todo";
    if (!e.startTime) return "doing";
    if (e.startDate === t && n < e.startTime) return "todo";
    if (e.endDate === t && e.endTime && n >= e.endTime) return "done";
    return "doing";
  }
  const MEETING_STATE = { todo: "예정", doing: "진행중", done: "완료" };

  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), 2400);
  }

  async function api(path, opts) {
    const o = opts || {};
    const res = await fetch(API + path, {
      method: o.method || "GET",
      headers: Object.assign({ "Content-Type": "application/json" }, state.token ? { Authorization: "Bearer " + state.token } : {}),
      body: o.body ? JSON.stringify(o.body) : undefined
    }).catch(() => null);
    if (!res) throw Object.assign(new Error("인터넷 연결을 확인해 주세요."), { status: 0 });
    if (res.status === 401 && path !== "/login" && path !== "/password") {
      logout(true);
      throw Object.assign(new Error("다시 로그인해 주세요."), { status: 401 });
    }
    const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || "문제가 생겼어요. 잠시 뒤 다시 시도해 주세요."), { status: res.status, field: data.field });
    return data;
  }
  // 고치고 나서 화면 새로고침 (실패하면 알림만)
  async function act(fn, done) {
    try { const r = await fn(); if (done) toast(done); return r; } catch (e) { if (e.status !== 401) toast(e.message); throw e; }
  }
  const quiet = (p) => p.catch(() => {});

  const ICON = {
    left: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
    right: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h3l1.5 4.5L8.5 10a12 12 0 0 0 5.5 5.5l1.5-2L20 15v3a2 2 0 0 1-2 2A14 14 0 0 1 4 6a2 2 0 0 1 2-2z"/></svg>',
    menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
    home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11l8-6.5 8 6.5V20H4z"/><path d="M10 20v-5h4v5"/></svg>',
    grid: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2.5"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/></svg>',
    people: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19c.8-3 3-4.6 5.5-4.6s4.7 1.6 5.5 4.6"/><circle cx="16.5" cy="9.5" r="2.5"/><path d="M15.5 14.6c2.3-.2 4.2 1.2 5 3.9"/></svg>',
    note: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8.5L19 8v12.5H6z"/><path d="M14 3.5V8h5M9 12.5h7M9 16h5"/></svg>',
    bell: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>',
    user: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5"/></svg>',
    tag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 12.5V4.5h8l9 9-8 8z"/><circle cx="8" cy="9" r="1.4"/></svg>',
    pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6l-1 6 3 3H7l3-3-1-6zM12 13v7"/></svg>',
    place: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg>',
    clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    cal: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2.5"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>',
    chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 18.5V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H8.5z"/></svg>',
    list: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/></svg>',
    star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l2.4 5 5.4.6-4 3.7 1.1 5.4L12 16l-4.9 2.7 1.1-5.4-4-3.7 5.4-.6z"/></svg>',
    link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
    doc: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8.5L19 8v12.5H6z"/><path d="M14 3.5V8h5"/></svg>',
    todo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7l2 2 3.5-3.5M5 15l2 2 3.5-3.5M13.5 8H20M13.5 16H20"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/></svg>',
    trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13"/></svg>',
    edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
    folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>',
    lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"/></svg>',
    grip: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></svg>',
    org: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3.5" width="6" height="5" rx="1.2"/><rect x="3" y="15.5" width="6" height="5" rx="1.2"/><rect x="15" y="15.5" width="6" height="5" rx="1.2"/><path d="M12 8.5v3.5M6 15.5V12h12v3.5"/></svg>',
    db: '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="6" rx="7" ry="2.5"/><path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/></svg>',
    gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/></svg>'
  };
  const icon = (name, cls) => h("span", { class: "ic" + (cls ? " " + cls : ""), html: ICON[name], "aria-hidden": "true" });

  /* ---------- 팀·태그 ---------- */
  const member = (id) => state.team.find((u) => u.id === id);
  const tagOf = (id) => state.tags.find((t) => t.id === id);
  function avatar(id, size) {
    const u = member(id);
    const name = u ? u.name : "?";
    return h("span", { class: `avatar c${u ? u.id % 6 : 0}` + (size ? " avatar--" + size : ""), title: name, text: name.replace(/\s/g, "").slice(-2) });
  }
  function personLine(id) {
    const u = member(id);
    if (!u) return h("span", { class: "muted", text: "담당자 없음" });
    return h("span", { class: "person" }, [avatar(id, "sm"), h("span", { text: u.name })]);
  }
  function tagChip(id) {
    const t = tagOf(id);
    return t ? h("span", { class: `tag c${t.color}`, text: t.name }) : null;
  }
  const tagChips = (list) => (list || []).map(tagChip).filter(Boolean);
  const kindDot = (kind) => h("i", { class: `dot c${KIND[kind].color}` });
  // 일정 하나: 우리 일정(회의·일정) 또는 외부 캘린더에서 가져온 일정(ext, 읽기 전용)
  // 팀 색: 운영총괄부 › 운영총괄팀 = 주황(고정), 기념품팀 = 원래 색(회의 보라·일정 파랑),
  // 다른 팀은 남은 색을 조직 순서대로 자동으로 (팀이 늘어도 기존 팀 색은 그대로). 아래 팀은 고정 팀 색을 따름
  const TEAM_FIXED = [{ path: ["운영총괄부", "운영총괄팀"], color: 2 }, { path: ["운영총괄부", "기념품팀"], color: null }];
  const TEAM_POOL = [5, 3, 6, 7, 8, 9]; // 주황(고정)·파랑·보라(원래 색)·초록(할 일) 빼고
  let teamColors = { units: null, map: new Map() };
  function teamColor(unitId) {
    if (!unitId) return null;
    if (teamColors.units !== state.units) {
      const map = new Map();
      const fixedOf = (u) => TEAM_FIXED.find((f) => u.name === f.path[1] && unitOf(u.parentId)?.name === f.path[0]);
      let n = 0;
      for (const u of [...state.units].sort((a, b) => a.id - b.id)) {
        let fixed = null;
        for (let x = u; x && !fixed; x = x.parentId ? unitOf(x.parentId) : null) fixed = fixedOf(x);
        map.set(u.id, fixed ? fixed.color : TEAM_POOL[n++ % TEAM_POOL.length]);
      }
      teamColors = { units: state.units, map };
    }
    return teamColors.map.get(unitId) ?? null;
  }
  const evColor = (e) => (e.ext ? e.color : teamColor(e.unitId) ?? KIND[e.kind].color);
  // 구글 캘린더에서 우리 소속으로 넣은 일정: 'WYD 캘린더 백업' 표시 (원본은 달력·검색에서 숨김)
  const srcTag = (e, short) => (e.sourceName ? h("span", { class: "src-tag", title: `${e.sourceName} 캘린더 백업 (구글 캘린더에서 가져온 일정)`, text: short ? e.sourceName : `${e.sourceName} 캘린더 백업` }) : null);
  const evDot = (e) => h("i", { class: `dot c${evColor(e)}` });
  const evKey = (e) => (e.ext ? "ext:" : "event:") + e.id;
  const openEv = (e) => openPeek(e.ext ? "ext" : "event", e.id);
  const showEv = (e) => (e.ext ? state.show["cal" + e.calendarId] !== false : state.show[e.kind]);
  const allEvents = (r) => r.events.concat(r.external || []);
  // 같은 WYD 원본을 여러 팀이 넣었으면 하나만 보여 줌 (내 소속 팀 것 먼저), 나머지는 alsoIn 으로
  function dedupeImported(list) {
    const mine = myVisibleUnits(), first = new Map(), out = [];
    const score = (e) => (e.unitId === myUnit() ? 0 : mine.has(e.unitId) ? 1 : 2);
    for (const e of list) {
      if (!e.sourceKey) { out.push(e); continue; }
      const kept = first.get(e.sourceKey);
      if (!kept) { const copy = { ...e, alsoIn: [] }; first.set(e.sourceKey, copy); out.push(copy); continue; }
      if (score(e) < score(kept)) { // 더 가까운 팀 것으로 바꿔 끼움
        const copy = { ...e, alsoIn: [...kept.alsoIn, { id: kept.id, unitId: kept.unitId }] };
        out[out.indexOf(kept)] = copy; first.set(e.sourceKey, copy);
      } else kept.alsoIn.push({ id: e.id, unitId: e.unitId });
    }
    return out;
  }

  /* ---------- 분류 ---------- */
  const isAdmin = () => state.user && state.user.role === "admin";
  const catOf = (id) => state.categories.find((c) => c.id === id);
  const catChildren = (pid) => state.categories.filter((c) => (c.parentId || null) === (pid || null));
  function catPath(id) {
    const out = [];
    for (let c = catOf(id); c; c = c.parentId ? catOf(c.parentId) : null) out.unshift(c);
    return out;
  }
  const catLabel = (id) => catPath(id).map((c) => c.name).join(" › ");
  function catSubtree(id) {
    const out = [id];
    for (let i = 0; i < out.length; i++) for (const c of catChildren(out[i])) out.push(c.id);
    return new Set(out);
  }
  // 트리를 위에서부터 한 줄씩 [{ c, depth }]
  function catRows(pid, depth, out) {
    out = out || [];
    for (const c of catChildren(pid)) { out.push({ c, depth: depth || 0 }); catRows(c.id, (depth || 0) + 1, out); }
    return out;
  }
  // 왼쪽에서 고른 분류(와 그 아래)에 드는 것만
  function catFilter() {
    if (!state.cat) return () => true;
    const scope = catSubtree(state.cat);
    return (x) => scope.has(x.categoryId);
  }
  // 목록에서는 끝 이름만, 마우스를 올리면 전체 경로
  function catChip(id) {
    const c = catOf(id);
    return c ? h("span", { class: "cat", title: catLabel(id) }, [icon("folder"), h("span", { text: c.name })]) : null;
  }
  /* ---------- 조직도 (소속) ---------- */
  const unitOf = (id) => state.units.find((u) => u.id === id);
  const unitChildren = (pid) => state.units.filter((u) => (u.parentId || null) === (pid || null));
  function unitPath(id) {
    const out = [];
    for (let u = unitOf(id); u; u = u.parentId ? unitOf(u.parentId) : null) out.unshift(u);
    return out;
  }
  const unitLabel = (id) => unitPath(id).map((u) => u.name).join(" › ");
  const unitShort = (id) => { const u = unitOf(id); return u ? u.short || u.name : ""; }; // 참석자·담당자 옆 (약칭 먼저)
  function unitSubtree(id) {
    const out = [id];
    for (let i = 0; i < out.length; i++) for (const u of unitChildren(out[i])) out.push(u.id);
    return new Set(out);
  }
  function unitRows(pid, depth, out) {
    out = out || [];
    for (const u of unitChildren(pid)) { out.push({ u, depth: depth || 0 }); unitRows(u.id, (depth || 0) + 1, out); }
    return out;
  }
  const personSub = (m) => (m && m.unitId && unitOf(m.unitId) ? unitShort(m.unitId) : "");
  // '우리 소속' 거르기: 내 소속(과 그 아래)의 팀원이 참석·담당하는 것, 그 소속에 연결한 구글 캘린더
  const myUnit = () => {
    const t = state.team.find((m) => m.id === state.user.id); // 관리자가 내 소속을 바꿨을 때 팀 목록이 최신
    if (t) state.user.unitId = t.unitId;
    return state.user.unitId && unitOf(state.user.unitId) ? state.user.unitId : null;
  };
  // 관리자가 추가로 지정한 볼 수 있는 조직 [{ unitId, sub }] → '기념품팀, 운영총괄부(부만)'
  const viewGrantsText = (grants) => (grants || []).filter((g) => unitOf(g.unitId)).map((g) => `${unitShort(g.unitId)}${g.sub || !unitChildren(g.unitId).length ? "" : "(그 조직만)"}`).join(", ");
  // 내가 볼 수 있는 조직 (서버 규칙과 같게): 내 소속과 그 아래 + 추가 지정
  function myVisibleUnits() {
    const set = new Set(myUnit() ? unitSubtree(myUnit()) : []);
    for (const g of state.user.viewUnits || []) if (unitOf(g.unitId)) for (const id of g.sub ? unitSubtree(g.unitId) : [g.unitId]) set.add(id);
    return set;
  }
  function ourFilter() {
    if (!state.ourUnit || !myUnit()) return () => true;
    const units = unitSubtree(myUnit());
    const ids = new Set(state.team.filter((m) => units.has(m.unitId)).map((m) => m.id));
    return (x) => {
      if (x.ext) { const c = state.calendars.find((k) => k.id === x.calendarId); return !!(c && units.has(c.unitId)); }
      if ("assigneeId" in x) return ids.has(x.assigneeId);
      return (x.attendeeIds || []).some((id) => ids.has(id)) || ids.has(x.createdBy);
    };
  }
  function ourToggle(onChange) {
    if (!myUnit()) return null;
    return h("div", { class: "seg seg--sm", title: `우리 소속: ${unitLabel(myUnit())}` }, [[false, "전체"], [true, "우리 소속"]].map(([k, label]) => h("button", {
      type: "button", "aria-selected": String(state.ourUnit === k), text: label,
      onclick: () => { state.ourUnit = k; store.set("ps.ours", k ? "1" : "0"); onChange(); }
    })));
  }
  // 항목의 팀 (보이는 범위): 만든 사람의 소속으로 자동, 만든 사람·관리자만 바꿈
  const canEditTeam = (x) => isAdmin() || x.createdBy === state.user.id;
  const teamName = (id) => (id && unitOf(id) ? unitShort(id) : "팀 없음");
  function teamButton(selected, onChange, cls) {
    const b = h("button", { class: cls || "select-btn", type: "button", title: "이 팀(과 위 조직) 사람들, 그리고 관련된 사람이 볼 수 있어요" });
    const draw = () => b.replaceChildren(h("span", { class: "catpath" }, [icon("org"), h("span", { text: selected && unitOf(selected) ? unitLabel(selected) : "팀 없음 (관련된 사람·관리자만)" })]));
    b.addEventListener("click", () => unitPicker(b, selected, (id) => { selected = id; draw(); onChange(id); }, { noneLabel: "팀 없음 (관련된 사람·관리자만)" }));
    draw();
    return b;
  }
  const teamInfo = (id) => h("span", { class: "catpath muted", title: "보이는 범위" }, [icon("org"), h("span", { text: id && unitOf(id) ? unitLabel(id) : "팀 없음 (관련된 사람·관리자만)" })]);

  // 관리자 전용 표시 (주황)
  const adminBadge = (label) => h("span", { class: "admin-badge" }, [icon("lock"), label || "관리자 전용"]);

  function setCategories(list) {
    state.categories = list || [];
    if (state.cat && !catOf(state.cat)) { state.cat = null; store.remove("ps.cat"); }
    drawCatsNav();
  }

  /* ---------- 대화 상자 ---------- */
  function openDialog(title, body, opts) {
    dialogTitle.textContent = title;
    if (opts && opts.admin) dialogTitle.append(" ", adminBadge());
    dialogBody.replaceChildren(body);
    dialog.classList.toggle("dialog--wide", !!(opts && opts.wide));
    dialog.classList.toggle("dialog--admin", !!(opts && opts.admin));
    if (!dialog.open) dialog.showModal();
    const first = dialogBody.querySelector("[autofocus]");
    if (first) first.focus();
  }
  function closeDialog() { closePop(); if (dialog.open) dialog.close(); }
  dialog.addEventListener("close", () => closePop());
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog || e.target.closest("[data-close]")) closeDialog();
  });

  function field(label, input, hint) {
    return h("label", { class: "field" }, [h("span", { class: "field__label", text: label }), input, hint ? h("span", { class: "field__hint", text: hint }) : null]);
  }
  function errorLine() { return h("p", { class: "form-error", role: "alert", hidden: true }); }
  function showError(el, msg) { el.textContent = msg; el.hidden = !msg; }
  async function busy(btn, fn) {
    btn.disabled = true;
    try { return await fn(); } finally { btn.disabled = false; }
  }
  function confirmDialog(title, message, okLabel, onOk) {
    const err = errorLine();
    const ok = h("button", { class: "btn btn--danger", type: "button", text: okLabel });
    ok.addEventListener("click", () => busy(ok, async () => {
      try { await onOk(); } catch (e) { showError(err, e.message); }
    }));
    openDialog(title, h("div", { class: "stack" }, [
      h("p", { class: "muted", text: message }), err,
      h("div", { class: "actions" }, [h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), ok])
    ]));
  }

  /* ---------- 작은 팝업 (태그·사람·상태 고르기) ---------- */
  let openPop = null;
  function popover(anchor, content) {
    closePop();
    const el = h("div", { class: "pop", role: "dialog" }, content);
    // 모달 대화상자가 열려 있으면 그 안에 붙임 (body 에 붙이면 대화상자 뒤에 그려져 보이지도, 눌리지도 않음)
    (dialog.open ? dialog : document.body).append(el);
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth, hgt = el.offsetHeight;
    let left = Math.min(r.left, window.innerWidth - w - 12);
    let top = r.bottom + 6;
    if (top + hgt > window.innerHeight - 12) top = Math.max(12, r.top - hgt - 6);
    el.style.left = Math.max(12, left) + "px";
    el.style.top = top + "px";
    openPop = { el, anchor };
    const f = el.querySelector("input, button");
    if (f) f.focus();
    return el;
  }
  function closePop() { if (openPop) { openPop.el.remove(); openPop = null; } }
  document.addEventListener("mousedown", (e) => {
    if (openPop && !openPop.el.contains(e.target) && !openPop.anchor.contains(e.target)) closePop();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && openPop) { e.stopPropagation(); e.preventDefault(); closePop(); } }, true);
  // 대화상자 안 팝업이 열려 있을 때 Esc 는 팝업만 닫음
  dialog.addEventListener("cancel", (e) => { if (openPop) { e.preventDefault(); closePop(); } });

  // 태그 고르기 (여러 개) — 고를 때마다 onChange(ids)
  function tagPicker(anchor, selected, onChange) {
    const sel = new Set(selected || []);
    const list = h("div", { class: "pop__list" });
    const input = h("input", { placeholder: "태그 찾기 또는 새로 만들기", "aria-label": "태그 이름" });
    function draw() {
      const qv = input.value.trim();
      const items = state.tags.filter((t) => !qv || t.name.includes(qv));
      list.replaceChildren(...items.map((t) => h("button", { type: "button", class: "pop__item" + (sel.has(t.id) ? " is-on" : ""), onclick: () => {
        sel.has(t.id) ? sel.delete(t.id) : sel.add(t.id);
        onChange([...sel]);
        draw();
      } }, [h("span", { class: "pop__check", html: sel.has(t.id) ? ICON.check : "" }), tagChip(t.id)])));
      if (qv && !state.tags.some((t) => t.name === qv)) {
        list.append(h("button", { type: "button", class: "pop__item pop__item--new", onclick: async () => {
          const r = await act(() => api("/tags", { method: "POST", body: { name: qv, color: state.tags.length % 6 } }));
          state.tags = r.tags;
          drawTagsNav();
          sel.add(r.tag.id);
          input.value = "";
          onChange([...sel]);
          draw();
        } }, [icon("plus"), h("span", { text: `'${qv}' 태그 만들기` })]));
      }
      if (!list.childElementCount) list.append(h("p", { class: "pop__empty", text: "태그가 없어요." }));
    }
    input.addEventListener("input", draw);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); const b = list.querySelector(".pop__item"); if (b) b.click(); } });
    draw();
    popover(anchor, [input, list, h("button", { type: "button", class: "pop__foot", onclick: () => { closePop(); manageTags(); } }, [icon("gear"), "태그 관리"])]);
  }

  // 분류 고르기 (하나) — 고르면 onChange(id 또는 null)
  function categoryPicker(anchor, selected, onChange) {
    const list = h("div", { class: "pop__list" });
    const input = h("input", { placeholder: "분류 찾기", "aria-label": "분류 찾기" });
    const pick = (id) => { closePop(); onChange(id); };
    function draw() {
      const qv = input.value.trim();
      const rows = catRows(null).filter(({ c }) => !qv || catLabel(c.id).includes(qv));
      fill(list,
        qv ? null : h("button", { type: "button", class: "pop__item muted" + (!selected ? " is-on" : ""), onclick: () => pick(null) }, [h("span", { class: "pop__check", html: !selected ? ICON.check : "" }), "분류 없음"]),
        ...rows.map(({ c, depth }) => h("button", { type: "button", class: "pop__item" + (c.id === selected ? " is-on" : ""), style: qv ? null : `padding-left:${8 + depth * 16}px`, onclick: () => pick(c.id) }, [
          h("span", { class: "pop__check", html: c.id === selected ? ICON.check : "" }),
          h("span", { class: "pop__name" }, [c.name, qv && c.parentId ? h("small", { text: catLabel(c.parentId) }) : null])
        ]))
      );
      if (!rows.length) list.append(h("p", { class: "pop__empty", text: state.categories.length ? "찾는 분류가 없어요." : isAdmin() ? "아직 분류가 없어요. 아래 '분류 관리'에서 만들어 주세요." : "아직 분류가 없어요. 관리자가 만들 수 있어요." }));
    }
    input.addEventListener("input", draw);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); const b = list.querySelector(".pop__item:not(.muted)"); if (b) b.click(); } });
    draw();
    popover(anchor, [state.categories.length > 8 ? input : null, list, isAdmin() ? h("button", { type: "button", class: "pop__foot", onclick: () => { closePop(); manageCategories(); } }, [icon("gear"), "분류 관리"]) : null].filter(Boolean));
  }
  // 폼·패널에서 쓰는 분류 버튼 (전체 경로를 보여 줌)
  function categoryButton(selected, onChange, cls) {
    const b = h("button", { class: cls || "select-btn", type: "button" });
    const draw = () => b.replaceChildren(selected ? h("span", { class: "catpath" }, [icon("folder"), h("span", { text: catLabel(selected) })]) : h("span", { class: "muted", text: "분류 고르기" }));
    b.addEventListener("click", () => categoryPicker(b, selected, (id) => { selected = id; draw(); onChange(id); }));
    draw();
    return b;
  }

  // 소속(조직) 고르기 — opts.noneLabel 이 있으면 맨 위에 '없음' 줄
  function unitPicker(anchor, selected, onChange, opts) {
    const o = opts || {};
    const noneLabel = o.noneLabel === undefined ? "소속 없음" : o.noneLabel;
    const list = h("div", { class: "pop__list" });
    const input = h("input", { placeholder: "조직 찾기", "aria-label": "조직 찾기" });
    const pick = (id) => { closePop(); onChange(id); };
    function draw() {
      const qv = input.value.trim();
      const rows = unitRows(null).filter(({ u }) => (!o.only || o.only.has(u.id)) && (!qv || unitLabel(u.id).includes(qv) || (u.short || "").includes(qv)));
      fill(list,
        !qv && noneLabel ? h("button", { type: "button", class: "pop__item muted" + (!selected ? " is-on" : ""), onclick: () => pick(null) }, [h("span", { class: "pop__check", html: !selected ? ICON.check : "" }), noneLabel]) : null,
        ...rows.map(({ u, depth }) => h("button", { type: "button", class: "pop__item" + (u.id === selected ? " is-on" : ""), style: qv ? null : `padding-left:${8 + depth * 16}px`, onclick: () => pick(u.id) }, [
          h("span", { class: "pop__check", html: u.id === selected ? ICON.check : "" }),
          h("span", { class: "pop__name" }, [h("span", { class: depth === 0 ? "strong" : null, text: u.name }), qv && u.parentId ? h("small", { text: unitLabel(u.parentId) }) : null])
        ]))
      );
      if (!rows.length) list.append(h("p", { class: "pop__empty", text: state.units.length ? "찾는 조직이 없어요." : isAdmin() ? "아직 조직도가 없어요. 관리자 메뉴의 '조직도'에서 만들어 주세요." : "아직 조직도가 없어요." }));
    }
    input.addEventListener("input", draw);
    draw();
    popover(anchor, [state.units.length > 8 ? input : null, list].filter(Boolean));
  }

  // 사람 고르기: multi 면 여러 명, 아니면 한 명 (빼기 포함)
  function personPicker(anchor, selected, multi, onChange) {
    const sel = new Set(selected || []);
    const list = h("div", { class: "pop__list" });
    const person = (u) => h("button", { type: "button", class: "pop__item" + (sel.has(u.id) ? " is-on" : ""), onclick: () => {
      if (multi) { sel.has(u.id) ? sel.delete(u.id) : sel.add(u.id); onChange([...sel]); draw(); }
      else { closePop(); onChange(sel.has(u.id) ? null : u.id); }
    } }, [h("span", { class: "pop__check", html: sel.has(u.id) ? ICON.check : "" }), avatar(u.id, "sm"), h("span", { class: "pop__name" }, [u.name, personSub(u) ? h("small", { text: personSub(u) }) : null])]);
    function draw() {
      const items = [];
      if (!state.units.length) items.push(...state.team.map(person));
      else {
        // 소속별로 묶음 (조직도 순서), 여러 명 고를 땐 '○○ 전체 넣기'
        const groups = unitRows(null).map(({ u }) => [u, state.team.filter((m) => m.unitId === u.id)]).filter(([, l]) => l.length);
        const none = state.team.filter((m) => !m.unitId || !unitOf(m.unitId));
        if (none.length) groups.push([null, none]);
        for (const [u, people] of groups) {
          const allIn = people.every((m) => sel.has(m.id));
          items.push(h("div", { class: "pop__group" }, [
            h("span", { text: u ? unitShort(u.id) : "소속 미지정", title: u ? unitLabel(u.id) : null }),
            multi ? h("button", { type: "button", class: "link-btn", text: allIn ? "전체 빼기" : `${u ? unitShort(u.id) : "미지정"} 전체 넣기`, onclick: () => {
              people.forEach((m) => (allIn ? sel.delete(m.id) : sel.add(m.id)));
              onChange([...sel]); draw();
            } }) : null
          ]), ...people.map(person));
        }
      }
      if (!multi && sel.size) items.push(h("button", { type: "button", class: "pop__item muted", onclick: () => { closePop(); onChange(null); } }, [h("span", { class: "pop__check" }), "담당자 빼기"]));
      list.replaceChildren(...items);
    }
    draw();
    popover(anchor, list);
  }

  function statusButton(t, onChange) {
    const b = h("button", { type: "button", class: `status status--${t.status}`, text: STATUS[t.status], "aria-label": `상태: ${STATUS[t.status]}` });
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      popover(b, h("div", { class: "pop__list" }, Object.keys(STATUS).map((s) => h("button", { type: "button", class: "pop__item" + (s === t.status ? " is-on" : ""), onclick: () => { closePop(); onChange(s); } }, [h("span", { class: "pop__check", html: s === t.status ? ICON.check : "" }), h("span", { class: `status status--${s}`, text: STATUS[s] })]))));
    });
    return b;
  }

  function checkbox(t, onChange) {
    const c = h("input", { type: "checkbox", class: "task-check", checked: t.status === "done", "aria-label": `${t.title} 완료` });
    c.addEventListener("click", (e) => e.stopPropagation());
    c.addEventListener("change", () => onChange(c.checked ? "done" : t.status === "done" ? "todo" : t.status === "doing" ? "doing" : "todo"));
    return c;
  }
  function dueBadge(t) {
    if (!t.dueDate) return null;
    const td = today();
    const late = t.status !== "done" && t.dueDate < td;
    // 시작일과 마감일이 같으면 한 날짜, 다르면 기간 (11/4~11/13)
    const when = t.startDate && t.startDate !== t.dueDate ? `${shortDate(t.startDate)}~${shortDate(t.dueDate)}` : shortDate(t.dueDate);
    return h("span", { class: "due" + (late ? " due--late" : t.dueDate === td ? " due--today" : ""), title: relDay(t.dueDate) || null, text: late ? `${when} 지남` : when });
  }

  async function patchTask(t, body) {
    const r = await act(() => api(`/tasks/${t.id}`, { method: "PATCH", body }));
    refresh();
    return r.task;
  }

  /* ---------- 로그인: 직원·봉사자를 먼저 고르고, 고른 쪽 입력 화면으로 (마지막 선택은 기억) ---------- */
  const LOGIN_AS = {
    staff: { title: "직원 로그인", pick: "직원", desc: "조직위 직원 · 관리자", icon: "user" },
    volunteer: { title: "봉사자 로그인", pick: "봉사자", desc: "봉사자 전용 화면", icon: "people" }
  };
  // 봉사자 화면·봉사자 로그인은 노란색 바탕 (색은 styles.css 의 .theme-volunteer)
  function volunteerTheme(on) {
    document.documentElement.classList.toggle("theme-volunteer", on);
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
      m.dataset.base ??= m.content;
      m.content = on ? "#ffd43b" : m.dataset.base;
    });
  }
  const authBrand = () => h("div", { class: "brand brand--lg" }, [h("img", { src: "favicon.svg", alt: "" }), h("span", { text: TITLE })]);
  function renderLogin(message, as, keepId) {
    document.title = TITLE;
    const mode = LOGIN_AS[as] ? as : store.get("ps.loginAs", "");
    if (!LOGIN_AS[mode]) return renderLoginChoice(message);
    const info = LOGIN_AS[mode];
    volunteerTheme(mode === "volunteer");
    const err = errorLine();
    const login = h("input", { name: "login", autocomplete: "username", autocapitalize: "none", spellcheck: "false", required: true, value: keepId || "" });
    const pw = h("input", { name: "password", type: "password", autocomplete: "current-password", required: true });
    const submit = h("button", { class: "btn btn--primary btn--block", type: "submit", text: "로그인" });
    const form = h("form", { class: "auth__card stack", novalidate: true }, [
      authBrand(),
      h("h1", { class: "auth__title", text: info.title }),
      field("아이디", login), field("비밀번호", pw), err, submit,
      h("button", { class: "link-btn auth__back", type: "button", text: "직원·봉사자 다시 고르기", onclick: () => { store.remove("ps.loginAs"); renderLoginChoice(); } }),
      h("p", { class: "auth__foot", text: "계정이 없거나 비밀번호를 잊었다면 관리자에게 문의해 주세요." })
    ]);
    if (message) showError(err, message);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!login.value.trim() || !pw.value) return showError(err, "아이디와 비밀번호를 적어 주세요.");
      busy(submit, async () => {
        try {
          const r = await api("/login", { method: "POST", body: { login: login.value, password: pw.value, as: mode } });
          state.token = r.token;
          store.set("ps.token", r.token);
          store.set("ps.loginAs", mode);
          await boot();
        } catch (ex) {
          if (ex.field === "as") { // 다른 쪽 계정: 맞는 화면으로 옮겨 주기 (비밀번호는 다시)
            const other = mode === "staff" ? "volunteer" : "staff";
            store.set("ps.loginAs", other);
            return renderLogin(`${ex.message} ${LOGIN_AS[other].title} 화면으로 옮겼어요. 비밀번호를 다시 적어 주세요.`, other, login.value);
          }
          showError(err, ex.message); pw.select();
        }
      });
    });
    app.replaceChildren(h("main", { class: "auth" }, form));
    (keepId ? pw : login).focus();
  }
  function renderLoginChoice(message) {
    volunteerTheme(false);
    const pick = (as) => h("button", { class: "auth__pick", type: "button", onclick: () => { store.set("ps.loginAs", as); renderLogin(message, as); } }, [
      icon(LOGIN_AS[as].icon),
      h("span", { class: "auth__pick-text" }, [h("strong", { text: LOGIN_AS[as].pick }), h("span", { class: "muted small", text: LOGIN_AS[as].desc })]),
      icon("right")
    ]);
    const err = errorLine();
    if (message) showError(err, message);
    app.replaceChildren(h("main", { class: "auth" }, h("div", { class: "auth__card stack" }, [
      authBrand(),
      h("h1", { class: "auth__title", text: "어느 쪽으로 로그인할까요?" }),
      err, pick("staff"), pick("volunteer"),
      h("p", { class: "auth__foot", text: "계정이 없거나 비밀번호를 잊었다면 관리자에게 문의해 주세요." })
    ])));
  }

  function passwordForm(onDone, forced) {
    const err = errorLine();
    const cur = h("input", { type: "password", autocomplete: "current-password", autofocus: true });
    const next = h("input", { type: "password", autocomplete: "new-password" });
    const again = h("input", { type: "password", autocomplete: "new-password" });
    const submit = h("button", { class: "btn btn--primary btn--block", type: "submit", text: "비밀번호 바꾸기" });
    const form = h("form", { class: "stack", novalidate: true }, [
      forced ? h("p", { class: "notice-box", text: "처음 받은 비밀번호예요. 나만 아는 비밀번호로 바꿔 주세요." }) : null,
      field(forced ? "받은 비밀번호" : "지금 비밀번호", cur),
      field("새 비밀번호", next, "6자 이상"),
      field("새 비밀번호 확인", again), err, submit
    ]);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (next.value.trim() !== again.value.trim()) return showError(err, "새 비밀번호가 서로 달라요.");
      busy(submit, async () => {
        try {
          await api("/password", { method: "POST", body: { current: cur.value, next: next.value } });
          state.user.mustChangePassword = false;
          toast("비밀번호를 바꿨어요.");
          onDone();
        } catch (ex) { showError(err, ex.message); (ex.field === "current" ? cur : next).select(); }
      });
    });
    return form;
  }

  function renderForcedPassword() {
    const card = h("div", { class: "auth__card stack" }, [
      h("div", { class: "brand brand--lg" }, [h("img", { src: "favicon.svg", alt: "" }), h("span", { text: TITLE })]),
      h("h1", { class: "auth__title", text: `${state.user.name}님, 반가워요` }),
      passwordForm(render, true),
      h("button", { class: "btn btn--ghost btn--block", type: "button", text: "로그아웃", onclick: () => logout() })
    ]);
    app.replaceChildren(h("main", { class: "auth" }, card));
  }

  async function logout(expired) {
    if (!expired && state.token) api("/logout", { method: "POST" }).catch(() => {});
    state.token = "";
    state.user = null;
    state.peek = null;
    store.remove("ps.token");
    closeDialog();
    closePop();
    renderLogin(expired ? "로그인 시간이 지났어요. 다시 로그인해 주세요." : "");
  }

  /* ---------- 틀: 사이드바 + 본문 + 측면 패널 ---------- */
  const layout = {};
  function route() {
    const [, name = "today", id] = location.hash.replace(/^#/, "").split("/");
    return { name, id };
  }
  function go(hash) { if (location.hash !== hash) location.hash = hash; else render(); }

  // 안 읽은 공지 수: 바뀌면 메뉴만 다시 그림. 2분마다·창으로 돌아올 때 새로 확인
  function setUnreadNotices(n) {
    if (typeof n !== "number" || n === state.unreadNotices) return;
    state.unreadNotices = n;
    if (layout.nav) drawNav(navActive);
  }
  const checkNotices = () => { if (state.token && state.user && state.user.role !== "volunteer" && document.visibilityState === "visible") quiet(api("/notices/unread").then((r) => setUnreadNotices(r.unreadNotices))); };
  setInterval(checkNotices, 120000);
  document.addEventListener("visibilitychange", checkNotices);

  // 사이드바: 접기(아이콘만) / 펼치기, 오른쪽 가장자리를 끌어서 폭 조절 (이 브라우저에 기억)
  function applySide() {
    const shell = app.querySelector(".shell");
    if (!shell) return;
    shell.style.setProperty("--side-w", state.sideMini ? "68px" : state.sideW + "px");
    shell.classList.toggle("side-mini", state.sideMini);
    const b = shell.querySelector(".side__collapse");
    if (b) { b.setAttribute("aria-label", state.sideMini ? "메뉴 펼치기" : "메뉴 접기"); b.title = state.sideMini ? "메뉴 펼치기" : "메뉴 접기"; b.setAttribute("aria-expanded", String(!state.sideMini)); }
  }
  function toggleSideMini() {
    state.sideMini = !state.sideMini;
    store.set("ps.sideMini", state.sideMini ? "1" : "0");
    applySide();
    if (!state.sideMini) requestAnimationFrame(drawTagsNav);
  }
  function sideResizer() {
    const el = h("div", { class: "side__resize", role: "separator", "aria-orientation": "vertical", "aria-label": "메뉴 폭 조절 (좌우 화살표)", tabindex: "0", title: "끌어서 폭 조절 · 두 번 누르면 처음 폭" });
    const set = (w) => { state.sideW = Math.max(200, Math.min(380, Math.round(w))); store.set("ps.sideW", String(state.sideW)); if (state.sideMini) { state.sideMini = false; store.set("ps.sideMini", "0"); } applySide(); };
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      app.querySelector(".shell").classList.add("is-resizing");
      const move = (ev) => set(ev.clientX);
      const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); app.querySelector(".shell")?.classList.remove("is-resizing"); drawTagsNav(); };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
    });
    el.addEventListener("dblclick", () => { set(248); drawTagsNav(); });
    el.addEventListener("keydown", (e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); set(state.sideW + (e.key === "ArrowLeft" ? -16 : 16)); } });
    return el;
  }

  function buildLayout() {
    layout.main = h("main", { class: "main", id: "main" });
    layout.peek = h("aside", { class: "peek", "aria-label": "상세 패널", hidden: true });
    layout.nav = h("nav", { class: "side__nav", "aria-label": "메뉴" });
    layout.mini = h("div", { class: "mini" });
    layout.tags = h("div", { class: "side__tags" });
    layout.cats = h("div", { class: "side__cats" });
    layout.unitNav = h("div", { class: "side__units" });
    layout.admin = isAdmin() ? h("section", { class: "side__admin", "aria-label": "관리자 전용 메뉴" }) : null;
    layout.cals = h("div", { class: "side__cals" });
    const account = h("button", { class: "side__account", type: "button" }, [avatar(state.user.id), h("span", { class: "side__who" }, [h("strong", { text: state.user.name }),
      h("small", { text: personSub(state.user) || (isAdmin() ? "" : "소속 없음") }), isAdmin() ? h("small", { class: "side__adminmark" }, [icon("lock"), "관리자 권한"]) : null])]);
    account.addEventListener("click", () => popover(account, h("div", { class: "pop__list" }, [
      h("button", { type: "button", class: "pop__item", onclick: () => { closePop(); openDialog("비밀번호 변경", passwordForm(closeDialog)); } }, "비밀번호 변경"),
      h("button", { type: "button", class: "pop__item", onclick: () => { closePop(); logout(); } }, "로그아웃")
    ])));
    layout.side = h("aside", { class: "side" }, [
      h("div", { class: "side__top" }, [
        h("a", { class: "brand", href: "#/today", title: TITLE }, [h("img", { src: "favicon.svg", alt: "" }), h("span", { class: "side__text", text: TITLE })]),
        h("button", { class: "icon-btn side__collapse", type: "button", html: ICON.left, onclick: toggleSideMini }),
        h("button", { class: "icon-btn side__close", type: "button", "aria-label": "메뉴 닫기", html: ICON.close, onclick: () => toggleNav(false) })
      ]),
      h("button", { class: "btn btn--dark btn--block side__add", type: "button", title: "일정 / 할 일 추가", onclick: () => quickAdd() }, [icon("plus"), h("span", { class: "side__text", text: "일정 / 할 일 추가" })]),
      layout.nav,
      h("div", { class: "side__section" }, [h("div", { class: "side__label", text: "내 소속" }), layout.unitNav]),
      layout.admin,
      h("div", { class: "side__section" }, [
        h("div", { class: "side__label" }, ["분류", isAdmin() ? h("button", { class: "icon-btn icon-btn--xs icon-btn--admin", type: "button", "aria-label": "분류 관리 (관리자 전용)", title: "분류 관리 (관리자 전용)", html: ICON.gear, onclick: () => manageCategories() }) : null]),
        layout.cats
      ]),
      h("div", { class: "side__section" }, [
        h("div", { class: "side__label" }, ["내 캘린더", isAdmin() ? h("button", { class: "icon-btn icon-btn--xs icon-btn--admin", type: "button", "aria-label": "구글 캘린더 연결 (관리자 전용)", title: "구글 캘린더 연결 (관리자 전용)", html: ICON.gear, onclick: () => manageCalendars() }) : null]),
        layout.cals
      ]),
      layout.mini,
      h("div", { class: "side__section" }, [
        h("div", { class: "side__label" }, ["자주 쓰는 태그", h("button", { class: "icon-btn icon-btn--xs", type: "button", "aria-label": "태그 관리", title: "태그 관리", html: ICON.gear, onclick: () => manageTags() })]),
        layout.tags
      ]),
      account,
      sideResizer()
    ]);
    layout.topbar = h("header", { class: "mobilebar" }, [
      h("button", { class: "icon-btn", type: "button", "aria-label": "메뉴", html: ICON.menu, onclick: () => toggleNav(true) }),
      h("a", { class: "brand", href: "#/today" }, [h("img", { src: "favicon.svg", alt: "" }), h("span", { text: TITLE })]),
      h("button", { class: "icon-btn", type: "button", "aria-label": "추가", html: ICON.plus, onclick: () => quickAdd() })
    ]);
    layout.scrim = h("div", { class: "scrim", onclick: () => toggleNav(false) });
    app.replaceChildren(h("div", { class: "shell" }, [layout.side, layout.scrim, h("div", { class: "content" }, [layout.topbar, layout.main]), layout.peek]));
    applySide();
    drawCalsNav();
    drawTagsNav();
    drawCatsNav();
  }
  function toggleNav(open) {
    state.navOpen = open;
    app.querySelector(".shell").classList.toggle("nav-open", open);
    if (open) requestAnimationFrame(drawTagsNav); // 서랍을 열면 태그 줄 다시 계산
  }

  function drawNav(active) {
    const items = [
      { id: "today", label: "오늘", icon: "home" },
      { id: "dashboard", label: "나의 대시보드", icon: "grid", kids: [
        { id: "tasks", label: "할 일", icon: "check" },
        { id: "meetings", label: "회의", icon: "people" },
        { id: "memos", label: "메모", icon: "note" }
      ] },
      { id: "projects", label: "프로젝트", icon: "folder", kids: [
        { id: "stock", label: "입출고 관리", icon: "db" }
      ] },
      { id: "orgchart", label: "조직도", icon: "org" },
      { id: "contacts", label: "연락처", icon: "phone" },
      { id: "notices", label: "공지", icon: "bell", badge: state.unreadNotices } // 맨 아래, 안 읽은 공지 수
    ];
    const isOpen = (it) => (it.id === "projects" ? state.navProjOpen : state.navDashOpen);
    const setOpen = (it, open) => {
      if (it.id === "projects") { state.navProjOpen = open; store.set("ps.navProj", open ? "1" : "0"); }
      else { state.navDashOpen = open; store.set("ps.navDash", open ? "1" : "0"); }
    };
    // 아래 메뉴 화면으로 가면 펼침 (접는 것은 사용자가)
    if (active !== navActive) for (const it of items) if (it.kids && it.kids.some((k) => k.id === active)) setOpen(it, true);
    const link = (it, sub) => h("a", {
      class: "side__link" + (sub ? " side__link--sub" : "") + (it.id === active ? " is-active" : ""), href: "#/" + it.id, "aria-current": it.id === active ? "page" : null,
      title: it.badge ? `${it.label} · 새 글 ${it.badge}개` : it.label,
      onclick: () => {
        if (it.kids) { const again = it.id === active; setOpen(it, again ? !isOpen(it) : true); if (again) drawNav(active); }
        toggleNav(false);
      }
    }, [icon(it.icon), h("span", { class: "side__text", text: it.label }), it.badge ? h("span", { class: "nav-badge", "aria-label": `안 읽은 공지 ${it.badge}개`, text: it.badge > 99 ? "99+" : String(it.badge) }) : null]);
    layout.nav.replaceChildren(...items.map((it) => (it.kids ? h("div", { class: "side__group" }, [
      h("div", { class: "side__row" }, [link(it), h("button", {
        class: "side__toggle" + (isOpen(it) ? " is-open" : ""), type: "button", html: ICON.right, "aria-expanded": String(isOpen(it)), "aria-label": `${it.label} 아래 메뉴 ${isOpen(it) ? "접기" : "펼치기"}`,
        onclick: () => { setOpen(it, !isOpen(it)); drawNav(active); }
      })]),
      h("div", { class: "side__kids", hidden: !isOpen(it) }, it.kids.map((k) => link(k, true)))
    ]) : link(it))));
    navActive = active;
    drawUnitNav(active);
    drawAdminNav(active);
  }
  let navActive = null;
  const drawNavAll = () => drawNav(navActive);
  // 내 소속 + 다른 소속 보기
  function drawUnitNav(active) {
    if (!layout.unitNav) return;
    const mine = myUnit();
    const viewing = active === "unit" ? Number(route().id) || mine : null;
    // 관리자가 '추가로 볼 수 있는 조직'으로 정한 곳은 내 소속 아래에 늘 보임
    const extra = [...new Set((state.user.viewUnits || []).map((g) => g.unitId))].filter((id) => id !== mine && unitOf(id));
    const other = h("button", { class: "side__sublink", type: "button", text: "다른 소속 보기" });
    other.addEventListener("click", () => unitPicker(other, viewing, (id) => { if (id) { toggleNav(false); go(`#/unit/${id}`); } }, { noneLabel: null }));
    fill(layout.unitNav,
      mine ? h("a", { class: "side__link side__link--unit" + (viewing === mine ? " is-active" : ""), href: `#/unit/${mine}`, title: unitLabel(mine), onclick: () => toggleNav(false) }, [h("i", { class: `dot c${teamColor(mine) ?? KIND.event.color}` }), h("span", { text: unitPath(mine).map((u) => u.short || u.name).slice(-2).join(" › ") })])
        : h("p", { class: "muted small side__catempty", text: "아직 소속이 없어요" }),
      ...extra.map((id) => h("a", { class: "side__link side__link--unit" + (viewing === id ? " is-active" : ""), href: `#/unit/${id}`, title: unitLabel(id), onclick: () => toggleNav(false) }, [h("i", { class: `dot c${teamColor(id) ?? KIND.event.color}` }), h("span", { text: unitPath(id).map((u) => u.short || u.name).slice(-2).join(" › ") })])),
      viewing && viewing !== mine && !extra.includes(viewing) && unitOf(viewing) ? h("a", { class: "side__link side__link--unit is-active", href: `#/unit/${viewing}` }, [h("i", { class: "dot c4" }), h("span", { text: unitShort(viewing) })]) : null,
      state.units.length ? other : null
    );
  }
  // 관리자 메뉴: 주황 상자 하나에 (멤버에게는 아예 안 보임)
  function drawAdminNav(active) {
    if (!layout.admin) return;
    const link = (id, label, ic, onclick) => (onclick
      ? h("button", { class: "side__link side__link--admin", type: "button", title: label, onclick: () => { toggleNav(false); onclick(); } }, [icon(ic), h("span", { class: "side__text", text: label })])
      : h("a", { class: "side__link side__link--admin" + (id === active ? " is-active" : ""), href: "#/" + id, title: label, "aria-current": id === active ? "page" : null, onclick: () => toggleNav(false) }, [icon(ic), h("span", { class: "side__text", text: label })]));
    layout.admin.replaceChildren(
      h("div", { class: "side__adminhead" }, [icon("lock"), "관리자 전용"]),
      link("org", "조직도 편집", "org"),
      link("alldash", "전체 대시보드", "grid"),
      link("members", "멤버 · 소속 지정", "user"),
      link("volunteers", "봉사자 관리", "people"),
      link("cats", "분류 관리", "folder", manageCategories),
      link("cals", "구글 캘린더 연결", "cal", manageCalendars),
      link("backup", "백업", "db")
    );
  }
  function drawCalsNav() {
    if (!layout.cals) return;
    const item = (k, label, color, title) => {
      const c = h("input", { type: "checkbox", checked: state.show[k] !== false });
      c.addEventListener("change", () => {
        state.show[k] = c.checked;
        store.set("ps.show", JSON.stringify(state.show));
        if (page && (page.name === "dashboard" || page.name === "today")) page.reload();
      });
      return h("label", { class: `side__cal c${color}`, title }, [c, h("span", { text: label })]);
    };
    layout.cals.replaceChildren(
      ...Object.entries(KIND).map(([k, v]) => item(k, v.label, v.color)),
      ...state.calendars.map((cal) => item("cal" + cal.id, cal.name, cal.color, "구글 캘린더에서 가져온 일정 (읽기 전용)")),
      teamLegend()
    );
  }
  // 팀 색 안내: 고정 팀 + 내 팀 (달력의 회의·일정은 팀 색으로)
  function teamLegend() {
    const mine = myUnit();
    const ids = state.units.filter((u) => TEAM_FIXED.some((f) => u.name === f.path[1] && unitOf(u.parentId)?.name === f.path[0])).map((u) => u.id);
    if (mine && !ids.includes(mine)) ids.push(mine);
    if (!ids.length) return null;
    const dot = (c) => h("i", { class: `dot c${c}` });
    return h("div", { class: "team-legend", title: "우리 일정(회의·일정)은 팀 색으로 보여요. 다른 팀은 자동으로 다른 색" }, [h("span", { class: "muted", text: "팀 색" }),
      ...ids.map((id) => { const c = teamColor(id); return h("span", { class: "team-legend__item" }, c == null ? [dot(KIND.meeting.color), dot(KIND.event.color), unitShort(id)] : [dot(c), unitShort(id)]); })]);
  }
  // 자주 쓰는 태그: 칩을 옆으로 이어 붙이고(줄이 차면 다음 줄), 많이 쓴 태그가 앞에. 3줄을 넘으면 '+N' 으로 접기
  let tagsOpen = false;
  function drawTagsNav() {
    if (!layout.tags) return;
    if (!state.tags.length) return layout.tags.replaceChildren(h("p", { class: "muted small", text: "태그가 없어요." }));
    const sorted = state.tags.slice().sort((a, b) => (b.uses || 0) - (a.uses || 0));
    const chips = sorted.map((t) => h("a", { class: `side__tag c${t.color}`, href: "#/tasks", title: `'${t.name}' 할 일 보기${t.uses ? ` · ${t.uses}곳` : ""}`, onclick: () => { taskFilter.tag = t.id; toggleNav(false); if (route().name === "tasks") render(); } }, t.name));
    const more = h("button", { class: "side__tagmore", type: "button", "aria-expanded": String(tagsOpen) });
    more.addEventListener("click", () => { tagsOpen = !tagsOpen; drawTagsNav(); });
    layout.tags.replaceChildren(...chips, more);
    clampTags(chips, more);
  }
  function clampTags(chips, more) {
    more.hidden = true;
    if (!layout.tags.offsetParent) return; // 서랍이 닫혀 있으면 열 때 다시 계산
    const lines = () => new Set([...layout.tags.children].filter((el) => !el.hidden).map((el) => el.offsetTop)).size;
    if (lines() <= 3) return; // 다 들어가면 버튼 없음
    more.hidden = false;
    if (tagsOpen) { more.textContent = "접기"; more.setAttribute("aria-label", "태그 접기"); return; }
    let hidden = 0;
    const label = () => { more.textContent = `+${hidden}`; more.setAttribute("aria-label", `태그 ${hidden}개 더 보기`); };
    for (let i = chips.length - 1; i >= 0 && lines() > 3; i--) { chips[i].hidden = true; hidden++; label(); }
    while (lines() > 3 && hidden < chips.length) { chips[chips.length - 1 - hidden].hidden = true; hidden++; label(); }
  }


  // 분류 트리: 누르면 오늘·대시보드·할 일·회의·메모를 그 분류(와 그 아래)로 걸러 봄
  const CAT_PAGES = new Set(["today", "dashboard", "alldash", "tasks", "meetings", "memos"]);
  const ADMIN_PAGES = new Set(["org", "members", "volunteers", "backup", "alldash"]);
  function setCat(id) {
    state.cat = id;
    id ? store.set("ps.cat", String(id)) : store.remove("ps.cat");
    toggleNav(false);
    drawCatsNav();
    if (CAT_PAGES.has(route().name)) render(); else go("#/dashboard");
  }
  function drawCatsNav() {
    if (!layout.cats) return;
    // 고른 분류의 윗 분류는 펼쳐 둠
    if (state.cat) for (const c of catPath(state.cat).slice(0, -1)) state.catOpen.add(c.id);
    const toggle = (id) => {
      state.catOpen.has(id) ? state.catOpen.delete(id) : state.catOpen.add(id);
      store.set("ps.catOpen", JSON.stringify([...state.catOpen]));
      drawCatsNav();
    };
    const row = (c, depth) => {
      const kids = catChildren(c.id);
      const open = state.catOpen.has(c.id);
      return [
        h("div", { class: "side__catrow" + (state.cat === c.id ? " is-active" : ""), style: `padding-left:${depth * 14}px` }, [
          kids.length ? h("button", { class: "side__cattoggle" + (open ? " is-open" : ""), type: "button", "aria-label": `${c.name} ${open ? "접기" : "펼치기"}`, "aria-expanded": String(open), html: ICON.right, onclick: () => toggle(c.id) }) : h("span", { class: "side__cattoggle" }),
          h("button", { class: "side__cat", type: "button", "aria-current": state.cat === c.id ? "true" : null, onclick: () => setCat(state.cat === c.id ? null : c.id) }, [h("span", { text: c.name })])
        ]),
        ...(open ? kids.flatMap((k) => row(k, depth + 1)) : [])
      ];
    };
    const roots = catChildren(null);
    fill(layout.cats,
      h("div", { class: "side__catrow" + (!state.cat ? " is-active" : "") }, [h("span", { class: "side__cattoggle" }), h("button", { class: "side__cat", type: "button", onclick: () => setCat(null) }, [h("span", { text: "전체" })])]),
      ...roots.flatMap((c) => row(c, 0)),
      roots.length ? null : h("p", { class: "muted small side__catempty", text: isAdmin() ? "톱니바퀴를 눌러 분류를 만들어 주세요." : "아직 분류가 없어요." })
    );
  }

  // 작은 달력 (날짜를 누르면 그날 '오늘' 화면)
  let miniMonth = null;
  function drawMini(selected) {
    if (!miniMonth) miniMonth = parseYmd(selected || today());
    const m = new Date(miniMonth.getFullYear(), miniMonth.getMonth(), 1);
    const start = addDays(m, -m.getDay());
    const t = today();
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = addDays(start, i);
      if (i === 35 && d.getMonth() !== m.getMonth()) break;
      const s = ymd(d);
      cells.push(h("a", {
        class: "mini__d" + (d.getMonth() !== m.getMonth() ? " is-out" : "") + (s === t ? " is-today" : "") + (s === selected ? " is-sel" : ""),
        href: `#/today/${s}`, text: d.getDate(), "aria-label": dateLabel(s), onclick: () => toggleNav(false)
      }));
    }
    layout.mini.replaceChildren(
      h("div", { class: "mini__head" }, [
        h("button", { class: "icon-btn icon-btn--xs", type: "button", "aria-label": "이전 달", html: ICON.left, onclick: () => { miniMonth = new Date(m.getFullYear(), m.getMonth() - 1, 1); drawMini(selected); } }),
        h("strong", { text: `${m.getFullYear()}년 ${m.getMonth() + 1}월` }),
        h("button", { class: "icon-btn icon-btn--xs", type: "button", "aria-label": "다음 달", html: ICON.right, onclick: () => { miniMonth = new Date(m.getFullYear(), m.getMonth() + 1, 1); drawMini(selected); } })
      ]),
      h("div", { class: "mini__grid" }, [...WEEKDAYS.map((w) => h("span", { class: "mini__w", text: w })), ...cells])
    );
  }

  function setMain(name, content) {
    drawNav(name);
    layout.main.className = "main main--" + name;
    // 분류로 걸러 보는 중이면 위에 표시
    const bar = state.cat && CAT_PAGES.has(name) ? h("div", { class: "catbar" }, [
      icon("folder"), h("span", {}, ["분류 ", h("strong", { text: catLabel(state.cat) }), " 만 보는 중 (아래 분류 포함)"]),
      h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "전체 보기", onclick: () => setCat(null) })
    ]) : null;
    // 관리자 전용 화면: 맨 위 주황 줄
    fill(layout.main, ADMIN_PAGES.has(name) ? h("div", { class: "admin-bar", "aria-hidden": "true" }) : null, bar, content);
  }
  const loading = () => h("div", { class: "loading", text: "불러오는 중…" });
  const failed = (e) => h("div", { class: "card empty", text: e.message });

  // 고친 뒤: 지금 화면과 패널을 다시 불러옴
  function refresh(opts) {
    if (page) quiet(page.reload());
    if (state.peek && !(opts && opts.keepPeek)) quiet(drawPeek());
  }

  /* ---------- 측면 패널 ---------- */
  function openPeek(type, id) {
    state.peek = { type, id };
    quiet(drawPeek());
  }
  function closePeek() {
    state.peek = null;
    layout.peek.hidden = true;
    app.querySelector(".shell").classList.remove("has-peek");
    app.querySelectorAll(".is-peeked").forEach((el) => el.classList.remove("is-peeked"));
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.peek && !dialog.open && !openPop && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) closePeek();
  });
  function markPeeked() {
    app.querySelectorAll(".is-peeked").forEach((el) => el.classList.remove("is-peeked"));
    if (!state.peek) return;
    app.querySelectorAll(`[data-peek="${state.peek.type}:${state.peek.id}"]`).forEach((el) => el.classList.add("is-peeked"));
  }
  let peekSeq = 0;
  async function drawPeek() {
    const p = state.peek;
    if (!p) return;
    const seq = ++peekSeq;
    const keep = layout.peek.querySelector(".peek__body");
    const scroll = keep && layout.peek.dataset.key === `${p.type}:${p.id}` ? keep.scrollTop : 0;
    if (layout.peek.hidden) {
      layout.peek.hidden = false;
      layout.peek.replaceChildren(peekFrame("", loading()));
    }
    app.querySelector(".shell").classList.add("has-peek");
    let content;
    try {
      content = p.type === "event" ? await eventPeek(p.id) : p.type === "ext" ? await extPeek(p.id) : p.type === "pos" ? await posPeek(p.id) : p.type === "task" ? await taskPeek(p.id) : await dayPeek(p.id);
    } catch (e) {
      if (e.status === 404) { closePeek(); toast(e.message); return; }
      content = peekFrame("", failed(e));
    }
    if (seq !== peekSeq || state.peek !== p) return;
    layout.peek.dataset.key = `${p.type}:${p.id}`;
    layout.peek.replaceChildren(content);
    const body = layout.peek.querySelector(".peek__body");
    if (body) body.scrollTop = scroll;
    markPeeked();
  }
  function peekFrame(head, body, tools) {
    return h("div", { class: "peek__inner" }, [
      h("div", { class: "peek__head" }, [h("div", { class: "peek__title" }, head), h("div", { class: "peek__tools" }, [...(tools || []),
        h("button", { class: "icon-btn", type: "button", "aria-label": "패널 닫기", html: ICON.close, onclick: closePeek })])]),
      h("div", { class: "peek__body" }, body)
    ]);
  }
  function section(iconName, title, extra, body) {
    return h("section", { class: "psec" }, [
      h("div", { class: "psec__head" }, [icon(iconName), h("h3", {}, title), extra ? h("div", { class: "psec__extra" }, extra) : null]),
      body
    ]);
  }
  // 클릭하면 바로 고칠 수 있는 글 (blur/Enter 에 저장)
  function inlineText(value, opts) {
    const multiline = opts.multiline;
    const el = h(multiline ? "textarea" : "input", { class: "inline" + (opts.cls ? " " + opts.cls : ""), value, placeholder: opts.placeholder || "", maxlength: opts.max || null, rows: multiline ? opts.rows || 2 : null, "aria-label": opts.label });
    if (multiline) { el.value = value; autoGrow(el); el.addEventListener("input", () => autoGrow(el)); }
    let saved = value;
    const save = async () => {
      const v = el.value.trim();
      if (v === saved.trim()) return;
      if (opts.required && !v) { el.value = saved; return; }
      try { await opts.onSave(v); saved = v; } catch (e) { el.value = saved; }
    };
    el.addEventListener("blur", save);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); el.blur(); }
      if (e.key === "Escape") { el.value = saved; el.blur(); }
    });
    return el;
  }
  function autoGrow(el) { requestAnimationFrame(() => { el.style.height = "auto"; el.style.height = el.scrollHeight + 2 + "px"; }); }

  // 한 줄 입력 + Enter 로 추가
  function adder(placeholder, onAdd) {
    const input = h("input", { class: "adder__input", placeholder, "aria-label": placeholder, maxlength: "200" });
    input.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      const v = input.value.trim();
      if (!v) return;
      input.disabled = true;
      try { await onAdd(v); input.value = ""; } catch (ex) { /* 알림은 act 가 */ } finally { input.disabled = false; input.focus(); }
    });
    return h("div", { class: "adder" }, [icon("plus"), input]);
  }

  /* ----- 회의·일정 패널 ----- */
  async function eventPeek(id) {
    const r = await api(`/events/${id}`);
    const e = r.event;
    const isMeeting = e.kind === "meeting";
    const patch = async (body) => {
      await act(() => api(`/events/${e.id}`, { method: "PATCH", body }));
      refresh({ keepPeek: true });
    };
    const patchAndRedraw = async (body) => { await patch(body); quiet(drawPeek()); };

    const title = inlineText(e.title, { cls: "inline--title", label: "제목", max: 80, required: true, onSave: (v) => patch({ title: v }) });
    const st = meetingState(e);
    const head = [h("div", { class: "peek__kind" }, [evDot(e), h("span", { text: KIND[e.kind].label }), isMeeting ? h("span", { class: `status status--${st}`, text: MEETING_STATE[st] }) : null]), title];
    const tools = [
      h("button", { class: "btn btn--ghost btn--sm", type: "button", onclick: () => editEvent(e) }, [icon("edit"), "수정"]),
      e.canDelete ? h("button", { class: "icon-btn", type: "button", "aria-label": "삭제", title: "삭제", html: ICON.trash, onclick: () => confirmDialog("삭제", `'${e.title}' 을(를) 지울까요? 연결된 할 일과 메모는 남고 연결만 풀려요.`, "삭제", async () => {
        await api(`/events/${e.id}`, { method: "DELETE" });
        closeDialog(); closePeek(); toast("지웠어요."); refresh();
      }) }) : null
    ].filter(Boolean);

    const important = r.memos.filter((m) => m.important);
    const before = r.tasks.filter((t) => t.phase === "before");
    const after = r.tasks.filter((t) => t.phase !== "before");

    const facts = h("ul", { class: "facts" }, [
      h("li", {}, [icon("cal"), h("button", { class: "fact-btn", type: "button", text: whenLabel(e), onclick: () => editEvent(e) })]),
      h("li", {}, [icon("place"), inlineText(e.location, { placeholder: "장소 추가", label: "장소", max: 80, onSave: (v) => patch({ location: v }) })]),
      h("li", {}, [icon("folder"), categoryButton(e.categoryId, (id) => patch({ categoryId: id }), "fact-btn")]),
      state.units.length ? h("li", {}, canEditTeam(e) ? teamButton(e.unitId, (id) => patch({ unitId: id }), "fact-btn") : teamInfo(e.unitId)) : null,
      h("li", { class: "facts__tags" }, [icon("tag"), h("div", { class: "chips" }, [...tagChips(e.tagIds), h("button", { class: "chip-add", type: "button", text: e.tagIds.length ? "편집" : "태그 추가", onclick: (ev) => tagPicker(ev.currentTarget, e.tagIds, (ids) => { e.tagIds = ids; quiet(patch({ tagIds: ids })); redrawChips(ev.target.closest(".chips"), ids); }) })])])
    ]);
    function redrawChips(box, ids) {
      const btn = box.querySelector(".chip-add");
      box.replaceChildren(...tagChips(ids), btn);
      btn.textContent = ids.length ? "편집" : "태그 추가";
    }

    // 외부 참석자 (계정 없는 사람): 이름 · 소속·기관 · 연락처(선택)
    let guests = r.guests || [];
    const guestBox = h("div", { class: "guests" });
    const attCount = h("span", { class: "muted" });
    const attendees = isMeeting ? section("people", ["참석자 ", attCount],
      h("button", { class: "link-btn", type: "button", text: "편집", onclick: (ev) => personPicker(ev.currentTarget, e.attendeeIds, true, (ids) => { e.attendeeIds = ids; drawAtt(); quiet(patch({ attendeeIds: ids })); }) }),
      h("div", {}, [h("div", { class: "attendees" }), guestBox])) : null;
    function drawGuests() {
      attCount.textContent = guests.length ? `${e.attendeeIds.length} + 외부 ${guests.length}` : String(e.attendeeIds.length);
      const contactLink = (c) => (/^[\d\s+()-]{7,}$/.test(c) ? h("a", { href: `tel:${c.replace(/[^\d+]/g, "")}`, text: c }) : /@/.test(c) ? h("a", { href: `mailto:${c}`, text: c }) : h("span", { text: c }));
      const name = h("input", { placeholder: "이름", maxlength: "30", "aria-label": "외부 참석자 이름" });
      const org = h("input", { placeholder: "소속·기관 (선택)", maxlength: "40", "aria-label": "소속·기관" });
      const contact = h("input", { placeholder: "연락처 (선택)", maxlength: "60", "aria-label": "연락처" });
      const add = h("button", { class: "btn btn--ghost btn--sm", type: "submit", text: "추가" });
      const form = h("form", { class: "guest-add" }, [name, org, contact, add]);
      form.addEventListener("submit", (ev) => {
        ev.preventDefault();
        if (!name.value.trim()) return name.focus();
        busy(add, async () => {
          const res = await act(() => api(`/events/${e.id}/guests`, { method: "POST", body: { name: name.value, org: org.value, contact: contact.value } }));
          guests = res.guests; drawGuests(); refresh({ keepPeek: true });
          guestBox.querySelector(".guest-add input").focus();
        });
      });
      fill(guestBox,
        h("div", { class: "guests__label" }, [icon("user"), "외부 참석자", h("small", { class: "muted", text: " 계정이 없는 분" })]),
        guests.length ? h("ul", { class: "guest-list" }, guests.map((g) => h("li", {}, [
          h("span", { class: "guest-list__name", text: g.name }),
          g.org ? h("span", { class: "muted", text: g.org }) : null,
          g.contact ? h("span", { class: "guest-list__contact" }, contactLink(g.contact)) : null,
          h("button", { class: "icon-btn icon-btn--xs row-del", type: "button", "aria-label": `${g.name} 빼기`, html: ICON.close, onclick: async () => {
            const res = await act(() => api(`/guests/${g.id}`, { method: "DELETE" }));
            guests = res.guests; drawGuests(); refresh({ keepPeek: true });
          } })
        ]))) : null,
        form
      );
    }
    function drawAtt() {
      const box = attendees.querySelector(".attendees");
      box.replaceChildren(...(e.attendeeIds.length ? e.attendeeIds.map((uid) => {
        const u = member(uid);
        return h("div", { class: "attendee" }, [avatar(uid), h("span", { text: u ? u.name : "?" }), personSub(u) ? h("small", { text: personSub(u) }) : null]);
      }) : [h("p", { class: "muted small", text: "참석자를 추가해 주세요." })]));
    }
    if (attendees) { drawAtt(); drawGuests(); }

    // 안건: 한 줄씩 고치고, Enter 로 추가
    const agendaList = h("ol", { class: "agenda" });
    let agenda = e.agenda.slice();
    function drawAgenda() {
      agendaList.replaceChildren(...agenda.map((a, i) => h("li", {}, [
        h("span", { class: "agenda__n", text: i + 1 }),
        inlineText(a, { label: `안건 ${i + 1}`, max: 200, onSave: async (v) => {
          if (v) agenda[i] = v; else agenda.splice(i, 1);
          await patch({ agenda });
          if (!v) drawAgenda();
        } }),
        h("button", { class: "icon-btn icon-btn--xs row-del", type: "button", "aria-label": "안건 빼기", html: ICON.close, onclick: async () => { agenda.splice(i, 1); drawAgenda(); await patch({ agenda }); } })
      ])));
    }
    drawAgenda();

    const body = [
      facts,
      e.source ? h("div", { class: "srcbox" + (e.source.status !== "same" ? " is-warn" : "") }, [
        h("span", {}, [icon("cal"), h("strong", { text: `${e.source.calendarName} 캘린더 백업` }), " · 구글 캘린더에서 가져온 일정이라 원본은 달력에서 숨겨요"]),
        e.source.status === "changed" ? h("span", { class: "srcbox__msg" }, [`원본이 바뀌었어요 (${e.source.changed.join(", ")})`,
          h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "원본대로 맞추기", onclick: (ev) => busy(ev.currentTarget, async () => {
            await act(() => api(`/events/${e.id}/source-sync`, { method: "POST" }), "원본대로 맞췄어요."); refresh();
          }) })]) : null,
        e.source.status === "deleted" ? h("span", { class: "srcbox__msg", text: "원본에서 지워졌어요" }) : null,
        ...(e.sameSource || []).map((x) => h("button", { class: "link-btn", type: "button", onclick: () => openPeek("event", x.eventId) }, `${teamName(x.unitId)}에도 있어요 → 열기`))
      ]) : null,
      important.length ? h("div", { class: "keybox" }, [h("div", { class: "keybox__head" }, [icon("star"), "중요 메모"]), h("ul", {}, important.map((m) => h("li", { text: m.body })))]) : null,
      attendees,
      section("doc", isMeeting ? "회의 개요" : "설명", null, inlineText(e.description, { multiline: true, rows: 2, placeholder: isMeeting ? "어떤 회의인지 적어 주세요" : "설명 추가", label: "개요", max: 3000, onSave: (v) => patch({ description: v }) })),
      isMeeting ? section("list", "회의 안건", null, h("div", {}, [agendaList, adder("안건 추가 후 Enter", async (v) => { agenda.push(v); drawAgenda(); await patch({ agenda }); })])) : null,
      section("todo", ["준비사항 ", h("span", { class: "muted", text: `${before.filter((t) => t.status === "done").length}/${before.length}` })], null,
        h("div", {}, [taskRows(before, { compact: true }), adder("준비할 일 추가 후 Enter", (v) => act(() => api("/tasks", { method: "POST", body: { title: v, meetingId: e.id, phase: "before", dueDate: e.startDate, assigneeId: state.user.id } })).then(() => refresh()))])),
      section("check", ["회의 후 할 일 ", h("span", { class: "muted", text: String(after.length) })], null,
        h("div", {}, [taskRows(after, { compact: true, assignee: true }), adder("후속 할 일 추가 후 Enter", (v) => act(() => api("/tasks", { method: "POST", body: { title: v, meetingId: e.id, phase: "after", dueDate: e.endDate > today() ? e.endDate : today(), assigneeId: state.user.id } })).then(() => refresh()))])),
      section("note", ["메모 / 참고 사항 ", h("span", { class: "muted", text: String(r.memos.length) })], null,
        h("div", {}, [memoRows(r.memos, { inMeeting: true }), memoAdder({ meetingId: e.id, date: today() })])),
      section("link", "관련 문서", h("button", { class: "link-btn", type: "button", text: "추가", onclick: (ev) => addLink(ev.currentTarget, e.id) }),
        r.links.length ? h("ul", { class: "links" }, r.links.map((l) => h("li", {}, [
          icon("doc"), h("a", { href: l.url, target: "_blank", rel: "noopener noreferrer", text: l.title }), h("span", { class: "muted small", text: ago(l.createdAt) }),
          h("button", { class: "icon-btn icon-btn--xs row-del", type: "button", "aria-label": "문서 빼기", html: ICON.close, onclick: () => act(() => api(`/links/${l.id}`, { method: "DELETE" })).then(() => drawPeek()) })
        ]))) : h("p", { class: "muted small", text: "회의 자료 링크를 모아 두세요." })),
      commentsBox("event", e.id, r.comments, () => refresh({ keepPeek: true })),
      h("p", { class: "peek__foot muted small", text: `${e.author || "알 수 없음"}님이 만듦 · ${ago(e.updatedAt)} 수정` })
    ];
    return peekFrame(head, body, tools);
  }

  /* ----- 가져온 일정 패널 (읽기 전용) ----- */
  async function extPeek(id) {
    const e = (await api(`/external/${id}`)).event;
    const head = [h("div", { class: "peek__kind" }, [evDot(e), h("span", { text: e.calendarName }), h("span", { class: "badge", text: "읽기 전용" })]), h("h2", { class: "peek__h", text: e.title })];
    return peekFrame(head, [
      h("ul", { class: "facts" }, [
        h("li", {}, [icon("cal"), h("span", { text: whenLabel(e) })]),
        e.location ? h("li", {}, [icon("place"), h("span", { text: e.location })]) : null,
        e.categoryId ? h("li", {}, [icon("folder"), h("span", { class: "catpath", text: catLabel(e.categoryId) })]) : null
      ]),
      e.description ? section("doc", "설명", null, h("p", { class: "prose ext-desc", text: e.description })) : null,
      h("p", { class: "notice-box small" }, [`구글 캘린더 '${e.calendarName}'에서 가져온 일정이에요. 고치려면 구글 캘린더에서 고쳐 주세요. `, e.syncedAt ? `(${ago(e.syncedAt)} 읽음)` : ""]),
      // 이미 우리 쪽에 넣었으면 열기, 아니면 넣기 (다른 팀에 또 넣는 건 허용)
      ...(e.imported || []).map((x) => h("button", { class: "btn btn--ghost btn--block import-open", type: "button", onclick: () => openPeek("event", x.eventId) }, [icon("check"), `${x.unitId && unitOf(x.unitId) ? unitShort(x.unitId) : "팀 없음"}에 있음 → 열기`])),
      h("button", { class: "btn btn--block " + ((e.imported || []).length ? "btn--ghost" : "btn--primary"), type: "button", onclick: () => importExternal([e]) }, [icon("plus"), (e.imported || []).length ? "다른 팀에도 넣기" : "우리 소속으로 넣기"])
    ]);
  }

  // 가져온 구글 캘린더 일정 → 우리 소속 일정으로 넣기 (하나 또는 여러 개)
  function importExternal(items) {
    const err = errorLine();
    let kind = "meeting";
    // 넣을 수 있는 팀: 관리자는 모두, 멤버는 내 소속과 그 아래 팀
    const only = isAdmin() ? null : myVisibleUnits();
    let unitId = myUnit(), attendeeIds = [state.user.id];
    const kindSeg = h("div", { class: "seg seg--sm" }, [["meeting", "회의"], ["event", "일정"]].map(([k, label]) => h("button", { type: "button", "aria-selected": String(k === kind), text: label, onclick: (ev) => { kind = k; kindSeg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b === ev.currentTarget))); } })));
    const unitBtn = h("button", { class: "select-btn", type: "button" });
    const drawUnit = () => unitBtn.replaceChildren(h("span", { class: "catpath" }, [icon("org"), h("span", { text: unitId && unitOf(unitId) ? unitLabel(unitId) : "팀 없음 (나·참석자·관리자만)" })]));
    unitBtn.addEventListener("click", () => unitPicker(unitBtn, unitId, (id) => { unitId = id; drawUnit(); }, { only, noneLabel: "팀 없음 (나·참석자·관리자만)" }));
    drawUnit();
    const attBtn = h("button", { class: "select-btn", type: "button" });
    const drawAtt = () => attBtn.replaceChildren(...(attendeeIds.length ? [h("span", { class: "avatars" }, attendeeIds.slice(0, 6).map((id) => avatar(id, "sm"))), h("span", { text: `${attendeeIds.length}명` })] : [h("span", { class: "muted", text: "참석자 고르기 (선택)" })]));
    attBtn.addEventListener("click", () => personPicker(attBtn, attendeeIds, true, (ids) => { attendeeIds = ids; drawAtt(); }));
    drawAtt();
    const ok = h("button", { class: "btn btn--primary", type: "submit", text: items.length > 1 ? `${items.length}개 넣기` : "넣기" });
    const form = h("form", { class: "stack", novalidate: true }, [
      h("ul", { class: "import-list" }, items.slice(0, 8).map((x) => h("li", {}, [h("i", { class: `dot c${x.color}` }), h("span", { text: `${shortDate(x.startDate)} ${x.startTime || "종일"}` }), h("strong", { text: x.title })]))),
      items.length > 8 ? h("p", { class: "muted small", text: `외 ${items.length - 8}개` }) : null,
      h("p", { class: "muted small", text: "제목·날짜·시간·장소·설명을 복사해 PSchedule 일정으로 만들어요. 원본은 그대로 두고, 원본이 바뀌면 알려 드려요." }),
      field("종류", kindSeg),
      field("팀", unitBtn, isAdmin() ? "이 팀(과 위 조직) 사람들, 참석자, 관리자가 볼 수 있어요" : "내 소속과 그 아래 팀 중에서 고를 수 있어요"),
      field("참석자", attBtn), err,
      h("div", { class: "actions" }, [h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), ok])
    ]);
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      busy(ok, async () => {
        try {
          const r = await api("/external/import", { method: "POST", body: { ids: items.map((x) => x.id), kind, unitId, attendeeIds } });
          closeDialog();
          toast(r.created.length ? `${r.created.length}개를 넣었어요${r.skipped.length ? ` (${r.skipped.length}개는 이미 그 팀에 있어요)` : ""}.` : "이미 그 팀에 있어요.");
          const first = r.created[0] || r.skipped[0];
          if (items.length === 1 && first) openPeek("event", first.eventId);
          refresh({ keepPeek: items.length === 1 });
        } catch (ex) { showError(err, ex.message); }
      });
    });
    openDialog(items.length > 1 ? `가져온 일정 ${items.length}개를 우리 소속으로` : "우리 소속으로 넣기", form, { wide: true });
  }

  function addLink(anchor, eventId) {
    const t = h("input", { placeholder: "이름 (예: 견적서)", maxlength: "80" });
    const u = h("input", { placeholder: "https://", type: "url", maxlength: "1000" });
    const err = errorLine();
    const ok = h("button", { class: "btn btn--primary btn--sm", type: "submit", text: "추가" });
    const form = h("form", { class: "pop__form" }, [u, t, err, ok]);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      busy(ok, async () => {
        try { await api(`/events/${eventId}/links`, { method: "POST", body: { url: u.value, title: t.value } }); closePop(); drawPeek(); }
        catch (ex) { showError(err, ex.message); }
      });
    });
    popover(anchor, form);
    u.focus();
  }

  /* ----- 할 일 목록 (여러 곳에서 씀) ----- */
  function taskRows(list, opts) {
    const o = opts || {};
    if (!list.length) return h("p", { class: "muted small task-empty", text: o.empty || "아직 없어요." });
    return h("ul", { class: "tasks" + (o.compact ? " tasks--compact" : "") }, list.map((t) => taskRow(t, o)));
  }
  function taskRow(t, o) {
    const row = h("li", { class: "task" + (t.status === "done" ? " is-done" : ""), "data-peek": `task:${t.id}` }, [
      checkbox(t, (s) => patchTask(t, { status: s })),
      h("button", { class: "task__title", type: "button", onclick: () => openPeek("task", t.id) }, [
        h("span", { text: t.title }),
        !o.hideMeeting && t.meetingId && !o.compact ? h("span", { class: "task__meeting", title: t.meetingTitle }, [icon("people"), t.meetingTitle]) : null
      ]),
      h("span", { class: "task__meta" }, [
        o.compact ? null : dueBadge(t),
        o.compact ? null : catChip(t.categoryId),
        ...(o.compact ? [] : tagChips(t.tagIds)),
        o.assignee ? h("button", { class: "assignee-btn", type: "button", title: member(t.assigneeId)?.name || "담당자 정하기", onclick: (ev) => personPicker(ev.currentTarget, t.assigneeId ? [t.assigneeId] : [], false, (uid) => patchTask(t, { assigneeId: uid })) },
          t.assigneeId ? personLine(t.assigneeId) : h("span", { class: "muted small", text: "담당자" })) : null,
        o.compact && t.dueDate ? dueBadge(t) : null,
        o.status !== false ? statusButton(t, (s) => patchTask(t, { status: s })) : null
      ])
    ]);
    return row;
  }

  /* ----- 메모 목록 ----- */
  function memoRows(list, opts) {
    const o = opts || {};
    if (!list.length) return h("p", { class: "muted small", text: o.empty || "메모가 없어요." });
    return h("ul", { class: "memos" }, list.map((m) => memoRow(m, o)));
  }
  function memoRow(m, o) {
    const star = h("button", { class: "star" + (m.important ? " is-on" : ""), type: "button", "aria-pressed": String(m.important), "aria-label": "중요 표시", title: m.important ? "중요 표시 빼기" : "중요 표시", html: ICON.star, disabled: !m.canEdit, onclick: async () => {
      await act(() => api(`/memos/${m.id}`, { method: "PATCH", body: { important: !m.important } }));
      refresh();
    } });
    const body = m.canEdit
      ? inlineText(m.body, { multiline: true, rows: 1, label: "메모", max: 3000, required: true, onSave: async (v) => { await act(() => api(`/memos/${m.id}`, { method: "PATCH", body: { body: v } })); refresh({ keepPeek: !o.inMeeting }); } })
      : h("p", { class: "memo__text", text: m.body });
    return h("li", { class: "memo" + (m.important ? " is-important" : "") }, [
      star,
      h("div", { class: "memo__main" }, [
        body,
        h("div", { class: "memo__meta" }, [
          h("span", { text: m.author }),
          h("span", { text: o.showDate ? dateLabel(m.date) : ago(m.createdAt) }),
          !o.inMeeting && m.meetingId ? h("button", { class: "memo__meeting", type: "button", onclick: () => openPeek("event", m.meetingId) }, [icon("people"), m.meetingTitle]) : null,
          o.inMeeting ? null : m.canEdit
            ? h("button", { class: m.categoryId ? "memo__cat" : "link-btn", type: "button", title: m.categoryId ? catLabel(m.categoryId) : null, onclick: (ev) => categoryPicker(ev.currentTarget, m.categoryId, async (id) => { await act(() => api(`/memos/${m.id}`, { method: "PATCH", body: { categoryId: id } })); refresh(); }) },
              m.categoryId ? catChip(m.categoryId) : "분류")
            : catChip(m.categoryId),
          !o.inMeeting && m.unitId && unitOf(m.unitId) ? h("span", { title: "팀", text: unitShort(m.unitId) }) : null,
          m.taskId ? h("button", { class: "memo__task", type: "button", onclick: () => openPeek("task", m.taskId) }, [icon("check"), "할 일로 만듦"])
            : h("button", { class: "link-btn", type: "button", text: "할 일로 만들기", onclick: () => memoToTask(m) }),
          m.canEdit ? h("button", { class: "link-btn link-btn--muted", type: "button", text: "삭제", onclick: async () => { await act(() => api(`/memos/${m.id}`, { method: "DELETE" })); refresh(); } }) : null
        ])
      ])
    ]);
  }
  function memoAdder(base) {
    const input = h("textarea", { rows: "2", placeholder: "메모를 남겨 주세요 (Ctrl/⌘+Enter 저장)", maxlength: "3000", "aria-label": "메모" });
    const imp = h("input", { type: "checkbox" });
    const save = h("button", { class: "btn btn--primary btn--sm", type: "submit", text: "저장" });
    const form = h("form", { class: "memo-add" }, [input, h("div", { class: "memo-add__bar" }, [h("label", { class: "check small" }, [imp, h("span", { text: "중요" })]), save])]);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) form.requestSubmit(); });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!input.value.trim()) return input.focus();
      busy(save, async () => {
        // 회의 메모는 회의의 분류를 따르고, 아니면 왼쪽에서 고른 분류로
        const cat = base.meetingId || !state.cat ? {} : { categoryId: state.cat };
        await act(() => api("/memos", { method: "POST", body: { ...base, ...cat, body: input.value, important: imp.checked } }));
        input.value = ""; imp.checked = false;
        refresh();
      });
    });
    return form;
  }
  function memoToTask(m) {
    const err = errorLine();
    const title = h("input", { value: m.body.split("\n")[0].slice(0, 80), maxlength: "80", autofocus: true });
    const due = h("input", { type: "date", value: today() });
    const phase = h("select", {}, [h("option", { value: "before", text: "회의 준비사항" }), h("option", { value: "after", text: "회의 후 할 일" })]);
    phase.value = "after";
    let assignee = state.user.id;
    const who = h("button", { class: "select-btn", type: "button" });
    const drawWho = () => who.replaceChildren(assignee ? personLine(assignee) : h("span", { class: "muted", text: "담당자 없음" }));
    drawWho();
    who.addEventListener("click", () => personPicker(who, assignee ? [assignee] : [], false, (uid) => { assignee = uid; drawWho(); }));
    const ok = h("button", { class: "btn btn--primary", type: "submit", text: "할 일 만들기" });
    const form = h("form", { class: "stack", novalidate: true }, [
      m.meetingId ? h("p", { class: "notice-box" }, ["'", h("strong", { text: m.meetingTitle }), "' 회의에 연결돼요."]) : null,
      field("할 일", title), h("div", { class: "row2" }, [field("담당자", who), field("마감일", due)]),
      m.meetingId ? field("구분", phase) : null, err,
      h("div", { class: "actions" }, [h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), ok])
    ]);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      busy(ok, async () => {
        try {
          await api(`/memos/${m.id}/task`, { method: "POST", body: { title: title.value, dueDate: due.value || null, assigneeId: assignee, phase: phase.value } });
          closeDialog(); toast("할 일을 만들었어요."); refresh();
        } catch (ex) { showError(err, ex.message); }
      });
    });
    openDialog("메모를 할 일로", form);
  }

  /* ----- 할 일 패널 ----- */
  async function taskPeek(id) {
    const [r, mc] = await Promise.all([api(`/tasks/${id}`), api(`/meetings/choices?date=${today()}`)]);
    const t = r.task;
    const patch = async (body) => { Object.assign(t, await patchTask(t, body)); quiet(drawPeek()); };
    const title = inlineText(t.title, { cls: "inline--title", label: "할 일", max: 80, required: true, onSave: (v) => patchTask(t, { title: v }) });
    const due = h("input", { type: "date", value: t.dueDate || "", class: "inline inline--box", "aria-label": "마감일" });
    due.addEventListener("change", () => patch({ dueDate: due.value || null }));
    const startEl = h("input", { type: "date", value: t.startDate || "", class: "inline inline--box", "aria-label": "시작일" });
    startEl.addEventListener("change", () => patch({ startDate: startEl.value || null }));
    const meetings = mc.meetings.slice();
    if (t.meetingId && !meetings.some((m) => m.id === t.meetingId)) meetings.unshift({ id: t.meetingId, title: t.meetingTitle, startDate: t.meetingDate, startTime: t.meetingTime });
    const meeting = h("select", { class: "inline inline--box", "aria-label": "관련 회의" }, [
      h("option", { value: "", text: "연결 안 함" }),
      ...meetings.map((m) => h("option", { value: String(m.id), text: `${shortDate(m.startDate)} ${m.startTime || ""} ${m.title}`.replace(/\s+/g, " ") }))
    ]);
    meeting.value = t.meetingId ? String(t.meetingId) : "";
    meeting.addEventListener("change", () => patch({ meetingId: meeting.value ? Number(meeting.value) : null }));
    const phase = h("select", { class: "inline inline--box", "aria-label": "회의 전후" }, [h("option", { value: "before", text: "회의 준비사항" }), h("option", { value: "after", text: "회의 후 할 일" })]);
    phase.value = t.phase || "after";
    phase.addEventListener("change", () => patch({ phase: phase.value }));

    const props = h("dl", { class: "props" }, [
      h("dt", {}, "상태"), h("dd", {}, statusButton(t, (s) => patch({ status: s }))),
      h("dt", {}, "담당자"), h("dd", {}, h("button", { class: "select-btn", type: "button", onclick: (ev) => personPicker(ev.currentTarget, t.assigneeId ? [t.assigneeId] : [], false, (uid) => patch({ assigneeId: uid })) }, personLine(t.assigneeId))),
      h("dt", {}, "시작일"), h("dd", {}, startEl),
      h("dt", {}, "마감일"), h("dd", {}, due),
      h("dt", {}, "분류"), h("dd", {}, categoryButton(t.categoryId, (id) => patch({ categoryId: id }))),
      state.units.length ? h("dt", {}, "팀") : null, state.units.length ? h("dd", {}, canEditTeam(t) ? teamButton(t.unitId, (id) => patch({ unitId: id })) : teamInfo(t.unitId)) : null,
      h("dt", {}, "태그"), h("dd", {}, h("div", { class: "chips" }, [...tagChips(t.tagIds), h("button", { class: "chip-add", type: "button", text: t.tagIds.length ? "편집" : "태그 추가", onclick: (ev) => tagPicker(ev.currentTarget, t.tagIds, (ids) => { t.tagIds = ids; quiet(patchTask(t, { tagIds: ids })); const box = ev.target.closest(".chips"); const b = box.querySelector(".chip-add"); box.replaceChildren(...tagChips(ids), b); }) })])),
      h("dt", {}, "관련 회의"), h("dd", { class: "props__meeting" }, [meeting, t.meetingId ? h("button", { class: "btn btn--ghost btn--sm", type: "button", onclick: () => openPeek("event", t.meetingId) }, ["회의 열기", icon("arrow")]) : null]),
      t.meetingId ? h("dt", {}, "구분") : null, t.meetingId ? h("dd", {}, phase) : null
    ]);
    const head = [h("div", { class: "peek__kind" }, [kindDot("task"), h("span", { text: "할 일" })]), h("div", { class: "peek__titlerow" }, [checkbox(t, (s) => patch({ status: s })), title])];
    const tools = t.canDelete ? [h("button", { class: "icon-btn", type: "button", "aria-label": "삭제", title: "삭제", html: ICON.trash, onclick: () => confirmDialog("할 일 삭제", `'${t.title}' 을(를) 지울까요?`, "삭제", async () => {
      await api(`/tasks/${t.id}`, { method: "DELETE" });
      closeDialog(); closePeek(); toast("지웠어요."); refresh();
    }) })] : [];
    return peekFrame(head, [
      props,
      section("note", "메모", null, inlineText(t.note, { multiline: true, rows: 3, placeholder: "세부 내용, 참고 링크 등", label: "할 일 메모", max: 2000, onSave: (v) => patchTask(t, { note: v }) })),
      h("p", { class: "peek__foot muted small", text: t.doneAt ? `완료 ${ago(t.doneAt)}` : "" })
    ], tools);
  }

  /* ----- 날짜 패널: 그날 회의의 핵심 안건·중요 메모·남은 할 일 ----- */
  async function dayPeek(day) {
    const [ev, tk, mm] = await Promise.all([
      api(`/events?from=${day}&to=${day}`), api(`/tasks?date=${day}&today=${today()}`), api(`/memos?date=${day}`)
    ]);
    const details = await Promise.all(ev.events.filter((e) => e.kind === "meeting").map((e) => api(`/events/${e.id}`)));
    const byId = new Map(details.map((d) => [d.event.id, d]));
    const dayEvents = dedupeImported(allEvents(ev));
    const cards = dayEvents.map((e) => {
      const d = e.ext ? null : byId.get(e.id);
      const imp = d ? d.memos.filter((m) => m.important).slice(0, 3) : [];
      const open = d ? d.tasks.filter((t) => t.status !== "done") : [];
      return h("li", {}, h("button", { class: "daycard", type: "button", onclick: () => openEv(e) }, [
        h("div", { class: "daycard__top" }, [evDot(e), h("span", { class: "daycard__time", text: timeRange(e) }), h("strong", { text: e.title }), e.ext ? h("small", { class: "muted", text: e.calendarName }) : null]),
        d && d.event.agenda.length ? h("ol", { class: "daycard__agenda" }, [...d.event.agenda.slice(0, 3).map((a) => h("li", { text: a })), d.event.agenda.length > 3 ? h("li", { class: "muted", text: `외 ${d.event.agenda.length - 3}개` }) : null]) : null,
        imp.length ? h("ul", { class: "daycard__imp" }, imp.map((m) => h("li", {}, [icon("star"), h("span", { text: m.body })]))) : null,
        open.length ? h("div", { class: "daycard__tasks" }, [icon("check"), `남은 할 일 ${open.length}개`]) : null
      ]));
    });
    return peekFrame([h("div", { class: "peek__kind" }, [icon("cal"), h("span", { text: relDay(day) || "선택한 날" })]), h("h2", { class: "peek__h", text: dateLabel(day) })], [
      section("people", ["일정 ", h("span", { class: "muted", text: String(dayEvents.length) })], h("button", { class: "link-btn", type: "button", text: "추가", onclick: () => editEvent(null, { date: day }) }),
        dayEvents.length ? h("ul", { class: "daycards" }, cards) : h("p", { class: "muted small", text: "일정이 없어요." })),
      section("check", ["할 일 ", h("span", { class: "muted", text: String(tk.tasks.length) })], null,
        h("div", {}, [taskRows(tk.tasks, { compact: true }), adder("할 일 추가 후 Enter", (v) => act(() => api("/tasks", { method: "POST", body: { title: v, startDate: day, dueDate: day, assigneeId: state.user.id, categoryId: state.cat } })).then(() => refresh()))])),
      section("note", ["메모 ", h("span", { class: "muted", text: String(mm.memos.length) })], null, h("div", {}, [memoRows(mm.memos), memoAdder({ date: day })])),
      h("a", { class: "btn btn--ghost btn--block", href: `#/today/${day}` }, ["이 날 타임라인 보기", icon("arrow")])
    ]);
  }

  /* ---------- 만들기 / 고치기 ---------- */
  function quickAdd(kind) {
    const tabs = [["meeting", "회의"], ["event", "일정"], ["task", "할 일"], ["memo", "메모"]];
    const body = h("div", { class: "stack" });
    const seg = h("div", { class: "seg", role: "tablist" });
    function pick(k) {
      seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.k === k)));
      const day = route().name === "today" && route().id ? route().id : today();
      body.replaceChildren(k === "task" ? taskForm({ dueDate: day }) : k === "memo" ? quickMemoForm(day) : eventForm(null, { kind: k, date: day }));
      const f = body.querySelector("[autofocus]");
      if (f) f.focus();
    }
    tabs.forEach(([k, label]) => seg.append(h("button", { type: "button", role: "tab", "data-k": k, text: label, onclick: () => pick(k) })));
    openDialog("추가", h("div", { class: "stack" }, [seg, body]), { wide: true });
    pick(kind || "meeting");
  }

  function editEvent(e, opts) {
    openDialog(e ? "일정 수정" : "일정 추가", eventForm(e, opts || {}), { wide: true });
  }

  function eventForm(e, opts) {
    const isNew = !e;
    const v = e || { kind: opts.kind || "meeting", title: opts.title || "", startDate: opts.date || today(), endDate: opts.date || today(), startTime: opts.time || "", endTime: "", location: opts.location || "", description: "", categoryId: state.cat, tagIds: [], attendeeIds: [state.user.id] };
    let kind = v.kind;
    const err = errorLine();
    const title = h("input", { value: v.title, maxlength: "80", required: true, autofocus: true, placeholder: kind === "meeting" ? "예: 식수 실무회의" : "예: 현장 방문" });
    const startDate = h("input", { type: "date", value: v.startDate, required: true });
    const endDate = h("input", { type: "date", value: v.endDate, required: true });
    const allDay = h("input", { type: "checkbox", checked: isNew ? kind !== "meeting" && !opts.time : !v.startTime });
    const startTime = h("input", { type: "time", value: v.startTime || "10:00", step: "300" });
    const endTime = h("input", { type: "time", value: v.endTime || (v.startTime ? "" : "11:00"), step: "300" });
    const loc = h("input", { value: v.location, maxlength: "80", placeholder: "선택" });
    let tagIds = v.tagIds.slice(), attendeeIds = v.attendeeIds.slice(), categoryId = v.categoryId || null, teamId = myUnit();
    const catBtn = categoryButton(categoryId, (id) => { categoryId = id; });
    const tagsBtn = h("button", { class: "select-btn", type: "button" });
    const drawTags = () => tagsBtn.replaceChildren(...(tagIds.length ? tagChips(tagIds) : [h("span", { class: "muted", text: "태그 고르기" })]));
    tagsBtn.addEventListener("click", () => tagPicker(tagsBtn, tagIds, (ids) => { tagIds = ids; drawTags(); }));
    const attBtn = h("button", { class: "select-btn", type: "button" });
    const drawAtt = () => attBtn.replaceChildren(...(attendeeIds.length ? [h("span", { class: "avatars" }, attendeeIds.slice(0, 6).map((id) => avatar(id, "sm"))), h("span", { text: `${attendeeIds.length}명` })] : [h("span", { class: "muted", text: "참석자 고르기" })]));
    attBtn.addEventListener("click", () => personPicker(attBtn, attendeeIds, true, (ids) => { attendeeIds = ids; drawAtt(); }));
    drawTags(); drawAtt();
    const attField = field("참석자", attBtn);
    const times = h("div", { class: "row2" }, [field("시작 시간", startTime), field("끝 시간", endTime, "선택")]);
    const sync = () => { times.hidden = allDay.checked; attField.hidden = kind !== "meeting"; };
    allDay.addEventListener("change", sync);
    startDate.addEventListener("change", () => { if (!endDate.value || endDate.value < startDate.value) endDate.value = startDate.value; });
    const kindSeg = h("div", { class: "seg seg--sm" }, Object.entries({ meeting: "회의", event: "일정" }).map(([k, label]) => h("button", { type: "button", "aria-selected": String(k === kind), text: label, onclick: (ev) => {
      kind = k;
      kindSeg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b === ev.currentTarget)));
      sync();
    } })));
    sync();
    const submit = h("button", { class: "btn btn--primary", type: "submit", text: isNew ? "추가" : "저장" });
    const form = h("form", { class: "stack", novalidate: true }, [
      isNew && !opts.kind ? null : field("종류", kindSeg),
      field("제목", title),
      h("div", { class: "row2" }, [field("시작 날짜", startDate), field("끝 날짜", endDate)]),
      h("label", { class: "check" }, [allDay, h("span", { text: "종일" })]),
      times,
      field("장소", loc),
      attField,
      field("분류", catBtn),
      isNew && state.units.length ? field("팀", teamButton(teamId, (id) => { teamId = id; }), "이 팀(과 위 조직) 사람들과 참석자·관리자가 볼 수 있어요") : null,
      field("태그", tagsBtn),
      err,
      h("div", { class: "actions" }, [h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), submit])
    ]);
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      busy(submit, async () => {
        const body = {
          kind, title: title.value, startDate: startDate.value, endDate: endDate.value || startDate.value,
          startTime: allDay.checked ? null : startTime.value || null, endTime: allDay.checked ? null : endTime.value || null,
          location: loc.value, categoryId, tagIds, attendeeIds: kind === "meeting" ? attendeeIds : [], ...(isNew && state.units.length ? { unitId: teamId } : {})
        };
        try {
          const r = await api(isNew ? "/events" : `/events/${e.id}`, { method: isNew ? "POST" : "PATCH", body });
          closeDialog();
          toast(isNew ? "추가했어요. 오른쪽에서 안건·메모를 채워 보세요." : "고쳤어요.");
          openPeek("event", r.event.id);
          refresh({ keepPeek: true });
        } catch (ex) { showError(err, ex.message); }
      });
    });
    return form;
  }

  function taskForm(v) {
    const err = errorLine();
    const title = h("input", { maxlength: "80", autofocus: true, placeholder: "예: 회의 자료 최종 점검" });
    // 일정 만들 때처럼 시작일·마감일을 그 날짜로 채움
    const due = h("input", { type: "date", value: v.dueDate || today() });
    const start = h("input", { type: "date", value: v.startDate || v.dueDate || today() });
    start.addEventListener("change", () => { if (start.value && due.value && due.value < start.value) due.value = start.value; });
    due.addEventListener("change", () => { if (start.value && due.value && due.value < start.value) start.value = due.value; });
    let assignee = state.user.id, tagIds = [], categoryId = state.cat, catTouched = false;
    const who = h("button", { class: "select-btn", type: "button" });
    const drawWho = () => who.replaceChildren(assignee ? personLine(assignee) : h("span", { class: "muted", text: "담당자 없음" }));
    who.addEventListener("click", () => personPicker(who, assignee ? [assignee] : [], false, (uid) => { assignee = uid; drawWho(); }));
    const catBtn = categoryButton(categoryId, (id) => { categoryId = id; catTouched = true; });
    let teamId = myUnit(), teamTouched = false;
    const teamBtn = state.units.length ? teamButton(teamId, (id) => { teamId = id; teamTouched = true; }) : null;
    const tagsBtn = h("button", { class: "select-btn", type: "button" });
    const drawTags = () => tagsBtn.replaceChildren(...(tagIds.length ? tagChips(tagIds) : [h("span", { class: "muted", text: "태그 고르기" })]));
    tagsBtn.addEventListener("click", () => tagPicker(tagsBtn, tagIds, (ids) => { tagIds = ids; drawTags(); }));
    drawWho(); drawTags();
    const meeting = h("select", {}, [h("option", { value: "", text: "연결 안 함" })]);
    const phase = h("select", {}, [h("option", { value: "before", text: "회의 준비사항" }), h("option", { value: "after", text: "회의 후 할 일" })]);
    const phaseField = field("구분", phase);
    phaseField.hidden = true;
    meeting.addEventListener("change", () => { phaseField.hidden = !meeting.value; });
    quiet(api(`/meetings/choices?date=${v.dueDate || today()}`).then((r) => meeting.append(...r.meetings.map((m) => h("option", { value: String(m.id), text: `${shortDate(m.startDate)} ${m.startTime || ""} ${m.title}`.replace(/\s+/g, " ") })))));
    const submit = h("button", { class: "btn btn--primary", type: "submit", text: "추가" });
    const form = h("form", { class: "stack", novalidate: true }, [
      field("할 일", title),
      field("담당자", who),
      h("div", { class: "row2" }, [field("시작일", start), field("마감일", due)]),
      h("div", { class: "row2" }, [field("분류", catBtn, "관련 회의를 고르면 회의 분류를 따라가요"), field("태그", tagsBtn)]),
      teamBtn ? field("팀", teamBtn, "관련 회의를 고르면 회의의 팀을 따라가요") : null,
      h("div", { class: "row2" }, [field("관련 회의", meeting), phaseField]),
      err,
      h("div", { class: "actions" }, [h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), submit])
    ]);
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      busy(submit, async () => {
        try {
          const body = { title: title.value, startDate: start.value || null, dueDate: due.value || null, assigneeId: assignee, tagIds, meetingId: meeting.value ? Number(meeting.value) : null, phase: phase.value };
          // 회의를 골랐고 분류를 직접 안 바꿨으면 회의 분류를 따름 (서버에서)
          if (!body.meetingId || catTouched) body.categoryId = categoryId;
          if (teamBtn && (!body.meetingId || teamTouched)) body.unitId = teamId; // 회의를 고르면 회의 팀을 따름
          const r = await api("/tasks", { method: "POST", body });
          closeDialog(); toast("할 일을 추가했어요."); openPeek("task", r.task.id); refresh({ keepPeek: true });
        } catch (ex) { showError(err, ex.message); }
      });
    });
    return form;
  }

  function quickMemoForm(day) {
    const form = quickMemo(day, () => closeDialog());
    form.querySelector("textarea").setAttribute("autofocus", "");
    return form;
  }

  // 빠른 메모: 회의를 고르면 그 회의의 메모·참고사항으로, 아니면 그날 일반 메모로
  function quickMemo(day, onSaved) {
    const input = h("textarea", { class: "quickmemo__text", placeholder: "메모를 입력하세요\n회의를 고르면 그 회의의 안건·메모로 들어가요", maxlength: "3000", "aria-label": "메모" });
    const meeting = h("select", { "aria-label": "연결할 회의" }, [h("option", { value: "", text: "회의 연결 안 함 (일반 메모)" })]);
    quiet(api(`/meetings/choices?date=${day}`).then((r) => {
      meeting.append(...r.meetings.map((m) => h("option", { value: String(m.id), text: `${relDay(m.startDate) || shortDate(m.startDate)} ${m.startTime || ""} ${m.title}`.replace(/\s+/g, " ") })));
    }));
    const imp = h("input", { type: "checkbox" });
    let categoryId = state.cat, catTouched = false;
    const catBtn = categoryButton(categoryId, (id) => { categoryId = id; catTouched = true; }, "select-btn quickmemo__cat");
    const save = h("button", { class: "btn btn--primary", type: "submit", text: "저장하기" });
    const form = h("form", { class: "quickmemo" }, [
      input,
      h("div", { class: "quickmemo__bar" }, [meeting, catBtn, h("label", { class: "check small" }, [imp, h("span", { text: "중요" })]), save])
    ]);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) form.requestSubmit(); });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!input.value.trim()) return input.focus();
      busy(save, async () => {
        const body = { body: input.value, date: day, meetingId: meeting.value ? Number(meeting.value) : null, important: imp.checked };
        if (!body.meetingId || catTouched) body.categoryId = categoryId; // 회의를 고르면 회의 분류를 따름
        await act(() => api("/memos", { method: "POST", body }), "메모를 저장했어요.");
        input.value = ""; imp.checked = false;
        if (onSaved) onSaved();
        refresh();
      });
    });
    return form;
  }

  function manageTags() {
    const list = h("ul", { class: "tagman" });
    function draw() {
      list.replaceChildren(...state.tags.map((t) => {
        const name = inlineText(t.name, { label: "태그 이름", max: 20, required: true, onSave: async (v) => { const r = await act(() => api(`/tags/${t.id}`, { method: "PATCH", body: { name: v } })); state.tags = r.tags; drawTagsNav(); refresh(); } });
        const colors = h("div", { class: "swatches swatches--sm" }, COLOR_NAMES.map((cn, i) => h("button", { class: `swatch c${i}`, type: "button", "aria-label": cn, "aria-pressed": String(t.color === i), onclick: async () => {
          const r = await act(() => api(`/tags/${t.id}`, { method: "PATCH", body: { color: i } })); state.tags = r.tags; drawTagsNav(); draw(); refresh();
        } })));
        return h("li", {}, [tagChip(t.id), name, colors, h("button", { class: "icon-btn icon-btn--xs", type: "button", "aria-label": `${t.name} 삭제`, html: ICON.trash, onclick: async () => {
          if (!confirm(`'${t.name}' 태그를 지울까요? 붙어 있던 일정·할 일에서도 빠져요.`)) return;
          const r = await act(() => api(`/tags/${t.id}`, { method: "DELETE" })); state.tags = r.tags; drawTagsNav(); draw(); refresh();
        } })]);
      }));
    }
    draw();
    openDialog("태그 관리", h("div", { class: "stack" }, [
      h("p", { class: "muted small", text: "팀이 함께 쓰는 태그예요. 이름·색을 바꾸면 붙어 있는 모든 곳에 반영돼요." }),
      list,
      adder("새 태그 이름 후 Enter", async (v) => { const r = await act(() => api("/tags", { method: "POST", body: { name: v, color: state.tags.length % 6 } })); state.tags = r.tags; drawTagsNav(); draw(); })
    ]), { wide: true });
  }

  // 분류 관리 (관리자): 이름 고치기, 위·아래, 아래 분류 추가, 지우기, 여러 줄 한 번에 넣기
  function manageCategories() {
    if (!isAdmin()) return;
    const list = h("ul", { class: "catman" });
    const saved = (r) => { setCategories(r.categories); draw(); refresh(); return r; };
    const call = (path, method, body) => act(() => api(path, { method, body })).then(saved);
    function addChild(anchor, parent) {
      const input = h("input", { placeholder: `'${parent.name}' 아래 분류 이름`, maxlength: "30" });
      const err = errorLine();
      const ok = h("button", { class: "btn btn--primary btn--sm", type: "submit", text: "추가" });
      const form = h("form", { class: "pop__form" }, [input, err, ok]);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        busy(ok, async () => {
          try {
            const r = await api("/categories", { method: "POST", body: { parentId: parent.id, name: input.value } });
            state.catOpen.add(parent.id);
            closePop(); saved(r);
          } catch (ex) { showError(err, ex.message); }
        });
      });
      popover(anchor, form);
      input.focus();
    }
    function draw() {
      const rows = catRows(null);
      list.replaceChildren(...(rows.length ? rows.map(({ c, depth }) => {
        const sibs = catChildren(c.parentId);
        const i = sibs.indexOf(c);
        return h("li", { style: `padding-left:${depth * 22}px` }, [
          h("span", { class: "catman__lv", text: ["대", "중", "소"][depth] }),
          inlineText(c.name, { label: "분류 이름", max: 30, required: true, onSave: (v) => call(`/categories/${c.id}`, "PATCH", { name: v }) }),
          h("div", { class: "catman__tools" }, [
            h("button", { class: "icon-btn icon-btn--xs catman__up", type: "button", "aria-label": `${c.name} 위로`, title: "위로", html: ICON.right, disabled: i === 0, onclick: () => call(`/categories/${c.id}`, "PATCH", { move: -1 }) }),
            h("button", { class: "icon-btn icon-btn--xs catman__down", type: "button", "aria-label": `${c.name} 아래로`, title: "아래로", html: ICON.right, disabled: i === sibs.length - 1, onclick: () => call(`/categories/${c.id}`, "PATCH", { move: 1 }) }),
            depth < 2 ? h("button", { class: "icon-btn icon-btn--xs", type: "button", "aria-label": `${c.name} 아래에 분류 추가`, title: "아래 분류 추가", html: ICON.plus, onclick: (ev) => addChild(ev.currentTarget, c) }) : h("span", { class: "catman__gap" }),
            h("button", { class: "icon-btn icon-btn--xs", type: "button", "aria-label": `${c.name} 삭제`, title: "삭제", html: ICON.trash, onclick: () => {
              const kids = catSubtree(c.id).size - 1;
              if (!confirm(`'${catLabel(c.id)}' 분류를 지울까요?${kids ? ` 아래 분류 ${kids}개도 함께 지워져요.` : ""} 붙어 있던 회의·할 일·메모는 ${c.parentId ? `'${catLabel(c.parentId)}'` : "'분류 없음'"}(으)로 옮겨져요.`)) return;
              call(`/categories/${c.id}`, "DELETE");
            } })
          ])
        ]);
      }) : [h("p", { class: "muted small", text: "아직 분류가 없어요. 아래에서 대분류를 만들거나 여러 줄을 한 번에 넣어 주세요." })]));
    }
    draw();
    const bulk = h("textarea", { rows: "5", maxlength: "20000", placeholder: "한 줄에 하나씩, > 로 단계를 나눠요\n기획팀 > 행사 > 개막미사\n기획팀 > 행사 > 폐막미사\n운영팀 > 숙박", "aria-label": "분류 여러 줄" });
    const bulkBtn = h("button", { class: "btn btn--primary btn--sm", type: "button", text: "한 번에 넣기" });
    bulkBtn.addEventListener("click", () => {
      if (!bulk.value.trim()) return bulk.focus();
      busy(bulkBtn, async () => {
        const r = await call("/categories/bulk", "POST", { text: bulk.value });
        bulk.value = "";
        toast(r.added ? `분류 ${r.added}개를 만들었어요.` : "새로 만든 분류가 없어요 (이미 있어요).");
      });
    });
    openDialog("분류 관리", h("div", { class: "stack" }, [
      h("p", { class: "muted small", text: "대분류 › 중분류 › 소분류 3단계까지 만들 수 있어요. 회의·할 일·메모에 하나씩 붙이고, 왼쪽 메뉴에서 분류를 누르면 그 분류(와 그 아래)만 볼 수 있어요." }),
      list,
      adder("새 대분류 이름 후 Enter", (v) => call("/categories", "POST", { name: v })),
      h("details", { class: "catman__bulk" }, [
        h("summary", { text: "여러 줄 한 번에 넣기" }),
        h("div", { class: "stack stack--sm" }, [bulk, h("p", { class: "muted small", text: "이미 있는 분류는 건너뛰고 없는 것만 만들어요." }), h("div", { class: "actions" }, bulkBtn)])
      ])
    ]), { wide: true, admin: true });
  }

  // 구글 캘린더 연결 (관리자): 비공개 iCal 주소 등록·이름·색·분류·지금 읽기·주소 바꾸기·지우기
  // 주소는 서버가 가려서만 돌려줌 (calendar.google.com · …ab12)
  async function manageCalendars() {
    if (!isAdmin()) return;
    const list = h("ul", { class: "calman" });
    const body = h("div", { class: "stack" }, [loading()]);
    openDialog("구글 캘린더 연결", body, { wide: true, admin: true });
    let cals = [];
    const after = async () => { const me = await api("/me"); state.calendars = me.calendars || []; drawCalsNav(); refresh(); };
    const report = (r, okMsg) => {
      if (r.warn) toast(r.warn);
      else if (r.sync && !r.sync.ok) toast(r.sync.error);
      else if (r.sync) toast(`${okMsg} 일정 ${r.sync.count}개를 읽었어요.`);
      else toast(okMsg);
    };
    async function load() { cals = (await api("/admin/calendars")).calendars; draw(); }
    function status(c) {
      if (c.lastError) return h("p", { class: "calman__err small", text: `읽기 실패 (${ago(c.lastSyncAt)}): ${c.lastError}` + (c.lastOkAt ? ` · 마지막 성공 ${ago(c.lastOkAt)}` : "") });
      return h("p", { class: "muted small", text: c.lastOkAt ? `일정 ${c.eventCount}개 · ${ago(c.lastOkAt)} 읽음 · 20분마다 다시 읽어요` : "아직 읽지 않았어요" });
    }
    function changeUrl(anchor, c) {
      const u = h("input", { type: "url", placeholder: "새 비공개 주소 (https://calendar.google.com/…/basic.ics)", autocomplete: "off", spellcheck: "false" });
      const err = errorLine();
      const ok = h("button", { class: "btn btn--primary btn--sm", type: "submit", text: "바꾸고 읽기" });
      const form = h("form", { class: "pop__form" }, [u, err, ok]);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        busy(ok, async () => {
          try { const r = await api(`/admin/calendars/${c.id}`, { method: "PATCH", body: { url: u.value } }); closePop(); report(r, "주소를 바꿨어요."); await load(); await after(); }
          catch (ex) { showError(err, ex.message); }
        });
      });
      popover(anchor, form);
      u.focus();
    }
    function draw() {
      const patch = async (c, b) => { await act(() => api(`/admin/calendars/${c.id}`, { method: "PATCH", body: b })); await load(); await after(); };
      list.replaceChildren(...(cals.length ? cals.map((c) => h("li", { class: "card calman__item" }, [
        h("div", { class: "calman__row" }, [
          h("i", { class: `dot c${c.color}` }),
          inlineText(c.name, { label: "캘린더 이름", max: 30, required: true, onSave: (v) => patch(c, { name: v }) }),
          h("button", { class: "btn btn--ghost btn--sm", type: "button", onclick: (ev) => busy(ev.currentTarget, async () => { const r = await act(() => api(`/admin/calendars/${c.id}/sync`, { method: "POST" })); report(r, "다시 읽었어요."); await load(); await after(); }) }, "지금 읽기"),
          h("button", { class: "icon-btn icon-btn--xs", type: "button", "aria-label": `${c.name} 연결 끊기`, title: "연결 끊기", html: ICON.trash, onclick: async () => {
            if (!confirm(`'${c.name}' 연결을 끊을까요? 가져온 일정이 PSchedule 에서 사라져요 (구글 캘린더는 그대로예요).`)) return;
            await act(() => api(`/admin/calendars/${c.id}`, { method: "DELETE" })); await load(); await after();
          } })
        ]),
        h("div", { class: "calman__row calman__row--meta" }, [
          h("span", { class: "mono small muted", title: "비공개 주소는 가려서 보여 줘요", text: c.address }),
          h("button", { class: "link-btn", type: "button", text: "주소 바꾸기", onclick: (ev) => changeUrl(ev.currentTarget, c) }),
          h("div", { class: "swatches swatches--sm" }, COLOR_NAMES.map((cn, i) => h("button", { class: `swatch c${i}`, type: "button", "aria-label": cn, "aria-pressed": String(c.color === i), onclick: () => patch(c, { color: i }) }))),
          categoryButton(c.categoryId, (id) => patch(c, { categoryId: id }), "select-btn calman__cat"),
          (() => { const b = h("button", { class: "select-btn calman__cat", type: "button", title: "이 캘린더를 쓰는 소속 (소속 화면·'우리 소속'에 반영)" }, c.unitId && unitOf(c.unitId) ? [icon("org"), h("span", { text: unitShort(c.unitId) })] : h("span", { class: "muted", text: "소속 고르기" }));
            b.addEventListener("click", () => unitPicker(b, c.unitId, (id) => patch(c, { unitId: id }))); return b; })()
        ]),
        status(c)
      ])) : [h("p", { class: "muted small", text: "아직 연결한 캘린더가 없어요." })]));
    }

    // 새로 연결
    const err = errorLine();
    const name = h("input", { maxlength: "30", placeholder: "예: 조직위 공용 캘린더" });
    const url = h("input", { type: "url", placeholder: "https://calendar.google.com/calendar/ical/…/private-…/basic.ics", autocomplete: "off", spellcheck: "false" });
    let color = 5, categoryId = null, unitId = null;
    const swatches = h("div", { class: "swatches swatches--sm" });
    const drawSw = () => swatches.replaceChildren(...COLOR_NAMES.map((cn, i) => h("button", { class: `swatch c${i}`, type: "button", "aria-label": cn, "aria-pressed": String(color === i), onclick: () => { color = i; drawSw(); } })));
    drawSw();
    const submit = h("button", { class: "btn btn--primary", type: "submit", text: "연결하고 읽기" });
    const form = h("form", { class: "card calman__new stack", novalidate: true }, [
      h("h3", { class: "card__title", text: "새 캘린더 연결" }),
      h("div", { class: "row2" }, [field("이름", name), field("분류", categoryButton(null, (id) => { categoryId = id; }), "가져온 일정에 붙일 분류 (선택)")]),
      state.units.length ? field("소속", unitButton(null, (id) => { unitId = id; }, "소속 고르기 (선택)"), "이 캘린더를 쓰는 소속 — '우리 소속' 거르기와 조직도에 반영") : null,
      field("비공개 주소 (iCal 형식)", url, "구글 캘린더 → 설정 → 왼쪽에서 캘린더 선택 → '캘린더 통합' → '비공개 주소(iCal 형식)' 를 복사해 붙여 넣어 주세요. 이 주소를 아는 사람은 누구나 일정을 볼 수 있으니 비밀번호처럼 다뤄 주세요."),
      field("색", swatches), err,
      h("div", { class: "actions" }, submit)
    ]);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      busy(submit, async () => {
        try {
          const r = await api("/admin/calendars", { method: "POST", body: { name: name.value, url: url.value, color, categoryId, unitId } });
          name.value = ""; url.value = "";
          report(r, "연결했어요.");
          await load(); await after();
        } catch (ex) { showError(err, ex.message); (ex.field === "url" ? url : name).focus(); }
      });
    });
    body.replaceChildren(
      h("p", { class: "muted small", text: "구글 캘린더의 일정을 읽기 전용으로 가져와 달력·오늘 화면에 함께 보여 줘요. PSchedule 에서 고친 내용은 구글로 가지 않아요 (한 방향)." }),
      list, form
    );
    try { await load(); } catch (e) { list.replaceChildren(failed(e)); }
  }

  /* ---------- 댓글 ---------- */
  function commentsBox(type, id, initial, onChange) {
    const list = h("ul", { class: "comments" });
    const count = h("span", { class: "muted" });
    function draw(items) {
      count.textContent = items.length ? String(items.length) : "";
      list.replaceChildren(...items.map((c) => h("li", { class: "comment" + (c.mine ? " is-mine" : "") }, [
        h("div", { class: "comment__head" }, [
          h("strong", { text: c.author }), h("span", { class: "muted", text: ago(c.createdAt) }),
          c.canDelete ? h("button", { class: "link-btn link-btn--muted", type: "button", text: "삭제", onclick: async () => {
            await act(() => api(`/comments/${c.id}`, { method: "DELETE" }));
            items = items.filter((x) => x.id !== c.id);
            draw(items);
            if (onChange) onChange();
          } }) : null
        ]),
        h("p", { class: "comment__body", text: c.body })
      ])));
    }
    draw(initial);
    const input = h("textarea", { rows: "1", maxlength: "1000", placeholder: "댓글 남기기", "aria-label": "댓글" });
    const submit = h("button", { class: "btn btn--primary btn--sm", type: "submit", text: "등록" });
    const form = h("form", { class: "comment-form" }, [input, submit]);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) form.requestSubmit(); });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      busy(submit, async () => {
        const r = await act(() => api(`/${type}s/${id}/comments`, { method: "POST", body: { body: input.value } }));
        input.value = "";
        draw(r.comments);
        if (onChange) onChange();
      });
    });
    return section("chat", ["댓글 ", count], null, h("div", { class: "stack stack--sm" }, [list, form]));
  }

  /* ---------- 오늘 (일자별 세부) ---------- */
  async function pageToday(day) {
    if (!day) day = today();
    document.title = `${relDay(day) === "오늘" ? "오늘" : dateLabel(day)} · ${TITLE}`;
    drawMini(day);
    const timelineBox = h("div", { class: "card tl-card" }, loading());
    const tasksBox = h("div", { class: "card today-tasks" }, loading());
    let taskTab = store.get("ps.todayTab", "all");

    const quickbar = h("div", { class: "quickbar" }, [
      h("div", { class: "quickbar__text" }, [h("strong", { text: "바로 추가하고, 여기서 해결하세요." }), h("span", { class: "muted", text: "회의, 할 일, 태그, 메모를 페이지 이동 없이 처리할 수 있어요." })]),
      h("div", { class: "quickbar__btns" }, [
        h("button", { class: "qbtn", type: "button", onclick: () => quickAdd("task") }, [icon("check"), h("span", {}, [h("strong", { text: "할 일 추가" }), h("small", { text: "예) 회의 자료 검토" })])]),
        h("button", { class: "qbtn", type: "button", onclick: () => manageTags() }, [icon("tag"), h("span", {}, [h("strong", { text: "태그 수정" }), h("small", { text: "자주 쓰는 태그 관리" })])]),
        h("button", { class: "qbtn", type: "button", onclick: () => { const t = layout.main.querySelector(".quickmemo__text"); if (t) { t.scrollIntoView({ block: "center", behavior: "smooth" }); t.focus(); } } }, [icon("note"), h("span", {}, [h("strong", { text: "메모 작성" }), h("small", { text: "예) 회의 내용 정리" })])])
      ])
    ]);
    const memoList = h("div", { class: "today-memos__list" });
    const memoBox = h("div", { class: "card today-memos" }, [h("h2", { class: "card__title", text: "메모" }), quickMemo(day), memoList]);
    setMain("today", [quickbar, h("div", { class: "today-grid" }, [timelineBox, h("div", { class: "today-side" }, [tasksBox, memoBox])])]);

    async function load() {
      const [ev, tk, mm] = await Promise.all([
        api(`/events?from=${day}&to=${day}`), api(`/tasks?date=${day}&today=${today()}`), api(`/memos?date=${day}`)
      ]);
      const inCat = catFilter();
      const events = dedupeImported(allEvents(ev).filter((e) => showEv(e) && inCat(e)));
      drawTimeline(events);
      drawTasks(tk.tasks.filter(inCat));
      memoList.replaceChildren(memoRows(mm.memos.filter(inCat), { empty: "이 날 남긴 메모가 없어요." }));
      markPeeked();
    }

    function drawTimeline(events) {
      const allDay = events.filter((e) => !e.startTime || e.startDate !== day);
      const timed = events.filter((e) => e.startTime && e.startDate === day);
      const head = h("div", { class: "card__head" }, [
        h("h2", { class: "card__title", text: relDay(day) === "오늘" ? "오늘의 일정" : `${relDay(day) || ""} 일정`.trim() }),
        h("div", { class: "daynav" }, [
          h("a", { class: "icon-btn", href: `#/today/${shiftYmd(day, -1)}`, "aria-label": "전날", html: ICON.left }),
          h("span", { class: "daynav__label", text: dateLabel(day) }),
          h("a", { class: "icon-btn", href: `#/today/${shiftYmd(day, 1)}`, "aria-label": "다음 날", html: ICON.right }),
          day !== today() ? h("a", { class: "btn btn--ghost btn--sm", href: "#/today", text: "오늘" }) : null
        ]),
        h("a", { class: "btn btn--ghost btn--sm", href: "#/dashboard" }, ["전체 일정 보기", icon("arrow")])
      ]);
      const grid = h("div", { class: "tl", style: `height:${24 * HOUR_PX}px` });
      for (let i = 0; i < 24; i++) grid.append(h("div", { class: "tl__hour", style: `top:${i * HOUR_PX}px` }, h("span", { text: `${pad(i)}:00` })));
      // 겹치는 일정은 나란히
      const items = timed.map((e) => {
        const s = minutes(e.startTime);
        const en = e.endTime && e.endTime > e.startTime ? minutes(e.endTime) : s + 60;
        return { e, s, en, lane: 0, lanes: 1 };
      }).sort((a, b) => a.s - b.s || b.en - a.en);
      let cluster = [], clusterEnd = -1;
      const flush = () => { const n = Math.max(1, ...cluster.map((x) => x.lane + 1)); cluster.forEach((x) => (x.lanes = n)); cluster = []; };
      for (const it of items) {
        if (it.s >= clusterEnd) { flush(); clusterEnd = -1; }
        const used = new Set(cluster.filter((x) => x.en > it.s).map((x) => x.lane));
        while (used.has(it.lane)) it.lane++;
        cluster.push(it);
        clusterEnd = Math.max(clusterEnd, it.en);
      }
      flush();
      for (const it of items) {
        const e = it.e;
        const top = (it.s / 60) * HOUR_PX, height = Math.max(26, ((it.en - it.s) / 60) * HOUR_PX - 3);
        grid.append(h("button", {
          class: `tl__ev c${evColor(e)}` + (e.ext ? " is-ext" : "") + (height < 46 ? " is-short" : ""), type: "button", "data-peek": evKey(e),
          style: `top:${top}px;height:${height}px;left:calc(56px + (100% - 60px) * ${it.lane / it.lanes});width:calc((100% - 60px) / ${it.lanes} - 4px)`,
          onclick: () => openEv(e)
        }, [
          h("div", { class: "tl__evtop" }, [h("strong", { text: e.title }), h("span", { class: "tl__tags" }, [srcTag(e, true), ...tagChips(e.tagIds)])]),
          h("div", { class: "tl__meta" }, [
            h("span", { text: timeRange(e) }),
            e.location ? h("span", {}, [icon("place"), e.location]) : null,
            e.ext ? h("span", {}, [icon("cal"), e.calendarName]) : null,
            e.kind === "meeting" && (e.attendeeIds.length || (e.guestNames || []).length) ? h("span", { title: (e.guestNames || []).length ? `외부: ${e.guestNames.join(", ")}` : null }, [icon("people"), `${e.attendeeIds.length + (e.guestNames || []).length}명`]) : null,
            e.openTasks ? h("span", {}, [icon("check"), `${e.openTasks}`]) : null
          ])
        ]));
      }
      if (day === today()) {
        const n = new Date();
        const m = n.getHours() * 60 + n.getMinutes();
        grid.append(h("div", { class: "tl__now", style: `top:${(m / 60) * HOUR_PX}px` }, h("span", { text: nowHm() })));
      }
      const scroller = h("div", { class: "tl-scroll" }, grid);
      fill(timelineBox, head,
        allDay.length ? h("div", { class: "tl-allday" }, [h("span", { class: "tl-allday__label", text: "종일" }), ...allDay.map((e) => h("button", { class: `chip c${evColor(e)}` + (e.ext ? " is-ext" : ""), type: "button", "data-peek": evKey(e), onclick: () => openEv(e) }, [srcTag(e, true), h("span", { text: e.title })]))]) : null,
        scroller,
        !events.length ? h("p", { class: "tl-empty muted", text: "일정이 없어요. 시간대를 두 번 눌러 바로 추가할 수 있어요." }) : null);
      grid.addEventListener("dblclick", (ev) => {
        if (ev.target.closest(".tl__ev")) return;
        const y = ev.clientY - grid.getBoundingClientRect().top;
        const hr = Math.max(0, Math.min(23, Math.floor(y / HOUR_PX)));
        editEvent(null, { kind: "meeting", date: day, time: `${pad(hr)}:00` });
      });
      // 처음에는 지금 시각(또는 첫 일정) 근처로
      if (!timelineBox.dataset.scrolled) {
        timelineBox.dataset.scrolled = "1";
        const first = items.length ? items[0].s / 60 : 9;
        const focusHour = day === today() ? Math.min(new Date().getHours() - 1, first) : first - 0.5;
        requestAnimationFrame(() => { scroller.scrollTop = Math.max(0, focusHour) * HOUR_PX; });
      } else {
        const prev = timelineBox.dataset.top;
        if (prev) requestAnimationFrame(() => { scroller.scrollTop = Number(prev); });
      }
      scroller.addEventListener("scroll", () => { timelineBox.dataset.top = String(scroller.scrollTop); });
    }

    function drawTasks(all) {
      const shown = state.show.task ? all : [];
      const groups = { all: shown, meeting: shown.filter((t) => t.meetingId), personal: shown.filter((t) => !t.meetingId) };
      const tabs = h("div", { class: "tabs-line", role: "tablist" }, [["all", "전체"], ["meeting", "회의 관련"], ["personal", "개인 업무"]].map(([k, label]) => h("button", {
        type: "button", role: "tab", "aria-selected": String(k === taskTab), onclick: () => { taskTab = k; store.set("ps.todayTab", k); drawTasks(all); }
      }, [label, h("span", { class: "count", text: String(groups[k].length) })])));
      const list = groups[taskTab].map((t) => h("li", { class: "ttask" + (t.status === "done" ? " is-done" : ""), "data-peek": `task:${t.id}` }, [
        checkbox(t, (s) => patchTask(t, { status: s })),
        h("button", { class: "ttask__main", type: "button", onclick: () => openPeek("task", t.id) }, [
          h("span", { class: "ttask__title", text: t.title }),
          t.meetingId ? h("span", { class: "ttask__meeting" }, [icon("people"), t.meetingTitle]) : null
        ]),
        h("span", { class: "ttask__meta" }, [dueBadge(t), ...tagChips(t.tagIds).slice(0, 2), t.assigneeId && t.assigneeId !== state.user.id ? avatar(t.assigneeId, "sm") : null])
      ]));
      tasksBox.replaceChildren(
        h("div", { class: "card__head" }, [h("h2", { class: "card__title" }, [relDay(day) === "오늘" ? "오늘의 할 일 " : "할 일 ", h("span", { class: "count count--lg", text: String(shown.filter((t) => t.status !== "done").length) })]),
          h("button", { class: "btn btn--ghost btn--sm", type: "button", onclick: () => quickAdd("task") }, [icon("plus"), "추가"])]),
        tabs,
        adder("할 일 추가 후 Enter", (v) => act(() => api("/tasks", { method: "POST", body: { title: v, startDate: day, dueDate: day, assigneeId: state.user.id, categoryId: state.cat } })).then(() => load())),
        list.length ? h("ul", { class: "ttasks" }, list) : h("p", { class: "muted small task-empty", text: state.show.task ? "할 일이 없어요." : "왼쪽 '내 캘린더'에서 할 일이 꺼져 있어요." })
      );
    }

    page = { name: "today", reload: load };
    try { await load(); } catch (e) { if (e.status !== 401) timelineBox.replaceChildren(failed(e)); }
  }

  /* ---------- 대시보드 (월간 달력 + 회의 전체 일정) ---------- */
  function monthRange(month) {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const start = addDays(first, -first.getDay());
    const last = new Date(month.getFullYear(), month.getMonth() + 1, 0);
    const end = addDays(last, 6 - last.getDay());
    return { start, end };
  }
  // mode 'mine': 나의 대시보드 (보이는 범위 규칙대로, 관리자도), 'all': 전체 대시보드 (관리자 전용, 팀으로 거르기·팀별 요약)
  async function pageDashboard(mode) {
    const all = mode === "all";
    if (all && !isAdmin()) return go("#/dashboard");
    const pageName = all ? "alldash" : "dashboard";
    const scopeQ = all ? "" : "&scope=mine";
    if (!state.month) {
      const saved = store.get("ps.month", "");
      const base = /^\d{4}-\d{2}$/.test(saved) ? parseYmd(saved + "-01") : new Date();
      state.month = new Date(base.getFullYear(), base.getMonth(), 1);
    }
    drawMini(null);
    let data = { events: [], tasks: [] };
    let listTab = store.get("ps.listTab", "all");
    const calCard = h("section", { class: "card cal-card" });
    const listCard = h("section", { class: "card mlist-card" });
    const topBox = h("div", { class: "dash-top" });
    setMain(pageName, [topBox, calCard, listCard]);
    // 전체 대시보드: 팀으로 거르기 (null 모든 팀, 'none' 팀 미지정, 아니면 그 팀과 아래 팀)
    const teamOk = () => {
      if (!all || !state.allTeam) return () => true;
      if (state.allTeam === "none") return (x) => !x.unitId;
      const scope = unitSubtree(state.allTeam);
      return (x) => scope.has(x.unitId);
    };
    function drawTop(overview) {
      if (!all) {
        const u = myUnit();
        const extra = viewGrantsText(state.user.viewUnits);
        fill(topBox, h("div", { class: "scopebar" }, [icon("org"), h("span", {}, [h("strong", { text: "보이는 범위: " }),
          u ? `${unitLabel(u)}${unitChildren(u).length ? " (아래 팀 포함)" : ""}${extra ? ` + 추가로 ${extra}` : ""} + 내가 관련된 것`
            : extra ? `${extra} + 내가 관련된 것` : "내가 만들었거나 참석·담당한 것만 (아직 소속이 없어요)",
          state.user.role === "director" ? " · 본부장 권한: 맡은 조직과 그 아래 조직 포함" : null]),
          isAdmin() ? h("a", { class: "btn btn--admin btn--sm", href: "#/alldash" }, [icon("lock"), "전체 대시보드"]) : null]));
        return;
      }
      if (state.allTeam && state.allTeam !== "none" && !unitOf(state.allTeam)) state.allTeam = null;
      const pick = h("button", { class: "select-btn select-btn--sm", type: "button" }, state.allTeam === "none" ? "팀 미지정" : state.allTeam ? unitLabel(state.allTeam) : h("span", { class: "muted", text: "모든 팀" }));
      pick.addEventListener("click", () => unitPicker(pick, state.allTeam === "none" ? null : state.allTeam, (id) => { state.allTeam = id; render(); }, { noneLabel: "모든 팀" }));
      const head = h("div", { class: "page-head page-head--wrap" }, [h("h1", { text: "전체 대시보드" }), adminBadge(),
        h("span", { class: "muted small", text: "모든 팀의 회의·일정·할 일. 나의 대시보드는 사이드바 '나의 대시보드'에서 따로 봐요." }),
        h("span", { class: "page-head__end ot-actions" }, [pick, state.allTeam ? h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "모든 팀 보기", onclick: () => { state.allTeam = null; render(); } }) : null])]);
      // 팀별 요약 (아래 팀까지 합친 숫자), 팀 미지정 줄
      let table = h("div", { class: "loading", text: "팀별 요약 불러오는 중…" });
      if (overview) {
        const byUnit = new Map(overview.rows.map((r) => [r.unitId, r]));
        const sum = (id) => { const t = { weekMeetings: 0, openTasks: 0, lateTasks: 0 }; for (const x of unitSubtree(id)) { const r = byUnit.get(x); if (r) { t.weekMeetings += r.weekMeetings; t.openTasks += r.openTasks; t.lateTasks += r.lateTasks; } } return t; };
        const rowEl = (key, label, depth, t) => h("tr", { class: (state.allTeam === key ? "is-sel" : "") + (t.weekMeetings + t.openTasks ? "" : " is-empty"), onclick: () => { state.allTeam = state.allTeam === key ? null : key; render(); } }, [
          h("td", {}, h("span", { class: "teamsum__name", style: `padding-left:${depth * 14}px`, text: label })),
          h("td", { class: "num", text: String(t.weekMeetings) }), h("td", { class: "num", text: String(t.openTasks) }),
          h("td", { class: "num" + (t.lateTasks ? " is-late" : ""), text: String(t.lateTasks) })]);
        const rows = unitRows(null).filter(({ depth }) => depth <= 3).map(({ u, depth }) => rowEl(u.id, u.name, depth, sum(u.id)));
        const none = byUnit.get(null) || { weekMeetings: 0, openTasks: 0, lateTasks: 0 };
        rows.push(rowEl("none", "팀 미지정", 0, none));
        table = h("div", { class: "table-wrap teamsum-wrap" }, h("table", { class: "table teamsum" }, [
          h("thead", {}, h("tr", {}, [h("th", { text: `팀 (이번 주 ${shortDate(overview.week.from)}~${shortDate(overview.week.to)})` }), h("th", { class: "num", text: "이번 주 회의" }), h("th", { class: "num", text: "남은 할 일" }), h("th", { class: "num", text: "마감 지남" })])),
          h("tbody", {}, rows)]));
      }
      fill(topBox, head, h("section", { class: "card teamsum-card" }, [h("div", { class: "card__head" }, [h("h2", { class: "card__title", text: "팀별 요약" }), h("span", { class: "muted small", text: "줄을 누르면 그 팀만 봐요" })]), table]));
    }
    drawTop(null);
    if (all) quiet(api(`/admin/overview?today=${today()}`).then(drawTop));

    const setMonth = (d) => { state.month = d; store.set("ps.month", ymd(d).slice(0, 7)); quiet(load()); };
    const matches = (x) => !state.search || x.title.toLowerCase().includes(state.search.toLowerCase());

    async function load() {
      const { start, end } = monthRange(state.month);
      const [ev, tk] = await Promise.all([api(`/events?from=${ymd(start)}&to=${ymd(end)}${scopeQ}`), api(`/tasks?from=${ymd(start)}&to=${ymd(end)}${scopeQ}`)]);
      const inCat = catFilter(), ours = ourFilter(), inTeam = teamOk();
      const keep = (x) => inCat(x) && ours(x) && inTeam(x);
      data = { events: dedupeImported(allEvents(ev).filter(keep)), tasks: tk.tasks.filter(keep) };
      draw();
    }

    function toolbar() {
      const title = `${state.month.getFullYear()}년 ${state.month.getMonth() + 1}월`;
      document.title = `${title} · ${TITLE}`;
      searchToggle = h("button", { class: "search__more", type: "button", "aria-label": "종류 거르기 펼치기", "aria-expanded": String(searchFiltersOpen), hidden: !state.search.trim(), html: ICON.right, onclick: (e) => { e.preventDefault(); searchFiltersOpen = !searchFiltersOpen; searchToggle.setAttribute("aria-expanded", String(searchFiltersOpen)); drawBody(); } });
      const search = h("label", { class: "search search--main" }, [icon("search"), h("input", { type: "search", value: state.search, placeholder: "안건·메모·댓글까지 전체 검색", "aria-label": "검색", oninput: (e) => { state.search = e.target.value; scheduleSearch(); } }), searchToggle]);
      const views = h("div", { class: "seg seg--sm" }, [["month", "월"], ["list", "목록"]].map(([k, label]) => h("button", { type: "button", "aria-selected": String(state.view === k), text: label, onclick: () => { state.view = k; store.set("ps.view", k); draw(); } }))
        .concat(h("a", { href: "#/today", class: "seg__link", text: "일" })));
      return h("div", { class: "cal-head" }, [
        h("div", { class: "cal-nav" }, [
          h("button", { class: "icon-btn", type: "button", "aria-label": "이전 달", html: ICON.left, onclick: () => setMonth(new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1)) }),
          h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "오늘", onclick: () => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1)) }),
          h("button", { class: "icon-btn", type: "button", "aria-label": "다음 달", html: ICON.right, onclick: () => setMonth(new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1)) })
        ]),
        h("h1", { class: "cal-title", text: title }),
        h("div", { class: "cal-tools" }, [ourToggle(() => quiet(load())), views, search])
      ]);
    }

    let bodyBox;
    function draw() {
      bodyBox = h("div", { class: "cal-body" });
      calCard.replaceChildren(toolbar(), bodyBox);
      drawBody();
    }
    function drawBody() {
      const searching = !!state.search.trim();
      listCard.hidden = searching;
      if (searchToggle) searchToggle.hidden = !searching;
      bodyBox.replaceChildren(searching ? searchView() : state.view === "list" ? monthList() : monthGrid());
      if (!searching) drawMeetingList();
      markPeeked();
    }

    /* ----- 검색: 서버에서 안쪽 내용까지 찾고, 날짜 순서대로 묶어서 ----- */
    let searchTimer = null, searchSeq = 0, searchData = null, searchKind = store.get("ps.searchKind", "all");
    let searchToggle = null, searchFiltersOpen = searchKind !== "all";
    let pickMode = false; const picked = new Map(); // 가져온 일정 여러 개 골라 우리 소속으로 넣기
    function scheduleSearch() {
      clearTimeout(searchTimer);
      if (!state.search.trim()) { searchData = null; drawBody(); return; }
      if (!searchData) drawBody(); // '찾는 중…'
      searchTimer = setTimeout(runSearchNow, 280);
    }
    async function runSearchNow() {
      const qv = state.search.trim(), seq = ++searchSeq;
      if (!qv) return;
      try {
        const r = await api(`/search?q=${encodeURIComponent(qv)}${scopeQ}`);
        if (seq !== searchSeq) return;
        searchData = r;
        drawBody();
        // 오늘(또는 오늘 다음 첫 날짜) 위치로
        const target = bodyBox.querySelector(".sr-today, .sr-group.is-today, .sr-group.is-future");
        if (target) target.scrollIntoView({ block: "center", behavior: "smooth" });
      } catch (e) { if (seq === searchSeq && e.status !== 401) bodyBox.replaceChildren(failed(e)); }
    }
    const SR_KIND = { meeting: ["회의", 4], event: ["일정", 0], task: ["할 일", 1], memo: ["메모", 2] };
    const srGroup = (r) => (r.type === "task" ? "task" : r.type === "memo" ? "memo" : "meeting");
    const marked = (text, hl) => (hl ? [text.slice(0, hl[0]), h("mark", { text: text.slice(hl[0], hl[1]) }), text.slice(hl[1])] : [text]);
    // '오전 10:30~ 11:30', '오후 2시~ 3시', '오전 11시~ 오후 1시'
    function koTime(t) {
      const [hh, mm] = t.split(":").map(Number);
      const ampm = hh < 12 || hh === 24 ? "오전" : "오후";
      const h12 = hh % 12 === 0 ? 12 : hh % 12;
      return [ampm, mm ? `${h12}:${pad(mm)}` : `${h12}시`];
    }
    function koRange(start, end) {
      if (!start) return "종일";
      const [a1, s1] = koTime(start);
      if (!end || end === start) return `${a1} ${s1}`;
      const [a2, s2] = koTime(end);
      return `${a1} ${s1}~ ${a2 === a1 ? "" : a2 + " "}${s2}`;
    }
    function searchView() {
      const qv = state.search.trim();
      if (!searchData) return h("div", { class: "card sr-card" }, h("div", { class: "loading", text: "찾는 중…" }));
      const pending = searchData.q !== qv; // 치는 동안에는 이전 결과를 그대로 두고 '찾는 중'만 표시
      const inCat = catFilter(), ours = ourFilter(), inTeam = teamOk();
      const all = searchData.results.filter((r) => inCat(r) && ours(r) && inTeam(r));
      // 왼쪽 분류·'우리 소속'·팀 거르기로 가려진 결과가 있으면 알려 줌
      const hidden = searchData.results.length - all.length;
      const count = (k) => (k === "all" ? all.length : all.filter((r) => srGroup(r) === k).length);
      const list = searchKind === "all" ? all : all.filter((r) => srGroup(r) === searchKind);
      const t = today();
      const groups = [];
      for (const r of list) {
        const key = r.date || "";
        if (!groups.length || groups[groups.length - 1].key !== key) groups.push({ key, items: [] });
        groups[groups.length - 1].items.push(r);
      }
      const todayLine = (note) => h("div", { class: "sr-today" }, [h("span", { class: "sr-today__dot" }), h("span", { text: `오늘 ${dateLabel(t)}` }), h("small", { text: note })]);
      const out = [];
      let todayShown = false;
      for (const g of groups) {
        if (!todayShown && (!g.key || g.key >= t)) {
          todayShown = true;
          if (g.key !== t) out.push(todayLine(g.key ? "이 날은 찾은 것이 없어요" : "앞으로의 날짜에는 찾은 것이 없어요"));
        }
        out.push(srGroupEl(g, t));
      }
      if (!todayShown && groups.length) out.push(todayLine("앞으로의 날짜에는 찾은 것이 없어요"));
      return h("div", { class: "sr" }, [
        h("div", { class: "sr-head" }, [
          h("p", { class: "sr-summary" }, [h("strong", { text: `'${searchData.q}'` }), ` ${list.length}건 · 전체 기간`, pending ? h("small", { class: "muted", text: " · 찾는 중…" }) : null, searchData.total > searchData.limit ? h("small", { class: "muted", text: ` (앞 ${searchData.limit}건만, 검색어를 더 자세히 적어 주세요)` }) : null]),
          searchKind !== "all" && !searchFiltersOpen ? h("span", { class: "sr-kindtag", text: { meeting: "회의·일정만", task: "할 일만", memo: "메모만" }[searchKind] }) : null,
          list.some((r) => r.ext) ? h("button", { class: "btn btn--ghost btn--sm sr-pick", type: "button", text: pickMode ? "고르기 그만" : "가져온 일정 골라 넣기", onclick: () => { pickMode = !pickMode; picked.clear(); drawBody(); } }) : null
        ]),
        pickMode ? h("div", { class: "bulkbar sr-pickbar" }, [
          h("span", { text: picked.size ? `가져온 일정 ${picked.size}개 골랐어요` : "넣을 구글 캘린더 일정을 눌러 골라 주세요" }),
          h("button", { class: "btn btn--primary btn--sm", type: "button", disabled: !picked.size, text: "우리 소속으로 넣기", onclick: () => importExternal([...picked.values()]) })
        ]) : null,
        hidden ? h("div", { class: "sr-hidden" }, [icon("search"), h("span", { text: `거르기 때문에 ${hidden}건이 가려졌어요 (${[state.cat && "분류", state.ourUnit && myUnit() && "우리 소속", pageName === "alldash" && state.allTeam && "팀"].filter(Boolean).join("·") || "거르기"}).` }),
          h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "거르기 풀고 보기", onclick: () => {
            state.ourUnit = false; store.set("ps.ours", "0"); state.allTeam = null;
            if (state.cat) { state.cat = null; store.remove("ps.cat"); drawCatsNav(); }
            render();
          } })]) : null,
        searchFiltersOpen ? h("div", { class: "seg seg--sm sr-kinds" }, [["all", "전체"], ["meeting", "회의·일정"], ["task", "할 일"], ["memo", "메모"]].map(([k, label]) => h("button", { type: "button", "aria-selected": String(searchKind === k), onclick: () => { searchKind = k; store.set("ps.searchKind", k); drawBody(); } }, [label, h("span", { class: "count", text: String(count(k)) })]))) : null,
        out.length ? h("div", { class: "card sr-card" }, out) : h("div", { class: "card sr-card" }, h("p", { class: "empty", text: "찾는 내용이 없어요. 다른 낱말로 찾아 보세요." }))
      ]);
    }
    // 날짜 한 묶음: 왼쪽 큰 날짜 숫자 + 'YYYY년 M월, 요일', 오른쪽에 그날 항목
    function srGroupEl(g, t) {
      const cls = g.key === t ? " is-today" : !g.key ? " is-nodate" : g.key > t ? " is-future" : " is-past";
      let dateCol;
      if (g.key) {
        const d = parseYmd(g.key);
        dateCol = h("div", { class: "sr-date" }, [h("span", { class: "sr-date__n", text: String(d.getDate()) }), h("span", { class: "sr-date__ym" }, [h("span", { class: "sr-date__long", text: `${d.getFullYear()}년 ${d.getMonth() + 1}월, ` }), WEEKDAYS[d.getDay()]])]);
      } else dateCol = h("div", { class: "sr-date sr-date--none" }, h("span", { class: "sr-date__ym", text: "날짜 없음" }));
      return h("section", { class: "sr-group" + cls, "aria-label": g.key ? dateLabel(g.key, { year: true }) : "날짜 없음" }, [dateCol, h("ul", { class: "sr-list" }, g.items.map(resultRow))]);
    }
    function resultRow(r) {
      const [label, color] = r.ext ? [r.calendarName || "구글 캘린더", r.color] : SR_KIND[r.type];
      const key = r.ext ? `ext:${r.id}` : r.type === "task" ? `task:${r.id}` : r.type === "memo" ? (r.meetingId ? `event:${r.meetingId}` : `day:${r.date}`) : `event:${r.id}`;
      const picking = pickMode && r.ext;
      const open = () => {
        if (picking) { picked.has(r.id) ? picked.delete(r.id) : picked.set(r.id, { id: r.id, color: r.color, startDate: r.date, startTime: r.time, title: r.title }); drawBody(); return; }
        const [type, id] = key.split(":"); openPeek(type, type === "day" ? id : Number(id));
      };
      const inTitle = r.field === "제목" || (r.type === "memo" && r.field === "메모"); // 메모는 본문이 곧 제목
      const done = r.type === "task" && r.status === "done";
      const mark = picking ? h("span", { class: "sr-mark sr-mark--task sr-mark--pick" + (picked.has(r.id) ? " is-done" : ""), html: picked.has(r.id) ? ICON.check : "" }) : r.type === "task" ? h("span", { class: "sr-mark sr-mark--task" + (done ? " is-done" : ""), title: label, html: done ? ICON.check : "" })
        : r.type === "memo" ? h("span", { class: "sr-mark sr-mark--memo", title: label }, icon("note"))
        : h("span", { class: `sr-mark sr-mark--dot c${color}`, title: label });
      const time = r.type === "task" ? (done ? "완료" : `할 일 · ${STATUS[r.status]}`) : r.type === "memo" ? (r.important ? "중요 메모" : "메모") : koRange(r.time, r.endTime);
      return h("li", {}, h("button", { class: "sr-row" + (picking && picked.has(r.id) ? " is-picked" : "") + (pickMode && !r.ext ? " is-dim" : ""), type: "button", "data-peek": key, onclick: open, title: `${label} · ${r.title}`, "aria-pressed": picking ? String(picked.has(r.id)) : null }, [
        mark,
        h("span", { class: "sr-time", text: time }),
        h("span", { class: "sr-main" }, [
          h("span", { class: "sr-title" + (done ? " is-done" : "") }, inTitle ? marked(r.text, r.hl) : [r.title]),
          inTitle ? null : h("span", { class: "sr-snip" }, [`${r.field}: `, ...marked(r.text, r.hl)]),
          r.type === "memo" && r.meetingTitle ? h("span", { class: "sr-snip" }, `회의: ${r.meetingTitle}`) : r.ext ? h("span", { class: "sr-snip", text: label }) : null,
          srcTag(r)
        ])
      ]));
    }

    function itemsOn(day) {
      const ev = data.events.filter((e) => showEv(e) && e.startDate <= day && e.endDate >= day && matches(e));
      const tk = state.show.task ? data.tasks.filter((t) => t.dueDate === day && matches(t)) : [];
      return { ev, tk, n: ev.length + tk.length };
    }

    function monthGrid() {
      const { start, end } = monthRange(state.month);
      const t = today();
      const m = state.month.getMonth();
      const grid = h("div", { class: "cal-grid", role: "grid" });
      grid.append(h("div", { class: "cal-row cal-row--head", role: "row" }, WEEKDAYS.map((w, i) => h("div", { class: "cal-wd" + (i === 0 ? " is-sun" : i === 6 ? " is-sat" : ""), role: "columnheader", text: w }))));
      let row;
      for (let d = start, i = 0; d <= end; d = addDays(d, 1), i++) {
        if (i % 7 === 0) { row = h("div", { class: "cal-row", role: "row" }); grid.append(row); }
        const day = ymd(d);
        const { ev, tk, n } = itemsOn(day);
        const chips = [
          ...ev.map((e) => h("button", { class: `chip c${evColor(e)}` + (e.startDate !== e.endDate ? " chip--span" : "") + (e.ext ? " is-ext" : ""), type: "button", "data-peek": evKey(e), title: `${e.title} · ${whenLabel(e)}${e.ext ? ` · ${e.calendarName}` : ""}`, onclick: (x) => { x.stopPropagation(); openEv(e); } },
            [h("i", { class: "chip__dot" }), srcTag(e, true), h("span", { text: (e.startTime && e.startDate === day ? e.startTime + " " : "") + e.title })])),
          ...tk.map((x) => h("button", { class: `chip chip--task c${KIND.task.color}` + (x.status === "done" ? " is-done" : ""), type: "button", "data-peek": `task:${x.id}`, title: `할 일 · ${x.title}`, onclick: (y) => { y.stopPropagation(); openPeek("task", x.id); } },
            [h("i", { class: "chip__box" }), h("span", { text: x.title })]))
        ];
        const cell = h("div", {
          class: "cal-day" + (d.getMonth() !== m ? " is-out" : "") + (day === t ? " is-today" : "") + (d.getDay() === 0 ? " is-sun" : d.getDay() === 6 ? " is-sat" : ""),
          role: "gridcell", tabindex: "0", "data-peek": `day:${day}`, "aria-label": `${dateLabel(day)}${n ? `, ${n}개` : ""}`
        }, [
          h("span", { class: "cal-num", text: d.getDate() }),
          h("div", { class: "cal-chips" }, [...chips.slice(0, MAX_CHIPS), chips.length > MAX_CHIPS ? h("span", { class: "cal-more", text: `+${chips.length - MAX_CHIPS}개 더보기` }) : null]),
          h("div", { class: "cal-dots", "aria-hidden": "true" }, [...ev.slice(0, 3).map((e) => h("i", { class: `c${evColor(e)}` })), ...tk.slice(0, 2).map(() => h("i", { class: `c${KIND.task.color}` }))])
        ]);
        cell.addEventListener("click", () => openPeek("day", day));
        cell.addEventListener("dblclick", () => editEvent(null, { kind: "meeting", date: day }));
        cell.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPeek("day", day); } });
        row.append(cell);
      }
      return grid;
    }

    function monthList() {
      const { start, end } = monthRange(state.month);
      const out = [];
      for (let d = new Date(state.month); d.getMonth() === state.month.getMonth(); d = addDays(d, 1)) {
        const day = ymd(d);
        const { ev, tk, n } = itemsOn(day);
        if (!n) continue;
        out.push(h("div", { class: "mlist-day" + (day === today() ? " is-today" : "") }, [
          h("button", { class: "mlist-day__date", type: "button", "data-peek": `day:${day}`, onclick: () => openPeek("day", day) }, [h("strong", { text: parseYmd(day).getDate() }), h("span", { text: WEEKDAYS[parseYmd(day).getDay()] })]),
          h("ul", { class: "mlist-day__items" }, [...ev.map((e) => meetingRow(e)), ...tk.map((x) => taskRow(x, {}))])
        ]));
      }
      void start; void end;
      return out.length ? h("div", { class: "mlist" }, out) : h("p", { class: "empty", text: "이번 달에는 아직 아무것도 없어요." });
    }

    // 회의 전체 일정: 지난 회의 / 오늘 / 내일 / 앞으로
    function drawMeetingList() {
      const me = state.user.id;
      const month = state.month.getMonth();
      const all = data.events.filter((e) => e.kind === "meeting" && (parseYmd(e.startDate).getMonth() === month || parseYmd(e.endDate).getMonth() === month) && matches(e));
      // 내가 만든 회의 = 직접 만들었거나 '우리 소속으로 넣기'로 넣은 회의 (참석자가 아니어도), 참석하는 회의 = 참석자 명단에 내가 있는 회의
      const sets = { all, mine: all.filter((e) => e.createdBy === me), joined: all.filter((e) => e.attendeeIds.includes(me)) };
      const list = sets[listTab] || all;
      const t = today(), tm = shiftYmd(t, 1);
      const groups = [
        ["지난 회의", list.filter((e) => e.endDate < t)],
        ["오늘", list.filter((e) => e.startDate <= t && e.endDate >= t)],
        ["내일", list.filter((e) => e.startDate <= tm && e.endDate >= tm && !(e.startDate <= t && e.endDate >= t))],
        ["앞으로", list.filter((e) => e.startDate > tm)]
      ].filter(([, l]) => l.length);
      const openKey = "ps.pastOpen";
      const pastOpen = store.get(openKey, "0") === "1";
      listCard.replaceChildren(
        h("div", { class: "card__head" }, [
          h("h2", { class: "card__title" }, ["회의 전체 일정 ", h("span", { class: "count count--lg", text: String(all.length) })]),
          h("button", { class: "btn btn--ghost btn--sm", type: "button", onclick: () => editEvent(null, { kind: "meeting", date: t }) }, [icon("plus"), "회의 추가"])
        ]),
        h("div", { class: "tabs-line", role: "tablist" }, [["all", "전체", "이번 달 보이는 회의 전부 (같은 WYD 원본은 한 번만 셈)"], ["mine", "내가 만든 회의", "내가 직접 만들었거나 '우리 소속으로 넣기'로 넣은 회의 — 참석자가 아니어도 여기에 나와요"], ["joined", "참석하는 회의", "참석자 명단에 내 이름이 있는 회의"]].map(([k, label, tip]) => h("button", { type: "button", role: "tab", title: tip, "aria-selected": String(k === listTab), onclick: () => { listTab = k; store.set("ps.listTab", k); drawMeetingList(); markPeeked(); } }, [label, h("span", { class: "count", text: String(sets[k].length) })]))),
        h("p", { class: "muted small mlist-hint", text: { all: "이번 달 보이는 회의 전부예요. 같은 WYD 일정을 여러 팀이 넣었으면 한 번만 세요.", mine: "내가 직접 만들었거나 '우리 소속으로 넣기'로 넣은 회의예요. 참석자 명단에 없어도 여기에 나와요.", joined: "참석자 명단에 내 이름이 있는 회의예요. 참석자는 회의 패널의 '참석자 → 편집'에서 바꿔요." }[listTab] || "" }),
        groups.length ? h("div", { class: "mgroups" }, groups.map(([label, l]) => {
          const past = label === "지난 회의";
          const box = h("div", { class: "mgroup" + (past && !pastOpen ? " is-folded" : "") }, [
            h("button", { class: "mgroup__head", type: "button", "aria-expanded": String(!past || pastOpen), onclick: (ev) => {
              if (!past) return;
              const open = box.classList.toggle("is-folded") === false;
              ev.currentTarget.setAttribute("aria-expanded", String(open));
              store.set(openKey, open ? "1" : "0");
            } }, [h("span", { text: label }), h("span", { class: "count", text: String(l.length) }), past ? icon("right", "mgroup__chev") : null]),
            h("ul", { class: "mrows" }, l.map((e) => meetingRow(e, label === "오늘" || label === "내일")))
          ]);
          return box;
        })) : h("p", { class: "empty", text: state.search ? "찾는 회의가 없어요." : "이번 달 회의가 없어요." })
      );
    }

    page = { name: pageName, reload: load };
    draw();
    // 다른 화면에 갔다 오거나 분류를 바꿔 화면을 다시 그려도 검색어가 남아 있으면 다시 찾음 ('찾는 중…' 에 멈추지 않게)
    if (state.search.trim()) quiet(runSearchNow());
    try { await load(); } catch (e) { if (e.status !== 401) bodyBox.replaceChildren(failed(e)); }
  }

  function meetingRow(e, hideDate) {
    const st = e.kind === "meeting" ? meetingState(e) : null;
    return h("li", {}, h("button", { class: "mrow", type: "button", "data-peek": evKey(e), onclick: () => openEv(e) }, [
      h("span", { class: "mrow__time" }, [hideDate ? null : h("small", { text: relDay(e.startDate) || shortDate(e.startDate) }), timeRange(e)]),
      evDot(e),
      h("span", { class: "mrow__title" }, [h("strong", { text: e.title }), e.ext ? h("span", { class: "ext-badge", text: e.calendarName }) : null, srcTag(e),
        (e.alsoIn || []).length ? h("span", { class: "ext-badge", title: `같은 WYD 일정이 ${e.alsoIn.map((x) => teamName(x.unitId)).join(", ")}에도 있어요`, text: `+${e.alsoIn.map((x) => teamName(x.unitId)).join(", ")}` }) : null, catChip(e.categoryId), ...tagChips(e.tagIds).slice(0, 2),
        e.openTasks ? h("span", { class: "mini-badge" }, [icon("check"), `할 일 ${e.openTasks}`]) : null,
        e.importantMemos ? h("span", { class: "mini-badge mini-badge--star" }, [icon("star"), String(e.importantMemos)]) : null]),
      h("span", { class: "mrow__people" }, [h("span", { class: "avatars" }, (e.attendeeIds.length ? e.attendeeIds : e.createdBy ? [e.createdBy] : []).slice(0, 3).map((id) => avatar(id, "sm"))), e.attendeeIds.length > 3 ? h("small", { text: `+${e.attendeeIds.length - 3}` }) : null, (e.guestNames || []).length ? h("small", { class: "muted", title: e.guestNames.join(", "), text: `외부 ${e.guestNames.length}` }) : null]),
      st ? h("span", { class: `status status--${st}`, text: MEETING_STATE[st] }) : h("span")
    ]));
  }

  /* ---------- 할 일 목록 ---------- */
  const taskFilter = { status: store.get("ps.taskStatus", "open"), who: store.get("ps.taskWho", "all"), day: "all", tag: null, q: "" };
  async function pageTasks() {
    document.title = `할 일 · ${TITLE}`;
    drawMini(null);
    const box = h("div", { class: "card tasks-card" }, loading());
    const filters = h("div", { class: "filters" });
    setMain("tasks", [h("div", { class: "page-head" }, [h("h1", { text: "할 일" }), h("button", { class: "btn btn--primary", type: "button", onclick: () => quickAdd("task") }, [icon("plus"), "할 일 추가"])]), filters, box]);
    let all = [];
    function drawFilters() {
      const seg = (key, opts, storeKey) => h("div", { class: "seg seg--sm" }, opts.map(([k, label]) => h("button", { type: "button", "aria-selected": String(taskFilter[key] === k), text: label, onclick: () => { taskFilter[key] = k; if (storeKey) store.set(storeKey, k); drawFilters(); drawList(); } })));
      const tagSel = h("select", { "aria-label": "태그" }, [h("option", { value: "", text: "모든 태그" }), ...state.tags.map((t) => h("option", { value: String(t.id), text: t.name }))]);
      tagSel.value = taskFilter.tag ? String(taskFilter.tag) : "";
      tagSel.addEventListener("change", () => { taskFilter.tag = tagSel.value ? Number(tagSel.value) : null; drawList(); });
      const search = h("label", { class: "search" }, [icon("search"), h("input", { type: "search", value: taskFilter.q, placeholder: "할 일 검색", "aria-label": "검색", oninput: (e) => { taskFilter.q = e.target.value; drawList(); } })]);
      fill(filters, seg("status", [["open", "미완료"], ["done", "완료"], ["all", "전체"]], "ps.taskStatus"), ourToggle(() => { drawFilters(); quiet(load()); }), seg("who", [["all", "모두"], ["me", "내 담당"]], "ps.taskWho"), seg("day", [["all", "모든 날짜"], ["-1", "어제"], ["0", "오늘"], ["1", "내일"]]), tagSel, search);
    }
    function drawList() {
      const f = taskFilter;
      const list = all.filter((t) => (f.status === "all" || (f.status === "done" ? t.status === "done" : t.status !== "done"))
        && (f.who === "all" || t.assigneeId === state.user.id) && (!f.tag || t.tagIds.includes(f.tag)) && (!f.q || t.title.includes(f.q)));
      const t = today(), tm = shiftYmd(t, 1), week = shiftYmd(t, 7);
      // 날짜로 보기: 시작일~마감일 기간에 그 날이 들어가는 할 일
      const dayKey = f.day === "all" ? null : shiftYmd(t, Number(f.day));
      const onDay = (x) => x.dueDate && (x.startDate || x.dueDate) <= dayKey && x.dueDate >= dayKey;
      const groups = dayKey ? [[{ "-1": "어제", 0: "오늘", 1: "내일" }[f.day], list.filter(onDay)]] : f.status === "done" ? [["완료", list]] : [
        ["마감 지남", list.filter((x) => x.dueDate && x.dueDate < t && x.status !== "done")],
        ["오늘", list.filter((x) => x.dueDate === t)],
        ["내일", list.filter((x) => x.dueDate === tm)],
        ["이번 주", list.filter((x) => x.dueDate > tm && x.dueDate <= week)],
        ["나중에", list.filter((x) => x.dueDate > week)],
        ["마감일 없음", list.filter((x) => !x.dueDate)],
        ["지난 완료", list.filter((x) => x.dueDate && x.dueDate < t && x.status === "done")]
      ];
      const shown = groups.filter(([, l]) => l.length);
      box.replaceChildren(...(shown.length ? shown.map(([label, l]) => h("div", { class: "tgroup" }, [
        h("div", { class: "tgroup__head" }, [h("span", { text: label }), h("span", { class: "count", text: String(l.length) })]),
        h("ul", { class: "tasks tasks--table" }, l.map((x) => taskRow(x, { assignee: true })))
      ])) : [h("p", { class: "empty", text: "조건에 맞는 할 일이 없어요." })]));
      markPeeked();
    }
    async function load() { const ours = ourFilter(); all = (await api("/tasks")).tasks.filter(catFilter()).filter(ours); drawList(); }
    page = { name: "tasks", reload: load };
    drawFilters();
    try { await load(); } catch (e) { if (e.status !== 401) box.replaceChildren(failed(e)); }
  }

  /* ---------- 회의 목록 ---------- */
  async function pageMeetings() {
    document.title = `회의 · ${TITLE}`;
    drawMini(null);
    const box = h("div", { class: "card mlist-card" }, loading());
    let qv = "";
    const search = h("label", { class: "search" }, [icon("search"), h("input", { type: "search", placeholder: "회의 검색", "aria-label": "회의 검색", oninput: (e) => { qv = e.target.value; draw(); } })]);
    setMain("meetings", [h("div", { class: "page-head" }, [h("h1", { text: "회의" }), h("button", { class: "btn btn--primary", type: "button", onclick: () => editEvent(null, { kind: "meeting" }) }, [icon("plus"), "회의 추가"])]), h("div", { class: "filters" }, [ourToggle(() => render()), search]), box]);
    let all = [];
    function draw() {
      const list = all.filter((e) => e.kind === "meeting" && (!qv || e.title.includes(qv)));
      const t = today();
      const upcoming = list.filter((e) => e.endDate >= t);
      const past = list.filter((e) => e.endDate < t).reverse();
      const byMonth = (l) => {
        const m = new Map();
        for (const e of l) { const k = e.startDate.slice(0, 7); if (!m.has(k)) m.set(k, []); m.get(k).push(e); }
        return [...m.entries()];
      };
      fill(box, ...(list.length ? [
        upcoming.length ? h("div", { class: "mgroup" }, [h("div", { class: "mgroup__head" }, [h("span", { text: "다가오는 회의" }), h("span", { class: "count", text: String(upcoming.length) })]), h("ul", { class: "mrows" }, upcoming.map((e) => meetingRow(e)))]) : null,
        ...byMonth(past).map(([k, l]) => h("div", { class: "mgroup" }, [h("div", { class: "mgroup__head" }, [h("span", { text: `${Number(k.slice(0, 4))}년 ${Number(k.slice(5))}월 지난 회의` }), h("span", { class: "count", text: String(l.length) })]), h("ul", { class: "mrows" }, l.map((e) => meetingRow(e)))]))
      ] : [h("p", { class: "empty", text: qv ? "찾는 회의가 없어요." : "아직 회의가 없어요." })]));
      markPeeked();
    }
    async function load() {
      const t = today();
      all = (await api(`/events?from=${shiftYmd(t, -180)}&to=${shiftYmd(t, 180)}`)).events.filter(catFilter()).filter(ourFilter());
      draw();
    }
    page = { name: "meetings", reload: load };
    try { await load(); } catch (e) { if (e.status !== 401) box.replaceChildren(failed(e)); }
  }

  /* ---------- 메모 목록 ---------- */
  async function pageMemos() {
    document.title = `메모 · ${TITLE}`;
    drawMini(null);
    let importantOnly = store.get("ps.memoImp", "0") === "1";
    const box = h("div", { class: "memo-days" }, loading());
    const filters = h("div", { class: "filters" });
    const drawFilters = () => filters.replaceChildren(h("div", { class: "seg seg--sm" }, [["0", "전체"], ["1", "중요만"]].map(([k, label]) => h("button", { type: "button", "aria-selected": String((importantOnly ? "1" : "0") === k), text: label, onclick: () => { importantOnly = k === "1"; store.set("ps.memoImp", k); drawFilters(); quiet(load()); } }))));
    setMain("memos", [h("div", { class: "page-head" }, [h("h1", { text: "메모" })]), h("div", { class: "card memo-compose" }, [h("h2", { class: "card__title", text: "빠른 메모" }), quickMemo(today())]), filters, box]);
    drawFilters();
    async function load() {
      const r = await api(`/memos${importantOnly ? "?important=1" : ""}`);
      const days = new Map();
      for (const m of r.memos.filter(catFilter())) { if (!days.has(m.date)) days.set(m.date, []); days.get(m.date).push(m); }
      box.replaceChildren(...(days.size ? [...days.entries()].map(([d, l]) => h("section", { class: "card memo-day" }, [
        h("a", { class: "memo-day__date", href: `#/today/${d}` }, [h("strong", { text: dateLabel(d) }), relDay(d) ? h("span", { class: "muted", text: relDay(d) }) : null]),
        memoRows(l)
      ])) : [h("div", { class: "card empty", text: importantOnly ? "중요 표시한 메모가 없어요." : "아직 메모가 없어요." })]));
    }
    page = { name: "memos", reload: load };
    try { await load(); } catch (e) { if (e.status !== 401) box.replaceChildren(failed(e)); }
  }

  /* ---------- 공지 ---------- */
  async function pageNotices() {
    document.title = `공지 · ${TITLE}`;
    drawMini(null);
    setMain("notices", loading());
    const isAdmin = state.user.role === "admin";
    async function load() {
      const r = await api("/notices");
      setUnreadNotices(r.unreadNotices);
      setMain("notices", h("div", { class: "narrow stack" }, [
        h("div", { class: "page-head" }, [h("h1", { text: "공지" }), isAdmin ? h("button", { class: "btn btn--admin", type: "button", title: "관리자 전용", onclick: () => editNotice(null) }, [icon("lock"), "공지 쓰기"]) : null]),
        r.notices.length ? h("ul", { class: "notice-list" }, r.notices.map((n) => h("li", {}, h("a", { class: "card notice-item" + (n.pinned ? " is-pinned" : ""), href: `#/notices/${n.id}` }, [
          h("div", { class: "notice-item__title" }, [n.pinned ? icon("pin", "pin") : null, h("strong", { text: n.title }), n.unread ? h("span", { class: "new-badge", text: "새 글" }) : null]),
          h("p", { class: "notice-item__preview", text: n.preview }),
          h("div", { class: "notice-item__meta muted" }, [h("span", { text: n.author || "관리자" }), h("span", { text: ago(n.createdAt) }), n.comments ? h("span", { class: "with-icon" }, [icon("chat"), String(n.comments)]) : null])
        ])))) : h("div", { class: "card empty", text: isAdmin ? "아직 공지가 없어요. 첫 공지를 써 보세요." : "아직 공지가 없어요." })
      ]));
    }
    page = { name: "notices", reload: load };
    try { await load(); } catch (e) { if (e.status !== 401) setMain("notices", failed(e)); }
  }

  async function pageNotice(id) {
    drawMini(null);
    setMain("notices", loading());
    async function load() {
      const r = await api(`/notices/${id}`);
      setUnreadNotices(r.unreadNotices); // 열어 보면 숫자가 줄어듦
      const n = r.notice;
      document.title = `${n.title} · ${TITLE}`;
      setMain("notices", h("div", { class: "narrow stack" }, [
        h("a", { class: "back-link", href: "#/notices" }, [icon("left"), "공지 목록"]),
        h("article", { class: "card notice-view stack" }, [
          h("h1", {}, [n.pinned ? icon("pin", "pin") : null, n.title]),
          h("div", { class: "muted notice-item__meta" }, [h("span", { text: n.author || "관리자" }), h("span", { text: ago(n.createdAt) }), n.updatedAt !== n.createdAt ? h("span", { text: "수정됨" }) : null]),
          h("div", { class: "prose", text: n.body }),
          n.canEdit ? h("div", { class: "actions actions--start" }, [
            h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "수정", onclick: () => editNotice(n) }),
            h("button", { class: "btn btn--ghost btn--sm btn--danger-text", type: "button", text: "삭제", onclick: () => confirmDialog("공지 삭제", `'${n.title}' 공지를 지울까요? 댓글도 함께 지워져요.`, "삭제", async () => {
              await api(`/notices/${n.id}`, { method: "DELETE" });
              closeDialog(); toast("공지를 지웠어요."); go("#/notices");
            }) })
          ]) : null
        ]),
        h("div", { class: "card card--pad" }, commentsBox("notice", n.id, r.comments))
      ]));
    }
    page = { name: "notice", reload: async () => {} };
    try { await load(); } catch (e) {
      if (e.status !== 401) setMain("notices", h("div", { class: "narrow stack" }, [h("a", { class: "back-link", href: "#/notices", text: "← 공지 목록" }), failed(e)]));
    }
  }

  function editNotice(n) {
    const isNew = !n;
    const err = errorLine();
    const title = h("input", { value: n ? n.title : "", maxlength: "80", autofocus: true });
    const body = h("textarea", { rows: "10", maxlength: "5000" });
    body.value = n ? n.body : "";
    const pinned = h("input", { type: "checkbox", checked: n ? n.pinned : false });
    const submit = h("button", { class: "btn btn--primary", type: "submit", text: isNew ? "올리기" : "저장" });
    const form = h("form", { class: "stack", novalidate: true }, [
      field("제목", title), field("내용", body),
      h("label", { class: "check" }, [pinned, h("span", { text: "목록 맨 위에 고정" })]),
      err,
      h("div", { class: "actions" }, [h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), submit])
    ]);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      busy(submit, async () => {
        try {
          const payload = { title: title.value, body: body.value, pinned: pinned.checked };
          const r = await api(isNew ? "/notices" : `/notices/${n.id}`, { method: isNew ? "POST" : "PUT", body: payload });
          closeDialog();
          toast(isNew ? "공지를 올렸어요." : "공지를 고쳤어요.");
          go(`#/notices/${isNew ? r.id : n.id}`);
        } catch (ex) { showError(err, ex.message); }
      });
    });
    openDialog(isNew ? "공지 쓰기" : "공지 수정", form, { wide: true, admin: true });
  }

  /* ---------- 멤버 · 소속 지정 (관리자) ---------- */
  const memberFilter = { kind: "all", unit: null };
  async function pageMembers() {
    if (!isAdmin()) return go("#/today");
    document.title = `멤버 · ${TITLE}`;
    drawMini(null);
    setMain("members", loading());
    const picked = new Set();
    async function load() {
      const r = await api("/admin/users");
      const users = r.users;
      for (const id of [...picked]) if (!users.some((u) => u.id === id)) picked.delete(id);
      const body = h("div", { class: "stack" });
      const counts = { all: users.length, none: users.filter((u) => !u.unitId && u.role !== "volunteer").length, admin: users.filter((u) => u.role === "admin").length, volunteer: users.filter((u) => u.role === "volunteer").length };
      const filterUnits = memberFilter.unit && unitOf(memberFilter.unit) ? unitSubtree(memberFilter.unit) : null;
      const shown = users.filter((u) => (memberFilter.kind === "all" || (memberFilter.kind === "none" ? !u.unitId && u.role !== "volunteer" : u.role === memberFilter.kind)) && (!filterUnits || filterUnits.has(u.unitId)));

      const notice = store.get("ps.unitNotice", "") === "1" ? null : h("div", { class: "infobar", role: "status" }, [
        h("strong", { text: "'직책' 칸이 '소속'으로 바뀌었어요." }),
        h("span", { text: "예전에 적은 직책은 '메모'로 남겨 두었어요 (이름 아래 작게 보여요). 소속은 조직도에서 골라 주세요." }),
        h("a", { href: "#/org", text: "조직도 열기 →" }),
        h("button", { class: "icon-btn icon-btn--xs", type: "button", "aria-label": "안내 닫기", html: ICON.close, onclick: () => { store.set("ps.unitNotice", "1"); load(); } })
      ]);
      const seg = h("div", { class: "seg seg--sm" }, [["all", "전체"], ["none", "소속 미지정"], ["admin", "관리자"], ["volunteer", "봉사자"]].map(([k, label]) => h("button", {
        type: "button", "aria-selected": String(memberFilter.kind === k), class: k === "none" && counts.none ? "seg__warn" : null,
        onclick: () => { memberFilter.kind = k; load(); }
      }, `${label} ${counts[k]}`)));
      const unitSel = h("button", { class: "select-btn select-btn--sm", type: "button" }, memberFilter.unit && unitOf(memberFilter.unit) ? unitLabel(memberFilter.unit) : h("span", { class: "muted", text: "모든 소속" }));
      unitSel.addEventListener("click", () => unitPicker(unitSel, memberFilter.unit, (id) => { memberFilter.unit = id; load(); }, { noneLabel: "모든 소속" }));
      const bulk = picked.size ? h("div", { class: "bulkbar" }, [
        h("strong", { text: `${picked.size}명 선택` }),
        h("button", { class: "btn btn--admin btn--sm", type: "button", text: "소속 바꾸기", onclick: (ev) => unitPicker(ev.currentTarget, null, async (id) => {
          const res = await act(() => api("/admin/users/unit", { method: "POST", body: { userIds: [...picked], unitId: id } }), id ? `${picked.size}명의 소속을 '${unitShort(id)}'(으)로 바꿨어요.` : `${picked.size}명의 소속을 뺐어요.`);
          state.team = res.team; picked.clear(); drawNavAll(); load();
        }, { noneLabel: "소속 빼기" }) }),
        h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "선택 해제", onclick: () => { picked.clear(); load(); } })
      ]) : h("span", { class: "muted small", text: "여러 명을 골라 한 번에 소속을 바꿀 수 있어요" });

      const all = h("input", { type: "checkbox", "aria-label": "보이는 멤버 모두 고르기", checked: shown.some((u) => u.role !== "volunteer") && shown.every((u) => u.role === "volunteer" || picked.has(u.id)) });
      all.addEventListener("change", () => { shown.filter((u) => u.role !== "volunteer").forEach((u) => (all.checked ? picked.add(u.id) : picked.delete(u.id))); load(); });
      const rows = shown.map((u) => {
        const volunteer = u.role === "volunteer";
        const c = h("input", { type: "checkbox", "aria-label": `${u.name} 고르기`, checked: picked.has(u.id) });
        c.addEventListener("change", () => { c.checked ? picked.add(u.id) : picked.delete(u.id); load(); });
        const unitBtn = h("button", { class: "unit-btn" + (u.unitId ? "" : " unit-btn--empty"), type: "button", title: u.unitId ? unitLabel(u.unitId) : "소속을 골라 주세요" }, [h("span", { text: u.unitId ? unitLabel(u.unitId) : "소속 고르기" }), h("span", { class: "unit-btn__caret", "aria-hidden": "true", text: "▾" })]);
        unitBtn.addEventListener("click", () => unitPicker(unitBtn, u.unitId, async (id) => {
          await act(() => api(`/admin/users/${u.id}`, { method: "PATCH", body: { unitId: id } }));
          await reloadTeam(); drawNavAll(); load();
        }, { noneLabel: "소속 빼기" }));
        return h("tr", { class: picked.has(u.id) ? "is-picked" : null }, [
          h("td", {}, volunteer ? null : c), // 봉사자는 소속이 없어서 일괄 변경에서 뺌
          h("td", {}, h("span", { class: "person person--stack" }, [volunteer ? h("span", { class: "avatar avatar--sm c0", title: u.name, text: u.name.replace(/\s/g, "").slice(-2) }) : avatar(u.id, "sm"), h("span", {}, [h("strong", { text: u.name }), u.me ? h("span", { class: "badge", text: "나" }) : null, u.note ? h("small", { class: "muted person__note", text: u.note }) : null])])),
          h("td", {}, volunteer ? h("span", { class: "muted", text: "-" }) : [unitBtn, (u.viewUnits || []).length ? h("small", { class: "muted member-extra", title: "관리자가 추가로 지정한 볼 수 있는 조직", text: `+ 추가로 봄: ${viewGrantsText(u.viewUnits)}` }) : null]),
          h("td", { class: "mono", text: u.login }),
          h("td", {}, u.role === "admin" ? adminBadge("관리자") : h("span", { class: "badge", text: { director: "본부장", volunteer: "봉사자" }[u.role] || "멤버" })),
          h("td", { class: "muted" }, u.pwChanged ? "변경함" : h("span", { class: "warn", text: "임시 비밀번호" })),
          h("td", { class: "muted", text: u.lastLoginAt ? ago(u.lastLoginAt) : "아직 없음" }),
          h("td", { class: "td-actions" }, [
            h("button", { class: "link-btn", type: "button", text: "수정", onclick: () => editMember(u) }),
            h("button", { class: "link-btn", type: "button", text: "비밀번호 재발급", onclick: () => confirmDialog("임시 비밀번호 발급", `${u.name}님(${u.login})의 비밀번호를 새 임시 비밀번호로 바꿀까요? 지금 로그인된 기기는 로그아웃돼요.`, "발급", async () => {
              const p = await api(`/admin/users/${u.id}/reset-password`, { method: "POST" });
              showIssued("임시 비밀번호", p);
            }) }),
            u.me ? null : h("button", { class: "link-btn link-btn--danger", type: "button", text: "삭제", onclick: () => confirmDialog("멤버 삭제", `${u.name}님(${u.login}) 계정을 지울까요? 올린 일정·할 일·메모는 남고 작성자·담당자만 비워져요.`, "삭제", async () => {
              await api(`/admin/users/${u.id}`, { method: "DELETE" });
              closeDialog(); toast("계정을 지웠어요."); await reloadTeam(); load();
            }) })
          ])
        ]);
      });
      fill(body,
        h("div", { class: "page-head" }, [h("h1", {}, ["멤버 ", h("span", { class: "muted", text: String(users.length) })]), adminBadge(), h("button", { class: "btn btn--admin page-head__end", type: "button", onclick: addMember }, [icon("plus"), "계정 발급"])]),
        notice,
        h("div", { class: "filters" }, [seg, unitSel, h("span", { class: "filters__end" }, bulk)]),
        h("div", { class: "card table-wrap" }, h("table", { class: "table" }, [
          h("thead", {}, h("tr", {}, [h("th", { class: "th-check" }, all), ...["이름", "소속", "아이디", "권한", "비밀번호", "최근 로그인", ""].map((t) => h("th", { text: t }))])),
          h("tbody", {}, rows.length ? rows : h("tr", {}, h("td", { colspan: "8", class: "muted empty", text: "조건에 맞는 멤버가 없어요." })))
        ]))
      );
      setMain("members", body);
    }
    page = { name: "members", reload: load };
    try { await load(); } catch (e) { if (e.status !== 401) setMain("members", failed(e)); }
  }

  async function reloadTeam() {
    const me = await api("/me");
    state.user = me.user; state.team = me.team; state.units = me.units || []; state.tags = me.tags; state.categories = me.categories || []; state.calendars = me.calendars || [];
  }

  function showIssued(title, p) {
    const line = `아이디 ${p.login} / 비밀번호 ${p.password}`;
    const copy = h("button", { class: "btn btn--primary", type: "button", text: "복사" });
    copy.addEventListener("click", () => {
      const msg = `[${TITLE}] ${p.name}님 계정\n${line}\n처음 로그인하면 비밀번호를 바꿔 주세요.\n${location.origin}`;
      navigator.clipboard.writeText(msg).then(() => toast("복사했어요."), () => toast("복사하지 못했어요. 직접 적어 주세요."));
    });
    openDialog(title, h("div", { class: "stack" }, [
      h("p", { class: "muted", text: `${p.name}님에게 아래 내용을 전해 주세요. 이 창을 닫으면 다시 볼 수 없어요.` }),
      h("div", { class: "issued" }, [h("div", {}, [h("span", { text: "아이디" }), h("strong", { class: "mono", text: p.login })]), h("div", {}, [h("span", { text: "비밀번호" }), h("strong", { class: "mono", text: p.password })])]),
      h("div", { class: "actions" }, [h("button", { class: "btn btn--ghost", type: "button", text: "닫기", "data-close": true }), copy])
    ]), { admin: true });
    dialog.addEventListener("close", () => { if (route().name === "members" && page) quiet(page.reload()); }, { once: true });
  }

  // 폼 안의 소속 고르기 버튼
  function unitButton(selected, onChange, noneLabel) {
    const b = h("button", { class: "select-btn", type: "button" });
    const draw = () => b.replaceChildren(selected && unitOf(selected) ? h("span", { text: unitLabel(selected) }) : h("span", { class: "muted", text: noneLabel || "소속 고르기" }));
    b.addEventListener("click", () => unitPicker(b, selected, (id) => { selected = id; draw(); onChange(id); }, { noneLabel: "소속 없음" }));
    draw();
    return b;
  }

  function addMember() {
    const err = errorLine();
    const name = h("input", { maxlength: "20", autofocus: true, placeholder: "예: 김지현" });
    let unitId = memberFilter.unit && unitOf(memberFilter.unit) ? memberFilter.unit : null;
    const login = h("input", { maxlength: "20", autocapitalize: "none", spellcheck: "false", placeholder: "예: jihyun" });
    const role = h("select", {}, [h("option", { value: "member", text: "멤버" }), h("option", { value: "director", text: "본부장" }), h("option", { value: "admin", text: "관리자" }), h("option", { value: "volunteer", text: "봉사자" })]);
    const submit = h("button", { class: "btn btn--admin", type: "submit", text: "발급" });
    const form = h("form", { class: "stack", novalidate: true }, [
      h("div", { class: "row2" }, [field("이름", name), field("소속", unitButton(unitId, (id) => { unitId = id; }), "조직도에서 고르기 (나중에 정해도 돼요)")]),
      field("아이디", login, "영문 소문자·숫자·._- 3~20자"),
      field("권한", role, "봉사자는 봉사자 전용 화면만 보고 소속 없이 관리돼요. 관리자는 조직도·멤버·분류·캘린더·백업 관리와 공지 쓰기를 할 수 있어요. 본부장은 맡은 조직(소속·연결한 조직도 자리)과 그 아래 조직의 회의·할 일·메모·연락처를 봐요. 관리 기능은 없어요"),
      err,
      h("div", { class: "actions" }, [h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), submit])
    ]);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      busy(submit, async () => {
        try {
          const p = await api("/admin/users", { method: "POST", body: { name: name.value, unitId, login: login.value, role: role.value } });
          await reloadTeam();
          showIssued("계정을 만들었어요", p);
        } catch (ex) { showError(err, ex.message); (ex.field === "login" ? login : name).focus(); }
      });
    });
    openDialog("계정 발급", form, { admin: true });
  }

  function editMember(u) {
    const err = errorLine();
    const name = h("input", { value: u.name, maxlength: "20", autofocus: true });
    let unitId = u.unitId;
    // 추가로 볼 수 있는 조직 [{ unitId, sub }]
    let grants = (u.viewUnits || []).filter((g) => unitOf(g.unitId)).map((g) => ({ ...g }));
    const grantsBox = h("div", { class: "grants" });
    function drawGrants() {
      const add = h("button", { class: "link-btn", type: "button", text: "+ 조직 추가" });
      add.addEventListener("click", () => unitPicker(add, null, (id) => {
        if (id && !grants.some((g) => g.unitId === id)) { grants.push({ unitId: id, sub: true }); drawGrants(); }
      }, { noneLabel: null }));
      fill(grantsBox,
        grants.length ? h("ul", { class: "grant-list" }, grants.map((g) => h("li", {}, [
          h("span", { class: "grant-list__name", text: unitLabel(g.unitId) }),
          unitChildren(g.unitId).length ? h("label", { class: "check small" }, [h("input", { type: "checkbox", checked: g.sub, onchange: (e) => { g.sub = e.target.checked; } }), h("span", { text: "아래 팀 포함" })]) : null,
          h("button", { class: "icon-btn icon-btn--xs", type: "button", "aria-label": `${unitShort(g.unitId)} 빼기`, html: ICON.close, onclick: () => { grants = grants.filter((x) => x !== g); drawGrants(); } })
        ]))) : h("p", { class: "muted small", text: "없음 (소속 조직과 그 아래 팀만 봐요)" }),
        add);
    }
    drawGrants();
    const note = h("input", { value: u.note || "", maxlength: "200", placeholder: "예: 예전 직책, 연락 메모" });
    const role = h("select", {}, [h("option", { value: "member", text: "멤버" }), h("option", { value: "director", text: "본부장" }), h("option", { value: "admin", text: "관리자" }), h("option", { value: "volunteer", text: "봉사자" })]);
    role.value = u.role;
    const submit = h("button", { class: "btn btn--admin", type: "submit", text: "저장" });
    const form = h("form", { class: "stack", novalidate: true }, [
      h("div", { class: "row2" }, [field("이름", name), field("소속", unitButton(unitId, (id) => { unitId = id; }))]),
      // (field 는 <label> 이라 안에 체크 상자가 여럿이면 엉뚱한 것이 눌려서 div 로)
      h("div", { class: "field" }, [h("span", { class: "field__label", text: "추가로 볼 수 있는 조직" }), grantsBox, h("span", { class: "field__hint", text: "소속 말고도 이 조직의 회의·할 일·메모를 봐요. '아래 팀 포함'을 끄면 그 조직(부·본부 직속)만 봐요." })]),
      field("메모", note, "관리자만 보는 메모예요. 예전 '직책'은 여기로 옮겨 두었어요."),
      field("권한", role, "봉사자로 바꾸면 소속·추가로 볼 조직·조직도 자리 연결이 지워지고 봉사자 전용 화면만 봐요. 본부장은 맡은 조직(소속·연결한 조직도 자리)과 그 아래 조직의 회의·할 일·메모·연락처를 봐요. 관리 기능은 없어요"), err,
      h("div", { class: "actions" }, [h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), submit])
    ]);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      busy(submit, async () => {
        try {
          await api(`/admin/users/${u.id}`, { method: "PATCH", body: { name: name.value, unitId, note: note.value, role: role.value, viewUnits: grants } });
          closeDialog(); toast("저장했어요.");
          await reloadTeam();
          if (isAdmin()) { buildLayout(); render(); } else go("#/today");
        } catch (ex) { showError(err, ex.message); }
      });
    });
    openDialog(`${u.login} 수정`, form, { admin: true });
  }

  /* ---------- 조직도 공통 ---------- */
  // 자리(직함·이름)는 PSchedule 계정과 따로. 이름이 비면 공석, userId 로 계정 연결
  async function loadOrg() {
    const r = await api("/org");
    state.units = r.units; state.positions = r.positions; state.orgBaseDate = r.baseDate;
    return r;
  }
  const setOrg = (r) => { if (r.units) state.units = r.units; if (r.positions) state.positions = r.positions; if (r.baseDate !== undefined) state.orgBaseDate = r.baseDate; if (r.team) state.team = r.team; };
  const posIn = (ids) => state.positions.filter((p) => ids.has(p.unitId));
  // 같은 사람인지: 연결한 계정 → 동명이인 구분(person) → 이름 순서로
  const personKey = (p) => (p.userId ? "u" + p.userId : "n" + (p.person || p.name));
  const isNamesake = (p) => (p.person || "").includes("#");
  // 인원: 공석 빼고, 한 조직 안에서는 같은 사람(겸직)을 한 번만
  function headCount(unitId) {
    return new Set(posIn(unitSubtree(unitId)).filter((p) => p.name).map(personKey)).size;
  }
  const unitDepthOf = (id) => unitPath(id).length; // 1 위원회, 2 본부, 3 부, 4 분과·팀, 5 팀
  // 엑셀식 위치: 본부 / 부 / 팀(맨 끝)
  function placeOf(unitId) {
    const path = unitPath(unitId);
    return { hq: path[1] ? path[1].name : "", dept: path[2] ? path[2].name : "", team: path.length > 3 ? path[path.length - 1].name : "", mid: path.length > 4 ? path.slice(3, -1).map((u) => u.name).join(" › ") : "" };
  }
  function orgRowsOrdered() { return state.positions.slice().sort((a, b) => a.sort - b.sort || a.id - b.id); }

  /* ---------- 조직도 보기 (모두) ---------- */
  const chart = { hq: "all", names: store.get("ps.chartNames", "1") === "1", zoom: Number(store.get("ps.chartZoom", "1")) || 1, q: "" };
  async function pageOrgChart() {
    document.title = `조직도 · ${TITLE}`;
    drawMini(null);
    setMain("orgchart", loading());
    try { await loadOrg(); } catch (e) { if (e.status !== 401) setMain("orgchart", failed(e)); return; }
    const root = unitChildren(null)[0];
    const head = h("div", { class: "page-head page-head--wrap" });
    const tools = h("div", { class: "filters" });
    const inner = h("div", { class: "oc", style: `zoom:${chart.zoom}` });
    const wrap = h("div", { class: "card oc-wrap" }, inner);
    setMain("orgchart", [head, tools, wrap, h("p", { class: "muted small", text: "사람 이름을 누르면 그 사람이 참석하는 회의·맡은 할 일이 측면 패널에 열려요. 부서 이름을 누르면 그 소속 화면으로 가요. 파란 칸은 '나'예요." })]);
    if (!root) {
      fill(head, h("h1", { text: "조직도" }));
      fill(wrap, h("p", { class: "muted empty", text: isAdmin() ? "아직 조직도가 없어요. 관리자 메뉴의 '조직도 편집'에서 엑셀을 불러와 주세요." : "아직 조직도가 없어요." }));
      page = { name: "orgchart", reload: async () => {} };
      return;
    }
    const total = headCount(root.id);
    fill(head,
      h("h1", { text: "조직도" }),
      h("span", { class: "muted small", text: `${root.name}${state.orgBaseDate ? ` · 기준일 ${state.orgBaseDate.replace(/-/g, ".")}` : ""} · ${total}명 (공석 제외)` }),
      isAdmin() ? h("a", { class: "btn btn--admin page-head__end", href: "#/org" }, [icon("lock"), "표로 편집"]) : null
    );
    const hqs = unitChildren(root.id);
    let hits = [], hit = 0;
    const setZoom = (z) => { chart.zoom = Math.max(0.3, Math.min(1.6, Math.round(z * 100) / 100)); inner.style.zoom = chart.zoom; store.set("ps.chartZoom", String(chart.zoom)); zoomLabel.textContent = Math.round(chart.zoom * 100) + "%"; };
    const zoomLabel = h("span", { class: "oc-zoom", text: Math.round(chart.zoom * 100) + "%" });
    const search = h("input", { type: "search", value: chart.q, placeholder: "이름·부서 찾기 (찾으면 그 칸으로 이동)", "aria-label": "이름·부서 찾기" });
    const hitInfo = h("span", { class: "muted small" });
    function find(next) {
      inner.querySelectorAll(".is-hit").forEach((el) => el.classList.remove("is-hit"));
      const qv = search.value.trim();
      chart.q = qv;
      hits = qv ? [...inner.querySelectorAll("[data-find]")].filter((el) => el.dataset.find.includes(qv)) : [];
      if (!hits.length) { hitInfo.textContent = qv ? "찾는 사람·부서가 없어요" : ""; return; }
      hit = next ? (hit + 1) % hits.length : 0;
      hits.forEach((el) => el.classList.add("is-hit"));
      hits[hit].classList.add("is-hit--now");
      inner.querySelectorAll(".is-hit--now").forEach((el) => el !== hits[hit] && el.classList.remove("is-hit--now"));
      hits[hit].scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
      hitInfo.textContent = `${hit + 1} / ${hits.length}`;
    }
    search.addEventListener("input", () => find(false));
    search.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); find(true); } });
    fill(tools,
      h("div", { class: "seg seg--sm" }, [["all", "전체"], ...hqs.map((u) => [u.id, u.name])].map(([k, label]) => h("button", { type: "button", "aria-selected": String(chart.hq === k), text: label, onclick: () => { chart.hq = k; draw(); drawTools(); } }))),
      h("div", { class: "seg seg--sm" }, [[true, "이름까지"], [false, "부서·인원만"]].map(([k, label]) => h("button", { type: "button", "aria-selected": String(chart.names === k), text: label, onclick: () => { chart.names = k; store.set("ps.chartNames", k ? "1" : "0"); draw(); drawTools(); } }))),
      h("label", { class: "search" }, [icon("search"), search]), hitInfo,
      h("span", { class: "filters__end oc-zoombar" }, [
        h("button", { class: "icon-btn", type: "button", "aria-label": "축소", text: "−", onclick: () => setZoom(chart.zoom - 0.1) }),
        zoomLabel,
        h("button", { class: "icon-btn", type: "button", "aria-label": "확대", text: "+", onclick: () => setZoom(chart.zoom + 0.1) }),
        h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "화면에 맞추기", onclick: () => { inner.style.zoom = 1; setZoom(Math.min(1, (wrap.clientWidth - 40) / inner.scrollWidth)); } })
      ])
    );
    const drawTools = () => tools.querySelectorAll(".seg").forEach((seg, i) => seg.querySelectorAll("button").forEach((b, j) => {
      const val = i === 0 ? (j === 0 ? "all" : hqs[j - 1].id) : j === 0;
      b.setAttribute("aria-selected", String((i === 0 ? chart.hq : chart.names) === val));
    }));

    const me = state.user.id;
    const personRow = (p) => h("button", {
      class: "oc-person" + (!p.name ? " is-vacant" : "") + (p.userId === me ? " is-me" : ""), type: "button", "data-find": `${p.name} ${p.title}`,
      onclick: () => openPeek("pos", p.id), title: p.note || null
    }, [h("span", { class: "oc-person__title", text: p.title }), h("span", { class: "oc-person__name", text: p.name ? p.name + (p.userId === me ? " (나)" : "") : "공석" })]);
    const own = (u) => state.positions.filter((p) => p.unitId === u.id).sort((a, b) => a.sort - b.sort);
    const unitLink = (u, cls, extra) => h("a", { class: cls, href: `#/unit/${u.id}`, "data-find": u.name }, [h("strong", { text: u.name }), ` (${headCount(u.id)})`, extra]);
    // 팀·분과 카드 (안쪽 조직은 점선 카드로)
    function teamCard(u, inside) {
      return h("div", { class: inside ? "oc-sub" : "oc-team" }, [
        h("a", { class: inside ? "oc-sub__head" : "oc-team__head", href: `#/unit/${u.id}`, "data-find": u.name }, [h("span", { text: (inside ? "↳ " : "") + u.name }), h("span", { text: String(headCount(u.id)) })]),
        chart.names || unitChildren(u.id).length ? h("div", { class: "oc-team__body" }, [...(chart.names ? own(u).map(personRow) : []), ...unitChildren(u.id).map((k) => teamCard(k, true))]) : null
      ]);
    }
    function draw() {
      const tops = own(root);
      const shown = chart.hq === "all" ? hqs : hqs.filter((u) => u.id === chart.hq);
      fill(inner,
        h("div", { class: "oc-top" }, tops.map((p) => h("div", { class: "oc-topwrap" }, [h("button", { class: "oc-box oc-box--d1" + (p.userId === me ? " is-me" : ""), type: "button", "data-find": `${p.name} ${p.title}`, onclick: () => openPeek("pos", p.id) }, `${p.title} ${p.name || "공석"}`), h("i", { class: "oc-vline" })]))),
        h("div", { class: "oc-hqs" + (shown.length > 1 ? " has-line" : "") }, shown.map((hq) => h("section", { class: "oc-hq", "aria-label": hq.name }, [
          h("div", { class: "oc-box oc-box--d2" }, [unitLink(hq, "oc-box__name"), ...own(hq).map((p) => h("button", { class: "oc-box__sub" + (p.userId === me ? " is-me" : ""), type: "button", "data-find": `${p.name} ${p.title}`, onclick: () => openPeek("pos", p.id) }, `${p.title} ${p.name || "공석"}`))]),
          h("div", { class: "oc-depts" }, unitChildren(hq.id).map((d) => h("div", { class: "oc-dept" }, [
            h("div", { class: "oc-box oc-box--d3" }, [unitLink(d, "oc-box__name"), ...(chart.names ? own(d).map((p) => h("button", { class: "oc-box__sub" + (!p.name ? " is-vacant" : "") + (p.userId === me ? " is-me" : ""), type: "button", "data-find": `${p.name} ${p.title}`, onclick: () => openPeek("pos", p.id) }, `${p.title} ${p.name || "공석"}`)) : [])]),
            ...unitChildren(d.id).map((t) => teamCard(t, false))
          ])))
        ])))
      );
      if (chart.q) find(false);
      markPeeked();
    }
    page = { name: "orgchart", reload: async () => { await loadOrg(); draw(); } };
    draw();
  }

  /* ----- 연락처: 볼 수 있는 사람만 서버가 보내 줌. 값은 화면 안에만 (state·검색·내보내기에 넣지 않음) ----- */
  const contactsFilter = { q: "", unit: "", cat: "" }; // cat: '' 전체, 'org' 조직도(내부), 'none' 미분류, 숫자 카테고리
  const telHref = (v) => "tel:" + v.replace(/내선.*/, "").replace(/[^0-9+]/g, "");
  function contactForm(v, onSave, saveClass, extra) {
    const input = (key, label, type, placeholder) => { const el = h("input", { type, value: v[key] || "", placeholder, autocomplete: "off", maxlength: key === "email" ? "120" : "30" }); return { key, el, wrap: field(label, el) }; };
    const inputs = [input("mobile", "휴대전화", "tel", "010-0000-0000"), input("office", "사무실 전화", "tel", "02-000-0000"), input("email", "이메일", "email", "name@example.com")];
    const err = errorLine();
    const ok = h("button", { class: `btn ${saveClass}`, type: "submit", text: "저장" });
    const form = h("form", { class: "contact-form", novalidate: true }, [...(extra || []).map((x) => x.wrap), ...inputs.map((x) => x.wrap), h("div", { class: "contact-form__end" }, ok), err]);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      showError(err, "");
      busy(ok, async () => {
        try { await onSave(Object.fromEntries([...(extra || []), ...inputs].map((x) => [x.key, x.el.value]))); }
        catch (ex) { showError(err, ex.message); }
      });
    });
    return form;
  }
  async function pageContacts() {
    document.title = `연락처 · ${TITLE}`;
    drawMini(null);
    setMain("contacts", loading());
    let data;
    try { data = await api("/contacts"); } catch (e) { if (e.status !== 401) setMain("contacts", failed(e)); return; }
    const mineBox = h("div"), adminBox = h("div"), listBox = h("div");
    const count = h("span", { class: "muted small" });
    const put = (ref, body) => api(`/contacts/${ref}`, { method: "PUT", body });
    const saved = (r) => { data = r; toast("연락처를 저장했어요."); drawAll(); };
    const unitSel = h("select", { "aria-label": "소속으로 거르기", onchange: (e) => { contactsFilter.unit = e.target.value; drawList(); } });
    const search = h("label", { class: "search" }, [icon("search"), h("input", { type: "search", value: contactsFilter.q, placeholder: "이름·소속 찾기", "aria-label": "이름·소속 찾기", oninput: (e) => { contactsFilter.q = e.target.value; drawList(); } })]);
    const catName = (id) => data.categories.find((c) => c.id === id)?.name || "미분류";
    const catSel = h("select", { "aria-label": "카테고리로 거르기", onchange: (e) => { contactsFilter.cat = e.target.value; drawList(); } });
    // 외부 연락처 입력·고치기 (r 이 없으면 새로)
    function externalDialog(r) {
      const extraInput = (key, label, maxlength, placeholder) => { const el = h("input", { value: r?.[key] || "", maxlength, placeholder, autocomplete: "off" }); return { key, el, wrap: field(label, el) }; };
      const cat = h("select", {}, [h("option", { value: "", text: "미분류" }), ...data.categories.map((c) => h("option", { value: String(c.id), text: c.name }))]);
      cat.value = r?.categoryId ? String(r.categoryId) : contactsFilter.cat && /^\d+$/.test(contactsFilter.cat) ? contactsFilter.cat : "";
      const extra = [{ key: "categoryId", el: cat, wrap: field("카테고리", cat) }, extraInput("name", "이름", "40", "이름"), extraInput("org", "소속", "60", "회사·기관 이름"), extraInput("title", "직함", "40", "직함")];
      const form = contactForm(r || {}, async (v) => {
        const body = { ...v, categoryId: v.categoryId ? Number(v.categoryId) : null };
        const x = await api(r ? `/admin/external-contacts/${r.ref.slice(1)}` : "/admin/external-contacts", { method: r ? "PATCH" : "POST", body });
        closeDialog(); saved(x);
      }, "btn--admin", extra);
      if (r) form.append(h("button", { class: "btn btn--danger-outline btn--sm", type: "button", text: "이 연락처 지우기", onclick: async () => {
        if (!confirm(`'${r.name}' 연락처를 지울까요?`)) return;
        const x = await act(() => api(`/admin/external-contacts/${r.ref.slice(1)}`, { method: "DELETE" }));
        closeDialog(); data = x; drawAll();
      } }));
      openDialog(r ? `${r.name} 연락처` : "외부 연락처 추가", form, { admin: true });
    }
    // 카테고리 만들기·이름 바꾸기·지우기 (지워도 연락처는 미분류로 남음)
    function categoryDialog() {
      const box = h("div", { class: "stack" });
      const apply = (r) => { data = r; drawAll(); draw(); };
      const draw = () => {
        const name = h("input", { maxlength: "30", placeholder: "새 카테고리 (예: 협력 업체)", "aria-label": "새 카테고리 이름" });
        const add = h("form", { class: "contact-cat" }, [name, h("button", { class: "btn btn--admin btn--sm", type: "submit", text: "추가" })]);
        add.addEventListener("submit", async (e) => { e.preventDefault(); if (name.value.trim()) apply(await act(() => api("/admin/contact-categories", { method: "POST", body: { name: name.value } }))); });
        box.replaceChildren(...data.categories.map((c) => {
          const input = h("input", { value: c.name, maxlength: "30", "aria-label": `${c.name} 이름` });
          input.addEventListener("change", async () => apply(await act(() => api(`/admin/contact-categories/${c.id}`, { method: "PATCH", body: { name: input.value } }))));
          return h("div", { class: "contact-cat" }, [input, h("button", { class: "icon-btn icon-btn--xs", type: "button", "aria-label": `${c.name} 지우기`, html: ICON.trash, onclick: async () => {
            if (confirm(`'${c.name}' 카테고리를 지울까요? 안의 연락처는 미분류로 남아요.`)) apply(await act(() => api(`/admin/contact-categories/${c.id}`, { method: "DELETE" })));
          } })]);
        }), add);
      };
      draw();
      openDialog("연락처 카테고리", box, { admin: true });
    }
    const editRow = (r) => (r.external ? externalDialog(r) : openDialog(`${r.name} 연락처`, contactForm(r, async (v) => { const x = await put(r.ref, v); closeDialog(); saved(x); }, "btn--admin"), { admin: true }));
    const valueCell = (label, v, href) => h("td", { "data-label": label }, v ? h("a", { href, text: v }) : h("span", { class: "muted", text: "-" }));
    const blankCell = () => h("td", { class: "contacts__blank" });
    const contactRow = (r) => (r.vacant ? h("tr", { class: "is-vacant" }, [
      h("td", { class: "contacts__name muted", text: "공석" }),
      h("td", { "data-label": "직함", class: "muted", text: r.title || "-" }),
      blankCell(), blankCell(), blankCell(), isAdmin() ? blankCell() : null
    ]) : h("tr", { class: r.mine ? "is-mine" : null }, [
      h("td", { class: "contacts__name" }, h("strong", { text: r.name })),
      h("td", { "data-label": "직함", text: [r.org, r.title].filter(Boolean).join(" · ") || "-" }),
      valueCell("휴대전화", r.mobile, telHref(r.mobile)),
      valueCell("사무실 전화", r.office, telHref(r.office)),
      valueCell("이메일", r.email, "mailto:" + encodeURIComponent(r.email).replace(/%40/g, "@")),
      isAdmin() ? h("td", { class: "contacts__edit" }, h("button", { class: "btn btn--admin btn--sm", type: "button", "aria-label": `${r.name} 연락처 고치기`, text: "고치기", onclick: () => editRow(r) })) : null
    ]));
    const groupRow = (g) => {
      const people = g.rows.filter((r) => !r.vacant).length, open = g.rows.length - people;
      return h("tr", { class: "contacts__group" }, h("th", { colspan: isAdmin() ? "6" : "5", scope: "colgroup", style: `padding-left:${14 + (g.depth || 0) * 18}px` }, [
        h("span", { text: g.label }),
        h("span", { class: "muted small contacts__count", text: g.rows.length ? `${people}명${open ? ` · 공석 ${open}` : ""}` : "자리 없음" })
      ]));
    };
    // 조직도 순서로 모든 소속·자리를 묶어서 (찾을 때는 맞는 줄이 있는 소속만), 그 아래에 외부 카테고리
    function contactGroups() {
      const words = contactsFilter.q.replace(/\s+/g, "").toLowerCase();
      const cat = contactsFilter.cat;
      const showOrg = cat === "" || cat === "org";
      unitSel.hidden = !showOrg;
      const scope = contactsFilter.unit && unitOf(Number(contactsFilter.unit)) ? unitSubtree(Number(contactsFilter.unit)) : null;
      const hit = (r) => !words || ((r.vacant ? "공석" : r.name) + (r.external ? catName(r.categoryId) + r.org : unitLabel(r.unitId)) + r.title).replace(/\s+/g, "").toLowerCase().includes(words);
      const inside = data.rows.filter((r) => !r.external && hit(r));
      const groups = [];
      if (showOrg) {
        for (const { u, depth } of unitRows(null)) {
          if (scope && !scope.has(u.id)) continue;
          const rows = inside.filter((r) => r.unitId === u.id);
          if (rows.length || !words) groups.push({ label: words ? unitLabel(u.id) : u.name, depth: words ? 0 : depth, rows });
        }
        const loose = inside.filter((r) => !r.unitId || !unitOf(r.unitId));
        if (loose.length && !scope) groups.push({ label: "소속 없음", rows: loose });
      }
      const outside = data.rows.filter((r) => r.external && hit(r));
      for (const c of [...data.categories, { id: null, name: "미분류" }]) {
        const key = c.id === null ? "none" : String(c.id);
        if ((cat !== "" && cat !== key) || (showOrg && scope)) continue; // 소속으로 거르면 그 소속만
        const rows = outside.filter((r) => (r.categoryId || null) === c.id);
        if (rows.length) groups.push({ label: `외부 · ${c.name}`, rows });
      }
      return groups;
    }
    function drawList() {
      const groups = contactGroups();
      const rows = groups.flatMap((g) => g.rows);
      const open = rows.filter((r) => r.vacant).length;
      count.textContent = `${rows.length - open}명${open ? ` · 공석 ${open}` : ""}`;
      fill(listBox, groups.length ? h("div", { class: "card table-wrap" }, h("table", { class: "table contacts" }, [
        h("thead", {}, h("tr", {}, [...["이름", "직함", "휴대전화", "사무실 전화", "이메일"].map((t) => h("th", { text: t })), isAdmin() ? h("th", { "aria-label": "고치기" }) : null])),
        h("tbody", {}, groups.flatMap((g) => [groupRow(g), ...g.rows.map(contactRow)]))
      ])) : h("div", { class: "card empty", text: data.rows.length ? "찾는 사람이 없어요." : "볼 수 있는 연락처가 없어요." }));
    }
    function drawAll() {
      fill(mineBox, h("section", { class: "card contact-me" }, [
        h("div", { class: "card__head" }, [h("h2", { class: "card__title", text: "내 연락처" }), h("span", { class: "muted small", text: "직접 입력하고 고칠 수 있어요" })]),
        contactForm(data.me, async (v) => saved(await put(data.me.ref, v)), "btn--dark")
      ]));
      if (isAdmin()) fill(adminBox, h("div", { class: "side__admin contact-admin" }, [
        h("div", { class: "side__adminhead" }, [icon("lock"), "관리자 전용"]),
        h("p", { class: "small", text: "계정이 없는 사람도 '고치기'로 입력할 수 있어요. 빠진 사람은 조직도 편집에서 자리를 추가하면 여기에 나와요." }),
        h("div", { class: "actions contact-admin__btns" }, [
          h("button", { class: "btn btn--admin btn--sm", type: "button", text: "+ 외부 연락처", onclick: () => externalDialog(null) }),
          h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "카테고리 관리", onclick: categoryDialog })
        ])
      ]));
      const hasNone = data.rows.some((r) => r.external && !r.categoryId);
      catSel.replaceChildren(h("option", { value: "", text: "카테고리 전체" }), h("option", { value: "org", text: "조직도 (내부)" }), ...data.categories.map((c) => h("option", { value: String(c.id), text: c.name })), hasNone ? h("option", { value: "none", text: "미분류" }) : "");
      catSel.value = contactsFilter.cat;
      if (catSel.value !== contactsFilter.cat) { contactsFilter.cat = ""; catSel.value = ""; }
      unitSel.replaceChildren(h("option", { value: "", text: "소속 전체" }), ...unitRows(null).map(({ u, depth }) => h("option", { value: String(u.id), text: "\u00a0\u00a0".repeat(depth) + u.name })));
      unitSel.value = contactsFilter.unit;
      if (unitSel.value !== contactsFilter.unit) { contactsFilter.unit = ""; unitSel.value = ""; }
      drawList();
    }
    setMain("contacts", [
      h("div", { class: "page-head page-head--wrap" }, [h("h1", { text: "연락처" }), count]),
      mineBox, adminBox,
      h("div", { class: "filters" }, [search, catSel, unitSel]),
      listBox
    ]);
    drawAll();
    page = { name: "contacts", reload: async () => { data = await api("/contacts"); drawAll(); } };
  }

  /* ----- 조직도 자리 패널: 겸직 자리, 계정이 연결돼 있으면 그 사람의 회의·할 일 ----- */
  async function posPeek(id) {
    if (!state.positions.some((p) => p.id === id)) await loadOrg();
    const p = state.positions.find((x) => x.id === id);
    if (!p) throw Object.assign(new Error("조직도에서 그 자리를 찾을 수 없어요."), { status: 404 });
    const same = p.name ? state.positions.filter((x) => x.name && personKey(x) === personKey(p)) : [p];
    const namesakes = p.name ? state.positions.filter((x) => x.name === p.name && personKey(x) !== personKey(p)) : [];
    const head = [h("div", { class: "peek__kind" }, [icon("org"), h("span", { text: "조직도" })]), h("h2", { class: "peek__h", text: p.name || `${p.title} (공석)` })];
    const body = [
      section("org", same.length > 1 ? `자리 ${same.length}개 (겸직)` : "자리", null, h("ul", { class: "pos-list" }, same.map((x) => h("li", {}, [
        h("strong", { text: x.title || "직함 없음" }), h("a", { href: `#/unit/${x.unitId}`, text: unitLabel(x.unitId) }), x.note ? h("small", { class: "muted", text: x.note }) : null
      ])))),
      namesakes.length ? h("p", { class: "muted small", text: `이름이 같은 다른 사람: ${namesakes.map((x) => `${x.name} (${unitOf(x.unitId)?.name || "?"} ${x.title})`).join(", ")}` }) : null
    ];
    if (p.userId) {
      const r = await api(`/people/${p.userId}?today=${today()}`);
      body.push(
        section("people", ["앞으로 30일 회의 ", h("span", { class: "muted", text: String(r.meetings.length) })], null, r.meetings.length ? h("ul", { class: "mrows" }, r.meetings.map((e) => meetingRow(e))) : h("p", { class: "muted small", text: "참석하는 회의가 없어요." })),
        section("check", ["맡은 할 일 ", h("span", { class: "muted", text: String(r.tasks.length) })], null, taskRows(r.tasks, { compact: true, empty: "남은 할 일이 없어요." }))
      );
    } else if (p.name) {
      body.push(h("p", { class: "notice-box small", text: isAdmin() ? "PSchedule 계정이 연결되지 않은 자리예요. '조직도 편집'의 계정 칸에서 연결하면 회의·할 일이 여기 보여요." : "PSchedule 계정이 연결되지 않은 자리예요." }));
    }
    return peekFrame(head, body);
  }

  /* ---------- 조직도 편집 (관리자): 엑셀과 같은 표 ---------- */
  const orgEdit = { hq: "all", q: "" };
  async function pageOrg() {
    if (!isAdmin()) return go("#/today");
    document.title = `조직도 편집 · ${TITLE}`;
    drawMini(null);
    setMain("org", loading());
    try { await loadOrg(); } catch (e) { if (e.status !== 401) setMain("org", failed(e)); return; }
    const base = h("input", { type: "date", value: state.orgBaseDate || "", "aria-label": "기준일" });
    base.addEventListener("change", async () => setOrg(await act(() => api("/admin/org/settings", { method: "PUT", body: { baseDate: base.value } }), "기준일을 저장했어요.")));
    const tableBox = h("section", { class: "card ot-card", "aria-label": "조직 표" });
    const checkBox = h("section", { class: "card ot-side ot-check", "aria-label": "확인할 것" });
    const treeBox = h("section", { class: "card ot-side", "aria-label": "부서 구조" });
    setMain("org", [
      h("div", { class: "page-head page-head--wrap" }, [
        h("h1", { text: "조직도 편집" }), adminBadge(),
        h("label", { class: "ot-base" }, ["기준일", base]),
        h("span", { class: "page-head__end ot-actions" }, [
          h("a", { class: "btn btn--ghost", href: "#/orgchart", text: "조직도로 보기 →" }),
          h("button", { class: "btn btn--ghost", type: "button", text: "엑셀(CSV)로 내보내기", onclick: exportCsv }),
          h("button", { class: "btn btn--admin", type: "button", text: "엑셀 불러오기 · 붙여넣기", onclick: importDialog })
        ])
      ]),
      h("div", { class: "ot-grid" }, [tableBox, h("aside", { class: "ot-aside" }, [checkBox, treeBox])])
    ]);
    const saved = (r) => { setOrg(r); drawTable(); drawCheck(); drawTree(); drawNavAll(); return r; };
    const patch = (p, body) => act(() => api(`/admin/org/positions/${p.id}`, { method: "PATCH", body })).then(saved);

    // 표: 부별 묶음 줄 + 자리 줄. 칸은 바로 고치고(포커스가 빠지면 저장), 순번 칸을 끌어서 순서 바꾸기
    let dragId = null;
    function drawTable() {
      const all = orgRowsOrdered();
      const root = unitChildren(null)[0];
      const hqs = root ? unitChildren(root.id) : [];
      const hqOf = (p) => unitPath(p.unitId)[1]?.id || null;
      const qv = orgEdit.q;
      const rows = all.filter((p) => (orgEdit.hq === "all" || hqOf(p) === orgEdit.hq) && (!qv || `${p.name} ${p.title} ${unitLabel(p.unitId)} ${p.note}`.includes(qv)));
      const no = new Map(all.map((p, i) => [p.id, i + 1]));
      const hqNames = hqs.map((u) => u.name);
      const datalist = (id, names) => h("datalist", { id }, [...new Set(names)].map((n) => h("option", { value: n })));
      const lists = [datalist("ot-hq", ["공통", ...hqNames]), datalist("ot-dept", state.units.filter((u) => unitDepthOf(u.id) === 3).map((u) => u.name).concat(["본부 직속", "위원회 직속"])), datalist("ot-team", state.units.filter((u) => unitDepthOf(u.id) >= 4).map((u) => u.name))];
      const groupKey = (p) => { const path = unitPath(p.unitId); return (path[2] || path[1] || path[0])?.id; };
      const out = [];
      let lastGroup = null;
      for (const p of rows) {
        const g = groupKey(p);
        if (g !== lastGroup) {
          lastGroup = g;
          const gu = unitOf(g);
          const d = gu ? unitDepthOf(g) : 0;
          out.push(h("tr", { class: "ot-group" }, h("td", { colspan: "9", text: !gu ? "(조직 없음)" : d === 3 ? `${gu.name} (${headCount(g)})` : d === 2 ? `${gu.name} · 본부 직속` : `${gu.name} · 위원회 직속` })));
        }
        out.push(positionRow(p, no.get(p.id)));
      }
      const users = state.team;
      const unlinkedSuggest = all.filter((p) => p.name && !p.userId && users.filter((u) => u.name === p.name).length === 1 && !all.some((x) => x.name === p.name && personKey(x) !== personKey(p))).length;
      fill(tableBox,
        h("div", { class: "ot-toolbar" }, [
          h("div", { class: "seg seg--sm" }, [["all", `전체 ${all.length}`], ...hqs.map((u) => [u.id, `${u.name} ${all.filter((p) => hqOf(p) === u.id).length}`])].map(([k, label]) => h("button", { type: "button", "aria-selected": String(orgEdit.hq === k), text: label, onclick: () => { orgEdit.hq = k; drawTable(); } }))),
          h("label", { class: "search" }, [icon("search"), h("input", { type: "search", value: qv, placeholder: "이름·부서·직함 찾기", "aria-label": "표에서 찾기", oninput: (e) => { orgEdit.q = e.target.value.trim(); clearTimeout(drawTable.t); drawTable.t = setTimeout(() => { drawTable(); tableBox.querySelector('input[type="search"]').focus(); }, 250); } })]),
          h("span", { class: "muted small filters__end", text: "칸을 눌러 바로 고쳐요 · 순번을 끌어서 순서 바꾸기" })
        ]),
        ...lists,
        h("div", { class: "table-wrap" }, h("table", { class: "table ot-table" }, [
          h("thead", {}, h("tr", {}, ["순번", "본부", "부", "팀 · 분과", "직함", "이름", "PSchedule 계정", "비고", ""].map((t) => h("th", { text: t })))),
          h("tbody", {}, out.length ? out : h("tr", {}, h("td", { colspan: "9", class: "muted empty", text: all.length ? "조건에 맞는 줄이 없어요." : "아직 조직도가 없어요. '엑셀 불러오기 · 붙여넣기'로 시작해 주세요." })))
        ])),
        h("div", { class: "ot-foot" }, [
          h("button", { class: "btn btn--ghost btn--sm ot-add", type: "button", text: "+ 줄 추가", onclick: addRow }),
          h("span", { class: "muted small", text: "부·팀 칸에 새 이름을 적으면 조직이 함께 만들어져요. 고친 칸은 바로 저장돼요." }),
          unlinkedSuggest ? h("button", { class: "btn btn--admin btn--sm filters__end", type: "button", text: `이름 같은 계정 ${unlinkedSuggest}명 연결`, onclick: linkSameNames }) : null
        ])
      );
    }
    function cellInput(value, opts) {
      const el = h("input", { class: "ot-in" + (opts.cls ? " " + opts.cls : ""), value: value || "", placeholder: opts.placeholder || "", list: opts.list || null, maxlength: opts.max || "30", "aria-label": opts.label });
      let saved0 = value || "";
      el.addEventListener("keydown", (e) => { if (e.key === "Enter") el.blur(); if (e.key === "Escape") { el.value = saved0; el.blur(); } });
      el.addEventListener("change", async () => { const v = el.value.trim(); if (v === saved0) return; try { await opts.onSave(v); saved0 = v; } catch (ex) { el.value = saved0; } });
      return el;
    }
    function positionRow(p, n) {
      const pl = placeOf(p.unitId);
      const row = h("tr", { class: "ot-row" + (!p.name ? " is-vacant" : "") + (p.userId === state.user.id ? " is-me" : ""), "data-id": p.id });
      const inputs = {};
      const savePath = () => patch(p, { path: { hq: inputs.hq.value || "공통", dept: inputs.dept.value, team: inputs.team.value } });
      inputs.hq = cellInput(pl.hq || "공통", { list: "ot-hq", label: "본부", onSave: savePath });
      inputs.dept = cellInput(pl.dept || (pl.hq ? "본부 직속" : "위원회 직속"), { list: "ot-dept", label: "부", onSave: savePath });
      inputs.team = cellInput(pl.team, { list: "ot-team", label: "팀·분과", placeholder: "—", onSave: savePath });
      // 이름이 같은 계정이 하나뿐이고 동명이인 자리가 아니면 바로 연결 제안, 여럿이면 소속을 보고 고르게
      const sameUsers = !p.userId && p.name ? state.team.filter((u) => u.name === p.name) : [];
      const ambiguous = sameUsers.length > 1 || (sameUsers.length === 1 && state.positions.some((x) => x.name === p.name && personKey(x) !== personKey(p)));
      const linked = p.userId && member(p.userId);
      const acc = h("button", { class: "ot-acc" + (p.userId ? " is-linked" : sameUsers.length ? " is-suggest" : ""), type: "button", title: p.userId ? "연결 바꾸기·끊기" : ambiguous ? "이름이 같은 계정·사람이 여럿이에요. 소속을 보고 골라 주세요" : sameUsers.length ? "이름이 같은 계정이 있어요" : "계정 연결" },
        linked ? `● ${linked.name}${personSub(linked) ? ` · ${personSub(linked)}` : ""}` : p.userId ? "● 연결됨" : ambiguous ? `${p.name} 고르기 (${sameUsers.length}명)` : sameUsers.length ? `연결 제안: ${sameUsers[0].name}${personSub(sameUsers[0]) ? ` · ${personSub(sameUsers[0])}` : ""}` : "+ 연결");
      acc.addEventListener("click", () => {
        if (sameUsers.length && !ambiguous) return patch(p, { userId: sameUsers[0].id });
        personPicker(acc, p.userId ? [p.userId] : [], false, (uid) => patch(p, { userId: uid }));
      });
      const grip = h("td", { class: "ot-no", draggable: "true", title: "끌어서 순서 바꾸기" }, [h("span", { class: "org-row__grip", html: ICON.grip, "aria-hidden": "true" }), String(n)]);
      grip.addEventListener("dragstart", (e) => { dragId = p.id; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(p.id)); row.classList.add("is-drag"); });
      grip.addEventListener("dragend", () => { dragId = null; tableBox.querySelectorAll(".ot-row").forEach((r) => r.classList.remove("is-drag", "drop-before", "drop-after")); });
      const zone = (e) => { const r = row.getBoundingClientRect(); return e.clientY - r.top < r.height / 2 ? "before" : "after"; };
      row.addEventListener("dragover", (e) => { if (!dragId || dragId === p.id) return; e.preventDefault(); row.classList.remove("drop-before", "drop-after"); row.classList.add("drop-" + zone(e)); });
      row.addEventListener("dragleave", () => row.classList.remove("drop-before", "drop-after"));
      row.addEventListener("drop", async (e) => {
        e.preventDefault();
        const id = dragId, z = zone(e); dragId = null;
        if (!id || id === p.id) return;
        const ids = orgRowsOrdered().map((x) => x.id).filter((x) => x !== id);
        const index = ids.indexOf(p.id) + (z === "after" ? 1 : 0);
        try { saved(await api(`/admin/org/positions/${id}`, { method: "PATCH", body: { index } })); } catch (ex) { toast(ex.message); drawTable(); }
      });
      row.append(grip,
        h("td", {}, inputs.hq), h("td", {}, inputs.dept),
        h("td", {}, [pl.mid ? h("small", { class: "muted ot-mid", text: pl.mid + " ›" }) : null, inputs.team]),
        h("td", {}, cellInput(p.title, { label: "직함", onSave: (v) => patch(p, { title: v }) })),
        h("td", {}, [cellInput(p.name, { label: "이름", placeholder: "공석", cls: "ot-in--name", onSave: (v) => patch(p, { name: v }) }), isNamesake(p) ? h("small", { class: "ot-namesake", title: "이름이 같은 다른 사람이에요", text: `동명이인 · ${unitOf(p.unitId)?.name || ""}` }) : null]),
        h("td", {}, acc),
        h("td", {}, cellInput(p.note, { label: "비고", max: "200", cls: "ot-in--note", onSave: (v) => patch(p, { note: v }) })),
        h("td", {}, h("button", { class: "icon-btn icon-btn--xs", type: "button", "aria-label": `${p.name || p.title || "빈"} 줄 지우기`, html: ICON.close, onclick: async () => {
          if (!confirm(`'${[p.title, p.name || "공석"].join(" ")}' 줄을 지울까요?`)) return;
          saved(await act(() => api(`/admin/org/positions/${p.id}`, { method: "DELETE" })));
        } }))
      );
      return row;
    }
    async function addRow() {
      const list = orgRowsOrdered();
      const last = [...tableBox.querySelectorAll(".ot-row")].pop();
      const after = last ? list.find((x) => x.id === Number(last.dataset.id)) : null;
      const body = after ? { afterId: after.id, unitId: after.unitId, title: "", name: "" } : { path: { hq: "공통", dept: "위원회 직속", team: "" }, title: "", name: "" };
      const r = await act(() => api("/admin/org/positions", { method: "POST", body }));
      saved(r);
      const row = tableBox.querySelector(`.ot-row[data-id="${r.id}"]`);
      if (row) { row.scrollIntoView({ block: "center" }); row.querySelector(".ot-in--name").focus(); }
    }
    async function linkSameNames() {
      // 이름이 같은 계정이 하나이고, 그 이름이 동명이인으로 나뉘지 않은 자리만 (헷갈리는 건 표에서 직접 고르기)
      const clear = (p) => state.team.filter((u) => u.name === p.name).length === 1 && !state.positions.some((x) => x.name === p.name && personKey(x) !== personKey(p));
      const list = orgRowsOrdered().filter((p) => p.name && !p.userId && clear(p)).map((p) => [p, state.team.find((u) => u.name === p.name)]);
      if (!list.length) return toast("바로 연결할 수 있는 자리가 없어요. 이름이 같은 사람이 여럿이면 표에서 골라 주세요.");
      if (!confirm(`이름이 같은 계정 ${list.length}개를 조직도 자리에 연결할까요?\n${list.map(([p, u]) => `· ${p.title} ${p.name} → ${u.name}`).join("\n")}`)) return;
      let r;
      for (const [p, u] of list) r = await act(() => api(`/admin/org/positions/${p.id}`, { method: "PATCH", body: { userId: u.id } }));
      if (r) { saved(r); await reloadTeam(); toast(`${list.length}개를 연결했어요.`); }
    }

    // 확인할 것: 이름이 같은 자리(겸직인지 동명이인인지), 공석, 계정 미연결
    function drawCheck() {
      const named = state.positions.filter((p) => p.name);
      const byName = new Map();
      for (const p of named) { if (!byName.has(p.name)) byName.set(p.name, []); byName.get(p.name).push(p); }
      // 같은 이름 자리: 아직 안 정한 것만 확인할 것으로 (같은 사람/다른 사람 버튼)
      const dups = [...byName.entries()].filter(([, l]) => l.length > 1 && l.some((p) => !p.person && !p.userId));
      const decided = [...byName.entries()].filter(([, l]) => l.length > 1 && !dups.some(([n]) => n === l[0].name));
      const decide = async (l, person) => { let r; for (const p of l) r = await act(() => api(`/admin/org/positions/${p.id}`, { method: "PATCH", body: { person } })); if (r) { saved(r); toast(person === "same" ? "같은 사람(겸직)으로 정했어요." : "다른 사람(동명이인)으로 나눴어요."); } };
      const vacant = state.positions.filter((p) => !p.name);
      const unlinked = new Set(named.filter((p) => !p.userId).map((p) => p.name)).size;
      const items = [
        ...dups.map(([name, l]) => h("li", {}, [h("strong", { text: `${name} ${l.length}자리` }), " — ", l.map((p) => `${p.title}(${unitOf(p.unitId)?.name || "?"})`).join(", "),
          h("div", { class: "ot-decide" }, [
            h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "같은 사람 (겸직)", onclick: () => decide(l, "same") }),
            h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "다른 사람 (동명이인)", onclick: () => decide(l, "other") })
          ])])),
        vacant.length ? h("li", {}, [h("strong", { text: `공석 ${vacant.length}` }), " — ", vacant.map((p) => `${unitOf(p.unitId)?.name || "?"} ${p.title}`).join(", ")]) : null,
        unlinked ? h("li", {}, [h("strong", { text: `계정 미연결 ${unlinked}명` }), " — 조직도에는 보이지만 회의·할 일과는 아직 이어지지 않아요."]) : null,
        ...(() => { const empty = state.units.filter((u) => !posIn(unitSubtree(u.id)).length); return empty.length ? [h("li", {}, [h("strong", { text: `빈 조직 ${empty.length}` }), " — ", empty.map((u) => unitLabel(u.id)).join(", "), h("small", { class: "muted", text: " 필요 없으면 부서 구조에서 지워 주세요." })])] : []; })()
      ].filter(Boolean);
      fill(checkBox, h("h2", { class: "card__title", text: `확인할 것 ${items.length}` }), items.length ? h("ul", { class: "ot-checklist" }, items) : h("p", { class: "muted small", text: "확인할 것이 없어요." }),
        decided.length ? h("p", { class: "muted small ot-decided" }, ["정한 것: ", ...decided.map(([name, l], i) => {
          const other = l.some(isNamesake);
          return h("span", {}, [i ? ", " : "", `${name} ${other ? "동명이인" : "겸직"} `, h("button", { class: "link-btn link-btn--muted", type: "button", text: "되돌리기", onclick: () => decide(l, "") })]);
        })]) : null);
    }

    // 부서 구조: 끌어서 위치·순서 바꾸기 (팀을 분과 아래로 넣으면 조직도에서 안쪽에 보여요)
    let dragUnit = null;
    const closed = new Set(JSON.parse(store.get("ps.orgClosed", "[]") || "[]"));
    function drawTree() {
      const rows = [];
      const walk = (pid, depth) => { for (const u of unitChildren(pid)) { const kids = unitChildren(u.id).length; rows.push(treeRow(u, depth, kids)); if (kids && !closed.has(u.id)) walk(u.id, depth + 1); } };
      walk(null, 0);
      fill(treeBox,
        h("div", { class: "card__head" }, [h("h2", { class: "card__title", text: "부서 구조" }), h("button", { class: "link-btn", type: "button", text: "+ 맨 위 조직", onclick: (ev) => addUnitPop(ev.currentTarget, null) })]),
        h("p", { class: "muted small", text: "팀을 분과 아래로 끌어 넣으면 조직도에서 안쪽에 보여요. 행 위쪽에 놓으면 앞에, 아래쪽은 뒤에, 가운데는 그 조직 안으로 (5단계까지)." }),
        rows.length ? h("div", { class: "ot-tree" }, rows) : h("p", { class: "muted small", text: "아직 조직이 없어요." })
      );
    }
    function treeRow(u, depth, kids) {
      const row = h("div", { class: "org-row org-row--sm", draggable: "true", style: `padding-left:${4 + depth * 16}px`, "data-id": u.id }, [
        h("span", { class: "org-row__grip", html: ICON.grip, "aria-hidden": "true" }),
        kids ? h("button", { class: "org-row__chev" + (closed.has(u.id) ? "" : " is-open"), type: "button", "aria-label": `${u.name} ${closed.has(u.id) ? "펼치기" : "접기"}`, html: ICON.right, onclick: (e) => { e.stopPropagation(); closed.has(u.id) ? closed.delete(u.id) : closed.add(u.id); store.set("ps.orgClosed", JSON.stringify([...closed])); drawTree(); } }) : h("span", { class: "org-row__chev" }),
        h("span", { class: `org-row__name org-row__name--d${Math.min(depth, 2)}`, text: u.name }),
        h("span", { class: "org-row__count", text: `${headCount(u.id)}명` }),
        h("button", { class: "icon-btn icon-btn--xs", type: "button", "aria-label": `${u.name} 고치기`, html: ICON.edit, onclick: (e) => { e.stopPropagation(); unitPop(e.currentTarget, u); } })
      ]);
      row.addEventListener("dragstart", (e) => { dragUnit = u.id; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(u.id)); row.classList.add("is-drag"); });
      row.addEventListener("dragend", () => { dragUnit = null; treeBox.querySelectorAll(".org-row").forEach((r) => r.classList.remove("is-drag", "drop-before", "drop-after", "drop-inside")); });
      const zone = (e) => { const r = row.getBoundingClientRect(); const y = (e.clientY - r.top) / r.height; return y < 0.25 ? "before" : y > 0.75 ? "after" : "inside"; };
      row.addEventListener("dragover", (e) => { if (!dragUnit || dragUnit === u.id) return; e.preventDefault(); row.classList.remove("drop-before", "drop-after", "drop-inside"); row.classList.add("drop-" + zone(e)); });
      row.addEventListener("dragleave", () => row.classList.remove("drop-before", "drop-after", "drop-inside"));
      row.addEventListener("drop", async (e) => {
        e.preventDefault();
        const id = dragUnit, z = zone(e); dragUnit = null;
        if (!id || id === u.id) return;
        let parentId, index;
        if (z === "inside") { parentId = u.id; index = unitChildren(u.id).filter((x) => x.id !== id).length; closed.delete(u.id); }
        else { parentId = u.parentId || null; const sibs = unitChildren(parentId).filter((x) => x.id !== id); index = sibs.indexOf(u) + (z === "after" ? 1 : 0); }
        try { const r = await api(`/admin/units/${id}`, { method: "PATCH", body: { parentId, index } }); setOrg(r); drawTable(); drawTree(); }
        catch (ex) { toast(ex.message); drawTree(); }
      });
      return row;
    }
    function addUnitPop(anchor, parent) {
      const input = h("input", { placeholder: parent ? `'${parent.name}' 아래 조직 이름` : "맨 위 조직 이름 (예: 조직위원회)", maxlength: "30" });
      const err = errorLine();
      const ok = h("button", { class: "btn btn--admin btn--sm", type: "submit", text: "추가" });
      const form = h("form", { class: "pop__form" }, [input, err, ok]);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        busy(ok, async () => {
          try { const r = await api("/admin/units", { method: "POST", body: { parentId: parent ? parent.id : null, name: input.value } }); closePop(); setOrg(r); drawTree(); drawTable(); }
          catch (ex) { showError(err, ex.message); }
        });
      });
      popover(anchor, form);
      input.focus();
    }
    // 조직 이름·약칭·책임자 고치기, 아래 조직 추가, 지우기
    function unitPop(anchor, u) {
      const name = h("input", { value: u.name, maxlength: "30", "aria-label": "조직 이름" });
      const short = h("input", { value: u.short || "", maxlength: "12", placeholder: "약칭 (예: 식음료)", "aria-label": "약칭" });
      const err = errorLine();
      const ok = h("button", { class: "btn btn--admin btn--sm", type: "submit", text: "저장" });
      const form = h("form", { class: "pop__form" }, [h("strong", { class: "small", text: unitLabel(u.id) }), name, short,
        err,
        h("div", { class: "actions" }, [
          unitDepthOf(u.id) < 5 ? h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "+ 아래 조직", onclick: () => addUnitPop(anchor, u) }) : null,
          h("button", { class: "btn btn--danger-outline btn--sm", type: "button", text: "지우기", onclick: async () => {
            if (!confirm(`'${unitLabel(u.id)}' 을(를) 지울까요? 아래 조직·자리·소속 멤버는 ${u.parentId ? `'${unitOf(u.parentId).name}'(으)로 옮겨져요` : "함께 지워져요"}.`)) return;
            closePop(); await act(() => api(`/admin/units/${u.id}`, { method: "DELETE" })); await loadOrg(); await reloadTeam(); drawTree(); drawTable(); drawCheck();
          } }),
          ok
        ])]);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        busy(ok, async () => {
          try { const r = await api(`/admin/units/${u.id}`, { method: "PATCH", body: { name: name.value, short: short.value } }); closePop(); setOrg(r); drawTree(); drawTable(); }
          catch (ex) { showError(err, ex.message); }
        });
      });
      popover(anchor, form);
      name.focus();
    }

    // 엑셀 불러오기·붙여넣기 → 지금 조직도와 비교한 미리보기 → 바뀐 것만 반영
    function importDialog() {
      const err = errorLine();
      const file = h("input", { type: "file", accept: ".xlsx" });
      const sheetSel = h("select", { "aria-label": "시트", hidden: true });
      const paste = h("textarea", { rows: "7", placeholder: "엑셀에서 표를 복사해 붙여 넣어도 돼요 (머리줄 포함)\n넘버링 | 본부 | 부서 | 직함 | 이름 | 비고", "aria-label": "붙여넣기" });
      const baseIn = h("input", { type: "date", value: state.orgBaseDate || today(), "aria-label": "기준일" });
      const preview = h("div", { class: "ot-preview" });
      const go2 = h("button", { class: "btn btn--admin", type: "button", text: "비교하기" });
      let sheets = [], rows = null, diff = null;
      file.addEventListener("change", () => busy(go2, async () => {
        try {
          sheets = await readXlsx(file.files[0]);
          sheetSel.replaceChildren(...sheets.map((s, i) => h("option", { value: String(i), text: `${s.name} (${s.rows.length}줄)` })));
          sheetSel.hidden = sheets.length < 2;
          const guess = sheets.findIndex((s) => /후/.test(s.name));
          sheetSel.value = String(guess >= 0 ? guess : 0);
          const m = sheets[Number(sheetSel.value)]?.name.match(/(\d{2})(\d{2})\s*$/);
          if (m) baseIn.value = `${today().slice(0, 4)}-${m[1]}-${m[2]}`;
          showError(err, "");
        } catch (ex) { showError(err, ex.message); }
      }));
      async function compare() {
        try {
          rows = sheets.length ? parseOrgRows(sheets[Number(sheetSel.value)].rows) : parseOrgRows(paste.value.split(/\r?\n/).map((l) => l.split("\t")));
          if (!rows.length) throw new Error("본부·부서·직함·이름 열을 찾지 못했어요. 머리줄(본부, 부서, 직함, 이름)을 함께 붙여 넣어 주세요.");
          diff = await api("/admin/org/preview", { method: "POST", body: { rows } });
          showError(err, "");
          drawPreview();
        } catch (ex) { showError(err, ex.message); }
      }
      go2.addEventListener("click", () => busy(go2, compare));
      const remove = new Set();
      function drawPreview() {
        remove.clear(); diff.remove.forEach((x) => remove.add(x.id));
        const list = (kind, items, cls) => items.length ? h("div", { class: "ot-diff" }, [h("h3", {}, [h("span", { class: `ot-badge ot-badge--${cls}`, text: kind }), ` ${items.length}`]),
          h("ul", {}, items.map((x) => h("li", {}, [
            cls === "remove" ? h("input", { type: "checkbox", checked: true, "aria-label": `${x.name} 빼기`, onchange: (e) => { e.target.checked ? remove.add(x.id) : remove.delete(x.id); applyBtn.textContent = `${diff.add.length + diff.move.length + remove.size}건 반영`; } }) : null,
            h("strong", { text: x.name }), " ", h("span", { class: "muted", text: x.what })
          ])))]) : null;
        const applyBtn = h("button", { class: "btn btn--admin", type: "button", text: `${diff.add.length + diff.move.length + diff.remove.length}건 반영` });
        applyBtn.addEventListener("click", () => busy(applyBtn, async () => {
          try {
            const r = await api("/admin/org/apply", { method: "POST", body: { rows, baseDate: baseIn.value || null, removeIds: [...remove] } });
            closeDialog(); saved(r); base.value = state.orgBaseDate || "";
            toast(`반영했어요: 추가 ${r.added}, 이동·변경 ${r.moved}, 빠짐 ${r.removed}`);
          } catch (ex) { showError(err, ex.message); }
        }));
        fill(preview,
          h("p", { class: "muted small", text: `${rows.length}줄을 지금 조직도와 비교했어요. 그대로인 줄 ${diff.same}개, 바뀐 것만 반영해요. 공석 줄은 그대로 둬요.` }),
          list("추가", diff.add, "add"), list("이동·변경", diff.move, "move"), list("빠짐", diff.remove, "remove"),
          !diff.add.length && !diff.move.length && !diff.remove.length ? h("p", { class: "muted", text: "바뀐 것이 없어요." }) : null,
          h("div", { class: "actions" }, [h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), diff.add.length + diff.move.length + diff.remove.length ? applyBtn : null])
        );
      }
      openDialog("엑셀 불러오기 · 붙여넣기", h("div", { class: "stack" }, [
        h("p", { class: "muted small", text: "엑셀 파일(.xlsx)을 고르거나 표를 붙여 넣으면, 지금 조직도와 비교해 추가·이동·빠짐만 보여 줘요. 확인한 뒤 반영해요. 파일은 이 브라우저 안에서만 읽고 서버에는 표 내용만 보내요." }),
        h("div", { class: "row2" }, [field("엑셀 파일", file), field("기준일", baseIn)]), sheetSel,
        field("또는 붙여넣기", paste), err,
        h("div", { class: "actions" }, go2),
        preview
      ]), { admin: true, wide: true });
    }
    function exportCsv() {
      const esc = (v) => (/[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
      const lines = [["넘버링", "본부", "부서", "직함", "이름", "비고"]];
      orgRowsOrdered().forEach((p, i) => {
        const pl = placeOf(p.unitId);
        lines.push([i + 1, pl.hq || "공통", pl.dept ? (pl.team ? `${pl.dept} / ${pl.team}` : pl.dept) : pl.hq ? "본부 직속" : "위원회 직속", p.title, p.name || "공석", p.note]);
      });
      const blob = new Blob(["﻿" + lines.map((l) => l.map(esc).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
      const a = h("a", { href: URL.createObjectURL(blob), download: `조직도${state.orgBaseDate ? "_" + state.orgBaseDate : ""}.csv` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    page = { name: "org", reload: async () => { await loadOrg(); drawTable(); drawCheck(); drawTree(); } };
    drawTable(); drawCheck(); drawTree();
  }

  // 엑셀 표(2차원 배열) → [{ hq, dept, title, name, note }]. 머리줄(본부·부서·직함·이름)을 찾아 열을 맞춤
  function parseOrgRows(grid) {
    const norm = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
    const hi = grid.findIndex((r) => r.some((c) => norm(c) === "이름") && r.some((c) => norm(c) === "직함"));
    let col, start;
    if (hi >= 0) {
      const head = grid[hi].map(norm);
      col = { hq: head.indexOf("본부"), dept: head.indexOf("부서"), title: head.indexOf("직함"), name: head.indexOf("이름"), note: head.indexOf("비고") };
      start = hi + 1;
    } else {
      // 머리줄 없이 붙여 넣으면: (넘버링) 본부 부서 직함 이름 비고
      const first = (grid.find((r) => r.some((c) => norm(c))) || []).map(norm).filter((c, i, a) => c || i < a.length);
      const shift = /^\d+$/.test(first[0] || "") || first[0] === "" ? 1 : 0;
      col = { hq: shift, dept: shift + 1, title: shift + 2, name: shift + 3, note: shift + 4 };
      start = 0;
    }
    if (col.name < 0 || col.title < 0) return [];
    const at = (r, i) => (i >= 0 ? norm(r[i]) : "");
    return grid.slice(start).map((r) => ({ hq: at(r, col.hq), dept: at(r, col.dept), title: at(r, col.title), name: at(r, col.name), note: at(r, col.note) }))
      .filter((r) => r.name || r.title).map((r) => (r.name === "공석" || r.name === "-" ? { ...r, name: "" } : r));
  }

  // .xlsx 읽기 (외부 라이브러리 없이: zip 목록 → 압축 풀기(브라우저 DecompressionStream) → 시트 XML)
  async function readXlsx(f) {
    if (!f) throw new Error("파일을 골라 주세요.");
    const buf = new Uint8Array(await f.arrayBuffer());
    const dv = new DataView(buf.buffer);
    let e = buf.length - 22;
    while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error("엑셀 파일(.xlsx)이 아니에요.");
    const files = {};
    for (let i = 0, off = dv.getUint32(e + 16, true), n = dv.getUint16(e + 10, true); i < n; i++) {
      const nameLen = dv.getUint16(off + 28, true), extra = dv.getUint16(off + 30, true), comment = dv.getUint16(off + 32, true);
      files[new TextDecoder().decode(buf.subarray(off + 46, off + 46 + nameLen))] = { method: dv.getUint16(off + 10, true), size: dv.getUint32(off + 20, true), local: dv.getUint32(off + 42, true) };
      off += 46 + nameLen + extra + comment;
    }
    const read = async (name) => {
      const x = files[name];
      if (!x) return null;
      const startAt = x.local + 30 + dv.getUint16(x.local + 26, true) + dv.getUint16(x.local + 28, true);
      const data = buf.subarray(startAt, startAt + x.size);
      if (x.method === 0) return new TextDecoder().decode(data);
      return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
    };
    const xml = (s) => new DOMParser().parseFromString(s || "<x/>", "application/xml");
    const tags = (node, name) => [...node.getElementsByTagName(name)];
    const wb = xml(await read("xl/workbook.xml"));
    const rels = Object.fromEntries(tags(xml(await read("xl/_rels/workbook.xml.rels")), "Relationship").map((r) => [r.getAttribute("Id"), r.getAttribute("Target")]));
    const strings = tags(xml(await read("xl/sharedStrings.xml")), "si").map((si) => tags(si, "t").filter((t) => t.parentNode.nodeName !== "rPh").map((t) => t.textContent).join(""));
    const colOf = (ref) => { let n = 0; for (const ch of ref.replace(/\d+/g, "")) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
    const sheets = [];
    for (const s of tags(wb, "sheet")) {
      const target = rels[s.getAttribute("r:id")] || "";
      const doc = xml(await read(target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, "")));
      const rows = tags(doc, "row").map((row) => {
        const cells = [];
        for (const c of tags(row, "c")) {
          const t = c.getAttribute("t"), v = tags(c, "v")[0]?.textContent ?? "";
          cells[colOf(c.getAttribute("r") || "A")] = t === "s" ? strings[Number(v)] ?? "" : t === "inlineStr" ? tags(c, "t").map((x) => x.textContent).join("") : v;
        }
        return Array.from(cells, (x) => x ?? "");
      });
      sheets.push({ name: s.getAttribute("name"), rows });
    }
    if (!sheets.length) throw new Error("시트를 찾지 못했어요.");
    return sheets;
  }

  /* ---------- 소속 화면 (모두): 팀원이 참석하는 회의 · 맡은 할 일 · 쓴 메모 ---------- */
  async function pageUnit(id) {
    drawMini(null);
    if (!id) id = state.user.unitId && unitOf(state.user.unitId) ? state.user.unitId : null;
    if (!id || !unitOf(id)) {
      document.title = `소속 · ${TITLE}`;
      const rows = unitRows(null);
      setMain("unit", h("div", { class: "narrow stack" }, [
        h("div", { class: "page-head" }, [h("h1", { text: "소속 보기" })]),
        h("p", { class: "muted", text: state.user.unitId ? "내 소속을 찾을 수 없어요. 아래에서 소속을 골라 주세요." : "아직 내 소속이 없어요. 관리자가 정해 줄 수 있어요. 아래에서 다른 소속을 볼 수 있어요." }),
        rows.length ? h("div", { class: "card unit-list" }, rows.map(({ u, depth }) => h("a", { class: "unit-list__row", href: `#/unit/${u.id}`, style: `padding-left:${14 + depth * 20}px` }, [h("span", { text: u.name }), h("small", { class: "muted", text: `${state.team.filter((m) => m.unitId === u.id).length}명` })])))
          : h("div", { class: "card empty", text: "아직 조직도가 없어요." })
      ]));
      page = { name: "unit", reload: async () => {} };
      return;
    }
    const u = unitOf(id);
    document.title = `${u.name} · ${TITLE}`;
    let sub = store.get("ps.unitSub", "0") === "1";
    let taskView = store.get("ps.unitTaskView", "who");
    let meetView = store.get("ps.unitMeetView", "today");
    const head = h("div", { class: "unit-head" });
    const statsBox = h("div", { class: "unit-stats" });
    const meetBox = h("section", { class: "card unit-card" }, loading());
    const taskBox = h("section", { class: "card unit-card" });
    const memoBox = h("section", { class: "card unit-card" });
    setMain("unit", [head, statsBox, h("div", { class: "unit-grid" }, [meetBox, taskBox, memoBox])]);
    let data = null;

    function drawHead() {
      const scope = sub ? unitSubtree(u.id) : new Set([u.id]);
      const ids = data ? new Set(data.memberIds) : new Set(state.team.filter((m) => scope.has(m.unitId)).map((m) => m.id));
      const people = state.team.filter((m) => ids.has(m.id));
      const lead = u.leadId && member(u.leadId);
      const path = unitPath(u.id);
      const other = h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "다른 소속" });
      other.addEventListener("click", () => unitPicker(other, u.id, (nid) => { if (nid) go(`#/unit/${nid}`); }, { noneLabel: null }));
      fill(head,
        path.length > 1 ? h("nav", { class: "muted small", "aria-label": "소속 경로" }, path.slice(0, -1).map((x) => x.name).join(" › ") + " ›") : null,
        h("div", { class: "unit-head__row" }, [
          h("h1", { text: u.name }),
          h("span", { class: "avatars avatars--lg" }, people.slice(0, 8).map((m) => avatar(m.id))),
          h("span", { class: "muted small", text: `멤버 ${people.length}명${lead ? ` · 책임 ${lead.name}` : ""}` }),
          h("span", { class: "unit-head__end" }, [
            unitChildren(u.id).length ? h("div", { class: "seg seg--sm" }, [[false, "이 팀만"], [true, "하위 조직 포함"]].map(([k, label]) => h("button", { type: "button", "aria-selected": String(sub === k), text: label, onclick: () => { sub = k; store.set("ps.unitSub", k ? "1" : "0"); drawHead(); quiet(load()); } }))) : null,
            other
          ])
        ]),
        h("p", { class: "muted small unit-head__desc", text: "팀원이 참석하는 회의, 팀원이 맡은 할 일, 팀원이 쓴 메모를 모아 보여 줘요. 팀원의 소속만 정하면 자동으로 모여요." })
      );
    }

    function drawBody() {
      const s = data.stats;
      const td = today();
      const todayMeetings = data.meetings.filter((e) => e.startDate <= td && e.endDate >= td);
      statsBox.replaceChildren(...[[todayMeetings.length, "오늘 회의"], [s.weekMeetings, "이번 주 회의"], [s.openTasks, "남은 할 일"], [s.lateTasks, "마감 지난 할 일", s.lateTasks > 0], [s.importantMemos, "중요 메모"]].map(([n, label, warn]) =>
        h("div", { class: "card unit-stat" + (warn ? " is-warn" : "") }, [h("strong", { text: String(n) }), h("span", { text: label })])));
      const week = `${shortDate(data.week.from)} ~ ${shortDate(data.week.to)}`;
      const isToday = meetView === "today";
      const meetList = isToday ? todayMeetings : data.meetings;
      fill(meetBox,
        h("div", { class: "card__head" }, [h("h2", { class: "card__title" }, [isToday ? "오늘 회의 " : "이번 주 회의 ", h("span", { class: "muted small", text: isToday ? shortDate(td) : week })]), h("a", { class: "btn btn--ghost btn--sm", href: "#/dashboard" }, ["대시보드", icon("arrow")])]),
        h("div", { class: "seg seg--sm" }, [["today", `오늘 ${todayMeetings.length}`], ["week", `이번 주 ${data.meetings.length}`]].map(([k, label]) => h("button", { type: "button", "aria-selected": String(meetView === k), text: label, onclick: () => { meetView = k; store.set("ps.unitMeetView", k); drawBody(); } }))),
        meetList.length ? h("ul", { class: "mrows" }, meetList.map((e) => meetingRow(e, isToday))) : h("p", { class: "muted small", text: !data.memberIds.length ? "아직 이 소속에 멤버가 없어요." : isToday ? "오늘 팀원이 참석하는 회의가 없어요." : "이번 주에 팀원이 참석하는 회의가 없어요." })
      );
      const tasks = data.tasks;
      const viewSeg = h("div", { class: "seg seg--sm" }, [["who", "담당자별"], ["due", "마감일순"]].map(([k, label]) => h("button", { type: "button", "aria-selected": String(taskView === k), text: label, onclick: () => { taskView = k; store.set("ps.unitTaskView", k); drawBody(); } })));
      let list;
      if (!tasks.length) list = h("p", { class: "muted small", text: "남은 할 일이 없어요." });
      else if (taskView === "due") list = taskRows(tasks, { assignee: true });
      else {
        list = h("div", { class: "stack stack--sm" }, data.memberIds.filter((mid) => tasks.some((t) => t.assigneeId === mid)).map((mid) => h("div", { class: "tgroup" }, [
          h("div", { class: "tgroup__head" }, [personLine(mid), h("span", { class: "count", text: String(tasks.filter((t) => t.assigneeId === mid).length) })]),
          taskRows(tasks.filter((t) => t.assigneeId === mid), {})
        ])));
      }
      fill(taskBox, h("div", { class: "card__head" }, [h("h2", { class: "card__title" }, ["팀 할 일 ", h("span", { class: "count count--lg", text: String(tasks.length) })]), viewSeg]), list);
      fill(memoBox, h("div", { class: "card__head" }, [h("h2", { class: "card__title", text: "최근 메모 · 중요 먼저" })]), memoRows(data.memos, { showDate: true, empty: "팀원이 쓴 메모가 없어요." }));
      markPeeked();
    }

    async function load() {
      data = await api(`/units/${u.id}?sub=${sub ? 1 : 0}&today=${today()}`);
      drawHead();
      drawBody();
    }
    page = { name: "unit", reload: load };
    drawHead();
    try { await load(); } catch (e) { if (e.status !== 401) meetBox.replaceChildren(failed(e)); }
  }

  /* ---------- 백업 (관리자) ---------- */
  async function pageBackup() {
    if (!isAdmin()) return go("#/today");
    document.title = `백업 · ${TITLE}`;
    drawMini(null);
    const box = h("div", { class: "card card--pad backup-card" }, loading());
    setMain("backup", h("div", { class: "narrow stack" }, [
      h("div", { class: "page-head page-head--wrap" }, [h("h1", { text: "백업" }), adminBadge()]),
      box,
      h("div", { class: "card card--pad" }, [
        h("h2", { class: "card__title", text: "내 Mac 으로 받기 · 복구" }),
        h("p", { class: "muted small", text: "저장소의 tools/pull-backups.sh 로 서버 백업을 내 Mac 으로 받을 수 있어요. 자동으로 받는 방법과 복구 순서는 README 의 '백업' 부분에 있어요. 백업 파일에는 일정·메모와 구글 캘린더 비공개 주소가 들어 있으니 비밀번호처럼 다뤄 주세요." })
      ])
    ]));
    const draw = (b) => {
      const now = h("button", { class: "btn btn--admin btn--sm", type: "button", text: "지금 백업" });
      now.addEventListener("click", () => busy(now, async () => draw(await act(() => api("/admin/backups", { method: "POST" }), "백업했어요."))));
      fill(box,
        h("div", { class: "card__head" }, [h("h2", { class: "card__title", text: "서버 자동 백업" }), now]),
        h("p", { class: "muted small", text: b.keepDays ? `매일 ${b.hour}시 이후 서버에 하루 한 개씩 저장하고 ${b.keepDays}일 지난 것은 지워요.` : "자동 백업이 꺼져 있어요 (BACKUP_KEEP_DAYS=0)." }),
        b.backups.length ? h("ul", { class: "backup-list" }, b.backups.slice(0, 14).map((x) => h("li", {}, [h("span", { class: "mono", text: x.name }), h("span", { class: "muted small", text: `${Math.max(1, Math.round(x.size / 1024))}KB` })]))) : h("p", { class: "muted small", text: "아직 백업이 없어요." }),
        b.backups.length > 14 ? h("p", { class: "muted small", text: `외 ${b.backups.length - 14}개` }) : null
      );
    };
    page = { name: "backup", reload: async () => draw(await api("/admin/backups")) };
    try { await page.reload(); } catch (e) { if (e.status !== 401) box.replaceChildren(failed(e)); }
  }

  /* ---------- 프로젝트: 팀별 목록 + 묶음·항목 트리 ---------- */
  const PROJECT_STATUS = [["none", "미정"], ["idea", "아이디어"], ["review", "검토"], ["doing", "진행"], ["fixed", "확정"], ["hold", "보류"], ["done", "완료"]];
  const projectStatusLabel = (k) => PROJECT_STATUS.find(([x]) => x === k)?.[1] || k;
  const projectBar = (p) => {
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    return h("div", { class: "pj-progress" }, [
      h("div", { class: "pj-bar", role: "img", "aria-label": `완료 ${p.done}개, 전체 ${p.total}개` }, h("i", { style: `width:${pct}%` })),
      h("span", { class: "muted small", text: `완료 ${p.done}/${p.total}` })
    ]);
  };
  const fmtN = (n) => Number(n || 0).toLocaleString("ko-KR");
  const projectFilter = { unit: null };
  // 프로젝트 만들기·고치기
  function projectDialog(p, onSaved) {
    const err = errorLine();
    const name = h("input", { value: p?.name || "", maxlength: "80", autofocus: true, placeholder: "예: 기념품 품목 관리" });
    const note = h("textarea", { rows: "3", maxlength: "1000", placeholder: "무엇을 관리하는 프로젝트인지" }, p?.note || "");
    let unitId = p ? p.unitId : projectFilter.unit || myUnit();
    const ok = h("button", { class: "btn btn--primary", type: "submit", text: p ? "저장" : "만들기" });
    const form = h("form", { class: "stack", novalidate: true }, [
      field("이름", name), field("팀", unitButton(unitId, (id) => { unitId = id; }, "팀 고르기")), field("설명", note), err,
      h("div", { class: "actions" }, [h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), ok])
    ]);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      busy(ok, async () => {
        try {
          const r = await api(p ? `/projects/${p.id}` : "/projects", { method: p ? "PATCH" : "POST", body: { name: name.value, note: note.value, unitId } });
          closeDialog(); onSaved(r);
        } catch (ex) { showError(err, ex.message); }
      });
    });
    openDialog(p ? "프로젝트 고치기" : "새 프로젝트", form);
  }
  async function pageProjects() {
    document.title = `프로젝트 · ${TITLE}`;
    drawMini(null);
    setMain("projects", loading());
    let list;
    const draw = () => {
      const scope = projectFilter.unit && unitOf(projectFilter.unit) ? unitSubtree(projectFilter.unit) : null;
      const shown = list.filter((p) => !scope || scope.has(p.unitId));
      const card = (p) => h("a", { class: "card pj-card", href: `#/projects/${p.id}` }, [
        h("strong", { class: "pj-card__name", text: p.name }),
        p.note ? h("p", { class: "muted small pj-card__note", text: p.note }) : null,
        projectBar(p),
        h("div", { class: "pj-counts" }, PROJECT_STATUS.filter(([k]) => p.counts[k]).map(([k, label]) => h("span", { class: `pj-st pj-st--${k}`, text: `${label} ${p.counts[k]}` }))),
        p.nextDue ? h("span", { class: "muted small", text: `가장 가까운 마감 ${shortDate(p.nextDue)}` }) : null
      ]);
      const team = (label, title, rows) => h("section", { class: "pj-team" }, [
        h("div", { class: "pj-team__head" }, [h("h2", { class: "card__title", title, text: label }), h("span", { class: "muted small", text: `프로젝트 ${rows.length}개 · 항목 ${rows.reduce((n, p) => n + p.total, 0)}개 · 완료 ${rows.reduce((n, p) => n + p.done, 0)}개` })]),
        h("div", { class: "pj-cards" }, rows.map(card))
      ]);
      const sections = unitRows(null).filter(({ u }) => shown.some((p) => p.unitId === u.id)).map(({ u }) => team(unitPath(u.id).map((x) => x.short || x.name).slice(-2).join(" › "), unitLabel(u.id), shown.filter((p) => p.unitId === u.id)));
      const loose = shown.filter((p) => !p.unitId || !unitOf(p.unitId));
      if (loose.length) sections.push(team("팀 없음", null, loose));
      const unitSel = h("button", { class: "select-btn select-btn--sm", type: "button" }, projectFilter.unit && unitOf(projectFilter.unit) ? unitLabel(projectFilter.unit) : h("span", { class: "muted", text: "모든 팀" }));
      unitSel.addEventListener("click", () => unitPicker(unitSel, projectFilter.unit, (id) => { projectFilter.unit = id; draw(); }, { noneLabel: "모든 팀" }));
      setMain("projects", [
        h("div", { class: "page-head" }, [h("h1", { text: "프로젝트" }), h("button", { class: "btn btn--primary page-head__end", type: "button", onclick: () => projectDialog(null, (r) => go(`#/projects/${r.project.id}`)) }, [icon("plus"), "새 프로젝트"])]),
        h("div", { class: "filters" }, [unitSel]),
        sections.length ? h("div", { class: "stack" }, sections) : h("div", { class: "card empty", text: list.length ? "이 팀에는 아직 프로젝트가 없어요." : "아직 볼 수 있는 프로젝트가 없어요." })
      ]);
    };
    page = { name: "projects", reload: async () => { list = (await api("/projects")).projects; draw(); } };
    try { await page.reload(); } catch (e) { if (e.status !== 401) setMain("projects", failed(e)); }
  }
  async function pageProject(id) {
    drawMini(null);
    setMain("projects", loading());
    let data;
    const closed = new Set();
    let statusFilter = "";
    const apply = (r) => { data = r; draw(); };
    function itemDialog(item, defaults) {
      const v = item || defaults;
      const isGroup = v.kind === "group";
      const err = errorLine();
      const name = h("input", { value: item?.name || "", maxlength: "80", autofocus: true });
      const note = h("textarea", { rows: "3", maxlength: "1000" }, item?.note || "");
      const status = h("select", {}, PROJECT_STATUS.map(([k, label]) => h("option", { value: k, text: label })));
      status.value = item?.status || "none";
      const due = h("input", { type: "date", value: item?.dueDate || "" });
      let assignee = item?.assigneeId || null;
      const who = h("button", { class: "select-btn", type: "button" });
      const drawWho = () => who.replaceChildren(assignee ? personLine(assignee) : h("span", { class: "muted", text: "담당자 없음" }));
      drawWho();
      who.addEventListener("click", () => personPicker(who, assignee ? [assignee] : [], false, (uid) => { assignee = uid; drawWho(); }));
      const ok = h("button", { class: "btn btn--primary", type: "submit", text: item ? "저장" : "추가" });
      const form = h("form", { class: "stack", novalidate: true }, [
        field(isGroup ? "묶음 이름" : "항목 이름", name),
        isGroup ? null : h("div", { class: "row2" }, [field("상태", status), field("담당자", who)]),
        isGroup ? null : field("마감일", due),
        field("메모", note), err,
        h("div", { class: "actions" }, [
          item ? h("button", { class: "btn btn--danger-outline btn--sm", type: "button", text: "지우기", onclick: async () => {
            if (!confirm(isGroup ? `'${item.name}' 묶음과 그 안의 항목·입출고 현황을 모두 지울까요?` : `'${item.name}' 항목을 지울까요?`)) return;
            const r = await act(() => api(`/project-items/${item.id}`, { method: "DELETE" }));
            closeDialog(); apply(r);
          } }) : null,
          h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), ok
        ])
      ]);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        busy(ok, async () => {
          try {
            const body = { name: name.value, note: note.value, ...(isGroup ? {} : { status: status.value, assigneeId: assignee, dueDate: due.value || null }) };
            const r = await api(item ? `/project-items/${item.id}` : `/projects/${id}/items`, { method: item ? "PATCH" : "POST", body: item ? body : { ...body, kind: v.kind, parentId: v.parentId || null } });
            closeDialog(); apply(r);
          } catch (ex) { showError(err, ex.message); }
        });
      });
      openDialog(item ? `${isGroup ? "묶음" : "항목"} 고치기` : isGroup ? "묶음 추가" : "항목 추가", form);
    }
    function importDialog() {
      const err = errorLine();
      const area = h("textarea", { rows: "12", autofocus: true, placeholder: "1. 순례자 키트\n* 티셔츠\n* 가방\n4-1. 묵주\n* 매듭 묵주\n※ 묶음에 붙일 메모" });
      const ok = h("button", { class: "btn btn--primary", type: "submit", text: "넣기" });
      const form = h("form", { class: "stack", novalidate: true }, [
        field("목록", area, "'1.' 은 묶음, '4-1.' 은 그 아래 묶음, '*' 는 항목, '※' 는 묶음 메모가 돼요. 이미 있는 항목은 그대로 두고 뒤에 더해요."), err,
        h("div", { class: "actions" }, [h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), ok])
      ]);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        busy(ok, async () => {
          try { const r = await api(`/projects/${id}/import`, { method: "POST", body: { text: area.value } }); closeDialog(); apply(r); }
          catch (ex) { showError(err, ex.message); }
        });
      });
      openDialog("목록 붙여넣기", form);
    }
    const patchItem = async (i, body) => apply(await act(() => api(`/project-items/${i.id}`, { method: "PATCH", body })));
    function draw() {
      const p = data.project;
      document.title = `${p.name} · ${TITLE}`;
      const kids = (pid) => data.items.filter((i) => (i.parentId || null) === pid);
      const inside = (g) => kids(g.id).flatMap((k) => (k.kind === "group" ? inside(k) : [k]));
      const shows = (i) => !statusFilter || i.status === statusFilter;
      const rows = [];
      const walk = (pid, depth) => {
        for (const i of kids(pid)) {
          const pad = `padding-left:${14 + depth * 20}px`;
          if (i.kind === "group") {
            const under = inside(i);
            if (statusFilter && !under.some(shows)) continue;
            const open = !closed.has(i.id);
            rows.push(h("tr", { class: "pj-group" }, [
              h("td", { colspan: "4", style: pad }, h("div", { class: "pj-group__row" }, [
                h("button", { class: "org-row__chev" + (open ? " is-open" : ""), type: "button", "aria-label": `${i.name} ${open ? "접기" : "펼치기"}`, html: ICON.right, onclick: () => { open ? closed.add(i.id) : closed.delete(i.id); draw(); } }),
                h("button", { class: "pj-name", type: "button", onclick: () => itemDialog(i) }, [h("strong", { text: i.name })]),
                h("span", { class: "muted small", text: `${under.filter((x) => x.status === "done").length}/${under.length}` }),
                i.note ? h("span", { class: "muted small pj-note", text: i.note }) : null
              ])),
              h("td", { class: "pj-actions" }, h("button", { class: "link-btn", type: "button", text: "+ 항목", onclick: () => itemDialog(null, { kind: "item", parentId: i.id }) }))
            ]));
            if (open) walk(i.id, depth + 1);
          } else if (shows(i)) {
            const st = h("select", { class: `pj-select pj-st--${i.status}`, "aria-label": `${i.name} 상태`, onchange: (e) => patchItem(i, { status: e.target.value }) }, PROJECT_STATUS.map(([k, label]) => h("option", { value: k, text: label })));
            st.value = i.status;
            const who = h("button", { class: "assignee-btn", type: "button", title: member(i.assigneeId)?.name || "담당자 정하기", onclick: (ev) => personPicker(ev.currentTarget, i.assigneeId ? [i.assigneeId] : [], false, (uid) => patchItem(i, { assigneeId: uid })) }, i.assigneeId ? personLine(i.assigneeId) : h("span", { class: "muted small", text: "담당자" }));
            const due = h("input", { type: "date", class: "inline inline--box", value: i.dueDate || "", "aria-label": `${i.name} 마감일`, onchange: (e) => patchItem(i, { dueDate: e.target.value || null }) });
            rows.push(h("tr", { class: i.status === "done" ? "is-done" : null }, [
              h("td", { class: "pj-itemname", style: pad }, [h("button", { class: "pj-name", type: "button", onclick: () => itemDialog(i), text: i.name }), i.note ? h("small", { class: "muted pj-note", text: i.note }) : null]),
              h("td", { "data-label": "상태" }, st),
              h("td", { "data-label": "담당" }, who),
              h("td", { "data-label": "마감" }, due),
              h("td", { class: "pj-actions" })
            ]));
          }
        }
      };
      walk(null, 0);
      const filter = h("select", { "aria-label": "상태로 거르기", onchange: (e) => { statusFilter = e.target.value; draw(); } }, [h("option", { value: "", text: "모든 상태" }), ...PROJECT_STATUS.map(([k, label]) => h("option", { value: k, text: label }))]);
      filter.value = statusFilter;
      setMain("projects", [
        h("nav", { class: "muted small" }, h("a", { href: "#/projects", text: "프로젝트" })),
        h("div", { class: "page-head page-head--wrap" }, [
          h("h1", { text: p.name }),
          h("span", { class: "muted small", title: p.unitId ? unitLabel(p.unitId) : null, text: p.unitId && unitOf(p.unitId) ? unitShort(p.unitId) : "팀 없음" }),
          h("span", { class: "page-head__end actions" }, [
            h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "고치기", onclick: () => projectDialog(p, apply) }),
            p.canDelete ? h("button", { class: "btn btn--danger-outline btn--sm", type: "button", text: "지우기", onclick: async () => {
              if (!confirm(`'${p.name}' 프로젝트와 그 안의 항목을 모두 지울까요?`)) return;
              await act(() => api(`/projects/${p.id}`, { method: "DELETE" }));
              go("#/projects");
            } }) : null
          ])
        ]),
        p.note ? h("p", { class: "muted pj-desc", text: p.note }) : null,
        projectBar(p),
        h("div", { class: "filters" }, [
          filter,
          h("span", { class: "filters__end actions" }, [
            h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "목록 붙여넣기", onclick: importDialog }),
            h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "+ 묶음", onclick: () => itemDialog(null, { kind: "group" }) }),
            h("button", { class: "btn btn--primary btn--sm", type: "button", text: "+ 항목", onclick: () => itemDialog(null, { kind: "item" }) })
          ])
        ]),
        rows.length ? h("div", { class: "card table-wrap" }, h("table", { class: "table pj-table" }, [
          h("thead", {}, h("tr", {}, [...["이름", "상태", "담당", "마감"].map((t) => h("th", { text: t })), h("th", { "aria-label": "추가" })])),
          h("tbody", {}, rows)
        ])) : h("div", { class: "card empty", text: data.items.length ? "이 상태의 항목이 없어요." : "아직 항목이 없어요. '+ 항목'이나 '목록 붙여넣기'로 넣어 주세요." })
      ]);
    }
    page = { name: "projects", reload: async () => apply(await api(`/projects/${id}`)) };
    try { await page.reload(); } catch (e) { if (e.status !== 401) setMain("projects", failed(e)); }
  }

  /* ---------- 입출고 관리: 단계별로 안내 (기본 정보 → 입고 → 출고 → 재고 확인 → 전달 후) ---------- */
  const STOCK_STEPS = [
    { id: "setup", label: "기본 정보", title: "기본 정보 확인", hint: "단위, 계약 수량, 품목 열을 확인해요. 품목 열은 입고·출고 표의 칸이 돼요." },
    { id: "in", label: "입고", title: "입고 기록", hint: "창고로 들어온 수량을 날짜별로 적어요. 표의 줄을 누르면 고칠 수 있어요." },
    { id: "out", label: "출고", title: "출고 기록", hint: "창고에서 나간 수량과 전달자를 적어요. 표 맨 아래에 품목별 재고가 계산돼요." },
    { id: "left", label: "재고 확인", title: "재고 확인", hint: "품목별 입고, 출고, 재고를 실제 창고 수량과 맞춰 봐요. 다르면 입고·출고 기록을 고쳐요." },
    { id: "after", label: "전달 후 현황", title: "전달 후 현황", hint: "전달한 뒤의 수량과 차이를 봐요. 필요할 때만 쓰는 선택 단계예요." }
  ];
  const stockDone = (s) => ({ setup: s.options > 0, in: s.inTotal > 0, out: s.outTotal > 0, left: s.inTotal > 0 && s.outTotal > 0, after: s.hasAfter });
  const stepNum = (i, done) => h("span", { class: "stock-step__num", html: done ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 13l4 4 10-10"/></svg>' : null, text: done ? null : String(i + 1) });
  // 대장 입력칸 묶음 (만들기 안내와 고치기 대화상자가 함께 씀)
  function ledgerParts(v) {
    const a = v?.ledger.after || {};
    const name = h("input", { value: v?.ledger.name || "", maxlength: "60", autofocus: true, placeholder: "예: 실타래 입출고" });
    const unit = h("input", { value: v?.ledger.unit || "개", maxlength: "10" });
    const inLabel = h("input", { value: v?.ledger.inLabel || "", maxlength: "80", placeholder: "예: 공급처 → 기념품팀" });
    const outLabel = h("input", { value: v?.ledger.outLabel || "", maxlength: "80", placeholder: "예: 기념품팀 → 봉사자" });
    const contract = h("input", { type: "number", min: "0", value: v?.ledger.contract ?? "" });
    let options = (v?.options || []).map((o) => ({ ...o }));
    let add = null;
    const optBox = h("div", { class: "stack stock-opts" });
    const drawOpts = (focus) => {
      add = h("input", { maxlength: "30", placeholder: "품목 이름 (색상·종류) 후 Enter", "aria-label": "품목 추가" });
      const push = (again) => { if (add.value.trim()) { options.push({ name: add.value.trim() }); drawOpts(again); } };
      add.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); push(true); } });
      add.addEventListener("blur", () => push(false));
      optBox.replaceChildren(...options.map((o) => {
        const input = h("input", { value: o.name, maxlength: "30", "aria-label": "품목 이름", oninput: (e) => { o.name = e.target.value; } });
        return h("div", { class: "contact-cat" }, [input, h("button", { class: "icon-btn icon-btn--xs", type: "button", "aria-label": `${o.name} 빼기`, html: ICON.close, onclick: () => { options = options.filter((x) => x !== o); drawOpts(); } })]);
      }), add);
      if (focus) add.focus();
    };
    drawOpts();
    const afterLabel = h("input", { value: a.label || "", maxlength: "40", placeholder: "예: 수녀원 전달" });
    const afterUnit = h("input", { value: a.unit || "", maxlength: "20", placeholder: "예: 자른실" });
    const afterQty = h("input", { type: "number", min: "0", value: a.qty || "" });
    const perLength = h("input", { type: "number", min: "0", value: a.perLength || "" });
    const lengths = h("input", { value: (a.lengths || []).join(", "), placeholder: "예: 9144, 9000, 8800" });
    return {
      name,
      basics: [h("div", { class: "row2" }, [field("이름", name), field("단위", unit)]), field("계약 수량 (선택)", contract, "적으면 미입고 수량을 함께 보여 줘요")],
      routes: h("div", { class: "row2" }, [field("입고 경로 (선택)", inLabel), field("출고 경로 (선택)", outLabel)]),
      opts: h("div", { class: "field" }, [h("span", { class: "field__label", text: "품목 열" }), optBox]),
      after: [
        h("div", { class: "row2" }, [field("전달 이름", afterLabel), field("전달 단위", afterUnit)]),
        field("전달 수량", afterQty),
        h("div", { class: "row2" }, [field("1개당 필요한 길이", perLength, "단위와 길이가 같은 값으로"), field("1단위 길이 후보", lengths, "쉼표로 나눠 적으면 후보별로 계산해요")])
      ],
      flush: () => { if (add.value.trim()) { options.push({ name: add.value.trim() }); drawOpts(); } },
      optionCount: () => options.filter((o) => o.name.trim()).length,
      body: () => ({
        name: name.value, unit: unit.value, inLabel: inLabel.value, outLabel: outLabel.value, contract: contract.value,
        after: { label: afterLabel.value, unit: afterUnit.value, qty: Number(afterQty.value) || 0, perLength: Number(perLength.value) || 0, lengths: lengths.value.split(",").map((x) => Number(x.trim())).filter((x) => x > 0) },
        options: v ? options.filter((o) => o.name.trim()) : options.map((o) => o.name).filter((x) => x.trim())
      })
    };
  }
  // 고치기: 한 화면에 전부 (opts.openAfter 면 전달 후 현황을 펼쳐서)
  function ledgerDialog(v, save, opts) {
    const err = errorLine();
    const parts = ledgerParts(v);
    const ok = h("button", { class: "btn btn--primary", type: "submit", text: "저장" });
    const form = h("form", { class: "stack", novalidate: true }, [
      ...parts.basics, parts.routes, parts.opts,
      h("details", { class: "stock-after", open: !!v.ledger.after?.label || !!opts?.openAfter }, [h("summary", { text: "전달 후 현황 (선택)" }), h("div", { class: "stack" }, parts.after)]),
      err,
      h("div", { class: "actions" }, [h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), ok])
    ]);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      parts.flush();
      busy(ok, async () => { try { await save(parts.body()); } catch (ex) { showError(err, ex.message); } });
    });
    openDialog("입출고 현황 고치기", form);
  }
  // 새로 만들기: 한 단계씩
  async function ledgerWizard(preset) {
    const { projects } = await act(() => api("/projects"));
    if (!projects.length) {
      openDialog("새 입출고 현황", h("div", { class: "stack" }, [
        h("p", { class: "muted", text: "입출고 현황은 프로젝트의 묶음에 속해요. 먼저 프로젝트를 만들어 주세요." }),
        h("div", { class: "actions" }, [h("button", { class: "btn btn--ghost", type: "button", text: "닫기", "data-close": true }), h("a", { class: "btn btn--primary", href: "#/projects", text: "프로젝트로 가기", onclick: () => closeDialog() })])
      ]));
      return;
    }
    const parts = ledgerParts(null);
    const err = errorLine();
    const mine = projects.find((p) => p.unitId === myUnit()) || projects[0];
    const projSel = h("select", { "aria-label": "프로젝트" }, projects.map((p) => h("option", { value: String(p.id), text: p.name })));
    projSel.value = String(preset?.projectId ?? mine.id);
    const groupSel = h("select", { "aria-label": "묶음" });
    const groupHelp = h("p", { class: "muted small", hidden: true, text: "이 프로젝트에는 묶음이 없어요. 프로젝트 화면에서 묶음을 먼저 만들어 주세요." });
    const loadGroups = async () => {
      const groups = (await act(() => api(`/projects/${projSel.value}`))).items.filter((i) => i.kind === "group");
      groupSel.replaceChildren(...groups.map((g) => h("option", { value: String(g.id), text: g.name })));
      groupSel.disabled = !groups.length;
      groupHelp.hidden = groups.length > 0;
    };
    projSel.addEventListener("change", loadGroups);
    await loadGroups();
    if (preset) groupSel.value = String(preset.itemId);
    const need = (cond, msg) => { if (!cond) showError(err, msg); return cond; };
    const steps = [
      { label: "위치", title: "어디에 둘까요?", hint: "대장이 속할 프로젝트와 묶음을 골라요.", body: [h("div", { class: "row2" }, [field("프로젝트", projSel), field("묶음", groupSel)]), groupHelp], check: () => need(!!groupSel.value, "묶음을 골라 주세요.") },
      { label: "이름", title: "무엇을 관리하나요?", hint: "대장 이름과 단위를 적어요. 나머지는 나중에 적어도 돼요.", body: [...parts.basics, parts.routes], check: () => need(parts.name.value.trim(), "이름을 적어 주세요.") },
      { label: "품목", title: "품목을 나눠 볼까요?", hint: "색상이나 종류마다 하나씩 적어요. 입고·출고 표의 칸이 돼요.", body: [parts.opts], check: () => { parts.flush(); return need(parts.optionCount() > 0, "품목을 하나 이상 적어 주세요."); } },
      { label: "전달 후", title: "전달 후 현황도 볼까요?", hint: "필요 없으면 비워 두고 만들어도 돼요. 나중에 추가할 수 있어요.", body: parts.after, check: () => true }
    ];
    let cur = 0;
    const stepper = h("ol", { class: "stock-steps stock-steps--sm", style: `--steps:${steps.length}` });
    const panels = steps.map((s) => h("div", { class: "stack wiz-panel" }, [h("div", {}, [h("h3", { text: s.title }), h("p", { class: "wiz-panel__hint", text: s.hint })]), ...s.body]));
    const ok = h("button", { class: "btn btn--primary", type: "submit" });
    const back = h("button", { class: "btn btn--ghost", type: "button", text: "이전", onclick: () => show(cur - 1) });
    const cancel = h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true });
    function show(i) {
      cur = i;
      stepper.replaceChildren(...steps.map((s, k) => h("li", {}, h("div", { class: "stock-step" + (k === i ? " is-active" : k < i ? " is-done" : ""), "aria-current": k === i ? "step" : null }, [stepNum(k, k < i), h("span", { class: "stock-step__label", text: s.label })]))));
      panels.forEach((p, k) => { p.hidden = k !== i; });
      back.hidden = i === 0;
      ok.textContent = i === steps.length - 1 ? "만들기" : "다음";
      showError(err, "");
      const first = panels[i].querySelector("input, select");
      if (first && dialog.open) first.focus();
    }
    const form = h("form", { class: "stack", novalidate: true }, [stepper, ...panels, err, h("div", { class: "actions" }, [cancel, back, ok])]);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!steps[cur].check()) return;
      if (cur < steps.length - 1) { show(cur + 1); return; }
      busy(ok, async () => {
        try {
          const r = await api(`/project-items/${groupSel.value}/ledgers`, { method: "POST", body: parts.body() });
          closeDialog();
          go(`#/stock/${r.ledger.id}`);
        } catch (ex) { showError(err, ex.message); }
      });
    });
    show(preset ? 1 : 0);
    openDialog("새 입출고 현황", form);
    panels[cur].querySelector("input, select")?.focus();
  }
  // 입출고 관리 목록
  async function pageStocks() {
    drawMini(null);
    setMain("stock", loading());
    document.title = `입출고 관리 · ${TITLE}`;
    let list = [];
    const draw = () => {
      const newBtn = (cls) => h("button", { class: `btn btn--primary ${cls}`, type: "button", onclick: () => ledgerWizard() }, [icon("plus"), "새 입출고 현황"]);
      const card = (l) => {
        const done = stockDone(l);
        const next = STOCK_STEPS.slice(0, 3).find((s) => !done[s.id]);
        return h("a", { class: "card pj-card", href: `#/stock/${l.id}` }, [
          h("strong", { text: l.name }),
          h("div", { class: "stock-card__nums" }, [`입고 ${fmtN(l.inTotal)}`, h("span", { text: `출고 ${fmtN(l.outTotal)}` }), h("strong", { class: l.inTotal - l.outTotal < 0 ? "stock-minus" : null, text: `재고 ${fmtN(l.inTotal - l.outTotal)} ${l.unit}` })]),
          h("div", { class: "stock-dots", "aria-hidden": "true" }, STOCK_STEPS.map((s) => h("i", { class: done[s.id] ? "is-done" : null, title: s.label }))),
          h("span", { class: next ? "stock-card__next" : "muted small", text: next ? `다음 단계: ${next.label}` : "기록 단계 완료" })
        ]);
      };
      // 묶음(예: 묵주)마다 제목을 두고 그 아래에 대장
      const groups = [...new Set(list.map((l) => l.itemId))].map((itemId) => list.filter((l) => l.itemId === itemId));
      const sections = groups.map((rows) => {
        const { itemId, itemName, projectId, projectName, unitId } = rows[0];
        const team = unitId && unitOf(unitId) ? unitShort(unitId) : "";
        return h("section", { class: "pj-team stock-group" }, [
          h("div", { class: "pj-team__head" }, [
            h("h2", { class: "stock-group__name", text: itemName }),
            h("span", { class: "muted small", text: [team, projectName, `대장 ${rows.length}개`].filter(Boolean).join(" · ") }),
            h("button", { class: "link-btn stock-group__add", type: "button", text: "+ 대장", "aria-label": `${itemName}에 입출고 대장 추가`, onclick: () => ledgerWizard({ projectId, itemId }) })
          ]),
          h("div", { class: "pj-cards" }, rows.map(card))
        ]);
      });
      setMain("stock", [
        h("div", { class: "page-head" }, [h("h1", { text: "입출고 관리" }), newBtn("page-head__end")]),
        list.length ? h("div", { class: "stack" }, sections) : h("div", { class: "card stock-guide stack" }, [
          h("h2", { text: "이런 순서로 관리해요" }),
          h("ol", { class: "stock-how" }, STOCK_STEPS.map((s, i) => h("li", {}, [stepNum(i), h("div", {}, [h("strong", { text: s.label }), h("span", { class: "muted small", text: s.hint })])]))),
          h("div", {}, newBtn(""))
        ])
      ]);
    };
    page = { name: "stock", reload: async () => { list = (await api("/stock")).ledgers; draw(); } };
    try { await page.reload(); } catch (e) { if (e.status !== 401) setMain("stock", failed(e)); }
  }
  async function pageStock(id) {
    drawMini(null);
    setMain("stock", loading());
    let data, step = store.get(`ps.stockStep.${id}`, "");
    const edit = (opts) => ledgerDialog(data, async (body) => { const r = await api(`/stock/${id}`, { method: "PATCH", body }); closeDialog(); apply(r); }, opts);
    const apply = (r) => { data = r; draw(); };
    function moveDialog(type, m) {
      const err = errorLine();
      const date = h("input", { value: m?.date || today(), maxlength: "20", autofocus: true, placeholder: today() });
      const handler = h("input", { value: m?.handler || "", maxlength: "40" });
      const note = h("textarea", { rows: "2", maxlength: "500" }, m?.note || "");
      const sum = h("strong");
      const inputs = data.options.map((o) => ({ o, el: h("input", { type: "number", min: "0", inputmode: "numeric", value: m?.qty[o.id] || "", "aria-label": o.name, oninput: () => drawSum() }) }));
      const drawSum = () => { sum.textContent = `합계 ${fmtN(inputs.reduce((n, x) => n + (Number(x.el.value) || 0), 0))} ${data.ledger.unit}`; };
      drawSum();
      const ok = h("button", { class: "btn btn--primary", type: "submit", text: m ? "저장" : "추가" });
      const form = h("form", { class: "stack", novalidate: true }, [
        h("div", { class: "row2" }, [field(type === "in" ? "입고일" : "출고일", date), type === "out" ? field("전달자", handler) : null]),
        inputs.length ? h("div", { class: "stock-grid" }, inputs.map((x) => h("label", { class: "stock-grid__cell" }, [h("span", { class: "small", text: x.o.name }), x.el]))) : h("p", { class: "muted small", text: "먼저 1단계 기본 정보에서 품목 열을 추가해 주세요." }),
        sum, field("비고", note), err,
        h("div", { class: "actions" }, [
          m ? h("button", { class: "btn btn--danger-outline btn--sm", type: "button", text: "지우기", onclick: async () => {
            if (!confirm(`${m.date} 기록을 지울까요?`)) return;
            const r = await act(() => api(`/stock-moves/${m.id}`, { method: "DELETE" }));
            closeDialog(); apply(r);
          } }) : null,
          h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), ok
        ])
      ]);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        busy(ok, async () => {
          try {
            const qty = Object.fromEntries(inputs.map((x) => [x.o.id, x.el.value]));
            const body = { date: date.value, handler: handler.value, note: note.value, qty };
            const r = await api(m ? `/stock-moves/${m.id}` : `/stock/${id}/moves`, { method: m ? "PATCH" : "POST", body: m ? body : { ...body, type } });
            closeDialog(); apply(r);
          } catch (ex) { showError(err, ex.message); }
        });
      });
      openDialog(`${type === "in" ? "입고" : "출고"} ${m ? "고치기" : "추가"}`, form);
    }
    function draw() {
      const { ledger: l, options, moves } = data;
      document.title = `${l.name} · ${TITLE}`;
      const sumOf = (type, oid) => moves.filter((m) => m.type === type).reduce((n, m) => n + (oid ? m.qty[oid] || 0 : Object.values(m.qty).reduce((a, b) => a + b, 0)), 0);
      const inAll = sumOf("in"), outAll = sumOf("out"), stock = inAll - outAll;
      const stat = (label, n, warn) => h("div", { class: "card unit-stat" + (warn ? " is-warn" : "") }, [h("strong", { text: fmtN(n) }), h("span", { text: `${label} (${l.unit})` })]);
      const pct = (n) => (inAll ? `${((n / inAll) * 100).toFixed(1)}%` : "-");
      const num = (n, cls) => h("td", { class: "num" + (cls ? ` ${cls}` : ""), text: n ? fmtN(n) : "-" });
      const table = (type) => {
        const list = moves.filter((m) => m.type === type);
        const isOut = type === "out";
        let running = 0;
        const body = list.map((m, i) => {
          const day = Object.values(m.qty).reduce((a, b) => a + b, 0);
          running += day;
          return h("tr", { class: "stock-row", tabindex: "0", title: "눌러서 고치기", onclick: () => moveDialog(type, m), onkeydown: (e) => { if (e.key === "Enter") moveDialog(type, m); } }, [
            h("td", { class: "num muted", text: String(i + 1) }), h("td", { class: "nowrap", text: m.date }),
            ...options.map((o) => num(m.qty[o.id])), num(day, "stock-strong"), num(running),
            isOut ? h("td", { text: m.handler || "-" }) : null, h("td", { class: "stock-note", text: m.note })
          ]);
        });
        const colsAfter = isOut ? 2 : 1;
        return h("section", { class: "stock-sec" }, [
          h("div", { class: "card__head" }, [
            h("h2", { class: "card__title" }, [isOut ? "출고 현황 " : "입고 현황 ", h("span", { class: "muted small", text: isOut ? l.outLabel : l.inLabel })]),
            h("button", { class: "btn btn--primary btn--sm", type: "button", onclick: () => moveDialog(type) }, [icon("plus"), isOut ? "출고 추가" : "입고 추가"])
          ]),
          h("div", { class: "card table-wrap" }, h("table", { class: "table stock-table" }, [
            h("thead", {}, h("tr", {}, [h("th", { class: "num", text: "순번" }), h("th", { text: isOut ? "출고일" : "입고일" }), ...options.map((o) => h("th", { class: "num", text: o.name })), h("th", { class: "num", text: "일계" }), h("th", { class: "num", text: "누계" }), isOut ? h("th", { text: "전달자" }) : null, h("th", { text: "비고" })])),
            h("tbody", {}, body.length ? body : h("tr", {}, h("td", { colspan: String(options.length + 4 + colsAfter), class: "muted empty", text: "아직 기록이 없어요." }))),
            h("tfoot", {}, [
              h("tr", {}, [h("th", { colspan: "2", text: "합계" }), ...options.map((o) => num(sumOf(type, o.id))), num(sumOf(type)), h("td", { colspan: String(1 + colsAfter) })]),
              h("tr", { class: "muted" }, [h("th", { colspan: "2", text: "입고 합계 대비" }), ...options.map((o) => h("td", { class: "num", text: pct(sumOf(type, o.id)) })), h("td", { class: "num", text: pct(sumOf(type)) }), h("td", { colspan: String(1 + colsAfter) })]),
              isOut ? h("tr", { class: "stock-left" }, [h("th", { colspan: "2", text: "창고 재고" }), ...options.map((o) => { const n = sumOf("in", o.id) - sumOf("out", o.id); return num(n, n < 0 ? "stock-minus" : ""); }), num(stock, stock < 0 ? "stock-minus" : ""), h("td", { colspan: String(1 + colsAfter) })]) : null
            ])
          ]))
        ]);
      };
      // 전달 후 현황: 길이 후보가 있으면 후보별 계산, 없으면 출고와 전달 수량 비교
      const a = l.after || {};
      let after = null;
      if (a.label) {
        const unitName = a.unit || l.unit;
        const lens = a.perLength > 0 ? a.lengths || [] : [];
        const line = (label, cells, cls) => h("tr", { class: cls || null }, [h("th", { text: label }), ...cells.map((c) => h("td", { class: "num", text: fmtN(c) }))]);
        const each = lens.map((x) => Math.floor(x / a.perLength));
        after = h("section", { class: "stock-sec" }, [
          h("div", { class: "card__head" }, [h("h2", { class: "card__title" }, ["전달 후 현황 ", h("span", { class: "muted small", text: a.label })]), h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "고치기", onclick: () => edit({ openAfter: true }) })]),
          h("div", { class: "card table-wrap" }, h("table", { class: "table stock-table stock-after-table" }, lens.length ? [
            h("thead", {}, h("tr", {}, [h("th", { text: `1${l.unit} 길이` }), ...lens.map((x) => h("th", { class: "num", text: fmtN(x) }))])),
            h("tbody", {}, [
              line(`1${l.unit}당 ${unitName} 수 (1개 ${fmtN(a.perLength)})`, each),
              l.contract ? line(`계약 ${fmtN(l.contract)}${l.unit} 기준 예상 ${unitName}`, each.map((k) => k * l.contract)) : null,
              line(`출고 ${fmtN(outAll)}${l.unit} 기준 예상 ${unitName}`, each.map((k) => k * outAll)),
              line(`${a.label} ${unitName}`, each.map(() => a.qty)),
              line("차이", each.map((k) => k * outAll - a.qty), "stock-left"),
              line(`차이의 ${l.unit} 환산`, each.map((k) => (k ? (k * outAll - a.qty) / k : 0)))
            ])
          ] : h("tbody", {}, [line(`출고 합계 (${l.unit})`, [outAll]), line(`${a.label} ${unitName}`, [a.qty]), line("차이", [outAll - a.qty], "stock-left")])))
        ]);
      }
      const summary = { options: options.length, inTotal: inAll, outTotal: outAll, hasAfter: !!a.label };
      const done = stockDone(summary);
      // 저장해 둔 단계가 없으면 아직 안 한 첫 단계부터, 다 했으면 재고 확인
      if (!STOCK_STEPS.some((s) => s.id === step)) step = STOCK_STEPS.slice(0, 3).find((s) => !done[s.id])?.id || "left";
      const at = STOCK_STEPS.findIndex((s) => s.id === step);
      const pick = (sid) => { step = sid; store.set(`ps.stockStep.${id}`, sid); draw(); window.scrollTo(0, 0); };
      const setupPanel = () => h("div", { class: "stock-sec" }, [
        h("div", { class: "card__head" }, [h("h2", { class: "card__title", text: "대장 정보" }), h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "고치기", onclick: () => edit() })]),
        h("dl", { class: "card stock-info" }, [
          h("dt", { text: "위치" }), h("dd", {}, [h("a", { href: `#/projects/${data.project.id}`, text: data.project.name }), ` › ${data.itemName}`]),
          h("dt", { text: "단위" }), h("dd", { text: l.unit }),
          h("dt", { text: "계약 수량" }), h("dd", { text: l.contract ? `${fmtN(l.contract)} ${l.unit}` : "정하지 않음" }),
          h("dt", { text: "입고 경로" }), h("dd", { text: l.inLabel || "-" }),
          h("dt", { text: "출고 경로" }), h("dd", { text: l.outLabel || "-" }),
          h("dt", { text: `품목 ${options.length}개` }), h("dd", {}, options.length ? h("div", { class: "stock-chips" }, options.map((o) => h("span", { text: o.name }))) : "아직 없어요. '고치기'에서 추가해 주세요.")
        ])
      ]);
      const leftPanel = () => h("div", { class: "stock-sec" }, h("div", { class: "card table-wrap" }, h("table", { class: "table stock-table" }, [
        h("thead", {}, h("tr", {}, [h("th", { text: "품목" }), h("th", { class: "num", text: "입고" }), h("th", { class: "num", text: "출고" }), h("th", { class: "num", text: "재고" }), h("th", { class: "num", text: "입고 대비 출고" })])),
        h("tbody", {}, options.map((o) => {
          const i = sumOf("in", o.id), u = sumOf("out", o.id);
          return h("tr", {}, [h("td", { text: o.name }), num(i), num(u), num(i - u, i - u < 0 ? "stock-minus stock-strong" : "stock-strong"), h("td", { class: "num muted", text: i ? `${((u / i) * 100).toFixed(1)}%` : "-" })]);
        })),
        h("tfoot", {}, h("tr", {}, [h("th", { text: "합계" }), num(inAll), num(outAll), num(stock, stock < 0 ? "stock-minus" : ""), h("td", { class: "num", text: pct(outAll) })]))
      ])));
      const afterPanel = () => after || h("div", { class: "card stock-empty stock-sec" }, [
        h("p", { text: "아직 전달 후 현황을 적지 않았어요. 필요 없으면 건너뛰어도 돼요." }),
        h("button", { class: "btn btn--primary btn--sm", type: "button", text: "전달 후 현황 적기", onclick: () => edit({ openAfter: true }) })
      ]);
      const panel = { setup: setupPanel, in: () => table("in"), out: () => table("out"), left: leftPanel, after: afterPanel }[step]();
      const cur = STOCK_STEPS[at], prev = STOCK_STEPS[at - 1], next = STOCK_STEPS[at + 1];
      setMain("stock", [
        h("nav", { class: "muted small" }, [h("a", { href: "#/stock", text: "입출고 관리" }), ` › ${data.itemName} › ${l.name}`]),
        h("div", { class: "page-head page-head--wrap" }, [
          h("h1", { text: l.name }),
          l.canDelete ? h("span", { class: "page-head__end actions" }, h("button", { class: "btn btn--danger-outline btn--sm", type: "button", text: "지우기", onclick: async () => {
            if (!confirm(`'${l.name}' 입출고 현황과 모든 기록을 지울까요?`)) return;
            await act(() => api(`/stock/${id}`, { method: "DELETE" }));
            go("#/stock");
          } })) : null
        ]),
        h("div", { class: "unit-stats" }, [
          l.contract ? stat("계약", l.contract) : null, stat("입고", inAll), l.contract ? stat("미입고", l.contract - inAll) : null, stat("출고", outAll), stat("창고 재고", stock, stock < 0)
        ]),
        h("ol", { class: "stock-steps", "aria-label": "진행 단계" }, STOCK_STEPS.map((s, i) => h("li", {}, h("button", { class: "stock-step" + (s.id === step ? " is-active" : "") + (done[s.id] ? " is-done" : ""), type: "button", "aria-current": s.id === step ? "step" : null, onclick: () => pick(s.id) }, [stepNum(i, done[s.id]), h("span", { class: "stock-step__label", text: s.label })])))),
        h("div", { class: "card stock-guide" }, [h("span", { class: "stock-guide__count", text: `${at + 1} / ${STOCK_STEPS.length}단계` }), h("h2", { text: cur.title }), h("p", { text: cur.hint })]),
        panel,
        h("div", { class: "stock-nav" }, [
          prev ? h("button", { class: "btn btn--ghost", type: "button", text: `이전: ${prev.label}`, onclick: () => pick(prev.id) }) : null,
          next ? h("button", { class: "btn btn--primary", type: "button", text: `다음: ${next.label}`, onclick: () => pick(next.id) }) : h("a", { class: "btn btn--primary", href: "#/stock", text: "목록으로" })
        ])
      ]);
    }
    page = { name: "stock", reload: async () => apply(await api(`/stock/${id}`)) };
    try { await page.reload(); } catch (e) { if (e.status !== 401) setMain("stock", failed(e)); }
  }

  /* ---------- 봉사자 화면: 직원 화면과 따로 (일정·기본 교육·기념품팀 프로젝트) ---------- */
  const volDay = (s) => parseYmd(s).toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "short" });
  const volTime = (x) => (x.startTime ? (x.endTime ? `${x.startTime}~${x.endTime}` : x.startTime) : "");
  let volSeq = 0;
  function renderVolunteer() {
    layout.main = null;
    const seq = ++volSeq;
    const { name, id } = route();
    const tab = ["vschedule", "vtraining", "vprojects"].includes(name) ? name : "vhome";
    document.title = `봉사자 · ${TITLE}`;
    const account = h("button", { class: "vol__account", type: "button", "aria-label": "내 계정" }, [h("strong", { text: state.user.name }), icon("right")]);
    account.addEventListener("click", () => popover(account, h("div", { class: "pop__list" }, [
      h("button", { type: "button", class: "pop__item", onclick: () => { closePop(); openDialog("비밀번호 변경", passwordForm(closeDialog)); } }, "비밀번호 변경"),
      h("button", { type: "button", class: "pop__item", onclick: () => { closePop(); logout(); } }, "로그아웃")
    ])));
    const main = h("main", { class: "vol__main", id: "main" }, loading());
    const navLink = (k, label) => h("a", { class: "vol__tab" + (k === tab ? " is-active" : ""), href: `#/${k}`, "aria-current": k === tab ? "page" : null, text: label });
    app.replaceChildren(h("div", { class: "vol" }, [
      h("header", { class: "vol__bar" }, [h("span", { class: "brand" }, [h("img", { src: "favicon.svg", alt: "" }), h("span", { text: TITLE })]), h("span", { class: "vol__tag", text: "봉사자" }), account]),
      h("nav", { class: "vol__nav", "aria-label": "봉사자 메뉴" }, [navLink("vhome", "대시보드"), navLink("vschedule", "일정"), navLink("vtraining", "기본 교육"), navLink("vprojects", "프로젝트")]),
      main
    ]));
    const show = (...kids) => { if (seq === volSeq) fill(main, ...kids); };
    const load = async () => {
      if (tab === "vprojects") {
        if (id) {
          const d = await api(`/volunteer/projects/${Number(id)}`);
          return show(volProject(d));
        }
        const { projects } = await api("/volunteer/projects");
        return show(volProjects(projects));
      }
      const d = await api("/volunteer/home");
      if (tab === "vschedule") return show(volSchedules(d.schedules));
      if (tab === "vtraining") return show(volTrainings(d.trainings));
      return show(volHome(d));
    };
    load().catch((e) => { if (e.status !== 401) show(failed(e)); });
  }
  const volSchedRow = (s) => h("li", { class: "vol-sched" }, [
    h("div", { class: "vol-sched__when" }, [h("strong", { text: volDay(s.date) }), volTime(s) ? h("span", { class: "muted small", text: volTime(s) }) : null]),
    h("div", { class: "vol-sched__what" }, [
      h("strong", { text: s.title }),
      s.place ? h("span", { class: "muted small", text: s.place }) : null,
      s.note ? h("p", { class: "vol-pre small", text: s.note }) : null
    ])
  ]);
  function volHome({ schedules, trainings }) {
    const next = schedules.filter((s) => s.date >= today()).slice(0, 3);
    const doneN = trainings.filter((t) => t.done).length;
    const todo = trainings.filter((t) => !t.done).slice(0, 3);
    const when = new Date().toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "long" });
    const more = (href, text) => h("a", { class: "link-btn", href, text });
    return [
      h("p", { class: "muted", text: when }),
      h("h1", { class: "vol__hello", text: `${state.user.name}님, 안녕하세요` }),
      h("div", { class: "vol__cards" }, [
        h("section", { class: "card vol__card" }, [
          h("div", { class: "card__head" }, [h("h2", { class: "card__title", text: "내 봉사 일정" }), more("#/vschedule", "전체 보기")]),
          next.length ? h("ul", { class: "vol-list" }, next.map(volSchedRow)) : h("p", { class: "muted", text: "다가오는 일정이 없어요." })
        ]),
        h("section", { class: "card vol__card" }, [
          h("div", { class: "card__head" }, [h("h2", { class: "card__title", text: "기본 교육" }), more("#/vtraining", "전체 보기")]),
          trainings.length ? h("p", { class: "muted", text: `${trainings.length}개 중 ${doneN}개 이수` }) : h("p", { class: "muted", text: "아직 등록된 교육이 없어요." }),
          todo.length ? h("ul", { class: "vol-todo" }, todo.map((t) => h("li", { text: t.title }))) : null
        ]),
        h("section", { class: "card vol__card" }, [
          h("div", { class: "card__head" }, [h("h2", { class: "card__title", text: "기념품팀 프로젝트" }), more("#/vprojects", "보기")]),
          h("p", { class: "muted", text: "진행 상황을 볼 수 있어요." })
        ])
      ])
    ];
  }
  function volSchedules(list) {
    const up = list.filter((s) => s.date >= today());
    const past = list.filter((s) => s.date < today()).reverse();
    return [
      h("h1", { class: "vol__hello", text: "일정" }),
      up.length ? h("ul", { class: "card vol__card vol-list" }, up.map(volSchedRow)) : h("div", { class: "card empty", text: "다가오는 일정이 없어요." }),
      past.length ? h("details", { class: "vol-past" }, [h("summary", { text: `지난 일정 ${past.length}개` }), h("ul", { class: "card vol__card vol-list" }, past.map(volSchedRow))]) : null
    ];
  }
  function volTrainings(list) {
    const doneN = list.filter((t) => t.done).length;
    const toggle = async (t, btn) => {
      await busy(btn, () => act(() => api(`/volunteer/trainings/${t.id}/done`, { method: "POST", body: { done: !t.done } }))).then(render, () => {});
    };
    return [
      h("h1", { class: "vol__hello", text: "기본 교육" }),
      list.length ? h("p", { class: "muted", text: `${list.length}개 중 ${doneN}개 이수` }) : null,
      list.length ? h("div", { class: "stack" }, list.map((t) => {
        const meta = [t.date ? volDay(t.date) : "", t.startTime, t.place].filter(Boolean).join(" · ");
        const btn = h("button", { class: `btn btn--sm ${t.done ? "btn--ghost" : "btn--primary"}`, type: "button", text: t.done ? "이수 취소" : "이수했어요", onclick: () => toggle(t, btn) });
        return h("section", { class: "card vol__card" }, [
          h("div", { class: "card__head" }, [h("h2", { class: "card__title", text: t.title }), t.done ? h("span", { class: "vol-done", text: "이수 완료" }) : null]),
          meta ? h("p", { class: "muted small", text: meta }) : null,
          t.body ? h("p", { class: "vol-pre", text: t.body }) : null,
          t.link ? h("p", {}, h("a", { class: "link-btn", href: t.link, target: "_blank", rel: "noopener noreferrer", text: "교육 자료 열기" })) : null,
          h("div", { class: "vol-actions" }, btn)
        ]);
      })) : h("div", { class: "card empty", text: "아직 등록된 교육이 없어요." })
    ];
  }
  function volProjects(list) {
    return [
      h("h1", { class: "vol__hello", text: "기념품팀 프로젝트" }),
      list.length ? h("div", { class: "pj-cards" }, list.map((p) => h("a", { class: "card pj-card", href: `#/vprojects/${p.id}` }, [
        h("strong", { text: p.name }),
        p.note ? h("p", { class: "pj-card__note muted small", text: p.note }) : null,
        h("span", { class: "muted small", text: `항목 ${p.total}개 · 완료 ${p.done}개` })
      ]))) : h("div", { class: "card empty", text: "아직 볼 수 있는 프로젝트가 없어요." })
    ];
  }
  function volProject({ project, items }) {
    const kids = (pid) => items.filter((i) => i.parentId === pid);
    const itemRow = (i) => h("li", { class: "vol-item" }, [
      h("div", { class: "vol-item__head" }, [h("span", { text: i.name }), h("span", { class: `pj-st pj-st--${i.status}`, text: projectStatusLabel(i.status) }), i.dueDate ? h("span", { class: "muted small", text: `마감 ${shortDate(i.dueDate)}` }) : null]),
      i.note ? h("p", { class: "vol-pre small muted", text: i.note }) : null
    ]);
    const list = (pid) => {
      const rows = kids(pid);
      const plain = rows.filter((i) => i.kind !== "group");
      const groups = rows.filter((i) => i.kind === "group");
      return [
        plain.length ? h("ul", { class: "vol-items" }, plain.map(itemRow)) : null,
        ...groups.map((g) => h("div", { class: "vol-group" }, [h("h3", { class: "vol-group__name", text: g.name }), g.note ? h("p", { class: "vol-pre small muted", text: g.note }) : null, ...list(g.id)]))
      ];
    };
    return [
      h("nav", { class: "muted small" }, h("a", { href: "#/vprojects", text: "프로젝트" })),
      h("h1", { class: "vol__hello", text: project.name }),
      project.note ? h("p", { class: "vol-pre muted", text: project.note }) : null,
      h("p", { class: "muted small", text: "읽기 전용이에요." }),
      h("div", { class: "card vol__card" }, items.length ? list(null) : h("p", { class: "muted", text: "아직 항목이 없어요." }))
    ];
  }

  /* ---------- 봉사자 관리 (관리자): 일정·기본 교육 등록, 이수 현황 ---------- */
  async function pageVolAdmin() {
    if (!isAdmin()) return go("#/today");
    document.title = `봉사자 관리 · ${TITLE}`;
    drawMini(null);
    setMain("volunteers", loading());
    const tab = route().id === "training" ? "training" : "schedule";
    let vols = [], schedules = [], trainings = [];
    const seg = h("div", { class: "seg", role: "tablist" }, [["schedule", "일정"], ["training", "기본 교육"]].map(([k, label]) => h("button", { type: "button", role: "tab", "aria-selected": String(k === tab), text: label, onclick: () => go(k === "training" ? "#/volunteers/training" : "#/volunteers") })));
    const dateAndTime = (date, start, end) => h("div", { class: "row2" }, [field("날짜", date), h("div", { class: "row2" }, [field("시작", start), end ? field("끝", end) : h("span")])]);
    const saveForm = (form, ok, err, send) => form.addEventListener("submit", (e) => {
      e.preventDefault();
      busy(ok, async () => { try { await send(); closeDialog(); await page.reload(); } catch (ex) { showError(err, ex.message); } });
    });
    const delBtn = (label, url) => h("button", { class: "btn btn--danger-outline btn--sm", type: "button", text: "지우기", onclick: async () => {
      if (!confirm(`'${label}'을(를) 지울까요?`)) return;
      await act(() => api(url, { method: "DELETE" }));
      closeDialog(); await page.reload();
    } });
    function scheduleDialog(s) {
      const err = errorLine();
      const title = h("input", { value: s?.title || "", maxlength: "120", autofocus: true, placeholder: "예: 11월 기념품 포장 봉사" });
      const date = h("input", { type: "date", value: s?.date || today() });
      const start = h("input", { type: "time", value: s?.startTime || "" });
      const end = h("input", { type: "time", value: s?.endTime || "" });
      const place = h("input", { value: s?.place || "", maxlength: "120" });
      const note = h("textarea", { rows: "3", maxlength: "1000" }, s?.note || "");
      let audience = s?.audience || "all";
      const picked = new Set(s?.userIds || []);
      const box = h("div", { class: "vol-pick" });
      const drawBox = () => {
        box.hidden = audience !== "some";
        box.replaceChildren(...(vols.length ? vols.map((u) => {
          const c = h("input", { type: "checkbox", checked: picked.has(u.id), onchange: (e) => { if (e.target.checked) picked.add(u.id); else picked.delete(u.id); } });
          return h("label", { class: "vol-pick__row" }, [c, h("span", { text: u.name })]);
        }) : [h("p", { class: "muted small", text: "아직 봉사자 계정이 없어요." })]));
      };
      drawBox();
      const seg2 = h("div", { class: "seg seg--sm" }, [["all", "봉사자 전체"], ["some", "개인 지정"]].map(([k, label]) => h("button", { type: "button", "aria-selected": String(k === audience), text: label, onclick: (ev) => { audience = k; seg2.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b === ev.currentTarget))); drawBox(); } })));
      const ok = h("button", { class: "btn btn--primary", type: "submit", text: s ? "저장" : "등록" });
      const form = h("form", { class: "stack", novalidate: true }, [
        field("제목", title), h("div", { class: "row2" }, [field("날짜", date), h("div", { class: "row2" }, [field("시작", start), field("끝", end)])]), field("장소", place), field("메모", note),
        h("div", { class: "field" }, [h("span", { class: "field__label", text: "대상" }), seg2, box]), err,
        h("div", { class: "actions" }, [s ? delBtn(s.title, `/admin/vol-schedules/${s.id}`) : null, h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), ok])
      ]);
      saveForm(form, ok, err, () => api(s ? `/admin/vol-schedules/${s.id}` : "/admin/vol-schedules", { method: s ? "PATCH" : "POST", body: { title: title.value, date: date.value, startTime: start.value, endTime: end.value, place: place.value, note: note.value, audience, userIds: [...picked] } }));
      openDialog(s ? "봉사 일정 고치기" : "봉사 일정 등록", form, { admin: true });
    }
    function trainingDialog(t) {
      const err = errorLine();
      const title = h("input", { value: t?.title || "", maxlength: "120", autofocus: true, placeholder: "예: 봉사자 기본 안내 교육" });
      const date = h("input", { type: "date", value: t?.date || "" });
      const start = h("input", { type: "time", value: t?.startTime || "" });
      const place = h("input", { value: t?.place || "", maxlength: "120" });
      const link = h("input", { type: "url", value: t?.link || "", maxlength: "500", placeholder: "https://" });
      const body = h("textarea", { rows: "5", maxlength: "5000" }, t?.body || "");
      const ok = h("button", { class: "btn btn--primary", type: "submit", text: t ? "저장" : "등록" });
      const doneBox = t ? h("div", { class: "field" }, [
        h("span", { class: "field__label", text: `이수 ${t.doneBy.length} / ${vols.length}명` }),
        vols.length ? h("div", { class: "stock-chips" }, vols.map((u) => { const d = t.doneBy.some((x) => x.id === u.id); return h("span", { class: d ? "vol-chip is-done" : "vol-chip", text: `${d ? "✓ " : ""}${u.name}` }); })) : h("p", { class: "muted small", text: "아직 봉사자 계정이 없어요." })
      ]) : null;
      const form = h("form", { class: "stack", novalidate: true }, [
        field("제목", title), field("내용", body), dateAndTime(date, start), field("장소", place), field("자료 링크", link, "http 또는 https 주소"), doneBox, err,
        h("div", { class: "actions" }, [t ? delBtn(t.title, `/admin/vol-trainings/${t.id}`) : null, h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), ok])
      ]);
      saveForm(form, ok, err, () => api(t ? `/admin/vol-trainings/${t.id}` : "/admin/vol-trainings", { method: t ? "PATCH" : "POST", body: { title: title.value, body: body.value, date: date.value, startTime: start.value, place: place.value, link: link.value } }));
      openDialog(t ? "기본 교육 고치기" : "기본 교육 등록", form, { admin: true });
    }
    const rowAttrs = (fn) => ({ class: "stock-row", tabindex: "0", onclick: fn, onkeydown: (e) => { if (e.key === "Enter") fn(); } });
    const draw = () => {
      const scheduleView = schedules.length ? h("div", { class: "card table-wrap" }, h("table", { class: "table" }, [
        h("thead", {}, h("tr", {}, ["날짜", "시간", "제목", "장소", "대상"].map((x) => h("th", { text: x })))),
        h("tbody", {}, schedules.map((s) => h("tr", rowAttrs(() => scheduleDialog(s)), [
          h("td", { class: "nowrap", text: volDay(s.date) }), h("td", { class: "nowrap", text: volTime(s) || "-" }), h("td", { text: s.title }), h("td", { text: s.place || "-" }),
          h("td", { text: s.audience === "all" ? "전체" : s.userIds.map((id) => vols.find((u) => u.id === id)?.name).filter(Boolean).join(", ") || "지정 없음" })
        ])))
      ])) : h("div", { class: "card empty", text: "아직 등록한 일정이 없어요." });
      const trainingView = trainings.length ? h("div", { class: "card table-wrap" }, h("table", { class: "table" }, [
        h("thead", {}, h("tr", {}, ["제목", "일시", "장소", "이수"].map((x) => h("th", { text: x })))),
        h("tbody", {}, trainings.map((t) => h("tr", rowAttrs(() => trainingDialog(t)), [
          h("td", { text: t.title }), h("td", { class: "nowrap", text: [t.date ? volDay(t.date) : "", t.startTime].filter(Boolean).join(" ") || "-" }), h("td", { text: t.place || "-" }), h("td", { class: "nowrap", text: `${t.doneBy.length} / ${vols.length}명` })
        ])))
      ])) : h("div", { class: "card empty", text: "아직 등록한 교육이 없어요." });
      setMain("volunteers", [
        h("div", { class: "page-head" }, [
          h("h1", { text: "봉사자 관리" }),
          h("button", { class: "btn btn--primary page-head__end", type: "button", onclick: () => (tab === "training" ? trainingDialog() : scheduleDialog()) }, [icon("plus"), tab === "training" ? "교육 등록" : "일정 등록"])
        ]),
        h("div", { class: "filters" }, [seg, h("span", { class: "muted small", text: `봉사자 ${vols.length}명` })]),
        tab === "training" ? trainingView : scheduleView
      ]);
    };
    page = { name: "volunteers", reload: async () => {
      const [u, s, t] = await Promise.all([api("/admin/users"), api("/admin/vol-schedules"), api("/admin/vol-trainings")]);
      vols = u.users.filter((x) => x.role === "volunteer");
      schedules = s.schedules; trainings = t.trainings;
      draw();
    } };
    try { await page.reload(); } catch (e) { if (e.status !== 401) setMain("volunteers", failed(e)); }
  }

  /* ---------- 시작 ---------- */
  function render() {
    if (!state.user) return;
    volunteerTheme(state.user.role === "volunteer");
    if (state.user.mustChangePassword) { layout.main = null; return renderForcedPassword(); }
    if (state.user.role === "volunteer") { closeDialog(); closePop(); return renderVolunteer(); }
    if (!layout.main || !app.contains(layout.main)) buildLayout();
    closeDialog();
    closePop();
    toggleNav(false);
    const { name, id } = route();
    window.scrollTo(0, 0);
    if (name === "today") return pageToday(id && /^\d{4}-\d{2}-\d{2}$/.test(id) ? id : null);
    if (name === "dashboard") return pageDashboard("mine");
    if (name === "alldash") return pageDashboard("all");
    if (name === "tasks") return pageTasks();
    if (name === "meetings") return pageMeetings();
    if (name === "memos") return pageMemos();
    if (name === "notices" && id) return pageNotice(Number(id));
    if (name === "notices") return pageNotices();
    if (name === "members") return pageMembers();
    if (name === "volunteers") return pageVolAdmin();
    if (name === "org") return pageOrg();
    if (name === "stock" && id) return pageStock(Number(id));
    if (name === "stock") return pageStocks();
    if (name === "projects" && id) return pageProject(Number(id));
    if (name === "projects") return pageProjects();
    if (name === "orgchart") return pageOrgChart();
    if (name === "contacts") return pageContacts();
    if (name === "backup") return pageBackup();
    if (name === "unit") return pageUnit(id ? Number(id) : null);
    return go("#/today");
  }

  window.addEventListener("hashchange", render);

  async function boot() {
    app.replaceChildren(h("div", { class: "loading loading--full", text: "불러오는 중…" }));
    const r = await api("/me");
    state.user = r.user; state.team = r.team; state.units = r.units || []; state.tags = r.tags; state.calendars = r.calendars || []; state.unreadNotices = r.unreadNotices || 0;
    setCategories(r.categories);
    layout.main = null;
    render();
  }

  (async function start() {
    if (!state.token) return renderLogin();
    try { await boot(); } catch (e) { if (e.status !== 401) renderLogin(e.message); }
  })();
})();
