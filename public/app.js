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
    month: null,      // 대시보드에서 보고 있는 달의 1일 (Date)
    view: store.get("ps.view", "month"),
    search: "",
    show: JSON.parse(store.get("ps.show", "null") || "null") || { meeting: true, event: true, task: true },
    peek: null,       // 측면 패널 { type: 'event' | 'task' | 'day', id }
    navOpen: false
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

  /* ---------- 대화 상자 ---------- */
  function openDialog(title, body, opts) {
    dialogTitle.textContent = title;
    dialogBody.replaceChildren(body);
    dialog.classList.toggle("dialog--wide", !!(opts && opts.wide));
    if (!dialog.open) dialog.showModal();
    const first = dialogBody.querySelector("[autofocus]");
    if (first) first.focus();
  }
  function closeDialog() { if (dialog.open) dialog.close(); }
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
    document.body.append(el);
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
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && openPop) { e.stopPropagation(); closePop(); } }, true);

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

  // 사람 고르기: multi 면 여러 명, 아니면 한 명 (빼기 포함)
  function personPicker(anchor, selected, multi, onChange) {
    const sel = new Set(selected || []);
    const list = h("div", { class: "pop__list" });
    function draw() {
      const items = state.team.map((u) => h("button", { type: "button", class: "pop__item" + (sel.has(u.id) ? " is-on" : ""), onclick: () => {
        if (multi) { sel.has(u.id) ? sel.delete(u.id) : sel.add(u.id); onChange([...sel]); draw(); }
        else { closePop(); onChange(sel.has(u.id) ? null : u.id); }
      } }, [h("span", { class: "pop__check", html: sel.has(u.id) ? ICON.check : "" }), avatar(u.id, "sm"), h("span", { class: "pop__name" }, [u.name, u.title ? h("small", { text: u.title }) : null])]));
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
    const rel = relDay(t.dueDate);
    return h("span", { class: "due" + (late ? " due--late" : t.dueDate === td ? " due--today" : ""), text: late ? `${shortDate(t.dueDate)} 지남` : rel || shortDate(t.dueDate) });
  }

  async function patchTask(t, body) {
    const r = await act(() => api(`/tasks/${t.id}`, { method: "PATCH", body }));
    refresh();
    return r.task;
  }

  /* ---------- 로그인 ---------- */
  function renderLogin(message) {
    document.title = TITLE;
    const err = errorLine();
    const login = h("input", { name: "login", autocomplete: "username", autocapitalize: "none", spellcheck: "false", required: true, autofocus: true });
    const pw = h("input", { name: "password", type: "password", autocomplete: "current-password", required: true });
    const submit = h("button", { class: "btn btn--primary btn--block", type: "submit", text: "로그인" });
    const form = h("form", { class: "auth__card stack", novalidate: true }, [
      h("div", { class: "brand brand--lg" }, [h("img", { src: "favicon.svg", alt: "" }), h("span", { text: TITLE })]),
      h("p", { class: "muted", text: "회의, 할 일, 메모를 한 화면에서." }),
      field("아이디", login), field("비밀번호", pw), err, submit,
      h("p", { class: "auth__foot", text: "계정이 없거나 비밀번호를 잊었다면 관리자에게 문의해 주세요." })
    ]);
    if (message) showError(err, message);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!login.value.trim() || !pw.value) return showError(err, "아이디와 비밀번호를 적어 주세요.");
      busy(submit, async () => {
        try {
          const r = await api("/login", { method: "POST", body: { login: login.value, password: pw.value } });
          state.token = r.token;
          store.set("ps.token", r.token);
          await boot();
        } catch (ex) { showError(err, ex.message); pw.select(); }
      });
    });
    app.replaceChildren(h("main", { class: "auth" }, form));
    login.focus();
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

  function buildLayout() {
    layout.main = h("main", { class: "main", id: "main" });
    layout.peek = h("aside", { class: "peek", "aria-label": "상세 패널", hidden: true });
    layout.nav = h("nav", { class: "side__nav", "aria-label": "메뉴" });
    layout.mini = h("div", { class: "mini" });
    layout.tags = h("div", { class: "side__tags" });
    layout.cals = h("div", { class: "side__cals" });
    const account = h("button", { class: "side__account", type: "button" }, [avatar(state.user.id), h("span", { class: "side__who" }, [h("strong", { text: state.user.name }), h("small", { text: state.user.role === "admin" ? "관리자" : state.user.title || "멤버" })])]);
    account.addEventListener("click", () => popover(account, h("div", { class: "pop__list" }, [
      h("button", { type: "button", class: "pop__item", onclick: () => { closePop(); openDialog("비밀번호 변경", passwordForm(closeDialog)); } }, "비밀번호 변경"),
      h("button", { type: "button", class: "pop__item", onclick: () => { closePop(); logout(); } }, "로그아웃")
    ])));
    layout.side = h("aside", { class: "side" }, [
      h("div", { class: "side__top" }, [
        h("a", { class: "brand", href: "#/today" }, [h("img", { src: "favicon.svg", alt: "" }), h("span", { text: TITLE })]),
        h("button", { class: "icon-btn side__close", type: "button", "aria-label": "메뉴 닫기", html: ICON.close, onclick: () => toggleNav(false) })
      ]),
      h("button", { class: "btn btn--dark btn--block", type: "button", onclick: () => quickAdd() }, [icon("plus"), "일정 / 할 일 추가"]),
      layout.nav,
      h("div", { class: "side__section" }, [h("div", { class: "side__label", text: "내 캘린더" }), layout.cals]),
      layout.mini,
      h("div", { class: "side__section" }, [
        h("div", { class: "side__label" }, ["자주 쓰는 태그", h("button", { class: "icon-btn icon-btn--xs", type: "button", "aria-label": "태그 관리", title: "태그 관리", html: ICON.plus, onclick: () => manageTags() })]),
        layout.tags
      ]),
      account
    ]);
    layout.topbar = h("header", { class: "mobilebar" }, [
      h("button", { class: "icon-btn", type: "button", "aria-label": "메뉴", html: ICON.menu, onclick: () => toggleNav(true) }),
      h("a", { class: "brand", href: "#/today" }, [h("img", { src: "favicon.svg", alt: "" }), h("span", { text: TITLE })]),
      h("button", { class: "icon-btn", type: "button", "aria-label": "추가", html: ICON.plus, onclick: () => quickAdd() })
    ]);
    layout.scrim = h("div", { class: "scrim", onclick: () => toggleNav(false) });
    app.replaceChildren(h("div", { class: "shell" }, [layout.side, layout.scrim, h("div", { class: "content" }, [layout.topbar, layout.main]), layout.peek]));
    drawCalsNav();
    drawTagsNav();
  }
  function toggleNav(open) {
    state.navOpen = open;
    app.querySelector(".shell").classList.toggle("nav-open", open);
  }

  function drawNav(active) {
    const items = [
      { id: "today", label: "오늘", icon: "home" },
      { id: "dashboard", label: "대시보드", icon: "grid" },
      { id: "tasks", label: "할 일", icon: "check" },
      { id: "meetings", label: "회의", icon: "people" },
      { id: "memos", label: "메모", icon: "note" },
      { id: "notices", label: "공지", icon: "bell" },
      state.user.role === "admin" ? { id: "members", label: "멤버", icon: "user" } : null
    ].filter(Boolean);
    layout.nav.replaceChildren(...items.map((it) => h("a", {
      class: "side__link" + (it.id === active ? " is-active" : ""), href: "#/" + it.id, "aria-current": it.id === active ? "page" : null,
      onclick: () => toggleNav(false)
    }, [icon(it.icon), h("span", { text: it.label })])));
  }
  function drawCalsNav() {
    layout.cals.replaceChildren(...Object.entries(KIND).map(([k, v]) => {
      const c = h("input", { type: "checkbox", checked: state.show[k] });
      c.addEventListener("change", () => {
        state.show[k] = c.checked;
        store.set("ps.show", JSON.stringify(state.show));
        if (page && (page.name === "dashboard" || page.name === "today")) page.reload();
      });
      return h("label", { class: `side__cal c${v.color}` }, [c, h("span", { text: v.label })]);
    }));
  }
  function drawTagsNav() {
    if (!layout.tags) return;
    layout.tags.replaceChildren(...(state.tags.length ? state.tags.map((t) => h("a", { class: "side__tag", href: `#/tasks`, onclick: () => { taskFilter.tag = t.id; } }, tagChip(t.id))) : [h("p", { class: "muted small", text: "태그가 없어요." })]),
      h("button", { class: "side__tagmanage", type: "button", onclick: () => manageTags() }, [icon("gear"), "태그 관리"]));
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
    fill(layout.main, content);
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
      content = p.type === "event" ? await eventPeek(p.id) : p.type === "task" ? await taskPeek(p.id) : await dayPeek(p.id);
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
    const head = [h("div", { class: "peek__kind" }, [kindDot(e.kind), h("span", { text: KIND[e.kind].label }), isMeeting ? h("span", { class: `status status--${st}`, text: MEETING_STATE[st] }) : null]), title];
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
      h("li", { class: "facts__tags" }, [icon("tag"), h("div", { class: "chips" }, [...tagChips(e.tagIds), h("button", { class: "chip-add", type: "button", text: e.tagIds.length ? "편집" : "태그 추가", onclick: (ev) => tagPicker(ev.currentTarget, e.tagIds, (ids) => { e.tagIds = ids; quiet(patch({ tagIds: ids })); redrawChips(ev.target.closest(".chips"), ids); }) })])])
    ]);
    function redrawChips(box, ids) {
      const btn = box.querySelector(".chip-add");
      box.replaceChildren(...tagChips(ids), btn);
      btn.textContent = ids.length ? "편집" : "태그 추가";
    }

    const attendees = isMeeting ? section("people", ["참석자 ", h("span", { class: "muted", text: String(e.attendeeIds.length) })],
      h("button", { class: "link-btn", type: "button", text: "편집", onclick: (ev) => personPicker(ev.currentTarget, e.attendeeIds, true, (ids) => { e.attendeeIds = ids; drawAtt(); quiet(patch({ attendeeIds: ids })); }) }),
      h("div", { class: "attendees" })) : null;
    function drawAtt() {
      const box = attendees.querySelector(".attendees");
      box.replaceChildren(...(e.attendeeIds.length ? e.attendeeIds.map((uid) => {
        const u = member(uid);
        return h("div", { class: "attendee" }, [avatar(uid), h("span", { text: u ? u.name : "?" }), u && u.title ? h("small", { text: u.title }) : null]);
      }) : [h("p", { class: "muted small", text: "참석자를 추가해 주세요." })]));
    }
    if (attendees) drawAtt();

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
      important.length ? h("div", { class: "keybox" }, [h("div", { class: "keybox__head" }, [icon("star"), "중요 메모"]), h("ul", {}, important.map((m) => h("li", { text: m.body })))]) : null,
      attendees,
      section("doc", isMeeting ? "회의 개요" : "설명", null, inlineText(e.description, { multiline: true, rows: 2, placeholder: isMeeting ? "어떤 회의인지 적어 주세요" : "설명 추가", label: "개요", max: 3000, onSave: (v) => patch({ description: v }) })),
      isMeeting ? section("list", "회의 안건", null, h("div", {}, [agendaList, adder("안건 추가 후 Enter", async (v) => { agenda.push(v); drawAgenda(); await patch({ agenda }); })])) : null,
      section("todo", ["준비사항 ", h("span", { class: "muted", text: `${before.filter((t) => t.status === "done").length}/${before.length}` })], null,
        h("div", {}, [taskRows(before, { compact: true }), adder("준비할 일 추가 후 Enter", (v) => act(() => api("/tasks", { method: "POST", body: { title: v, meetingId: e.id, phase: "before", dueDate: e.startDate } })).then(() => refresh()))])),
      section("check", ["회의 후 할 일 ", h("span", { class: "muted", text: String(after.length) })], null,
        h("div", {}, [taskRows(after, { compact: true, assignee: true }), adder("후속 할 일 추가 후 Enter", (v) => act(() => api("/tasks", { method: "POST", body: { title: v, meetingId: e.id, phase: "after" } })).then(() => refresh()))])),
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
        await act(() => api("/memos", { method: "POST", body: { ...base, body: input.value, important: imp.checked } }));
        input.value = ""; imp.checked = false;
        refresh();
      });
    });
    return form;
  }
  function memoToTask(m) {
    const err = errorLine();
    const title = h("input", { value: m.body.split("\n")[0].slice(0, 80), maxlength: "80", autofocus: true });
    const due = h("input", { type: "date" });
    let assignee = state.user.id;
    const who = h("button", { class: "select-btn", type: "button" });
    const drawWho = () => who.replaceChildren(assignee ? personLine(assignee) : h("span", { class: "muted", text: "담당자 없음" }));
    drawWho();
    who.addEventListener("click", () => personPicker(who, assignee ? [assignee] : [], false, (uid) => { assignee = uid; drawWho(); }));
    const ok = h("button", { class: "btn btn--primary", type: "submit", text: "할 일 만들기" });
    const form = h("form", { class: "stack", novalidate: true }, [
      m.meetingId ? h("p", { class: "notice-box" }, ["'", h("strong", { text: m.meetingTitle }), "' 회의의 후속 할 일로 연결돼요."]) : null,
      field("할 일", title), h("div", { class: "row2" }, [field("담당자", who), field("마감일", due)]), err,
      h("div", { class: "actions" }, [h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), ok])
    ]);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      busy(ok, async () => {
        try {
          await api(`/memos/${m.id}/task`, { method: "POST", body: { title: title.value, dueDate: due.value || null, assigneeId: assignee } });
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
      h("dt", {}, "마감일"), h("dd", {}, due),
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
    const cards = ev.events.map((e) => {
      const d = byId.get(e.id);
      const imp = d ? d.memos.filter((m) => m.important).slice(0, 3) : [];
      const open = d ? d.tasks.filter((t) => t.status !== "done") : [];
      return h("li", {}, h("button", { class: "daycard", type: "button", onclick: () => openPeek("event", e.id) }, [
        h("div", { class: "daycard__top" }, [kindDot(e.kind), h("span", { class: "daycard__time", text: timeRange(e) }), h("strong", { text: e.title })]),
        d && d.event.agenda.length ? h("ol", { class: "daycard__agenda" }, [...d.event.agenda.slice(0, 3).map((a) => h("li", { text: a })), d.event.agenda.length > 3 ? h("li", { class: "muted", text: `외 ${d.event.agenda.length - 3}개` }) : null]) : null,
        imp.length ? h("ul", { class: "daycard__imp" }, imp.map((m) => h("li", {}, [icon("star"), h("span", { text: m.body })]))) : null,
        open.length ? h("div", { class: "daycard__tasks" }, [icon("check"), `남은 할 일 ${open.length}개`]) : null
      ]));
    });
    return peekFrame([h("div", { class: "peek__kind" }, [icon("cal"), h("span", { text: relDay(day) || "선택한 날" })]), h("h2", { class: "peek__h", text: dateLabel(day) })], [
      section("people", ["일정 ", h("span", { class: "muted", text: String(ev.events.length) })], h("button", { class: "link-btn", type: "button", text: "추가", onclick: () => editEvent(null, { date: day }) }),
        ev.events.length ? h("ul", { class: "daycards" }, cards) : h("p", { class: "muted small", text: "일정이 없어요." })),
      section("check", ["할 일 ", h("span", { class: "muted", text: String(tk.tasks.length) })], null,
        h("div", {}, [taskRows(tk.tasks, { compact: true }), adder("할 일 추가 후 Enter", (v) => act(() => api("/tasks", { method: "POST", body: { title: v, dueDate: day, assigneeId: state.user.id } })).then(() => refresh()))])),
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
    const v = e || { kind: opts.kind || "meeting", title: "", startDate: opts.date || today(), endDate: opts.date || today(), startTime: opts.time || "", endTime: "", location: "", description: "", tagIds: [], attendeeIds: [state.user.id] };
    let kind = v.kind;
    const err = errorLine();
    const title = h("input", { value: v.title, maxlength: "80", required: true, autofocus: true, placeholder: kind === "meeting" ? "예: 식수 실무회의" : "예: 현장 방문" });
    const startDate = h("input", { type: "date", value: v.startDate, required: true });
    const endDate = h("input", { type: "date", value: v.endDate, required: true });
    const allDay = h("input", { type: "checkbox", checked: isNew ? kind !== "meeting" && !opts.time : !v.startTime });
    const startTime = h("input", { type: "time", value: v.startTime || "10:00", step: "300" });
    const endTime = h("input", { type: "time", value: v.endTime || (v.startTime ? "" : "11:00"), step: "300" });
    const loc = h("input", { value: v.location, maxlength: "80", placeholder: "선택" });
    let tagIds = v.tagIds.slice(), attendeeIds = v.attendeeIds.slice();
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
          location: loc.value, tagIds, attendeeIds: kind === "meeting" ? attendeeIds : []
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
    const due = h("input", { type: "date", value: v.dueDate || "" });
    let assignee = state.user.id, tagIds = [];
    const who = h("button", { class: "select-btn", type: "button" });
    const drawWho = () => who.replaceChildren(assignee ? personLine(assignee) : h("span", { class: "muted", text: "담당자 없음" }));
    who.addEventListener("click", () => personPicker(who, assignee ? [assignee] : [], false, (uid) => { assignee = uid; drawWho(); }));
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
      h("div", { class: "row2" }, [field("담당자", who), field("마감일", due)]),
      field("태그", tagsBtn),
      h("div", { class: "row2" }, [field("관련 회의", meeting), phaseField]),
      err,
      h("div", { class: "actions" }, [h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), submit])
    ]);
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      busy(submit, async () => {
        try {
          const r = await api("/tasks", { method: "POST", body: { title: title.value, dueDate: due.value || null, assigneeId: assignee, tagIds, meetingId: meeting.value ? Number(meeting.value) : null, phase: phase.value } });
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
    const save = h("button", { class: "btn btn--primary", type: "submit", text: "저장하기" });
    const form = h("form", { class: "quickmemo" }, [
      input,
      h("div", { class: "quickmemo__bar" }, [meeting, h("label", { class: "check small" }, [imp, h("span", { text: "중요" })]), save])
    ]);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) form.requestSubmit(); });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!input.value.trim()) return input.focus();
      busy(save, async () => {
        await act(() => api("/memos", { method: "POST", body: { body: input.value, date: day, meetingId: meeting.value ? Number(meeting.value) : null, important: imp.checked } }), "메모를 저장했어요.");
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
      const events = ev.events.filter((e) => state.show[e.kind]);
      drawTimeline(events);
      drawTasks(tk.tasks);
      memoList.replaceChildren(memoRows(mm.memos, { empty: "이 날 남긴 메모가 없어요." }));
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
          class: `tl__ev c${KIND[e.kind].color}` + (height < 46 ? " is-short" : ""), type: "button", "data-peek": `event:${e.id}`,
          style: `top:${top}px;height:${height}px;left:calc(56px + (100% - 60px) * ${it.lane / it.lanes});width:calc((100% - 60px) / ${it.lanes} - 4px)`,
          onclick: () => openPeek("event", e.id)
        }, [
          h("div", { class: "tl__evtop" }, [h("strong", { text: e.title }), h("span", { class: "tl__tags" }, tagChips(e.tagIds))]),
          h("div", { class: "tl__meta" }, [
            h("span", { text: timeRange(e) }),
            e.location ? h("span", {}, [icon("place"), e.location]) : null,
            e.kind === "meeting" && e.attendeeIds.length ? h("span", {}, [icon("people"), `${e.attendeeIds.length}명`]) : null,
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
        allDay.length ? h("div", { class: "tl-allday" }, [h("span", { class: "tl-allday__label", text: "종일" }), ...allDay.map((e) => h("button", { class: `chip c${KIND[e.kind].color}`, type: "button", "data-peek": `event:${e.id}`, onclick: () => openPeek("event", e.id) }, h("span", { text: e.title })))]) : null,
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
        adder("할 일 추가 후 Enter", (v) => act(() => api("/tasks", { method: "POST", body: { title: v, dueDate: day, assigneeId: state.user.id } })).then(() => load())),
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
  async function pageDashboard() {
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
    setMain("dashboard", [calCard, listCard]);

    const setMonth = (d) => { state.month = d; store.set("ps.month", ymd(d).slice(0, 7)); quiet(load()); };
    const matches = (x) => !state.search || x.title.toLowerCase().includes(state.search.toLowerCase());

    async function load() {
      const { start, end } = monthRange(state.month);
      const [ev, tk] = await Promise.all([api(`/events?from=${ymd(start)}&to=${ymd(end)}`), api(`/tasks?from=${ymd(start)}&to=${ymd(end)}`)]);
      data = { events: ev.events, tasks: tk.tasks };
      draw();
    }

    function toolbar() {
      const title = `${state.month.getFullYear()}년 ${state.month.getMonth() + 1}월`;
      document.title = `${title} · ${TITLE}`;
      const search = h("label", { class: "search" }, [icon("search"), h("input", { type: "search", value: state.search, placeholder: "일정, 회의, 할 일 검색", "aria-label": "검색", oninput: (e) => { state.search = e.target.value; drawBody(); } })]);
      const views = h("div", { class: "seg seg--sm" }, [["month", "월"], ["list", "목록"]].map(([k, label]) => h("button", { type: "button", "aria-selected": String(state.view === k), text: label, onclick: () => { state.view = k; store.set("ps.view", k); draw(); } }))
        .concat(h("a", { href: "#/today", class: "seg__link", text: "일" })));
      return h("div", { class: "cal-head" }, [
        h("div", { class: "cal-nav" }, [
          h("button", { class: "icon-btn", type: "button", "aria-label": "이전 달", html: ICON.left, onclick: () => setMonth(new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1)) }),
          h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "오늘", onclick: () => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1)) }),
          h("button", { class: "icon-btn", type: "button", "aria-label": "다음 달", html: ICON.right, onclick: () => setMonth(new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1)) })
        ]),
        h("h1", { class: "cal-title", text: title }),
        h("div", { class: "cal-tools" }, [views, search])
      ]);
    }

    let bodyBox;
    function draw() {
      bodyBox = h("div", { class: "cal-body" });
      calCard.replaceChildren(toolbar(), bodyBox);
      drawBody();
    }
    function drawBody() {
      bodyBox.replaceChildren(state.view === "list" ? monthList() : monthGrid());
      drawMeetingList();
      markPeeked();
    }

    function itemsOn(day) {
      const ev = data.events.filter((e) => state.show[e.kind] && e.startDate <= day && e.endDate >= day && matches(e));
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
          ...ev.map((e) => h("button", { class: `chip c${KIND[e.kind].color}` + (e.startDate !== e.endDate ? " chip--span" : ""), type: "button", "data-peek": `event:${e.id}`, title: `${e.title} · ${whenLabel(e)}`, onclick: (x) => { x.stopPropagation(); openPeek("event", e.id); } },
            [h("i", { class: "chip__dot" }), h("span", { text: (e.startTime && e.startDate === day ? e.startTime + " " : "") + e.title })])),
          ...tk.map((x) => h("button", { class: `chip chip--task c${KIND.task.color}` + (x.status === "done" ? " is-done" : ""), type: "button", "data-peek": `task:${x.id}`, title: `할 일 · ${x.title}`, onclick: (y) => { y.stopPropagation(); openPeek("task", x.id); } },
            [h("i", { class: "chip__box" }), h("span", { text: x.title })]))
        ];
        const cell = h("div", {
          class: "cal-day" + (d.getMonth() !== m ? " is-out" : "") + (day === t ? " is-today" : "") + (d.getDay() === 0 ? " is-sun" : d.getDay() === 6 ? " is-sat" : ""),
          role: "gridcell", tabindex: "0", "data-peek": `day:${day}`, "aria-label": `${dateLabel(day)}${n ? `, ${n}개` : ""}`
        }, [
          h("span", { class: "cal-num", text: d.getDate() }),
          h("div", { class: "cal-chips" }, [...chips.slice(0, MAX_CHIPS), chips.length > MAX_CHIPS ? h("span", { class: "cal-more", text: `+${chips.length - MAX_CHIPS}개 더보기` }) : null]),
          h("div", { class: "cal-dots", "aria-hidden": "true" }, [...ev.slice(0, 3).map((e) => h("i", { class: `c${KIND[e.kind].color}` })), ...tk.slice(0, 2).map(() => h("i", { class: `c${KIND.task.color}` }))])
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
        h("div", { class: "tabs-line", role: "tablist" }, [["all", "전체"], ["mine", "내 회의"], ["joined", "참석 회의"]].map(([k, label]) => h("button", { type: "button", role: "tab", "aria-selected": String(k === listTab), onclick: () => { listTab = k; store.set("ps.listTab", k); drawMeetingList(); markPeeked(); } }, [label, h("span", { class: "count", text: String(sets[k].length) })]))),
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

    page = { name: "dashboard", reload: load };
    draw();
    try { await load(); } catch (e) { if (e.status !== 401) bodyBox.replaceChildren(failed(e)); }
  }

  function meetingRow(e, hideDate) {
    const st = e.kind === "meeting" ? meetingState(e) : null;
    return h("li", {}, h("button", { class: "mrow", type: "button", "data-peek": `event:${e.id}`, onclick: () => openPeek("event", e.id) }, [
      h("span", { class: "mrow__time" }, [hideDate ? null : h("small", { text: relDay(e.startDate) || shortDate(e.startDate) }), timeRange(e)]),
      kindDot(e.kind),
      h("span", { class: "mrow__title" }, [h("strong", { text: e.title }), ...tagChips(e.tagIds).slice(0, 2),
        e.openTasks ? h("span", { class: "mini-badge" }, [icon("check"), `할 일 ${e.openTasks}`]) : null,
        e.importantMemos ? h("span", { class: "mini-badge mini-badge--star" }, [icon("star"), String(e.importantMemos)]) : null]),
      h("span", { class: "mrow__people" }, [h("span", { class: "avatars" }, (e.attendeeIds.length ? e.attendeeIds : e.createdBy ? [e.createdBy] : []).slice(0, 3).map((id) => avatar(id, "sm"))), e.attendeeIds.length > 3 ? h("small", { text: `+${e.attendeeIds.length - 3}` }) : null]),
      st ? h("span", { class: `status status--${st}`, text: MEETING_STATE[st] }) : h("span")
    ]));
  }

  /* ---------- 할 일 목록 ---------- */
  const taskFilter = { status: store.get("ps.taskStatus", "open"), who: store.get("ps.taskWho", "all"), tag: null, q: "" };
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
      filters.replaceChildren(seg("status", [["open", "미완료"], ["done", "완료"], ["all", "전체"]], "ps.taskStatus"), seg("who", [["all", "모두"], ["me", "내 담당"]], "ps.taskWho"), tagSel, search);
    }
    function drawList() {
      const f = taskFilter;
      const list = all.filter((t) => (f.status === "all" || (f.status === "done" ? t.status === "done" : t.status !== "done"))
        && (f.who === "all" || t.assigneeId === state.user.id) && (!f.tag || t.tagIds.includes(f.tag)) && (!f.q || t.title.includes(f.q)));
      const t = today(), tm = shiftYmd(t, 1), week = shiftYmd(t, 7);
      const groups = f.status === "done" ? [["완료", list]] : [
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
    async function load() { all = (await api("/tasks")).tasks; drawList(); }
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
    setMain("meetings", [h("div", { class: "page-head" }, [h("h1", { text: "회의" }), h("button", { class: "btn btn--primary", type: "button", onclick: () => editEvent(null, { kind: "meeting" }) }, [icon("plus"), "회의 추가"])]), h("div", { class: "filters" }, search), box]);
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
      all = (await api(`/events?from=${shiftYmd(t, -180)}&to=${shiftYmd(t, 180)}`)).events;
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
      for (const m of r.memos) { if (!days.has(m.date)) days.set(m.date, []); days.get(m.date).push(m); }
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
      setMain("notices", h("div", { class: "narrow stack" }, [
        h("div", { class: "page-head" }, [h("h1", { text: "공지" }), isAdmin ? h("button", { class: "btn btn--primary", type: "button", onclick: () => editNotice(null) }, [icon("plus"), "공지 쓰기"]) : null]),
        r.notices.length ? h("ul", { class: "notice-list" }, r.notices.map((n) => h("li", {}, h("a", { class: "card notice-item" + (n.pinned ? " is-pinned" : ""), href: `#/notices/${n.id}` }, [
          h("div", { class: "notice-item__title" }, [n.pinned ? icon("pin", "pin") : null, h("strong", { text: n.title })]),
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
    openDialog(isNew ? "공지 쓰기" : "공지 수정", form, { wide: true });
  }

  /* ---------- 멤버 관리 (관리자) ---------- */
  async function pageMembers() {
    if (state.user.role !== "admin") return go("#/today");
    document.title = `멤버 · ${TITLE}`;
    drawMini(null);
    setMain("members", loading());
    async function load() {
      const r = await api("/admin/users");
      const rows = r.users.map((u) => h("tr", {}, [
        h("td", {}, h("span", { class: "person" }, [avatar(u.id, "sm"), h("strong", { text: u.name }), u.me ? h("span", { class: "badge", text: "나" }) : null])),
        h("td", { class: "muted", text: u.title || "—" }),
        h("td", { class: "mono", text: u.login }),
        h("td", {}, h("span", { class: "badge" + (u.role === "admin" ? " badge--accent" : ""), text: u.role === "admin" ? "관리자" : "멤버" })),
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
      ]));
      setMain("members", h("div", { class: "stack" }, [
        h("div", { class: "page-head" }, [h("h1", {}, ["멤버 ", h("span", { class: "muted", text: String(r.users.length) })]), h("button", { class: "btn btn--primary", type: "button", onclick: addMember }, [icon("plus"), "계정 발급"])]),
        h("div", { class: "card table-wrap" }, h("table", { class: "table" }, [
          h("thead", {}, h("tr", {}, ["이름", "직책", "아이디", "권한", "비밀번호", "최근 로그인", ""].map((t) => h("th", { text: t })))),
          h("tbody", {}, rows)
        ]))
      ]));
    }
    page = { name: "members", reload: load };
    try { await load(); } catch (e) { if (e.status !== 401) setMain("members", failed(e)); }
  }

  async function reloadTeam() {
    const me = await api("/me");
    state.user = me.user; state.team = me.team; state.tags = me.tags;
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
    ]));
    dialog.addEventListener("close", () => { if (route().name === "members" && page) quiet(page.reload()); }, { once: true });
  }

  function addMember() {
    const err = errorLine();
    const name = h("input", { maxlength: "20", autofocus: true, placeholder: "예: 김지현" });
    const title = h("input", { maxlength: "20", placeholder: "예: 운영팀 팀장" });
    const login = h("input", { maxlength: "20", autocapitalize: "none", spellcheck: "false", placeholder: "예: jihyun" });
    const role = h("select", {}, [h("option", { value: "member", text: "멤버" }), h("option", { value: "admin", text: "관리자" })]);
    const submit = h("button", { class: "btn btn--primary", type: "submit", text: "발급" });
    const form = h("form", { class: "stack", novalidate: true }, [
      h("div", { class: "row2" }, [field("이름", name), field("직책·부서", title, "선택")]),
      field("아이디", login, "영문 소문자·숫자·._- 3~20자"),
      field("권한", role, "관리자는 공지 쓰기와 멤버 관리를 할 수 있어요"),
      err,
      h("div", { class: "actions" }, [h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), submit])
    ]);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      busy(submit, async () => {
        try {
          const p = await api("/admin/users", { method: "POST", body: { name: name.value, title: title.value, login: login.value, role: role.value } });
          await reloadTeam();
          showIssued("계정을 만들었어요", p);
        } catch (ex) { showError(err, ex.message); (ex.field === "login" ? login : name).focus(); }
      });
    });
    openDialog("계정 발급", form);
  }

  function editMember(u) {
    const err = errorLine();
    const name = h("input", { value: u.name, maxlength: "20", autofocus: true });
    const title = h("input", { value: u.title, maxlength: "20" });
    const role = h("select", {}, [h("option", { value: "member", text: "멤버" }), h("option", { value: "admin", text: "관리자" })]);
    role.value = u.role;
    const submit = h("button", { class: "btn btn--primary", type: "submit", text: "저장" });
    const form = h("form", { class: "stack", novalidate: true }, [
      h("div", { class: "row2" }, [field("이름", name), field("직책·부서", title)]), field("권한", role), err,
      h("div", { class: "actions" }, [h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), submit])
    ]);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      busy(submit, async () => {
        try {
          await api(`/admin/users/${u.id}`, { method: "PATCH", body: { name: name.value, title: title.value, role: role.value } });
          closeDialog(); toast("저장했어요.");
          await reloadTeam();
          if (state.user.role === "admin") { buildLayout(); render(); } else go("#/today");
        } catch (ex) { showError(err, ex.message); }
      });
    });
    openDialog(`${u.login} 수정`, form);
  }

  /* ---------- 시작 ---------- */
  function render() {
    if (!state.user) return;
    if (state.user.mustChangePassword) { layout.main = null; return renderForcedPassword(); }
    if (!layout.main || !app.contains(layout.main)) buildLayout();
    closeDialog();
    closePop();
    toggleNav(false);
    const { name, id } = route();
    window.scrollTo(0, 0);
    if (name === "today") return pageToday(id && /^\d{4}-\d{2}-\d{2}$/.test(id) ? id : null);
    if (name === "dashboard") return pageDashboard();
    if (name === "tasks") return pageTasks();
    if (name === "meetings") return pageMeetings();
    if (name === "memos") return pageMemos();
    if (name === "notices" && id) return pageNotice(Number(id));
    if (name === "notices") return pageNotices();
    if (name === "members") return pageMembers();
    return go("#/today");
  }

  window.addEventListener("hashchange", render);

  async function boot() {
    app.replaceChildren(h("div", { class: "loading loading--full", text: "불러오는 중…" }));
    const r = await api("/me");
    state.user = r.user; state.team = r.team; state.tags = r.tags;
    layout.main = null;
    render();
  }

  (async function start() {
    if (!state.token) return renderLogin();
    try { await boot(); } catch (e) { if (e.status !== 401) renderLogin(e.message); }
  })();
})();
