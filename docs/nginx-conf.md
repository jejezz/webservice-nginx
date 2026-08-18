# `nginx-conf/` — 서비스가 선언하는 리버스 프록시 정보

각 서비스는 자기 디렉토리 아래에 `nginx-conf/` 폴더를 만들고,
자신이 필요한 포트·프로토콜·라우트를 INI 로 적어 둡니다.

```
services/<서비스>/nginx-conf/service.ini
```

nginx 쪽 생성기가 `services/*/nginx-conf/*.ini` 를 전부 읽어
`/etc/nginx/conf.d/path-routing.conf` 를 만들고,
manager 대시보드도 **같은 파일**을 읽어 서비스 목록을 만듭니다.
라우팅의 단일 진실 공급원이 서비스 쪽으로 내려온 셈입니다.

> 폴더 안에 `.ini` 파일이 여러 개여도 됩니다. 파일 이름순으로 모두 합쳐집니다.
> 한 디렉토리가 서비스 둘을 담을 때 씁니다 — `apartment-mgmt-server/nginx-conf/`
> 에 `service.ini`(/complex/*)와 `cassini.ini`(/cassini/)가 함께 있습니다.
> 스캔은 `services/*/nginx-conf/` **한 단계만** 하므로, 하위 디렉토리에 둔
> 선언은 발견되지 않습니다.
> `pm2/` 는 스캔 대상이 아닙니다 — 프로세스 정의와 라우팅 선언은 분리합니다.

## `[service]`

```ini
[service]
name        = huygens-server
host        = 127.0.0.1
ports       = 28092
protocol    = http
health_path = /health
```

| 키 | 기본값 | 설명 |
|---|---|---|
| `name` | 폴더 이름 | 서비스 이름. `/health` 응답의 `service` 와 같아야 합니다 |
| `host` | `127.0.0.1` | 백엔드 주소 |
| `ports` | — | 공백으로 구분. **두 개 이상이면 `least_conn` 로드밸런싱** 됩니다 |
| `protocol` | `http` | 백엔드와 말하는 프로토콜. `https` 면 TLS 검증을 건너뜁니다 (자체 서명 대응) |
| `health_path` | `/health` | 대시보드가 직접 호출할 경로 |
| `dashboard_path` | — | 서비스 자체 관리 화면 경로. 있으면 대시보드에 링크 버튼이 생깁니다 |
| `enabled` | `true` | `false` 면 라우트를 만들지 않습니다 (서비스를 잠시 내릴 때) |

## `[route:*]`

섹션 하나가 nginx `location` 블록 하나가 됩니다.

```ini
[route:client]
location   = /complex/client/
proxy_path = /api/client/
websocket  = true
```

| 키 | 기본값 | 설명 |
|---|---|---|
| `location` | — | nginx location 지시자 그대로. `= /health`, `/face/`, `~ ^/x/(a\|b)$` 모두 가능 |
| `proxy_path` | (없음) | 백엔드에서의 경로. 비우면 원본 URI 가 그대로 전달됩니다 |
| `websocket` | `false` | `true` 면 `Upgrade`/`Connection` 헤더를 넘깁니다 |
| `buffering` | `on` | `off` 면 SSE 용으로 버퍼링·캐시를 끄고 chunked 를 켭니다 |
| `timeout` | `120` | `proxy_send_timeout` / `proxy_read_timeout` (초) |
| `max_body` | (서버 기본) | `client_max_body_size`. 업로드가 큰 라우트에만 |
| `order` | `100` | 생성 순서. **정규식 location 은 순서대로 평가되므로** 먼저 걸려야 하는 것에 낮은 값을 줍니다 |

### `proxy_path` 와 슬래시

nginx 는 `proxy_pass` 에 경로가 붙어 있으면 location 접두사를 잘라내고 그 경로를 앞에 붙입니다.
그래서 접두사 location 에는 **양쪽 다 슬래시로 끝나야** 합니다.

```ini
location   = /face/        # /face/foo
proxy_path = /api/v2/      # → /api/v2/foo   ✅

location   = /face/
proxy_path = /api/v2       # → /api/v2foo    ❌
```

정규식 location 에서는 캡처 그룹을 쓸 수 있습니다.

```ini
location   = ~ ^/complex/client/(resident|security|public)/events$
proxy_path = /api/client/$1/events
```

### 순서(`order`)를 신경 써야 하는 이유

nginx 의 location 선택 규칙은 이렇습니다.

1. `= ` 정확히 일치 → 즉시 결정
2. 접두사 중 **가장 긴 것**을 기억 (파일 순서 무관)
3. 정규식을 **적힌 순서대로** 검사 → 처음 걸리는 것 채택
4. 정규식이 하나도 안 걸리면 2번에서 기억한 접두사 사용

즉 접두사끼리는 순서가 상관없지만, **정규식끼리는 순서가 결과를 바꿉니다.**
SSE 처럼 더 일반적인 라우트보다 먼저 걸려야 하는 것은 `order` 를 낮게 주세요.

## 충돌 검사

생성기는 서로 다른 서비스가 **같은 location 을 선언하면 오류를 내고 멈춥니다.**
조용히 덮어써서 한쪽 서비스가 죽는 것보다, 설정을 만들 때 터지는 편이 낫습니다.

```
ERROR: duplicate location '/cassini/'
  services/apartment-mgmt-server/nginx-conf/service.ini
  services/apartment-mgmt-server/nginx-conf/cassini.ini
```

## 서비스를 새로 붙일 때

1. `services/<이름>/nginx-conf/service.ini` 를 씁니다.
2. `/health` 를 [규약](health-contract.md)대로 구현합니다.
3. `pm2/ecosystem.config.js` 에 프로세스를 등록합니다.
4. `sudo nginx/install_nginx_stack.sh --skip-install` 를 돌립니다.

대시보드에는 따로 등록할 게 없습니다 — 같은 파일을 읽으므로 자동으로 나타납니다.
