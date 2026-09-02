# 클라이언트 이관 — SIP · RTC

서버 쪽은 끝났습니다. 남은 것은 **클라이언트 세 종류**입니다. 이 문서 하나로
시작할 수 있게 썼습니다 — 규격은 [identity.md](identity.md), 앱 API 전체는
[client-guide.md](client-guide.md) 에 있고, 여기서는 **무엇이 바뀌었고 무엇을
고쳐야 하는지**만 다룹니다.

## 한 줄 요약

**앱이 SIP 내선 번호를 정하던 구조가 없어졌습니다.** 서버가 승인 시점에
동/호에서 번호를 계산해 배정하고 Kamailio 계정까지 만듭니다. 클라이언트는 등록
응답으로 받은 값을 쓰기만 하면 됩니다.

## 번호 규칙 (전부)

```
 0101 0805 01
 └동4┘└호4┘└순번2┘
```

- 동·호는 왼쪽을 `0` 으로 채워 각각 **4자리 고정**. 101동 805호 → `01010805`
- 순번: `00` 붙박이 장치(세대면 월패드, 인터폰 세대면 인터폰) · `01`~`04` 모바일
- 숫자만. 특수문자 없음. 단지는 번호에 넣지 않습니다 — 단지마다 서버·도메인이 다릅니다
- 인터폰도 같은 규칙입니다. 실재하지 않는 호를 그 동에 두고 순번은 `00`
  — **101동 9901호 인터폰 → `0101990100`**

## ① 모바일 앱 — SIP 자격을 받아 쓰기

### 바뀐 것

| 지금 앱 | 바뀐 뒤 |
|---|---|
| `/register/mobile` 에 `sip_user` 를 실어 보냄 | **보내지 않음.** 보내도 무시되지는 않지만 서버가 배정한 값이 이깁니다 |
| SIP 비밀번호를 사람이 앱에 넣어 둠 | 등록 응답의 `sip` 로 받음 |
| Janus `register` 에 사람이 정한 내선 | 받은 번호로 등록 |

### 요청

```jsonc
POST /iot/register/mobile          // nginx 경유. 포트 직결이면 /register/mobile
{
  "uuid":    "<단말 고유 id>",      // 서버가 단말을 가르는 열쇠. 절대 바꾸지 마세요
  "email":   "...",
  "complex": "...",
  "address": "101B805U",           // 동B호U
  "token":   "<FCM 토큰>"
  // sip_user 는 보내지 않습니다
}
```

> ⚠️ **`token` 을 빈 값으로 보내지 마세요.** 이 호출은 저장된 토큰을 덮어씁니다.
> 시험한다고 빈 문자열을 넣으면 그 단말의 푸시가 조용히 끊깁니다.

### 응답 (이미 승인된 단말)

```jsonc
{
  "title": "websocket-relay",
  "result": "success",
  "status": "approved",
  "message": "Your token has been updated successfully.",
  "sip": {                          // ← 새로 생긴 필드
    "user":     "0101080501",
    "domain":   "pluto.org",
    "password": "9e807d…"           // 24자 16진수
  },
  "canCall": true,                  // 지금 이 단말에 열려 있는 권한
  "canControl": false,
  "janus": {                        // 이 단말만의 Janus 토큰
    "url":   "wss://<호스트>/janus-ws",
    "token": "<32바이트 난수>"
  },
  "clientCert": "-----BEGIN CERTIFICATE-----…"   // CSR 을 함께 보냈을 때만
}
```

`canCall`·`canControl` 은 승인 푸시로 한 번 받은 뒤 월패드나 관리자가 바꿀 수
있습니다. 등록할 때마다 현재 값이 오므로 **여기서 따라잡으십시오** — 없는 버튼을
계속 보여 주면 눌러야 실패합니다.

### `janus` — 이 단말만의 토큰

Janus 요청에 `apisecret` 대신 **`token`** 을 실으십시오. `apisecret` 은 단지에
하나뿐이라 모든 폰에 같은 값이 들어갑니다 — 한 대에서 새면 그 단지의 게이트웨이
전체가 열리고, 그 한 대만 막을 방법이 없습니다.

- **키가 없으면 그 값은 안 온 것입니다.** 서버는 값이 없을 때 키를 **빼고**
  보냅니다(빈 문자열이 아닙니다). 쥐고 있던 값을 지우지 마세요
- `token` 이 없고 `apiSecret` 만 있으면 지금처럼 동작하면 됩니다 (전환 기간)
- **403 을 받으면 재등록으로 새 토큰을 받아 다시 시도하십시오.** Janus 는 토큰을
  메모리에만 갖고 있어 재시작하면 사라집니다. 서버가 등록 때마다 다시 넣으므로
  앱이 재등록하는 것이 곧 복구입니다
- 토큰은 `janus.plugin.sip` 으로 좁혀져 있습니다. 다른 플러그인에 attach 하면
  거절됩니다
- 통화 권한(`canCall`)이 꺼지면 토큰도 거둬집니다. 다시 켜면 다음 등록에서 새로
  발급됩니다
- 착신 푸시(`sip-incoming`)는 예전처럼 최상위 `janusUrl` 을 씁니다. 그 관례는
  그대로입니다

- **`sip` 가 없을 수 있습니다.** 번호를 받기 전에 승인된 옛 단말이거나, 숫자가
  아닌 동/호(`A동` 등)라 번호를 만들 수 없는 세대입니다. 그 경우 예전처럼
  동작해야 합니다 — SIP 착신만 없고 WebRTC 초인종은 그대로입니다
- **비밀번호는 바뀔 수 있습니다.** 그 자리를 다른 단말이 물려받으면 새로
  발급됩니다. 등록이 401 로 실패하면 `/register/mobile` 을 한 번 더 불러 새 값을
  받으세요. 캐시해 두고 영원히 쓰면 안 됩니다
- 승인 전이면 `202` 와 `status: "pending"` 입니다. `sip` 는 없습니다

### Janus 에 등록할 때

```jsonc
{"janus":"message","session_id":S,"handle_id":H,"transaction":"t3","apisecret":"…",
 "body":{
   "request":"register",
   "username":"sip:0101080501@pluto.org",   // sip.user, sip.domain
   "authuser":"0101080501",                 // sip.user — username 과 같아야 합니다
   "display_name":"0101080501",
   "secret":"<sip.password>",
   "proxy":"sip:192.168.0.252:5060",
   "outbound_proxy":"sip:192.168.0.252:5060"
 }}
```

**`username` 과 `authuser` 를 같게 두십시오.** Kamailio 의
`auth_check("$fd","subscriber","1")` 이 "digest 사용자명 == To 사용자명" 을
강제합니다. 다르면 401 입니다.

`outbound_proxy` 를 빠뜨리면 INVITE 가 `pluto.org` 를 DNS 로 풀어 인터넷으로
나갑니다 — Kamailio 는 그것을 보지도 못하고, 로그도 응답도 없습니다.

### 착신 푸시를 받으면

```jsonc
{ "method": "sip-incoming",
  "sipUser": "0101080501",     // 인터폰이 건 번호 = 이 단말의 번호
  "home":    "01010805",       // 세대번호로 걸려 온 경우에만 실립니다
  "janusUrl": "wss://<호스트>/janus-ws",
  "caller": "…", "callId": "…" }
```

받으면 **60초 안에** Janus 에 붙어 `register` 까지 마쳐야 합니다. Kamailio 가
INVITE 를 붙들고 있는 시간이 60초입니다. 등록이 끝나면 붙들려 있던 INVITE 가 그
경로로 흘러옵니다.

등록에 쓸 번호는 **푸시의 `sipUser` 가 아니라 `/register/mobile` 로 받아 둔
`sip.user`** 입니다. 지금은 두 값이 같지만, 세대번호로 거는 경로가 열리면
달라집니다.

> Janus 의 등록 만료는 10분입니다. 앱이 사라진 뒤 그 시간이 지나야 Kamailio 가
> "없음" 으로 보고 다시 푸시를 겁니다 — 그 사이 착신은 죽은 세션으로 갑니다.
> **앱을 종료할 때 Janus 세션을 명시적으로 정리하면** 이 창이 사라집니다.

## ② 인터폰 — 거는 쪽

사람은 **세대 8자리**를 누르지만, 클라이언트가 **뒤 두 자리를 붙여** 보냅니다.
서버가 받는 RURI 는 언제나 단말 10자리입니다.

```
사람이 누름: 01010805
클라이언트가 보냄: 0101080500, …01, …02, …03, …04   (필요한 자리만)
```

이 구조를 고른 결과로 **거는 쪽이 지는 몫이 둘** 있습니다.

1. **한 대가 받으면 나머지를 CANCEL 해야 합니다.** 다섯 개의 독립 트랜잭션이라
   SIP 포크와 달리 저절로 취소되지 않습니다. 안 보내면 나머지 폰이 계속 울립니다
2. **빈 자리로 걸면 `480 Temporarily Unavailable` 이 옵니다.** 그 집에 두 대만
   있으면 `03`·`04` 가 그렇습니다. **오류가 아니라 정상**이므로 사용자에게
   실패로 보이면 안 됩니다

인터폰 자신의 계정도 필요합니다 — INVITE 를 걸 때 digest 인증을 받습니다
(`from_uri==myself`). 번호는 `<인터폰세대>00`, 계정은 사람이 `kamctl` 로 만듭니다.

## ③ 월패드

보내는 값에서 **`complex`(단지 표시 이름)가 빠졌습니다.**

```jsonc
POST /register/complex_agents
{ "type": "wallpad", "building": "101", "unit": "805", "ipaddress": "192.168.0.9" }
```

단지는 서버가 압니다 — 한 서버가 한 단지를 맡고 서버 간 통화가 없으므로, 이
서버에 온 등록은 정의상 이 단지입니다. 월패드는 인트라넷에만 있어 단지 정보를
바깥에서 받아 올 수도 없고, 사람에게 입력시킬 이유도 없습니다. 옛 월패드가
`complex` 를 계속 보내와도 오류가 아니며 무시됩니다.

응답에 `sip` 가 실립니다. 모바일과 같은 모양이고, 번호는 `<세대>00` 입니다.

- **부팅마다 불러도 같은 값이 옵니다.** 이미 있으면 비밀번호를 새로 발급하지
  않습니다 (`libs/sipAccount.ts` 의 `ensure`)
- 월패드가 SIP 를 쓰지 않는 배치라면 이 값을 무시하면 됩니다. 계정이 하나
  남을 뿐이고 아무것도 강제하지 않습니다

## 바뀌지 **않는** 것

오해를 막기 위해 적어 둡니다.

- **WebRTC 초인종 경로 전체.** `/relay/rtc` · `/relay/iot` WebSocket, `/room/invite`,
  방 규약, `address`(`101B805U`) 기반 라우팅 — 하나도 바뀌지 않았습니다
- **FCM 토큰 취급.** `/register/mobile` 로 갱신하는 방식 그대로입니다
- **승인 절차.** 월패드가 승인해야 권한이 열리는 것 그대로입니다
- **Kamailio 설정.** 한 줄도 바꾸지 않았습니다

## 확인하는 법

```bash
# 1. 그 단말의 자격이 실제로 내려오는지 (토큰을 지우지 않도록 실제 토큰을 실어야 함)
curl -s -X POST http://127.0.0.1:28099/register/mobile \
  -H 'Content-Type: application/json' \
  -d '{"uuid":"<uuid>","email":"…","complex":"…","address":"101B805U","token":"<진짜 토큰>"}'

# 2. 계정이 Kamailio 에 있는지
services/kamailio/check-accounts.sh

# 3. 등록이 실제로 잡혔는지 (앱이 Janus 에 붙은 뒤)
sudo /usr/sbin/kamctl ul show

# 4. 착신 네 자리가 다 붙어 있는지
services/kamailio/check-push.sh

# 5. Janus 경로가 통째로 도는지 (실제 통화, 시험용 세대로)
services/janus/verify-call.sh --run
```

푸시 자체는 대시보드에서 확인할 수 있습니다 — `/relay/dashboard` → 모바일 단말 →
행의 종 버튼. **'토큰 검증만'** 은 단말을 울리지 않고 토큰 유효성만 봅니다.

## 알아 두면 시간을 아끼는 것들

- **`/iot/` 접두사는 nginx 가 붙입니다.** 서버 포트(28099)에 직접 붙을 때 경로는
  `/register/mobile` 입니다. `/iot/register/mobile` 로 찌르면 404 입니다
- **`verify-call.sh` 는 지난 실패가 남아 있으면 `--run` 을 거부합니다.**
  `services/janus/test-harness/last-run/result.json` 을 지우면 다시 돕니다
- **`subscriber.password` 는 평문입니다.** 이 서버는 `calculate_ha1=yes` 라
  평문 컬럼만 인증에 씁니다. `ha1` 만 있고 `password` 가 비면 **어떤 비밀번호로도
  401** 입니다 (`services/kamailio/accounts.md`)
- 앱이 지워졌다 다시 깔려 `uuid` 가 바뀌면 **새 단말**입니다. 옛 행이 자리를
  차지한 채 남으므로(세대당 4대) 관리자가 지워야 합니다

## 코드가 있는 곳

| 무엇 | 어디 |
|---|---|
| 번호 계산 | `services/websocket-relay/src/libs/sipNumber.ts` |
| 계정 발급·회수 | `services/websocket-relay/src/libs/sipAccount.ts` |
| 순번 배정 (승인) | `services/websocket-relay/src/libs/enrollment.ts` 의 `insertApproved` |
| 등록 응답에 `sip` 싣기 | `services/websocket-relay/src/routes/register.ts` |
| 월패드 자리 | `services/websocket-relay/src/libs/homenetRecord.ts` |
| 착신 푸시 | `services/websocket-relay/src/routes/sipPush.ts` |
| 기존 단말 백필 | `services/websocket-relay/scripts/backfill-sip-number.ts` (`npm run sip:backfill`) |
| 안드로이드 예제 | `services/websocket-relay/example/android/` — `okhttp/models/SipCredential.java`(새로 만듦) · `RegisterResult.java` 가 `sip` 를 읽습니다. kotlin·java 쪽은 `RelayRestApi.sipCredential()` |
| Janus 등록 절차 | `docs/client-guide.md` 3절 |

## 지금 서버 상태 (2026-08-29)

- 마이그레이션 `007-sip-number` · `008-homenet-complex-id` · `009-janus-token` 적용됨
- 계정 6개 — `0101080500`(101동 805호 월패드) · `0101080501`(같은 세대 모바일) ·
  `9999999901`~`04`(시험용 세대 9999동 9999호)
- 인터폰 계정은 **아직 없습니다.** 번호 규칙만 정해져 있습니다
- 검증된 것: `/register/mobile` 이 `sip` 를 내려주는 것, `verify-call.sh --run`
  5단계 전부 통과(RTP 양방향 297/298 패킷)
- 검증되지 않은 것: **앱이 그 자격으로 Janus 에 등록하는 것** — 클라이언트가
  고쳐져야 처음 확인됩니다
