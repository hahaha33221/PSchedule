/*
 * 우리 소속으로 넣은 일정의 구글 원본이 지금 있는지 — 캘린더를 제대로 읽을 때마다 한꺼번에 판단해 events.src_state 에 적음
 *
 *   ok    원본이 있음 (같은 회차)
 *   moved 원본이 있는데 회차 키가 바뀜 (단발의 시각을 옮겼거나, 반복을 나누어 새 UID 가 된 것) → src_row 가 지금 원본 줄
 *   gone  원본에서 지워짐 (UID 가 없음 · 그 회차를 지움 · 반복이 그 앞에서 끝남)
 *   lost  반복은 있는데 그 회차를 찾지 못함 (옮겼는지 지웠는지 알 수 없음) → 지워짐으로 보이지 않음
 *   out   가져오는 기간 밖이라 알 수 없음 → 지워짐으로 보이지 않음
 *   NULL  아직 판단하지 않음 (캘린더를 지웠거나, 주소를 다른 캘린더로 바꾼 것)
 *
 * 읽기에 실패하면 부르지 않으므로 앞서 판단한 것이 그대로 남음. 일정의 내용은 고치지 않음
 */
export function addEventSourceColumns(db) {
  const has = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c);
  if (!has("events", "src_state")) db.exec("ALTER TABLE events ADD COLUMN src_state TEXT");
  if (!has("events", "src_row")) db.exec("ALTER TABLE events ADD COLUMN src_row INTEGER");
  // 어느 주소의 캘린더에서 왔는지 (calendars.edit_base 와 같은 표시, 주소 자체는 아님)
  if (!has("events", "src_base")) {
    db.exec("ALTER TABLE events ADD COLUMN src_base TEXT");
    db.exec("UPDATE events SET src_base = (SELECT c.edit_base FROM calendars c WHERE c.id = events.src_calendar_id) WHERE src_calendar_id IS NOT NULL");
  }
}

// 'abc_R20261112T050000@google.com' → 'abc@google.com' (구글이 '이 일정과 다음 일정'을 나눌 때 붙이는 꼬리)
export const family = (uid) => String(uid).replace(/_R\d{8}(?:T\d{6}Z?)?(?=@|$)/, "");
// 회차 키의 한국 날짜
export function instDay(inst) {
  const m = /^([DT])(\d{4}-?\d{2}-?\d{2})(T.*)?$/.exec(String(inst || ""));
  if (!m) return null;
  if (m[1] === "D") { const d = m[2].replace(/-/g, ""); return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`; }
  const t = Date.parse(m[2] + (m[3] || ""));
  return Number.isFinite(t) ? new Date(t + 9 * 3600e3).toISOString().slice(0, 10) : null;
}

// 원본 하나 판단. rows: 지금 이 캘린더의 줄 [{ id, uid, inst, recur, start_date }] 을 가족(family)으로 묶은 Map
export function judge(uid, inst, feed, byFamily, range, wasRecurring) {
  const fam = byFamily.get(family(uid)) || [];
  const exact = fam.find((r) => r.uid === uid && r.inst === inst);
  if (exact) return { state: "ok", row: exact.id };
  const uids = feed.families.get(family(uid)) || [];
  if (uids.some((u) => feed.cancelled.has(u + "|" + inst))) return { state: "gone" };
  // 나뉜 반복의 다른 쪽에 같은 회차가 있음
  const twin = fam.filter((r) => r.uid !== uid && r.inst === inst);
  if (twin.length === 1) return { state: "moved", row: twin[0].id };
  const mine = fam.filter((r) => r.uid === uid), recurring = uids.some((u) => feed.recurring.has(u));
  // 단발: 시각·날짜를 옮기면 회차 키가 달라짐 (반복이던 것이 단발이 된 것은 어느 회차인지 몰라 잇지 않음)
  if (!recurring && !wasRecurring && mine.length === 1 && mine[0].recur === 0) return { state: "moved", row: mine[0].id };
  const day = instDay(inst);
  if (!day || day < range.from || day > range.to) return { state: "out" };
  if (!uids.length) return { state: "gone" };
  if (!recurring) {
    // 원본에 있는데 줄이 없으면 가져오는 기간 밖으로 옮긴 것
    if (feed.uids.has(uid) && !mine.length) return { state: "out" };
    return { state: "lost" };
  }
  // 반복: 그 회차 날짜나 그 뒤로 이어지는 회차가 하나도 없으면 그 앞에서 끝난 것
  return { state: fam.some((r) => r.start_date >= day) ? "lost" : "gone" };
}

export function createEventSources(db) {
  const q = {
    copies: db.prepare("SELECT id, src_uid, src_inst, src_state, src_row, src_base FROM events WHERE src_calendar_id = ?"),
    rows: db.prepare("SELECT id, uid, inst, recur, start_date FROM calendar_events WHERE calendar_id = ?"),
    set: db.prepare("UPDATE events SET src_state = ?, src_row = ?, src_base = ? WHERE id = ?"),
    forget: db.prepare("UPDATE events SET src_state = NULL, src_row = NULL, src_base = 'x' WHERE src_calendar_id = ?")
  };
  // 캘린더를 다 바꿔 넣은 뒤 같은 거래 안에서. cal.edit_base: 앞서 읽은 주소 표시, base: 이번 주소 표시, old: 바꾸기 전 줄
  function synced(cal, base, old, feed, range) {
    const copies = q.copies.all(cal.id);
    if (!copies.length) return;
    if (!feed.uids.size) return; // 빈 캘린더는 판단하지 않음
    feed.families = new Map();
    for (const u of feed.uids) { const k = family(u); if (!feed.families.has(k)) feed.families.set(k, []); feed.families.get(k).push(u); }
    const before = new Set(old.map((r) => r.uid)), still = [...before].filter((u) => feed.uids.has(u)).length;
    const alike = before.size > 0 && still >= before.size * 0.5; // 앞서 읽은 것이 절반 넘게 그대로 있음
    const lots = before.size - still > 5 && !alike;              // 한꺼번에 많이 사라짐
    const many = new Map();
    for (const c of copies) many.set(c.src_uid, (many.get(c.src_uid) || new Set()).add(c.src_inst));
    const byFamily = new Map();
    for (const r of q.rows.all(cal.id)) { const k = family(r.uid); if (!byFamily.has(k)) byFamily.set(k, []); byFamily.get(k).push(r); }
    for (const c of copies) {
      const j = judge(c.src_uid, c.src_inst, feed, byFamily, range, many.get(c.src_uid).size > 1);
      // 다른 캘린더일 수 있음: 원본을 실제로 찾은 것만 잇고, 못 찾은 것은 판단하지 않음
      const same = (c.src_base ?? null) === (cal.edit_base ?? null) && (cal.edit_base === base || alike);
      let state = j.state, row = j.row ?? null;
      if (!same && !row) state = null;
      else if (state === "out" && c.src_state === "gone" && !feed.uids.has(c.src_uid)) state = "gone"; // 지워진 것이 기간을 벗어나도 그대로
      else if (state === "gone" && c.src_state !== "gone" && lots) state = c.src_state; // 덜 읽은 것일 수 있어 미룸
      const b = same || row ? base : c.src_base;
      if (state !== c.src_state || row !== c.src_row || b !== c.src_base) q.set.run(state, row, b, c.id);
    }
  }
  return { synced, forget: (calId) => q.forget.run(calId) };
}
