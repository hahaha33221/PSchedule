// 묵주 교육의 상태는 하나: 예정(plan) · 완료(done) · 연기(delay)
// 저장은 두 곳(관리자 '교육 기록'의 vol_schedules.progress, 팀 봉사자의 team_org_info.status)에 남아 있어서
// 읽을 때는 여기 규칙으로 하나로 보고, 바꿀 때는 setEduStatus 로 양쪽을 같이 씀. 값을 옮기는 이전(migration)은 없음
//   연기가 먼저(연기는 progress 에 없음), 그다음 어느 쪽이든 완료면 완료
export const eduStatus = (progress, teamStatus) => (teamStatus === "delay" ? "delay" : progress === "done" || teamStatus === "done" ? "done" : "plan");
export const EDU_STATUS_SQL = "(CASE WHEN t.status = 'delay' THEN 'delay' WHEN s.progress = 'done' OR t.status = 'done' THEN 'done' ELSE 'plan' END)"; // s = vol_schedules, t = team_org_info (LEFT JOIN)
// 상태만 바꿈: 참석 인원·특이사항·예상 완성 수량·입력자는 건드리지 않음. 완료면 수도회를 '교육 완료'로 (이미 그 다음 단계면 그대로)
export function setEduStatus(db, scheduleId, status) {
  db.prepare("UPDATE vol_schedules SET progress = ? WHERE id = ?").run(status === "done" ? "done" : "planned", scheduleId);
  if (status === "delay") db.prepare("INSERT INTO team_org_info (schedule_id, status) VALUES (?, 'delay') ON CONFLICT(schedule_id) DO UPDATE SET status = 'delay'").run(scheduleId);
  else db.prepare("UPDATE team_org_info SET status = ? WHERE schedule_id = ?").run(status, scheduleId);
  if (status === "done") db.prepare("UPDATE monasteries SET status = 'edu_done', updated_at = datetime('now') WHERE status = 'new' AND id = (SELECT monastery_id FROM vol_schedules WHERE id = ?)").run(scheduleId);
  else dropEduDone(db, db.prepare("SELECT monastery_id AS id FROM vol_schedules WHERE id = ?").get(scheduleId)?.id);
}
// 끝난 교육이 하나도 안 남으면 '교육 완료' → '등록'. 그 밖의 상태(제작 중·문제 있음·회수·검수 완료)는 그대로
export function dropEduDone(db, mid) {
  if (mid) db.prepare(`UPDATE monasteries SET status = 'new', updated_at = datetime('now') WHERE id = ? AND status = 'edu_done'
    AND NOT EXISTS (SELECT 1 FROM vol_schedules s LEFT JOIN team_org_info t ON t.schedule_id = s.id WHERE s.monastery_id = monasteries.id AND ${EDU_STATUS_SQL} = 'done')`).run(mid);
}
