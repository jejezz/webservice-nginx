# websocket-relay

WebRTC 시그널링과 IoT 기기 메시지를 중계하는 WebSocket 릴레이입니다.
인터폰·도어벨이 방문자 호출을 보내면 같은 방(room)에 있는 모바일 단말로
시그널을 넘기고, 단말이 접속해 있지 않으면 FCM 푸시로 깨웁니다.
Kamailio 가 받은 SIP 착신도 `/sip-push` 로 받아 같은 방식으로 깨웁니다.

nginx 뒤 `/relay/` 에 붙습니다. 라우팅 선언은 [nginx-conf/service.ini](nginx-conf/service.ini),
프로세스 정의는 [pm2-conf/app.ini](pm2-conf/app.ini) 에 있습니다.

> **통합 이력** — 이 서비스는 `rtc-relay-server` 와 `websocket-relay-gateway`
> 두 코드베이스를 합친 것입니다. 서버 기능은 `rtc-relay-server` 쪽이 상위집합
> (`/sip-push`·단지 ID·세션 인증)이라 그쪽을 기준으로 두고,
> `websocket-relay-gateway` 의 구조(설정 단일화·부팅 분리·운영 스크립트)를
> 가져왔습니다. **대시보드는 어느 쪽도 상위집합이 아니어서** 양쪽 기능을 모아
> 한 벌로 다시 맞췄습니다 (아래 '관리 대시보드').
> 옛 저장소는 더 이상 쓰지 않습니다.

## 공개 주소

| 주소 | 쓰는 쪽 |
|---|---|
| `wss://<호스트>/relay/rtc` | 인터폰·모바일 (RTC 시그널링) |
| `wss://<호스트>/relay/iot` | 홈넷 IoT 기기 |
| `https://<호스트>/relay/register` · `/unregister` | 단말 등록 |
| `https://<호스트>/relay/room` | 방 초대 / 푸시 발송 |
| `https://<호스트>/relay/status/rooms` | 방 상태 조회 (Android 클라이언트) |
| `https://<호스트>/relay/dashboard` | 관리 대시보드 (manager 로그인 필요) |
| `https://<호스트>/relay/tests` | 옛 주소 — 대시보드의 '연결 테스트' 로 넘어갑니다 |
| `https://<호스트>/relay/health` | manager 대시보드 |

**nginx 는 접두사를 잘라내지 않습니다.** 원본 URI 가 그대로 백엔드에 도착하고,
앱은 라우터를 루트(`/`)와 접두사(`/relay`) 양쪽에 붙여 둘 다 받습니다.
이것은 의도된 설계입니다 — 아래 세 경로가 여기에 기대고 있습니다.

| 내부 전용 경로 | 부르는 쪽 | 왜 nginx 로 노출되지 않는가 |
|---|---|---|
| `/sip-push` | Kamailio (같은 호스트) | 노출되면 외부에서 남의 단말을 임의로 깨울 수 있습니다 |
| `/mobile-crud-operation` | 내부 도구 | 단말 등록을 임의로 만들고 지울 수 있습니다 |
| `/user` | 내부 도구 | 등록된 주민 전원의 이메일·주소·전화번호 목록입니다 |

이 셋은 **앱에만** 붙어 있어 `/relay/...` 로는 404 입니다. IP 검사만으로는
부족한데, nginx 를 거친 요청은 소켓 주소가 늘 `127.0.0.1` 이라 사설망 검사를
무조건 통과하기 때문입니다. 자세한 것은 [src/app.ts](src/app.ts) 주석에 있습니다.

## 관리 대시보드

`/relay/dashboard` 한 곳입니다. manager 로그인 세션으로 들어가며, 이 서비스는
계정을 따로 두지 않고 검증만 합니다.

| 탭 | 하는 일 |
|---|---|
| 개요 | 방·연결 수, DB·푸시 상태, 이 서버의 단지 |
| 방 | 활성 방과 접속 클라이언트. 정원 초과·홈넷 없음 같은 이상을 경고로 올립니다 |
| 모바일 단말 | **승인 대기 처리**, 동/호 필터, 통화·제어 권한 토글, 추가·수정·삭제. 단지 ID 불일치·SIP 내선 없음·푸시 실패를 눈에 보이게 합니다 |
| 홈넷 장치 | 등록된 월패드 목록과 **추가·삭제**. 월패드가 붙기 전에 세대를 열어 둘 때 씁니다 |
| 푸시 키 | FCM 서비스 계정 키 올리기·검증·내리기 (아래) |
| 연결 테스트 | 브라우저에서 `/relay/rtc`·`/relay/iot` 에 직접 붙어 봅니다 |

통합 전에는 두 대시보드가 각각 반쪽씩 갖고 있었습니다 — 추가·수정 폼과 연결
테스트는 무번들 쪽에만, 홈넷 화면과 단지·푸시 진단은 React 쪽에만 있었습니다.
여기 한 벌로 모았습니다.

'연결 테스트' 는 **이 화면이 열린 주소로** 접속하므로 nginx 프록시 경로까지
함께 확인됩니다 — 서버에서 `127.0.0.1:28099` 로 찔러 보는 것으로는 알 수 없는
부분입니다. 예전 `/tests`(`public/echo_client.html`)는 `/relay/iot` 이 하드코딩돼
있어 RTC 경로를 볼 수 없었고, 이 탭이 대신합니다.

단말 생성·수정 규칙은 [src/libs/mobileRecord.ts](src/libs/mobileRecord.ts) 한
곳에 있고 대시보드 API 와 내부 `/mobile-crud-operation` 이 **같은 모듈**을
부릅니다. 두 벌로 두면 `sip_user` 형식이나 토큰 뒷정리가 조용히 갈라집니다.

### 들어가는 길은 manager 하나뿐입니다

대시보드는 **nginx 접두사 아래에만** 붙어 있습니다 (`app.ts` 의
`createDashboardRouter`). 포트로 직접 들어온 `/dashboard` 는 404 입니다 —
공용 라우터에 두면 nginx 를 거치지 않는 입구가 하나 더 생기기 때문입니다.

인증은 경로가 아니라 **세션**이 합니다. manager 가 발급한 `manager_session`
쿠키를 공유 시크릿(`services/.session-secret`)으로 검증하며, 이 서비스는
계정을 두지 않습니다.

| | 동작 |
|---|---|
| 페이지 · 정적 에셋 | 세션 없으면 `/manager/login?next=…` 으로 302 |
| API | 세션 없으면 `401` + `loginUrl`, `Cache-Control: no-store` |
| 만료된 토큰 | 거부 (`exp` 를 요청마다 확인) |
| manager 관리자 콘솔(super) 토큰 | **거부** — manager 자신의 `verify()` 와 같은 규약입니다 |

에셋에도 세션을 요구합니다. "데이터가 없는 JS/CSS" 라 열어 뒀었는데, 그러면
로그인하지 않은 사람도 번들을 받아 어떤 API 가 어떤 모양으로 있는지 읽을 수
있습니다. 데이터가 없다는 것과 알려 줄 것이 없다는 것은 다릅니다.

화면 오른쪽 위에 **남은 세션 시간**이 뜨고 5분 전부터 경고합니다. 만료되면
다음 요청을 기다리지 않고 로그인으로 넘깁니다. 401 은 조회·저장·삭제를 가리지
않고 `api.js` 의 `request()` 한 곳에서 처리합니다 — 예전에는 조회에만 있어서
저장을 누르는 순간 만료되면 빨간 줄만 뜨고 그 자리에 머물렀습니다.

### 단말 등록 — 월패드가 인정해야 들어온다

`/register/mobile` 은 등록을 **받아 두기만** 한다. 아무 권한이 없다.

```
등록 요청  →  mobile_enrollments (대기, 30분)   전화도 제어도 안 됨
승인       →  rtc_mobiles 로 이동               can_call / can_control 이 켜진다
```

**왜 이렇게 바꿨는가.** 예전에는 `/register/mobile` 이 uuid·email·complex·
address·token 만 받고 곧바로 `rtc_mobiles` 에 넣었다. 인증도 횟수 제한도 없어서
**단지 + 동 + 호 세 값만 알면 그 집 초인종 영상·음성을 받고 방문자와 대화까지
됐다.** 셋 중 비밀은 하나도 없다 — 단지 ID 는 공개 디렉터리에 있고 동/호는
건물에 적혀 있다. 그 집 안에 물리적으로 있는 것은 **월패드뿐**이라, 신뢰의
뿌리를 거기로 옮겼다.

| 겹 | 무엇 |
|---|---|
| 주소 형식 | `1B101U` 가 아니면 거부 ([libs/address.ts](src/libs/address.ts)) |
| 월패드 존재 | `rtc_homenet` 에 그 동/호가 없으면 거부 |
| 세대당 4대 | 승인된 단말 기준. 넘으면 대기에 올리지도 않는다 |
| 대기 4건 | 넘치면 **거절이 아니라 가장 오래된 것을 밀어낸다** |
| 승인 | 월패드(WebSocket) 또는 관리자(대시보드) |

승인·거절·만료는 요청한 단말에 **FCM 으로 통보**됩니다 (`enroll.approved` /
`enroll.rejected` / `enroll.expired`). 이게 없으면 앱은 202 를 받은 뒤 아무 일도
일어나지 않는 것처럼 보입니다. 같은 세대의 기존 단말에는 새 요청이 들어올 때
`enroll.pending` 이 갑니다.

'월패드 존재' 검사는 **거주 증명이 아니다.** 실재하는 집은 전부 월패드가
등록돼 있으니 동/호를 아는 공격자는 그냥 통과한다. 여기서 얻는 것은 **용량
상한**이다 — 표 크기가 실제 세대 수에 묶인다. 실제 방어는 '승인 없이는 아무
권한 없음' 이 한다.

대기 슬롯이 넘칠 때 **밀어내는** 이유: 거절로 두면 공격자가 슬롯을 채워 진짜
주민의 등록을 막을 수 있다. 축출 방식이면 방금 들어온 요청이 늘 최신이라 살아남는다.

#### 월패드가 쓰는 것 (IoT WebSocket)

```
서버 → 월패드   enroll.pending   등록 요청이 들어왔다 (목록 포함)
                enroll.list      접속 직후, 놓친 대기가 있으면
월패드 → 서버   enroll.list      목록을 다시 달라
                enroll.approve   { enrollmentId, canCall, canControl }
                enroll.reject    { enrollmentId }
```

월패드가 꺼져 있어 이벤트를 놓쳐도 괜찮다 — **진실은 DB 의 대기 표에 있고**,
다시 접속할 때 받아 간다. 이벤트를 큐에 쌓아 두지 않는 이유가 이것이다.

승인 권한의 근거는 "IoT 방을 만든 쪽(initiator)" 이다. 방을 만들려면 RoomID 를
알아야 하고 RoomID 는 그 집 월패드 화면에만 있다. 즉 **기존 제어 권한과 같은
경계**를 승인에도 쓴다. 강한 인증은 아니다 — 제대로 하려면 월패드에 클라이언트
인증서를 발급해야 한다 (`nginx/cert/` 에 기반이 있다).

#### 두 권한은 축이 다르다

| 컬럼 | 누가 정하나 | 뜻 |
|---|---|---|
| `active` | **기계** | FCM 토큰이 살아 있는가. 무효 토큰이면 자동 0 |
| `can_call` | **사람** | 초인종·전화를 이 단말로 보낼 것인가 |
| `can_control` | **사람** | 홈넷을 제어하게 할 것인가 |

`active` 를 권한으로 재사용하지 않았다. 그랬다면 FCM 실패 한 번에 권한이
사라지고 재등록으로 되살아난다 — 승인이라는 말의 뜻이 없어진다.

`can_call` 은 푸시 조회 **네 곳 전부**에 걸려 있다 (초인종 · `/room/invite` ·
`/sip-push` · 등록 알림).

`can_control` 은 **세대 단위로만** 강제된다. WebSocket 메시지에 단말 식별자가
없어 "이 소켓이 어느 등록 행인가" 를 서버가 알 수 없기 때문이다. 그래서
'제어를 아무에게도 허용하지 않은 세대' 는 막지만, 같은 세대 안에서 단말 하나만
골라 막지는 못한다. 단말 단위 강제는 핸드셰이크가 uuid 를 실어 와야 가능하다.

### 단지 ID

`/relay/dashboard` 개요 화면에서 보고 바꿉니다.

**이 값은 비밀이 아닙니다.** 앱이 Firestore 단지 디렉터리에서 공개로 받아 오는
라우팅 키입니다 (`allow read: if true` — [docs/multi-complex.md](docs/multi-complex.md)).
게다가 `/register` 는 앱이 이 필드를 **안 보내면 서버 값으로 채우고 통과**시킵니다
([routes/register.ts](src/routes/register.ts)). 즉 값을 가려도 막히는 것이 없습니다.
"이 사람이 그 집 사람인가" 를 가리려면 별도의 1회용 등록 토큰이 필요하고, 그건
아직 없습니다.

그래서 **읽기는 열어 두고 쓰기만 조입니다.** 위험한 것은 바꾸는 쪽입니다 —
바뀌는 순간 등록된 단말의 `complex_id` 와 어긋나 그 단말들이 착신 대상 조회에서
통째로 빠지고, 각자 앱을 열어 다시 등록하기 전까지 전화를 받지 못합니다.

| 겹 | 무엇 |
|---|---|
| 영향 미리보기 | "등록된 N대가 즉시 착신 불가가 됩니다" + 열려 있는 연결 수 |
| 재입력 확인 | 새 ID 를 두 번 입력해야 버튼이 열립니다 (오타 하나가 단지 전체를 끊습니다) |
| 비밀번호 재확인 | **서버가** manager 의 `/verify-password` 에 물어봅니다 |
| 감사 로그 | `[audit] 단지 ID 변경: 이전 → 이후 (by 사용자)` |
| 즉시 반영 | 재시작 없이 적용되고 `.env` 에도 기록됩니다 |

비밀번호 확인을 **서버가** 하는 것이 핵심입니다. 화면에서 확인하고 통과하면
API 를 부르는 방식은 아무것도 막지 못합니다 — 세션만 있으면 그 단계를 건너뛰고
API 를 바로 부르면 되기 때문입니다 ([src/auth/reauth.ts](src/auth/reauth.ts)).
manager 가 닿지 않으면 **통과시키지 않습니다.** 확인할 수 없는 것은 확인되지
않은 것이고, 열어 주면 manager 를 죽이는 것이 곧 이 검사를 없애는 방법이 됩니다.

등록된 단말이 있어도 변경 자체를 막지는 않습니다. 단지 ID 를 정말 바꿔야 하는
상황(재발급·오설정 정정)이 있고, 화면에서 못 고치면 사람이 `.env` 를 직접
고치게 되는데 그러면 위 검사들이 전부 무의미해집니다.

> `COMPLEX_ID` 는 [libs/complex.ts](src/libs/complex.ts) 의 `complexId()` 로만
> 꺼냅니다. 예전처럼 `export const` 로 두면 import 한 모듈들이 **로드 시점의
> 값을 각자 복사**해, 바꿔도 `register.ts` 는 옛 값으로 검사합니다. 그 어긋남은
> "등록은 되는데 전화가 안 온다" 로만 드러납니다.

### 푸시 키 (FCM)

`Firebase 콘솔 → 프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성` 으로 받은
JSON 을 대시보드에서 바로 올립니다. **서비스를 재시작하지 않습니다** — 재시작은
프로세스 메모리에 있는 방을 전부 날려 통화 중인 사람이 끊깁니다.

이 키를 잘못 올리면 **조용히** 망가집니다. 서비스는 정상으로 뜨고 대시보드도
초록색이고 방도 열리는데, 초인종을 눌러도 자고 있는 집의 전화만 울리지 않습니다.
주민이 민원을 넣어야 알게 됩니다. 그래서 쓰기 **전에** 판단할 수 있는 것을
전부 판단해 보여 주고(`POST /firebase/analyze` — 파일을 건드리지 않습니다),
사람이 읽은 뒤에 적용합니다.

| 무엇을 보나 | 왜 |
|---|---|
| 서버용 키가 맞는가 | 웹 SDK 설정(`apiKey`…)을 올리는 실수가 가장 흔합니다 |
| `private_key` 가 PEM 인가 | 편집기로 열어 줄바꿈이 깨지면 서명이 실패합니다 |
| **프로젝트가 바뀌는가** | FCM 토큰은 프로젝트에 묶여 있어, 바뀌면 등록된 단말이 **전부** 무효가 됩니다. 영향받는 대수를 함께 보여 줍니다 |
| 같은 키인가 | 같으면 적용 버튼이 비활성입니다 |
| 실제로 통하는가 | Google 에 토큰을 한 번 받아 봅니다 — 계정 삭제·키 회수·서버 시계 어긋남·망 차단은 파일만 봐서는 알 수 없습니다 |
| 파일 권한 | `600` 이 아니면 경고합니다 |

덮어쓰기 전에 항상 `secrets/firebase-admin.<시각>.bak.json` 으로 백업합니다.
'키 내리기' 도 지우기 전에 백업하며, 내려도 WebSocket 중계는 계속 동작합니다.

## 구조

```
src/
├── index.ts      부팅 순서만 잡는다 (설정 → DB → HTTP → WebSocket → 종료)
├── config.ts     환경 변수를 읽는 단 한 곳
├── app.ts        Express 라우트 조립. 공개/내부 경로의 경계가 여기 있다
├── gateway.ts    실행 상태(roomTable·서버 핸들)를 담는 객체
├── health.ts     /health — ../../docs/health-contract.md 규약
├── auth/         manager 세션 쿠키 검증 (계정은 manager 가 관리한다)
├── http/         대시보드 전용 API (로그인 필요)
├── libs/         릴레이 본체. websocketService.ts 가 /rtc·/iot 연결을 받는다
│                 rtcRoom·rtcClient·rtcRoomTable · push(FCM) · complex(단지)
│                 firebaseAdmin(재적재 가능) · firebaseKey(키 분석·설치)
└── routes/       REST 엔드포인트 (sipPush 포함)

schema/           이 서비스가 소유하는 SQL. database/database.ini 가 가리킨다
scripts/          설치·진단·마이그레이션 (아래 '명령')
web/              관리 대시보드 (React + Vite). 빌드 결과는 web/dist
tools/            디렉터리 등록·FCM 시험용 일회성 도구
```

방 상태는 프로세스 메모리에 있습니다. **인스턴스를 늘리면 안 됩니다** —
클라이언트마다 다른 방 테이블을 보게 됩니다. pm2 에서 `instances: 1` 고정입니다.

## 명령

| 명령 | 하는 일 |
|---|---|
| `npm run setup` | 처음부터 끝까지. 여러 번 돌려도 안전합니다 |
| `npm run doctor` | 고치지 않고 상태만 점검. 문제마다 해결 명령을 붙여 줍니다 |
| `npm run db:migrate` | `schema/*.sql` 중 아직 적용되지 않은 것을 적용 |
| `npm run db:status` | 마이그레이션·표별 행 수·인덱스·최근 등록 |
| `npm run web:build` | 관리 대시보드 빌드 (`web/dist`) |
| `npm run dev` | 소스 감시하며 실행 |
| `npm run typecheck` | `src/` 와 `scripts/` 타입 검사 |
| `npm start` / `restart` / `stop` / `logs` | pm2 |
| `npm run nginx:check` | 라우팅 선언 검사 (충돌 확인) |
| `npm run nginx:apply` | nginx 반영 (sudo) |

## 처음 올릴 때

```bash
npm install                                  # 1. 의존성
sudo ../../database/setup_mariadb.sh         # 2. DB·계정 (database.ini 가 선언)
npm run setup                                # 3. .env → 대시보드 빌드 → 스키마 → pm2
npm run nginx:apply                          # 4. nginx 반영 (최초 1회, 라우팅 변경 시)
npm run doctor                               # 5. 점검
```

**DB 와 계정은 이 서비스가 만들지 않습니다.** `database/database.ini` 가
선언하고 `sudo database/setup_mariadb.sh` 가 적용합니다 — 계정과 권한을 정하는
곳이 둘이 되면 어느 쪽이 진짜인지 알 수 없게 됩니다. 이 서비스가 소유하는 것은
`schema/*.sql` 뿐이고, `npm run db:migrate` 가 그것을 적용합니다.

**서버는 런타임에 표를 만들지 않습니다.** 부팅 때마다 DDL 을 돌리면 스키마의
실제 상태를 아무도 알 수 없게 되기 때문입니다.

## 설정

값은 전부 [src/config.ts](src/config.ts) 한 곳에서 읽습니다. 자세한 항목은
[.env.example](.env.example) 과 [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md) 을 보세요.

비밀값은 `.env` 에도 소스에도 두지 않고 **파일로 두고 경로만 가리킵니다.**

| 비밀 | 위치 | 없으면 |
|---|---|---|
| DB 비밀번호 | `database/secrets/jyahn.pw` (database/ 가 소유) | 단말 등록 비활성, `/health` 가 degraded |
| Firebase 서비스 계정 | `secrets/firebase-admin.json` (600) | 착신 푸시만 비활성, 중계는 계속 동작 |
| manager 세션 시크릿 | `services/.session-secret` (manager 가 소유) | 대시보드 접근이 모두 거부 |

`COMPLEX_ID` 는 이 서버가 맡은 단지입니다 (소문자 16진수 8자). 비워 두면 단지
검사를 하지 않습니다. **한 번 정하면 바꾸지 않습니다** — 바꾸면 이미 등록된
단말이 전부 자기 단지를 잃습니다. 자세한 것은 [docs/multi-complex.md](docs/multi-complex.md).

## 관련 문서

- [docs/enrollment.md](docs/enrollment.md) — **단말 등록 남은 작업** (Firestore 적용 · 앱 · 월패드)
- [ANDROID_API_GUIDE.md](ANDROID_API_GUIDE.md) — 클라이언트가 쓰는 API 전체
- [example/android/](example/android/) — 최소 클라이언트 (Kotlin·Java)
- [ApplyNginx.md](ApplyNginx.md) · [Certificate.md](Certificate.md) — 배치
- [../../docs/health-contract.md](../../docs/health-contract.md) — `/health` 규약
- [../../database/README.md](../../database/README.md) — DB 규약
