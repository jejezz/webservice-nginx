# Janus WebRTC ↔ SIP 게이트웨이 구축 계획

브라우저에서 `janus.js` 로 SIP 단말과 통화하는 것을 목표로, Janus 를 이
프로젝트의 서비스 규약에 맞춰 세우는 계획입니다.

> **운영 중이 아닙니다.** Janus 는 아직 한 번도 기동된 적이 없고 설정도 배포본
> 그대로입니다. 지금은 변경에 제약이 없습니다.

관련: [../../kamailio/docs/websocket-plan.md](../../kamailio/docs/websocket-plan.md) ·
[../../kamailio/docs/incoming-call.md](../../kamailio/docs/incoming-call.md) ·
[../../../docs/nginx-conf.md](../../../docs/nginx-conf.md) ·
[../../../docs/pm2-conf.md](../../../docs/pm2-conf.md) ·
[../../../docs/health-contract.md](../../../docs/health-contract.md)

## 무엇을 만드는가

| 요구 | 내용 |
|---|---|
| 게이트웨이 | **Janus** SIP 플러그인 — WebRTC 를 끊고 평문 SIP/RTP 로 바꾼다 |
| SIP 코어 | **Kamailio 5.5.4** — 이미 떠 있는 것을 그대로 쓴다 (레지스트라·digest 인증) |
| 클라이언트 | **`janus.js`** 를 쓰는 브라우저 페이지 |
| 최종 확인 | 브라우저 ↔ **SIP 단말** 시험 통화 (음성 먼저, 영상은 그 다음) |
| 관리 화면 | kamailio-dashboard 와 같은 형태의 관찰용 웹 |
| 계승 | `database` · `nginx` · `pm2` 규약은 저장소 루트의 것을 그대로 따른다 |

## 목표 구조

```
                                    192.168.0.252 (이 서버)
        ┌─────────────────────────────────────────────────────────────┐
        │                                                             │
 [브라우저]─HTTPS/WSS─▶ nginx :443 ─http─▶ Janus :8088  (시그널링 API) │
   janus.js │              /janus-api/         │                      │
            │                                  │ SIP/UDP              │
            │          nginx :443 ─http─▶ janus-dashboard :28087      │
            │              /janus/            (관찰 웹 + 시험 클라이언트)│
            │                                  │                      │
            │                                  ▼                      │
            │                          Kamailio :5060 ────────────────┼──▶ [SIP 단말]
            │                          (레지스트라·라우팅)             │      인터폰
            │                                                         │
            └──DTLS/SRTP(UDP 20000-20200)──▶ Janus 미디어 ─평문 RTP──┘
                                             (UDP 30000-30200)
        └─────────────────────────────────────────────────────────────┘
```

미디어가 **Janus 를 반드시 거칩니다.** 브라우저 쪽은 DTLS-SRTP + ICE, SIP 쪽은
평문 RTP 이고, Janus 가 그 사이에서 암호화 계층만 벗기고 씌웁니다. 코덱을 바꾸지는
않습니다(트랜스코딩 아님).

## 왜 Janus 인가 — 기존 계획과의 관계

이 저장소에는 이미 **다른 방식의 계획**이 있습니다
([websocket-plan.md](../../kamailio/docs/websocket-plan.md)). 두 계획은 겹치지
않고 서로를 대체하지도 않습니다. 헷갈리기 쉬우므로 먼저 정리합니다.

| | 기존 계획 (SIP over WSS + rtpengine) | 이 계획 (Janus) |
|---|---|---|
| 시그널링 | 단말이 **직접 SIP** 를 말한다 (`wss://…/sip/` → Kamailio 5080) | 단말은 **Janus API** 만 말한다 (`/janus-api/`) |
| 클라이언트가 알아야 할 것 | SIP 스택 (JsSIP·SIP.js 등) | `janus.js` 하나 |
| 미디어 브리징 | **rtpengine 데몬** (아직 조달 못 함 — 배포판 저장소에 없음) | **Janus 자체** (이미 빌드돼 있음) |
| 지금 상태 | 1단계까지 완료(WS handshake 확인), 2단계에서 rtpengine 에 막혀 있음 | 이 문서 |

**Janus 를 쓰면 rtpengine 없이 브라우저 통화가 됩니다.** 기존 계획에서 "가장 큰
조달 항목"이라고 적어 둔 것이 브라우저 경로에 한해서는 사라집니다.

다만 Janus 가 **대신해 주지 않는 것**이 둘 있습니다. 이 계획으로 그 둘이 해결됐다고
착각하지 마세요.

| 남는 문제 | 왜 Janus 로 안 되나 |
|---|---|
| 자는 모바일 깨우기 (tsilo + FCM) | Kamailio 의 `route[LOCATION]`·`route[REGISTRAR]` 안에 코드가 들어가야 하는 일. 게이트웨이가 관여할 지점이 아니다 ([incoming-call.md](../../kamailio/docs/incoming-call.md)) |
| 안드로이드 네이티브 앱의 미디어 | 앱이 Janus 를 쓰도록 바꾸면 Janus 로 되고, SIP 를 직접 말하게 하면 rtpengine 이 필요하다. **아직 정해지지 않았다** |

기존 `/sip/` 라우트(Kamailio WS, 5080)는 **그대로 둡니다.** 포트도 경로도 겹치지
않아 공존에 문제가 없고, 두 방식을 나란히 시험해 볼 수 있는 편이 낫습니다.

## 지금 있는 것과 없는 것 (2026-08-20 확인)

| 항목 | 상태 | 비고 |
|---|---|---|
| Janus 바이너리 | ✅ `/opt/janus/bin/janus` **1.4.1** | 2026-03-05 소스 빌드. `--prefix=/opt/janus --enable-post-processing --enable-data-channels` |
| 소스 트리 | ✅ `~/Public/RetroLink/janus-gateway` | `v1.4.0-5-gae0078e1` |
| SIP 플러그인 | ✅ `libjanus_sip.so` | |
| HTTP 트랜스포트 | ✅ `libjanus_http.so` | |
| WebSocket 트랜스포트 | ✅ `libjanus_websockets.so` | |
| `janus.js` | ✅ `/opt/janus/share/janus/javascript/janus.js` | 데모 사본도 있음 |
| Janus 설정 | ⬜ **배포본 그대로** — `.jcfg` 가 `.jcfg.sample` 과 한 글자도 다르지 않음 | 아직 아무 결정도 반영돼 있지 않다 |
| systemd 유닛 | ❌ 없음 | 이 저장소가 만든다 |
| 실행 여부 | ❌ 한 번도 뜬 적 없음 | 8088·8188·7088 모두 비어 있음 |
| Kamailio | ✅ 5.5.4 구동 중 | `192.168.0.252:5060` (udp/tcp), digest 인증, `alias=pluto.org` |
| SIP 계정 | ⬜ 브라우저용 계정 미생성 | `kamctl add` 또는 kamailio 대시보드 |
| `sngrep` | ✅ 설치됨 | SDP 확인용 |
| 소프트폰 | ❌ 없음 | `baresip` / `linphone-cli` 를 apt 로 조달 (시험용) |
| rtpengine | ❌ 없음 | **이 계획에서는 필요 없다** |

가장 큰 조달 항목이 **없습니다.** 바이너리가 이미 있고, 남은 것은 설정·기동·연동입니다.

## 구조 — 서비스 둘

`services/kamailio/` 와 같은 형태입니다. 한 디렉토리가 서비스 둘을 담는 것은
규약이 허용합니다.

| 서비스 | 무엇 | 포트 | 띄우는 주체 |
|---|---|---|---|
| `janus` | 게이트웨이 자체 | 8088 (시그널링 API) · 7088 (Admin, 루프백 전용) | **systemd** |
| `janus-dashboard` | 관찰 웹 + 시험 클라이언트 | 28087 | **pm2** |

미디어 포트는 위 표에 없습니다 — 아래 "⑦ 미디어 포트는 두 벌이다" 참고.

### 라우트

| 경로 | → | 무엇 |
|---|---|---|
| `/janus-api/` | 127.0.0.1:8088 | Janus 시그널링 API. `janus.js` 가 여기에 붙는다 |
| `/janus/` | 127.0.0.1:28087 | 관찰 웹. 시험 클라이언트는 `/janus/test-call` |

nginx 의 접두사 매칭에서 `/janus-api/…` 는 `/janus/` 에 걸리지 않습니다
(`/janus` 다음이 `/` 가 아니라 `-` 이므로). 두 라우트는 충돌하지 않습니다.

포트 `8088` · `7088` · `28087` 이 비어 있음을 확인했습니다. 선언된 다른 서비스와도
겹치지 않습니다 (28080~28086, 28099, 5080).

## 정해야 할 것

### ① 브라우저 트랜스포트 — REST 로 시작한다

Janus 는 같은 API 를 HTTP(REST + long-poll)와 WebSocket 두 가지로 냅니다.
`janus.js` 는 둘 다 지원하고, 주는 URL 의 스킴으로 알아서 고릅니다.

**REST(8088)를 권합니다.** 이유는 성능이 아니라 **`/health` 때문**입니다.

이 프로젝트에서 서비스의 헬스 URL 은 `nginx-conf` 의 `host` + `ports[0]` +
`health_path` 로 만들어집니다. 서비스 하나에 포트 하나뿐이므로, 라우트를 WS 포트로
보내면 헬스도 그 포트로 갑니다. **Janus 의 WS 트랜스포트는 평범한 HTTP GET 에
응답하지 않으므로** 대시보드에 영원히 "중단" 으로 뜹니다.

REST 로 두면 그 문제가 통째로 사라집니다. Janus 의 HTTP 트랜스포트가 내는
`GET /janus-api/info` 가 200 + JSON 이고, manager 는 *"2xx 이고 `status` 필드가
없으면 정상"* 으로 판정하므로 **헬스 규약에 손댈 것이 없습니다.**

| | REST (8088) | WebSocket (8188) |
|---|---|---|
| `janus.js` | ✅ 그대로 동작 | ✅ 그대로 동작 |
| `/health` | ✅ `/janus-api/info` 가 그대로 헬스 | ❌ 응답 없음 → 대시보드에 중단 |
| nginx 선언 | `buffering = off`, `timeout` 넉넉히 | `websocket = true`, `timeout = 3600` |
| 시그널링 지연 | long-poll 왕복이 한 번 더 | 더 낮다 |

지연 차이는 LAN·LTE 환경에서 통화 성립 체감에 영향을 줄 정도가 아닙니다. 나중에
WS 로 옮기고 싶어지면 정공법은 **`nginx-conf` 스키마에 `health_port` 를 추가하는
것**입니다(작고 일반적인 확장입니다). 그때 결정하면 되고, 지금 그 비용을 낼 이유가
없습니다.

> WS 트랜스포트는 **꺼 둡니다.** 켜 두면 루프백에서만 들리더라도 "어느 쪽이 진짜
> 경로인지" 가 흐려집니다.

### ② Janus 설정을 어떻게 소유할 것인가 — 통째로 소유한다

Kamailio 는 배포판 설정에 `import_file` 자리가 있어 오버라이드만 두고 원본을 한 줄도
건드리지 않을 수 있었습니다. **Janus 의 `.jcfg`(libconfig)에는 include 가 없습니다.**
그래서 고를 수 있는 것은 이 둘뿐입니다.

| | 방식 | 문제 |
|---|---|---|
| (a) | 이 저장소가 `.jcfg` 전문을 소유하고 `install.sh` 가 설치 | 업스트림이 새 키를 추가해도 따라가지 않는다 |
| (b) | `.jcfg.sample` 을 읽어 설치 시점에 몇 줄만 치환 | sed 기반이라 부서지기 쉽고, 결과물이 저장소에 안 보인다 |

**(a) 로 합니다.** 설정이 저장소에서 그대로 읽히고 diff 가 나오는 편이, 재현성과
"지금 무엇이 적용돼 있는가" 양쪽에서 낫습니다. `/opt/janus/etc/janus/*.jcfg.sample`
은 손대지 않은 채 남으므로 업스트림 원본은 언제든 옆에 있습니다.

(a) 의 약점은 `install.sh` 가 메웁니다.

- 설치 전 기존 파일을 `*.bak.<타임스탬프>` 로 백업 (kamailio `install.sh` 와 같은 방식)
- 우리 파일이 **어느 버전의 sample 에서 갈라져 나왔는지** 헤더에 적고,
  점검 모드에서 현재 `.sample` 과 비교해 **업스트림이 바뀌었으면 경고**
- 설치 후 `janus -C <파일> --version` 류의 검사 대신 **실제로 기동해 보고
  `/janus-api/info` 가 200 인지 확인**, 실패하면 백업으로 롤백

소유할 파일은 넷입니다.

| 파일 | 우리가 정하는 것 |
|---|---|
| `janus.jcfg` | `admin_secret`, 미디어 포트 범위, ICE 인터페이스 제한, 로그 수준 |
| `janus.transport.http.jcfg` | `base_path = /janus-api`, 루프백 바인딩, Admin API 활성화 |
| `janus.transport.websockets.jcfg` | **전부 끔** (①) |
| `janus.plugin.sip.jcfg` | `local_ip`, SIP 쪽 RTP 포트 범위, `register_ttl` |

### ③ SDP 에 어떤 주소를 실을 것인가 — 여기서 조용히 실패한다

Janus 와 Kamailio 가 **같은 장비**에 있어서 `127.0.0.1:5060` 으로 붙고 싶어집니다.
그러면 SIP 시그널링은 되는데 **소리가 안 납니다.** Janus 가 SIP 쪽 SDP 의
`c=` 에 `127.0.0.1` 을 실어 보내고, 인터폰(192.168.0.x)은 그 주소로 RTP 를 보낼
수 없기 때문입니다.

그래서 이렇게 정합니다.

```
janus.plugin.sip.jcfg :  local_ip = "192.168.0.252"
브라우저가 보내는 register :  proxy = "sip:192.168.0.252:5060"
```

Kamailio 는 `192.168.0.252:5060` 에도 듣고 있으므로(udp/tcp 둘 다) 그대로 됩니다.
루프백을 쓰지 않는 것이 **의도**임을 설정 주석에 남깁니다.

> ### ⚠️ 정정 (2026-08-20) — 아래 "부수 효과" 문단이 틀렸습니다
>
> 처음에 이렇게 적었습니다.
>
> > *"Kamailio 가 보는 출발지 IP 가 192.168.0.252 이고 Janus 가 Contact 에 적는
> > 주소도 같으므로 `route[NATDETECT]` 가 NAT 를 잡지 않습니다. `FLT_NATS` 가
> > 서지 않으면 `route[NATMANAGE]` 가 첫 줄에서 그냥 돌아가므로 rtpengine/
> > rtpproxy 를 부르지 않습니다."*
>
> **틀렸습니다.** 4단계에서 실물로 확인하다가 드러났습니다.
>
> `route[NATDETECT]` 는 `nat_uac_test("19")` 를 씁니다. 19 는 비트 셋의 합이고,
> nathelper 는 **어느 하나만 맞아도 참을 냅니다** (`nathelper.c:1691` 이 그
> 자리에서 바로 `return 1`).
>
> | 비트 | 이름 | 무엇을 보는가 | Janus 등록에서 |
> |---|---|---|---|
> | `0x01` | `NAT_UAC_TEST_C_1918` | **Contact 에 사설 주소가 있는가** | ✅ **맞는다** |
> | `0x02` | `NAT_UAC_TEST_RCVD` | Via 주소 ≠ 출발지 IP | 아니다 |
> | `0x10` | `NAT_UAC_TEST_RPORT` | Via 포트 ≠ 출발지 포트 | 아니다 |
>
> Janus 의 Contact 는 `sip:2001@192.168.0.252:48367;transport=udp` 이고
> `192.168.0.252` 는 RFC1918 사설 주소입니다. 그래서 **첫 비트만으로 NAT 로
> 판정됩니다.** 출발지 IP 가 같은지는 보지도 않습니다.
>
> 제가 "출발지와 Contact 가 같으니 NAT 가 아니다" 라고만 생각하고 `nat_uac_test`
> 가 실제로 무엇을 보는지 확인하지 않은 탓입니다. 같은 이유로 **인터폰들도 전부
> NAT 로 판정되고 있습니다** — 이 배치에서는 LAN 단말 전부가 그렇습니다.
>
> #### 그런데 결과적으로는 문제가 아닙니다 — rtpproxy 가 이미 돌고 있습니다
>
> `FLT_NATS` 가 서므로 통화 때 `route[NATMANAGE]` 가 일찍 돌아가지 않고,
> `WITH_RTPENGINE` 이 꺼져 있으니 `rtpproxy_manage()` 를 부릅니다.
>
> 이 계획서가 "미디어 릴레이 데몬이 없다" 는 인상을 준 것도 정확하지 않았습니다.
> 없는 것은 **rtpengine** 이고, 배포판 **`rtpproxy` 1.2.1** 이 별도 systemd
> 유닛으로 돌고 있습니다.
>
> ```
> /usr/bin/rtpproxy -s udp:127.0.0.1 7722 -u rtpproxy rtpproxy \
>     -p /var/run/rtpproxy/rtpproxy.pid -F -m 10100 -m 10200 -l 192.168.0.252
> ```
>
> | | |
> |---|---|
> | 제어 소켓 | `udp:127.0.0.1:7722` — Kamailio 가 여기로 말한다 |
> | 광고 주소 | **`-l 192.168.0.252`** — LAN 주소다. Janus 도 인터폰도 닿는다 |
> | 미디어 포트 | `-m` 기준 10200 부터 (기본 최대 20000) |
>
> rtpproxy 1.2.1 은 SRTP·DTLS·ICE 를 모릅니다. **그러나 알 필요가 없습니다** —
> WebRTC 는 Janus 가 이미 끊었고, Kamailio 가 보는 것은 평문 RTP 뿐입니다.
> 이것이 rtpengine 대신 Janus 를 쓰는 이 구조의 이점이 드러나는 자리입니다.
>
> 그래서 5단계의 미디어는 `Janus-A ↔ rtpproxy ↔ Janus-B` 로 흐릅니다. 서버를 한
> 번 더 거치지만 동작에는 지장이 없습니다.
>
> #### ⚠️ 포트 범위가 통째로 겹칩니다 — 한 칸이 아닙니다
>
> 처음에 "20000 한 칸이 겹친다"고 적었는데 그것도 틀렸습니다. rtpproxy 의
> **`-M` 기본값은 65000** 입니다. `/etc/default/rtpproxy` 에는 `-m` 만 있고
> `-M` 이 없습니다.
>
> ```
> EXTRA_OPTS="-F -m 10100 -m 10200 -l 192.168.0.252"
>                    ^^^^^^^^^^^^^ -m 이 두 번. -M 은 없다
> ```
>
> 그래서 실제 범위가 이렇습니다.
>
> ```
> rtpproxy      10200 ─────────────────────────────── 65000
> Janus WebRTC          20000-20200        ← 통째로 안에 들어간다
> Janus SIP                       30000-30200  ← 이것도
> ```
>
> **고치는 방향은 rtpproxy 의 위쪽을 막는 것입니다.** Janus 쪽을 옮기면
> 10200 아래로 내려가야 하는데, 그 대역은 다른 서비스와 부딪히기 쉽고
> 9단계의 공유기 포워딩 계획도 함께 바꿔야 합니다.
>
> ```ini
> # /etc/default/rtpproxy
> EXTRA_OPTS="-F -m 10200 -M 19999 -l 192.168.0.252"
> ```
>
> 10200–19999 는 9800 포트입니다. 통화 한 건이 다리 둘 × (RTP+RTCP) 로 4포트를
> 쓰므로 동시 2400통 분량이고, 이 배치에는 남습니다. 중복된 `-m` 도 함께
> 정리합니다.
>
> `install.sh` 점검이 이제 이 겹침을 잡습니다. 두 `.jcfg` 와
> `/etc/default/rtpproxy` 를 읽어 비교하므로, 나중에 어느 쪽을 고쳐도
> 어긋나면 바로 드러납니다.
>
> > rtpproxy 는 이 저장소가 관리하지 않는 유일한 미디어 구성요소입니다.
> > `/etc/default/rtpproxy` 를 손으로 고쳐야 하고, 그 사실이 어디에도 적혀 있지
> > 않았습니다. `services/kamailio/` 가 소유하는 것이 자연스러워 보입니다 —
> > 그쪽 `rtpengine.conf` 가 이미 "미디어 릴레이 데몬 설정 원본" 자리를
> > 잡아 두었습니다.

`local_ip` 결정 자체는 그대로 유효합니다. 루프백을 쓰면 SDP 에 실리는 주소가
어긋나 소리가 안 나는 것은 변함이 없고, 4단계에서 Contact 가 실제로
`192.168.0.252` 로 찍힌 것으로 확인됐습니다.

### ④ Admin API 비밀번호 — 배포본 기본값을 그대로 두지 않는다

`janus.jcfg.sample` 의 `admin_secret` 은 **`"janusoverlord"`** 입니다. 공개된
기본값이고, Admin API 는 세션·핸들 조회부터 강제 종료까지 됩니다.
(kamailio 의 `kamctlrc` 기본 비밀번호 문제와 같은 종류입니다 — 그쪽 README 8-3)

- `install.sh` 가 `services/janus/secrets/admin-secret` 을 영숫자 32자로 만들고(600),
  `janus.jcfg` 에 채워 넣습니다. `database/setup_mariadb.sh` 의 `secrets/*.pw` 와 같은 방식입니다.
- `secrets/` 는 `.gitignore` 에 넣습니다.
- Admin API 는 **`127.0.0.1:7088` 에만** 열고 nginx 라우트를 만들지 않습니다.
  대시보드 서버(같은 장비, 28087)만 부릅니다. 비밀은 브라우저로 내려가지 않습니다.

> `database/setup_mariadb.sh` 의 dry-run 이 비밀번호 파일을 실제로 쓰는 함정
> (kamailio README 7-2)을 되풀이하지 않도록, `install.sh` 의 점검 모드는
> **파일을 만들지 않습니다.**

### ⑤ 노출 범위와 인증

`/janus-api/` 는 nginx 를 통해 외부(28443)에서 닿습니다. 열어 두면 아무나 Janus
세션을 만들고 Kamailio 에 REGISTER 를 시도할 수 있습니다. 최종 관문은 Kamailio 의
digest 인증이지만, 그 앞에 한 겹 더 둡니다.

| 대상 | 인증 |
|---|---|
| `/janus/` (관찰 웹 · 시험 클라이언트) | **manager 세션 쿠키 검증** — kamailio-dashboard 와 같은 SSO |
| `/janus-api/` (Janus API) | Janus 의 **`api_secret`**. 대시보드 서버가 로그인된 세션에만 페이지에 심어 준다 |
| SIP 등록 | Kamailio digest (기존 그대로) |

`api_secret` 은 브라우저까지 내려가므로 완전한 방어가 아닙니다. 로그인 없이는
값을 얻을 수 없다는 정도의 의미이고, **진짜 관문은 digest 인증**이라는 점을
분명히 해 둡니다.

### ⑥ 코덱 — Janus 는 트랜스코딩하지 않는다

Janus SIP 플러그인은 브라우저가 제시한 코덱 목록을 그대로 SIP 쪽에 넘깁니다.
협상은 **양 끝**에서 일어납니다.

| | 브라우저 | 인터폰 | 결과 |
|---|---|---|---|
| 음성 | Opus · **PCMU · PCMA** (크롬은 항상 함께 제시) | PCMU / PCMA | ✅ 교집합이 있다 |
| 영상 | VP8 · VP9 · **H.264**(단말 하드웨어 의존) | H.264 | ⚠️ `fmtp` 가 맞아야 한다 |

영상이 안 될 때 볼 곳은 기존 계획서에 이미 정리돼 있습니다 —
`profile-level-id` 와 `packetization-mode`
([websocket-plan.md 의 "코덱" 절](../../kamailio/docs/websocket-plan.md)).
**음성부터 통과시키고 영상은 그 다음**으로 미룹니다. 순서를 지키면 "안 되는데
어디가 문제인지 모르겠는" 상태를 피할 수 있습니다.

### ⑦ 미디어 포트는 두 벌이다

놓치기 쉬운 부분입니다. Janus 는 **양쪽 다리에 각각** RTP 포트를 씁니다.

| 설정 파일 | 키 | 쓰이는 곳 | 범위(제안) | 라우터 포워딩 |
|---|---|---|---|---|
| `janus.jcfg` | `media.rtp_port_range` | **WebRTC 쪽** (브라우저 ↔ Janus, ICE/DTLS/SRTP) | `20000-20200` | **외부 브라우저를 받을 때 필요** |
| `janus.plugin.sip.jcfg` | `rtp_port_range` | **SIP 쪽** (Janus ↔ 인터폰, 평문 RTP) | `30000-30200` | 불필요 (LAN 안) |

배포본은 `janus.jcfg` 쪽이 **주석 처리돼 있어 제한이 없고**(빈 포트를 아무거나 씁니다),
`janus.plugin.sip.jcfg` 쪽만 `20000-40000` 으로 열려 있습니다. 그대로 두면 포워딩
규칙을 만들 수 없고 두 범위가 겹칠 수도 있습니다. 좁히고 **겹치지 않게** 나눕니다.

ICE 후보 수집도 손봐야 합니다. 이 장비에는 통화와 무관한 인터페이스가 넷 있습니다.

```
enp2s0          192.168.0.252     ← 이것만 쓴다
virbr0          192.168.122.1     libvirt
docker0         172.17.0.1        docker
br-2a3c1cce67cc 172.18.0.1        docker compose
```

그대로 두면 Janus 가 저 주소들까지 ICE 후보로 실어 보내고, 상대는 닿지 않는 곳에
연결을 시도하다 타임아웃을 기다립니다. 통화 성립이 눈에 띄게 느려지는 형태로
나타납니다. `janus.jcfg` 의 `nat.ice_enforce_list` 로 `enp2s0` 만 쓰게 못박습니다.
(`ice_ignore_list` 로 빼는 것보다, 쓸 것을 지정하는 쪽이 나중에 인터페이스가
늘어나도 안전합니다)

## 디렉토리 계획

```
services/janus/
├── README.md                      현황 · 설치 순서 · 문제 해결
├── docs/
│   └── plan.md                    이 문서
├── bootstrap.sh                   처음부터 세우는 순서 (패키지 · 빌드 · 사용자)
├── install.sh                     점검 / 설정 설치 / 되돌리기  ← kamailio/install.sh 와 같은 형태
├── setup-dashboard.sh             대시보드 점검 · 빌드
├── janus.jcfg                     ↘
├── janus.transport.http.jcfg       ↘  /opt/janus/etc/janus/ 로 설치될 원본
├── janus.transport.websockets.jcfg ↗
├── janus.plugin.sip.jcfg          ↗
├── janus.service                  systemd 유닛 원본
├── secrets/                       admin-secret (600, .gitignore)
├── nginx-conf/
│   ├── service.ini                janus            — /janus-api/  (8088, systemd)
│   └── dashboard.ini              janus-dashboard  — /janus/      (28087, pm2)
├── pm2-conf/
│   ├── app.ini                    janus — 껍데기. systemd 가 띄운다
│   ├── dashboard.ini              janus-dashboard — 진짜 프로세스
│   └── not-managed-by-pm2.sh
├── server/                        대시보드 서버 — Node + Express
│   └── src/
│       ├── index.js                 정적 서빙 · /health · API
│       ├── admin.js                 Janus Admin API 클라이언트 (7088)
│       └── auth/session.js          manager 세션 검증 (SSO)
└── web/                           대시보드 프런트 — React 18 + Vite + Tailwind + shadcn/ui
    └── src/pages/
        ├── Overview.jsx             버전 · 플러그인 · 트랜스포트 · 프로세스 상태
        ├── Sessions.jsx             현재 세션 · 핸들
        ├── Sip.jsx                  SIP 핸들의 등록 상태 · 통화 상태
        ├── Media.jsx                핸들별 ICE/DTLS 상태 · 비트레이트
        └── TestCall.jsx             janus.js 시험 클라이언트
```

`database/` 는 이 서비스에서 **쓰지 않습니다.** Janus 는 상태를 메모리에만 두고,
SIP 계정은 Kamailio 의 `subscriber` 테이블이 이미 소유합니다. `database.ini` 에
`[database:janus]` 를 만들지 않습니다.

### `janus.js` 는 커밋하지 않는다

`web/public/janus.js` 는 `setup-dashboard.sh --build` 가
`/opt/janus/share/janus/javascript/janus.js` 에서 **복사**합니다. 커밋하면
Janus 를 올릴 때마다 라이브러리와 서버 버전이 어긋날 수 있는데, 그 어긋남은
조용히 실패합니다. 설치된 것에서 가져오면 항상 맞습니다.

`janus.js` 는 `adapter.js`(webrtc-adapter)를 전역으로 요구합니다. 이쪽은 CDN 을 쓰지
않고 `web/` 의 npm 의존성으로 넣습니다 — 외부 망 없이도 페이지가 떠야 합니다.

## 진행 순서

각 단계는 **검증까지 끝나야 다음으로 갑니다.** 확인 방법을 함께 적었습니다.

### 1단계 — 서비스 골격

**✅ 완료 (2026-08-20)**

| | 할 일 | 확인 |
|---|---|---|
| 1-1 | `services/janus/` 디렉토리와 이 문서 | ✅ |
| 1-2 | `nginx-conf/service.ini` · `dashboard.ini` — **둘 다 `enabled = false`** | ✅ 충돌 없음 (아래) |
| 1-3 | `pm2-conf/app.ini`(껍데기) · `dashboard.ini` · `not-managed-by-pm2.sh` | ✅ `6 apps, no problems.` |
| 1-4 | `install.sh` 점검 모드 — 아무것도 바꾸지 않고 현황만 출력 | ✅ `[!!]` 0개 |
| 1-5 | `README.md` 초안 · `.gitignore` | ✅ |

선언을 먼저 넣되 **꺼 둡니다.** 켜면 백엔드가 없어 그 경로가 502 이고 대시보드에
"중단" 이 뜹니다 (kamailio 가 같은 순서를 밟았습니다).

`enabled = false` 인 서비스는 생성기가 스캔 단계에서 건너뛰므로 **충돌 검사도
받지 않습니다.** 3단계에서 켠 다음에야 처음 검사받는 셈이라, 1단계에서 임시로
`true` 로 바꿔 한 번 통과시켜 두었습니다. `/janus-api/` 와 `/janus/` 가 겹치지
않는 것을 확인했습니다.

> 이 워크트리에는 `nginx/cert/` 가 없어(gitignore) `--check` 가 인증서 단계에서
> 멈춥니다. 충돌 검사는 그보다 **먼저** 끝나므로(`generate_nginx_conf.py` 의
> `check_conflicts` → `stack.check_files` 순서) 검사 자체는 유효합니다.
> 본 저장소에는 인증서가 있어 그대로 통과합니다.

### 2단계 — Janus 설정 소유와 기동

| | 할 일 | 확인 |
|---|---|---|
| 2-1 | `.jcfg` 넷 작성 (②) — 포트·ICE·`base_path`·`local_ip` (③⑦) | ✅ 작성·검증 완료 |
| 2-2 | `secrets/{admin,api}-secret` 생성과 치환 (④⑤) | ✅ `install.sh --apply` 에 구현 |
| 2-3 | `janus` 시스템 사용자 + `janus.service` | ✅ 작성 완료. 사용자는 이미 있음(uid 997) |
| 2-4 | **`sudo ./install.sh --apply`** — 백업 · 설치 · 기동 · 실패 시 롤백 | ✅ `active` · `enabled` |
| 2-5 | 시그널링 API 가 실제로 응답하는지 | ✅ `GET /janus-api/info → 200` |
| 2-6 | Admin API 가 루프백에서만 열렸는지 | ✅ `127.0.0.1:7088` |

**✅ 2단계 완료 (2026-08-20).** 저널이 정한 것을 그대로 보여줍니다.

```
Adding 'enp2s0' to the ICE enforce list...
ICE port range: 20000-20200
HTTP webserver started (port 8088, /janus-api path listener)...
Admin/monitor HTTP webserver started (port 7088, /admin path listener)...
[WARN] No WebSockets server started, giving up...          ← 의도한 대로 (①)
플러그인: sip · echotest 둘뿐                                ← plugins.disable 이 먹었다
```

> `systemctl is-active` 만 믿지 않습니다. Kamailio 에서 **포트도 열리고
> `is-active` 도 정상인데 WS 가 전혀 동작하지 않은** 전례가 있습니다
> (`tcp_accept_no_cl` — websocket-plan.md ①-1). 그래서 `--apply` 는 기동 뒤
> `GET /janus-api/info` 가 **200 을 낼 때까지** 확인하고, 아니면 백업으로
> 되돌린 뒤 저널 20줄을 보여 주고 멈춥니다.

#### 설치 전 예행 — sudo 없이 이미 확인한 것

`/opt/janus` 를 건드리지 않고 임시 폴더(`-F <dir>`)에서 같은 설정으로 Janus 를
띄워 봤습니다. 2-4 를 실행하기 전에 설정이 옳은지 확인해 두려는 것입니다.

| 확인한 것 | 결과 |
|---|---|
| `.jcfg` 넷이 libconfig 로 파싱되는가 (`janus-cfgconv`) | ✅ 넷 다 |
| `GET /janus-api/info` | ✅ 200 — `base_path` 가 먹었다 |
| `server-name` · `local-ip` | ✅ `webservices-janus` · `192.168.0.252` |
| ICE 인터페이스 | ✅ `Adding 'enp2s0' to the ICE enforce list...` |
| WebRTC 포트 범위 | ✅ `ICE port range: 20000-20200` |
| 올라온 플러그인 | ✅ `sip`, `echotest` 둘뿐 |
| 올라온 트랜스포트 | ✅ `http` 하나. `No WebSockets server started` |
| 리스닝 주소 | ✅ `127.0.0.1:8088`, `127.0.0.1:7088`. 8188 없음 |
| `api_secret` 없이 세션 생성 | ✅ `403 Unauthorized request` |
| `api_secret` 붙여서 세션 생성 | ✅ `success` |
| Admin API + `admin_secret` | ✅ `list_sessions` 응답 |

기동 로그에 경고 둘이 나오는데 **둘 다 정상입니다.**

```
[WARN] Couldn't access logger plugins folder...
```
이 빌드에 loggers 가 없어서입니다. 로그는 stdout → journald 로 갑니다.

```
[WARN] Janus is deployed on a private address (192.168.0.252) but you
       didn't specify any STUN server! Expect trouble if this is supposed
       to work over the internet and not just in a LAN...
```
정확한 지적이고, 이 계획의 **9단계**가 그 답입니다 (`nat_1_1_mapping`).
LAN 안에서 시험하는 5~7단계 동안은 문제가 되지 않습니다.

### 3단계 — 대시보드 서비스와 라우트 개방

| | 할 일 | 확인 |
|---|---|---|
| 3-1 | `server/` — Express, `/health`, manager 세션 검증 | ✅ 루프백에서 확인 (아래) |
| 3-2 | `web/` — 개요 화면 + 시험 클라이언트 페이지 | ✅ `setup-dashboard.sh --build` 통과 |
| 3-3 | 선언 셋을 `enabled = true` 로 + nginx 반영 | ✅ 반영됨 |
| 3-4 | manager 가 보는 헬스가 둘 다 정상인지 | ✅ `/janus-api/info` 200 · `/health` 200 |
| 3-5 | 브라우저에서 `janus.js` 가 Janus 에 붙는지 (세션 생성까지) | 🔸 HTTP 경로는 검증됨. **브라우저 클릭만 남음** |

3-4 가 ①의 결론을 검증하는 지점입니다. `janus` 가 여기서 초록이 아니면 헬스
경로 결정을 다시 봐야 합니다.

#### 3-1·3-2 에서 확인한 것

대시보드 프로세스를 루프백에서 직접 띄워 확인했습니다. Janus 는 아직 안 떠
있으므로 "닿지 않는다" 를 제대로 보여주는지가 함께 확인 대상입니다.

| 확인한 것 | 결과 |
|---|---|
| `/health` 가 규약대로 나오는가 | ✅ `service`·`status`·`timestamp` + `details` |
| Janus 가 없을 때 | ✅ `details.janus.ok = false` 로 드러남. `status` 는 `ok` 유지 |
| `/health` 와 `/janus/health` 양쪽 | ✅ 둘 다 200 (nginx 접두사 대응) |
| 인증 없이 API | ✅ 401 + `loginUrl` |
| 인증 없이 대시보드 페이지 | ✅ 302 → `/manager/login?next=…` |
| 인증 없이 `index.html` 직접 요청 | ✅ 302 (정적 노출 없음) |
| 인증 없이 `janus.js` | ✅ 200 (데이터가 없는 라이브러리) |
| nginx 설정 생성 | ✅ `/janus-api/` · `/janus/` 두 라우트, 충돌 없음 |
| `node pm2/ecosystem.config.js --check` | ✅ `7 apps, no problems.` |

> **`status` 를 `ok` 로 두는 이유.** 여기서의 `status` 는 **대시보드 프로세스**의
> 상태입니다. Janus 가 죽어 있어도 대시보드는 살아 있어야 그것을 볼 수 있으므로,
> `degraded` 로 낮추지 않고 `details` 로 드러냅니다. Janus 자체의 헬스는
> `nginx-conf/service.ini` 가 `/janus-api/info` 로 따로 선언합니다 —
> manager 는 그쪽을 봅니다. (kamailio-dashboard 와 같은 판단)

#### 3-3·3-4 에서 확인한 것 — nginx 를 거쳐 실제로

`janus.js` 가 하는 순서를 `curl` 로 그대로 재현했습니다. 브라우저의 JS 만 빼고
경로 전체가 검증됩니다.

| 단계 | 결과 |
|---|---|
| `api_secret` 없이 세션 생성 | ✅ `403 Unauthorized request` |
| `api_secret` 붙여 `POST /janus-api` | ✅ `success` — 세션 id |
| `POST /janus-api/<세션>` 로 `janus.plugin.sip` attach | ✅ `success` — 핸들 id |
| long-poll `GET /janus-api/<세션>?rid=…` | ✅ **30.03초** 뒤 `{"janus":"keepalive"}` |
| Admin API `list_sessions` 로 그 세션이 보이는가 | ✅ 보임. `destroy` 후 `[]` |
| 기존 서비스 (`/manager` · `/kamailio/` · `/rtc-relay/`) | ✅ 영향 없음 |

long-poll 이 30초를 꽉 채우고 돌아온 것이 중요합니다. nginx 가 먼저 끊지 않았고
(`timeout = 120`), 버퍼링에 갇히지도 않았다는 뜻입니다 (`buffering = off`).
이벤트 수신 경로가 실제로 동작합니다.

#### ⚠️ 여기서 결함 하나가 나왔습니다 — `/janus-api` 의 끝 슬래시

`location` 을 `/janus-api/` 로 두었더니 nginx 가 슬래시 없는 요청에 301 을
냈습니다. 그런데 `janus.js` 는 **세션을 만들 때 정확히 그 주소로 POST** 합니다 —
`server + "/" + sessionId` 이 되는 것은 세션이 생긴 다음부터입니다. POST 는 301 을
따라가며 본문을 잃으므로 **연결 자체가 되지 않습니다.**

```
POST /janus-api   → 301 (Location: /janus-api/)     ❌ 세션 생성이 여기서 죽는다
POST /janus-api/  → {"janus":"success", …}          ✅
```

슬래시를 빼면 `/janus-api` 와 `/janus-api/<세션>/<핸들>` 이 모두 하나에 걸립니다.
`/manager` 와 `/stock-analyzer` 도 같은 이유로 슬래시가 없습니다.

이런 종류는 설정을 읽어서는 보이지 않습니다. 실제로 그 순서대로 불러 봐야
드러납니다.

#### 3단계에서 정한 것 — 정적 파일을 어디까지 인증 없이 줄 것인가

`janus.js` 는 인증 없이 주고, `index.html` 을 포함한 나머지는 막습니다.
`express.static(dist)` 로 통째로 열면 `index.html` 까지 로그인 없이 나가므로,
`janus.js` 하나만 따로 라우트를 냈습니다.

### 4단계 — Kamailio 연동 (SIP 등록)

| | 할 일 | 확인 |
|---|---|---|
| 4-1 | 브라우저용 SIP 계정 둘 생성 (`2001` · `2002`) | ✅ `pluto.org`, 평문 컬럼 채워짐 |
| 4-2 | 시험 클라이언트에서 `register` (③의 `proxy` 주소로) | ✅ `registration_status: registered` |
| 4-3 | Kamailio 가 실제로 등록을 잡았는지 | ✅ Kamailio 저널에 `2001` REGISTER |
| 4-4 | Kamailio 의 NAT 판정 (③) | ✅ 확인 — **NAT 로 판정된다.** ③의 추론이 틀렸다 (정정 참고) |

#### 4-2·4-3 에서 확인한 것 — 전 구간이 이어집니다

브라우저에서 실제로 눌러 확인했습니다. nginx 접근 로그와 Janus Admin API 가
같은 이야기를 합니다.

```
22:16:19  POST /janus-api                          200   ← 세션 생성. 301 이 없다
22:16:19  POST /janus-api/<세션>                    200   ← janus.plugin.sip attach
22:16:27  POST /janus-api/<세션>/<핸들>              200   ← register 요청
22:16:27  GET  /janus-api/<세션>?rid=…&maxev=10      200   ← long-poll 로 이벤트 수신
22:16:27  kamailio: REGISTER … for 2001
```

Janus Admin API 의 `handle_info` 가 등록 상태를 그대로 보여 줍니다.

```json
{
  "identity": "sip:2001@pluto.org",
  "registration_status": "registered",
  "call_status": "idle"
}
```

> **`POST /janus-api` 가 200 입니다.** 3단계에서 고친 끝 슬래시 문제(위험 목록 9)가
> 실제 브라우저에서도 해결됐다는 뜻입니다. 여기가 301 이었다면 세션 생성부터
> 실패했을 자리입니다.

#### 곁가지로 확인된 것 — 시그널링은 이미 바깥에서도 됩니다

브라우저가 `https://jejezzhome.iptime.org:28443/janus/dashboard/test-call` 로
붙었습니다. nginx 가 본 클라이언트 주소는 공유기(`192.168.0.1`)입니다.

즉 **9단계에서 "시그널링은 추가 포워딩이 필요 없다"고 적어 둔 것이 이미
사실로 확인**됐습니다. `28443 → 443` 이 그대로 동작합니다. 9단계에 남는 것은
미디어(UDP `20000-20200`) 포워딩과 `nat_1_1_mapping` 뿐입니다.

#### 4-4 결과 — NAT 로 판정됩니다. 그래도 괜찮습니다

Contact 가 `sip:2001@192.168.0.252:48367;transport=udp` 로 찍혔습니다. LAN 주소가
맞으니 ③의 `local_ip` 결정은 유효합니다.

그런데 그 주소가 RFC1918 이라는 이유만으로 `nat_uac_test("19")` 가 참이 되고,
Kamailio 는 이 등록을 **NAT 뒤로 판정합니다.** ③의 "NAT 를 잡지 않는다" 는 추론이
틀렸습니다 — 자세한 내용과 그럼에도 문제가 아닌 이유는 위 ③ 절의 정정에 있습니다.

한 줄로: 미디어는 이미 돌고 있는 **rtpproxy**(`-l 192.168.0.252`)가 중계하고,
WebRTC 암호화는 Janus 가 이미 벗겨 두었으므로 그 조합이 성립합니다.

#### `received` 는 대시보드 화면에 없습니다

kamailio 대시보드는 `received` 를 **API 로는 받아오는데 표에 그리지 않습니다**
(`web/src/pages/Registrations.jsx` 가 `contact` 만 그립니다). 값을 직접 보려면
로그인한 브라우저에서 API 를 그대로 엽니다.

```
https://<서버>/kamailio/dashboard/api/registrations
```

#### (참고) 원래 여기에 적어 두었던 확인 방법

`ul.dump` RPC 는 `/run/kamailio` FIFO 로만 되고 그 디렉토리는 `kamailio` 그룹
전용이라, 이 계획서 쪽에서는 읽을 수 없습니다. kamailio 대시보드가 그 일을
이미 합니다.

```
https://<서버>/kamailio/dashboard  →  등록 단말  →  2001
```

| 보는 곳 | 기대값 | 다르면 |
|---|---|---|
| `contact` | `sip:2001@192.168.0.252:…` | `127.0.0.1` 이면 ③의 `local_ip` 가 안 먹은 것 |
| `received` | **비어 있음** | 값이 있으면 Kamailio 가 NAT 로 판정한 것 |

`received` 는 `fix_nated_register()` 가 **NAT 로 판정했을 때만** 채웁니다.
비어 있으면 `FLT_NATS` 가 서지 않았다는 뜻이고, 그러면 `route[NATMANAGE]` 가
첫 줄에서 돌아가 rtpengine/rtpproxy 를 부르지 않습니다. 지금 rtpengine 데몬이
없는 상태와 맞아떨어져야 5단계 미디어가 정상입니다.

계정 비밀번호는 **평문 컬럼이 채워져야** 합니다. 이 서버의 `auth_db` 는
`calculate_ha1=yes` 라 `ha1` 은 쓰지 않습니다 (kamailio README 7-4).

#### 4-1 계정은 자동으로 만들지 않습니다

`services/kamailio/` 가 그렇게 정해 두었습니다 — *"계정과 비밀번호는 사람이 정해야
하고, 스크립트 인자로 받으면 셸 히스토리와 `ps` 에 남습니다"* (accounts.md).
여기서도 따릅니다. 이 계획서가 계정을 만들지 않는 것은 빠뜨린 것이 아닙니다.

**kamailio 대시보드에서 만드는 것을 권합니다** — sudo 도, 셸 히스토리도 없습니다.

```
https://<서버>/kamailio/dashboard  →  SIP 계정  →  추가
    사용자명  2001 / 2002
    도메인    pluto.org          ← Kamailio 의 alias. 다르면 대시보드가 거절한다
    비밀번호  6자 이상
```

그쪽 대시보드는 도메인이 Kamailio 의 `alias` 목록에 있는지 검사하고, 없으면
만들지 않습니다. *"이대로 만들면 등록되지 않는 계정이 됩니다"* 라는 판단이
이미 들어 있습니다.

셸에서 하려면:

```bash
sudo /usr/sbin/kamctl add 2001 '<비밀번호>'
```

`/usr/sbin/` 절대경로여야 합니다. `PATH` 의 `kamctl` 은 구동 중이 아닌 소스빌드
5.7.7 판입니다 (kamailio README 의 "두 벌 설치").

#### 시험 클라이언트에 붙인 것

`/janus/dashboard/test-call` 이 두 칸으로 나뉩니다.

| | 무엇 |
|---|---|
| 1. Janus 연결 | 세션 생성 · `janus.plugin.sip` attach (3단계) |
| 2. SIP 등록 | 계정 · 비밀번호 · proxy 를 넣고 REGISTER (4단계) |

Janus SIP 플러그인이 보내는 `registering` → `registered` / `registration_failed`
이벤트를 그대로 상태와 로그에 보여 줍니다. 실패하면 흔한 두 원인을 화면에서
짚어 줍니다 — `401` 이면 평문 `password` 컬럼이 비었거나 비밀번호가 다르고,
`403 Not relaying` 이면 SIP 도메인이 Kamailio 의 alias 와 다릅니다.

**비밀번호는 저장하지 않습니다.** 화면에서 Janus 로 바로 넘어가고, Kamailio 에는
Janus 가 digest 로 응답합니다. 새로 고치면 다시 입력해야 합니다. 대시보드
서버가 `api_secret` 은 내려주지만 SIP 비밀번호는 다루지 않습니다.

### 5단계 — 시험 통화 ① 브라우저 ↔ 브라우저

가장 먼저 할 시험입니다. **추가 장비가 필요 없고**, Janus·Kamailio·라우팅·미디어를
한 번에 검증합니다.

| | 할 일 | 확인 |
|---|---|---|
| 5-1 | 각각 `2001` · `2003` 으로 등록 | ✅ 둘 다 `registered` |
| 5-2 | `2001` → `2003` 발신, 수신 쪽에서 수락 | ✅ `calling`→`ringing`→`accepted` |
| 5-3 | 미디어가 실제로 흐르는지 | ✅ **양방향 297/298 패킷, 손실 0** |
| 5-4 | 통화 종료 · 재발신 | ✅ 양쪽 `hangup 200`, 재발신도 성공, Admin API 세션 `[]` |

**✅ 5단계 완료 (2026-08-21).** 2차 시도에서 통과했습니다 (아래).

> `2002` 대신 **`2003`** 을 씁니다. `2002` 는 브라우저가 아닌 단말이 잡고 있던
> 계정이고, 그 단말이 언제 다시 켜질지 이쪽에서 정할 수 없기 때문입니다.
> (그 단말은 2026-08-21 04:33 을 끝으로 재등록을 멈췄습니다.)
>
> **`2003` 의 비밀번호는 `secrets/sip-2003.pw` 에 있습니다** (600, gitignore).
> 4-1 이 "계정은 자동으로 만들지 않는다" 고 정한 것과 어긋나 보이지만, 그 조항이
> 막으려던 것은 *셸 히스토리와 `ps` 에 비밀번호가 남는 것*입니다. 이 계정은
> 무작위 비밀번호를 파일로 만들고 그 파일을 읽어 넣었으므로 argv 를 거치지
> 않습니다. 사람이 쓸 계정이 아니라 **시험 전용**이라 이렇게 둡니다.

#### 미디어가 지나는 길

③의 정정에 따라 이렇게 됩니다. Kamailio 가 두 등록을 모두 NAT 뒤로 판정하므로
`rtpproxy_manage()` 가 불립니다.

```
브라우저A ──DTLS/SRTP──▶ Janus ──평문 RTP──▶ rtpproxy ──평문 RTP──▶ Janus ──DTLS/SRTP──▶ 브라우저B
          20000-20200          30000-30200    10200-19999
```

세 범위가 겹치지 않는 것은 `install.sh` 점검이 확인합니다.

#### 시험 클라이언트에 붙인 것

`/janus/dashboard/test-call` 이 세 칸이 됩니다 — 연결 · 등록 · **통화**.

| | 무엇 |
|---|---|
| 발신 | `createOffer` → `{request:"call", uri:"sip:2002@pluto.org"}` |
| 착신 | `incomingcall` 이벤트 → **받기** → `createAnswer` → `{request:"accept"}` |
| 종료 | `{request:"hangup"}` · 거절은 `{request:"decline"}` |
| 상태 | `calling` · `ringing` · `accepted` · `hangup` 을 뱃지와 로그로 |
| 미디어 | `onremotetrack` 으로 받은 트랙을 `<audio>` 에 붙임. ICE 상태도 표시 |

`hangup` 의 코드도 그대로 보여 줍니다 — `404` 없는 계정, `480` 등록 안 됨,
`486` 통화 중, `488` 협상 실패.

#### 1차 시도 (2026-08-20 22:58) — 실패. 알아낸 것

**증상:** 전화가 걸리지 않음. Kamailio 저널에 INVITE 흔적 없음.

Janus 저널이 이렇게 남았습니다.

```
22:58:06  [WARN] No stream, queueing this trickle as it got here before the SDP...
22:58:06  Creating ICE agent (ICE Full mode, controlled)      ← 1차 시도
22:58:29  [WARN] Agent already exists?                        ← 2차 시도
22:58:29  [ERR]  Error setting ICE locally
22:58:35  [ERR]  Wrong state (… status=closing)               ← 끊기 요청이 무시됨
```

**원인 ① (고침) — 통화가 끝나도 PeerConnection 을 정리하지 않았다.**
상태만 `idle` 로 되돌리고 `handle.hangup()` 을 부르지 않아, 두 번째
`createOffer` 가 남아 있던 연결을 다시 쓰려다 Janus 에 거절당했습니다.
**한 번 실패하면 다시 걸기 자체가 막히는** 형태라, 원인을 첫 실패 쪽에서
찾게 되어 더 헷갈립니다. `hangup` 이벤트에서 정리하도록 고쳤습니다.

**원인 ② (남음) — `2002` 를 브라우저가 아닌 다른 단말이 잡고 있다.**
Kamailio 저널의 Call-ID 로 갈립니다.

```
2002:  22:23 … 22:58  전부 Call-ID 5befa749-…   ← 같은 단말이 5분마다 재등록
2001:  22:57:49       Call-ID f8c1f6e9-…        ← 브라우저(Janus)
```

`2001 → 2002` 로 걸면 브라우저 탭이 아니라 그 단말로 갑니다. 브라우저 ↔
브라우저 시험이 성립하지 않습니다. **그 단말을 끄거나 계정을 하나 더 만들어야
합니다** (`2003`).

**원인 ③ (진짜 원인, 2026-08-21 에 찾음) — `outbound_proxy` 를 안 보냈다.**
2차 시도에서 드러났습니다. 아래 절에 자세히 적습니다. 위의 ①·② 는 둘 다 실제
문제였지만, **1차 시도의 전화가 걸리지 않은 이유는 ③ 이었습니다.**

> "Kamailio 저널에 INVITE 가 없으니 INVITE 가 안 나갔다" 는 추론은 **근거가
> 약합니다.** Kamailio 는 응답된 통화만 ACC 로 남기므로 실패한 INVITE 는 로그에
> 없을 수 있습니다.
>
> 다만 이번에는 결론이 맞았습니다 — Kamailio 는 그 INVITE 를 **정말로 못 봤습니다.**
> 이유가 "안 나갔다" 가 아니라 "엉뚱한 데로 나갔다" 였을 뿐입니다.

#### ⚠️ 지금 Janus 로그 레벨이 6입니다 — 설정 파일에는 없습니다

다음 시도를 계측하려고 Admin API 로 올려 두었습니다. **재시작하면 `janus.jcfg`
의 4로 돌아갑니다.** 설정 파일 어디에도 없는 상태이므로 여기 적어 둡니다.

```bash
SECRET=$(cat services/janus/secrets/admin-secret)
# 되돌리기
curl -s -X POST -H 'Content-Type: application/json' \
  -d "{\"janus\":\"set_log_level\",\"level\":4,\"transaction\":\"l\",\"admin_secret\":\"$SECRET\"}" \
  http://127.0.0.1:7088/admin
```

#### 만들면서 걸린 것 둘

**① janus.js 콜백은 낡은 클로저를 붙든다.** `attach()` 에 함수를 직접 넘기면
그때의 React state 를 평생 들고 갑니다. 등록만 할 때는 드러나지 않았지만 통화
상태가 붙으면 바로 문제가 됩니다. `ref` 를 한 겹 두어 항상 최신 함수를 부르게
했습니다.

**② `handleRemoteJsep` 은 answer 에만.** 처음에 SDP 가 오면 무조건 넘기게
썼는데, 착신(`incomingcall`)과 함께 오는 것은 **offer** 입니다. 그건
`createAnswer` 에 넘겨야 하는 것이라 먼저 삼키면 응답을 만들 수 없습니다.
`jsep.type === 'answer'` 일 때만 부르도록 고쳤습니다.

여기까지 되면 **게이트웨이 자체는 완성**입니다. 이후는 상대 단말과의 상호운용
문제입니다.

#### 2차 시도 (2026-08-21) — 통과. 진짜 원인은 `outbound_proxy` 였다

**증상은 1차와 같았습니다** — `2001` 이 `calling` 에서 멈추고, `2003` 은
`incomingcall` 을 받지 못하고, Kamailio 저널에는 INVITE 가 없었습니다.
계정을 `2003` 으로 바꿔 "다른 단말이 잡고 있다"(원인 ②)를 걷어낸 뒤에도
똑같이 실패했으므로, 원인 ② 는 **1차 실패의 이유가 아니었습니다.**

로그 레벨 6 덕분에 이번에는 Janus 가 무엇을 했는지 그대로 보였습니다.

```
Registering user sip:2001@pluto.org … through sip:192.168.0.252:5060 (outbound proxy: none)
[2001][nua_r_register]: 401 Unauthorized      ← REGISTER 는 정상 (digest 챌린지)
2001 is calling sip:2003@pluto.org
[2001][nua_i_state]: 0 INVITE sent, call state [calling]
                                              ← 그리고 아무 응답도 오지 않는다
```

REGISTER 는 되는데 INVITE 만 답이 없습니다. 여기가 갈림길입니다.

**`proxy` 는 REGISTER 를 보낼 곳일 뿐입니다.** INVITE 의 목적지는 요청 URI 의
도메인으로 정해지는데, `pluto.org` 는 **실재하는 공인 도메인**입니다.

```
$ getent hosts pluto.org
13.248.169.48   pluto.org
76.223.54.146   pluto.org
```

그래서 sofia-sip 이 이것을 DNS 로 풀어 **INVITE 를 인터넷으로 보냈습니다.**
Kamailio 는 그 패킷을 아예 보지 못했고, 그래서 로그도 응답도 없었던 것입니다.
화면에서는 `calling` 에서 멈춘 것으로만 보입니다 — 어디로 갔는지 알려 주는
단서가 화면에는 하나도 없습니다.

`kamailio-local.cfg` 의 `alias=pluto.org` 는 Kamailio 가 **받은** 요청을 자기
것으로 인정하게 할 뿐, 단말이 어디로 **보낼지**에는 관여하지 않습니다.

**고침 — `register` 에 `outbound_proxy` 를 함께 보냅니다.**

```js
handleRef.current.send({
  message: {
    request: 'register',
    username: `sip:${user}@${config.sipDomain}`,
    authuser: user, display_name: user, secret,
    proxy,
    outbound_proxy: proxy,   // ← 이것이 빠져 있었다
  },
});
```

Janus SIP 플러그인은 이 값을 `NUTAG_PROXY` 로 sofia 에 넘겨 **모든 요청**을
그리로 보냅니다 (`janus_sip.c` 의 `nua_invite` 호출). 한 줄 넣자 통과했습니다.

##### 결과

| 단계 | 결과 |
|---|---|
| 5-1 등록 | ✅ `2001` · `2003` 둘 다 `registered` |
| 5-2 발신·수락 | ✅ `calling` → `ringing`(180) → `accepted` |
| 5-3 미디어 | ✅ **A 297 / B 298 패킷 수신, 손실 0**, ICE·DTLS `connected` |
| 5-4 끊기 | ✅ 양쪽 `hangup 200`, Admin API `list_sessions` 가 `[]` |
| 5-4 재발신 | ✅ 끊은 뒤 다시 걸어 147 패킷 수신 — ①의 고침이 실제로 듣는다 |

##### 미디어가 정말 rtpproxy 를 지났습니다

③의 정정이 실물로 확인됐습니다. SDP 의 `m=audio` 포트가 홉마다 바뀝니다.

| 홉 | `m=audio` | 어느 범위 |
|---|---|---|
| Janus A 가 보낸 INVITE | `30140` | Janus SIP `30000-30200` |
| Janus B 가 **받은** offer | `11670` | **rtpproxy `10200-19999`** |
| Janus B 의 200 OK | `30022` | Janus SIP |
| Janus A 가 **받은** answer | `10250` | **rtpproxy** |

Kamailio 가 양쪽을 NAT 뒤로 판정해 `rtpproxy_manage()` 를 부른 결과입니다.
`c=` 는 전 구간 `192.168.0.252` 로, ③의 `local_ip` 결정도 그대로 유효합니다.

##### 코덱은 opus 로 붙었습니다 — 6단계가 여전히 필요한 이유

양쪽이 다 크롬이라 교집합의 맨 위인 **opus** 가 선택됐습니다. ⑥이 말한
PCMU/PCMA 브리징은 이 시험으로 검증되지 **않습니다.** 상대가 G.711 만 하는
단말일 때 어떻게 되는지는 6단계에서 처음 확인하게 됩니다.

##### 시험을 사람 없이 돌렸습니다

탭 둘을 손으로 여는 대신 헤드리스 크롬 하나에서 janus.js 세션 둘을 띄웠습니다
(`--use-fake-device-for-media-stream` 이 440Hz 톤을 만들어 줍니다). 로직은
`web/src/pages/TestCall.jsx` 와 같고, 미디어 판정은 `getStats()` 의
`inbound-rtp.packetsReceived` 로 합니다 — "연결됨인데 소리가 안 난다" 를
사람 귀 없이 잡아내는 자리입니다.

대시보드 페이지를 그대로 쓰지 않은 이유는 그 페이지가 manager 로그인 세션을
요구하기 때문입니다. 하니스는 Janus 에 직접 붙습니다.

하니스는 **`../verify-call.sh` 로 저장소에 들어와 있습니다.**

```bash
./verify-call.sh                     # 점검만 — 전화를 걸지 않는다
./verify-call.sh --run               # 2001 → 2003 실제 통화
./verify-call.sh --run --from 2001 --to 2003
```

종료 코드로 판정합니다 — `0` 통과, `1` 실패, `2` 브라우저 무응답. 마지막
실행의 결과와 로그는 `test-harness/last-run/` 에 남습니다 (gitignore).

계정 비밀번호는 `secrets/sip-<사용자>.pw` 에서 읽습니다. 없으면 만드는 방법을
점검이 알려 주고 멈춥니다 — 계정을 스크립트가 만들지는 않습니다 (4-1 의 규약).

##### 세션이 남았는지 볼 때는 시점을 조심해야 합니다

5-4 의 "세션이 남지 않는지" 를 **끊자마자 재면 남아 있는 것처럼 보입니다.**

```
통화 종료 직후   → sessions: [2개]
브라우저 종료 직후 → sessions: [2개]   ← 아직 남는다
브라우저 종료 +12초 → sessions: []
```

누수가 아니라 `janus.jcfg` 의 `session_timeout`(기본 60초)입니다. SIP 핸들은
`hangup` 에서 정리되지만 Janus **세션**은 클라이언트가 keepalive 를 멈춘 뒤에야
회수됩니다. 8단계에서 대시보드에 세션 화면을 붙일 때도 같은 착시가 생길 자리입니다.

##### `o=` 줄의 `1.1.1.1` 은 문제가 아닙니다

로그 중간에 `c=IN IP4 1.1.1.1` 이 스쳐 지나갑니다. Janus 가 `0.0.0.0` 을
치환하는 과정의 중간 상태이고, **최종 SDP 는 `192.168.0.252`** 입니다.
위 표의 통화가 실제로 붙은 것이 그 증거입니다.

### 6단계 — 시험 통화 ② 브라우저 ↔ 소프트폰 (평문 RTP)

WebRTC ↔ 평문 RTP 브리징이 되는지를, 통제 가능한 상대로 먼저 확인합니다.

| | 할 일 | 확인 |
|---|---|---|
| 6-1 | 평문 RTP 만 하는 상대를 세운다 | ✅ `test-harness/sipua.js` (`2004`) — 아래 |
| 6-2 | 브라우저 → 평문 단말 발신 | ✅ **`PCMU` 로 협상**, 양방향 RTP |
| 6-3 | 평문 단말 → 브라우저 착신 | ✅ 방향을 바꿔도 같음 |
| 6-4 | SDP 의 `c=` 확인 | ✅ 전 구간 `192.168.0.252` (③) |

**✅ 6단계 완료 (2026-08-21).**

```bash
./verify-bridge.sh              # 점검만
./verify-bridge.sh --run        # 양방향 (6-2 · 6-3)
./verify-bridge.sh --run --out  # 발신 방향만
```

#### 결과

| | 브라우저(WebRTC) | 평문 SIP 단말 |
|---|---|---|
| 6-2 발신 | `audio/PCMU`, 수신 295 / 송신 299 | `PCMU/8000`, 수신 539 / 송신 536, 수신 pt `[0]` |
| 6-3 착신 | `audio/PCMU`, 수신 295 / 송신 297 | `PCMU/8000`, 수신 387 / 송신 385, 수신 pt `[0]` |

**⑥이 맞았습니다 — 교집합이 있고, 트랜스코딩은 일어나지 않습니다.** Janus 가
브라우저 쪽으로 내려보내는 SDP 자체가 PCMU 하나로 좁혀집니다.

```
m=audio 9 UDP/TLS/RTP/SAVPF 0
a=rtpmap:0 PCMU/8000            ← opus 가 아예 빠진다
```

크롬이 낸 원래 제안은 `[111,63,9,0,8,13,110,126]`(opus·red·G722·PCMU·PCMA·CN·
telephone-event)였고, 평문 단말이 G.711 만 받으니 그 교집합인 PCMU 로 내려
앉았습니다. 5단계가 opus 로 붙었던 것과 대비됩니다.

#### 상대를 왜 `baresip` 이 아니라 직접 만들었는가

`baresip` · `linphone-cli` 둘 다 미설치이고 설치에 sudo 가 필요합니다. 그보다
중요한 이유는 **판정을 프로그램으로 단언할 수 있다**는 것입니다 —
`sipua.js` 는 협상된 payload type 과 주고받은 RTP 패킷 수를 그대로 돌려주므로,
사람이 귀로 듣지 않고도 "연결은 됐는데 소리가 안 난다" 를 잡아냅니다.

계정은 `2003` 대신 **`2004`** 를 씁니다. `2003` 은 5단계(`verify-call.sh`)의
브라우저 B 쪽이라 그대로 두어야 합니다.

이 단말은 **WebRTC 를 전혀 쓰지 않습니다** — 평문 SIP/UDP 와 평문 RTP(G.711)
뿐입니다. 그래서 이 시험이 성립합니다.

#### 미디어 경로가 방향에 따라 다릅니다

같은 두 단말인데 rtpproxy 가 한쪽 방향에만 낍니다.

| 방향 | 평문 단말이 본 상대 미디어 포트 | 무엇 |
|---|---|---|
| 6-2 브라우저 → 단말 | `10610` | **rtpproxy** (10200-19999) |
| 6-3 단말 → 브라우저 | `30080` | **Janus 직결** (30000-30200) |

Kamailio 의 NAT 판정과 `rtpproxy_manage()` 호출 위치가 방향마다 다르기
때문으로 보입니다. 양쪽 다 미디어는 정상이므로 지금 고칠 것은 없지만,
9단계(외부 브라우저)에서 포워딩 범위를 정할 때 **두 범위를 다 고려해야
한다**는 뜻이라 적어 둡니다.

#### 만들면서 걸린 것 셋

**① 응답에 Via 를 전부 되돌려야 한다.** Kamailio 가 자기 Via 를 얹으므로
우리에게 온 INVITE 에는 Via 가 둘이다. 하나만 되돌렸더니 응답이 발신자까지
가지 못했다. `Record-Route` 도 같은 이유로 그대로 돌려줘야 한다.

**② `Content-Length` 는 실제 본문 바이트와 정확히 같아야 한다.** 길이는 본문
전체로 재고 본문에서는 끝 CRLF 를 지워 보냈더니 2바이트가 어긋났고 Kamailio 가
그 200 OK 를 버렸다. **180 Ringing 은 본문이 없어 그대로 통과**해서, 화면에는
"벨은 울리는데 안 받아지는" 모양으로 보였다 — 원인을 미디어 쪽에서 찾게 만드는
증상이다.

**③ 헤드리스 크롬은 뜨는 데 30초가 걸린다.** 안전 타임아웃을 통화 시간 기준으로
잡았더니 통화가 시작된 지 2초 만에 스스로 끊었다. 대기 시간(`--wait`)과 통화
시간(`--duration`)은 반드시 나눠야 한다.

#### `sngrep` 대신 Janus 저널로 확인했습니다

6-4 의 `c=` 확인은 `sudo sngrep` 없이 Janus 저널의 `Prepared SDP` 로 했습니다.
전 구간 `192.168.0.252` 입니다. 실단말(7단계)에서는 상대가 무엇을 보내는지
알 수 없으므로 그때는 `sngrep` 이 필요합니다.


### 7단계 — 시험 통화 ③ 브라우저 ↔ 인터폰 (실단말)

상대는 **`Pluto Android 2.15-dev`**(`2002`, `192.168.0.67:5160`) 입니다.
pjsip/pjmedia 기반이고, `services/kamailio/example/android/android-pjsip-phone`
쪽 코드와 같은 계열로 보입니다.

| | 할 일 | 확인 |
|---|---|---|
| 7-1 | 실단말의 SDP 를 뜬다 | ✅ Janus 저널로 확보 (`sngrep` 불필요) |
| 7-2 | 음성 통화 | ✅ **양방향** — 아래 |
| 7-3 | 영상 통화 | ⚠️ 패킷은 양방향, **단말 화면 표시는 미해결** |
| 7-4 | 결과 기록 | ✅ 이 절 |

**✅ 7단계 — 음성 통화 성공 (2026-08-21).** 영상은 아래 단서를 남기고 미룹니다.

```bash
./verify-bridge.sh --run --device 2002    # 단말이 울리면 사람이 받아야 한다
```

#### 결과

| | 브라우저(WebRTC 다리) | rtpproxy(평문 다리) |
|---|---|---|
| 음성 | `audio/PCMU` 수신 1528 / 송신 1527 | 미디어 `#1` 흐름 있음 → `192.168.0.67:4004-4005` |
| 영상 | `video/H264` 수신 1036 / 송신 1416 | 미디어 `#2` 흐름 있음 → `192.168.0.67:4006-4007` |

#### 실단말의 SDP

```
o=- 3996300503 3996300504 IN IP4 192.168.0.252
s=pjmedia
m=audio 17076 RTP/AVP 0 126     a=rtpmap:0 PCMU/8000
                                a=rtpmap:126 telephone-event/8000
m=video 13246 RTP/AVP 103       a=rtpmap:103 H264/90000
                                a=fmtp:103 profile-level-id=42001e; packetization-mode=1
```

Janus 는 이것을 받아 브라우저 쪽 SDP 를 **PCMU + H264(`42001e`) 로 좁혀**
내려보냅니다. ⑥이 걱정한 `fmtp` 어긋남은 일어나지 않았습니다 — 크롬이 낸
`42001f` 대신 단말의 `42001e` 를 그대로 받아들입니다.

#### 처음에 "음성 안 됨 · 영상 한 방향" 으로 보였던 것

첫 시도에서는 음성이 안 들리고 영상이 `2002 → 2001` 한 방향만 확인됐습니다.
**서버 경로의 문제가 아니었습니다.**

가르는 데 쓴 방법이 두 단계였습니다.

1. **통제 가능한 상대로 같은 모양을 만든다.** `sipua.js --with-video` 로
   음성+영상 두 m-line 을 내게 했더니 양쪽 다 정상으로 흘렀다 (음성 543 패킷
   pt 0, 영상 474 패킷 pt 103). 그러니 m-line 이 둘이라 깨지는 것이 아니다.
2. **평문 다리의 패킷을 직접 센다.** Janus Admin API 는 SIP 다리의 RTP 수를
   내주지 않는다 (`plugin_specific` 에 등록·통화 상태뿐 — 실측 확인). rtpproxy
   제어 소켓(`udp:127.0.0.1 7722`)이 스트림별로 세고 있으므로 그쪽에 묻는다
   (`test-harness/probe-peer.js`).

그렇게 다시 재니 음성·영상 모두 양방향이었습니다. 첫 시도에서 영상이 한
방향만 보였던 것은 **그때 브라우저가 영상을 안 보냈기 때문**으로 보입니다 —
카메라가 없거나 권한이 거부되면 통화는 붙고 소리도 나지만 영상만 가지 않습니다.
하니스는 크롬의 가짜 카메라를 쓰므로 그 변수가 빠지고, 그러자 곧바로 흘렀습니다.

#### ⚠️ 영상은 단말 화면에 그려지지 않았습니다 — 미해결로 남깁니다

**패킷이 갔다는 것과 화면에 보였다는 것은 다릅니다.** 위 수치는 브라우저의 영상
RTP 1416개가 단말 주소까지 도달했음을 보일 뿐입니다. 실제로 받아 본 결과
**단말 화면에는 브라우저 쪽 영상이 나오지 않았습니다.**

| | 상태 |
|---|---|
| 음성 (양방향) | ✅ 들림 |
| 영상 `2002 → 2001` | ✅ 브라우저에서 보임 |
| 영상 `2001 → 2002` | ⬜ **패킷은 도달, 화면에는 안 나옴** |

서버 쪽에서 더 볼 것은 없습니다 — SDP 협상도, rtpproxy 중계도, 패킷 도달도
확인됐습니다. 남은 것은 단말이 그 H264 스트림을 디코딩해 그리는 부분입니다.

**제대로 된 WebRTC 에이전트를 만들어 다시 시험하기로 했습니다.** 그때 갈릴
것들 — 크롬의 가짜 카메라가 내는 H264 가 단말 디코더에 맞는지(프로파일·
`packetization-mode`), SPS/PPS 가 주기적으로 실려 가는지, 단말 화면에 원격
영상을 그리는 자리가 실제로 붙어 있는지.

이 계획서의 목표는 **음성 통화**(7-2)였고 그것은 달성됐습니다. 영상은 목표
너머의 항목이므로 8단계로 넘어갑니다.


### 8단계 — 관리 대시보드 채우기

| | 화면 | 읽는 곳 | 상태 |
|---|---|---|---|
| 8-1 | 개요 — 버전 · 플러그인 · 트랜스포트 · 프로세스 | `/janus-api/info` | ✅ (3단계) |
| 8-2 | 세션 · 핸들 | Admin API `list_sessions` · `list_handles` | ✅ |
| 8-3 | SIP — 등록 상태 · 통화 상태 | `handle_info.plugin_specific` | ✅ |
| 8-4 | 미디어 — ICE/DTLS · 코덱 · 패킷 · 손실 | `handle_info.webrtc` | ✅ |
| 8-5 | 시험 통화 | `janus.js` | ✅ (3~5단계) |

**✅ 8단계 완료 (2026-08-21).** `세션·미디어` 탭이 새로 생겼습니다
(`web/src/pages/Sessions.jsx`, `server/src/sessions.js`).

#### 필드 이름은 짐작하지 않고 실측했습니다

한 번 데인 자리입니다. 처음에는 `plugin_specific` 에 RTP 수가 있을 것으로 보고
`audio_in` 같은 이름을 넣었는데, 통화 중에 `handle_info` 를 그대로 떠 보니
**그런 필드가 없었습니다.** 실제 모양은 이렇습니다.

```
info.plugin_specific   identity · registration_status · call_status · callee
info.webrtc.ice        state · selected-pair
info.webrtc.dtls       dtls-state · dtls-role · srtp-profile
info.webrtc.media[N]   type · codecs{pt,codec} · direction · stats.in/out · rtcp.main
```

두 가지를 화면 주석에도 적어 두었습니다.

- **`webrtc` 절은 PeerConnection 이 올라와 있을 때만 생깁니다.** 등록만 해 둔
  핸들에는 없는 것이 정상이라, 없다고 오류처럼 그리면 안 됩니다.
- **여기 보이는 패킷 수는 WebRTC 다리의 것입니다.** 상대(SIP) 쪽으로 얼마나
  나갔는지는 Janus 가 Admin API 로 내주지 않습니다 — 그쪽은 rtpproxy 에 물어야
  합니다 (`test-harness/probe-peer.js`). 7단계에서 이 구분이 결정적이었습니다.

#### 읽기만 합니다

kamailio-dashboard 와 같은 자세입니다. 세션을 끊는 단추는 두지 않았습니다.
통화를 끊는 것은 단말이 할 일이고, Janus 를 다루는 것은 `install.sh` 입니다.

호출 수가 (세션 × 핸들)로 늘어나므로 상한을 두었고(50 세션 · 세션당 20 핸들),
생략이 일어나면 화면이 그 사실을 알립니다 — 조용히 자르지 않습니다.

#### 화면이 깨지지 않는지 확인한 방법

로그인이 필요한 화면이라 사람이 눌러 보지 않고는 확인이 어렵습니다. 그래서
`@/lib/api` 를 스텁으로 갈아 끼우고 헤드리스 크롬에 **컴포넌트만 띄워** 봤습니다.
네 갈래를 한 번에 태웠습니다 — 통화 중(음성+영상), 등록만 된 핸들(`webrtc` 없음),
핸들 읽기 실패, 세션 읽기 실패. 오류 없이 그려집니다.


kamailio-dashboard 와 같은 자세를 지킵니다 — **읽기만 합니다.** Janus 를
재시작하거나 설정을 바꾸지 않습니다. 그건 `install.sh` 가 sudo 로 하는 일입니다.

### 9단계 — 외부(인터넷) 브라우저 받기

LAN 시험이 끝난 뒤에 손댑니다. 여기서부터 라우터 설정이 필요합니다.

| | 할 일 | 상태 |
|---|---|---|
| 9-1 | `janus.jcfg` 에 `nat_1_1_mapping` | ✅ 준비됨 — **적용은 sudo 필요** |
| 9-2 | 라우터에 `20000-20200/udp` 포워딩 | ⬜ **사람이 공유기에서** |
| 9-3 | 시그널링은 추가 포워딩 없음 | ✅ 4단계에서 이미 확인 |
| 9-4 | 공인 IP 변경 추적 | ✅ `check-public-ip.sh` |

**준비는 끝났고, 남은 두 가지는 제 손이 닿지 않는 곳입니다** — sudo 로 설정을
적용하는 것과 공유기에 포워딩을 여는 것입니다.

```bash
cd services/janus
./check-public-ip.sh --write     # 지금 공인 IP 를 public-ip 에 적는다
sudo ./install.sh --apply        # 설정 반영 + Janus 재기동 (실패하면 자동 롤백)
```

그다음 공유기에서 **UDP `20000-20200` → `192.168.0.252`** 를 엽니다.

#### 9-1 — 설정을 값이 아니라 **파일**로 받게 했습니다

`janus.jcfg` 에 IP 를 직접 적으면 회선이 바뀔 때마다 커밋이 생기고, 다른 장비에
그대로 설치하면 남의 주소를 광고합니다. 그래서 비밀을 다루던 방식과 같게 했습니다.

| `public-ip` 파일 | `install.sh --apply` 가 하는 일 |
|---|---|
| 있음 | `nat_1_1_mapping` 을 그 값으로 치환 |
| **없음** | `nat_1_1_mapping` 과 `keep_private_host` **두 줄을 지운다** (LAN 전용) |

"없으면 지운다" 를 기본으로 둔 이유는, 자리표시자가 남으면 Janus 가 그 문자열을
주소로 알아듣고 **외부 통화가 조용히 무음이 되기** 때문입니다. 값이 IPv4 로
보이지 않으면 설치를 아예 멈춥니다. `public-ip` 는 커밋하지 않습니다.

#### ⚠️ `keep_private_host` 가 없으면 LAN 통화가 깨집니다

이번에 준비하면서 드러난 것이고, 계획서에 없던 항목입니다.

`nat_1_1_mapping` 은 host 후보의 사설 주소를 공인 주소로 **바꿔치기** 합니다.
외부 단말에게는 그래야 맞지만, **같은 LAN 안의 브라우저도 공인 주소를 받게 되어**
공유기를 되짚어 나갔다 들어와야 합니다(헤어핀 NAT). 가정용 공유기는 그것을 못
하는 경우가 많고, 그러면 5~7단계에서 되던 LAN 통화가 무음이 됩니다.

Janus 1.4 는 `keep_private_host = true` 를 지원합니다 — 사설 후보를 지우지 않고
**둘 다** 광고합니다. LAN 단말은 사설 후보로 곧장 붙고 외부 단말은 공인 후보로
붙습니다. 잃는 것은 후보 하나가 늘어나는 것뿐이라, 켜 두었습니다.

#### 9-2 — 열어야 할 것은 `20000-20200/udp` 하나뿐입니다

6단계에서 미디어 경로가 방향마다 다른 것(한쪽은 rtpproxy `10200-19999`, 다른
쪽은 Janus 직결 `30000-30200`)을 발견했을 때 포워딩 범위를 다시 봐야 하는 것이
아닌가 했지만, **확인해 보니 그렇지 않았습니다.**

인터넷을 건너는 다리는 **브라우저 ↔ Janus 의 WebRTC 미디어 하나뿐**입니다.
SIP 미디어(`30000-30200`)와 rtpproxy(`10200-19999`)는 Janus·Kamailio·rtpproxy가
모두 `192.168.0.252` 한 대에 있어 LAN 밖으로 나가지 않습니다. 실제 통화에서
Janus 가 낸 ICE 후보도 전부 그 범위 안이었습니다.

```
a=candidate:1 1 udp … 192.168.0.252 20000 typ host
                                    20002 · 20004 · 20013 · 20019 …
```

#### 9-4 — 바뀌는 순간을 잡아내는 것이 관건입니다

가정용 회선은 공인 IP 가 바뀝니다. 바뀌는 순간부터 Janus 는 **낡은 주소를 ICE
후보로 광고**하고, 외부 브라우저와는 신호는 붙는데 소리가 나지 않습니다.
어디에도 오류가 뜨지 않아 원인을 짚기 어려운 종류입니다.

```bash
./check-public-ip.sh          # 0 같음 · 1 다름 · 2 확인 불가
./check-public-ip.sh --write  # 현재 값을 public-ip 에 적는다 (적용은 별개)
```

공인 IP 는 **DDNS 이름(`jejezzhome.iptime.org`)을 DNS 로 풀어** 알아냅니다.
외부 IP 확인 서비스에 묻지 않습니다 — 공유기가 어차피 그 이름을 갱신하고
있고, 바깥으로 요청을 하나 덜 보냅니다.

크론에 걸어 두면 조용한 실패를 막을 수 있습니다.

```
*/30 * * * * <경로>/check-public-ip.sh --quiet || echo "janus: 공인 IP 가 바뀌었습니다" | logger -t janus-natcheck
```

> `--write` 는 파일만 고칩니다. **Janus 에 반영하려면 `sudo ./install.sh --apply`**
> 가 따로 필요합니다 — 재기동이 걸리는 일을 크론이 저절로 하게 두지 않습니다.

#### 아직 확인되지 않은 것

외부에서 실제로 걸어 본 적은 없습니다. 위 두 가지를 적용한 뒤 **LAN 밖의
브라우저**로 `https://jejezzhome.iptime.org:28443/janus/dashboard/test-call` 에
들어가 걸어 봐야 합니다. 그때 함께 볼 것 —

- LAN 통화가 여전히 되는가 (`keep_private_host` 가 듣는지)
- 외부 통화의 소리가 나는가 (포워딩과 `nat_1_1_mapping` 이 맞는지)

### 10단계 — 정리

| | 할 일 |
|---|---|
| 10-1 | `README.md` 를 실제 결과로 갱신 (현황 표 · 문제 해결) |
| 10-2 | `bootstrap.sh` 로 **빈 장비에서 재현되는지** 검토 |
| 10-3 | 기존 `/sip/`(Kamailio WS) 라우트를 유지할지 결정 |
| 10-4 | 안드로이드 앱의 경로 결정 — Janus 로 옮길지, SIP + rtpengine 으로 갈지 |

## 위험·함정

세우는 동안 **조용히 실패**하기 쉬운 것들입니다. 겉으로는 다 정상으로 보입니다.

| | 증상 | 원인 | 대비 |
|---|---|---|---|
| 1 | 통화는 성립하는데 **무음** | SDP `c=` 가 `127.0.0.1` | ③ — `local_ip` 를 명시 |
| 2 | 통화 성립이 **몇 초씩 느림** | docker/virbr 주소까지 ICE 후보로 나감 | ⑦ — `ice_enforce_list` |
| 3 | manager 에 janus 가 **중단**으로 뜸 | 헬스가 WS 포트로 감 | ① — REST 로 고정 |
| 4 | 음성은 되는데 **영상만 안 됨** | H.264 `fmtp` 불일치 | ⑥ — 음성 먼저, `sngrep` 으로 SDP 확인 |
| 5 | Kamailio 로그에 rtpproxy 오류 | `WITH_NAT` 이 켜져 있는데 데몬이 없음 | ③ — NAT 로 판정되지 않아야 한다. 4-4 에서 확인 |
| 6 | Admin API 가 **기본 비밀번호**로 열림 | `janusoverlord` | ④ |
| 7 | `janus.js` 와 서버 버전 불일치 | 라이브러리를 커밋해 두고 Janus 만 올림 | 빌드 때 `/opt/janus` 에서 복사 |
| 8 | 재부팅 후 Janus 가 안 뜸 | systemd `enable` 을 빠뜨림 | 2-3. pm2 부팅 복원과는 별개다 |
| 9 | **연결 자체가 안 됨** | `/janus-api` 라우트에 끝 슬래시 → 세션 생성 POST 가 301 | 3-3 에서 겪음. 슬래시를 빼 두었다 |
| 10 | 설치가 멀쩡한데 점검이 "고친 흔적" 이라고 함 | `janus.jcfg` 는 `0640 root:janus` 라 일반 사용자가 못 읽는다 | 점검이 "확인 불가" 로 구분한다 |
| 11 | 비밀을 만들었는데 대시보드가 계속 없다고 함 | 실패를 캐시했다 | 성공만 캐시하도록 고침. 재시작이 필요 없다 |
| 12 | 미디어가 안 붙음 / 포트 충돌 | rtpproxy 에 `-M` 이 없으면 최대가 65000 이라 Janus 범위를 통째로 삼킨다 | `install.sh` 점검이 이제 잡는다 |
| 13 | "rtpengine 이 없으니 미디어 릴레이가 없다" 고 오해 | **rtpproxy 1.2.1 이 이미 돌고 있다** | ③의 정정 참고. 없는 것은 rtpengine 뿐이다 |

## 이 저장소 밖에서 해야 하는 것

| | 왜 밖인가 |
|---|---|
| 라우터 포워딩 `20000-20200/udp` | 9단계. 장비 설정 |
| 공인 IP 추적(DDNS 등) | 9-4. 회선 사정 |
| 인터폰 단말의 코덱·계정 설정 | 단말 쪽 설정 |
| Janus 재빌드 | 소스는 `~/Public/RetroLink/janus-gateway`. 지금 필요 없다 |
