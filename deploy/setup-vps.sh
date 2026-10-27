#!/usr/bin/env bash
# PSchedule API — VPS 최초 설정 (도란도란 등 다른 서비스와 같은 서버에서 겹치지 않게)
#
#   점검만:  ssh root@<VPS> 'bash -s' < deploy/setup-vps.sh <호스트명> --check
#   설치:    ssh root@<VPS> 'bash -s' < deploy/setup-vps.sh <호스트명> [--port N]
#
#   이 스크립트가 만드는/쓰는 것 (다른 서비스와 분리)
#     폴더 /opt/pschedule, 컨테이너 pschedule-api, 네트워크 pschedule, 포트 127.0.0.1:<API_PORT>
#     /etc/nginx/sites-available/pschedule, 인증서 /etc/letsencrypt/live/<호스트>
#     다른 사이트 설정 파일은 건드리지 않습니다.
set -euo pipefail

HOST="${1:-}"
[ -n "$HOST" ] && [ "${HOST#--}" = "$HOST" ] || { echo "사용법: setup-vps.sh <호스트명> [--port N] [--check]"; exit 1; }
shift
API_PORT=18807; CHECK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --port) API_PORT="$2"; shift 2 ;;
    --check) CHECK=1; shift ;;
    *) echo "알 수 없는 옵션: $1"; exit 1 ;;
  esac
done

APP_DIR=/opt/pschedule
REPO=https://github.com/hahaha33221/PSchedule.git
SITE=/etc/nginx/sites-available/pschedule

echo "━━━ 서버 점검 ━━━"
if ss -ltnH "( sport = :$API_PORT )" | grep -q . && ! docker ps --format '{{.Names}}' | grep -qx pschedule-api; then
  echo "✖ 포트 $API_PORT 를 다른 서비스가 쓰고 있어요 → --port 로 다른 포트를 지정하세요"
  exit 1
fi
echo "· 포트 $API_PORT (PSchedule API용): 사용 가능"
command -v docker >/dev/null || { echo "✖ docker 가 없어요"; exit 1; }
command -v nginx >/dev/null || { echo "✖ nginx 가 없어요"; exit 1; }
[ "$CHECK" = 1 ] && { echo "(점검만 했어요. 바뀐 것은 없어요)"; exit 0; }

echo "━━━ 설치 ━━━"
[ -d "$APP_DIR/.git" ] || git clone "$REPO" "$APP_DIR"
cd "$APP_DIR"
git pull --ff-only
[ -f .env ] || echo "API_PORT=$API_PORT" > .env
mkdir -p data
chown -R 1000:1000 data # 컨테이너의 node 사용자(uid 1000)

docker compose up -d --build
sleep 3
curl -fs "http://127.0.0.1:$API_PORT/api/health" >/dev/null && echo "✔ API 실행 중 (127.0.0.1:$API_PORT)"
docker compose logs api | grep -m1 "관리자 계정" || true

if [ -f "$SITE" ]; then
  # 이미 있으면(certbot 이 HTTPS 를 추가했을 수 있음) 포트만 맞춤
  sed -i -E "s#proxy_pass http://127\.0\.0\.1:[0-9]+/api/;#proxy_pass http://127.0.0.1:$API_PORT/api/;#" "$SITE"
else
  sed -e "s/__HOST__/$HOST/g" -e "s/__PORT__/$API_PORT/g" deploy/nginx-site.conf > "$SITE"
  ln -sf "$SITE" /etc/nginx/sites-enabled/pschedule
  echo "· nginx: pschedule 사이트 생성 ($HOST)"
fi
if nginx -t 2>/dev/null; then
  systemctl reload nginx
else
  nginx -t || true
  rm -f /etc/nginx/sites-enabled/pschedule
  echo "✖ nginx 설정 검사 실패 → pschedule 사이트를 비활성화했어요 (다른 사이트 영향 없음)"
  exit 1
fi
if [ ! -d "/etc/letsencrypt/live/$HOST" ] && command -v certbot >/dev/null 2>&1; then
  echo "▶ HTTPS 인증서 발급 ($HOST)"
  certbot --nginx -d "$HOST" --non-interactive --agree-tos --redirect --register-unsafely-without-email \
    || echo "✖ 인증서 발급 실패 — DNS($HOST → 이 서버)를 확인한 뒤 다시 실행하세요"
fi

echo
echo "확인: curl https://$HOST/api/health  →  {\"ok\":true}"
