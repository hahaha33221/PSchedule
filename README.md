# PSchedule

팀 업무 관리 웹사이트 (WYD HUB 노션 개선 요청 반영). 회의·일정, 할 일, 메모, 태그를 서로 연결해서 페이지를 오가지 않고 목록·달력 화면에서 바로 보고 고칩니다. 관리자가 멤버 계정을 발급합니다.

- **오늘**: 하루 24시간 타임라인, 오늘의 할 일 (전체 / 회의 관련 / 개인 업무), 빠른 메모 (회의를 고르면 그 회의 메모로 저장)
- **대시보드**: 월간 달력 (회의·일정·할 일), 날짜를 누르면 측면 패널에 그날 회의의 핵심 안건·중요 메모·남은 할 일. 아래에 이번 달 회의를 지난 회의 / 오늘 / 내일 / 앞으로 로 묶어 표시 (전체 / 내 회의 / 참석 회의)
- **측면 패널**: 목록·달력에서 항목을 누르면 오른쪽에 열리고, 닫지 않고 다른 항목을 골라 비교. 회의는 참석자, 개요, 안건, 준비사항, 회의 후 할 일 (담당자·상태), 메모·참고사항, 관련 문서 링크, 댓글을 그 자리에서 고침
- **회의 ↔ 할 일 연결**: 할 일에 '관련 회의'와 구분 (준비사항 / 회의 후 할 일). 메모에서 **할 일로 만들기** 하면 원래 회의에 자동 연결
- **중요 메모**: 별표한 메모는 회의 패널 맨 위와 날짜 패널에 먼저 보임
- **태그**: 팀 공용, 목록·패널에서 바로 붙이고 새로 만들기, 태그 관리 (이름·색)
- **할 일 / 회의 / 메모** 목록 화면, **공지** (관리자 작성, 댓글), **멤버** (관리자: 계정 발급·임시 비밀번호 재발급·직책·권한)
- 고치기는 팀 누구나 (회의록을 함께 채우므로), 지우기는 만든 사람·관리자. 메모는 쓴 사람만 고침
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
