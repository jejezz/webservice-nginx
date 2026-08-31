# WebServices

이 서버가 웹으로 제공하는 것들을 한 곳에 모아 둔 디렉토리입니다.
역할에 따라 나뉩니다.

지금 이 저장소의 중심은 **아파트 인터폰·월패드·모바일을 잇는 통화 시스템**입니다.
네 서비스가 한 몸처럼 움직입니다.

```
인터폰 ──SIP──▶ Kamailio ──▶ Janus ──WebRTC──▶ 모바일 앱
                    │                              ▲
                    └── websocket-relay ──FCM──────┘   자는 단말을 깨운다
                        (등록·승인·초인종 중계)
```

번호 체계와 세 서비스가 같은 단말을 가리키는 방법은
[docs/identity.md](docs/identity.md) 에 있습니다.

## 동작 환경

**기준은 Ubuntu 22.04 입니다.** 24.04 로 옮기는 중이고, 22.04 로 돌고 있는 것을
끄는 시점은 아직 정하지 않았습니다. 그래서 브랜치를 나눕니다.

| 브랜치 | 무엇이 사는가 |
|---|---|
| `master` | **OS 중립인 것 전부.** 수정은 원칙적으로 여기에 하고 아래로 merge 합니다 |
| `release/22.04` | 22.04 에서만 다른 것 + 지금 돌고 있는 것의 수정 |
| `release/24.04` | 24.04 에서만 다른 것 |

가르는 기준은 하나입니다 — **다른 OS 에서도 참이면 `master`**, 이 OS 에서만
참이면 그 `release/*`. `master` 에 해 두면 다른 쪽으로 자동으로 따라갑니다.

| | 22.04 | 24.04 |
|---|---|---|
| MariaDB | 10.6 | 10.11 |
| nginx | 1.18 | 1.24 |
| Kamailio | 5.5.4 | 5.7.4 |
| rtpengine | 배포판에 없음 | 11.5.1 |
| rtpproxy | 있음 | **없음** |
| Janus | 양쪽 다 `/opt/janus` 소스 빌드 | |

Node.js 는 **20 이상**이 필요합니다 (`fetch` · `AbortSignal.timeout`). 배포판
기본값은 22.04 가 v12, 24.04 가 v18 이라 **어느 쪽이든 NodeSource 나 nvm 이
필요합니다.**

> ⚠️ **24.04 에서는 둘이 먼저 걸립니다.**
>
> - `rtpproxy` 가 24.04 저장소에 **없습니다.** 아래 '전부 멈추기' 의 `systemctl`
>   명령이 실패합니다. 대신 `rtpengine` 이 배포판에 들어와 있어, 저장소가 원래
>   가려던 쪽(`rtpengine.conf` · `WITH_RTPENGINE`)이 오히려 쉬워집니다
> - Kamailio 가 **5.7** 입니다. 이 저장소의 `kamailio.cfg` 는 5.5 기준이라
>   **아직 검증되지 않았습니다**
>
> 이 문서와 [docs/clean-install-test.md](docs/clean-install-test.md) 는 22.04 를
> 전제로 쓰여 있습니다. 차이표와 옮기는 순서는
> [docs/unify-plan.md](docs/unify-plan.md) 의 '서버 환경' 절에 있습니다.

## 처음이라면 — 여기서 시작하세요

```bash
git clone https://github.com/jejezz/webservice-nginx.git webservices
cd webservices
./bootstrap.sh
```

그러면 관리 대시보드가 뜨고, 마지막에 **구축 마법사 주소**를 알려 줍니다.

```
http://127.0.0.1:28084/manager/setup
```

나머지는 그 화면이 순서대로 안내합니다 — 사이트 값 → DB → pm2 → Kamailio →
Janus → nginx → 릴레이 → 시험 통화까지 19단계입니다. 각 단계는 **무엇을 왜
하는지**와 점검 결과를 함께 보여 주고, 끝났는지는 기계가 판정합니다.

- `./bootstrap.sh --check` — 아무것도 바꾸지 않고 무엇이 준비됐는지만 봅니다
- **`bootstrap.sh` 는 sudo 를 쓰지 않습니다.** 필요한 자리에서는 실행할 명령을
  보여 주고 멈춥니다. 남의 장비에 root 로 무엇을 했는지 모르는 상태를 만들지
  않기 위해서입니다
- 이미 설치된 장비에서 다시 돌려도 안전합니다

> 전체 설치가 무엇을 어떤 순서로 하는지는 [docs/setup-wizard.md](docs/setup-wizard.md),
> 여러 서비스가 함께 쓰는 값은 [site/README.md](site/README.md) 를 보세요.
>
> **이 길이 실제로 통하는지 증명하려면** 빈 장비에서 처음부터 끝까지 돌려 봐야
> 합니다 — 절차와 기록표가 [docs/clean-install-test.md](docs/clean-install-test.md)
> 에 있습니다.

```
webservices/
├── bootstrap.sh # 클론 직후 여기서 시작 (위 '처음이라면')
├── site/        # 여러 서비스가 함께 쓰는 값 — 호스트·단지 ID·SIP 도메인
├── docs/        # 서비스 사이의 약속 — nginx-conf / pm2-conf 스키마, /health 규약
├── lib/         # 여러 스크립트가 공유하는 셸 조각 (점검 보고·설정 읽기)
├── nginx/       # 리버스 프록시 서버 설정과 인증서 (systemd 가 nginx 자체를 관리)
├── pm2/         # 프로세스 오케스트레이션 — 선언 스캐너, 부팅 스크립트, 로그
├── database/    # MariaDB — database/README.md
└── services/    # 서비스 코드. 하나의 서비스 = 하나의 디렉토리
    ├── manager/         # 관리 대시보드·구축 마법사   /manager    (28084)
    ├── websocket-relay/ # 등록·승인·초인종·착신 푸시  /relay/     (28099)
    ├── kamailio/        # SIP 레지스트라·프록시       /kamailio/  (28086 · SIP 5060)
    ├── janus/           # WebRTC ↔ SIP 게이트웨이     /janus/     (28087 · API 8088)
    └── route-a|b|c/     # 예제 서비스 (라우트 꺼 둠)              (28080~28082)
```

> `services/ws-bridge` 와 `services/stock-analyzer` 는 **별도 저장소**라 클론에
> 따라오지 않습니다. 그 자리에 두면 스캐너가 알아서 줍습니다.
>
> Kamailio 와 Janus 는 pm2 가 아니라 **systemd** 가 띄웁니다(각자의 `install.sh`).
> 위 포트는 그 서비스의 **대시보드**이고, 프로토콜 포트는 따로입니다.

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

서비스를 하나 더 붙이는 절차와, **아직 손으로 고쳐야 하는 자리 셋**은
[docs/adding-a-service.md](docs/adding-a-service.md) 에 있습니다.

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
systemctl is-active nginx kamailio janus     # 뒤 둘은 pm2 가 아니라 systemd 입니다
curl -sk -o /dev/null -w '%{http_code}\n' https://127.0.0.1/manager
```

`502` 면 nginx 설정은 맞는데 뒤에 프로세스가 없다는 뜻입니다.

서비스마다 **자기 점검 스크립트**가 있습니다. 마법사가 보는 것과 같은 판정이고,
sudo 없이 돌아갑니다 — 무엇이 왜 안 되는지는 대개 여기서 나옵니다.

```bash
./site/apply.sh                          # 사이트 값 (호스트·단지 ID·SIP 도메인)
./database/check-database.sh             # DB·스키마
./services/kamailio/check-accounts.sh    # SIP 계정
./services/kamailio/check-push.sh        # 인터폰 착신 네 자리
./services/janus/install.sh              # Janus 설정·미디어 포트·단말 토큰
./services/janus/verify-call.sh          # 마지막 시험 통화 결과 (--run 이면 실제로 걸어 봅니다)
./services/websocket-relay/check-relay.sh
./nginx/install_nginx_stack.sh --check
```

## 전부 멈추기 — 자동 시작을 끄고 손으로만 띄우기

장비를 다른 일에 쓰거나, 재부팅해도 아무것도 안 뜨게 하고 싶을 때입니다.
**부팅에 걸려 있는 것은 둘**입니다.

| 무엇 | 어디에 | 무엇을 띄우나 |
|---|---|---|
| `pm2 resurrect` | 사용자 crontab 의 `@reboot` → `pm2/pm2-boot.sh` | manager · websocket-relay · 각 대시보드 등 pm2 앱 |
| systemd | `nginx` · `kamailio` · `janus` · `rtpproxy` · `mariadb` | 프록시·SIP·게이트웨이·미디어·DB |

### 멈추기

```bash
# ① pm2 — 지금 멈추고, **저장 목록을 비웁니다**
pm2 stop all
pm2 delete all
pm2 save                    # ← 이걸 빠뜨리면 재부팅 때 resurrect 가 되살립니다

# ② 부팅 훅 — 목록이 비었으면 그대로 둬도 아무것도 안 뜹니다.
#    확실히 하려면 그 줄을 지우거나 앞에 # 를 붙이세요.
crontab -e                  # @reboot ... pm2-boot.sh 줄

# ③ systemd — 지금 멈추고 부팅 등록도 뗍니다
sudo systemctl disable --now nginx kamailio janus rtpproxy
sudo systemctl disable --now mariadb        # DB 까지 멈출 때만
```

> `pm2 save` 를 빠뜨리는 것이 가장 흔한 실수입니다. `pm2 delete all` 만 하면
> 지금은 조용하지만 **재부팅하면 옛 목록이 그대로 되살아납니다.**
>
> `rtpproxy` 는 sysv 스크립트라 `disable` 이 `systemd-sysv-install` 로 넘어간다는
> 안내를 찍습니다 — 정상입니다.
>
> **`mariadb` 를 멈추면 manager 로그인도 안 됩니다** (계정이 DB 에 있습니다).
> 대시보드를 계속 쓰려면 DB 는 남겨 두세요.

### 멈췄는지 확인

```bash
pm2 list                                     # 비어 있어야 합니다
systemctl is-enabled nginx kamailio janus    # 전부 disabled
ss -lntp | grep -E ':(80|443|28084|28099|8088)'   # 아무것도 안 나와야 합니다
```

### 다시 손으로 띄우기

```bash
sudo systemctl start mariadb nginx kamailio janus rtpproxy
cd pm2 && pm2 start ecosystem.config.js && pm2 save
```

특정 서비스만 띄우려면 `--only` 를 씁니다.

```bash
cd pm2 && pm2 start ecosystem.config.js --only manager
```

### 다시 자동으로 뜨게

```bash
sudo systemctl enable nginx kamailio janus rtpproxy mariadb
crontab -e     # @reboot 줄을 되살립니다 (원문 만드는 법은 pm2/README.md)
cd pm2 && pm2 start ecosystem.config.js && pm2 save
```

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
- `WebServices` 저장소와 하나로 합치는 계획 → [docs/unify-plan.md](docs/unify-plan.md)

통화 시스템을 다룬다면 이쪽입니다.

- **번호 체계** (동/호 → SIP 번호, 세 서비스가 같은 단말을 가리키는 법) → [docs/identity.md](docs/identity.md)
- 앱·월패드·인터폰을 고칠 때 → [docs/client-migration.md](docs/client-migration.md)
- 단말 등록과 승인 흐름 → [services/websocket-relay/docs/enrollment.md](services/websocket-relay/docs/enrollment.md)
- 인터폰 착신이 자는 폰을 깨우는 길 → [services/kamailio/docs/incoming-call.md](services/kamailio/docs/incoming-call.md)

서비스별 상세는 각 디렉토리의 README 에 있습니다 —
[websocket-relay](services/websocket-relay/ReadMe.md) ·
[kamailio](services/kamailio/README.md) ·
[janus](services/janus/README.md) ·
[manager](services/manager/README.md).
`ws-bridge` 와 `stock-analyzer` 는 각자의 저장소에 있습니다.
