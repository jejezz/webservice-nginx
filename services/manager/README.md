# Manager — Nginx / 서비스 관리 대시보드

React + Tailwind CSS + shadcn/ui 기반의 관리 페이지입니다.
`nginx.ini`의 라우트와 `services/ecosystem.config.js`의 PM2 앱을 합쳐 서비스 목록을 만들고,
각 서비스의 `/health`를 직접 호출해 PM2·Nginx 상태와 함께 보여줍니다.

```
브라우저 ──HTTPS──> Nginx (/manager) ──> manager (127.0.0.1:28084)
                                              │
                                              ├─ 서비스 목록: nginx.ini + ecosystem.config.js
                                              ├─ GET http://127.0.0.1:28083/health    (ws-bridge)
                                              ├─ GET http://127.0.0.1:28099/health    (websocket-relay)
                                              ├─ pm2 jlist
                                              └─ systemctl show nginx
```

Nginx 라우트가 없는 서비스(포트로 직접 접근)도 목록에 나타나며 `직결` 배지로 구분됩니다.

## 서비스 대시보드 링크와 SSO

서비스가 자체 관리 페이지를 제공하면 목록에 **대시보드** 버튼이 나타납니다.
링크는 `nginx.ini`의 `location` + `ecosystem.config.js`의 `env.DASHBOARD_PATH`로 만들어지며,
둘 중 하나라도 없으면 브라우저에서 열 수 없으므로 버튼을 만들지 않습니다.
따라서 대시보드를 구현한 서비스만 링크가 보입니다.

```js
// services/ecosystem.config.js
{
  name: 'ws-bridge',
  env: { PORT: 28083, DASHBOARD_PATH: '/dashboard' },   // → /ws-bridge/dashboard
}
```

로그인은 manager 한 곳에서만 합니다. 세션 쿠키는 `Path=/`로 발급되고,
각 서비스는 `services/.session-secret`을 공유해 같은 쿠키를 검증합니다.
비로그인 상태로 서비스 대시보드에 접근하면 `/manager/login?next=<원래 주소>`로 이동한 뒤
로그인 후 원래 페이지로 돌아옵니다.

## 구조

```
services/manager/
├── config.json           # 계정/포트/세션 설정 (커밋 제외)
├── config.example.json   # 설정 템플릿
├── schema/               # 이 서비스의 DB 스키마 (001-initial.sql …)
├── server/               # Express API + 정적 파일 서버
│   ├── src/
│   │   ├── index.js          # 진입점, /manager 마운트, SPA 폴백
│   │   ├── config.js         # config.json + 환경 변수 병합
│   │   ├── nginx-ini.js      # nginx.ini 파서
│   │   ├── db.js            # MariaDB 연결 풀
│   │   ├── auth/
│   │   │   ├── user-store.js    # 저장소 선택 (db / file)
│   │   │   ├── db-user-store.js # administrator 테이블 + 승인 절차
│   │   │   ├── password.js      # scrypt 해시 / 상수 시간 비교
│   │   │   └── session.js       # HMAC 서명 쿠키 세션 (일반 / 관리자 콘솔)
│   │   ├── services/
│   │   │   ├── registry.js   # nginx.ini + ecosystem.config.js 서비스 목록 병합
│   │   │   ├── health.js     # /health 체크 (HTTPS 자체 서명 인증서 지원)
│   │   │   ├── pm2.js        # pm2 jlist
│   │   │   ├── nginx.js      # systemctl 상태
│   │   │   ├── setup.js      # 구축 마법사 단계 표 + 점검 스크립트 실행기
│   │   │   ├── setup-attest.js # 사람의 확인 기록 (setup-attest.json)
│   │   │   └── setup-settings.js # 파라미터 폼 ↔ 서비스의 settings.ini
│   │   └── routes/
│   │       ├── api.js        # REST API
│   │       └── admin.js      # 관리자 콘솔 API (administrator CRUD)
│   ├── tools/
│   │   ├── admin.js          # 관리자 계정 CLI
│   │   └── hash-password.js
│   └── public/               # web 빌드 결과 (vite build 시 생성)
└── web/                  # React SPA (Vite)
    └── src/
        ├── pages/{Login,Dashboard,Setup,AdminConsole}.jsx
        ├── components/AdminLoginDialog.jsx  # 로그인 화면의 설정 버튼 모달
        ├── components/ui/    # shadcn/ui 컴포넌트
        └── lib/api.js
```

## 설치 및 빌드

```bash
cd services/manager/server && npm install
cd ../web && npm install && npm run build   # 결과물이 ../server/public 에 생성됨
```

## 실행

PM2로 실행합니다 (`services/ecosystem.config.js`에 `manager` 항목 포함).

```bash
cd services
pm2 start ecosystem.config.js --only manager
pm2 save
```

직접 실행하려면:

```bash
cd services/manager/server && npm start
```

## Nginx 연동

`nginx.ini`에 이미 라우트가 추가되어 있습니다.

```ini
[manager]
location = /manager
proxy_pass = http://127.0.0.1:28084
websocket = false
```

```bash
sudo ./setup_nginx.sh
```

접속: `https://<server_name>/manager`

> HTTP(80)로 접근하면 Nginx가 HTTPS로 301 리다이렉트합니다.
> 세션 쿠키에 `Secure` 속성이 붙으므로 HTTPS에서만 로그인이 유지됩니다.

## 계정과 로그인

계정은 MariaDB `manager` 스키마의 `administrator` 테이블에 있습니다. (`auth.provider: "db"`)
스키마 정의는 이 서비스가 소유합니다 — [schema/001-initial.sql](schema/001-initial.sql).
테이블을 추가할 때는 같은 디렉토리에 `002-xxx.sql` 을 넣고 `sudo database/setup_mariadb.sh` 를 다시 실행합니다.

- **아이디는 이메일만** 받습니다. 서버와 화면 양쪽에서 형식을 확인합니다.
- 등록되지 않은 이메일로 로그인하면 **승인 요청**이 만들어집니다. (`approved = 0`)
- `approved = 1` 인 계정만 로그인에 성공합니다.

### 로그인 흐름

| 상황 | 응답 | 화면 |
|------|------|------|
| 승인된 계정 + 비밀번호 일치 | `200` | 대시보드로 이동 |
| 처음 보는 이메일 | `403 pending_approval` | "승인 요청이 등록되었습니다" 안내 |
| 승인 대기 중인 계정 | `403 pending_approval` | "승인 대기 중입니다" 안내 |
| 승인된 계정 + 비밀번호 불일치 | `401 invalid_credentials` | 오류 |
| 이메일 형식 아님 | `400 invalid_email` | 오류 |
| DB 접속 불가 | `503` | 오류 |

승인 대기는 실패로 세지 않으므로 로그인 시도 제한(IP당 5회)에 걸리지 않습니다.
또한 승인 전에는 비밀번호를 다시 설정할 수 있습니다 — 처음 요청할 때 오타가 나도
승인 전에 바로잡을 수 있고, 아직 아무 권한이 없으므로 위험하지 않습니다.

### 관리 CLI

```bash
cd services/manager/server

npm run admin -- list                          # 전체 목록 (승인 대기 표시)
npm run admin -- approve you@example.com       # 승인
npm run admin -- revoke  you@example.com       # 승인 취소
npm run admin -- add     you@example.com [--password <pw>] [--name 이름] [--pending]
npm run admin -- passwd  you@example.com --password <pw>
npm run admin -- delete  you@example.com
```

`add`에 비밀번호를 주지 않으면 임의로 만들어 **한 번만** 출력합니다.
`delete`는 마지막으로 남은 승인 계정이면 거부합니다. (로그인 불가 상태 방지)

### 관리자 콘솔 (웹)

CLI 없이 브라우저에서도 같은 일을 할 수 있습니다.

1. 로그인 화면 오른쪽 위의 **설정(⚙) 버튼**을 누릅니다.
2. 관리자 아이디·비밀번호를 넣습니다. (`config.json`의 `superAdmin`, 기본 `zoomon`)
3. `/manager/admin` 콘솔이 열리고 `administrator` 테이블을 직접 다룹니다.

| 조작 | 방법 |
|------|------|
| 승인 / 승인 취소 | 표의 **승인 스위치**를 바로 켜고 끕니다 |
| 이메일·이름·권한 수정 | 연필 아이콘 → 행이 입력란으로 바뀜 → 체크로 저장 |
| 비밀번호 변경 | `••` 아이콘 |
| 삭제 | 휴지통 아이콘 (확인 후 삭제) |
| 추가 | 헤더의 “관리자 추가” |

콘솔 세션은 일반 로그인과 **완전히 분리된 쿠키**(`manager_admin`, 기본 30분)를 씁니다.
두 토큰은 서로를 대신할 수 없고, 이 쿠키는 `/manager` 경로 밖으로 나가지 않습니다.
모든 변경은 `admin_audit_log`에 `console:<아이디>` 행위자로 남습니다.

> **주의** — 이 계정 하나로 모든 관리자 계정을 만들고 지울 수 있습니다.
> 기본값(`zoomon` / `77887788`)을 그대로 두지 말고, 최소한 아래처럼 해시로 바꿔 두세요.
>
> ```bash
> cd services/manager/server && npm run hash-password -- '새 비밀번호'
> ```
>
> 출력한 `scrypt$…` 값을 `config.json`의 `superAdmin.passwordHash`에 넣으면
> `superAdmin.password`는 무시됩니다. CLI와 달리 이 콘솔에는 “마지막 승인 계정 보호”가
> 없습니다 — 모두 승인 취소해도 설정 버튼으로 다시 들어와 되돌릴 수 있기 때문입니다.

### 첫 계정 만들기

가장 간단한 방법은 로그인 화면을 그대로 쓰는 것입니다.

1. 로그인 화면에서 본인 이메일과 쓸 비밀번호로 로그인 시도 → 승인 요청 생성
2. 서버에서 승인

```bash
cd services/manager/server && npm run admin -- approve you@example.com
```

3. 같은 이메일·비밀번호로 다시 로그인

CLI로 한 번에 만들 수도 있습니다.

```bash
npm run admin -- add you@example.com --password '...' --name '홍길동'
```

### DB 장애 시 (비상용)

`auth.provider`를 `file`로 바꾸면 `config.json`의 `auth.users`로 로그인합니다.
평상시에는 쓰지 마세요. 비밀번호가 설정 파일에 남습니다.

```json
{
  "auth": {
    "provider": "file",
    "users": [{ "username": "you@example.com", "passwordHash": "scrypt$…", "displayName": "…" }]
  }
}
```

```bash
npm run hash-password -- '비상용비밀번호'   # passwordHash 값 생성
pm2 restart manager
```

### 데이터베이스 설정

```json
{
  "database": {
    "host": "127.0.0.1",
    "port": 3306,
    "user": "jyahn",
    "passwordFile": "../../database/secrets/jyahn.pw",
    "name": "manager",
    "connectionLimit": 5
  }
}
```

비밀번호는 `config.json`에 두지 않고 파일에서 읽습니다.
환경 변수 `MANAGER_DB_PASSWORD`로도 덮어쓸 수 있습니다.

`/manager/health`의 `details.database`에서 접속 상태를 확인할 수 있습니다.

```json
{ "configured": true, "ok": true, "database": "manager" }
```

## 설정 항목 (config.json)

| 항목 | 기본값 | 설명 |
|------|--------|------|
| `port` | `28084` | 리스닝 포트 |
| `host` | `127.0.0.1` | 바인딩 주소. Nginx가 루프백으로 프록시하므로 기본은 외부 노출 없음 |
| `basePath` | `/manager` | Nginx가 프록시하는 경로 접두사 |
| `sessionSecret` | — | 세션 쿠키 서명 키. 비우면 `services/.session-secret`을 읽거나 새로 만듦 |
| `sessionTtlMinutes` | `120` | 세션 유효 시간 |
| `cookieSecure` | `true` | HTTPS 전용 쿠키. HTTP로 테스트할 때만 `false` |
| `nginxIniPath` | `../../nginx.ini` | 라우트를 읽어올 ini 경로 |
| `ecosystemPath` | `../ecosystem.config.js` | PM2 앱 목록을 읽어올 경로 |
| `healthTimeoutMs` | `3000` | `/health` 호출 타임아웃 |
| `pm2Enabled` | `true` | PM2 상태 수집 여부 |
| `auth.provider` | `db` | `db`(administrator 테이블) 또는 `file`(비상용) |
| `superAdmin.username` | `zoomon` | 관리자 콘솔 아이디 |
| `superAdmin.password` | `77887788` | 관리자 콘솔 비밀번호. `passwordHash`가 있으면 무시됨 |
| `superAdmin.passwordHash` | — | `npm run hash-password`로 만든 `scrypt$…` (권장) |
| `superAdmin.sessionTtlMinutes` | `30` | 관리자 콘솔 세션 유효 시간 |
| `database.host` / `port` | `127.0.0.1` / `3306` | MariaDB 주소 |
| `database.user` | `jyahn` | 공용 DB 계정 |
| `database.passwordFile` | `../../database/secrets/jyahn.pw` | 비밀번호 파일 |
| `database.name` | `manager` | 사용할 스키마 |
| `database.connectionLimit` | `5` | 연결 풀 크기 |

환경 변수 `PORT`, `MANAGER_HOST`, `MANAGER_BASE_PATH`, `MANAGER_SESSION_SECRET`, `MANAGER_CONFIG`,
`MANAGER_DB_PASSWORD`, `MANAGER_SUPERADMIN_USERNAME`, `MANAGER_SUPERADMIN_PASSWORD`,
`MANAGER_SUPERADMIN_PASSWORD_HASH`로도 덮어쓸 수 있습니다.

## API

| 메서드 | 경로 | 인증 | 설명 |
|--------|------|------|------|
| `GET` | `/manager/health` | — | manager 자체 상태 |
| `POST` | `/manager/api/login` | — | 로그인 / 승인 요청 (IP당 5회 실패 시 5분 차단) |
| `POST` | `/manager/api/logout` | — | 로그아웃 |
| `GET` | `/manager/api/me` | 필요 | 현재 세션 |
| `POST` | `/manager/api/verify-password` | 필요 | 지금 로그인한 사람이 맞는지 비밀번호로 재확인 (서비스 대시보드가 민감한 값을 꺼내기 전에 부름) |
| `GET` | `/manager/api/overview` | 필요 | 서비스·Nginx 전체 상태 |
| `GET` | `/manager/api/services/:name/health` | 필요 | 개별 서비스 재확인 |
| `GET` | `/manager/api/setup` | 필요 | 구축 단계 정의 + 각 단계의 마지막 점검 결과 |
| `POST` | `/manager/api/setup/check/:stepId` | 필요 | 그 단계의 점검 스크립트를 돌리고 판정을 반환 |
| `PUT` | `/manager/api/setup/settings/:stepId` | 필요 | 그 단계의 파라미터를 서비스의 `settings.ini` 에 저장 |
| `POST` | `/manager/api/setup/attest/:stepId` | 필요 | 사람의 확인을 기록 (기계가 확인할 수 없는 단계) |
| `DELETE` | `/manager/api/setup/attest/:stepId` | 필요 | 그 확인 기록을 지움 |
| `POST` | `/manager/api/admin/login` | — | 관리자 콘솔 로그인 (IP당 5회 실패 시 10분 차단) |
| `POST` | `/manager/api/admin/logout` | — | 관리자 콘솔 로그아웃 |
| `GET` | `/manager/api/admin/me` | 콘솔 | 콘솔 세션 확인 |
| `GET` | `/manager/api/admin/administrators` | 콘솔 | 관리자 목록 |
| `POST` | `/manager/api/admin/administrators` | 콘솔 | 관리자 추가 |
| `PATCH` | `/manager/api/admin/administrators/:id` | 콘솔 | 이메일·이름·권한·비밀번호·`approved` 수정 |
| `DELETE` | `/manager/api/admin/administrators/:id` | 콘솔 | 관리자 삭제 |

“콘솔” 인증은 `manager_admin` 쿠키이며, 일반 로그인 세션(`manager_session`)으로는 통과하지 못합니다.
응답에 `password_hash`는 절대 포함되지 않습니다.

대시보드는 5초마다 `/overview`를 갱신하며, 헤더의 스위치로 자동 갱신을 끌 수 있습니다.

## 서비스 상태 판정 규칙

각 서비스는 `/health`에 아래 형태로 응답해야 합니다.

```json
{ "service": "ws-bridge", "status": "ok", "uptimeSec": 120, "pid": 1234, "timestamp": "…" }
```

| 표시 | 조건 |
|------|------|
| 정상 (up) | 2xx 응답이고 `status`가 `ok`/`healthy`/`up`/`pass`/`ready`/`green` (또는 `status` 필드 없음) |
| 주의 (degraded) | 2xx 응답이지만 `status`가 그 외의 값 |
| 중단 (down) | 연결 실패 / 타임아웃 / 2xx 아닌 응답 |
| 알 수 없음 (unknown) | 헬스 URL을 만들 수 없음 (`proxy_pass` 파싱 실패, `PORT`/`HEALTH_URL` 없음) |

### 헬스 URL 결정 순서

1. `ecosystem.config.js`의 `env.HEALTH_URL`
2. `nginx.ini` 라우트의 `proxy_pass` + `health_path` (기본 `/health`)
3. `ecosystem.config.js`의 `env.PORT` → `http://127.0.0.1:<PORT>/health`

Nginx 라우트가 있는 서비스는 경로를 ini에서 바꿉니다.

```ini
[some-service]
location = /some/
proxy_pass = http://127.0.0.1:29000
websocket = false
health_path = /status
```

Nginx를 거치지 않는 서비스는 `ecosystem.config.js`의 env로 지정합니다.

```js
env: {
  PORT: 28099,
  HEALTH_URL: 'https://127.0.0.1:28099/health',
  HEALTH_INSECURE_TLS: 'true',   // 자체 서명 인증서일 때
}
```

## 구축 마법사 (`/manager/setup`)

서비스를 **어떤 순서로 무엇을 채워야 하는지** 안내하고, 사람이 한 일을 실제로
됐는지 확인한 뒤 다음으로 넘기는 화면입니다. 설계는
[docs/setup-wizard.md](../../docs/setup-wizard.md), 점검 출력의 형식은
[docs/check-contract.md](../../docs/check-contract.md) 에 있습니다.

대시보드 헤더의 **구축** 버튼으로 들어갑니다. 단계 하나를 주소로 가리킬 수도
있습니다 — `/manager/setup?step=janus.config`.

| # | 단계 | 점검 |
|---|---|---|
| 1 | `database.schema` | `database/check-database.sh` |
| 2 | `pm2.apps` | `pm2/ecosystem.config.js --check-json` |
| 3 | `kamailio.deps` | `services/kamailio/bootstrap.sh` |
| 4 | `kamailio.config` | `services/kamailio/install.sh` |
| 5 | `sip.accounts` | 사람의 확인만 |
| 6 | `janus.deps` | `services/janus/bootstrap.sh` |
| 7 | `janus.build` | 사람의 확인만 |
| 8 | `janus.config` | `services/janus/install.sh` |
| 9 | `janus.dashboard` | `services/janus/setup-dashboard.sh` |
| 10 | `nginx.routes` | `nginx/install_nginx_stack.sh` |
| 11 | `janus.verify.call` | `verify-call.sh --check` + 통화 결과는 사람의 확인 |
| 12 | `janus.publicip` (선택) | `check-public-ip.sh` + 포워딩은 사람의 확인 |
| 13 | `push.incoming` (선택) | `services/kamailio/check-push.sh` |

- **진행은 점검 결과로만 정해집니다.** 사람이 누른 "했습니다" 는 점검을 부르는
  방아쇠일 뿐입니다. 앞 단계가 통과하지 않으면 다음 단계는 잠깁니다.
- **마법사는 sudo 를 부르지 않습니다.** 바꾸는 명령(`--apply` · `--install`)과
  90초짜리 시험 통화(`verify-call.sh --run`)는 화면이 보여 주기만 하고 사람이
  터미널에서 돌립니다.
- **진행률을 저장하지 않습니다.** 마지막 점검 결과는 프로세스 메모리에만 있고,
  화면에 들어올 때마다 전부 다시 점검합니다 (11개에 1.3초). 터미널에서 되돌린
  것이 "완료" 로 남지 않게 하기 위해서입니다.

단계를 늘릴 때는 `server/src/services/setup.js` 의 `STEPS` 에 한 줄을 더합니다.
화면 코드는 손대지 않습니다.

### 사람의 확인 (`attested`)

기계가 확인할 수 없는 것들이 있습니다 — 공유기에 포워딩을 열었는가, SIP 계정을
만들었는가, 시험 통화에서 소리가 났는가.

이런 단계는 사람의 확인을 **누가 언제** 눌렀는지와 함께 기록하고, 통과와 다른
색으로 그립니다. 다음 단계는 열어 주되 "통과" 로 위장하지 않습니다 — 나중에
무언가 안 될 때 여기부터 의심할 수 있어야 하기 때문입니다.

**사람의 확인이 점검을 이기지 못합니다.** 점검이 `problem` 이면 확인 기록이
있어도 `problem` 입니다.

기록은 `services/manager/setup-attest.json` 에 남습니다 (커밋하지 않습니다).
DB 가 아니라 파일인 이유는 **MariaDB 를 세우는 것이 이 마법사의 1단계**이기
때문입니다 — DB 에 두면 DB 가 없는 동안 아무것도 기록할 수 없습니다.

### 파라미터 입력 (장비마다 다른 값)

단계에 `settings` 가 붙어 있으면 그 서비스의 `settings-schema.json` 을 읽어 폼을
그리고, 사람이 넣은 값을 그 서비스의 `settings.ini` 에 씁니다. 규약은
[docs/settings-contract.md](../../docs/settings-contract.md) 입니다.

| 단계 | 받는 값 |
|---|---|
| `kamailio.config` | `sip_domain` · `sip_listen_addr` · `sip_push_url` |
| `janus.config` | `public_ip` · `rtp_port_range` |

**저장과 반영은 다릅니다.** 저장은 파일에 적는 것뿐이고, 반영은 사람이 그
단계의 `--apply` 를 돌려야 일어납니다. 그 사이의 상태는 **점검 스크립트가**
`[--] … 가 아직 반영되지 않았습니다` 로 보고하므로, 값을 바꾸면 그 단계가 곧바로
'통과' 에서 '아직' 으로 내려갑니다. 마법사가 따로 계산하지 않습니다 — 규칙을 한
곳에 두기 위해서입니다.

### 파일 쓰기 경계

마법사가 파일을 쓰는 곳은 둘뿐입니다.

| 무엇 | 어디에 |
|---|---|
| 사람의 확인 기록 | `services/manager/setup-attest.json` |
| 파라미터 | `services/<서비스>/settings.ini` |

경로는 `STEPS` 가 정합니다 — 사람 입력에서 만들지 않고, 저장소 밖으로 나가면
거부합니다. 설정 파일 자체(`.jcfg` · `kamailio-local.cfg`)는 건드리지 않고,
서비스를 재기동하지도 않습니다. 값은 저장 전에 검증하고, root 로 도는 적용
스크립트가 **한 번 더** 검증합니다.

### 자식 프로세스 경계

manager 가 셸 스크립트를 돌리는 곳은 여기뿐입니다. 경계를 좁게 잡았습니다.

| | |
|---|---|
| 무엇을 돌리는가 | `STEPS` 에 박힌 것만. `:stepId` 는 그 표에서 한 줄을 고르는 데만 쓴다 |
| 어떻게 | `execFile` — 셸을 거치지 않는다. 사람 입력으로 인자를 만들지 않는다 |
| 어디까지 | 실행 파일이 저장소 밖으로 나가면 거부한다 |
| 얼마나 | 타임아웃 30초, 출력 상한 1MB, 같은 단계는 겹쳐 돌지 않는다 |
| 무엇을 안 하는가 | 바꾸는 모드와 sudo |

점검을 마치지 못하면(스크립트 없음·타임아웃·출력을 읽지 못함·다른 `step` 을
보고함) `unknown` 이 되고, **통과로도 실패로도 치지 않습니다.** 다음 단계는
열리지 않습니다.

## 개발 모드

```bash
cd services/manager/server && npm run dev     # API :28084
cd services/manager/web && npm run dev        # http://localhost:5183/manager/ (API는 프록시됨)
```

브라우저에서 HTTP로 접속하게 되므로 개발 중에는 `config.json`의 `cookieSecure`를 `false`로 둡니다.
