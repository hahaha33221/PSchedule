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
  const MAX_CHIPS = 3; // 달력 칸 하나에 보여 줄 일정 수 (넘치면 +n)
  const UPCOMING_DAYS = 60; // '다가오는 일정' 에 보여 줄 기간

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
    month: null,      // 보고 있는 달의 1일 (Date)
    selected: null,   // 고른 날짜 'YYYY-MM-DD'
    events: [],
    upcoming: []
  };

  /* ---------- 유틸 ---------- */
  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k === "html") el.innerHTML = v;
      else if (k === "style") el.style.cssText = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of [].concat(children || [])) {
      if (c != null && c !== false) el.append(c);
    }
    return el;
  }

  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseYmd = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const today = () => ymd(new Date());

  function dateLabel(s, withYear) {
    const d = parseYmd(s);
    const y = withYear || d.getFullYear() !== new Date().getFullYear() ? `${d.getFullYear()}년 ` : "";
    return `${y}${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAYS[d.getDay()]})`;
  }
  function timeLabel(t) {
    const [hh, mm] = t.split(":").map(Number);
    const ap = hh < 12 ? "오전" : "오후";
    const h12 = hh % 12 || 12;
    return `${ap} ${h12}${mm ? ":" + pad(mm) : "시"}`;
  }
  function whenLabel(e) {
    const range = e.startDate === e.endDate ? dateLabel(e.startDate) : `${dateLabel(e.startDate)} ~ ${dateLabel(e.endDate)}`;
    if (!e.startTime) return `${range} · 종일`;
    return `${range} · ${timeLabel(e.startTime)}${e.endTime ? " ~ " + timeLabel(e.endTime) : ""}`;
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

  const ICON = {
    left: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
    right: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6l-1 6 3 3H7l3-3-1-6zM12 13v7"/></svg>',
    place: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg>',
    clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 18.5V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H8.5z"/></svg>',
    user: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5"/></svg>'
  };

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

  /* ---------- 로그인 ---------- */
  function renderLogin(message) {
    document.title = TITLE;
    const err = errorLine();
    const login = h("input", { name: "login", autocomplete: "username", autocapitalize: "none", spellcheck: "false", required: true, autofocus: true });
    const pw = h("input", { name: "password", type: "password", autocomplete: "current-password", required: true });
    const submit = h("button", { class: "btn btn--primary btn--block", type: "submit", text: "로그인" });
    const form = h("form", { class: "auth__card stack", novalidate: true }, [
      h("div", { class: "brand brand--lg" }, [h("img", { src: "favicon.svg", alt: "" }), h("span", { text: TITLE })]),
      h("p", { class: "muted", text: "우리 모임 일정을 함께 확인해요." }),
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
          state.user = r.user;
          start();
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
      passwordForm(start, true),
      h("button", { class: "btn btn--ghost btn--block", type: "button", text: "로그아웃", onclick: () => logout() })
    ]);
    app.replaceChildren(h("main", { class: "auth" }, card));
  }

  async function logout(expired) {
    if (!expired && state.token) api("/logout", { method: "POST" }).catch(() => {});
    state.token = "";
    state.user = null;
    store.remove("ps.token");
    closeDialog();
    renderLogin(expired ? "로그인 시간이 지났어요. 다시 로그인해 주세요." : "");
  }

  /* ---------- 틀 (머리글 + 탭) ---------- */
  function route() {
    const [, page = "calendar", id] = location.hash.replace(/^#/, "").split("/");
    return { page, id };
  }
  function go(hash) { if (location.hash !== hash) location.hash = hash; else render(); }

  function shell(page, content) {
    const tabs = [
      { id: "calendar", label: "일정", hash: "#/calendar" },
      { id: "notices", label: "공지", hash: "#/notices" },
      state.user.role === "admin" ? { id: "members", label: "멤버", hash: "#/members" } : null
    ].filter(Boolean);
    const account = h("button", { class: "account", type: "button", "aria-haspopup": "menu", "aria-expanded": "false" }, [
      h("span", { class: "account__icon", html: ICON.user }), h("span", { class: "account__name", text: state.user.name })
    ]);
    const menu = h("div", { class: "menu", role: "menu", hidden: true }, [
      h("div", { class: "menu__who" }, [h("strong", { text: state.user.name }), h("span", { text: `${state.user.login} · ${state.user.role === "admin" ? "관리자" : "멤버"}` })]),
      h("button", { type: "button", role: "menuitem", text: "비밀번호 변경", onclick: () => { hideMenu(); openDialog("비밀번호 변경", passwordForm(closeDialog)); } }),
      h("button", { type: "button", role: "menuitem", text: "로그아웃", onclick: () => logout() })
    ]);
    function hideMenu() { menu.hidden = true; account.setAttribute("aria-expanded", "false"); }
    account.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
      account.setAttribute("aria-expanded", String(!menu.hidden));
    });

    const header = h("header", { class: "topbar" }, [
      h("a", { class: "brand", href: "#/calendar" }, [h("img", { src: "favicon.svg", alt: "" }), h("span", { text: TITLE })]),
      h("nav", { class: "tabs", "aria-label": "메뉴" }, tabs.map((t) =>
        h("a", { class: "tab" + (t.id === page ? " is-active" : ""), href: t.hash, "aria-current": t.id === page ? "page" : null, text: t.label }))),
      h("div", { class: "account-wrap" }, [account, menu])
    ]);
    app.replaceChildren(header, h("main", { class: "page page--" + page }, content));
  }

  /* ---------- 달력 ---------- */
  function monthRange(month) {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const start = addDays(first, -first.getDay());
    const last = new Date(month.getFullYear(), month.getMonth() + 1, 0);
    const end = addDays(last, 6 - last.getDay());
    return { start, end };
  }
  const covers = (e, day) => e.startDate <= day && e.endDate >= day;
  const byDay = (day) => state.events.filter((e) => covers(e, day));

  async function loadMonth() {
    const { start, end } = monthRange(state.month);
    const t = today();
    const [r, u] = await Promise.all([
      api(`/events?from=${ymd(start)}&to=${ymd(end)}`),
      api(`/events?from=${t}&to=${ymd(addDays(parseYmd(t), UPCOMING_DAYS))}`)
    ]);
    state.events = r.events;
    state.upcoming = u.events;
  }

  async function renderCalendar() {
    if (!state.month) {
      const saved = store.get("ps.month", "");
      const base = /^\d{4}-\d{2}$/.test(saved) ? parseYmd(saved + "-01") : new Date();
      state.month = new Date(base.getFullYear(), base.getMonth(), 1);
    }
    if (!state.selected) state.selected = today();
    shell("calendar", h("div", { class: "loading", text: "불러오는 중…" }));
    try { await loadMonth(); } catch (e) {
      if (e.status === 401) return;
      return shell("calendar", h("p", { class: "empty", text: e.message }));
    }
    drawCalendar();
  }

  function shiftMonth(n) {
    state.month = new Date(state.month.getFullYear(), state.month.getMonth() + n, 1);
    store.set("ps.month", ymd(state.month).slice(0, 7));
    const sel = parseYmd(state.selected);
    if (sel.getMonth() !== state.month.getMonth() || sel.getFullYear() !== state.month.getFullYear()) {
      state.selected = ymd(state.month.getMonth() === new Date().getMonth() && state.month.getFullYear() === new Date().getFullYear() ? new Date() : state.month);
    }
    renderCalendar();
  }

  function chip(e, day) {
    const continues = e.startDate < day && parseYmd(day).getDay() !== 0;
    const label = (e.startTime && e.startDate === day ? e.startTime + " " : "") + e.title;
    return h("button", {
      class: `chip c${e.color}` + (e.startDate !== e.endDate ? " chip--span" : "") + (continues ? " chip--cont" : ""),
      type: "button", title: `${e.title} · ${whenLabel(e)}`,
      onclick: (ev) => { ev.stopPropagation(); openEvent(e.id); }
    }, h("span", { text: label }));
  }

  function drawCalendar() {
    const { start, end } = monthRange(state.month);
    const t = today();
    const m = state.month.getMonth();
    const title = `${state.month.getFullYear()}년 ${m + 1}월`;
    document.title = `${title} · ${TITLE}`;

    const head = h("div", { class: "cal-head" }, [
      h("h1", { class: "cal-title", text: title }),
      h("div", { class: "cal-nav" }, [
        h("button", { class: "icon-btn", type: "button", "aria-label": "이전 달", html: ICON.left, onclick: () => shiftMonth(-1) }),
        h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "오늘", onclick: () => {
          state.month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
          state.selected = today();
          store.set("ps.month", ymd(state.month).slice(0, 7));
          renderCalendar();
        } }),
        h("button", { class: "icon-btn", type: "button", "aria-label": "다음 달", html: ICON.right, onclick: () => shiftMonth(1) })
      ]),
      h("button", { class: "btn btn--primary cal-add", type: "button", onclick: () => editEvent(null, state.selected) }, [h("span", { class: "btn__icon", html: ICON.plus }), "일정 추가"])
    ]);

    const grid = h("div", { class: "cal-grid", role: "grid", "aria-label": title });
    grid.append(h("div", { class: "cal-row cal-row--head", role: "row" },
      WEEKDAYS.map((w, i) => h("div", { class: "cal-wd" + (i === 0 ? " is-sun" : i === 6 ? " is-sat" : ""), role: "columnheader", text: w }))));
    let row;
    for (let d = start, i = 0; d <= end; d = addDays(d, 1), i++) {
      if (i % 7 === 0) { row = h("div", { class: "cal-row", role: "row" }); grid.append(row); }
      const day = ymd(d);
      const list = byDay(day);
      const cls = ["cal-day"];
      if (d.getMonth() !== m) cls.push("is-out");
      if (day === t) cls.push("is-today");
      if (day === state.selected) cls.push("is-selected");
      if (d.getDay() === 0) cls.push("is-sun");
      if (d.getDay() === 6) cls.push("is-sat");
      const cell = h("div", {
        class: cls.join(" "), role: "gridcell", tabindex: day === state.selected ? "0" : "-1",
        "aria-selected": String(day === state.selected),
        "aria-label": `${dateLabel(day)}${list.length ? `, 일정 ${list.length}개` : ""}`,
        "data-day": day
      }, [
        h("span", { class: "cal-num", text: d.getDate() }),
        h("div", { class: "cal-chips" }, [
          ...list.slice(0, MAX_CHIPS).map((e) => chip(e, day)),
          list.length > MAX_CHIPS ? h("span", { class: "cal-more", text: `+${list.length - MAX_CHIPS}` }) : null
        ]),
        h("div", { class: "cal-dots", "aria-hidden": "true" }, list.slice(0, 4).map((e) => h("i", { class: `c${e.color}` })))
      ]);
      cell.addEventListener("click", () => selectDay(day));
      cell.addEventListener("dblclick", () => editEvent(null, day));
      cell.addEventListener("keydown", (e) => {
        const move = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
        if (move) { e.preventDefault(); selectDay(ymd(addDays(parseYmd(day), move)), true); }
        else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectDay(day); }
      });
      row.append(cell);
    }

    const wrap = h("div", { class: "cal-layout" }, [h("section", { class: "card cal-card" }, [head, grid]), agenda()]);
    shell("calendar", wrap);
  }

  function selectDay(day, focus) {
    const d = parseYmd(day);
    if (d.getMonth() !== state.month.getMonth() || d.getFullYear() !== state.month.getFullYear()) {
      state.selected = day;
      state.month = new Date(d.getFullYear(), d.getMonth(), 1);
      store.set("ps.month", ymd(state.month).slice(0, 7));
      return renderCalendar().then(() => focus && focusSelected());
    }
    state.selected = day;
    drawCalendar();
    focusSelected();
  }
  function focusSelected() {
    const el = app.querySelector(`.cal-day[data-day="${state.selected}"]`);
    if (el) el.focus({ preventScroll: true });
  }

  function agenda() {
    const day = state.selected;
    const list = byDay(day);
    const items = list.length
      ? h("ul", { class: "agenda-list" }, list.map((e) => h("li", {}, h("button", { class: "agenda-item", type: "button", onclick: () => openEvent(e.id) }, [
        h("span", { class: `agenda-bar c${e.color}` }),
        h("span", { class: "agenda-main" }, [
          h("strong", { text: e.title }),
          h("span", { class: "agenda-meta" }, [
            h("span", { text: e.startTime ? timeLabel(e.startTime) + (e.endTime ? " ~ " + timeLabel(e.endTime) : "") : e.startDate !== e.endDate ? "기간 일정" : "종일" }),
            e.location ? h("span", { text: e.location }) : null
          ])
        ]),
        e.comments ? h("span", { class: "agenda-count", "aria-label": `댓글 ${e.comments}개` }, [h("span", { html: ICON.chat }), String(e.comments)]) : null
      ]))))
      : h("p", { class: "empty", text: "이 날은 일정이 없어요." });
    return h("aside", { class: "card agenda", "aria-label": "고른 날 일정" }, [
      h("div", { class: "agenda-head" }, [
        h("h2", { text: dateLabel(day) }),
        h("button", { class: "btn btn--ghost btn--sm", type: "button", onclick: () => editEvent(null, day) }, [h("span", { class: "btn__icon", html: ICON.plus }), "추가"])
      ]),
      items,
      upcoming()
    ]);
  }

  // 오늘부터 UPCOMING_DAYS 일 안의 일정 (고른 날 일정은 위에 이미 보이므로 뺌)
  function upcoming() {
    const t = today();
    const list = state.upcoming.filter((e) => !covers(e, state.selected)).slice(0, 5);
    if (!list.length) return null;
    return h("div", { class: "upcoming" }, [
      h("h3", { text: "다가오는 일정" }),
      h("ul", {}, list.map((e) => h("li", {}, h("button", { type: "button", class: "upcoming-item", onclick: () => openEvent(e.id) }, [
        h("i", { class: `dot c${e.color}` }), h("span", { class: "upcoming-date", text: dateLabel(e.startDate < t ? t : e.startDate).replace(/^\d+년 /, "") }), h("span", { class: "upcoming-title", text: e.title })
      ]))))
    ]);
  }

  /* ---------- 일정 상세 ---------- */
  async function openEvent(id) {
    let r;
    try { r = await api(`/events/${id}`); } catch (e) { return toast(e.message); }
    const e = r.event;
    const body = h("div", { class: "stack" }, [
      h("div", { class: "event-tag" }, [h("i", { class: `dot c${e.color}` }), h("span", { text: e.author ? `${e.author}님이 올림` : "작성자 없음" })]),
      h("ul", { class: "event-facts" }, [
        h("li", {}, [h("span", { class: "fact-icon", html: ICON.clock }), h("span", { text: whenLabel(e) })]),
        e.location ? h("li", {}, [h("span", { class: "fact-icon", html: ICON.place }), h("span", { text: e.location })]) : null
      ]),
      e.description ? h("p", { class: "prose", text: e.description }) : null,
      e.canEdit ? h("div", { class: "actions actions--start" }, [
        h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "수정", onclick: () => editEvent(e) }),
        h("button", { class: "btn btn--ghost btn--sm btn--danger-text", type: "button", text: "삭제", onclick: () => confirmDialog("일정 삭제", `'${e.title}' 일정을 지울까요? 댓글도 함께 지워져요.`, "삭제", async () => {
          await api(`/events/${e.id}`, { method: "DELETE" });
          closeDialog();
          toast("일정을 지웠어요.");
          refreshCalendar();
        }) })
      ]) : null,
      commentsBox("event", e.id, r.comments, refreshCalendar)
    ]);
    openDialog(e.title, body, { wide: true });
  }

  function refreshCalendar() {
    if (route().page === "calendar") loadMonth().then(drawCalendar).catch(() => {});
  }

  /* ---------- 일정 만들기 / 고치기 ---------- */
  function editEvent(e, day) {
    const isNew = !e;
    const v = e || { title: "", startDate: day || today(), endDate: day || today(), startTime: "", endTime: "", location: "", description: "", color: 0 };
    const err = errorLine();
    const title = h("input", { value: v.title, maxlength: "80", required: true, autofocus: true, placeholder: "예: 정기 모임" });
    const startDate = h("input", { type: "date", value: v.startDate, required: true });
    const endDate = h("input", { type: "date", value: v.endDate, required: true });
    const allDay = h("input", { type: "checkbox", checked: !v.startTime });
    const startTime = h("input", { type: "time", value: v.startTime || "19:00", step: "300" });
    const endTime = h("input", { type: "time", value: v.endTime || "", step: "300" });
    const location_ = h("input", { value: v.location, maxlength: "80", placeholder: "선택" });
    const desc = h("textarea", { rows: "4", maxlength: "3000", placeholder: "준비물, 링크 등 (선택)" });
    desc.value = v.description;
    let color = v.color;
    const swatches = h("div", { class: "swatches", role: "radiogroup", "aria-label": "색" }, COLOR_NAMES.map((name, i) => {
      const b = h("button", { class: `swatch c${i}`, type: "button", role: "radio", "aria-checked": String(i === color), "aria-label": name, title: name });
      b.addEventListener("click", () => {
        color = i;
        swatches.querySelectorAll(".swatch").forEach((s, j) => s.setAttribute("aria-checked", String(j === i)));
      });
      return b;
    }));
    const times = h("div", { class: "row2" }, [field("시작 시간", startTime), field("끝 시간", endTime, "선택")]);
    const syncTimes = () => { times.hidden = allDay.checked; };
    allDay.addEventListener("change", syncTimes);
    syncTimes();
    startDate.addEventListener("change", () => { if (!endDate.value || endDate.value < startDate.value) endDate.value = startDate.value; });

    const submit = h("button", { class: "btn btn--primary", type: "submit", text: isNew ? "추가" : "저장" });
    const form = h("form", { class: "stack", novalidate: true }, [
      field("제목", title),
      h("div", { class: "row2" }, [field("시작 날짜", startDate), field("끝 날짜", endDate)]),
      h("label", { class: "check" }, [allDay, h("span", { text: "종일" })]),
      times,
      field("장소", location_),
      field("설명", desc),
      h("div", { class: "field" }, [h("span", { class: "field__label", text: "색" }), swatches]),
      err,
      h("div", { class: "actions" }, [h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), submit])
    ]);
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      busy(submit, async () => {
        const body = {
          title: title.value, startDate: startDate.value, endDate: endDate.value || startDate.value,
          startTime: allDay.checked ? null : startTime.value || null, endTime: allDay.checked ? null : endTime.value || null,
          location: location_.value, description: desc.value, color
        };
        try {
          const r = await api(isNew ? "/events" : `/events/${e.id}`, { method: isNew ? "POST" : "PUT", body });
          toast(isNew ? "일정을 추가했어요." : "일정을 고쳤어요.");
          state.selected = r.event.startDate;
          const d = parseYmd(r.event.startDate);
          state.month = new Date(d.getFullYear(), d.getMonth(), 1);
          if (route().page === "calendar") { await loadMonth(); drawCalendar(); }
          openEvent(r.event.id);
        } catch (ex) { showError(err, ex.message); }
      });
    });
    openDialog(isNew ? "일정 추가" : "일정 수정", form, { wide: true });
  }

  /* ---------- 댓글 ---------- */
  function commentsBox(type, id, initial, onChange) {
    const list = h("ul", { class: "comments" });
    const count = h("span", { class: "muted" });
    function draw(items) {
      count.textContent = items.length ? String(items.length) : "";
      list.replaceChildren(...(items.length ? items.map((c) => h("li", { class: "comment" + (c.mine ? " is-mine" : "") }, [
        h("div", { class: "comment__head" }, [
          h("strong", { text: c.author }), h("span", { class: "muted", text: ago(c.createdAt) }),
          c.canDelete ? h("button", { class: "link-btn", type: "button", text: "삭제", onclick: async () => {
            try {
              await api(`/comments/${c.id}`, { method: "DELETE" });
              items = items.filter((x) => x.id !== c.id);
              draw(items);
              if (onChange) onChange();
            } catch (e) { toast(e.message); }
          } }) : null
        ]),
        h("p", { class: "comment__body", text: c.body })
      ])) : [h("li", { class: "empty empty--sm", text: "아직 댓글이 없어요." })]));
    }
    draw(initial);
    const input = h("textarea", { rows: "2", maxlength: "1000", placeholder: "댓글을 남겨 주세요", "aria-label": "댓글" });
    const submit = h("button", { class: "btn btn--primary btn--sm", type: "submit", text: "등록" });
    const err = errorLine();
    const form = h("form", { class: "comment-form" }, [input, submit]);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) form.requestSubmit(); });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      busy(submit, async () => {
        try {
          const r = await api(`/${type}s/${id}/comments`, { method: "POST", body: { body: input.value } });
          input.value = "";
          showError(err, "");
          draw(r.comments);
          if (onChange) onChange();
        } catch (ex) { showError(err, ex.message); }
      });
    });
    return h("section", { class: "comments-box" }, [h("h3", {}, ["댓글 ", count]), list, form, err]);
  }

  /* ---------- 공지 ---------- */
  async function renderNotices() {
    document.title = `공지 · ${TITLE}`;
    shell("notices", h("div", { class: "loading", text: "불러오는 중…" }));
    let r;
    try { r = await api("/notices"); } catch (e) { if (e.status !== 401) shell("notices", h("p", { class: "empty", text: e.message })); return; }
    const isAdmin = state.user.role === "admin";
    shell("notices", h("div", { class: "narrow stack" }, [
      h("div", { class: "page-head" }, [
        h("h1", { text: "공지" }),
        isAdmin ? h("button", { class: "btn btn--primary", type: "button", onclick: () => editNotice(null) }, [h("span", { class: "btn__icon", html: ICON.plus }), "공지 쓰기"]) : null
      ]),
      r.notices.length ? h("ul", { class: "notice-list" }, r.notices.map((n) => h("li", {}, h("a", { class: "card notice-item" + (n.pinned ? " is-pinned" : ""), href: `#/notices/${n.id}` }, [
        h("div", { class: "notice-item__title" }, [n.pinned ? h("span", { class: "pin", html: ICON.pin, title: "고정" }) : null, h("strong", { text: n.title })]),
        h("p", { class: "notice-item__preview", text: n.preview }),
        h("div", { class: "notice-item__meta muted" }, [
          h("span", { text: n.author || "관리자" }), h("span", { text: ago(n.createdAt) }),
          n.comments ? h("span", { class: "with-icon" }, [h("span", { html: ICON.chat }), String(n.comments)]) : null
        ])
      ])))) : h("div", { class: "card empty", text: isAdmin ? "아직 공지가 없어요. 첫 공지를 써 보세요." : "아직 공지가 없어요." })
    ]));
  }

  async function renderNotice(id) {
    shell("notices", h("div", { class: "loading", text: "불러오는 중…" }));
    let r;
    try { r = await api(`/notices/${id}`); } catch (e) {
      if (e.status === 401) return;
      return shell("notices", h("div", { class: "narrow stack" }, [h("a", { class: "back-link", href: "#/notices", text: "← 공지 목록" }), h("p", { class: "card empty", text: e.message })]));
    }
    const n = r.notice;
    document.title = `${n.title} · ${TITLE}`;
    shell("notices", h("div", { class: "narrow stack" }, [
      h("a", { class: "back-link", href: "#/notices", text: "← 공지 목록" }),
      h("article", { class: "card notice-view stack" }, [
        h("h1", {}, [n.pinned ? h("span", { class: "pin", html: ICON.pin, title: "고정" }) : null, n.title]),
        h("div", { class: "muted notice-item__meta" }, [h("span", { text: n.author || "관리자" }), h("span", { text: ago(n.createdAt) }), n.updatedAt !== n.createdAt ? h("span", { text: "수정됨" }) : null]),
        h("div", { class: "prose", text: n.body }),
        n.canEdit ? h("div", { class: "actions actions--start" }, [
          h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "수정", onclick: () => editNotice(n) }),
          h("button", { class: "btn btn--ghost btn--sm btn--danger-text", type: "button", text: "삭제", onclick: () => confirmDialog("공지 삭제", `'${n.title}' 공지를 지울까요? 댓글도 함께 지워져요.`, "삭제", async () => {
            await api(`/notices/${n.id}`, { method: "DELETE" });
            closeDialog();
            toast("공지를 지웠어요.");
            go("#/notices");
          }) })
        ]) : null
      ]),
      h("div", { class: "card" }, commentsBox("notice", n.id, r.comments))
    ]));
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
  async function renderMembers() {
    if (state.user.role !== "admin") return go("#/calendar");
    document.title = `멤버 · ${TITLE}`;
    shell("members", h("div", { class: "loading", text: "불러오는 중…" }));
    let r;
    try { r = await api("/admin/users"); } catch (e) { if (e.status !== 401) shell("members", h("p", { class: "empty", text: e.message })); return; }
    const rows = r.users.map((u) => h("tr", {}, [
      h("td", {}, [h("strong", { text: u.name }), u.me ? h("span", { class: "badge", text: "나" }) : null]),
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
        u.me ? null : h("button", { class: "link-btn link-btn--danger", type: "button", text: "삭제", onclick: () => confirmDialog("멤버 삭제", `${u.name}님(${u.login}) 계정을 지울까요? 올린 일정·댓글은 남고 작성자만 비워져요.`, "삭제", async () => {
          await api(`/admin/users/${u.id}`, { method: "DELETE" });
          closeDialog();
          toast("계정을 지웠어요.");
          renderMembers();
        }) })
      ])
    ]));
    shell("members", h("div", { class: "stack" }, [
      h("div", { class: "page-head" }, [
        h("h1", {}, ["멤버 ", h("span", { class: "muted", text: String(r.users.length) })]),
        h("button", { class: "btn btn--primary", type: "button", onclick: addMember }, [h("span", { class: "btn__icon", html: ICON.plus }), "계정 발급"])
      ]),
      h("div", { class: "card table-wrap" }, h("table", { class: "table" }, [
        h("thead", {}, h("tr", {}, ["이름", "아이디", "권한", "비밀번호", "최근 로그인", ""].map((t) => h("th", { text: t })))),
        h("tbody", {}, rows)
      ]))
    ]));
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
    dialog.addEventListener("close", () => { if (route().page === "members") renderMembers(); }, { once: true });
  }

  function addMember() {
    const err = errorLine();
    const name = h("input", { maxlength: "20", autofocus: true, placeholder: "예: 김민지" });
    const login = h("input", { maxlength: "20", autocapitalize: "none", spellcheck: "false", placeholder: "예: minji" });
    const role = h("select", {}, [h("option", { value: "member", text: "멤버" }), h("option", { value: "admin", text: "관리자" })]);
    const submit = h("button", { class: "btn btn--primary", type: "submit", text: "발급" });
    const form = h("form", { class: "stack", novalidate: true }, [
      field("이름", name, "달력·댓글에 보이는 이름"),
      field("아이디", login, "영문 소문자·숫자·._- 3~20자"),
      field("권한", role, "관리자는 공지 쓰기와 멤버 관리를 할 수 있어요"),
      err,
      h("div", { class: "actions" }, [h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), submit])
    ]);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      busy(submit, async () => {
        try {
          const p = await api("/admin/users", { method: "POST", body: { name: name.value, login: login.value, role: role.value } });
          showIssued("계정을 만들었어요", p);
        } catch (ex) { showError(err, ex.message); (ex.field === "login" ? login : name).focus(); }
      });
    });
    openDialog("계정 발급", form);
  }

  function editMember(u) {
    const err = errorLine();
    const name = h("input", { value: u.name, maxlength: "20", autofocus: true });
    const role = h("select", {}, [h("option", { value: "member", text: "멤버" }), h("option", { value: "admin", text: "관리자" })]);
    role.value = u.role;
    const submit = h("button", { class: "btn btn--primary", type: "submit", text: "저장" });
    const form = h("form", { class: "stack", novalidate: true }, [
      field("이름", name), field("권한", role), err,
      h("div", { class: "actions" }, [h("button", { class: "btn btn--ghost", type: "button", text: "취소", "data-close": true }), submit])
    ]);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      busy(submit, async () => {
        try {
          await api(`/admin/users/${u.id}`, { method: "PATCH", body: { name: name.value, role: role.value } });
          closeDialog();
          toast("저장했어요.");
          if (u.me) { const me = await api("/me"); state.user = me.user; }
          if (state.user.role === "admin") renderMembers(); else go("#/calendar");
        } catch (ex) { showError(err, ex.message); }
      });
    });
    openDialog(`${u.login} 수정`, form);
  }

  /* ---------- 시작 ---------- */
  function render() {
    if (!state.user) return;
    if (state.user.mustChangePassword) return renderForcedPassword();
    closeDialog();
    const { page, id } = route();
    if (page === "notices" && id) return renderNotice(Number(id));
    if (page === "notices") return renderNotices();
    if (page === "members") return renderMembers();
    return renderCalendar();
  }

  function start() { render(); }

  window.addEventListener("hashchange", render);
  // 계정 메뉴 바깥을 누르면 닫기
  document.addEventListener("click", (e) => {
    const menu = app.querySelector(".menu");
    if (menu && !menu.hidden && !menu.contains(e.target)) {
      menu.hidden = true;
      app.querySelector(".account").setAttribute("aria-expanded", "false");
    }
  });

  (async function boot() {
    if (!state.token) return renderLogin();
    app.replaceChildren(h("div", { class: "loading loading--full", text: "불러오는 중…" }));
    try {
      const r = await api("/me");
      state.user = r.user;
      start();
    } catch (e) {
      if (e.status !== 401) renderLogin(e.message);
    }
  })();
})();
