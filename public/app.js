(function () {
  "use strict";

  const TITLE = "P-Schedule";
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

  // 로그인 토큰: 자동 로그인이면 localStorage(브라우저를 닫아도 유지), 아니면 sessionStorage(창을 닫으면 사라짐)
  const tokenStore = {
    get() {
      try { return localStorage.getItem("ps.token") || sessionStorage.getItem("ps.token") || ""; } catch (e) { return ""; }
    },
    set(token, keep) {
      try {
        (keep ? sessionStorage : localStorage).removeItem("ps.token");
        (keep ? localStorage : sessionStorage).setItem("ps.token", token);
      } catch (e) { /* 저장 불가 환경 무시 */ }
    },
    clear() {
      try { localStorage.removeItem("ps.token"); sessionStorage.removeItem("ps.token"); } catch (e) { /* 무시 */ }
    }
  };

  const state = {
    token: tokenStore.get(),
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
    navRosaryOpen: store.get("ps.navRosary", "") !== "0", // 봉사자: 묵주 아래 입출고도 처음에는 펼침
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
  // 차액 = 요청수량 − 교육물량 (둘 다 있을 때만). 양수는 아직 덜 전달, 음수는 더 전달
  // 추가 전달 물량 = 요청수량 − 실(또는 십자가) 출고. 출고 기록이 없으면 계산하지 않음
  const moreThread = (v) => (v.qty != null && v.threadQty != null ? v.qty - v.threadQty : null);
  const moreCross = (v) => (v.qty != null && v.crossQty != null ? v.qty - v.crossQty : null);
  const qtyDiff = (v) => (v.qty != null && v.eduQty != null ? v.qty - v.eduQty : null);
  const diffText = (d) => (d == null ? "-" : d > 0 ? `+${fmtN(d)}` : d < 0 ? `−${fmtN(-d)}` : "0");
  const diffCls = (d) => (d == null ? "muted" : d < 0 ? "qty-diff is-over" : d > 0 ? "qty-diff is-left" : "qty-diff");
  // 'YYYY-MM-DD' 가 아니면(예: 엑셀 이월 기록 '2026-10월 이전') 글자를 그대로 보여 줌
  const shortDate = (s) => { if (!/^\d{4}-\d{2}-\d{2}/.test(String(s || ""))) return String(s || "-"); const d = parseYmd(s); return `${d.getMonth() + 1}/${d.getDate()}`; };
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
  // 공지 날짜는 항상 2026-11-13 형식 (서버 UTC → 이 기기 시각)
  const dayOf = (s) => (s ? ymd(new Date(s.replace(" ", "T") + "Z")) : "");
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
    if (!res.ok) throw Object.assign(new Error(data.error || "문제가 생겼어요. 잠시 뒤 다시 시도해 주세요."), { status: res.status, field: data.field, as: data.as, confirm: data.confirm });
    return data;
  }
  // 서버가 확인을 받으라고 하면(409 check) 무엇이 이상한지 보여 주고, 확인하면 다시 보냄. 취소하면 null (저장 안 함)
  async function apiAsk(path, opts = {}) {
    try { return await api(path, opts); } catch (ex) {
      if (ex.confirm?.mode !== "check") throw ex;
      const del = opts.method === "DELETE";
      if (!confirm(`${ex.confirm.lines.join("\n")}\n그래도 ${del ? "지울" : "저장할"}까요?`)) return null;
      return api(del ? `${path}${path.includes("?") ? "&" : "?"}confirmed=1` : path, del ? opts : { ...opts, body: { ...opts.body, confirmed: true } });
    }
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
  // 원본이 지워졌으면 그 자리에 '원본 지워짐' 하나만 (goneTag)
  const GONE_HINT = "구글 캘린더 원본이 지워졌어요. 이 일정은 그대로 남아 있어요.";
  const goneTag = (e, cls) => (e.sourceGone ? h("span", { class: "gone-tag" + (cls ? " " + cls : ""), title: GONE_HINT, role: "img", "aria-label": "원본 지워짐" }, [h("i", { text: "원본 " }), "지워짐"]) : null); // 좁은 칸에서는 '지워짐'만
  const srcTag = (e, short) => (e.sourceName && !e.sourceGone ? h("span", { class: "src-tag", title: `${e.sourceName} 캘린더 백업 (구글 캘린더에서 가져온 일정)`, text: short ? e.sourceName : `${e.sourceName} 캘린더 백업` }) : null);
  // 수정된 일정: '수정됨'(날짜가 바뀌면 함께), 우리 소속으로 넣은 일정은 '원본 수정됨'. 원본이 지워졌으면 그 표시만
  const changeLine = (c) => `${c.label} ${c.from} → ${c.to}`;
  function editTag(e, cls) {
    if (e.sourceGone) return goneTag(e, cls);
    const x = e.edited || (e.sourceEdited?.gone ? null : e.sourceEdited);
    if (!x) return null;
    const word = e.edited ? "수정됨" : "원본 수정됨";
    const moved = x.changes.some((c) => c.kind === "date");
    return h("span", { class: "edit-tag" + (cls ? " " + cls : ""), title: x.changes.map(changeLine).join("\n") || null, text: word + (moved ? " · 날짜 바뀜" : "") });
  }
  function editBox(e) {
    return [["edited", e.edited], ["source", e.sourceEdited]].filter((x) => x[1] && !x[1].gone).map(([k, x]) => h("div", { class: "edit-box" }, [
      h("div", { class: "edit-box__head" }, [h("strong", { text: k === "edited" ? "수정됨" : "원본 수정됨" }), h("span", { class: "muted small", text: `${ago(x.at)} ${e.ext || k === "source" ? "알게 됨" : "고침"}` })]),
      k === "source" ? h("p", { class: "muted small", text: "구글 캘린더에서 바뀌었어요. 이 일정에는 아직 옮기지 않았어요." }) : null,
      x.changes.length ? h("ul", {}, x.changes.map((c) => h("li", {}, [h("span", { class: "edit-box__label", text: c.label }), h("span", { class: "edit-box__val" }, [h("s", { text: c.from }), h("span", { "aria-label": "에서", text: " → " }), h("b", { text: c.to })])]))) : null
    ]));
  }
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
    if (opts && opts.tone) dialog.dataset.tone = opts.tone; else delete dialog.dataset.tone; // 입고(in)·출고(out) 색 띠
    if (!dialog.open) dialog.showModal();
    const first = dialogBody.querySelector("[autofocus]");
    if (first) first.focus();
  }
  function closeDialog() { closePop(); if (dialog.open) dialog.close(); }
  dialog.addEventListener("close", () => { closePop(); if (state.opsRefresh) quiet(state.opsRefresh()); });
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
  // 빈 날짜 칸을 누르면 오늘 날짜가 먼저 들어가 있게 (달력도 오늘에서 열림)
  document.addEventListener("focusin", (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement) || el.type !== "date" || el.value || el.disabled || el.readOnly) return;
    el.value = today();
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
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
    volunteer: { title: "부서 봉사자 로그인", pick: "부서 봉사자(물류)", desc: "입고·출고·완제품 등 물류", icon: "people" },
    team: { title: "팀 봉사자 로그인", pick: "팀 봉사자(교육&검수)", desc: "수도회 교육 · 검수", icon: "check" }
  };
  // 봉사자 화면·봉사자 로그인은 노란색 바탕 (색은 styles.css 의 .theme-volunteer)
  // 봉사자 화면 바탕: 부서 봉사자는 노랑, 팀 봉사자(team)는 연초록
  function volunteerTheme(on, team) {
    document.documentElement.classList.toggle("theme-volunteer", on);
    document.documentElement.classList.toggle("theme-team", !!(on && team));
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
      m.dataset.base ??= m.content;
      m.content = on ? (team ? "#8fd16a" : "#ffd43b") : m.dataset.base;
    });
  }
  const authBrand = () => h("div", { class: "brand brand--lg" }, [h("img", { src: "favicon.svg", alt: "" }), h("span", { text: TITLE })]);
  function renderLogin(message, as, keepId) {
    document.title = TITLE;
    const mode = LOGIN_AS[as] ? as : store.get("ps.loginAs", "");
    if (!LOGIN_AS[mode]) return renderLoginChoice(message);
    const info = LOGIN_AS[mode];
    volunteerTheme(mode !== "staff", mode === "team");
    const err = errorLine();
    const savedId = store.get("ps.savedId", "");
    const login = h("input", { name: "login", autocomplete: "username", autocapitalize: "none", spellcheck: "false", required: true, value: keepId || savedId });
    const pw = h("input", { name: "password", type: "password", autocomplete: "current-password", required: true });
    const submit = h("button", { class: "btn btn--primary btn--block", type: "submit", text: "로그인" });
    // 아이디 저장: 이 기기에 아이디만 기억 (비밀번호는 저장하지 않음)
    // 자동 로그인: 브라우저·앱을 닫아도 로그인 유지 (끄면 창을 닫을 때 로그아웃). 처음에는 설치한 앱에서만 켜 둠
    const remId = h("input", { type: "checkbox", checked: !!savedId });
    const autoPref = store.get("ps.autoLogin", "");
    const auto = h("input", { type: "checkbox", checked: autoPref ? autoPref === "1" : isStandalone() });
    const opts = h("div", { class: "auth__opts" }, [
      h("label", { class: "check" }, [remId, "아이디 저장"]),
      h("label", { class: "check", title: "공용 PC 에서는 끄세요" }, [auto, "자동 로그인"])
    ]);
    const autoNote = h("p", { class: "auth__note muted small", text: "공용 PC·다른 사람 기기에서는 자동 로그인을 끄세요.", hidden: !auto.checked });
    auto.addEventListener("change", () => { autoNote.hidden = !auto.checked; });
    const form = h("form", { class: "auth__card stack", novalidate: true }, [
      authBrand(),
      h("h1", { class: "auth__title", text: info.title }),
      field("아이디", login), field("비밀번호", pw), opts, autoNote, err, submit,
      h("button", { class: "link-btn auth__back", type: "button", text: "로그인 종류 다시 고르기", onclick: () => { store.remove("ps.loginAs"); renderLoginChoice(); } }),
      h("p", { class: "auth__foot", text: "계정이 없거나 비밀번호를 잊었다면 관리자에게 문의해 주세요." })
    ]);
    if (message) showError(err, message);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!login.value.trim() || !pw.value) return showError(err, "아이디와 비밀번호를 적어 주세요.");
      busy(submit, async () => {
        try {
          const r = await api("/login", { method: "POST", body: { login: login.value, password: pw.value, as: mode, remember: auto.checked } });
          state.token = r.token;
          tokenStore.set(r.token, auto.checked);
          store.set("ps.autoLogin", auto.checked ? "1" : "0");
          if (remId.checked) store.set("ps.savedId", login.value.trim()); else store.remove("ps.savedId");
          store.set("ps.loginAs", mode);
          await boot();
        } catch (ex) {
          if (ex.field === "as") { // 다른 쪽 계정: 맞는 화면으로 옮겨 주기 (비밀번호는 다시)
            const other = LOGIN_AS[ex.as] ? ex.as : mode === "staff" ? "volunteer" : "staff";
            store.set("ps.loginAs", other);
            return renderLogin(`${ex.message} ${LOGIN_AS[other].title} 화면으로 옮겼어요. 비밀번호를 다시 적어 주세요.`, other, login.value);
          }
          showError(err, ex.message); pw.select();
        }
      });
    });
    app.replaceChildren(h("main", { class: "auth" }, form));
    (keepId || savedId ? pw : login).focus();
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
      err, pick("staff"), pick("volunteer"), pick("team"),
      h("p", { class: "auth__foot", text: "계정이 없거나 비밀번호를 잊었다면 관리자에게 문의해 주세요." }),
      // 앱 설치 안내 (앱으로 열었으면 숨김)
      isStandalone() ? null : h("p", { class: "auth__foot auth__app" }, isIos() ? "아이폰·아이패드: 사파리 '공유 → 홈 화면에 추가'로 앱처럼 쓸 수 있어요." : [h("a", { class: "link-btn", href: "/download/pschedule.apk", download: "pschedule.apk", text: "안드로이드 앱(APK) 내려받기" }), " · 아이폰·아이패드는 사파리 '공유 → 홈 화면에 추가'"])
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
    if (!expired && state.token) { await pushOff(true).catch(() => {}); api("/logout", { method: "POST" }).catch(() => {}); }
    state.token = "";
    state.user = null;
    state.peek = null;
    state.volMenu = null;
    tokenStore.clear();
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
  // 알림(변경 내역): 메뉴마다 안 본 변경 수. 메뉴를 열면 그 메뉴 숫자만 사라짐 (서버에 사람마다 남겨 기기 사이에도 같음)
  const chgN = (menu) => (state.chg?.counts || {})[menu] || 0;
  const chgBadge = (n) => (n ? h("span", { class: "nav-badge nav-badge--chg", "aria-label": `새 변경 ${n}건`, title: `새 변경 ${n}건`, text: n > 99 ? "99+" : String(n) }) : null);
  const chgAs = () => (state.volPreview ? `?as=${state.volPreview}` : "");
  function setChg(r) {
    const key = JSON.stringify([r.counts, r.alarm]);
    if (key === state.chgKey) return;
    state.chgKey = key; state.chg = { counts: r.counts, alarm: r.alarm };
    if (state.drawVolNav) state.drawVolNav(); else if (layout.nav && navActive) drawNav(navActive);
  }
  let chgSeq = 0;
  // 메뉴를 열었을 때: 그 메뉴를 본 것으로. 늦게 온 예전 답이 새 값을 덮지 않게 차례를 셈
  const seeMenu = (menu) => { const n = ++chgSeq; quiet(api(`/changes/seen${chgAs()}`, { method: "POST", body: { menu } }).then((r) => { if (n === chgSeq) setChg(r); })); };
  const checkChanges = () => { if (!state.token || !state.user || state.user.mustChangePassword || document.visibilityState !== "visible") return; const n = ++chgSeq; quiet(api(`/changes/counts${chgAs()}`).then((r) => { if (n === chgSeq) setChg(r); })); };
  setInterval(checkChanges, 120000);
  // 열어 둔 '오늘' 화면: 2분마다, 그리고 다시 볼 때 새로 읽음 (구글 일정은 서버가 20분마다 읽음)
  let autoAt = 0, autoBusy = false;
  async function autoToday(min) {
    if (!state.token || !state.user || !page?.auto || autoBusy || document.visibilityState !== "visible" || Date.now() - autoAt < min) return;
    autoAt = Date.now(); autoBusy = true;
    try { await page.auto(); } catch (e) { /* 다음 차례에 */ } finally { autoBusy = false; }
  }
  setInterval(() => autoToday(110000), 30000);
  document.addEventListener("visibilitychange", () => autoToday(10000));
  window.addEventListener("focus", () => autoToday(10000));
  document.addEventListener("visibilitychange", checkChanges);
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
      h("button", { type: "button", class: "pop__item", onclick: () => { closePop(); toggleNav(false); appDialog(); } }, "휴대폰 알림 · 앱 설치"),
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
      ...(opsSees() ? [{ id: "ops", label: "수도회·물류", icon: "db" }] : []), // 직원은 권한표에서 켜야 보임
      { id: "orgchart", label: "조직도", icon: "org" },
      { id: "contacts", label: "연락처", icon: "phone" },
      { id: "alerts", label: "알림", icon: "clock", alarm: true },
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
    }, [icon(it.icon), h("span", { class: "side__text", text: it.label }), it.badge ? h("span", { class: "nav-badge", "aria-label": `안 읽은 공지 ${it.badge}개`, text: it.badge > 99 ? "99+" : String(it.badge) }) : chgBadge(it.alarm ? state.chg?.alarm : chgN(it.id))]);
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
  // 관리자 메뉴: 수정중 카테고리 / 직원 관리 / 봉사자 관리 / 공통 관리
  let adminProjects = null; // 수정중 카테고리의 프로젝트 바로가기 (한 번만 불러옴)
  function drawAdminNav(active) {
    if (!layout.admin) return;
    const sub = route().id;
    const link = (id, label, ic, onclick, on) => (onclick
      ? h("button", { class: "side__link side__link--admin", type: "button", title: label, onclick: () => { toggleNav(false); onclick(); } }, [icon(ic), h("span", { class: "side__text", text: label })])
      : h("a", { class: "side__link side__link--admin" + (on ?? id === active ? " is-active" : ""), href: "#/" + id, title: label, "aria-current": (on ?? id === active) ? "page" : null, onclick: () => toggleNav(false) }, [icon(ic), h("span", { class: "side__text", text: label }), chgBadge(chgN(id))]));
    const part = (label) => h("div", { class: "side__adminpart", text: label });
    const wip = adminProjects === null ? [h("p", { class: "side__adminnote", text: "불러오는 중…" })]
      : adminProjects.length ? adminProjects.map((p) => link(`projects/${p.id}`, p.name, "folder", null, active === "projects" && String(sub) === String(p.id)))
        : [h("p", { class: "side__adminnote", text: "아직 없어요" })];
    layout.admin.replaceChildren(
      h("div", { class: "side__adminhead" }, [icon("lock"), "관리자 전용"]),
      part("수정중 카테고리"),
      h("p", { class: "side__adminnote", text: "상세 프로세스·협력업체·수량·이미지 (아직 관리자만)" }),
      ...wip,
      part("직원 관리"),
      link("members", "멤버 · 소속 지정", "user"),
      link("org", "조직도 편집", "org"),
      part("봉사자 관리"),
      link("volunteers", "봉사자 일정", "cal", null, active === "volunteers" && !sub),
      link("volunteers/training", "기본 교육", "check", null, active === "volunteers" && sub === "training"),
      link("volunteers/stock", "입출고 입력", "db", null, active === "volunteers" && sub === "stock"),
      link("board", "게시판", "chat", null, active === "board"),
      part("공통 관리"),
      link("cats", "분류 관리", "folder", manageCategories),
      link("cals", "구글 캘린더 연결", "cal", manageCalendars),
      link("backup", "백업", "db")
    );
    if (adminProjects === null) {
      adminProjects = [];
      api("/projects").then((r) => { adminProjects = r.projects.map((p) => ({ id: p.id, name: p.name })); drawAdminNav(navActive); }).catch(() => {});
    }
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
  let catShown = null; // 내용을 펼쳐 둔 분류 (분류를 바꾸면 다시 접힘)
  function setCat(id) {
    if (id !== state.cat) catShown = null;
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
    // 분류로 걸러 보는 중이면 내용은 처음에 접어 두고, 눌러야 펼쳐 봄 (같은 분류 안에서는 펼친 채로 유지)
    if (bar) {
      const box = h("details", { class: "catfold" }, [
        h("summary", { class: "catfold__sum" }, [icon("right"), h("span", {}, ["'", h("strong", { text: catLabel(state.cat) }), "' 분류에서 쓴 내용"]), h("span", { class: "catfold__hint muted small" })]),
        h("div", { class: "catfold__body" }, content)
      ]);
      const hint = box.querySelector(".catfold__hint");
      const sync = () => { hint.textContent = box.open ? "눌러서 접기" : "눌러서 펼치기"; };
      box.open = catShown === state.cat; sync();
      box.addEventListener("toggle", () => { catShown = box.open ? state.cat : null; sync(); });
      content = box;
    }
    // 관리자 전용 화면: 맨 위 주황 줄
    fill(layout.main, ADMIN_PAGES.has(name) ? h("div", { class: "admin-bar", "aria-hidden": "true" }) : null, bar, content);
  }
  // 불러오는 중: P-Schedule 로고가 살짝 움직이며 표시
  const loading = (full) => h("div", { class: "loading" + (full ? " loading--full" : ""), role: "status" }, h("div", { class: "loading__inner" }, [
    h("img", { class: "loading__logo", src: "favicon.svg", alt: "" }), h("span", { class: "loading__text", text: "불러오는 중…" })]));
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
    const head = [h("div", { class: "peek__kind" }, [evDot(e), h("span", { text: KIND[e.kind].label }), isMeeting ? h("span", { class: `status status--${st}`, text: MEETING_STATE[st] }) : null, goneTag(e)]), title];
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
      ...editBox(e),
      e.source ? h("div", { class: "srcbox" + (e.source.status !== "same" || e.source.moved ? " is-warn" : "") }, [
        h("span", {}, [icon("cal"), h("strong", { text: `${e.source.calendarName} 캘린더 백업` }), " · 구글 캘린더에서 가져온 일정이라 원본은 달력에서 숨겨요"]),
        e.source.status === "changed" || e.source.moved ? h("span", { class: "srcbox__msg" }, [e.source.changed.length ? `원본이 바뀌었어요 (${e.source.changed.join(", ")})` : "원본의 반복이 나뉘었어요 (내용은 같아요)",
          h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "원본대로 맞추기", onclick: (ev) => busy(ev.currentTarget, async () => {
            await act(() => api(`/events/${e.id}/source-sync`, { method: "POST" }), "원본대로 맞췄어요."); refresh();
          }) })]) : null,
        e.source.status === "deleted" ? h("span", { class: "srcbox__msg", text: "원본에서 지워졌어요" + (e.sourceEdited?.gone ? ` (${ago(e.sourceEdited.at)} 알게 됨)` : "") }) : null,
        e.source.status === "unknown" ? h("span", { class: "srcbox__msg", text: { lost: "원본의 이 회차를 찾지 못했어요 (옮겼거나 지웠을 수 있어요)", out: "원본이 가져오는 기간 밖이라 확인할 수 없어요", unlinked: "원본 캘린더 연결이 끊겨서 확인할 수 없어요" }[e.source.reason] || "원본을 아직 확인하지 못했어요" }) : null,
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
      ...editBox(e),
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
      h("p", { class: "muted small", text: "제목·날짜·시간·장소·설명을 복사해 P-Schedule 일정으로 만들어요. 원본은 그대로 두고, 원본이 바뀌면 알려 드려요." }),
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
        h("div", { class: "daycard__top" }, [evDot(e), h("span", { class: "daycard__time", text: timeRange(e) }), goneTag(e), h("strong", { text: e.title }), e.ext ? h("small", { class: "muted", text: e.calendarName }) : null]),
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
            if (!confirm(`'${c.name}' 연결을 끊을까요? 가져온 일정이 P-Schedule 에서 사라져요 (구글 캘린더는 그대로예요).`)) return;
            await act(() => api(`/admin/calendars/${c.id}`, { method: "DELETE" })); await load(); await after();
          } })
        ]),
        h("div", { class: "calman__row calman__row--meta" }, [
          h("span", { class: "mono small muted", title: "비공개 주소는 가려서 보여 줘요", text: c.address }),
          h("button", { class: "link-btn", type: "button", text: "주소 바꾸기", onclick: (ev) => changeUrl(ev.currentTarget, c) }),
          h("div", { class: "swatches swatches--sm" }, COLOR_NAMES.map((cn, i) => h("button", { class: `swatch c${i}`, type: "button", "aria-label": cn, "aria-pressed": String(c.color === i), onclick: () => patch(c, { color: i }) }))),
          categoryButton(c.categoryId, (id) => patch(c, { categoryId: id }), "select-btn calman__cat"),
          (() => { const b = h("button", { class: "select-btn calman__cat", type: "button", title: "이 캘린더를 쓰는 소속 (소속 화면·'우리 소속'에 반영)" }, c.unitId && unitOf(c.unitId) ? [icon("org"), h("span", { text: unitShort(c.unitId) })] : h("span", { class: "muted", text: "소속 고르기" }));
            b.addEventListener("click", () => unitPicker(b, c.unitId, (id) => patch(c, { unitId: id }))); return b; })(),
          (() => { const x = h("input", { type: "checkbox", checked: c.absence }); x.addEventListener("change", () => quiet(patch(c, { absence: x.checked })));
            return h("label", { class: "check small", title: "켜면 '이름으로 모아 보기'의 부재 알림에 나오고, 회의실·취소됨 표시에서는 빠져요" }, [x, h("span", { text: `부재 캘린더${c.absenceSet == null && c.absence ? " (이름으로 정함)" : ""}` })]); })()
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
      h("p", { class: "muted small", text: "구글 캘린더의 일정을 읽기 전용으로 가져와 달력·오늘 화면에 함께 보여 줘요. P-Schedule 에서 고친 내용은 구글로 가지 않아요 (한 방향)." }),
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
  // 이름으로 모아 보기에 나오는 종류 (새 종류는 여기에 한 줄 추가)
  const FIND_KINDS = {
    event: { label: "일정", when: (x) => (x.time ? (x.endTime ? `${x.time}~${x.endTime}` : x.time) : "종일") },
    meeting: { label: "회의", when: (x) => (x.time ? (x.endTime ? `${x.time}~${x.endTime}` : x.time) : "종일") },
    ext: { label: "구글 일정", when: (x) => (x.time ? (x.endTime ? `${x.time}~${x.endTime}` : x.time) : "종일") },
    task: { label: "할 일" },
    memo: { label: "메모" }
  };
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
    // 이름(검색어)마다 시간이 겹치는 일정: 겹치는 것끼리 맨 위로 모으고 '시간 겹침' 표시
    // 끝 시간이 없으면 30분짜리로 봄. 종일 일정·할 일·메모는 시간이 없어 비교하지 않음. 부재는 회의가 아니라 비교하지 않고 맨 위로
    const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ""); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
    function withClashes(all) {
      const off = all.filter((x) => x.absence), r = clashesOf(all.filter((x) => !x.absence));
      return { list: [...off, ...r.list], clashes: r.clashes };
    }
    function clashesOf(results) {
      const timed = results.map((x, i) => { const a = toMin(x.time); if (a == null || x.absence || x.type === "task" || x.type === "memo") return null; const e = toMin(x.endTime); return { i, a, b: e != null && e > a ? e : a + 30 }; }).filter(Boolean);
      const hit = new Map();
      for (const p of timed) for (const o of timed) if (p.i !== o.i && p.a < o.b && o.a < p.b) { if (!hit.has(p.i)) hit.set(p.i, []); hit.get(p.i).push(results[o.i].title); }
      if (!hit.size) return { list: results, clashes: 0 };
      const top = [...hit.keys()].sort((i, j) => toMin(results[i].time) - toMin(results[j].time) || i - j).map((i) => ({ ...results[i], clash: hit.get(i) }));
      return { list: [...top, ...results.filter((_, i) => !hit.has(i))], clashes: hit.size };
    }
    // 이름으로 모아 보기: 공통 검색어 + 내 검색어, 그날 걸린 일정·할 일·메모
    const findBox = h("section", { class: "card today-find" }, loading());
    let findDay = day; // 이 칸만 앞뒤 날짜로 옮겨 볼 수 있음 (아래 일정은 그대로)
    let findSeq = 0;
    async function loadFind(auto) {
      const seq = ++findSeq;
      const r = await api(`/today-search?date=${findDay}`);
      if (seq !== findSeq) return; // 날짜를 빨리 넘길 때 늦게 온 응답은 버림
      const sig = JSON.stringify(r) + findDay;
      if (auto === true && (sig === findSig || !calm())) return;
      findSig = sig;
      const put = async (body) => { await act(() => api("/today-keywords", { method: "PUT", body })); quiet(loadFind()); };
      const save = (mine) => put({ keywords: mine });
      const saveEx = (ex) => put({ excludes: ex });
      const moveDay = (d) => { findDay = d; quiet(loadFind()); };
      const me = state.user.name;
      const hasMe = r.common.includes(me) || r.mine.includes(me);
      const add = h("input", { class: "today-find__add", maxlength: "30", placeholder: "검색어 추가", "aria-label": "검색어 추가" });
      add.addEventListener("keydown", (e) => { if (e.key === "Enter" && add.value.trim()) { e.preventDefault(); save([...r.mine, add.value.trim()]); } });
      const exAdd = h("input", { class: "today-find__add today-find__add--ex", maxlength: "30", placeholder: "제외어 추가", "aria-label": "제외어 추가" });
      exAdd.addEventListener("keydown", (e) => { if (e.key === "Enter" && exAdd.value.trim()) { e.preventDefault(); saveEx([...r.excludes, exAdd.value.trim()]); } });
      const exChip = (k) => h("span", { class: "today-find__chip is-ex" }, [h("span", { "aria-hidden": "true", text: "−" }), k, h("button", { class: "icon-btn icon-btn--xs", type: "button", "aria-label": `제외어 ${k} 빼기`, html: ICON.close, onclick: () => saveEx(r.excludes.filter((x) => x !== k)) })]);
      const t0 = today();
      const dayNav = h("div", { class: "today-find__day" }, [
        h("button", { class: "icon-btn icon-btn--xs", type: "button", "aria-label": "전날", title: "전날", html: ICON.left, onclick: () => moveDay(shiftYmd(findDay, -1)) }),
        h("span", { class: "today-find__date" + (findDay === t0 ? " is-today" : ""), text: dateLabel(findDay) }),
        h("button", { class: "icon-btn icon-btn--xs", type: "button", "aria-label": "다음 날", title: "다음 날", html: ICON.right, onclick: () => moveDay(shiftYmd(findDay, 1)) }),
        findDay !== t0 ? h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "오늘", onclick: () => moveDay(t0) }) : null
      ]);
      const chip = (k, mine) => h("span", { class: "today-find__chip" + (mine ? " is-mine" : "") }, [k, mine ? h("button", { class: "icon-btn icon-btn--xs", type: "button", "aria-label": `${k} 빼기`, html: ICON.close, onclick: () => save(r.mine.filter((x) => x !== k)) }) : h("small", { text: "공통" })]);
      const row = (x) => {
        const key = x.ext ? `ext:${x.id}` : x.type === "task" ? `task:${x.id}` : x.type === "memo" ? (x.meetingId ? `event:${x.meetingId}` : `day:${x.date}`) : `event:${x.id}`;
        const kind = FIND_KINDS[x.type] || FIND_KINDS.event;
        const when = x.absence ? awayWhen(x) : kind.when ? kind.when(x) : kind.label;
        // 제목이 아닌 곳(설명·안건·메모 등)에서 찾은 것은 + 로 표시
        const extra = x.field && x.field !== "제목";
        return h("li", {}, h("button", { class: "today-find__row today-find__row--" + (x.absence ? "absence" : FIND_KINDS[x.type] ? x.type : "event") + (x.clash ? " is-clash" : ""), type: "button", "data-peek": key, title: extra ? `${x.field}에 '${x.keyword || ""}'이(가) 들어 있어요` : null, onclick: () => { const [t, id] = key.split(":"); openPeek(t, t === "day" ? id : Number(id)); } }, [
          h("span", { class: "today-find__kind" + (x.absence ? " is-absence" : ""), text: x.absence ? "부재" : kind.label }),
          x.clash ? h("span", { class: "today-find__clash", title: `${x.clash.join(", ")}와(과) 시간이 겹쳐요`, text: "시간 겹침" }) : null,
          editTag(x),
          x.absence ? awayTitle(x) : h("span", { class: "today-find__title", text: x.title }),
          extra ? h("span", { class: "today-find__plus", "aria-label": `${x.field}에서 찾음`, text: "+" }) : null,
          kind.when ? h("span", { class: "today-find__time", text: when }) : null
        ]));
      };
      // 부재: '이름 · 종류'(나눌 수 없으면 제목 그대로), 여러 날이면 기간과 며칠째인지
      const awayTitle = (x) => h("span", { class: "today-find__title" }, x.who ? [h("strong", { text: x.who }), ` · ${x.why}`] : x.title);
      const awayWhen = (x) => {
        const t = x.time ? (x.endTime ? `${x.time}~${x.endTime}` : x.time) : "";
        if (!x.endDate || x.endDate === x.date) return t || "종일";
        const days = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 86400000) + 1;
        return `${shortDate(x.date)}~${shortDate(x.endDate)}${t ? " " + t : ""} · ${days(x.date, x.endDate)}일 중 ${days(x.date, findDay)}일째${findDay === t0 ? " (오늘)" : ""}`;
      };
      const away = r.absences || { on: false, results: [], excluded: 0 };
      const AWAY_SHOW = 8;
      const awayBox = () => {
        const all = store.get("ps.awayAll", "0") === "1", list = all ? away.results : away.results.slice(0, AWAY_SHOW);
        return h("section", { class: "today-away", "aria-label": "부재 알림" }, [
          h("h3", {}, ["부재 알림", h("span", { class: "muted small", text: ` ${away.results.length}건${away.excluded ? ` (제외 ${away.excluded})` : ""}` })]),
          away.results.length ? h("ul", { class: "today-away__list" }, list.map((x) => h("li", {}, h("button", { class: "today-away__row", type: "button", "data-peek": `ext:${x.id}`, onclick: () => openPeek("ext", x.id) }, [
            h("span", { class: "today-find__kind is-absence", text: "부재" }), editTag(x), awayTitle(x), h("span", { class: "today-find__time", text: awayWhen(x) })
          ])))) : h("p", { class: "muted small", text: away.excluded ? "제외어로 모두 빠졌어요." : "이 날 부재가 없어요." }),
          away.results.length > AWAY_SHOW ? h("button", { class: "link-btn", type: "button", "aria-expanded": String(all), text: all ? "접기" : `모두 보기 (${away.results.length}건)`, onclick: (ev) => { store.set("ps.awayAll", all ? "0" : "1"); ev.currentTarget.closest(".today-away").replaceWith(awayBox()); } }) : null
        ]);
      };
      const open = store.get("ps.findOpen", "1") === "1"; // 처음에는 펼친 상태
      const toggle = h("button", { class: "today-find__toggle", type: "button", "aria-expanded": String(open), onclick: () => { store.set("ps.findOpen", open ? "0" : "1"); quiet(loadFind()); } }, [
        h("span", { class: "today-find__chev" + (open ? " is-open" : ""), html: ICON.right }),
        h("h2", { class: "card__title", text: "이름으로 모아 보기" }),
        h("span", { class: "muted small", text: `${r.groups.reduce((n, g) => n + g.results.length, 0)}건${away.on ? ` · 부재 ${away.results.length}건` : ""}` })
      ]);
      findBox.classList.toggle("is-folded", !open);
      fill(findBox,
        h("div", { class: "card__head" }, [
          toggle,
          open ? dayNav : null,
          open && !hasMe ? h("button", { class: "btn btn--primary btn--sm", type: "button", onclick: () => save([...r.mine, me]) }, [icon("search"), `내 이름(${me})으로 찾기`]) : null
        ]),
        open ? h("div", { class: "today-find__chips" }, [...r.common.map((k) => chip(k, false)), ...r.mine.map((k) => chip(k, true)), add]) : null,
        open ? h("div", { class: "today-find__chips today-find__chips--ex" }, [h("span", { class: "muted small", text: "제외" }), ...r.excludes.map(exChip), exAdd, r.excludes.length ? null : h("span", { class: "muted small", text: "이 말이 들어간 것은 결과에서 빼요" })]) : null,
        open ? h("div", { class: "today-find__groups" }, r.groups.map((g) => { const { list, clashes } = withClashes(g.results); return h("div", { class: "today-find__group" + (clashes ? " has-clash" : "") }, [
          h("h3", {}, [g.keyword, h("span", { class: "muted small", text: ` ${g.results.length}건${g.excluded ? ` (제외 ${g.excluded}${g.excludedAbsences ? `, 그중 부재 ${g.excludedAbsences}` : ""})` : ""}` }), clashes ? h("span", { class: "today-find__clashsum", text: `시간 겹침 ${clashes}건` }) : null]),
          g.results.length ? h("ul", { class: "today-find__list" }, list.map((x) => row({ ...x, keyword: g.keyword }))) : h("p", { class: "muted small", text: g.excluded ? "제외어로 모두 빠졌어요." : "이 날 걸린 것이 없어요." })
        ]); })) : null,
        open && away.on ? awayBox() : null,
        open && r.groups.some((g) => g.results.some((x) => x.field && x.field !== "제목")) ? h("p", { class: "muted small today-find__legend" }, [h("span", { class: "today-find__plus", text: "+" }), " 제목이 아닌 내용(설명·안건·메모 등)에서 찾은 것"]) : null
      );
      markPeeked();
    }
    // 회의실 예약 현황: 회의실(관리자 등록)마다 시간대별로 어떤 일정이 잡혀 있는지
    const roomBox = h("section", { class: "card rooms" });
    const PSR = window.PSRooms; // 읽기 규칙은 rooms.js
    // 부재 캘린더(관리자가 켠 것, 안 정했으면 이름에 '부재')와 휴가·연차 캘린더는 방을 찾지 않음
    const noRoom = (e) => { const c = e.ext && state.calendars.find((x) => x.id === e.calendarId); return c ? c.absence || PSR.isAbsenceCalendar(c.name.replace(/부재/g, "")) : PSR.isAbsenceCalendar(e.calendarName || e.sourceName); };
    let roomEvents = [], roomNames = [];
    function setRooms(r) { state.rooms = r.rooms; state.roomSkip = r.skip; drawRooms(roomEvents); }
    const unreadChips = (list, done) => h("div", { class: "rooms__unread" }, list.map((u) => h("button", { type: "button", class: "chip-add rooms__word", onclick: () => roomWordDialog(u.name, done) }, [u.name, u.n > 1 ? h("span", { class: "muted", text: ` ${u.n}건` }) : null])));
    // 읽지 못한 표기 하나: 방 별명에 넣거나 '회의실 아님'으로
    function roomWordDialog(word, done) {
      const listed = PSR.makeReader(state.rooms, state.roomSkip).listed;
      const byName = new Map((state.rooms || []).map((r, i) => [listed[i], PSR.parseLine(r).name])); // 보여 주는 이름 → 적힌 이름
      const names = [...new Set([...listed, ...roomNames, PSR.A4])];
      const pick = h("select", {}, [h("option", { value: "", text: "방을 골라 주세요" }), ...names.map((n) => h("option", { value: n, text: n })), h("option", { value: "+", text: "새 방으로 만들기" })]);
      const name = h("input", { maxlength: "30", value: word.slice(0, 30) });
      const nameField = field("새 방 이름", name);
      nameField.hidden = true;
      pick.addEventListener("change", () => { nameField.hidden = pick.value !== "+"; });
      const err = errorLine();
      const back = () => (done ? done() : closeDialog());
      const save = (btn, body, msg) => busy(btn, async () => {
        try { setRooms(await api("/admin/rooms/word", { method: "POST", body: { word, ...body } })); toast(msg); back(); } catch (ex) { showError(err, ex.message); }
      });
      const ok = h("button", { class: "btn btn--primary", type: "submit", text: "이 방으로 읽기" });
      const no = h("button", { class: "btn btn--ghost", type: "button", text: "회의실 아님", onclick: () => save(no, {}, `'${word}'은(는) 회의실이 아닌 것으로 기억했어요.`) });
      const form = h("form", { class: "stack" }, [
        h("p", { class: "muted small", text: "고르면 이 표기가 적힌 일정이 모두 그 방에 모여요. 일정은 고치지 않아요." }),
        h("p", { class: "rooms__wordname" }, [h("strong", { text: `[${word}]` })]),
        field("어느 방인가요?", pick), nameField, err,
        h("div", { class: "actions" }, [done ? h("button", { class: "btn btn--ghost", type: "button", text: "뒤로", onclick: back }) : null, no, ok])
      ]);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const room = pick.value === "+" ? name.value.trim() : byName.get(pick.value) || pick.value;
        if (!room) return showError(err, pick.value === "+" ? "새 방 이름을 적어 주세요." : "방을 골라 주세요.");
        save(ok, { room }, `'${word}'을(를) ${pick.value === "+" ? room : pick.value}(으)로 읽어요.`);
      });
      openDialog("회의실 표기", form, { admin: true });
    }
    function roomsDialog() {
      const ta = h("textarea", { rows: "8", maxlength: "9000", placeholder: "한 줄에 하나씩\nA604호\nA4 소회의실 = A4소, 4A소, 4층 소회의실\n영성센터 B동 401호" }, (state.rooms || []).join("\n"));
      const skip = h("textarea", { rows: "4", maxlength: "9000", placeholder: "한 줄에 하나씩" }, (state.roomSkip || []).join("\n"));
      const err = errorLine();
      const ok = h("button", { class: "btn btn--primary", type: "submit", text: "저장" });
      const lines = (x) => x.value.split("\n").map((y) => y.trim()).filter(Boolean);
      const unreadBox = h("div", { class: "stack" }, h("p", { class: "muted small", text: "찾는 중…" }));
      const form = h("form", { class: "stack" }, [
        h("p", { class: "muted small", text: "회의실은 일정 제목의 [A602] 같은 표기로 자동으로 잡혀요. 여기에 적은 회의실은 이 순서대로 맨 앞에, 예약이 없는 날에도 보여요. 30개까지예요." }),
        field("회의실 목록", ta, "같은 방을 다르게 적는 표기가 있으면 '방 이름 = 다른 표기, 다른 표기'로 적어 주세요. 그 표기가 이 방으로 모여요."),
        h("details", { class: "rooms__more" }, [h("summary", {}, ["회의실 아님으로 기억한 표기 ", h("span", { class: "muted", text: `${(state.roomSkip || []).length}개` })]), field("한 줄에 하나씩 (지우면 다시 찾아요)", skip)]),
        err, h("div", { class: "actions" }, [h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), ok]),
        h("div", { class: "rooms__unreadbox" }, [h("h3", { class: "card__title", text: "회의실로 읽지 못한 표기" }), unreadBox])
      ]);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        busy(ok, async () => {
          try { setRooms(await api("/admin/rooms", { method: "PUT", body: { rooms: lines(ta), skip: lines(skip) } })); closeDialog(); toast("회의실 목록을 저장했어요."); }
          catch (ex) { showError(err, ex.message); }
        });
      });
      openDialog("회의실 관리", form, { admin: true });
      // 앞뒤 일정에서 읽지 못한 표기를 모아 보여 줌 (고치다 만 글이 있으면 먼저 저장하도록)
      api(`/events?from=${shiftYmd(day, -30)}&to=${shiftYmd(day, 60)}`).then((ev) => {
        const b = PSR.makeReader(state.rooms, state.roomSkip).board(dedupeImported(allEvents(ev)), { noRoom });
        const dirty = () => ta.value !== ta.defaultValue || skip.value !== skip.defaultValue;
        const chips = unreadChips(b.unread.slice(0, 60), roomsDialog);
        chips.addEventListener("click", (e) => { if (dirty() && e.target.closest("button")) { e.stopPropagation(); showError(err, "고친 목록을 먼저 저장해 주세요."); } }, true);
        unreadBox.replaceChildren(
          h("p", { class: "muted small", text: b.unread.length ? `${dateLabel(shiftYmd(day, -30))}부터 ${dateLabel(shiftYmd(day, 60))}까지 일정 제목의 대괄호예요. 누르면 방을 정하거나 회의실이 아니라고 기억할 수 있어요.` : "앞뒤 일정에는 읽지 못한 표기가 없어요." }),
          b.unread.length ? chips : "",
          b.unread.length > 60 ? h("p", { class: "muted small", text: `많이 나온 60개만 보여요. 모두 ${b.unread.length}개예요.` }) : "");
      }).catch(() => unreadBox.replaceChildren(h("p", { class: "muted small", text: "불러오지 못했어요." })));
    }
    // all: 그날 일정 전부(분류와 상관없이). 왼쪽 '내 캘린더'에서 끈 것은 빼고 그리되, 빠진 예약이 있으면 알려 줌
    function drawRooms(all) {
      roomEvents = all;
      if (!PSR) return fill(roomBox, h("h2", { class: "card__title", text: "회의실 예약 현황" }), h("p", { class: "muted", text: "새 버전이 나왔어요. 화면을 새로 고치면 보여요." }));
      const reader = PSR.makeReader(state.rooms, state.roomSkip);
      const events = dedupeImported(all.filter(showEv));
      const { rooms, byRoom, events: used, usedRooms, unread } = reader.board(events, { noRoom });
      roomNames = rooms;
      const hidden = dedupeImported(all).filter((e) => !showEv(e) && !noRoom(e) && reader.read(e).rooms.length);
      const offNames = [...new Set(hidden.map((e) => (e.ext ? e.calendarName : KIND[e.kind]?.label) || "일정"))];
      const over = new Map(rooms.map((r) => [r, PSR.overlaps(byRoom.get(r), day)]));
      const sum = (k) => [...over.values()].reduce((n, o) => n + o[k], 0);
      const clashes = sum("clash"), dups = sum("dup");
      const timed = [...byRoom.values()].flat().filter((e) => e.startTime && e.startDate === day);
      const startH = Math.min(8, ...timed.map((e) => Math.floor(minutes(e.startTime) / 60)));
      const endH = Math.max(20, ...timed.map((e) => Math.ceil(minutes(e.endTime && e.endTime > e.startTime ? e.endTime : e.startTime) / 60) + (e.endTime && e.endTime > e.startTime ? 0 : 1)));
      const RH = 40, H = (endH - startH) * RH;
      const nowTop = day === today() ? (() => { const n = new Date(), m = n.getHours() * 60 + n.getMinutes(); return m >= startH * 60 && m <= endH * 60 ? ((m - startH * 60) / 60) * RH : null; })() : null;
      // 누를 때마다 다음 겹친 방으로 (옆으로 밀어 보여 줌)
      const at = { clash: -1, dup: -1 };
      const toFlag = (k) => {
        const hits = [...roomBox.querySelectorAll(`.rooms__name.is-${k}`)], box = roomBox.querySelector(".rooms__scroll");
        if (!hits.length) return;
        at[k] = (at[k] + 1) % hits.length;
        const c = hits[at[k]].parentElement;
        box.scrollLeft = c.offsetLeft - 60;
        c.querySelector(`.rooms__ev.is-${k}`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
      };
      const head = h("div", { class: "card__head" }, [
        h("h2", { class: "card__title", text: "회의실 예약 현황" }),
        h("span", { class: "muted small", text: rooms.length ? `${dateLabel(day)} · 일정 ${used}건 · 쓰는 방 ${usedRooms}곳` : "" }),
        clashes ? h("button", { type: "button", class: "rooms__flag", title: "겹친 방 보기", onclick: () => toFlag("clash"), text: `시간 겹침 ${clashes}건` }) : null,
        dups ? h("button", { type: "button", class: "rooms__flag rooms__flag--dup", title: "중복일 수 있는 방 보기", onclick: () => toFlag("dup"), text: `중복일 수 있음 ${dups}건` }) : null,
        isAdmin() ? h("button", { class: "btn btn--ghost btn--sm btn--admin", type: "button", title: "관리자 전용", onclick: roomsDialog }, [icon("lock"), "회의실 관리"]) : null
      ]);
      const offNote = hidden.length ? h("p", { class: "rooms__off", text: `왼쪽 '내 캘린더'에서 ${offNames.join(", ")}을(를) 꺼 두어서 회의실 일정 ${hidden.length}건이 안 보여요. 비어 보이는 방도 예약이 있을 수 있어요.` }) : null;
      const unreadNote = isAdmin() && unread.length ? h("div", { class: "rooms__unreadbox" }, [h("p", { class: "muted small" }, [adminBadge(), ` 회의실로 읽지 못한 표기 ${unread.length}개 · 눌러서 방을 정하거나 회의실이 아니라고 기억해요.`]), unreadChips(unread)]) : null;
      if (!rooms.length) return fill(roomBox, head, offNote, h("p", { class: "muted", text: offNote ? "보이는 일정 가운데 회의실 예약이 없어요." : "이 날은 회의실 예약이 없어요. 일정 제목 앞에 [A602]처럼 회의실을 적으면 여기에 보여요." }), unreadNote);
      const axis = h("div", { class: "rooms__axis", style: `height:${H}px` }, Array.from({ length: endH - startH }, (_, i) => h("span", { style: `top:${i * RH}px`, text: `${pad(startH + i)}:00` })));
      const FLAG = { clash: "시간 겹침", dup: "중복일 수 있음" };
      const col = (r) => {
        const list = byRoom.get(r), ov = over.get(r);
        const allDay = list.filter((e) => !e.startTime || e.startDate !== day);
        const items = list.filter((e) => e.startTime && e.startDate === day).map((e) => { const s0 = minutes(e.startTime); const en = e.endTime && e.endTime > e.startTime ? minutes(e.endTime) : s0 + 60; return { e, s: s0, en, lane: 0 }; }).sort((a, b) => a.s - b.s);
        for (const it of items) { const busyL = new Set(items.filter((x) => x !== it && x.s < it.en && x.en > it.s && items.indexOf(x) < items.indexOf(it)).map((x) => x.lane)); while (busyL.has(it.lane)) it.lane++; }
        const lanes = Math.max(1, ...items.map((x) => x.lane + 1));
        const body = h("div", { class: "rooms__body", style: `height:${H}px` }, [
          ...Array.from({ length: endH - startH }, (_, i) => h("i", { class: "rooms__line", style: `top:${i * RH}px` })),
          nowTop != null ? h("i", { class: "rooms__now", style: `top:${nowTop}px` }) : null,
          ...items.map((it) => { const f = ov.of.get(it.e); return h("button", {
            type: "button", class: `rooms__ev c${evColor(it.e)}` + (it.e.ext ? " is-ext" : "") + (f ? ` is-${f}` : "") + (f || editTag(it.e) ? (it.en - it.s < 55 ? " is-short" : it.en - it.s < 75 ? " is-mid" : "") : ""), "data-peek": evKey(it.e), onclick: () => openEv(it.e),
            title: `${f ? `[${FLAG[f]}] ` : ""}${it.e.title} · ${timeRange(it.e)}${it.e.location ? " · " + it.e.location : ""}`,
            style: `top:${((it.s - startH * 60) / 60) * RH}px;height:${Math.max(22, ((it.en - it.s) / 60) * RH - 2)}px;left:calc(100% * ${it.lane / lanes} + 2px);width:calc(100% / ${lanes} - 4px)`
          }, [f || editTag(it.e) ? h("span", { class: "rooms__evflags" }, [f ? h("em", { class: "rooms__evflag", text: FLAG[f] }) : null, editTag(it.e)]) : null, h("strong", { text: it.e.title }), h("span", { text: timeRange(it.e).replace(/^[^·]*·\s*/, "") })]); })
        ]);
        const flag = ov.clash ? "clash" : ov.dup ? "dup" : "";
        return h("div", { class: "rooms__col" + (lanes > 1 ? " is-wide" : "") }, [
          h("div", { class: "rooms__name" + (flag ? ` is-${flag}` : "") }, [h("strong", { text: r, title: r }), h("span", { class: "muted small" }, [list.length ? `${list.length}건` : "비어 있음", flag ? h("b", { text: ` · ${FLAG[flag]}` }) : null])]),
          allDay.length ? h("div", { class: "rooms__allday" }, allDay.map((e) => h("button", { type: "button", class: `rooms__chip c${evColor(e)}`, onclick: () => openEv(e) }, [editTag(e), `종일 · ${e.title}`]))) : h("div", { class: "rooms__allday" }),
          body
        ]);
      };
      const cols = rooms.map(col);
      fill(roomBox, head, offNote,
        h("div", { class: "rooms__scroll" }, h("div", { class: "rooms__grid", style: `grid-template-columns:52px ${cols.map((c, i) => (c.classList.contains("is-wide") ? "minmax(270px, 1.4fr)" : rooms[i].length > 9 ? "minmax(180px, 1fr)" : "minmax(130px, 1fr)")).join(" ")}` }, [
          h("div", { class: "rooms__axiswrap" }, [h("div", { class: "rooms__name rooms__name--blank" }), h("div", { class: "rooms__allday" }), axis]),
          ...cols
        ])),
        unreadNote,
        h("p", { class: "muted small", text: "일정 제목의 [A602] 같은 표기로 회의실을 잡아요. 분류를 골라도 여기는 모든 분류의 일정을 보여 줘요. 두 방을 쓰는 일정은 방마다 보여요. 눌러서 자세히 보거나 고칠 수 있어요." })
      );
    }
    setMain("today", [quickbar, findBox, roomBox, h("div", { class: "today-grid" }, [timelineBox, h("div", { class: "today-side" }, [tasksBox, memoBox])])]);

    let lastSig = "", findSig = "";
    // auto: 저절로 새로 읽을 때. 달라진 것이 없으면 화면을 건드리지 않음
    async function load(auto) {
      auto = auto === true;
      if (!auto) quiet(loadFind().catch((e) => { if (e.status !== 401) fill(findBox, failed(e)); }));
      const [ev, tk, mm] = await Promise.all([
        api(`/events?from=${day}&to=${day}`), api(`/tasks?date=${day}&today=${today()}`), api(`/memos?date=${day}`)
      ]);
      const sig = JSON.stringify([ev, tk, mm]);
      if (auto && (sig === lastSig || !calm())) return;
      lastSig = sig;
      const inCat = catFilter();
      const events = dedupeImported(allEvents(ev).filter((e) => showEv(e) && inCat(e)));
      const keep = roomBox.querySelector(".rooms__scroll")?.scrollLeft || 0;
      drawTimeline(events, (ev.moved || []).filter((l) => showEv(l) && inCat(l)));
      // 회의실 예약은 분류 거르기와 관계없이 그날 일정 전부로 (끈 캘린더는 안에서 빼고 알려 줌)
      drawRooms(allEvents(ev));
      const rs = roomBox.querySelector(".rooms__scroll");
      if (rs && keep) rs.scrollLeft = keep;
      drawTasks(tk.tasks.filter(inCat));
      memoList.replaceChildren(memoRows(mm.memos.filter(inCat), { empty: "이 날 남긴 메모가 없어요." }));
      markPeeked();
    }
    // 입력 중이거나 창·목록이 열려 있으면 다시 그리지 않고 다음 차례를 기다림 (빠른 메모·옆 패널은 다시 그리지 않으므로 괜찮음)
    function calm() {
      if (dialog.open || openPop) return false;
      const at = document.activeElement;
      if (/INPUT|TEXTAREA|SELECT/.test(at.tagName) && at.type !== "checkbox" && [findBox, roomBox, timelineBox, tasksBox, memoList].some((b) => b.contains(at))) return false;
      return ![findBox, tasksBox].some((b) => [...b.querySelectorAll("input, textarea")].some((x) => x.type !== "checkbox" && x.value.trim()));
    }
    async function autoLoad() {
      if (page?.reload !== load || document.visibilityState !== "visible" || !calm()) return;
      // 자정이 지나면 '오늘'을 새 날짜로
      if (day0 !== today() && day === day0 && /^#\/today\/?$/.test(location.hash || "#/today")) return pageToday();
      await load(true);
      await loadFind(true);
    }
    const day0 = today();

    function drawTimeline(events, movedList) {
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
          h("div", { class: "tl__evtop" }, [editTag(e), h("strong", { text: e.title }), h("span", { class: "tl__tags" }, [srcTag(e, true), ...tagChips(e.tagIds)])]),
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
        movedList.length ? h("ul", { class: "tl-moved" }, movedList.map((l) => h("li", { class: `tl-moved__row is-${l.what}` }, [
          h("span", { class: "tl-moved__what", text: l.what === "gone" ? "취소됨" : `옮김 → ${l.toDate}${l.toTime !== "종일" ? " " + l.toTime : ""}` }),
          l.id ? h("button", { class: "tl-moved__title", type: "button", "data-peek": evKey(l), onclick: () => openEv(l) }, [h("s", { text: l.title })]) : h("span", { class: "tl-moved__title" }, h("s", { text: l.title })),
          h("span", { class: "muted small", text: `원래 ${l.time}${l.ext ? " · " + l.calendarName : ""}` })
        ]))) : null,
        allDay.length ? h("div", { class: "tl-allday" }, [h("span", { class: "tl-allday__label", text: "종일" }), ...allDay.map((e) => h("button", { class: `chip c${evColor(e)}` + (e.ext ? " is-ext" : ""), type: "button", "data-peek": evKey(e), onclick: () => openEv(e) }, [editTag(e), srcTag(e, true), h("span", { text: e.title })]))]) : null,
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

    page = { name: "today", reload: load, auto: autoLoad };
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
          state.user.role === "director" ? " · 본부장 권한: 맡은 조직과 그 아래 조직 포함" : null])]));
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
      const foldBtn = h("button", { class: "icon-btn cal-fold" + (calFolded ? "" : " is-open"), type: "button", html: ICON.right, "aria-expanded": String(!calFolded), "aria-label": calFolded ? "달력 펼치기" : "달력 접기", title: calFolded ? "달력 펼치기" : "달력 접기", onclick: () => { calFolded = !calFolded; store.set("ps.calFold", calFolded ? "1" : "0"); draw(); } });
      return h("div", { class: "cal-head" }, [
        foldBtn,
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
    let calFolded = store.get("ps.calFold", "0") === "1"; // 달력 접기 (이 기기에 기억)
    function draw() {
      bodyBox = h("div", { class: "cal-body" });
      calCard.classList.toggle("is-folded", calFolded);
      calCard.replaceChildren(toolbar(), bodyBox);
      drawBody();
    }
    function drawBody() {
      const searching = !!state.search.trim();
      listCard.hidden = searching;
      if (searchToggle) searchToggle.hidden = !searching;
      bodyBox.hidden = calFolded && !searching; // 접어도 검색 결과는 보임
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
          goneTag(r), srcTag(r)
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
          ...ev.map((e) => h("button", { class: `chip c${evColor(e)}` + (e.startDate !== e.endDate ? " chip--span" : "") + (e.ext ? " is-ext" : ""), type: "button", "data-peek": evKey(e), title: `${e.sourceGone ? "[원본 지워짐] " : ""}${e.title} · ${whenLabel(e)}${e.ext ? ` · ${e.calendarName}` : ""}`, onclick: (x) => { x.stopPropagation(); openEv(e); } },
            [h("i", { class: "chip__dot" }), goneTag(e), srcTag(e, true), h("span", { text: (e.startTime && e.startDate === day ? e.startTime + " " : "") + e.title })])),
          ...tk.map((x) => h("button", { class: `chip chip--task c${KIND.task.color}` + (x.status === "done" ? " is-done" : ""), type: "button", "data-peek": `task:${x.id}`, title: `할 일 · ${x.title}`, onclick: (y) => { y.stopPropagation(); openPeek("task", x.id); } },
            [h("i", { class: "chip__box" }), h("span", { text: x.title })]))
        ];
        const gone = ev.filter((e) => e.sourceGone).length, goneMore = ev.slice(MAX_CHIPS).filter((e) => e.sourceGone).length;
        const cell = h("div", {
          class: "cal-day" + (d.getMonth() !== m ? " is-out" : "") + (day === t ? " is-today" : "") + (d.getDay() === 0 ? " is-sun" : d.getDay() === 6 ? " is-sat" : ""),
          role: "gridcell", tabindex: "0", "data-peek": `day:${day}`, "aria-label": `${dateLabel(day)}${n ? `, ${n}개` : ""}${gone ? `, 원본 지워짐 ${gone}건` : ""}`
        }, [
          h("span", { class: "cal-num", text: d.getDate() }),
          h("div", { class: "cal-chips" }, [...chips.slice(0, MAX_CHIPS), chips.length > MAX_CHIPS ? h("span", { class: "cal-more", text: `+${chips.length - MAX_CHIPS}개 더보기` }) : null, goneMore ? h("span", { class: "gone-tag", title: GONE_HINT, text: `원본 지워짐 ${goneMore}` }) : null]),
          gone ? h("span", { class: "cal-gone", "aria-hidden": "true", title: `원본 지워짐 ${gone}건`, text: "지워짐" }) : null,
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
      h("span", { class: "mrow__title" }, [goneTag(e), h("strong", { text: e.title }), e.ext ? h("span", { class: "ext-badge", text: e.calendarName }) : null, srcTag(e),
        (e.alsoIn || []).length ? h("span", { class: "ext-badge", title: `같은 WYD 일정이 ${e.alsoIn.map((x) => teamName(x.unitId)).join(", ")}에도 있어요`, text: `+${e.alsoIn.map((x) => teamName(x.unitId)).join(", ")}` }) : null, catChip(e.categoryId), ...tagChips(e.tagIds).slice(0, 2),
        e.openTasks ? h("span", { class: "mini-badge" }, [icon("check"), `할 일 ${e.openTasks}`]) : null,
        e.importantMemos ? h("span", { class: "mini-badge mini-badge--star" }, [icon("star"), String(e.importantMemos)]) : null]),
      h("span", { class: "mrow__people" }, [h("span", { class: "avatars" }, (e.attendeeIds.length ? e.attendeeIds : e.createdBy ? [e.createdBy] : []).slice(0, 3).map((id) => avatar(id, "sm"))), e.attendeeIds.length > 3 ? h("small", { text: `+${e.attendeeIds.length - 3}` }) : null, (e.guestNames || []).length ? h("small", { class: "muted", title: e.guestNames.join(", "), text: `외부 ${e.guestNames.length}` }) : null]),
      st ? h("span", { class: `status status--${st}`, text: MEETING_STATE[st] }) : h("span")
    ]));
  }

  /* ---------- 할 일 목록 ---------- */
  const taskFilter = { status: store.get("ps.taskStatus", "open"), who: store.get("ps.taskWho", "all"), day: "all", tag: null, q: "" };
  // 할 일·회의·메모 화면은 내가 등록한 것만 (다른 사람 것은 오늘·대시보드에서)
  const byMe = (x) => x.createdBy === state.user.id;
  const mineHint = (what) => h("p", { class: "muted small mine-hint" }, [icon("user"), ` 내가 등록한 ${what}만 보여요. 다른 사람이 등록한 것은 오늘·나의 대시보드에서 볼 수 있어요.`]);
  async function pageTasks() {
    document.title = `할 일 · ${TITLE}`;
    drawMini(null);
    const box = h("div", { class: "card tasks-card" }, loading());
    const filters = h("div", { class: "filters" });
    setMain("tasks", [h("div", { class: "page-head" }, [h("h1", { text: "할 일" }), h("button", { class: "btn btn--primary", type: "button", onclick: () => quickAdd("task") }, [icon("plus"), "할 일 추가"])]), mineHint("할 일"), filters, box]);
    let all = [];
    function drawFilters() {
      const seg = (key, opts, storeKey) => h("div", { class: "seg seg--sm" }, opts.map(([k, label]) => h("button", { type: "button", "aria-selected": String(taskFilter[key] === k), text: label, onclick: () => { taskFilter[key] = k; if (storeKey) store.set(storeKey, k); drawFilters(); drawList(); } })));
      const tagSel = h("select", { "aria-label": "태그" }, [h("option", { value: "", text: "모든 태그" }), ...state.tags.map((t) => h("option", { value: String(t.id), text: t.name }))]);
      tagSel.value = taskFilter.tag ? String(taskFilter.tag) : "";
      tagSel.addEventListener("change", () => { taskFilter.tag = tagSel.value ? Number(tagSel.value) : null; drawList(); });
      const search = h("label", { class: "search" }, [icon("search"), h("input", { type: "search", value: taskFilter.q, placeholder: "할 일 검색", "aria-label": "검색", oninput: (e) => { taskFilter.q = e.target.value; drawList(); } })]);
      fill(filters, seg("status", [["open", "미완료"], ["done", "완료"], ["all", "전체"]], "ps.taskStatus"), seg("day", [["all", "모든 날짜"], ["-1", "어제"], ["0", "오늘"], ["1", "내일"]]), tagSel, search);
    }
    function drawList() {
      const f = taskFilter;
      const list = all.filter((t) => (f.status === "all" || (f.status === "done" ? t.status === "done" : t.status !== "done"))
        && (!f.tag || t.tagIds.includes(f.tag)) && (!f.q || t.title.includes(f.q)));
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
    async function load() { all = (await api("/tasks")).tasks.filter(catFilter()).filter(byMe); drawList(); }
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
    setMain("meetings", [h("div", { class: "page-head" }, [h("h1", { text: "회의" }), h("button", { class: "btn btn--primary", type: "button", onclick: () => editEvent(null, { kind: "meeting" }) }, [icon("plus"), "회의 추가"])]), mineHint("회의"), h("div", { class: "filters" }, [search]), box]);
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
      ] : [h("p", { class: "empty", text: qv ? "찾는 회의가 없어요." : "내가 등록한 회의가 없어요." })]));
      markPeeked();
    }
    async function load() {
      const t = today();
      all = (await api(`/events?from=${shiftYmd(t, -180)}&to=${shiftYmd(t, 180)}`)).events.filter(catFilter()).filter(byMe);
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
    setMain("memos", [h("div", { class: "page-head" }, [h("h1", { text: "메모" })]), mineHint("메모"), h("div", { class: "card memo-compose" }, [h("h2", { class: "card__title", text: "빠른 메모" }), quickMemo(today())]), filters, box]);
    drawFilters();
    async function load() {
      const r = await api(`/memos${importantOnly ? "?important=1" : ""}`);
      const days = new Map();
      for (const m of r.memos.filter(catFilter()).filter(byMe)) { if (!days.has(m.date)) days.set(m.date, []); days.get(m.date).push(m); }
      box.replaceChildren(...(days.size ? [...days.entries()].map(([d, l]) => h("section", { class: "card memo-day" }, [
        h("a", { class: "memo-day__date", href: `#/today/${d}` }, [h("strong", { text: dateLabel(d) }), relDay(d) ? h("span", { class: "muted", text: relDay(d) }) : null]),
        memoRows(l)
      ])) : [h("div", { class: "card empty", text: importantOnly ? "내가 쓴 메모 중 중요 표시한 것이 없어요." : "내가 쓴 메모가 없어요." })]));
    }
    page = { name: "memos", reload: load };
    try { await load(); } catch (e) { if (e.status !== 401) box.replaceChildren(failed(e)); }
  }

  /* ---------- 공지 ---------- */
  const NOTICE_AUD = [["staff", "직원 전체"], ["all", "모든 권한 (봉사자 포함)"], ["lead", "본부장·관리자"], ["admin", "관리자만"]];
  const audTag = (k) => (k && k !== "staff" ? h("span", { class: "stock-tag", text: NOTICE_AUD.find(([x]) => x === k)?.[1] || k }) : null);
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
          h("div", { class: "notice-item__title" }, [n.pinned ? icon("pin", "pin") : null, h("strong", { text: n.title }), audTag(n.audience), n.unread ? h("span", { class: "new-badge", text: "새 글" }) : null]),
          h("p", { class: "notice-item__preview", text: n.preview }),
          h("div", { class: "notice-item__meta muted" }, [h("span", { text: n.author || "관리자" }), h("span", { text: dayOf(n.createdAt) }), n.comments ? h("span", { class: "with-icon" }, [icon("chat"), String(n.comments)]) : null])
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
          audTag(n.audience),
          h("div", { class: "muted notice-item__meta" }, [h("span", { text: n.author || "관리자" }), h("span", { text: dayOf(n.createdAt) }), n.updatedAt !== n.createdAt ? h("span", { text: "수정됨" }) : null]),
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
    const audience = h("select", {}, NOTICE_AUD.map(([k, t]) => h("option", { value: k, text: t })));
    audience.value = n?.audience || "staff";
    const submit = h("button", { class: "btn btn--primary", type: "submit", text: isNew ? "올리기" : "저장" });
    const form = h("form", { class: "stack", novalidate: true }, [
      field("제목", title), field("내용", body), field("공개 범위", audience, "고른 권한에게만 목록과 내용이 보여요"),
      h("label", { class: "check" }, [pinned, h("span", { text: "목록 맨 위에 고정" })]),
      err,
      h("div", { class: "actions" }, [h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), submit])
    ]);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      busy(submit, async () => {
        try {
          const payload = { title: title.value, body: body.value, pinned: pinned.checked, audience: audience.value };
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
          h("td", {}, u.role === "admin" ? adminBadge("관리자") : h("span", { class: "badge", text: u.role === "volunteer" ? (u.volKinds?.length > 1 ? "부서·팀 봉사자" : u.volKinds?.[0] === "team" ? "팀 봉사자" : "부서 봉사자") + (u.volLeader ? " · 리더" : "") : { director: "본부장" }[u.role] || "멤버" })),
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
    state.user = me.user; state.team = me.team; state.units = me.units || []; state.tags = me.tags; state.categories = me.categories || []; state.calendars = me.calendars || []; state.rooms = me.rooms || []; state.roomSkip = me.roomSkip || [];
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
    const vk = volKindPicker(role, ["dept"]);
    const submit = h("button", { class: "btn btn--admin", type: "submit", text: "발급" });
    const form = h("form", { class: "stack", novalidate: true }, [
      h("div", { class: "row2" }, [field("이름", name), field("소속", unitButton(unitId, (id) => { unitId = id; }), "조직도에서 고르기 (나중에 정해도 돼요)")]),
      field("아이디", login, "영문 소문자·숫자·._- 3~20자"),
      field("권한", role, "봉사자는 봉사자 전용 화면만 보고 소속 없이 관리돼요. 관리자는 조직도·멤버·분류·캘린더·백업 관리와 공지 쓰기를 할 수 있어요. 본부장은 맡은 조직(소속·연결한 조직도 자리)과 그 아래 조직의 회의·할 일·메모·연락처를 봐요. 관리 기능은 없어요"),
      vk.el,
      err,
      h("div", { class: "actions" }, [h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), submit])
    ]);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      busy(submit, async () => {
        try {
          const p = await api("/admin/users", { method: "POST", body: { name: name.value, unitId, login: login.value, role: role.value, ...(role.value === "volunteer" ? { volKinds: vk.kinds(), volLeader: vk.leader() } : {}) } });
          await reloadTeam();
          showIssued("계정을 만들었어요", p);
        } catch (ex) { showError(err, ex.message); (ex.field === "login" ? login : name).focus(); }
      });
    });
    openDialog("계정 발급", form, { admin: true });
  }

  // 봉사자 권한 고르기: 부서 봉사자(물류) · 팀 봉사자(교육&검수), 둘 다 고를 수 있음 (권한이 '봉사자'일 때만 보임)
  function volKindPicker(role, init, leaderInit) {
    const box = (k, label) => h("input", { type: "checkbox", checked: init.includes(k), "data-k": k, "aria-label": label });
    const dept = box("dept", "부서 봉사자(물류)"), team = box("team", "팀 봉사자(교육&검수)");
    const leader = h("input", { type: "checkbox", checked: !!leaderInit, "aria-label": "리더 봉사자" });
    const leaderRow = h("label", { class: "check vol-kind__leader" }, [leader, h("span", { text: "리더 봉사자 (교육 추가·지우기)" })]);
    const el = h("div", { class: "field" }, [h("span", { class: "field__label", text: "봉사자 권한 (여러 개 고를 수 있어요)" }),
      h("label", { class: "check" }, [dept, h("span", { text: "부서 봉사자(물류)" })]), h("label", { class: "check" }, [team, h("span", { text: "팀 봉사자(교육&검수)" })]), leaderRow,
      h("span", { class: "field__hint", text: "둘 다 고르면 로고 옆 버튼으로 화면을 바꿔 써요. 리더 봉사자는 팀 봉사자 중 교육(수도회 일정)을 추가하고 지울 수 있어요." })]);
    const sync = () => { el.hidden = role.value !== "volunteer"; leaderRow.hidden = !team.checked; };
    role.addEventListener("change", sync); team.addEventListener("change", sync); sync();
    return { el, kinds: () => [dept, team].filter((c) => c.checked).map((c) => c.dataset.k), leader: () => team.checked && leader.checked };
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
    const vk = volKindPicker(role, u.volKinds?.length ? u.volKinds : ["dept"], u.volLeader);
    const submit = h("button", { class: "btn btn--admin", type: "submit", text: "저장" });
    const form = h("form", { class: "stack", novalidate: true }, [
      h("div", { class: "row2" }, [field("이름", name), field("소속", unitButton(unitId, (id) => { unitId = id; }))]),
      // (field 는 <label> 이라 안에 체크 상자가 여럿이면 엉뚱한 것이 눌려서 div 로)
      h("div", { class: "field" }, [h("span", { class: "field__label", text: "추가로 볼 수 있는 조직" }), grantsBox, h("span", { class: "field__hint", text: "소속 말고도 이 조직의 회의·할 일·메모를 봐요. '아래 팀 포함'을 끄면 그 조직(부·본부 직속)만 봐요." })]),
      field("메모", note, "관리자만 보는 메모예요. 예전 '직책'은 여기로 옮겨 두었어요."),
      field("권한", role, "봉사자로 바꾸면 소속·추가로 볼 조직·조직도 자리 연결이 지워지고 봉사자 전용 화면만 봐요. 본부장은 맡은 조직(소속·연결한 조직도 자리)과 그 아래 조직의 회의·할 일·메모·연락처를 봐요. 관리 기능은 없어요"),
      vk.el, err,
      h("div", { class: "actions" }, [h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), submit])
    ]);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      busy(submit, async () => {
        try {
          await api(`/admin/users/${u.id}`, { method: "PATCH", body: { name: name.value, unitId, note: note.value, role: role.value, viewUnits: grants, ...(role.value === "volunteer" ? { volKinds: vk.kinds(), volLeader: vk.leader() } : {}) } });
          closeDialog(); toast("저장했어요.");
          await reloadTeam();
          if (isAdmin()) { buildLayout(); render(); } else go("#/today");
        } catch (ex) { showError(err, ex.message); }
      });
    });
    openDialog(`${u.login} 수정`, form, { admin: true });
  }

  /* ---------- 조직도 공통 ---------- */
  // 자리(직함·이름)는 P-Schedule 계정과 따로. 이름이 비면 공석, userId 로 계정 연결
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
      body.push(h("p", { class: "notice-box small", text: isAdmin() ? "P-Schedule 계정이 연결되지 않은 자리예요. '조직도 편집'의 계정 칸에서 연결하면 회의·할 일이 여기 보여요." : "P-Schedule 계정이 연결되지 않은 자리예요." }));
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
          h("thead", {}, h("tr", {}, ["순번", "본부", "부", "팀 · 분과", "직함", "이름", "P-Schedule 계정", "비고", ""].map((t) => h("th", { text: t })))),
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
      // 엑셀에서 수식으로 실행되지 않게: =, +, -, @, 탭으로 시작하면 앞에 ' 를 붙임
      const esc = (raw) => { const v = /^[=+\-@\t\r]/.test(String(raw)) ? `'${raw}` : String(raw); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
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
  // 항목 이미지 (관리자 전용): 인증 머리말이 필요해서 받아 와 Blob 주소로 보여 줌. 바뀐 시각으로 캐시
  const itemImgCache = new Map();
  function itemImageUrl(i) {
    const key = `${i.id}:${i.image}`;
    if (!itemImgCache.has(key)) itemImgCache.set(key, fetch(`${API}/project-items/${i.id}/image`, { headers: { Authorization: "Bearer " + state.token } }).then((r) => (r.ok ? r.blob() : null)).then((b) => (b ? URL.createObjectURL(b) : null)).catch(() => null));
    return itemImgCache.get(key);
  }
  function itemThumb(i, cls) {
    if (!i.image) return null;
    const img = h("img", { class: cls || "pj-thumb", alt: `${i.name} 이미지` });
    itemImageUrl(i).then((u) => { if (u) img.src = u; else img.remove(); });
    return img;
  }
  // 사진 열기: createImageBitmap 이 못 열면 <img> 로 한 번 더 (사파리는 HEIC 도 열림). 둘 다 안 되면 null
  async function decodeImage(file) {
    try { return await createImageBitmap(file); } catch { /* 아래에서 다시 시도 */ }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image(); img.src = url; await img.decode();
      return await createImageBitmap(img).catch(() => img);
    } catch { return null; } finally { setTimeout(() => URL.revokeObjectURL(url), 10000); }
  }
  // 올리기 전에 브라우저에서 줄이기: 긴 변 최대 900px, JPEG 로 46KB 안쪽이 될 때까지 화질·크기를 낮춤
  async function shrinkImage(file) {
    const heic = /^image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
    if (!heic && !/^image\/(jpeg|png|webp|gif)$/i.test(file.type) && !/\.(jpe?g|png|webp|gif)$/i.test(file.name)) throw new Error("이미지 파일을 골라 주세요.");
    const bmp = await decodeImage(file);
    if (!bmp) throw new Error(heic
      ? "이 브라우저는 HEIC 사진(아이폰·갤럭시 고효율 사진)을 열지 못해요. 사진을 JPG로 저장해 올리거나, 화면을 캡처해서 올려 주세요."
      : "사진을 열지 못했어요. 다른 사진을 고르거나 화면을 캡처해서 올려 주세요.");
    let scale = Math.min(1, 900 / Math.max(bmp.width, bmp.height));
    for (let round = 0; round < 6; round++) {
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(bmp.width * scale)); c.height = Math.max(1, Math.round(bmp.height * scale));
      const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
      for (const qv of [0.85, 0.75, 0.65, 0.55, 0.45]) {
        const b = await new Promise((ok) => c.toBlob(ok, "image/jpeg", qv));
        if (b && b.size <= 46000) return b;
      }
      scale *= 0.75;
    }
    throw new Error("이미지를 충분히 줄이지 못했어요. 다른 이미지를 골라 주세요.");
  }
  const blobToBase64 = (b) => new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1]); r.onerror = fail; r.readAsDataURL(b); });
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
        dashBox,
        h("div", { class: "filters" }, [unitSel]),
        sections.length ? h("div", { class: "stack" }, sections) : h("div", { class: "card empty", text: list.length ? "이 팀에는 아직 프로젝트가 없어요." : "아직 볼 수 있는 프로젝트가 없어요." })
      ]);
    };
    // 묵주 봉사자 대시보드: 기념품팀 프로젝트를 볼 수 있는 직원에게만 (봉사자가 입력·업데이트한 현황)
    const dashBox = h("div", { class: "stack vstat vstat--dash" });
    const loadDash = () => api("/projects/volunteer-dashboard").then((r) => fill(dashBox, ...r.groups.map((g) => volGroupSection(g, { compact: true, title: `묵주 봉사자 현황 · ${g.projectName}`, link: `#/projects/${g.projectId}/volunteer` })))).catch(() => fill(dashBox));
    page = { name: "projects", reload: async () => { list = (await api("/projects")).projects; draw(); quiet(loadDash()); } };
    try { await page.reload(); } catch (e) { if (e.status !== 401) setMain("projects", failed(e)); }
  }
  // 봉사자 현황: 묶음(묵주·손십자가)마다 요약, 최근 변동, 신청과 일정 대조
  function volunteerPanel(pid) {
    const box = h("div", { class: "stack vstat" }, loading());
    api(`/projects/${pid}/volunteer-status`).then((r) => fill(box, ...(r.groups.length ? r.groups.map(volGroupSection) : [h("div", { class: "card empty", text: "이 프로젝트에는 봉사자 묶음이 없어요." })]))).catch((e) => fill(box, failed(e)));
    return box;
  }
  const localAt = (at) => { if (!at) return ""; const d = new Date(`${at.replace(" ", "T")}Z`); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  // 수도회 이름 대조 (참고용): 띄어쓰기·괄호·흔한 낱말을 빼고 앞 3글자가 겹치면 같은 곳으로 봄
  const orgKey = (s) => { let v = String(s || "").replace(/\(.*?\)|\[.*?\]/g, "").replace(/[\s·]/g, "").replace(/^묵주교육/, ""); for (const w of ["수녀회", "수도회", "수녀원", "수녀", "회", "한국", "총원", "관구", "서울", "대구", "대전", "수원", "인천", "봉쇄"]) v = v.split(w).join(""); return v.replace(/\d+$/, ""); };
  // 월별 막대 (요청수량·교육물량): 숫자는 막대 위에, 이번 달은 강조
  function volMonthBars(rows) {
    const list = rows.filter((r) => r.req || r.edu);
    if (!list.length) return h("p", { class: "muted small", text: "아직 월별로 보여 줄 수량이 없어요." });
    const max = Math.max(...list.map((r) => Math.max(r.req, r.edu)), 1);
    const now = today().slice(0, 7);
    return h("div", { class: "vbars" }, [
      h("div", { class: "vbars__plot" }, list.map((r) => h("div", { class: "vbars__col" + (r.month === now ? " is-now" : ""), title: `${r.month} 요청 ${fmtN(r.req)} · 교육 ${fmtN(r.edu)}` }, [
        h("div", { class: "vbars__pair" }, [
          h("span", { class: "vbars__bar vbars__bar--req", style: `height:${Math.round((r.req / max) * 100)}%` }, h("em", { text: r.req ? fmtN(r.req) : "" })),
          h("span", { class: "vbars__bar vbars__bar--edu", style: `height:${Math.round((r.edu / max) * 100)}%` }, h("em", { text: r.edu ? fmtN(r.edu) : "" }))
        ]),
        h("span", { class: "vbars__label", text: `${r.month.slice(2, 4)}.${r.month.slice(5, 7)}` })
      ]))),
      h("div", { class: "vbars__legend muted small" }, [h("span", {}, [h("i", { class: "vbars__key vbars__bar--req" }), "요청수량"]), h("span", {}, [h("i", { class: "vbars__key vbars__bar--edu" }), "교육물량"])])
    ]);
  }
  const vProgress = (label, a, b, unit) => {
    const pct = b ? Math.min(100, Math.round((a / b) * 100)) : 0;
    return h("div", { class: "vprog" }, [
      h("div", { class: "vprog__head" }, [h("span", { text: label }), h("strong", { text: b ? `${pct}%` : "-" })]),
      h("div", { class: "vprog__bar" }, h("i", { style: `width:${pct}%` })),
      h("span", { class: "muted small", text: `${fmtN(a)} / ${fmtN(b)}${unit ? " " + unit : ""}` })
    ]);
  };
  function volGroupSection(g, opts = {}) {
    const unit = g.ledgers[0]?.unit || "개";
    const inT = g.ledgers.reduce((n, l) => n + l.inTotal, 0), outT = g.ledgers.reduce((n, l) => n + l.outTotal, 0);
    const t = today();
    const reqT = g.visits.reduce((n, v) => n + (v.qty || 0), 0), left = g.visits.filter((v) => v.date >= t).reduce((n, v) => n + (v.qty || 0), 0);
    const appT = g.requests.reduce((n, r) => n + (r.qty || 0), 0);
    const tile = (label, value, sub) => h("div", { class: "card vstat__tile" }, [h("span", { class: "muted small", text: label }), h("strong", { text: value }), sub ? h("span", { class: "muted small", text: sub }) : null]);
    // 신청 ↔ 일정 대조
    const used = new Set();
    const matchOf = (r) => {
      const k = orgKey(r.org); if (!k) return null;
      let best = null;
      for (const v of g.visits) {
        if (used.has(v.id)) continue;
        const vk = orgKey(v.title.replace(/^묵주 교육 · /, ""));
        if (!vk || !(k.includes(vk.slice(0, 3)) || vk.includes(k.slice(0, 3)))) continue;
        const dd = Math.abs((parseYmd(v.date) - parseYmd(r.date || v.date)) / 86400000);
        if (dd <= 60 && (!best || dd < best.dd)) best = { v, dd };
      }
      if (best) used.add(best.v.id);
      return best?.v || null;
    };
    const matched = g.requests.map((r) => ({ r, v: matchOf(r) }));
    const unassigned = matched.filter((x) => !x.v);
    const kindLabel = { stock: "입출고", qty: "요청수량", edu: "교육물량", mat: "실·십자가", material: "원자재", recovery: "회수" };
    const pastReq = g.visits.filter((v) => v.date < t).reduce((n, v) => n + (v.qty || 0), 0);
    const eduT = g.visits.reduce((n, v) => n + (v.eduQty || 0), 0);
    return h("section", { class: "card stack vstat__group" }, [
      h("div", { class: "card__head" }, [h("h2", { class: "card__title", text: opts.title || `${g.name} · 봉사자 현황` }), opts.link ? h("a", { class: "link-btn", href: opts.link, text: "자세히 보기" }) : h("span", { class: "muted small", text: "봉사자 화면에서 입력한 값이 바로 반영돼요" })]),
      h("div", { class: "vstat__tiles" }, [
        g.requests.length ? tile("수업 신청", `${g.requests.length}건`, `신청 수량 ${fmtN(appT)}${unassigned.length ? ` · 일정 미배정 ${unassigned.length}건` : ""}`) : null,
        tile("요청수량 (일정)", fmtN(reqT), `방문 ${g.visits.length}건 · 남음 ${fmtN(left)}`),
        tile("교육물량", fmtN(eduT), `적은 일정 ${g.visits.filter((v) => v.eduQty != null).length}건`),
        tile("추가 전달 물량", `실 ${fmtN(g.visits.reduce((n, v) => n + Math.max(0, moreThread(v) || 0), 0))} · 십자가 ${fmtN(g.visits.reduce((n, v) => n + Math.max(0, moreCross(v) || 0), 0))}`, `요청 − 출고, 더 보낼 곳 ${g.visits.filter((v) => (moreThread(v) || 0) > 0 || (moreCross(v) || 0) > 0).length}곳`),
        tile("실 · 십자가 출고", `${fmtN(g.visits.reduce((n, v) => n + (v.threadQty || 0), 0))} · ${fmtN(g.visits.reduce((n, v) => n + (v.crossQty || 0), 0))}`, "출납 대장 기준"),
        (() => { const both = g.visits.filter((v) => qtyDiff(v) != null); return tile("차액 (요청 − 교육)", diffText(both.length ? both.reduce((n, v) => n + qtyDiff(v), 0) : null), `둘 다 적힌 일정 ${both.length}건`); })(),
        tile("입고", `${fmtN(inT)} ${unit}`, g.ledgers.map((l) => l.name).join(", ") || "대장 없음"),
        tile("출고", `${fmtN(outT)} ${unit}`, `재고 ${fmtN(inT - outT)} ${unit}`),
        (() => { const st = g.recovery.stages || {}; return tile(g.name === "손십자가" ? "제품 (판매 가능)" : "완제품 (판매 가능)", fmtN((st.packed || 0) - (st.out || 0)), g.recovery.count ? `입고 ${fmtN(st.in || 0)} · 검수 ${fmtN(st.checked || 0)} · 패키징 ${fmtN(st.packed || 0)} · 출고 ${fmtN(st.out || 0)}` : "기록 없음"); })()
      ]),
      g.ledgers.length ? h("div", { class: "vstat__ledgers" }, g.ledgers.map((l) => h("a", { class: "stock-tag", href: `#/stock/${l.id}`, text: `${l.name} · 재고 ${fmtN(l.inTotal - l.outTotal)} ${l.unit}` }))) : null,
      h("div", { class: "vstat__dash" }, [
        h("div", { class: "vstat__panel" }, [h("h3", { class: "vstat__h", text: "월별 요청수량 · 교육물량" }), volMonthBars(g.monthly || [])]),
        h("div", { class: "vstat__panel vstat__progs" }, [
          h("h3", { class: "vstat__h", text: "진행률" }),
          vProgress("방문 진행 (다녀온 요청수량)", pastReq, reqT),
          vProgress("교육물량 / 요청수량", eduT, reqT),
          ...g.ledgers.map((l) => vProgress(`${l.name} 출고 / 입고`, l.outTotal, l.inTotal, l.unit)),
          g.requests.length ? vProgress("수업 신청 일정 배정", g.requests.length - unassigned.length, g.requests.length, "건") : null
        ])
      ]),
      h("h3", { class: "vstat__h", text: "최근 변동" }),
      g.changes.length ? h("ul", { class: "vstat__changes" }, g.changes.slice(0, opts.compact ? 6 : 20).map((c) => h("li", {}, [
        h("span", { class: "nowrap muted small", text: localAt(c.at) }),
        h("span", { class: "nowrap" }, [c.who || "-", c.volunteer ? h("span", { class: "stock-tag", text: "봉사자" }) : null]),
        h("span", { class: "stock-tag vstat__kind", text: kindLabel[c.kind] || c.kind }),
        c.ledgerId ? h("a", { href: `#/stock/${c.ledgerId}`, text: c.where }) : h("span", { text: c.where }),
        h("span", { class: "vstat__what", text: c.what })
      ]))) : h("p", { class: "muted", text: "아직 변동이 없어요." }),
      !opts.compact && g.changes.length > 20 ? h("p", { class: "muted small", text: `최근 20건만 보여요 (전체 ${g.changes.length}건). 대장별 자세한 기록은 입출고 관리에서 봐요.` }) : null,
      !opts.compact && g.requests.length ? h("details", { class: "vstat__more", open: unassigned.length > 0 }, [
        h("summary", {}, [`수업 신청과 일정 대조 (${g.requests.length}건)`, unassigned.length ? h("span", { class: "move-issue small", text: ` · 미배정 ${unassigned.length}건` }) : null]),
        h("p", { class: "muted small", text: "네이버폼 신청(연락처 제외)과 봉사자 일정을 수도회 이름으로 자동 대조한 참고용이에요. 합동 수업·이름이 다른 경우 틀릴 수 있어요." }),
        h("div", { class: "table-wrap" }, h("table", { class: "table" }, [
          h("thead", {}, h("tr", {}, ["번호", "수도회", "희망일", "신청 수량", "일정", "일정 수량"].map((x) => h("th", { text: x })))),
          h("tbody", {}, matched.map(({ r, v }) => h("tr", { class: v ? null : "vstat__miss" }, [
            h("td", { class: "num muted", text: r.no ?? "-" }), h("td", { text: r.org }), h("td", { class: "nowrap", text: r.date ? `${shortDate(r.date)}${r.time ? " " + r.time : ""}` : "-" }), h("td", { class: "num", text: r.qty != null ? fmtN(r.qty) : "-" }),
            h("td", { class: "nowrap", text: v ? `${shortDate(v.date)} ${v.title.replace(/^묵주 교육 · /, "")}` : "미배정" }), h("td", { class: "num" + (v && r.qty != null && v.qty != null && v.qty !== r.qty ? " move-issue" : ""), text: v?.qty != null ? fmtN(v.qty) : "-" })
          ])))
        ]))
      ]) : null,
      opts.compact ? null : h("details", { class: "vstat__more" }, [
        h("summary", {}, `요청수량 일정 (${g.visits.length}건)`),
        g.visits.length ? h("div", { class: "table-wrap" }, h("table", { class: "table" }, [
          h("thead", {}, h("tr", {}, ["번호", "날짜", "제작 수도회", "요청수량", "교육물량", "실 출고", "십자가 출고", "차액", "마지막 수정"].map((x) => h("th", { text: x })))),
          h("tbody", {}, g.visits.map((v, i) => h("tr", { class: v.date < t ? "is-past" : null }, [
            h("td", { class: "num muted", text: String(i + 1) }), h("td", { class: "nowrap", text: `${shortDate(v.date)}${v.startTime ? " " + v.startTime : ""}` }), h("td", { text: v.title.replace(/^묵주 교육 · /, "") + (v.place ? ` · ${v.place}` : "") }),
            h("td", { class: "num", text: v.qty != null ? fmtN(v.qty) : "-" }), h("td", { class: "num", text: v.eduQty != null ? fmtN(v.eduQty) : "-" }), h("td", { class: "num", text: v.threadQty != null ? fmtN(v.threadQty) : "-" }), h("td", { class: "num", text: v.crossQty != null ? fmtN(v.crossQty) : "-" }), h("td", { class: "num nowrap " + diffCls(qtyDiff(v)), text: diffText(qtyDiff(v)) }),
            h("td", { class: "muted small nowrap", text: [v.qtyBy ? `수량 ${v.qtyBy} ${localAt(v.qtyAt)}` : "", v.eduBy ? `교육 ${v.eduBy} ${localAt(v.eduAt)}` : ""].filter(Boolean).join(" · ") || "-" })
          ])))
        ])) : h("p", { class: "muted", text: "연결된 일정이 없어요." })
      ])
    ]);
  }

  async function pageProject(id) {
    drawMini(null);
    setMain("projects", loading());
    let data;
    const closed = new Set();
    let statusFilter = "";
    // 주소: #/projects/1 (구역이 있으면 구역 카드), #/projects/1/area/<구역>[/process], 구역이 없으면 #/projects/1[/process]
    const parts = location.hash.split("/");
    const COMMON = "-", COMMON_NAME = "프로젝트 공통";
    const area = parts[3] === "area" ? (parts[4] === COMMON ? "" : decodeURIComponent(parts[4] || "")) : null;
    const base = area === null ? `#/projects/${id}` : `#/projects/${id}/area/${parts[4]}`;
    const tabWord = area === null ? parts[3] : parts[5];
    // 상세 프로세스·협력업체는 우선 관리자만 (협력업체는 구역 안에서만)
    const tab = isAdmin() && tabWord === "process" ? "process" : isAdmin() && area && tabWord === "partner" ? "partner" : area === null && tabWord === "volunteer" ? "volunteer" : "items";
    let procs = [];
    const apply = (r) => { data = r; draw(); };
    const partnerOf = (a) => (data.areas || []).find((x) => x.area === a)?.partner || "";
    // 협력업체 관련 표시 (관리자에게만 값이 옴): 직접 체크했거나 위 묶음을 체크한 경우
    const partnerTag = (i) => {
      let c = i, on = false;
      while (c && !on) { on = !!c.partnerRelated; c = c.parentId ? data.items.find((x) => x.id === c.parentId) : null; }
      return on ? h("span", { class: "stock-tag pj-partner-tag", title: "협력업체 관련 (관리자에게만 보임)", text: partnerOf(areaOfItem(i)) || "협력업체" }) : null;
    };
    const areaOfItem = (i) => { let c = i; while (c && c.parentId) c = data.items.find((x) => x.id === c.parentId); return c?.area || ""; };
    // 협력업체 탭 (관리자 전용): 구역의 협력업체와 관련 항목·프로세스를 한눈에, 줄마다 체크
    let partnerOnly = false;
    function partnerPanel(p, inside) {
      const info = (data.areas || []).find((x) => x.area === area) || { partner: "", note: "" };
      const tops = data.items.filter((i) => !i.parentId && (i.area || "") === area);
      const allItems = data.items.filter((x) => areaOfItem(x) === area);
      const pr = procs.filter((r) => (r.area || "") === area);
      const itemOnes = allItems.filter((i) => i.kind === "item");
      const relItems = itemOnes.filter((i) => i.partnerRelated || (i.parentId && data.items.find((g) => g.id === i.parentId)?.partnerRelated));
      const relProcs = pr.filter((r) => r.partnerRelated);
      const late = (r) => r.dueDate && r.dueDate < today() && r.status !== "done" && r.status !== "hold";
      const next = relProcs.filter((r) => r.dueDate && r.dueDate >= today() && r.status !== "done" && r.status !== "hold").sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
      const edit = () => {
        const err = errorLine();
        const name = h("input", { value: info.partner, maxlength: "60", autofocus: true, placeholder: "예: 이노션" });
        const note = h("textarea", { rows: "3", maxlength: "500" }, info.note);
        const ok = h("button", { class: "btn btn--primary", type: "submit", text: "저장" });
        const form = h("form", { class: "stack", novalidate: true }, [field("협력업체", name, "아직 정해지지 않았으면 비워 두세요"), field("메모", note), err, h("div", { class: "actions" }, [h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), ok])]);
        form.addEventListener("submit", (e) => { e.preventDefault(); busy(ok, async () => { try { const r = await api(`/projects/${p.id}/areas`, { method: "PUT", body: { area, partner: name.value, note: note.value } }); closeDialog(); apply(r); } catch (ex) { showError(err, ex.message); } }); });
        openDialog(`${area} 협력업체`, form, { admin: true });
      };
      const check = (on, label, fn) => {
        const c = h("input", { type: "checkbox", checked: !!on, "aria-label": `${label} 협력업체 관련` });
        c.addEventListener("change", async () => { c.disabled = true; try { await fn(c.checked); } catch (ex) { toast(ex.message); c.checked = !c.checked; } finally { c.disabled = false; } });
        return c;
      };
      const setItem = async (i, on) => apply(await api(`/project-items/${i.id}`, { method: "PATCH", body: { partnerRelated: on } }));
      const setProc = async (r, on) => { procs = (await api(`/project-processes/${r.id}`, { method: "PATCH", body: { partnerRelated: on } })).processes; draw(); };
      const itemRows = tops.flatMap((t) => {
        const under = inside(t);
        const rows = [h("tr", { class: "pj-group" }, [h("td", {}, check(t.partnerRelated, t.name, (on) => setItem(t, on))), h("td", {}, h("strong", { text: t.name })), h("td", { class: "muted small", text: `항목 ${under.length}개 · 묶음 전체를 체크하면 아래 항목이 모두 관련으로 잡혀요` })])];
        for (const i of under) {
          const viaGroup = !i.partnerRelated && data.items.find((g) => g.id === i.parentId)?.partnerRelated;
          if (partnerOnly && !i.partnerRelated && !viaGroup) continue;
          rows.push(h("tr", {}, [h("td", {}, check(i.partnerRelated, i.name, (on) => setItem(i, on))), h("td", { text: i.name }), h("td", { class: "muted small", text: [projectStatusLabel(i.status), i.dueDate ? `마감 ${shortDate(i.dueDate)}` : "", viaGroup ? "묶음으로 관련" : ""].filter(Boolean).join(" · ") })]));
        }
        return partnerOnly && !t.partnerRelated && rows.length === 1 ? [] : rows;
      });
      const procRows = pr.filter((r) => !partnerOnly || r.partnerRelated).map((r) => h("tr", { class: r.status === "done" ? "is-done" : null }, [
        h("td", {}, check(r.partnerRelated, r.detail || r.task, (on) => setProc(r, on))),
        h("td", {}, [h("span", { text: r.detail || r.task }), h("small", { class: "muted pj-note", text: [r.section, r.phase, r.task].filter(Boolean).join(" › ") })]),
        h("td", { class: "nowrap small" + (late(r) ? " proc-late" : ""), text: [r.dueDate ? shortDate(r.dueDate) : "-", PROC_STATUS.find(([k]) => k === r.status)?.[1] || ""].join(" · ") })
      ]));
      const seg = h("div", { class: "seg seg--sm" }, [[false, "전체"], [true, "관련만"]].map(([k, label]) => h("button", { type: "button", "aria-selected": String(k === partnerOnly), text: label, onclick: () => { partnerOnly = k; draw(); } })));
      return h("div", { class: "stack" }, [
        h("section", { class: "card partner-card" }, [
          h("div", { class: "card__head" }, [h("h2", { class: "card__title" }, ["협력업체 ", h("strong", { class: info.partner ? "partner-name" : "muted", text: info.partner || "미정" })]), h("button", { class: "btn btn--ghost btn--sm", type: "button", text: info.partner ? "고치기" : "입력하기", onclick: edit })]),
          info.note ? h("p", { class: "vol-pre small", text: info.note }) : h("p", { class: "muted small", text: info.partner ? "아래에서 이 업체와 관련된 항목과 상세 프로세스를 체크해 주세요." : "협력업체가 정해지면 '입력하기'로 넣어 주세요. 체크는 지금도 할 수 있어요." })
        ]),
        h("div", { class: "unit-stats" }, [
          h("div", { class: "card unit-stat" }, [h("strong", { text: `${relItems.length}/${itemOnes.length}` }), h("span", { text: "관련 항목" })]),
          h("div", { class: "card unit-stat" }, [h("strong", { text: `${relProcs.length}/${pr.length}` }), h("span", { text: "관련 프로세스" })]),
          h("div", { class: "card unit-stat" }, [h("strong", { text: `${relProcs.filter((r) => r.status === "done").length}/${relProcs.length}` }), h("span", { text: "관련 프로세스 완료" })]),
          h("div", { class: "card unit-stat" + (relProcs.some(late) ? " is-warn" : "") }, [h("strong", { text: next ? shortDate(next.dueDate) : String(relProcs.filter(late).length) }), h("span", { text: next ? `다음: ${next.label || next.task}` : "관련 일정 지남" })])
        ]),
        h("div", { class: "filters" }, [seg]),
        h("section", { class: "card table-wrap" }, [h("h3", { class: "partner-sec__title", text: "항목" }), itemRows.length ? h("table", { class: "table partner-table" }, h("tbody", {}, itemRows)) : h("p", { class: "muted empty", text: partnerOnly ? "관련으로 체크한 항목이 없어요." : "이 구역에 항목이 없어요." })]),
        h("section", { class: "card table-wrap" }, [h("h3", { class: "partner-sec__title", text: "상세 프로세스" }), procRows.length ? h("table", { class: "table partner-table" }, h("tbody", {}, procRows)) : h("p", { class: "muted empty", text: partnerOnly ? "관련으로 체크한 프로세스가 없어요." : "이 구역에 상세 프로세스가 없어요." })])
      ]);
    }
    function itemDialog(item, defaults) {
      const v = item || defaults;
      const isGroup = v.kind === "group";
      const err = errorLine();
      const name = h("input", { value: item?.name || "", maxlength: "80", autofocus: true });
      const note = h("textarea", { rows: "3", maxlength: "1000" }, item?.note || "");
      const status = h("select", {}, PROJECT_STATUS.map(([k, label]) => h("option", { value: k, text: label })));
      status.value = item?.status || "none";
      const due = h("input", { type: "date", value: item?.dueDate || "" });
      const qty = h("input", { type: "number", min: "0", inputmode: "numeric", value: item?.qty ?? "" });
      // 이미지 (관리자, 이미 있는 항목만): 고르면 바로 줄여서 올림
      const imgBox = h("div", { class: "pj-imgbox" });
      const drawImg = (it) => {
        const file = h("input", { type: "file", accept: "image/*", class: "pj-imgbox__file" });
        file.addEventListener("change", async () => {
          const f = file.files[0]; if (!f) return;
          try {
            fill(imgBox, h("span", { class: "muted small", text: "올리는 중…" }));
            const blob = await shrinkImage(f);
            const r = await api(`/project-items/${it.id}/image`, { method: "PUT", body: { data: await blobToBase64(blob) } });
            apply(r); const now = r.items.find((x) => x.id === it.id); toast("이미지를 올렸어요."); drawImg(now);
          } catch (ex) { toast(ex.message); drawImg(it); }
        });
        fill(imgBox,
          it.image ? itemThumb(it, "pj-imgbox__img") : h("div", { class: "pj-imgbox__empty muted small", text: "이미지 없음" }),
          h("div", { class: "pj-imgbox__btns" }, [
            h("label", { class: "btn btn--ghost btn--sm" }, [it.image ? "바꾸기" : "이미지 올리기", file]),
            it.image ? h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "지우기", onclick: async () => { if (!confirm("이미지를 지울까요?")) return; const r = await act(() => api(`/project-items/${it.id}/image`, { method: "DELETE" })); apply(r); drawImg(r.items.find((x) => x.id === it.id)); } }) : null
          ]),
          h("p", { class: "muted small", text: "올릴 때 자동으로 작게 줄여요 (긴 변 최대 900px)." })
        );
      };
      if (item && !isGroup && isAdmin()) drawImg(item);
      const isTop = item ? !item.parentId : !v.parentId;
      const areaNames = [...new Set([...data.items.map((i) => i.area), ...procs.map((r) => r.area)].filter(Boolean))];
      const areaInput = h("input", { value: item ? item.area || "" : area || "", maxlength: "60", list: "pj-areas", placeholder: "예: 리테일굿즈" });
      const ok = h("button", { class: "btn btn--primary", type: "submit", text: item ? "저장" : "추가" });
      const form = h("form", { class: "stack", novalidate: true }, [
        field(isGroup ? "묶음 이름" : "항목 이름", name),
        isGroup ? null : h("div", { class: "row2" }, [field("상태", status), field("마감일", due)]),
        !isGroup && isAdmin() ? h("div", { class: "admin-fields" }, [
          h("div", { class: "admin-fields__head" }, adminBadge()),
          field("수량", qty, "예: 30000"),
          item ? h("div", { class: "field" }, [h("span", { class: "field__label", text: "이미지" }), imgBox]) : h("p", { class: "muted small", text: "이미지는 항목을 추가한 뒤 '고치기'에서 올릴 수 있어요." })
        ]) : null,
        isTop ? h("datalist", { id: "pj-areas" }, areaNames.map((x) => h("option", { value: x }))) : null,
        isTop ? field("구역", areaInput, "프로젝트 첫 화면을 나누는 이름이에요. 비우면 공통") : null,
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
            const body = { name: name.value, note: note.value, ...(isGroup ? {} : { status: status.value, dueDate: due.value || null }), ...(!isGroup && isAdmin() ? { qty: qty.value } : {}), ...(isTop ? { area: areaInput.value } : {}) };
            const r = await api(item ? `/project-items/${item.id}` : `/projects/${id}/items`, { method: item ? "PATCH" : "POST", body: item ? body : { ...body, kind: v.kind, parentId: v.parentId || null } });
            closeDialog(); apply(r);
          } catch (ex) { showError(err, ex.message); }
        });
      });
      openDialog(item ? `${isGroup ? "묶음" : "항목"} 고치기` : isGroup ? "묶음 추가" : "항목 추가", form);
    }
    function importDialog() {
      const err = errorLine();
      const paste = h("textarea", { rows: "12", autofocus: true, placeholder: "1. 순례자 키트\n* 티셔츠\n* 가방\n4-1. 묵주\n* 매듭 묵주\n※ 묶음에 붙일 메모" });
      const ok = h("button", { class: "btn btn--primary", type: "submit", text: "넣기" });
      const form = h("form", { class: "stack", novalidate: true }, [
        field("목록", paste, "'1.' 은 묶음, '4-1.' 은 그 아래 묶음, '*' 는 항목, '※' 는 묶음 메모가 돼요. 이미 있는 항목은 그대로 두고 뒤에 더해요."), err,
        h("div", { class: "actions" }, [h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), ok])
      ]);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        busy(ok, async () => {
          try { const r = await api(`/projects/${id}/import`, { method: "POST", body: { text: paste.value, area: area || "" } }); closeDialog(); apply(r); }
          catch (ex) { showError(err, ex.message); }
        });
      });
      openDialog("목록 붙여넣기", form);
    }
    const patchItem = async (i, body) => apply(await act(() => api(`/project-items/${i.id}`, { method: "PATCH", body })));
    function draw() {
      const p = data.project;
      document.title = `${p.name} · ${TITLE}`;
      const kids = (pid) => data.items.filter((i) => (i.parentId || null) === pid && (pid !== null || area === null || (i.area || "") === area));
      const inside = (g) => data.items.filter((k) => k.parentId === g.id).flatMap((k) => (k.kind === "group" ? inside(k) : [k]));
      const shows = (i) => !statusFilter || i.status === statusFilter;
      // 구역 카드: 구역이 하나라도 있으면 프로젝트 첫 화면
      const named = [...new Set([...data.items.filter((i) => !i.parentId).map((i) => i.area), ...procs.map((r) => r.area)].filter(Boolean))];
      if (named.length && area === null && tab !== "process") return drawAreas(p, named, inside);
      const rows = [];
      const walk = (pid, depth) => {
        for (const i of kids(pid)) {
          const pad = `padding-left:${14 + depth * 20}px`;
          if (i.kind === "group") {
            const under = inside(i);
            if (statusFilter && !under.some(shows)) continue;
            const open = !closed.has(i.id);
            rows.push(h("tr", { class: "pj-group" }, [
              h("td", { colspan: isAdmin() ? "4" : "3", style: pad }, h("div", { class: "pj-group__row" }, [
                h("button", { class: "org-row__chev" + (open ? " is-open" : ""), type: "button", "aria-label": `${i.name} ${open ? "접기" : "펼치기"}`, html: ICON.right, onclick: () => { open ? closed.add(i.id) : closed.delete(i.id); draw(); } }),
                h("button", { class: "pj-name", type: "button", onclick: () => itemDialog(i) }, [h("strong", { text: i.name })]), partnerTag(i),
                h("span", { class: "muted small", text: `${under.filter((x) => x.status === "done").length}/${under.length}` }),
                i.note ? h("span", { class: "muted small pj-note", text: i.note }) : null
              ])),
              h("td", { class: "pj-actions" }, h("button", { class: "link-btn", type: "button", text: "+ 항목", onclick: () => itemDialog(null, { kind: "item", parentId: i.id }) }))
            ]));
            if (open) walk(i.id, depth + 1);
          } else if (shows(i)) {
            const st = h("select", { class: `pj-select pj-st--${i.status}`, "aria-label": `${i.name} 상태`, onchange: (e) => patchItem(i, { status: e.target.value }) }, PROJECT_STATUS.map(([k, label]) => h("option", { value: k, text: label })));
            st.value = i.status;
            const due = h("input", { type: "date", class: "inline inline--box", value: i.dueDate || "", "aria-label": `${i.name} 마감일`, onchange: (e) => patchItem(i, { dueDate: e.target.value || null }) });
            rows.push(h("tr", { class: i.status === "done" ? "is-done" : null }, [
              h("td", { class: "pj-itemname", style: pad }, [itemThumb(i), h("button", { class: "pj-name", type: "button", onclick: () => itemDialog(i), text: i.name }), partnerTag(i), i.note ? h("small", { class: "muted pj-note", text: i.note }) : null]),
              h("td", { "data-label": "상태" }, st),
              h("td", { "data-label": "마감" }, due),
              isAdmin() ? h("td", { "data-label": "수량", class: "num pj-qty", text: i.qty != null ? fmtN(i.qty) : "-" }) : null,
              h("td", { class: "pj-actions" })
            ]));
          }
        }
      };
      walk(null, 0);
      const filter = h("select", { "aria-label": "상태로 거르기", onchange: (e) => { statusFilter = e.target.value; draw(); } }, [h("option", { value: "", text: "모든 상태" }), ...PROJECT_STATUS.map(([k, label]) => h("option", { value: k, text: label }))]);
      filter.value = statusFilter;
      setMain("projects", [
        h("nav", { class: "muted small" }, area === null ? h("a", { href: "#/projects", text: "프로젝트" }) : [h("a", { href: "#/projects", text: "프로젝트" }), " › ", h("a", { href: `#/projects/${id}`, text: p.name })]),
        h("div", { class: "page-head page-head--wrap" }, [
          h("h1", { text: area === null ? p.name : area || COMMON_NAME }),
          h("span", { class: "muted small", title: p.unitId ? unitLabel(p.unitId) : null, text: p.unitId && unitOf(p.unitId) ? unitShort(p.unitId) : "팀 없음" }),
          area !== null ? null : h("span", { class: "page-head__end actions" }, [
            h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "고치기", onclick: () => projectDialog(p, apply) }),
            p.canDelete ? h("button", { class: "btn btn--danger-outline btn--sm", type: "button", text: "지우기", onclick: async () => {
              if (!confirm(`'${p.name}' 프로젝트와 그 안의 항목·상세 프로세스를 모두 지울까요?`)) return;
              await act(() => api(`/projects/${p.id}`, { method: "DELETE" }));
              go("#/projects");
            } }) : null
          ])
        ]),
        area === null && p.note ? h("p", { class: "muted pj-desc", text: p.note }) : null,
        isAdmin() || (area === null && data.volGroups?.length) ? h("div", { class: "seg pj-tabs", role: "tablist" }, [["items", named.length && area === null ? "구역" : "항목"], ...(area === null && data.volGroups?.length ? [["volunteer", "봉사자 현황"]] : []), ...(isAdmin() ? [["process", "상세 프로세스"]] : []), ...(area && isAdmin() ? [["partner", "협력업체"]] : [])].map(([k, label]) => h("button", { type: "button", role: "tab", "aria-selected": String(k === tab), title: k === "process" || k === "partner" ? "관리자만 볼 수 있어요" : null, onclick: () => go(k === "items" ? base : `${base}/${k}`) }, k === "process" || k === "partner" ? [label, " ", adminBadge()] : label))) : null,
        ...(tab === "volunteer" ? [volunteerPanel(id)] : tab === "partner" ? [partnerPanel(p, inside)] : tab === "process" ? [processPanel(id, area, () => (area === null ? p.name : `${p.name} ${area || COMMON_NAME}`))] : [area === null ? projectBar(p) : (() => { const its = kids(null).flatMap((k) => (k.kind === "group" ? inside(k) : [k])); return projectBar({ total: its.length, done: its.filter((x) => x.status === "done").length }); })(),
        h("div", { class: "filters" }, [
          filter,
          h("span", { class: "filters__end actions" }, [
            h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "목록 붙여넣기", onclick: importDialog }),
            h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "+ 묶음", onclick: () => itemDialog(null, { kind: "group" }) }),
            h("button", { class: "btn btn--primary btn--sm", type: "button", text: "+ 항목", onclick: () => itemDialog(null, { kind: "item" }) })
          ])
        ]),
        rows.length ? h("div", { class: "card table-wrap" }, h("table", { class: "table pj-table" }, [
          h("thead", {}, h("tr", {}, [...["이름", "상태", "마감", ...(isAdmin() ? ["수량"] : [])].map((t) => h("th", { class: t === "수량" ? "num" : null, text: t })), h("th", { "aria-label": "추가" })])),
          h("tbody", {}, rows)
        ])) : h("div", { class: "card empty", text: data.items.length ? "이 상태의 항목이 없어요." : "아직 항목이 없어요. '+ 항목'이나 '목록 붙여넣기'로 넣어 주세요." })
        ])
      ]);
    }
    // 구역 카드: 구역마다 항목·프로세스 현황
    function drawAreas(p, named, inside) {
      const card = (key, name) => {
        const tops = data.items.filter((i) => !i.parentId && (i.area || "") === key);
        const its = tops.flatMap((k) => (k.kind === "group" ? inside(k) : [k]));
        const pr = procs.filter((r) => (r.area || "") === key);
        const prDone = pr.filter((r) => r.status === "done").length;
        const late = pr.filter((r) => r.dueDate && r.dueDate < today() && r.status !== "done" && r.status !== "hold").length;
        const next = pr.filter((r) => r.dueDate && r.dueDate >= today() && r.status !== "done" && r.status !== "hold").sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
        const enc = key ? encodeURIComponent(key) : COMMON;
        return h("a", { class: "card pj-card pj-area", href: `#/projects/${id}/area/${enc}${!tops.length && pr.length ? "/process" : ""}` }, [
          h("strong", { class: "pj-area__name", text: name }),
          isAdmin() && key ? h("span", { class: "small pj-area__partner", title: "관리자에게만 보여요" }, ["협력업체 ", h("strong", { text: partnerOf(key) || "미정" })]) : null,
          tops.length ? h("span", { class: "muted small pj-area__groups", text: tops.map((t) => t.name.split(" (")[0]).join(" · ") }) : null,
          tops.length ? projectBar({ total: its.length, done: its.filter((x) => x.status === "done").length }) : null,
          pr.length ? h("span", { class: "small", text: `상세 프로세스 ${prDone}/${pr.length} 완료` }) : null,
          late ? h("span", { class: "small proc-late", text: `일정 지남 ${late}건` }) : null,
          next ? h("span", { class: "muted small", text: `다음 ${shortDate(next.dueDate)} · ${next.label || next.task}` }) : null
        ]);
      };
      const common = data.items.some((i) => !i.parentId && !i.area) || procs.some((r) => !r.area);
      setMain("projects", [
        h("nav", { class: "muted small" }, h("a", { href: "#/projects", text: "프로젝트" })),
        h("div", { class: "page-head page-head--wrap" }, [
          h("h1", { text: p.name }),
          h("span", { class: "muted small", title: p.unitId ? unitLabel(p.unitId) : null, text: p.unitId && unitOf(p.unitId) ? unitShort(p.unitId) : "팀 없음" }),
          h("span", { class: "page-head__end actions" }, [
            h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "+ 묶음", onclick: () => itemDialog(null, { kind: "group" }) }),
            h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "고치기", onclick: () => projectDialog(p, apply) }),
            p.canDelete ? h("button", { class: "btn btn--danger-outline btn--sm", type: "button", text: "지우기", onclick: async () => {
              if (!confirm(`'${p.name}' 프로젝트와 그 안의 항목·상세 프로세스를 모두 지울까요?`)) return;
              await act(() => api(`/projects/${p.id}`, { method: "DELETE" }));
              go("#/projects");
            } }) : null
          ])
        ]),
        p.note ? h("p", { class: "muted pj-desc", text: p.note }) : null,
        isAdmin() || data.volGroups?.length ? h("div", { class: "seg pj-tabs", role: "tablist" }, [
          h("button", { type: "button", role: "tab", "aria-selected": String(tab !== "volunteer"), text: "구역", onclick: () => go(`#/projects/${id}`) }),
          data.volGroups?.length ? h("button", { type: "button", role: "tab", "aria-selected": String(tab === "volunteer"), title: "봉사자가 입력한 요청수량·입고·출고·완제품과 최근 변동", onclick: () => go(`#/projects/${id}/volunteer`) }, "봉사자 현황") : null,
          isAdmin() ? h("button", { type: "button", role: "tab", "aria-selected": "false", title: "프로젝트 전체 WBS와 PDF. 관리자만 볼 수 있어요", onclick: () => go(`#/projects/${id}/process`) }, ["상세 프로세스", " ", adminBadge()]) : null
        ]) : null,
        tab === "volunteer" ? volunteerPanel(id) : h("div", { class: "pj-areas" }, [...named.map((n) => card(n, n)), common ? card("", COMMON_NAME) : null])
      ]);
    }
    page = { name: "projects", reload: async () => { const [d, r] = await Promise.all([api(`/projects/${id}`), isAdmin() ? api(`/projects/${id}/processes`) : { processes: [] }]); procs = r.processes; apply(d); } };
    try { await page.reload(); } catch (e) { if (e.status !== 401) setMain("projects", failed(e)); }
  }

  /* ---------- 상세 프로세스: 구분 > 단계 > 세부 업무, 목록과 일정표 ---------- */
  const PROC_STATUS = [["todo", "예정"], ["doing", "진행"], ["done", "완료"], ["hold", "보류"]];
  const procFilter = { section: "", status: "" };
  // 받은 JPEG 페이지(캔버스)를 PDF 파일로 묶기
  function jpegPagesToPdf(canvases, w, h) {
    const enc = new TextEncoder();
    const parts = [];
    let size = 0;
    const offsets = [];
    const write = (x) => { const b = typeof x === "string" ? enc.encode(x) : x; parts.push(b); size += b.length; };
    const n = canvases.length;
    const obj = (id, fn) => { offsets[id] = size; write(`${id} 0 obj\n`); fn(); write("\nendobj\n"); };
    write("%PDF-1.4\n");
    obj(1, () => write("<< /Type /Catalog /Pages 2 0 R >>"));
    obj(2, () => write(`<< /Type /Pages /Count ${n} /Kids [${canvases.map((_, i) => `${3 + i * 3} 0 R`).join(" ")}] >>`));
    canvases.forEach((c, i) => {
      const base = 3 + i * 3;
      const raw = atob(c.toDataURL("image/jpeg", 0.9).split(",")[1]);
      const img = new Uint8Array(raw.length);
      for (let k = 0; k < raw.length; k++) img[k] = raw.charCodeAt(k);
      const draw = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
      obj(base, () => write(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${base + 1} 0 R >> >> /Contents ${base + 2} 0 R >>`));
      obj(base + 1, () => { write(`<< /Type /XObject /Subtype /Image /Width ${c.width} /Height ${c.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.length} >>\nstream\n`); write(img); write("\nendstream"); });
      obj(base + 2, () => write(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`));
    });
    const count = 3 + n * 3;
    const xref = size;
    write(`xref\n0 ${count}\n0000000000 65535 f \n`);
    for (let id = 1; id < count; id++) write(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
    write(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(parts, { type: "application/pdf" });
  }
  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = h("a", { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  function processPanel(projectId, area, pdfTitle) {
    const box = h("div", { class: "stack" }, loading());
    let list = [];
    const closed = new Set();
    const uniq = (xs) => [...new Set(xs.filter(Boolean))];
    const late = (r) => r.dueDate && r.dueDate < today() && r.status !== "done" && r.status !== "hold";
    const when = (r) => (r.startDate && r.dueDate && r.startDate !== r.dueDate ? `${shortDate(r.startDate)}~${shortDate(r.dueDate)}` : r.dueDate ? shortDate(r.dueDate) : r.startDate ? shortDate(r.startDate) : "-");
    const yearOf = (r) => (r.dueDate || r.startDate || "").slice(0, 4);
    const whenFull = (r) => { const y = yearOf(r); return y && y !== today().slice(0, 4) ? `${y}년 ${when(r)}` : when(r); };
    function dialog(r, preset) {
      const err = errorLine();
      const v = r || preset || {};
      const areaInput = h("input", { value: r ? r.area || "" : area || "", maxlength: "60", list: "proc-areas" });
      const options = (id, vals) => h("datalist", { id }, vals.map((x) => h("option", { value: x })));
      const section = h("input", { value: v.section || "", maxlength: "60", list: "proc-sections", placeholder: "예: 순례자 키트" });
      const phase = h("input", { value: v.phase || "", maxlength: "60", list: "proc-phases", placeholder: "예: 디자인/기획" });
      const task = h("input", { value: v.task || "", maxlength: "120", list: "proc-tasks", autofocus: true, placeholder: "예: 제품 기획" });
      const detail = h("textarea", { rows: "2", maxlength: "500" }, v.detail || "");
      const output = h("input", { value: v.output || "", maxlength: "200" });
      const label = h("input", { value: v.label || "", maxlength: "40" });
      const start = h("input", { type: "date", value: v.startDate || "" });
      const due = h("input", { type: "date", value: v.dueDate || "" });
      const status = h("select", {}, PROC_STATUS.map(([k, t]) => h("option", { value: k, text: t })));
      status.value = v.status || "todo";
      const note = h("textarea", { rows: "2", maxlength: "1000" }, v.note || "");
      const ok = h("button", { class: "btn btn--primary", type: "submit", text: r ? "저장" : "추가" });
      const form = h("form", { class: "stack", novalidate: true }, [
        options("proc-sections", uniq(list.map((x) => x.section))), options("proc-phases", uniq(list.map((x) => x.phase))), options("proc-tasks", uniq(list.map((x) => x.task))), options("proc-areas", uniq(list.map((x) => x.area))),
        h("div", { class: "row2" }, [field("구분", section), field("단계", phase)]),
        field("세부 업무", task), field("진행 상세", detail), field("산출물 · 과업", output),
        h("div", { class: "row2" }, [field("시작일", start), field("예정일", due)]),
        h("div", { class: "row2" }, [field("상태", status), field("일정표 표시 이름", label, "비우면 세부 업무로 보여요")]),
        field("구역", areaInput, "비우면 프로젝트 공통이에요"),
        field("메모", note), err,
        h("div", { class: "actions" }, [
          r ? h("button", { class: "btn btn--danger-outline btn--sm", type: "button", text: "지우기", onclick: async () => {
            if (!confirm(`'${r.detail || r.task}' 프로세스를 지울까요?`)) return;
            list = (await act(() => api(`/project-processes/${r.id}`, { method: "DELETE" }))).processes;
            closeDialog(); draw();
          } }) : null,
          h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), ok
        ])
      ]);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        busy(ok, async () => {
          try {
            const body = { section: section.value, phase: phase.value, task: task.value, detail: detail.value, output: output.value, label: label.value, startDate: start.value || null, dueDate: due.value || null, status: status.value, note: note.value, area: areaInput.value };
            list = (await api(r ? `/project-processes/${r.id}` : `/projects/${projectId}/processes`, { method: r ? "PATCH" : "POST", body })).processes;
            closeDialog(); draw();
          } catch (ex) { showError(err, ex.message); }
        });
      });
      openDialog(r ? "프로세스 고치기" : "프로세스 추가", form, { wide: true });
    }
    const statusSel = (r) => {
      const st = h("select", { class: `pj-select proc-st--${r.status}`, "aria-label": `${r.detail || r.task} 상태`, onclick: (e) => e.stopPropagation(), onchange: async (e) => {
        list = (await act(() => api(`/project-processes/${r.id}`, { method: "PATCH", body: { status: e.target.value } }))).processes; draw();
      } }, PROC_STATUS.map(([k, t]) => h("option", { value: k, text: t })));
      st.value = r.status;
      return st;
    };
    // 구분 → 단계 순서는 처음 나온 순서대로
    const grouped = (rows) => uniq(rows.map((r) => r.section || "구분 없음")).map((section) => {
      const inSec = rows.filter((r) => (r.section || "구분 없음") === section);
      return { section, rows: inSec, phases: [...new Set(inSec.map((r) => r.phase))].map((phase) => ({ phase, rows: inSec.filter((r) => r.phase === phase) })) };
    });
    const listView = (groups) => h("div", { class: "stack" }, groups.map((g) => {
      const open = !closed.has(g.section);
      const done = g.rows.filter((r) => r.status === "done").length;
      return h("section", { class: "card proc-sec" }, [
        h("div", { class: "proc-sec__head" }, [
          h("button", { class: "org-row__chev" + (open ? " is-open" : ""), type: "button", "aria-label": `${g.section} ${open ? "접기" : "펼치기"}`, html: ICON.right, onclick: () => { if (open) closed.add(g.section); else closed.delete(g.section); draw(); } }),
          h("h2", { class: "card__title", text: g.section }),
          h("span", { class: "muted small", text: `${done}/${g.rows.length} 완료` }),
          h("button", { class: "link-btn proc-sec__add", type: "button", text: "+ 프로세스", onclick: () => dialog(null, { section: g.section === "구분 없음" ? "" : g.section }) })
        ]),
        open ? h("div", { class: "table-wrap" }, h("table", { class: "table proc-table" }, [
          h("thead", {}, h("tr", {}, ["단계", "세부 업무", "진행 상세", "산출물 · 과업", "일정", "상태"].map((t) => h("th", { text: t })))),
          h("tbody", {}, g.phases.flatMap((ph) => ph.rows.map((r, i) => h("tr", { class: "stock-row" + (r.status === "done" ? " is-done" : ""), tabindex: "0", title: "눌러서 고치기", onclick: () => dialog(r), onkeydown: (e) => { if (e.key === "Enter" && e.target === e.currentTarget) dialog(r); } }, [
            h("td", { class: "proc-phase", text: i === 0 ? ph.phase : "" }),
            h("td", { class: "proc-task", text: r.task }),
            h("td", {}, [r.detail, r.note ? h("small", { class: "muted proc-note", text: r.note }) : null]),
            h("td", { class: "muted small", text: r.output || "-" }),
            h("td", { class: "nowrap" + (late(r) ? " proc-late" : ""), text: `${whenFull(r)}${late(r) ? " 지남" : ""}` }),
            h("td", {}, statusSel(r))
          ]))))
        ])) : null
      ]);
    }));
    // WBS: 구분 > 단계 > 세부 업무 > 진행 상세, 번호와 진척률 (완료 100, 진행 50, 나머지 0 의 평균)
    const rollup = (rows) => {
      const dates = rows.flatMap((r) => [r.startDate, r.dueDate]).filter(Boolean).sort();
      const score = rows.reduce((n, r) => n + (r.status === "done" ? 100 : r.status === "doing" ? 50 : 0), 0);
      return { start: dates[0] || null, end: dates[dates.length - 1] || null, pct: rows.length ? Math.round(score / rows.length) : 0, done: rows.filter((r) => r.status === "done").length, total: rows.length, late: rows.filter(late).length };
    };
    const wbsTree = (groups) => groups.map((g, gi) => {
      const code = String(gi + 1);
      return { code, level: 0, name: g.section, rows: g.rows, ...rollup(g.rows), kids: g.phases.map((ph, pi) => {
        const pc = `${code}.${pi + 1}`;
        const tasks = [...new Set(ph.rows.map((r) => r.task))];
        return { code: pc, level: 1, name: ph.phase || "단계 없음", rows: ph.rows, ...rollup(ph.rows), kids: tasks.map((t, ti) => {
          const tc = `${pc}.${ti + 1}`;
          const rows = ph.rows.filter((r) => r.task === t);
          if (rows.length === 1) return { code: tc, level: 2, name: rows[0].detail || t, sub: rows[0].detail ? t : "", leaf: rows[0], rows, ...rollup(rows), kids: [] };
          return { code: tc, level: 2, name: t, rows, ...rollup(rows), kids: rows.map((r, ri) => {
            const repeat = r.detail && r.output && rows.filter((x) => x.detail === r.detail).length > 1; // 같은 진행 상세가 여러 줄이면 산출물까지 이름에
            return { code: `${tc}.${ri + 1}`, level: 3, name: repeat ? `${r.detail} · ${r.output}` : r.detail || r.output || t, sub: !repeat && r.detail && r.output ? r.output : "", leaf: r, rows: [r], ...rollup([r]), kids: [] };
          }) };
        }) };
      }) };
    });
    const flatten = (nodes, respectClosed) => nodes.flatMap((n) => [n, ...(respectClosed && closed.has(`w${n.code}`) ? [] : flatten(n.kids, respectClosed))]);
    const barKind = (n) => (n.leaf ? (late(n.leaf) ? "late" : n.leaf.status) : n.late ? "late" : n.pct === 100 ? "done" : "doing");
    const DAY = 86400000, WEEK_W = 24;
    const wbsView = (groups) => {
      const tree = wbsTree(groups);
      const all = flatten(tree, false);
      const dates = all.flatMap((n) => [n.start, n.end]).filter(Boolean).sort();
      if (!dates.length) return h("div", { class: "card empty", text: "날짜가 있는 프로세스가 아직 없어요." });
      const mondayOf = (s) => { const d = parseYmd(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; };
      const from = mondayOf(dates[0]);
      const to = mondayOf(dates[dates.length - 1]); to.setDate(to.getDate() + 7);
      const dayX = (s) => Math.round((parseYmd(s) - from) / DAY) * (WEEK_W / 7);
      const width = (Math.round((to - from) / DAY) / 7) * WEEK_W;
      const months = [];
      for (const d = new Date(from.getFullYear(), from.getMonth(), 1); d < to; d.setMonth(d.getMonth() + 1)) {
        months.push(h("span", { class: "gantt__month", style: `left:${Math.max(0, dayX(ymd(d)))}px`, text: d.getMonth() === 0 || !months.length ? `${String(d.getFullYear()).slice(2)}년 ${d.getMonth() + 1}월` : `${d.getMonth() + 1}월` }));
      }
      const t = today();
      const todayLine = () => (t >= ymd(from) && t < ymd(to) ? h("i", { class: "gantt__today", style: `left:${dayX(t)}px` }) : null);
      const period = (n) => (n.start ? (n.start === n.end ? shortDate(n.start) : `${shortDate(n.start)}~${shortDate(n.end)}`) : "-");
      const row = (n) => {
        const open = !closed.has(`w${n.code}`);
        const left = n.start ? dayX(n.start) : 0;
        const w = n.start ? Math.max(8, dayX(n.end) - left + WEEK_W / 7) : 0;
        const click = n.leaf ? () => dialog(n.leaf) : () => { if (open) closed.add(`w${n.code}`); else closed.delete(`w${n.code}`); draw(); };
        return h("div", { class: `gantt__row wbs-row wbs-row--${n.level}`, role: "row" }, [
          h("button", { class: "gantt__name wbs__name", type: "button", style: `padding-left:${8 + n.level * 12}px`, title: [n.name, n.sub, period(n)].filter(Boolean).join(" · "), "aria-expanded": n.leaf ? null : String(open), onclick: click }, [
            n.leaf ? h("span", { class: "wbs__chev" }) : h("span", { class: "wbs__chev" + (open ? " is-open" : ""), html: ICON.right }),
            h("span", { class: "wbs__code", text: n.code }),
            h("span", { class: "wbs__label" }, [h("span", { text: n.name }), n.sub ? h("small", { class: "muted", text: n.sub }) : null]),
            h("span", { class: "wbs__pct" + (n.late ? " proc-late" : ""), text: `${n.pct}%` })
          ]),
          h("div", { class: "gantt__track", style: `width:${width}px` }, [
            todayLine(),
            n.start ? (n.leaf
              ? h("button", { class: `gantt__bar proc-bar--${barKind(n)}`, type: "button", style: `left:${left}px;width:${w}px`, "aria-label": `${n.name} ${period(n)}`, title: `${n.name} (${period(n)})`, onclick: click })
              : h("div", { class: "wbs__sum", style: `left:${left}px;width:${w}px`, title: `${n.name} ${n.done}/${n.total} 완료 (${n.pct}%)` }, h("i", { class: `proc-bar--${barKind(n)}`, style: `width:${n.pct}%` }))) : null,
            n.start && n.leaf ? h("span", { class: "gantt__label", style: `left:${left + w + 4}px`, text: n.leaf.label || period(n) }) : null
          ])
        ]);
      };
      const scroller = h("div", { class: "card gantt", role: "table" }, [
        h("div", { class: "gantt__row gantt__row--head" }, [h("div", { class: "gantt__name gantt__name--head wbs__name" }, [h("span", { class: "wbs__chev" }), h("span", { class: "wbs__code", text: "WBS" }), h("span", { class: "wbs__label", text: "작업" }), h("span", { class: "wbs__pct", text: "진척" })]), h("div", { class: "gantt__track", style: `width:${width}px` }, [...months, todayLine()])]),
        ...flatten(tree, true).map(row)
      ]);
      requestAnimationFrame(() => { if (t >= ymd(from) && t < ymd(to)) scroller.scrollLeft = Math.max(0, dayX(t) - 120); });
      return h("div", { class: "stack stack--sm" }, [
        scroller,
        h("div", { class: "gantt__legend muted small" }, [["done", "완료"], ["doing", "진행"], ["todo", "예정"], ["hold", "보류"], ["late", "일정 지남"]].map(([k, t2]) => h("span", {}, [h("i", { class: `proc-bar--${k}` }), t2])))
      ]);
    };
    // 현재 시점 PDF: 라이브러리 없이 캔버스로 그려 JPEG 페이지로 묶음 (한글 글꼴 포함 걱정 없음, 글자 선택은 안 됨)
    async function downloadPdf(btn, rows) {
      await busy(btn, async () => {
        try {
          if (document.fonts?.ready) await document.fonts.ready;
          const tree = wbsTree(grouped(rows));
          const lines = flatten(tree, false);
          const now = new Date();
          const stamp = `${ymd(now)} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
          const sum = rollup(rows);
          const title = `${pdfTitle()} 상세 프로세스 (WBS)`;
          const W = 842, H = 595, SCALE = 2.4, M = 24, ROW = 15, TOP = 86, BOTTOM = 26;
          const X = { code: M, name: M + 48, period: M + 258, pct: M + 338, st: M + 374, time: M + 412 };
          const timeW = W - M - X.time;
          const dates = lines.flatMap((n) => [n.start, n.end]).filter(Boolean).sort();
          const t0 = parseYmd(dates[0] || today()); t0.setDate(1);
          const t1 = parseYmd(dates[dates.length - 1] || today()); t1.setMonth(t1.getMonth() + 1, 1);
          const px = (s) => X.time + ((parseYmd(s) - t0) / (t1 - t0)) * timeW;
          const FONT = '"Pretendard Variable", Pretendard, -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
          const COLOR = { done: "#2f9e44", doing: "#3b63f3", todo: "#b4c3f8", hold: "#8a90a2", late: "#e03131" };
          const perPage = Math.floor((H - TOP - BOTTOM) / ROW);
          const pageN = Math.max(1, Math.ceil(lines.length / perPage));
          const statusName = (n) => (n.leaf ? PROC_STATUS.find(([k]) => k === n.leaf.status)?.[1] || "" : `${n.done}/${n.total}`);
          const pages = [];
          for (let p = 0; p < pageN; p++) {
            const c = document.createElement("canvas");
            c.width = W * SCALE; c.height = H * SCALE;
            const g = c.getContext("2d");
            g.scale(SCALE, SCALE);
            g.fillStyle = "#fff"; g.fillRect(0, 0, W, H);
            const text = (s, x, y, size, weight, color, maxW, align) => {
              g.font = `${weight || 400} ${size}px ${FONT}`; g.fillStyle = color || "#171a23"; g.textAlign = align || "left"; g.textBaseline = "middle";
              let v = String(s);
              if (maxW && g.measureText(v).width > maxW) { while (v.length > 1 && g.measureText(`${v}…`).width > maxW) v = v.slice(0, -1); v += "…"; }
              g.fillText(v, x, y);
            };
            text(title, M, 30, 15, 700);
            text(`기준 시점 ${stamp}`, W - M, 26, 9.5, 600, "#4a5061", 0, "right");
            text(`진척 ${sum.pct}% · 완료 ${sum.done}/${sum.total} · 일정 지남 ${sum.late}건`, W - M, 39, 9.5, 400, sum.late ? "#e03131" : "#4a5061", 0, "right");
            const hy = TOP - 16;
            g.fillStyle = "#f1f3f8"; g.fillRect(M, hy, W - 2 * M, 16);
            [["WBS", X.code + 3], ["작업", X.name], ["기간", X.period], ["진척", X.pct], ["상태", X.st]].forEach(([s, x]) => text(s, x, hy + 8, 8, 700, "#4a5061"));
            // 달 눈금
            const body = TOP + ROW * Math.min(perPage, lines.length - p * perPage);
            for (const d = new Date(t0); d < t1; d.setMonth(d.getMonth() + 1)) {
              const x = px(ymd(d));
              g.strokeStyle = "#e3e6ee"; g.lineWidth = 0.5; g.beginPath(); g.moveTo(x, hy); g.lineTo(x, body); g.stroke();
              if ((t1 - t0) / DAY < 500 || d.getMonth() % 2 === 0) text(d.getMonth() === 0 ? `${String(d.getFullYear()).slice(2)}.1` : `${d.getMonth() + 1}`, x + 2, hy + 8, 7, 600, "#4a5061");
            }
            lines.slice(p * perPage, (p + 1) * perPage).forEach((n, i) => {
              const y = TOP + i * ROW, mid = y + ROW / 2;
              if (n.level === 0) { g.fillStyle = "#e8ebf2"; g.fillRect(M, y, X.time - M, ROW); }
              else if (n.level === 1) { g.fillStyle = "#f1f3f8"; g.fillRect(M, y, X.time - M, ROW); }
              const weight = n.level < 2 ? 700 : n.leaf ? 400 : 600;
              text(n.code, X.code + 3, mid, 7.5, weight, "#4a5061");
              text(n.name, X.name + n.level * 7, mid, 8, weight, "#171a23", X.period - X.name - n.level * 7 - 4);
              text(n.start ? (n.start === n.end ? shortDate(n.start) : `${shortDate(n.start)}~${shortDate(n.end)}`) : "-", X.period, mid, 7.5, 400, n.leaf && late(n.leaf) ? "#e03131" : "#4a5061");
              text(`${n.pct}%`, X.pct, mid, 7.5, 600, n.late ? "#e03131" : "#171a23");
              text(statusName(n), X.st, mid, 7.5, 400, n.leaf && late(n.leaf) ? "#e03131" : "#4a5061");
              g.strokeStyle = "#eef0f5"; g.lineWidth = 0.4; g.beginPath(); g.moveTo(M, y + ROW); g.lineTo(W - M, y + ROW); g.stroke();
              if (n.start) {
                const a = px(n.start), b = Math.max(a + 2, px(ymd(new Date(parseYmd(n.end).getTime() + DAY))));
                const kind = barKind(n);
                if (n.leaf) { g.fillStyle = COLOR[kind]; g.fillRect(a, y + 4, b - a, ROW - 8); }
                else { g.fillStyle = "#d6dbe6"; g.fillRect(a, y + 5.5, b - a, ROW - 11); g.fillStyle = COLOR[kind]; g.fillRect(a, y + 5.5, (b - a) * (n.pct / 100), ROW - 11); }
              }
            });
            const today0 = today();
            if (dates.length && today0 >= ymd(t0) && today0 < ymd(t1)) { const x = px(today0); g.strokeStyle = "#e03131"; g.lineWidth = 0.9; g.beginPath(); g.moveTo(x, hy); g.lineTo(x, body); g.stroke(); }
            // 범례·쪽 번호
            let lx = M;
            [["done", "완료"], ["doing", "진행"], ["todo", "예정"], ["hold", "보류"], ["late", "일정 지남"]].forEach(([k, s]) => { g.fillStyle = COLOR[k]; g.fillRect(lx, H - 15, 10, 5); text(s, lx + 13, H - 12.5, 7, 400, "#4a5061"); lx += 48; });
            text("진척: 완료 100, 진행 50, 그 외 0 의 평균", lx + 4, H - 12.5, 7, 400, "#8a90a2");
            text(`${TITLE} · ${p + 1} / ${pageN}`, W - M, H - 12.5, 7.5, 400, "#8a90a2", 0, "right");
            pages.push(c);
          }
          saveBlob(jpegPagesToPdf(pages, W, H), `${`${pdfTitle()}_상세프로세스_${ymd(now).replaceAll("-", "")}`.replace(/[\\/:*?"<>|\s&]+/g, "_")}.pdf`);
          toast(`기준 시점 ${stamp} PDF를 만들었어요.`);
        } catch (ex) { toast(`PDF를 만들지 못했어요: ${ex.message}`); }
      });
    }
    function draw() {
      const view = store.get("ps.procView", "wbs") === "list" ? "list" : "wbs";
      const all = area === undefined || area === null ? list : list.filter((r) => (r.area || "") === area);
      const sections = uniq(all.map((r) => r.section));
      if (procFilter.section && !sections.includes(procFilter.section)) procFilter.section = "";
      const shown = all.filter((r) => (!procFilter.section || r.section === procFilter.section) && (!procFilter.status || (procFilter.status === "late" ? late(r) : r.status === procFilter.status)));
      const counts = (k) => all.filter((r) => r.status === k).length;
      const lateN = all.filter(late).length;
      const next = all.filter((r) => r.dueDate && r.dueDate >= today() && r.status !== "done" && r.status !== "hold").sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
      const secSel = h("select", { "aria-label": "구분으로 거르기", onchange: (e) => { procFilter.section = e.target.value; draw(); } }, [h("option", { value: "", text: "모든 구분" }), ...sections.map((x) => h("option", { value: x, text: x }))]);
      secSel.value = procFilter.section;
      const stSel = h("select", { "aria-label": "상태로 거르기", onchange: (e) => { procFilter.status = e.target.value; draw(); } }, [h("option", { value: "", text: "모든 상태" }), ...PROC_STATUS.map(([k, t]) => h("option", { value: k, text: t })), h("option", { value: "late", text: "일정 지남" })]);
      stSel.value = procFilter.status;
      const seg = h("div", { class: "seg seg--sm" }, [["wbs", "WBS"], ["list", "목록"]].map(([k, t]) => h("button", { type: "button", "aria-selected": String(k === view), text: t, onclick: () => { store.set("ps.procView", k); draw(); } })));
      fill(box,
        all.length ? h("div", { class: "unit-stats" }, [
          h("div", { class: "card unit-stat" }, [h("strong", { text: `${rollup(all).pct}%` }), h("span", { text: `진척 (완료 ${counts("done")}/${all.length})` })]),
          h("div", { class: "card unit-stat" }, [h("strong", { text: String(counts("doing")) }), h("span", { text: "진행" })]),
          h("div", { class: "card unit-stat" + (lateN ? " is-warn" : "") }, [h("strong", { text: String(lateN) }), h("span", { text: "일정 지남" })]),
          h("div", { class: "card unit-stat" }, [h("strong", { class: "proc-next", title: next ? next.detail || next.task : null, text: next ? shortDate(next.dueDate) : "-" }), h("span", { text: next ? `다음: ${next.label || next.task}` : "다음 일정" })])
        ]) : null,
        h("div", { class: "filters" }, [secSel, stSel, seg, h("span", { class: "filters__end actions" }, [
          all.length ? (() => { const b = h("button", { class: "btn btn--ghost btn--sm", type: "button", title: "지금 보이는 조건 그대로, 현재 시점 기준으로 내려받아요", text: "PDF 다운로드", onclick: () => downloadPdf(b, shown) }); return b; })() : null,
          h("button", { class: "btn btn--primary btn--sm", type: "button", text: "+ 프로세스", onclick: () => dialog() })
        ])]),
        !all.length ? h("div", { class: "card empty", text: "아직 상세 프로세스가 없어요. '+ 프로세스'로 단계별 일정을 넣어 주세요." })
          : !shown.length ? h("div", { class: "card empty", text: "조건에 맞는 프로세스가 없어요." })
            : view === "wbs" ? wbsView(grouped(shown)) : listView(grouped(shown))
      );
    }
    api(`/projects/${projectId}/processes`).then((r) => { list = r.processes; draw(); }).catch((e) => { if (e.status !== 401) fill(box, failed(e)); });
    return box;
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
  // 입출고 목록 공통: 묶음(예: 묵주)마다 제목을 두고 그 아래에 대장 (onAdd 가 없으면 추가 버튼 없음)
  function stockGroupSections(list, href, onAdd) {
    const card = (l) => {
      const done = stockDone(l);
      const next = STOCK_STEPS.slice(0, 3).find((s) => !done[s.id]);
      return h("a", { class: "card pj-card", href: href(l) }, [
        h("strong", { text: l.name }),
        l.volunteerEntry ? h("span", { class: "stock-tag", text: "봉사자 입력" }) : null,
        h("div", { class: "stock-card__nums" }, [`입고 ${fmtN(l.inTotal)}`, h("span", { text: `출고 ${fmtN(l.outTotal)}` }), h("strong", { class: l.inTotal - l.outTotal < 0 ? "stock-minus" : null, text: `재고 ${fmtN(l.inTotal - l.outTotal)} ${l.unit}` })]),
        h("div", { class: "stock-dots", "aria-hidden": "true" }, STOCK_STEPS.map((s) => h("i", { class: done[s.id] ? "is-done" : null, title: s.label }))),
        h("span", { class: next ? "stock-card__next" : "muted small", text: next ? `다음 단계: ${next.label}` : "기록 단계 완료" }),
        l.last ? h("span", { class: "muted small", text: `최근 ${l.last.type === "in" ? "입고" : "출고"} ${l.last.date}${l.last.enteredBy ? ` · ${l.last.enteredBy}` : ""}` }) : null
      ]);
    };
    const groups = [...new Set(list.map((l) => l.itemId))].map((itemId) => list.filter((l) => l.itemId === itemId));
    return groups.map((rows) => {
      const { itemId, itemName, projectId, projectName, unitId } = rows[0];
      const team = unitId && unitOf(unitId) ? unitShort(unitId) : "";
      return h("section", { class: "pj-team stock-group" }, [
        h("div", { class: "pj-team__head" }, [
          h("h2", { class: "stock-group__name", text: itemName }),
          h("span", { class: "muted small", text: [team, projectName, `대장 ${rows.length}개`].filter(Boolean).join(" · ") }),
          onAdd ? h("button", { class: "link-btn stock-group__add", type: "button", text: "+ 대장", "aria-label": `${itemName}에 입출고 대장 추가`, onclick: () => onAdd({ projectId, itemId }) }) : null
        ]),
        h("div", { class: "pj-cards" }, rows.map(card))
      ]);
    });
  }
  // 입출고 관리 목록
  async function pageStocks() {
    drawMini(null);
    setMain("stock", loading());
    document.title = `입출고 관리 · ${TITLE}`;
    let list = [];
    const draw = () => {
      const newBtn = (cls) => h("button", { class: `btn btn--primary ${cls}`, type: "button", onclick: () => ledgerWizard() }, [icon("plus"), "새 입출고 현황"]);
      const sections = stockGroupSections(list, (l) => `#/stock/${l.id}`, ledgerWizard);
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
  // 다른 화면(위치 이동·실사 조정·실자르기·타래 배분)에서 생긴 입출고: 보기만 하고 어디서 고치는지 안내
  function refMoveInfo(m, data, img) {
    const parts = data.options.filter((o) => Number(m.qty[o.id])).map((o) => `${o.name} ${fmtN(m.qty[o.id])}`).join(" · ");
    openDialog(`${m.type === "in" ? "입고" : "출고"} 기록 · ${m.date}`, h("div", { class: "stack" }, [
      h("p", { class: "ref-guide small", text: m.guide }),
      h("strong", { text: `${parts || "수량 없음"}${parts ? ` ${data.ledger.unit}` : ""}` }),
      m.note ? h("p", { class: "small", text: m.note }) : null, m.issue ? h("p", { class: "move-issue", text: `이슈: ${m.issue}` }) : null,
      m.photos?.length ? h("div", { class: "move-photos" }, m.photos.map((pid) => img(pid))) : null,
      h("div", { class: "actions" }, [h("button", { class: "btn btn--ghost", type: "button", text: "닫기", "data-close": true })])
    ]));
  }
  // vol 이 있으면 봉사자 화면: 기록 입력과 고치기·지우기 (대장은 못 바꿈, 누가 적은 기록이든 고침, 수정 기록에 남음), 그리는 곳도 봉사자 화면
  async function pageStock(id, vol) {
    const base = vol ? `/volunteer/stock/${id}` : `/stock/${id}`;
    const moveUrl = (mid) => (vol ? `/volunteer/stock-moves/${mid}` : `/stock-moves/${mid}`);
    const photoUrl = (pid) => (vol ? `/volunteer/stock-photos/${pid}` : `/stock-photos/${pid}`);
    // 사진은 인증 머리말이 필요해서 받아 와 Blob 주소로 보여 줌
    const photoCache = new Map();
    const photoSrc = (pid) => { if (!photoCache.has(pid)) photoCache.set(pid, fetch(API + photoUrl(pid), { headers: { Authorization: "Bearer " + state.token } }).then((r) => (r.ok ? r.blob() : null)).then((b) => (b ? URL.createObjectURL(b) : null)).catch(() => null)); return photoCache.get(pid); };
    const photoImg = (pid, cls) => { const img = h("img", { class: cls || "move-photo", alt: "기록 사진" }); photoSrc(pid).then((u) => { if (u) img.src = u; }); return img; };
    const canEditMove = () => true; // 봉사자도 누가 적은 기록이든 고침 (수정 기록에 고친 사람이 남음)
    function viewPhotos(m) {
      openDialog(`${m.type === "in" ? "입고" : "출고"} 사진 · ${m.date}`, h("div", { class: "stack" }, [
        h("div", { class: "move-photos move-photos--big" }, m.photos.map((pid) => h("a", { href: "#", onclick: (e) => { e.preventDefault(); photoSrc(pid).then((u) => { if (u) window.open(u, "_blank", "noopener"); }); } }, photoImg(pid, "move-photo move-photo--big")))),
        m.issue ? h("p", { class: "move-issue", text: `이슈: ${m.issue}` }) : null
      ]));
    }
    const PHOTO_MAX = 4;
    const listHash = vol ? "#/vstock" : "#/stock";
    const put = (kids) => (vol ? vol.show(kids) : setMain("stock", kids));
    if (!vol) { drawMini(null); setMain("stock", loading()); }
    let data, step = store.get(`ps.stockStep.${id}`, ""), historyOpen = false;
    const utcLabel = (at) => { const d = new Date(`${at.replace(" ", "T")}Z`); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
    const edit = (opts) => ledgerDialog(data, async (body) => { const r = await api(`/stock/${id}`, { method: "PATCH", body }); closeDialog(); apply(r); }, opts);
    const apply = (r) => { data = r; draw(); };
    function moveDialog(type, m) {
      if (m?.refType && m.refType !== "purchase") return refMoveInfo(m, data, photoImg);
      const lock = !!m?.refType; // 구매 입고: 날짜·수량·전달자는 못 고침 (비고·이슈·입고 검수·사진만)
      const err = errorLine();
      // 봉사자는 달력으로 고르기 (예전 기록의 '10월 이전' 같은 글자 날짜는 직원 화면에서만)
      const date = vol ? h("input", { type: "date", value: m?.date || today(), autofocus: true }) : h("input", { value: m?.date || today(), maxlength: "20", autofocus: true, placeholder: today() });
      const qtyOf = (mv, oid) => mv.qty[oid] || 0;
      const leftOf = (oid) => data.moves.reduce((n, x) => (m && x.id === m.id ? n : n + (x.type === "in" ? qtyOf(x, oid) : -qtyOf(x, oid))), 0); // 이 기록을 뺀 재고
      const handler = h("input", { value: m?.handler ?? (vol && type === "out" ? state.user.name : ""), maxlength: "40" });
      const note = h("textarea", { rows: "2", maxlength: "500" }, m?.note || "");
      const issue = h("textarea", { rows: "2", maxlength: "500", placeholder: "예: 10개 중 2개 불량, 박스 파손, 수량 부족" }, m?.issue || "");
      // 입고 검수: 들어온 수량 중 합격·불량 (비우면 검수 안 함)
      const insOk = h("input", { type: "number", min: "0", inputmode: "numeric", value: m?.inspectOk ?? "", "aria-label": "검수 합격" });
      const insBad = h("input", { type: "number", min: "0", inputmode: "numeric", value: m?.inspectBad ?? "", "aria-label": "검수 불량" });
      // 사진: 고른 사진은 바로 줄여 두고 저장할 때 올림. 봉사자가 새로 넣을 때는 1장 이상
      const needPhoto = !!vol && !m;
      const pending = [];
      let savedId = null; // 이 창에서 저장을 마친 기록 번호
      let kept = m ? [...m.photos] : [];
      const photoBox = h("div", { class: "move-photos" });
      const fileIn = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp", multiple: true, hidden: true });
      const pickBtn = h("button", { class: "btn btn--ghost btn--sm", type: "button", onclick: () => fileIn.click() }, [icon("plus"), type === "in" ? "영수증·사진 추가" : "사진 추가"]);
      const drawPhotos = () => {
        photoBox.replaceChildren(
          ...kept.map((pid) => h("span", { class: "move-photos__item" }, [photoImg(pid), m && canEditMove(m) ? h("button", { class: "move-photos__x", type: "button", "aria-label": "사진 지우기", html: ICON.close, onclick: async () => {
            if (!confirm("이 사진을 지울까요?")) return;
            const r = await act(() => api(photoUrl(pid), { method: "DELETE" }));
            kept = kept.filter((x) => x !== pid); data = r; drawPhotos();
          } }) : null])),
          ...pending.map((b, i) => h("span", { class: "move-photos__item is-new" }, [h("img", { class: "move-photo", alt: "올릴 사진", src: URL.createObjectURL(b) }), h("button", { class: "move-photos__x", type: "button", "aria-label": "고른 사진 빼기", html: ICON.close, onclick: () => { pending.splice(i, 1); drawPhotos(); } })]))
        );
        pickBtn.hidden = kept.length + pending.length >= PHOTO_MAX;
      };
      fileIn.addEventListener("change", async () => {
        const files = [...fileIn.files]; fileIn.value = "";
        for (const f of files) {
          if (kept.length + pending.length >= PHOTO_MAX) { showError(err, `사진은 ${PHOTO_MAX}장까지 올릴 수 있어요.`); break; }
          try { pending.push(await shrinkImage(f)); showError(err, ""); } catch (ex) { showError(err, ex.message); }
        }
        drawPhotos();
      });
      drawPhotos();
      const sum = h("strong");
      const inputs = data.options.map((o) => ({ o, el: h("input", { type: "number", min: "0", inputmode: "numeric", value: m?.qty[o.id] || "", "aria-label": o.name, oninput: () => drawSum() }) }));
      const drawSum = () => { sum.textContent = `합계 ${fmtN(inputs.reduce((n, x) => n + (Number(x.el.value) || 0), 0))} ${data.ledger.unit}`; };
      drawSum();
      if (lock) for (const el of [date, handler, ...inputs.map((x) => x.el)]) el.disabled = true;
      const ok = h("button", { class: "btn btn--primary", type: "submit", text: m ? "저장" : "추가" });
      const form = h("form", { class: "stack", novalidate: true }, [
        lock ? h("p", { class: "ref-guide small", text: m.guide }) : null,
        h("div", { class: "row2" }, [field(type === "in" ? "입고일" : "출고일", date), type === "out" ? field("전달자", handler) : null]),
        inputs.length ? h("div", { class: "stock-grid" }, inputs.map((x) => h("label", { class: "stock-grid__cell" }, [h("span", { class: "small opt-name" }, [optDot(x.o), x.o.name]), x.el, h("span", { class: "muted stock-grid__left", text: `재고 ${fmtN(leftOf(x.o.id))}` })]))) : h("p", { class: "muted small", text: "먼저 1단계 기본 정보에서 품목 열을 추가해 주세요." }),
        sum, field("비고", note),
        type === "in" ? h("div", { class: "row2" }, [field("검수 합격", insOk), field("검수 불량", insBad, "검수했으면 적어 주세요. 불량이 있으면 아래 이슈에도 적어 주세요.")]) : null,
        field("이슈 (문제가 된 점)", issue, "이 날짜·물량에 문제가 있었으면 적어 주세요. 나중에 모아서 업체에 보낼 수 있어요."),
        h("div", { class: "field" }, [h("span", { class: "field__label", text: `${type === "in" ? "영수증·사진" : "출고 사진"}${needPhoto ? " (1장 이상)" : " (선택)"}` }), photoBox, h("div", {}, [pickBtn, fileIn]), h("small", { class: "muted", text: `${PHOTO_MAX}장까지, 올릴 때 자동으로 작게 줄여요.` })]),
        m?.enteredBy ? h("p", { class: "muted small", text: `입력: ${m.enteredBy}` }) : null,
        err,
        h("div", { class: "actions" }, [
          m && !lock ? h("button", { class: "btn btn--danger-outline btn--sm", type: "button", text: "지우기", onclick: async () => {
            if (!confirm(`${m.date} 기록을 지울까요?`)) return;
            const r = await act(() => apiAsk(moveUrl(m.id), { method: "DELETE" }));
            if (!r) return;
            closeDialog(); apply(r);
          } }) : null,
          h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), ok
        ])
      ]);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        busy(ok, async () => {
          try {
            if (!date.value) return showError(err, "날짜를 골라 주세요.");
            if (!inputs.some((x) => Number(x.el.value) > 0)) return showError(err, "수량을 하나 이상 적어 주세요.");
            const over = type === "out" ? inputs.filter((x) => Number(x.el.value) > leftOf(x.o.id)) : [];
            if (over.length && !confirm(`재고보다 많이 출고해요: ${over.map((x) => `${x.o.name} (재고 ${fmtN(leftOf(x.o.id))})`).join(", ")}\n그래도 저장할까요?`)) return;
            if (needPhoto && !savedId && !pending.length) return showError(err, type === "in" ? "영수증이나 사진을 1장 이상 올려 주세요." : "출고 사진을 1장 이상 올려 주세요.");
            const qty = Object.fromEntries(inputs.map((x) => [x.o.id, x.el.value]));
            const body = { date: date.value, handler: handler.value, note: note.value, issue: issue.value, qty, ...(type === "in" ? { inspectOk: insOk.value, inspectBad: insBad.value } : {}) };
            // 기록이 한 번 저장되면 (사진 올리기가 실패해도) 다시 누를 때는 기록을 또 만들지 않고 그 기록에 사진만 올림
            let r = savedId ? null : await apiAsk(m ? moveUrl(m.id) : `${base}/moves`, { method: m ? "PATCH" : "POST", body: m ? { ...body, ...(over.length ? { confirmed: true } : {}) } : { ...body, type } });
            if (!savedId && !r) return;
            if (r) { savedId = m ? m.id : r.newMoveId; apply(r); }
            while (pending.length) {
              try { r = await api(`${moveUrl(savedId)}/photos`, { method: "POST", body: { data: await blobToBase64(pending[0]) } }); }
              catch (ex) { drawPhotos(); return showError(err, `기록은 저장했어요. 사진을 올리지 못했어요: ${ex.message} 다시 '${ok.textContent}'를 누르면 남은 사진만 올려요.`); }
              pending.shift(); apply(r);
            }
            closeDialog();
          } catch (ex) { showError(err, ex.message); }
        });
      });
      openDialog(`${type === "in" ? "입고" : "출고"} ${m ? "고치기" : "추가"}`, form);
    }
    // 이슈가 있는 기록을 CSV 로 (업체에 메일로 보낼 때). 엑셀에서 수식으로 실행되지 않게 막음
    function exportIssues() {
      const { ledger: l, options, moves } = data;
      const esc = (raw) => { const v = /^[=+\-@\t\r]/.test(String(raw)) ? `'${raw}` : String(raw); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
      const lines = [["구분", "날짜", ...options.map((o) => o.name), "합계", "검수 합격", "검수 불량", "전달자", "비고", "이슈", "사진 수", "입력자"]];
      for (const m of moves.filter((x) => x.issue)) lines.push([m.type === "in" ? "입고" : "출고", m.date, ...options.map((o) => m.qty[o.id] || 0), Object.values(m.qty).reduce((a, b) => a + b, 0), m.inspectOk ?? "", m.inspectBad ?? "", m.handler, m.note, m.issue, m.photos.length, m.enteredBy || ""]);
      const blob = new Blob(["\ufeff" + lines.map((r) => r.map(esc).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
      const a = h("a", { href: URL.createObjectURL(blob), download: `${l.name}_이슈_${today()}.csv` });
      document.body.append(a); a.click(); a.remove();
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
          const rowAttrs = canEditMove(m) ? { class: "stock-row", tabindex: "0", title: m.refType && m.refType !== "purchase" ? "눌러서 보기" : "눌러서 고치기", onclick: () => moveDialog(type, m), onkeydown: (e) => { if (e.key === "Enter") moveDialog(type, m); } } : {};
          return h("tr", rowAttrs, [
            h("td", { class: "num muted", text: String(i + 1) }), h("td", { class: "nowrap", text: m.date }),
            ...options.map((o) => num(m.qty[o.id])), num(day, "stock-strong"), num(running),
            isOut ? h("td", { text: m.handler || "-" }) : null, h("td", { class: "stock-note", text: m.note }),
            isOut ? null : h("td", { class: "nowrap", text: m.inspectOk != null || m.inspectBad != null ? `합격 ${fmtN(m.inspectOk || 0)} · 불량 ${fmtN(m.inspectBad || 0)}` : "-" }),
            h("td", { class: "stock-note move-issue", text: m.issue || "" }),
            h("td", { class: "nowrap" }, m.photos.length ? h("button", { class: "btn btn--ghost btn--sm move-photo-btn", type: "button", title: "사진 보기", onclick: (e) => { e.stopPropagation(); viewPhotos(m); } }, [icon("note"), String(m.photos.length)]) : h("span", { class: "muted", text: "-" })),
            vol ? h("td", { class: "nowrap" }, h("button", { class: "btn btn--ghost btn--sm", type: "button", "aria-label": `${m.date} ${isOut ? "출고" : "입고"} 고치기`, onclick: (e) => { e.stopPropagation(); moveDialog(type, m); } }, m.refType && m.refType !== "purchase" ? "보기" : "고치기")) : h("td", { class: "nowrap", text: m.enteredBy || "-" })
          ]);
        });
        const colsAfter = (isOut ? 2 : 2) + 2 + 1;
        return h("section", { class: "stock-sec" }, [
          h("div", { class: "card__head" }, [
            h("h2", { class: "card__title" }, [isOut ? "출고 현황 " : "입고 현황 ", h("span", { class: "muted small", text: isOut ? l.outLabel : l.inLabel })]),
            h("div", { class: "actions actions--start" }, [
              !vol && list.some((m) => m.issue) ? h("button", { class: "btn btn--ghost btn--sm", type: "button", title: "이슈가 있는 기록만 엑셀(CSV)로", onclick: () => exportIssues() }, "이슈 내려받기") : null,
              h("button", { class: "btn btn--primary btn--sm", type: "button", onclick: () => moveDialog(type) }, [icon("plus"), isOut ? "출고 추가" : "입고 추가"])
            ])
          ]),
          h("div", { class: "card table-wrap" }, h("table", { class: "table stock-table" }, [
            h("thead", {}, h("tr", {}, [h("th", { class: "num", text: "순번" }), h("th", { text: isOut ? "출고일" : "입고일" }), ...options.map((o) => h("th", { class: "num", text: o.name })), h("th", { class: "num", text: "일계" }), h("th", { class: "num", text: "누계" }), isOut ? h("th", { text: "전달자" }) : null, h("th", { text: "비고" }), isOut ? null : h("th", { text: "검수" }), h("th", { text: "이슈" }), h("th", { text: "사진" }), h("th", { text: vol ? "고치기" : "입력자" })])),
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
          h("div", { class: "card__head" }, [h("h2", { class: "card__title" }, ["전달 후 현황 ", h("span", { class: "muted small", text: a.label })]), vol ? null : h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "고치기", onclick: () => edit({ openAfter: true }) })]),
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
        h("div", { class: "card__head" }, [h("h2", { class: "card__title", text: "대장 정보" }), vol ? null : h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "고치기", onclick: () => edit() })]),
        h("dl", { class: "card stock-info" }, [
          h("dt", { text: "위치" }), h("dd", {}, vol ? `${data.project.name} › ${data.itemName}` : [h("a", { href: `#/projects/${data.project.id}`, text: data.project.name }), ` › ${data.itemName}`]),
          h("dt", { text: "단위" }), h("dd", { text: l.unit }),
          h("dt", { text: "계약 수량" }), h("dd", { text: l.contract ? `${fmtN(l.contract)} ${l.unit}` : "정하지 않음" }),
          h("dt", { text: "입고 경로" }), h("dd", { text: l.inLabel || "-" }),
          h("dt", { text: "출고 경로" }), h("dd", { text: l.outLabel || "-" }),
          h("dt", { text: `품목 ${options.length}개` }), h("dd", {}, options.length ? h("div", { class: "stock-chips" }, options.map((o) => h("span", { text: o.name }))) : vol ? "아직 없어요. 관리자에게 문의해 주세요." : "아직 없어요. '고치기'에서 추가해 주세요.")
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
        h("p", { text: vol ? "아직 전달 후 현황이 없어요." : "아직 전달 후 현황을 적지 않았어요. 필요 없으면 건너뛰어도 돼요." }),
        vol ? null : h("button", { class: "btn btn--primary btn--sm", type: "button", text: "전달 후 현황 적기", onclick: () => edit({ openAfter: true }) })
      ]);
      const panel = { setup: setupPanel, in: () => table("in"), out: () => table("out"), left: leftPanel, after: afterPanel }[step]();
      const cur = STOCK_STEPS[at], prev = STOCK_STEPS[at - 1], next = STOCK_STEPS[at + 1];
      put([
        h("nav", { class: "muted small" }, [h("a", { href: listHash, text: vol ? "입출고" : "입출고 관리" }), ` › ${data.itemName} › ${l.name}`]),
        h("div", { class: "page-head page-head--wrap" }, [
          h("h1", { text: l.name }),
          !vol && l.volunteerEntry ? h("span", { class: "stock-tag", text: "봉사자 입력" }) : null,
          l.canDelete ? h("span", { class: "page-head__end actions" }, h("button", { class: "btn btn--danger-outline btn--sm", type: "button", text: "지우기", onclick: async () => {
            if (!confirm(`'${l.name}' 입출고 현황과 모든 기록을 지울까요?`)) return;
            await act(() => api(`/stock/${id}`, { method: "DELETE" }));
            go(listHash);
          } })) : null
        ]),
        h("div", { class: "unit-stats" }, [
          l.contract ? stat("계약", l.contract) : null, stat("입고", inAll), l.contract ? stat("미입고", l.contract - inAll) : null, stat("출고", outAll), stat("창고 재고", stock, stock < 0)
        ]),
        h("ol", { class: "stock-steps", "aria-label": "진행 단계" }, STOCK_STEPS.map((s, i) => h("li", {}, h("button", { class: "stock-step" + (s.id === step ? " is-active" : "") + (done[s.id] ? " is-done" : ""), type: "button", "aria-current": s.id === step ? "step" : null, onclick: () => pick(s.id) }, [stepNum(i, done[s.id]), h("span", { class: "stock-step__label", text: s.label })])))),
        h("div", { class: "card stock-guide" }, [h("span", { class: "stock-guide__count", text: `${at + 1} / ${STOCK_STEPS.length}단계` }), h("h2", { text: cur.title }), h("p", { text: cur.hint }), vol && (step === "in" || step === "out") ? h("p", { class: "muted small", text: "기록 줄의 '고치기'를 누르면 고치거나 지울 수 있어요. 누가 언제 무엇을 고쳤는지 직원 화면 수정 기록에 남아요." }) : null, !vol && l.volunteerEntry && (step === "in" || step === "out") ? h("p", { class: "muted small", text: "이 대장은 봉사자가 입력해요. 직원은 확인하고, 필요하면 기록을 눌러 고칠 수 있어요." }) : null]),
        panel,
        h("div", { class: "stock-nav" }, [
          prev ? h("button", { class: "btn btn--ghost", type: "button", text: `이전: ${prev.label}`, onclick: () => pick(prev.id) }) : null,
          next ? h("button", { class: "btn btn--primary", type: "button", text: `다음: ${next.label}`, onclick: () => pick(next.id) }) : h("a", { class: "btn btn--primary", href: listHash, text: "목록으로" })
        ]),
        data.history ? h("details", { class: "stock-history", open: historyOpen, ontoggle: (e) => { historyOpen = e.currentTarget.open; } }, [
          h("summary", { text: `수정 기록 ${data.history.length}건${data.history.length >= 100 ? " (최근 100건)" : ""}` }),
          data.history.length ? h("ul", {}, data.history.map((x) => h("li", {}, [h("span", { class: "stock-history__when", text: utcLabel(x.at) }), h("span", { class: "stock-history__who", text: x.by || "-" }), h("span", { class: "stock-history__what", text: x.summary })]))) : h("p", { class: "muted", text: "아직 수정 기록이 없어요. 앞으로 입력하거나 고치면 여기에 남아요." })
        ]) : null
      ]);
    }
    const staffRef = !vol && ["stock_in", "stock_out"].includes(state.openRef?.topic) && state.openRef.ledgerId === id ? state.openRef : null; // 알림에서 온 기록 바로 열기
    if (staffRef) {
      state.openRef = null;
      const r = await api(base), em = r.moves.find((x) => x.id === staffRef.id);
      if (em) { step = em.type; store.set(`ps.stockStep.${id}`, step); }
      apply(r);
      if (em) moveDialog(em.type, em); else toast(REF_GONE);
      return;
    }
    if (vol) {
      if (vol.open) { step = vol.open; store.set(`ps.stockStep.${id}`, step); }
      // 프로젝트 화면의 '고치기'로 오면 그 기록 고치기 창을 바로 엶
      if (vol.editId) {
        const r = await api(base); const em = r.moves.find((x) => x.id === vol.editId);
        if (em) { step = em.type; store.set(`ps.stockStep.${id}`, step); }
        apply(r);
        if (vol.isCurrent()) {
          history.replaceState(null, "", `#/vstock/${id}`);
          if (em) moveDialog(em.type, em); else toast("그 기록을 찾을 수 없어요. 이미 지워졌을 수 있어요.");
        }
        return;
      }
      apply(await api(base));
      if (vol.open && vol.isCurrent()) {
        history.replaceState(null, "", `#/vstock/${id}`); // 새로고침해도 입력 창이 다시 열리지 않게
        moveDialog(vol.open);
      }
      return;
    }
    page = { name: "stock", reload: async () => apply(await api(base)) };
    try { await page.reload(); } catch (e) { if (e.status !== 401) setMain("stock", failed(e)); }
  }

  /* ---------- 봉사자 화면: 직원 화면과 따로 (일정·기본 교육·기념품팀 프로젝트) ---------- */
  const volDay = (s) => parseYmd(s).toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "short" });
  const volTime = (x) => (x.startTime ? (x.endTime ? `${x.startTime}~${x.endTime}` : x.startTime) : "");
  let volSeq = 0;
  // 관리자가 연 메뉴만 봉사자에게 보임 (단계적으로 엶). 못 받아 오면 입고·출고 중심
  const VOL_MENU_DEFAULT = ["home", "notices", "in", "out"];
  const volOn = (k) => (state.volMenu || VOL_MENU_DEFAULT).includes(k);
  function renderVolunteer() {
    const preview = state.volPreview; // 관리자 미리보기: "dept" | "team"
    const team = preview ? preview === "team" : state.user.volKind === "team"; // 팀 봉사자(교육·검수): 같은 틀에 다른 메뉴
    if (!state.volMenu) { api("/ops/menu").then((r) => { state.volMenu = r.menu; render(); }).catch(() => { state.volMenu = VOL_MENU_DEFAULT; render(); }); }
    const steps = stepsOn(); // 단계형 메뉴 (미리보기는 늘, 봉사자는 '메뉴 공개'에서 켜면)
    layout.main = null;
    const seq = ++volSeq;
    const { name, id } = route();
    const teamSteps = STEP_CATS.team.flatMap((c) => c.steps.map((x) => x[0])), deptSteps = STEP_CATS.dept.flatMap((c) => c.steps.map((x) => x[0]));
    // 합친 단계의 예전 주소 → 새 화면 (교육 결과 → 교육 일정·결과, 회수 받기 → 회수)
    if (team && steps && { tedu3: 1, tmake3: 1 }[name]) return location.replace({ tedu3: "#/tedu2", tmake3: "#/tmake2" }[name]);
    if (["tdocs", "vdeadlines"].includes(name)) return location.replace(team ? "#/thome" : "#/vhome"); // 없앤 화면(자료실·역할, 데드라인 일정)의 예전 주소
    const tab = team ? ([...TEAM_TABS, "vnotices", "vboard", ...(steps ? [...teamSteps, "tedu4", "vcontacts", "vschedule"] : []), "alerts"].includes(name) ? name : "thome") : ["vschedule", "vtraining", "vstock", "vprojects", "vp", "vnotices", "vboard", ...(steps ? [...deptSteps, "vissues", "vcontacts"] : []), "alerts"].includes(name) ? name : "vhome";
    const vpView = tab === "vp" ? location.hash.split("/")[3] || "" : null; // 요약 / wbs / in / req / out
    document.title = `봉사자 · ${TITLE}`;
    // 왼쪽 메뉴: 직원 화면과 같은 틀 (묵주 아래에 입출고를 접고 펴기)
    layout.tags = null;
    const main = h("main", { class: "vol__main", id: "main" }, loading());
    const navBox = h("nav", { class: "side__nav", "aria-label": "봉사자 메뉴" });
    const drawVolNav = () => {
      const link = (id, label, ic, sub, onclick, badge) => h("a", {
        class: "side__link" + (sub ? " side__link--sub" : "") + (id === tab ? " is-active" : ""), href: `#/${id}`, "aria-current": id === tab ? "page" : null, title: badge ? `${label} · 새 글 ${badge}개` : label,
        onclick: () => { if (onclick) onclick(); toggleNav(false); }
      }, [icon(ic), h("span", { class: "side__text", text: label }), badge ? h("span", { class: "nav-badge", "aria-label": `안 읽은 공지 ${badge}개`, text: badge > 99 ? "99+" : String(badge) }) : chgBadge(id === "alerts" ? state.chg?.alarm : chgN(id))]);
      // 묶음(묵주·손십자가)마다 프로젝트 관리 메뉴: 요약 아래 WBS · 입고 · 요청수량 · 출고
      const groupNav = (g) => {
        const key = "ps.navVg." + g.key;
        const here = tab === "vp" && id === g.key;
        const open = here || store.get(key, "1") !== "0";
        const setOpen = (o) => { store.set(key, o ? "1" : "0"); drawVolNav(); };
        const sub = (view, label, ic) => {
          const on = here && vpView === view;
          return h("a", { class: "side__link side__link--sub" + (on ? " is-active" : ""), href: `#/vp/${g.key}/${view}`, "aria-current": on ? "page" : null, title: label, onclick: () => toggleNav(false) }, [icon(ic), h("span", { class: "side__text", text: label }), chgBadge(chgN(`vp/${g.key}/${view}`))]);
        };
        const top = here && !vpView;
        return h("div", { class: "side__group" }, [
          h("div", { class: "side__row" }, [
            h("a", { class: "side__link" + (top ? " is-active" : ""), href: `#/vp/${g.key}`, "aria-current": top ? "page" : null, title: `프로젝트 관리(${g.name})`, onclick: () => toggleNav(false) }, [icon("folder"), h("span", { class: "side__text", text: `프로젝트 관리(${g.name})` })]),
            h("button", { class: "side__toggle" + (open ? " is-open" : ""), type: "button", html: ICON.right, "aria-expanded": String(open), "aria-label": `${g.name} 아래 메뉴 ${open ? "접기" : "펼치기"}`, onclick: () => setOpen(!open) })
          ]),
          h("div", { class: "side__kids", hidden: !open }, g.only ? [volOn(g.only) ? sub(g.only, "제품 관리", "db") : null] : [volOn("wbs") ? sub("wbs", "WBS", "grid") : null, volOn("req") ? sub("req", "추가 전달 물량", "cal") : null, volOn("in") ? sub("in", "입고", "db") : null, volOn("out") ? sub("out", "출고", "db") : null, volOn("recovery") ? sub("recovery", g.key === "cross" ? "제품 관리" : "완제품 관리", "db") : null])
        ]);
      };
      if (steps) {
        const stepLink = (k, label, n) => h("a", { class: "side__link side__link--sub side__step" + (k === tab ? " is-active" : ""), href: `#/${k}`, "aria-current": k === tab ? "page" : null, title: label, onclick: () => toggleNav(false) }, [
          h("span", { class: "side__stepnum", text: String(n) }), h("span", { class: "side__text", text: label }), chgBadge(chgN(k))]);
        const group = (ic, name, kids) => h("div", { class: "side__group side__cat" }, [h("div", { class: "side__catlabel" }, [icon(ic), h("span", { class: "side__text", text: name })]), ...kids.filter(Boolean)]);
        const sub = (id, label, ic, badge) => link(id, label, ic, true, null, badge);
        return navBox.replaceChildren(...[
          link(team ? "thome" : "vhome", "홈 (오늘 할 일)", "home"),
          link("alerts", "알림", "clock"),
          team ? link("tcal", "캘린더", "cal") : null,
          ...STEP_CATS[team ? "team" : "dept"].map((cat) => group(cat.icon, cat.name, cat.steps.map(([k, l], i) => stepLink(k, l, i + 1)))),
          group("chat", "소통", team
            ? [sub("vschedule", "일정", "cal"), sub("tissues", "이슈", "note"), sub("vboard", "게시판", "chat"), sub("vnotices", "공지", "bell", state.unreadNotices)]
            : [sub("vcontacts", "연락·문의 기록", "phone"), sub("vtraining", "기본 교육", "check"), sub("vissues", "이슈", "note"), sub("vboard", "게시판", "chat"), sub("vnotices", "공지", "bell", state.unreadNotices)])
        ].filter(Boolean));
      }
      if (team) return navBox.replaceChildren(
        link("thome", "홈", "grid"), link("alerts", "알림", "clock"), link("tcal", "캘린더", "cal"), link("torgs", "수도회·교육", "people"), link("trecov", "제품 회수", "db"), link("tinsp", "제품 검수", "check"),
        link("tissues", "이슈 등록", "note"), link("vboard", "게시판", "chat"), link("vnotices", "공지", "bell", false, null, state.unreadNotices));
      navBox.replaceChildren(...[
        volOn("home") ? link("vhome", "대시보드", "grid") : null,
        link("alerts", "알림", "clock"),
        volOn("schedule") ? link("vschedule", "일정", "cal") : null,
        volOn("training") ? link("vtraining", "기본 교육", "check") : null,
        ...VOL_GROUPS.map(groupNav),
        link("vboard", "게시판", "chat"),
        volOn("notices") ? link("vnotices", "공지", "bell", false, null, state.unreadNotices) : null
      ].filter(Boolean));
    };
    drawVolNav();
    state.drawVolNav = drawVolNav;
    // 이 메뉴를 열었으니 이 메뉴의 '새 변경' 숫자는 지움 (알림 화면은 '알림' 숫자)
    seeMenu(tab === "alerts" ? "alarm" : tab === "vp" ? `vp/${id}/${vpView}` : tab);
    const account = h("button", { class: "side__account", type: "button", "aria-label": "내 계정" }, [
      h("span", { class: `avatar c${state.user.id % 6}`, text: state.user.name.replace(/\s/g, "").slice(-2) }),
      h("span", { class: "side__who" }, [h("strong", { text: state.user.name }), h("small", { text: (preview ? "관리자 미리보기 · " : "") + (team ? "팀 봉사자" : "부서 봉사자") })])
    ]);
    const other = preview ? null : (state.user.volKinds || []).find((k) => k !== (team ? "team" : "dept")); // 권한이 둘이면 다른 쪽
    const switchVol = async () => {
      closePop();
      const r = await act(() => api("/vol-mode", { method: "POST", body: { mode: other } }));
      state.user = r.user; state.volMenu = null; state.chg = null; state.chgKey = ""; store.set("ps.loginAs", other === "team" ? "team" : "volunteer");
      location.hash = other === "team" ? "#/thome" : "#/vhome"; render();
    };
    // 로고 옆: 어떤 봉사자인지 버튼 (권한이 둘이면 누르면 다른 화면으로)
    const kindLabel = (team ? "팀 봉사자" : "부서 봉사자") + (team && state.user.volLeader ? " · 리더" : "");
    const kindBtn = () => h("button", { class: "vol__kind" + (other ? " is-switch" : ""), type: "button", disabled: !other, title: other ? `${other === "team" ? "팀 봉사자" : "부서 봉사자"} 화면으로 바꾸기` : kindLabel, "aria-label": other ? `지금 ${kindLabel}. 누르면 ${other === "team" ? "팀 봉사자" : "부서 봉사자"} 화면으로` : kindLabel, onclick: () => { if (other) quiet(switchVol()); } }, [h("span", { text: kindLabel }), other ? h("span", { class: "vol__kind-swap", "aria-hidden": "true", text: "⇄" }) : null]);
    account.addEventListener("click", () => popover(account, h("div", { class: "pop__list" }, preview ? [
      h("button", { type: "button", class: "pop__item", onclick: () => { closePop(); startVolPreview(team ? "dept" : "team"); } }, team ? "부서 봉사자 화면 미리보기로" : "팀 봉사자 화면 미리보기로"),
      h("button", { type: "button", class: "pop__item", onclick: endVolPreview }, "미리보기 끝내기 (관리자 화면으로)")
    ] : [
      other ? h("button", { type: "button", class: "pop__item", onclick: () => quiet(switchVol()) }, other === "team" ? "팀 봉사자 화면으로" : "부서 봉사자 화면으로") : null,
      h("button", { type: "button", class: "pop__item", onclick: () => { closePop(); toggleNav(false); appDialog(); } }, "휴대폰 알림 · 앱 설치"),
      h("button", { type: "button", class: "pop__item", onclick: () => { closePop(); openDialog("비밀번호 변경", passwordForm(closeDialog)); } }, "비밀번호 변경"),
      h("button", { type: "button", class: "pop__item", onclick: () => { closePop(); logout(); } }, "로그아웃")
    ])));
    const brand = () => h("a", { class: "brand", href: team ? "#/thome" : "#/vhome", title: TITLE }, [h("img", { src: "favicon.svg", alt: "" }), h("span", { class: "side__text", text: TITLE })]);
    app.replaceChildren(h("div", { class: "shell shell--vol" }, [
      h("aside", { class: "side" }, [
        h("div", { class: "side__top" }, [
          brand(),
          kindBtn(),
          h("button", { class: "icon-btn side__collapse", type: "button", html: ICON.left, onclick: toggleSideMini }),
          h("button", { class: "icon-btn side__close", type: "button", "aria-label": "메뉴 닫기", html: ICON.close, onclick: () => toggleNav(false) })
        ]),
        navBox,
        account,
        sideResizer()
      ]),
      h("div", { class: "scrim", onclick: () => toggleNav(false) }),
      h("div", { class: "content" }, [
        h("header", { class: "mobilebar" }, [
          h("button", { class: "icon-btn", type: "button", "aria-label": "메뉴", html: ICON.menu, onclick: () => toggleNav(true) }),
          brand(),
          kindBtn()
        ]),
        preview ? h("div", { class: "preview-bar", role: "status" }, [h("span", {}, [icon("lock"), ` 관리자 미리보기 · ${team ? "팀" : "부서"} 봉사자 화면 · 적은 내용은 실제로 저장돼요`]),
          h("span", { class: "actions" }, [h("button", { class: "btn btn--ghost btn--sm", type: "button", text: team ? "부서 화면 보기" : "팀 화면 보기", onclick: () => startVolPreview(team ? "dept" : "team") }), h("button", { class: "btn btn--sm btn--primary", type: "button", text: "미리보기 끝내기", onclick: endVolPreview })])]) : null,
        main
      ])
    ]));
    applySide();
    const show = (...kids) => { if (seq === volSeq) fill(main, ...kids); };
    const load = async () => {
      // 아직 열지 않은 메뉴로 들어오면 안내 (주소를 직접 쳐도)
      const closedMsg = () => show([h("h1", { class: "vol__hello", text: "준비 중인 메뉴예요" }), h("div", { class: "card empty", text: "이 메뉴는 아직 열리지 않았어요. 왼쪽의 입고·출고 메뉴를 써 주세요." })]);
      const keyOf = { vschedule: "schedule", vtraining: "training", vnotices: "notices" }[tab];
      if (!steps && !team && state.volMenu && keyOf && !volOn(keyOf)) return closedMsg();
      if (!steps && state.volMenu && tab === "vp" && vpView && !volOn(vpView)) return closedMsg();
      // 입력 판을 닫거나 상태를 바꾸면 건수·진행 표시를 그 자리에서 새로 고침
      state.opsRefresh = steps ? async () => {
        if (seq !== volSeq) return;
        try { state.opsCounts = (await api("/ops/counts")).counts; } catch (e) { return; }
        if (seq !== volSeq) return;
        drawVolNav();
        if (stepOf(tab)) {
          const fresh = stepFrame(tab, [], team);
          main.querySelector(".stepbar")?.replaceWith(fresh[0]);
          main.querySelector(".stepbar__next")?.replaceWith(fresh[fresh.length - 1]);
        }
      } : null;
      if (tab === "alerts") { document.title = `알림 · ${TITLE}`; return show(await alertsView()); }
      if (steps) {
        // 단계 화면마다 처리할 건수를 새로 받아 메뉴·진행 표시에 씀
        try { state.opsCounts = (await api("/ops/counts")).counts; } catch (e) { state.opsCounts = state.opsCounts || {}; }
        if (seq === volSeq) drawVolNav();
        const st = stepOf(tab);
        if (st) { document.title = `${st.cat.steps[st.i][1]} · ${TITLE}`; return show(stepFrame(tab, await stepScreen(tab), team)); }
        if (tab === (team ? "thome" : "vhome")) return show(await opsHome(team));
        if (tab === "vissues") return show(await teamIssues());
        if (tab === "vcontacts" || tab === "tedu4") return show([h("h1", { class: "vol__hello", text: "연락·문의 기록" }), ...(await opsContacts(team))]);
        if (team && tab === "vschedule") { document.title = `일정 · ${TITLE}`; return show(volSchedules((await api("/volunteer/home")).schedules)); }
      }
      if (tab === "vboard") { document.title = `게시판 · ${TITLE}`; return show(id ? await boardPostView("#/vboard", Number(id)) : await boardList("#/vboard")); }
      if (tab === "vnotices") {
        const setBadge = (r) => { if (seq === volSeq) { state.unreadNotices = r.unreadNotices; drawVolNav(); } };
        if (id) {
          const r = await api(`/notices/${Number(id)}`);
          setBadge(r);
          document.title = `${r.notice.title} · ${TITLE}`;
          return show([
            h("a", { class: "back-link", href: "#/vnotices" }, [icon("left"), "공지 목록"]),
            h("article", { class: "card notice-view stack" }, [h("h1", { text: r.notice.title }), h("div", { class: "muted notice-item__meta" }, h("span", { text: dayOf(r.notice.createdAt) })), h("div", { class: "prose", text: r.notice.body })])
          ]);
        }
        const r = await api("/notices");
        setBadge(r);
        return show([
          h("h1", { class: "vol__hello", text: "공지" }),
          r.notices.length ? h("ul", { class: "notice-list" }, r.notices.map((n) => h("li", {}, h("a", { class: "card notice-item" + (n.pinned ? " is-pinned" : ""), href: `#/vnotices/${n.id}` }, [
            h("div", { class: "notice-item__title" }, [h("strong", { text: n.title }), n.unread ? h("span", { class: "new-badge", text: "새 글" }) : null]),
            h("p", { class: "notice-item__preview", text: n.preview }),
            h("div", { class: "notice-item__meta muted" }, h("span", { text: dayOf(n.createdAt) }))
          ])))) : h("div", { class: "card empty", text: "아직 공지가 없어요." })
        ]);
      }
      if (team) return show(await teamPage(tab, id));
      if (tab === "vstock") {
        if (id) {
          const [, , , open, editId] = location.hash.split("/");
          if (volOn("moves2")) { // 새 입고·출고 화면: 대장 상세(5단계) 대신 입고·출고 화면에서 바로 적기·고치기
            const [{ ledgers }, d] = await Promise.all([api("/volunteer/stock"), api(`/volunteer/stock/${Number(id)}`)]);
            const eid = open === "edit" ? Number(editId) || null : null;
            const type = eid ? d.moves.find((x) => x.id === eid)?.type || "in" : open === "out" ? "out" : "in";
            if (open) history.replaceState(null, "", `#/vstock/${id}`); // 새로고침해도 입력 창이 다시 열리지 않게
            document.title = `입고 · 출고 · ${TITLE}`;
            return show([h("nav", { class: "muted small" }, h("a", { href: "#/vstock", text: "입출고" })), h("h1", { class: "vol__hello", text: "입고 · 출고" }),
              volMovesPage(type, ledgers, { ledgerId: Number(id), data: d, editId: eid, openNew: open === "in" || open === "out", switchable: true, isCurrent: () => seq === volSeq })]);
          }
          return pageStock(Number(id), { show, open: open === "in" || open === "out" ? open : null, editId: open === "edit" ? Number(editId) || null : null, isCurrent: () => seq === volSeq });
        }
        const { ledgers } = await api("/volunteer/stock");
        document.title = `입출고 · ${TITLE}`;
        return show([
          h("h1", { class: "vol__hello", text: "입출고" }),
          ledgers.length ? h("div", { class: "stack" }, stockGroupSections(ledgers, (l) => `#/vstock/${l.id}`)) : h("div", { class: "card empty", text: "아직 입력할 수 있는 입출고 대장이 없어요." })
        ]);
      }
      if (tab === "vp") {
        const g = VOL_GROUPS.find((x) => x.key === id) || VOL_GROUPS[0];
        return show(await volGroupPage(g, vpView));
      }
      if (tab === "vprojects") {
        if (!id) { location.replace(`#/vp/${VOL_GROUPS[0].key}`); return; } // 예전 주소 → 묵주 요약
        if (id) {
          const d = await api(`/volunteer/projects/${Number(id)}`);
          const ls = (await api("/volunteer/stock")).ledgers.filter((l) => l.projectId === d.project.id);
          return show(volProject(d, false, ls, await volLedgerDetails(ls)));
        }
        const { projects } = await api("/volunteer/projects");
        const { ledgers } = await api("/volunteer/stock");
        if (projects.length === 1) return show(volProject(await api(`/volunteer/projects/${projects[0].id}`), true, ledgers, await volLedgerDetails(ledgers))); // 하나면 바로
        return show(volProjects(projects));
      }
      if (tab === "vhome" && state.volMenu && !volOn("home")) { location.replace(`#/vp/${VOL_GROUPS[0].key}/${volOn("in") ? "in" : ""}`); return; }
      const d = await api("/volunteer/home");
      if (tab === "vhome") d.ledgers = (await api("/volunteer/stock")).ledgers;
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
      s.place || s.qty != null ? h("span", { class: "muted small", text: [s.place, s.qty != null ? `수량 ${fmtN(s.qty)}` : ""].filter(Boolean).join(" · ") }) : null,
      s.note ? h("p", { class: "vol-pre small", text: s.note }) : null
    ])
  ]);
  // 대장 한 줄: 입고·출고·재고와 바로 입력 버튼
  const volStockRow = (l) => {
    const left = l.inTotal - l.outTotal;
    return h("li", { class: "vol-stock" }, [
      h("a", { class: "vol-stock__name", href: `#/vstock/${l.id}` }, [h("strong", { text: l.name }), h("span", { class: "muted small", text: `입고 ${fmtN(l.inTotal)} · 출고 ${fmtN(l.outTotal)}` }), h("span", { class: left < 0 ? "small stock-minus" : "small", text: `재고 ${fmtN(left)} ${l.unit}` })]),
      h("span", { class: "vol-stock__btns" }, [h("a", { class: "btn btn--primary btn--sm", href: `#/vstock/${l.id}/in`, "aria-label": `${l.name} 입고 입력`, text: "입고" }), h("a", { class: "btn btn--primary btn--sm", href: `#/vstock/${l.id}/out`, "aria-label": `${l.name} 출고 입력`, text: "출고" })])
    ]);
  };
  function volHome({ schedules, trainings, ledgers }) {
    const next = schedules.filter((s) => s.date >= today()).slice(0, 3);
    const doneN = trainings.filter((t) => t.done).length;
    const todo = trainings.filter((t) => !t.done).slice(0, 3);
    const when = new Date().toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "long" });
    const more = (href, text) => h("a", { class: "link-btn", href, text });
    return [
      h("p", { class: "muted", text: when }),
      h("h1", { class: "vol__hello", text: `${state.user.name}님, 안녕하세요` }),
      h("div", { class: "vol__cards" }, [
        !volOn("schedule") ? null : h("section", { class: "card vol__card" }, [
          h("div", { class: "card__head" }, [h("h2", { class: "card__title", text: "내 봉사 일정" }), more("#/vschedule", "전체 보기")]),
          next.length ? h("ul", { class: "vol-list" }, next.map(volSchedRow)) : h("p", { class: "muted", text: "다가오는 일정이 없어요." })
        ]),
        !volOn("training") ? null : h("section", { class: "card vol__card" }, [
          h("div", { class: "card__head" }, [h("h2", { class: "card__title", text: "기본 교육" }), more("#/vtraining", "전체 보기")]),
          trainings.length ? h("p", { class: "muted", text: `${trainings.length}개 중 ${doneN}개 이수` }) : h("p", { class: "muted", text: "아직 등록된 교육이 없어요." }),
          todo.length ? h("ul", { class: "vol-todo" }, todo.map((t) => h("li", { text: t.title }))) : null
        ]),
        h("section", { class: "card vol__card" }, [
          h("div", { class: "card__head" }, [h("h2", { class: "card__title", text: "입고 · 출고" }), h("span", { class: "actions actions--start" }, [volOn("in") ? more(`#/vp/${VOL_GROUPS[0].key}/in`, "입고") : null, volOn("out") ? more(`#/vp/${VOL_GROUPS[0].key}/out`, "출고") : null])]),
          ledgers.length ? h("ul", { class: "vol-list" }, ledgers.map(volStockRow)) : h("p", { class: "muted", text: "아직 입력할 수 있는 대장이 없어요." })
        ]),
        h("section", { class: "card vol__card" }, [
          h("div", { class: "card__head" }, [h("h2", { class: "card__title", text: "프로젝트 관리" }), more(`#/vp/${VOL_GROUPS[0].key}`, "보기")]),
          h("p", { class: "muted", text: "묵주·손십자가 요약과 입고·출고를 봐요." })
        ])
      ])
    ];
  }
  // 봉사자 일정: 달력 + 고른 날의 일정. 직접 입력한 일정만 고칠 수 있음
  const volCal = { month: "", sel: "" };
  function volScheduleDialog(s, date) {
    const err = errorLine();
    const title = h("input", { value: s?.title || "", maxlength: "120", autofocus: true, placeholder: "예: 포장 봉사" });
    const day = h("input", { type: "date", value: s?.date || date || today() });
    const start = h("input", { type: "time", value: s?.startTime || "" });
    const end = h("input", { type: "time", value: s?.endTime || "" });
    const place = h("input", { value: s?.place || "", maxlength: "120" });
    const note = h("textarea", { rows: "3", maxlength: "1000" }, s?.note || "");
    const qty = h("input", { type: "number", min: "0", inputmode: "numeric", value: s?.qty ?? "" });
    const ok = h("button", { class: "btn btn--primary", type: "submit", text: s ? "저장" : "추가" });
    const form = h("form", { class: "stack", novalidate: true }, [
      field("제목", title),
      field("날짜", day),
      field("수량 (선택)", qty),
      h("div", { class: "row2" }, [field("시작 (선택)", start), field("끝 (선택)", end)]),
      field("장소 (선택)", place), field("메모 (선택)", note),
      s ? null : h("p", { class: "muted small", text: "내 일정으로 저장돼요. 다른 봉사자에게는 보이지 않고, 관리자는 볼 수 있어요." }),
      err,
      h("div", { class: "actions" }, [
        s ? h("button", { class: "btn btn--danger-outline btn--sm", type: "button", text: "지우기", onclick: async () => {
          if (!confirm(`'${s.title}' 일정을 지울까요?`)) return;
          await act(() => api(`/volunteer/schedules/${s.id}`, { method: "DELETE" }));
          closeDialog(); render();
        } }) : null,
        h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), ok
      ])
    ]);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      busy(ok, async () => {
        try {
          await api(s ? `/volunteer/schedules/${s.id}` : "/volunteer/schedules", { method: s ? "PATCH" : "POST", body: { title: title.value, date: day.value, startTime: start.value, endTime: end.value, place: place.value, note: note.value, qty: qty.value } });
          volCal.sel = day.value; volCal.month = day.value.slice(0, 7);
          closeDialog(); render();
        } catch (ex) { showError(err, ex.message); }
      });
    });
    openDialog(s ? "일정 고치기" : "일정 추가", form);
  }
  function volSchedules(list) {
    if (!volCal.sel) volCal.sel = today();
    if (!volCal.month) volCal.month = volCal.sel.slice(0, 7);
    const box = h("div", { class: "stack" });
    const color = (s) => (s.mine ? "c2" : "c0");
    const draw = () => {
      const [y, m] = volCal.month.split("-").map(Number);
      const shift = (n) => { const d = new Date(y, m - 1 + n, 1); volCal.month = ymd(d).slice(0, 7); draw(); };
      const first = new Date(y, m - 1, 1);
      const cur = new Date(y, m - 1, 1 - first.getDay());
      const grid = h("div", { class: "cal-grid vol-cal", role: "grid" }, h("div", { class: "cal-row cal-row--head", role: "row" }, WEEKDAYS.map((w, i) => h("div", { class: "cal-wd" + (i === 0 ? " is-sun" : i === 6 ? " is-sat" : ""), role: "columnheader", text: w }))));
      do {
        const row = h("div", { class: "cal-row", role: "row" });
        for (let i = 0; i < 7; i++) {
          const key = ymd(cur);
          const rows = list.filter((s) => s.date === key);
          const pick = () => { volCal.sel = key; if (key.slice(0, 7) !== volCal.month) volCal.month = key.slice(0, 7); draw(); };
          row.append(h("div", {
            class: "cal-day" + (i === 0 ? " is-sun" : i === 6 ? " is-sat" : "") + (key.slice(0, 7) !== volCal.month ? " is-out" : "") + (key === today() ? " is-today" : "") + (key === volCal.sel ? " is-peeked" : ""),
            role: "gridcell", tabindex: "0", "aria-label": `${volDay(key)}, 일정 ${rows.length}개`, "aria-selected": String(key === volCal.sel), onclick: pick, onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } }
          }, [
            h("span", { class: "cal-num", text: String(cur.getDate()) }),
            h("div", { class: "cal-chips vol-cal__chips" }, rows.slice(0, 3).map((s) => h("span", { class: `vol-chipline ${color(s)}`, title: s.title, text: `${s.startTime ? `${s.startTime} ` : ""}${s.title.split(" · ").pop()}` }))),
            rows.length > 3 ? h("span", { class: "muted vol-cal__more", text: `+${rows.length - 3}` }) : null,
            rows.length ? h("span", { class: "vol-cal__dots", "aria-hidden": "true" }, rows.slice(0, 3).map((s) => h("i", { class: color(s) }))) : null
          ]));
          cur.setDate(cur.getDate() + 1);
        }
        grid.append(row);
      } while (cur.getMonth() === m - 1 && cur.getFullYear() === y);
      const dayRows = list.filter((s) => s.date === volCal.sel);
      fill(box,
        h("section", { class: "card cal-card" }, [
          h("div", { class: "cal-head" }, [
            h("div", { class: "cal-nav" }, [
              h("button", { class: "icon-btn", type: "button", "aria-label": "이전 달", html: ICON.left, onclick: () => shift(-1) }),
              h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "오늘", onclick: () => { volCal.sel = today(); volCal.month = volCal.sel.slice(0, 7); draw(); } }),
              h("button", { class: "icon-btn", type: "button", "aria-label": "다음 달", html: ICON.right, onclick: () => shift(1) })
            ]),
            h("h2", { class: "cal-title", text: `${y}년 ${m}월` }),
            h("div", { class: "cal-tools vol-cal__legend" }, [h("span", { class: "vol-legend c2", text: "내 일정" }), h("span", { class: "vol-legend c0", text: "안내받은 일정" })])
          ]),
          grid
        ]),
        h("section", { class: "card vol__card" }, [
          h("div", { class: "card__head" }, [
            h("h2", { class: "card__title", text: volDay(volCal.sel) }),
            h("button", { class: "btn btn--primary btn--sm", type: "button", onclick: () => volScheduleDialog(null, volCal.sel) }, [icon("plus"), "일정 추가"])
          ]),
          dayRows.length ? h("ul", { class: "vol-list" }, dayRows.map((s) => h("li", s.mine ? { "data-ref": `sched:${s.id}`, class: "vol-dayrow is-mine", tabindex: "0", title: "눌러서 고치기", onclick: () => volScheduleDialog(s), onkeydown: (e) => { if (e.key === "Enter") volScheduleDialog(s); } } : { class: "vol-dayrow", "data-ref": `sched:${s.id}` }, [
            h("i", { class: `vol-dayrow__mark ${color(s)}` }),
            h("div", { class: "vol-sched__what" }, [
              h("strong", { text: s.title }),
              [volTime(s), s.place, s.qty != null].some(Boolean) ? h("span", { class: "muted small", text: [volTime(s), s.place, s.qty != null ? `수량 ${fmtN(s.qty)}` : ""].filter(Boolean).join(" · ") }) : null,
              s.note ? h("p", { class: "vol-pre small", text: s.note }) : null
            ]),
            s.mine ? h("span", { class: "muted small vol-dayrow__edit", text: "고치기" }) : null
          ]))) : h("p", { class: "muted", text: "이 날은 일정이 없어요." })
        ])
      );
    };
    draw();
    openRef("sched", (id) => list.find((s) => s.id === id), (s) => { volCal.sel = s.date; volCal.month = s.date.slice(0, 7); draw(); flashRef("sched", s.id); });
    return [
      h("div", { class: "page-head" }, [h("h1", { class: "vol__hello", text: "일정" })]),
      box
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
        return h("section", { class: "card vol__card", "data-ref": `training:${t.id}` }, [
          h("div", { class: "card__head" }, [h("h2", { class: "card__title", text: t.title }), t.done ? h("span", { class: "vol-done", text: "이수 완료" }) : null]),
          meta ? h("p", { class: "muted small", text: meta }) : null,
          t.body ? h("p", { class: "vol-pre", text: t.body }) : null,
          t.link ? h("p", {}, h("a", { class: "link-btn", href: t.link, target: "_blank", rel: "noopener noreferrer", text: "교육 자료 열기" })) : null,
          h("div", { class: "vol-actions" }, btn)
        ]);
      })) : h("div", { class: "card empty", text: "아직 등록된 교육이 없어요." })
    ];
  }
  // 봉사자 프로젝트 관리는 묶음별: 묵주 / 손십자가
  const VOL_GROUPS = [{ key: "rosary", name: "묵주" }, { key: "cross", name: "손십자가", only: "recovery" }]; // only: 이 화면만 둠 (손십자가는 제품 관리만)
  async function volGroupPage(g, view, opts = {}) {
    if (g.key === "rosary") await loadRosaryWbs();
    if (g.only && view !== g.only) { location.replace(`#/vp/${g.key}/${g.only}`); return []; }
    document.title = `프로젝트 관리(${g.name}) · ${TITLE}`;
    const title = (t) => h("h1", { class: "vol__hello", text: t });
    const { projects } = await api("/volunteer/projects");
    let d = null, grp = null;
    for (const p of projects) {
      const x = await api(`/volunteer/projects/${p.id}`);
      const found = x.items.find((i) => i.kind === "group" && i.name === g.name);
      if (found) { d = x; grp = found; break; }
    }
    if (!grp) return [title(`프로젝트 관리(${g.name})`), h("div", { class: "card empty", text: `아직 '${g.name}' 프로젝트가 준비되지 않았어요.` })];
    // 이 묶음과 그 아래 항목만
    const ids = new Set([grp.id]);
    for (let grew = true; grew;) { grew = false; for (const i of d.items) if (i.parentId && ids.has(i.parentId) && !ids.has(i.id)) { ids.add(i.id); grew = true; } }
    const items = d.items.filter((i) => ids.has(i.id));
    const visits = (d.visits || []).filter((v) => ids.has(v.itemId));
    const ledgers = (await api("/volunteer/stock")).ledgers.filter((l) => ids.has(l.itemId));
    const head = (label) => (opts.steps ? [] : [h("nav", { class: "muted small" }, h("a", { href: `#/vp/${g.key}`, text: `프로젝트 관리(${g.name})` })), title(label)]);
    if (view === "wbs") return [...head("WBS"), g.key === "rosary" ? volWbsRosary() : volWbs({ name: g.name }, visits)];
    if (view === "req") return [...head(`${g.name} 추가 전달 물량`), volVisits(visits, `${g.name} 추가 전달 물량`)];
    if (view === "in" || view === "out") {
      if (volOn("moves2") || opts.steps) {
        const ref = ["stock_in", "stock_out"].includes(state.openRef?.topic) ? state.openRef : null; // 알림에서 온 기록 바로 열기
        if (ref) state.openRef = null;
        return [...head(view === "in" ? "입고" : "출고"), volMovesPage(view, ledgers, { cut: view === "out" && g.key === "rosary" ? visits : null, ...(ref ? { ledgerId: ref.ledgerId, editId: ref.id } : {}) })];
      }
      const moves = volMoveCard(view, ledgers, await volLedgerDetails(ledgers));
      // 묵주 출고: 1) 실타래(창고) 입출고와 2) 자른실(제작 수도회) 출고를 나눠서
      if (view === "out" && g.key === "rosary") { const t = moves.querySelector(".card__title"); if (t) t.textContent = "1) 실타래 입출고 · 출고"; return [...head("출고"), moves, volCutCard(visits)]; }
      return [...head(view === "in" ? "입고" : "출고"), moves];
    }
    if (view === "recovery") return [...head(fgCfg(g.key).title), await volStageCard(grp.id, g.key)];
    if (view === "material") { location.replace(`#/vp/${g.key}`); return []; } // 원자재 보유물량은 없앰 (예전 주소는 요약으로)
    // 요약
    const leaf = items.filter((i) => i.kind === "item");
    const inT = ledgers.reduce((n, l) => n + l.inTotal, 0), outT = ledgers.reduce((n, l) => n + l.outTotal, 0);
    const reqT = visits.reduce((n, v) => n + (v.qty || 0), 0), reqLeft = visits.filter((v) => v.date >= today()).reduce((n, v) => n + (v.qty || 0), 0);
    const unit = ledgers[0]?.unit || "개";
    const rec = (await api(`/volunteer/records?item=${grp.id}&kind=recovery`)).records;
    const tile = (view, label, value, sub) => !volOn(view) ? null : h("a", { class: "card vol-sum__tile", href: `#/vp/${g.key}/${view}` }, [h("span", { class: "muted small", text: label }), h("strong", { text: value }), sub ? h("span", { class: "muted small", text: sub }) : null]);
    return [
      title(`프로젝트 관리(${g.name})`),
      h("p", { class: "muted small", text: `${d.project.name} › ${g.name} · 요약` }),
      h("div", { class: "vol-sum" }, [
        g.key === "rosary" ? tile("wbs", "WBS 공정", `확정 ${rosaryCounts().fixed} / ${rosaryCounts().total}`, `마일스톤 ${ROSARY_MILESTONES.length}단계`) : tile("wbs", "WBS 진척", "0%", "항목 준비 중"),
        tile("req", "추가 전달 물량", `실 ${fmtN(visits.reduce((n, v) => n + Math.max(0, moreThread(v) || 0), 0))} · 십자가 ${fmtN(visits.reduce((n, v) => n + Math.max(0, moreCross(v) || 0), 0))}`, visits.length ? `요청수량 ${fmtN(reqT)} · 방문 ${visits.length}건` : "연결된 일정 없음"),
        tile("in", "입고", `${fmtN(inT)} ${unit}`, ledgers.length ? `대장 ${ledgers.length}개` : "대장 없음"),
        tile("out", "출고", `${fmtN(outT)} ${unit}`, `재고 ${fmtN(inT - outT)} ${unit}`),
        (() => { const t = stageSum(rec); return tile("recovery", fgCfg(g.key).title, `판매 가능 ${fmtN(t.packed - t.out)}`, rec.length ? `입고 ${fmtN(t.in)} · 검수 ${fmtN(t.checked)} · 패키징 ${fmtN(t.packed)} · 출고 ${fmtN(t.out)}` : "기록 없음"); })()
      ]),
      grp.note ? h("p", { class: "vol-pre muted", text: grp.note }) : null,
      h("section", { class: "card vol__card" }, [
        h("div", { class: "card__head" }, [h("h2", { class: "card__title", text: "항목" }), h("span", { class: "muted small", text: `${leaf.length}개 · 완료 ${leaf.filter((i) => i.status === "done").length}개 · 읽기 전용` })]),
        leaf.length ? h("ul", { class: "vol-items" }, leaf.map((i) => h("li", { class: "vol-item" }, [
          h("div", { class: "vol-item__head" }, [h("span", { text: i.name }), h("span", { class: `pj-st pj-st--${i.status}`, text: projectStatusLabel(i.status) }), i.dueDate ? h("span", { class: "muted small", text: `마감 ${shortDate(i.dueDate)}` }) : null])
        ]))) : h("p", { class: "muted", text: "아직 항목이 없어요." })
      ])
    ];
  }
  // 묵주 WBS: '매듭묵주 사업 업무 정리(안)' 기준 — 마일스톤 7단계 > 공정 15개(확정·미정) > 추가 과업
  let ROSARY_PROCS = {
    1: { name: "원자재 조달(실타래)", fixed: true, feat: "입고 박스 운반과 수량·품질·대금 기록을 함께 처리", link: "고은방 불량·보충 협의" },
    2: { name: "원자재 조달(십자가알)", fixed: true, feat: "대량 입고 하차·운반과 계약·납품 기록 관리", link: "대건상사 납기 협의" },
    3: { name: "원자재 조달(본드)", fixed: true, feat: "소량 구매, 수녀님 수요 확인과 함께 처리", link: "영수증 처리" },
    4: { name: "배포용 재료 포장", fixed: true, joint: "십자가알·실타래를 수도회별 수량으로 나누고 포장", feat: "10만 개 분량을 수도회별로 나누는 세부 작업이 많음", link: "운반, 봉사자 조율" },
    5: { name: "수도회 배포", fixed: true, feat: "수녀님·수도회와 일정을 맞추는 일", link: "택배 포장·발송·운반" },
    6: { name: "제작(교육)", fixed: true, feat: "50개 수도회와 상시로 소통하는 일", link: "제작 현황 집계" },
    7: { name: "1차 검수(수도회)", fixed: true, feat: "수도회에 검수 기준을 안내하는 일", link: "검수 결과 집계" },
    8: { name: "완성품 조직위 배달", feat: "완성품 박스 수령·하차·운반이 중심", link: "회수 일정 조율", tasks: ["회수 방식 결정(택배·방문·수업 때 수거)", "완성품 수령·하차·운반", "운송비 기준 정리, 기안 반영"] },
    9: { name: "회수·2차 검수", joint: "완성품 샘플링 검수, 불량품 분리·교환", feat: "샘플링 검수·불량 교환 등 세부 작업이 많음", link: "운반·기록, 봉사자", tasks: ["검수 주체 결정 자료(조직위·출판사)", "검수 기준에 대한 출판사·수녀님 의견 수렴", "검수 봉사자 확보", "샘플링 검수, 불량품 교환"] },
    10: { name: "포장 원자재 조달", feat: "디자인·문구를 부서·업체와 협의하는 일이 중심", link: "발주·기안, 입고 운반", tasks: ["기적의 패 부착 여부·비용 부담 협의", "패키지 디자인·문구 확정(커뮤니케이션부)", "봉투·삽지·스티커 견적 요청", "발주·기안, 포장재 입고 운반"] },
    11: { name: "보관", feat: "창고 입출고 작업과 대장 관리", link: "직송 협의", tasks: ["창고 후보 조사, 출판사 직송 협의", "창고 계약 기안, 입출고 대장·작업"] },
    12: { name: "패키징", joint: "봉투·삽지·수도회명 스티커·기적의 패 작업", feat: "삽지·스티커 부착 등 10만 개 포장 작업", link: "운반, 봉사자·출판사 조율", tasks: ["작업 주체 결정(봉사자·출판사)", "포장 작업", "자재·완성품 운반"] },
    13: { name: "판매 채널 출고", feat: "출고 박스 운반과 배분·출고 기록", link: "판매처 수령 안내", tasks: ["판매 경로 비교안(출판사·자체·SNC)", "채널별 배분 수량표", "판매처 수령 일정 안내", "출고 박스 운반"] },
    14: { name: "판매", joint: "순례자 센터·팝업 등 판매 현장 근무 (일부)", feat: "판매처·현장 인력과 협의하는 일", link: "실적 집계, 현장 판매(공동 작업)", tasks: ["판매가 결정 자료(20·25달러)", "판매처 협의, 현장 인력 확보", "현장 판매 운영", "판매 실적 집계"] },
    15: { name: "정산·재고", feat: "재무부 정산, 잔여 재고 회수·운반", link: "판매처 재고 협의", tasks: ["정산 방식 재무부 협의", "잔여 재고 처리 기준", "판매처 잔여 재고 회수 협의", "잔여 재고 회수·운반"] }
  };
  let ROSARY_MILESTONES = [
    { name: "원자재 조달", main: "입고·운반·계약 기록", link: "업체 협의", procs: [1, 2, 3] },
    { name: "제작·검수(교육)", main: "수도회 제작·1차 검수 안내", link: "2차 검수(공동 작업)", procs: [4, 5, 6, 7, 8, 9] },
    { name: "보관", main: "창고·입출고 작업·대장", link: "출판사 직송 협의", procs: [11] },
    { name: "패키지", main: "디자인·문구·업체 협의", link: "포장 작업(공동 작업)", procs: [10, 12] },
    { name: "판매", main: "판매처·현장 인력 협의", link: "배분·출고·실적 집계", procs: [13, 14] },
    { name: "정산", main: "재무부 정산·결과보고", link: "판매처 재고 회수 협의", procs: [15] }
  ];
  const rosaryCounts = () => { const all = Object.values(ROSARY_PROCS); return { total: all.length, fixed: all.filter((p) => p.fixed).length }; };
  // 봉사자 WBS 타임라인 (주 단위 칸, 월 표기 26.11, 오늘 선)
  function volTimeline(fromYmd, toYmd) {
    const DAY = 86400000, WEEK_W = 24, t = today();
    const mondayOf = (x) => { const d = parseYmd(x); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; };
    const from = mondayOf(fromYmd), to = mondayOf(toYmd); to.setDate(to.getDate() + 7);
    const dayX = (x) => Math.round((parseYmd(x) - from) / DAY) * (WEEK_W / 7);
    const width = (Math.round((to - from) / DAY) / 7) * WEEK_W;
    const months = [], bands = [];
    const curMonth = t.slice(0, 7);
    for (const d = new Date(from.getFullYear(), from.getMonth(), 1), i = { n: 0 }; d < to; d.setMonth(d.getMonth() + 1), i.n++) {
      const x0 = Math.max(0, dayX(ymd(d))), nx = new Date(d.getFullYear(), d.getMonth() + 1, 1), x1 = Math.min(width, dayX(ymd(nx)));
      const key = ymd(d).slice(0, 7);
      months.push(h("span", { class: "gantt__month" + (key === curMonth ? " is-now" : ""), style: `left:${x0}px;width:${x1 - x0}px`, text: `${String(d.getFullYear()).slice(2)}.${pad(d.getMonth() + 1)}` }));
      bands.push({ x0, w: x1 - x0, odd: i.n % 2 === 1, now: key === curMonth });
    }
    const inRange = t >= ymd(from) && t < ymd(to);
    const todayLine = () => (inRange ? h("i", { class: "gantt__today", style: `left:${dayX(t)}px`, title: `오늘 ${t}` }) : null);
    // 월마다 옅은 음영, 이번 달은 따로 표시 (막대가 없어도 시간이 읽히게)
    const bandEls = () => bands.map((b) => h("span", { class: "vtl__band" + (b.odd ? " is-odd" : "") + (b.now ? " is-now" : ""), style: `left:${b.x0}px;width:${b.w}px` }));
    const track = (kids) => h("div", { class: "gantt__track vtl__track", style: `width:${width}px` }, [...bandEls(), todayLine(), ...(kids || [])]);
    const head = (nameCell) => h("div", { class: "gantt__row gantt__row--head", role: "row" }, [nameCell, h("div", { class: "gantt__track", style: `width:${width}px` }, [...months, todayLine()])]);
    const scrollToToday = (el) => requestAnimationFrame(() => { if (inRange) el.scrollLeft = Math.max(0, dayX(t) - 160); });
    return { track, head, scrollToToday };
  }
  function volWbsRosary() {
    const closed = new Set(JSON.parse(store.get("ps.vwbsClosed", "[]") || "[]"));
    let jointOnly = store.get("ps.vwbsJoint", "0") === "1";
    const box = h("section", { class: "card vol__card vwbs vol-wbs" });
    const c = rosaryCounts();
    const tag = (cls, text) => h("span", { class: "vwbs__tag vwbs__tag--" + cls, text });
    // 원자재 조달(2026-07)부터 WYD(2027-08)까지
    const tl = volTimeline("2026-07-01", "2027-08-31");
    // 한 줄짜리 이름 칸: 번호 · 이름 · 상태 점. 자세한 내용은 줄을 눌러 펼침
    const nameCell = (level, code, label, tags, chev, onclick, extraCls) => h(onclick ? "button" : "div", { class: `gantt__name wbs__name vwbs__cell${extraCls ? " " + extraCls : ""}`, type: onclick ? "button" : null, style: `padding-left:${10 + level * 16}px`, "aria-expanded": chev == null ? null : String(chev), onclick }, [
      h("span", { class: "wbs__chev" + (chev ? " is-open" : ""), html: chev == null ? "" : ICON.right }),
      h("span", { class: "wbs__code", text: code }),
      h("span", { class: "vwbs__title", title: typeof label === "string" ? label : null, text: typeof label === "string" ? label : "" }, typeof label === "string" ? null : label),
      h("span", { class: "vwbs__state" }, tags.filter(Boolean))
    ]);
    const dot = (kind, text) => h("span", { class: `vwbs__dot vwbs__dot--${kind}`, title: text }, [h("i"), text]);
    const draw = () => {
      const rows = [];
      ROSARY_MILESTONES.forEach((m, mi) => {
        const code = String(mi + 1);
        const procs = m.procs.filter((n) => !jointOnly || ROSARY_PROCS[n].joint);
        if (jointOnly && !procs.length) return;
        const open = !closed.has(code);
        const fixedN = m.procs.filter((n) => ROSARY_PROCS[n].fixed).length;
        const toggle = () => { open ? closed.add(code) : closed.delete(code); store.set("ps.vwbsClosed", JSON.stringify([...closed])); draw(); };
        rows.push(h("div", { class: "gantt__row wbs-row wbs-row--0" + (m.first ? " is-first" : ""), role: "row", title: `주요 업무: ${m.main}` }, [
          nameCell(0, code, h("span", {}, [h("strong", { text: m.name }), h("small", { class: "muted", text: `  ${m.main}` })]), [m.first ? tag("first", "먼저 결정") : m.procs.length ? h("span", { class: "vwbs__count", text: `확정 ${fixedN}/${m.procs.length}` }) : null], open, toggle),
          tl.track()
        ]));
        if (!open) return;
        if (!m.procs.length) rows.push(h("div", { class: "gantt__row wbs-row wbs-row--1", role: "row" }, [nameCell(1, `${code}.1`, `${m.main} — 판매가(20·25달러)·판매 경로 결정`, [dot("todo", "결정 필요")]), tl.track()]));
        procs.forEach((n, pi) => {
          const p = ROSARY_PROCS[n], pc = `${code}.${pi + 1}`;
          rows.push(h("div", { class: "gantt__row wbs-row wbs-row--1", role: "row" }, [
            nameCell(1, pc, `공정 ${n} · ${p.name}`, [p.joint ? dot("joint", "공동") : null, dot(p.fixed ? "fixed" : "open", p.fixed ? "확정" : "미정")]),
            tl.track()
          ]));
        });
      });
      const chart = h("div", { class: "gantt vol-wbs__chart", role: "table" }, [
        tl.head(h("div", { class: "gantt__name gantt__name--head wbs__name vwbs__cell" }, [h("span", { class: "wbs__chev" }), h("span", { class: "wbs__code", text: "WBS" }), h("span", { class: "vwbs__title", text: "마일스톤 · 공정" }), h("span", { class: "vwbs__state", text: "상태" })])),
        ...rows
      ]);
      tl.scrollToToday(chart);
      fill(box,
        h("div", { class: "card__head" }, [h("h2", { class: "card__title", text: "매듭묵주 WBS" }), h("span", { class: "muted small", text: "업무 정리(안) 기준" })]),
        h("div", { class: "vwbs__tools" }, [
          h("div", { class: "seg seg--sm" }, [["0", "전체"], ["1", "공동 작업만"]].map(([k, label]) => h("button", { type: "button", "aria-selected": String((jointOnly ? "1" : "0") === k), text: label, onclick: () => { jointOnly = k === "1"; store.set("ps.vwbsJoint", k); draw(); } }))),
          h("button", { class: "btn btn--ghost btn--sm", type: "button", text: closed.size ? "모두 펼치기" : "모두 접기", onclick: () => { if (closed.size) closed.clear(); else ROSARY_MILESTONES.forEach((_, i) => closed.add(String(i + 1))); store.set("ps.vwbsClosed", JSON.stringify([...closed])); draw(); } })
        ]),
        chart,
        h("div", { class: "vwbs__legend muted small" }, [dot("fixed", "확정 (진행 중)"), dot("open", "미정 (방식 결정 필요)"), dot("joint", "공동 작업 (봉사자와 함께)"), h("span", {}, [h("i", { class: "vwbs__todaykey" }), " 오늘"]), h("span", {}, [h("i", { class: "vwbs__nowkey" }), " 이번 달"])]),
        h("p", { class: "muted small", text: "공정별 일정이 정해지면 막대로 보여요." })
      );
    };
    draw();
    return box;
  }
  // 원자재 보유물량 · 제품 회수물량: 봉사자가 직접 적는 기록표
  const latestByName = (rows) => { const m = new Map(); for (const r of rows) if (!m.has(r.name)) m.set(r.name, r); return [...m.values()]; }; // 날짜 최신순으로 옴
  const VOL_RECORD = {
    material: { title: "원자재 보유물량", nameLabel: "원자재", namePh: "예: 실타래", hint: "원자재마다 가장 최근에 적은 수량이 지금 보유물량이에요.",
      total: (rows) => latestByName(rows).reduce((n, r) => n + r.qty, 0), sub: (rows) => `원자재 ${latestByName(rows).length}종 · 최근 기준` },
    recovery: { title: "제품 회수물량", nameLabel: "회수처", namePh: "예: ○○성당", hint: "회수한 날마다 한 줄씩 적어 주세요. 위 숫자는 전체 합계예요.",
      total: (rows) => rows.reduce((n, r) => n + r.qty, 0), sub: (rows) => `기록 ${rows.length}건 · 합계` }
  };
  // 완제품(묵주 회수 · 손십자가) 단계 관리: 입고 → 검수완료 → 패키징완료(바로 판매 가능) → 출고
  const VOL_STAGE_KEYS = ["in", "checked", "packed", "out"];
  const fgCfg = (gk) => gk === "cross"
    ? { title: "제품 관리", labels: { in: "입고 (대건상사)", checked: "검수완료", packed: "패키징 완료", out: "출고" }, namePh: { in: "예: 대건상사", checked: "", packed: "", out: "예: 판매처·현장" } }
    : { title: "완제품 관리", labels: { in: "회수 입고", checked: "검수완료", packed: "패키징 완료", out: "출고" }, namePh: { in: "예: ○○수녀회", checked: "", packed: "", out: "예: 판매처·현장" } };
  const stageSum = (rows) => Object.fromEntries(VOL_STAGE_KEYS.map((k) => [k, rows.filter((r) => (r.stage || "in") === k).reduce((n, r) => n + r.qty, 0)]));
  async function volStageCard(itemId, gk) {
    const cfg = fgCfg(gk);
    const box = h("section", { class: "card vol__card vol-rec vol-fg" });
    let rows = (await api(`/volunteer/records?item=${itemId}&kind=recovery`)).records;
    let filter = "";
    const edit = (r, presetStage) => {
      const err = errorLine();
      const stage = h("select", {}, VOL_STAGE_KEYS.map((k) => h("option", { value: k, text: cfg.labels[k] })));
      stage.value = r?.stage || presetStage || "in";
      const date = h("input", { type: "date", value: r?.date || today(), required: true });
      const name = h("input", { value: r?.name || "", maxlength: "80", placeholder: cfg.namePh[stage.value] || "" });
      // 어디서·어디로: 입고(입고 장소 · 보낸 대상)와 출고(출고 장소 · 받는 대상)에서만 보임. 저장된 값은 지우지 않음
      const nameF = field("입고 장소 · 보낸 대상 (선택)", name);
      const syncName = () => { name.placeholder = cfg.namePh[stage.value] || ""; nameF.hidden = !["in", "out"].includes(stage.value); nameF.querySelector(".field__label").textContent = stage.value === "out" ? "출고 장소 · 받는 대상 (선택)" : "입고 장소 · 보낸 대상 (선택)"; };
      stage.addEventListener("change", syncName); syncName();
      const qty = h("input", { type: "number", min: "0", inputmode: "numeric", value: r ? String(r.qty) : "", required: true, autofocus: true });
      const note = h("input", { value: r?.note || "", maxlength: "300" });
      const ok = h("button", { class: "btn btn--primary", type: "submit", text: r ? "저장" : "추가" });
      const form = h("form", { class: "stack" }, [h("div", { class: "row2" }, [field("단계", stage), field("날짜", date)]), h("div", { class: "row2" }, [field("수량", qty), nameF]), field("메모 (선택)", note), err,
        h("div", { class: "actions" }, [r ? h("button", { class: "btn btn--danger-outline btn--sm", type: "button", text: "지우기", onclick: async () => {
          if (!confirm("이 기록을 지울까요?")) return;
          const x = await act(() => apiAsk(`/volunteer/records/${r.id}`, { method: "DELETE" })); if (!x) return; rows = x.records; closeDialog(); draw();
        } }) : null, ok])]);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const body = { itemId, kind: "recovery", stage: stage.value, date: date.value, name: name.value, qty: qty.value, note: note.value };
        busy(ok, async () => {
          try { const x = await apiAsk(r ? `/volunteer/records/${r.id}` : "/volunteer/records", { method: r ? "PATCH" : "POST", body }); if (!x) return; rows = x.records; closeDialog(); toast("저장했어요."); draw(); }
          catch (ex) { showError(err, ex.message); }
        });
      });
      openDialog(r ? `${cfg.title} 고치기` : `${cfg.title} 적기`, form);
    };
    const draw = () => {
      const t = stageSum(rows);
      const wait = { checked: t.in - t.checked, packed: t.checked - t.packed, sell: t.packed - t.out };
      const step = (k, sub) => h("button", { type: "button", class: "vol-fg__step" + (filter === k ? " is-on" : ""), onclick: () => { filter = filter === k ? "" : k; draw(); } }, [h("span", { class: "muted small", text: cfg.labels[k] }), h("strong", { text: fmtN(t[k]) }), sub ? h("span", { class: "muted small", text: sub }) : null]);
      const shown = filter ? rows.filter((r) => (r.stage || "in") === filter) : rows;
      fill(box,
        h("div", { class: "card__head" }, [h("h2", { class: "card__title", text: cfg.title }), h("button", { class: "btn btn--primary btn--sm", type: "button", onclick: () => edit(null, filter) }, [icon("plus"), "적기"])]),
        h("div", { class: "vol-fg__flow" }, [
          step("in"), h("span", { class: "vol-fg__arrow", text: "→" }),
          step("checked", `검수 대기 ${fmtN(Math.max(0, wait.checked))}`), h("span", { class: "vol-fg__arrow", text: "→" }),
          step("packed", `패키징 대기 ${fmtN(Math.max(0, wait.packed))}`), h("span", { class: "vol-fg__arrow", text: "→" }),
          step("out")
        ]),
        h("div", { class: "vol-fg__sell" }, [h("span", { text: "바로 판매 가능한 재고 (패키징 완료 − 출고)" }), h("strong", { class: wait.sell < 0 ? "stock-minus" : null, text: fmtN(wait.sell) })]),
        filter ? h("p", { class: "muted small" }, [`'${cfg.labels[filter]}' 기록만 보는 중 · `, h("button", { class: "link-btn", type: "button", text: "전체 보기", onclick: () => { filter = ""; draw(); } })]) : null,
        shown.length ? h("div", { class: "table-wrap" }, h("table", { class: "table" }, [
          h("thead", {}, h("tr", {}, [h("th", { text: "날짜" }), h("th", { text: "단계" }), h("th", { class: "num", text: "수량" }), h("th", { text: "입고·출고 장소 (대상)" }), h("th", { text: "메모" }), h("th", { text: "적은 사람" }), h("th")])),
          h("tbody", {}, shown.map((r) => h("tr", { "data-ref": `fin:${r.id}` }, [
            h("td", { class: "nowrap", text: shortDate(r.date) }), h("td", { class: "nowrap" }, h("span", { class: `vol-fg__tag vol-fg__tag--${r.stage || "in"}`, text: cfg.labels[r.stage || "in"] })), h("td", { class: "num", text: fmtN(r.qty) }),
            h("td", { text: r.name }), h("td", { class: "muted small", text: r.note }), h("td", { class: "muted small", text: r.author }),
            h("td", {}, r.canEdit ? h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "고치기", onclick: () => edit(r) }) : null)
          ])))
        ])) : h("p", { class: "muted", text: "아직 적은 기록이 없어요. '적기'를 눌러 추가해 주세요." }),
        h("p", { class: "muted small", text: "단계마다 처리한 날에 한 줄씩 적어 주세요(예: 11/20 회수 입고 500, 11/22 검수완료 480). 위 단계 칸을 누르면 그 단계 기록만 보여요. 고치기·지우기는 직접 적은 기록만 할 수 있어요." })
      );
    };
    draw();
    return box;
  }
  // 출고 화면의 '자른실 출고': 제작 수도회마다 나간 자른 실(출납 대장)
  function volCutCard(visits) {
    const list = visits.filter((v) => v.threadQty != null).sort((a, b) => a.date.localeCompare(b.date));
    const total = list.reduce((n, v) => n + v.threadQty, 0);
    return h("section", { class: "card vol__card" }, [
      h("div", { class: "card__head" }, [h("h2", { class: "card__title", text: "2) 자른실 출고" }), h("a", { class: "link-btn", href: `#/vp/${VOL_GROUPS[0].key}/req`, text: "고치기" })]),
      h("div", { class: "vol-fg__sell" }, [h("span", { text: `자른실 출고 합계 (제작 수도회 ${list.length}곳)` }), h("strong", { text: fmtN(total) })]),
      list.length ? h("div", { class: "table-wrap" }, h("table", { class: "table" }, [
        h("thead", {}, h("tr", {}, [h("th", { class: "num", text: "번호" }), h("th", { text: "교육일" }), h("th", { text: "제작 수도회" }), h("th", { class: "num", text: "자른실" }), h("th", { class: "num", text: "십자가" })])),
        h("tbody", {}, list.map((v, i) => h("tr", {}, [h("td", { class: "num muted", text: String(i + 1) }), h("td", { class: "nowrap", text: shortDate(v.date) }), h("td", { text: v.title.split(" · ").pop() }), h("td", { class: "num", text: fmtN(v.threadQty) }), h("td", { class: "num", text: v.crossQty != null ? fmtN(v.crossQty) : "-" })]))),
        h("tfoot", {}, h("tr", { class: "vol-more__sum" }, [h("th", { colspan: "3", text: `합계 (${list.length}곳)` }), h("td", { class: "num", text: fmtN(total) }), h("td", { class: "num", text: fmtN(list.reduce((n, v) => n + (v.crossQty || 0), 0)) })]))
      ])) : h("p", { class: "muted", text: "아직 자른실 출고 기록이 없어요." }),
      h("p", { class: "muted small", text: "자른실은 제작 수도회에 보낸 실이에요. '고치기'를 누르면 '추가 전달 물량 › 수량 입력'으로 가요. 관리자뿐 아니라 부서 봉사자도 고칠 수 있고, 고친 사람 이름이 남아요. 위 '1) 실타래 입출고'는 창고의 실타래(타래 단위) 입출고예요." })
    ]);
  }
  async function volRecordCard(itemId, kind) {
    const cfg = VOL_RECORD[kind];
    const box = h("section", { class: "card vol__card vol-rec" });
    let rows = (await api(`/volunteer/records?item=${itemId}&kind=${kind}`)).records;
    const edit = (r) => {
      const err = errorLine();
      const date = h("input", { type: "date", value: r?.date || today(), required: true });
      const name = h("input", { value: r?.name || "", maxlength: "80", placeholder: cfg.namePh, autofocus: true });
      const qty = h("input", { type: "number", min: "0", inputmode: "numeric", value: r ? String(r.qty) : "", required: true });
      const note = h("input", { value: r?.note || "", maxlength: "300" });
      const ok = h("button", { class: "btn btn--primary", type: "submit", text: r ? "저장" : "추가" });
      const form = h("form", { class: "stack" }, [h("div", { class: "row2" }, [field("날짜", date), field(cfg.nameLabel, name)]), h("div", { class: "row2" }, [field("수량", qty), field("메모 (선택)", note)]), err,
        h("div", { class: "actions" }, [r ? h("button", { class: "btn btn--danger-outline btn--sm", type: "button", text: "지우기", onclick: async () => {
          if (!confirm("이 기록을 지울까요?")) return;
          const x = await act(() => apiAsk(`/volunteer/records/${r.id}`, { method: "DELETE" })); if (!x) return; rows = x.records; closeDialog(); draw();
        } }) : null, ok])]);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const body = { itemId, kind, date: date.value, name: name.value, qty: qty.value, note: note.value };
        busy(ok, async () => {
          try { const x = await apiAsk(r ? `/volunteer/records/${r.id}` : "/volunteer/records", { method: r ? "PATCH" : "POST", body }); if (!x) return; rows = x.records; closeDialog(); toast("저장했어요."); draw(); }
          catch (ex) { showError(err, ex.message); }
        });
      });
      openDialog(r ? `${cfg.title} 고치기` : `${cfg.title} 적기`, form);
    };
    const draw = () => fill(box,
      h("div", { class: "card__head" }, [h("h2", { class: "card__title", text: cfg.title }), h("button", { class: "btn btn--primary btn--sm", type: "button", onclick: () => edit(null) }, [icon("plus"), "적기"])]),
      h("div", { class: "vol-visits__sum" }, [h("span", {}, [kind === "material" ? "지금 보유 " : "회수 합계 ", h("strong", { text: fmtN(cfg.total(rows)) })]), rows.length ? h("span", { class: "muted", text: cfg.sub(rows) }) : null]),
      kind === "material" && rows.length ? h("ul", { class: "vol-rec__now" }, latestByName(rows).map((r) => h("li", {}, [h("span", { text: r.name || "(이름 없음)" }), h("strong", { text: fmtN(r.qty) }), h("small", { class: "muted", text: shortDate(r.date) })]))) : null,
      rows.length ? h("div", { class: "table-wrap" }, h("table", { class: "table" }, [
        h("thead", {}, h("tr", {}, [h("th", { text: "날짜" }), h("th", { text: cfg.nameLabel }), h("th", { class: "num", text: "수량" }), h("th", { text: "메모" }), h("th", { text: "적은 사람" }), h("th")])),
        h("tbody", {}, rows.map((r) => h("tr", {}, [
          h("td", { class: "nowrap", text: shortDate(r.date) }), h("td", { text: r.name }), h("td", { class: "num", text: fmtN(r.qty) }), h("td", { class: "muted small", text: r.note }), h("td", { class: "muted small", text: r.author }),
          h("td", {}, r.canEdit ? h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "고치기", onclick: () => edit(r) }) : null)
        ])))
      ])) : h("p", { class: "muted", text: "아직 적은 기록이 없어요. '적기'를 눌러 추가해 주세요." }),
      h("p", { class: "muted small", text: cfg.hint + " 고치기·지우기는 직접 적은 기록만 할 수 있어요." })
    );
    draw();
    return box;
  }
  function volProjects(list) {
    return [
      h("h1", { class: "vol__hello", text: "프로젝트 관리" }),
      list.length ? h("div", { class: "pj-cards" }, list.map((p) => h("a", { class: "card pj-card", href: `#/vprojects/${p.id}` }, [
        h("strong", { text: p.name }),
        h("span", { class: "muted small", text: `항목 ${p.total}개 · 완료 ${p.done}개` })
      ]))) : h("div", { class: "card empty", text: "아직 볼 수 있는 프로젝트가 없어요." })
    ];
  }
  // 방문 일정·수량: 여기서 고친 수량이 달력에 그대로 보임
  // 제목을 누르면 오름차순·내림차순 (같은 제목을 다시 누르면 방향이 바뀜)
  function sortHead(cols, st, onChange) {
    return h("thead", {}, h("tr", {}, cols.map(([key, label, cls, title]) => {
      if (!key) return h("th", { class: cls || null, text: label });
      const on = st.key === key;
      return h("th", { class: (cls || "") + " sort-th", "aria-sort": on ? (st.dir > 0 ? "ascending" : "descending") : "none", title }, h("button", { type: "button", class: "sort-th__btn" + (on ? " is-on" : ""), onclick: () => { if (on) st.dir = -st.dir; else { st.key = key; st.dir = cls === "num" ? -1 : 1; } onChange(); } }, [label, h("span", { class: "sort-th__arrow", "aria-hidden": "true", text: on ? (st.dir > 0 ? "▲" : "▼") : "↕" })]));
    })));
  }
  const sortBy = (list, st, getters) => {
    const g = getters[st.key]; if (!g) return list;
    return [...list].sort((a, b) => {
      const x = g(a), y = g(b);
      if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; // 빈 값은 늘 아래
      return (typeof x === "string" ? x.localeCompare(y, "ko") : x - y) * st.dir || a.date.localeCompare(b.date);
    });
  };
  function volVisits(visits, heading) {
    const box = h("section", { class: "card vol__card vol-visits" });
    let inputOpen = false; // 고친 뒤 다시 그려도 '수량 입력'이 펼친 채로
    const moreSort = { key: "moreT", dir: -1 }, inSort = { key: "date", dir: 1 };
    let qv = "";
    const orgOf = (v) => v.title.split(" · ").pop();
    // 수도회 이름 옆 표시: 네이버폼 신청이 없는 일정, 수업 날짜가 아직 없어 달력에 없는 신청
    const orgTags = (v) => [!v.fromForm ? h("span", { class: "stock-tag vol-visits__tag", title: "네이버폼 수업 신청에 없는 일정", text: "신청서 없음" }) : null, v.tableOnly ? h("span", { class: "stock-tag vol-visits__tag", title: "수업 날짜가 정해지지 않아 달력에는 없어요. 날짜는 신청서의 수업 가능 날짜", text: "달력 미정" }) : null];
    // 합계에서 빼는 줄: 수량은 회색으로 보이고 이유를 붙임
    const noteQtyCell = (v) => h("td", { class: "num muted", title: v.sumNote }, [fmtN(v.noteQty ?? 0), h("small", { class: "vol-visits__by", text: v.sumNote })]);
    const hit = (v) => !qv || `${orgOf(v)} ${v.place || ""}`.toLowerCase().replace(/\s/g, "").includes(qv.toLowerCase().replace(/\s/g, ""));
    const getters = { org: orgOf, date: (v) => v.date, qty: (v) => v.qty, edu: (v) => v.eduQty, thread: (v) => v.threadQty, cross: (v) => v.crossQty, moreT: moreThread, moreC: moreCross, diff: qtyDiff };
    // 검색 칸은 그대로 두고 아래만 다시 그림 (입력 중 커서가 빠지지 않게)
    const search = h("label", { class: "search vol-visits__search" }, [icon("search"), h("input", { type: "search", placeholder: "제작 수도회·장소 검색", "aria-label": "제작 수도회·장소 검색", oninput: (e) => { qv = e.target.value.trim(); draw(); } })]);
    const content = h("div", { class: "stack stack--sm" });
    // 한 칸을 저장한 뒤 다른 수량 칸에 입력 중이면 표를 바로 다시 그리지 않음 (입력 값·커서·휴대폰 키보드가 사라지지 않게).
    // 수량 칸 밖으로 나가면 그때 한 번 다시 그림
    let drawLater = false;
    const typing = () => { const el = document.activeElement; return !!el && el.classList?.contains("vol-visits__qty") && content.contains(el); };
    const redraw = () => { if (typing()) drawLater = true; else { drawLater = false; draw(); } };
    content.addEventListener("focusout", () => setTimeout(() => { if (drawLater && !typing()) { drawLater = false; draw(); } }, 0));
    const draw = () => {
      const sum = (rows, k = "qty") => rows.reduce((n, v) => n + (v[k] || 0), 0);
      const past = visits.filter((v) => v.date < today()), next = visits.filter((v) => v.date >= today());
      const empty = visits.filter((v) => v.qty == null && !v.sumNote).length;
      const whoOf = (v) => (v.note.match(/담당:\s*([^\n]+)/) || [])[1] || "";
      // 칸 하나: 요청수량·교육물량·실·십자가 출고. 고치면 바로 저장, 고친 사람 이름이 남음
      const qtyCell = (v, key, label) => {
        if (key === "qty" && v.sumNote) return noteQtyCell(v);
        const by = key === "qty" ? v.qtyBy : key === "eduQty" ? v.eduBy : v.matBy, at = key === "qty" ? v.qtyAt : key === "eduQty" ? v.eduAt : v.matAt;
        const input = h("input", { type: "number", min: "0", inputmode: "numeric", class: "vol-visits__qty", value: v[key] ?? "", "aria-label": `${orgOf(v)} ${label}`, placeholder: "-" });
        input.addEventListener("change", async () => {
          try {
            const r = await api(`/volunteer/schedules/${v.id}/qty`, { method: "PATCH", body: { [key]: input.value } });
            Object.assign(v, r.schedule); toast(`${label}을 저장했어요.`); redraw();
          } catch (ex) { toast(ex.message); input.value = v[key] ?? ""; }
        });
        return h("td", { class: "num" }, [input, by ? h("small", { class: "vol-visits__by muted", title: at || "", text: by }) : null]);
      };
      const shown = visits.filter(hit);
      const row = (v, i) => h("tr", { class: v.date < today() ? "is-past" : null, "data-ref": `req:${v.id}` }, [
        h("td", { class: "num muted", text: String(i + 1) }),
        h("td", { class: "nowrap" }, [volDay(v.date), v.startTime ? h("small", { class: "muted", text: ` ${v.startTime}` }) : null]),
        h("td", {}, [h("span", { text: orgOf(v) }), v.place ? h("small", { class: "muted", text: ` · ${v.place}` }) : null, ...orgTags(v), whoOf(v) ? h("small", { class: "vol-visits__who muted", text: whoOf(v) }) : null]),
        qtyCell(v, "qty", "요청수량"),
        qtyCell(v, "eduQty", "교육물량"),
        qtyCell(v, "threadQty", "실 출고"),
        qtyCell(v, "crossQty", "십자가 출고"),
        h("td", { class: "num nowrap " + diffCls(qtyDiff(v)), text: diffText(qtyDiff(v)) })
      ]);
      const big = (label, value, sub) => h("div", { class: "vol-visits__big" }, [h("span", { class: "muted small", text: label }), h("strong", { text: value }), sub ? h("span", { class: "muted small", text: sub }) : null]);
      const calc = visits.filter((v) => moreThread(v) != null || moreCross(v) != null);
      const tSum = calc.reduce((n, v) => n + Math.max(0, moreThread(v) || 0), 0), cSum = calc.reduce((n, v) => n + Math.max(0, moreCross(v) || 0), 0);
      const need = calc.filter((v) => (moreThread(v) || 0) > 0 || (moreCross(v) || 0) > 0);
      const noRec = visits.filter((v) => v.qty != null && v.threadQty == null && v.crossQty == null);
      const cell = (d) => h("td", { class: "num nowrap " + (d == null ? "muted" : d > 0 ? "qty-diff is-need" : d < 0 ? "qty-diff is-over" : "qty-diff is-done"), text: d == null ? "-" : d > 0 ? fmtN(d) : d < 0 ? `−${fmtN(-d)} (더 보냄)` : "완료" });
      const moreRows = sortBy(shown, moreSort, getters);
      const inRows = sortBy(shown, inSort, getters);
      fill(content,
        h("div", { class: "vol-visits__bigs" }, [
          big("추가 전달할 실", fmtN(tSum), "요청수량 − 실 출고 합계"),
          big("추가 전달할 십자가", fmtN(cSum), "요청수량 − 십자가 출고 합계"),
          big("더 보내야 할 제작 수도회", `${need.length}곳`, `계산된 ${calc.length}곳 중 · 출고 기록 없음 ${noRec.length}곳`)
        ]),
        qv ? h("p", { class: "muted small", text: `'${qv}' 검색: ${shown.length}곳` }) : null,
        shown.length ? h("div", { class: "table-wrap" }, h("table", { class: "table vol-more__table" }, [
          sortHead([[null, "번호", "num"], ["org", "제작 수도회"], ["date", "교육일"], ["qty", "요청수량", "num"], ["thread", "실 출고", "num"], ["cross", "십자가 출고", "num"], ["moreT", "추가 전달 실", "num", "요청수량 − 실 출고"], ["moreC", "추가 전달 십자가", "num", "요청수량 − 십자가 출고"]], moreSort, draw),
          h("tbody", {}, moreRows.map((v, i) => h("tr", { class: v.qty == null && !v.sumNote ? "is-past" : null }, [
            h("td", { class: "num muted", text: String(i + 1) }),
            h("td", {}, [h("span", { text: orgOf(v) }), v.place ? h("small", { class: "muted", text: ` · ${v.place}` }) : null, ...orgTags(v)]),
            h("td", { class: "nowrap", text: shortDate(v.date) }),
            v.sumNote ? noteQtyCell(v) : h("td", { class: "num", text: v.qty != null ? fmtN(v.qty) : "-" }),
            h("td", { class: "num", text: v.threadQty != null ? fmtN(v.threadQty) : "-" }),
            h("td", { class: "num", text: v.crossQty != null ? fmtN(v.crossQty) : "-" }),
            cell(moreThread(v)), cell(moreCross(v))
          ]))),
          // 합계: 지금 보이는 곳(검색 반영) 기준. 추가 전달은 더 보낼 양(+)만 더함
          h("tfoot", {}, h("tr", { class: "vol-more__sum" }, [
            h("th", { colspan: "3", text: qv ? `합계 (검색 ${shown.length}곳)` : `합계 (${shown.length}곳)` }),
            h("td", { class: "num", text: fmtN(sum(shown)) }),
            h("td", { class: "num", text: fmtN(sum(shown, "threadQty")) }),
            h("td", { class: "num", text: fmtN(sum(shown, "crossQty")) }),
            h("td", { class: "num", text: fmtN(shown.reduce((n, v) => n + Math.max(0, moreThread(v) || 0), 0)) }),
            h("td", { class: "num", text: fmtN(shown.reduce((n, v) => n + Math.max(0, moreCross(v) || 0), 0)) })
          ]))
        ])) : h("p", { class: "muted", text: "찾는 제작 수도회가 없어요." }),
        h("p", { class: "muted small", text: "제목을 누르면 오름차순·내림차순으로 바뀌어요. 추가 전달 물량 = 요청수량 − 실(십자가) 출고이고, 값이 없으면 '-'로 보여요. 아래 '수량 입력'에서 고치면 바로 다시 계산돼요." }),
        h("details", { class: "vstat__more vol-visits__input", open: inputOpen, ontoggle: (e) => { inputOpen = e.currentTarget.open; } }, [h("summary", {}, `수량 입력 · 요청 · 교육 · 출고 (${shown.length}곳)`),
          h("div", { class: "vol-visits__bigs" }, [
            big("총 제작 수도회", `${visits.length}곳`, empty ? `요청수량 없음 ${empty}곳` : null),
            big("총 요청수량", fmtN(sum(visits)), `지난 교육 ${fmtN(sum(past))} · 다가오는 교육 ${fmtN(sum(next))}`),
            big("총 교육물량", fmtN(sum(visits, "eduQty")), `적은 곳 ${visits.filter((v) => v.eduQty != null).length}곳`),
            big("실 · 십자가 출고", `${fmtN(sum(visits, "threadQty"))} · ${fmtN(sum(visits, "crossQty"))}`, "출납 대장 기준"),
            (() => { const both = visits.filter((v) => qtyDiff(v) != null), d = both.reduce((n, v) => n + qtyDiff(v), 0); return big("차액 (요청 − 교육)", diffText(both.length ? d : null), `둘 다 적힌 곳 ${both.length}곳 · 덜 전달 ${both.filter((v) => qtyDiff(v) > 0).length} · 더 전달 ${both.filter((v) => qtyDiff(v) < 0).length}`); })()
          ]),
          h("div", { class: "table-wrap" }, h("table", { class: "table vol-visits__table" }, [
            sortHead([[null, "번호", "num"], ["date", "날짜"], ["org", "제작 수도회"], ["qty", "요청수량", "num"], ["edu", "교육물량", "num"], ["thread", "실 출고", "num", "출납 대장의 자른 실"], ["cross", "십자가 출고", "num"], ["diff", "차액", "num", "요청수량 − 교육물량 (둘 다 있는 곳만)"]], inSort, draw),
            h("tbody", {}, inRows.map(row)),
            h("tfoot", {}, h("tr", { class: "vol-more__sum" }, [
              h("th", { colspan: "3", text: `합계 (${shown.length}곳)` }),
              h("td", { class: "num", text: fmtN(sum(shown)) }), h("td", { class: "num", text: fmtN(sum(shown, "eduQty")) }),
              h("td", { class: "num", text: fmtN(sum(shown, "threadQty")) }), h("td", { class: "num", text: fmtN(sum(shown, "crossQty")) }),
              (() => { const both = shown.filter((v) => qtyDiff(v) != null); const d = both.reduce((n, v) => n + qtyDiff(v), 0); return h("td", { class: "num nowrap " + diffCls(both.length ? d : null), text: diffText(both.length ? d : null) }); })()
            ]))
          ])),
          h("p", { class: "muted small", text: "요청수량·교육물량·실·십자가 출고를 고치면 바로 저장되고, 고친 사람 이름이 함께 남아요. 차액은 요청수량 − 교육물량이에요(+는 덜 전달, −는 더 전달)." })
        ])
      );
    };
    fill(box,
      h("div", { class: "card__head" }, [h("h2", { class: "card__title", text: heading || "일정 관리" }), h("span", { class: "muted small", text: "제작 수도회 · 수량" }), stepsOn() ? null : h("a", { class: "link-btn", href: "#/vschedule", text: "달력 보기" })]),
      visits.length ? search : null,
      visits.length ? content : h("p", { class: "muted", text: "아직 연결된 제작 수도회 일정이 없어요." })
    );
    if (visits.length) draw();
    return box;
  }
  // 대장마다 입출고 기록 (입고·출고 칸에 최근 기록을 보여 주려고)
  const volLedgerDetails = (ls) => Promise.all(ls.map((l) => api(`/volunteer/stock/${l.id}`).catch(() => null)));
  // WBS: 관리자 상세 프로세스와 같은 모양의 틀 (항목은 준비 중)
  function volWbs(project, visits) {
    const DAY = 86400000, WEEK_W = 24, t = today();
    const dates = [t, ...visits.map((v) => v.date)].sort();
    const mondayOf = (s) => { const d = parseYmd(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; };
    const from = mondayOf(dates[0]);
    const last = dates[dates.length - 1] > shiftYmd(t, 90) ? dates[dates.length - 1] : shiftYmd(t, 90);
    const to = mondayOf(last); to.setDate(to.getDate() + 7);
    const dayX = (s) => Math.round((parseYmd(s) - from) / DAY) * (WEEK_W / 7);
    const width = (Math.round((to - from) / DAY) / 7) * WEEK_W;
    const months = [];
    for (const d = new Date(from.getFullYear(), from.getMonth(), 1); d < to; d.setMonth(d.getMonth() + 1)) {
      months.push(h("span", { class: "gantt__month", style: `left:${Math.max(0, dayX(ymd(d)))}px`, text: `${String(d.getFullYear()).slice(2)}.${pad(d.getMonth() + 1)}` }));
    }
    const todayLine = () => h("i", { class: "gantt__today", style: `left:${dayX(t)}px`, title: `오늘 ${t}` });
    const row = (level, code, name, sub) => h("div", { class: `gantt__row wbs-row wbs-row--${level}`, role: "row" }, [
      h("div", { class: "gantt__name wbs__name", style: `padding-left:${8 + level * 12}px` }, [
        h("span", { class: "wbs__chev" + (level === 0 ? " is-open" : ""), html: level === 0 ? ICON.right : "" }),
        h("span", { class: "wbs__code", text: code }),
        h("span", { class: "wbs__label" }, [h("span", { text: name }), sub ? h("small", { class: "muted", text: sub }) : null]),
        h("span", { class: "wbs__pct muted", text: level === 0 ? "0%" : "-" })
      ]),
      h("div", { class: "gantt__track", style: `width:${width}px` }, todayLine())
    ]);
    const scroller = h("div", { class: "gantt vol-wbs__chart", role: "table" }, [
      h("div", { class: "gantt__row gantt__row--head" }, [h("div", { class: "gantt__name gantt__name--head wbs__name" }, [h("span", { class: "wbs__chev" }), h("span", { class: "wbs__code", text: "WBS" }), h("span", { class: "wbs__label", text: "작업" }), h("span", { class: "wbs__pct", text: "진척" })]), h("div", { class: "gantt__track", style: `width:${width}px` }, [...months, todayLine()])]),
      row(0, "1", project.name),
      row(1, "1.1", "단계", "준비 중")
    ]);
    requestAnimationFrame(() => { scroller.scrollLeft = Math.max(0, dayX(t) - 120); });
    return h("section", { class: "card vol__card vol-wbs" }, [
      h("div", { class: "card__head" }, [h("h2", { class: "card__title", text: "WBS" }), h("span", { class: "muted small", text: "진행 현황" })]),
      scroller,
      h("div", { class: "gantt__legend muted small" }, [["done", "완료"], ["doing", "진행"], ["todo", "예정"], ["hold", "보류"], ["late", "일정 지남"]].map(([k, t2]) => h("span", {}, [h("i", { class: `proc-bar--${k}` }), t2]))),
      h("p", { class: "muted small", text: "WBS 항목은 준비 중이에요. 단계와 일정이 정해지면 여기에 진행 상황이 보여요." })
    ]);
  }
  // 입고 칸·출고 칸: 대장마다 합계, 최근 기록, 입력 버튼
  function volMoveCard(type, ledgers, details) {
    const label = type === "in" ? "입고" : "출고";
    const sumOf = (m) => Object.values(m.qty || {}).reduce((n, v) => n + (Number(v) || 0), 0);
    return h("section", { class: `card vol__card vol-moves vol-moves--${type}` }, [
      h("div", { class: "card__head" }, [h("h2", { class: "card__title", text: label }), h("a", { class: "link-btn", href: "#/vstock", text: "전체 보기" })]),
      ledgers.length ? h("div", { class: "stack stack--sm" }, ledgers.map((l, i) => {
        const moves = ((details && details[i]?.moves) || []).filter((m) => m.type === type).sort((a, b) => (a.date < b.date ? 1 : -1));
        return h("div", { class: "vol-moves__ledger" }, [
          h("div", { class: "vol-moves__head" }, [
            h("a", { href: `#/vstock/${l.id}` }, h("strong", { text: l.name })),
            h("span", { class: "muted small", text: `${label} 합계 ${fmtN(type === "in" ? l.inTotal : l.outTotal)} ${l.unit} · 재고 ${fmtN(l.inTotal - l.outTotal)}` }),
            h("a", { class: "btn btn--primary btn--sm", href: `#/vstock/${l.id}/${type}`, "aria-label": `${l.name} ${label} 입력`, text: `${label} 입력` })
          ]),
          moves.length ? h("ul", { class: "vol-moves__list" }, moves.slice(0, 5).map((m) => h("li", {}, [
            h("span", { class: "nowrap", text: m.date ? shortDate(m.date) : "-" }),
            h("strong", { class: "num", text: `${fmtN(sumOf(m))} ${l.unit}` }),
            h("span", { class: "muted small", text: [m.handler, m.note].filter(Boolean).join(" · ") }),
            m.photos?.length ? h("span", { class: "muted small", text: `사진 ${m.photos.length}` }) : null,
            m.inspectBad ? h("span", { class: "move-issue small", text: `불량 ${fmtN(m.inspectBad)}` }) : null,
            m.issue ? h("span", { class: "move-issue small", title: m.issue, text: "이슈 있음" }) : null,
            h("a", { class: "link-btn small vol-moves__edit", href: `#/vstock/${l.id}/edit/${m.id}`, "aria-label": `${m.date} ${label} 고치기`, text: "고치기" })
          ]))) : h("p", { class: "muted small", text: `아직 ${label} 기록이 없어요.` }),
          moves.length > 5 ? h("a", { class: "link-btn small", href: `#/vstock/${l.id}`, text: `${label} 기록 ${moves.length}건 모두 보기` }) : null
        ]);
      })) : h("p", { class: "muted", text: "아직 입력할 수 있는 대장이 없어요." })
    ]);
  }
  // ---- 새 입고·출고 화면 (휴대폰 기준). 관리자가 '메뉴 공개'에서 '새 입고·출고 화면'을 켜면 봉사자에게 보임
  // 데이터·API 는 그대로: /volunteer/stock/:id, .../moves, /volunteer/stock-moves/:id, .../photos
  const vmPhotoCache = new Map();
  const vmPhotoSrc = (pid) => { if (!vmPhotoCache.has(pid)) vmPhotoCache.set(pid, fetch(API + `/volunteer/stock-photos/${pid}`, { headers: { Authorization: "Bearer " + state.token } }).then((r) => (r.ok ? r.blob() : null)).then((b) => (b ? URL.createObjectURL(b) : null)).catch(() => null)); return vmPhotoCache.get(pid); };
  // 품목 색 동그라미 (색만으로 구분하지 않게 이름과 함께 씀, 색이 없는 품목은 안 보임)
  const optDot = (o, big) => (o.color ? h("i", { class: "opt-dot" + (big ? " opt-dot--big" : ""), style: `background:${o.color}`, "aria-hidden": "true" }) : null);
  const vmPhotoImg = (pid) => { const img = h("img", { class: "move-photo", alt: "기록 사진" }); vmPhotoSrc(pid).then((u) => { if (u) img.src = u; }); return img; };
  const vmSum = (m) => Object.values(m.qty || {}).reduce((n, v) => n + (Number(v) || 0), 0);
  const vmDay = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) ? volDay(s) : String(s || "-"));
  const VM_PAGE = 10, VM_PHOTO_MAX = 4;
  // type: "in"|"out". opts: ledgerId(처음 고를 대장) · data(미리 받은 대장) · editId(바로 고칠 기록) · openNew(바로 적기) · cut(묵주 자른실 출고 일정) · switchable(입고·출고 전환) · isCurrent
  function volMovesPage(type, ledgers, opts = {}) {
    const box = h("div", { class: "vm" });
    let lid = opts.ledgerId && ledgers.some((l) => l.id === opts.ledgerId) ? opts.ledgerId : Number(store.get("ps.vmLedger", 0));
    if (!ledgers.some((l) => l.id === lid)) lid = ledgers[0]?.id || null;
    let data = opts.data && opts.data.ledger?.id === lid ? opts.data : null, shown = VM_PAGE, flash = null, part = "moves";
    const label = () => (type === "in" ? "입고" : "출고");
    const sumType = (t, oid) => (data?.moves || []).filter((m) => m.type === t).reduce((n, m) => n + (oid ? Number(m.qty[oid]) || 0 : vmSum(m)), 0);
    const leftOf = (oid) => sumType("in", oid) - sumType("out", oid);
    const load = async () => { try { data = lid ? await api(`/volunteer/stock/${lid}`) : null; } catch (e) { if (e.status !== 401) box.replaceChildren(failed(e)); throw e; } };
    const apply = (r) => { data = r; draw(); };
    const tabs = (list, cur, pick) => h("div", { class: "vm-seg", role: "tablist" }, list.map(([k, t]) => h("button", { type: "button", role: "tab", "aria-selected": String(k === cur), text: t, onclick: () => pick(k) })));
    function draw() {
      const kids = [];
      if (opts.switchable) kids.push(tabs([["in", "입고"], ["out", "출고"]], type, (k) => { type = k; shown = VM_PAGE; draw(); }));
      if (opts.cut) {
        kids.push(tabs([["moves", "실타래 출고"], ["cut", "자른실 출고"]], part, (k) => { part = k; draw(); }));
        kids.push(h("p", { class: "muted small vm-note", text: "두 기록은 서로 연결되지 않아요. 실타래가 창고에서 나갔으면 '실타래 출고'에도 적어 주세요." }));
        if (part === "cut") {
          const cut = volCutCard(opts.cut);
          const t = cut.querySelector(".card__title"); if (t) t.textContent = "자른실 출고";
          for (const p of cut.querySelectorAll("p.muted")) if (p.textContent.includes("1) 실타래 입출고")) p.textContent = "자른실은 제작 수도회에 보낸 실이에요. '고치기'를 누르면 '추가 전달 물량 › 수량 입력'으로 가요. 관리자뿐 아니라 부서 봉사자도 고칠 수 있고, 고친 사람 이름이 남아요. 창고의 실타래(타래 단위)는 '실타래 출고' 탭에 적어요.";
          kids.push(cut); return box.replaceChildren(...kids);
        }
      }
      if (!ledgers.length) { kids.push(h("div", { class: "card empty", text: "아직 입력할 수 있는 대장이 없어요. 관리자에게 문의해 주세요." })); return box.replaceChildren(...kids); }
      if (ledgers.length > 1) {
        const sel = h("select", { "aria-label": "대장 고르기", onchange: () => { lid = Number(sel.value); store.set("ps.vmLedger", String(lid)); data = null; shown = VM_PAGE; draw(); load().then(draw, () => {}); } }, ledgers.map((l) => h("option", { value: String(l.id), text: l.name })));
        sel.value = String(lid);
        kids.push(h("label", { class: "vm-pick" }, [h("span", { class: "muted small", text: "대장" }), sel]));
      }
      if (!data) { kids.push(loading()); return box.replaceChildren(...kids); }
      const { ledger: l, options, moves } = data;
      const unit = l.unit;
      const list = moves.filter((m) => m.type === type).sort((a, b) => (a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1));
      const month = today().slice(0, 7);
      const stock = sumType("in") - sumType("out");
      const stat = (t, n, warn) => h("div", { class: "vm-stat" + (warn ? " is-warn" : "") }, [h("span", { text: t }), h("strong", { text: fmtN(n) }), h("small", { text: unit })]);
      kids.push(h("section", { class: "card vm-sum" }, [
        h("h2", { class: "vm-sum__name", text: l.name }),
        h("div", { class: "vm-stats" }, [stat(`${label()} 합계`, sumType(type)), stat("재고", stock, stock < 0), stat(`이번 달 ${label()}`, list.filter((m) => String(m.date).startsWith(month)).reduce((n, m) => n + vmSum(m), 0))]),
        options.length ? h("details", { class: "vm-opts vm-opts--gallery", open: store.get("ps.vmOpts", "0") === "1", ontoggle: (e) => store.set("ps.vmOpts", e.currentTarget.open ? "1" : "0") }, [
          h("summary", {}, [icon("grid"), h("span", { text: "품목별 재고 현황 확인하기" }), h("span", { class: "muted small vm-opts__n", text: `${options.length}가지` })]),
          h("ul", { class: "opt-gallery" }, options.map((o) => h("li", { class: "opt-card" }, [
            h("span", { class: "opt-card__top" }, [h("span", { class: "opt-card__name" }, [o.name, optDot(o, true)]), h("strong", { class: leftOf(o.id) < 0 ? "stock-minus" : null, text: `${fmtN(leftOf(o.id))}${unit}` })]),
            h("span", { class: "opt-card__sub", text: `입고 ${fmtN(sumType("in", o.id))} | 출고 ${fmtN(sumType("out", o.id))}` })])))
        ]) : h("p", { class: "muted small", text: "아직 품목이 없어요. 관리자에게 문의해 주세요." })
      ]));
      const card = (m) => {
        const parts = options.filter((o) => Number(m.qty[o.id])).map((o) => `${o.name} ${fmtN(m.qty[o.id])}`).join(" · ");
        const tags = [
          type === "out" && m.handler ? h("span", { class: "vm-tag", text: `전달 ${m.handler}` }) : null,
          m.refType ? h("span", { class: "vm-tag", text: REF_LABEL[m.refType] || "연결된 기록" }) : null,
          m.mine ? h("span", { class: "vm-tag is-mine", text: "내 기록" }) : null,
          m.photos?.length ? h("span", { class: "vm-tag", text: `사진 ${m.photos.length}` }) : null,
          m.inspectBad ? h("span", { class: "vm-tag is-bad", text: `불량 ${fmtN(m.inspectBad)}` }) : null,
          m.issue ? h("span", { class: "vm-tag is-bad", text: "이슈 있음" }) : null
        ].filter(Boolean);
        return h("li", {}, h("button", { type: "button", class: "vm-card" + (m.id === flash ? " is-new" : ""), "aria-label": `${vmDay(m.date)} ${label()} ${fmtN(vmSum(m))}${unit} 고치기`, onclick: () => sheet(m) }, [
          h("span", { class: "vm-card__top" }, [h("strong", { class: "vm-card__date", text: vmDay(m.date) }), h("strong", { class: "vm-card__qty", text: `${fmtN(vmSum(m))} ${unit}` })]),
          parts ? h("span", { class: "vm-card__parts small", text: parts }) : null,
          tags.length ? h("span", { class: "vm-card__tags" }, tags) : null,
          m.note ? h("span", { class: "vm-card__note small", text: m.note }) : null,
        ]));
      };
      kids.push(h("section", { class: "vm-records" }, [
        h("div", { class: "vm-head" }, [h("h2", { text: `${label()} 기록 ${list.length}건` }),
          h("button", { class: `btn btn--primary vm-add vm-add--${type}`, type: "button", onclick: () => sheet(null) }, [icon("plus"), `${label()} 적기`])]),
        list.length ? h("ul", { class: "vm-list" }, list.slice(0, shown).map(card)) : h("div", { class: "card empty", text: `아직 ${label()} 기록이 없어요. 아래 '${label()} 적기'를 눌러 첫 기록을 남겨 주세요.` }),
        list.length > shown ? h("button", { class: "btn btn--ghost vm-more", type: "button", text: `더 보기 (${list.length - shown}건 남음)`, onclick: () => { shown += VM_PAGE; draw(); } }) : null,
        list.length ? h("p", { class: "muted small", text: "기록을 누르면 고치거나 지울 수 있어요 (실자르기·구매처럼 다른 화면에서 생긴 기록은 보기만 해요). 누가 언제 고쳤는지 직원 화면에 남아요." }) : null
      ]));
      box.replaceChildren(...kids);
    }
    // 입력 판: 휴대폰에서는 아래에서 올라오는 판, PC 에서는 가운데 창 (대화상자 하나를 같이 씀)
    function sheet(m) {
      if (m?.refType && m.refType !== "purchase") return refMoveInfo(m, data, vmPhotoImg);
      const lock = !!m?.refType; // 구매 입고: 날짜·수량은 못 고침
      const { ledger: l, options } = data;
      const t = type, lab = label(), unit = l.unit;
      const err = errorLine();
      const date = h("input", { type: "date", value: m?.date || today(), "aria-label": `${lab}일` });
      const handler = h("input", { value: m?.handler ?? (t === "out" ? state.user.name : ""), maxlength: "40" });
      const note = h("textarea", { rows: "2", maxlength: "500" }, m?.note || "");
      const issue = h("textarea", { rows: "2", maxlength: "500", placeholder: "예: 10개 중 2개 불량, 박스 파손, 수량 부족" }, m?.issue || "");
      const insOk = h("input", { type: "number", min: "0", inputmode: "numeric", value: m?.inspectOk ?? "" });
      const insBad = h("input", { type: "number", min: "0", inputmode: "numeric", value: m?.inspectBad ?? "" });
      const qtyOf = (mv, oid) => Number(mv.qty[oid]) || 0;
      const leftWithout = (oid) => data.moves.reduce((n, x) => (m && x.id === m.id ? n : n + (x.type === "in" ? qtyOf(x, oid) : -qtyOf(x, oid))), 0);
      const rows = options.map((o) => {
        const inp = h("input", { type: "number", min: "0", inputmode: "numeric", placeholder: "0", value: m?.qty[o.id] || "", "aria-label": `${o.name} 수량`, oninput: () => upd() });
        const warn = h("span", { class: "vm-row__warn", hidden: true });
        const step = (d) => { const v = Math.max(0, (Number(inp.value) || 0) + d); inp.value = v ? String(v) : ""; upd(); };
        return { o, inp, warn, el: h("div", { class: "vm-row" }, [
          h("div", { class: "vm-row__name" }, [h("strong", { class: "opt-name" }, [optDot(o), o.name]), h("span", { class: "muted small", text: `재고 ${fmtN(leftWithout(o.id))}` }), warn]),
          h("div", { class: "vm-step" }, [h("button", { type: "button", class: "vm-step__btn", "aria-label": `${o.name} 1 빼기`, text: "−", onclick: () => step(-1) }), inp, h("button", { type: "button", class: "vm-step__btn", "aria-label": `${o.name} 1 더하기`, text: "+", onclick: () => step(1) })])
        ]) };
      });
      // 사진: 고르면 바로 줄여 두고, 저장할 때 올림. 새 기록은 1장 이상
      const needPhoto = !m;
      const pending = [];
      let kept = m ? [...m.photos] : [], savedId = null;
      const photoBox = h("div", { class: "move-photos" });
      const pickers = ["camera", "album"].map((k) => h("input", { type: "file", accept: "image/*", hidden: true, multiple: k === "album", ...(k === "camera" ? { capture: "environment" } : {}) }));
      const photoBtns = h("div", { class: "vm-photo-btns" }, [
        h("button", { class: "btn btn--ghost", type: "button", onclick: () => pickers[0].click() }, [icon("plus"), "사진 찍기"]),
        h("button", { class: "btn btn--ghost", type: "button", onclick: () => pickers[1].click() }, [icon("note"), "앨범에서 고르기"]), ...pickers]);
      const photoHint = h("small", { class: "muted" });
      const drawPhotos = () => {
        photoBox.replaceChildren(
          ...kept.map((pid) => h("span", { class: "move-photos__item" }, [
            h("a", { href: "#", "aria-label": "사진 크게 보기", onclick: (e) => { e.preventDefault(); vmPhotoSrc(pid).then((u) => { if (u) window.open(u, "_blank", "noopener"); }); } }, vmPhotoImg(pid)),
            h("button", { class: "move-photos__x", type: "button", "aria-label": "사진 지우기", html: ICON.close, onclick: async () => {
              if (!confirm("이 사진을 지울까요?")) return;
              const r = await act(() => api(`/volunteer/stock-photos/${pid}`, { method: "DELETE" }));
              kept = kept.filter((x) => x !== pid); apply(r); drawPhotos();
            } })])),
          ...pending.map((b, i) => h("span", { class: "move-photos__item is-new" }, [h("img", { class: "move-photo", alt: "올릴 사진", src: URL.createObjectURL(b) }), h("button", { class: "move-photos__x", type: "button", "aria-label": "고른 사진 빼기", html: ICON.close, onclick: () => { pending.splice(i, 1); drawPhotos(); } })]))
        );
        photoBtns.hidden = kept.length + pending.length >= VM_PHOTO_MAX;
        photoHint.textContent = photoBtns.hidden ? `사진은 ${VM_PHOTO_MAX}장까지예요.` : `${VM_PHOTO_MAX}장까지, 올릴 때 자동으로 작게 줄여요.`;
        upd();
      };
      for (const fin of pickers) fin.addEventListener("change", async () => {
        const files = [...fin.files]; fin.value = "";
        for (const f of files) {
          if (kept.length + pending.length >= VM_PHOTO_MAX) { showError(err, `사진은 ${VM_PHOTO_MAX}장까지 올릴 수 있어요.`); break; }
          try { pending.push(await shrinkImage(f)); showError(err, ""); } catch (ex) { showError(err, ex.message); }
        }
        drawPhotos();
      });
      const sumLine = h("p", { class: "vm-foot__sum" });
      const total = h("p", { class: "vm-total" });
      function upd() {
        const n = rows.reduce((s, x) => s + (Number(x.inp.value) || 0), 0);
        for (const x of rows) {
          const over = t === "out" ? (Number(x.inp.value) || 0) - leftWithout(x.o.id) : 0;
          x.warn.hidden = over <= 0; x.warn.textContent = over > 0 ? `재고보다 ${fmtN(over)}${unit} 많아요` : "";
        }
        const photos = kept.length + pending.length;
        total.textContent = `합계 ${fmtN(n)} ${unit}`;
        sumLine.replaceChildren(`합계 ${fmtN(n)} ${unit} · `, h("span", { class: needPhoto && !photos ? "is-bad" : null, text: needPhoto && !photos ? "사진 0장 (1장 이상 필요)" : `사진 ${photos}장` }));
      }
      const ok = h("button", { class: "btn btn--primary", type: "submit", text: m ? "저장하기" : `${lab} 저장하기` });
      if (lock) { for (const el of [date, handler]) el.disabled = true; for (const x of rows) for (const el of x.el.querySelectorAll("input, button")) el.disabled = true; }
      const form = h("form", { class: "vm-form", novalidate: true }, [
        lock ? h("p", { class: "ref-guide small", text: m.guide }) : null,
        h("div", { class: "row2" }, [field(`${lab}일`, date), t === "out" ? field("전달자", handler) : null]),
        h("div", { class: "field" }, [h("span", { class: "field__label", text: "수량" }),
          rows.length ? h("div", { class: "vm-rows" }, rows.map((x) => x.el)) : h("p", { class: "muted small", text: "아직 품목이 없어요. 관리자에게 문의해 주세요." }), total]),
        h("div", { class: "field" }, [h("span", { class: "field__label" }, [t === "in" ? "영수증·사진" : "출고 사진", needPhoto ? h("span", { class: "vm-need", text: " (1장 이상 필요)" }) : " (선택)"]), photoBox, photoBtns, photoHint]),
        h("section", { class: "vm-extra vm-extra--open" }, [h("h3", { class: "vm-extra__title", text: t === "in" ? "검수 · 비고 · 이슈 (선택)" : "비고 · 이슈 (선택)" }), h("div", { class: "stack" }, [
          t === "in" ? h("div", { class: "row2" }, [field("검수 합격", insOk), field("검수 불량", insBad, "불량이 있으면 이슈에도 적어 주세요.")]) : null,
          field("비고", note),
          field("이슈 (문제가 된 점)", issue, "이 날짜·물량에 문제가 있었으면 적어 주세요.")
        ])]),
        h("div", { class: "vm-foot" }, [err, sumLine, h("div", { class: "vm-foot__btns" }, [
          m && !lock ? h("button", { class: "btn btn--danger-outline", type: "button", text: "지우기", onclick: async () => {
            if (!confirm(`${vmDay(m.date)} ${lab} 기록을 지울까요? 사진도 함께 지워져요.`)) return;
            const r = await act(() => apiAsk(`/volunteer/stock-moves/${m.id}`, { method: "DELETE" }));
            if (!r) return;
            closeDialog(); apply(r); toast(`${lab} 기록을 지웠어요.`);
          } }) : null, ok])])
      ]);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        busy(ok, async () => {
          try {
            if (!date.value) return showError(err, "날짜를 골라 주세요.");
            if (!rows.some((x) => Number(x.inp.value) > 0)) return showError(err, "수량을 하나 이상 적어 주세요.");
            const over = t === "out" ? rows.filter((x) => Number(x.inp.value) > leftWithout(x.o.id)) : [];
            if (over.length && !confirm(`재고보다 많이 출고해요: ${over.map((x) => `${x.o.name} (재고 ${fmtN(leftWithout(x.o.id))})`).join(", ")}\n그래도 저장할까요?`)) return;
            if (needPhoto && !savedId && !pending.length) return showError(err, t === "in" ? "영수증이나 사진을 1장 이상 올려 주세요." : "출고 사진을 1장 이상 올려 주세요.");
            const qty = Object.fromEntries(rows.map((x) => [x.o.id, x.inp.value]));
            const body = { date: date.value, handler: handler.value, note: note.value, issue: issue.value, qty, ...(t === "in" ? { inspectOk: insOk.value, inspectBad: insBad.value } : {}) };
            // 기록이 한 번 저장되면 (사진 올리기가 실패해도) 다시 누를 때는 기록을 또 만들지 않고 사진만 올림
            let r = savedId ? null : await apiAsk(m ? `/volunteer/stock-moves/${m.id}` : `/volunteer/stock/${l.id}/moves`, { method: m ? "PATCH" : "POST", body: m ? { ...body, ...(over.length ? { confirmed: true } : {}) } : { ...body, type: t } });
            if (!savedId && !r) return;
            if (r) { savedId = m ? m.id : r.newMoveId; data = r; }
            while (pending.length) {
              try { r = await api(`/volunteer/stock-moves/${savedId}/photos`, { method: "POST", body: { data: await blobToBase64(pending[0]) } }); }
              catch (ex) { drawPhotos(); draw(); return showError(err, `기록은 저장했어요. 사진을 올리지 못했어요: ${ex.message} 다시 '${ok.textContent}'를 누르면 남은 사진만 올려요.`); }
              pending.shift(); data = r;
            }
            closeDialog();
            flash = savedId; draw();
            toast(m ? `${lab} 기록을 고쳤어요.` : `${lab}를 저장했어요.`);
            box.querySelector(".vm-card.is-new")?.scrollIntoView({ block: "center", behavior: "smooth" });
          } catch (ex) { showError(err, ex.message); }
        });
      });
      drawPhotos();
      openDialog(`${lab} ${m ? "고치기" : "적기"} · ${l.name}`, form, { tone: t });
    }
    const start = () => {
      draw();
      if (opts.isCurrent && !opts.isCurrent()) return;
      const em = opts.editId && data?.moves.find((x) => x.id === opts.editId);
      if (opts.editId && !em) toast("그 기록을 찾을 수 없어요. 이미 지워졌을 수 있어요.");
      if (em) sheet(em); else if (opts.openNew && data) sheet(null);
    };
    if (data || !lid) start(); else { draw(); load().then(start, () => {}); }
    return box;
  }
  function volProject({ project, items, visits = [] }, only, ledgers, details) {
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
    // 맨 위가 '묵주' 묶음 하나면 제목과 겹치지 않게 그 안부터
    const tops = kids(null);
    const single = tops.length === 1 && tops[0].kind === "group" ? tops[0] : null;
    return [
      only ? null : h("nav", { class: "muted small" }, h("a", { href: "#/vprojects", text: "프로젝트 관리" })),
      h("h1", { class: "vol__hello", text: "프로젝트 관리" }),
      h("p", { class: "muted small", text: `${project.name} › 묵주 · 항목은 읽기 전용` }),
      single?.note ? h("p", { class: "vol-pre muted", text: single.note }) : null,
      h("div", { class: "card vol__card" }, list(single ? single.id : null)),
      volWbs(project, visits),
      volVisits(visits),
      h("div", { class: "vol-moves-grid" }, [volMoveCard("in", ledgers, details), volMoveCard("out", ledgers, details)])
    ];
  }

  /* ---------- 팀 봉사자(교육·검수): 홈 · 캘린더 · 수도회·교육 · 검수 · 이슈 (공지·게시판은 부서 봉사자와 같이) ---------- */
  const TEAM_TABS = ["thome", "tcal", "torgs", "trecov", "tinsp", "tissues"];
  const TEAM_STATUS = { plan: "예정", done: "완료", delay: "연기" };
  const ISSUE_STATUS = { new: "접수", doing: "처리 중", done: "완료" };
  const ISSUE_KIND = { general: "일반", thread: "실 품질" };
  const teamPhotoCache = new Map();
  const teamPhotoImg = (pid, cls) => {
    if (!teamPhotoCache.has(pid)) teamPhotoCache.set(pid, fetch(`${API}/team/issue-photos/${pid}`, { headers: { Authorization: "Bearer " + state.token } }).then((r) => (r.ok ? r.blob() : null)).then((b) => (b ? URL.createObjectURL(b) : null)).catch(() => null));
    const img = h("img", { class: cls || "move-photo", alt: "이슈 사진" });
    teamPhotoCache.get(pid).then((u) => { if (u) img.src = u; });
    return img;
  };
  const statusTag = (label, cls) => h("span", { class: `stock-tag team-tag ${cls || ""}`, text: label });
  async function teamPage(tab, id) {
    if (tab === "tcal") return teamCalendar();
    if (tab === "torgs") return teamOrgs();
    if (tab === "trecov") return teamRecovery();
    if (tab === "tinsp") return teamInspect(id || "records");
    if (tab === "tissues") return teamIssues();
    return teamHome();
  }
  // 하루 '봉사 가능' 상자: 가능 n명 / 필요 m명, 이름(성 뺌), 내 신청 버튼, 리더는 필요 인원 정하기
  // st = { avail } 를 같이 쓰고, 바뀌면 redraw()
  function availBox(ymd, st, redraw, compact) {
    const a = st.avail, people = a.people?.[ymd] || [], mine = a.mine.includes(ymd), need = a.needs?.[ymd], past = ymd < today();
    // 교육 일정이 있는 날만 신청 (없는 날은 버튼 없이 안내만, 이미 신청한 것은 취소만)
    const hasEdu = (a.eduDays || []).includes(ymd);
    if (!past && !hasEdu && !mine && !need) return h("div", { class: "tcal__availbox" + (compact ? " is-compact" : "") }, h("p", { class: "muted small", text: "교육 일정이 없는 날은 봉사 가능을 신청할 수 없어요." }));
    const full = need && people.length >= need.need;
    const toggle = past || (!hasEdu && !mine) ? null : h("button", { class: "btn btn--sm " + (mine ? "btn--primary" : "btn--ghost"), type: "button", "aria-pressed": String(mine), text: mine ? (compact ? "신청함 ✓" : "봉사 가능 ✓ (누르면 취소)") : compact ? "봉사 가능" : "이날 봉사할 수 있어요",
      onclick: async () => { st.avail = await act(() => api("/team/avail", { method: "PUT", body: { date: ymd, on: !mine } })); redraw(); } });
    const needSet = a.canSetNeed && !past && (hasEdu || need) ? (() => {
      const n = h("input", { type: "number", min: "0", max: "500", inputmode: "numeric", class: "tcal__needin", value: need?.need ?? "", placeholder: "인원", "aria-label": `${volDay(ymd)} 필요 인원` });
      const note = compact ? null : h("input", { maxlength: "200", value: need?.note || "", placeholder: "메모 (선택)", "aria-label": "필요 인원 메모" });
      return h("span", { class: "tcal__needset" }, [h("span", { class: "muted small", text: "필요 인원" }), n, note, h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "저장", onclick: async () => { st.avail = await act(() => api("/team/day-need", { method: "PUT", body: { date: ymd, need: n.value, note: note ? note.value : need?.note || "" } }), "필요 인원을 저장했어요."); redraw(); } })]);
    })() : null;
    return h("div", { class: "tcal__availbox" + (compact ? " is-compact" : "") }, [
      h("div", {}, [h("strong", { text: "봉사 가능" }), h("span", { class: "small " + (full ? "team-ok" : "muted"), text: need ? ` ${people.length} / 필요 ${need.need}명${full ? " (다 찼어요)" : ""}` : people.length ? ` ${people.length}명` : " 아직 없어요" }), need?.note ? h("small", { class: "muted", text: ` · ${need.note}` }) : null]),
      people.length ? h("div", { class: "tcal__names" }, people.map((n) => h("span", { class: "tcal__name", text: n }))) : null,
      h("div", { class: "actions actions--start" }, [toggle, needSet])
    ]);
  }
  // 교육 등록 (리더 봉사자·관리자): 수도회·교육, 홈, 캘린더에서 같이 씀. 날짜를 비우면 달력 미정으로 표에만
  function teamEduDialog(date0, done) {
    const err = errorLine();
    const org = h("input", { maxlength: "80", autofocus: true, placeholder: "예: ○○수녀회" }), date = h("input", { type: "date", value: date0 || "" }), time = h("input", { type: "time" });
    const place = h("input", { maxlength: "120", placeholder: "예: 명동" }), qty = h("input", { type: "number", min: "0", inputmode: "numeric" }), helper = h("input", { maxlength: "80", placeholder: "예: 길동" });
    const ok = h("button", { class: "btn btn--primary", type: "submit", text: "등록" });
    const { el: askEl, ask } = orgAskPanel();
    let orgConfirm = "";
    org.addEventListener("input", () => { askEl.hidden = true; orgConfirm = ""; });
    const form = h("form", { class: "stack", novalidate: true }, [
      h("p", { class: "muted small", text: "지금 목록에 없는 교육도 새로 등록할 수 있어요. 등록하면 수도회·교육 목록과 캘린더에 보여요." }),
      field("수도회", org), askEl, h("div", { class: "row2" }, [field("교육 날짜", date, "비우면 '달력 미정'으로 수도회·교육 목록에만 보여요"), field("시작 시간", time, "모르면 비워 두세요 ('시간 없음')")]),
      h("div", { class: "row2" }, [field("장소", place), field("요청수량 (선택)", qty)]), field("담당 봉사자 (선택)", helper), err,
      h("div", { class: "actions" }, [h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), ok])]);
    form.addEventListener("submit", (e) => { e.preventDefault(); busy(ok, async () => {
      try {
        if (!org.value.trim()) return showError(err, "수도회 이름을 적어 주세요.");
        const r = await api("/team/orgs", { method: "POST", body: { org: org.value, date: date.value, startTime: time.value, place: place.value, qty: qty.value, helper: helper.value, ...(orgConfirm ? { orgConfirm } : {}) } });
        closeDialog(); toast("교육을 등록했어요."); done(r);
      } catch (ex) { if (ex.confirm) return ask(ex.confirm, (v) => { orgConfirm = v; form.requestSubmit(); }); showError(err, ex.message); }
    }); });
    openDialog("교육 등록", form);
  }
  const teamHead = (title, sub) => [h("h1", { class: "vol__hello", text: title }), sub ? h("p", { class: "muted small", text: sub }) : null];
  // 홈 카드 두 장: 다가오는 교육(위) · 봉사 가능 신청(아래). 예전 홈과 단계형 홈에서 같이 씀
  async function teamHomeCards() {
    const [d, av, o] = await Promise.all([api("/team/home"), api("/team/avail"), api("/team/orgs")]);
    const st = { avail: av };
    const availCard = h("section", { class: "card vol__card" });
    // 봉사 가능 신청: 리더·관리자가 필요 인원을 넣은 날만 보임 (오늘부터 날짜순)
    const drawAvail = () => {
      const days = Object.keys(st.avail.needs || {}).filter((d) => d >= today()).sort();
      const addBox = st.avail.canSetNeed ? (() => {
        const date = h("select", { "aria-label": "봉사가 필요한 날 (교육 일정이 있는 날)" }, [h("option", { value: "", text: (st.avail.eduDays || []).length ? "교육 있는 날 고르기" : "앞으로 교육 일정이 없어요" }), ...(st.avail.eduDays || []).map((d) => h("option", { value: d, text: `${volDay(d)} · ${o.orgs.filter((x) => !x.tableOnly && x.date === d).map((x) => x.org).join(", ")}` }))]), n = h("input", { type: "number", min: "1", max: "500", inputmode: "numeric", class: "tcal__needin", placeholder: "인원", "aria-label": "필요 인원" });
        const note = h("input", { maxlength: "200", placeholder: "메모 (선택, 예: 오전 검수)", "aria-label": "메모" });
        return h("div", { class: "tcal__needset team-needadd" }, [h("span", { class: "muted small", text: "필요한 날 넣기" }), date, n, note, h("button", { class: "btn btn--primary btn--sm", type: "button", text: "넣기", onclick: async () => {
          if (!date.value || !Number(n.value)) return toast("교육 있는 날과 필요 인원을 골라 주세요.");
          st.avail = await act(() => api("/team/day-need", { method: "PUT", body: { date: date.value, need: n.value, note: note.value } }), "필요한 날을 넣었어요."); drawAvail();
        } })]);
      })() : null;
      fill(availCard,
        h("div", { class: "card__head" }, [h("h2", { class: "card__title", text: "봉사 가능 신청" }), h("a", { class: "link-btn", href: "#/tcal", text: "캘린더에서 보기" })]),
        h("p", { class: "muted small", text: st.avail.canSetNeed ? "교육 일정이 있는 날 중에서 봉사가 필요한 날과 인원을 넣으면 여기에 보여요. 봉사자는 '봉사 가능'을 눌러 신청해요. 인원을 0으로 저장하면 목록에서 빠져요." : "리더 봉사자가 교육 일정이 있는 날 중 봉사가 필요한 날을 넣으면 여기에 보여요. 할 수 있는 날에 '봉사 가능'을 눌러 주세요." }),
        addBox,
        days.length ? h("ul", { class: "team-days" }, days.map((ymd) => {
          const edu = o.orgs.filter((x) => !x.tableOnly && x.date === ymd).sort((a, b) => (a.startTime || "99:99").localeCompare(b.startTime || "99:99"));
          return h("li", { class: "team-day" + (ymd === today() ? " is-today" : "") }, [
            h("div", { class: "team-day__when" }, [h("strong", { text: volDay(ymd) }), edu.length ? h("small", { class: "muted", text: ` 교육 ${edu.map((x) => `${x.startTime || "시간 없음"} ${x.org}`).join(", ")}` }) : null]),
            availBox(ymd, st, drawAvail, true)
          ]);
        })) : h("p", { class: "muted", text: "아직 봉사가 필요한 날이 없어요." }));
    };
    drawAvail();
    const eduCard = h("section", { class: "card vol__card" }, [
      h("div", { class: "card__head" }, [h("h2", { class: "card__title", text: "다가오는 교육" }), h("span", { class: "actions" }, [
        st.avail.canSetNeed ? h("button", { class: "btn btn--primary btn--sm", type: "button", onclick: () => teamEduDialog("", () => render()) }, [icon("plus"), "교육 등록"]) : null,
        h("a", { class: "link-btn", href: "#/tcal", text: "캘린더" })])]),
      d.nextEdu.length ? h("ul", { class: "vol-sched-list" }, d.nextEdu.map((x) => h("li", { class: "vol-sched" }, [
        h("div", { class: "vol-sched__when" }, [h("strong", { text: volDay(x.date) }), h("span", { class: "muted small", text: x.startTime || "시간 없음" })]),
        h("div", { class: "vol-sched__what" }, [h("strong", { text: x.org }), h("span", { class: "muted small", text: [x.place, x.helper ? `담당 ${x.helper}` : "", TEAM_STATUS[x.status]].filter(Boolean).join(" · ") })])
      ]))) : h("p", { class: "muted", text: "다가오는 교육 일정이 없어요." })
    ]);
    return { d, eduCard, availCard };
  }
  async function teamHome() {
    document.title = `팀 봉사자 · ${TITLE}`;
    const { d, eduCard, availCard } = await teamHomeCards();
    const tile = (href, label, value, sub) => h("a", { class: "card vstat__tile team-tile", href }, [h("span", { class: "muted small", text: label }), h("strong", { text: value }), sub ? h("span", { class: "muted small", text: sub }) : null]);
    return [
      ...teamHead(`안녕하세요, ${state.user.name}님`, "팀 봉사자(교육·검수) 화면이에요. 맡은 일을 입력하고, 원자재·입고 정보는 조회만 해요."),
      h("div", { class: "team-tiles" }, [
        tile("#/torgs", "담당 수도회", `${d.orgs.total}곳`, `교육 완료 ${d.orgs.done} · 연기 ${d.orgs.delay} · 날짜 미정 ${d.orgs.undated}`),
        tile("#/torgs", "열린 문의", `${d.orgs.openInquiries}건`, `예상 완성 수량 ${fmtN(d.orgs.made)}`),
        tile("#/trecov", "제품 회수", fmtN(d.recovered), "수도회에서 받은 완성품 합계"),
        tile("#/tinsp/records", "제품 검수", `${d.inspect.count}건`, `검수 ${fmtN(d.inspect.checked)} · 불량 ${fmtN(d.inspect.bad)}`),
        tile("#/tinsp/daily", "하루 검수 기록 합계", fmtN(d.daily), "날짜별 검수 수량 합"),
        tile("#/tissues", "처리 전 이슈", `${d.openIssues}건`, "접수·처리 중"),
        tile("#/tinsp/shifts", "내 봉사 신청", `${d.myShifts.length}일`, d.myShifts.slice(0, 2).map((s) => shortDate(s.date)).join(", ") || "신청한 날이 없어요")
      ]),
      eduCard,
      availCard
    ];
  }
  // 캘린더: 달력 모양(한 달), 날짜를 누르면 아래에 그날 교육·검수 봉사와 '봉사 가능'(성 뺀 이름)
  async function teamCalendar() {
    document.title = `캘린더 · ${TITLE}`;
    const [o, sh, av] = await Promise.all([api("/team/orgs"), api("/team/shifts"), api("/team/avail")]);
    const st = { avail: av };
    let month = today().slice(0, 7), picked = today();
    const box = h("div", { class: "stack" });
    // 하루 일정은 시간순(시간이 없으면 뒤로, '시간 없음'으로 표시)
    const byTime = (a, b) => (a.startTime || "99:99").localeCompare(b.startTime || "99:99");
    const eduOf = (ymd) => o.orgs.filter((x) => !x.tableOnly && x.date === ymd).sort(byTime), shiftsOf = (ymd) => sh.shifts.filter((x) => x.date === ymd).sort(byTime);
    const draw = () => {
      const [y, m] = month.split("-").map(Number);
      const days = new Date(y, m, 0).getDate(), first = new Date(y, m - 1, 1).getDay();
      const ymdOf = (d) => `${month}-${String(d).padStart(2, "0")}`;
      const cells = [];
      for (let i = 0; i < first; i++) cells.push(h("div", { class: "tcal__cell is-blank", "aria-hidden": "true" }));
      for (let d = 1; d <= days; d++) {
        const ymd = ymdOf(d), edu = eduOf(ymd), shifts = shiftsOf(ymd), people = st.avail.people?.[ymd] || [], need = st.avail.needs?.[ymd], dow = (first + d - 1) % 7;
        cells.push(h("button", {
          type: "button", class: "tcal__cell" + (ymd === today() ? " is-today" : "") + (ymd === picked ? " is-picked" : "") + (ymd < today() ? " is-past" : "") + (dow === 0 ? " is-sun" : dow === 6 ? " is-sat" : ""),
          "aria-pressed": String(ymd === picked), "aria-label": `${volDay(ymd)}${edu.length ? ` 교육 ${edu.length}건` : ""}${shifts.length ? ` 검수 봉사 ${shifts.length}건` : ""}${people.length ? ` 봉사 가능 ${people.length}명` : ""}`,
          onclick: () => { picked = ymd; draw(); }
        }, [
          h("span", { class: "tcal__num", text: String(d) }),
          ...edu.slice(0, 2).map((x) => h("span", { class: "tcal__ev is-edu", title: `${x.startTime || "시간 없음"} ${x.org}` }, [h("b", { class: "tcal__time", text: x.startTime || "없음" }), ` ${x.org}`])),
          edu.length > 2 ? h("span", { class: "tcal__more", text: `+${edu.length - 2}` }) : null,
          ...shifts.map((x) => h("span", { class: "tcal__ev is-insp", title: `${x.startTime || "시간 없음"} 검수 봉사` }, [h("b", { class: "tcal__time", text: x.startTime || "없음" }), ` 검수 ${x.people.length}/${x.need}`])),
          people.length || need ? h("span", { class: "tcal__avail" + (st.avail.mine.includes(ymd) ? " is-mine" : ""), text: need ? `가능 ${people.length}/${need.need}` : `가능 ${people.length}` }) : null
        ]));
      }
      const shift = (n) => { const d = new Date(y, m - 1 + n, 1); month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; picked = month === today().slice(0, 7) ? today() : `${month}-01`; draw(); };
      // 고른 날 자세히
      const edu = eduOf(picked), shifts = shiftsOf(picked);
      const detail = h("section", { class: "card vol__card tcal__detail" }, [
        h("div", { class: "card__head" }, [h("h2", { class: "card__title tcal__title" }, [volDay(picked), picked === today() ? statusTag("오늘", "is-plan") : null]), h("span", { class: "actions" }, [
          st.avail.canSetNeed && picked >= today() ? h("button", { class: "btn btn--primary btn--sm", type: "button", onclick: () => teamEduDialog(picked, () => render()) }, [icon("plus"), "이날 교육 등록"]) : null])]),
        edu.length || shifts.length ? h("ul", { class: "tcal__list" }, [
          ...edu.map((x) => ({ t: x.startTime, el: [statusTag("교육", "is-edu"), h("strong", { text: ` ${x.org}` }), h("small", { class: "muted", text: [x.place, x.helper ? `담당 ${x.helper}` : "", TEAM_STATUS[x.status]].filter(Boolean).map((t) => ` · ${t}`).join("") })] })),
          ...shifts.map((x) => ({ t: x.startTime, el: [statusTag("검수 봉사", "is-insp"), ` 필요 ${x.need}명 · 신청 ${x.people.length}명`, x.people.length ? h("small", { class: "muted", text: ` (${x.people.join(", ")})` }) : null, h("a", { class: "link-btn small", href: "#/tinsp/shifts", text: " 봉사 신청" })] }))
        ].sort((a, b) => byTime({ startTime: a.t }, { startTime: b.t })).map((x) => h("li", { class: "tcal__row" }, [h("span", { class: "tcal__rowtime" + (x.t ? "" : " is-none"), text: x.t || "시간 없음" }), h("span", {}, x.el)])))
        : h("p", { class: "muted small", text: "이날은 교육·검수 일정이 없어요." }),
        availBox(picked, st, draw, false),
        picked < today() ? h("p", { class: "muted small", text: "지난 날은 바꿀 수 없어요." }) : null
      ]);
      fill(box,
        h("div", { class: "filters" }, [
          h("button", { class: "icon-btn", type: "button", "aria-label": "이전 달", html: ICON.left, onclick: () => shift(-1) }),
          h("strong", { text: `${y}년 ${m}월` }),
          h("button", { class: "icon-btn", type: "button", "aria-label": "다음 달", html: ICON.right, onclick: () => shift(1) }),
          month !== today().slice(0, 7) ? h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "오늘", onclick: () => { month = today().slice(0, 7); picked = today(); draw(); } }) : null,
          h("span", { class: "muted small filters__end", text: "날짜를 누르면 아래에 그날 일정과 봉사 가능한 사람이 나와요." })
        ]),
        h("div", { class: "card tcal" }, [
          h("div", { class: "tcal__head" }, ["일", "월", "화", "수", "목", "금", "토"].map((t, i) => h("span", { class: i === 0 ? "is-sun" : i === 6 ? "is-sat" : null, text: t }))),
          h("div", { class: "tcal__grid" }, cells)
        ]),
        detail);
    };
    draw();
    return [...teamHead("캘린더", "교육 일정과 검수 봉사일을 보고, 봉사할 수 있는 날을 표시해요."), box];
  }
  // 글자 복사 (https 가 아니거나 막혀 있으면 옛 방식으로)
  async function copyText(t, what = "복사") {
    try { await navigator.clipboard.writeText(t); } catch (e) {
      const a = h("textarea", { style: "position:fixed;opacity:0" }, t); (dialog.open ? dialog : document.body).append(a); a.select();
      const done = document.execCommand("copy"); a.remove();
      if (!done) return toast("복사하지 못했어요. 길게 눌러 복사해 주세요.");
    }
    toast(`${what}했어요: ${t}`);
  }
  // 연락처 글에서 전화번호를 찾아 전화 걸기·복사 버튼으로 (번호가 없으면 글 전체 복사)
  function phoneBox(text) {
    const t = String(text || "").trim();
    if (!t) return null;
    const nums = [...new Set(t.match(/\+?\d[\d\s().-]{7,}\d/g) || [])].map((x) => x.trim());
    return h("div", { class: "phone-box" }, [
      h("p", { class: "vol-pre small", text: t }),
      ...(nums.length ? nums : [t]).map((n) => h("div", { class: "phone-box__row" }, [
        nums.length ? h("span", { class: "phone-box__num", text: n }) : null,
        nums.length ? h("a", { class: "btn btn--ghost btn--sm", href: `tel:${n.replace(/[^\d+]/g, "")}` }, [icon("phone"), "전화 걸기"]) : null,
        h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "복사하기", onclick: () => copyText(n) })]))
    ]);
  }
  // 수도회 이름을 고치면 무엇이 바뀌는지 보여 주고 고르게 하는 칸 (팀 '교육 일정', 관리자 '교육 기록')
  function orgAskPanel() {
    const orgAsk = h("div", { class: "card stack stack--sm org-ask", role: "alert", hidden: true });
    const askOrg = (c, go) => {
      const btn = (t, v, main) => h("button", { class: `btn btn--sm ${main ? "btn--primary" : "btn--ghost"}`, type: "button", text: t, onclick: () => { orgAsk.hidden = true; go(v); } });
      const lines = c.mode === "similar" ? [`'${c.to}' 이름과 띄어쓰기·괄호만 다른 수도회가 이미 있어요${c.add ? ` (${c.similar.map((m) => m.name).join(", ")})` : ""}. 같은 곳이면 ${c.add && !c.edu ? "추가하지 말고 그 수도회를 써" : c.add ? "그 수도회의 교육으로 등록해" : "그 수도회로 옮겨"} 주세요.`]
        : c.mode === "move" ? [`'${c.to}'은(는) 이미 있는 수도회예요. 이 교육 하나만 '${c.from}'에서 '${c.to}'(으)로 옮겨요.`]
          : c.mode === "rename" ? [`수도회 이름을 '${c.from}'에서 '${c.to}'(으)로 바꿔요.`, c.edus > 1 ? `이 수도회의 교육 ${c.edus}건 제목이 모두 바뀌어요. 이 교육만 다른 수도회라면 취소해 주세요.` : "연락처·상태는 그대로예요."]
            : [`'${c.to}' 수도회를 새로 만들어 이 교육과 이어요.`];
      fill(orgAsk, h("strong", { text: c.add ? "비슷한 이름이 있어요" : "수도회 이름이 바뀌어요" }), ...lines.map((t) => h("p", { class: "small", text: t })), h("div", { class: "actions actions--start" }, [
        ...(c.mode === "similar" ? [...(c.add && !c.edu ? [] : c.similar.map((m, i) => btn(c.add ? `'${m.name}' 교육으로 등록` : `'${m.name}'(으)로 옮기기`, `similar:${m.id}`, !i))), btn(`그래도 '${c.to}'(으)로`, "force")]
          : [btn(c.mode === "move" ? "이 교육만 옮기기" : c.mode === "rename" ? "이름 바꾸기" : "새로 만들기", c.mode === "move" ? `move:${c.targetId}` : c.mode, true)]),
        h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "취소", onclick: () => { orgAsk.hidden = true; } })]));
      orgAsk.hidden = false; orgAsk.scrollIntoView({ block: "center" });
    };
    return { el: orgAsk, ask: askOrg };
  }
  // 담당 수도회 · 교육 · 문의 · 원자재 배분(조회) · 제작 진행
  async function teamOrgs(opts = {}) {
    const mode = opts.mode || ""; // 단계형 메뉴: schedule 교육 일정 · result 교육 결과 · made 제작 진행
    document.title = `수도회·교육 · ${TITLE}`;
    const first = await api("/team/orgs");
    let orgs = first.orgs;
    const canAdd = !!first.canAdd; // 리더 봉사자·관리자
    const addDialog = () => teamEduDialog("", (r) => { orgs = r.orgs; draw(); });
    let qv = "", st = "", tile = "plan", when = "next";
    const box = h("div", { class: "stack" });
    // 단계형 '교육 일정·결과': 예정된 교육 · 완료된 교육 · 내 교육(지난·다가오는)
    const isPast = (o) => !o.tableOnly && o.date < today();
    const EDU_TILES = {
      plan: { label: "예정된 교육", pick: (o) => o.status !== "done", hint: "날짜가 지난 교육부터 보여요. 교육을 마쳤으면 눌러서 참석 인원·특이사항을 적고 상태를 '완료'로 바꿔 주세요. 날짜가 미정인 교육은 맨 아래예요.",
        sort: (a, b) => a.tableOnly - b.tableOnly || isPast(b) - isPast(a) || a.date.localeCompare(b.date) },
      done: { label: "완료된 교육", pick: (o) => o.status === "done", hint: "마친 교육이에요. 눌러서 결과를 보거나 고쳐요.", sort: (a, b) => b.date.localeCompare(a.date) },
      mine: { label: "내 교육", pick: (o) => o.mine, hint: "봉사자 명단에 내 계정이 이어져 있고, 교육의 진행 봉사자로 적힌 교육이에요.", sort: (a, b) => (when === "past" ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date)) }
    };
    const matches = (o) => (!st || o.status === st) && (!qv || `${o.org} ${o.place} ${o.helper}`.replace(/\s/g, "").includes(qv.replace(/\s/g, "")));
    // 수도회 목록: 교육(방문 일정) 줄을 수도회 이름으로 묶어 한 줄씩. 줄을 누르면 아래 교육 목록을 그 수도회로 거름
    const orgListCard = () => {
      const t = today(), groups = new Map();
      for (const o of orgs) {
        const key = o.org.trim();
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(o);
      }
      const uniq = (xs) => [...new Set(xs.map((x) => String(x || "").trim()).filter(Boolean))];
      const rows = [...groups].map(([name, list]) => {
        const next = list.filter((o) => !o.tableOnly && o.date >= t).sort((a, b) => (a.date < b.date ? -1 : 1))[0];
        const sum = (k) => list.reduce((n, o) => n + (o[k] || 0), 0);
        return { name, list, no: Math.min(...list.map((o) => o.no)), places: uniq(list.map((o) => o.place)), helpers: uniq(list.flatMap((o) => String(o.helper || "").split(/[,·]/))),
          contact: list.map((o) => o.contact).find((c) => c && c.trim()) || "", done: list.filter((o) => o.status === "done").length, next, undated: list.some((o) => o.tableOnly),
          req: list.some((o) => o.reqQty != null) ? sum("reqQty") : null, thread: sum("threadQty"), cross: sum("crossQty"), open: sum("openInquiries") };
      }).sort((a, b) => a.no - b.no);
      const pick = (name) => { qv = name; st = ""; draw(); listBox.scrollIntoView({ block: "start", behavior: "smooth" }); };
      return h("section", { class: "team-orglist" }, [
        h("div", { class: "card__head" }, [h("h2", { class: "card__title", text: "수도회 목록" }), h("span", { class: "muted small", text: `${rows.length}곳 · 줄을 누르면 아래 교육 목록에서 그 수도회만 보여요` })]),
        rows.length ? h("div", { class: "card table-wrap" }, h("table", { class: "table team-orgs team-orglist__table" }, [
          h("thead", {}, h("tr", {}, ["번호", "수도회", "장소", "연락처", "담당 봉사자", "교육", "다음 교육", "요청", "실·십자가 받음"].map((x) => h("th", { text: x })))),
          h("tbody", {}, rows.map((r) => h("tr", { class: "stock-row" + (qv === r.name ? " is-picked" : ""), tabindex: "0", title: "이 수도회의 교육만 보기", onclick: () => pick(r.name), onkeydown: (e) => { if (e.key === "Enter") pick(r.name); } }, [
            h("td", { class: "num muted", text: String(rows.indexOf(r) + 1) }),
            h("td", {}, [h("strong", { text: r.name }), r.open ? h("span", { class: "stock-tag vol-visits__tag", text: `문의 ${r.open}` }) : null]),
            h("td", { text: r.places.join(", ") || "-" }),
            h("td", { class: "team-orglist__contact", text: r.contact ? r.contact.replace(/\s*\n\s*/g, " · ") : "-" }),
            h("td", { text: r.helpers.join(", ") || "-" }),
            h("td", { class: "nowrap", text: `${r.list.length}회${r.done ? ` (완료 ${r.done})` : ""}` }),
            h("td", { class: "nowrap", text: r.next ? `${shortDate(r.next.date)}${r.next.startTime ? ` ${r.next.startTime}` : ""}` : r.undated ? "미정" : "-" }),
            h("td", { class: "num", text: r.req != null ? fmtN(r.req) : "-" }),
            h("td", { class: "num nowrap", text: r.thread || r.cross ? `${fmtN(r.thread)} · ${fmtN(r.cross)}` : "-" })
          ])))
        ])) : h("div", { class: "card empty", text: "아직 담당 수도회가 없어요." })
      ]);
    };
    // 단계마다 보이는 교육: 결과는 날짜가 지난 교육(적을 것 먼저), 제작은 교육을 마친 곳(예상 수량이 빈 곳 먼저)
    const modeFilter = (list) => mode === "edu" ? list.filter((o) => EDU_TILES[tile].pick(o) && (tile !== "mine" || (when === "past" ? isPast(o) || o.status === "done" : !isPast(o) && o.status !== "done"))).sort(EDU_TILES[tile].sort)
      : mode === "made" ? list.filter((o) => o.status === "done").sort((a, b) => (a.madeQty == null) === (b.madeQty == null) ? a.no - b.no : a.madeQty == null ? -1 : 1) : list;
    const draw = () => {
      const shown = modeFilter(orgs.filter(matches));
      fill(box,
        mode ? null : orgListCard(),
        mode ? null : h("div", { class: "card__head team-orglist__next" }, [h("h2", { class: "card__title", text: "수도회 교육" }), qv ? h("button", { class: "link-btn small", type: "button", text: `'${qv}' 거름 풀기`, onclick: () => { qv = ""; draw(); } }) : null]),
        h("div", { class: "filters" }, [
          canAdd ? h("button", { class: "btn btn--primary btn--sm", type: "button", onclick: addDialog }, [icon("plus"), "교육 등록"]) : null,
          h("label", { class: "search" }, [icon("search"), h("input", { type: "search", placeholder: "수도회·장소·담당 검색", "aria-label": "수도회 검색", value: qv, oninput: (e) => { qv = e.target.value.trim(); drawList(); } })]),
          (() => { const s2 = h("select", { "aria-label": "교육 상태" }, [h("option", { value: "", text: "모든 상태" }), ...Object.entries(TEAM_STATUS).map(([k, v]) => h("option", { value: k, text: v }))]); s2.value = st; s2.addEventListener("change", () => { st = s2.value; draw(); }); return s2; })(),
          h("span", { class: "muted small filters__end", text: `${shown.length}곳 / 전체 ${orgs.length}곳` })
        ]),
        ...(mode === "edu" ? [
          h("div", { class: "pick-tiles pick-tiles--3" }, Object.entries(EDU_TILES).map(([k, x]) => pickTile(x.label, orgs.filter(x.pick).length, "개", k === tile, () => { tile = k; draw(); }))),
          tile === "mine" && orgs.some((o) => o.mine) ? opsSeg([["past", "지난 교육"], ["next", "다가오는 교육"]], when, (k) => { when = k; draw(); }) : null,
          opsHint(EDU_TILES[tile].hint),
          (() => { const n = orgs.filter((o) => EDU_TILES.plan.pick(o) && isPast(o) && o.status === "plan").length, q = orgs.filter((o) => o.openInquiries).length; return tile === "plan" && (n || q) ? h("p", { class: "ref-guide small", text: [n ? `처리할 일 ${n}건: 날짜가 지났는데 결과를 안 적은 교육` : "", q ? `답을 기다리는 문의가 있는 교육 ${q}곳 (문의 칸의 '열림')` : ""].filter(Boolean).join(" · ") }) : null; })()
        ] : []),
        listBox);
      drawList(shown);
    };
    const listBox = h("div");
    const drawList = (shownIn) => {
      const shown = shownIn || modeFilter(orgs.filter(matches));
      fill(listBox, shown.length ? h("div", { class: "card table-wrap" }, h("table", { class: "table team-orgs" }, [
        h("thead", {}, h("tr", {}, ["번호", "수도회", "교육일", "상태", "담당 봉사자", "요청", "실·십자가 받음", "예상 완성", "문의"].map((t) => h("th", { text: t })))),
        h("tbody", {}, shown.map((o) => h("tr", { class: "stock-row", tabindex: "0", onclick: () => orgDialog(o), onkeydown: (e) => { if (e.key === "Enter") orgDialog(o); } }, [
          h("td", { class: "num muted", text: String(o.no) }),
          h("td", {}, [h("strong", { text: o.org }), o.place ? h("small", { class: "muted", text: ` · ${o.place}` }) : null, !o.fromForm ? h("span", { class: "stock-tag vol-visits__tag", text: "신청서 없음" }) : null]),
          h("td", { class: "nowrap" }, [o.tableOnly ? h("span", { class: "muted", text: o.fromForm ? `미정 (희망 ${shortDate(o.date)})` : "미정" }) : shortDate(o.date), o.startTime && !o.tableOnly ? h("small", { class: "muted", text: ` ${o.startTime}` }) : null]),
          h("td", {}, statusTag(TEAM_STATUS[o.status], `is-${o.status}`)),
          h("td", { text: o.helper || "-" }),
          h("td", { class: "num", title: o.sumNote || "", text: o.reqQty != null ? fmtN(o.reqQty) + (o.sumNote ? " *" : "") : "-" }),
          h("td", { class: "num nowrap", text: o.threadQty != null || o.crossQty != null ? `${fmtN(o.threadQty || 0)} · ${fmtN(o.crossQty || 0)}` : "-" }),
          h("td", { class: "num nowrap", text: o.madeQty != null ? `${fmtN(o.madeQty)}${o.madeDue ? ` (${o.madeDue})` : ""}` : "-" }),
          h("td", { class: "num", text: o.inquiries ? `${o.openInquiries ? `열림 ${o.openInquiries} / ` : ""}${o.inquiries}` : "-" })
        ])))
      ])) : h("div", { class: "card empty", text: mode === "made" && !qv && !st ? "아직 교육을 마친 수도회가 없어서 비어 있어요. '교육 일정·결과'에서 상태를 '완료'로 바꾸면 여기에 보여요." : mode === "edu" && tile === "mine" && !orgs.some((x) => x.mine) ? "아직 내 교육이 없어요. 관리자가 봉사자 명단에서 내 계정을 이어 주고 교육의 진행 봉사자로 적으면 여기에 보여요." : "찾는 교육이 없어요." }));
    };
    async function orgDialog(o) {
      const err = errorLine();
      const orgName = h("input", { value: o.org, maxlength: "80" }), place = h("input", { value: o.place || "", maxlength: "120" });
      const date = h("input", { type: "date", value: o.tableOnly ? "" : o.date });
      const time = h("input", { type: "time", value: o.startTime || "" });
      const status = h("select", {}, Object.entries(TEAM_STATUS).map(([k, v]) => h("option", { value: k, text: v })));
      status.value = o.status;
      const helper = h("input", { value: o.helper, maxlength: "80", placeholder: "예: 홍길동, 김OO" });
      const attend = h("input", { type: "number", min: "0", inputmode: "numeric", value: o.attend ?? "" });
      const result = h("textarea", { rows: "2", maxlength: "1000" }, o.resultNote);
      const made = h("input", { type: "number", min: "0", inputmode: "numeric", value: o.madeQty ?? "" });
      const due = h("input", { value: o.madeDue, maxlength: "40", placeholder: "예: 12월 말" });
      const contact = isAdmin() || state.user.volLeader ? h("textarea", { rows: "2", maxlength: "300", placeholder: "담당자 이름 · 전화 · 이메일" }, o.contact) : null;
      // 수도회 이름을 고치면 무엇이 바뀌는지 먼저 보여 주고 고르게 함 (서버가 409 로 알려 줌)
      const { el: orgAsk, ask: askOrg } = orgAskPanel();
      orgName.addEventListener("input", () => { orgAsk.hidden = true; }); // 이름을 또 고치면 다시 물어봄
      const inqBox = h("div", { class: "stack stack--sm" });
      const editInq = (x, li) => {
        const d1 = h("input", { type: "date", value: x.date }), q1 = h("textarea", { rows: "2", maxlength: "1000" }, x.question), a1 = h("textarea", { rows: "2", maxlength: "1000", placeholder: "답변" }, x.answer), k1 = h("input", { type: "checkbox", checked: x.done });
        fill(li, h("div", { class: "stack stack--sm" }, [field("날짜", d1), field("문의", q1), field("답변", a1), h("label", { class: "check" }, [k1, h("span", { text: "처리 완료" })]),
          h("div", { class: "actions actions--start" }, [
            h("button", { class: "btn btn--primary btn--sm", type: "button", text: "문의 저장", onclick: async () => { await act(() => api(`/team/inquiries/${x.id}`, { method: "PATCH", body: { date: d1.value, question: q1.value, answer: a1.value, done: k1.checked } }), "문의 기록을 저장했어요."); changed = true; drawInq(); } }),
            h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "취소", onclick: () => drawInq() })])]));
        a1.focus();
      };
      const drawInq = async () => {
        const { inquiries } = await api(`/team/orgs/${o.id}/inquiries`);
        const qd = h("input", { type: "date", value: today() }), qq = h("textarea", { rows: "2", maxlength: "1000", placeholder: "문의 내용" }), qa = h("textarea", { rows: "2", maxlength: "1000", placeholder: "답변 (선택)" }), qdone = h("input", { type: "checkbox" });
        fill(inqBox,
          inquiries.length ? h("ul", { class: "team-inq" }, inquiries.map((x) => h("li", { class: "team-inq__item" + (x.done ? " is-done" : "") }, [
            h("div", { class: "small muted" }, [`${x.date} · ${x.author || "-"} `, x.done ? statusTag("처리 완료", "is-done") : statusTag("열림", "is-new")]),
            h("p", { class: "vol-pre", text: `문의: ${x.question}` }), x.answer ? h("p", { class: "vol-pre muted", text: `답변: ${x.answer}` }) : null,
            h("button", { class: "link-btn small", type: "button", text: x.done ? "다시 열기" : "처리 완료로", onclick: async () => { await act(() => api(`/team/inquiries/${x.id}`, { method: "PATCH", body: { done: !x.done } })); changed = true; drawInq(); } }),
            " ", h("button", { class: "link-btn small", type: "button", text: x.answer ? "고치기" : "답 적기", onclick: (e) => editInq(x, e.currentTarget.closest("li")) }),
            x.canDelete ? " " : null, x.canDelete ? h("button", { class: "link-btn small", type: "button", text: "지우기", onclick: async () => { if (!confirm("이 문의 기록을 지울까요?")) return; await act(() => api(`/team/inquiries/${x.id}`, { method: "DELETE" })); changed = true; drawInq(); } }) : null
          ]))) : h("p", { class: "muted small", text: "아직 문의 기록이 없어요." }),
          h("details", { class: "vstat__more" }, [h("summary", {}, "문의 기록 추가"), h("div", { class: "stack stack--sm" }, [
            field("날짜", qd), qq, qa, h("label", { class: "check" }, [qdone, h("span", { text: "처리 완료" })]),
            h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "문의 추가", onclick: async () => { if (!qq.value.trim()) return showError(err, "문의 내용을 적어 주세요."); await act(() => api(`/team/orgs/${o.id}/inquiries`, { method: "POST", body: { date: qd.value, question: qq.value, answer: qa.value, done: qdone.checked } })); changed = true; drawInq(); } })
          ])])
        );
      };
      let changed = false;
      const delWhy = o.linked ? `${o.linked}이 이어져 있어요.` : "네이버폼 신청이나 출고·교육물량 기록이 있어요.";
      const ok = h("button", { class: "btn btn--primary", type: "submit", text: "저장" });
      const form = h("form", { class: "stack", novalidate: true }, [
        h("p", { class: "muted small", text: [`교육 순서 ${o.no}`, o.fromForm ? "네이버폼 신청" : "신청서 없음", o.updatedBy ? `마지막 수정 ${o.updatedBy}` : ""].filter(Boolean).join(" · ") }),
        h("h3", { class: "team-sec", text: "교육 일정" }),
        h("div", { class: "row2" }, [field("수도회", orgName), field("장소", place)]), orgAsk,
        h("div", { class: "row2" }, [field(o.tableOnly ? "교육 날짜 (정하면 달력에 보여요)" : "교육 날짜", date, o.tableOnly ? (o.fromForm ? `신청서의 희망일 ${o.date}` : null) : "비우고 저장하면 '미정'이 돼서 달력에 안 보여요"), field("시작 시간", time)]),
        h("div", { class: "row2" }, [field("상태", status), field("담당 봉사자", helper)]),
        h("h3", { class: "team-sec", text: "교육 결과" }),
        h("div", { class: "row2" }, [field("참석 인원", attend), field("특이사항", result)]),
        h("h3", { class: "team-sec", text: "제작 진행" }),
        h("div", { class: "row2" }, [field("예상 완성 수량", made), field("완성 예정 시기", due)]),
        h("h3", { class: "team-sec", text: "원자재 배분 (조회)" }),
        h("p", { class: "small", text: `요청 ${o.reqQty != null ? fmtN(o.reqQty) : "-"}${o.sumNote ? ` (${o.sumNote}, 합계 제외)` : ""} · 교육물량 ${o.eduQty != null ? fmtN(o.eduQty) : "-"} · 실 ${o.threadQty != null ? fmtN(o.threadQty) : "-"} · 십자가 ${o.crossQty != null ? fmtN(o.crossQty) : "-"}` }),
        h("h3", { class: "team-sec", text: "연락처" }),
        contact ? field("연락처 (리더 봉사자·관리자만 고쳐요)", contact) : o.contact ? null : h("p", { class: "small muted", text: "아직 적은 연락처가 없어요. 리더 봉사자나 관리자에게 알려 주세요." }),
        phoneBox(o.contact),
        h("h3", { class: "team-sec", text: "문의 대응 기록" }), inqBox,
        canAdd && !o.deletable ? h("p", { class: "muted small", text: `이 교육은 지울 수 없어요: ${delWhy}` }) : null,
        err,
        h("div", { class: "actions" }, [
          canAdd ? h("button", { class: "btn btn--danger-outline btn--sm", type: "button", text: "교육 지우기", disabled: !o.deletable, title: o.deletable ? "" : delWhy, onclick: async () => {
            if (!confirm(`'${o.org}' 교육을 지울까요? 교육 결과·문의 기록도 함께 지워져요.`)) return;
            orgs = (await act(() => api(`/team/orgs/${o.id}`, { method: "DELETE" }), "교육을 지웠어요.")).orgs; closeDialog(); draw();
          } }) : null,
          h("button", { class: "btn btn--ghost", type: "button", text: "닫기", "data-close": true }), ok])
      ]);
      const submit = (orgConfirm) => {
        busy(ok, async () => {
          try {
            if (!orgName.value.trim()) return showError(err, "수도회 이름을 적어 주세요.");
            const body = { ...(orgName.value.trim() !== o.org.trim() ? { org: orgName.value, ...(orgConfirm ? { orgConfirm } : {}) } : {}), place: place.value, helper: helper.value, attend: attend.value, resultNote: result.value, madeQty: made.value, madeDue: due.value };
            if (date.value ? o.tableOnly || date.value !== o.date || time.value !== (o.startTime || "") : !o.tableOnly) Object.assign(body, { date: date.value, startTime: date.value ? time.value : "" }); // 날짜를 비우면 '미정'으로
            if (status.value !== o.status) Object.assign(body, { status: status.value, statusFrom: o.status }); // 바꿨을 때만 (관리자 '교육 기록'과 같은 값)
            if (contact && contact.value !== o.contact) body.contact = contact.value;
            const r = await apiAsk(`/team/orgs/${o.id}`, { method: "PATCH", body });
            if (!r) return;
            orgs = body.org ? (await api("/team/orgs")).orgs : orgs.map((x) => (x.id === o.id ? r.org : x)); // 이름을 바꾸면 다른 교육 제목도 바뀔 수 있어 다시 받음
            closeDialog(); toast("저장했어요."); draw();
          } catch (ex) { if (ex.confirm) { showError(err, ""); return askOrg(ex.confirm, submit); } showError(err, ex.message); }
        });
      };
      form.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
      openDialog(o.org, form, { wide: true });
      drawInq().catch((ex) => showError(err, ex.message));
      // 문의만 바꾸고 닫아도 목록 숫자가 맞게
      const reloadIfChanged = async () => { if (changed) { orgs = (await api("/team/orgs")).orgs; draw(); } };
      dialog.addEventListener("close", () => { quiet(reloadIfChanged()); }, { once: true });
    }
    draw();
    openRef(["edu", "made", "req"], (id) => orgs.find((o) => o.id === id), orgDialog);
    if (mode) return [h("p", { class: "muted small", text: { edu: "교육 날짜·시간을 정하고, 마친 교육의 결과를 적어요. 위 칸을 누르면 그 교육만 보여요. 줄을 누르면 열려요.", schedule: "교육 날짜·시간·상태를 정해요. 날짜가 미정인 교육부터 정해 주세요. 줄을 누르면 열려요.", result: "날짜가 지난 교육의 참석 인원·특이사항을 적고 상태를 '완료'로 바꿔요. 줄을 누르면 열려요.", made: "교육을 마친 수도회의 예상 완성 수량과 완성 예정 시기를 적어요. 줄을 누르면 열려요." }[mode] }), box];
    return [...teamHead("수도회·교육", "담당 수도회마다 교육 일정·결과, 문의, 제작 진행을 적어요. 원자재(실·십자가)는 조회만 해요. 줄을 누르면 열려요."), box];
  }
  // 검수: 검수 기록 · 입고 완성품 · 하루 검수 기록 · 봉사 신청 · 검수 기준
  async function teamInspect(sub, opts = {}) {
    document.title = `제품 검수 · ${TITLE}`;
    const tabs = [["records", "검수 결과"], ["products", "입고 완성품"], ["daily", "하루 검수 기록"], ["shifts", "봉사 신청"], ["guide", "검수 기준"]];
    if (!tabs.some(([k]) => k === sub)) sub = "records";
    const seg = h("div", { class: "seg ops-tabs", role: "tablist" }, tabs.map(([k, label]) => h("a", { class: "seg__link" + (k === sub ? " is-active" : ""), role: "tab", href: `#/tinsp/${k}`, "aria-selected": String(k === sub), text: label })));
    const box = h("div", { class: "stack" });
    const head = [...teamHead("제품 검수", "회수한 완성품을 검수해요. 검수 결과·하루 검수 기록·봉사 신청은 입력하고, 입고 완성품과 검수 기준은 조회해요."), seg];
    if (sub === "records") {
      let mod;
      let waiting = opts.waiting ? (await api("/ops/inspect-waiting").catch(() => ({ waiting: [] }))).waiting : [];
      const waitBox = () => waiting.length ? h("section", { class: "stack stack--sm" }, [h("h2", { class: "card__title", text: `검수 대기 ${waiting.length}건` }), h("ul", { class: "vm-list" }, waiting.map((w) => h("li", {}, h("div", { class: "vm-card" }, [
        h("span", { class: "vm-card__top" }, [h("strong", { class: "vm-card__date", text: `${shortDate(w.date)} · ${w.org}` }), h("strong", { class: "vm-card__qty", text: `${fmtN(w.qty - w.checked)}개 남음` })]),
        h("span", { class: "vm-card__parts small", text: [`회수 ${fmtN(w.qty)}개`, w.checked ? `검수 ${fmtN(w.checked)}개` : "", w.trackingNo ? `송장 ${w.trackingNo}` : ""].filter(Boolean).join(" · ") }),
        h("span", { class: "actions actions--start" }, h("button", { class: "btn btn--primary btn--sm", type: "button", text: "이 물량 검수 입력", onclick: () => mod.dialog(null, { recoveryId: w.id, source: w.org, checkedQty: w.qty - w.checked }) }))
      ]))))]) : null;
      const redraw = async (reload) => { if (reload && opts.waiting) waiting = (await api("/ops/inspect-waiting").catch(() => ({ waiting }))).waiting; fill(box, waitBox(), h("div", { class: "actions actions--start" }, h("button", { class: "btn btn--primary btn--sm", type: "button", onclick: () => mod.dialog(null) }, [icon("plus"), "검수 결과 입력"])), mod.view()); };
      mod = inspModule("/team", redraw, "검수할 때마다 한 줄씩 적어요. 사진은 선택이고, 불량이 있으면 붙여 주면 좋아요. 불합격품은 수도회로 반송할지 현장에서 고칠지 골라 주세요.");
      await mod.load(); redraw();
      openRef(["inspect", "defect"], (id) => mod.data().inspections.find((x) => x.id === id), mod.dialog);
    } else if (sub === "products") {
      const { records } = await api("/team/products");
      const stage = { in: "입고", checked: "검수 완료", packed: "패키징 완료", out: "출고" };
      fill(box, records.length ? h("div", { class: "card table-wrap" }, h("table", { class: "table" }, [
        h("thead", {}, h("tr", {}, ["날짜", "단계", "수도회·내용", "수량", "메모"].map((t) => h("th", { text: t })))),
        h("tbody", {}, records.map((r) => h("tr", {}, [h("td", { class: "nowrap", text: r.date }), h("td", { text: stage[r.stage] || r.stage }), h("td", { text: r.name || "-" }), h("td", { class: "num", text: fmtN(r.qty) }), h("td", { class: "muted small", text: r.note || "" })])))
      ])) : h("div", { class: "card empty", text: "아직 입고된 완성품 기록이 없어요. (조직위·부서 봉사자가 적은 기록을 보여 줘요)" }));
    } else if (sub === "daily") {
      let daily = (await api("/team/daily")).daily;
      const draw = () => {
        const total = daily.reduce((n, x) => n + x.qty, 0);
        const byDate = new Map(); for (const x of daily) byDate.set(x.date, (byDate.get(x.date) || 0) + x.qty);
        fill(box,
          h("div", { class: "actions actions--start" }, [h("button", { class: "btn btn--primary btn--sm", type: "button", onclick: () => dailyDialog(null) }, [icon("plus"), "기록 추가"]), h("span", { class: "muted small", text: `총 ${fmtN(total)}개 · ${byDate.size}일` })]),
          daily.length ? h("div", { class: "card table-wrap" }, h("table", { class: "table" }, [
            h("thead", {}, h("tr", {}, ["날짜", "검수 수량", "그날 합계", "함께한 봉사자", "메모", "입력"].map((t) => h("th", { text: t })))),
            h("tbody", {}, daily.map((x) => h("tr", x.canEdit ? { class: "stock-row", tabindex: "0", onclick: () => dailyDialog(x) } : { "data-ref": `daily:${x.id}`, title: "적은 사람과 리더 봉사자·관리자만 고쳐요" }, [h("td", { class: "nowrap", text: x.date }), h("td", { class: "num", text: fmtN(x.qty) }), h("td", { class: "num muted", text: fmtN(byDate.get(x.date)) }), h("td", { text: x.workers || "-" }), h("td", { class: "muted small", text: x.note || "" }), h("td", { class: "muted small", text: x.author || "-" })]))),
            h("tfoot", {}, h("tr", { class: "vol-more__sum" }, [h("th", { text: "합계" }), h("td", { class: "num", text: fmtN(total) }), h("td", { colspan: "4" })]))
          ])) : h("div", { class: "card empty", text: "아직 하루 검수 기록이 없어요." }));
      };
      const dailyDialog = (x) => {
        const err = errorLine();
        const date = h("input", { type: "date", value: x?.date || today() }), qty = h("input", { type: "number", min: "0", inputmode: "numeric", value: x?.qty ?? "" });
        const workers = h("input", { value: x?.workers || "", maxlength: "300", placeholder: "예: 김OO, 이OO" }), note = h("textarea", { rows: "2", maxlength: "500" }, x?.note || "");
        const ok = h("button", { class: "btn btn--primary", type: "submit", text: x ? "저장" : "추가" });
        const form = h("form", { class: "stack", novalidate: true }, [h("div", { class: "row2" }, [field("날짜", date), field("검수 수량", qty)]), field("함께한 봉사자", workers), field("메모 (선택)", note), err,
          h("div", { class: "actions" }, [x?.canEdit ? h("button", { class: "btn btn--danger-outline btn--sm", type: "button", text: "지우기", onclick: async () => { if (!confirm("이 하루 검수 기록을 지울까요?")) return; daily = (await act(() => api(`/team/daily/${x.id}`, { method: "DELETE" }))).daily; closeDialog(); draw(); } }) : null, h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), ok])]);
        form.addEventListener("submit", (e) => { e.preventDefault(); busy(ok, async () => { try { if (qty.value === "") return showError(err, "검수 수량을 적어 주세요."); daily = (await api(x ? `/team/daily/${x.id}` : "/team/daily", { method: x ? "PATCH" : "POST", body: { date: date.value, qty: qty.value, workers: workers.value, note: note.value } })).daily; closeDialog(); draw(); } catch (ex) { showError(err, ex.message); } }); });
        openDialog(x ? "하루 검수 기록 고치기" : "하루 검수 기록 추가", form);
      };
      draw();
      openRef("daily", (id) => daily.find((x) => x.id === id), (x) => (x.canEdit ? dailyDialog(x) : flashRef("daily", x.id)));
    } else if (sub === "shifts") {
      let shifts = (await api("/team/shifts")).shifts;
      const draw = () => fill(box,
        h("div", { class: "actions actions--start" }, h("button", { class: "btn btn--primary btn--sm", type: "button", onclick: () => shiftDialog() }, [icon("plus"), "봉사일 만들기"])),
        shifts.length ? h("ul", { class: "card team-days" }, shifts.map((s) => h("li", { class: "team-day", "data-ref": `shifts:${s.id}` }, [
          h("div", { class: "team-day__when" }, [h("strong", { text: volDay(s.date) }), s.startTime ? h("span", { class: "muted small", text: ` ${s.startTime}` }) : null]),
          h("div", { class: "team-day__what" }, [h("div", { text: `필요 ${s.need}명 · 신청 ${s.people.length}명${s.people.length >= s.need ? " (다 찼어요)" : ""}` }), s.people.length ? h("small", { class: "muted", text: s.people.join(", ") }) : null, s.note ? h("small", { class: "muted vol-pre", text: s.note }) : null]),
          h("span", { class: "actions" }, [
            isAdmin() && !state.user.volKind ? null : h("button", { class: "btn btn--sm " + (s.mine ? "btn--primary" : "btn--ghost"), type: "button", disabled: s.full && !s.mine, text: s.mine ? "신청함 ✓" : s.full ? "다 찼어요" : "신청", onclick: async () => { shifts = (await act(() => api(`/team/shifts/${s.id}/signup`, { method: "POST", body: { on: !s.mine } }))).shifts; draw(); } }),
            s.canEdit ? h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "고치기", onclick: () => shiftDialog(s) }) : null,
            s.canDelete ? h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "지우기", onclick: async () => { if (!confirm("이 봉사일을 지울까요? 신청도 함께 지워져요.")) return; shifts = (await act(() => api(`/team/shifts/${s.id}`, { method: "DELETE" }))).shifts; draw(); } }) : null
          ])
        ]))) : h("div", { class: "card empty", text: "앞으로 잡힌 검수 봉사일이 없어요." }));
      const shiftDialog = (s) => {
        const err = errorLine();
        const date = h("input", { type: "date", min: today(), value: s?.date || today() }), time = h("input", { type: "time", value: s?.startTime || "" }), need = h("input", { type: "number", min: "1", inputmode: "numeric", value: s ? String(s.need) : "3" }), note = h("textarea", { rows: "2", maxlength: "300", placeholder: "장소·준비물 등 (선택)" }, s?.note || "");
        const ok = h("button", { class: "btn btn--primary", type: "submit", text: s ? "저장" : "만들기" });
        const form = h("form", { class: "stack", novalidate: true }, [h("div", { class: "row2" }, [field("날짜", date), field("시작 시간", time)]), field("필요 인원", need), field("메모", note), err, h("div", { class: "actions" }, [h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), ok])]);
        form.addEventListener("submit", (e) => { e.preventDefault(); busy(ok, async () => { try {
          if (date.value && date.value < today() && date.value !== s?.date) return showError(err, "지난 날짜로는 봉사일을 잡을 수 없어요.");
          shifts = (await api(s ? `/team/shifts/${s.id}` : "/team/shifts", { method: s ? "PATCH" : "POST", body: { date: date.value, startTime: time.value, need: need.value, note: note.value } })).shifts; closeDialog(); draw(); } catch (ex) { showError(err, ex.message); } }); });
        openDialog(s ? "검수 봉사일 고치기" : "검수 봉사일 만들기", form);
      };
      draw();
    } else {
      const { docs } = await api("/team/docs");
      fill(box, docList(docs.filter((d) => d.category === "inspect"), "아직 올린 검수 기준이 없어요. 관리자가 올리면 여기에 보여요."));
    }
    return opts.bare ? [box] : [...head, box];
  }
  // 단계형 '회수': 오는 택배(보기) + 회수 결과(택배에서 온 것·직접 받은 것)
  async function teamRecoveryStep() {
    const ships = await api("/ops/shipments").catch(() => ({ shipments: [] }));
    const coming = ships.shipments.filter((s) => s.direction === "in" && ["ready", "sent"].includes(s.status) && s.partyType === "monastery" && ["", "inspect"].includes(s.kind)).sort((a, b) => (a.status === "sent" ? 0 : 1) - (b.status === "sent" ? 0 : 1) || (a.arrivedDate || a.sentDate || "9").localeCompare(b.arrivedDate || b.sentDate || "9"));
    // 알림의 '택배 수신': 오는 중이면 그 카드로, 도착했으면 이어진 회수 기록으로
    const ref = state.openRef?.topic === "ship_in" ? state.openRef.id : null, ship = ref && ships.shipments.find((s) => s.id === ref);
    if (ref) {
      state.openRef = null;
      if (ship?.recoveryId) state.openRef = { topic: "recovery", id: ship.recoveryId };
      else setTimeout(() => (coming.some((s) => s.id === ref) ? flashRef("ship_in", ref) : toast(ship ? `이 택배는 지금 '${SHIP_STATUS[ship.status]}' 상태예요.` : REF_GONE)), 60);
    }
    const rest = await teamRecovery({ bare: true });
    document.title = `회수 · ${TITLE}`;
    return [
      h("h2", { class: "card__title ops-sec", text: `오는 택배 ${coming.length}건` }),
      opsHint("부서 봉사자가 적은 택배예요 (보기만). 도착으로 바뀌면 아래 회수 결과와 검수 대기에 저절로 생겨요. 여기서 다시 적지 마세요."),
      opsCards(coming, (s) => shipCard(s, null), "지금 오는 택배가 없어요."),
      h("h2", { class: "card__title ops-sec", text: "회수 결과" }), ...rest];
  }
  // 제품 회수: 수도회에서 완성품을 받은 날짜·수량·방법. 수도회별 합계와 예상 완성 수량을 나란히
  const RECOVERY_METHOD = { "": "-", parcel: "택배", visit: "방문 회수", bring: "수도회가 가져옴" };
  async function teamRecovery(opts = {}) {
    document.title = `제품 회수 · ${TITLE}`;
    const [o, r0] = await Promise.all([api("/team/orgs"), api("/team/recovery")]);
    let r = r0, view = "list";
    const box = h("div", { class: "stack" });
    const dialogFor = (x) => {
      const err = errorLine();
      const org = h("select", {}, [h("option", { value: "", text: "수도회 고르기" }), ...o.orgs.map((g) => h("option", { value: String(g.id), text: `${g.no}. ${g.org}` }))]);
      org.value = x ? String(x.scheduleId) : "";
      const date = h("input", { type: "date", value: x?.date || today() }), qty = h("input", { type: "number", min: "0", inputmode: "numeric", value: x?.qty ?? "" });
      const how = h("select", {}, Object.entries(RECOVERY_METHOD).map(([k, v]) => h("option", { value: k, text: k ? v : "방법 (선택)" })));
      how.value = x?.method || "";
      const note = h("textarea", { rows: "2", maxlength: "500", placeholder: "예: 박스 2개, 송장 번호 등" }, x?.note || "");
      const ok = h("button", { class: "btn btn--primary", type: "submit", text: x ? "저장" : "추가" });
      const form = h("form", { class: "stack", novalidate: true }, [field("수도회", org), h("div", { class: "row2" }, [field("회수 날짜", date), field("회수 수량", qty)]), h("div", { class: "row2" }, [field("방법", how), field("메모 (선택)", note)]), err,
        h("div", { class: "actions" }, [x && (x.mine || isAdmin() || state.user.volLeader) ? h("button", { class: "btn btn--danger-outline btn--sm", type: "button", text: "지우기", onclick: async () => { if (!confirm("이 회수 기록을 지울까요?")) return; r = await act(() => api(`/team/recovery/${x.id}`, { method: "DELETE" })); closeDialog(); draw(); } }) : null,
          h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), ok])]);
      form.addEventListener("submit", (e) => { e.preventDefault(); busy(ok, async () => {
        try { if (!org.value) return showError(err, "수도회를 골라 주세요."); const rr = await apiAsk(x ? `/team/recovery/${x.id}` : "/team/recovery", { method: x ? "PATCH" : "POST", body: { scheduleId: Number(org.value), date: date.value, qty: qty.value, method: how.value, note: note.value } }); if (!rr) return; r = rr; closeDialog(); toast("회수 기록을 저장했어요."); draw(); }
        catch (ex) { showError(err, ex.message); }
      }); });
      openDialog(x ? "회수 기록 고치기" : "제품 회수 기록", form);
    };
    const draw = () => {
      const seg = h("div", { class: "seg seg--sm", role: "tablist" }, [["list", "회수 기록"], ["org", "수도회별"]].map(([k, label]) => h("button", { type: "button", role: "tab", "aria-selected": String(k === view), text: label, onclick: () => { view = k; draw(); } })));
      const orgRows = o.orgs.filter((g) => r.byOrg[g.id] || g.madeQty != null);
      fill(box,
        h("div", { class: "filters" }, [h("button", { class: "btn btn--primary btn--sm", type: "button", onclick: () => dialogFor(null) }, [icon("plus"), opts.bare ? "직접 받은 것 적기" : "회수 기록"]), seg, h("span", { class: "muted small filters__end", text: `회수 합계 ${fmtN(r.total)}개 · ${r.records.length}건` })]),
        view === "list"
          ? (r.records.length ? h("div", { class: "card table-wrap" }, h("table", { class: "table" }, [
            h("thead", {}, h("tr", {}, ["회수 날짜", "수도회", "수량", "방법", "메모", "입력"].map((t) => h("th", { text: t })))),
            h("tbody", {}, r.records.map((x) => h("tr", { class: "stock-row", tabindex: "0", onclick: () => dialogFor(x), onkeydown: (e) => { if (e.key === "Enter") dialogFor(x); } }, [h("td", { class: "nowrap", text: x.date }), h("td", {}, [x.org, x.shipmentId ? h("span", { class: "stock-tag vol-visits__tag", text: "택배에서 옴" }) : null]), h("td", { class: "num", text: fmtN(x.qty) }), h("td", { class: "nowrap", text: RECOVERY_METHOD[x.method] }), h("td", { class: "muted small", text: x.note || "" }), h("td", { class: "muted small", text: x.author || "-" })]))),
            h("tfoot", {}, h("tr", { class: "vol-more__sum" }, [h("th", { colspan: "2", text: "합계" }), h("td", { class: "num", text: fmtN(r.total) }), h("td", { colspan: "3" })]))
          ])) : h("div", { class: "card empty", text: "아직 회수 기록이 없어요. '회수 기록'을 눌러 추가해 주세요." }))
          : (orgRows.length ? h("div", { class: "card table-wrap" }, h("table", { class: "table" }, [
            h("thead", {}, h("tr", {}, ["번호", "수도회", "요청", "예상 완성", "회수", "남은 수량"].map((t) => h("th", { text: t })))),
            h("tbody", {}, orgRows.map((g) => { const got = r.byOrg[g.id] || 0, left = g.madeQty != null ? g.madeQty - got : null; return h("tr", {}, [h("td", { class: "num muted", text: String(g.no) }), h("td", { text: g.org }), h("td", { class: "num", text: g.reqQty != null ? fmtN(g.reqQty) : "-" }), h("td", { class: "num", text: g.madeQty != null ? fmtN(g.madeQty) : "-" }), h("td", { class: "num", text: fmtN(got) }), h("td", { class: "num " + (left > 0 ? "qty-diff is-need" : left != null ? "qty-diff is-done" : "muted"), text: left == null ? "-" : left > 0 ? fmtN(left) : "완료" })]); }))
          ])) : h("div", { class: "card empty", text: "회수 기록이나 예상 완성 수량이 있는 수도회가 아직 없어요." })));
    };
    draw();
    openRef("recovery", (id) => r.records.find((x) => x.id === id), dialogFor);
    if (opts.bare) return [h("p", { class: "muted small", text: "직접 찾아가서 받았거나 수도회가 가져온 완성품을 적어요. 택배로 받은 것은 부서 봉사자가 도착 처리하면 저절로 생겨요 ('택배에서 옴' 표시)." }), box];
    return [...teamHead("제품 회수", "수도회에서 완성품을 받으면 날짜·수량·방법을 적어요. 받은 완성품은 '제품 검수'에서 검수해요."), box];
  }
  const docList = (docs, empty) => docs.length ? h("ul", { class: "stack stack--sm team-docs" }, docs.map((d) => h("li", { class: "card team-doc", "data-ref": `docs:${d.id}` }, [
    h("strong", { text: d.title }), d.note ? h("p", { class: "vol-pre small", text: d.note }) : null,
    d.url ? h("a", { class: "link-btn", href: d.url, target: "_blank", rel: "noopener noreferrer", text: "열기 / 내려받기" }) : null
  ]))) : h("div", { class: "card empty", text: empty });
  // 이슈: 누구나 등록(사진 4장), 조직위가 처리 상태·답을 적음
  async function teamIssues() {
    document.title = `이슈 · ${TITLE}`;
    let { issues } = await api("/team/issues");
    const orgs = isAdmin() || state.user.volKind === "team" ? (await api("/team/orgs").catch(() => ({ orgs: [] }))).orgs : []; // 부서 봉사자는 수도회 목록 없이
    let only = "";
    const box = h("div", { class: "stack" });
    const draw = () => {
      const shown = issues.filter((x) => !only || (only === "mine" ? x.mine : x.status !== "done"));
      fill(box,
        h("div", { class: "filters" }, [
          h("button", { class: "btn btn--primary btn--sm", type: "button", onclick: () => issueDialog(null) }, [icon("plus"), "이슈 등록"]),
          (() => { const s2 = h("select", { "aria-label": "이슈 거르기" }, [["", "모든 이슈"], ["open", "처리 전"], ["mine", "내가 올린 것"]].map(([v, t]) => h("option", { value: v, text: t }))); s2.value = only; s2.addEventListener("change", () => { only = s2.value; draw(); }); return s2; })(),
          h("span", { class: "muted small filters__end", text: `${shown.length}건` })
        ]),
        shown.length ? h("ul", { class: "stack stack--sm team-list" }, shown.map((x) => h("li", { class: "card team-issue stock-row", tabindex: "0", onclick: () => issueDialog(x) }, [
          h("div", { class: "team-issue__head" }, [statusTag(ISSUE_STATUS[x.status], `is-${x.status}`), statusTag(ISSUE_KIND[x.kind], x.kind === "thread" ? "is-thread" : ""), h("strong", { text: x.title })]),
          h("div", { class: "muted small", text: [x.org, x.author, x.createdAt?.slice(0, 10), x.photos.length ? `사진 ${x.photos.length}` : ""].filter(Boolean).join(" · ") }),
          x.reply ? h("p", { class: "vol-pre small team-issue__reply", text: `조직위: ${x.reply}` }) : null
        ]))) : h("div", { class: "card empty", text: "이슈가 없어요." }));
    };
    const issueDialog = (x) => {
      const canEdit = !x || x.mine || isAdmin();
      const err = errorLine();
      const kind = h("select", { disabled: !canEdit }, Object.entries(ISSUE_KIND).map(([k, v]) => h("option", { value: k, text: v })));
      kind.value = x?.kind || "general";
      const org = h("select", { disabled: !canEdit }, [h("option", { value: "", text: "수도회 없음" }), ...orgs.map((o) => h("option", { value: String(o.id), text: `${o.no}. ${o.org}` }))]);
      org.value = x?.scheduleId ? String(x.scheduleId) : "";
      const title = h("input", { value: x?.title || "", maxlength: "120", disabled: !canEdit, placeholder: "예: ○○수녀회 실이 자주 끊어져요" });
      const body = h("textarea", { rows: "4", maxlength: "2000", disabled: !canEdit }, x?.body || "");
      const pending = [];
      const photoBox = h("div", { class: "move-photos" });
      const fileIn = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp", multiple: true, hidden: true });
      const drawPhotos = () => photoBox.replaceChildren(...(x?.photos || []).map((pid) => h("span", { class: "move-photos__item" }, [teamPhotoImg(pid), canEdit ? h("button", { class: "move-photos__x", type: "button", "aria-label": "사진 지우기", html: ICON.close, onclick: async () => {
        if (!confirm("이 사진을 지울까요?")) return;
        issues = (await act(() => api(`/team/issue-photos/${pid}`, { method: "DELETE" }))).issues; x = issues.find((y) => y.id === x.id) || x; drawPhotos(); draw();
      } }) : null])), ...pending.map((b, i) => h("span", { class: "move-photos__item is-new" }, [h("img", { class: "move-photo", alt: "올릴 사진", src: URL.createObjectURL(b) }), h("button", { class: "move-photos__x", type: "button", "aria-label": "빼기", html: ICON.close, onclick: () => { pending.splice(i, 1); drawPhotos(); } })])));
      fileIn.addEventListener("change", async () => { for (const f of [...fileIn.files]) { if ((x?.photos.length || 0) + pending.length >= 4) break; try { pending.push(await shrinkImage(f)); showError(err, ""); } catch (ex) { showError(err, ex.message); } } fileIn.value = ""; drawPhotos(); });
      drawPhotos();
      let savedId = x?.id || null;
      const ok = h("button", { class: "btn btn--primary", type: "submit", text: x ? "저장" : "등록", hidden: !canEdit });
      const form = h("form", { class: "stack", novalidate: true }, [
        x ? h("p", { class: "small" }, [statusTag(ISSUE_STATUS[x.status], `is-${x.status}`), ` ${x.author || ""} · ${x.createdAt?.slice(0, 10) || ""}`]) : null,
        h("div", { class: "row2" }, [field("종류", kind, "실 품질: 끊어짐·색상 등 수도회가 알려 온 불량"), field("수도회 (선택)", org)]),
        field("제목", title), field("내용", body),
        h("div", { class: "field" }, [h("span", { class: "field__label", text: "사진 (선택, 4장까지)" }), photoBox, canEdit ? h("div", {}, [h("button", { class: "btn btn--ghost btn--sm", type: "button", onclick: () => fileIn.click() }, [icon("plus"), "사진 추가"]), fileIn]) : null]),
        x?.reply ? h("p", { class: "vol-pre team-issue__reply", text: `조직위 답: ${x.reply}` }) : null,
        x?.mine && x.status !== "new" && !isAdmin() ? h("p", { class: "muted small", text: "처리를 시작한 이슈는 관리자만 지울 수 있어요. 지워야 하면 관리자에게 알려 주세요." }) : null,
        err,
        h("div", { class: "actions" }, [
          x && ((x.mine && x.status === "new") || isAdmin()) ? h("button", { class: "btn btn--danger-outline btn--sm", type: "button", text: "지우기", onclick: async () => { if (!confirm("이 이슈를 지울까요?")) return; issues = (await act(() => api(`/team/issues/${x.id}`, { method: "DELETE" }))).issues; closeDialog(); draw(); } }) : null,
          h("button", { class: "btn btn--ghost", type: "button", text: "닫기", "data-close": true }), ok
        ])
      ]);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        busy(ok, async () => {
          try {
            if (!title.value.trim()) return showError(err, "제목을 적어 주세요.");
            const b = { kind: kind.value, scheduleId: org.value ? Number(org.value) : null, title: title.value, body: body.value };
            let r = null;
            if (!savedId) { r = await api("/team/issues", { method: "POST", body: b }); savedId = r.id; issues = r.issues; }
            else if (x) { r = await api(`/team/issues/${x.id}`, { method: "PATCH", body: b }); issues = r.issues; }
            while (pending.length) {
              try { r = await api(`/team/issues/${savedId}/photos`, { method: "POST", body: { data: await blobToBase64(pending[0]) } }); }
              catch (ex) { drawPhotos(); draw(); return showError(err, `이슈는 저장했어요. 사진을 올리지 못했어요: ${ex.message} 다시 누르면 남은 사진만 올려요.`); }
              pending.shift(); issues = r.issues;
            }
            closeDialog(); toast("이슈를 저장했어요."); draw();
          } catch (ex) { showError(err, ex.message); }
        });
      });
      openDialog(x ? "이슈" : "이슈 등록", form, { wide: true });
    };
    draw();
    openRef("issue", (id) => issues.find((x) => x.id === id), issueDialog);
    return [...teamHead("이슈", "문제가 생기면 바로 등록해 주세요. 조직위가 처리 상태와 답을 적어요."), box];
  }

  /* ---------- 게시판 (봉사자·관리자): 요청·건의·자유, 비밀글은 쓴 사람과 관리자만 ---------- */
  const BOARD_CAT = { request: "요청", suggest: "건의", free: "자유" };
  let boardCat = "";
  function boardEditDialog(base, post, onSaved) {
    const err = errorLine();
    const cat = h("select", {}, Object.entries(BOARD_CAT).map(([k, t]) => h("option", { value: k, text: t })));
    cat.value = post?.category || "free";
    const title = h("input", { value: post?.title || "", maxlength: "100", autofocus: true, placeholder: "제목" });
    const body = h("textarea", { rows: "8", maxlength: "5000", placeholder: "자유롭게 적어 주세요" }, post?.body || "");
    const secret = h("input", { type: "checkbox", checked: !!post?.secret });
    const ok = h("button", { class: "btn btn--primary", type: "submit", text: post ? "저장" : "올리기" });
    const form = h("form", { class: "stack" }, [
      h("div", { class: "row2" }, [field("분류", cat), h("div", { class: "field" }, [h("span", { class: "field__label", text: "비밀글" }), h("label", { class: "check" }, [secret, h("span", { text: "비밀글로 쓰기 (나와 관리자만 볼 수 있어요)" })])])]),
      field("제목", title), field("내용", body), err,
      h("div", { class: "actions" }, [h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), ok])
    ]);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      busy(ok, async () => {
        try { const r = await api(post ? `/board/${post.id}` : "/board", { method: post ? "PATCH" : "POST", body: { category: cat.value, title: title.value, body: body.value, secret: secret.checked } }); closeDialog(); toast(post ? "고쳤어요." : "글을 올렸어요."); onSaved(post ? post.id : r.id); }
        catch (ex) { showError(err, ex.message); }
      });
    });
    openDialog(post ? "글 고치기" : "글쓰기", form);
  }
  // base: 봉사자는 '#/vboard', 관리자는 '#/board'
  async function boardList(base) {
    const r = await api("/board");
    const list = r.posts.filter((p) => !boardCat || p.category === boardCat);
    const box = h("div", { class: "stack" });
    const draw = () => fill(box,
      h("div", { class: "page-head" }, [h("h1", { class: base === "#/vboard" ? "vol__hello" : null, text: "게시판" }), h("button", { class: "btn btn--primary page-head__end", type: "button", onclick: () => boardEditDialog(base, null, (id) => go(`${base}/${id}`)) }, [icon("plus"), "글쓰기"])]),
      h("p", { class: "muted small", text: "요청·건의·자유롭게 의견을 남겨 주세요. 비밀글은 쓴 사람과 관리자만 볼 수 있어요." }),
      h("div", { class: "seg seg--sm" }, [["", "전체"], ...Object.entries(BOARD_CAT)].map(([k, t]) => h("button", { type: "button", "aria-selected": String(boardCat === k), text: t, onclick: () => { boardCat = k; render(); } }))),
      list.length ? h("ul", { class: "notice-list" }, list.map((p) => h("li", {}, h("a", { class: "card notice-item board-item" + (p.canSee ? "" : " is-locked"), href: p.canSee ? `${base}/${p.id}` : null, "aria-disabled": p.canSee ? null : "true" }, [
        h("div", { class: "notice-item__title" }, [h("span", { class: "stock-tag", text: BOARD_CAT[p.category] }), p.secret ? h("span", { class: "board-lock", title: "비밀글", text: "🔒" }) : null, h("strong", { text: p.title })]),
        h("div", { class: "notice-item__meta muted" }, [p.author ? h("span", { text: p.author }) : null, h("span", { text: dayOf(p.createdAt) }), p.comments && p.canSee ? h("span", { class: "with-icon" }, [icon("chat"), String(p.comments)]) : null])
      ])))) : h("div", { class: "card empty", text: "아직 글이 없어요. 첫 글을 남겨 주세요." })
    );
    draw();
    return box;
  }
  async function boardPostView(base, id) {
    const r = await api(`/board/${id}`);
    const p = r.post;
    const box = h("div", { class: "stack" });
    const reload = async () => fill(box, ...(await boardPostView(base, id)).childNodes);
    const editComment = (c, li) => {
      const t = h("textarea", { rows: "2", maxlength: "1000", "aria-label": "댓글 고치기" }, c.body);
      fill(li, t, h("div", { class: "actions actions--start" }, [
        h("button", { class: "btn btn--primary btn--sm", type: "button", text: "저장", onclick: async () => { if (!t.value.trim()) return; await act(() => api(`/board-comments/${c.id}`, { method: "PATCH", body: { body: t.value } }), "댓글을 고쳤어요."); await reload(); } }),
        h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "취소", onclick: () => quiet(reload()) })]));
      t.focus();
    };
    const cIn = h("textarea", { rows: "2", maxlength: "1000", placeholder: "댓글 달기" });
    const cOk = h("button", { class: "btn btn--primary btn--sm", type: "button", text: "댓글 달기", onclick: () => busy(cOk, async () => { if (!cIn.value.trim()) return; await act(() => api(`/board/${id}/comments`, { method: "POST", body: { body: cIn.value } })); await reload(); }) });
    fill(box,
      h("a", { class: "back-link", href: base }, [icon("left"), "게시판"]),
      h("article", { class: "card notice-view stack" }, [
        h("div", { class: "notice-item__title" }, [h("span", { class: "stock-tag", text: BOARD_CAT[p.category] }), p.secret ? h("span", { class: "board-lock", text: "🔒 비밀글" }) : null]),
        h("h1", { text: p.title }),
        h("div", { class: "muted notice-item__meta" }, [h("span", { text: p.author || "-" }), h("span", { text: dayOf(p.createdAt) }), p.updatedAt !== p.createdAt ? h("span", { text: "수정됨" }) : null]),
        h("div", { class: "prose", text: p.body }),
        p.canEdit ? h("div", { class: "actions actions--start" }, [
          h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "고치기", onclick: () => boardEditDialog(base, p, () => quiet(reload())) }),
          h("button", { class: "btn btn--ghost btn--sm btn--danger-text", type: "button", text: "지우기", onclick: async () => { if (!confirm("이 글을 지울까요? 댓글도 함께 지워져요.")) return; await act(() => api(`/board/${id}`, { method: "DELETE" })); go(base); } })
        ]) : null
      ]),
      h("section", { class: "card stack", style: "padding:14px 16px" }, [
        h("h2", { class: "card__title", text: `댓글 ${r.comments.length}` }),
        r.comments.length ? h("ul", { class: "comments" }, r.comments.map((c) => h("li", { class: "comment" }, [
          h("div", { class: "comment__head muted small" }, [h("strong", { text: c.author || "-" }), c.admin ? h("span", { class: "stock-tag", text: "관리자" }) : null, h("span", { text: dayOf(c.createdAt) }),
            c.mine ? h("button", { class: "link-btn", type: "button", text: "고치기", onclick: (e) => editComment(c, e.currentTarget.closest("li")) }) : null,
            c.canDelete ? h("button", { class: "link-btn", type: "button", text: "지우기", onclick: async () => { if (!confirm("댓글을 지울까요?")) return; await act(() => api(`/board-comments/${c.id}`, { method: "DELETE" })); await reload(); } }) : null]),
          h("p", { class: "comment__body", text: c.body })
        ]))) : h("p", { class: "muted small", text: "아직 댓글이 없어요." }),
        cIn, h("div", { class: "actions actions--start" }, cOk)
      ])
    );
    return box;
  }
  async function pageBoard(id) {
    if (!isAdmin()) return go("#/today");
    document.title = `게시판 · ${TITLE}`;
    drawMini(null);
    setMain("board", loading());
    page = { name: "board", reload: async () => setMain("board", h("div", { class: "narrow" }, id ? await boardPostView("#/board", Number(id)) : await boardList("#/board"))) };
    try { await page.reload(); } catch (e) { if (e.status !== 401) setMain("board", failed(e)); }
  }

  /* ---------- 봉사자 관리 (관리자): 일정·기본 교육 등록, 이수 현황 ---------- */
  // ---- 검수 기록 화면: 관리자 '봉사자 관리 › 검수 관리'와 팀 봉사자 '검수'가 같이 씀. base 는 "/admin" 또는 "/team"
  const REWORK_LABEL = { "": "정하지 않음", return: "수도회로 반송", fix: "현장 재작업", hold: "보관", discard: "폐기" };
  function inspModule(base, redraw, intro) {
    let insp = null; // { groups, types, inspections }
    const inspFilter = { from: "", to: "", stage: "", item: "" };
    // ---- 검수 관리 (관리자 전용): 1차 수도회 자체 · 2차 외부 봉사자 · 3차 부서 봉사자, 불량 유형별 수량·사진, 클레임용 CSV·인쇄
    const STAGE_LABEL = { 1: "1차 · 수도회 자체", 2: "2차 · 외부 봉사자", 3: "3차 · 부서 봉사자" };
    const inspPhotoCache = new Map();
    const inspPhotoUrl = (pid) => { if (!inspPhotoCache.has(pid)) inspPhotoCache.set(pid, fetch(`${API}${base}/inspection-photos/${pid}`, { headers: { Authorization: "Bearer " + state.token } }).then((r) => (r.ok ? r.blob() : null)).then((b) => (b ? URL.createObjectURL(b) : null)).catch(() => null)); return inspPhotoCache.get(pid); };
    const inspImg = (pid) => { const img = h("img", { class: "move-photo", alt: "검수 사진" }); inspPhotoUrl(pid).then((u) => { if (u) img.src = u; }); return img; };
    const inspShown = () => (insp?.inspections || []).filter((x) => (!inspFilter.from || x.date >= inspFilter.from) && (!inspFilter.to || x.date <= inspFilter.to) && (!inspFilter.stage || String(x.stage) === inspFilter.stage) && (!inspFilter.item || String(x.itemId) === inspFilter.item));
    const rate = (bad, n) => (n ? `${((bad / n) * 100).toFixed(1)}%` : "-");
    let links = null; // { groups, waiting } 검수 조·회수 건 고르기 (F05)
    const dname = (t) => insp?.criteria?.items?.find((i) => i.defectKey === t)?.defectName || t;
    // 저장 전에: 샘플 수·불량 합계가 검수 수량보다 많은지 (샘플 검수면 불량의 기준은 샘플 수). 고칠 때는 이 값들이 바뀌었을 때만
    const inspCheck = (b, x) => {
      const total = Object.values(b.defects).reduce((a, n) => a + (Number(n) || 0), 0), checked = Number(b.checkedQty) || 0, bySample = b.sampled && b.sampleQty !== "", sample = Number(b.sampleQty) || 0;
      if (x && checked === x.checkedQty && !!b.sampled === x.sampled && (bySample ? sample : null) === (x.sampleQty ?? null) && total === x.defectTotal) return "";
      if (bySample && sample > checked) return `샘플 수(${sample})가 검수 수량(${checked})보다 많아요.`;
      return total > (bySample ? sample : checked) ? `불량 합계(${total})가 ${bySample ? "샘플 수" : "검수 수량"}(${bySample ? sample : checked})보다 많아요.` : "";
    };
    function inspDialog(x, preset = {}) {
      const err = errorLine();
      const group = h("select", {}, insp.groups.map((g) => h("option", { value: String(g.id), text: g.name })));
      if (x) group.value = String(x.itemId);
      const stage = h("select", {}, [1, 2, 3].map((k) => h("option", { value: String(k), text: STAGE_LABEL[k] })));
      stage.value = String(x?.stage || 3);
      const date = h("input", { type: "date", value: x?.date || today() });
      const source = h("input", { value: x?.source || preset.source || "", maxlength: "80", placeholder: "예: ○○수녀회, 대건상사 11/13 입고" });
      const checked = h("input", { type: "number", min: "0", inputmode: "numeric", value: x ? String(x.checkedQty) : preset.checkedQty ?? "" });
      const grpSel = links ? h("select", {}, [h("option", { value: "", text: "검수 조 (선택)" }), ...links.groups.map((g) => h("option", { value: String(g.id), text: g.name + (g.mine ? " · 내 조" : "") }))]) : null;
      if (grpSel) grpSel.value = String(x?.groupId ?? (links.groups.find((g) => g.mine)?.id || ""));
      const recOpts = links ? [...links.waiting, ...(x?.recoveryId && !links.waiting.some((w) => w.id === x.recoveryId) ? [{ id: x.recoveryId, org: "이어진 회수 건", date: "" }] : [])] : [];
      const recSel = links ? h("select", {}, [h("option", { value: "", text: "회수 건 (선택)" }), ...recOpts.map((w) => h("option", { value: String(w.id), text: `${w.date ? `${shortDate(w.date)} · ` : ""}${w.org}${w.qty != null ? ` · ${fmtN(w.qty - (w.checked || 0))}개 남음` : ""}` }))]) : null;
      if (recSel) recSel.value = String(x?.recoveryId ?? preset.recoveryId ?? "");
      recSel?.addEventListener("change", () => { const w = links.waiting.find((y) => String(y.id) === recSel.value); if (w && !source.value) source.value = w.org; });
      const sampled = h("input", { type: "checkbox", checked: !!x?.sampled });
      const sampleQty = h("input", { type: "number", min: "0", inputmode: "numeric", value: x?.sampleQty ?? "", placeholder: "샘플 수" });
      const defIn = insp.types.map((t) => ({ t, el: h("input", { type: "number", min: "0", inputmode: "numeric", value: x?.defects?.[t] ?? "", "aria-label": `${dname(t)} 불량 수량` }) }));
      const note = h("textarea", { rows: "2", maxlength: "500" }, x?.note || "");
      const rework = h("select", {}, Object.entries(REWORK_LABEL).map(([v, t]) => h("option", { value: v, text: t })));
      rework.value = x?.rework || "";
      const pending = []; let kept = x ? [...x.photos] : [];
      const photoBox = h("div", { class: "move-photos" });
      const fileIn = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp", multiple: true, hidden: true });
      const drawPhotos = () => photoBox.replaceChildren(
        ...kept.map((pid) => h("span", { class: "move-photos__item" }, [inspImg(pid), x.delPhotos.includes(pid) ? h("button", { class: "move-photos__x", type: "button", "aria-label": "사진 지우기", html: ICON.close, onclick: async () => { if (!confirm("이 사진을 지울까요?")) return; insp.inspections = (await act(() => api(`${base}/inspection-photos/${pid}`, { method: "DELETE" }))).inspections; kept = kept.filter((p) => p !== pid); drawPhotos(); } }) : null])),
        ...pending.map((b, i) => h("span", { class: "move-photos__item is-new" }, [h("img", { class: "move-photo", alt: "올릴 사진", src: URL.createObjectURL(b) }), h("button", { class: "move-photos__x", type: "button", "aria-label": "빼기", html: ICON.close, onclick: () => { pending.splice(i, 1); drawPhotos(); } })]))
      );
      fileIn.addEventListener("change", async () => { for (const f of [...fileIn.files]) { if (kept.length + pending.length >= 4) break; try { pending.push(await shrinkImage(f)); } catch (ex) { showError(err, ex.message); } } fileIn.value = ""; drawPhotos(); });
      drawPhotos();
      const ok = h("button", { class: "btn btn--primary", type: "submit", text: x ? "저장" : "추가" });
      const form = h("form", { class: "stack", novalidate: true }, [
        h("div", { class: "row2" }, [field("묶음", group), field("검수 단계", stage)]),
        h("div", { class: "row2" }, [field("검수일", date), field("대상 (수도회·업체·입고 건)", source)]),
        links ? h("div", { class: "row2" }, [field("검수 조", grpSel), field("회수 건 (검수 대기)", recSel, "고르면 그 수도회 물량과 이어져요")]) : null,
        h("div", { class: "row2" }, [field("검수 수량", checked), h("div", { class: "field" }, [h("span", { class: "field__label", text: "샘플링 검수" }), h("label", { class: "check" }, [sampled, h("span", { text: "샘플링으로 검수했어요" })]), sampleQty])]),
        h("div", { class: "field" }, [h("span", { class: "field__label", text: "불량 유형별 수량" }), h("div", { class: "insp-defects" }, defIn.map((d) => h("label", { class: "stock-grid__cell" }, [h("span", { class: "small", text: dname(d.t) }), d.el])))]),
        h("div", { class: "row2" }, [field("불합격품 처리", rework, "수도회로 돌려보낼지, 현장에서 고칠지"), field("메모 (선택)", note)]),
        h("div", { class: "field" }, [h("span", { class: "field__label", text: "사진 (선택, 4장까지, 불량 근거)" }), photoBox, h("div", {}, [h("button", { class: "btn btn--ghost btn--sm", type: "button", onclick: () => fileIn.click() }, [icon("plus"), "사진 추가"]), fileIn])]),
        err,
        h("div", { class: "actions" }, [
          x?.canDelete ? h("button", { class: "btn btn--danger-outline btn--sm", type: "button", text: "지우기", onclick: async () => { if (!confirm("이 검수 기록과 사진을 지울까요?")) return; insp.inspections = (await act(() => api(`${base}/inspections/${x.id}`, { method: "DELETE" }))).inspections; closeDialog(); redraw(); } }) : null,
          h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), ok
        ])
      ]);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        busy(ok, async () => {
          try {
            const body = { ...(links ? { groupId: grpSel.value || null, recoveryId: recSel.value || null } : {}), itemId: Number(group.value), stage: Number(stage.value), date: date.value, source: source.value, checkedQty: checked.value, sampled: sampled.checked, sampleQty: sampleQty.value, defects: Object.fromEntries(defIn.map((d) => [d.t, d.el.value])), note: note.value, rework: rework.value };
            const bad = inspCheck(body, x);
            if (bad) return showError(err, bad);
            let r = await apiAsk(x ? `${base}/inspections/${x.id}` : `${base}/inspections`, { method: x ? "PATCH" : "POST", body });
            if (!r) return;
            const id = x ? x.id : r.id;
            for (const b of pending) r = await api(`${base}/inspections/${id}/photos`, { method: "POST", body: { data: await blobToBase64(b) } });
            insp.inspections = r.inspections; closeDialog(); toast("검수 기록을 저장했어요."); if (links) links.waiting = (await api("/ops/inspect-waiting").catch(() => links)).waiting; redraw(true);
          } catch (ex) { showError(err, ex.message); }
        });
      });
      openDialog(x ? "검수 기록 고치기" : "검수 기록 추가", form, { admin: base === "/admin", wide: true });
    }
    // 클레임용: 지금 거른 기록을 CSV 로 (엑셀 수식 실행 막음)
    function inspCsv() {
      const rows = inspShown();
      const esc = (raw) => { const v = /^[=+\-@\t\r]/.test(String(raw)) ? `'${raw}` : String(raw); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
      const lines = [["검수일", "묶음", "단계", "대상", "검수 수량", "샘플링", "샘플 수", ...insp.types, "불량 합계", "불량률", "불합격품 처리", "메모", "사진 수", "입력자"]];
      for (const x of rows) lines.push([x.date, x.group, STAGE_LABEL[x.stage], x.source, x.checkedQty, x.sampled ? "예" : "", x.sampleQty ?? "", ...insp.types.map((t) => x.defects[t] || 0), x.defectTotal, rate(x.defectTotal, x.sampleQty || x.checkedQty), x.rework ? REWORK_LABEL[x.rework] : "", x.note, x.photos.length, x.author]);
      const blob = new Blob(["\ufeff" + lines.map((r) => r.map(esc).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
      const a = h("a", { href: URL.createObjectURL(blob), download: `검수기록_${inspFilter.from || "처음"}_${inspFilter.to || today()}.csv` });
      document.body.append(a); a.click(); a.remove();
    }
    // 클레임용 인쇄: 새 창에 표와 사진을 넣고 인쇄 창을 엶
    async function inspPrint() {
      const rows = inspShown();
      const w = window.open("", "_blank");
      if (!w) return toast("팝업이 막혀 있어요. 브라우저에서 팝업을 허용해 주세요.");
      const toData = (pid) => inspPhotoUrl(pid).then((u) => (u ? fetch(u).then((r) => r.blob()).then((b) => new Promise((ok) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.readAsDataURL(b); })) : ""));
      const escH = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
      const imgs = await Promise.all(rows.map((x) => Promise.all(x.photos.map(toData))));
      const sum = rows.reduce((n, x) => n + x.defectTotal, 0), cnt = rows.reduce((n, x) => n + (x.sampleQty || x.checkedQty), 0);
      w.document.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>검수 기록 (클레임 근거)</title><style>body{font-family:system-ui,sans-serif;font-size:12px;margin:24px}h1{font-size:18px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:4px 6px;vertical-align:top}th{background:#eee}img{width:110px;height:110px;object-fit:cover;margin:2px;border:1px solid #ccc}.r{text-align:right}</style></head><body>
        <h1>검수 기록 (클레임 근거)</h1><p>기간: ${escH(inspFilter.from || "처음")} ~ ${escH(inspFilter.to || today())} · ${escH(inspFilter.stage ? STAGE_LABEL[inspFilter.stage] : "전체 단계")} · ${rows.length}건 · 불량 합계 ${sum} / 검수 ${cnt} (${rate(sum, cnt)}) · 출력 ${escH(today())}</p>
        <table><thead><tr><th>검수일</th><th>묶음</th><th>단계</th><th>대상</th><th>검수(샘플)</th>${insp.types.map((t) => `<th>${escH(t)}</th>`).join("")}<th>불량</th><th>메모</th></tr></thead><tbody>
        ${rows.map((x, i) => `<tr><td>${escH(x.date)}</td><td>${escH(x.group)}</td><td>${escH(STAGE_LABEL[x.stage])}</td><td>${escH(x.source)}</td><td class="r">${x.checkedQty}${x.sampled ? ` (샘플 ${x.sampleQty ?? "-"})` : ""}</td>${insp.types.map((t) => `<td class="r">${x.defects[t] || ""}</td>`).join("")}<td class="r">${x.defectTotal} (${rate(x.defectTotal, x.sampleQty || x.checkedQty)})</td><td>${escH(x.note)}</td></tr>${imgs[i].filter(Boolean).length ? `<tr><td colspan="${7 + insp.types.length}">${imgs[i].filter(Boolean).map((src) => `<img src="${src}" alt="">`).join("")}</td></tr>` : ""}`).join("")}
        </tbody></table></body></html>`);
      w.document.close();
      setTimeout(() => w.print(), 400);
    }
    function inspView() {
      if (!insp) return loading();
      const rows = inspShown();
      const sel = (key, opts, label) => { const s2 = h("select", { "aria-label": label }, [h("option", { value: "", text: label }), ...opts.map(([v, t]) => h("option", { value: String(v), text: t }))]); s2.value = inspFilter[key]; s2.addEventListener("change", () => { inspFilter[key] = s2.value; redraw(); }); return s2; };
      const dIn = (key, label) => { const d = h("input", { type: "date", value: inspFilter[key], "aria-label": label }); d.addEventListener("change", () => { inspFilter[key] = d.value; redraw(); }); return d; };
      const byStage = [1, 2, 3].map((k) => { const l = rows.filter((x) => x.stage === k); const n = l.reduce((a, x) => a + (x.sampleQty || x.checkedQty), 0), bad = l.reduce((a, x) => a + x.defectTotal, 0); return h("div", { class: "card unit-stat" }, [h("strong", { text: rate(bad, n) }), h("span", { text: `${STAGE_LABEL[k]} · 불량 ${fmtN(bad)} / ${fmtN(n)}` })]); });
      const typeSum = insp.types.map((t) => [dname(t), rows.reduce((a, x) => a + (x.defects[t] || 0), 0)]).filter(([, v]) => v);
      return h("div", { class: "stack" }, [
        h("p", { class: "muted small", text: intro }),
        h("div", { class: "filters" }, [dIn("from", "시작일"), h("span", { class: "muted", text: "~" }), dIn("to", "끝일"), sel("stage", [1, 2, 3].map((k) => [k, STAGE_LABEL[k]]), "모든 단계"), sel("item", insp.groups.map((g) => [g.id, g.name]), "모든 묶음"),
          h("span", { class: "filters__end actions" }, [h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "CSV 내려받기", disabled: !rows.length, onclick: inspCsv }), h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "인쇄 (클레임용)", disabled: !rows.length, onclick: () => quiet(inspPrint()) })])]),
        h("div", { class: "unit-stats" }, byStage),
        typeSum.length ? h("p", { class: "small" }, ["불량 유형: ", typeSum.map(([t, v]) => `${t} ${fmtN(v)}`).join(" · ")]) : null,
        rows.length ? h("div", { class: "card table-wrap" }, h("table", { class: "table" }, [
          h("thead", {}, h("tr", {}, ["검수일", "묶음", "단계", "대상", "검수 수량", "불량", "불량률", "처리", "사진", "입력자"].map((t2) => h("th", { text: t2 })))),
          h("tbody", {}, rows.map((x) => h("tr", { class: "stock-row", tabindex: "0", onclick: () => inspDialog(x), onkeydown: (e) => { if (e.key === "Enter") inspDialog(x); } }, [
            h("td", { class: "nowrap", text: x.date }), h("td", { text: x.group }), h("td", { class: "nowrap", text: STAGE_LABEL[x.stage] }), h("td", { text: x.source || "-" }),
            h("td", { class: "num nowrap", text: `${fmtN(x.checkedQty)}${x.sampled ? ` (샘플 ${x.sampleQty ?? "-"})` : ""}` }),
            h("td", { class: "num nowrap move-issue", title: Object.entries(x.defects).map(([k, v]) => `${k} ${v}`).join(", "), text: x.defectTotal ? fmtN(x.defectTotal) : "-" }),
            h("td", { class: "num", text: rate(x.defectTotal, x.sampleQty || x.checkedQty) }), h("td", { class: "nowrap", text: x.rework ? REWORK_LABEL[x.rework] : "-" }), h("td", { class: "num", text: x.photos.length ? `${x.photos.length}장` : "-" }), h("td", { class: "muted small", text: x.author || "-" })
          ])))
        ])) : h("div", { class: "card empty", text: (insp.inspections || []).length ? "조건에 맞는 검수 기록이 없어요." : "아직 검수 기록이 없어요. '검수 기록'을 눌러 추가해 주세요." })
      ]);
    }
    return { load: async () => {
      insp = await api(`${base}/inspections`);
      try { const [g, w] = await Promise.all([api("/ops/groups"), api("/ops/inspect-waiting")]); links = { groups: g.groups.filter((x) => x.active), waiting: w.waiting }; } catch (e) { links = null; }
    }, view: inspView, dialog: inspDialog, data: () => insp };
  }
  /* ---------- 봉사자 단계형 메뉴 (DB 설계 v2 1차): 카테고리 안에서 번호 매긴 단계, 한 화면에 한 가지 일 ----------
     관리자는 '봉사자 관리'에서 미리보기로 먼저 보고, 봉사자에게는 '메뉴 공개'의 '단계형 메뉴'를 켜야 보임 */
  const STEP_CATS = {
    team: [
      { key: "edu", name: "교육", icon: "people", steps: [["tedu1", "수도회 확인"], ["tedu2", "교육 일정·결과"]] },
      { key: "make", name: "제작·회수", icon: "db", steps: [["tmake1", "제작 진행"], ["tmake2", "회수"]] },
      { key: "ins", name: "검수", icon: "check", steps: [["tins1", "검수 기준 보기"], ["tins2", "내 조·봉사일 확인"], ["tins3", "검수 입력"], ["tins4", "불량 처리"], ["tins5", "하루 봉사 기록"]] }
    ],
    dept: [
      { key: "recv", name: "받기", icon: "db", steps: [["dr1", "택배 수신"], ["dr2", "입고"]] },
      { key: "send", name: "보내기", icon: "db", steps: [["ds1", "추가 전달 물량 확인"], ["ds2", "출고"], ["ds3", "택배 발송"]] },
      { key: "fin", name: "완제품", icon: "check", steps: [["df1", "회수품 받기"], ["df2", "손십자가 제품 관리"]] }
    ]
  };
  const STEP_TABS = [...STEP_CATS.team, ...STEP_CATS.dept].flatMap((c) => c.steps.map((s) => s[0]));
  const stepOf = (tab) => {
    for (const k of ["team", "dept"]) for (const c of STEP_CATS[k]) { const i = c.steps.findIndex((s) => s[0] === tab); if (i >= 0) return { cat: c, i }; }
    return null;
  };
  const stepsOn = () => !!state.volPreview || volOn("steps2");
  // 관리자 미리보기: 봉사자 화면을 관리자 계정으로 열어 봄 (이 브라우저 탭에서만)
  function startVolPreview(kind, to) {
    state.volPreview = kind; state.opsCounts = null; state.chg = null; state.chgKey = "";
    try { sessionStorage.setItem("ps.volPreview", kind); } catch (e) { /* 저장 못 해도 이번만 */ }
    const hash = to || (kind === "team" ? "#/thome" : "#/vhome");
    if (location.hash !== hash) location.hash = hash; else render();
  }
  function endVolPreview() {
    state.volPreview = ""; state.opsCounts = null; state.opsRefresh = null; state.chg = null; state.chgKey = ""; state.drawVolNav = null;
    try { sessionStorage.removeItem("ps.volPreview"); } catch (e) { /* 무시 */ }
    closePop(); closeDialog();
    location.hash = "#/volunteers";
    render();
  }
  // 단계 화면 틀: 위에 카테고리 단계 진행 표시, 아래에 [다음 단계 →]
  function stepFrame(tab, kids, team) {
    const st = stepOf(tab);
    if (!st) return kids;
    const { cat, i } = st, c = state.opsCounts || {};
    const n = c[tab] || 0, next = cat.steps[i + 1];
    return [
      h("nav", { class: "stepbar", "aria-label": `${cat.name} 단계` }, [
        h("span", { class: "stepbar__cat" }, [icon(cat.icon), cat.name]),
        h("ol", {}, cat.steps.map(([k, label], j) => h("li", {}, h("a", { class: "stepbar__step" + (j === i ? " is-active" : "") + (j < i ? " is-past" : ""), href: `#/${k}`, "aria-current": j === i ? "step" : null, title: label }, [
          h("span", { class: "stepbar__num", text: String(j + 1) }), h("span", { class: "stepbar__label", text: label }), j === i ? null : chgBadge(chgN(k))
        ]))))
      ]),
      h("h1", { class: "vol__hello stepbar__title" }, [`${i + 1}. ${cat.steps[i][1]}`, n ? h("span", { class: "stepbar__todo", text: `처리할 일 ${n}건` }) : null]),
      ...[].concat(kids),
      h("div", { class: "stepbar__next" }, next
        ? (n ? h("p", { class: "muted small", text: `이 단계에서 처리할 일이 ${n}건 남았어요. 다 하면 다음 단계로 넘어가요.` }) : h("a", { class: "btn btn--primary", href: `#/${next[0]}` }, `다음 단계 → ${i + 2}. ${next[1]}`))
        : h("a", { class: "btn btn--ghost", href: team ? "#/thome" : "#/vhome" }, n ? `처리할 일 ${n}건 · 홈으로` : `${cat.name} 단계를 다 봤어요 · 홈으로`))
    ];
  }
  // 홈: 카테고리마다 지금 할 단계만 카드로
  async function opsHome(team) {
    document.title = `오늘 할 일 · ${TITLE}`;
    const c = state.opsCounts || {};
    const cats = STEP_CATS[team ? "team" : "dept"];
    const card = (cat) => {
      const idx = cat.steps.findIndex(([k]) => c[k]);
      const [k, label] = cat.steps[idx >= 0 ? idx : 0];
      return h("a", { class: "card ops-home__card" + (idx >= 0 ? " is-todo" : ""), href: `#/${k}` }, [
        h("span", { class: "ops-home__cat" }, [icon(cat.icon), cat.name]),
        h("strong", { text: `${(idx >= 0 ? idx : 0) + 1}. ${label}` }),
        h("span", { class: "small " + (idx >= 0 ? "ops-home__todo" : "muted"), text: idx >= 0 ? `처리할 일 ${c[k]}건` : "지금 처리할 일이 없어요. 1단계부터 둘러볼 수 있어요." })
      ]);
    };
    const tc = team ? await teamHomeCards() : null; // 팀 봉사자: 다가오는 교육 → 봉사 가능 신청 → 오늘 할 일
    return [
      tc ? h("div", { class: "stack ops-home__team" }, [tc.eduCard, tc.availCard]) : null,
      h("h1", { class: "vol__hello", text: "오늘 할 일" }),
      h("p", { class: "muted small", text: "카테고리마다 지금 할 단계를 모았어요. 누르면 그 단계로 가고, 단계를 마치면 [다음 단계 →]가 보여요." }),
      c.followups ? h("a", { class: "card ops-home__card is-todo", href: "#/vcontacts" }, [h("span", { class: "ops-home__cat" }, [icon("bell"), "연락 후속 조치"]), h("strong", { text: `기한이 된 후속 조치 ${c.followups}건` }), h("span", { class: "small ops-home__todo", text: "연락 기록에서 처리해요" })]) : null,
      h("div", { class: "ops-home" }, cats.map(card))
    ];
  }
  // ---- 작은 도구: 숫자 칸 · 카드 목록 · 아래에서 올라오는 입력 판 · 고르기
  const vmStat = (t, n, warn) => h("div", { class: "vm-stat" + (warn ? " is-warn" : "") }, [h("span", { text: t }), h("strong", { text: fmtN(n) })]);
  const opsCards = (items, render, empty) => (items.length ? h("ul", { class: "vm-list" }, items.map((x) => h("li", {}, render(x)))) : h("div", { class: "card empty", text: empty }));
  const opsCard = (onclick, kids, cls) => h(onclick ? "button" : "div", { type: onclick ? "button" : null, class: "vm-card" + (cls ? ` ${cls}` : ""), onclick }, kids);
  const opsTop = (left, right) => h("span", { class: "vm-card__top" }, [h("strong", { class: "vm-card__date", text: left }), right ? h("strong", { class: "vm-card__qty", text: right }) : null]);
  const opsLine = (t) => (t ? h("span", { class: "vm-card__parts small", text: t }) : null);
  const opsTags = (...tags) => { const t = tags.filter(Boolean); return t.length ? h("span", { class: "vm-card__tags" }, t) : null; };
  const opsTag = (t, cls) => h("span", { class: `vm-tag ${cls || ""}`, text: t });
  const opsSel = (pairs, value, first) => { const s = h("select", {}, [first != null ? h("option", { value: "", text: first }) : null, ...pairs.map(([v, t]) => h("option", { value: String(v), text: t }))].filter(Boolean)); s.value = value == null ? "" : String(value); return s; };
  const opsSeg = (pairs, cur, pick) => h("div", { class: "vm-seg", role: "tablist" }, pairs.map(([k, t]) => h("button", { type: "button", role: "tab", "aria-selected": String(k === cur), text: t, onclick: () => pick(k) })));
  const opsAddBtn = (label, onclick) => h("button", { class: "btn btn--primary vm-add vm-add--in", type: "button", onclick }, [icon("plus"), label]);
  function opsSheet(title, fields, { save, del, saveText = "저장하기", tone, ask } = {}) {
    const err = errorLine();
    const ok = h("button", { class: "btn btn--primary", type: "submit", text: saveText });
    const form = h("form", { class: "vm-form", novalidate: true }, [...fields.filter(Boolean), h("div", { class: "vm-foot" }, [err, h("div", { class: "vm-foot__btns" }, [
      del ? h("button", { class: "btn btn--danger-outline", type: "button", text: "지우기", onclick: async () => { try { if (await del() !== false) closeDialog(); } catch (ex) { showError(err, ex.message); } } }) : null,
      save ? ok : h("button", { class: "btn btn--ghost", type: "button", text: "닫기", "data-close": true })
    ])])]);
    form.addEventListener("submit", (e) => { e.preventDefault(); if (!save) return; if (ask && !confirm(ask)) return; busy(ok, async () => { try { if (await save() !== false) closeDialog(); } catch (ex) { showError(err, ex.message); } }); });
    openDialog(title, form, { tone });
  }
  // 누르면 아래 목록이 바뀌는 칸 (수도회 확인·교육)
  const pickTile = (label, n, unit, on, onclick, warn) => h("button", { type: "button", class: "pick-tile" + (on ? " is-on" : "") + (warn && n ? " is-warn" : ""), "aria-pressed": String(on), onclick }, [h("span", { text: label }), h("strong", { text: `${fmtN(n)}${unit}` })]);
  // 알림에서 눌러 온 기록 열기: 화면을 다 그린 뒤 그 기록을 찾아 열고, 없으면 안내
  const REF_GONE = "그 기록을 찾을 수 없어요. 지워졌거나 지금은 볼 수 없는 기록이에요.";
  function openRef(topic, find, open) {
    const r = state.openRef;
    if (!r || ![].concat(topic).includes(r.topic)) return;
    state.openRef = null;
    const x = find(r.id);
    setTimeout(() => { if (x) open(x); else toast(REF_GONE); }, 60);
  }
  // 여는 창이 없는 목록: data-ref 를 단 줄로 가서 잠깐 밝게 (접힌 칸은 펼침). 한동안 못 찾으면 안내
  function seekRef() {
    const r = state.openRef, hash = location.hash, until = Date.now() + 6000;
    const tick = () => {
      if (state.openRef !== r) return;
      if (location.hash !== hash) { state.openRef = null; return; }
      let el = document.querySelector(`main [data-ref~="${r.topic}:${r.id}"]`); if (el?.hidden) el = el.parentElement;
      if (el) { state.openRef = null; return flashEl(el); }
      if (Date.now() > until) { state.openRef = null; return toast(REF_GONE); }
      setTimeout(tick, 150);
    };
    setTimeout(tick, 250);
  }
  function flashEl(el) {
    for (let p = el.parentElement; p; p = p.parentElement) if (p.tagName === "DETAILS") p.open = true;
    el.scrollIntoView({ block: "center" });
    el.classList.add("is-flash");
    setTimeout(() => el.classList.remove("is-flash"), 2600);
  }
  const flashRef = (topic, id) => { let el = document.querySelector(`main [data-ref~="${topic}:${id}"]`); if (el?.hidden) el = el.parentElement; if (el) flashEl(el); else toast(REF_GONE); };
  // ---- 알림 (변경 내역): 누가 · 언제 · 무엇을 · 어떻게. 누르면 그 화면의 그 기록으로
  const CHG_ACT = { add: "추가", edit: "고침", delete: "지움" };
  const NO_REF = ["criteria", "need", "stockops"]; // 기록 하나가 아니라 화면 전체인 것
  function openChange(c) {
    let link = c.link;
    if (c.topic === "board" && c.refId && c.action !== "delete") link = `${link}/${c.refId}`;
    state.openRef = null;
    const hash = `#/${link}`;
    if (c.action === "delete") toast("지운 기록이에요. 그 화면으로 왔어요.");
    else if (c.refId && !NO_REF.includes(c.topic) && !["board", "proj", "ledger"].includes(c.topic)) state.openRef = { topic: c.topic, id: c.refId, ledgerId: c.ledgerId };
    if (hash.startsWith("#/projects/")) state.openRef = null; // 프로젝트 화면까지만
    const ref = state.openRef;
    // 관리자 화면이 따로 없는 팀 기록은 '팀 봉사자 화면 미리보기'로 엶
    const pre = isAdmin() && !state.volPreview && { recovery: "tmake2", shifts: "tins2", daily: "tins5", made: "tmake1", need: "thome" }[c.topic];
    if (pre) { startVolPreview("team", `#/${pre}`); toast("팀 봉사자 화면 미리보기로 열었어요."); if (ref) setTimeout(() => { if (state.openRef === ref) seekRef(); }, 50); return; }
    go(hash);
    if (ref) setTimeout(() => { if (state.openRef === ref) seekRef(); }, 50);
  }
  async function alertsView() {
    let topic = "", only = false, d = await api(`/changes${chgAs()}`), list = d.changes;
    const box = h("div", { class: "stack alerts" });
    const q = (before) => `/changes?${new URLSearchParams({ ...(state.volPreview ? { as: state.volPreview } : {}), ...(topic ? { topic } : {}), ...(only ? { unread: "1" } : {}), ...(before ? { before: String(before) } : {}) })}`;
    const reload = async () => { d = await act(() => api(q())); list = d.changes; draw(); };
    const when = (s) => { const t = new Date(s.replace(" ", "T") + "Z"); return `${pad(t.getHours())}:${pad(t.getMinutes())}`; };
    const item = (c) => h("li", {}, h("button", { type: "button", class: "alert" + (c.unread ? " is-new" : ""), onclick: () => openChange(c) }, [
      h("span", { class: "alert__top" }, [c.unread ? h("span", { class: "alert__dot", "aria-label": "안 읽음" }) : null, h("span", { class: "vm-tag", text: c.label }), h("strong", { class: "alert__title", text: c.title }), h("span", { class: `alert__act is-${c.action}`, text: CHG_ACT[c.action] })]),
      c.detail ? h("span", { class: "alert__detail", text: c.detail }) : null,
      h("span", { class: "alert__meta muted small", text: `${c.mine ? "나" : c.who} · ${when(c.at)} (${ago(c.at)})` })
    ]));
    const draw = () => {
      const days = new Map();
      for (const c of list) { const k = dayOf(c.at); if (!days.has(k)) days.set(k, []); days.get(k).push(c); }
      const total = Object.values(d.counts).reduce((n, x) => n + x, 0);
      fill(box,
        h("div", { class: "page-head" }, [h("h1", { class: layout.main ? null : "vol__hello", text: "알림" }), h("button", { class: "btn btn--ghost btn--sm page-head__end", type: "button", disabled: !total, text: "모두 읽음", onclick: async () => { const r = await act(() => api(`/changes/seen${chgAs()}`, { method: "POST", body: { menu: "*" } })); setChg(r); await reload(); } })]),
        h("p", { class: "muted small", text: `누가 무엇을 바꿨는지 최신순으로 보여요(${d.keepDays}일 동안). 누르면 그 기록으로 가요. 메뉴 옆 숫자는 그 메뉴의 안 본 변경 수이고, 그 메뉴를 열면 사라져요.` }),
        h("div", { class: "filters" }, [
          opsSeg([["all", "전체"], ["new", `안 읽음 ${total}`]], only ? "new" : "all", (k) => { only = k === "new"; quiet(reload()); }),
          (() => { const s2 = opsSel(d.topics.map((t) => [t.key, t.label]), topic, "모든 종류"); s2.setAttribute("aria-label", "종류 고르기"); s2.addEventListener("change", () => { topic = s2.value; quiet(reload()); }); return s2; })()]),
        ...(list.length ? [...days].map(([k, rows]) => h("section", { class: "stack stack--sm" }, [h("h2", { class: "alerts__day", text: k === today() ? `오늘 · ${volDay(k)}` : volDay(k) }), h("ul", { class: "card alerts__list" }, rows.map(item))])) : [h("div", { class: "card empty", text: only ? "안 읽은 변경이 없어요." : topic ? "이 종류의 변경이 아직 없어요." : "아직 변경 내역이 없어요. 이 기능을 연 뒤의 변경부터 쌓여요." })]),
        d.more ? h("button", { class: "btn btn--ghost", type: "button", text: "더 보기", onclick: async () => { const r = await act(() => api(q(list[list.length - 1].id))); list = [...list, ...r.changes]; d.more = r.more; draw(); } }) : null);
    };
    draw();
    return [box];
  }
  async function pageAlerts() {
    document.title = `알림 · ${TITLE}`;
    drawMini(null);
    setMain("alerts", loading());
    let body;
    try { body = await alertsView(); } catch (e) { if (e.status === 401) return; body = [failed(e)]; }
    if (route().name === "alerts") setMain("alerts", body);
  }
  const opsHint = (t) => h("p", { class: "muted small", text: t });
  const nospace = (s) => String(s || "").replace(/\s/g, "");
  // ---- F01 수도회 확인
  const MON_STATUS = { new: "등록", edu_done: "교육 완료", making: "제작 중", recovered: "회수 완료", checked: "검수 완료", issue: "문제 있음" };
  async function opsMonasteries() {
    document.title = `수도회 확인 · ${TITLE}`;
    let d = await api("/ops/monasteries"), qv = "", view = "all";
    const box = h("div", { class: "vm" });
    const byName = (a, b) => a.name.localeCompare(b.name, "ko");
    const DONE = ["edu_done", "making", "recovered", "checked"];
    // 위 칸을 누르면 아래 목록이 그 조건으로 거르고 정렬됨
    const VIEWS = {
      all: { label: "전체 수도회", hint: "가나다순이에요.", pick: () => true, sort: byName },
      done: { label: "교육 진행 완료", hint: "교육을 마친 뒤 단계(교육 완료·제작 중·회수 완료·검수 완료)예요. 최근 교육부터 보여요.", pick: (m) => DONE.includes(m.status), sort: (a, b) => b.lastEdu.localeCompare(a.lastEdu) || byName(a, b) },
      todo: { label: "미진행·진행 필요", hint: "아직 '등록'인 수도회예요. 교육 날짜가 가까운 곳부터 보여요.", pick: (m) => m.status === "new", sort: (a, b) => (a.nextEdu || "9").localeCompare(b.nextEdu || "9") || byName(a, b) },
      issue: { label: "문제 있음", hint: "문제가 있다고 적은 수도회예요.", pick: (m) => m.status === "issue", sort: byName },
      added: { label: "추가된 수도회", hint: "새로 추가한 수도회예요. 최근에 추가한 곳부터 보여요.", pick: (m) => !!m.addedAt, sort: (a, b) => b.addedAt.localeCompare(a.addedAt) }
    };
    const when = (at) => { const t = new Date(`${at.replace(" ", "T")}Z`); return `${t.getMonth() + 1}/${t.getDate()} ${pad(t.getHours())}:${pad(t.getMinutes())}`; };
    const draw = () => {
      const all = d.monasteries, v = VIEWS[view];
      const search = h("input", { type: "search", placeholder: "수도회 이름 검색", "aria-label": "수도회 검색", value: qv });
      search.addEventListener("input", () => { qv = search.value.trim(); drawList(); });
      const listBox = h("div"), count = h("span", { class: "muted small filters__end" });
      const drawList = () => {
        const list = all.filter((m) => v.pick(m) && (!qv || nospace(m.name).includes(nospace(qv)))).sort(v.sort);
        count.textContent = `${list.length}곳`;
        fill(listBox, opsCards(list, (m) => opsCard(() => edit(m), [
          opsTop(m.name, MON_STATUS[m.status]),
          view === "added" ? opsLine(`추가 ${when(m.addedAt)} · ${m.addedBy}`) : null,
          opsLine(`교육 ${m.visits}회 (완료 ${m.eduDone})${m.nextEdu ? ` · 다음 교육 ${shortDate(m.nextEdu)}` : ""} · 요청 ${fmtN(m.reqQty)} · 회수 ${fmtN(m.recoveredQty)} · 검수 ${fmtN(m.checkedQty)}`),
          opsTags(m.status === "issue" ? opsTag("문제 있음", "is-bad") : null, m.contactName ? opsTag(`담당 ${m.contactName}`) : null),
          m.issueNote ? h("span", { class: "vm-card__note small", text: `문제: ${m.issueNote}` }) : null,
          m.phone ? opsLine(`연락처 ${m.phone.replace(/\s*\n\s*/g, " · ")}`) : null,
          m.address ? opsLine(`주소 ${m.address}`) : null
        ], m.status === "issue" ? "is-warn" : ""), view === "added" ? "아직 추가한 수도회가 없어요. 앞으로 추가하면 누가 언제 추가했는지 여기에 보여요." : "찾는 수도회가 없어요."));
      };
      fill(box,
        h("div", { class: "pick-tiles" }, Object.entries(VIEWS).map(([k, x]) => pickTile(x.label, all.filter(x.pick).length, "곳", k === view, () => { view = k; draw(); }, k === "issue"))),
        h("div", { class: "filters" }, [h("label", { class: "search" }, [icon("search"), search]), count]),
        opsHint(v.hint), listBox,
        d.canAdd ? opsAddBtn("수도회 추가", addMon) : null);
      drawList();
    };
    const addMon = () => {
      const name = h("input", { maxlength: "80", placeholder: "예: ○○ 수녀회" });
      const { el: askEl, ask } = orgAskPanel();
      let orgConfirm = "";
      name.addEventListener("input", () => { askEl.hidden = true; orgConfirm = ""; });
      opsSheet("수도회 추가", [field("수도회 이름", name, "같은 이름은 넣을 수 없어요. 가운뎃점(·)은 띄어쓰기로 바꿔 저장해요."), askEl], {
        saveText: "추가하기",
        save: async () => {
          try { d = { ...d, ...(await api("/ops/monasteries", { method: "POST", body: { name: name.value, ...(orgConfirm ? { orgConfirm } : {}) } })) }; }
          catch (ex) { if (!ex.confirm) throw ex; ask(ex.confirm, (v) => { orgConfirm = v; name.closest("form").requestSubmit(); }); return false; }
          toast("수도회를 추가했어요."); draw();
        }
      });
    };
    const edit = (m) => {
      const ro = !d.canEdit;
      const status = opsSel(Object.entries(MON_STATUS), m.status); status.disabled = ro;
      const issue = h("textarea", { rows: "2", maxlength: "500", disabled: ro, placeholder: "예: 연락이 안 됨, 실 부족" }, m.issueNote);
      const issueField = field("문제 내용", issue, "'문제 있음'일 때 꼭 적어요");
      const syncIssue = () => { issueField.hidden = status.value !== "issue" && !issue.value; };
      status.addEventListener("change", syncIssue); syncIssue();
      const cname = h("input", { value: m.contactName, maxlength: "80", disabled: ro, placeholder: "담당 수녀·수사 이름" });
      const phone = d.canPhone ? h("textarea", { rows: "2", maxlength: "300", placeholder: "전화 · 이메일" }, m.phone) : null;
      const addr = h("input", { value: m.address, maxlength: "200", disabled: ro, placeholder: "택배 받을 주소" });
      const note = h("textarea", { rows: "2", maxlength: "1000", disabled: ro }, m.note);
      const mname = h("input", { value: m.name, maxlength: "80", disabled: ro });
      const hist = h("div", { class: "small muted", text: "불러오는 중…" });
      api(`/ops/monasteries/${m.id}/history`).then((r) => fill(hist, r.history.length ? h("ul", { class: "mon-hist" }, r.history.map((x) => h("li", {}, [h("strong", { text: MON_STATUS[x.to] || x.to }), h("span", { class: "muted", text: ` ← ${MON_STATUS[x.from] || x.from}` }), h("div", { class: "muted", text: [when(x.at), x.who, x.reason].filter(Boolean).join(" · ") })]))) : h("p", { class: "muted small", text: "아직 바뀐 기록이 없어요. 앞으로 바뀐 것부터 남아요." })), () => { hist.textContent = "이력을 불러오지 못했어요."; });
      opsSheet(m.name, [
        field("수도회 이름", mname, "바꾸면 이어진 방문 일정 제목도 같이 바뀌어요"), field("진행 상태", status), issueField, field("담당 수녀·수사", cname),
        h("div", { class: "field" }, [h("span", { class: "field__label", text: "연락처" }), phoneBox(m.phone) || h("p", { class: "small muted", text: "적은 연락처가 없어요." }), phone ? h("details", { class: "vm-extra" }, [h("summary", { text: "연락처 고치기 (리더 봉사자·관리자)" }), phone]) : null]),
        field("주소", addr), field("메모", note),
        h("div", { class: "field" }, [h("span", { class: "field__label", text: "상태 이력" }), hist])
      ], {
        ask: ro ? null : "이대로 고칠까요?",
        save: ro ? null : async () => {
          const body = { name: mname.value, status: status.value, issueNote: issue.value, contactName: cname.value, address: addr.value, note: note.value, ...(phone && phone.value !== m.phone ? { phone: phone.value } : {}) };
          d = { ...d, ...(await api(`/ops/monasteries/${m.id}`, { method: "PATCH", body })) }; toast("저장했어요."); draw();
        },
        del: d.canAdd && m.deletable ? async () => { if (!confirm(`'${m.name}' 수도회를 지울까요? 되돌릴 수 없어요.`)) return false; d = { ...d, ...(await api(`/ops/monasteries/${m.id}`, { method: "DELETE" })) }; toast("수도회를 지웠어요."); draw(); } : null
      });
    };
    draw();
    openRef("mon", (id) => d.monasteries.find((m) => m.id === id), edit);
    return [opsHint("수도회와 진행 상태를 확인해요. 위 칸을 누르면 그 수도회만 보여요. 문제가 있으면 수도회를 눌러 '문제 있음'을 고르고 내용을 적어요."), box];
  }
  // ---- F06 연락·문의 기록
  const CT_TARGET = { monastery: "수도회", vendor: "업체", volunteer: "봉사자", etc: "기타" };
  const CT_METHOD = { phone: "전화", sms: "문자", email: "이메일", visit: "방문", etc: "기타" };
  const CT_PURPOSE = { "": "일반", recovery: "묵주 발송 요청", inspect: "검수 결과 안내", thread: "실 전달", purchase: "구매", etc: "기타" };
  async function opsContacts(team) {
    document.title = `연락 기록 · ${TITLE}`;
    let d = await api("/ops/contacts"), view = "todo";
    const orgs = team ? (await api("/team/orgs").catch(() => ({ orgs: [] }))).orgs : [];
    const box = h("div", { class: "vm" });
    const draw = () => {
      const todo = d.logs.filter((x) => !x.done && x.followUp);
      const list = view === "todo" ? todo : view === "mine" ? d.logs.filter((x) => x.mine) : d.logs;
      const inq = orgs.filter((o) => o.openInquiries);
      fill(box,
        h("div", { class: "vm-stats" }, [vmStat("후속 조치 남음", todo.length, todo.some((x) => x.overdue)), vmStat("기한 지남", todo.filter((x) => x.overdue).length, todo.some((x) => x.overdue)), vmStat(team ? "열린 문의" : "전체 기록", team ? inq.reduce((n, o) => n + o.openInquiries, 0) : d.logs.length)]),
        team && inq.length ? h("section", { class: "card vm-sum" }, [h("h2", { class: "vm-sum__name", text: "수도회에서 온 열린 문의" }), h("ul", { class: "vm-opts__list" }, inq.map((o) => h("li", { class: "small", text: `${o.org} · ${o.openInquiries}건` }))), opsHint("답은 '교육 일정·결과'에서 그 수도회를 눌러 '문의 대응 기록'에 적어요.")]) : null,
        opsSeg([["todo", `할 일 ${todo.length}`], ["all", "전체"], ["mine", "내 기록"]], view, (k) => { view = k; draw(); }),
        opsCards(list, (x) => opsCard(() => edit(x), [
          opsTop(`${shortDate(x.date)} · ${x.target || CT_TARGET[x.targetType]}`, CT_METHOD[x.method]),
          opsTags(opsTag(CT_TARGET[x.targetType]), x.purpose ? opsTag(CT_PURPOSE[x.purpose]) : null, x.overdue ? opsTag("기한 지남", "is-bad") : null, x.done ? opsTag("완료") : null, x.mine ? opsTag("내 기록", "is-mine") : null),
          x.content ? h("span", { class: "vm-card__note small", text: x.content }) : null,
          x.followUp ? opsLine(`후속 조치: ${x.followUp}${x.dueDate ? ` (기한 ${shortDate(x.dueDate)})` : ""}`) : null,
          opsLine(x.author ? `적은 사람 ${x.author}` : "")
        ], x.overdue ? "is-warn" : ""), view === "todo" ? "남은 후속 조치가 없어요." : "아직 연락 기록이 없어요."),
        opsAddBtn("연락 기록 적기", () => edit(null)));
    };
    const edit = (x) => {
      const canAll = !x || x.canEdit;
      if (!canAll) {
        const done = h("input", { type: "checkbox", checked: x.done });
        return opsSheet("연락 기록", [h("p", { class: "small", text: `${x.date} · ${x.target} · ${CT_METHOD[x.method]}` }), x.content ? h("p", { class: "vol-pre small", text: x.content }) : null, x.followUp ? h("p", { class: "small", text: `후속 조치: ${x.followUp}` }) : null,
          h("label", { class: "check" }, [done, h("span", { text: "후속 조치 완료" })])], { save: async () => { d = await api(`/ops/contacts/${x.id}`, { method: "PATCH", body: { done: done.checked } }); draw(); } });
      }
      const type = opsSel(Object.entries(CT_TARGET), x?.targetType || "monastery");
      const mon = opsSel(d.monasteries.map((m) => [m.id, m.name]), x?.monasteryId, "수도회 고르기");
      const name = h("input", { value: x?.targetName || "", maxlength: "80", placeholder: "업체·봉사자 이름" });
      const monF = field("수도회", mon), nameF = field("누구에게", name);
      const sync = () => { monF.hidden = type.value !== "monastery"; nameF.hidden = type.value === "monastery"; };
      type.addEventListener("change", sync); sync();
      const date = h("input", { type: "date", value: x?.date || today() });
      const how = opsSel(Object.entries(CT_METHOD), x?.method || "phone"), why = opsSel(Object.entries(CT_PURPOSE), x?.purpose || "");
      const content = h("textarea", { rows: "3", maxlength: "1000", placeholder: "예: 9월 교육 묵주를 보내 달라고 안내함" }, x?.content || "");
      const follow = h("input", { value: x?.followUp || "", maxlength: "500", placeholder: "예: 도착하면 확인 전화" }), due = h("input", { type: "date", value: x?.dueDate || "" });
      const done = h("input", { type: "checkbox", checked: !!x?.done });
      opsSheet(x ? "연락 기록 고치기" : "연락 기록 적기", [
        h("div", { class: "row2" }, [field("대상", type), field("날짜", date)]), monF, nameF,
        h("div", { class: "row2" }, [field("방법", how), field("목적", why)]), field("연락 내용", content),
        h("details", { class: "vm-extra", open: !!(x?.followUp) }, [h("summary", { text: "후속 조치 (선택)" }), h("div", { class: "stack" }, [field("후속 조치", follow), field("기한", due, "기한이 되면 아침에 알림이 가요"), h("label", { class: "check" }, [done, h("span", { text: "후속 조치 완료" })])])])
      ], {
        save: async () => {
          const body = { targetType: type.value, monasteryId: type.value === "monastery" ? mon.value : null, targetName: type.value === "monastery" ? "" : name.value, date: date.value, method: how.value, purpose: why.value, content: content.value, followUp: follow.value, dueDate: due.value, done: done.checked };
          d = { ...d, ...(await api(x ? `/ops/contacts/${x.id}` : "/ops/contacts", { method: x ? "PATCH" : "POST", body })) }; toast("저장했어요."); draw();
        },
        del: x ? async () => { if (!confirm("이 연락 기록을 지울까요?")) return false; d = { ...d, ...(await api(`/ops/contacts/${x.id}`, { method: "DELETE" })) }; draw(); } : null
      });
    };
    draw();
    openRef("contacts", (id) => d.logs.find((x) => x.id === id), edit);
    return [opsHint("수도회·업체·봉사자에게 연락한 것을 적어요. 후속 조치와 기한을 적으면 기한이 된 날 아침에 알림이 가요."), box];
  }
  // ---- F02 택배 (받기·보내기). readOnly 면 조회만 (팀 봉사자 '회수 받기')
  const SHIP_STATUS = { ready: "준비", sent: "발송", arrived: "도착", returned: "반송" };
  const SHIP_PARTY = { monastery: "수도회", volunteer: "봉사자", vendor: "업체", etc: "기타" };
  // 택배 종류: 받는 택배 · 보내는 택배 (예전 택배는 '종류 미정')
  const SHIP_KIND = {
    in: { inspect: ["검수 택배", "수도회가 만든 완성 묵주. 도착하면 회수·검수 대기로 넘어가요"], material_done: ["재료 택배(작업완료)", "봉사자가 작업을 마친 재료(자른실·안 자른 실·십자가)"], vendor: ["업체 택배", "업체에서 산 물건"] },
    out: { material_make: ["재료 택배(제작용)", "수도회가 묵주를 만들 재료(자른실·십자가)"], material_work: ["재료 택배(작업용)", "봉사자가 작업할 재료(안 자른 실 등)"], return: ["반송 택배", "불량 등으로 돌려보내는 물건"] }
  };
  const shipKind = (s) => SHIP_KIND[s.direction]?.[s.kind]?.[0] || "종류 미정";
  const shipBadge = (st) => h("span", { class: `ship-badge is-${st}`, text: SHIP_STATUS[st] });
  // 택배 카드 (이름 · 내용물 · 상대/종류 칩 · 택배사·송장 · 날짜·담당, 오른쪽 위 상태)
  const shipCard = (s, onclick) => opsCard(onclick, [
    h("span", { hidden: true, "data-ref": `ship_in:${s.id}` }),
    h("span", { class: "ship-card__top" }, [h("strong", { class: "ship-card__name", text: s.party || SHIP_PARTY[s.partyType] }), shipBadge(s.status)]),
    opsLine([s.contents, s.qty != null ? `${fmtN(s.qty)}개` : ""].filter(Boolean).join(" · ") || "내용물 안 적음"),
    h("span", { class: "ship-card__chips" }, [
      h("span", { class: `ship-chip is-${s.partyType}`, text: SHIP_PARTY[s.partyType] }), h("span", { class: `ship-chip is-${s.partyType}` + (s.kind ? "" : " is-none"), text: shipKind(s) }),
      s.carrier || s.trackingNo ? h("i", { class: "ship-sep", "aria-hidden": "true" }) : null,
      s.carrier ? h("span", { class: "ship-chip is-line", text: s.carrier }) : null, s.trackingNo ? h("span", { class: "ship-chip is-line", text: `송장 ${s.trackingNo}` }) : null,
      s.recoveryId ? h("span", { class: "ship-chip is-line is-ok", text: "회수·검수 대기로 넘김" }) : null]),
    h("span", { class: "ship-card__meta" }, [
      h("span", {}, [icon("cal"), [s.sentDate ? `발송 ${shortDate(s.sentDate)}` : "", s.arrivedDate ? `도착 ${shortDate(s.arrivedDate)}` : ""].filter(Boolean).join(" · ") || "날짜 안 적음"]),
      h("span", {}, [icon("user"), `담당자: ${s.handler || s.author || "-"}`])]),
    s.note ? h("span", { class: "vm-card__note small", text: s.note }) : null
  ], "ship-card");
  async function opsShipments(dir, readOnly) {
    const inbound = dir === "in";
    document.title = `${inbound ? "택배 수신" : "택배 발송"} · ${TITLE}`;
    let [d, m] = await Promise.all([api("/ops/shipments"), api("/ops/monasteries").catch(() => ({ monasteries: [] }))]);
    const can = d.canEdit && !readOnly;
    const mons = m.monasteries;
    let view = "open", mineOnly = false;
    const on = new Set(Object.keys(SHIP_STATUS));
    const box = h("div", { class: "vm" });
    // 내 담당: 담당자가 나이거나, 담당자가 없으면 내가 적은 것
    const mine = (s) => (s.handlerId ? s.handlerId === state.user.id : s.createdBy === state.user.id);
    // 정렬: 상태(받기 발송>준비, 보내기 준비>발송) → 내 것 → 날짜. 할 일은 이른 날짜부터, 끝난 것은 최근부터
    const ORDER = inbound ? ["sent", "ready", "arrived", "returned"] : ["ready", "sent", "arrived", "returned"];
    const dayKey = (s) => s.arrivedDate || s.sentDate || "";
    const sortShips = (a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || mine(b) - mine(a)
      || (["ready", "sent"].includes(a.status) ? (dayKey(a) || "9").localeCompare(dayKey(b) || "9") : dayKey(b).localeCompare(dayKey(a))) || b.id - a.id;
    const draw = () => {
      const all = d.shipments.filter((s) => s.direction === dir);
      const isOpen = (s) => s.status === "sent" || s.status === "ready";
      const open = all.filter(isOpen), arrived = all.filter((s) => s.status === "arrived");
      const list = (view === "open" ? open : view === "arrived" ? arrived : all.filter((s) => on.has(s.status))).filter((s) => !mineOnly || mine(s)).sort(sortShips);
      const mineBox = h("input", { type: "checkbox", checked: mineOnly, onchange: (e) => { mineOnly = e.target.checked; draw(); } });
      fill(box,
        h("details", { class: "card ship-kinds", open: store.get("ps.shipKinds", "1") !== "0", ontoggle: (e) => store.set("ps.shipKinds", e.currentTarget.open ? "1" : "0") }, [h("summary", { text: inbound ? "받는 택배에는 어떤 종류가 있나요?" : "보내는 택배에는 어떤 종류가 있나요?" }),
          h("ul", {}, Object.values(SHIP_KIND[dir]).map(([t, sub]) => h("li", {}, [h("strong", { text: t }), h("span", { class: "muted", text: ` ${sub}` })])))]),
        h("div", { class: "vm-stats" }, inbound
          ? [vmStat("오는 중", all.filter((s) => s.status === "sent").length), vmStat("도착", arrived.length), vmStat("받은 수량", arrived.reduce((n, s) => n + (s.qty || 0), 0))]
          : [vmStat("보낼 준비", all.filter((s) => s.status === "ready").length), vmStat("발송", all.filter((s) => s.status === "sent").length), vmStat("도착 확인", arrived.length)]),
        opsSeg([["open", `처리할 것 ${open.length}`], ["arrived", `도착 ${arrived.length}`], ["all", `전체 ${all.length}`]], view, (k) => { view = k; draw(); }),
        h("div", { class: "filters ship-filters" }, [
          ...(view === "all" ? Object.entries(SHIP_STATUS).map(([k, t]) => h("label", { class: "check" }, [h("input", { type: "checkbox", checked: on.has(k), onchange: (e) => { if (e.target.checked) on.add(k); else on.delete(k); draw(); } }), h("span", { text: `${t} ${all.filter((s) => s.status === k).length}` })])) : []),
          h("label", { class: "check" }, [mineBox, h("span", { text: "내 것만" })]), h("span", { class: "muted small filters__end", text: `${list.length}건` })]),
        opsCards(list, (s) => shipCard(s, can ? () => edit(s) : null), mineOnly ? "내 담당 택배가 없어요." : view === "open" ? (inbound ? "처리할 택배가 없어요." : "보낼 준비 중이거나 가는 중인 택배가 없어요.") : "택배 기록이 없어요."),
        can ? opsAddBtn(inbound ? "받을 택배 적기" : "보낼 택배 적기", () => edit(null)) : opsHint(readOnly ? "택배는 부서 봉사자가 적어요. 여기서는 보기만 해요." : ""));
    };
    // 팀 봉사자가 회수 기록을 직접 고쳤으면(409) 맞출지, 택배만 저장할지 물어봄. 둘 다 아니면 저장하지 않음
    const askSync = async (send, canKeep) => {
      try { return await send(); } catch (ex) {
        if (ex.confirm?.mode !== "recovery") throw ex;
        const what = ex.confirm.edited.join(", ");
        if (confirm(`팀 봉사자가 이어진 회수 기록을 직접 고쳤어요 (${what}).\n확인을 누르면 ${ex.confirm.drop ? "그 회수 기록을 지우고" : "회수 기록을 택배에 맞추고"} ${canKeep ? "저장해요" : "택배도 지워요"}.`)) return send("overwrite");
        if (canKeep && confirm("회수 기록은 그대로 두고 택배만 저장할까요?")) return send("keep");
        return null;
      }
    };
    const edit = (s) => {
      const party = opsSel(Object.entries(SHIP_PARTY), s?.partyType || "monastery");
      const mon = opsSel(mons.map((x) => [x.id, x.name]), s?.monasteryId, "수도회 고르기");
      const pname = h("input", { value: s?.partyName || "", maxlength: "80", placeholder: "보내는·받는 사람 이름" });
      const monF = field("수도회", mon), nameF = field(inbound ? "보낸 사람" : "받는 사람", pname);
      // 종류: 새 택배는 상대에 맞춰 먼저 골라 두고, 사람이 고르면 그대로
      const kind = opsSel(Object.entries(SHIP_KIND[dir]).map(([k, v]) => [k, v[0]]), s ? s.kind : "", s && !s.kind ? "종류 미정" : "종류 고르기");
      const kindHint = h("small", { class: "muted" });
      let kindTouched = !!s;
      const guess = () => (inbound ? { monastery: "inspect", volunteer: "material_done", vendor: "vendor" } : { monastery: "material_make", volunteer: "material_work" })[party.value] || "";
      const syncKind = () => { if (!kindTouched) kind.value = guess(); kindHint.textContent = SHIP_KIND[dir][kind.value]?.[1] || "종류를 골라 두면 목록에서 알아보기 쉬워요."; };
      kind.addEventListener("change", () => { kindTouched = true; syncKind(); });
      // 주소: 수도회를 고르면 채우고, 수도회를 바꾸면 같이 바꿈. 사람이 고친 주소는 덮어쓰지 않음
      const addr = h("input", { value: s?.address || "", maxlength: "200", placeholder: "주소" });
      const addrOf = (id) => mons.find((y) => String(y.id) === String(id))?.address || "";
      let lastMon = mon.value;
      mon.addEventListener("change", () => { if (!inbound && (!addr.value.trim() || addr.value === addrOf(lastMon))) addr.value = addrOf(mon.value); lastMon = mon.value; });
      if (!s && !inbound && mon.value) addr.value = addrOf(mon.value);
      const addrRow = h("div", { class: "addr-row" }, [addr, h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "주소 복사", onclick: () => (addr.value.trim() ? copyText(addr.value.trim(), "주소를 복사") : toast("복사할 주소가 없어요.")) })]);
      const sync = () => { monF.hidden = party.value !== "monastery"; nameF.hidden = party.value === "monastery"; syncKind(); };
      party.addEventListener("change", sync); sync();
      const carrier = h("input", { value: s?.carrier || "", maxlength: "40", placeholder: "예: 우체국", list: "ops-carriers" });
      const carriers = h("datalist", { id: "ops-carriers" }, ["우체국", "CJ대한통운", "한진", "롯데", "로젠"].map((v) => h("option", { value: v })));
      const track = h("input", { value: s?.trackingNo || "", maxlength: "40", inputmode: "numeric" });
      const contents = h("input", { value: s?.contents || "", maxlength: "200", placeholder: inbound ? "예: 완성 묵주" : "예: 자른 실 20타래, 십자가 50개" });
      const qty = h("input", { type: "number", min: "0", inputmode: "numeric", value: s?.qty ?? "" });
      const status = opsSel(Object.entries(SHIP_STATUS), s?.status || (inbound ? "sent" : "ready"));
      const sent = h("input", { type: "date", value: s?.sentDate || "" }), arrived = h("input", { type: "date", value: s?.arrivedDate || "" });
      const note = h("textarea", { rows: "2", maxlength: "500" }, s?.note || "");
      const statusHint = inbound ? `자동으로 바뀌지 않아요. 택배를 받으면 직접 '도착'으로 바꿔 주세요.${s?.recoveryId ? " 회수·검수 대기로 넘어간 택배라 고치면 회수 기록도 함께 바뀌어요." : " 검수 택배는 도착으로 바꾸면 검수 대기로 넘어가요."}` : "자동으로 바뀌지 않아요. 택배를 보내면 직접 '발송'으로 바꿔 주세요.";
      opsSheet(s ? (inbound ? "받을 택배" : "보낼 택배") : inbound ? "받을 택배 적기" : "보낼 택배 적기", [
        h("div", { class: "row2" }, [field(inbound ? "보낸 곳" : "받는 곳", party), field("상태", status, statusHint)]), monF, nameF,
        h("div", { class: "field" }, [h("span", { class: "field__label", text: "택배 종류" }), kind, kindHint]),
        inbound ? null : field("주소", addrRow, "수도회를 고르면 적어 둔 주소가 채워져요"),
        h("div", { class: "row2" }, [field("내용물", contents), field("수량", qty)]),
        h("div", { class: "row2" }, [field("택배사", h("span", {}, [carrier, carriers])), field("송장번호", track)]),
        h("div", { class: "row2" }, [field("발송일", sent), field("도착일", arrived)]), field("메모", note),
        inbound ? h("details", { class: "vm-extra", open: !!s?.address }, [h("summary", { text: "보낸 곳 주소 (선택, 받는 택배에는 안 적어도 돼요)" }), addrRow]) : null
      ], {
        save: async () => {
          const body = { direction: dir, kind: kind.value, partyType: party.value, monasteryId: party.value === "monastery" ? mon.value : null, partyName: party.value === "monastery" ? "" : pname.value, address: addr.value, carrier: carrier.value, trackingNo: track.value, contents: contents.value, qty: qty.value, status: status.value, sentDate: sent.value, arrivedDate: arrived.value, note: note.value, ...(s ? {} : { handlerId: state.user.id }) };
          const r = await askSync((sync) => api(s ? `/ops/shipments/${s.id}` : "/ops/shipments", { method: s ? "PATCH" : "POST", body: sync ? { ...body, syncRecovery: sync } : body }), true);
          if (!r) return false;
          d = { ...d, ...r };
          toast(r.notice || (status.value === "arrived" && inbound ? "도착 처리했어요." : "저장했어요.")); draw();
        },
        del: s?.canDelete ? async () => {
          if (!confirm(s.recoveryId ? "이 택배 기록을 지울까요? 이어진 회수 기록과 검수 대기도 함께 지워져요." : "이 택배 기록을 지울까요?")) return false;
          const r = await askSync((sync) => api(`/ops/shipments/${s.id}${sync ? `?syncRecovery=${sync}` : ""}`, { method: "DELETE" }), false);
          if (!r) return false;
          d = { ...d, ...r }; if (r.notice) toast(r.notice); draw();
        } : null
      });
    };
    draw();
    openRef(inbound ? "ship_in" : "ship_out", (id) => d.shipments.find((s) => s.id === id && s.direction === dir), (s) => (can ? edit(s) : toast(`${s.party} 택배예요.`)));
    return [opsHint(inbound ? "받을 택배를 적어 두고, 실제로 받으면 직접 '도착'으로 바꿔 주세요 (자동으로 바뀌지 않아요). 검수 택배는 팀 봉사자의 검수 대기로 넘어가요." : "수도회·봉사자에게 보낼 택배를 적어 두고, 실제로 보내면 직접 '발송'으로 바꿔 주세요 (자동으로 바뀌지 않아요)."), box];
  }
  // ---- F04 검수 기준 보기 (리더·관리자는 새 판 만들기)
  async function opsCriteria() {
    document.title = `검수 기준 · ${TITLE}`;
    let d = await api("/ops/criteria"), ver = d.current, tab = "";
    const open = new Set();
    const box = h("div", { class: "vm" });
    const cache = new Map();
    const src = (pid) => { if (!cache.has(pid)) cache.set(pid, fetch(`${API}/ops/criteria-photos/${pid}`, { headers: { Authorization: "Bearer " + state.token } }).then((r) => (r.ok ? r.blob() : null)).then((b) => (b ? URL.createObjectURL(b) : null)).catch(() => null)); return cache.get(pid); };
    // 사진 줄: 누르면 크게, 리더·관리자는 올리고 지움 (줄여서 저장, 칸마다 4장)
    const photoRow = (kind, key, empty) => {
      const list = (d.photos || []).filter((p) => p.kind === kind && p.key === key);
      const fin = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp", multiple: true, hidden: true });
      fin.addEventListener("change", async () => {
        const files = [...fin.files].slice(0, 4 - list.length); fin.value = "";
        for (const f of files) { try { d = { ...d, ...(await api("/ops/criteria-photos", { method: "POST", body: { kind, key, data: await blobToBase64(await shrinkImage(f)) } })) }; } catch (ex) { toast(ex.message); break; } }
        draw();
      });
      return h("div", { class: "crit-photos" }, [
        ...list.map((p) => { const img = h("img", { alt: kind === "ok" ? "정상 예시 사진" : "불량 예시 사진" }); src(p.id).then((u) => { if (u) img.src = u; });
          return h("span", { class: "crit-photo" }, [h("button", { type: "button", class: "crit-photo__btn", "aria-label": "사진 크게 보기", onclick: () => src(p.id).then((u) => { if (u) window.open(u, "_blank", "noopener"); }) }, img),
            d.canEdit ? h("button", { class: "move-photos__x", type: "button", "aria-label": "사진 지우기", html: ICON.close, onclick: async () => { if (!confirm("이 사진을 지울까요?")) return; d = { ...d, ...(await act(() => api(`/ops/criteria-photos/${p.id}`, { method: "DELETE" }))) }; draw(); } }) : null]); }),
        list.length ? null : h("p", { class: "muted small", text: empty + (d.canEdit ? " 아래 '사진 올리기'로 올려 주세요." : " 리더 봉사자나 관리자가 올리면 여기에 보여요.") }),
        d.canEdit && list.length < 4 ? h("button", { class: "btn btn--ghost btn--sm", type: "button", onclick: () => fin.click() }, [icon("plus"), `사진 올리기 (${list.length}/4)`]) : null, fin]);
    };
    const sampleCard = (v) => {
      const tabs = [["", "묵주 전체"], ...v.items.map((it) => [it.defectKey, it.item])];
      if (!tabs.some(([k]) => k === tab)) tab = "";
      return h("section", { class: "card crit-sample" }, [h("h2", { text: "검수 샘플 (정상 예시)" }),
        h("div", { class: "crit-tabs", role: "tablist" }, tabs.map(([k, t]) => h("button", { type: "button", role: "tab", "aria-selected": String(k === tab), text: t, onclick: () => { tab = k; draw(); } }))),
        photoRow("ok", tab, "아직 정상 예시 사진이 없어요.")]);
    };
    const draw = () => {
      const v = d.versions.find((x) => x.version === ver) || d.versions[d.versions.length - 1];
      if (!v) return fill(box, h("div", { class: "card empty", text: "아직 검수 기준이 없어요." }));
      const pickV = d.versions.length > 1 ? opsSel(d.versions.map((x) => [x.version, `${x.version}판${x.version === d.current ? " (지금 기준)" : ""}`]), v.version) : null;
      pickV?.addEventListener("change", () => { ver = Number(pickV.value); draw(); });
      fill(box,
        h("section", { class: "card vm-sum" }, [h("h2", { class: "vm-sum__name", text: `${v.version}판 검수 기준${v.version === d.current ? " · 지금 적용" : ""}` }), opsLine(`적용 ${v.validFrom}${v.approvedBy ? ` · 확인 ${v.approvedBy}` : ""} · 항목 ${v.items.length}개 · 이 판으로 적은 검수 ${fmtN(v.used)}건`), pickV ? h("label", { class: "vm-pick" }, [h("span", { class: "muted small", text: "다른 판 보기" }), pickV]) : null,
          d.canEdit && !v.used ? h("span", { class: "actions actions--start" }, [h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "이 판 고치기", onclick: () => edit(v, true) }),
            d.versions.length > 1 ? h("button", { class: "btn btn--danger-outline btn--sm", type: "button", text: "이 판 지우기", onclick: async () => { if (!confirm(`${v.version}판 검수 기준을 지울까요? 되돌릴 수 없어요.`)) return; d = { ...d, ...(await act(() => api(`/ops/criteria/${v.version}`, { method: "DELETE" }))) }; ver = d.current; toast("판을 지웠어요."); draw(); } }) : null]) : d.canEdit ? opsHint("이 판으로 적은 검수 기록이 있어 고치거나 지울 수 없어요. 바꾸려면 새 판을 만들어요.") : null]),
        sampleCard(v),
        h("div", { class: "crit-list" }, v.items.map((it) => h("details", { class: "crit-item", open: open.has(it.defectKey), ontoggle: (e) => { if (e.currentTarget.open) open.add(it.defectKey); else open.delete(it.defectKey); } }, [
          h("summary", {}, [h("span", { text: it.item })]),
          h("div", { class: "crit-item__body" }, [
            h("div", {}, [h("strong", { class: "small", text: `${it.item} 불량 예시` }), photoRow("bad", it.defectKey, "아직 불량 예시 사진이 없어요.")]),
            h("div", { class: "crit-item__text" }, [h("strong", { text: `불량 이름: ${it.defectName}` }), h("p", { text: it.method ? `확인 방법: ${it.method}` : "확인 방법을 아직 적지 않았어요." }), h("p", { text: it.passRule ? `합격 기준: ${it.passRule}` : "합격 기준을 아직 적지 않았어요." }), opsTags(opsTag(`불량 코드 ${it.defectKey}`))])
          ])]))),
        d.canEdit ? opsAddBtn("기준 고치기 (새 판)", () => edit(v)) : opsHint("검수 기준은 리더 봉사자와 관리자가 정해요. 검수 입력에서는 이 불량 코드만 골라요."));
    };
    const edit = (v, same) => {
      const rows = v.items.map((it) => ({ ...it }));
      const rowsBox = h("div", { class: "stack" });
      const drawRows = () => fill(rowsBox, ...rows.map((it, i) => {
        const inp = (k, ph, max) => { const e = h("input", { value: it[k] || "", maxlength: String(max), placeholder: ph }); e.addEventListener("input", () => { it[k] = e.value; }); return e; };
        return h("div", { class: "card ops-critrow" }, [h("div", { class: "row2" }, [field(`${i + 1}. 검수 항목`, inp("item", "예: 매듭", 80)), field("불량 이름", inp("defectName", "예: 매듭 풀림", 40))]),
          h("div", { class: "row2" }, [field("확인 방법", inp("method", "예: 손으로 당겨 봄", 300)), field("합격 기준", inp("passRule", "예: 풀림 없음", 300))]),
          h("div", { class: "row2" }, [field("불량 코드 (비우면 불량 이름)", inp("defectKey", "예: knot", 40)), h("div", { class: "field" }, h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "이 항목 빼기", onclick: () => { rows.splice(i, 1); drawRows(); } }))])]);
      }), h("button", { class: "btn btn--ghost btn--sm", type: "button", onclick: () => { rows.push({ item: "", defectName: "", defectKey: "", method: "", passRule: "" }); drawRows(); } }, [icon("plus"), "항목 더하기"]));
      drawRows();
      const from = h("input", { type: "date", value: same ? v.validFrom : today() }), by = h("input", { maxlength: "80", placeholder: "예: 신부님 협의", value: v.approvedBy || "" });
      opsSheet(same ? `검수 기준 ${v.version}판 고치기` : `검수 기준 ${Math.max(...d.versions.map((x) => x.version)) + 1}판 만들기`, [opsHint(same ? "아직 이 판으로 적은 검수 기록이 없어 그대로 고쳐요." : "지금 판을 고쳐 새 판으로 저장해요. 예전 검수 결과는 예전 판 기준으로 남아요."), h("div", { class: "row2" }, [field("적용 시작일", from), field("확인한 사람", by)]), rowsBox], {
        saveText: same ? "이 판 저장" : "새 판 저장", ask: same ? `${v.version}판을 이대로 고칠까요?` : null,
        save: async () => { d = { ...d, ...(await api(same ? `/ops/criteria/${v.version}` : "/ops/criteria", { method: same ? "PUT" : "POST", body: { validFrom: from.value, approvedBy: by.value, items: rows } })) }; ver = same ? v.version : d.current; toast("검수 기준을 저장했어요."); draw(); }
      });
    };
    draw();
    return [opsHint("검수할 항목과 합격 기준, 불량 코드를 확인해요."), box];
  }
  // ---- F05 내 조·물량 배정 (리더·관리자는 조 만들기·배정)
  const ASSIGN_STATUS = { wait: "대기", doing: "검수 중", done: "완료" };
  async function opsGroups() {
    let d = await api("/ops/groups");
    const box = h("div", { class: "vm" });
    const draw = () => {
      const mine = d.groups.filter((g) => g.mine), others = d.groups.filter((g) => !g.mine);
      const gcard = (g) => h("div", { class: "vm-card ops-group" + (g.mine ? " is-mine" : ""), "data-ref": `groups:${g.id}` }, [
        opsTop(`${g.name}${g.active ? "" : " (쉼)"}`, g.mine ? "내 조" : ""),
        opsLine([g.leader ? `조장 ${g.leader}` : "", g.members.length ? `조원 ${g.members.map((m) => m.name).join(", ")}` : "조원 없음"].filter(Boolean).join(" · ")),
        g.note ? h("span", { class: "vm-card__note small", text: g.note }) : null,
        g.assigns.length ? h("ul", { class: "ops-assigns" }, g.assigns.map((a) => {
          const s = opsSel(Object.entries(ASSIGN_STATUS), a.status);
          s.disabled = !(g.mine || d.canEdit);
          s.setAttribute("aria-label", `${a.org} 검수 상태`);
          s.addEventListener("change", async () => { try { d = { ...d, ...(await api(`/ops/assigns/${a.id}`, { method: "PATCH", body: { status: s.value } })) }; toast("상태를 바꿨어요."); draw(); if (state.opsRefresh) quiet(state.opsRefresh()); } catch (ex) { toast(ex.message); s.value = a.status; } });
          return h("li", { class: "ops-assign" }, [h("span", {}, [h("strong", { text: a.org }), h("span", { class: "muted small", text: ` ${a.qty != null ? `${fmtN(a.qty)}개` : ""}${a.dueDate ? ` · ${shortDate(a.dueDate)}까지` : ""} · 검수 ${fmtN(a.checked)}${a.note ? ` · ${a.note}` : ""}` })]), s,
            d.canEdit ? h("button", { class: "link-btn small", type: "button", text: "고치기", onclick: () => editAssign(g, a) }) : null,
            d.canEdit ? h("button", { class: "link-btn small", type: "button", text: "지우기", onclick: async () => { if (!confirm("이 배정을 지울까요?")) return; d = { ...d, ...(await act(() => api(`/ops/assigns/${a.id}`, { method: "DELETE" }))) }; draw(); } }) : null]);
        })) : opsLine("배정된 물량이 없어요."),
        d.canEdit ? h("span", { class: "actions actions--start" }, [h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "조 고치기", onclick: () => edit(g) }), h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "물량 배정", onclick: () => assign(g) })]) : null
      ]);
      fill(box,
        h("div", { class: "vm-stats" }, [vmStat("내 조", mine.length), vmStat("배정 물량", mine.reduce((n, g) => n + g.assigns.filter((a) => a.status !== "done").reduce((k, a) => k + (a.qty || 0), 0), 0)), vmStat("남은 배정", mine.reduce((n, g) => n + g.assigns.filter((a) => a.status !== "done").length, 0))]),
        d.canEdit && d.waiting?.length ? h("section", { class: "card vm-sum" }, [h("h2", { class: "vm-sum__name", text: `배정 대기 물량 ${d.waiting.length}건` }), opsHint("택배 수신·회수로 들어온 물량이에요. 조를 고르면 남은 수량이 그 조에 배정돼요."),
          h("ul", { class: "ops-assigns" }, d.waiting.map((w) => { const s = opsSel(d.groups.filter((g) => g.active).map((g) => [g.id, g.name]), "", "조 배정"); s.setAttribute("aria-label", `${w.org} 조 배정`);
            s.addEventListener("change", async () => { if (!s.value) return; try { const r = await apiAsk(`/ops/groups/${s.value}/assigns`, { method: "POST", body: { scheduleId: w.scheduleId, qty: Math.max(0, w.qty - w.checked) } }); if (!r) { s.value = ""; return; } d = { ...d, ...r }; d.waiting = d.waiting.filter((x) => x.id !== w.id); toast(`${w.org} 물량을 배정했어요.`); draw(); if (state.opsRefresh) quiet(state.opsRefresh()); } catch (ex) { toast(ex.message); s.value = ""; } });
            return h("li", { class: "ops-assign" }, [h("span", {}, [h("strong", { text: w.org }), h("span", { class: "muted small", text: ` ${shortDate(w.date)} · ${fmtN(w.qty - w.checked)}개` })]), s]); }))]) : null,
        mine.length ? h("div", { class: "stack stack--sm" }, mine.map(gcard)) : h("div", { class: "card empty", text: "아직 속한 검수 조가 없어요. 리더에게 알려 주세요." }),
        others.length ? h("details", { class: "vm-opts" }, [h("summary", {}, `다른 조 ${others.length}개`), h("div", { class: "stack stack--sm" }, others.map(gcard))]) : null,
        d.canEdit ? opsAddBtn("검수 조 만들기", () => edit(null)) : null);
    };
    const edit = (g) => {
      const name = h("input", { value: g?.name || "", maxlength: "40", placeholder: "예: 1조" });
      const leader = opsSel((d.people || []).map((p) => [p.id, p.name]), g?.leaderId, "조장 (선택)");
      const picked = new Set((g?.members || []).map((m) => m.id));
      const mem = h("div", { class: "ops-checks" }, (d.people || []).map((p) => { const c = h("input", { type: "checkbox", checked: picked.has(p.id) }); c.addEventListener("change", () => (c.checked ? picked.add(p.id) : picked.delete(p.id))); return h("label", { class: "check" }, [c, h("span", { text: p.name })]); }));
      const active = h("input", { type: "checkbox", checked: g ? g.active : true });
      const note = h("textarea", { rows: "2", maxlength: "300" }, g?.note || "");
      opsSheet(g ? `${g.name} 고치기` : "검수 조 만들기", [field("조 이름", name), field("조장", leader), h("div", { class: "field" }, [h("span", { class: "field__label", text: "조원" }), (d.people || []).length ? mem : opsHint("팀 봉사자 계정이 없어요.")]), h("label", { class: "check" }, [active, h("span", { text: "사용 중인 조" })]), field("메모", note)], {
        save: async () => { const body = { name: name.value, leaderId: leader.value, memberIds: [...picked], active: active.checked, note: note.value }; d = { ...d, ...(await api(g ? `/ops/groups/${g.id}` : "/ops/groups", { method: g ? "PATCH" : "POST", body })) }; toast("저장했어요."); draw(); },
        del: g ? async () => { if (!confirm(`'${g.name}' 조를 지울까요? 배정도 함께 지워져요.`)) return false; d = { ...d, ...(await api(`/ops/groups/${g.id}`, { method: "DELETE" })) }; draw(); } : null
      });
    };
    const editAssign = (g, a) => {
      const qty = h("input", { type: "number", min: "0", inputmode: "numeric", value: a.qty ?? "" }), due = h("input", { type: "date", value: a.dueDate }), note = h("input", { maxlength: "300", value: a.note });
      opsSheet(`${g.name} · ${a.org} 배정 고치기`, [opsHint(`지금까지 검수 ${fmtN(a.checked)}개. 수량을 바꾸면 진행 상태도 검수한 만큼으로 맞춰요.`), h("div", { class: "row2" }, [field("배정 수량", qty), field("완료 예정일", due)]), field("메모", note)], {
        save: async () => { d = { ...d, ...(await api(`/ops/assigns/${a.id}`, { method: "PATCH", body: { qty: qty.value, dueDate: due.value, note: note.value } })) }; toast("저장했어요."); draw(); }
      });
    };
    const assign = (g) => {
      const sch = opsSel((d.schedules || []).map((o) => [o.id, `${o.org}${o.date ? ` (${shortDate(o.date)})` : ""}`]), "", "수도회 물량 고르기");
      const qty = h("input", { type: "number", min: "0", inputmode: "numeric" }), due = h("input", { type: "date" }), note = h("input", { maxlength: "300" });
      opsSheet(`${g.name} 물량 배정`, [field("수도회 물량", sch), h("div", { class: "row2" }, [field("배정 수량", qty), field("완료 예정일", due)]), field("메모", note)], {
        saveText: "배정하기",
        save: async () => { if (!sch.value) throw new Error("수도회 물량을 골라 주세요."); const r = await apiAsk(`/ops/groups/${g.id}/assigns`, { method: "POST", body: { scheduleId: sch.value, qty: qty.value, dueDate: due.value, note: note.value } }); if (!r) return false; d = { ...d, ...r }; toast("배정했어요."); draw(); }
      });
    };
    draw();
    openRef("groups", (id) => d.groups.find((g) => g.id === id), (g) => flashRef("groups", g.id));
    return [opsHint("내가 속한 검수 조와 맡은 수도회 물량을 확인하고, 검수를 시작하면 상태를 바꿔요."), box];
  }
  // ---- 불량 처리: 불량이 있는 검수 기록의 처리 방법(반송·현장 재작업) 정하기
  async function opsDefects() {
    document.title = `불량 처리 · ${TITLE}`;
    let d = await api("/team/inspections"), view = "todo";
    const dname = (k) => d.criteria?.items?.find((i) => i.defectKey === k)?.defectName || k;
    const box = h("div", { class: "vm" });
    const draw = () => {
      const bad = d.inspections.filter((x) => x.defectTotal > 0);
      const todo = bad.filter((x) => !x.rework);
      const list = view === "todo" ? todo : bad;
      fill(box,
        h("div", { class: "vm-stats" }, [vmStat("처리 전", todo.length, todo.length > 0), vmStat("불량 합계", bad.reduce((n, x) => n + x.defectTotal, 0)), vmStat("처리함", bad.length - todo.length)]),
        opsSeg([["todo", `처리 전 ${todo.length}`], ["all", "불량 전체"]], view, (k) => { view = k; draw(); }),
        opsCards(list, (x) => opsCard(() => edit(x), [
          opsTop(`${shortDate(x.date)} · ${x.source || x.group}`, `불량 ${fmtN(x.defectTotal)}`),
          opsLine(Object.entries(x.defects).map(([k, v]) => `${dname(k)} ${v}`).join(" · ")),
          opsTags(x.rework ? opsTag(REWORK_LABEL[x.rework]) : opsTag("처리 정하기", "is-bad"), x.photos.length ? opsTag(`사진 ${x.photos.length}`) : null),
          x.note ? h("span", { class: "vm-card__note small", text: x.note }) : null
        ]), view === "todo" ? "처리할 불량이 없어요." : "불량이 나온 검수 기록이 없어요."));
    };
    const edit = (x) => {
      const rw = opsSel(Object.entries(REWORK_LABEL), x.rework || "");
      const note = h("textarea", { rows: "2", maxlength: "500" }, x.note || "");
      opsSheet(`${x.source || x.group} · 불량 ${x.defectTotal}개`, [opsLine(Object.entries(x.defects).map(([k, v]) => `${dname(k)} ${v}`).join(" · ")), field("불합격품 처리", rw, "수도회로 돌려보낼지, 현장에서 고칠지"), field("메모", note)], {
        save: async () => {
          const body = { itemId: x.itemId, stage: x.stage, date: x.date, source: x.source, checkedQty: x.checkedQty, sampled: x.sampled, sampleQty: x.sampleQty ?? "", defects: x.defects, note: note.value, rework: rw.value };
          const r = await api(`/team/inspections/${x.id}`, { method: "PATCH", body }); d.inspections = r.inspections; toast("저장했어요."); draw();
        }
      });
    };
    draw();
    openRef(["defect", "inspect"], (id) => d.inspections.find((x) => x.id === id), edit);
    return [opsHint("불량이 나온 검수 기록마다 처리 방법을 골라요."), box];
  }
  // ---- F03 역할·업무 담당 (관리자가 정하고 모두 봄)
  const DUTY = { parcel_out: "택배 발송", parcel_in: "택배 수신", storage: "보관", inspect_place: "검수 장소", purchase: "구매", thread: "실", etc: "기타" };
  async function opsDuties() {
    let d = await api("/ops/duties");
    const box = h("div", { class: "vm" });
    const draw = () => fill(box,
      opsCards(Object.keys(DUTY).filter((k) => d.duties.some((x) => x.duty === k)), (k) => h("div", { class: "vm-card" }, [opsTop(DUTY[k], ""), h("ul", { class: "ops-assigns" }, d.duties.filter((x) => x.duty === k).map((x) => h("li", { class: "ops-assign", "data-ref": `duties:${x.id}` }, [
        h("span", {}, [h("strong", { text: x.name }), h("span", { class: "muted small", text: ` ${x.who}${x.startDate || x.endDate ? ` · ${x.startDate || "…"} ~ ${x.endDate || "…"}` : ""}${x.note ? ` · ${x.note}` : ""}` })]),
        x.active ? opsTag("지금 담당", "is-mine") : opsTag("기간 아님"),
        d.canEdit ? h("button", { class: "link-btn small", type: "button", text: "고치기", onclick: () => edit(x) }) : null])))]), "아직 정한 업무 담당자가 없어요."),
      d.canEdit ? opsAddBtn("업무 담당자 정하기", () => edit(null)) : null);
    const edit = (x) => {
      const duty = opsSel(Object.entries(DUTY), x?.duty || "parcel_out"), who = opsSel((d.people || []).map((p) => [p.id, `${p.name} (${p.who})`]), x?.userId, "담당자 고르기");
      const s = h("input", { type: "date", value: x?.startDate || "" }), e = h("input", { type: "date", value: x?.endDate || "" }), note = h("input", { value: x?.note || "", maxlength: "300" });
      opsSheet(x ? "업무 담당 고치기" : "업무 담당자 정하기", [field("업무", duty), field("담당자", who), h("div", { class: "row2" }, [field("시작일 (비우면 바로)", s), field("종료일 (비우면 계속)", e)]), field("메모", note)], {
        save: async () => { d = { ...d, ...(await api(x ? `/ops/duties/${x.id}` : "/ops/duties", { method: x ? "PATCH" : "POST", body: { duty: duty.value, userId: who.value, startDate: s.value, endDate: e.value, note: note.value } })) }; toast("저장했어요."); draw(); },
        del: x ? async () => { if (!confirm("이 업무 담당을 지울까요?")) return false; d = { ...d, ...(await api(`/ops/duties/${x.id}`, { method: "DELETE" })) }; draw(); } : null
      });
    };
    draw();
    return [h("h2", { class: "card__title ops-sec", text: "역할 · 업무 담당" }), opsHint("택배·보관·검수 장소 같은 업무를 누가 맡는지 봐요. 관리자가 정해요."), box];
  }
  // 단계 화면 고르기
  async function stepScreen(tab) {
    switch (tab) {
      case "tedu1": return opsMonasteries();
      case "tedu2": return teamOrgs({ mode: "edu" });
      case "tmake1": return teamOrgs({ mode: "made" });
      case "tmake2": return teamRecoveryStep();
      case "tins1": return opsCriteria();
      case "tins2": return [...(await opsGroups()), h("h2", { class: "card__title ops-sec", text: "봉사 신청" }), ...(await teamInspect("shifts", { bare: true }))];
      case "tins3": return teamInspect("records", { bare: true, waiting: true });
      case "tins4": return opsDefects();
      case "tins5": return teamInspect("daily", { bare: true });
      case "dr1": return opsShipments("in", false);
      case "dr2": return volGroupPage(VOL_GROUPS[0], "in", { steps: true });
      case "ds1": return volGroupPage(VOL_GROUPS[0], "req", { steps: true });
      case "ds2": return volGroupPage(VOL_GROUPS[0], "out", { steps: true });
      case "ds3": return opsShipments("out", false);
      case "df1": return volGroupPage(VOL_GROUPS[0], "recovery", { steps: true });
      case "df2": return volGroupPage(VOL_GROUPS[1], "recovery", { steps: true });
      default: return [h("div", { class: "card empty", text: "찾는 단계가 없어요." })];
    }
  }
  /* ---------- 수도회·물류 (직원·관리자): DB 설계 v2 2·3차 화면. 직원은 관리자가 권한표에서 '직원도 쓰기'를 켜야 보임 ---------- */
  const OPS_TABS = [
    ["dash", "대시보드", "dashboard"], ["mon", "수도회", "monasteries"], ["ship-in", "택배 수신", "shipments"], ["ship-out", "택배 발송", "shipments"],
    ["stock", "재고·보관", "stock"], ["cut", "실자르기·타래", "cutting"], ["buy", "업체 구매", "purchases"], ["contacts", "연락 기록", "contacts"],
    ["groups", "검수 조·배정", "groups"], ["criteria", "검수 기준", "criteria"], ["duties", "담당·역할", "duties"], ["perms", "권한표", null]
  ];
  async function loadOpsPerms() {
    try { state.opsPerms = await api("/ops/perms"); } catch (e) { state.opsPerms = { mine: {} }; }
    if (layout.nav) drawNav(navActive);
  }
  const opsSees = () => isAdmin() || Object.values(state.opsPerms?.mine || {}).some((x) => x.v);
  async function pageOps() {
    if (!state.opsPerms) await loadOpsPerms();
    if (!opsSees()) return go("#/today");
    document.title = `수도회·물류 · ${TITLE}`;
    drawMini(null);
    const mine = state.opsPerms.mine || {};
    const tabs = OPS_TABS.filter(([, , k]) => (k ? isAdmin() || mine[k]?.v : isAdmin()));
    const sub = tabs.some(([k]) => k === route().id) ? route().id : tabs[0][0];
    setMain("ops", loading());
    const seg = h("nav", { class: "seg ops-tabs", "aria-label": "수도회·물류 메뉴" }, tabs.map(([k, label]) => h("a", { class: "seg__link" + (k === sub ? " is-active" : ""), href: `#/ops/${k}`, "aria-selected": String(k === sub), "aria-current": k === sub ? "page" : null, text: label })));
    let body;
    try {
      body = await ({
        dash: opsDashboard, mon: opsMonasteries, "ship-in": () => opsShipments("in", !(isAdmin() || mine.shipments?.e)), "ship-out": () => opsShipments("out", !(isAdmin() || mine.shipments?.e)),
        stock: opsStock, cut: opsCutting, buy: opsPurchases, contacts: () => opsContacts(false), groups: opsGroups, criteria: opsCriteria, duties: opsDuties, perms: opsPermsAdmin
      }[sub])();
    } catch (e) { if (e.status === 401) return; body = [failed(e)]; }
    if (route().name !== "ops") return;
    setMain("ops", [h("div", { class: "page-head" }, [h("h1", { text: "수도회·물류" }), isAdmin() && !state.opsPerms.staffOn ? h("span", { class: "stock-tag", title: "직원에게는 아직 안 보여요. 권한표에서 켤 수 있어요.", text: "관리자에게만 보임" }) : null]), seg, ...[].concat(body)]);
    seg.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "center" });
  }
  // ---- 관리 대시보드
  async function opsDashboard() {
    const d = await api("/ops/dashboard");
    const k = d.kpi, rate = k.checked ? (k.bad / k.checked) * 100 : 0;
    const stages = [["edu_done", "교육완료"], ["making", "제작중"], ["recovered", "회수완료"], ["checked", "검수완료"], ["issue", "문제 있음"]];
    const max = Math.max(1, ...stages.map(([s]) => d.stages[s] || 0));
    const kpi = (n, label, warn) => h("div", { class: "card ops-kpi" + (warn ? " is-warn" : "") }, [h("strong", { text: n }), h("span", { text: label })]);
    const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
    return [
      h("p", { class: "muted small", text: `${d.date} 기준 · 수도회 진행 상황과 물량` }),
      h("div", { class: "ops-kpis" }, [kpi(fmtN(k.reqQty), "요청 수량 (개)"), kpi(fmtN(k.inspectLeft), "검수 남은 수량"), kpi(`${rate.toFixed(1)}%`, `불량률 (검수 ${fmtN(k.checked)}개 중 ${fmtN(k.bad)}개)`, rate > 5), kpi(fmtN(k.lateFollowups), "기한 된 후속 조치", k.lateFollowups > 0), kpi(fmtN(k.lowStock), "안전재고 미달 품목", k.lowStock > 0)]),
      h("section", { class: "card ops-flowcard" }, [h("h2", { class: "card__title", text: "수도회 진행 단계" }), h("div", { class: "ops-flow" }, stages.map(([s, t], i) => h("div", { class: "ops-stage" + (s === "issue" ? " is-issue" : "") }, [
        h("strong", { text: fmtN(d.stages[s] || 0) }), h("span", { text: t }), h("i", { class: "ops-bar" }, h("b", { style: `width:${((d.stages[s] || 0) / max) * 100}%` })), i < 3 ? h("span", { class: "ops-flow__arrow", "aria-hidden": "true", text: "→" }) : null]))),
        h("p", { class: "muted small", text: `아직 교육 전(등록)인 수도회 ${fmtN(d.stages.new || 0)}곳은 빠져 있어요.` })]),
      h("section", { class: "stack stack--sm" }, [h("h2", { class: "card__title", text: "수도회별 물량" }), d.monasteries.length ? h("div", { class: "card table-wrap" }, h("table", { class: "table" }, [
        h("thead", {}, h("tr", {}, ["수도회", "상태", "요청", "제작", "회수", "검수", "검수 진행", "합격률"].map((t) => h("th", { text: t })))),
        h("tbody", {}, d.monasteries.map((m) => h("tr", {}, [h("td", {}, h("strong", { text: m.name })), h("td", {}, h("span", { class: "vm-tag" + (m.status === "issue" ? " is-bad" : ""), text: MON_STATUS[m.status] })),
          h("td", { class: "num", text: fmtN(m.req) }), h("td", { class: "num", text: fmtN(m.made) }), h("td", { class: "num", text: fmtN(m.rec) }), h("td", { class: "num", text: fmtN(m.chk) }),
          h("td", {}, h("i", { class: "ops-bar", title: pct(m.chk, m.rec) }, h("b", { style: `width:${m.rec ? Math.min(100, (m.chk / m.rec) * 100) : 0}%` }))), h("td", { class: "num", text: pct(m.pass, m.chk) })])))
      ])) : h("div", { class: "card empty", text: "교육을 마친 수도회가 아직 없어요." })]),
      h("div", { class: "ops-grid2" }, [
        h("section", { class: "stack stack--sm" }, [h("h2", { class: "card__title", text: "도착 예정 택배" }), opsCards(d.incoming, (s) => opsCard(null, [opsTop(s.party, s.qty != null ? `${fmtN(s.qty)}개` : ""), opsLine([s.contents, s.trackingNo ? `송장 ${s.trackingNo}` : "", s.sentDate ? `발송 ${shortDate(s.sentDate)}` : ""].filter(Boolean).join(" · "))]), "도착 예정 택배가 없어요.")]),
        h("section", { class: "stack stack--sm" }, [h("h2", { class: "card__title", text: "기한 된 후속 조치" }), opsCards(d.late, (c) => opsCard(null, [opsTop(c.target, c.dueDate ? shortDate(c.dueDate) : ""), opsLine(c.followUp), opsLine(c.author ? `적은 사람 ${c.author}` : "")], "is-warn"), "기한 된 후속 조치가 없어요.")])
      ]),
      d.low.length ? h("section", { class: "stack stack--sm" }, [h("h2", { class: "card__title", text: "안전재고 미달" }), opsCards(d.low, (x) => opsCard(null, [opsTop(`${x.ledger} · ${x.name}`, `${fmtN(x.qty)} / ${fmtN(x.safety)} ${x.unit}`)], "is-warn"), "")]) : null
    ];
  }
  // ---- 재고·보관 (F09·F10): 품목별 재고·위치·안전재고, 위치 이동·실사 조정, 위치 등록(관리자)
  const LOC_KIND = { all: "공용", raw: "원자재", finished: "완제품", inspect: "검수 대기" };
  const REF_LABEL = { "": "직접 입력", move: "위치 이동", adjust: "실사 조정", cutting: "실자르기", handout: "타래 배분", purchase: "구매 입고", shipment: "택배", recovery: "회수", schedule: "방문 일정" };
  async function opsStock() {
    let d = await api("/ops/stock"), view = "items";
    const box = h("div", { class: "vm" });
    const locName = (id) => d.locations.find((x) => x.id === id)?.name || "위치 미정";
    const draw = () => {
      const all = d.ledgers.flatMap((l) => l.options.map((o) => ({ ...o, ledger: l, low: o.safety != null && o.qty < o.safety })));
      fill(box,
        h("div", { class: "vm-stats" }, [vmStat("품목", all.length), vmStat("안전재고 미달", all.filter((o) => o.low).length, all.some((o) => o.low)), vmStat("보관 위치", d.locations.filter((x) => x.active).length)]),
        opsSeg([["items", "품목별 재고"], ["locs", "보관 위치"], ["moves", "최근 입출고"]], view, (k) => { view = k; draw(); }),
        view === "items" ? h("div", { class: "stack stack--sm" }, d.ledgers.map((l) => h("section", { class: "stack stack--sm" }, [h("h2", { class: "card__title", text: `${l.name} (${l.unit})` }),
          opsCards(l.options, (o) => opsCard(d.canEdit ? () => edit(l, o) : null, [opsTop(o.name, `${fmtN(o.qty)} ${l.unit}`),
            opsLine(o.byLoc.length ? o.byLoc.map((x) => `${locName(x.locationId)} ${fmtN(x.qty)}`).join(" · ") : "위치 기록 없음"),
            opsTags(o.safety != null ? opsTag(`안전재고 ${fmtN(o.safety)}`, o.qty < o.safety ? "is-bad" : "") : null, o.qty < (o.safety ?? -Infinity) ? opsTag("부족", "is-bad") : null)], o.safety != null && o.qty < o.safety ? "is-warn" : ""), "품목이 없어요.")])))
        : view === "locs" ? h("div", { class: "stack stack--sm" }, [opsCards(d.locations, (x) => opsCard(d.canLocations ? () => locEdit(x) : null, [opsTop(x.name, LOC_KIND[x.kind]), opsLine([x.place, x.active ? "" : "쉼", x.note].filter(Boolean).join(" · ")),
            opsLine(`${all.filter((o) => o.byLoc.some((b) => b.locationId === x.id)).length}개 품목`)]), "아직 보관 위치가 없어요. 관리자가 등록해요."), d.canLocations ? opsAddBtn("보관 위치 등록", () => locEdit(null)) : null])
        : opsCards(d.moves, (m) => opsCard(d.canEdit && ["move", "adjust"].includes(m.refType) ? () => moveEdit(m) : null, [opsTop(`${shortDate(m.date)} · ${m.ledger}`, `${m.type === "in" ? "+" : "−"} ${m.items}`), opsTags(opsTag(REF_LABEL[m.refType] || m.refType), m.location ? opsTag(m.location) : null, m.toLocation ? opsTag(`→ ${m.toLocation}`) : null), m.note ? opsLine(m.note) : null]), "아직 입출고가 없어요."),
        view === "items" && d.canEdit ? opsAddBtn("위치 이동·실사 조정", () => edit(null, null)) : null);
    };
    const edit = (l0, o0) => {
      const opts = d.ledgers.flatMap((l) => l.options.map((o) => [`${l.id}:${o.id}`, `${l.name} · ${o.name} (${fmtN(o.qty)})`]));
      const what = opsSel(opts, l0 ? `${l0.id}:${o0.id}` : "", "품목 고르기");
      const mode = opsSel([["adjust", "실사 조정 (실제 센 수량)"], ["move", "위치 이동"], ["safety", "안전재고 정하기"], ...(isAdmin() ? [["color", "품목 색 정하기 (관리자)"]] : [])], "adjust");
      const cNow = () => { const [a, b] = what.value.split(":").map(Number); return d.ledgers.find((l) => l.id === a)?.options.find((o) => o.id === b); };
      const color = h("input", { type: "color", value: o0?.color || "#888888" }), noColor = h("input", { type: "checkbox", checked: !!o0 && !o0.color });
      what.addEventListener("change", () => { const o = cNow(); color.value = o?.color || "#888888"; noColor.checked = !!o && !o.color; });
      const fColor = h("div", { class: "field" }, [h("span", { class: "field__label", text: "품목 색" }), color, h("label", { class: "check" }, [noColor, h("span", { text: "색 없음" })])]);
      const locs = d.locations.filter((x) => x.active).map((x) => [x.id, x.name]);
      const from = opsSel(locs, "", "위치 미정"), to = opsSel(locs, "", "옮길 위치 고르기"), loc = opsSel(locs, "", "위치 전체");
      const qty = h("input", { type: "number", min: "0", inputmode: "numeric" }), note = h("input", { maxlength: "300", placeholder: "사유·메모" });
      const safety = h("input", { type: "number", min: "0", inputmode: "numeric", value: o0?.safety ?? "" });
      const fMove = h("div", { class: "row2" }, [field("보낸 위치", from), field("받는 위치", to)]), fLoc = field("센 위치", loc, "위치를 고르면 그 위치 기록과 비교해요"), fQty = field("수량", qty), fSafe = field("안전재고 (비우면 안 봄)", safety), fNote = field("메모", note);
      const sync = () => { fMove.hidden = mode.value !== "move"; fLoc.hidden = mode.value !== "adjust"; fSafe.hidden = mode.value !== "safety"; fColor.hidden = mode.value !== "color"; fQty.hidden = fNote.hidden = ["safety", "color"].includes(mode.value); fQty.querySelector(".field__label").textContent = mode.value === "move" ? "옮길 수량" : "실제 센 수량"; };
      mode.addEventListener("change", sync); sync();
      opsSheet("재고 고치기", [field("품목", what), field("할 일", mode), fMove, fLoc, fQty, fSafe, fColor, fNote], {
        save: async () => {
          if (!what.value) throw new Error("품목을 골라 주세요.");
          const [ledgerId, optionId] = what.value.split(":").map(Number);
          if (mode.value === "move") {
            const o = d.ledgers.find((l) => l.id === ledgerId).options.find((x) => x.id === optionId), have = o.byLoc.find((x) => String(x.locationId ?? "") === from.value)?.qty || 0;
            if (Number(qty.value) > have) throw new Error(`${from.value ? "보낸 위치" : "위치 미정"}에는 ${fmtN(have)}개만 있어요. 그보다 많이 옮길 수 없어요.`);
          }
          if (mode.value === "color") d = { ...d, ...(await api(`/ops/stock-options/${optionId}`, { method: "PATCH", body: { color: noColor.checked ? "none" : color.value } })) };
          else if (mode.value === "safety") d = { ...d, ...(await api(`/ops/stock-options/${optionId}`, { method: "PATCH", body: { safetyQty: safety.value } })) };
          else if (mode.value === "move") d = { ...d, ...(await api("/ops/stock/move", { method: "POST", body: { ledgerId, optionId, qty: qty.value, fromLocationId: from.value, toLocationId: to.value, note: note.value } })) };
          else d = { ...d, ...(await api("/ops/stock/adjust", { method: "POST", body: { ledgerId, optionId, actualQty: qty.value, locationId: loc.value, note: note.value } })) };
          toast("저장했어요."); draw();
        }
      });
    };
    // 위치 이동·실사 조정 고치기·지우기 (이동은 출고·입고 두 줄을 함께)
    const moveEdit = (m) => {
      const isMove = m.refType === "move";
      const out = isMove ? d.moves.find((x) => x.refType === "move" && x.type === "out" && (x.id === m.refId || x.refId === m.refId || x.id === m.id)) || m : m;
      const locs = d.locations.map((x) => [x.id, x.name]);
      const date = h("input", { type: "date", value: m.date }), note = h("input", { maxlength: "300", placeholder: "사유·메모" });
      const qty = h("input", { type: "number", min: "1", inputmode: "numeric", value: out.qty ?? "" });
      const from = opsSel(locs, out.locationId, "위치 미정"), to = opsSel(locs, out.toLocationId, "옮길 위치 고르기"), loc = opsSel(locs, m.locationId, "위치 미정");
      const diff = h("input", { type: "number", inputmode: "numeric", value: (m.type === "in" ? 1 : -1) * (m.qty || 0) });
      opsSheet(isMove ? "위치 이동 고치기" : "실사 조정 고치기", [opsLine(`${m.ledger} · ${m.items}`), field("날짜", date),
        ...(isMove ? [field("옮길 수량", qty), h("div", { class: "row2" }, [field("보낸 위치", from), field("받는 위치", to)])] : [field("조정 수량 (+ 늘림 · − 줄임)", diff), field("위치", loc)]), field("메모", note),
        opsHint("고치거나 지우면 입출고 수정 기록에 남아요.")], {
        ask: "이대로 고칠까요?",
        save: async () => { const body = isMove ? { date: date.value, qty: qty.value, fromLocationId: from.value, toLocationId: to.value, note: note.value } : { date: date.value, diff: diff.value, locationId: loc.value, note: note.value };
          d = { ...d, ...(await api(`/ops/stock/moves/${out.id}`, { method: "PATCH", body })) }; toast("고쳤어요."); draw(); },
        del: async () => { if (!confirm(isMove ? "이 위치 이동(출고·입고 두 줄)을 지울까요?" : "이 실사 조정을 지울까요?")) return false; d = { ...d, ...(await api(`/ops/stock/moves/${out.id}`, { method: "DELETE" })) }; toast("지웠어요."); draw(); }
      });
    };
    const locEdit = (x) => {
      const name = h("input", { value: x?.name || "", maxlength: "60", placeholder: "예: 본관 2층 자재실" }), place = h("input", { value: x?.place || "", maxlength: "80" });
      const kind = opsSel(Object.entries(LOC_KIND), x?.kind || "all"), active = h("input", { type: "checkbox", checked: x ? x.active : true }), note = h("input", { value: x?.note || "", maxlength: "300" });
      opsSheet(x ? "보관 위치 고치기" : "보관 위치 등록", [field("위치 이름", name), h("div", { class: "row2" }, [field("건물·방", place), field("용도", kind)]), h("label", { class: "check" }, [active, h("span", { text: "쓰는 위치" })]), field("메모", note)], {
        ask: x ? "이대로 고칠까요?" : null,
        save: async () => { d = { ...d, ...(await api(x ? `/ops/locations/${x.id}` : "/ops/locations", { method: x ? "PATCH" : "POST", body: { name: name.value, place: place.value, kind: kind.value, active: active.checked, note: note.value } })) }; toast("저장했어요."); draw(); },
        del: x ? async () => { if (!confirm(`'${x.name}' 위치를 지울까요? 입출고에 쓰인 위치는 지울 수 없고, '쓰는 위치'를 끄면 돼요.`)) return false; d = { ...d, ...(await api(`/ops/locations/${x.id}`, { method: "DELETE" })) }; toast("위치를 지웠어요."); draw(); } : null
      });
    };
    draw();
    return [opsHint("품목별 재고와 보관 위치를 봐요. 위치 이동은 출고·입고 두 줄로, 실사 조정은 차이만큼 입출고 기록에 남아요."), box];
  }
  // ---- 실자르기·타래 배분 (F07·F08): 누르면 고치기·지우기 (쌓인 입출고·택배 준비 건도 같이 맞춤)
  async function opsCutting() {
    let d = await api("/ops/cutting"), view = "jobs";
    const box = h("div", { class: "vm" });
    const optPairs = () => d.ledgers.flatMap((l) => l.options.map((o) => [`${l.id}:${o.id}`, `${l.name} · ${o.name} (${fmtN(o.qty)})`]));
    const mineOk = (x) => d.canEdit && (isAdmin() || x.createdBy === state.user.id);
    const draw = () => fill(box,
      h("div", { class: "vm-stats" }, [vmStat("이번 달 만든 타래", d.monthSkeins), vmStat("작업 기록", d.jobs.length), vmStat("배분", d.handouts.length)]),
      opsSeg([["jobs", "작업 기록"], ["hand", "타래 배분"]], view, (k) => { view = k; draw(); }),
      view === "jobs"
        ? opsCards(d.jobs, (j) => opsCard(mineOk(j) ? () => jobSheet(j) : null, [opsTop(`${shortDate(j.date)}${j.thread ? ` · ${j.thread}` : ""}`, `${fmtN(j.skeinQty)}타래`), opsLine([j.rawQty != null ? `실 ${fmtN(j.rawQty)} 사용` : "", j.workers ? `작업 ${j.workers}` : "", j.location].filter(Boolean).join(" · ")), j.note ? opsLine(j.note) : null]), "아직 실자르기 기록이 없어요.")
        : opsCards(d.handouts, (x) => opsCard(mineOk(x) ? () => handSheet(x) : null, [opsTop(`${shortDate(x.date)} · ${x.receiver}`, x.skeinQty ? `${fmtN(x.skeinQty)}타래` : ""), opsLine(Object.entries(x.supplies).map(([k, v]) => `${k} ${v}`).join(" · ")),
            opsTags(opsTag(x.receiverType === "monastery" ? "수도회" : "실봉사자"), x.shipmentId ? opsTag(`택배 ${SHIP_STATUS[x.shipStatus] || "준비"}${x.trackingNo ? ` · ${x.trackingNo}` : ""}`, "is-mine") : opsTag("직접 전달"))]), "아직 타래 배분 기록이 없어요."),
      d.canEdit ? opsAddBtn(view === "jobs" ? "실자르기 작업 기록" : "타래 배분", () => (view === "jobs" ? jobSheet(null) : handSheet(null))) : null);
    const pairOf = (l, o) => (l && o ? `${l}:${o}` : "");
    const jobSheet = (j) => {
      const date = h("input", { type: "date", value: j?.date || today() }), raw = opsSel(optPairs(), pairOf(j?.ledgerId, j?.optionId), "사용한 실 (선택)"), rawQty = h("input", { type: "number", min: "0", inputmode: "numeric", value: j?.rawQty ?? "" });
      const sk = opsSel(optPairs(), pairOf(j?.skeinLedgerId, j?.skeinOptionId), "타래를 넣을 품목 (선택)"), skQty = h("input", { type: "number", min: "0", inputmode: "numeric", value: j?.skeinQty ?? "" });
      const loc = opsSel(d.locations.map((x) => [x.id, x.name]), j?.locationId, "보관 위치 (선택)"), workers = h("input", { maxlength: "200", placeholder: "예: 김OO, 이OO", value: j?.workers || "" }), note = h("input", { maxlength: "300", value: j?.note || "" });
      opsSheet(j ? "실자르기 작업 고치기" : "실자르기 작업 기록", [field("작업일", date), h("div", { class: "row2" }, [field("사용한 실", raw), field("사용 수량", rawQty)]), h("div", { class: "row2" }, [field("만든 타래 → 품목", sk), field("만든 타래 수", skQty)]), field("타래 보관 위치", loc), field("함께한 봉사자", workers), field("메모", note),
        opsHint(j ? "고치면 이 작업으로 쌓인 실 출고·타래 입고를 새 값으로 다시 맞춰요." : "저장하면 사용한 실은 출고, 만든 타래는 입고로 입출고 기록에 쌓여요.")], {
        ask: j ? "이 작업을 고칠까요? 쌓인 입출고도 같이 바뀌어요." : null,
        save: async () => { const [rl, ro] = raw.value ? raw.value.split(":") : [], [sl, so] = sk.value ? sk.value.split(":") : [];
          const body = { date: date.value, ledgerId: rl, optionId: ro, rawQty: rawQty.value, skeinLedgerId: sl, skeinOptionId: so, skeinQty: skQty.value, locationId: loc.value, workers: workers.value, note: note.value };
          d = { ...d, ...(await api(j ? `/ops/cutting/${j.id}` : "/ops/cutting", { method: j ? "PATCH" : "POST", body })) }; toast(j ? "작업을 고쳤어요." : "작업을 기록했어요."); draw(); },
        del: j ? async () => { if (!confirm("이 작업 기록과 함께 쌓인 입출고를 지울까요?")) return false; d = { ...d, ...(await api(`/ops/cutting/${j.id}`, { method: "DELETE" })) }; draw(); } : null
      });
    };
    const handSheet = (x) => {
      const date = h("input", { type: "date", value: x?.date || today() }), type = opsSel([["volunteer", "실봉사자"], ["monastery", "수도회"]], x?.receiverType || "volunteer");
      const vol = opsSel(d.volunteers.map((y) => [y.id, y.name]), x?.userId, "봉사자 계정 (없으면 이름만)"), name = h("input", { maxlength: "80", placeholder: "받는 사람 이름", value: x?.receiverName || "" }), mon = opsSel(d.monasteries.map((y) => [y.id, y.name]), x?.monasteryId, "수도회 고르기");
      const fVol = h("div", { class: "row2" }, [field("봉사자", vol), field("이름 (계정 없을 때)", name)]), fMon = field("수도회", mon);
      const sync = () => { fVol.hidden = type.value !== "volunteer"; fMon.hidden = type.value !== "monastery"; }; type.addEventListener("change", sync); sync();
      const sk = opsSel(optPairs(), pairOf(x?.skeinLedgerId, x?.skeinOptionId), "타래 품목 (선택)"), qty = h("input", { type: "number", min: "0", inputmode: "numeric", value: x?.skeinQty || "" });
      const job = opsSel(d.jobs.map((j) => [j.id, `${shortDate(j.date)} 작업 ${j.skeinQty}타래`]), x?.cuttingJobId, "어느 작업에서 (선택)");
      const bags = h("input", { type: "number", min: "0", inputmode: "numeric", placeholder: "0", value: x?.supplies?.["대형 비닐팩"] ?? "" }), glue = h("input", { type: "number", min: "0", inputmode: "numeric", placeholder: "0", value: x?.supplies?.["순간접착제"] ?? "" });
      const parcel = h("input", { type: "checkbox", checked: !!x?.shipmentId }), addr = h("input", { maxlength: "200", placeholder: "택배 주소 (수도회는 비우면 등록된 주소)", value: x?.address || "" }), note = h("input", { maxlength: "300", value: x?.note || "" });
      const sent = x?.shipmentId && x.shipStatus && x.shipStatus !== "ready";
      opsSheet(x ? "타래 배분 고치기" : "타래 배분", [sent ? opsHint("이미 발송한 택배가 이어져 있어 고칠 수 없어요. 지우거나 택배 기록에서 처리해 주세요.") : null, field("전달일", date), field("받는 쪽", type), fVol, fMon, h("div", { class: "row2" }, [field("타래 품목", sk), field("타래 수", qty)]), field("작업", job),
        h("div", { class: "row2" }, [field("대형 비닐팩 (장)", bags), field("순간접착제 (개)", glue)]), h("label", { class: "check" }, [parcel, h("span", { text: "택배로 보내요 (택배 발송 '준비'로 넘김)" })]), field("주소", addr), field("메모", note),
        opsHint("같은 이름의 품목 열이 있는 자재는 그 대장에서 출고돼요.")], {
        ask: x ? "이 배분을 고칠까요? 쌓인 출고와 택배 준비 건도 같이 바뀌어요." : null,
        save: sent ? null : async () => { const [sl, so] = sk.value ? sk.value.split(":") : []; const supplies = {}; if (Number(bags.value)) supplies["대형 비닐팩"] = bags.value; if (Number(glue.value)) supplies["순간접착제"] = glue.value;
          const body = { date: date.value, receiverType: type.value, userId: vol.value, receiverName: name.value, monasteryId: mon.value, skeinLedgerId: sl, skeinOptionId: so, skeinQty: qty.value, cuttingJobId: job.value, supplies, parcel: parcel.checked, address: addr.value, note: note.value };
          d = { ...d, ...(await api(x ? `/ops/handouts/${x.id}` : "/ops/handouts", { method: x ? "PATCH" : "POST", body })) };
          toast(parcel.checked ? "배분을 저장하고 택배 발송 준비로 맞췄어요." : "배분을 저장했어요."); draw(); },
        del: x ? async () => { if (!confirm("이 배분 기록을 지울까요? 함께 쌓인 출고와 아직 보내지 않은 택배도 지워져요.")) return false; d = { ...d, ...(await api(`/ops/handouts/${x.id}`, { method: "DELETE" })) }; draw(); } : null
      });
    };
    draw();
    openRef("cutting", (id) => d.jobs.find((j) => j.id === id), (x) => (mineOk(x) ? jobSheet(x) : toast(`${x.date} 실자르기 작업이에요.`)));
    return [opsHint("실자르기 작업과 타래 배분을 적어요. 사용한 실·만든 타래·나눠 준 타래가 입출고에 함께 쌓이고, 누르면 고치거나 지울 수 있어요."), box];
  }
  // ---- 업체 구매 (F12)
  const PUR = { request: "요청", approved: "승인", ordered: "주문", received: "입고", canceled: "취소" };
  async function opsPurchases() {
    let d = await api("/ops/purchases"), view = "open";
    const box = h("div", { class: "vm" });
    const next = { request: "approved", approved: "ordered", ordered: "received" };
    const draw = () => {
      const open = d.purchases.filter((p) => !["received", "canceled"].includes(p.status)), list = view === "open" ? open : d.purchases;
      fill(box,
        h("div", { class: "vm-stats" }, [vmStat("요청", d.purchases.filter((p) => p.status === "request").length), vmStat("주문 중", d.purchases.filter((p) => p.status === "ordered").length), vmStat("입고", d.purchases.filter((p) => p.status === "received").length)]),
        opsSeg([["open", `진행 중 ${open.length}`], ["all", "전체"]], view, (k) => { view = k; draw(); }),
        opsCards(list, (p) => opsCard(d.canEdit ? () => edit(p) : null, [opsTop(p.itemName, PUR[p.status]), opsLine([p.qty != null ? `${fmtN(p.qty)}${p.unit}` : "", p.vendor, p.amount != null ? `${fmtN(p.amount)}원` : ""].filter(Boolean).join(" · ")),
          opsLine([p.expectedDate ? `입고 예정 ${shortDate(p.expectedDate)}` : "", p.orderDate ? `주문 ${shortDate(p.orderDate)}` : "", p.requester ? `요청 ${p.requester}` : ""].filter(Boolean).join(" · ")), p.reason ? h("span", { class: "vm-card__note small", text: p.reason }) : null]), view === "open" ? "진행 중인 구매가 없어요." : "아직 구매 기록이 없어요."),
        d.canEdit ? opsAddBtn("구매 요청", () => edit(null)) : null);
    };
    const edit = (p) => {
      const item = h("input", { value: p?.itemName || "", maxlength: "80", placeholder: "예: 대형 비닐팩" }), qty = h("input", { type: "number", min: "0", inputmode: "numeric", value: p?.qty ?? "" }), unit = h("input", { value: p?.unit || "", maxlength: "20", placeholder: "장·개" });
      const vendor = opsSel(d.vendors.map((v) => [v.id, `${v.name}${v.org ? ` · ${v.org}` : ""}`]), p?.vendorId, "업체 (외부 연락처에서)"), amount = h("input", { type: "number", min: "0", inputmode: "numeric", value: p?.amount ?? "" });
      const ledger = opsSel(d.ledgers.map((l) => [l.id, l.name]), p?.ledgerId, "입고할 대장 (입고 때 필요)"), expected = h("input", { type: "date", value: p?.expectedDate || "" }), reason = h("input", { value: p?.reason || "", maxlength: "300" }), note = h("input", { value: p?.note || "", maxlength: "500" });
      const nx = p && next[p.status];
      const opt = opsSel([], "", "품목 열"), loc = opsSel(d.locations.map((x) => [x.id, x.name]), "", "보관 위치 (선택)");
      const fillOpt = () => { const l = d.ledgers.find((x) => String(x.id) === ledger.value); opt.replaceChildren(h("option", { value: "", text: "품목 열 고르기" }), ...(l?.options || []).map((o) => h("option", { value: String(o.id), text: o.name }))); const same = l?.options.find((o) => o.name === item.value); if (same) opt.value = String(same.id); };
      ledger.addEventListener("change", fillOpt); fillOpt();
      const fRecv = h("div", { class: "row2" }, [field("입고 품목 열", opt), field("보관 위치", loc)]);
      fRecv.hidden = nx !== "received";
      const locked = p && p.status === "received";
      opsSheet(p ? `${p.itemName} · ${PUR[p.status]}` : "구매 요청", [field("품목", item), h("div", { class: "row2" }, [field("수량", qty), field("단위", unit)]), h("div", { class: "row2" }, [field("업체", vendor), field("금액 (원)", amount)]),
        h("div", { class: "row2" }, [field("입고할 대장", ledger), field("입고 예정일", expected)]), field("요청 이유", reason), field("메모", note), fRecv,
        nx ? opsHint(`저장하면 '${PUR[nx]}'(으)로 넘어가요.${nx === "approved" ? " 승인은 관리자만 해요." : nx === "received" ? " 입고하면 입출고 기록이 한 줄 생겨요." : ""}`) : null], locked ? {} : {
        saveText: p ? (nx ? `${PUR[nx]} 처리` : "저장하기") : "요청하기",
        save: async () => {
          const body = { itemName: item.value, qty: qty.value, unit: unit.value, vendorId: vendor.value, amount: amount.value, ledgerId: ledger.value, expectedDate: expected.value, reason: reason.value, note: note.value, ...(nx ? { status: nx } : {}), ...(nx === "received" ? { optionId: opt.value, locationId: loc.value } : {}) };
          d = { ...d, ...(await api(p ? `/ops/purchases/${p.id}` : "/ops/purchases", { method: p ? "PATCH" : "POST", body })) }; toast("저장했어요."); draw();
        },
        del: p && p.status !== "received" ? async () => { if (p.status !== "request") { if (!confirm("이 구매를 취소할까요?")) return false; d = { ...d, ...(await api(`/ops/purchases/${p.id}`, { method: "PATCH", body: { status: "canceled" } })) }; draw(); return; } if (!confirm("이 요청을 지울까요?")) return false; d = { ...d, ...(await api(`/ops/purchases/${p.id}`, { method: "DELETE" })) }; draw(); } : null
      });
    };
    draw();
    openRef("buy", (id) => d.purchases.find((p) => p.id === id), (p) => (d.canEdit ? edit(p) : toast(`${p.itemName} · ${PUR[p.status]}`)));
    return [opsHint("요청 → 승인(관리자) → 주문 → 입고 순서로 처리해요. 입고하면 고른 대장에 입고 기록이 생겨요."), box];
  }
  // ---- 권한표 (F14): 메뉴 × 역할 (조회·등록), 직원 쓰기 켜기
  async function opsPermsAdmin() {
    let d = await api("/ops/perms");
    const label = { dashboard: "대시보드", monasteries: "수도회 관리", contacts: "연락 기록", duties: "담당자·역할", criteria: "검수 기준", groups: "검수 조·배정", inspect: "검수 입력", cutting: "실자르기·타래", shipments: "택배 발송·수신", stock: "재고·보관", purchases: "업체 구매" };
    const roleName = { staff: "직원", dept: "부서 봉사자", team: "팀 봉사자" };
    const box = h("div", { class: "stack" });
    const draw = () => {
      const p = JSON.parse(JSON.stringify(d.perms));
      const staffOn = h("input", { type: "checkbox", checked: d.staffOn });
      const cell = (k, r, mode) => { const c = h("input", { type: "checkbox", checked: p[k][mode].includes(r), "aria-label": `${label[k]} ${roleName[r]} ${mode === "v" ? "조회" : "등록"}` }); c.addEventListener("change", () => { const a = new Set(p[k][mode]); c.checked ? a.add(r) : a.delete(r); p[k][mode] = [...a]; }); return c; };
      const ok = h("button", { class: "btn btn--primary", type: "button", text: "권한 저장", onclick: () => busy(ok, async () => { d = await act(() => api("/ops/perms", { method: "PUT", body: { staffOn: staffOn.checked, perms: p } })); state.opsPerms = null; toast("권한을 저장했어요. 각자 새로고침하면 바뀌어요."); draw(); }) });
      fill(box,
        h("label", { class: "check card ops-staffon" }, [staffOn, h("span", {}, [h("strong", { text: "직원도 쓰기" }), h("small", { class: "muted", text: " 켜면 직원 계정이 아래 표의 '직원' 칸대로 '수도회·물류' 메뉴를 써요. 기본은 꺼짐." })])]),
        h("div", { class: "card table-wrap" }, h("table", { class: "table ops-perms" }, [
          h("thead", {}, [h("tr", {}, [h("th", { rowspan: "2", text: "메뉴" }), ...d.roles.map((r) => h("th", { colspan: "2", class: "c", text: roleName[r] }))]), h("tr", {}, d.roles.flatMap(() => [h("th", { class: "c", text: "조회" }), h("th", { class: "c", text: "등록" })]))]),
          h("tbody", {}, d.keys.map((k) => h("tr", {}, [h("td", { text: label[k] }), ...d.roles.flatMap((r) => [h("td", { class: "c" }, cell(k, r, "v")), h("td", { class: "c" }, cell(k, r, "e"))])])))
        ])),
        opsHint("관리자는 늘 모두 봐요. 등록은 조회가 켜진 칸에서만 쓰여요. 검수 기준·검수 조의 등록은 팀 봉사자 중 리더만 해요. 수도회 연락처는 관리자만 적어요."),
        h("div", { class: "actions actions--start" }, [ok, h("button", { class: "btn btn--ghost", type: "button", text: "기본값으로", onclick: () => { d = { ...d, perms: JSON.parse(JSON.stringify(d.defaults)) }; draw(); } })]));
    };
    draw();
    return [opsHint("메뉴마다 역할별로 볼 수 있는지(조회)와 적을 수 있는지(등록)를 정해요. 기본값은 DB 설계 화면안의 메뉴 표예요."), box];
  }
  // ---- 묵주 교육 기록 · 봉사자 명단 (관리자 전용으로 시작): 교육 회차·진행상태·참여 봉사자·출납 상세, 계정 없는 봉사자 명단과 봉사자별 집계
  const ROSTER_KIND = { making: "묵주 만들기", cutting: "실 자르기", etc: "기타" };
  const EDU_PROG = { done: "진행완료", planned: "진행예정" };
  const qtyText = (v) => (v == null ? "-" : fmtN(v));
  async function adminRosaryEdu() {
    let d = await api("/admin/vol-edu"), prog = "", qv = "", onlyBad = false;
    const box = h("div", { class: "stack" });
    const draw = () => {
      const rows = d.rows.filter((r) => (!prog || r.progress === prog) && (!qv || nospace(r.org).includes(nospace(qv)) || r.code.includes(qv.toUpperCase())) && (!onlyBad || r.mismatch.length));
      const st = opsSel(Object.entries(EDU_PROG), prog, "모든 진행상태");
      st.addEventListener("change", () => { prog = st.value; draw(); });
      const search = h("input", { type: "search", placeholder: "수도회·회차 검색", "aria-label": "수도회·회차 검색", value: qv });
      search.addEventListener("change", () => { qv = search.value.trim(); draw(); });
      const bad = h("input", { type: "checkbox", checked: onlyBad, onchange: (e) => { onlyBad = e.target.checked; draw(); } });
      const total = (k) => rows.reduce((n, r) => n + (r[k] || 0), 0);
      fill(box,
        h("div", { class: "vm-stats" }, [vmStat("교육", d.rows.length), vmStat("진행완료", d.rows.filter((r) => r.progress === "done").length), vmStat("진행예정", d.rows.filter((r) => r.progress !== "done").length), vmStat("출납 불일치", d.rows.filter((r) => r.mismatch.length).length, d.rows.some((r) => r.mismatch.length))]),
        h("div", { class: "filters" }, [st, search, h("label", { class: "check" }, [bad, h("span", { text: "불일치만" })]), h("span", { class: "muted small", text: `${rows.length}건` }), h("button", { class: "btn btn--primary btn--sm", type: "button", onclick: () => addEdu() }, [icon("plus"), "교육 추가"])]),
        rows.length ? h("div", { class: "card table-wrap" }, h("table", { class: "table edu-table" }, [
          h("thead", {}, h("tr", {}, ["회차", "날짜", "수도회", "진행", "진행 봉사자", "요청", "배당", "자른실 지급", "십자가 지급", "미지급 실·십자가", "보낼 실·십자가", "샘플", "완성", "로스", "담당", "확인"].map((t) => h("th", { text: t })))),
          h("tbody", {}, rows.map((r) => h("tr", { class: "stock-row" + (r.mismatch.length ? " is-warn" : ""), tabindex: "0", onclick: () => edit(r), onkeydown: (e) => { if (e.key === "Enter") edit(r); } }, [
            h("td", { class: "nowrap", text: r.code || "-" }), h("td", { class: "nowrap", text: r.tableOnly ? `${shortDate(r.date)} (미정)` : `${shortDate(r.date)}${r.startTime ? ` ${r.startTime}` : ""}` }), h("td", { text: r.org }),
            h("td", { class: "nowrap" }, r.delay ? statusTag("연기", "is-delay") : statusTag(EDU_PROG[r.progress], r.progress === "done" ? "is-done" : "is-plan")),
            h("td", { class: "small", text: r.helpers.map((x) => x.call).join(", ") || "-" }),
            ...["qty", "alloc", "thread", "cross"].map((k) => h("td", { class: "num", text: qtyText(r[k]) })),
            h("td", { class: "num nowrap", text: `${qtyText(r.unpaidThread)} · ${qtyText(r.unpaidCross)}` }), h("td", { class: "num nowrap", text: `${qtyText(r.sendThread)} · ${qtyText(r.sendCross)}` }),
            ...["sample", "done", "loss"].map((k) => h("td", { class: "num", text: qtyText(r[k]) })),
            h("td", { class: "small", text: r.handler || "-" }), h("td", { class: "small edu-bad", text: r.mismatch.join(" / ") })
          ]))),
          h("tfoot", {}, h("tr", {}, [h("td", { colspan: "5", text: "합계" }), ...["qty", "alloc", "thread", "cross"].map((k) => h("td", { class: "num", text: fmtN(total(k)) })), h("td", { class: "num nowrap", text: `${fmtN(total("unpaidThread"))} · ${fmtN(total("unpaidCross"))}` }), h("td", { class: "num nowrap", text: `${fmtN(total("sendThread"))} · ${fmtN(total("sendCross"))}` }), ...["sample", "done", "loss"].map((k) => h("td", { class: "num", text: fmtN(total(k)) })), h("td", { colspan: "2" })]))
        ])) : h("div", { class: "card empty", text: "조건에 맞는 교육이 없어요." }));
    };
    const edit = (r) => {
      const num = (v) => h("input", { type: "number", min: "0", inputmode: "numeric", value: v ?? "" });
      const code = h("input", { maxlength: "20", value: r.code, placeholder: "예: S12" }), pr = opsSel(Object.entries(EDU_PROG), r.progress);
      const on = new Map(r.helpers.map((x) => [x.id, x.role]));
      const pick = h("div", { class: "vol-pick edu-pick" }, Object.entries(ROSTER_KIND).map(([k, label]) => {
        const list = d.roster.filter((p) => p.kind === k);
        return list.length ? h("fieldset", { class: "edu-pick__group" }, [h("legend", { class: "small muted", text: label }), ...list.map((p) => h("label", { class: "vol-pick__row" }, [
          h("input", { type: "checkbox", checked: on.has(p.id), onchange: (e) => { if (e.target.checked) on.set(p.id, p.call === "수녀님" ? "수녀님" : "봉사자"); else on.delete(p.id); } }), h("span", { text: p.name && p.name !== p.call ? `${p.call} (${p.name})` : p.call })]))]) : null;
      }).filter(Boolean));
      const f = { alloc: num(r.alloc), thread: num(r.thread), cross: num(r.cross), sendThread: num(r.sendThread), sendCross: num(r.sendCross), sample: num(r.sample), done: num(r.done), loss: num(r.loss) };
      const handler = h("input", { maxlength: "100", value: r.handler }), note = h("textarea", { rows: "2", maxlength: "500" }, r.matNote);
      const orgIn = h("input", { maxlength: "80", value: r.org }), dateIn = h("input", { type: "date", value: r.tableOnly ? "" : r.date }), timeIn = h("input", { type: "time", value: r.tableOnly ? "" : r.startTime });
      const { el: orgAsk, ask: askOrg } = orgAskPanel();
      let orgConfirm = "";
      orgIn.addEventListener("input", () => { orgAsk.hidden = true; orgConfirm = ""; });
      opsSheet(`${r.code ? `${r.code} · ` : ""}${r.org}`, [
        opsHint(`${r.tableOnly ? "날짜 미정" : `${volDay(r.date)}${r.startTime ? ` ${r.startTime}` : ""}`} · 요청 ${qtyText(r.qty)}. 미지급은 배당 − 지급으로 계산하고, 보낼 수량과 다르면 '확인'에 표시해요.${r.delay ? " 팀 봉사자가 '연기'로 둔 교육이에요. 진행완료로 바꾸면 연기가 풀려요." : ""}`),
        field("수도회", orgIn), orgAsk,
        h("div", { class: "row2" }, [field("교육 날짜", dateIn, "비우고 저장하면 '미정'이 돼서 달력에 안 보여요"), field("시작 시간", timeIn)]),
        h("div", { class: "row2" }, [field("교육 회차", code), field("진행상태", pr)]),
        h("div", { class: "field" }, [h("span", { class: "field__label", text: `진행 봉사자 (${on.size}명)` }), d.roster.length ? pick : h("p", { class: "muted small", text: "먼저 '봉사자 명단'에 봉사자를 넣어 주세요." })]),
        h("div", { class: "row2" }, [field("배당물량", f.alloc), field("담당 봉사자", handler)]),
        h("div", { class: "row2" }, [field("자른실 지급", f.thread), field("십자가 지급", f.cross)]),
        h("div", { class: "row2" }, [field("보낼 실 (기재)", f.sendThread), field("보낼 십자가 (기재)", f.sendCross)]),
        h("div", { class: "row2" }, [field("샘플 묵주", f.sample), h("div", { class: "row2" }, [field("완성 묵주", f.done), field("로스", f.loss)])]),
        field("출납 비고", note)
      ], {
        save: async () => {
          const body = { code: code.value, ...(pr.value !== r.progress ? { progress: pr.value } : {}), handler: handler.value, matNote: note.value, helpers: [...on].map(([id, role]) => ({ id, role })) };
          for (const [k, el] of Object.entries(f)) body[k] = el.value;
          if (orgIn.value.trim() !== r.org.trim()) Object.assign(body, { org: orgIn.value, ...(orgConfirm ? { orgConfirm } : {}) });
          if (dateIn.value ? r.tableOnly || dateIn.value !== r.date || timeIn.value !== (r.startTime || "") : !r.tableOnly) Object.assign(body, { date: dateIn.value, startTime: dateIn.value ? timeIn.value : "" });
          let x;
          try { x = await apiAsk(`/admin/vol-edu/${r.id}`, { method: "PATCH", body }); }
          catch (ex) { if (!ex.confirm) throw ex; askOrg(ex.confirm, (v) => { orgConfirm = v; orgIn.closest("form").requestSubmit(); }); return false; }
          if (!x) return false;
          d.rows = x.rows || d.rows.map((y) => (y.id === r.id ? x.row : y)); d.roster = x.roster; toast("저장했어요."); draw();
        },
        del: async () => {
          if (!confirm(`'${r.org}' 교육을 지울까요? 출납(배당·지급)과 교육 결과·문의 기록도 함께 지워져요.`)) return false;
          const x = await api(`/admin/vol-edu/${r.id}`, { method: "DELETE" }); d.rows = x.rows; d.roster = x.roster; toast("지웠어요."); draw();
        }
      });
    };
    const addEdu = () => {
      const org = h("input", { maxlength: "80", placeholder: "예: ○○수녀회" }), date = h("input", { type: "date" }), time = h("input", { type: "time" }), qty = h("input", { type: "number", min: "0", inputmode: "numeric" }), place = h("input", { maxlength: "120" });
      const { el: askEl, ask } = orgAskPanel();
      let orgConfirm = "";
      org.addEventListener("input", () => { askEl.hidden = true; orgConfirm = ""; });
      opsSheet("교육 추가", [field("수도회", org), askEl, h("div", { class: "row2" }, [field("교육 날짜", date, "비우면 '미정'으로 표에만 보여요"), field("시작 시간", time)]), h("div", { class: "row2" }, [field("요청수량", qty), field("장소", place)])], {
        saveText: "추가하기",
        save: async () => { let x; try { x = await api("/admin/vol-edu", { method: "POST", body: { org: org.value, date: date.value, startTime: time.value, qty: qty.value, place: place.value, ...(orgConfirm ? { orgConfirm } : {}) } }); } catch (ex) { if (!ex.confirm) throw ex; ask(ex.confirm, (v) => { orgConfirm = v; org.closest("form").requestSubmit(); }); return false; } d.rows = x.rows; d.roster = x.roster; toast("교육을 추가했어요."); draw(); }
      });
    };
    draw();
    openRef(["edu", "made", "req"], (id) => d.rows.find((r) => r.id === id), edit);
    return h("div", { class: "stack" }, [opsHint("묵주 교육마다 진행상태·진행 봉사자·출납을 적어요. 줄을 누르면 고쳐요. 지금은 관리자만 봐요."), box]);
  }
  async function adminRoster() {
    let d = await api("/admin/vol-roster"), kind = "";
    const box = h("div", { class: "stack" });
    const draw = () => {
      const rows = d.roster.filter((r) => !kind || r.kind === kind);
      const st = opsSel(Object.entries(ROSTER_KIND), kind, "모든 구분");
      st.addEventListener("change", () => { kind = st.value; draw(); });
      fill(box,
        h("div", { class: "vm-stats" }, [vmStat("명단", d.roster.length), vmStat("묵주 만들기", d.roster.filter((r) => r.kind === "making").length), vmStat("실 자르기", d.roster.filter((r) => r.kind === "cutting").length), vmStat("계정 연결", d.roster.filter((r) => r.userId).length)]),
        h("div", { class: "filters" }, [st, h("button", { class: "btn btn--primary btn--sm", type: "button", onclick: () => edit(null) }, [icon("plus"), "봉사자 추가"])]),
        rows.length ? h("div", { class: "card table-wrap" }, h("table", { class: "table" }, [
          h("thead", {}, h("tr", {}, ["호칭", "이름", "구분", "소속", "계정", "진행완료", "진행예정", "첫 참여", "최근 참여"].map((t) => h("th", { text: t })))),
          h("tbody", {}, rows.map((r) => h("tr", { class: "stock-row", tabindex: "0", onclick: () => edit(r), onkeydown: (e) => { if (e.key === "Enter") edit(r); } }, [
            h("td", { class: "nowrap", text: r.call }), h("td", { class: "nowrap", text: r.name || "-" }), h("td", { class: "nowrap", text: ROSTER_KIND[r.kind] }), h("td", { text: r.affiliation || "-" }),
            h("td", { class: "nowrap", text: r.userName || "-" }), h("td", { class: "num", text: fmtN(r.done) }), h("td", { class: "num", text: fmtN(r.planned) }),
            h("td", { class: "nowrap", text: r.first ? shortDate(r.first) : "-" }), h("td", { class: "nowrap", text: r.last ? shortDate(r.last) : "-" })
          ])))
        ])) : h("div", { class: "card empty", text: "아직 명단이 없어요." }));
    };
    const edit = (r) => {
      const call = h("input", { maxlength: "40", value: r?.call || "", placeholder: "일정표에 적는 이름 (예: 은희)" }), name = h("input", { maxlength: "40", value: r?.name || "" });
      const k = opsSel(Object.entries(ROSTER_KIND), r?.kind || "making"), aff = h("input", { maxlength: "100", value: r?.affiliation || "", placeholder: "예: 서울대교구 ○○성당" });
      const user = opsSel(d.users.map((u) => [u.id, u.name]), r?.userId ?? "", "계정 없음"), note = h("textarea", { rows: "2", maxlength: "300" }, r?.note || "");
      opsSheet(r ? "봉사자 고치기" : "봉사자 추가", [
        opsHint("세례명·연락처는 적지 않아요. 사이트 계정이 있는 봉사자는 계정을 골라 이어 주세요."),
        h("div", { class: "row2" }, [field("호칭", call), field("이름", name)]), h("div", { class: "row2" }, [field("구분", k), field("계정 연결 (선택)", user)]), field("소속", aff), field("메모", note)
      ], {
        save: async () => { d = { ...d, ...(await api(r ? `/admin/vol-roster/${r.id}` : "/admin/vol-roster", { method: r ? "PATCH" : "POST", body: { call: call.value, name: name.value, kind: k.value, affiliation: aff.value, userId: user.value || null, note: note.value } })) }; toast("저장했어요."); draw(); },
        del: r ? async () => { if (!confirm(`'${r.call}'을(를) 명단에서 지울까요?`)) return false; d = { ...d, ...(await api(`/admin/vol-roster/${r.id}`, { method: "DELETE" })) }; toast("지웠어요."); draw(); } : null
      });
    };
    draw();
    return h("div", { class: "stack" }, [opsHint("교육을 진행하는 봉사자 명단이에요 (사이트 계정이 없어도 돼요). 진행 횟수는 '교육 기록'의 진행 봉사자로 세고, 합동 교육은 한 번으로 세요."), box]);
  }
  // ---- 묵주 WBS: 서버에 저장된 공정표를 받아 씀 (없으면 화면에 들어 있는 기본값). 고치기는 관리자만
  const ROSARY_DEFAULT = { procs: JSON.parse(JSON.stringify(ROSARY_PROCS)), milestones: JSON.parse(JSON.stringify(ROSARY_MILESTONES)) };
  let rosaryWbsLoaded = false;
  async function loadRosaryWbs(force) {
    if (rosaryWbsLoaded && !force) return;
    try {
      const r = await api("/ops/wbs");
      const w = r.wbs || ROSARY_DEFAULT;
      ROSARY_PROCS = JSON.parse(JSON.stringify(w.procs)); ROSARY_MILESTONES = JSON.parse(JSON.stringify(w.milestones));
      rosaryWbsLoaded = true;
    } catch (e) { /* 못 받으면 기본값 */ }
  }
  async function adminWbs() {
    await loadRosaryWbs(true);
    let draft = { procs: JSON.parse(JSON.stringify(ROSARY_PROCS)), milestones: JSON.parse(JSON.stringify(ROSARY_MILESTONES)) }, editing = false;
    const box = h("div", { class: "stack" });
    const draw = () => {
      if (!editing) return fill(box, h("div", { class: "actions actions--start" }, [h("button", { class: "btn btn--primary btn--sm btn--admin", type: "button", onclick: () => { editing = true; draw(); } }, [icon("lock"), "WBS 고치기"])]), volWbsRosary());
      const ids = Object.keys(draft.procs).map(Number).sort((a, b) => a - b);
      const inp = (obj, k, ph, max) => { const e = h("input", { value: obj[k] || "", maxlength: String(max || 200), placeholder: ph }); e.addEventListener("input", () => { obj[k] = e.value; }); return e; };
      const msBox = draft.milestones.map((m, i) => {
        const pr = h("input", { value: m.procs.join(", "), placeholder: "예: 1, 2, 3", "aria-label": "공정 번호" }); pr.addEventListener("input", () => { m.procs = pr.value.split(/[,\s]+/).map(Number).filter((n) => n > 0); });
        return h("div", { class: "card ops-critrow" }, [h("div", { class: "row2" }, [field(`${i + 1}. 마일스톤`, inp(m, "name", "예: 원자재 조달", 60)), field("공정 번호", pr, "아래 공정의 번호를 쉼표로")]),
          h("div", { class: "row2" }, [field("주 업무", inp(m, "main", "")), field("연결 업무", inp(m, "link", ""))]),
          h("button", { class: "link-btn small", type: "button", text: "이 마일스톤 빼기", onclick: () => { draft.milestones.splice(i, 1); draw(); } })]);
      });
      const prBox = ids.map((id) => {
        const p = draft.procs[id];
        const fixed = h("input", { type: "checkbox", checked: !!p.fixed }); fixed.addEventListener("change", () => { p.fixed = fixed.checked; });
        const tasks = h("textarea", { rows: "2", placeholder: "추가 과업 (한 줄에 하나)" }, (p.tasks || []).join("\n")); tasks.addEventListener("input", () => { p.tasks = tasks.value.split("\n").map((x) => x.trim()).filter(Boolean); });
        return h("div", { class: "card ops-critrow" }, [h("div", { class: "row2" }, [field(`공정 ${id}`, inp(p, "name", "공정 이름", 80)), h("label", { class: "check" }, [fixed, h("span", { text: "확정" })])]),
          h("div", { class: "row2" }, [field("특징", inp(p, "feat", "", 300)), field("연결 업무", inp(p, "link", ""))]), field("공동 작업 (비우면 없음)", inp(p, "joint", "")), field("추가 과업", tasks),
          h("button", { class: "link-btn small", type: "button", text: "이 공정 빼기", onclick: () => { delete draft.procs[id]; draft.milestones.forEach((m) => { m.procs = m.procs.filter((n) => n !== id); }); draw(); } })]);
      });
      const save = h("button", { class: "btn btn--primary", type: "button", text: "WBS 저장", onclick: () => { if (!confirm("WBS 를 이대로 저장할까요? 봉사자 화면에도 바로 보여요.")) return; busy(save, async () => { try { const r = await api("/ops/wbs", { method: "PUT", body: draft }); ROSARY_PROCS = r.wbs.procs; ROSARY_MILESTONES = r.wbs.milestones; rosaryWbsLoaded = true; editing = false; toast("WBS 를 저장했어요."); draw(); } catch (ex) { toast(ex.message); } }); } });
      fill(box,
        opsHint("관리자만 고쳐요. 마일스톤마다 공정 번호를 쉼표로 적고, 공정은 아래에서 이름·확정 여부·특징·추가 과업을 고쳐요."),
        h("h2", { class: "card__title", text: "마일스톤" }), ...msBox, h("button", { class: "btn btn--ghost btn--sm", type: "button", onclick: () => { draft.milestones.push({ name: "", main: "", link: "", procs: [] }); draw(); } }, [icon("plus"), "마일스톤 더하기"]),
        h("h2", { class: "card__title", text: "공정" }), ...prBox, h("button", { class: "btn btn--ghost btn--sm", type: "button", onclick: () => { const n = Math.max(0, ...ids) + 1; draft.procs[n] = { name: "", feat: "", link: "" }; draw(); } }, [icon("plus"), "공정 더하기"]),
        h("div", { class: "actions actions--start" }, [save, h("button", { class: "btn btn--ghost", type: "button", text: "취소", onclick: () => { draft = { procs: JSON.parse(JSON.stringify(ROSARY_PROCS)), milestones: JSON.parse(JSON.stringify(ROSARY_MILESTONES)) }; editing = false; draw(); } }),
          h("button", { class: "btn btn--ghost", type: "button", text: "처음 공정표로", onclick: () => { if (!confirm("처음(기본) 공정표로 되돌려 고칠까요? 저장해야 반영돼요.")) return; draft = JSON.parse(JSON.stringify(ROSARY_DEFAULT)); draw(); } })]));
    };
    draw();
    return box;
  }
  async function pageVolAdmin() {
    if (!isAdmin()) return go("#/today");
    document.title = `봉사자 관리 · ${TITLE}`;
    drawMini(null);
    setMain("volunteers", loading());
    if (route().id === "deadlines") return location.replace("#/volunteers"); // 없앤 탭의 예전 주소
    const tab = ["training", "stock", "records", "inspect", "team", "menu", "wbs", "edu", "roster"].includes(route().id) ? route().id : "schedule";
    let extraView = null; // 묵주 WBS·교육 기록·봉사자 명단 탭 (비동기로 그린 화면)
    let teamData = null; // 팀 봉사자 탭: { issues, docs, orgs }
    const ins = inspModule("/admin", () => draw(), "검수할 때마다 한 줄씩 적고, 거른 기록을 업체 클레임 근거로 CSV·인쇄로 내보내요. 샘플링이면 불량률은 샘플 수 기준이에요. 팀 봉사자가 적은 기록도 여기에 함께 보여요.");
    let vols = [], schedules = [], trainings = [], stockMoves = [], volRecords = [], volMenuSet = null;
    const seg = h("div", { class: "seg ops-tabs", role: "tablist" }, [["schedule", "일정"], ["edu", "교육 기록"], ["roster", "봉사자 명단"], ["training", "기본 교육"], ["stock", "입출고 입력"], ["records", "완제품 기록"], ["inspect", "검수 관리"], ["team", "팀 봉사자"], ["wbs", "묵주 WBS"], ["menu", "메뉴 공개"]].map(([k, label]) => h("button", { type: "button", role: "tab", "aria-selected": String(k === tab), text: label, onclick: () => go(k === "schedule" ? "#/volunteers" : `#/volunteers/${k}`) })));
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
      const qty = h("input", { type: "number", min: "0", inputmode: "numeric", value: s?.qty ?? "" });
      const eduQty = h("input", { type: "number", min: "0", inputmode: "numeric", value: s?.eduQty ?? "" });
      const linkBox = h("input", { type: "checkbox", checked: s ? !!s.project : false });
      const tableOnlyBox = h("input", { type: "checkbox", checked: !!s?.tableOnly });
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
        field("교육물량 (선택)", eduQty, s?.eduBy ? `마지막 수정: ${s.eduBy}` : "교육 때 쓰거나 나눈 물량"),
        h("div", { class: "row2" }, [field("수량 (선택)", qty, s?.qtyBy ? `마지막 수정: ${s.qtyBy}` : null), h("label", { class: "check vol-linkcheck" }, [linkBox, h("span", { text: "묵주 프로젝트 방문 (봉사자 프로젝트 관리에서 수량을 고쳐요)" })])]),
        h("label", { class: "check" }, [tableOnlyBox, h("span", { text: "달력에는 안 보이게 (수업 날짜 미정, 추가 전달 물량 표에만)" })]),
        h("div", { class: "field" }, [h("span", { class: "field__label", text: "대상" }), seg2, box]), err,
        h("div", { class: "actions" }, [s ? delBtn(s.title, `/admin/vol-schedules/${s.id}`) : null, h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), ok])
      ]);
      saveForm(form, ok, err, () => api(s ? `/admin/vol-schedules/${s.id}` : "/admin/vol-schedules", { method: s ? "PATCH" : "POST", body: { title: title.value, date: date.value, startTime: start.value, endTime: end.value, place: place.value, note: note.value, audience, userIds: [...picked], qty: qty.value, eduQty: eduQty.value, project: linkBox.checked, tableOnly: tableOnlyBox.checked } }));
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
    // 봉사자가 적은 완제품 기록: 관리자가 고치거나 지움
    function recordDialog(r) {
      const err = errorLine(), STG = { in: "입고", checked: "검수완료", packed: "패키징 완료", out: "출고" };
      const stage = opsSel(Object.entries(STG), r.stage), date = h("input", { type: "date", value: r.date }), qty = h("input", { type: "number", min: "0", inputmode: "numeric", value: String(r.qty) }), name = h("input", { value: r.name, maxlength: "80" }), note = h("input", { value: r.note, maxlength: "300" });
      const ok = h("button", { class: "btn btn--primary", type: "submit", text: "저장" });
      const form = h("form", { class: "stack", novalidate: true }, [h("p", { class: "muted small", text: `${r.group} · 적은 사람 ${r.author || "-"}` }), h("div", { class: "row2" }, [r.kind === "recovery" ? field("단계", stage) : null, field("날짜", date)]), h("div", { class: "row2" }, [field("수량", qty), field("입고·출고 장소 (대상)", name)]), field("메모", note), err,
        h("div", { class: "actions" }, [h("button", { class: "btn btn--danger-outline btn--sm", type: "button", text: "지우기", onclick: async () => { if (!confirm("이 기록을 지울까요?")) return; if (!(await act(() => apiAsk(`/volunteer/records/${r.id}`, { method: "DELETE" })))) return; closeDialog(); await page.reload(); } }),
          h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), ok])]);
      form.addEventListener("submit", (e) => { e.preventDefault(); busy(ok, async () => { try { if (!(await apiAsk(`/volunteer/records/${r.id}`, { method: "PATCH", body: { stage: stage.value, date: date.value, qty: qty.value, name: name.value, note: note.value } }))) return; closeDialog(); toast("저장했어요."); await page.reload(); } catch (ex) { showError(err, ex.message); } }); });
      openDialog("완제품 기록 고치기", form, { admin: true });
    }
    const rowAttrs = (fn) => ({ class: "stock-row", tabindex: "0", onclick: fn, onkeydown: (e) => { if (e.key === "Enter") fn(); } });
    const draw = () => {
      const scheduleView = schedules.length ? h("div", { class: "card table-wrap" }, h("table", { class: "table" }, [
        h("thead", {}, h("tr", {}, ["번호", "날짜", "시간", "제목", "장소", "요청수량", "교육물량", "실 출고", "십자가 출고", "차액", "대상", "입력자"].map((x) => h("th", { text: x })))),
        h("tbody", {}, schedules.map((s, i) => h("tr", { ...rowAttrs(() => scheduleDialog(s)), "data-ref": `sched:${s.id}` }, [
          h("td", { class: "num muted", text: String(i + 1) }),
          h("td", { class: "nowrap", text: volDay(s.date) }), h("td", { class: "nowrap", text: volTime(s) || "-" }), h("td", {}, [s.title, s.tableOnly ? h("span", { class: "stock-tag vol-visits__tag", text: "달력 미정" }) : null, s.sumNote ? h("small", { class: "muted", text: ` · 합계 제외: ${s.sumNote}` }) : null]), h("td", { text: s.place || "-" }), h("td", { class: "nowrap num", text: s.qty != null ? fmtN(s.qty) : "-" }), h("td", { class: "nowrap num", text: s.eduQty != null ? fmtN(s.eduQty) : "-" }), h("td", { class: "nowrap num", text: s.threadQty != null ? fmtN(s.threadQty) : "-" }), h("td", { class: "nowrap num", text: s.crossQty != null ? fmtN(s.crossQty) : "-" }), h("td", { class: "nowrap num " + diffCls(qtyDiff(s)), text: diffText(qtyDiff(s)) }),
          h("td", { text: s.audience === "all" ? "전체" : s.userIds.map((id) => vols.find((u) => u.id === id)?.name).filter(Boolean).join(", ") || "지정 없음" }),
          h("td", { class: "nowrap" }, s.byVolunteer ? [s.enteredBy, " ", h("span", { class: "stock-tag", text: "봉사자" })] : s.enteredBy || "-")
        ])))
      ])) : h("div", { class: "card empty", text: "아직 등록한 일정이 없어요." });
      const trainingView = trainings.length ? h("div", { class: "card table-wrap" }, h("table", { class: "table" }, [
        h("thead", {}, h("tr", {}, ["제목", "일시", "장소", "이수"].map((x) => h("th", { text: x })))),
        h("tbody", {}, trainings.map((t) => h("tr", { ...rowAttrs(() => trainingDialog(t)), "data-ref": `training:${t.id}` }, [
          h("td", { text: t.title }), h("td", { class: "nowrap", text: [t.date ? volDay(t.date) : "", t.startTime].filter(Boolean).join(" ") || "-" }), h("td", { text: t.place || "-" }), h("td", { class: "nowrap", text: `${t.doneBy.length} / ${vols.length}명` })
        ])))
      ])) : h("div", { class: "card empty", text: "아직 등록한 교육이 없어요." });
      const when = (m) => { const d = new Date(`${m.createdAt.replace(" ", "T")}Z`); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
      const stockView = stockMoves.length ? h("div", { class: "card table-wrap" }, h("table", { class: "table" }, [
        h("thead", {}, h("tr", {}, ["입력 시각", "입력자", "대장", "구분", "날짜", "수량", "검수", "사진", "이슈", "비고"].map((x) => h("th", { text: x })))),
        h("tbody", {}, stockMoves.map((m) => h("tr", rowAttrs(() => go(`#/stock/${m.ledgerId}`)), [
          h("td", { class: "nowrap", text: when(m) }), h("td", { class: "nowrap", text: m.enteredBy }), h("td", { text: m.ledgerName }), h("td", { class: "nowrap", text: m.type === "in" ? "입고" : "출고" }), h("td", { class: "nowrap", text: m.date }), h("td", { class: "nowrap", text: `${fmtN(m.total)} ${m.unit}` }),
          h("td", { class: "nowrap", text: m.inspectOk != null || m.inspectBad != null ? `합격 ${fmtN(m.inspectOk || 0)} · 불량 ${fmtN(m.inspectBad || 0)}` : "-" }),
          h("td", { class: "nowrap", text: m.photos ? `${m.photos}장` : "-" }), h("td", { class: "move-issue", text: m.issue || "" }), h("td", { text: m.note || "-" })
        ])))
      ])) : h("div", { class: "card empty", text: "아직 봉사자가 입력한 기록이 없어요." });
      // 봉사자가 적은 원자재 보유물량 · 제품 회수물량
      const recView = volRecords.length ? h("div", { class: "card table-wrap" }, h("table", { class: "table" }, [
        h("thead", {}, h("tr", {}, ["종류", "묶음", "날짜", "입고·출고 장소 (대상)", "수량", "메모", "적은 사람"].map((x) => h("th", { text: x })))),
        h("tbody", {}, volRecords.map((r) => h("tr", { ...rowAttrs(() => recordDialog(r)), "data-ref": `fin:${r.id}` }, [
          h("td", { class: "nowrap", text: r.kind === "material" ? "원자재 보유" : `완제품 · ${{ in: "입고", checked: "검수완료", packed: "패키징 완료", out: "출고" }[r.stage] || "입고"}` }), h("td", { class: "nowrap", text: r.group }), h("td", { class: "nowrap", text: r.date }), h("td", { text: r.name || "-" }), h("td", { class: "num nowrap", text: fmtN(r.qty) }), h("td", { class: "muted small", text: r.note }), h("td", { class: "nowrap", text: r.author || "-" })
        ])))
      ])) : h("div", { class: "card empty", text: "아직 봉사자가 적은 완제품 기록이 없어요." });
      // 메뉴 공개: 고른 메뉴만 봉사자 화면에 보임 (단계적으로 엶)
      const MENU_LABEL = { home: "대시보드", schedule: "일정", training: "기본 교육", notices: "공지", wbs: "WBS", req: "추가 전달 물량", in: "입고", out: "출고", recovery: "완제품·제품 관리", moves2: "새 입고·출고 화면 (휴대폰용)", steps2: "단계형 메뉴 (부서·팀 봉사자 새 메뉴)" };
      const menuView = volMenuSet ? (() => {
        const boxes = volMenuSet.keys.map((k) => ({ k, el: h("input", { type: "checkbox", checked: volMenuSet.menu.includes(k) }) }));
        const ok = h("button", { class: "btn btn--primary", type: "button", text: "저장", onclick: () => busy(ok, async () => {
          volMenuSet = await act(() => api("/admin/vol-menu", { method: "PUT", body: { menu: boxes.filter((x) => x.el.checked).map((x) => x.k) } }));
          toast("봉사자 메뉴를 저장했어요. 봉사자가 새로고침하면 바뀌어요."); draw();
        }) });
        return h("section", { class: "card stack", style: "padding:16px" }, [
          h("p", { class: "muted small", text: "체크한 메뉴만 봉사자 화면에 보여요. 처음에는 입고·출고 중심(대시보드·공지·입고·출고)으로 열려 있어요. 프로젝트 관리(묵주·손십자가) 요약은 늘 보여요." }),
          h("div", { class: "vol-menu-grid" }, boxes.map((x) => h("label", { class: "check" }, [x.el, h("span", { text: MENU_LABEL[x.k] || x.k })]))),
          h("div", { class: "actions actions--start" }, ok)
        ]);
      })() : loading();
      setMain("volunteers", [
        h("div", { class: "page-head" }, [
          h("h1", { text: "봉사자 관리" }),
          h("span", { class: "actions vol-preview-btns" }, [h("button", { class: "btn btn--ghost btn--sm", type: "button", title: "관리자 계정으로 부서 봉사자 화면(단계형 메뉴)을 미리 봐요", onclick: () => startVolPreview("dept") }, "부서 봉사자 화면 미리보기"), h("button", { class: "btn btn--ghost btn--sm", type: "button", title: "관리자 계정으로 팀 봉사자 화면(단계형 메뉴)을 미리 봐요", onclick: () => startVolPreview("team") }, "팀 봉사자 화면 미리보기")]),
          tab === "inspect" ? h("button", { class: "btn btn--primary page-head__end", type: "button", onclick: () => ins.dialog(null) }, [icon("plus"), "검수 기록"]) : ["stock", "records", "menu", "team", "wbs", "edu", "roster"].includes(tab) ? null : h("button", { class: "btn btn--primary page-head__end", type: "button", onclick: () => (tab === "training" ? trainingDialog() : scheduleDialog()) }, [icon("plus"), tab === "training" ? "교육 등록" : "일정 등록"])
        ]),
        h("div", { class: "filters" }, [seg, h("span", { class: "muted small", text: `봉사자 ${vols.length}명` })]),
        ["wbs", "edu", "roster"].includes(tab) ? extraView : tab === "inspect" ? ins.view() : tab === "team" ? teamAdminView() : tab === "stock" ? stockView : tab === "records" ? recView : tab === "menu" ? menuView : tab === "training" ? trainingView : scheduleView
      ]);
      seg.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "center" }); // 좁은 화면: 고른 탭이 보이게
    };
    // ---- 팀 봉사자(교육·검수): 이슈 처리 · 검수 기준 자료(예전 화면용) · 수도회 연락처 (관리자만)
    function teamAdminView() {
      if (!teamData) return loading();
      const { issues, docs, orgs } = teamData;
      const issueRow = (x) => {
        const st = h("select", { "aria-label": "처리 상태" }, Object.entries(ISSUE_STATUS).map(([k, v]) => h("option", { value: k, text: v })));
        st.value = x.status;
        const reply = h("input", { value: x.reply, maxlength: "1000", placeholder: "봉사자에게 보일 답 (선택)" });
        const save = h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "저장", onclick: async () => { teamData.issues = (await act(() => api(`/team/issues/${x.id}`, { method: "PATCH", body: { status: st.value, reply: reply.value } }), "처리 상태를 저장했어요.")).issues; draw(); } });
        return h("li", { class: "card team-issue", "data-ref": `issue:${x.id}` }, [
          h("div", { class: "team-issue__head" }, [statusTag(ISSUE_STATUS[x.status], `is-${x.status}`), statusTag(ISSUE_KIND[x.kind], x.kind === "thread" ? "is-thread" : ""), h("strong", { text: x.title })]),
          h("div", { class: "muted small", text: [x.org, x.author, x.createdAt?.slice(0, 10)].filter(Boolean).join(" · ") }),
          x.body ? h("p", { class: "vol-pre small", text: x.body }) : null,
          x.photos.length ? h("div", { class: "move-photos" }, x.photos.map((pid) => h("a", { href: "#", onclick: (e) => { e.preventDefault(); teamPhotoCache.get(pid)?.then((u) => { if (u) window.open(u, "_blank", "noopener"); }); } }, teamPhotoImg(pid)))) : null,
          h("div", { class: "filters" }, [st, reply, save])
        ]);
      };
      const docDialog = (d) => {
        const err = errorLine();
        const title = h("input", { value: d?.title || "", maxlength: "120" }), url = h("input", { value: d?.url || "", maxlength: "500", placeholder: "https://… (구글 드라이브 등 공유 링크)" }), note = h("textarea", { rows: "4", maxlength: "2000" }, d?.note || "");
        const ok = h("button", { class: "btn btn--primary", type: "submit", text: d ? "저장" : "올리기" });
        const form = h("form", { class: "stack", novalidate: true }, [field("제목", title), field("링크", url, "파일은 공유 링크로 올려요 (https://)"), field("내용 (선택)", note, "검수 기준표처럼 글로 적어도 돼요"), err,
          h("div", { class: "actions" }, [d ? delBtn(d.title, `/team/docs/${d.id}`) : null, h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), ok])]);
        saveForm(form, ok, err, () => api(d ? `/team/docs/${d.id}` : "/team/docs", { method: d ? "PATCH" : "POST", body: { category: "inspect", title: title.value, url: url.value, note: note.value } }));
        openDialog(d ? "검수 기준 자료 고치기" : "검수 기준 자료 올리기", form, { admin: true });
      };
      const contactRow = (o) => {
        const c = h("input", { value: o.contact, maxlength: "300", placeholder: "담당자 · 전화 · 이메일", "aria-label": `${o.org} 연락처` });
        c.addEventListener("change", async () => { try { const r = await api(`/team/orgs/${o.id}`, { method: "PATCH", body: { contact: c.value } }); Object.assign(o, r.org); toast(`${o.org} 연락처를 저장했어요.`); } catch (ex) { toast(ex.message); c.value = o.contact; } });
        return h("tr", {}, [h("td", { class: "num muted", text: String(o.no) }), h("td", { text: o.org }), h("td", { class: "nowrap", text: o.tableOnly ? "미정" : shortDate(o.date) }), h("td", {}, c)]);
      };
      const open = issues.filter((x) => x.status !== "done");
      return h("div", { class: "stack" }, [
        h("p", { class: "muted small", text: "팀 봉사자(교육·검수) 화면의 이슈를 처리하고, 검수 기준 자료와 수도회 연락처를 관리해요. 팀 봉사자 계정은 멤버 화면에서 권한 '팀 봉사자(교육&검수)'로 발급해요." }),
        h("section", { class: "stack stack--sm" }, [h("h2", { class: "card__title", text: `이슈 (처리 전 ${open.length}건 / 전체 ${issues.length}건)` }), issues.length ? h("ul", { class: "stack stack--sm team-list" }, issues.map(issueRow)) : h("div", { class: "card empty", text: "아직 올라온 이슈가 없어요." })]),
        h("section", { class: "stack stack--sm" }, [
          h("div", { class: "card__head" }, [h("h2", { class: "card__title", text: "검수 기준 자료" }), h("button", { class: "btn btn--primary btn--sm", type: "button", onclick: () => docDialog(null) }, [icon("plus"), "자료 올리기"])]),
          h("p", { class: "muted small", text: "단계형 메뉴를 껐을 때 팀 봉사자의 예전 화면 '제품 검수 › 검수 기준'에만 보여요. 단계형 메뉴에서는 '검수 기준 보기'를 써요." }),
          docs.length ? h("ul", { class: "stack stack--sm team-list" }, docs.map((d) => h("li", { class: "card team-doc stock-row", "data-ref": `docs:${d.id}`, tabindex: "0", onclick: () => docDialog(d) }, [h("strong", { text: d.title }), d.url ? h("span", { class: "muted small", text: d.url }) : null]))) : h("div", { class: "card empty", text: "아직 올린 자료가 없어요." })
        ]),
        h("section", { class: "stack stack--sm" }, [
          h("h2", { class: "card__title", text: "수도회 연락처" }),
          h("p", { class: "muted small", text: "팀 봉사자에게 보이는 연락처예요. 칸을 고치고 벗어나면 저장돼요. 개인정보라 꼭 필요한 것만 적어 주세요." }),
          h("div", { class: "card table-wrap" }, h("table", { class: "table" }, [h("thead", {}, h("tr", {}, ["번호", "수도회", "교육일", "연락처"].map((t) => h("th", { text: t })))), h("tbody", {}, orgs.map(contactRow))]))
        ])
      ]);
    }
    page = { name: "volunteers", reload: async () => {
      const [u, s, t, m, rc, mn] = await Promise.all([api("/admin/users"), api("/admin/vol-schedules"), api("/admin/vol-trainings"), api("/admin/vol-stock-moves"), api("/admin/vol-records"), api("/admin/vol-menu")]);
      vols = u.users.filter((x) => x.role === "volunteer");
      schedules = s.schedules; trainings = t.trainings; stockMoves = m.moves; volRecords = rc.records; volMenuSet = mn;
      if (tab === "inspect") { await ins.load(); openRef(["inspect", "defect"], (id) => ins.data().inspections.find((x) => x.id === id), ins.dialog); }
      if (tab === "wbs") extraView = await adminWbs();
      if (tab === "edu") extraView = await adminRosaryEdu();
      if (tab === "roster") extraView = await adminRoster();
      if (tab === "team") { const [i, d, o] = await Promise.all([api("/team/issues"), api("/team/docs"), api("/team/orgs")]); teamData = { issues: i.issues, docs: d.docs.filter((x) => x.category === "inspect"), orgs: o.orgs }; }
      draw();
    } };
    try { await page.reload(); } catch (e) { if (e.status !== 401) setMain("volunteers", failed(e)); }
  }

  // 휴대폰에서 표를 카드처럼 보일 때 칸 이름을 붙이려고, 표가 그려질 때마다 머리글 글자를 칸(data-label)에 넣어 둠
  function labelTables(root) {
    for (const t of root.querySelectorAll("table.table:not(.stock-table)")) {
      const heads = [...t.querySelectorAll("thead th")].map((th) => th.textContent.replace(/[↕▲▼]/g, "").trim());
      if (!heads.length) continue;
      for (const tr of t.querySelectorAll("tbody tr, tfoot tr")) {
        let col = 0;
        for (const cell of tr.children) {
          if (cell.tagName === "TD" && !cell.hasAttribute("data-label")) cell.setAttribute("data-label", cell.colSpan > 1 ? "" : heads[col] || "");
          col += cell.colSpan || 1;
        }
      }
    }
  }
  let labelQueued = false;
  new MutationObserver(() => { if (labelQueued) return; labelQueued = true; requestAnimationFrame(() => { labelQueued = false; labelTables(document); }); }).observe(document.body, { childList: true, subtree: true });

  /* ---------- 시작 ---------- */
  function render() {
    if (!state.user) return;
    if (state.volPreview === undefined) { try { state.volPreview = sessionStorage.getItem("ps.volPreview") || ""; } catch (e) { state.volPreview = ""; } }
    if (state.volPreview && !isAdmin()) state.volPreview = "";
    volunteerTheme(state.user.role === "volunteer" || !!state.volPreview, state.volPreview ? state.volPreview === "team" : state.user.volKind === "team");
    if (state.user.mustChangePassword) { layout.main = null; return renderForcedPassword(); }
    if (state.user.role === "volunteer" || state.volPreview) { closeDialog(); closePop(); return renderVolunteer(); }
    if (state.opsPerms === undefined) { state.opsPerms = null; quiet(loadOpsPerms()); } // 직원 메뉴 '수도회·물류' 를 보일지
    if (!layout.main || !app.contains(layout.main)) buildLayout();
    closeDialog();
    closePop();
    toggleNav(false);
    const { name, id } = route();
    window.scrollTo(0, 0);
    state.drawVolNav = null;
    seeMenu(name === "alerts" ? "alarm" : name === "volunteers" && ["training", "stock"].includes(id) ? `volunteers/${id}` : name);
    if (name === "alerts") return pageAlerts();
    if (name === "today") return pageToday(id && /^\d{4}-\d{2}-\d{2}$/.test(id) ? id : null);
    if (name === "dashboard") return pageDashboard("mine");
    if (name === "alldash") return go("#/dashboard"); // 전체 대시보드는 메뉴에서 뺌 (예전 주소는 나의 대시보드로)
    if (name === "tasks") return pageTasks();
    if (name === "meetings") return pageMeetings();
    if (name === "memos") return pageMemos();
    if (name === "notices" && id) return pageNotice(Number(id));
    if (name === "notices") return pageNotices();
    if (name === "members") return pageMembers();
    if (name === "volunteers") return pageVolAdmin();
    if (name === "ops") return pageOps();
    if (name === "board") return pageBoard(id);
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
    app.replaceChildren(loading(true));
    const r = await api("/me");
    state.user = r.user; state.team = r.team; state.units = r.units || []; state.tags = r.tags; state.calendars = r.calendars || []; state.rooms = r.rooms || []; state.roomSkip = r.roomSkip || []; state.unreadNotices = r.unreadNotices || 0;
    setCategories(r.categories);
    layout.main = null;
    render();
    quiet(pushBoot());
  }

  /* ---------- 앱 설치(PWA)와 알림(웹 푸시) ---------- */
  const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const isIos = () => !/Android/i.test(navigator.userAgent) && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)); // 아이패드는 맥처럼 보여서 터치로 구분
  const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const isAndroid = () => /Android/i.test(navigator.userAgent);
  const APK_URL = "/download/pschedule.apk";
  const b64uToBytes = (s) => { const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };
  async function swReg() { return "serviceWorker" in navigator ? navigator.serviceWorker.register("/sw.js") : null; }
  async function pushSub() { if (!pushSupported()) return null; const reg = await navigator.serviceWorker.getRegistration(); return reg ? reg.pushManager.getSubscription() : null; }
  async function pushOn() {
    if (!pushSupported()) throw new Error(isIos() && !isStandalone() ? "아이폰·아이패드는 사파리에서 '공유 → 홈 화면에 추가'로 설치한 앱에서 알림을 켤 수 있어요." : "이 브라우저는 알림을 지원하지 않아요.");
    const perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error("알림이 허용되지 않았어요. 브라우저(앱) 설정에서 P-Schedule 알림을 허용해 주세요.");
    const reg = await swReg(); await navigator.serviceWorker.ready;
    const { key } = await api("/push/key");
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(key) });
    await api("/push/subscribe", { method: "POST", body: sub.toJSON() });
    store.set("ps.pushAsked", "1");
    store.set("ps.pushWanted", "1"); // 이 기기에서 알림을 켜 둠 (브라우저가 구독을 끊어도 다시 이어 붙임)
  }
  // 이미 구독한 기기: 권한을 다시 묻지 않고 서버에 지금 계정으로 다시 묶음 (로그아웃 때 서버 쪽만 지워서, 다시 로그인하면 여기서 되살림)
  async function pushRebind(sub) { await api("/push/subscribe", { method: "POST", body: sub.toJSON() }); }
  // quietServerOnly: 로그아웃 때는 서버 구독만 지우고 기기 권한은 그대로
  async function pushOff(quietServerOnly) {
    if (!quietServerOnly) store.remove("ps.pushWanted");
    const sub = await pushSub();
    if (!sub) return;
    await api("/push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } }).catch(() => {});
    if (!quietServerOnly) { await sub.unsubscribe(); store.remove("ps.pushWanted"); }
  }
  // 로그인 때: 서비스 워커 등록, 이미 켠 기기면 지금 계정으로 다시 묶고, 아니면 한 번 권유
  async function pushBoot() {
    await swReg().catch(() => null);
    if (pushSupported() && Notification.permission === "granted") {
      const sub = await pushSub();
      if (sub) return pushRebind(sub);
      if (store.get("ps.pushWanted", "")) return pushOn(); // 켜 뒀는데 브라우저가 구독을 끊음 → 다시 구독
    }
    if (store.get("ps.pushAsked", "") || document.querySelector(".push-ask")) return;
    const canPush = pushSupported() && Notification.permission === "default";
    const iosGuide = isIos() && !isStandalone();
    if (!canPush && !iosGuide) return;
    const close = () => { store.set("ps.pushAsked", "1"); bar.remove(); };
    const bar = h("div", { class: "push-ask", role: "dialog", "aria-label": "알림 받기" }, [
      h("p", { text: iosGuide ? "아이폰·아이패드는 사파리 '공유 → 홈 화면에 추가'로 설치하면 앱처럼 쓰고 알림도 받을 수 있어요." : "알림을 켜면 새 공지·게시판·교육 일정·이슈 답을 바로 받아요." }),
      h("div", { class: "actions" }, [
        canPush ? h("button", { class: "btn btn--primary btn--sm", type: "button", text: "알림 켜기", onclick: async () => { try { await pushOn(); toast("알림을 켰어요."); close(); } catch (e) { toast(e.message); close(); } } }) : null,
        h("button", { class: "btn btn--ghost btn--sm", type: "button", text: canPush ? "나중에" : "알겠어요", onclick: close })
      ])
    ]);
    document.body.append(bar);
  }
  // 계정 메뉴 '알림 · 앱 설치': 이 기기의 알림 상태와 켜기·끄기·시험, 앱 설치 안내
  // 알림 종류별 켜기·끄기: 계정마다 저장 (모든 기기에 같이 적용), 바꾸면 바로 저장
  const PUSH_KIND_LABEL = {
    notice: ["새 공지", "볼 수 있는 공지가 올라오면"],
    board: ["게시판 새 글", "게시판에 새 글이 올라오면"],
    comment: ["내 글 댓글", "내가 쓴 게시판 글에 댓글이 달리면"],
    edu: ["교육 일정", "팀 봉사자 교육이 새로 잡히거나 날짜가 바뀌면"],
    need: ["봉사자 필요 인원", "리더가 날짜별 필요 인원을 정하면"],
    issue_new: ["새 이슈", "팀 봉사자가 이슈를 올리면"],
    issue_reply: ["이슈 처리·답", "내가 올린 이슈의 상태나 답이 바뀌면"],
    followup: ["연락 후속 조치", "내가 적은 후속 조치의 기한이 되면"]
  };
  const pushKindLabel = (k) => PUSH_KIND_LABEL[k] || ["기타 알림", ""]; // 화면이 모르는 종류가 와도 창이 비지 않게
  function pushPrefsBox(p) {
    const box = h("section", { class: "stack stack--sm push-prefs" });
    const draw = () => {
      const save = async (off) => { const r = await act(() => api("/push/prefs", { method: "PUT", body: { off } })); p.off = r.off; draw(); };
      const allOn = p.kinds.every((k) => !p.off.includes(k)), allOff = p.kinds.every((k) => p.off.includes(k));
      fill(box,
        h("div", { class: "push-prefs__head" }, [
          h("h3", { class: "team-sec", text: "받을 알림" }),
          h("div", { class: "actions" }, [
            h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "전체 켜기", disabled: allOn, onclick: () => save(p.off.filter((k) => !p.kinds.includes(k))) }),
            h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "전체 끄기", disabled: allOff, onclick: () => save([...new Set([...p.off, ...p.kinds])]) })
          ])
        ]),
        h("ul", { class: "push-prefs__list" }, p.kinds.map((k) => {
          const on = !p.off.includes(k);
          const c = h("input", { type: "checkbox", checked: on, "aria-describedby": `pp-${k}` });
          c.addEventListener("change", () => save(c.checked ? p.off.filter((x) => x !== k) : [...p.off, k]));
          return h("li", {}, h("label", { class: "push-prefs__item" }, [c, h("span", {}, [h("strong", { text: pushKindLabel(k)[0] }), h("small", { class: "muted", id: `pp-${k}`, text: pushKindLabel(k)[1] })])]));
        })),
        h("p", { class: "muted small", text: "이 계정으로 알림을 켠 모든 기기에 똑같이 적용돼요." })
      );
    };
    draw();
    return box;
  }
  async function appDialog() {
    const box = h("div", { class: "stack" });
    const draw = async () => {
      let sub = await pushSub().catch(() => null);
      // 켜 둔 기기인데 브라우저가 구독을 끊었으면(권한은 그대로) 알아서 다시 켬 → '알림 켜기'를 또 누르지 않아도 됨
      if (!sub && pushSupported() && Notification.permission === "granted" && store.get("ps.pushWanted", "")) sub = await pushOn().then(pushSub, () => null);
      // 기기에는 구독이 있는데 서버에 없을 수 있어(로그아웃 등) 열 때마다 다시 묶음. 실패하면 꺼진 것으로 보여 줌
      if (sub && !(await pushRebind(sub).then(() => true, () => false))) sub = null;
      const prefs = await api("/push/prefs").catch(() => null);
      const perm = "Notification" in window ? Notification.permission : "unsupported";
      const state1 = !pushSupported() ? (isIos() && !isStandalone() ? "아이폰·아이패드는 홈 화면에 추가한 앱에서만 알림을 켤 수 있어요." : "이 브라우저는 알림을 지원하지 않아요.")
        : perm === "denied" ? "이 기기에서 알림이 막혀 있어요. 브라우저(앱) 설정 → 사이트 설정 → 알림에서 P-Schedule을 허용해 주세요."
          : sub ? "이 기기에서 알림을 받고 있어요." : "이 기기에서는 알림이 꺼져 있어요.";
      fill(box,
        h("section", { class: "stack stack--sm" }, [
          h("h3", { class: "team-sec", text: "알림" }),
          h("p", { class: "small", text: state1 }),
          h("p", { class: "muted small", text: "새 공지, 게시판 새 글·내 글 댓글, 팀 봉사자 교육 일정·필요 인원, 이슈 처리·답, 연락 후속 조치가 오면 알려 줘요. 기기마다 따로 켜요." }),
          h("div", { class: "actions actions--start" }, [
            pushSupported() && perm !== "denied" && !sub ? h("button", { class: "btn btn--primary btn--sm", type: "button", text: "알림 켜기", onclick: async () => { try { await pushOn(); toast("알림을 켰어요."); } catch (e) { toast(e.message); } draw(); } }) : null,
            sub ? h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "시험 알림 보내기", onclick: () => act(() => api("/push/test", { method: "POST" }), "시험 알림을 보냈어요. 잠시 뒤 알림이 와요.") }) : null,
            sub ? h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "알림 끄기", onclick: async () => { await pushOff(); toast("이 기기 알림을 껐어요."); draw(); } }) : null
          ])
        ]),
        prefs ? pushPrefsBox(prefs) : null,
        h("section", { class: "stack stack--sm" }, [
          h("h3", { class: "team-sec", text: "앱으로 쓰기" }),
          h("p", { class: "small", text: isStandalone() ? "지금 앱으로 쓰고 있어요." : "휴대폰·패드에 설치하면 주소창 없이 앱처럼 써요. 사이트가 바뀌면 앱도 바로 바뀌어요." }),
          h("ul", { class: "app-guide" }, [
            h("li", {}, [h("strong", { text: "안드로이드: " }), h("a", { class: "link-btn", href: APK_URL, download: "pschedule.apk", text: "앱(APK) 내려받기" }), " → 내려받은 파일을 열어 설치 (처음이면 '출처를 알 수 없는 앱' 설치를 한 번 허용해요). 크롬 메뉴의 '앱 설치'로도 돼요."]),
            h("li", {}, [h("strong", { text: "아이폰·아이패드: " }), "사파리에서 이 사이트를 열고 '공유 → 홈 화면에 추가'. 설치한 앱에서 알림을 켤 수 있어요."]),
            h("li", {}, [h("strong", { text: "PC: " }), "크롬·엣지 주소창 오른쪽의 설치 버튼"])
          ])
        ]));
    };
    openDialog("휴대폰 알림 · 앱 설치", box);
    await draw();
  }

  (async function start() {
    if (!state.token) return renderLogin();
    try { await boot(); } catch (e) { if (e.status !== 401) renderLogin(e.message); }
  })();
})();
