/*
 * DB 자동 백업 — 하루 한 번 BACKUP_DIR 에 'pschedule-YYYY-MM-DD.db' 로 복사하고 오래된 것은 지움
 *
 *   실행 중인 DB 를 그냥 복사하면 깨질 수 있어서 SQLite 의 VACUUM INTO 로 일관된 사본을 만듦
 *   (임시 파일에 먼저 만든 뒤 이름을 바꿔서, 반쯤 만들어진 파일이 백업으로 남지 않게)
 *
 *   환경 변수
 *   - BACKUP_DIR        기본 <DATA_DIR>/backups  (VPS: /opt/pschedule/data/backups)
 *   - BACKUP_KEEP_DAYS  기본 30, 0 이면 자동 백업 끔
 *   - BACKUP_HOUR       기본 4 (한국 시각 이 시 이후 그날 첫 확인 때 백업)
 */
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const NAME = /^pschedule-(\d{4}-\d{2}-\d{2})\.db$/;
const seoulNow = () => new Date(Date.now() + 9 * 3600 * 1000);
const seoulDay = (offsetDays = 0) => new Date(seoulNow().getTime() + offsetDays * 86400 * 1000).toISOString().slice(0, 10);

export function listBackups(dir) {
  try {
    return readdirSync(dir).filter((f) => NAME.test(f)).sort().reverse()
      .map((f) => ({ name: f, size: statSync(join(dir, f)).size, date: f.match(NAME)[1] }));
  } catch { return []; }
}

// 지금 바로 백업 (같은 날 이미 있으면 덮어씀)
export function backupNow(db, dir, day = seoulDay()) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `pschedule-${day}.db`);
  const tmp = file + ".tmp";
  rmSync(tmp, { force: true });
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  renameSync(tmp, file);
  return file;
}

export function pruneBackups(dir, keepDays) {
  const cutoff = seoulDay(-keepDays);
  const removed = [];
  for (const b of listBackups(dir)) {
    if (b.date < cutoff) { rmSync(join(dir, b.name), { force: true }); removed.push(b.name); }
  }
  return removed;
}

export function startAutoBackup(db, { dir, keepDays = 30, hour = 4, log = console.log }) {
  if (!keepDays) return;
  const tick = () => {
    try {
      if (seoulNow().getUTCHours() < hour) return;
      if (listBackups(dir).some((b) => b.date === seoulDay())) return;
      const file = backupNow(db, dir);
      const removed = pruneBackups(dir, keepDays);
      log(`[backup] ${file} 저장${removed.length ? `, 오래된 백업 ${removed.length}개 정리` : ""}`);
    } catch (e) {
      log(`[backup] 실패: ${e.message}`);
    }
  };
  setTimeout(tick, 10_000).unref();
  setInterval(tick, 30 * 60 * 1000).unref();
}
