# Kamailio — 설치·설정·계정

ws-bridge 가 SIP 로 붙는 Kamailio 서버에 관한 것을 모아 둔 디렉토리입니다.

```
services/kamailio/
├── README.md               이 문서 — 현황, 설치 순서, 업그레이드, 문제 해결
├── accounts.md             SIP 계정 등록·삭제 (kamctl / SQL)
├── install.sh              상태 점검 / 인증 설정 설치 / 되돌리기
├── setup-websocket.sh      SIP over WebSocket 점검 · 패키지 설치 · 설정 적용
├── bootstrap.sh            ★ 처음부터 세우는 순서 · 패키지 · 그룹
├── setup-dashboard.sh      대시보드 점검 (그룹·FIFO·프로세스·빌드) · 빌드
├── kamailio.cfg            배포판 설정의 포크 — 착신 푸시 훅 (install.sh 가 설치)
├── kamailio-local.cfg      /etc/kamailio/ 오버라이드 — digest 인증 (install.sh 가 설치)
├── kamailio-websocket.cfg  /etc/kamailio/ 오버라이드 — WS 전송 (setup-websocket.sh 가 설치)
├── docs/
│   ├── websocket-plan.md   SIP over WSS 계획 — ⛔ 채택 안 됨 (모바일도 Janus 로)
│   ├── incoming-call.md    인터폰 → 모바일 착신 (FCM 으로 단말 깨우기)
│   ├── mobile-transport.md 모바일을 무엇으로 붙일 것인가 — 확인한 것과 정한 것
│   └── alternatives.md     Asterisk 를 다시 검토하게 될 때 (판단 보류 기록)
├── rtpengine.conf          미디어 릴레이 데몬 설정 원본 (아직 도입 전)
├── server/                 관찰용 대시보드 — Node
│   └── src/rpc.js            Kamailio JSON-RPC 클라이언트 (FIFO)
├── web/                    대시보드 프런트 — React 18 + Vite + Tailwind + shadcn/ui
├── nginx-conf/
│   ├── service.ini         kamailio            — SIP over WS (5080, systemd)
│   └── dashboard.ini       kamailio-dashboard  — 관찰용 웹 (28086, pm2)
├── pm2-conf/
│   ├── app.ini             kamailio — 껍데기. systemd 가 띄운다
│   ├── dashboard.ini       kamailio-dashboard — 진짜 프로세스
│   └── not-managed-by-pm2.sh
└── schema/
    └── 001-auth.sql        subscriber·version 테이블 (database.ini 가 적용)
```

이 디렉토리는 **서비스 둘**을 담습니다. 규약이 허용하는 형태입니다
([nginx-conf.md](../../docs/nginx-conf.md) 의 "폴더 안에 `.ini` 가 여러 개여도 됩니다").

| 서비스 | 무엇 | 포트 | 띄우는 주체 |
|---|---|---|---|
| `kamailio` | SIP 서버 자체 | 5060(UDP/TCP) · 5080(WS) | systemd |
| `kamailio-dashboard` | 관찰용 웹 | 28086 | pm2 |

## 관찰용 대시보드

로그는 대시보드의 **로그** 탭에서 봅니다 — 이 서비스는 pm2 가 아니라 systemd 가
띄우므로 `pm2 logs` 에 나오지 않습니다. 자주 쓰는 필터(`REGISTER`, `INVITE`,
`ts_store|ts_append`, `sip-push`)를 화면에 적어 두었습니다. 터미널에서는
`journalctl -u kamailio -f` 입니다.

`https://<서버>/kamailio/dashboard`

manager 로그인 하나로 들어갑니다 — 이 서비스도 계정을 두지 않고 세션만 검증합니다.
화면은 **개요 · 등록 단말 · WebSocket · SIP 계정 · 통계** 다섯입니다.

Kamailio 를 **읽기만 합니다.** 재시작하거나 설정을 바꾸지 않습니다 — 그건
`install.sh` · `setup-websocket.sh` 가 sudo 로 하는 일입니다.

### 데이터를 어떻게 읽는가

Kamailio 의 **JSON-RPC FIFO** (`/run/kamailio/kamailio_rpc.fifo`)를 씁니다.
Kamailio 설정은 건드리지 않습니다 — 배포판 설정의 `transport = 7` 에 FIFO 가
이미 포함돼 있습니다.

다른 경로는 다 막혀 있어서 이걸 골랐습니다.

| 방법 | 왜 안 되나 |
|---|---|
| HTTP JSON-RPC | `jsonrpcs.so` 는 배포판 설정 259행에서 로드되는데 우리 오버라이드는 127행이라 `jsonrpc_dispatch` 를 모른다 |
| binrpc (`kamcmd`) | `kamailio_ctl` 이 `srw-------` 라 소유자만 쓸 수 있고, JSON 출력도 없다 |
| datagram 소켓 | Node 의 `dgram` 이 유닉스 소켓을 지원하지 않는다 |

### ⚠️ kamailio 그룹 — 여기서 한 번 막힙니다

FIFO 가 있는 `/run/kamailio` 가 `drwxrwx--- kamailio:kamailio` 라, 대시보드
프로세스가 **kamailio 그룹을 가져야** 합니다.

```bash
sudo usermod -aG kamailio <pm2 를 돌리는 사용자>
```

**이것만으로는 부족합니다.** `usermod` 은 `/etc/group` 만 고칩니다. 보조 그룹은
**로그인할 때** `initgroups()` 로 한 번 정해지고 그 뒤 자식에게 그대로 상속되므로,
이미 떠 있는 셸과 그 셸이 띄운 pm2 데몬은 옛 그룹 집합을 계속 씁니다.

> 실제로 겪은 함정입니다. `usermod` 하고 `pm2 kill` 후 다시 띄웠는데도 대시보드가
> "Kamailio 에 닿지 않습니다" 를 계속 띄웠습니다. 원인은 **재시작한 셸 자체가
> usermod 이전에 만들어진 것**이었습니다. `/etc/group` 에는 등록돼 있으니 겉으로는
> 다 맞아 보입니다.

둘 중 하나로 해결합니다.

**① 다시 로그인** (권장 — 재부팅 후에도 유효)

```bash
pm2 kill
cd pm2 && pm2 start ecosystem.config.js && pm2 save
```

**② 로그아웃 없이 — `sg` 로 데몬을 띄운다**

```bash
pm2 kill
sg kamailio -c "cd <프로젝트>/pm2 && pm2 start ecosystem.config.js && pm2 save"
```

②는 데몬의 **기본 그룹**이 `kamailio` 가 되므로 임시 조치로만 쓰세요.

`pm2 restart` 로는 바뀌지 않습니다 — 데몬이 자식에게 그룹을 물려주므로
**데몬 자체를 다시 띄워야** 합니다. 그래서 `pm2 kill` 이 필요합니다.

**확인:**

```bash
./setup-dashboard.sh                                    # 전체 점검
grep ^Groups: /proc/$(pm2 pid kamailio-dashboard)/status  # 143 이 있어야 한다
```

닿지 않으면 대시보드 화면과 pm2 로그에 원인과 위 해결 방법이 그대로 표시됩니다.

### 빌드·점검

```bash
./setup-dashboard.sh --build   # server/web 의존성 설치 + 프런트 빌드 + 점검
./setup-dashboard.sh           # 점검만 (그룹·FIFO·프로세스·빌드)
cd web && npm run dev          # 개발 서버 (5186, API 는 28086 으로 프록시)
```

## 처음부터 다시 만들려면

```bash
./bootstrap.sh          # 지금 어디까지 됐는지 (아무것도 바꾸지 않음)
sudo ./bootstrap.sh --install   # 패키지 + kamailio 그룹
```

`bootstrap.sh` 가 **전체 순서를 출력합니다.** 이 저장소만으로 새 장비에서 같은
상태를 만들 수 있는지 확인하려고 만들었습니다 — 세우는 동안 손으로 한 일들이
어디에도 적혀 있지 않으면 재현할 수 없기 때문입니다.

| | 단계 | 무엇 |
|---|---|---|
| 1 | `sudo ./bootstrap.sh --install` | 패키지 4개 + `usermod -aG kamailio` |
| 2 | `database/setup_mariadb.sh` | `subscriber` · `sip_user` 스키마 |
| 3 | `sudo ./install.sh --apply` | 인증 · 도메인 · 5060 리스너 · 착신 푸시 훅 |
| 4 | `sudo ./setup-websocket.sh --enable` | SIP over WebSocket (5080) |
| 5 | `nginx-conf/service.ini` → `enabled = true` 후 nginx 반영 | `wss://…/sip/` |
| 6 | `./setup-dashboard.sh --build` | 대시보드 빌드 |
| 7 | `pm2 kill` 후 재기동 | **1 이후 다시 로그인하고** |
| 8 | `./bootstrap.sh` | 전부 초록인지 확인 |

**1 다음에는 반드시 다시 로그인해야 합니다.** 보조 그룹은 로그인할 때 정해져서,
`usermod` 만 하고 pm2 를 재시작하면 대시보드가 Kamailio 에 닿지 못합니다.

### 이 저장소 밖에서 해야 하는 것

| | 왜 밖인가 |
|---|---|
| 공유기 포워딩 `30000-30500/udp` | 미디어(rtpengine) 도입 시. 장비 설정 |
| rtpengine 데몬 | 배포판 저장소에 없음 — sipwise 저장소 또는 소스 빌드 (`rtpengine.conf` 참고) |
| 단말 앱의 `sipUser` | `/register` 에 함께 보내야 착신 푸시가 간다 |

## 이 디렉토리가 서비스인 이유

Kamailio 는 이 프로젝트가 만든 프로그램이 아니라 배포판 패키지지만, **서비스 하나로
다룹니다.** 스키마(`schema/`)와 라우팅 선언(`nginx-conf/`)을 가지고, 설치·설정
절차가 코드로 남아 있기 때문입니다. 그래서 다른 서비스와 같은 규약을 따릅니다.

| 규약 | 이 서비스에서 | 문서 |
|---|---|---|
| `schema/` | `database.ini` 의 `[database:kamailio]` 가 가리킴 | [database/README.md](../../database/README.md) |
| `nginx-conf/` | SIP over WS 라우트. **아직 `enabled = false`** | [docs/nginx-conf.md](../../docs/nginx-conf.md) |
| `pm2-conf/` | **껍데기.** systemd 가 띄우므로 `enabled = false` | [docs/pm2-conf.md](../../docs/pm2-conf.md) |

`pm2-conf/` 를 비워 두지 않고 껍데기라도 두는 이유는, 나중에 보는 사람이
"선언을 빠뜨린 것"과 "pm2 대상이 아닌 것"을 구별할 수 있게 하기 위해서입니다.

> 이 디렉토리는 원래 `services/ws-bridge/kamailio/` 에 있었습니다. Kamailio 는
> ws-bridge 의 부속이 아니라 독립 서비스이고, 앞으로 websocket-relay 도
> (착신 푸시 때문에) 붙게 되므로 한 서비스 밑에 두는 것이 맞지 않습니다.

## 현황 (2026-08-19 확인)

| 항목 | 값 |
|---|---|
| 구동 중인 바이너리 | `/usr/sbin/kamailio` **5.5.4** (배포판 패키지) |
| 설정 | `/etc/kamailio/kamailio.cfg` — **배포판 설정의 포크** (`install.sh --apply`). `kamailio-local.cfg` · `kamailio-websocket.cfg` 오버라이드 |
| systemd | `kamailio.service` → `ExecStart=/usr/sbin/kamailio ... -f /etc/kamailio/kamailio.cfg` |
| 또 하나의 설치 | `/usr/local/sbin/kamailio` **5.7.7** (소스빌드, 2026-03-05) — **구동되지 않음** |
| SIP 소켓 | `192.168.0.252:5060`, `192.168.122.1:5060`, `127.0.0.1:5060` (udp/tcp) + WS `127.0.0.1:5080` |
| SIP 도메인 | `pluto.org` (`alias=`) |
| 인증 | digest — `subscriber` 테이블 (`use_domain=0`) |

### ⚠️ 두 벌 설치 — 도구는 반드시 절대경로로

`which kamctl` / `which kamdbctl` 은 **`/usr/local/sbin` 의 5.7.7 판**을 가리킵니다.
그쪽은 `/usr/local/etc/kamailio/kamctlrc` 를 읽는데 그 파일은 손대지 않은 상태(`DBENGINE` 미설정)라
그냥 실패하고, 통과하더라도 5.7 기준 스키마를 만들어 5.5.4 데몬이 거부합니다.

**항상 `/usr/sbin/kamctl` 처럼 절대경로로 부르세요.**

> 인증에 쓰는 `subscriber` / `version` 테이블 정의는 5.5 와 5.7 이 **동일**함을 확인했으므로,
> 이 디렉토리의 스키마는 나중에 5.7.7 로 올려도 그대로 씁니다.

## 차례

번호는 인용하기 쉽도록 붙였습니다. "2-3 까지 했다" 처럼 가리키면 됩니다.

| | 단계 | 담당 |
|---|---|---|
| **0** | 사전 조건 — ws-bridge digest 인증 | ✅ 완료 |
| **1** | 현재 상태 점검 | `./install.sh` |
| **2** | 데이터베이스 생성 | `database/setup_mariadb.sh` |
| **3** | 인증 설정 설치 | `install.sh --apply` — **전 과정 자동** |
| **4** | 계정 등록 | 수동 (`kamctl add`) |
| **5** | 되돌리기 | `install.sh --remove` |
| **6** | 설정을 바꿀 때 | |
| **7** | 문제 해결 | |
| **8** | 남은 보안 항목 | |

## 설치

데이터베이스는 `database/database.ini` 가 소유하고, Kamailio 설정은 `install.sh` 가 담당합니다.
`kamdbctl create` 는 쓰지 않습니다 — 그러면 DB 가 프로젝트 관리 밖에 놓입니다.

### 0. 사전 조건 — ws-bridge digest 인증 ✅ 완료

인증을 켜면 Kamailio 가 401 로 challenge 를 보냅니다.
ws-bridge 는 이미 이를 처리합니다. (`src/protocols/sip/digest.js`, 테스트 `npm test`)
계정 비밀번호는 WS 클라이언트가 `register` 메시지의 `password` 필드로 보냅니다.

### 1. 현재 상태 점검

**1-1.** 무엇이 준비됐고 무엇이 남았는지 확인합니다. 아무것도 바꾸지 않습니다.

```bash
cd services/kamailio
./install.sh
```

**1-2.** `sudo` 를 붙이면 DB 접속과 `/etc/kamailio/` 내용까지 확인합니다.

```bash
sudo ./install.sh
```

### 2. 데이터베이스 생성

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
ws-bridge 등 다른 서비스가 같은 계정으로 계정 테이블을 다룰 수 있게 하기 위함입니다.

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
> 그 상태로 3단계를 진행하면 Kamailio 가 기동에 실패합니다. (문제 해결 절 참고)

**2-4.** 결과를 확인합니다.

```bash
sudo mariadb -e "SELECT table_name FROM information_schema.tables WHERE table_schema='kamailio';"
sudo mariadb -e "SELECT * FROM kamailio.version;"
```

`version` 과 `subscriber` 가 보이고 `subscriber` 의 `table_version` 이 `7` 이면 됩니다.

### 3. 인증 설정 설치

**3-0. 이 장비의 값을 먼저 정합니다** — `settings.ini`

장비마다 다른 값 셋은 스크립트가 아니라 `settings.ini` 에 있습니다. 구축
마법사(`/manager/setup` 의 4단계)의 폼에서 넣거나, 편집기로 직접 적습니다.

```ini
sip_domain      = pluto.org
sip_listen_addr = 192.168.0.252          ; 이 장비의 LAN 주소 — 기본값이 없다
sip_push_url    = https://127.0.0.1:28099/sip-push
```

| 키 | 어디로 가는가 |
|---|---|
| `sip_domain` | `kamctlrc` 의 `SIP_DOMAIN` 과 `kamailio-local.cfg` 의 `alias`. 둘이 어긋나면 계정은 만들어지는데 등록이 안 됩니다 |
| `sip_listen_addr` | `listen=udp/tcp:<주소>:5060`. **이 장비에 없는 주소를 적으면 기동에서 죽습니다** — `install.sh` 가 실제 주소 목록과 맞춰 보고 막습니다 |
| `sip_push_url` | 착신 푸시를 요청할 곳 (`docs/incoming-call.md` ⑤) |

항목 정의는 `settings-schema.json` 에 있고(커밋합니다), 값 파일과 적용 기록
(`.applied-settings`)은 커밋하지 않습니다. 규약은
[docs/settings-contract.md](../../docs/settings-contract.md) 입니다.

`./install.sh` (점검)이 지금 값과 **설치된 값이 다른지**도 알려 줍니다 —
저장만 하고 `--apply` 를 잊으면 그 자리에서 `[--]` 로 보입니다.

**3-1.** 한 번에 적용합니다. 아래 3-2 의 모든 항목이 이 명령 안에서 실행됩니다.

```bash
cd services/kamailio
sudo ./install.sh --apply
```

**3-2.** `--apply` 가 하는 일:

| | 내용 |
|---|---|
| 3-2-0 | `settings.ini` 검증 — 형식과 **그 주소가 이 장비에 있는지**. 실패하면 아무것도 건드리지 않음 |
| 3-2-1 | 스키마 존재 및 `secrets/kamailio.pw` 로 **실제 DB 로그인** 확인 — 실패하면 아무것도 건드리지 않음 |
| 3-2-2 | 기존 파일 백업 (`*.bak.<타임스탬프>`) |
| 3-2-3 | `kamailio-local.cfg` 설치 — `__DBURL__` 자리를 비밀번호로 치환, `root:kamailio` 0640 |
| 3-2-4 | `kamctlrc` 생성 — `SIP_DOMAIN=<settings.ini 의 sip_domain>`, DB 접속 정보, `STORE_PLAINTEXT_PW=1`, 0640 |
| 3-2-5 | `kamailio -c` 문법·모듈 검사 — **실패하면 설치 파일을 지우고 재시작하지 않음** |
| 3-2-6 | `systemctl restart kamailio` 후 5초 대기 뒤 판정 — **실패하면 자동 롤백 + 로그 15줄 출력** |
| 3-2-7 | 성공했을 때만 `.applied-settings` 에 설치한 값을 남김 (되돌렸으면 남기지 않음) |

> `kamailio -c` 는 문법과 모듈만 봅니다. DB 접속은 fork 이후 `child_init` 에서 일어나므로
> 3-2-5 로는 자격 증명 오류를 잡을 수 없습니다. 그래서 3-2-1 이 먼저 있습니다.

**3-3.** 배포판의 `kamailio.cfg` 는 한 줄도 고치지 않습니다. 그 파일 127행의
`import_file "kamailio-local.cfg"` 를 이용하며, 그 지점은 defines·모듈 로딩보다 앞입니다.
패키지를 업그레이드해도 설정이 날아가지 않습니다.

**3-4.** 인증이 실제로 걸렸는지 확인합니다. 계정 없이 REGISTER 하면 `401` 이 와야 합니다.

```bash
sudo systemctl status kamailio
sudo /usr/sbin/kamctl ul show
```

### 4. 계정 등록

> 자동화하지 않았습니다. 계정과 비밀번호는 사람이 정해야 하고,
> 스크립트 인자로 받으면 셸 히스토리와 `ps` 에 남습니다.

**4-1.** 계정을 만듭니다. **절대경로**를 쓰세요 (아래 "두 벌 설치" 참고).

```bash
sudo /usr/sbin/kamctl add 1001 '내선1001비밀번호'
```

**4-2.** 확인합니다.

```bash
sudo /usr/sbin/kamctl show          # 등록된 계정
sudo /usr/sbin/kamctl ul show       # 현재 접속 중인 단말
```

**4-3.** WS 클라이언트의 `register` 메시지에 `password` 를 넣습니다.

```json
{ "type": "register", "protocol": "sip", "userId": "1001",
  "contactIp": "192.168.0.100", "contactPort": 5060, "deviceId": "...",
  "password": "내선1001비밀번호" }
```

자세한 내용과 SQL 로 다루는 방법은 [accounts.md](accounts.md).

## 5. 되돌리기

**5-1.** 인증을 끄고 원래 상태로 돌아갑니다.

```bash
sudo ./install.sh --remove
```

`/etc/kamailio/kamailio-local.cfg` 를 백업 후 제거하고 재시작합니다.
데이터베이스는 그대로 둡니다 — 로드되지 않으면 읽지 않으므로 남아 있어도 무해합니다.

**5-2.** 데이터베이스까지 지우려면 (계정이 모두 사라집니다)

```bash
sudo mariadb -e "SELECT COUNT(*) FROM kamailio.subscriber;"   # 먼저 확인
sudo mariadb -e "DROP DATABASE kamailio;"
```

`database.ini` 의 `[database:kamailio]` 항목도 함께 지우지 않으면
다음 `setup_mariadb.sh` 실행 때 다시 만들어집니다.

## 6. 설정을 바꿀 때

**6-1.** `kamailio-local.cfg` 를 고친 뒤 다시 설치합니다.

```bash
sudo ./install.sh --apply
```

**6-2.** 템플릿에 주석 처리해 둔 항목:

| define | 켜면 | 필요한 테이블 |
|---|---|---|
| `WITH_USRLOCDB` | 등록 정보를 DB 에 저장 (재시작해도 유지) | `location`, `location_attrs` |
| `WITH_IPAUTH` | IP 기반 인증 (digest 대신 출발지 주소로 허용) | `address` |
| `WITH_ACCDB` | 통화 기록 저장 | `acc`, `missed_calls` |

**6-3.** 테이블이 더 필요하면 `schema/002-xxx.sql` 로 추가하고 `setup_mariadb.sh` 를 다시 실행합니다.

원본 SQL 은 `/usr/share/kamailio/mysql/` 에 있지만 **그대로 복사하면 안 됩니다.**
`CREATE TABLE` 이 멱등하지 않아 두 번째 실행에서 실패합니다.
`001-auth.sql` 처럼 `IF NOT EXISTS` 로 옮기고, `version` 테이블의 `table_version` 값은
원본과 정확히 같게 두세요. Kamailio 가 기동할 때 검사합니다.

## 7. 문제 해결

**7-1. 기동하지 않음 / DB 오류 — 먼저 볼 것**

```bash
journalctl -u kamailio -n 40 --no-pager
sudo /usr/sbin/kamailio -c -f /etc/kamailio/kamailio.cfg     # 문법만 검사
```

**7-2. `db_mysql ... Access denied for user 'kamailio'` → `Cannot fork` 후 기동 실패**

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

**7-3. `invalid version for table subscriber`** — `version` 테이블의 값이 데몬이 기대하는 것과 다릅니다.
5.7 도구로 스키마를 만들었을 때 생깁니다. `schema/001-auth.sql` 을 다시 적용하세요. (6-3)

**7-4. 올바른 비밀번호인데 401 이 반복됨** — `subscriber.password`(평문) 컬럼이 비어 있습니다.

이 서버의 `auth_db` 는 `calculate_ha1=yes` 라 **평문 `password` 컬럼만 읽습니다.**
`ha1` 컬럼은 값이 있어도 쓰이지 않습니다. 확인:

```sql
SELECT id, username FROM subscriber WHERE password = '';   -- 인증 불가 계정
```

대시보드의 SIP 계정 화면에서 **"인증 불가"** 로 표시되며, 수정에서 비밀번호를 다시 입력하면
정상화됩니다. 원래 비밀번호는 해시에서 되돌릴 수 없으므로, 단말에 설정된 값을 그대로 넣으면
단말을 건드리지 않고 복구됩니다. 자세한 내용은 [accounts.md](accounts.md).

> `kamctlrc` 의 `STORE_PLAINTEXT_PW` 가 `0` 이면 `kamctl add` 도 같은 문제를 만듭니다.
> `install.sh` 는 `1` 로 설정합니다.

**7-4b. realm 과 도메인** — realm 은 단말이 보낸 `From` 도메인이 그대로 쓰이고 DNS 조회는
하지 않습니다. `subscriber.domain` 과 달라도 `use_domain=0` 이라 무관합니다.
다만 단말이 **Request-URI 에도** 그 도메인을 쓴다면 `myself` 에 없어 `403 Not relaying` 이
납니다. 그때는 `kamailio-local.cfg` 에 `alias="pluto.org"` 를 추가하세요.

**7-5. ws-bridge 등록 실패** — `pm2 logs ws-bridge` 에 이유가 남습니다.
비밀번호가 없으면 "register 메시지에 password를 담아 보내세요", 틀리면 "아이디 또는 비밀번호가
올바르지 않습니다" 로 구분됩니다.

## 8. 남은 보안 항목

이 디렉토리의 작업 범위 밖이지만 함께 살펴본 것들입니다.

**8-1. MariaDB 의 노출 범위** — ~~`bind_address = 0.0.0.0`, `[user:jyahn] host = %`~~
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

**8-2. 버전 통일** — 5.5.4(2022년판, 구동 중)와 5.7.7(빌드만 되어 있음, 소스는
`~/Public/RetroLink/kamailio/`). 5.7.7 로 옮기려면 systemd 유닛의 `ExecStart`/`CFGFILE` 을
`/usr/local` 쪽으로 바꾸고 설정을 이식해야 합니다.
인증 스키마는 양쪽이 동일하므로 이 디렉토리와 등록한 계정은 그대로 씁니다.

**8-3. `/etc/kamailio/kamctlrc` 의 배포판 기본 비밀번호** — `install.sh --apply` (3-2-4) 가
파일을 새로 쓰면서 해소됩니다. 그 전까지는 공개된 기본값이 world-readable 상태로 남아 있습니다.

**8-5. SIP 비밀번호가 평문으로 저장됩니다** — 이 Kamailio 설정(`calculate_ha1=yes`)이
평문 컬럼으로 인증하기 때문입니다. 그 평문에 닿을 수 있는 범위가 곧 `jyahn` 의
범위이므로, 8-1 의 확인(옛 `jyahn@%` 가 남아 있지 않은가)이 특히 중요합니다.
평문을 남기지 않으려면 `calculate_ha1` 을 끄는 방식으로 옮겨야 합니다. ([accounts.md](accounts.md))

**8-4. `setup_mariadb.sh` 의 dry-run 부작용** — 비밀번호 생성 함수에 `--dry-run` 가드가 없어
dry-run 이 `secrets/*.pw` 를 실제로 씁니다. Kamailio 뿐 아니라 새로 추가하는 모든 계정에
해당하므로, `setup_mariadb.sh` 쪽을 고치는 편이 근본적입니다. (7-2 참고)
