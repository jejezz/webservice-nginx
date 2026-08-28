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
| 모바일 단말 | 목록·검색, **추가·수정**, 활성 토글, 삭제. 단지 ID 불일치·SIP 내선 없음·푸시 실패를 눈에 보이게 합니다 |
| 홈넷 장치 | 등록된 월패드 목록과 삭제 |
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

- [ANDROID_API_GUIDE.md](ANDROID_API_GUIDE.md) — 클라이언트가 쓰는 API 전체
- [example/android/](example/android/) — 최소 클라이언트 (Kotlin·Java)
- [ApplyNginx.md](ApplyNginx.md) · [Certificate.md](Certificate.md) — 배치
- [../../docs/health-contract.md](../../docs/health-contract.md) — `/health` 규약
- [../../database/README.md](../../database/README.md) — DB 규약
