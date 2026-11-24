// 변경 내역(알림): 고치는 요청(POST·PATCH·PUT·DELETE)의 앞뒤 행을 비교해 '누가·언제·무엇을·어떻게'를 쌓음
//   - 전화번호·주소·담당자 이름과 긴 글(메모·내용)은 값 없이 '고쳤어요'만 남김
//   - 공지(안 읽은 수가 따로 있음)·비밀글·개인 일정은 남기지 않음
//   - 볼 수 있는지는 읽을 때 지금 권한으로 거름 (visibleTo)
export const KEEP_DAYS = 90;

const MON = { new: "등록", edu_done: "교육 완료", making: "제작 중", recovered: "회수 완료", checked: "검수 완료", issue: "문제 있음" };
const SHIP = { ready: "준비", sent: "발송", arrived: "도착", returned: "반송" };
const SHIP_KIND = { "": "종류 미정", inspect: "검수 택배", material_done: "재료 택배(작업완료)", vendor: "업체 택배", material_make: "재료 택배(제작용)", material_work: "재료 택배(작업용)", return: "반송 택배" };
const EDU = { plan: "예정", done: "완료", delay: "연기", planned: "진행예정" };
const ASSIGN = { wait: "대기", doing: "검수 중", done: "완료" };
const ISSUE = { new: "접수", doing: "처리 중", done: "완료" };
const STAGE = { in: "입고", checked: "검수완료", packed: "패키징완료", out: "출고" };
const REWORK = { "": "정하지 않음", return: "반송", fix: "현장 재작업", hold: "보관", discard: "폐기" };
const BUY = { request: "요청", approved: "승인", ordered: "주문", received: "입고", canceled: "취소" };
const YN = { 0: "아니요", 1: "예" };
const HIDE = Symbol("값은 남기지 않음");

const lastPart = (t) => String(t || "").split(" · ").pop().trim();
// 요청 주소 → 표 하나. 라벨: [이름, 값 바꿈 | HIDE]
const SPECS = (db) => {
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const orgOf = (sid) => (sid ? lastPart(one("SELECT title FROM vol_schedules WHERE id = ?", sid)?.title) : "");
  const eduRow = (id) => one("SELECT s.*, t.status AS t_status, t.helper, t.attend, t.result_note, t.made_qty, t.made_due FROM vol_schedules s LEFT JOIN team_org_info t ON t.schedule_id = s.id WHERE s.id = ?", id);
  const EDU_LABEL = { title: ["수도회", lastPart], date: "날짜", start_time: "시간", table_only: ["날짜 미정", YN], place: ["장소", HIDE], progress: ["진행상태", EDU], t_status: ["상태", EDU], helper: ["담당 봉사자", HIDE], contact: ["연락처", HIDE], attend: "참석 인원", result_note: ["특이사항", HIDE], made_qty: "예상 완성 수량", made_due: "완성 예정 시기", qty: "요청수량", edu_qty: "교육물량", thread_qty: "실 출고", cross_qty: "십자가 출고", alloc_qty: "배당물량", send_thread: "보낼 실", send_cross: "보낼 십자가", sample_qty: "샘플", done_qty: "완성", loss_qty: "로스", mat_handler: ["출납 담당", HIDE], mat_note: ["출납 비고", HIDE] };
  const edu = (re, x = {}) => ({ re, table: "vol_schedules", load: eduRow, labels: EDU_LABEL, title: (r) => lastPart(r.title), topic: (r, key) => (!r.project_item_id ? (r.audience === "all" ? "sched" : null) : key?.startsWith("made_") ? "made" : ["qty", "edu_qty", "thread_qty", "cross_qty"].includes(key) ? "req" : "edu"), also: (r) => (r.project_item_id ? "req" : null), ...x });
  const moveTitle = (r) => `${one("SELECT name FROM stock_ledgers WHERE id = ?", r.ledger_id)?.name || "입출고"} · ${r.type === "in" ? "입고" : "출고"} ${r.date}`;
  const moveRow = (id) => { const m = one("SELECT * FROM stock_moves WHERE id = ?", id); return m && { ...m, items: db.prepare("SELECT o.name, q.qty FROM stock_qty q JOIN stock_options o ON o.id = q.option_id WHERE q.move_id = ? ORDER BY o.id").all(id).map((x) => `${x.name} ${x.qty}`).join(", ") }; };
  const move = (re) => ({ re, table: "stock_moves", load: moveRow, labels: { date: "날짜", items: "수량", inspect_ok: "검수 합격", inspect_bad: "검수 불량", handler: ["전달자", HIDE], note: ["비고", HIDE], issue: ["이슈", HIDE] }, title: moveTitle, topic: (r) => (r.type === "in" ? "stock_in" : "stock_out"), scope: (r) => r.ledger_id });
  const insp = (re) => ({ re, table: "inspections", labels: { date: "검수일", checked_qty: "검수 수량", sample_qty: "샘플 수", defects: ["불량", HIDE], rework: ["불합격품 처리", REWORK], source: "대상", note: ["메모", HIDE] }, title: (r) => r.source || orgOf(r.schedule_id) || "검수", topic: (r, key) => (key === "rework" ? "defect" : "inspect") });
  return [
    { re: /^\/api\/ops\/shipments(?:\/(\d+))?$/, table: "shipments", labels: { status: ["상태", SHIP], kind: ["종류", SHIP_KIND], qty: "수량", contents: "내용물", sent_date: "발송일", arrived_date: "도착일", carrier: "택배사", tracking_no: "송장번호", monastery_id: ["수도회", (v) => one("SELECT name FROM monasteries WHERE id = ?", v)?.name || "-"], address: ["주소", HIDE], party_name: ["상대 이름", HIDE], note: ["메모", HIDE] },
      title: (r) => (r.monastery_id && one("SELECT name FROM monasteries WHERE id = ?", r.monastery_id)?.name) || (r.external_contact_id && one("SELECT name FROM external_contacts WHERE id = ?", r.external_contact_id)?.name) || SHIP_KIND[r.kind] || "택배", topic: (r) => (r.direction === "in" ? "ship_in" : "ship_out"), scope: (r) => (["", "inspect"].includes(r.kind) ? r.monastery_id : null) },
    { re: /^\/api\/ops\/monasteries(?:\/(\d+))?$/, table: "monasteries", topic: "mon", title: (r) => r.name, labels: { name: "이름", status: ["진행 상태", MON], issue_note: ["문제 내용", HIDE], contact_name: ["담당 수녀·수사", HIDE], phone: ["연락처", HIDE], address: ["주소", HIDE], note: ["메모", HIDE], short_name: "약칭" } },
    edu(/^\/api\/team\/orgs(?:\/(\d+))?$/), edu(/^\/api\/admin\/vol-edu(?:\/(\d+))?$/), edu(/^\/api\/admin\/vol-schedules(?:\/(\d+))?$/),
    edu(/^\/api\/volunteer\/schedules\/(\d+)\/qty$/, {}),
    { re: /^\/api\/team\/orgs\/(\d+)\/inquiries$/, table: "team_inquiries", create: true, topic: "edu", title: (r) => `${orgOf(r.schedule_id)} 문의`, ref: (r) => r.schedule_id, labels: {} },
    { re: /^\/api\/team\/inquiries\/(\d+)$/, table: "team_inquiries", topic: "edu", title: (r) => `${orgOf(r.schedule_id)} 문의`, ref: (r) => r.schedule_id, labels: { question: ["문의", HIDE], answer: ["답변", HIDE], done: ["처리 완료", YN], date: "날짜" } },
    { re: /^\/api\/team\/recovery(?:\/(\d+))?$/, table: "team_recovery", topic: "recovery", title: (r) => `${orgOf(r.schedule_id)} 회수`, labels: { qty: "수량", date: "날짜", method: ["방법", { "": "-", parcel: "택배", visit: "방문", bring: "가져옴" }], schedule_id: ["수도회", orgOf], note: ["메모", HIDE] } },
    { re: /^\/api\/team\/daily(?:\/(\d+))?$/, table: "team_daily", topic: "daily", title: (r) => `${r.date} 하루 봉사 기록`, labels: { qty: "검수 수량", date: "날짜", workers: ["함께한 봉사자", HIDE], note: ["메모", HIDE] } },
    { re: /^\/api\/team\/shifts(?:\/(\d+))?$/, table: "team_shifts", topic: "shifts", title: (r) => `${r.date} 검수 봉사일`, labels: { date: "날짜", start_time: "시간", need: "필요 인원", note: ["메모", HIDE] } },
    { re: /^\/api\/team\/shifts\/(\d+)\/signup$/, table: "team_shifts", topic: "shifts", title: (r) => `${r.date} 검수 봉사일`, load: (id) => { const s = one("SELECT * FROM team_shifts WHERE id = ?", id); return s && { ...s, people: one("SELECT count(*) AS n FROM team_shift_users WHERE shift_id = ?", id).n }; }, labels: { people: "신청 인원" }, },
    { re: /^\/api\/team\/day-need$/, custom: () => Object.fromEntries(db.prepare("SELECT date, need FROM team_day_need").all().map((x) => [x.date, x.need])), topic: "need", label: "필요 인원" },
    { re: /^\/api\/team\/issues(?:\/(\d+))?$/, table: "team_issues", topic: "issue", title: (r) => r.title, labels: { title: "제목", status: ["처리 상태", ISSUE], reply: ["답", HIDE], body: ["내용", HIDE] } },
    { re: /^\/api\/team\/docs(?:\/(\d+))?$/, table: "team_docs", topic: "docs", title: (r) => r.title, labels: { title: "제목", url: ["링크", HIDE], note: ["내용", HIDE] } },
    insp(/^\/api\/(?:team|admin)\/inspections(?:\/(\d+))?$/),
    { re: /^\/api\/ops\/criteria(?:\/(\d+))?$/, whole: () => db.prepare("SELECT version, item, method, pass_rule, defect_key, defect_name, valid_from FROM inspection_criteria ORDER BY id").all(), topic: "criteria", title: () => "검수 기준", detail: "검수 기준을 고쳤어요" },
    { re: /^\/api\/ops\/criteria-photos(?:\/(\d+))?$/, whole: () => db.prepare("SELECT id FROM criteria_photos").all(), topic: "criteria", title: () => "검수 기준 사진", detail: "예시 사진을 올리거나 지웠어요" },
    { re: /^\/api\/ops\/groups(?:\/(\d+))?$/, table: "inspection_groups", topic: "groups", title: (r) => r.name, labels: { name: "조 이름", active: ["사용", YN], note: ["메모", HIDE] } },
    { re: /^\/api\/ops\/groups\/(\d+)\/assigns$/, table: "inspection_group_assigns", create: true, topic: "groups", title: (r) => `${one("SELECT name FROM inspection_groups WHERE id = ?", r.group_id)?.name || "조"} · ${orgOf(r.schedule_id)} 배정`, ref: (r) => r.group_id, labels: {} },
    { re: /^\/api\/ops\/assigns\/(\d+)$/, table: "inspection_group_assigns", topic: "groups", title: (r) => `${one("SELECT name FROM inspection_groups WHERE id = ?", r.group_id)?.name || "조"} · ${orgOf(r.schedule_id)} 배정`, ref: (r) => r.group_id, labels: { qty: "수량", due_date: "완료 예정일", status: ["상태", ASSIGN], note: ["메모", HIDE] } },
    { re: /^\/api\/ops\/contacts(?:\/(\d+))?$/, table: "contact_logs", topic: "contacts", title: (r) => `${(r.monastery_id && one("SELECT name FROM monasteries WHERE id = ?", r.monastery_id)?.name) || "연락"} 기록 ${r.date}`, labels: { date: "날짜", content: ["내용", HIDE], follow_up: ["후속 조치", HIDE], due_date: "기한", done: ["후속 조치 완료", YN], target_name: ["대상", HIDE] } },
    { re: /^\/api\/ops\/duties(?:\/(\d+))?$/, table: "duty_assignments", topic: "duties", title: () => "업무 담당", labels: { duty: ["업무", HIDE], user_id: ["담당자", HIDE], start_date: "시작", end_date: "끝", note: ["메모", HIDE] } },
    { re: /^\/api\/ops\/deadlines(?:\/(\d+))?$/, table: "deadlines", topic: "deadline", title: (r) => r.title, scope: (r) => ({ all: 0, dept: 1, team: 2 })[r.audience] ?? 0, labels: { date: "마감일", title: "할 일", done: ["완료", YN], note: ["메모", HIDE] } },
    { re: /^\/api\/ops\/cutting(?:\/(\d+))?$/, table: "cutting_jobs", topic: "cutting", title: (r) => `실자르기 ${r.date}`, labels: { date: "작업일", raw_qty: "사용 수량", skein_qty: "만든 타래", workers: ["함께한 봉사자", HIDE], note: ["메모", HIDE] } },
    { re: /^\/api\/ops\/handouts(?:\/(\d+))?$/, table: "thread_handouts", topic: "cutting", title: (r) => `타래 배분 ${r.date}`, ref: () => null, labels: { date: "전달일", skein_qty: "타래 수", receiver_name: ["받는 사람", HIDE], note: ["메모", HIDE] } },
    { re: /^\/api\/ops\/purchases(?:\/(\d+))?$/, table: "purchases", topic: "buy", title: (r) => r.item_name, labels: { status: ["상태", BUY], qty: "수량", amount: ["금액", HIDE], expected_date: "입고 예정일", note: ["메모", HIDE] } },
    { re: /^\/api\/ops\/stock\/(?:move|adjust)$/, table: "stock_moves", create: true, first: true, load: moveRow, topic: "stockops", title: moveTitle, labels: {} },
    { re: /^\/api\/ops\/stock\/moves\/(\d+)$/, table: "stock_moves", load: moveRow, topic: "stockops", title: moveTitle, labels: { items: "수량", date: "날짜" } },
    { re: /^\/api\/ops\/stock-options\/(\d+)$/, table: "stock_options", topic: "stockops", title: (r) => r.name, scope: (r) => r.ledger_id, ref: () => null, labels: { safety_qty: "안전 재고", color: ["품목 색", HIDE] } },
    { re: /^\/api\/ops\/locations(?:\/(\d+))?$/, table: "storage_locations", topic: "stockops", title: (r) => `보관 장소 ${r.name}`, ref: () => null, labels: { name: "이름", active: ["사용", YN], place: ["위치", HIDE], note: ["메모", HIDE] } },
    { re: /^\/api\/stock\/(\d+)$/, table: "stock_ledgers", topic: "ledger", title: (r) => `${r.name} 대장`, scope: (r) => r.id, labels: { name: "이름", unit: "단위", contract: "계약 수량", in_label: "입고 경로", out_label: "출고 경로", after: ["전달 후 현황", HIDE] } },
    { re: /^\/api\/projects(?:\/(\d+))?$/, table: "projects", topic: "proj", title: (r) => r.name, scope: (r) => r.id, labels: { name: "이름", note: ["설명", HIDE] } },
    { re: /^\/api\/projects\/(\d+)\/items$/, table: "project_items", create: true, topic: "proj", title: (r) => r.name, scope: (r) => r.project_id, ref: (r) => r.project_id, labels: {} },
    { re: /^\/api\/project-items\/(\d+)$/, table: "project_items", topic: "proj", title: (r) => r.name, scope: (r) => r.project_id, ref: (r) => r.project_id, labels: { name: "이름", status: ["상태", { none: "미정", idea: "아이디어", review: "검토", doing: "진행", fixed: "확정", hold: "보류", done: "완료" }], due_date: "마감일", assignee_id: ["담당자", HIDE], note: ["메모", HIDE] } },
    move(/^\/api\/(?:volunteer\/)?stock-moves\/(\d+)$/), { ...move(/^\/api\/(?:volunteer\/)?stock\/(\d+)\/moves$/), create: true },
    { re: /^\/api\/volunteer\/records(?:\/(\d+))?$/, table: "vol_records", topic: "fin", title: (r) => `${one("SELECT name FROM project_items WHERE id = ?", r.item_id)?.name || "완제품"} ${STAGE[r.stage] || ""} ${r.date}`, scope: (r) => r.item_id, labels: { stage: ["단계", STAGE], qty: "수량", date: "날짜", name: ["장소", HIDE], note: ["메모", HIDE] } },
    { re: /^\/api\/board(?:\/(\d+))?$/, table: "board_posts", topic: "board", title: (r) => r.title, skip: (r) => !!r.secret, labels: { title: "제목", secret: ["비밀글", YN], body: ["내용", HIDE] }, purge: (r) => r.secret }, // 비밀글로 바꾸거나 비밀글을 지우면 지난 알림도 지움
    { re: /^\/api\/board\/(\d+)\/comments$/, table: "board_comments", create: true, topic: "board", title: (r) => `${one("SELECT title FROM board_posts WHERE id = ?", r.post_id)?.title || "글"} 댓글`, ref: (r) => r.post_id, skip: (r) => !!one("SELECT secret FROM board_posts WHERE id = ?", r.post_id)?.secret, labels: {} },
    { re: /^\/api\/board-comments\/(\d+)$/, table: "board_comments", topic: "board", title: (r) => `${one("SELECT title FROM board_posts WHERE id = ?", r.post_id)?.title || "글"} 댓글`, ref: (r) => r.post_id, skip: (r) => !!one("SELECT secret FROM board_posts WHERE id = ?", r.post_id)?.secret, labels: { body: ["댓글", HIDE] } },
    { re: /^\/api\/admin\/vol-trainings(?:\/(\d+))?$/, table: "vol_trainings", topic: "training", title: (r) => r.title, labels: { title: "제목", date: "날짜", start_time: "시간", place: ["장소", HIDE], body: ["내용", HIDE], link: ["자료 링크", HIDE] } }
  ];
};

export function makeChanges(db) {
  const specs = SPECS(db);
  const ins = db.prepare("INSERT INTO changes (actor_id, actor_name, topic, action, title, detail, ref_id, scope_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const cut = (t, n) => (String(t).length > n ? `${String(t).slice(0, n - 1)}…` : String(t));
  const add = ({ user, topic, action, title, detail = "", ref = null, scope = null }) => { if (topic) ins.run(user?.id ?? null, user?.name || "자동", topic, action, cut(title || "", 120), cut(detail, 300), ref, scope); };
  const show = (v, map) => { if (v == null || v === "") return "없음"; if (typeof map === "function") return map(v) || "없음"; return map && map[v] !== undefined ? map[v] : cut(v, 80); };
  const part = (spec, k, a, b) => { const l = [].concat(spec.labels[k]); return l[1] === HIDE ? `${l[0]} 고침` : `${l[0]} ${show(a[k], l[1])} → ${show(b[k], l[1])}`; };
  const maxId = (t) => db.prepare(`SELECT coalesce(max(id), 0) AS n FROM ${t}`).get().n;
  const MON_NEW = (id) => db.prepare("SELECT * FROM monasteries WHERE id > ? ORDER BY id").all(id);
  // 요청을 처리하기 전에 부르고, 성공하면 돌려준 함수를 부름 (주소에 맞는 것이 없으면 null)
  function watch(path, method, user) {
    if (!["POST", "PATCH", "PUT", "DELETE"].includes(method)) return null;
    const spec = specs.find((s) => s.re.test(path));
    if (!spec) return null;
    if (spec.whole) { const a = JSON.stringify(spec.whole()); return () => { if (JSON.stringify(spec.whole()) !== a) add({ user, topic: spec.topic, action: "edit", title: spec.title(), detail: spec.detail }); }; }
    if (spec.custom) {
      const a = spec.custom();
      return () => { const b = spec.custom(); for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) add({ user, topic: spec.topic, action: a[k] === undefined ? "add" : b[k] === undefined ? "delete" : "edit", title: `${k} ${spec.label}`, detail: `${a[k] ?? 0}명 → ${b[k] ?? 0}명` }); };
    }
    const load = spec.load || ((id) => db.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).get(id));
    const topicOf = (r, key) => (typeof spec.topic === "function" ? spec.topic(r, key) : spec.topic);
    const base = (r) => ({ user, title: spec.title(r), ref: spec.ref ? spec.ref(r) : r.id, scope: spec.scope?.(r) ?? null }); // 지운 기록도 제목을 남기려고 미리 만들어 둠
    const put = (action, r, b, detail = "") => {
      if (spec.skip?.(r)) return;
      for (const topic of new Set([topicOf(r), spec.also?.(r)])) if (topic) add({ ...b, topic, action, detail });
    };
    const id = Number(path.match(spec.re)[1]) || null;
    // 딸려 생기는 기록: 새 수도회, 택배 도착으로 생긴 회수 기록, 저절로 바뀐 수도회 진행 상태
    const mon0 = spec.table === "monasteries" ? Infinity : maxId("monasteries"), rec0 = spec.table === "team_recovery" ? Infinity : maxId("team_recovery"), log0 = spec.table === "monasteries" ? Infinity : maxId("monastery_status_log");
    const after = () => {
      if (mon0 !== Infinity) for (const m of MON_NEW(mon0)) add({ user, topic: "mon", action: "add", title: m.name, ref: m.id });
      if (rec0 !== Infinity) for (const r of db.prepare("SELECT r.id, r.qty, s.title FROM team_recovery r JOIN vol_schedules s ON s.id = r.schedule_id WHERE r.id > ?").all(rec0)) add({ user, topic: "recovery", action: "add", title: `${lastPart(r.title)} 회수`, detail: `택배 도착으로 생김 · 수량 ${r.qty}`, ref: r.id });
      if (log0 !== Infinity) statusLogs(log0);
    };
    if (id && !spec.create) {
      const a = load(id);
      if (!a) return null;
      const was = base(a);
      return () => {
        const b = load(id);
        if (!b) put("delete", a, was);
        else {
          const by = new Map();
          if (!spec.skip?.(b)) for (const k of Object.keys(spec.labels)) if ((a[k] ?? "") !== (b[k] ?? "")) { const t = topicOf(b, k); if (t) by.set(t, [...(by.get(t) || []), part(spec, k, a, b)]); }
          for (const [topic, list] of by) add({ ...base(b), topic, action: "edit", detail: list.join(", ") });
        }
        if (spec.purge && (spec.purge(b || a))) db.prepare("DELETE FROM changes WHERE topic = ? AND ref_id = ?").run(topicOf(a), id);
        after();
      };
    }
    if (method !== "POST") return null;
    const max = maxId(spec.table);
    return () => {
      const rows = db.prepare(`SELECT id FROM ${spec.table} WHERE id > ? ORDER BY id`).all(max);
      for (const x of spec.first ? rows.slice(0, 1) : rows) { const r = load(x.id); if (r && (r.created_by == null || r.created_by === user.id)) put("add", r, base(r), r.items || ""); }
      after();
    };
  }
  // 수도회 진행 상태 이력 → 변경 내역 (사람이 직접 바꾼 것은 수도회 고치기에서 이미 남으므로 부르지 않음)
  function statusLogs(afterId) {
    for (const l of db.prepare("SELECT l.*, m.name FROM monastery_status_log l JOIN monasteries m ON m.id = l.monastery_id WHERE l.id > ? ORDER BY l.id").all(afterId))
      add({ user: l.actor_id ? { id: l.actor_id, name: l.actor_name } : null, topic: "mon", action: "edit", title: l.name, detail: `진행 상태 ${MON[l.from_status] || l.from_status} → ${MON[l.to_status] || l.to_status}${l.reason ? ` (${l.reason})` : ""}`, ref: l.monastery_id });
  }
  const logMax = () => maxId("monastery_status_log");
  const prune = () => db.prepare(`DELETE FROM changes WHERE at < datetime('now', '-${KEEP_DAYS} days')`).run().changes;
  return { watch, statusLogs, logMax, prune };
}

// 주제 → 이름, 역할마다 그 변경을 볼 메뉴(열면 숫자가 사라짐). 없으면 그 역할에는 안 보임
//   dept0·team0: 단계형 메뉴를 끈 예전 화면 / staff·admin: 왼쪽 메뉴, link 는 눌렀을 때 여는 화면 / perm: 권한표에서 볼 수 있어야 함
export const TOPICS = {
  ship_in: { label: "택배 수신", dept: "dr1", team: "tmake2", staff: "ops", admin: "ops", link: "ops/ship-in", perm: "shipments" },
  ship_out: { label: "택배 발송", dept: "ds3", staff: "ops", admin: "ops", link: "ops/ship-out", perm: "shipments" },
  stock_in: { label: "입고", dept: "dr2", dept0: "in", staff: "stock", admin: "stock", link: "stock" },
  stock_out: { label: "출고", dept: "ds2", dept0: "out", staff: "stock", admin: "stock", link: "stock" },
  req: { label: "추가 전달 물량", dept: "ds1", dept0: "req", team: "tedu2", team0: "torgs", staff: "projects", admin: "volunteers", link: "volunteers/edu", staffLink: "projects" },
  fin: { label: "완제품", dept: "df1", dept0: "recovery", staff: "projects", admin: "volunteers", link: "volunteers/records", staffLink: "projects" },
  mon: { label: "수도회", team: "tedu1", staff: "ops", admin: "ops", link: "ops/mon", perm: "monasteries" },
  edu: { label: "교육", team: "tedu2", team0: "torgs", admin: "volunteers", link: "volunteers/edu" },
  made: { label: "제작 진행", team: "tmake1", team0: "torgs", admin: "volunteers", link: "volunteers/edu" },
  recovery: { label: "회수", team: "tmake2", team0: "trecov", admin: "volunteers", link: "volunteers/team" },
  criteria: { label: "검수 기준", team: "tins1", staff: "ops", admin: "ops", link: "ops/criteria", perm: "criteria" },
  groups: { label: "검수 조·배정", team: "tins2", staff: "ops", admin: "ops", link: "ops/groups", perm: "groups" },
  shifts: { label: "검수 봉사일", team: "tins2", team0: "tinsp", admin: "volunteers", link: "volunteers/team" },
  need: { label: "필요 인원", team: "thome", team0: "thome", admin: "volunteers", link: "volunteers/team" },
  inspect: { label: "검수", team: "tins3", team0: "tinsp", admin: "volunteers", link: "volunteers/inspect" },
  defect: { label: "불량 처리", team: "tins4", team0: "tinsp", admin: "volunteers", link: "volunteers/inspect" },
  daily: { label: "하루 봉사 기록", team: "tins5", team0: "tinsp", admin: "volunteers", link: "volunteers/team" },
  issue: { label: "이슈", team: "tissues", team0: "tissues", dept: "vissues", admin: "volunteers", link: "volunteers/team" },
  board: { label: "게시판", team: "vboard", team0: "vboard", dept: "vboard", dept0: "vboard", admin: "board", link: "board" },
  docs: { label: "자료실", team: "tdocs", team0: "tdocs", admin: "volunteers", link: "volunteers/team" },
  duties: { label: "담당·역할", team: "tdocs", staff: "ops", admin: "ops", link: "ops/duties", perm: "duties" },
  contacts: { label: "연락·문의 기록", dept: "vcontacts", staff: "ops", admin: "ops", link: "ops/contacts", perm: "contacts" },
  deadline: { label: "데드라인", dept: "vdeadlines", team: "vdeadlines", admin: "volunteers", link: "volunteers/deadlines" },
  sched: { label: "일정", team: "vschedule", dept0: "vschedule", admin: "volunteers", link: "volunteers" },
  training: { label: "기본 교육", dept: "vtraining", dept0: "vtraining", admin: "volunteers/training", link: "volunteers/training" },
  cutting: { label: "실자르기·타래", staff: "ops", admin: "ops", link: "ops/cut", perm: "cutting" },
  buy: { label: "업체 구매", staff: "ops", admin: "ops", link: "ops/buy", perm: "purchases" },
  stockops: { label: "재고·보관", dept: "dr2", staff: "ops", admin: "ops", link: "ops/stock", perm: "stock" },
  ledger: { label: "입출고 대장", staff: "stock", admin: "stock", link: "stock" },
  proj: { label: "프로젝트", staff: "projects", admin: "projects", link: "projects" }
};
