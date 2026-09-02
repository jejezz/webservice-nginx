# 모바일 단말을 무엇으로 붙일 것인가 — 확인한 것과 정한 것

2026-08-19 하루치 조사·작업 기록입니다. `websocket-plan.md` 가 세운 계획을 실제
단말(PJSIP 안드로이드 앱)에 대 보면서 드러난 것들이고, 몇 가지는 그 문서의 전제를
뒤집습니다.

관련: [websocket-plan.md](websocket-plan.md) · [incoming-call.md](incoming-call.md) ·
[alternatives.md](alternatives.md)

## 요약

| | 결과 |
|---|---|
| PJSIP 은 WSS 로 붙을 수 있는가 | **아니오.** WebSocket 전송 자체가 없음 |
| 그래서 무엇을 했나 | SIP over TLS 입구(5061)를 열었다. **동작 확인 완료** |
| Kamailio 가 TLS 를 끊는가 | **아니오.** 5.5.4+OpenSSL3 이 깨진다. nginx stream 이 끊는다 |
| 착신 문제는 풀렸나 | **아니오.** 전송만 풀렸다. FCM(3단계)은 그대로 남아 있다 |
| 지금 검토 중 | **WebRTC-to-SIP 게이트웨이 (Janus)** — `alternatives.md` 가 예약해 둔 결정 시점 |

---

## 1. PJSIP 에는 WebSocket 전송이 없다

`websocket-plan.md` 는 모바일이 `wss://…:28443/sip/` 로 붙는 것을 전제합니다.
**PJSIP 기반 앱에는 그 전제가 성립하지 않습니다.**

```
pjsip_transport_type_e:  UDP / TCP / TLS / DTLS / SCTP / LOOP     ← WS 없음
libpjsua2.so 안의 "websocket" 문자열:  0건
```

`Endpoint` 에 SIP 메시지를 밖에서 밀어 넣는 API 도 없습니다 (`transportCreate`
계열뿐이고 `SipRxData` 는 읽기 전용). 즉 릴레이가 받은 SIP 을 PJSIP 에 건네줄
방법이 없고, **PJSIP 이 통화에 참여하려면 진짜 소켓으로 받아야** 합니다.

## 2. 그래서 SIP over TLS 입구를 열었다 (완료)

```
[단말] ──TLS 5061──▶ [nginx stream] ──평문 TCP──▶ [kamailio 127.0.0.1:5060]
```

- `nginx-sip-tls.conf` · `setup-tls.sh` 가 소유. `sudo ./setup-tls.sh --check`
- Kamailio 설정은 **한 줄도 바뀌지 않았습니다**
- 인증서 사본 불필요 — nginx master 가 root 라 nginx 쪽 원본을 그대로 읽습니다
- 검증: TLSv1.3 핸드셰이크 + 인증서 검증 통과 + **SIP OPTIONS 에 `200 Keepalive` 응답**

WS 경로(5080)는 그대로 살아 있습니다. 둘은 독립된 입구입니다.

### Kamailio 가 직접 TLS 를 끊지 못하는 이유

5.5.4 의 tls 모듈은 `CRYPTO_set_mem_functions()` 로 OpenSSL 의 할당자를 Kamailio
것으로 바꾸는데, 이 배포판의 OpenSSL 3.0.2 와는 그것이 성립하지 않아 **기동 중에
힙이 깨집니다.**

```
CRITICAL: qm_debug_check_frag(): BUG: qm: fragm. end overwritten (0, 0)!
Memory allocator was called from tls: tls_init.c:323
```

`kamailio -c` 는 통과하고 리스너까지 정상으로 잡힙니다 — 재시작하는 순간에야
드러납니다. 5.5.4 에 우회할 모듈 파라미터가 없습니다. Kamailio 5.6 부터
해결됩니다.

`kamailio-tls.cfg` 를 그때를 위해 남겨 두었습니다 (머리말에 ⛔ 표시). 거기 적어 둔
두 가지는 5.6+ 에서도 유효합니다 — `WITH_TLS` 대신 오버라이드에서 `tls.so` 를
직접 로드해야 하고(배포판 379행보다 앞선 **318행의 `http_client.so`** 가 OpenSSL 을
먼저 초기화합니다), `enable_tls=yes` 는 `loadmodule` 앞에 있어야 합니다.

## 3. 문서와 실제가 달랐던 것

**미디어는 이미 서버를 경유하고 있습니다.** `websocket-plan.md` 는 rtpengine 이
없다고 적었지만, **`rtpproxy` 가 이미 돌면서 릴레이하고 있습니다.**

```
앱 SDP:              c=IN IP4 192.168.0.67   m=audio 4016
Kamailio 가 넘긴 것:  c=IN IP4 192.168.0.252  m=audio 53142   ← 재작성됨
200 OK:              a=nortpproxy:yes
Record-Route:        <sip:192.168.0.252;lr;nat=yes>            ← WITH_NAT 도 이미 켜짐
```

⚠️ 다만 rtpproxy 는 `-m 10100 -m 10200` 으로 떠 있는데 **실제 할당 포트가 범위
밖**입니다 (관측: 53142 · 26618 · 25604). 포워딩 규칙을 정하려면 실제 범위를 먼저
확인해야 합니다.

**H.264 는 위험이 낮습니다.** 캡처한 통화에서 양끝이 같은 값이었습니다.

```
a=fmtp:99 profile-level-id=42e01e; packetization-mode=1     (양쪽 동일)
```

단, 그 캡처의 상대(192.168.0.2)도 pjsip(`s=pjmedia`, `;ob`)이었습니다. **진짜
인터폰 장비인지 확인이 필요합니다.**

## 4. 착신 문제는 그대로 남아 있다

TLS 는 **전송**을 풀었을 뿐입니다. WebSocket 이었어도 같았습니다 — WS 도 TCP 라
Doze 가 똑같이 끊습니다.

- 앱은 등록 주기를 설정하지 않아 pjsua2 기본값 **300초**를 씁니다
- Doze 가 그 타이머를 미루면 등록이 만료되고 착신이 성립하지 않습니다
- 포그라운드 서비스로 유지할 수 있지만, 앱이 죽으면 끝입니다

**결국 FCM 이 필요합니다.** 서버 쪽은 이미 준비돼 있습니다 — `tsilo` · `http_client`
설치됨, `kamailio.cfg` 포크에 훅 있음, `websocket-relay` 의 `POST /sip-push` 구현·검증
완료. **비어 있는 것은 앱 쪽뿐입니다.**

> 이 Kamailio 의 `registrar` 에는 RFC 8599(`pn-provider`/`pn-prid`) 지원이 없습니다
> (`outbound_mode` 만 있음). 그래서 `sip_user` ↔ FCM 토큰 DB 매핑을 씁니다.

## 5. 지금 검토 중 — WebRTC-to-SIP 게이트웨이

`alternatives.md` 가 "**rtpengine 작업을 시작하기 직전**이 그 자리" 라고 예약해 둔
결정 시점에 도달했습니다.

동기: 모바일에서는 WebRTC 가 시그널링·미디어 양쪽에서 더 자동적이고, LAN 쪽은
legacy SIP 호환만 되면 됩니다.

### ⚠️ 바로잡아야 할 전제

`websocket-plan.md` 는 "모바일 앱에 이미 WebRTC 스택이 있습니다" 라고 적었는데,
그것은 **`websocket-relay` 쪽 앱**입니다. **`android-pjsip-phone` 에는 WebRTC 가
없습니다** (PJSIP 전용). 이 방향을 택하면 이 앱은 vehicle 이 아니며, 방·FCM·인증서
신뢰가 이미 있는 websocket-relay 쪽 앱을 확장하는 편이 짧습니다.

### 후보

| | 앱이 SIP 을 아는가 | 미디어 | Kamailio |
|---|---|---|---|
| Kamailio + rtpengine (현재) | 안다 (SIP over WSS) | rtpengine 조달 필요 | 유지 |
| **Janus + SIP 플러그인** | **모른다** (JSON API) | Janus 가 브리징 | **유지** |
| FreeSWITCH + mod_verto | 모른다 (JSON-RPC) | 내장·트랜스코딩 | 대체 |
| Asterisk + ARI | 경우에 따라 | 내장 (`webrtc=yes`) | 대체 |

Janus SIP 플러그인은 "registers at the SIP server and **acts as a SIP client on
behalf of the web peer**" 로, 구상했던 등록대행 Agent 와 같은 모델입니다.
브라우저 클라이언트 `janus.js` 와 SIP 데모(`html/siptest.html`)가 함께 옵니다 —
**Android 클라이언트는 직접 만들어야 합니다.**

**Janus 를 권하는 이유는 하나입니다 — Kamailio 를 갈아엎지 않아도 됩니다.**
계정·인증·LAN 통화·대시보드·tsilo·TLS 입구가 전부 살아 있고 그 앞에 SIP UA 하나로
붙습니다. FreeSWITCH·Asterisk 는 `alternatives.md` 가 적어 둔 전환 비용을 그대로
치릅니다.

⚠️ **Janus 는 GPL-3.0** 입니다. 내부 시스템에는 문제없지만 제품 배포·납품 계획이
있으면 미리 확인하세요. (FreeSWITCH 는 MPL 1.1, Asterisk 는 GPLv2 + 상용 선택 가능)

### 다음 확인 (앱을 건드리지 않고 되는 구간)

1. Janus 설치 + Kamailio 에 내선 하나 등록 — **조달 가능성부터 확인** (배포판 저장소에 없을 것)
2. `siptest.html` 로 브라우저 → 인터폰 통화
   - **여기서 H.264 협상이 드러납니다.** 가장 큰 위험 요소
   - Android WebRTC 의 H.264 는 단말 MediaCodec 에 의존 — 없는 단말은 VP8 만 제시
3. 되면 Android 클라이언트 (websocket-relay 앱 확장)

## 6. 앱 쪽 변경 (Mac 저장소에 적용됨)

`android-pjsip-phone` 을 `0554973` 기준으로 고쳐 Mac(`/Users/jejezz/StudioProjects/`)에
적용했습니다. 파일 15개 (신규 6 · 수정 9).

- `SipTransportMode` / `SipTransportOptions` / `SipServerConfig` (신규) —
  **서버 호스트와 SIP 도메인을 분리.** 전자는 인증서와 대조하는 이름
  (지금은 `c-a3f19c04.rtc.zoomon.art` — 예전 `jejezzhome.iptime.org` 는 삭제됨),
  후자는 digest realm (`pluto.org`)
- `SipUserAgent` — 전송 생성 통합, `TlsConfig`(CA·검증·TLS1.2+1.3), 실패 사유 노출
- `SipPreferences` (신규) — 설정 읽기 단일화 + CA 를 `res/raw` 에서 `files/` 로 스테이징
- 설정 화면에 **전송 방식** 추가, 발신 URI 를 도메인 기반으로
- `setTextCount(0)` — 쓰지 않는 T.140 스트림 제거 (릴레이 포트 한 쌍 절약)

**지금 `.so` 에는 TLS 가 없습니다** (`--disable-ssl` 로 빌드됨). TLS 를 고르면
"전송을 열지 못했습니다" 다이얼로그가 뜨는 것이 정상입니다. UDP 로 두면 기존 LAN
동작은 그대로여야 하며, **이 회귀 확인이 아직 안 됐습니다.**

Janus 방향으로 가면 이 변경은 필수 경로에서 빠지고 pjsip 재빌드도 불필요해집니다.
`tls 5061` 입구는 SIP 단말용으로 계속 유효합니다.

---

## 7. 결론 (2026-08-21) — Janus 로 가고, TLS 는 걷어냈습니다

이 문서가 "지금 검토 중" 으로 남겨 둔 항목의 답입니다.

**Janus WebRTC ↔ SIP 게이트웨이가 실제로 동작합니다.** 브라우저 ↔ 브라우저,
브라우저 ↔ 평문 G.711 단말, 브라우저 ↔ 실단말(음성)까지 확인됐습니다. 자세한
결과는 [../../janus/docs/plan.md](../../janus/docs/plan.md) 의 5~7단계에 있습니다.

**모바일도 WebRTC 로 가기로 정했습니다.** 그러면 이 문서 1절의 전제 — *PJSIP 에
WebSocket 전송이 없다* — 가 무의미해집니다. 앱이 PJSIP 을 쓰지 않게 되기 때문입니다.

### 그래서 SIP over TLS 를 걷어냈습니다

| 구간 | 무엇이 지나가는가 | 암호화 |
|---|---|---|
| 외부 → nginx `28443→443` | 시그널링 (HTTPS/WSS) | ✅ TLS 1.3 |
| 외부 ↔ Janus `20000-20200` | 미디어 | ✅ DTLS-SRTP (실측 확인) |
| Janus ↔ Kamailio ↔ rtpproxy ↔ 단말 | SIP · RTP 평문 | LAN 안에서만 |

**인터넷을 건너는 구간은 이미 전부 암호화돼 있습니다.** 평문으로 남는 곳은
모두 LAN 안이므로, SIP 를 따로 TLS 로 감쌀 자리가 없습니다.

지운 것 — `kamailio-tls.cfg` · `nginx-sip-tls.conf` · `setup-tls.sh`,
그리고 `kamailio-local.cfg` 의 `import_file` 한 줄.

되살리려면 바로 앞 커밋을 보세요 (*"진행 중이던 SIP over TLS 작업을 그대로
커밋한다 — 걷어내기 전에"*). 6절의 앱 변경(TLS 전송)도 필수 경로에서 빠집니다.

### 이 전제가 유지되는 조건

**외부에서 들어오는 클라이언트가 전부 WebRTC 여야 합니다.** 네이티브 SIP 단말을
인터넷에서 직접 받기로 하면 그때는 다시 필요해집니다 — 그 경우 SIP digest 응답과
RTP 가 평문으로 인터넷을 건너기 때문입니다.

⚠️ 그래서 공유기에서 **5060/UDP · 5061/TCP 가 포워딩되어 있지 않아야** 합니다.
Kamailio 의 5060 은 `0.0.0.0` 에 바인딩돼 있어, 포워딩만 열리면 바로 인터넷에서
닿습니다.

### 남은 갈림길 하나 — 모바일이 WebRTC 로 **어디에** 붙는가

| | 붙는 곳 | 필요한 것 |
|---|---|---|
| ① Janus | `/janus-api` (브라우저와 같은 길) | 없음 — 이미 동작 |
| ② Kamailio WS | `/sip/` (SIP over WebSocket) | **rtpengine** (미설치) |

**✅ ①로 정했습니다 (2026-08-21).** `/sip/` 라우트와 rtpengine 이 둘 다 필요
없어집니다. 지금까지 검증된 것도 ①쪽입니다.

그래서 SIP 는 **서버 안쪽의 신호 언어**로만 남습니다. 밖에서 SIP 로 들어오는
길은 두지 않습니다.

```
브라우저 ─WSS/DTLS-SRTP─▶ Janus ─평문 SIP/RTP─▶ Kamailio ─▶ LAN SIP 단말
모바일   ─WSS/DTLS-SRTP─▶ Janus ─┘
```

`websocket-plan.md` 는 채택되지 않은 계획이 되었습니다 — 그 문서 머리에 적어
두었습니다. 1단계에서 확인한 사실들은 그대로 유효하므로 지우지 않습니다.
