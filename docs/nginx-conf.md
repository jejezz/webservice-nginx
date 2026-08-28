# `nginx-conf/` — 서비스가 선언하는 리버스 프록시 정보

각 서비스는 자기 디렉토리 아래에 `nginx-conf/` 폴더를 만들고,
자신에게 필요한 포트·프로토콜·라우트를 INI 로 적어 둡니다.

```
services/<서비스>/nginx-conf/service.ini
```

`nginx/generate_nginx_conf.py` 가 `services/*/nginx-conf/*.ini` 를 전부 읽어
하나의 nginx 설정을 만들고, manager 대시보드도 **같은 파일**을 읽어 서비스 목록을
만듭니다. 라우팅의 단일 진실 공급원이 `nginx.ini` 한 파일에서 각 서비스로
내려온 셈입니다.

> 폴더 안에 `.ini` 가 여러 개여도 됩니다 — 파일 이름순으로 모두 합쳐집니다.
> 한 디렉토리가 서비스 둘을 담을 때 씁니다.
> 스캔은 `services/*/nginx-conf/` **한 단계만** 하므로 하위 디렉토리에 둔 선언은
> 발견되지 않습니다.
> `pm2-conf/` 는 이 스캔의 대상이 아닙니다 — 라우팅 선언과 프로세스 정의는
> 분리합니다 ([pm2-conf.md](pm2-conf.md)).

## `[service]`

```ini
[service]
name        = ws-bridge
host        = 127.0.0.1
ports       = 28083
protocol    = http
health_path = /health
```

| 키 | 기본값 | 설명 |
|---|---|---|
| `name` | 폴더 이름 | 서비스 이름. `/health` 응답의 `service`, `pm2-conf` 의 `[app] name` 과 **모두 같아야** 합니다 |
| `host` | `127.0.0.1` | 백엔드 주소. 루프백에 묶어 두면 Nginx 를 우회한 직접 접근이 차단됩니다 |
| `ports` | — | 공백으로 구분. **두 개 이상이면 `least_conn` 로드밸런싱** 됩니다 |
| `protocol` | `http` | 백엔드와 말하는 프로토콜. `https` 면 TLS 검증을 건너뜁니다 (자체 서명 대응) |
| `health_path` | `/health` | 대시보드가 직접 호출할 경로 ([health-contract.md](health-contract.md)) |
| `dashboard_path` | — | 서비스 자체 관리 화면 경로. 있으면 대시보드에 링크 버튼이 생깁니다 |
| `enabled` | `true` | `false` 면 라우트를 만들지 않습니다 (서비스를 잠시 내릴 때) |

`enabled = false` 는 **선언을 지우지 않고 라우트만 끄는** 수단입니다.
지금 `nginx.ini` 에서 `;` 로 주석 처리해 둔 `route-a/b/c` 가 여기에 해당합니다.

## `[route:*]`

섹션 하나가 nginx `location` 블록 하나가 됩니다.

```ini
[route:main]
location  = /ws-bridge/
websocket = true
```

| 키 | 기본값 | 설명 |
|---|---|---|
| `location` | — | nginx location 지시자 그대로. `= /health`, `/manager`, `~ ^/x/(a\|b)$` 모두 가능 |
| `proxy_path` | (없음) | 백엔드에서의 경로. **비우면 원본 URI 가 그대로 전달됩니다** |
| `port` | (서비스의 `ports`) | **같은 데몬의 다른 입구.** 이 라우트만 이 포트로 보냅니다 (아래) |
| `websocket` | `false` | `true` 면 `Upgrade`/`Connection` 헤더를 넘깁니다 |
| `buffering` | `on` | `off` 면 SSE 용으로 버퍼링·캐시를 끄고 chunked 를 켭니다 |
| `timeout` | `120` | `proxy_send_timeout` / `proxy_read_timeout` (초) |
| `max_body` | (서버 기본) | `client_max_body_size`. 업로드가 큰 라우트에만 |
| `order` | `100` | 생성 순서. **정규식 location 은 순서대로 평가되므로** 먼저 걸려야 하는 것에 낮은 값을 줍니다 |

### `port` — 같은 데몬의 다른 입구

한 데몬이 포트를 여럿 여는 일이 있습니다. Janus 가 그렇습니다 — 같은 API 를
REST(8088)와 WebSocket(8188) 두 곳으로 냅니다.

```ini
[service]
name  = janus
ports = 8088                  ; 헬스는 늘 이 포트로 간다

[route:api]
location = /janus-api         ; → 8088

[route:ws]
location  = /janus-ws
port      = 8188              ; → 8188
websocket = true
```

**`[service]` 의 `ports` 에 8188 을 더하면 안 됩니다.** 거기 둘 이상을 적으면
`least_conn` 로드밸런싱이 됩니다. 그건 *"같은 것을 여러 벌 돌린다"* 는 뜻이고,
여기 필요한 것은 *"같은 데몬의 다른 입구"* 입니다.

`port` 를 쓰면 그 라우트만 별도 업스트림으로 나갑니다.

```nginx
upstream janus_backend    { server 127.0.0.1:8088 …; }
upstream janus_ws_backend { server 127.0.0.1:8188 …; }
```

**헬스는 영향을 받지 않습니다** — 헬스 URL 은 `[service]` 의 `ports[0]` 로
만들어지므로 그대로 8088 입니다. Janus 의 WS 트랜스포트는 평범한 HTTP GET 에
응답하지 않아서, 헬스가 그쪽으로 가면 대시보드에 영원히 "중단" 으로 뜹니다.
`port` 는 그 문제를 건드리지 않고 옆문만 여는 방법입니다.

### `proxy_path` 를 비워 두는 것이 현재의 기본

지금 `nginx.ini` 의 세 라우트는 모두 `proxy_pass http://127.0.0.1:PORT` 형태로,
**경로가 붙어 있지 않습니다.** 이 경우 nginx 는 location 접두사를 자르지 않고
원본 URI 를 그대로 백엔드에 넘깁니다. 그래서 manager 는 `basePath: "/manager"`,
ws-bridge 는 `/ws-bridge/...` 를 자기가 직접 해석합니다.

새 스키마에서 이 동작은 **`proxy_path` 를 비워 두는 것**에 해당합니다.
`proxy_path` 를 적으면 nginx 는 접두사를 잘라내고 그 경로를 앞에 붙이므로,
서비스 코드의 basePath 를 함께 바꾸지 않으면 404 가 납니다.

```ini
location   = /face/        # /face/foo
proxy_path = /api/v2/      # → /api/v2/foo   ✅

location   = /face/
proxy_path = /api/v2       # → /api/v2foo    ❌ 접두사 location 은 양쪽 다 / 로 끝나야 한다
```

정규식 location 에서는 캡처 그룹을 쓸 수 있습니다.

```ini
location   = ~ ^/x/(a|b)/events$
proxy_path = /api/$1/events
```

### 순서(`order`)를 신경 써야 하는 이유

nginx 의 location 선택 규칙은 이렇습니다.

1. `= ` 정확히 일치 → 즉시 결정
2. 접두사 중 **가장 긴 것**을 기억 (파일 순서 무관)
3. 정규식을 **적힌 순서대로** 검사 → 처음 걸리는 것 채택
4. 정규식이 하나도 안 걸리면 2번에서 기억한 접두사 사용

즉 접두사끼리는 순서가 상관없지만, **정규식끼리는 순서가 결과를 바꿉니다.**

## 충돌 검사

생성기는 서로 다른 서비스가 **같은 location 을 선언하면 오류를 내고 멈춥니다.**
조용히 덮어써서 한쪽 서비스가 죽는 것보다, 설정을 만들 때 터지는 편이 낫습니다.
서비스 이름과 upstream 이름의 중복도 같이 검사합니다.

```
ERROR: duplicate location '/manager'
  services/manager/nginx-conf/service.ini
  services/other/nginx-conf/service.ini
```

적용 전에 선언만 검사하려면 sudo 없이 다음을 씁니다.

```bash
./nginx/install_nginx_stack.sh --check
```

## 서버 수준 설정은 여기가 아니다 — `nginx/nginx-stack.conf`

TLS, listen 포트처럼 **서비스 하나에 속하지 않는 값**은 `nginx-stack.conf` 가
가집니다. 지금 `nginx.ini` 의 `[server]` 섹션이 그대로 여기로 옵니다.

```ini
[general]
server_name  = localhost
listen_port  = 80
ssl_port     = 443
; client_max_body_size. 비우면 지시자를 만들지 않는다(= nginx 기본값 1m).
max_body     =
; nginx-conf/ 를 찾아 훑을 디렉토리. 이 파일 기준 상대 경로.
services_dir = ../services

; 루트 '/' 접속 시 302 로 보낼 곳. 비우면 리다이렉트하지 않는다.
default_route = /manager

; 공유기 포트 포워딩. 외부 28080 -> 내부 80, 외부 28443 -> 내부 443.
; HTTP 로 들어온 외부 요청을 HTTPS 로 보낼 때 목적지 포트를 알아야 해서 필요하다.
public_http_port  = 28080
public_https_port = 28443

[tls]
cert_dir      = ./cert
cert_file     = server/server.crt
key_file      = server/server.key
; mTLS. 클라이언트 인증서 검증. 비우면 검증 블록을 만들지 않는다.
client_ca     = ca/ca.crt
verify_client = optional
```

`default_route`, `public_*_port`, `client_ca`/`verify_client` 는 참조 저장소
(`webservices-nginx`)의 생성기에는 **없는 키**입니다. 이 서버는 셋 다 실제로
쓰고 있으므로 생성기와 템플릿을 확장해서 추가합니다
([migration-plan.md](migration-plan.md) 4단계).

생성되는 설정에는 이 값들 외에 `absolute_redirect off` 와 `error_page 497` 도
고정으로 들어갑니다. 포트 포워딩 환경에서 리다이렉트 목적지가 443 으로
바뀌는 것을 막는 장치라 빠지면 외부 접속이 끊깁니다.

**location 이나 upstream 을 `nginx-stack.conf` 에 직접 적지 마세요** — 생성기가
덮어씁니다. 경로를 바꾸려면 그 서비스의 `nginx-conf/service.ini` 를 고칩니다.

## 서비스를 새로 붙일 때

1. `services/<이름>/nginx-conf/service.ini` 를 씁니다.
2. `services/<이름>/pm2-conf/app.ini` 를 씁니다 ([pm2-conf.md](pm2-conf.md)).
3. `/health` 를 [규약](health-contract.md)대로 구현합니다.
4. `./nginx/install_nginx_stack.sh --check` 로 선언을 검사합니다.
5. `sudo ./nginx/install_nginx_stack.sh --skip-install` 로 반영합니다.
6. `cd pm2 && pm2 start ecosystem.config.js --only <이름> && pm2 save`

대시보드에는 따로 등록할 게 없습니다 — 같은 파일을 읽으므로 자동으로 나타납니다.

선언이 있어도 프로세스가 안 떠 있으면 그 경로는 **502** 입니다. 둘은 별개입니다.
