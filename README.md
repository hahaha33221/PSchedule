# PSchedule

팀 업무 관리 웹사이트 (WYD HUB 노션 개선 요청 반영). 회의·일정, 할 일, 메모, 태그를 서로 연결해서 페이지를 오가지 않고 목록·달력 화면에서 바로 보고 고칩니다. 관리자가 멤버 계정을 발급합니다.

- **오늘**: 하루 24시간 타임라인, 오늘의 할 일 (전체 / 회의 관련 / 개인 업무), 빠른 메모 (회의를 고르면 그 회의 메모로 저장)
- **대시보드**: 월간 달력 (회의·일정·할 일), 날짜를 누르면 측면 패널에 그날 회의의 핵심 안건·중요 메모·남은 할 일. 아래에 이번 달 회의를 지난 회의 / 오늘 / 내일 / 앞으로 로 묶어 표시 (전체 / 내 회의 / 참석 회의)
- **대시보드 검색**: 전체 기간에서 안쪽 내용까지 찾음 — 회의·일정(제목, 장소, 개요, 안건, 관련 문서, 댓글, 태그·분류, 참석자), 할 일(제목, 메모, 관련 회의, 담당자, 태그·분류), 메모 본문, 구글 캘린더 일정. 띄어쓰기·영문 대소문자 무시. 결과는 날짜 순서로 묶고 오늘 위치로 이동, 어디서 찾았는지와 찾은 글자를 강조, 회의·일정 / 할 일 / 메모 거르기 (최대 300개)
- **측면 패널**: 목록·달력에서 항목을 누르면 오른쪽에 열리고, 닫지 않고 다른 항목을 골라 비교. 회의는 참석자, 개요, 안건, 준비사항, 회의 후 할 일 (담당자·상태), 메모·참고사항, 관련 문서 링크, 댓글을 그 자리에서 고침
- **회의 ↔ 할 일 연결**: 할 일에 '관련 회의'와 구분 (준비사항 / 회의 후 할 일). 메모에서 **할 일로 만들기** 하면 원래 회의에 자동 연결
- **중요 메모**: 별표한 메모는 회의 패널 맨 위와 날짜 패널에 먼저 보임
- **분류**: 대분류 › 중분류 › 소분류 3단계. 회의·할 일·메모에 하나씩 붙이고 (회의에 연결한 할 일·메모는 회의 분류를 따름), 왼쪽 메뉴 트리에서 누르면 오늘·대시보드·할 일·회의·메모를 그 분류(와 그 아래)로 걸러 봄. 관리자가 분류 관리에서 만들고 이름·순서를 바꾸며, `기획팀 > 행사 > 개막미사` 처럼 여러 줄을 한 번에 넣을 수 있음. 분류를 지우면 붙어 있던 항목은 한 단계 위 분류로 옮겨짐
- **구글 캘린더 가져오기** (읽기 전용, 한 방향): 관리자가 '내 캘린더' 옆 톱니바퀴에서 구글 캘린더의 **비공개 주소(iCal 형식)** 를 등록하면, 서버가 20분마다 읽어서 달력·오늘 화면에 빗금 무늬로 함께 보여 줌. 캘린더 여러 개, 캘린더별 이름·색·분류, 지금 읽기. 반복·종일·시간대(한국 시각으로 변환)·예외·바뀐 회차·취소 반영, 다시 읽을 때 통째로 바꿔서 고친 것·지운 것도 반영. 읽기에 실패하면 이전 일정을 그대로 두고 관리 창에 오류 표시. 비공개 주소는 비밀번호처럼 다룸 (관리자만 등록, 화면에는 `calendar.google.com · …ab12` 처럼 가려서만, 로그·API 응답에 안 나옴, DB 에만 저장)
- **태그**: 팀 공용, 목록·패널에서 바로 붙이고 새로 만들기, 태그 관리 (이름·색)
- **조직도 보기** (모두, 사이드바 '조직도'): PDF 조직도처럼 위원회 → 본부 → 부 카드(가로) → 팀·분과 카드(세로, 분과 안의 팀은 점선 카드). 본부 거르기, '이름까지 / 부서·인원만', 이름·부서 찾기(그 칸으로 이동·강조), 확대·축소·화면에 맞추기. 공석은 흐리게, '나'는 파랑. 이름을 누르면 겸직 자리와 (계정이 연결돼 있으면) 그 사람의 회의·할 일, 부서를 누르면 소속 화면
- **조직도 편집** (관리자 전용): 엑셀과 같은 표 (순번 | 본부 | 부 | 팀·분과 | 직함 | 이름 | PSchedule 계정 | 비고), 칸 바로 고치기, 부별 묶음, 본부 거르기·찾기, 줄 추가, 순번을 끌어서 순서 바꾸기. 부·팀 칸에 새 이름을 적으면 조직이 생김. 엑셀(.xlsx) 불러오기·붙여넣기 → 지금 조직도와 비교한 미리보기(추가·이동·빠짐)를 확인하고 반영 (파일은 브라우저에서 읽고 표 내용만 서버로). 확인할 것(이름 같은 자리, 공석, 계정 미연결, 빈 조직), 부서 구조 트리(끌어서 팀을 분과 아래로), 기준일, CSV 내보내기. 조직은 5단계까지 (위원회 › 본부 › 부 › 분과 › 팀), 같은 이름의 하위 조직 가능 (국제부 › 국제부)
- **조직도 자리와 계정은 따로**: 조직도의 사람(자리)은 PSchedule 계정이 없어도 됨. 계정은 골라서 연결(이름이 같으면 연결 제안), 한 사람이 여러 자리 겸직 가능. 처음 연결하면 그 자리 조직이 멤버의 대표 소속이 됨. 인원 수는 공석 빼고, 한 조직 안에서 같은 사람은 한 번
- **소속**: 멤버마다 조직 하나 (예전 '직책' 칸 대신, 예전 직책 글자는 멤버 '메모'로 옮겨 둠). 참석자·담당자 옆과 계정 메뉴에 소속 약칭. 멤버 관리 표에서 소속 고르기·소속 미지정/관리자 거르기·여러 명 한 번에 바꾸기
- **소속 화면** (모두, 사이드바 '내 소속'·'다른 소속 보기'): 팀원·책임자, 이 팀만/하위 조직 포함, 이번 주 회의·남은 할 일·마감 지난 할 일·중요 메모 숫자, 팀원이 참석하는 회의, 팀원이 맡은 할 일 (담당자별/마감일순), 팀원이 쓴 메모 (중요 먼저). 대시보드·할 일·회의 목록의 '전체 / 우리 소속' 거르기, 참석자 고를 때 소속별로 묶고 '○○ 전체 넣기'
- **관리자 전용은 주황**: 일반 화면은 파랑, 관리자만 할 수 있는 곳은 자물쇠 + '관리자 전용' 이름표, 화면 맨 위 주황 줄, 주황 버튼. 사이드바의 관리자 메뉴(조직도, 멤버·소속 지정, 분류 관리, 구글 캘린더 연결, 백업)는 주황 상자 하나에 모으고 멤버에게는 안 보임. 서버에서도 관리자만 고칠 수 있음
- **할 일 / 회의 / 메모** 목록 화면, **공지** (관리자 작성, 댓글), **멤버** (관리자: 계정 발급·임시 비밀번호 재발급·소속·권한)
- 고치기는 팀 누구나 (회의록을 함께 채우므로), 지우기는 만든 사람·관리자. 메모는 쓴 사람만 고침
- 처음 받은 비밀번호로 로그인하면 비밀번호를 바꿔야 들어갈 수 있음. 로그인은 14일 유지

## 구조

| 위치 | 내용 |
| --- | --- |
| `public/` | 프론트엔드 (빌드 없음, 바닐라 JS) → Vercel |
| `server/` | API (의존성 없음: `node:http` + `node:sqlite`) → VPS Docker |
| `server/admin.mjs` | 서버에서 쓰는 관리자 명령 |
| `server/ical.mjs` | iCal 읽기·반복 일정 펼치기 (외부 라이브러리 없음, `node tools/ical-test.mjs` 로 검사) |
| `server/calendars.mjs` | 구글 캘린더 주기적 동기화 |
| `server/backup.mjs` | 매일 자동 백업 |
| `tools/pull-backups.sh` | VPS 백업을 내 Mac 으로 내려받기 |
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

https://pschedule.vercel.app — Vercel 프로젝트 `pschedule` (GitHub 연결 안 됨, 화면을 고치면 직접 배포). `.vercelignore` 로 `public/` 과 `vercel.json` 만 올라갑니다.

```bash
npx --yes vercel@62 --prod --yes
```

(폴더 이름에 대문자·점이 있어 처음 한 번은 `npx --yes vercel@62 link --yes --project pschedule` 로 연결해야 했어요.)

## 관리자 명령 (VPS)

```bash
ssh root@srv1809055.hstgr.cloud 'cd /opt/pschedule && docker compose exec -T api node --disable-warning=ExperimentalWarning server/admin.mjs list'
```

- `list` — 계정 목록
- `add <아이디> <이름> [admin]` — 계정 발급
- `reset-password <아이디>` — 임시 비밀번호 재발급 (master 비밀번호를 잊었을 때도)
- `backup` — 지금 백업, `backups` — 백업 목록

## 백업

모든 데이터(구글 캘린더 비공개 주소 포함)는 VPS 의 `/opt/pschedule/data/pschedule.db` 한 파일입니다. **백업 파일도 비밀번호처럼** 다뤄 주세요 (공유 폴더에 두지 않기).

### VPS 자동 백업 (설정 필요 없음)

API 서버가 매일 한국 시각 4시 이후 한 번 `/opt/pschedule/data/backups/pschedule-YYYY-MM-DD.db` 를 만들고, 30일 지난 것은 지웁니다. 실행 중인 DB 를 그냥 복사하지 않고 SQLite `VACUUM INTO` 로 일관된 사본을 만듭니다. VPS 의 cron 이나 다른 서비스는 건드리지 않습니다. 멤버 화면 아래 '자동 백업' 카드에서 최근 백업 확인과 '지금 백업'을 할 수 있어요.

바꾸려면 `/opt/pschedule/.env` 에 `BACKUP_KEEP_DAYS=60` (0 이면 끔), `BACKUP_HOUR=3`, `CALENDAR_SYNC_MINUTES=30` 처럼 적고 `docker compose up -d` 하세요.

```bash
ssh root@srv1809055.hstgr.cloud 'cd /opt/pschedule && docker compose exec -T api node --disable-warning=ExperimentalWarning server/admin.mjs backups'
```

### 내 Mac 으로 백업 받기

```bash
bash tools/pull-backups.sh
```

VPS 의 백업 중 아직 없는 것만 `~/PSchedule-backups` 로 받고 (`sqlite3` 로 깨지지 않았는지 검사), 이 Mac 에서는 90일 지난 것을 지웁니다. VPS 에 ssh 키로 비밀번호 없이 접속할 수 있어야 해요.

매일 자동으로 받으려면 (오전 9시 30분, 잠자기 중이었으면 깨어난 뒤):

```bash
mkdir -p ~/PSchedule-backups && cp tools/pull-backups.sh ~/PSchedule-backups/
sed "s#__HOME__#$HOME#g" tools/com.pschedule.pull-backups.plist > ~/Library/LaunchAgents/com.pschedule.pull-backups.plist
launchctl load ~/Library/LaunchAgents/com.pschedule.pull-backups.plist
```

기록은 `~/PSchedule-backups/pull.log`. 끄기: `launchctl unload ~/Library/LaunchAgents/com.pschedule.pull-backups.plist`

### 복구

1. 되돌릴 백업을 고릅니다 (VPS `/opt/pschedule/data/backups/` 또는 Mac `~/PSchedule-backups/`). 먼저 내용을 보고 싶으면 로컬에서 `DATA_DIR` 를 다른 폴더로 두고 그 파일을 `pschedule.db` 로 복사해 `npm run dev` 로 열어 볼 수 있어요.
2. VPS 에서 API 를 멈추고, 지금 DB 를 따로 보관한 뒤 백업으로 바꿉니다.

```bash
ssh root@srv1809055.hstgr.cloud
cd /opt/pschedule
docker compose stop api
mkdir -p data/before-restore && mv data/pschedule.db* data/before-restore/   # 지금 DB (WAL 파일 포함) 보관
cp data/backups/pschedule-2026-11-01.db data/pschedule.db                    # Mac 에서 올릴 땐: scp ~/PSchedule-backups/pschedule-2026-11-01.db root@srv1809055.hstgr.cloud:/opt/pschedule/data/pschedule.db
chown 1000:1000 data/pschedule.db
docker compose start api
docker compose logs --tail 5 api
```

3. 사이트에 로그인해 확인합니다. 로그인 세션도 백업 시점으로 돌아가서 다시 로그인해야 할 수 있어요. 문제가 있으면 `data/before-restore/` 의 파일로 같은 방법으로 되돌리면 됩니다.
