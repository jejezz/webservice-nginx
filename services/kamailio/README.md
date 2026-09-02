# Kamailio — 설치·운영·문제 해결

SIP 로 붙는 Kamailio 서버에 관한 것을 모아 둔 디렉토리입니다.

이 문서는 **위에서 아래로 읽으면 빈 장비에서 동작하는 상태까지 가도록** 되어 있습니다.
단계마다 번호를 붙였으니 "3-2 까지 했다" 처럼 가리키면 됩니다.

| | |
|---|---|
| 처음 세운다 | [설치](#설치) 를 0 부터 순서대로 |
| 이미 세워져 있다 | [운영](#운영) |
| 안 된다 | [문제 해결](#문제-해결) |
| 왜 이렇게 되어 있나 | [배경](#배경) |

```
설치 순서 (자세한 것은 아래 표)

  0 사전 조건 → 1 패키지·그룹 → 2 데이터베이스 → 3 장비 값(settings.ini)
    → 4 Kamailio 설정 설치 → 5 SIP over WebSocket(선택)
    → 6 대시보드 빌드 → 7 pm2 등록 → 8 SIP 계정 → 9 마지막 점검
```

## 이 디렉토리가 담는 것

**서비스 둘**을 담습니다. 규약이 허용하는 형태입니다
([nginx-conf.md](../../docs/nginx-conf.md) 의 "폴더 안에 `.ini` 가 여러 개여도 됩니다").

| 서비스 | 무엇 | 포트 | 띄우는 주체 |
|---|---|---|---|
| `kamailio` | SIP 서버 자체 | 5060(UDP/TCP) · 5080(WS) | **systemd** |
| `kamailio-dashboard` | 관찰용 웹 | 28086 | **pm2** |

```
services/kamailio/
├── README.md               이 문서 — 설치 순서, 운영, 문제 해결
├── accounts.md             SIP 계정 등록·삭제 (kamctl / SQL)
│
│   ── 스크립트 (설치 순서대로) ──
├── bootstrap.sh            ① 패키지 · kamailio 그룹 · 전체 점검
├── install.sh              ④ 인증 · 도메인 · 리스너 · 착신 푸시 훅 설치 / 되돌리기
├── setup-websocket.sh      ⑤ SIP over WebSocket 점검 · 패키지 · 설정 적용
├── setup-dashboard.sh      ⑥ 대시보드 점검(그룹·FIFO·프로세스·빌드) · 빌드
├── check-accounts.sh       ⑧ SIP 계정이 등록될 수 있는 모양인지 확인 (sudo 불필요)
├── check-push.sh           착신 푸시가 붙을 준비가 됐는지 확인 (sudo 불필요)
│
│   ── 설정 ──
├── settings-schema.json    장비마다 다른 값의 정의 (커밋함)
├── settings.ini            그 값 (커밋하지 않음 — 구축 마법사나 편집기가 씀)
├── kamailio.cfg            배포판 설정의 포크 — 착신 푸시 훅 (install.sh 가 설치)
├── kamailio-local.cfg      /etc/kamailio/ 오버라이드 — digest 인증 (install.sh)
├── kamailio-websocket.cfg  /etc/kamailio/ 오버라이드 — WS 전송 (setup-websocket.sh)
├── rtpengine.conf          미디어 릴레이 데몬 설정 원본 (아직 도입 전)
│
│   ── 규약 선언 ──
├── nginx-conf/
│   ├── service.ini         kamailio            — SIP over WS (5080, systemd)
│   └── dashboard.ini       kamailio-dashboard  — 관찰용 웹 (28086, pm2)
├── pm2-conf/
│   ├── app.ini             kamailio — 껍데기. systemd 가 띄운다
│   ├── dashboard.ini       kamailio-dashboard — 진짜 프로세스
│   └── not-managed-by-pm2.sh
├── schema/
│   └── 001-auth.sql        subscriber·version 테이블 (database.ini 가 적용)
│
│   ── 대시보드 ──
├── server/                 관찰용 대시보드 — Node
│   └── src/rpc.js            Kamailio JSON-RPC 클라이언트 (FIFO)
├── web/                    대시보드 프런트 — React 18 + Vite + Tailwind + shadcn/ui
│
└── docs/
    ├── incoming-call.md    인터폰 → 모바일 착신 (FCM 으로 단말 깨우기)
    ├── mobile-transport.md 모바일을 무엇으로 붙일 것인가 — 확인한 것과 정한 것
    ├── websocket-plan.md   SIP over WSS 계획 — ⛔ 채택 안 됨 (모바일도 Janus 로)
    └── alternatives.md     Asterisk 를 다시 검토하게 될 때 (판단 보류 기록)
```

---

# 설치

전체를 훑어보는 표입니다. 각 단계의 자세한 내용은 아래에 이어집니다.

| | 단계 | 명령 | 확인 |
|---|---|---|---|
| **0** | 사전 조건 — Janus 가 digest 를 처리 | ✅ 완료 (할 일 없음) | |
| **1** | 패키지 · kamailio 그룹 | `sudo ./bootstrap.sh --install` | **다시 로그인** |
| **2** | 데이터베이스 | `cd database && sudo ./setup_mariadb.sh` | `kamailio.version` |
| **3** | 이 장비의 값 | `/manager/setup` 의 폼, 또는 `--init` 로 뼈대 | `./install.sh` |
| **4** | Kamailio 설정 설치 | `sudo ./install.sh --apply` | `systemctl status kamailio` |
| **5** | SIP over WebSocket *(선택)* | `sudo ./setup-websocket.sh --enable` | `./setup-websocket.sh` |
| **6** | 대시보드 빌드 | `./setup-dashboard.sh --build` | `./setup-dashboard.sh` |
| **7** | pm2 등록 | `pm2 kill` 후 재기동 | `pm2 list` |
| **8** | SIP 계정 등록 | `sudo /usr/sbin/kamctl add …` | `./check-accounts.sh` |
| **9** | 마지막 점검 | `./bootstrap.sh` | 전부 초록 |

`./bootstrap.sh` 는 **아무것도 바꾸지 않고** 지금 어디까지 됐는지 알려 주며, 남은 것이
있으면 이 순서를 그대로 출력합니다. 막히면 언제든 이것부터 실행하세요.

```bash
./bootstrap.sh
```

> **1 다음에는 반드시 다시 로그인해야 합니다.** 보조 그룹은 로그인할 때 정해지므로,
> `usermod` 만 하고 pm2 를 재시작하면 7 단계에서 대시보드가 Kamailio 에 닿지 못합니다.
> 이 함정은 [7. pm2 등록](#7-pm2-등록) 에 자세히 적어 두었습니다.

데이터베이스는 `database/database.ini` 가 소유하고, Kamailio 설정은 `install.sh` 가
담당합니다. `kamdbctl create` 는 쓰지 않습니다 — 그러면 DB 가 프로젝트 관리 밖에 놓입니다.

## 0. 사전 조건 — Janus 가 digest 를 처리 ✅ 완료

인증을 켜면 Kamailio 가 401 로 challenge 를 보냅니다. 그 응답은 **Janus 의 SIP
플러그인**이 합니다 — 브라우저는 `register` 요청에 계정과 비밀번호만 담아 보내고,
digest 주고받기는 플러그인이 Kamailio 와 직접 합니다.
(`services/janus/janus.plugin.sip.jcfg`)

계정을 소유하는 것은 그 플러그인이 아닙니다. 계정은 이 디렉토리의 `subscriber`
테이블에 있고, websocket-relay 가 단말 승인 시점에 발급합니다
(`services/websocket-relay` 의 `libs/sipAccount.js`, [docs/identity.md](../../docs/identity.md)).

## 1. 패키지 · kamailio 그룹

**1-1.** 지금 무엇이 있고 무엇이 없는지 봅니다. 아무것도 바꾸지 않습니다.

```bash
cd services/kamailio
./bootstrap.sh
```

**1-2.** 패키지 4개와 그룹을 넣습니다. 설정과 실행 중인 서비스는 건드리지 않습니다.

```bash
sudo ./bootstrap.sh --install
```

| 패키지 | 무엇에 필요한가 |
|---|---|
| `kamailio` | SIP 서버 본체 |
| `kamailio-mysql-modules` | `db_mysql` — 계정(`subscriber`) 조회, digest 인증 |
| `kamailio-websocket-modules` | `websocket` — SIP over WebSocket |
| `kamailio-utils-modules` | `http_client` — 착신 푸시 요청 (websocket-relay 호출) |

그리고 `sudo usermod -aG kamailio <pm2 를 돌리는 사용자>` 를 실행합니다. 대시보드가
Kamailio 의 RPC FIFO 를 읽으려면 이 그룹이 필요합니다.

**1-3. ⚠️ 여기서 다시 로그인하세요.** 이 한 줄을 건너뛰면 6·7 단계에서 대시보드가
"Kamailio 에 닿지 않습니다" 를 띄웁니다. 이유는 [7. pm2 등록](#7-pm2-등록) 에 있습니다.

## 2. 데이터베이스

> 이 단계는 `database/` 가 소유합니다. `install.sh` 는 관여하지 않고 결과만 확인합니다.
> `setup_mariadb.sh` 는 `database.ini` 전체(manager·ws_bridge 포함)를 적용하기 때문입니다.

**2-1.** `database.ini` 에 아래 항목을 이미 넣어 두었습니다. 확인만 하면 됩니다.

```ini
[database:kamailio]
schema_dir = ../services/kamailio/schema

[user:kamailio]
host = localhost
databases = kamailio
privileges = ALL
```

`[user:jyahn]` 의 `databases` 에도 `kamailio` 를 추가해 두었습니다.
websocket-relay 가 같은 계정으로 SIP 계정을 발급·조회할 수 있게 하기 위함입니다.

**2-2.** 무엇이 바뀌는지 먼저 봅니다.

```bash
cd database
sudo ./setup_mariadb.sh --dry-run
```

**2-3.** 적용합니다. `secrets/kamailio.pw` 가 자동으로 만들어집니다(영숫자 32자, 권한 600).

```bash
sudo ./setup_mariadb.sh
```

> ⚠️ **2-2 만 하고 2-3 을 건너뛰면 안 됩니다.** dry-run 은 비밀번호 파일을 실제로 만들면서
> `ALTER USER` 는 실행하지 않아, 파일과 DB 의 비밀번호가 어긋납니다.
> 그 상태로 4 단계를 진행하면 Kamailio 가 기동에 실패합니다. ([문제 해결 T-2](#t-2-db-오류로-기동하지-않음--access-denied-for-user-kamailio))

**2-4.** 결과를 확인합니다.

```bash
sudo mariadb -e "SELECT table_name FROM information_schema.tables WHERE table_schema='kamailio';"
sudo mariadb -e "SELECT * FROM kamailio.version;"
```

`version` 과 `subscriber` 가 보이고 `subscriber` 의 `table_version` 이 `7` 이면 됩니다.

## 3. 이 장비의 값 — `settings.ini`

장비마다 다른 값 셋은 스크립트가 아니라 `settings.ini` 에 있습니다. 이 파일은
커밋하지 않으므로 **새 장비에는 없습니다.** 만드는 길이 둘입니다.

**3-1. 구축 마법사** (권장) — `/manager/setup` 의 Kamailio 설정 단계에 폼이
있습니다. 항목 설명·형식 검사·저장이 한자리에서 끝나고, 저장한 값이 아직
반영되지 않았다는 것도 그 화면이 알려 줍니다.

**3-2. 편집기로 직접** — 마법사를 띄울 수 없는 장비라면 뼈대를 만들어 채웁니다.
항목 설명이 주석으로 함께 들어갑니다.

```bash
node ../../lib/settings.js --init .    # settings.ini 뼈대를 만든다
node ../../lib/settings.js --print .   # 만들지 않고 무엇이 필요한지만 본다
```

값이 이미 있는 파일은 덮지 않습니다. 만들어진 뼈대는 이런 모양입니다.

```ini
; SIP 를 받을 주소  (필수)
;   이 장비의 LAN 주소입니다. 장비마다 다르므로 기본값이 없습니다.
;   형식: IPv4 (예: 192.168.0.252)
sip_listen_addr =
```

`sip_listen_addr` 는 이 장비에 실제로 있는 주소여야 합니다 — `ip -4 -br addr` 로
확인하세요. 없는 주소를 적으면 Kamailio 가 기동에서 죽고, `install.sh --apply`
는 그것을 미리 막습니다 (4-3-0).

| 키 | 어디로 가는가 |
|---|---|
| `sip_domain` | `kamctlrc` 의 `SIP_DOMAIN` 과 `kamailio-local.cfg` 의 `alias`. 둘이 어긋나면 계정은 만들어지는데 등록이 안 됩니다. **비워 두면 사이트 값(`site/settings.ini`)을 씁니다** |
| `sip_listen_addr` | `listen=udp/tcp:<주소>:5060`. **이 장비에 없는 주소를 적으면 기동에서 죽습니다** — `install.sh` 가 실제 주소 목록과 맞춰 보고 막습니다 |
| `sip_push_url` | 착신 푸시를 요청할 곳 (`docs/incoming-call.md` ⑤) |

항목 정의는 `settings-schema.json` 에 있고(커밋합니다), 값 파일과 적용 기록
(`.applied-settings`)은 커밋하지 않습니다. 규약은
[docs/settings-contract.md](../../docs/settings-contract.md) 입니다.

`./install.sh` (점검)이 지금 값과 **설치된 값이 다른지**도 알려 줍니다 —
저장만 하고 `--apply` 를 잊으면 그 자리에서 `[--]` 로 보입니다.

## 4. Kamailio 설정 설치 — 인증 · 도메인 · 리스너 · 푸시 훅

**4-1.** 먼저 점검합니다. 아무것도 바꾸지 않습니다. `sudo` 를 붙이면 DB 접속과
`/etc/kamailio/` 내용까지 확인합니다.

```bash
./install.sh
sudo ./install.sh
```

**4-2.** 한 번에 적용합니다. 아래 4-3 의 모든 항목이 이 명령 안에서 실행됩니다.

```bash
sudo ./install.sh --apply
```

**4-3.** `--apply` 가 하는 일:

| | 내용 |
|---|---|
| 4-3-0 | `settings.ini` 검증 — 형식과 **그 주소가 이 장비에 있는지**. 실패하면 아무것도 건드리지 않음 |
| 4-3-1 | 스키마 존재 및 `secrets/kamailio.pw` 로 **실제 DB 로그인** 확인 — 실패하면 아무것도 건드리지 않음 |
| 4-3-2 | 기존 파일 백업 (`*.bak.<타임스탬프>`) |
| 4-3-3 | `kamailio-local.cfg` 설치 — `__DBURL__` 자리를 비밀번호로 치환, `root:kamailio` 0640 |
| 4-3-4 | `kamctlrc` 생성 — `SIP_DOMAIN=<settings.ini 의 sip_domain>`, DB 접속 정보, `STORE_PLAINTEXT_PW=1`, 0640 |
| 4-3-5 | `kamailio -c` 문법·모듈 검사 — **실패하면 설치 파일을 지우고 재시작하지 않음** |
| 4-3-6 | `systemctl restart kamailio` 후 5초 대기 뒤 판정 — **실패하면 자동 롤백 + 로그 15줄 출력** |
| 4-3-7 | 성공했을 때만 `.applied-settings` 에 설치한 값을 남김 (되돌렸으면 남기지 않음) |

> `kamailio -c` 는 문법과 모듈만 봅니다. DB 접속은 fork 이후 `child_init` 에서 일어나므로
> 4-3-5 로는 자격 증명 오류를 잡을 수 없습니다. 그래서 4-3-1 이 먼저 있습니다.

**4-4.** 배포판의 `kamailio.cfg` 는 한 줄도 고치지 않습니다. 그 파일 127행의
`import_file "kamailio-local.cfg"` 를 이용하며, 그 지점은 defines·모듈 로딩보다 앞입니다.
패키지를 업그레이드해도 설정이 날아가지 않습니다.

**4-5.** 인증이 실제로 걸렸는지 확인합니다. 계정 없이 REGISTER 하면 `401` 이 와야 합니다.

```bash
sudo systemctl status kamailio
sudo /usr/sbin/kamctl ul show
```

## 5. SIP over WebSocket *(선택 — 지금은 쓰지 않습니다)*

**5-1.** 단말이 SIP 를 직접 말하는 길(`wss://…/sip/`)입니다. **⛔ 지금은 꺼 두었습니다** —
브라우저도 모바일도 Janus 로 붙기로 정하면서 쓸 클라이언트가 없어졌습니다
(`nginx-conf/service.ini`, [docs/mobile-transport.md](docs/mobile-transport.md) 7절).

LAN 의 SIP 단말은 평문 UDP 5060 으로 붙으므로 이 단계 없이도 동작합니다.
**필요 없으면 6 으로 넘어가세요.** 다만 `bootstrap.sh` 는 이 둘(WS 설정·nginx 라우트)을
아직 "남은 항목"으로 셈하므로, 건너뛰면 9 단계에서 초록이 되지 않습니다.

**5-2.** 켤 때. `handshake` 까지 자동으로 검증합니다.

```bash
sudo ./setup-websocket.sh --enable    # WS 설정 설치 + 재시작 (5080)
./setup-websocket.sh                  # 점검만
sudo ./setup-websocket.sh --disable   # 걷어내기
```

**5-3.** 바깥에서 닿게 하려면 nginx 라우트도 함께 켭니다.

```bash
# nginx-conf/service.ini 의 enabled = true 로 바꾼 뒤
cd ../..
sudo ./nginx/install_nginx_stack.sh --skip-install
```

> ⚠️ `enabled = false` 인 서비스는 생성기가 스캔 단계에서 건너뜁니다 — 포트·경로 충돌
> 검사도 받지 않습니다. 다시 켤 때 그 검사를 처음 받는 셈입니다.

## 6. 대시보드 빌드

**6-1.** 의존성을 설치하고 프런트를 빌드합니다.

```bash
./setup-dashboard.sh --build   # server/web 의존성 + 프런트 빌드 + 점검
./setup-dashboard.sh           # 점검만 (그룹·FIFO·프로세스·빌드)
```

**6-2.** 이 스크립트는 `sudo` 가 필요한 일을 하지 않습니다 — 무엇을 실행해야 하는지
알려만 줍니다. 프런트 산출물은 `web/dist/` 이고 커밋하지 않습니다.

**6-3.** 프런트를 고칠 때는 개발 서버를 씁니다 (5186, API 는 28086 으로 프록시).

```bash
cd web && npm run dev
```

## 7. pm2 등록

대시보드는 pm2 가 띄웁니다. Kamailio 본체는 여기 나오지 않습니다 — systemd 가 띄웁니다.

### ⚠️ kamailio 그룹 — 여기서 한 번 막힙니다

대시보드는 Kamailio 상태를 JSON-RPC FIFO 로 읽는데, FIFO 가 있는 `/run/kamailio` 가
`drwxrwx--- kamailio:kamailio` 라 **프로세스가 kamailio 그룹을 가져야** 합니다.
1-2 의 `usermod` 이 그것입니다.

**`usermod` 만으로는 부족합니다.** 그것은 `/etc/group` 만 고칩니다. 보조 그룹은
**로그인할 때** `initgroups()` 로 한 번 정해지고 그 뒤 자식에게 그대로 상속되므로,
이미 떠 있는 셸과 그 셸이 띄운 pm2 데몬은 옛 그룹 집합을 계속 씁니다.

> 실제로 겪은 함정입니다. `usermod` 하고 `pm2 kill` 후 다시 띄웠는데도 대시보드가
> "Kamailio 에 닿지 않습니다" 를 계속 띄웠습니다. 원인은 **재시작한 셸 자체가
> usermod 이전에 만들어진 것**이었습니다. `/etc/group` 에는 등록돼 있으니 겉으로는
> 다 맞아 보입니다.

**7-1. 다시 로그인한 뒤 데몬을 새로 띄웁니다** (권장 — 재부팅 후에도 유효)

```bash
pm2 kill
cd pm2 && pm2 start ecosystem.config.js && pm2 save
```

**7-2. 로그아웃할 수 없다면 — `sg` 로 데몬을 띄웁니다** (임시 조치)

```bash
pm2 kill
sg kamailio -c "cd <프로젝트>/pm2 && pm2 start ecosystem.config.js && pm2 save"
```

데몬의 **기본 그룹**이 `kamailio` 가 되므로 임시로만 쓰세요.

**7-3.** `pm2 restart` 로는 바뀌지 않습니다 — 데몬이 자식에게 그룹을 물려주므로
**데몬 자체를 다시 띄워야** 합니다. 그래서 `pm2 kill` 이 필요합니다.

**7-4.** 확인합니다.

```bash
./setup-dashboard.sh                                      # 전체 점검
grep ^Groups: /proc/$(pm2 pid kamailio-dashboard)/status  # 143 이 있어야 한다
```

닿지 않으면 대시보드 화면과 pm2 로그에 원인과 위 해결 방법이 그대로 표시됩니다.

## 8. SIP 계정 등록

> 자동화하지 않았습니다. 계정과 비밀번호는 사람이 정해야 하고,
> 스크립트 인자로 받으면 셸 히스토리와 `ps` 에 남습니다.

**8-1.** 계정을 만듭니다. **절대경로**를 쓰세요
([두 벌 설치](#두-벌-설치--도구는-반드시-절대경로로) 참고).

```bash
sudo /usr/sbin/kamctl add 1001 '내선1001비밀번호'
```

**8-2.** 확인합니다.

```bash
sudo /usr/sbin/kamctl show          # 등록된 계정
sudo /usr/sbin/kamctl ul show       # 현재 접속 중인 단말
./check-accounts.sh                 # 등록될 수 있는 모양인지 (sudo 불필요)
```

`check-accounts.sh` 는 조용히 실패하는 자리 둘을 봅니다 — **도메인이 어긋난 계정**과
**비밀번호 컬럼이 빈 계정**입니다. 둘 다 계정은 있는데 등록만 안 되는 상태를 만듭니다.

**8-3.** 브라우저는 Janus SIP 플러그인에 `register` 를 보냅니다. 비밀번호는
`secret` 에 들어갑니다.

```json
{ "request": "register",
  "username": "sip:1001@<sip_domain>",
  "authuser": "1001",
  "secret": "내선1001비밀번호",
  "proxy": "sip:<sip_listen_addr>:5060",
  "outbound_proxy": "sip:<sip_listen_addr>:5060" }
```

`proxy` 는 루프백이 아니라 LAN 주소여야 하고, `outbound_proxy` 를 빠뜨리면 등록은
되는데 **발신만 조용히 실패합니다.** 두 함정의 경위는
`services/janus/web/src/pages/TestCall.jsx` 의 주석에 적혀 있습니다.

자세한 내용과 SQL 로 다루는 방법은 [accounts.md](accounts.md).

## 9. 마지막 점검

```bash
./bootstrap.sh          # 패키지 · 그룹 · DB · 설정 · 동작
./setup-dashboard.sh    # 그룹 · FIFO · 프로세스 · 빌드
./check-accounts.sh     # SIP 계정
./check-push.sh         # 착신 푸시 (docs/incoming-call.md)
```

전부 초록이면 됩니다. `bootstrap.sh` · `check-accounts.sh` · `check-push.sh` 는
`--json` 도 받습니다 — 구축 마법사가 그것을 읽습니다
([docs/check-contract.md](../../docs/check-contract.md)).
`setup-dashboard.sh` 는 아직 사람이 보는 출력만 냅니다.

## 이 저장소 밖에서 해야 하는 것

| | 왜 밖인가 |
|---|---|
| 공유기 포워딩 `30000-30500/udp` | 미디어(rtpengine) 도입 시. 장비 설정 |
| rtpengine 데몬 | 배포판 저장소에 없음 — sipwise 저장소 또는 소스 빌드 (`rtpengine.conf` 참고) |
| 단말 앱의 `sipUser` | `/register` 에 함께 보내야 착신 푸시가 간다 |

---

# 운영

## 관찰용 대시보드

`https://<서버>/kamailio/dashboard`

manager 로그인 하나로 들어갑니다 — 이 서비스도 계정을 두지 않고 세션만 검증합니다.
화면은 **개요 · 등록 단말 · WebSocket · SIP 계정 · 통계** 다섯입니다.

Kamailio 를 **읽기만 합니다.** 재시작하거나 설정을 바꾸지 않습니다 — 그건
`install.sh` · `setup-websocket.sh` 가 sudo 로 하는 일입니다.

## 로그

로그는 대시보드의 **로그** 탭에서 봅니다 — Kamailio 는 pm2 가 아니라 systemd 가
띄우므로 `pm2 logs` 에 나오지 않습니다. 자주 쓰는 필터(`REGISTER`, `INVITE`,
`ts_store|ts_append`, `sip-push`)를 화면에 적어 두었습니다.

```bash
journalctl -u kamailio -f          # Kamailio 본체
pm2 logs kamailio-dashboard        # 대시보드
```

## 설정을 바꿀 때

**O-1.** `settings.ini` 나 `kamailio-local.cfg` 를 고친 뒤 다시 설치합니다.
`install.sh --apply` 는 언제 다시 실행해도 됩니다 (검사 실패 시 자동 롤백).

```bash
sudo ./install.sh --apply
```

**O-2.** 템플릿에 주석 처리해 둔 항목:

| define | 켜면 | 필요한 테이블 |
|---|---|---|
| `WITH_USRLOCDB` | 등록 정보를 DB 에 저장 (재시작해도 유지) | `location`, `location_attrs` |
| `WITH_IPAUTH` | IP 기반 인증 (digest 대신 출발지 주소로 허용) | `address` |
| `WITH_ACCDB` | 통화 기록 저장 | `acc`, `missed_calls` |

**O-3.** 테이블이 더 필요하면 `schema/002-xxx.sql` 로 추가하고 `setup_mariadb.sh` 를
다시 실행합니다.

원본 SQL 은 `/usr/share/kamailio/mysql/` 에 있지만 **그대로 복사하면 안 됩니다.**
`CREATE TABLE` 이 멱등하지 않아 두 번째 실행에서 실패합니다.
`001-auth.sql` 처럼 `IF NOT EXISTS` 로 옮기고, `version` 테이블의 `table_version` 값은
원본과 정확히 같게 두세요. Kamailio 가 기동할 때 검사합니다.

## 되돌리기

**O-4.** 인증을 끄고 원래 상태로 돌아갑니다.

```bash
sudo ./install.sh --remove
```

`/etc/kamailio/kamailio-local.cfg` 를 백업 후 제거하고 재시작합니다.
데이터베이스는 그대로 둡니다 — 로드되지 않으면 읽지 않으므로 남아 있어도 무해합니다.

**O-5.** 데이터베이스까지 지우려면 (계정이 모두 사라집니다)

```bash
sudo mariadb -e "SELECT COUNT(*) FROM kamailio.subscriber;"   # 먼저 확인
sudo mariadb -e "DROP DATABASE kamailio;"
```

`database.ini` 의 `[database:kamailio]` 항목도 함께 지우지 않으면
다음 `setup_mariadb.sh` 실행 때 다시 만들어집니다.

---

# 문제 해결

| 증상 | 항목 |
|---|---|
| 기동하지 않음 | [T-1](#t-1-기동하지-않음--먼저-볼-것) |
| `Access denied for user 'kamailio'` → `Cannot fork` | [T-2](#t-2-db-오류로-기동하지-않음--access-denied-for-user-kamailio) |
| `invalid version for table subscriber` | [T-3](#t-3-invalid-version-for-table-subscriber) |
| 올바른 비밀번호인데 401 이 반복됨 | [T-4](#t-4-올바른-비밀번호인데-401-이-반복됨) |
| `403 Not relaying` | [T-5](#t-5-403-not-relaying--realm-과-도메인) |
| 대시보드가 "Kamailio 에 닿지 않습니다" | [T-6](#t-6-대시보드가-kamailio-에-닿지-않습니다) |
| Janus 등록 실패 | [T-7](#t-7-janus-등록-실패) |
| 마법사가 "점검 출력을 읽지 못했습니다" | [T-8](#t-8-마법사가-점검-출력을-읽지-못했습니다) |

## T-1. 기동하지 않음 — 먼저 볼 것

```bash
journalctl -u kamailio -n 40 --no-pager
sudo /usr/sbin/kamailio -c -f /etc/kamailio/kamailio.cfg     # 문법만 검사
```

`settings.ini` 의 `sip_listen_addr` 가 이 장비에 없는 주소면 기동에서 죽습니다.
`install.sh --apply` 는 그 경우 적용 전에 막습니다 (4-3-0).

## T-2. DB 오류로 기동하지 않음 — `Access denied for user 'kamailio'`

`secrets/kamailio.pw` 의 값이 MariaDB 에 반영되지 않은 상태입니다.
`setup_mariadb.sh` 의 비밀번호 생성 함수에는 `--dry-run` 가드가 없어서,
**dry-run 으로만 돌려도 비밀번호 파일은 실제로 만들어지고 `ALTER USER` 는 실행되지 않습니다.**
그 상태로 `install.sh --apply` 를 하면 파일의 새 비밀번호로 DBURL 이 만들어져 접속이 거부됩니다.

```bash
cd database && sudo ./setup_mariadb.sh      # --dry-run 없이 한 번 실행
sudo systemctl start kamailio
```

`install.sh` 는 이제 설치 전에 실제로 DB 로그인을 해 보고, 실패하면 아무것도 건드리지 않습니다.
`./install.sh` (점검 모드)에서도 이 불일치를 알려 줍니다.

> `kamailio -c` 는 문법과 모듈만 검사합니다. DB 접속은 fork 이후 `child_init` 에서 일어나므로
> `-c` 로는 이 문제를 잡을 수 없습니다.

## T-3. `invalid version for table subscriber`

`version` 테이블의 값이 데몬이 기대하는 것과 다릅니다.
5.7 도구로 스키마를 만들었을 때 생깁니다 ([두 벌 설치](#두-벌-설치--도구는-반드시-절대경로로)).
`schema/001-auth.sql` 을 다시 적용하세요 (O-3).

## T-4. 올바른 비밀번호인데 401 이 반복됨

`subscriber.password`(평문) 컬럼이 비어 있습니다.

이 서버의 `auth_db` 는 `calculate_ha1=yes` 라 **평문 `password` 컬럼만 읽습니다.**
`ha1` 컬럼은 값이 있어도 쓰이지 않습니다. 확인:

```bash
./check-accounts.sh
```

```sql
SELECT id, username FROM subscriber WHERE password = '';   -- 인증 불가 계정
```

대시보드의 SIP 계정 화면에서 **"인증 불가"** 로 표시되며, 수정에서 비밀번호를 다시 입력하면
정상화됩니다. 원래 비밀번호는 해시에서 되돌릴 수 없으므로, 단말에 설정된 값을 그대로 넣으면
단말을 건드리지 않고 복구됩니다. 자세한 내용은 [accounts.md](accounts.md).

> `kamctlrc` 의 `STORE_PLAINTEXT_PW` 가 `0` 이면 `kamctl add` 도 같은 문제를 만듭니다.
> `install.sh` 는 `1` 로 설정합니다 (4-3-4).

## T-5. `403 Not relaying` — realm 과 도메인

realm 은 단말이 보낸 `From` 도메인이 그대로 쓰이고 DNS 조회는 하지 않습니다.
`subscriber.domain` 과 달라도 `use_domain=0` 이라 무관합니다.
다만 단말이 **Request-URI 에도** 그 도메인을 쓴다면 `myself` 에 없어 `403 Not relaying` 이
납니다. 그때는 `settings.ini` 의 `sip_domain` 을 그 값으로 맞추고 다시 적용하세요.

## T-6. 대시보드가 "Kamailio 에 닿지 않습니다"

거의 항상 **kamailio 그룹**입니다. [7. pm2 등록](#7-pm2-등록) 을 그대로 따르세요 —
`usermod` 후 **다시 로그인**하고 `pm2 restart` 가 아니라 `pm2 kill` 로 데몬을 새로 띄워야 합니다.

```bash
./setup-dashboard.sh
grep ^Groups: /proc/$(pm2 pid kamailio-dashboard)/status   # 143 이 있어야 한다
```

## T-7. Janus 등록 실패

브라우저에는 `registration_failed` 이벤트가 돌아옵니다. 이유는 Janus 쪽 로그에
남습니다 — Janus 도 pm2 가 아니라 systemd 가 띄웁니다.

```bash
journalctl -u janus -n 40 --no-pager
journalctl -u kamailio -f | grep REGISTER      # Kamailio 가 무엇을 돌려주는가
```

계정 쪽이 원인인 경우가 대부분입니다. [T-4](#t-4-올바른-비밀번호인데-401-이-반복됨) 와
`./check-accounts.sh` 를 먼저 보세요.

## T-8. 마법사가 "점검 출력을 읽지 못했습니다"

구축 마법사는 판정을 스스로 하지 않고 이 디렉토리의 점검 스크립트를
`--check --json` 으로 실행해 그 출력을 읽습니다. 그래서 **스크립트가 JSON 한
덩어리를 내지 못하면 마법사가 그 단계를 `unknown` 으로 둡니다.**

먼저 손으로 같은 것을 돌려 봅니다. 마법사가 무엇을 부르는지는 그 단계 화면에
그대로 적혀 있습니다.

```bash
./bootstrap.sh --check --json | jq .
```

원인은 거의 둘 중 하나입니다.

**① 사람이 보는 출력이 JSON 에 섞였다.** `echo` 나 `cat` 으로 stdout 에 바로
찍으면 JSON 앞뒤에 붙어 나옵니다. `lib/check-report.sh` 의 `info` 를 거쳐야
JSON 모드에서 조용해집니다.

**② 스크립트가 `check_finish` 전에 죽었다.** 이때는 stdout 이 **아예 빕니다** —
`--json` 은 출력을 모아 마지막에 한 번에 내기 때문입니다. `set -e` 아래에서는
실패하는 명령 하나가 대입문에 있어도 스크립트가 그 자리에서 끝납니다.

```bash
./bootstrap.sh --check --json; echo "exit=$?"   # 출력이 없고 종료 코드가 0·1 이 아니면 ②
bash -x ./bootstrap.sh --check --json 2>&1 | tail   # 어디서 멈췄는지
```

> `bootstrap.sh` 가 실제로 ②였습니다. WS(5080)를 켜지 않은 장비에서 `/health` 를
> 찍어 보는 `curl` 이 7(연결 실패)로 끝나고, `set -e` 아래의 그 대입문 하나가
> 점검을 통째로 끝냈습니다. 사람이 보는 모드에서는 거기까지 찍힌 줄이 남아
> 티가 나지 않아 오래 몰랐습니다. 지금은 `|| true` 로 막혀 있습니다.

---

# 배경

## 현황 (2026-09-02 확인)

**이 장비는 아직 1~2 단계까지만 되어 있습니다.** 패키지와 그룹은 있고, 이
저장소의 설정은 하나도 설치되지 않았습니다.

| 항목 | 값 |
|---|---|
| 구동 중인 바이너리 | `/usr/sbin/kamailio` **5.7.4** (배포판 패키지) |
| 설정 | `/etc/kamailio/kamailio.cfg` — **배포판 그대로** (2024-04-01). 이 저장소의 포크는 아직 설치되지 않았습니다 |
| 오버라이드 | `kamailio-local.cfg` · `kamailio-websocket.cfg` **둘 다 없음** — 지금은 **인증 없이** REGISTER 를 받습니다 |
| systemd | `kamailio.service` → `ExecStart=/usr/sbin/kamailio -P … -f $CFGFILE` |
| SIP 소켓 | `10.10.0.224:5060`, `127.0.0.1:5060` — 배포판 기본값의 자동 바인딩 (WS 5080 없음) |
| 이 장비의 주소 | `enp131s0` = `10.10.0.224/8` — `settings.ini` 의 `sip_listen_addr` 에 넣을 값입니다 |
| SIP 도메인 | 서비스 값이 비어 있어 **사이트 값**(`site/settings.ini` 의 `sip_domain`)을 씁니다 |
| 인증 | 아직 없음. 3·4 단계를 마치면 digest — `subscriber` 테이블 (`use_domain=0`) |
| `settings.ini` | **없음** — 3 단계에서 만듭니다 |

> 이 표는 사람이 손으로 옮겨 적은 것이라 언제든 뒤처집니다. 같은 내용을
> `./bootstrap.sh` 와 `./install.sh` 가 그 자리에서 찍어 주므로, 문서와
> 다르면 **스크립트 출력을 믿으세요.**

## 두 벌 설치 — 도구는 절대경로로

~~`which kamctl` 은 `/usr/local/sbin` 의 소스빌드판을 가리킵니다~~
**해소됐습니다** (2026-09-02 확인) — `/usr/local/sbin/kamailio` 는 이제 없고
`which kamctl` 도 `/usr/sbin/kamctl` 을 가리킵니다.

그래도 이 문서는 계속 `/usr/sbin/kamctl` 처럼 **절대경로로 적습니다.** 소스빌드를
다시 하면 `/usr/local/sbin` 이 PATH 앞에 서서 조용히 그쪽을 부르게 되고, 그 판은
`/usr/local/etc/kamailio/kamctlrc`(`DBENGINE` 미설정)를 읽어 실패하거나, 통과하더라도
다른 기준의 스키마를 만들어 데몬이 거부합니다 (T-3).

> 인증에 쓰는 `subscriber` / `version` 테이블 정의는 5.5 와 5.7 이 **동일**함을 확인했으므로,
> 이 디렉토리의 스키마는 나중에 5.7.7 로 올려도 그대로 씁니다.

## 대시보드가 데이터를 읽는 방법

Kamailio 의 **JSON-RPC FIFO** (`/run/kamailio/kamailio_rpc.fifo`)를 씁니다.
Kamailio 설정은 건드리지 않습니다 — 배포판 설정의 `transport = 7` 에 FIFO 가
이미 포함돼 있습니다.

다른 경로는 다 막혀 있어서 이걸 골랐습니다.

| 방법 | 왜 안 되나 |
|---|---|
| HTTP JSON-RPC | `jsonrpcs.so` 는 배포판 설정 259행에서 로드되는데 우리 오버라이드는 127행이라 `jsonrpc_dispatch` 를 모른다 |
| binrpc (`kamcmd`) | `kamailio_ctl` 이 `srw-------` 라 소유자만 쓸 수 있고, JSON 출력도 없다 |
| datagram 소켓 | Node 의 `dgram` 이 유닉스 소켓을 지원하지 않는다 |

그 FIFO 가 kamailio 그룹 전용이라는 것이 [7. pm2 등록](#7-pm2-등록) 의 함정으로 이어집니다.

## 이 디렉토리가 서비스인 이유

Kamailio 는 이 프로젝트가 만든 프로그램이 아니라 배포판 패키지지만, **서비스 하나로
다룹니다.** 스키마(`schema/`)와 라우팅 선언(`nginx-conf/`)을 가지고, 설치·설정
절차가 코드로 남아 있기 때문입니다. 그래서 다른 서비스와 같은 규약을 따릅니다.

| 규약 | 이 서비스에서 | 문서 |
|---|---|---|
| `schema/` | `database.ini` 의 `[database:kamailio]` 가 가리킴 | [database/README.md](../../database/README.md) |
| `nginx-conf/` | SIP over WS 라우트. **아직 `enabled = false`** | [docs/nginx-conf.md](../../docs/nginx-conf.md) |
| `pm2-conf/` | 대시보드는 진짜 프로세스, Kamailio 본체는 **껍데기** (systemd 가 띄움) | [docs/pm2-conf.md](../../docs/pm2-conf.md) |
| `settings.ini` | 장비마다 다른 값 3개 | [docs/settings-contract.md](../../docs/settings-contract.md) |
| `*.sh --json` | `bootstrap.sh` · `install.sh` · `check-accounts.sh` · `check-push.sh` | [docs/check-contract.md](../../docs/check-contract.md) |

`pm2-conf/app.ini` 를 비워 두지 않고 껍데기라도 두는 이유는, 나중에 보는 사람이
"선언을 빠뜨린 것"과 "pm2 대상이 아닌 것"을 구별할 수 있게 하기 위해서입니다.

> 이 디렉토리는 원래 `services/ws-bridge/kamailio/` 에 있었습니다. Kamailio 는
> ws-bridge 의 부속이 아니라 독립 서비스이므로 한 서비스 밑에 두는 것이 맞지
> 않았습니다. 옮겨 두길 잘했습니다 — 그 뒤 ws-bridge 는 없어졌고, 지금은 Janus
> (digest)와 websocket-relay(계정 발급·착신 푸시)가 함께 이 서버에 붙습니다.

## 남은 보안 항목

이 디렉토리의 작업 범위 밖이지만 함께 살펴본 것들입니다.

**S-1. MariaDB 의 노출 범위** — ~~`bind_address = 0.0.0.0`, `[user:jyahn] host = %`~~
**기본값을 조였습니다** — 지금은 `bind_address = 127.0.0.1` 이고 `jyahn` 도
`host = 127.0.0.1` 입니다 ([database/README.md](../../database/README.md)).
이 계정이 SIP 계정 해시까지 다루므로 그 편이 맞습니다.

⚠️ **이미 만들어 둔 장비에서는 값을 바꾸는 것만으로 좁혀지지 않습니다.**
`setup_mariadb.sh` 는 추가·갱신만 하므로 옛 `jyahn@%` 가 그대로 남습니다.

```bash
sudo mariadb -e "SELECT user, host FROM mysql.user WHERE user = 'jyahn';"
sudo mariadb -e "DROP USER 'jyahn'@'%';"
```

`jyahn` 의 비밀번호가 8자 영단어+숫자 조합이라 약한 것은 그대로입니다.
원거리에서 닿아야 하면 3306 을 여는 대신 SSH 터널을 씁니다.

**S-2. 버전 통일** — ~~5.5.4 와 5.7.7 두 벌~~ **해소됐습니다** (2026-09-02 확인).
지금은 배포판 5.7.4 한 벌뿐이고 소스빌드는 남아 있지 않습니다. 다시 소스빌드를
하게 되면 위 "두 벌 설치" 의 함정이 그대로 돌아옵니다.

**S-3. `/etc/kamailio/kamctlrc` 의 배포판 기본 비밀번호** — `install.sh --apply` (4-3-4) 가
파일을 새로 쓰면서 해소됩니다. 그 전까지는 공개된 기본값이 world-readable 상태로 남아 있습니다.

**S-4. SIP 비밀번호가 평문으로 저장됩니다** — 이 Kamailio 설정(`calculate_ha1=yes`)이
평문 컬럼으로 인증하기 때문입니다. 그 평문에 닿을 수 있는 범위가 곧 `jyahn` 의
범위이므로, S-1 의 확인(옛 `jyahn@%` 가 남아 있지 않은가)이 특히 중요합니다.
평문을 남기지 않으려면 `calculate_ha1` 을 끄는 방식으로 옮겨야 합니다. ([accounts.md](accounts.md))

**S-5. `setup_mariadb.sh` 의 dry-run 부작용** — 비밀번호 생성 함수에 `--dry-run` 가드가 없어
dry-run 이 `secrets/*.pw` 를 실제로 씁니다. Kamailio 뿐 아니라 새로 추가하는 모든 계정에
해당하므로, `setup_mariadb.sh` 쪽을 고치는 편이 근본적입니다. (T-2 참고)
