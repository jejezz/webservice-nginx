# Manager — Nginx / 서비스 관리 대시보드

React + Tailwind CSS + shadcn/ui 기반의 관리 페이지입니다.
Nginx의 기본 웹페이지를 대신해 **루트(`/`)** 에서 응답합니다.

> **이 문서의 경로와 명령은 `WebServices/` 루트 기준입니다.**
> 예: `cd services/manager/server` 는 `WebServices/services/manager/server` 입니다.

각 서비스가 자기 디렉토리에 선언한 `nginx-conf/service.ini`와 `pm2/ecosystem.config.js`의
PM2 앱을 합쳐 서비스 목록을 만들고, 각 서비스의 `/health`를 직접 호출해
PM2·Nginx 상태와 함께 보여줍니다.

```
브라우저 ──HTTPS──> Nginx (location /) ──> manager (127.0.0.1:28084)
                                              │
                                              ├─ 서비스 목록: services/*/nginx-conf/*.ini + ecosystem.config.js
                                              ├─ GET http://127.0.0.1:5500/health    (face-recognition-server)
                                              ├─ GET http://127.0.0.1:28092/health   (huygens-server)
                                              ├─ pm2 jlist
                                              └─ systemctl show nginx
```

manager는 `install_nginx_stack.sh`가 읽는 것과 **같은 선언 파일**을 읽습니다.
그래서 라우팅의 진실 공급원이 하나뿐이고, 서비스가 늘어나도 대시보드를 고칠 필요가 없습니다.
선언 스키마는 [../../docs/nginx-conf.md](../../docs/nginx-conf.md),
`/health` 응답 형식은 [../../docs/health-contract.md](../../docs/health-contract.md)를 참고하세요.

병합 규칙은 이름 우선입니다. 선언과 PM2 앱의 이름이 같으면 한 행으로 합치고,
이름이 다르면 `env.PORT`(또는 `HEALTH_URL`의 포트)가 선언된 포트와 같을 때 합칩니다.
(`Huygens-Server` ↔ `huygens-server`가 이 경우입니다.)
한쪽에만 있는 것도 목록에 나타나며, 각 행의 `등록 위치`가 어디서 왔는지 보여줍니다.
선언에 포트가 여러 개면 `least_conn`으로 분산되므로 포트마다 따로 헬스 체크해
`face-recognition-server[5501]`처럼 인스턴스별 행으로 나뉩니다.

## 구조

```
WebServices/services/manager/
├── config.json           # 계정/포트/세션 설정 (커밋 제외)
├── config.example.json   # 설정 템플릿
├── secrets/              # DB 비밀번호 파일 (커밋 제외)
├── schema/               # 이 서비스의 DB 스키마
│   ├── 001-initial.sql
│   └── setup_database.sh # 스키마 생성 + *.sql 적용
├── server/               # Express API + 정적 파일 서버
│   ├── src/
│   │   ├── index.js          # 진입점, 루트 마운트, SPA 폴백
│   │   ├── config.js         # config.json + 환경 변수 병합
│   │   ├── nginx-conf.js     # services/*/nginx-conf/*.ini 선언 파서
│   │   ├── db.js             # MariaDB 연결 풀
│   │   ├── auth/
│   │   │   ├── user-store.js    # 저장소 선택 (db / file)
│   │   │   ├── db-user-store.js # administrator 테이블 + 승인 절차
│   │   │   ├── password.js      # scrypt 해시 / 상수 시간 비교
│   │   │   └── session.js       # HMAC 서명 쿠키 세션 (일반 / 관리자 콘솔)
│   │   ├── services/
│   │   │   ├── registry.js   # 선언 + ecosystem.config.js 서비스 목록 병합
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

## 설치

### 1. 데이터베이스

계정은 MariaDB `manager` 스키마의 `administrator` 테이블에 있습니다. (`auth.provider: "db"`)

```bash
cd services/manager
sudo ./schema/setup_database.sh
```

스키마와 애플리케이션 계정을 만들고 `schema/*.sql`을 이름순으로 적용합니다.

> `Access denied for user 'root'@'localhost' (using password: YES)` 가 나오면
> `/root/.my.cnf` 에 적힌 비밀번호가 낡았을 가능성이 큽니다. `using password` 값이
> 어느 쪽인지가 단서입니다 — `YES` 면 비밀번호를 보냈는데 틀린 것이고,
> `NO` 면 비밀번호를 안 보냈는데 서버가 요구한다는 뜻입니다.
>
> 스크립트는 붙는 방법을 순서대로 시도하므로 대개 그냥 실행하면 됩니다:
> ① 옵션 파일 무시 + 소켓 → ② 기본 옵션 파일 → ③ `/etc/mysql/debian.cnf`
> (Debian/Ubuntu 유지보수 계정, root 비밀번호를 몰라도 되는 탈출구) → ④ 직접 입력.
비밀번호는 화면에서 입력받아 `secrets/manager-db.pw`에 `0600`으로 저장합니다.
(인자로 받지 않습니다 — 프로세스 목록과 셸 히스토리에 남기 때문입니다)
테이블을 추가할 때는 같은 디렉토리에 `002-xxx.sql`을 넣고 다시 실행합니다.

### 2. 설정 파일

```bash
cp config.example.json config.json
```

`superAdmin.passwordHash`는 반드시 채웁니다. **기본 비밀번호는 없습니다.**
비어 있으면 로그인 화면의 설정(⚙) 버튼이 항상 실패합니다.

```bash
cd services/manager/server && npm install && npm run hash-password -- '새 비밀번호'
```

출력한 `scrypt$…` 값을 `config.json`의 `superAdmin.passwordHash`에 넣습니다.

### 3. 빌드

```bash
cd services/manager/server && npm install
cd services/manager/web && npm install && npm run build   # 결과물이 ../server/public 에 생성됨
```

### 4. Nginx 라우트

`nginx-conf/service.ini`에 이미 선언되어 있습니다.

```ini
[service]
name        = nginx-manager
ports       = 28084
health_path = /health

[route:app]
location = /
```

```bash
cd nginx
sudo ./install_nginx_stack.sh --skip-install
```

`location /`은 가장 짧은 접두사이므로 `/face/`, `/complex/`, `/cassini/`, `= /health`가
먼저 매칭되고 남는 요청(`/`, `/login`, `/dashboard`, `/admin`, `/api/*`, 정적 에셋)만 넘어옵니다.

> `= /health`는 face-recognition-server가 선언한 경로라 그쪽으로 갑니다.
> manager 자신의 상태는 `http://127.0.0.1:28084/health`로 확인합니다.

### 5. 실행

PM2로 실행합니다. (`pm2/ecosystem.config.js` 에 `nginx-manager` 항목 포함)

```bash
cd pm2
pm2 start ecosystem.config.js --only nginx-manager
pm2 save
```

직접 실행하려면:

```bash
cd services/manager/server && npm start
```

접속: `https://<서버 주소>/`

> HTTP(80)로 접근하면 Nginx가 HTTPS로 301 리다이렉트합니다.
> 세션 쿠키에 `Secure` 속성이 붙으므로 HTTPS에서만 로그인이 유지됩니다.

## 계정과 로그인

- **아이디는 이메일만** 받습니다. 서버와 화면 양쪽에서 형식을 확인합니다.
- 등록되지 않은 이메일로 로그인하면 **승인 요청**이 만들어집니다. (`approved = 0`)
- `approved = 1` 인 계정만 로그인에 성공합니다.
- 이때 입력한 비밀번호가 **그대로 계정 비밀번호가 되므로**, 저장 전에 확인 입력을
  한 번 더 받습니다. 확인 없이는 `password_hash` 를 쓰지 않습니다.

### 로그인 흐름

| 상황 | 응답 | 화면 |
|------|------|------|
| 승인된 계정 + 비밀번호 일치 | `200` | 대시보드로 이동 |
| 처음 보는 이메일 | `403 password_confirm_required` (`reason: signup`) | **비밀번호 확인** 칸이 열림 |
| 확인값 불일치 | `400 password_mismatch` | 확인 칸만 비우고 다시 입력 |
| 확인값 일치 | `403 pending_approval` | "비밀번호가 저장되었습니다" 안내 |
| 승인 대기 중 + 비밀번호 일치 | `403 pending_approval` | "승인 대기 중입니다" 안내 |
| 승인 대기 중 + 비밀번호 불일치 | `403 password_confirm_required` (`reason: reset`) | 재설정하려면 확인 입력 |
| 승인된 계정 + 비밀번호 불일치 | `401 invalid_credentials` | 오류 |
| 이메일 형식 아님 | `400 invalid_email` | 오류 |
| DB 접속 불가 | `503` | 오류 |

승인 대기와 확인 요구는 실패로 세지 않으므로 로그인 시도 제한(IP당 5회)에 걸리지 않습니다.
아직 자격 증명을 틀린 게 아니기 때문입니다.

### 왜 확인 입력을 받나

첫 로그인 시도가 곧 계정 등록이라, 그때 친 비밀번호가 조용히 계정 비밀번호가 됩니다.
예전에는 화면에 "승인 요청이 등록되었습니다"라고만 나와서 **비밀번호가 정해졌다는 사실
자체를 알 수 없었습니다.** 그 시점에 오타가 나면, 승인이 끝난 뒤에는 스스로 고칠 방법이
없어 관리자가 `admin -- passwd` 로 재설정해줘야 했습니다.

그래서 비밀번호가 새로 저장되는 두 경우 — 신규 등록(`signup`)과 승인 전 재설정(`reset`) —
에는 확인 입력을 받은 뒤에만 쓰도록 했습니다. 확인 전에는 DB에 행조차 만들지 않으므로,
인증되지 않은 요청 한 번으로 레코드가 생기지도 않습니다.

승인 전에 비밀번호를 다시 설정할 수 있다는 점은 그대로입니다. 아직 아무 권한이 없어
위험하지 않고, 오타를 스스로 바로잡을 수 있는 유일한 창구이기 때문입니다.

### 첫 계정 만들기

가장 간단한 방법은 로그인 화면을 그대로 쓰는 것입니다.

1. 로그인 화면에서 본인 이메일과 쓸 비밀번호를 입력 → **비밀번호 확인** 칸이 열림
2. 같은 비밀번호를 한 번 더 입력 → 승인 요청 생성 (이 비밀번호가 계정 비밀번호)
3. 서버에서 승인

```bash
cd services/manager/server && npm run admin -- approve you@example.com
```

4. 같은 이메일·비밀번호로 다시 로그인

CLI로 한 번에 만들 수도 있습니다.

```bash
npm run admin -- add you@example.com --password '...' --name '홍길동'
```

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
2. `config.json`의 `superAdmin` 아이디·비밀번호를 넣습니다.
3. `/admin` 콘솔이 열리고 `administrator` 테이블을 직접 다룹니다.

| 조작 | 방법 |
|------|------|
| 승인 / 승인 취소 | 표의 **승인 스위치**를 바로 켜고 끕니다 |
| 이메일·이름·권한 수정 | 연필 아이콘 → 행이 입력란으로 바뀜 → 체크로 저장 |
| 비밀번호 변경 | `••` 아이콘 |
| 삭제 | 휴지통 아이콘 (확인 후 삭제) |
| 추가 | 헤더의 "관리자 추가" |

콘솔 세션은 일반 로그인과 **완전히 분리된 쿠키**(`manager_admin`, 기본 30분)를 씁니다.
두 토큰은 서로를 대신할 수 없습니다.
모든 변경은 `admin_audit_log`에 `console:<아이디>` 행위자로 남습니다.

> 원본 저장소는 이 쿠키를 `Path=/manager`로 묶어 다른 서비스에 전달되지 않게 합니다.
> 루트에 붙으면 경로로 좁힐 수 없어 `Path=/`가 되고, 같은 오리진의 다른
> location(`/face/`, `/complex/` …)에도 전달됩니다. 모두 같은 서버의 내부 백엔드라
> 실질적인 위험은 낮지만, 격리가 필요하면 `basePath`를 `/manager`로 옮기고
> `web/vite.config.js`의 `BASE`도 함께 바꾸세요.

> **주의** — 이 계정 하나로 모든 관리자 계정을 만들고 지울 수 있습니다.
> 이 대시보드는 루트에 붙어 있으므로 기본 비밀번호를 두지 않았습니다.
> `superAdmin.passwordHash`가 비어 있으면 콘솔은 열리지 않습니다. (fail-closed)
> CLI와 달리 이 콘솔에는 "마지막 승인 계정 보호"가 없습니다 —
> 모두 승인 취소해도 설정 버튼으로 다시 들어와 되돌릴 수 있기 때문입니다.

### DB 장애 시 (비상용)

`auth.provider`를 `file`로 바꾸면 `config.json`의 `auth.users`로 로그인합니다.
평상시에는 쓰지 마세요. 비밀번호 해시가 설정 파일에 남습니다.

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
pm2 restart nginx-manager
```

### 데이터베이스 설정

```json
{
  "database": {
    "host": "127.0.0.1",
    "port": 3306,
    "user": "jyahn",
    "passwordFile": "./secrets/manager-db.pw",
    "name": "manager",
    "connectionLimit": 5
  }
}
```

비밀번호는 `config.json`에 두지 않고 파일에서 읽습니다.
환경 변수 `MANAGER_DB_PASSWORD`로도 덮어쓸 수 있습니다.

`http://127.0.0.1:28084/health`의 `details.database`에서 접속 상태를 확인할 수 있습니다.

```json
{ "configured": true, "ok": true, "database": "manager" }
```

## 설정 항목 (config.json)

| 항목 | 기본값 | 설명 |
|------|--------|------|
| `port` | `28084` | 리스닝 포트. `nginx-conf/service.ini`의 `ports`와 같아야 함 |
| `host` | `127.0.0.1` | 바인딩 주소. Nginx가 루프백으로 프록시하므로 기본은 외부 노출 없음 |
| `basePath` | `""` (루트) | 하위 경로로 옮기려면 `web/vite.config.js`의 `BASE`도 함께 바꿈 |
| `sessionSecret` | — | 세션 쿠키 서명 키. 비우면 `services/.session-secret`을 읽거나 새로 만듦 |
| `sessionTtlMinutes` | `120` | 세션 유효 시간 |
| `cookieSecure` | `true` | HTTPS 전용 쿠키. HTTP로 테스트할 때만 `false` |
| `servicesDir` | `..` | `*/nginx-conf/*.ini` 선언을 훑을 디렉토리 |
| `nginxStackPath` | `../../nginx/nginx-stack.conf` | listen 포트·TLS 등 서버 수준 설정 경로 |
| `ecosystemPath` | `../../pm2/ecosystem.config.js` | PM2 앱 목록을 읽어올 경로 |
| `healthTimeoutMs` | `3000` | `/health` 호출 타임아웃 |
| `pm2Enabled` | `true` | PM2 상태 수집 여부 |
| `auth.provider` | `db` | `db`(administrator 테이블) 또는 `file`(비상용) |
| `superAdmin.username` | `zoomon` | 관리자 콘솔 아이디 |
| `superAdmin.passwordHash` | — | `npm run hash-password`로 만든 `scrypt$…`. **필수** |
| `superAdmin.sessionTtlMinutes` | `30` | 관리자 콘솔 세션 유효 시간 |
| `database.host` / `port` | `127.0.0.1` / `3306` | MariaDB 주소 |
| `database.user` | `jyahn` | DB 계정 |
| `database.passwordFile` | `./secrets/manager-db.pw` | 비밀번호 파일 |
| `database.name` | `manager` | 사용할 스키마 |
| `database.connectionLimit` | `5` | 연결 풀 크기 |

환경 변수 `PORT`, `MANAGER_HOST`, `MANAGER_BASE_PATH`, `MANAGER_SESSION_SECRET`, `MANAGER_CONFIG`,
`MANAGER_DB_PASSWORD`, `MANAGER_SUPERADMIN_USERNAME`, `MANAGER_SUPERADMIN_PASSWORD`,
`MANAGER_SUPERADMIN_PASSWORD_HASH`로도 덮어쓸 수 있습니다.

## API

| 메서드 | 경로 | 인증 | 설명 |
|--------|------|------|------|
| `GET` | `/health` | — | manager 자체 상태 (루프백 포트로만 접근) |
| `POST` | `/api/login` | — | 로그인 / 승인 요청 (IP당 5회 실패 시 5분 차단) |
| `POST` | `/api/logout` | — | 로그아웃 |
| `GET` | `/api/me` | 필요 | 현재 세션 |
| `GET` | `/api/overview` | 필요 | 서비스·Nginx 전체 상태 |
| `GET` | `/api/services/:name/health` | 필요 | 개별 서비스 재확인 |
| `POST` | `/api/admin/login` | — | 관리자 콘솔 로그인 (IP당 5회 실패 시 10분 차단) |
| `POST` | `/api/admin/logout` | — | 관리자 콘솔 로그아웃 |
| `GET` | `/api/admin/me` | 콘솔 | 콘솔 세션 확인 |
| `GET` | `/api/admin/administrators` | 콘솔 | 관리자 목록 |
| `POST` | `/api/admin/administrators` | 콘솔 | 관리자 추가 |
| `PATCH` | `/api/admin/administrators/:id` | 콘솔 | 이메일·이름·권한·비밀번호·`approved` 수정 |
| `DELETE` | `/api/admin/administrators/:id` | 콘솔 | 관리자 삭제 |

"콘솔" 인증은 `manager_admin` 쿠키이며, 일반 로그인 세션(`manager_session`)으로는 통과하지 못합니다.
응답에 `password_hash`는 절대 포함되지 않습니다.

대시보드는 5초마다 `/overview`를 갱신하며, 헤더의 스위치로 자동 갱신을 끌 수 있습니다.

## 서비스 상태 판정 규칙

각 서비스는 `/health`에 아래 형태로 응답해야 합니다.

```json
{ "service": "face", "status": "ok", "uptimeSec": 120, "pid": 1234, "timestamp": "…" }
```

| 표시 | 조건 |
|------|------|
| 정상 (up) | 2xx 응답이고 `status`가 `ok`/`healthy`/`up`/`pass`/`ready`/`green` (또는 `status` 필드 없음) |
| 주의 (degraded) | 2xx 응답이지만 `status`가 그 외의 값 |
| 중단 (down) | 연결 실패 / 타임아웃 / 2xx 아닌 응답 |
| 알 수 없음 (unknown) | 헬스 URL을 만들 수 없음 (`PORT`/`HEALTH_URL` 없음) |

### 헬스 URL 결정 순서

1. `ecosystem.config.js`의 `env.HEALTH_URL`
2. 선언의 `protocol://host:port` + `health_path` (기본 `/health`)
3. `ecosystem.config.js`의 `env.PORT` → `http://127.0.0.1:<PORT>/health`

헬스 체크는 Nginx를 거치지 않고 백엔드에 직접 요청합니다.
선언이 없는(포트로 직접 접근하는) 서비스는 `ecosystem.config.js`의 env로 지정합니다.

```js
env: {
  PORT: 28099,
  HEALTH_URL: 'https://127.0.0.1:28099/health',
  HEALTH_INSECURE_TLS: 'true',   // 자체 서명 인증서일 때
  DASHBOARD_PATH: '/dashboard',  // 자체 관리 페이지가 있으면 목록에 링크가 생김
}
```

`PORT`(또는 `HEALTH_URL`의 포트)가 선언된 포트와 같으면 두 항목이 한 행으로 합쳐지고,
서비스 이름은 PM2 앱 이름을 따릅니다.
`DASHBOARD_PATH`는 선언의 `dashboard_path`와 같은 역할이며, 둘 다 있으면 PM2 쪽이 이깁니다.

## 개발 모드

```bash
cd services/manager/server && npm run dev     # API :28084
cd services/manager/web && npm run dev        # http://localhost:5183/ (API는 프록시됨)
```

브라우저에서 HTTP로 접속하게 되므로 개발 중에는 `config.json`의 `cookieSecure`를 `false`로 둡니다.
