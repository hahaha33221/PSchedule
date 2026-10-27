# PSchedule

팀·모임 일정 공유 웹사이트. 관리자가 멤버 계정을 발급하고, 멤버는 로그인해서 월간 달력으로 일정을 보고 올리며 일정·공지에 댓글을 남깁니다.

- **일정**: 월간 달력, 날짜를 고르면 그날 일정과 다가오는 일정(60일) 표시. 종일/시간/여러 날 일정, 장소·설명·색. 올린 사람과 관리자만 수정·삭제
- **공지**: 관리자가 쓰고(맨 위 고정 가능) 모두 댓글
- **멤버** (관리자): 계정 발급(임시 비밀번호 6자리), 비밀번호 재발급, 이름·권한 수정, 삭제
- 처음 받은 비밀번호로 로그인하면 비밀번호를 바꿔야 들어갈 수 있음. 로그인은 14일 유지

## 구조

| 위치 | 내용 |
| --- | --- |
| `public/` | 프론트엔드 (빌드 없음, 바닐라 JS) → Vercel |
| `server/` | API (의존성 없음: `node:http` + `node:sqlite`) → VPS Docker |
| `server/admin.mjs` | 서버에서 쓰는 관리자 명령 |
| `deploy/` | VPS 설치 스크립트, nginx 사이트 설정 |

Vercel 이 `/api/*` 를 VPS 의 `https://pschedule.31-97-71-87.sslip.io/api/*` 로 넘깁니다 (`vercel.json`).

## 로컬 개발

Node 22.13 이상.

```bash
ADMIN_PASSWORD=원하는비번 npm run dev
```

http://localhost:5179 — 처음 실행하면 `master` 관리자 계정이 만들어집니다 (`ADMIN_PASSWORD` 를 안 주면 임시 비밀번호가 터미널에 나옴). DB 는 `data/pschedule.db` (커밋 안 됨).

## 배포

### API (VPS, 처음 한 번)

도란도란과 같은 Hostinger VPS 를 씁니다. 폴더 `/opt/pschedule`, 컨테이너 `pschedule-api`, 포트 `127.0.0.1:18807`, 전용 nginx 사이트 `pschedule` 로 다른 서비스와 분리됩니다.

```bash
ssh root@srv1809055.hstgr.cloud 'bash -s' < deploy/setup-vps.sh pschedule.31-97-71-87.sslip.io
```

첫 실행 로그에 나온 `master` 임시 비밀번호로 로그인해 비밀번호를 바꾸세요. 다시 보려면:

```bash
ssh root@srv1809055.hstgr.cloud 'cd /opt/pschedule && docker compose logs api | grep 관리자'
```

이후 `main` 에 푸시하면 GitHub Actions 가 검사 후 자동 배포합니다. 저장소 시크릿 `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` (도란도란과 같은 값) 가 필요합니다.

### 프론트 (Vercel)

```bash
npx --yes vercel@62 --prod --yes
```

## 관리자 명령 (VPS)

```bash
ssh root@srv1809055.hstgr.cloud 'cd /opt/pschedule && docker compose exec -T api node --disable-warning=ExperimentalWarning server/admin.mjs list'
```

- `list` — 계정 목록
- `add <아이디> <이름> [admin]` — 계정 발급
- `reset-password <아이디>` — 임시 비밀번호 재발급 (master 비밀번호를 잊었을 때도)

## 백업

모든 데이터는 VPS 의 `/opt/pschedule/data/pschedule.db` 한 파일입니다.

```bash
scp root@srv1809055.hstgr.cloud:/opt/pschedule/data/pschedule.db ./pschedule-backup.db
```
