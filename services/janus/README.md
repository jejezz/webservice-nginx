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

## ⚠️ 지금은 1단계입니다 — 아직 동작하지 않습니다

| | 단계 | 상태 |
|---|---|---|
| 1 | 계획서 · 서비스 선언 · 점검 스크립트 | ✅ **완료** (2026-08-20) |
| 2 | Janus 설정 소유 (`.jcfg` 넷) · systemd 유닛 · 기동 | 🔸 **설치 대기** — 아래 참고 |
| 3 | 대시보드 서비스 · nginx 라우트 개방 | 🔸 **반영 대기** — 코드·빌드 완료 |
| 4 | Kamailio 연동 (SIP 등록) | ⬜ |
| 5 | 시험 통화 ① 브라우저 ↔ 브라우저 | ⬜ |
| 6 | 시험 통화 ② 브라우저 ↔ 소프트폰 | ⬜ |
| 7 | 시험 통화 ③ 브라우저 ↔ 인터폰 | ⬜ |
| 8 | 대시보드 화면 채우기 | ⬜ |
| 9 | 외부(인터넷) 브라우저 받기 | ⬜ |
| 10 | 정리 | ⬜ |

각 단계의 내용과 검증 방법은 [docs/plan.md](docs/plan.md) 의 "진행 순서" 에 있습니다.

**선언 넷은 모두 `enabled = false`** 입니다. Janus 가 아직 기동된 적이 없어서,
켜면 그 경로는 502 이고 manager 대시보드에도 중단으로 뜹니다. 2·3단계가 끝난 뒤에
켭니다. (kamailio 도 같은 순서를 밟았습니다)

### 2단계 — 설치할 것은 다 준비됐고, 실행만 남았습니다

설정 원본 넷과 systemd 유닛, `install.sh --apply` 가 모두 준비돼 있습니다.
`/opt/janus` 를 건드리지 않고 임시 폴더에서 같은 설정으로 한 번 띄워
확인까지 마쳤습니다 ([docs/plan.md](docs/plan.md) 의 "설치 전 예행").

남은 것은 **root 권한이 필요한 한 줄**입니다.

```bash
cd services/janus && sudo ./install.sh --apply
```

무엇을 하는지:

| | 내용 |
|---|---|
| 1 | 시스템 사용자 `janus` 확인 (이미 있으면 건너뜀) |
| 2 | `secrets/{admin-secret,api-secret}` 생성 (없을 때만, 600, 실행한 사용자 소유) |
| 3 | 기존 `/opt/janus/etc/janus/*.jcfg` 를 `*.bak.<타임스탬프>` 로 백업 |
| 4 | 설정 넷 설치 — `janus.jcfg` 만 `0640 root:janus` (비밀이 들어감) |
| 5 | `janus.service` 설치 · `daemon-reload` · `enable` |
| 6 | `restart` 후 **`GET /janus-api/info` 가 200 이 될 때까지 확인** |
| 7 | 실패하면 백업으로 되돌리고 저널 20줄을 보여 준 뒤 멈춤 |

되돌리려면:

```bash
cd services/janus && sudo ./install.sh --remove
```

### 3단계 — 대시보드는 만들어졌고, 반영만 남았습니다

`server/` · `web/` 를 만들고 빌드까지 마쳤습니다. 루프백에서 직접 띄워
`/health` · 인증 · 정적 파일 응답을 확인했습니다
([docs/plan.md](docs/plan.md) 의 "3-1·3-2 에서 확인한 것").

선언 셋(`nginx-conf/service.ini` · `nginx-conf/dashboard.ini` ·
`pm2-conf/dashboard.ini`)도 `enabled = true` 로 바꿔 두었습니다.

**순서가 중요합니다.** Janus 를 먼저 띄우고 nginx 를 반영하세요. 뒤집으면
`/janus-api/` 가 502 이고 manager 에 중단으로 뜹니다.

`node_modules/` 와 `web/dist/` 는 커밋하지 않으므로, 이 저장소를 처음 받은
곳에서는 `setup-dashboard.sh --build` 를 한 번 돌려야 합니다.

```bash
cd services/janus
sudo ./install.sh --apply            # 2단계 — Janus 기동
./install.sh                         # /janus-api/info → 200 확인

./setup-dashboard.sh --build         # 의존성 · janus.js · 프런트 빌드
cd ../../pm2 && pm2 start ecosystem.config.js --only janus-dashboard && pm2 save

cd .. && ./nginx/install_nginx_stack.sh --check
sudo ./nginx/install_nginx_stack.sh --skip-install
```

확인할 곳:

| | 무엇 |
|---|---|
| `https://<서버>/manager` | `janus` · `janus-dashboard` 둘 다 **정상** |
| `https://<서버>/janus/dashboard` | 개요 화면 — 버전·ICE·올라온 모듈 |
| `https://<서버>/janus/dashboard/test-call` | **연결** 버튼 → "연결됨" 이면 3단계 끝 |

## 지금 상태 보기

아무것도 바꾸지 않고 무엇이 됐고 무엇이 남았는지만 출력합니다. sudo 가 필요 없습니다.

```bash
cd services/janus && ./install.sh
```

`[ok]` 는 됐고, `[--]` 는 아직 안 만든 것, `[!!]` 는 손봐야 할 것입니다.
`--apply` 와 `--remove` 는 2단계에서 구현합니다.

선언만 검사하려면 저장소 루트에서:

```bash
./nginx/install_nginx_stack.sh --check
node pm2/ecosystem.config.js --check
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
| 설정 | **배포본 그대로** — `.jcfg` 넷이 `.jcfg.sample` 과 동일 |
| 기동 | 없음. systemd 유닛 없음, 8088·8188·7088 모두 비어 있음 |
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

## 관련 문서

- 계획서 → [docs/plan.md](docs/plan.md)
- 라우팅 선언 스키마 → [docs/nginx-conf.md](../../docs/nginx-conf.md)
- 프로세스 선언 스키마 → [docs/pm2-conf.md](../../docs/pm2-conf.md)
- `/health` 규약 → [docs/health-contract.md](../../docs/health-contract.md)
- SIP 서버 → [services/kamailio/README.md](../kamailio/README.md)
- SIP 계정 등록 → [services/kamailio/accounts.md](../kamailio/accounts.md)
