# Janus — WebRTC ↔ SIP 게이트웨이

브라우저(`janus.js`)와 SIP 단말을 잇는 게이트웨이입니다. WebRTC 를 여기서 끊고
평문 SIP/RTP 로 바꿔 Kamailio 로 보냅니다.

```
services/janus/
├── README.md               이 문서 — 현황, 설치 순서, 문제 해결
├── docs/
│   └── plan.md             ★ 계획서 — 결정 사항과 진행 순서. 여기부터 읽으세요
├── install.sh              점검 / 설정 설치 / 되돌리기  (sudo)
├── setup-dashboard.sh      대시보드 점검 · 빌드            (sudo 불필요)
├── verify-call.sh          시험 통화를 사람 없이 돌린다     (sudo 불필요)
├── verify-bridge.sh        WebRTC ↔ 평문 RTP 브리징 확인   (sudo 불필요)
├── test-harness/           verify-call.sh 가 쓰는 헤드리스 하니스
├── janus.jcfg              ↘
├── janus.transport.http.jcfg        ↘  /opt/janus/etc/janus/ 로 설치될 원본
├── janus.transport.websockets.jcfg  ↗  (install.sh --apply 가 설치)
├── janus.plugin.sip.jcfg   ↗
├── janus.service           systemd 유닛 원본
├── secrets/                admin-secret · api-secret (600, 커밋 금지)
├── nginx-conf/
│   ├── service.ini         janus            — 시그널링 API (8088, systemd)
│   └── dashboard.ini       janus-dashboard  — 관찰 웹 (28087, pm2)
├── pm2-conf/
│   ├── app.ini             janus — 껍데기. systemd 가 띄운다
│   ├── dashboard.ini       janus-dashboard — 진짜 프로세스
│   └── not-managed-by-pm2.sh
├── server/                 대시보드 서버 — Node + Express
│   └── src/janus.js          Janus 클라이언트 (info · Admin API)
└── web/                    대시보드 프런트 — React 18 + Vite + Tailwind + shadcn/ui
    └── public/janus.js       빌드 때 /opt/janus 에서 복사 (커밋하지 않음)
```

이 디렉토리는 **서비스 둘**을 담습니다. 규약이 허용하는 형태입니다
([nginx-conf.md](../../docs/nginx-conf.md) 의 "폴더 안에 `.ini` 가 여러 개여도 됩니다").
`services/kamailio/` 와 같은 구성입니다.

| 서비스 | 무엇 | 포트 | 띄우는 주체 |
|---|---|---|---|
| `janus` | 게이트웨이 자체 | 8088 (API) · 7088 (Admin, 루프백) | systemd |
| `janus-dashboard` | 관찰 웹 + 시험 클라이언트 | 28087 | pm2 |

미디어(RTP/ICE)는 UDP 포트를 따로 쓰며 nginx 도 pm2 도 거치지 않습니다.
브라우저 쪽과 SIP 쪽이 **각각 다른 범위**를 씁니다 — [plan.md](docs/plan.md) ⑦ 절.

## 진행 상황

| | 단계 | 상태 |
|---|---|---|
| 1 | 계획서 · 서비스 선언 · 점검 스크립트 | ✅ **완료** (2026-08-20) |
| 2 | Janus 설정 소유 (`.jcfg` 넷) · systemd 유닛 · 기동 | ✅ **완료** (2026-08-20) |
| 3 | 대시보드 서비스 · nginx 라우트 개방 | ✅ **완료** — 브라우저 확인만 남음 |
| 4 | Kamailio 연동 (SIP 등록) | ✅ **완료** (2026-08-20) |
| 5 | 시험 통화 ① 브라우저 ↔ 브라우저 | 🔸 1차 실패 — [docs/plan.md](docs/plan.md) 의 "1차 시도" |
| 6 | 시험 통화 ② 브라우저 ↔ 소프트폰 | ⬜ |
| 7 | 시험 통화 ③ 브라우저 ↔ 인터폰 | ⬜ |
| 8 | 대시보드 화면 채우기 | ⬜ |
| 9 | 외부(인터넷) 브라우저 받기 | ⬜ |
| 10 | 정리 | ⬜ |

각 단계의 내용과 검증 방법은 [docs/plan.md](docs/plan.md) 의 "진행 순서" 에 있습니다.

선언 넷 중 셋이 `enabled = true` 입니다. `pm2-conf/app.ini` 하나만 `false` 인데,
그것은 껍데기라서입니다 — Janus 는 systemd 가 띄웁니다.

### 지금 상태 — 떠 있습니다

```
systemd            active · enabled
시그널링 API        127.0.0.1:8088    GET /janus-api/info → 200
Admin API          127.0.0.1:7088    루프백 전용 (nginx 라우트 없음)
janus-dashboard    127.0.0.1:28087   pm2, /health 200
nginx              /janus-api → 8088,  /janus/ → 28087
```

`janus.js` 가 하는 순서를 `curl` 로 그대로 재현해 확인했습니다 — 세션 생성 ·
SIP 플러그인 attach · long-poll 이벤트 수신 · Admin API 조회까지
([docs/plan.md](docs/plan.md) 의 "3-3·3-4 에서 확인한 것").

남은 것은 **브라우저에서 눌러 보는 것** 하나입니다.

| | |
|---|---|
| `https://<서버>/manager` | `janus` · `janus-dashboard` 둘 다 정상 |
| `https://<서버>/janus/dashboard` | 개요 — 버전 · ICE · 올라온 모듈 |
| `https://<서버>/janus/dashboard/test-call` | 연결 → SIP 등록 → 통화. 탭 둘로 `2001`·`2002` |

### 다시 세우거나 되돌릴 때

```bash
cd services/janus
./install.sh                      # 상태 점검 (sudo 불필요)
sudo ./install.sh                 # janus.jcfg 내용까지 확인 (0640 root:janus)
sudo ./install.sh --apply         # 설정·유닛 재설치 후 기동. 실패하면 자동 롤백
sudo ./install.sh --remove        # 걷어내기 (secrets/ 는 남긴다)

./setup-dashboard.sh              # 대시보드 점검
./setup-dashboard.sh --build      # 의존성 · janus.js 복사 · 프런트 빌드

./verify-call.sh                  # 시험 통화 점검 (전화를 걸지 않는다)
./verify-call.sh --run            # 2001 → 2003 으로 실제로 걸어 본다

./verify-bridge.sh                # 브리징 점검
./verify-bridge.sh --run          # 브라우저 ↔ 평문 RTP 단말, 양방향
```

`verify-call.sh --run` 은 헤드리스 크롬에서 janus.js 세션 둘을 띄워 **등록 ·
발신 · 수락 · 미디어 · 끊기 · 재발신**을 한 번에 확인합니다. 협상이 됐는지가
아니라 RTP 가 실제로 양방향으로 흘렀는지까지 봅니다 — 이 게이트웨이에서 가장
자주 만나는 실패는 "연결됨인데 소리가 안 난다" 이기 때문입니다.

종료 코드는 `0` 통과 · `1` 실패 · `2` 브라우저 무응답이고, 마지막 실행 기록은
`test-harness/last-run/` 에 남습니다. 계정 비밀번호는 `secrets/sip-<사용자>.pw`
에서 읽습니다 — 계정 자체는 사람이 만듭니다 (`../kamailio/accounts.md`).

`verify-bridge.sh` 는 상대를 **평문 RTP 만 하는 SIP 단말**(`test-harness/sipua.js`,
WebRTC 미사용)로 두어 `verify-call.sh` 가 못 재는 것을 잽니다. 브라우저 둘은
언제나 opus 로 붙지만, G.711 만 하는 상대와는 **PCMU 로 내려앉아야** 하고
그러지 못하면 소리가 나지 않습니다 — Janus 는 트랜스코딩하지 않기 때문입니다.
기록은 `test-harness/last-run-bridge/` 에 남습니다.

`node_modules/` 와 `web/dist/` 는 커밋하지 않으므로, 이 저장소를 처음 받은
곳에서는 `setup-dashboard.sh --build` 를 한 번 돌려야 합니다.

**순서가 있습니다.** Janus 를 먼저 띄우고 nginx 를 반영하세요. 뒤집으면
`/janus-api` 가 502 이고 manager 에 중단으로 뜹니다.

```bash
sudo ./nginx/install_nginx_stack.sh --skip-install
```

## 확인된 현황 (2026-08-20)

| 항목 | 값 |
|---|---|
| Janus | `/opt/janus/bin/janus` **1.4.1** — 2026-03-05 소스 빌드 |
| 빌드 옵션 | `--prefix=/opt/janus --enable-post-processing --enable-data-channels` |
| 소스 | `~/Public/RetroLink/janus-gateway` (`v1.4.0-5-gae0078e1`) |
| 플러그인 | SIP · echotest · videoroom · audiobridge · streaming · nosip · textroom · recordplay · videocall |
| 트랜스포트 | HTTP · WebSocket · Unix socket |
| `janus.js` | `/opt/janus/share/janus/javascript/janus.js` |
| 설정 | 이 저장소가 소유 — `.jcfg` 넷을 `install.sh --apply` 가 설치 |
| 기동 | `janus.service` (systemd), `janus` 사용자, 8088 · 7088 루프백 |
| 미디어 포트 | WebRTC `20000-20200/udp` · SIP `30000-30200/udp` |
| Kamailio | 5.5.4 구동 중 — `192.168.0.252:5060` (udp/tcp), digest 인증, `alias=pluto.org` |

apt 에도 `janus` 패키지(0.11.8)가 있지만 **쓰지 않습니다.** 설정 폴더와 모듈 경로가
갈려 어느 쪽이 도는지 헷갈리게 됩니다. Kamailio 에서 5.5.4(배포판)와
5.7.7(소스빌드)이 함께 있어 겪은 것과 같은 종류의 문제입니다
([kamailio/README.md](../kamailio/README.md) 의 "두 벌 설치").

## 왜 rtpengine 이 필요 없는가

이 저장소에는 이미 다른 방식의 SIP 계획이 있습니다
([kamailio/docs/websocket-plan.md](../kamailio/docs/websocket-plan.md)).
그쪽은 단말이 SIP 를 직접 말하고(`wss://…/sip/`) 미디어를 **rtpengine** 이
브리징하는 구조인데, rtpengine 데몬이 배포판 저장소에 없어 2단계에서 막혀
있습니다.

Janus 는 그 브리징을 **자기가** 합니다. 브라우저 경로에 한해 rtpengine 조달이
필요 없어집니다. 다만 Janus 가 대신해 주지 **않는** 것이 둘 있습니다.

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
- 라우팅 선언 스키마 → [docs/nginx-conf.md](../../docs/nginx-conf.md)
- 프로세스 선언 스키마 → [docs/pm2-conf.md](../../docs/pm2-conf.md)
- `/health` 규약 → [docs/health-contract.md](../../docs/health-contract.md)
- SIP 서버 → [services/kamailio/README.md](../kamailio/README.md)
- SIP 계정 등록 → [services/kamailio/accounts.md](../kamailio/accounts.md)
