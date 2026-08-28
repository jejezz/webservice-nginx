# Android 예제

`websocket-relay` 에 붙는 최소 클라이언트입니다. **서버 소스에서 직접 확인한 규약**을
따릅니다 (`src/libs/websocketService.ts`). 상위 문서인 `ANDROID_API_GUIDE.md` 와
어긋나는 부분이 있으면 이 문서가 맞습니다.

```
example/android/
├── kotlin/    RtcRelayClient.kt  IotRelayClient.kt  RelayRestApi.kt  RelayTls.kt  RtcMessage.kt
├── java/      RtcRelayClient.java IotRelayClient.java RelayRestApi.java RelayTls.java RtcMessage.java
└── okhttp/    앱에 넣어 쓰는 소스 묶음 (com.wsrelay.api). 통합 전 android-wsrelay 였습니다
```

`kotlin/` 과 `java/` 의 구현은 같은 동작을 합니다. 쓰는 쪽 언어에 맞춰 하나만
가져가면 됩니다. `okhttp/` 는 목적이 다릅니다 — 규약을 보여 주는 예제가 아니라
모델 클래스와 콜백까지 갖춘 클라이언트 묶음이라, 앱에 그대로 넣어 쓸 때 고릅니다.

## 의존성

```gradle
implementation 'com.squareup.okhttp3:okhttp:4.12.0'
implementation 'org.json:json:20240303'   // Android 에 기본 포함(org.json). 단위 테스트용으로만 필요
```

## 접속 대상

| 용도 | 주소 |
|---|---|
| RTC 시그널링 | `wss://jejezzhome.iptime.org:28099/ws` |
| IoT 제어 | `wss://jejezzhome.iptime.org:28099/iot` |
| REST | `https://jejezzhome.iptime.org:28099` |

호스트 이름은 서버 인증서 SAN 에 있는 것을 써야 합니다. 자세한 것은
`ANDROID_API_GUIDE.md` 의 인증서 절을 보세요. CA 는 `nginx/cert/ca/ca.crt` 입니다.

`/ws` 와 `/iot` 외의 경로로 붙으면 서버가 **말없이 연결을 닫습니다.**

## RTC 메시지

모든 메시지는 JSON 한 덩어리이고 `method` 로 갈립니다.

```json
{
  "method": "invite",
  "roomid": "12345678",
  "sender":  "rtc:101B405U@192.168.0.157",
  "receiver":"rtc:101B203U@192.168.0.167:8088",
  "device":  "interphone",
  "clientid":"",
  "code":    "100",
  "extendParam": ""
}
```

**`roomid` · `sender` · `device` · `receiver` 는 모든 메시지에 있어야 합니다.**
하나라도 비면 서버가 오류를 보내고 연결을 끊습니다.

`receiver` 는 반드시 `rtc:<주소>@<호스트>` 형식입니다. 서버는 `rtc:` 와 `@` 사이만
잘라내 FCM 대상 주소로 씁니다. 형식이 어긋나면 푸시 대상을 찾지 못합니다.

| method | 방향 | 뜻 |
|---|---|---|
| `invite` | 앱 → 서버 | 방에 들어간다. 첫 참가자면 서버가 상대에게 FCM 푸시를 보낸다 |
| `invite-ack` | 앱 → 서버 | 푸시를 받고 들어갈 때 |
| `offer` `answer` `candidate` `remove-candidates` | 양방향 | 방의 상대에게 그대로 중계된다 |
| `accept` | 양방향 | 중계된다 |
| `bye` `error` | 앱 → 서버 | 방에서 빠진 뒤 상대에게 중계된다 |

### 참가 절차

1. `/ws` 로 연결한다.
2. `invite` 를 보낸다.
3. 서버가 **`{"method":"update","clientid":"12345678"}`** 로 답한다.
   이 `clientid` 를 보관하고 이후 모든 메시지에 넣는다.
4. `offer` → `answer` → `candidate` 를 주고받는다.
5. 끝나면 `bye`.

중계는 **방 안의 다른 클라이언트 한 명**에게 갑니다 (1:1 통화 전제).
방에 혼자면 메시지가 큐에 쌓였다가 상대가 들어올 때 전달됩니다 — 나중에 들어온
쪽은 접속 직후 먼저 온 `invite` 를 받게 되므로, `onEvent` 에서 그 경우를 처리해야
합니다.

> 아래 동작은 실제 서버에 붙여 확인한 것입니다.
> `invite` → `{"method":"update","clientid":"32438045"}`,
> 필수 필드 누락 → `ERROR:invalid register request: missing 'device'` 후 연결 종료,
> 비-JSON 입력 → `I don't know what to do with:hello`,
> 모르는 `method` → 무응답,
> A 의 `offer` 가 B 에게, B 의 `answer` 가 A 에게 중계됨.

### 서버가 보내는 것

| 형태 | 뜻 |
|---|---|
| `{"method":"update","clientid":"..."}` | `invite` 응답. JSON |
| 상대가 보낸 메시지 원본 | 중계된 시그널링. JSON |
| `ERROR:<사유>` | **평문**. 이 뒤에 서버가 연결을 닫는다 |
| `I don't know what to do with:<원본>` | **평문**. 파싱 못 한 입력에 대한 응답 |

**오류가 JSON 이 아니라 평문이고 연결이 끊긴다**는 점에 주의하세요. 예제의
`onMessage` 는 이 세 가지를 모두 구분합니다.

## IoT 메시지

`/iot` 로 붙고 형태가 다릅니다.

```json
{ "method": "create", "roomid": "1234", "clientid": 0,
  "address": "101B1001U", "rescode": "0", "payload": {} }
```

`create` `modify` `join` `subscribe` `iot-control` `iot-status` `unsubscribe` `error`.

> 2026-08-18 에 고쳤습니다 — 이전에는 성공 응답이 `sendOk()` 를 거치며
> `I don't know what to do with:` 접두사를 달고 나갔습니다. 지금은 순수 JSON 입니다.
> 예제는 접두사가 있든 없든 파싱하므로 옛 서버에도 그대로 붙습니다.

## REST

| 메서드 | 경로 | 본문 |
|---|---|---|
| POST | `/register/mobile` | `{uuid, email, complex, address, token, phone?, image?}` |
| POST | `/unregister/mobile` | `{uuid}` |
| POST | `/register/complex_agents` | `{complex, type, building, unit, ipaddress}` |
| GET | `/register/findip?address=rtc:...@...` | — |
| GET | `/status/rooms` | — |
| POST | `/room/invite` | `{target, source}` |

`token` 은 FCM 등록 토큰입니다. 이 값으로 착신 푸시가 갑니다.

## 착신 푸시

`/room/invite` 가 보내는 FCM `data` 는 이렇습니다.

```json
{ "method":"invite",
  "sender":"rtc:101B405U@jejezzhome.iptime.org:28099",
  "receiver":"rtc:101B203U@jejezzhome.iptime.org:28099",
  "code":"100", "device":"interphone", "roomid":"12345678" }
```

`sender` 는 `/room/invite` 의 `source`, `receiver` 는 `target` 에서 옵니다.
`rtc:<주소>@<호스트>` 형태로 보내면 그대로 실리고, 주소만 보내면 요청이 들어온
호스트를 붙여 만듭니다. (2026-08-18 이전에는 고정 문자열이 박혀 있어 누가 걸든
같은 두 주소가 전달됐습니다.)

철자는 WebSocket 규약과 같은 `roomid` 입니다. 2026-08-18 이전 서버는 여기만
`roomId`(대문자 I)를 보냈습니다. 예제의 `RtcMessage.fromPushData()` 가 둘 다 받으므로
옛 서버에도 그대로 붙습니다.

`/status/rooms` 와 대시보드 API 의 JSON 목록은 `roomId`·`clientId`·`ipAddress` 처럼
camelCase 를 씁니다. 그쪽은 메시지가 아니라 목록 응답이고 자기들끼리 일관돼 있어
철자가 다릅니다.

푸시를 받으면 `roomId` 로 `/ws` 에 붙어 `invite-ack` 을 보내면 됩니다.
