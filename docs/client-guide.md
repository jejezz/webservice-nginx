# 클라이언트 만들기 — 모바일이 인터폰과 통화하기까지

Flutter·안드로이드·브라우저 등 **WebRTC 클라이언트를 만드는 사람**을 위한
문서입니다. 서버는 다 서 있고, 앱이 무엇을 어떤 순서로 하면 되는지만 적습니다.

관련: [../services/janus/docs/plan.md](../services/janus/docs/plan.md) ·
[../services/kamailio/docs/incoming-call.md](../services/kamailio/docs/incoming-call.md) ·
[../services/kamailio/docs/mobile-transport.md](../services/kamailio/docs/mobile-transport.md)

## 먼저 버려야 할 오해 다섯

여기서 길을 잃기 쉽습니다. **엉뚱한 방향은 대개 이 다섯 중 하나입니다.**

| 오해 | 사실 |
|---|---|
| 앱에 SIP 스택(PJSIP 등)이 필요하다 | **아닙니다.** 앱은 SIP 를 한 글자도 말하지 않습니다. Janus 가 앱을 대신해 SIP 를 씁니다 |
| VideoRoom(방)을 써야 한다 | **아닙니다.** 인터폰 통화는 `janus.plugin.sip` 의 1:1 통화입니다. 방 개념이 없습니다 |
| `wss://…/janus-api` 로 붙는다 | `/janus-api` 는 **REST 입구**입니다. WebSocket 은 `wss://…/janus-ws` |
| offer 만 보내면 통화가 걸린다 | 그 전에 **세션 · 핸들 · SIP 등록**이 있습니다. 등록이 끝나기 전 `call` 은 실패합니다 |
| 코덱은 opus 로 맞추면 된다 | 인터폰은 **G.711 만** 합니다. Janus 는 트랜스코딩하지 않습니다 — offer 에 PCMU/PCMA 가 남아 있어야 소리가 납니다 |

## 전체 그림

```
 [모바일 앱]                    [서버]                          [LAN]
      │                                                          
      │ ①  wss://<서버>/janus-ws        ┌──────────┐            
      ├────────────────────────────────▶│  Janus   │            
      │    시그널링 (JSON)               │ SIP 플러그인│            
      │                                 └────┬─────┘            
      │ ②  미디어 (DTLS-SRTP)                │ 평문 SIP/RTP       
      ╞═════════════════════════════════════▶│                   
      │                                 ┌────┴─────┐   ┌────────┐
      │                                 │ Kamailio ├──▶│ 인터폰  │
      │                                 └──────────┘   └────────┘
      │
      │ ③  https://<서버>/iot/register  (FCM 토큰 · sip_user 등록)
      └────────────────────────────────▶ websocket-relay ──▶ FCM
```

- ①②는 앱이 **Janus 하나**만 상대하면 됩니다. Kamailio·인터폰은 서버 안쪽 이야기입니다.
- ③은 **착신(인터폰 → 모바일)** 을 받기 위한 등록입니다. 발신만 할 거라면 없어도 됩니다.
- 인터넷을 건너는 구간은 시그널링(WSS)도 미디어(DTLS-SRTP)도 전부 암호화돼 있습니다.
  평문 SIP/RTP 는 서버와 LAN 안에만 있습니다.

## 필요한 것 셋

| | 값 | 어디서 |
|---|---|---|
| 시그널링 주소 | `wss://<서버>/janus-ws` | Janus 대시보드 **개요 → 접속 주소** 에서 복사 |
| API 비밀 | `apisecret` | Janus 대시보드 **개요 → 시그널링 API 비밀 → 보기** (로그인 비밀번호를 한 번 더 묻습니다). 서버에서는 `services/janus/secrets/api-secret` |
| SIP 계정 | 내선 번호 + 비밀번호 | 사람이 만듭니다 — `services/kamailio/accounts.md` |

도메인과 프록시는 이 서버에서 이렇게 정해져 있습니다.

```
SIP 도메인   pluto.org
SIP 프록시   sip:192.168.0.252:5060
```

## 발신 — 앱에서 인터폰으로

WebSocket 하나에 JSON 을 주고받습니다. **모든 요청에 `transaction`(임의 문자열)과
`apisecret` 이 들어갑니다.** 응답·이벤트는 같은 소켓으로 옵니다.

### 0. 연결

```
wss://<서버>/janus-ws          서브프로토콜: janus-protocol   ← 필수
```

서브프로토콜을 빠뜨리면 Janus 가 연결을 끊고 nginx 는 **502** 를 냅니다.

**응답을 기다렸다가 다음 것을 보내세요.** `create`·`attach`·`message` 를 한꺼번에
쏘면 뒤엣것들은 `session_id`/`handle_id` 가 비어 있어 `457 Unhandled request` 로
떨어집니다. `transaction` 값으로 응답을 짝지어 두면 그대로 순서가 됩니다.

### 1. 세션 만들기

```json
{"janus":"create","transaction":"t1","apisecret":"…"}
→ {"janus":"success","data":{"id":123456789}}          // session_id
```

### 2. SIP 플러그인 붙이기

```json
{"janus":"attach","session_id":S,"plugin":"janus.plugin.sip",
 "transaction":"t2","apisecret":"…"}
→ {"janus":"success","data":{"id":987654321}}          // handle_id
```

### 3. SIP 등록 — **`call` 보다 먼저**

```json
{"janus":"message","session_id":S,"handle_id":H,"transaction":"t3","apisecret":"…",
 "body":{
   "request":"register",
   "username":"sip:1001@pluto.org",
   "authuser":"1001",
   "display_name":"1001",
   "secret":"<계정 비밀번호>",
   "proxy":"sip:192.168.0.252:5060",
   "outbound_proxy":"sip:192.168.0.252:5060"
 }}
→ event: plugindata.data.result.event = "registered"
```

⚠️ **`outbound_proxy` 를 빠뜨리지 마세요.** `proxy` 는 REGISTER 를 보낼 곳일
뿐이고, INVITE 의 목적지는 요청 URI 의 도메인으로 정해집니다. `pluto.org` 는
**실재하는 공인 도메인**이라 그대로 두면 DNS 로 풀려 INVITE 가 인터넷으로
나갑니다. Kamailio 는 그것을 아예 보지 못하고 — 로그도 응답도 없습니다. 이
저장소의 시험 하니스가 실제로 여기 걸렸습니다
([test-bridge-in.html:175](../services/janus/test-harness/test-bridge-in.html)).

### 4. 발신

로컬 PeerConnection 을 만들고 offer 를 실어 보냅니다.

```json
{"janus":"message","session_id":S,"handle_id":H,"transaction":"t4","apisecret":"…",
 "body":{"request":"call","uri":"sip:0101080501@pluto.org"},
 "jsep":{"type":"offer","sdp":"…"}}
→ event: result.event = "progress"  (180/183)
→ event: result.event = "accepted" + jsep answer   ← setRemoteDescription
```

### 5. 그동안 계속 할 것

```json
{"janus":"trickle","session_id":S,"handle_id":H,"candidate":{…},"transaction":"t5"}
{"janus":"keepalive","session_id":S,"transaction":"t6"}     // 30초마다
```

**세션 타임아웃이 60초**입니다. keepalive 를 멈추면 통화 중에 세션이 사라집니다.

### 6. 끊기

```json
{"janus":"message","session_id":S,"handle_id":H,"transaction":"t7","apisecret":"…",
 "body":{"request":"hangup"}}
```

## 착신 — 인터폰에서 앱으로

앱이 자고 있어도 벨이 울려야 합니다. 그래서 한 단계가 더 있습니다.

```
① 인터폰 ──INVITE──▶ Kamailio        (모바일은 등록돼 있지 않다)
② Kamailio 가 INVITE 를 붙들어 둔다   ts_store · 최대 60초 (wt_timer)
③ Kamailio ──/sip-push──▶ websocket-relay ──FCM──▶ 앱을 깨운다
④ 앱이 깨어나 Janus 에 붙고 register  ← 위 3번과 똑같다
⑤ 등록되는 순간 Kamailio 가 붙들어 둔 INVITE 를 그 연결로 흘려보낸다 (ts_append)
⑥ 앱에 incomingcall 이벤트 + jsep offer 가 온다
⑦ 앱이 answer 를 만들어 accept
```

### 앱이 미리 해 둘 일 — FCM 토큰과 내선 연결

이걸 하지 않으면 ③에서 **깨울 단말을 찾지 못합니다.** 지금 이 서버에 연결된
단말이 0대인 이유가 이것입니다.

```
POST https://<서버>/iot/register/mobile
{
  "uuid": "<단말 고유 id>",
  "email": "…", "complex": "…", "address": "…",
  "token": "<FCM 토큰>",
  "sip_user": "1001"          ← 이 줄이 SIP 내선과 이어 준다
}
```

- `sip_user` 는 **Kamailio 에 만든 내선과 같아야** 합니다. 다르면 푸시는 나가는데
  통화는 안 되는 상태가 됩니다.
- 안 보내면 **기존 값을 건드리지 않습니다**(빈 문자열을 보내면 연결이 끊깁니다).
- 쓸 수 있는 문자는 `A-Z a-z 0-9 . _ -` 64자까지입니다.

> ⚠️ **이 필드는 없어집니다.** 번호를 앱이 정하지 않고 **서버가 승인 시점에
> 배정합니다** — 규격과 이유는 [identity.md](identity.md) 에 있습니다.
> 서버 쪽은 이미 그렇게 동작하고, 아래 `sip` 를 쓰면 이 필드를 보내지 않아도
> 됩니다. 보내던 앱도 그대로 둡니다.

승인된 단말이 다시 등록하면 응답에 **내선 자격**이 실려 옵니다. 앱을 고칠 때
필요한 것은 [client-migration.md](client-migration.md) 에 모아 두었습니다. 이 값으로 Janus
에 등록하세요(위 3번의 `username`·`authuser`·`secret`).

```jsonc
{ "result": "success", "status": "approved",
  "sip": { "user": "0101080501", "domain": "pluto.org", "password": "…" } }
```

- `username` 은 `sip:<user>@<domain>`, `authuser` 는 `<user>`, `secret` 은 `password` 입니다.
- `sip` 가 없으면 아직 번호가 배정되지 않은 단말입니다. 예전처럼 동작합니다.
- 비밀번호는 **바뀔 수 있습니다.** 등록에 실패하면 `/register/mobile` 을 한 번
  더 불러 새 값을 받으세요.

경로 끝의 **`/mobile` 을 빠뜨리지 마세요** — `/iot/register` 는 404 입니다.
빈 본문으로 한 번 찔러 보면 붙었는지 바로 압니다.

```bash
curl -k -X POST -H 'Content-Type: application/json' -d '{}' \
  https://<서버>/iot/register/mobile
# → 400 {"error":"uuid, email, complex, address, token 은 필수입니다."}   ← 이러면 정상
```

### 깨어난 뒤 받는 FCM 데이터

```json
{ "method": "sip-incoming", "aor": "1001", "caller": "…", "callId": "…" }
```

`method` 가 `sip-incoming` 이면 **60초 안에** Janus 에 붙어 `register` 까지
마쳐야 합니다(②의 `wt_timer`). FCM 왕복이 보통 2~8초이니 여유는 있지만, 앱이
콜드 스타트에서 로그인·설정을 다 하고 나서야 등록한다면 그 시간을 넘길 수
있습니다. **깨어나면 등록부터 하세요.**

### 받을 이벤트

```json
{"janus":"event","plugindata":{"data":{"sip":"event","result":{
   "event":"incomingcall","username":"sip:0101080501@pluto.org"}}},
 "jsep":{"type":"offer","sdp":"…"}}
```

```json
{"janus":"message","session_id":S,"handle_id":H,"transaction":"t8","apisecret":"…",
 "body":{"request":"accept"},
 "jsep":{"type":"answer","sdp":"…"}}
```

거절은 `{"request":"decline","code":486}` 입니다.

## 조용히 실패하는 자리들

전부 이 저장소가 실제로 겪은 것들입니다. **오류가 뜨지 않고 그냥 안 되는** 종류라
미리 알아 두는 편이 낫습니다.

| 증상 | 원인 | 고치는 법 |
|---|---|---|
| 502, 소켓이 바로 닫힘 | 서브프로토콜 없음 | `janus-protocol` 을 요청 |
| `403` / `Unauthorized request` | `apisecret` 누락 또는 **값이 틀림** | 대시보드에서 실제 값을 확인해 모든 요청에 넣기 |
| `457 Unhandled request` | `session_id`/`handle_id` 없이 보냄 | `create` → `attach` 응답을 **기다렸다가** 그 id 를 실어 보내기 |
| INVITE 를 Kamailio 가 못 봄 (로그도 없음) | `outbound_proxy` 누락 → `pluto.org` 가 DNS 로 풀림 | `outbound_proxy` 지정 |
| **연결은 됐는데 소리가 안 남** | 코덱을 opus 로 좁힘 | offer 에 PCMU/PCMA 유지 |
| 통화 중 갑자기 끊김 | keepalive 안 보냄 (세션 60초) | 30초마다 keepalive |
| 착신이 안 옴 | `sip_user` 미등록, 또는 등록이 60초를 넘김 | `/register/mobile` 에 `sip_user`, 깨어나면 등록 먼저 |
| 단말 등록이 404 | 경로가 `/register` (끝에 `/mobile` 없음) | `/iot/register/mobile` |
| 밖에서 소리만 안 남 | 공유기 UDP 포워딩 없음 | `20000-20200`(WebRTC) 열기 |
| REST 로 붙였는데 세션이 안 만들어짐 | `/janus-api/` 끝 슬래시 → `POST` 가 301 로 본문을 잃음 | 슬래시 없이 `/janus-api` |

## Flutter 로 만들 때

- **미디어**: `flutter_webrtc`. `getUserMedia({audio:true, video:…})` → `createOffer`.
- **시그널링**: 위 JSON 이 전부라 `WebSocketChannel` 로 **직접 구현하는 편이 단순**합니다.
  `janus.js` 는 브라우저용이고, Dart 래퍼 패키지를 쓸 수도 있지만 그 경우에도
  위의 `register`/`call` 본문은 그대로 넣게 됩니다.
- **코덱**: SDP 를 손대지 마세요. `flutter_webrtc` 의 기본 offer 에는 PCMU/PCMA 가
  들어 있습니다. 굳이 munging 하면 인터폰과 못 붙습니다.
- **안드로이드 깨우기**: FCM **data 메시지**(`priority: high`)로 옵니다. 화면이 꺼진
  상태에서 통화 UI 를 띄우려면 포그라운드 서비스나 `full-screen intent` 가 필요합니다.
- **권한**: 마이크(+영상이면 카메라). 권한 요청을 통화 시작 시점에 하면 그 사이에
  60초를 까먹습니다 — 앱 첫 실행 때 받아 두세요.

## 앱을 짜기 전에 확인할 수 있는 것

앱에서 막혔을 때 **어디가 문제인지** 가르려면 이 순서로 좁히세요.

| | 무엇 | 확인하는 것 |
|---|---|---|
| 1 | Janus 대시보드 **개요 → 접속 주소 → 붙어 보기** | 주소·TLS·서브프로토콜까지 전 구간 |
| 2 | `services/janus/verify-call.sh --run` | 등록·발신·양방향 RTP·재통화 (서버 쪽 전부) |
| 3 | `services/janus/verify-bridge.sh --run` | WebRTC ↔ **평문 G.711 단말** 브리징 |
| 4 | 앱 | 위 셋이 통과했는데 앱만 안 되면 앱 쪽 문제 |

1~3이 통과하면 **서버는 무죄입니다.** 그때는 앱의 SDP·순서·keepalive 를 보세요.

## 막혔을 때 볼 곳

| 무엇이 보이나 | 어디 |
|---|---|
| 지금 붙어 있는 세션·핸들·SIP 상태·미디어 통계 | Janus 대시보드 **세션·미디어** 탭 |
| 등록된 SIP 계정과 온라인 단말 | Kamailio 대시보드 (`/kamailio/`) |
| 착신 푸시 네 자리가 다 붙었는지 | `services/kamailio/check-push.sh` |
| Janus 가 무엇을 주고받았는지 | `journalctl -u janus -f` |
| Kamailio 가 INVITE 를 봤는지 | `journalctl -u kamailio -f` |
