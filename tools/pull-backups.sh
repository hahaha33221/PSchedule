#!/usr/bin/env bash
# VPS 의 PSchedule 백업을 이 Mac 으로 내려받기
#
#   bash tools/pull-backups.sh
#
#   - VPS 의 /opt/pschedule/data/backups/pschedule-YYYY-MM-DD.db 중 아직 없는 것만 받음 (읽기만, VPS 에서는 아무것도 바꾸지 않음)
#   - 받은 파일이 정상 SQLite 인지 검사하고, 깨졌으면 지움
#   - 이 Mac 에서는 KEEP_DAYS(기본 90일) 지난 것을 정리
#
#   바꾸고 싶으면 환경 변수로:
#     PSCHEDULE_VPS=root@srv1809055.hstgr.cloud  PSCHEDULE_BACKUP_DIR=~/PSchedule-backups  PSCHEDULE_KEEP_DAYS=90
#
#   ※ 백업에는 일정·메모와 구글 캘린더 비공개 주소가 들어 있어요. 공유 폴더(iCloud 공유, Dropbox 공유 등)에 두지 마세요.
set -euo pipefail

VPS="${PSCHEDULE_VPS:-root@srv1809055.hstgr.cloud}"
DEST="${PSCHEDULE_BACKUP_DIR:-$HOME/PSchedule-backups}"
KEEP_DAYS="${PSCHEDULE_KEEP_DAYS:-90}"
REMOTE_DIR=/opt/pschedule/data/backups
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=20)

mkdir -p "$DEST"
chmod 700 "$DEST"

echo "[$(date '+%F %T')] $VPS 에서 백업 목록 확인"
remote=$("${SSH[@]}" "$VPS" "ls -1 $REMOTE_DIR 2>/dev/null | grep -E '^pschedule-[0-9]{4}-[0-9]{2}-[0-9]{2}\.db$'" || true)
if [ -z "$remote" ]; then
  echo "VPS 에 백업이 아직 없어요 ($REMOTE_DIR)."
  exit 1
fi

today=$(TZ=Asia/Seoul date +%F)
got=0
for f in $remote; do
  # 오늘 것은 하루 중 다시 만들어질 수 있어 늘 새로 받음
  if [ -f "$DEST/$f" ] && [ "$f" != "pschedule-$today.db" ]; then continue; fi
  scp -q -o BatchMode=yes -o ConnectTimeout=20 "$VPS:$REMOTE_DIR/$f" "$DEST/$f.part"
  if command -v sqlite3 >/dev/null && [ "$(sqlite3 "$DEST/$f.part" 'PRAGMA integrity_check;' 2>/dev/null)" != "ok" ]; then
    echo "✖ $f 검사 실패 → 지움"
    rm -f "$DEST/$f.part"
    continue
  fi
  mv "$DEST/$f.part" "$DEST/$f"
  chmod 600 "$DEST/$f"
  got=$((got + 1))
done

find "$DEST" -name 'pschedule-*.db' -type f -mtime +"$KEEP_DAYS" -print -delete | sed 's/^/정리: /' || true
echo "✔ 새로 받은 백업 ${got}개 · 보관 중 $(ls -1 "$DEST" | grep -c '^pschedule-.*\.db$')개 → $DEST"
