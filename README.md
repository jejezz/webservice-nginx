# WebServices

이 서버가 웹으로 제공하는 것들을 한 곳에 모아 둔 디렉토리입니다.
역할에 따라 나뉩니다.

```
webservices/
├── docs/        # 서비스 사이의 약속 — nginx-conf / pm2-conf 스키마, /health 규약
├── nginx/       # 리버스 프록시 서버 설정과 인증서 (systemd 가 nginx 자체를 관리)
├── pm2/         # 프로세스 오케스트레이션 — 선언 스캐너, 부팅 스크립트, 로그
├── database/    # MariaDB — database/README.md
└── services/    # 서비스 코드. 하나의 서비스 = 하나의 디렉토리
    ├── manager/                # 관리 대시보드        /manager      (28084)
    ├── ws-bridge/              # WebSocket Bridge     /ws-bridge/   (28083)
    ├── stock-analyzer/         # 주식 차트·예측       /stock-analyzer (28085)
    ├── route-a|route-b|route-c/# 예제 서비스          (라우트 꺼 둠) (28080~28082)
    └── rtc-relay-server/       # rtc-relay-server     /rtc-relay/   (28099, 자체 HTTPS)
```

경계는 이렇습니다.

| 디렉토리 | 담는 것 | 담지 않는 것 |
|---|---|---|
| `docs/` | 서비스가 지켜야 할 규약 | 특정 서비스의 사정 |
| `nginx/` | TLS·listen 포트 등 서버 수준 설정, 인증서 | 라우팅(각 서비스가 선언), 서비스 코드 |
| `pm2/` | 스캐너, 부팅 스크립트, 로그 | 앱 정의(각 서비스가 선언), 서비스 코드 |
| `services/` | 서비스별 소스와 각자의 선언 | 오케스트레이션 설정 |

## 서비스는 자기를 스스로 선언한다

서비스 하나가 자기 디렉토리 안에 선언 둘을 둡니다.

```
services/<서비스>/
├── nginx-conf/service.ini   # 어떤 경로로 들어오는가 (포트·라우트)
└── pm2-conf/app.ini         # 어떻게 띄우는가 (script·env)
```

nginx 생성기와 manager 대시보드가 **같은** `nginx-conf` 를 읽고, pm2 가
`pm2-conf` 를 읽습니다. 중앙 파일(`nginx.ini`, `ecosystem.config.js`)에 손댈 일이
없어지고, 서비스를 옮기거나 지울 때 선언이 함께 따라갑니다.
`services/manager` 처럼 독립 git 저장소인 디렉토리는 자기 라우팅·프로세스 정의를 자기 저장소에 커밋하게 됩니다.

둘은 별개입니다 — **선언이 있어도 프로세스가 안 떠 있으면 그 경로는 502** 입니다.

## 자주 하는 일

라우팅 선언을 바꾼 뒤 nginx 에 반영합니다.

```bash
sudo ./nginx/install_nginx_stack.sh --skip-install
```

반영 전에 선언만 검사합니다 (sudo 불필요). 포트나 location 이 겹치면 설정을 쓰지
않고 종료하므로, 잘못된 선언이 nginx 까지 가지 않습니다.

```bash
./nginx/install_nginx_stack.sh --check
node pm2/ecosystem.config.js --check
```

프로세스를 띄웁니다.

```bash
cd pm2 && pm2 start ecosystem.config.js && pm2 save
```

상태를 봅니다.

```bash
pm2 list
systemctl is-active nginx
curl -sk -o /dev/null -w '%{http_code}\n' https://127.0.0.1/manager
```

`502` 면 nginx 설정은 맞는데 뒤에 프로세스가 없다는 뜻입니다.

## 서로를 가리키는 방법

절대 경로는 **사용자 crontab 의 `@reboot` 줄 하나뿐**입니다. 나머지는 모두
스크립트 자기 위치 기준의 상대 경로이므로, `webservices/` 를 옮기면 그 한 줄과
pm2 등록(`pm2 delete` 후 재등록)만 손보면 됩니다.

| 참조 | 경로 |
|---|---|
| nginx 생성기 → 서비스 선언 | `services/*/nginx-conf/*.ini` |
| pm2 스캐너 → 서비스 선언 | `services/*/pm2-conf/*.ini` |
| manager → 라우팅 | `nginx/nginx-stack.conf` (의 `services_dir`) |
| manager → PM2 앱 목록 | `pm2/ecosystem.config.js` |
| nginx 가 읽는 인증서 | `nginx/cert/server/server.{crt,key}` |
| 공유 세션 시크릿 | `services/.session-secret` (600, 커밋 금지) |

## 로그인 세션 공유 (SSO)

서비스마다 로그인을 따로 두지 않습니다. manager 에서 한 번 로그인하면 모든 서비스
대시보드를 쓸 수 있습니다.

- 세션 쿠키(`manager_session`)는 HMAC 서명 토큰이며 `Path=/` 로 발급됩니다.
- 서명 키는 `services/.session-secret` 파일 하나를 manager 와 각 서비스가 공유합니다.
- 서비스는 이 쿠키를 **검증만** 합니다. 계정 관리는 manager 한 곳에서 합니다.

## 어디서부터 읽을지

- 라우팅을 바꾸려면 → 그 서비스의 `nginx-conf/service.ini` ([스키마](docs/nginx-conf.md))
- 프로세스를 추가·수정하려면 → 그 서비스의 `pm2-conf/app.ini` ([스키마](docs/pm2-conf.md))
- 서버 수준 설정(listen 포트·TLS·mTLS·인증서) → [nginx/README.md](nginx/README.md)
- 기동·부팅 복원·문제 해결 → [pm2/README.md](pm2/README.md)
- `/health` 응답 형식 → [docs/health-contract.md](docs/health-contract.md)
- **모바일·브라우저 클라이언트를 만들려면** → [docs/client-guide.md](docs/client-guide.md)
- 대시보드와 로그인 → [services/manager/README.md](services/manager/README.md)
- 데이터베이스 → [database/README.md](database/README.md)
- 이 구조로 옮긴 과정 → [docs/migration-plan.md](docs/migration-plan.md)

서비스별 상세는 각 디렉토리의 README 에 있습니다
([ws-bridge](services/ws-bridge/README.md),
[stock-analyzer](services/stock-analyzer/README.md),
[rtc-relay-server](services/rtc-relay-server/ReadMe.md)).
