// 묵주 교육의 상태는 하나: 예정(plan) · 완료(done) · 연기(delay)
// 저장은 두 곳(관리자 '교육 기록'의 vol_schedules.progress, 팀 봉사자의 team_org_info.status)에 남아 있어서
// 읽을 때는 여기 규칙으로 하나로 보고, 바꿀 때는 setEduStatus 로 양쪽을 같이 씀. 값을 옮기는 이전(migration)은 없음
//   연기가 먼저(연기는 progress 에 없음), 그다음 어느 쪽이든 완료면 완료
import { actor } from "./ctx.mjs";

export const eduStatus = (progress, teamStatus) => (teamStatus === "delay" ? "delay" : progress === "done" || teamStatus === "done" ? "done" : "plan");
export const EDU_STATUS_SQL = "(CASE WHEN t.status = 'delay' THEN 'delay' WHEN s.progress = 'done' OR t.status = 'done' THEN 'done' ELSE 'plan' END)"; // s = vol_schedules, t = team_org_info (LEFT JOIN)
export const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

// 수도회 진행 상태 바꾸기: from 을 주면 그 상태일 때만. 바뀌면 언제·누가·무엇으로를 이력에 남김 (요청 밖이면 '자동')
export function setMonStatus(db, id, to, from = null, reason = "") {
  const m = id ? db.prepare("SELECT id, status FROM monasteries WHERE id = ?").get(id) : null;
  if (!m || m.status === to || (from && !from.includes(m.status))) return false;
  db.prepare("UPDATE monasteries SET status = ?, updated_at = datetime('now') WHERE id = ?").run(to, m.id);
  logMonStatus(db, m.id, m.status, to, reason);
  return true;
}
export function logMonStatus(db, id, from, to, reason = "") {
  const u = actor();
  db.prepare("INSERT INTO monastery_status_log (monastery_id, from_status, to_status, reason, actor_id, actor_name) VALUES (?, ?, ?, ?, ?, ?)").run(id, from, to, reason, u?.id ?? null, u?.name || "자동");
}

// 상태만 바꿈: 참석 인원·특이사항·예상 완성 수량·입력자는 건드리지 않음. 완료면 수도회를 '교육 완료'로 (이미 그 다음 단계면 그대로)
// 사람이 완료를 예정으로 되돌린 교육(auto_skip)은 날짜가 지나도 수도회를 자동으로 '교육 완료'로 올리지 않음
export function setEduStatus(db, scheduleId, status) {
  const s = db.prepare("SELECT s.monastery_id AS mid, s.progress, t.status FROM vol_schedules s LEFT JOIN team_org_info t ON t.schedule_id = s.id WHERE s.id = ?").get(scheduleId);
  const was = s ? eduStatus(s.progress, s.status) : "plan";
  db.prepare("UPDATE vol_schedules SET progress = ?, auto_skip = ? WHERE id = ?").run(status === "done" ? "done" : "planned", status === "plan" && was === "done" ? 1 : 0, scheduleId);
  if (status === "delay") db.prepare("INSERT INTO team_org_info (schedule_id, status) VALUES (?, 'delay') ON CONFLICT(schedule_id) DO UPDATE SET status = 'delay'").run(scheduleId);
  else db.prepare("UPDATE team_org_info SET status = ? WHERE schedule_id = ?").run(status, scheduleId);
  if (status === "done") setMonStatus(db, s?.mid, "edu_done", ["new"], "교육 완료");
  else dropEduDone(db, s?.mid);
}
// 날짜가 지나 저절로 '교육 완료'로 볼 교육: 달력 미정·연기·사람이 예정으로 되돌린 교육은 뺌
const AUTO_DONE_SQL = "(s.project_item_id IS NOT NULL AND s.table_only = 0 AND s.auto_skip = 0 AND s.date < ? AND coalesce(t.status, '') <> 'delay')";
// 끝난 교육(저절로 완료로 볼 교육 포함)이 하나도 안 남으면 '교육 완료' → '등록'. 그 밖의 상태(제작 중·문제 있음·회수·검수 완료)는 그대로
export function dropEduDone(db, mid) {
  if (mid && !db.prepare(`SELECT 1 FROM vol_schedules s LEFT JOIN team_org_info t ON t.schedule_id = s.id WHERE s.monastery_id = ? AND (${EDU_STATUS_SQL} = 'done' OR ${AUTO_DONE_SQL}) LIMIT 1`).get(mid, kstToday())) setMonStatus(db, mid, "new", ["edu_done"], "끝난 교육이 없음");
}
// 시간마다: '등록'인 수도회 중 교육 날짜가 지난 곳을 '교육 완료'로 (교육 자체의 상태는 바꾸지 않음)
export function autoEduDone(db) {
  const t = kstToday();
  const ids = db.prepare(`SELECT DISTINCT m.id FROM monasteries m JOIN vol_schedules s ON s.monastery_id = m.id LEFT JOIN team_org_info t ON t.schedule_id = s.id WHERE m.status = 'new' AND ${AUTO_DONE_SQL}`).all(t).map((x) => x.id);
  for (const id of ids) setMonStatus(db, id, "edu_done", ["new"], "교육 날짜가 지남");
  return ids;
}
