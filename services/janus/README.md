# Janus — 설치·운영·문제 해결

브라우저(`janus.js`)와 SIP 단말을 잇는 WebRTC ↔ SIP 게이트웨이입니다. WebRTC 를
여기서 끊고 평문 SIP/RTP 로 바꿔 Kamailio 로 보냅니다.

이 문서는 **위에서 아래로 읽으면 빈 장비에서 통화가 되는 상태까지 가도록** 되어
있습니다. 단계마다 번호를 붙였으니 "4 까지 했다" 처럼 가리키면 됩니다.
`services/kamailio/README.md` 와 같은 짜임입니다.

| | |
|---|---|
| 처음 세운다 | [설치](#설치) 를 0 부터 순서대로 |
| 세운 것이 되는지 본다 | [시험](#시험) |
| 이미 세워져 있다 | [운영](#운영) |
| 안 된다 | [문제 해결](#문제-해결) |
| 왜 이렇게 되어 있나 | [배경](#배경) |

```
설치 순서 (자세한 것은 아래 표)

  0 사전 조건(Kamailio) → 1 빌드 의존성 → 2 Janus 소스 빌드
    → 3 설정 · systemd 유닛 → 4 대시보드 빌드 → 5 pm2 등록 → 6 nginx 라우트
    → 7 SIP 계정 → 8 외부 브라우저 받기(선택) → 9 마지막 점검
```

무엇을 왜 이렇게 정했는지는 **[docs/plan.md](docs/plan.md)** 에 있습니다. 결정
사항(트랜스포트·설정 소유·SDP 주소·코덱·포트)과 단계별 검증 방법이 그쪽에 있고,
이 문서는 그것을 **실행 순서**로 옮긴 것입니다.

## 이 디렉토리가 담는 것

**서비스 둘**을 담습니다. 규약이 허용하는 형태입니다
([nginx-conf.md](../../docs/nginx-conf.md) 의 "폴더 안에 `.ini` 가 여러 개여도 됩니다").
`services/kamailio/` 와 같은 구성입니다.

| 서비스 | 무엇 | 포트 | 띄우는 주체 |
|---|---|---|---|
| `janus` | 게이트웨이 자체 | 8088 (API) · 7088 (Admin, 루프백) | **systemd** |
| `janus-dashboard` | 관찰 웹 + 시험 클라이언트 | 28087 | **pm2** |

```
services/janus/
├── README.md               이 문서 — 설치 순서, 시험, 운영, 문제 해결
├── docs/
│   └── plan.md             ★ 계획서 — 결정 사항과 진행 순서
│
│   ── 스크립트 (설치 순서대로) ──
├── bootstrap.sh            ①② 빌드 의존성 점검·설치 · 세우는 순서 출력
├── install.sh              ③ 점검 / 설정·유닛 설치 / 되돌리기        (sudo)
├── setup-dashboard.sh      ④ 대시보드 점검 · 빌드                    (sudo 불필요)
├── ensure-test-accounts.sh ⑦ 시험용 SIP 계정 넷을 만든다             (sudo 불필요)
├── verify-call.sh          시험 ① 브라우저 ↔ 브라우저                (sudo 불필요)
├── verify-bridge.sh        시험 ② WebRTC ↔ 평문 RTP 브리징           (sudo 불필요)
├── check-public-ip.sh      ⑧ 공인 IP 가 바뀌었는지 본다              (sudo 불필요)
├── test-harness/           verify-call.sh · verify-bridge.sh 가 쓰는 하니스
│                          (sipua.js 평문 SIP 단말 · probe-peer.js rtpproxy 관찰)
│
│   ── 설정 ──
├── janus.jcfg              ↘
├── janus.transport.http.jcfg        ↘  /opt/janus/etc/janus/ 로 설치될 원본
├── janus.transport.websockets.jcfg  ↗  (install.sh --apply 가 설치)
├── janus.plugin.sip.jcfg   ↗
├── janus.service           systemd 유닛 원본
├── settings-schema.json    장비마다 다른 값의 정의 (커밋함)
├── settings.ini            그 값 — 공인 IP · 미디어 포트 (커밋하지 않음)
├── secrets/                admin-secret · api-secret · sip-*.pw (600, 커밋 금지)
│
│   ── 규약 선언 ──
├── nginx-conf/
│   ├── service.ini         janus            — 시그널링 API (8088, systemd)
│   └── dashboard.ini       janus-dashboard  — 관찰 웹 (28087, pm2)
├── pm2-conf/
│   ├── app.ini             janus — 껍데기. systemd 가 띄운다
│   ├── dashboard.ini       janus-dashboard — 진짜 프로세스
│   └── not-managed-by-pm2.sh
│
│   ── 대시보드 ──
├── server/                 대시보드 서버 — Node + Express
│   └── src/janus.js          Janus 클라이언트 (info · Admin API)
└── web/                    대시보드 프런트 — React 18 + Vite + Tailwind + shadcn/ui
    └── public/janus.js       빌드 때 /opt/janus 에서 복사 (커밋하지 않음)
```

선언 넷 중 셋이 `enabled = true` 입니다. `pm2-conf/app.ini` 하나만 `false` 인데,
그것은 껍데기라서입니다 — Janus 는 systemd 가 띄웁니다.

미디어(RTP/ICE)는 UDP 포트를 따로 쓰며 nginx 도 pm2 도 거치지 않습니다.
브라우저 쪽과 SIP 쪽이 **각각 다른 범위**를 씁니다 — [plan.md](docs/plan.md) ⑦ 절.

---

# 설치

전체를 훑어보는 표입니다. 각 단계의 자세한 내용은 아래에 이어집니다.

| | 단계 | 명령 | 확인 |
|---|---|---|---|
| **0** | 사전 조건 — Kamailio | `cd ../kamailio && ./bootstrap.sh` | SIP 코어가 떠 있음 |
| **1** | 빌드 의존성 | `sudo ./bootstrap.sh --install` | `./bootstrap.sh` |
| **2** | Janus 소스 빌드 ⚠️ 사람이 | `./configure … && make` | `/opt/janus/bin/janus -v` |
| **3** | 설정 · systemd 유닛 | `sudo ./install.sh --apply` | `systemctl status janus` |
| **4** | 대시보드 빌드 | `./setup-dashboard.sh --build` | `./setup-dashboard.sh` |
| **5** | pm2 등록 | `../../pm2/restart.sh --restart` | `pm2 list` 에 `online` |
| **6** | nginx 라우트 | `sudo ../../nginx/install_nginx_stack.sh --skip-install` | `/janus-api/info` → 200 |
| **7** | SIP 계정 | `./ensure-test-accounts.sh` | `./verify-call.sh` |
| **8** | 외부 브라우저 받기 *(선택)* | 대시보드 설정 → `sudo ./install.sh --apply` | `./check-public-ip.sh` |
| **9** | 마지막 점검 | `./bootstrap.sh` | 전부 초록 |

`./bootstrap.sh` 는 **아무것도 바꾸지 않고** 지금 어디까지 됐는지 알려 주며, 남은
것이 있으면 이 순서를 그대로 출력합니다. 막히면 언제든 이것부터 실행하세요.

```bash
./bootstrap.sh
```

## 0. 사전 조건 — Kamailio 가 먼저

SIP 코어가 없으면 Janus 는 할 일이 없습니다. 등록도 발신도 Kamailio 로 갑니다.

```bash
cd ../kamailio && ./bootstrap.sh
```

Janus 는 Kamailio 의 digest challenge 에 **SIP 플러그인이 직접** 응답합니다 —
브라우저는 `register` 요청에 계정과 비밀번호만 담아 보냅니다
([kamailio/README.md](../kamailio/README.md) 의 0 단계).

## 1. 빌드 의존성

```bash
cd services/janus
./bootstrap.sh                  # 무엇이 있고 무엇이 없는지 (아무것도 바꾸지 않음)
sudo ./bootstrap.sh --install   # 빌드 의존성 패키지만 설치
```

패키지 목록은 짐작이 아니라 실측입니다 — 설치된 바이너리와 `.so` 가 무엇에 링크돼
있는지 `ldd` 로 확인해 뽑았고, 라이브러리가 아니라 **기능** 기준으로 묶어 두었습니다
(왜 필요한지 보이지 않으면 나중에 지워도 되는지 판단할 수 없습니다).

## 2. Janus 소스 빌드 ⚠️ 사람이 보면서

**`bootstrap.sh` 는 Janus 를 빌드하지 않습니다.** 시간이 오래 걸리고 실패 지점이
많아 사람이 보면서 해야 합니다. 대신 필요한 것과 정확한 플래그를 알려 줍니다.

```bash
git clone https://github.com/meetecho/janus-gateway ~/Public/RetroLink/janus-gateway
cd ~/Public/RetroLink/janus-gateway
sh autogen.sh
./configure --prefix=/opt/janus --enable-post-processing --enable-data-channels
make && sudo make install && sudo make configs
```

configure 끝의 요약에서 **SIP plugin 과 REST(HTTP) transport 가 yes** 인지 꼭
보세요 — 아니면 `libsofia-sip-ua-dev` · `libmicrohttpd-dev` 가 빠진 것입니다.

### configure 가 멈추면 — 빠진 라이브러리를 말해 줍니다

```
configure: error: libusrsctp not found. See README.md for installation
instructions or use --disable-data-channels
```

1 단계에서 빠뜨린 것입니다. 필요한 패키지를 넣고 `./configure` 부터 다시 합니다.

```bash
sudo apt-get install -y libusrsctp-dev     # Ubuntu 24.04 noble/universe 에 있습니다
```

`--disable-data-channels` 로 넘어가지 **마세요.** 위의 플래그는 먼저 세운 장비에서
실제로 쓴 것이고, 플래그가 갈리면 "같은 저장소인데 이 장비에서만 안 된다" 가
생깁니다. 빌드된 것이 선언과 같은지는 `install.sh` 가 보지 않습니다 — 이 자리는
사람이 지켜야 합니다.

다른 라이브러리에서 멈춰도 같습니다. `./bootstrap.sh` 가 무엇이 빠졌는지
`sudo ./bootstrap.sh --install` 로 채울 수 있는지 알려 줍니다.

apt 에도 `janus` 패키지(0.11.8)가 있지만 **쓰지 않습니다** — [두 벌 설치를 만들지
않는다](#apt-패키지를-쓰지-않는-이유) 를 보세요.

## 3. 설정 · systemd 유닛 — `install.sh --apply`

`.jcfg`(libconfig)에는 include 가 없어 오버라이드를 둘 수 없으므로, 이 저장소가
설정 파일 넷을 **통째로 소유**합니다 ([plan.md](docs/plan.md) ② 절). 배포본 원본은
옆에 `*.jcfg.sample` 로 그대로 남습니다.

```bash
./install.sh                      # 상태 점검 (sudo 불필요)
sudo ./install.sh                 # janus.jcfg 내용까지 확인 (0640 root:janus)
sudo ./install.sh --apply         # 설정·유닛 설치 후 기동. 실패하면 자동 롤백
sudo ./install.sh --apply -y      # 확인 없이 진행
```

`--apply` 는 `secrets/admin-secret` · `secrets/api-secret` 도 없으면 만듭니다.
Kamailio 는 이 스크립트가 건드리지 않습니다 — 연동 대상으로 상태만 확인합니다.

## 4. 대시보드 빌드

`node_modules/` 와 `web/dist/` 는 커밋하지 않으므로, 이 저장소를 처음 받은 곳에서는
**반드시 한 번 돌려야 합니다.** 빠뜨리면 5 단계에서 pm2 가 `errored` 입니다
([T-3](#t-3-대시보드가-pm2-에서-errored--module_not_found)).

```bash
./setup-dashboard.sh              # 점검 (의존성 · 빌드 · janus.js · 프로세스)
./setup-dashboard.sh --build      # 의존성 · janus.js 복사 · 프런트 빌드
```

`janus.js` 는 번들에 넣지 않고 **설치된 Janus 것**(`/opt/janus/share/janus/javascript/`)을
복사합니다. 버전이 어긋나면 조용히 실패하기 때문입니다. 그래서 2 단계가 먼저입니다.

## 5. pm2 등록

```bash
cd ../../pm2 && ./restart.sh --restart
```

`janus-dashboard` 만 올라옵니다. Janus 본체는 pm2 대상이 아닙니다 —
`pm2-conf/app.ini` 는 껍데기이고 `enabled = false` 입니다. 비워 두지 않고 껍데기라도
두는 이유는, 나중에 보는 사람이 "선언을 빠뜨린 것"과 "pm2 대상이 아닌 것"을 구별할
수 있게 하기 위해서입니다.

## 6. nginx 라우트

**⚠️ 순서가 있습니다. Janus 를 먼저 띄우고 nginx 를 반영하세요.** 뒤집으면
`/janus-api` 가 502 이고 manager 에 중단으로 뜹니다
([T-2](#t-2-janus-api-가-502)).

```bash
../../nginx/install_nginx_stack.sh --check              # 선언 검사 (sudo 불필요)
sudo ../../nginx/install_nginx_stack.sh --skip-install  # 반영
```

| 라우트 | 어디로 |
|---|---|
| `/janus-api` | 127.0.0.1:8088 — 시그널링 REST |
| `/janus-ws` | 127.0.0.1:8188 — 시그널링 WebSocket |
| `/janus/` | 127.0.0.1:28087 — 대시보드 |

Admin API(7088)는 **라우트를 만들지 않습니다.** 루프백 전용입니다.

## 7. SIP 계정

시험 통화와 대시보드의 '시험 통화' 화면은 계정 넷(`9999999901`~`04`)을 씁니다.
실재하지 않는 세대(9999동 9999호)의 시험용이라 스크립트가 만듭니다.

```bash
./ensure-test-accounts.sh --check   # 무엇이 있는지 보기만 한다
./ensure-test-accounts.sh           # 없는 것만 만든다 (sudo 불필요)
```

DB 에 계정을 넣고 비밀번호를 `secrets/sip-<사용자>.pw` 에 둡니다 — `verify-*.sh` 가
그 파일을 읽습니다. 파일과 DB 의 값이 어긋나 있으면 그것도 알려 줍니다 (실제로
있었던 실패입니다 — DB 는 `1234`, 파일은 다른 값이었고 등록이 904 로 실패했습니다).

**실재하는 세대의 계정은 이 스크립트가 만들지 않습니다.** 모바일·월패드는
websocket-relay 가 승인·등록 때 만들고([docs/identity.md](../../docs/identity.md)),
인터폰은 사람이 만듭니다 ([kamailio/accounts.md](../kamailio/accounts.md)).

## 8. 외부(인터넷) 브라우저 받기 *(선택)*

LAN 안에서만 쓸 것이면 건너뜁니다. 공인 IP 가 비어 있으면 `nat_1_1_mapping` 없이
LAN 전용으로 설치됩니다 ([plan.md](docs/plan.md) 9 단계).

**8-1.** 대시보드의 **설정** 화면(`/janus/dashboard/settings`)에서 공인 IP 와 미디어
포트 범위를 넣고 저장합니다. 값은 `settings.ini` 에 저장되고 커밋되지 않습니다.

**8-2.** 화면이 알려 주는 명령을 **사람이** 실행합니다. 대시보드는 sudo 를 부르지
않습니다 — 명령을 보여 줄 뿐입니다.

```bash
sudo ./install.sh --apply
```

**8-3.** 공유기에서 그 범위를 UDP 로 포워딩합니다.

**8-4.** 가정용 회선은 공인 IP 가 바뀝니다. 바뀌는 순간부터 Janus 는 **낡은 주소를
ICE 후보로 광고**하고, 신호는 붙는데 소리가 나지 않습니다
([T-5](#t-5-밖에서-걸면-소리가-나지-않는다--공인-ip)).

```bash
./check-public-ip.sh              # 0 같음 · 1 다름 · 2 확인 불가
./check-public-ip.sh --write      # 현재 값을 settings.ini 에 적는다 (적용은 별개)
```

항목 정의는 `settings-schema.json` 에 있습니다(커밋합니다). 구축 마법사
(`/manager/setup`)의 8 단계도 같은 파일을 읽어 같은 폼을 그리므로, 항목을 늘릴 때는
그 파일 하나만 고치면 양쪽에 반영됩니다 —
[docs/settings-contract.md](../../docs/settings-contract.md).

## 9. 마지막 점검

```bash
./bootstrap.sh                   # 빌드 · 설정 · 유닛 · 기동
./install.sh                     # 설치본이 저장소와 같은가 · /janus-api/info → 200
./setup-dashboard.sh             # 의존성 · 빌드 · janus.js · 프로세스
./verify-call.sh                 # 시험 통화 준비 (전화는 걸지 않는다)
./verify-bridge.sh               # 브리징 준비
```

전부 초록이면 [시험](#시험) 으로 갑니다. 이 다섯은 `--json` 도 받습니다 — 구축
마법사가 그것을 읽습니다 ([docs/check-contract.md](../../docs/check-contract.md)).

## 이 저장소 밖에서 해야 하는 것

| | 왜 밖인가 |
|---|---|
| 공유기 UDP 포워딩 (WebRTC 미디어 범위) | 장비 설정. 8 단계에서 정한 범위 그대로 |
| Janus 소스 빌드 | 오래 걸리고 실패 지점이 많아 사람이 본다 (2 단계) |
| 실재 세대의 SIP 계정 | websocket-relay 와 사람의 몫 (7 단계) |
| 안드로이드 네이티브 앱의 경로 | 아직 정해지지 않음 |

---

# 시험

## 시험 ① 브라우저 ↔ 브라우저 — `verify-call.sh`

```bash
./verify-call.sh                                   # 점검만 (아무 전화도 걸지 않는다)
./verify-call.sh --run                             # 9999999901 → 9999999903
./verify-call.sh --run --from 9999999901 --to 9999999903
```

헤드리스 크롬에서 janus.js 세션 둘을 띄워 **등록 · 발신 · 수락 · 미디어 · 끊기 ·
재발신**을 한 번에 확인합니다. 협상이 됐는지가 아니라 RTP 가 실제로 양방향으로
흘렀는지까지 봅니다 — 이 게이트웨이에서 가장 자주 만나는 실패는 "연결됨인데 소리가
안 난다" 이기 때문입니다. 사람 귀 대신 `getStats` 의 `inbound-rtp.packetsReceived`
로 판정합니다.

| | 무엇을 |
|---|---|
| 5-1 | 둘 다 REGISTER 되는가 |
| 5-2 | 발신 → 착신 → 수락이 이어지는가 |
| 5-3 | RTP 가 양방향으로 실제로 오는가 |
| 5-4 | 끊긴 뒤 다시 걸리는가 |

종료 코드는 `0` 통과 · `1` 실패 · `2` 브라우저 무응답이고, 마지막 실행 기록은
`test-harness/last-run/` 에 남습니다.

## 시험 ② 브라우저 ↔ 평문 RTP 단말 — `verify-bridge.sh`

```bash
./verify-bridge.sh                       # 점검만
./verify-bridge.sh --run                 # 양방향 (발신 · 착신) 다 시험
./verify-bridge.sh --run --out           # 브라우저 → 평문 단말 (6-2) 만
./verify-bridge.sh --run --in            # 평문 단말 → 브라우저 (6-3) 만
```

상대를 **G.711 만 하는 평문 SIP 단말**(`test-harness/sipua.js`, WebRTC 미사용)로 두어
①이 못 재는 것을 잽니다. 브라우저 둘은 언제나 opus 로 붙지만, 그런 상대와는
**PCMU 로 내려앉아야** 하고 그러지 못하면 소리가 나지 않습니다 — Janus 는
트랜스코딩하지 않기 때문입니다 ([plan.md](docs/plan.md) ⑥ 절).
기록은 `test-harness/last-run-bridge/` 에 남습니다.

## 시험 ③ 실단말 — 사람이 받아야 합니다

```bash
./verify-bridge.sh --run --device 9999999902
```

상대를 우리가 세우지 않습니다. 브라우저가 그 번호로 걸고 **사람이 받습니다.** 대신
통화 내내 rtpproxy 에 물어(`probe-peer.js`) 음성·영상 스트림이 각각 실제로 흐르는지
기록합니다 — "안 들린다" 가 무음인지 무패킷인지 가르는 자리입니다.

## 손으로 걸어 보기

| | |
|---|---|
| `https://<서버>/janus/dashboard/test-call` | 연결 → SIP 등록 → 통화. 탭 둘로 `9999999901`·`9999999902` |
| `https://<서버>/manager` | `janus` · `janus-dashboard` 가 둘 다 정상인지 |

## 무엇이 확인됐는가 (2026-08-21 · 192.168.0.252)

아래는 **먼저 세웠던 장비**에서 확인한 결과입니다. 지금 이 장비의 상태는
[배경 › 이 장비의 현황](#이-장비의-현황-2026-09-02-확인) 에 있습니다.

| 확인한 것 | 결과 |
|---|---|
| 브라우저 ↔ 브라우저 | ✅ opus, 양방향 · 재발신 · 세션 정리까지 |
| 브라우저 ↔ 평문 RTP 단말 | ✅ **PCMU** 로 협상, 양방향 (트랜스코딩 없음) |
| 브라우저 ↔ 실단말(안드로이드) | ✅ 음성 양방향 · ⚠️ 영상은 패킷은 가는데 화면에 안 나옴 ([T-7](#t-7-영상이-실단말-화면에-나오지-않는다)) |
| 미디어 경로 | Janus ↔ rtpproxy ↔ Janus (SDP 포트로 확인) |

그때의 동작 상태는 이랬습니다.

```
systemd            active · enabled
시그널링 API        127.0.0.1:8088    GET /janus-api/info → 200
Admin API          127.0.0.1:7088    루프백 전용 (nginx 라우트 없음)
janus-dashboard    127.0.0.1:28087   pm2, /health 200
nginx              /janus-api → 8088,  /janus/ → 28087
미디어             WebRTC 20000-20200  ·  SIP 30000-30200  ·  rtpproxy 10200-19999
```

---

# 운영

## 대시보드

`https://<서버>/janus/dashboard`

manager 로그인 하나로 들어갑니다 — 이 서비스도 계정을 두지 않고 세션만 검증합니다.
화면은 **개요 · 세션·미디어 · 로그 · 시험 통화 · 설정** 입니다.

Janus 를 **읽기만 합니다.** 재시작하거나 설정을 바꾸지 않습니다 — 그건
`install.sh` 가 sudo 로 하는 일입니다. `kamailio-dashboard` 와 같은 자세입니다.

## 로그

이 서비스는 pm2 가 아니라 **systemd** 가 띄우므로 `pm2 logs` 에 나오지 않습니다.
대시보드의 **로그** 탭이 저널을 그대로 보여 줍니다 (줄 수·기간·정규식 필터·따라가기).

```bash
journalctl -u janus -f            # Janus 본체
pm2 logs janus-dashboard          # 대시보드
```

## 접속 주소

클라이언트를 짤 때 필요한 주소는 **개요 화면의 '접속 주소' 카드**에 있습니다.
주소를 화면에 따로 적어 두지 않고 `nginx-conf/*.ini` 를 읽어 그립니다 — nginx
설정을 만드는 바로 그 파일이라 실제 라우팅과 어긋나지 않습니다.

| 용도 | 밖에서 | 안에서 |
|---|---|---|
| 시그널링 (REST) | `https://<서버>/janus-api` | `http://127.0.0.1:8088/janus-api` |
| 시그널링 (WebSocket) | `wss://<서버>/janus-ws` | `ws://127.0.0.1:8188` |
| Admin API | 열지 않음 | `http://127.0.0.1:7088/admin` |

`janus.js` 는 **주는 주소의 스킴으로 트랜스포트를 고릅니다** — `wss://` 면
WebSocket, `https://` 면 REST 입니다. 둘 다 살아 있습니다. 직접 짠 WebSocket
클라이언트라면 서브프로토콜 `janus-protocol` 을 요청해야 합니다 (빠뜨리면
핸드셰이크에서 끊깁니다). 모든 요청에는 `apisecret` 이 필요하고, 값은
`secrets/api-secret` 입니다.

WS 주소는 카드의 **붙어 보기** 단추로 브라우저에서 바로 핸드셰이크해 볼 수
있습니다. 클라이언트가 겪을 것과 같은 경로(서브프로토콜 포함)로 시험합니다.

## 클라이언트를 만든다면

앱이 무엇을 어떤 순서로 해야 하는지는
**[docs/client-guide.md](../../docs/client-guide.md)** 에 있습니다 — 세션·핸들·
SIP 등록·발신·착신의 실제 JSON, 그리고 조용히 실패하는 자리들(서브프로토콜,
`outbound_proxy`, 코덱, keepalive)을 모아 두었습니다.

## API 비밀도 대시보드에서 봅니다

`apisecret` 은 개요 화면에 가려진 채로 있고, **보기** 를 누르면 로그인 비밀번호를
한 번 더 묻습니다. 세션 쿠키만으로는 내려 주지 않습니다 — 로그인한 채 자리를 비운
화면 하나로 새어 나가지 않게 하려는 것입니다. 확인은 계정을 소유한 manager 가
하고(`POST /manager/api/verify-password`), 이 서비스는 비밀번호를 판단하지도
저장하지도 않습니다. 1 분 뒤 저절로 다시 가려집니다.

## 설정을 바꿀 때

**O-1.** `.jcfg` 나 `settings.ini` 를 고친 뒤 다시 설치합니다. `install.sh --apply`
는 언제 다시 실행해도 됩니다 (검사 실패 시 자동 롤백).

```bash
sudo ./install.sh --apply
```

**O-2. 올리는 플러그인은 셋입니다.**

| | 무엇에 |
|---|---|
| `sip` | 이 게이트웨이의 본업 (인터폰 ↔ 모바일) |
| `echotest` | "브라우저 ↔ Janus 미디어 경로만" 을 SIP 없이 떼어 확인할 때 |
| `videoroom` | WebRTC 클라이언트의 다자 통화 |

나머지는 빌드는 돼 있지만 `janus.jcfg` 의 `plugins.disable` 로 올리지 않습니다 —
올려 두면 쓰지 않는 API 가 열려 있게 되고 "어느 쪽이 진짜 경로인지" 가 흐려집니다.
하나 켜려면 그 목록에서 빼고 `sudo ./install.sh --apply` 를 돌립니다. 점검이
**선언대로 올라왔는지** 확인해 줍니다 ([T-9](#t-9-선언한-플러그인이-올라오지-않았다)).

> `videoroom` 의 설정 파일(`janus.plugin.videoroom.jcfg`)은 **저장소가 소유하지
> 않습니다.** 방은 API 로만 만들기로 했으므로 배포본 파일을 그대로 둡니다.
> 고정 방을 설정에 박아 두게 되면 그때 `install.sh` 의 `OWNED_CFGS` 에 넣으세요 —
> 그러지 않으면 그 파일은 "설치본이 저장소와 같은가" 점검 밖에 있게 됩니다.

## 되돌리기

```bash
sudo ./install.sh --remove        # 설정·유닛을 걷어낸다 (secrets/ 는 남긴다)
```

`secrets/` 를 남기는 것은 다시 설치할 때 같은 `apisecret` 으로 붙기 위해서입니다.
Kamailio 의 SIP 계정은 건드리지 않습니다 — 그쪽이 소유합니다.

---

# 문제 해결

| 증상 | 항목 |
|---|---|
| 기동하지 않음 | [T-1](#t-1-기동하지-않음--먼저-볼-것) |
| `/janus-api` 가 502 | [T-2](#t-2-janus-api-가-502) |
| pm2 에서 `errored` — `MODULE_NOT_FOUND` | [T-3](#t-3-대시보드가-pm2-에서-errored--module_not_found) |
| 연결은 됐는데 소리가 안 난다 | [T-4](#t-4-연결은-됐는데-소리가-안-난다) |
| 밖에서 걸면 소리가 나지 않는다 | [T-5](#t-5-밖에서-걸면-소리가-나지-않는다--공인-ip) |
| SIP 등록 실패 (401 · 403 · 904) | [T-6](#t-6-sip-등록-실패-401--403--904) |
| 영상이 실단말 화면에 나오지 않는다 | [T-7](#t-7-영상이-실단말-화면에-나오지-않는다) |
| `verify-*.sh` 가 계정 비밀번호를 못 찾는다 | [T-8](#t-8-verify-sh-가-계정-비밀번호를-못-찾는다) |
| 선언한 플러그인이 올라오지 않았다 | [T-9](#t-9-선언한-플러그인이-올라오지-않았다) |
| 소스 빌드의 `configure` 가 멈춘다 | [설치 2 단계](#configure-가-멈추면--빠진-라이브러리를-말해-줍니다) |

## T-1. 기동하지 않음 — 먼저 볼 것

```bash
journalctl -u janus -n 40 --no-pager
./install.sh                       # 설치본이 저장소와 같은가 · 무엇이 빠졌는가
```

`--apply` 는 검사에 실패하면 **자동으로 되돌립니다.** 그러므로 "적용했는데 옛
설정으로 돌고 있다" 면 롤백된 것입니다 — 저널에 이유가 남아 있습니다.

## T-2. `/janus-api` 가 502

nginx 는 라우트를 만들었는데 백엔드가 없는 상태입니다. **순서를 뒤집으면 반드시
이렇게 됩니다** (6 단계). manager 대시보드에도 중단으로 뜹니다.

```bash
systemctl is-active janus
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8088/janus-api/info
```

127.0.0.1:8088 이 200 인데 밖에서 502 면 nginx 반영이 안 된 것입니다
(`sudo ../../nginx/install_nginx_stack.sh --skip-install`). 8088 부터 안 되면 T-1.

## T-3. 대시보드가 pm2 에서 `errored` — `MODULE_NOT_FOUND`

4 단계(대시보드 빌드)를 건너뛴 것입니다. `node_modules/` 와 `web/dist/` 는 커밋하지
않으므로 저장소를 처음 받은 장비에서는 **반드시 한 번** 빌드해야 합니다.

```bash
pm2 logs janus-dashboard --err --lines 20 --nostream    # code: 'MODULE_NOT_FOUND'
./setup-dashboard.sh --build
cd ../../pm2 && ./restart.sh --restart
```

`kamailio-dashboard` 의 [T-9](../kamailio/README.md#t-9-pm2-에서-errored--module_not_found) 와
같은 모양입니다.

## T-4. 연결은 됐는데 소리가 안 난다

이 게이트웨이에서 가장 자주 만나는 실패입니다. 신호(SIP)와 미디어(RTP)가 서로 다른
경로를 타기 때문에, 신호만 보고는 알 수 없습니다.

```bash
./verify-call.sh --run       # 브라우저 둘 사이는 되는가 (opus)
./verify-bridge.sh --run     # 평문 RTP 단말과는 되는가 (PCMU)
```

| 어느 쪽이 | 무엇을 의심하는가 |
|---|---|
| ① 은 되고 ② 가 안 되면 | **코덱**입니다 — 상대가 G.711 만 하는데 PCMU 로 내려앉지 못했습니다. Janus 는 트랜스코딩하지 않습니다 ([plan.md](docs/plan.md) ⑥ 절) |
| 둘 다 안 되면 | **미디어 포트** 또는 **SDP 에 실린 주소**입니다 ([plan.md](docs/plan.md) ③ ⑦ 절) |
| 밖에서만 안 되면 | [T-5](#t-5-밖에서-걸면-소리가-나지-않는다--공인-ip) |

## T-5. 밖에서 걸면 소리가 나지 않는다 — 공인 IP

가정용 회선은 공인 IP 가 바뀝니다. 바뀐 뒤에도 Janus 는 설치될 때 박힌 낡은 주소를
ICE 후보로 광고하므로, 신호는 붙고 화면에는 아무 오류도 뜨지 않습니다.

```bash
./check-public-ip.sh              # 0 같음 · 1 다름 · 2 확인 불가
./check-public-ip.sh --write && sudo ./install.sh --apply
```

주기적으로 보려면 crontab 에 넣습니다.

```
*/30 * * * * /path/to/services/janus/check-public-ip.sh --quiet \
             || echo "janus: 공인 IP 가 바뀌었습니다" | logger -t janus-natcheck
```

공유기 UDP 포워딩이 그대로인지도 함께 보세요 (8 단계).

## T-6. SIP 등록 실패 (401 · 403 · 904)

등록은 Janus 가 아니라 **Kamailio** 가 판정합니다. 그쪽 문제 해결을 먼저 보세요 —
[T-4 올바른 비밀번호인데 401](../kamailio/README.md#t-4-올바른-비밀번호인데-401-이-반복됨) ·
[T-5 `403 Not relaying`](../kamailio/README.md#t-5-403-not-relaying--realm-과-도메인) ·
[T-7 Janus 등록 실패](../kamailio/README.md#t-7-janus-등록-실패).

시험 계정이라면 값이 어긋난 것일 수 있습니다 ([T-8](#t-8-verify-sh-가-계정-비밀번호를-못-찾는다)).

```bash
./ensure-test-accounts.sh --check
journalctl -u kamailio -f | grep REGISTER
```

## T-7. 영상이 실단말 화면에 나오지 않는다

`9999999901 → 9999999902` 방향에서 확인된 **미해결 항목**입니다. 서버 쪽은 확인이
끝났습니다 — SDP 협상도, rtpproxy 중계도, 패킷 도달(1416 개)도 정상입니다. 남은 것은
단말이 그 H264 스트림을 디코딩해 그리는 부분입니다.

```bash
./verify-bridge.sh --run --device 9999999902    # 음성·영상 스트림을 각각 기록
```

자세한 단서는 [docs/plan.md](docs/plan.md) 의 7 단계 절에 있습니다.

## T-8. `verify-*.sh` 가 계정 비밀번호를 못 찾는다

```
[!!]   9999999901: secrets/sip-9999999901.pw 가 없습니다
```

7 단계를 건너뛴 것입니다. 파일은 있는데 등록이 904 로 실패한다면 **DB 의 값과 파일의
값이 어긋난 것**입니다 — `--check` 가 그 경우도 짚어 줍니다.

```bash
./ensure-test-accounts.sh --check
./ensure-test-accounts.sh
```

`secrets/api-secret` 이 없다는 경고라면 3 단계입니다 (`sudo ./install.sh --apply`).

## T-9. 선언한 플러그인이 올라오지 않았다

```
[ok]   sip 올라옴
[ok]   echotest 올라옴
[--]   videoroom 이 선언에는 켜져 있는데 올라오지 않았습니다 → sudo ./install.sh --apply
```

`janus.jcfg` 는 고쳤는데 설치하지 않았거나, 그 `.so` 가 빌드되지 않은 것입니다.
후자면 2 단계의 configure 요약을 다시 보세요.

---

# 배경

## 진행 상황

| | 단계 | 상태 |
|---|---|---|
| 1 | 계획서 · 서비스 선언 · 점검 스크립트 | ✅ (2026-08-20) |
| 2 | Janus 설정 소유 (`.jcfg` 넷) · systemd 유닛 · 기동 | ✅ (2026-08-20) |
| 3 | 대시보드 서비스 · nginx 라우트 개방 | ✅ (2026-08-20) |
| 4 | Kamailio 연동 (SIP 등록) | ✅ (2026-08-20) |
| 5 | 시험 통화 ① 브라우저 ↔ 브라우저 | ✅ (2026-08-21) — `verify-call.sh` |
| 6 | 시험 통화 ② 브라우저 ↔ 평문 RTP 단말 | ✅ (2026-08-21) — `verify-bridge.sh` |
| 7 | 시험 통화 ③ 브라우저 ↔ 실단말 | ✅ 음성 · ⚠️ **영상 표시 미해결** ([T-7](#t-7-영상이-실단말-화면에-나오지-않는다)) |
| 8 | 대시보드 화면 채우기 | ✅ (2026-08-21) — `세션·미디어` 탭 |
| 9 | 외부(인터넷) 브라우저 받기 | 🔸 설정 준비됨 — **공유기 포워딩과 적용이 남음** |
| 10 | 정리 | ✅ (2026-08-21) |

각 단계의 내용과 검증 방법은 [docs/plan.md](docs/plan.md) 의 "진행 순서" 에 있습니다.
위 표는 **코드가 어디까지 왔는가**이지 이 장비가 어디까지 됐는가가 아닙니다.

## 이 장비의 현황 (2026-09-02 확인)

**이 장비(`10.10.0.224`)에는 Janus 가 아직 설치되어 있지 않습니다.** 위의 ✅ 들은
먼저 세웠던 장비(`192.168.0.252`)에서 확인한 것입니다.

| 항목 | 값 |
|---|---|
| `/opt/janus` | **없음** — 1·2 단계부터 시작해야 합니다 |
| `janus.service` | **없음** (systemd 에 등록되지 않음) |
| `janus-dashboard` | pm2 에 `errored` — `MODULE_NOT_FOUND` ([T-3](#t-3-대시보드가-pm2-에서-errored--module_not_found)) |
| `secrets/` | **없음** — 3 단계에서 만들어집니다 |
| Kamailio | `/usr/sbin/kamailio` **5.7.4** 구동 중, `10.10.0.224:5060` · `127.0.0.1:5060` |
| Kamailio 설정 | 배포판 그대로 — 이 저장소의 포크는 아직 설치되지 않음 ([kamailio/README.md](../kamailio/README.md) 의 현황) |

> 이 표는 사람이 손으로 옮겨 적은 것이라 언제든 뒤처집니다. 같은 내용을
> `./bootstrap.sh` 와 `./install.sh` 가 그 자리에서 찍어 주므로, 문서와 다르면
> **스크립트 출력을 믿으세요.**

## 먼저 세운 장비의 현황 (2026-08-20 확인 · `192.168.0.252`)

| 항목 | 값 |
|---|---|
| Janus | `/opt/janus/bin/janus` **1.4.1** — 2026-03-05 소스 빌드 |
| 빌드 옵션 | `--prefix=/opt/janus --enable-post-processing --enable-data-channels` |
| 소스 | `~/Public/RetroLink/janus-gateway` (`v1.4.0-5-gae0078e1`) |
| 플러그인 | **빌드된 것** SIP · echotest · videoroom · audiobridge · streaming · nosip · textroom · recordplay · videocall |
| 올리는 플러그인 | **sip · echotest · videoroom** — 나머지는 `janus.jcfg` 의 `plugins.disable` |
| 트랜스포트 | HTTP · WebSocket · Unix socket |
| `janus.js` | `/opt/janus/share/janus/javascript/janus.js` |
| 설정 | 이 저장소가 소유 — `.jcfg` 넷을 `install.sh --apply` 가 설치 |
| 기동 | `janus.service` (systemd), `janus` 사용자, 8088 · 7088 루프백 |
| 미디어 포트 | WebRTC `20000-20200/udp` · SIP `30000-30200/udp` |
| Kamailio | 5.5.4 구동 중 — `192.168.0.252:5060` (udp/tcp), digest 인증, `alias=pluto.org` |

## apt 패키지를 쓰지 않는 이유

apt 에도 `janus` 패키지(0.11.8)가 있지만 **쓰지 않습니다.** 설정 폴더와 모듈 경로가
갈려 어느 쪽이 도는지 헷갈리게 됩니다. Kamailio 에서 5.5.4(배포판)와
5.7.7(소스빌드)이 함께 있어 겪은 것과 같은 종류의 문제입니다
([kamailio/README.md](../kamailio/README.md) 의 "두 벌 설치").

## 왜 rtpengine 이 필요 없는가

이 저장소에는 다른 방식의 SIP 계획이 있었습니다
([kamailio/docs/websocket-plan.md](../kamailio/docs/websocket-plan.md)).
그쪽은 단말이 SIP 를 직접 말하고(`wss://…/sip/`) 미디어를 **rtpengine** 이
브리징하는 구조인데, rtpengine 데몬이 배포판 저장소에 없어 2 단계에서 막혀
있었습니다.

**그 계획은 채택되지 않았습니다 (2026-08-21).** 브라우저도 모바일도 Janus 로
붙기로 정했으므로 rtpengine 은 영구히 필요 없어졌습니다 — 그것을 요구하던 것이
그 경로뿐이었기 때문입니다.

Janus 는 그 브리징을 **자기가** 합니다. 다만 Janus 가 대신해 주지 **않는** 것이
둘 있습니다.

- 자는 모바일 깨우기 (tsilo + FCM) — Kamailio 라우트 안의 일 ([incoming-call.md](../kamailio/docs/incoming-call.md))
- 안드로이드 네이티브 앱의 경로 — 아직 정해지지 않음

기존 `/sip/` 라우트는 그대로 둡니다. 포트도 경로도 겹치지 않습니다.

### ⚠️ 미디어 릴레이는 이미 하나 돌고 있습니다

계획서가 처음에 "미디어 릴레이 데몬이 없다" 는 인상을 주었는데 정확하지
않았습니다. 없는 것은 **rtpengine** 이고, 배포판 **`rtpproxy` 1.2.1** 이 별도
systemd 유닛으로 돌고 있습니다 (`-s udp:127.0.0.1 7722`, `-l 192.168.0.252`).

`WITH_NAT` 이 켜져 있고 LAN 단말의 Contact 가 사설 주소라 Kamailio 는 **모든 LAN
등록을 NAT 뒤로 판정**합니다. 그래서 통화 때 `rtpproxy_manage()` 가 불리고,
미디어가 rtpproxy 를 거칩니다.

rtpproxy 1.2.1 은 SRTP·DTLS·ICE 를 모르지만 **알 필요가 없습니다** — WebRTC 는
Janus 가 이미 끊었고 Kamailio 가 보는 것은 평문 RTP 뿐입니다. rtpengine 대신
Janus 를 쓰는 이 구조의 이점이 드러나는 자리입니다.
자세한 경위는 [docs/plan.md](docs/plan.md) ③ 절의 정정에 있습니다.

## 관련 문서

- 계획서 → [docs/plan.md](docs/plan.md)
- 클라이언트 구현 → [docs/client-guide.md](../../docs/client-guide.md)
- 라우팅 선언 스키마 → [docs/nginx-conf.md](../../docs/nginx-conf.md)
- 프로세스 선언 스키마 → [docs/pm2-conf.md](../../docs/pm2-conf.md)
- 장비별 값 규약 → [docs/settings-contract.md](../../docs/settings-contract.md)
- 점검 출력 규약 → [docs/check-contract.md](../../docs/check-contract.md)
- `/health` 규약 → [docs/health-contract.md](../../docs/health-contract.md)
- SIP 서버 → [services/kamailio/README.md](../kamailio/README.md)
- SIP 계정 등록 → [services/kamailio/accounts.md](../kamailio/accounts.md)
