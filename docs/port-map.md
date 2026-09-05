# 포트 지도 — RTP·시그널링·내부 HTTP 한눈에 보기

nginx·MariaDB·Kamailio·rtpproxy(rtpengine)·Janus·coturn·websocket-relay 가 한
장비에서 같이 도는 SIP-WebRTC 게이트웨이라, 포트가 다섯 계층(서비스)에 걸쳐
흩어져 있습니다. 이 문서가 그 전체 그림입니다 — 공유기를 바꾸거나 포트
포워딩을 다시 확인할 때는 여기부터 보면 됩니다.

> manager 대시보드(`/manager`)에도 이 표를 그대로 보여주는 화면이 있습니다
> (아래 "대시보드에서 보기"). 이 문서는 그 화면이 읽는 값의 **뜻과 바꾸는
> 법**을 설명합니다 — 숫자 자체의 최신값은 대시보드 쪽이 항상 더 정확합니다
> (설정 파일을 그 자리에서 다시 읽으므로).

## 1. RTP/미디어 (UDP) — 실제 통화 소리가 오가는 대역

각 역할이 자기 "만 단위" 블록을 쓰고, 서로 겹치지 않습니다.

| 역할 | 대역 | 어디서 정하나 | 공유기 포워딩 |
|---|---|---|---|
| SIP 트렁크 미디어 (Kamailio가 NAT로 판정한 통화) | `10200-19999` | rtpproxy: `/etc/default/rtpproxy`(장비 로컬) — `services/kamailio/settings.ini`의 `media_port_range`는 그 값을 **비추기만** 함. rtpengine: `services/kamailio/settings.ini`의 `media_port_range` | ❌ LAN 전용 |
| Janus WebRTC (브라우저·모바일 앱) | `20000-20200` | `services/janus/settings.ini`의 `rtp_port_range` | ✅ 필요 |
| Janus ↔ Kamailio(SIP) 브리지 | `30000-30200` | `services/janus/settings.ini`의 `sip_rtp_port_range` | ❌ LAN 전용 |
| coturn TURN 릴레이 (셀룰러 모바일) | `49160-49560` | `services/coturn/settings.ini`의 `relay_port_range` | ✅ 필요 |

## 2. 시그널링 · 컨트롤 포트

| 포트 | 프로토콜 | 무엇 | 공유기 포워딩 |
|---|---|---|---|
| `5060` | UDP+TCP | Kamailio SIP (LAN 주소로만 수신) | ❌ (LAN 전용 배치) |
| `5080` | TCP | Kamailio WS 트랜스포트 (nginx가 TLS 종료 후 `/sip/`로 프록시) | 해당 없음 — nginx 뒤 |
| `7722` | UDP (127.0.0.1) | rtpproxy 컨트롤 소켓 (Kamailio↔rtpproxy) | ❌ 루프백 전용 |
| `2223` | UDP (127.0.0.1) | rtpengine 컨트롤 소켓 (`ng` 프로토콜, 지금은 비활성) | ❌ 루프백 전용 |
| `8088` | TCP | Janus HTTP/REST API (`/janus-api`) | 해당 없음 — nginx 뒤 |
| `7088` | TCP (127.0.0.1) | Janus Admin API | ❌ 루프백 전용, nginx 선언 금지 |
| `8188` | TCP | Janus WebSocket 트랜스포트 (선언만 있고 **미사용** — HTTP 트랜스포트를 씀) | 해당 없음 |
| `3478` | UDP+TCP | coturn STUN/TURN 수신 (`services/coturn/settings.ini`의 `listening_port`) | ✅ 필요 |

## 3. 내부 HTTP 포트 (nginx가 프록시하는 것들, `services/*/nginx-conf/*.ini`)

전부 `127.0.0.1` 백엔드, `28080`대 한 블록에 순서대로 배정돼 있습니다.
plug-in 서비스(자기 저장소를 가진 것)가 늘면 이 표도 늘어납니다.

| 서비스 | 포트 |
|---|---|
| manager | 28084 |
| stock-analyzer | 28085 |
| kamailio-dashboard | 28086 |
| janus-dashboard | 28087 |
| coturn-dashboard | 28090 (`services/coturn/settings.ini`의 `dashboard_port` — 장비마다 다를 수 있음) |
| huygens-server (apartment-mgmt-server-node) | 28092 |
| web-cassini (apartment-mgmt-server-node) | 28093 |
| websocket-relay | 28099 |

새 서비스를 추가할 때 이 블록에서 비어 있는 번호(28080-28083·28088·28089·28091·28094-28098)를 쓰면 됩니다 — [service-rollout.md](service-rollout.md)의 순서를 그대로 따르세요.

## 4. 공유기 포트 포워딩 체크리스트

**공유기를 바꾸거나 포워딩을 다시 확인할 때는 이 표만 보면 됩니다.** 여기
없는 포트는 전부 LAN 전용이라 포워딩 대상이 아닙니다.

| 프로토콜 | 포트 | 내부 목적지 | 용도 |
|---|---|---|---|
| TCP | 80 | 이 서버:80 | HTTP (Let's Encrypt 갱신·리다이렉트) |
| TCP | 443 | 이 서버:443 | HTTPS — 모든 서비스의 웹/대시보드/API가 이 뒤에 있음 |
| UDP | 20000-20200 | 이 서버 | Janus WebRTC 미디어 |
| UDP+TCP | 3478 | 이 서버 | coturn STUN/TURN 시그널링 |
| UDP | 49160-49560 | 이 서버 | coturn TURN 릴레이 미디어 |

> 2026-08-29부터 80/443을 표준 포트 그대로 포워딩합니다(`nginx/nginx-stack.conf`의
> `public_http_port`/`public_https_port`가 비어 있음). 예전에는 외부
> 28080/28443을 내부 80/443으로 매핑했는데, 지금은 쓰지 않습니다 — 공유기
> 설정 화면에 그 규칙이 아직 남아 있다면 지워도 됩니다.
>
> SIP(5060/UDP+TCP)는 포워딩하지 않습니다 — 이 배치의 SIP 단말은 전부 LAN
> 안에 있고, 외부 모바일은 Janus(WebRTC)를 거쳐 붙습니다.

## 5. 대역을 바꾸고 싶을 때

값 자체(위 표의 숫자)는 이미 서로 겹치지 않게 정해져 있어 **바꿀 이유가
없다면 그대로 두는 것을 권합니다** — 실제 통화 중인 시스템이라 바꾸면
공유기 포워딩까지 같이 손대야 합니다. 그래도 바꿔야 한다면:

### Janus WebRTC / SIP-브리지 대역

```bash
cd services/janus
# rtp_port_range (WebRTC, 브라우저/앱 쪽) 또는
# sip_rtp_port_range (Kamailio SIP 브리지 쪽) 를 고친다
$EDITOR settings.ini
./install.sh                 # 미리 점검 (sudo 불필요) — 겹침 여부까지 확인
sudo ./install.sh --apply    # janus.jcfg / janus.plugin.sip.jcfg 에 반영
```

WebRTC 대역을 바꿨다면 공유기 포워딩도 새 대역으로 다시 여세요.

### coturn 릴레이 대역 / 수신 포트

```bash
cd services/coturn
$EDITOR settings.ini         # relay_port_range 또는 listening_port
sudo ./install.sh --apply
```

바꾼 값 그대로 공유기 포워딩을 다시 여세요 — README.md의 "6. 공유기 포트
포워딩" 절이 끝에 안내 문구를 다시 보여줍니다.

### SIP 트렁크 미디어(rtpproxy/rtpengine) 대역

**둘 중 무엇이 도는지에 따라 절차가 다릅니다** — `sudo services/kamailio/install.sh`로
지금 뭐가 도는지 확인하세요.

- **rtpengine 이 도는 경우** (24.04): `services/kamailio/settings.ini`의
  `media_port_range`를 고치고 `sudo ./install.sh --apply` — `/etc/rtpengine/rtpengine.conf`의
  `port-min`/`port-max`를 자동으로 다시 씁니다.
- **rtpproxy 가 도는 경우** (22.04): 이 저장소는 rtpproxy 자체
  설정을 소유하지 않습니다(`database/README.md`·`services/kamailio/install.sh`의
  "미디어 릴레이는 이 장비에 있는 것을 쓴다" 원칙과 같은 이유). 두 단계가
  필요합니다.
  1. `/etc/default/rtpproxy`의 `EXTRA_OPTS="-F -m <시작> -M <끝> -l <LAN IP>"`를
     손으로 고치고 `sudo systemctl restart rtpproxy`
  2. `services/kamailio/settings.ini`의 `media_port_range`도 같은 값으로
     맞춰 씀 — 이건 실제 반영이 아니라 **Janus 범위와의 겹침 검사가 보는
     기준값**이라, 안 맞추면 검사가 낡은 값으로 통과/실패를 잘못 알려줍니다.

어느 쪽이든 바꾼 뒤 `sudo services/janus/install.sh`와
`sudo services/kamailio/install.sh`를 다시 돌려 겹침이 없는지 확인하세요.

## 대시보드에서 보기

manager 대시보드 로그인 후 **포트 지도** 화면(`/manager` → 좌측 메뉴)에서
이 표 전체를 실시간 값으로 봅니다. 소스는 각 서비스의 `settings.ini`(없으면
`settings-schema.json`의 기본값)와 `nginx-conf/*.ini`를 그 자리에서 다시
읽은 것이라, 이 문서보다 항상 최신입니다. 공유기 포워딩이 필요한 항목에는
별도 표시가 있습니다.
