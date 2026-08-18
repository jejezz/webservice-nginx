# Manager — Nginx / 서비스 관리 대시보드

React + Tailwind CSS + shadcn/ui 기반의 관리 페이지입니다.
`nginx.ini`의 라우트와 `services/ecosystem.config.js`의 PM2 앱을 합쳐 서비스 목록을 만들고,
각 서비스의 `/health`를 직접 호출해 PM2·Nginx 상태와 함께 보여줍니다.

```
브라우저 ──HTTPS──> Nginx (/manager) ──> manager (127.0.0.1:28084)
                                              │
                                              ├─ 서비스 목록: nginx.ini + ecosystem.config.js
                                              ├─ GET http://127.0.0.1:28083/health    (ws-bridge)
                                              ├─ GET https://127.0.0.1:28099/health   (callfusion2rtc, TLS 검증 생략)
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
│   │   │   └── nginx.js      # systemctl 상태
│   │   └── routes/
│   │       ├── api.js        # REST API
│   │       └── admin.js      # 관리자 콘솔 API (administrator CRUD)
│   ├── tools/
│   │   ├── admin.js          # 관리자 계정 CLI
│   │   └── hash-password.js
│   └── public/               # web 빌드 결과 (vite build 시 생성)
└── web/                  # React SPA (Vite)
    └── src/
        ├── pages/{Login,Dashboard,AdminConsole}.jsx
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
| `GET` | `/manager/api/overview` | 필요 | 서비스·Nginx 전체 상태 |
| `GET` | `/manager/api/services/:name/health` | 필요 | 개별 서비스 재확인 |
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

## 개발 모드

```bash
cd services/manager/server && npm run dev     # API :28084
cd services/manager/web && npm run dev        # http://localhost:5183/manager/ (API는 프록시됨)
```

브라우저에서 HTTP로 접속하게 되므로 개발 중에는 `config.json`의 `cookieSecure`를 `false`로 둡니다.
