# okhttp 클라이언트

`websocket-relay` 서버에 붙는 안드로이드 클라이언트 소스입니다.
통합 전 `websocket-relay-gateway` 저장소의 `android-wsrelay/` 를 그대로 옮겼습니다.

같은 디렉토리의 `../java` · `../kotlin` 은 **의존성 없는 최소 예제**이고,
여기 있는 것은 OkHttp 를 쓰는 **앱에 넣어 쓰는 소스 묶음**입니다. 용도가 다르니
둘 중 하나를 고르세요.
`apartment-mgmt-server/android-cassini` 와 같은 방식으로, 라이브러리가 아니라
**앱에 그대로 넣어 쓰는 소스**입니다.

## 넣는 법

`app/src/main/java/com/wsrelay/api/` 아래에 그대로 복사합니다.
패키지는 `com.wsrelay.api` 와 `com.wsrelay.api.models` 입니다.

```gradle
dependencies {
    implementation 'com.squareup.okhttp3:okhttp:4.12.0'
    // InviteNotification 이 RemoteMessage 를 받습니다. 푸시를 안 쓰면 빼도 됩니다.
    implementation platform('com.google.firebase:firebase-bom:33.1.0')
    implementation 'com.google.firebase:firebase-messaging'
}
```

`org.json` 은 안드로이드에 기본 포함이라 따로 넣지 않습니다.

## 서버 주소

기본 주소 하나만 넘기면 됩니다. 나머지 경로(`/relay/...`)는 클라이언트가 붙입니다.

```java
String server = "https://relay.example.com";
```

nginx 가 TLS 를 종단하고 `/relay/` 아래로 프록시합니다.
**자체 서명 인증서를 쓰므로** 안드로이드 기본 신뢰 저장소로는 붙지 않습니다.
서버 인증서를 `res/raw/server_cert.crt` 에 넣고 `sslCertificate()` 로 지정하세요.
검증을 끄지 마세요.

## 구성

| 파일 | 역할 |
|---|---|
| `WsRelayApiClient.java` | REST — 단말 등록/해제, 초대, IP 조회, 헬스 |
| `WsRelayWebSocketClient.java` | WebSocket 공통 — 연결·재연결·핑·인증서 |
| `RtcSignalingClient.java` | `/relay/rtc` 위 RTC 시그널링 (권장 진입점) |
| `IotClient.java` | `/relay/iot` 위 IoT 제어 |
| `models/` | 메시지·응답 POJO, 예외, 파서 |

대부분의 앱은 `WsRelayApiClient` + `RtcSignalingClient` 둘만 씁니다.
`WsRelayWebSocketClient` 는 원시 프레임을 직접 다룰 때만 필요합니다.

## 엔드포인트

인증이 없습니다. 단말은 등록할 때 쓴 `uuid` 로 자신을 식별합니다.
(`/status`, `/mobile-crud-operation`, `/admin` 은 서버가 내부망으로 제한하므로
이 클라이언트에 없습니다.)

| 메서드 | 경로 | 클라이언트 |
|---|---|---|
| POST | `/relay/register/mobile` | `register().mobile(...)` |
| POST | `/relay/register/complex_agents` | `register().homenet(...)` |
| GET | `/relay/register/findip?address=` | `register().findIp(...)` |
| POST | `/relay/unregister/mobile` | `unregister().mobile(uuid)` |
| POST | `/relay/room/invite` | `room().invite(target, source)` |
| GET | `/relay/health` | `health()` |
| WS | `/relay/rtc` | `RtcSignalingClient` |
| WS | `/relay/iot` | `IotClient` |

## 초인종 받기 — 전체 흐름

이 서비스의 핵심 시나리오입니다.

```
[문 앞 단말]  POST /relay/room/invite {target, source}
                      │
                      ▼
[릴레이]  room id 생성 → target 주소로 등록된 단말의 FCM 토큰 조회 → 푸시
                      │
                      ▼
[휴대폰]  FCM 수신 (data.roomId)
          → wss://.../relay/rtc 연결
          → INVITE 전송 (roomid = data.roomId)
          → 릴레이가 {"method":"update","clientid":"..."} 응답
          → offer/answer/candidate 교환
          → bye
```

### 1. 등록

**FCM 토큰이 갱신될 때마다** 다시 호출하세요. 별도의 토큰 갱신 API 는 없고,
같은 `uuid` 로 다시 등록하는 것이 갱신 경로입니다.

```java
WsRelayApiClient client = new WsRelayApiClient(server);

client.register().mobileAsync(
        deviceUuid,          // 설치마다 고정된 값. 서버의 기본키입니다
        "user@example.com",  // 이 단말의 계정
        "행복단지",
        "101B203U",          // 문 앞 단말이 부를 주소와 반드시 같아야 합니다
        fcmToken,
        new ApiCallback<JSONObject>() {
            public void onSuccess(JSONObject result) {
                RegisterResult r = ResponseParser.registerResult(result);

                // 승인된 단말이면 SIP 내선 자격이 함께 옵니다. 이 값으로
                // Janus SIP 플러그인에 등록합니다 (docs/client-migration.md).
                if (r.hasSipCredential()) {
                    JSONObject register = new JSONObject();
                    register.put("request",  "register");
                    register.put("username", r.sip.sipUri());  // sip:0101080501@pluto.org
                    register.put("authuser", r.sip.user);      // 0101080501
                    register.put("secret",   r.sip.password);
                    // … proxy · outbound_proxy 를 채워 Janus 로 보냅니다
                }
            }
            public void onError(ApiException e) {
                if (e.isRetryable()) { /* 나중에 다시 */ }
            }
        });
```

`address` 가 어긋나면 푸시가 영영 오지 않습니다. 등록은 성공하는데 초인종만
안 울린다면 여기부터 확인하세요 (서버에서는 `npm run db:status` 로 보입니다).

`sip` 가 **없을 수도 있습니다.** 아직 승인 전이거나, `A동` 처럼 숫자가 아닌
동/호라 번호를 만들 수 없는 세대입니다. 오류가 아니므로 등록을 실패로 다루면
안 됩니다 — 그 단말은 인터폰 착신만 못 받고 초인종 호출은 그대로 동작합니다.
자세한 것은 [docs/client-migration.md](../../../../../docs/client-migration.md).

### 2. 푸시 수신

알림 채널을 **첫 푸시 전에** 만들어 두어야 합니다. 안드로이드 8 이상에서
채널이 없으면 소리가 나지 않습니다.

```java
// Application.onCreate()
NotificationChannel channel = new NotificationChannel(
        InviteNotification.CHANNEL_ID,          // "callfusion_2_rtc"
        "방문자 호출",
        NotificationManager.IMPORTANCE_HIGH);
channel.setSound(doorbellUri, audioAttributes); // doorbell.wav
```

```java
// FirebaseMessagingService
@Override
public void onMessageReceived(RemoteMessage message) {
    InviteNotification invite = InviteNotification.from(message);
    if (invite.isInvite()) {
        startCallActivity(invite.roomId, invite.senderAddress());
    }
}

@Override
public void onNewToken(String token) {
    // 새 토큰으로 다시 등록 — 안 하면 다음 초인종부터 안 옵니다
    client.register().mobileAsync(deviceUuid, email, complex, address, token, callback);
}
```

### 3. 시그널링

**INVITE 를 먼저 보내고 응답을 기다려야 합니다.** 그 전에 보낸 메시지는
아무 오류 없이 조용히 버려집니다. `onJoined()` 가 준비 신호입니다.

```java
RtcSignalingClient rtc = new RtcSignalingClient.Builder(server)
        .sslCertificate(this, R.raw.server_cert)
        .listener(new RtcSignalingClient.Listener() {
            public void onConnected() {
                rtc.join(roomId,
                         ClientMessage.address("101B203U", myHost),   // "rtc:101B203U@..."
                         invite.sender,
                         "mobile");
            }

            public void onJoined(String clientId) {
                // 여기서부터 offer/answer 를 보낼 수 있습니다
                rtc.sendOffer(invite.sender, localSdp);
            }

            public void onSignal(ClientMessage msg) {
                switch (msg.method) {
                    case WsMethod.ANSWER:    applyAnswer(msg.code); break;
                    case WsMethod.CANDIDATE: addCandidate(msg.code); break;
                    case WsMethod.BYE:       endCall(); break;
                }
            }

            public void onServerMessage(ServerMessage msg) {
                if (msg.isError()) Log.e(TAG, msg.error);
            }

            public void onDisconnected(int code, String reason) { }
            public void onError(Exception e) { }
        })
        .build();

rtc.connect();
// 통화 종료
rtc.disconnect();   // bye 를 보내고 닫습니다
```

주소 형식은 `rtc:{주소}@{호스트}` 입니다. 릴레이는 `rtc:` 와 `@...` 를 떼어
내고 가운데만 등록된 주소와 비교합니다.

## IoT

월패드가 방을 만들고 휴대폰이 구독하는 구조입니다.

```java
IotClient iot = new IotClient.Builder(server)
        .sslCertificate(this, R.raw.server_cert)
        .listener(new IotClient.Listener() {
            public void onConnected() { iot.subscribe(roomId); }
            public void onMessage(IoTMessage msg) {
                if (IotClient.CODE_OK.equals(msg.rescode)) { ... }
            }
            public void onDisconnected(int code, String reason) { }
            public void onError(Exception e) { }
        })
        .build();

iot.connect();
iot.control(new JSONObject().put("light", "off"));
```

메서드마다 필요한 필드가 다릅니다. 빠지면 릴레이가 소켓을 닫지 않고
`ServerMessage` 로 오류만 보내므로 `onServerMessage` 를 꼭 보세요.

| 메서드 | 필요한 것 |
|---|---|
| `create` / `modify` / `join` / `subscribe` | `roomid` |
| `iot-control` / `iot-status` / `unsubscribe` | `roomid` + `clientid` |

`create` 로 재접속할 때는 **처음 받은 `clientid` 를 그대로** 보내야 합니다.
다른 값이면 "Room already exists, not the same clientid" 로 거부됩니다.

## 오류 처리

`ApiException.Kind` 로 갈라집니다.

| Kind | 뜻 | 대응 |
|---|---|---|
| `NETWORK` | 연결 실패·타임아웃 | 재시도 |
| `VALIDATION` | 400/401 — 필수 필드 누락 | 요청을 고칠 것 |
| `NOT_FOUND` | 404 — 등록이 없음 | 해제 시에는 정상 상황 |
| `UNAVAILABLE` | 503 — 릴레이는 살아 있고 DB 가 끊김 | 재시도 |
| `HTTP` / `PARSE` / `UNKNOWN` | 그 외 | 로그 |

`isRetryable()` 이 true 면 `WsRelayApiClient` 가 이미 두 번까지 자동 재시도한
뒤 던진 것입니다 (`setMaxRetries` 로 조절).

**503 은 장애가 아니라 부분 장애입니다.** 릴레이의 DB 가 끊기면 등록과 초대는
실패하지만 WebSocket 중계는 계속 동작합니다. 통화 중이라면 끊지 마세요.
`health()` 의 `status` 가 `degraded`, `details.dbError` 에 원인이 실립니다.

## 스레드

- REST 의 동기 메서드는 **메인 스레드에서 호출하면 안 됩니다.**
  `...Async` 를 쓰거나 `client.async(...)` 로 감싸세요.
- WebSocket 콜백은 기본적으로 메인 스레드로 옵니다
  (`callbackOnMainThread(false)` 로 끌 수 있습니다).

## 재연결

`WsRelayWebSocketClient` 가 지수 백오프로 자동 재연결합니다(기본 1초 → 최대 60초,
무제한). 두 가지만 알아 두세요.

- **재연결하면 `clientid` 가 새로 발급됩니다.** 이전 값은 무효이고,
  `RtcSignalingClient` 는 재연결 시 `onConnected()` 를 다시 호출하므로
  거기서 `join()` 을 다시 하면 됩니다.
- **닫힘 코드 1008 은 경로가 틀렸다는 뜻입니다.** 재연결해도 소용없어서
  클라이언트가 시도하지 않습니다. `/relay/rtc` 또는 `/relay/iot` 인지 확인하세요.

릴레이도 60초마다 핑을 보내고 응답 없는 연결을 끊습니다. 클라이언트 핑 주기
기본값(30초)을 그보다 크게 올리지 마세요.

## 서버 쪽 확인

문제가 생겼을 때 서버에서 볼 것들입니다.

```bash
npm run doctor      # 릴레이 전반 상태
npm run db:status   # 등록된 단말, 최근 등록 이력
```

관리 대시보드는 `https://{호스트}/relay/admin/` 입니다(내부망 전용).
접속 중인 룸과 클라이언트를 실시간으로 보여 주고, 연결 테스트 탭에서
`/relay/rtc` 에 직접 붙어 볼 수 있습니다.
