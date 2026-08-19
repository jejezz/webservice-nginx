# SIP 서비스 구축 계획 — WebSocket · NAT · 미디어

이 문서는 결정이 필요한 지점과 검증한 사실을 모아 둔 것입니다.
현재 상태는 `./setup-websocket.sh` 로 언제든 확인할 수 있습니다.

> **운영 중이 아닙니다.** 지금은 변경에 제약이 없습니다.

## 무엇을 만들려는가

| 요구 | 내용 |
|---|---|
| 서버 위치 | **NAT 내부** (`192.168.0.252`, 공유기 뒤) |
| 내부 agent | **인터폰 장비** (고정 기능 임베디드) |
| 통화 1 | 인터폰 ↔ 인터폰 |
| 통화 2 | 인터폰 ↔ 외부 모바일 |
| 우선순위 | **인터폰 → 모바일 착신이 중요** (모바일을 깨워 받게 해야 함) |
| 코덱 (음성) | **PCMU / PCMA** |
| 코덱 (영상) | **H.264** |
| 미디어 (모바일) | RTP · WebRTC 둘 다 가능 |

### 목표 구조

```
                          공유기 (NAT)
                 ┌──────────────────────────────────────┐
                 │            192.168.0.252             │
 [모바일 agent]   │                                      │
   (외부·LTE)     │   ┌─ nginx :443 ──ws──▶ kamailio :5080 (WS)
      │  시그널링 ─┼──▶│                          │           │
      │  :28443   │   └─(이미 포워딩되어 있음)      │           │
      │           │                              ├──▶ [내부 SIP agent]
      │           │                     kamailio :5060 (UDP)  │
      │  미디어    │                                          │
      └─ RTP ─────┼──▶ rtpengine :30000-30500 (UDP) ─────────┘
         :30000+  │        ⚠️ 포워딩 추가 필요
                 └──────────────────────────────────────┘
```

### 포트 포워딩

| 외부 | → 내부 | 용도 | 상태 |
|---|---|---|---|
| `28443/tcp` | `443` (nginx) | 모바일 SIP 시그널링 (WSS) | ✅ **이미 있음** |
| `30000-30500/udp` | 같은 포트 (rtpengine) | 모바일 미디어 (RTP) | ❌ **추가 필요** |

**시그널링은 새 포워딩이 필요 없습니다.** 모바일이 `wss://<공인IP>:28443/sip/` 로
붙으면 이미 열려 있는 HTTPS 경로를 그대로 탑니다. 이것이 (b)안(Kamailio 가 직접
TLS 종단, 포트를 새로 열어야 함)보다 (a)안이 나은 결정적인 이유입니다.

**미디어는 nginx 를 거치지 않습니다.** RTP 는 UDP 라 별도 포워딩이 필요합니다.

### 미디어 경로

| 통화 | 경로 | rtpengine | 비고 |
|---|---|---|---|
| 내부 ↔ 내부 | 직접 RTP (같은 LAN) | 불필요 | 가장 단순. 서버를 거치지 않음 |
| 내부(RTP) ↔ 모바일(RTP) | rtpengine 릴레이 | **필요** | 공인 IP 광고 + 포워딩 |
| 내부(RTP) ↔ 모바일(WebRTC) | rtpengine 브리징 | **필요** | 위 + DTLS/ICE |

**모바일은 WebRTC 를 권합니다.** (영상이 들어오면서 판단이 바뀌었습니다 —
앞서 평문 RTP 를 권했던 것은 영상과 기존 WebRTC 스택을 모르는 상태의 판단이었습니다)

- 모바일 앱에 **이미 WebRTC 스택이 있습니다** (rtc-relay-server 용). 평문 RTP 로
  가려면 H.264 RTP 스택을 새로 만들어야 하는데, 그게 WebRTC 를 재사용하는 것보다
  일이 큽니다.
- 인터넷 구간이 **SRTP 로 암호화**됩니다.
- rtpengine 이 WebRTC(SRTP/DTLS/ICE) ↔ 평문 RTP 브리징을 합니다. **영상도 됩니다** —
  암호화 계층만 벗기고 씌우는 것이라 트랜스코딩이 아닙니다.

대가는 ICE 후보 수집 시간이 착신 지연에 더해지는 것입니다. LAN·LTE 환경에서
host/srflx 후보만 모으면 크지 않습니다.

### 코덱 — 영상이 제일 까다롭다

| | 인터폰 | 모바일(WebRTC) | 결과 |
|---|---|---|---|
| 음성 | PCMU / PCMA | **필수 지원** (RFC 7874 가 G.711 을 의무화) | ✅ 그대로 통과 |
| 영상 | H.264 | H.264 (단서 있음, 아래) | ⚠️ **파라미터가 맞아야 함** |

**모든 단말이 H.264 를 필수 지원하므로 트랜스코딩은 필요 없습니다.** (확정)
rtpengine 은 어차피 영상을 트랜스코딩하지 않고 그대로 흘려보내기만 하므로,
이 조건이 맞아떨어집니다.

다만 코덱이 같아도 **`fmtp` 파라미터가 어긋나면 협상이 깨질 수 있습니다.** 이건
트랜스코딩으로 풀리는 문제가 아니라 양끝을 맞춰야 하는 문제입니다. 음성은 멀쩡한데
영상만 안 나오는 형태로 나타나므로, 안 되면 여기를 먼저 보세요.

맞아야 하는 것은 `fmtp` 의 두 값입니다.

```
a=fmtp:96 profile-level-id=42e01f;packetization-mode=1
                          ^^^^^^                    ^
                          프로파일/레벨              패킷화 모드
```

- `packetization-mode` — WebRTC 는 보통 `1`(non-interleaved)을 씁니다. 인터폰
  장비는 `0`(single NAL)만 내는 경우가 흔합니다. **여기가 제일 자주 어긋납니다.**
- `profile-level-id` — WebRTC 는 대개 Constrained Baseline(`42e01f` 계열)입니다.
  인터폰이 Main/High 프로파일만 내면 안 맞습니다.

**Android WebRTC 의 H.264 는 단말 하드웨어에 의존합니다.** libwebrtc 는 H.264 를
MediaCodec(하드웨어 코덱)으로 처리하는데, 없는 단말에서는 **VP8 만 제시하고
영상이 아예 안 됩니다.** 지금 rtc-relay-server 로 영상 통화가 되고 있다면 이미
확인된 셈이지만, 대상 단말 범위를 넓힐 때 다시 걸릴 수 있습니다.

#### 지금 할 수 있는 확인 — 인터폰의 실제 SDP 보기

이 서버에 `sngrep` 이 있습니다. 인터폰끼리 한 통 걸어 보고 INVITE 의 SDP 를
그대로 뜨면, 위 두 값을 바로 알 수 있습니다.

```bash
sudo sngrep -d any port 5060
```

통화를 잡아 Enter 로 열면 SDP 가 보입니다. `m=video` 줄과 그 아래 `a=fmtp:` 를
확인하세요. 파일로 남기려면:

```bash
sudo tcpdump -i any -s 0 -A 'udp port 5060' -w /tmp/sip.pcap
```

급한 확인은 아닙니다 — 트랜스코딩이 필요 없다는 것이 확정됐으므로 조달이나
구조가 바뀌지 않습니다. **영상이 안 나올 때 제일 먼저 볼 곳**으로 적어 둡니다.

### rtpengine 과 NAT — 놓치기 쉬운 지점

rtpengine 은 `192.168.0.252` 에 있는데 모바일은 NAT 바깥입니다. 기본 설정이면
SDP 에 **사설 주소를 광고**하고, 모바일은 거기로 보낼 수 없어 **한쪽만 들리거나
아예 무음**이 됩니다. 조용히 실패하는 대표적인 형태입니다.

rtpengine 에 공인 주소를 알려 줘야 합니다.

```
# /etc/rtpengine/rtpengine.conf — 사설!광고 형식
interface = 192.168.0.252!<공인IP>
port-min  = 30000
port-max  = 30500
```

⚠️ **가정용 회선이면 공인 IP 가 바뀝니다.** 바뀌면 광고 주소가 어긋나 그때부터
무음이 됩니다. DDNS 로 추적하고 rtpengine 을 갱신하는 절차가 필요합니다.
(포트 범위를 좁게 잡은 이유는 공유기 포워딩 규칙을 적게 만들기 위해서입니다.
**영상이 있으므로 통화 1건당 음성·영상 두 스트림**이고, rtcp-mux 를 쓰면 스트림당
1포트라 4포트 정도, 안 쓰면 8포트입니다. 500개면 동시 60~125통 분량입니다)

## 왜 이 방향인가

지금은 `ws-bridge` 가 WS 클라이언트를 대신해 Kamailio 에 REGISTER 를 넣어 주는
**등록 대행** 구조입니다. 등록은 동작하지만 착신이 전달되지 않습니다.

- `ws-bridge` 가 등록하는 Contact 는 단말 자신의 주소(`sip:1001@10.0.0.5:5060`)라,
  Kamailio 는 착신 INVITE 를 브릿지를 건너뛰고 그리로 보냅니다.
- 브릿지의 SIP 파서는 **응답만** 해석합니다. INVITE 같은 요청은 버려집니다.
- WS 가 끊기고 30초가 지나면 등록을 해지하므로, 자는 단말은 아예 등록 상태가
  아닙니다. 착신이 성립할 수 없습니다.

브릿지에서 이것을 해결하려면 트랜잭션 계층, 다이얼로그 상태, Via/Contact/
Record-Route 재작성, 그리고 미디어 릴레이까지 직접 만들어야 합니다. 그건
stateful proxy 를 새로 쓰는 일입니다.

Kamailio 는 이 셋을 이미 가지고 있습니다.

| 필요한 것 | Kamailio 의 답 |
|---|---|
| SIP over WebSocket 전송 | `websocket` 모듈 (RFC 7118) |
| 자는 단말 착신 | `tsilo` — INVITE 를 붙들고, 푸시로 깨우고, 재등록 시 흘려보냄 |
| 푸시 규약 | RFC 8599 (`pn-provider` / `pn-param` / `pn-prid`) |
| WebRTC ↔ SIP 미디어 | `rtpengine` 모듈 + rtpengine 데몬 |

그러면 `ws-bridge` 는 SIP 경로에서 빠지고, FCM 발송은 이미 Firebase 를 갖춘
`rtc-relay-server` 가 맡는 편이 자연스럽습니다.

## 지금 무엇이 있고 무엇이 없는가

`./setup-websocket.sh` 가 출력하는 내용입니다 (2026-08-19 확인).

| 항목 | 상태 | 조달 방법 |
|---|---|---|
| `xhttp` (handshake) | ✅ 있음 | — |
| `nathelper` | ✅ 있음 | — |
| `rtpengine` 모듈 | ✅ 있음 | — |
| `tsilo` | ✅ 있음 | — |
| Android WebRTC 스택 | ✅ 이미 사용 중 | rtc-relay-server 용으로 구현되어 있음 |
| `websocket` 모듈 | ✅ 설치됨 | (2026-08-19) |
| `tls` 모듈 | ❌ 없음 | `kamailio-tls-modules` 5.5.4-1 — (b)안을 택할 때만 필요 |
| TCP 소켓 | ✅ 있음 | TCP·UDP 5060 이 모든 인터페이스에 열려 있음. WS 는 전용 포트 5080 을 따로 연다 |
| 푸시 호출용 HTTP 클라이언트 | ❌ 없음 | 아래 "④ 푸시를 어떻게 부를 것인가" |
| **rtpengine 데몬** | ❌ 없음 | **저장소에 없음** — sipwise 저장소 또는 소스 빌드 |

가장 큰 조달 항목은 **rtpengine 데몬** 하나입니다. 나머지는 apt 로 해결되거나
이미 있습니다.

---

## 정해야 할 것

### ① 설정을 어떻게 소유할 것인가 — **1~2단계는 해결, 3단계는 필요**

> **2026-08-19 정정.** 이 절은 처음에 "지금의 `kamailio-local.cfg` 오버라이드로는
> WebSocket 을 켤 수 없고, 배포판 `kamailio.cfg` 를 통째로 소유해야 한다"고
> 적었습니다. **그 판단이 틀렸습니다.** 실제로 검사해 보니 오버라이드로 켤 수
> 있습니다. 아래는 정정한 내용입니다.

배포판 `kamailio.cfg` 에 `WITH_WEBSOCKET` 스위치가 없는 것은 맞습니다.
5.5.4 패키지가 아는 스위치는 이것뿐입니다.

```
WITH_ACCDB  WITH_ALIASDB  WITH_ANTIFLOOD  WITH_AUTH  WITH_BLOCK3XX
WITH_BLOCK401407  WITH_DEBUG  WITH_FEATURE  WITH_IPAUTH  WITH_JSONRPC
WITH_MSGREBUILD  WITH_MULTIDOMAIN  WITH_MYSQL  WITH_NAT  WITH_NATSIPPING
WITH_PRESENCE  WITH_PSTN  WITH_RTPENGINE  WITH_SPEEDDIAL  WITH_TLS
WITH_USRLOCDB  WITH_VOICEMAIL
```

처음에는 여기서 "그러니 배포판 설정을 소유해야 한다"고 결론지었습니다.
근거는 WS handshake 를 처리할 `event_route[xhttp:request]` 가 배포판 954행에
**이미 정의돼 있어** 두 번 정의할 수 없다는 것이었습니다.

**그런데 그 event_route 는 `#!ifdef WITH_JSONRPC` 안에 있고, 그 스위치는 켜져 있지
않습니다.** `xhttp.so` 로드(257행)도 마찬가지입니다. 즉 자리가 비어 있습니다.

```
206:#!ifdef WITH_JSONRPC     ← 참조만 있고
256:#!ifdef WITH_JSONRPC        어디에도
336:#!ifdef WITH_JSONRPC        #!define WITH_JSONRPC 가 없다
953:#!ifdef WITH_JSONRPC
```

`kamailio-local.cfg` 는 127행에서 import 되는데, 이는 defines·모듈 로딩·라우트보다
모두 앞입니다. 그래서 오버라이드 파일에서 모듈을 로드하고 `listen=` 을 추가하고
`event_route[xhttp:request]` 를 정의할 수 있습니다.

`kamailio -c` 로 확인한 결과입니다 (실행 중인 서비스는 건드리지 않고 임시 디렉토리에서).

| 시험 | 결과 |
|---|---|
| 오버라이드에서 `xhttp.so` 로드 + `event_route` 정의 + `listen=` | ✅ `config file ok` |
| 거기에 `WITH_JSONRPC` 까지 켜면 | ❌ `duplicate route` — 검사가 충돌을 잡아낸다 |
| 없는 `websocket.so` 를 로드하면 | ❌ `could not find module` — 조용히 넘어가지 않는다 |
| `import_file` 대상이 없을 때 | ✅ 통과 (오류 아님) — 파일 분리 가능 |
| `#!define WITH_NAT` 을 오버라이드에서 | ✅ 통과 (nathelper/rtpengine/rtpproxy 로드) |

아래 두 시험이 중요합니다. 충돌과 모듈 부재를 `-c` 가 실제로 잡아내므로,
**첫 번째 시험의 통과는 진짜 통과입니다.**

#### 그래서 이렇게 합니다 — 파일 세 겹

```
/etc/kamailio/kamailio.cfg              배포판. 한 줄도 고치지 않는다
  └ 127행 import_file kamailio-local.cfg          install.sh 가 소유 (digest 인증)
      └ import_file kamailio-websocket.cfg        setup-websocket.sh 가 소유 (WS 전송)
```

`import_file` 은 대상이 없어도 오류가 아니므로, WS 파일을 지우면 WS 만 꺼지고
인증은 그대로 남습니다. 스크립트 하나가 파일 하나를 소유해 "어느 쪽이 최신인지"
문제가 생기지 않습니다.

배포판 설정을 통째로 소유하지 않아도 되므로 **패키지 업그레이드에 안전하다는
지금의 장점을 그대로 유지합니다.**

#### 제약 — 라우트는 고칠 수 없다. 그래서 여기까지만 된다

배포판이 아래 라우트를 전부 정의하므로 오버라이드에서 다시 정의할 수 없습니다
(`duplicate route`).

```
request_route  route[RELAY]  route[REQINIT]  route[WITHINDLG]  route[REGISTRAR]
route[LOCATION]  route[PRESENCE]  route[AUTH]  route[NATDETECT]  route[NATMANAGE]
route[DLGURI]  route[SIPOUT]  route[PSTN]  route[TOVOICEMAIL]
branch_route[MANAGE_BRANCH]  onreply_route[MANAGE_REPLY]  failure_route[MANAGE_FAILURE]
```

**WS 전송에는 문제가 없습니다.** WS 단말로 되돌아가는 데 필요한
`fix_nated_register()` / `set_contact_alias()` / `handle_ruri_alias()` 가
`route[NATDETECT]` 등에 있는데, 배포판이 이미 갖추고 `#!ifdef WITH_NAT` 로만 막아
두었습니다. define 은 오버라이드에서 켤 수 있으므로 그대로 씁니다.

⚠️ `WITH_NAT` 은 WS 뿐 아니라 **기존 UDP 단말의 처리도 바꿉니다.**
지금은 운영 중이 아니라 괜찮지만, 나중에 켤 때는 점검 창에서 적용하세요.

**그러나 착신(tsilo + 푸시)은 여기서 막힙니다.** 그 기능은 라우트 안에 코드를
넣어야 합니다.

| 넣을 곳 | 넣을 것 |
|---|---|
| `route[LOCATION]` | 등록이 없으면 `ts_store()` 로 INVITE 를 붙들고 푸시 요청 |
| `route[REGISTRAR]` | `save()` 뒤 `ts_append()` 로 붙들어 둔 INVITE 를 새 contact 로 |

Kamailio 설정 언어에는 기존 라우트에 코드를 끼워 넣는 수단이 없습니다
(`#!define` 은 배포판이 미리 만들어 둔 자리에만 통합니다). 즉 **착신을 하려면
설정을 소유해야 합니다.**

#### 오버라이드로 어디까지 되는가 — 전부 `kamailio -c` 로 확인함

| 기능 | 오버라이드로 | 근거 |
|---|---|---|
| WS handshake · `listen` · `/health` | ✅ | `WITH_JSONRPC` 가 꺼져 있어 자리가 빔 |
| WS 단말 alias/라우팅 (`WITH_NAT`) | ✅ | 배포판이 갖추고 define 으로만 막아 둠 |
| 미디어 릴레이 (`WITH_RTPENGINE`) | ✅ | 같음. `-c` 통과 확인 |
| **내부↔내부 통화에서 rtpengine 우회** | ✅ | **배포판이 이미 그렇게 함** (아래) |
| 모바일이 **평문 RTP** 일 때 미디어 | ✅ | 배포판의 기본 플래그로 충분 |
| 모바일이 **WebRTC** 일 때 브리징 | ❌ | 방향별 플래그 필요 (아래) |
| tsilo + 푸시 착신 | ❌ | 라우트 안에 코드가 들어가야 함 |

**내부↔내부는 자동으로 rtpengine 을 건너뜁니다.** `route[NATMANAGE]` 첫머리가
이렇습니다.

```
if (!(isflagset(FLT_NATS) || isbflagset(FLB_NATB))) return;
```

`FLT_NATS` 는 `route[NATDETECT]` 가 상대를 NAT 뒤로 판정했을 때만 섭니다. 같은 LAN
인터폰끼리는 서지 않으므로 미디어가 서버를 거치지 않고 직접 흐릅니다. 앞서
"내부↔내부는 rtpengine 을 거치지 않게 하라"고 적었는데, **이미 그렇게 되어 있습니다.**
따로 할 일이 없습니다.

**WebRTC 브리징은 방향별 플래그가 필요합니다.** 배포판은 이렇게 고정 호출합니다.

```
rtpengine_manage("replace-origin replace-session-connection");
```

WebRTC 쪽으로는 `RTP/SAVPF ICE=force DTLS=passive rtcp-mux-offer`,
SIP 쪽으로는 `RTP/AVP ICE=remove rtcp-mux-demux` 처럼 방향에 따라 달라져야 하는데,
`route[NATMANAGE]` 를 고칠 수 없으므로 오버라이드로는 안 됩니다.

> 비용이 추가되지는 않습니다. 착신(tsilo)이 어차피 설정 소유를 요구하므로,
> WebRTC 브리징은 같은 단계에 얹혀 갑니다.

#### 그래서 설정 소유는 3단계로 미룹니다

아래 "진행 순서" 기준입니다.

| 단계 | 범위 | 설정 |
|---|---|---|
| **1~2** | WS 전송 · 내부↔내부 통화 · 모바일 발신 · 미디어 | 오버라이드. **배포판 설정 그대로** |
| **3** | 내부 → 모바일 착신 (tsilo + FCM 푸시) | **설정 소유 필요** |

1~2단계는 위험이 낮고 되돌리기 쉽습니다 (파일 하나 지우면 끝). 먼저 여기까지
동작시켜 놓고, 착신을 붙일 때 설정을 소유하는 것이 낫습니다.

3단계에서 배포판 설정을 그대로 포크할 필요는 없습니다. 배포판 `kamailio.cfg` 는
presence·voicemail·PSTN·speeddial 같은 안 쓰는 기능까지 담아 1000행이 넘습니다.
이 배치에 필요한 것 — 레지스트라 · digest 인증 · WS · NAT · rtpengine · tsilo/푸시
— 만 담으면 훨씬 짧고 읽을 수 있는 설정이 됩니다. 그때는 이 디렉토리가 그 파일을
소유하고 `install.sh` 가 지금처럼 백업·검사·롤백하며 설치하면 됩니다.

### ①-1 `tcp_accept_no_cl=yes` — 빠뜨리면 조용히 실패한다

처음 `--enable` 했을 때 포트도 열리고 `systemctl` 도 `active` 이고 `kamailio -c` 도
통과했는데 **WS 가 전혀 동작하지 않았습니다.** 이 한 줄이 빠져서였습니다.

SIP over TCP 는 Content-Length 를 요구하지만 HTTP/1.1 은 본문이 없으면 그 헤더를
붙이지 않습니다. **WebSocket handshake 가 정확히 그 형태(본문 없는 GET)** 라,
Kamailio 의 TCP 리더가 본문을 기다리며 아무 응답도 하지 않습니다.

증상이 이렇게 갈렸습니다.

```
curl http://127.0.0.1:5080/health                          → 응답 없음 (000)
curl -H 'Content-Length: 0' http://127.0.0.1:5080/health   → 200 OK
```

겉으로 보이는 지표가 전부 정상이라 알아채기 어렵습니다. 그래서
`setup-websocket.sh` 가 설치 후 **실제 HTTP 응답과 WebSocket handshake 를 직접
확인**하도록 만들어 두었습니다. `-c` 통과나 `is-active` 만 믿으면 안 됩니다.

### ② TLS 를 누가 끊을 것인가

**(a) Nginx 가 끊고 Kamailio 는 평문 WS** ← 권장, `nginx-conf/service.ini` 가 이 전제

```
[단말] ──WSS──▶ [nginx :443 /sip/] ──ws──▶ [kamailio 127.0.0.1:5080]
```

- 인증서가 지금처럼 `nginx/cert/` 한 곳에만 있습니다
- `kamailio-tls-modules` 가 필요 없습니다
- `nginx-conf` 스키마의 `websocket = true` 를 그대로 씁니다

주의할 점 셋:

1. **`timeout` 을 크게.** nginx 기본 60초면 유휴 WS 가 끊깁니다.
   `service.ini` 에 `timeout = 3600` 을 넣어 두었습니다.
2. **Kamailio 가 보는 소스 IP 가 항상 `127.0.0.1`** 입니다. IP 기반 ACL 은
   무의미해집니다. 다만 라우팅은 문제없습니다 — WS 연결 자체가 transport 라
   응답과 착신이 같은 연결로 되돌아갑니다.
3. nginx 가 `Upgrade` / `Connection` 헤더를 그대로 넘겨야 합니다.

**(b) Kamailio 가 직접 WSS** — `kamailio-tls-modules` 설치, 전용 포트.

**(a) 로 확정합니다.** 서버가 NAT 내부라는 것이 결정적입니다 — `28443 → 443` 포워딩이
이미 있으므로 (a) 는 **공유기 설정을 건드리지 않고** 모바일을 받을 수 있습니다.
(b) 는 SIP 전용 포트를 새로 열어야 하고, 인증서 관리 지점도 둘로 늘어납니다.
얻는 것(진짜 클라이언트 IP)은 이 배치에서 쓸 데가 없습니다 — 인증은 digest 로
하고, WS 는 연결 자체가 transport 라 IP 기반 라우팅이 필요 없습니다.

### ③ `/health` 를 어떻게 낼 것인가

이 프로젝트는 모든 서비스가 `/health` 를 같은 형식으로 내도록 정해 두었습니다
([health-contract.md](../../../docs/health-contract.md)). Kamailio 는 HTTP 서비스가
아니라 기본 제공하지 않습니다.

**`kamailio-websocket.cfg` 에 이미 넣어 두었습니다.** ①이 해결되면서 같은
`event_route[xhttp:request]` 안에서 처리할 수 있게 됐습니다.

```
if ($hu =~ "^/health") {
    xhttp_reply("200", "OK", "application/json",
        '{"service":"kamailio","status":"ok"}');
    exit;
}
```

Kamailio 설정 언어로는 uptime 이나 메모리 같은 값을 얻기 번거로워 최소 필드만
냅니다. 규약이 요구하는 `service` 와 `status` 는 채웁니다 — 더 필요하면
`$stat(...)` 로 늘릴 수 있습니다.

`--enable` 전까지는 `nginx-conf/service.ini` 가 `enabled = false` 이므로
대시보드에 비정상으로 뜨지 않습니다.

### ④⑤ 착신 푸시 — **별도 문서로 옮김**

인터폰 → 모바일 착신에서 자는 단말을 깨우는 흐름은
**[incoming-call.md](incoming-call.md)** 에 따로 정리했습니다.

요약하면:

| 조각 | 상태 |
|---|---|
| `POST /sip-push` (rtc-relay-server, 루프백 전용) | ✅ 구현·검증 완료 |
| `rtc_mobiles.sip_user` 컬럼 (SIP 사용자명 ↔ FCM 토큰) | ✅ 스키마 작성 (`002-sip-user.sql`) |
| Kamailio 의 `ts_store` / `ts_append` / 푸시 호출 | ⬜ 설정 소유 필요 |

> **정정.** 앞서 "`http_async_client` 는 저장소에 패키지가 없어 소스 빌드가
> 필요하다" 고 적었는데 **잘못이었습니다.** `kamailio-extra-modules` 에
> `http_async_client` · `evapi` · `jansson` 이 함께 들어 있습니다. apt 로 됩니다.
> 동기인 `http_client` 로 워커를 막을 이유가 없습니다.

### ⑥ 미디어 — rtpengine 조달과 설정

미디어 경로와 rtpengine 의 NAT 설정은 위 **"무엇을 만들려는가"** 에 정리했습니다.
여기서는 남은 조달·결정 항목만 적습니다.

**rtpengine 데몬이 배포판 저장소에 없습니다.** sipwise 저장소를 추가하거나 소스
빌드해야 합니다. (Kamailio 쪽 `rtpengine.so` 모듈은 이미 있습니다) 이것이 이
계획에서 가장 큰 조달 항목입니다.

정할 것:

- **음성은 확정.** 인터폰이 PCMU/PCMA 이고 WebRTC 는 G.711 이 필수라 겹칩니다.
  트랜스코딩 없이 릴레이만 하면 되므로 rtpengine 을 코덱 지원으로 빌드할 필요도
  없습니다.
- **영상은 확인이 필요합니다.** rtpengine 이 영상을 트랜스코딩하지 않으므로
  H.264 파라미터가 양끝에서 맞아야 합니다. 위 "코덱" 절의 `sngrep` 절차로
  인터폰의 실제 SDP 를 먼저 뜨세요.
- **내부↔내부 통화는 rtpengine 을 거치지 않게.** 같은 LAN 이라 직접 RTP 가
  가능하고, 서버를 거치면 대역폭과 지연만 늘어납니다. Kamailio 설정에서
  통화 상대에 따라 `rtpengine_manage()` 호출 여부를 가르면 됩니다.
- **공인 IP 추적.** 위 "rtpengine 과 NAT" 참고. 가정용 회선이면 필수입니다.

모바일이 WebRTC 를 쓰게 될 경우에만 추가로 걸리는 것:

- **Trickle ICE 는 안 됩니다.** SIP 는 SDP 를 한 번에 보내므로 단말이 ICE 후보
  수집을 끝낸 뒤 SDP 를 만들어야 합니다. 착신 지연에 그만큼 더해집니다.
- **STUN/TURN 은 불필요합니다.** rtpengine 이 공인 주소를 광고하고 ICE-lite 로
  동작하면 단말은 그쪽으로만 붙으면 됩니다.

---

## 착신 전체 흐름 (목표 상태)

```
 1. INVITE(1001) ────────────────────────────▶ Kamailio
 2. Kamailio ── 100 Trying ──▶ 발신측         ← 500ms 안에. 재전송 타이머 정지
 3. WS 연결 없음 확인 → ts_store()             ← 트랜잭션을 붙들어 둔다
 4. Kamailio ──HTTP──▶ rtc-relay-server /sip-push
 5.                     rtc-relay ──FCM──▶ 단말 기동
 6. 단말 ──WSS──▶ Kamailio : REGISTER
 7. REGISTER 라우트: save() 후 ts_append()     ← 붙들어 둔 INVITE 를 새 contact 로 분기
 8. rtpengine_manage() — SDP 를 WebRTC 용으로 재작성
      (RTP/SAVPF · DTLS fingerprint · ICE candidate · rtcp-mux · bundle)
 9. 단말: INVITE 수신 → RTCPeerConnection → setRemoteDescription(offer)
10. 단말 ── 180 Ringing ──▶                    ← 여기서 비로소 벨이 울린다
11. 수락 → createAnswer → 200 OK 에 WebRTC SDP answer
12. rtpengine_manage() 다시 — 응답 SDP 를 평문 RTP/AVP 로 되돌려 발신측에 전달
13. ICE 연결성 검사(단말 ↔ rtpengine) → DTLS 핸드셰이크 → SRTP 키 합의
14. 음성:  단말 ──SRTP──▶ rtpengine ──RTP──▶ 발신측
```

2번과 10번 사이가 FCM 지연 구간입니다. 현실적으로 2~8초이고 그동안 발신자는
무음이므로, 보통 `183 Session Progress` 로 링백을 흘립니다.

**2번이 중요합니다.** `100 Trying` 을 500ms 안에 보내지 않으면 발신측이 T1(500ms)
부터 배수로 INVITE 를 재전송하고 32초(Timer B)에 포기합니다. 그 뒤로는 프록시
Timer C(최소 3분)라 프로토콜상 여유가 충분합니다.

## 진행 순서

각 단계가 끝나면 `./setup-websocket.sh` 로 상태를 확인할 수 있습니다.

### 1단계 — WS 전송 · 내부 통화 · 모바일 발신 (배포판 설정 그대로)

| | 단계 | 상태 |
|---|---|---|
| 1-1 | `sudo ./setup-websocket.sh --install` | ✅ **완료** (2026-08-19) |
| 1-2 | `sudo ./install.sh --apply` | ✅ **완료** |
| 1-3 | `sudo ./setup-websocket.sh --enable` | ✅ **완료** — handshake 101 확인 |
| 1-4 | `nginx-conf/service.ini` → `enabled = true` 후 반영 | ✅ **완료** — nginx 경유 handshake 101 확인 |
| 1-5 | 모바일이 `wss://<공인IP>:28443/sip/` 로 REGISTER | ⬜ |
| 1-6 | 인터폰끼리 통화 | ⬜ 미디어 직접 RTP. rtpengine 불필요 |

**1-3 까지의 검증 결과** (`./setup-websocket.sh`):

```
[ok]   WS 설정 설치됨: /etc/kamailio/kamailio-websocket.cfg
[ok]   HTTP 응답 확인: /health → 200 (Content-Length 없는 GET 처리됨)
[ok]   WebSocket handshake 확인: 101 Switching Protocols (서브프로토콜 sip)
```

서브프로토콜 없이 붙으면 `400` 이 옵니다 — RFC 7118 이 `sip` 을 요구하므로 정상입니다.

**nginx 경유 확인** (1-4 이후). `--http1.1` 이 **반드시** 있어야 합니다.

```bash
curl -sik -m 5 --http1.1 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Sec-WebSocket-Protocol: sip" \
  https://127.0.0.1/sip/ | head -4
```

`--http1.1` 을 빼면 curl 이 ALPN 으로 HTTP/2 를 고르고 **nginx 가 400 을 냅니다.**
HTTP/2 는 `Connection`·`Upgrade` 헤더를 금지하기 때문입니다 (nginx 는 `listen 443
ssl http2`). 설정 문제가 아니라 시험 방법 문제이므로 헷갈리지 마세요.

실제 클라이언트는 영향받지 않습니다 — 브라우저 WebSocket API 도 Android 의
OkHttp 계열도 WS 업그레이드에는 HTTP/1.1 을 씁니다. nginx 가 RFC 8441 Extended
CONNECT 를 지원하지 않으므로 h2 로 WS 를 시도하는 클라이언트도 없습니다.

여기까지는 **rtpengine 없이** 됩니다. 내부↔내부 통화와 모바일 발신 시그널링이
동작하는 것을 먼저 확인하는 것이 목적입니다.

### 2단계 — 모바일과의 미디어

| | 단계 | 비고 |
|---|---|---|
| 2-0 | **인터폰 SDP 확인** (`sngrep`) — H.264 `fmtp` | sudo 만 있으면 지금 가능. 아래 결과에 따라 설계가 갈림 |
| 2-1 | rtpengine 조달 (sipwise 저장소 또는 소스 빌드) | 가장 큰 조달 항목 |
| 2-2 | `interface = 192.168.0.252!<공인IP>`, 포트 범위 지정 | 빠뜨리면 무음 |
| 2-3 | 공유기에 `30000-30500/udp` 포워딩 | |
| 2-4 | Kamailio 설정에 `WITH_RTPENGINE` + 내부↔내부 예외 | |
| 2-5 | 모바일 ↔ 내부 통화에 소리가 나는지 | |

### 3단계 — 내부 → 모바일 착신 (설정 소유)

| | 단계 | 비고 |
|---|---|---|
| 3-1 | 이 배치 전용 `kamailio.cfg` 작성 | 배포판 포크 아님. 필요한 것만 |
| 3-2 | `route[LOCATION]` 에 `ts_store()` + 푸시 요청 | |
| 3-3 | `route[REGISTRAR]` 에 `ts_append()` | |
| 3-4 | rtc-relay-server 에 `POST /sip-push` 추가 (④) | FCM 은 이미 있음 |
| 3-5 | SIP 사용자 ↔ FCM 토큰 매핑 (⑤) | `rtc_mobiles` 스키마 변경 |
| 3-6 | `100 Trying` / `183` 타이밍 확인 | 아래 "착신 전체 흐름" |

### 4단계 — 정리

| | 단계 | 비고 |
|---|---|---|
| 4-1 | `ws-bridge` 를 SIP 경로에서 제거 | 역할이 끝남 |
| 4-2 | `services/ws-bridge/kamailio/` 삭제 | 이미 이 디렉토리로 옮김 |
