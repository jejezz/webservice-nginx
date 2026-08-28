# 단말 등록 — 남은 작업

서버 쪽 등록·승인은 들어갔습니다. 이 문서는 **아직 남은 세 가지**를 적습니다.

1. [Firestore 단지 디렉터리 적용](#1-firestore-단지-디렉터리-적용) — 운영
2. [모바일 앱이 해야 할 것](#2-모바일-앱이-해야-할-것) — 앱
3. [월패드가 해야 할 것](#3-월패드가-해야-할-것) — 월패드

설계 배경은 [../ReadMe.md](../ReadMe.md) 의 '단말 등록' 절과
[multi-complex.md](multi-complex.md) 에 있습니다.

---

## 지금 어디까지 되어 있나

```
앱: 단지 선택 → 동/호 입력 → POST /register/mobile
                                    ↓
                          mobile_enrollments (대기, 30분)
                                    ↓  월패드가 승인
                          rtc_mobiles  can_call / can_control
```

| | 상태 |
|---|---|
| 대기 표 · 상한 · 만료 | ✅ 서버에 들어감 |
| 승인 API (대시보드) | ✅ |
| 승인 API (월패드 WebSocket) | ✅ |
| `can_call` 강제 (푸시 4경로) | ✅ |
| `can_control` 강제 | ⚠️ 세대 단위만 ([한계](#can_control-의-한계)) |
| 앱에 결과 통보 (승인·거절·만료 FCM) | ✅ |
| 월패드 승인 UI | ❌ 만들어야 함 |
| 앱의 대기 상태 UI | ❌ 만들어야 함 |
| 월패드 인증 | ❌ 미정 ([아래](#월패드-인증은-아직-없다)) |

### 결과 통보는 FCM 으로 갑니다

요청한 단말은 승인·거절·만료를 **FCM data 메시지**로 받습니다. 앱이 화면을
열고 있지 않아도 됩니다 (폴링 불필요).

```json
{ "method": "enroll.approved", "address": "1B101U", "canCall": "true", "canControl": "false" }
{ "method": "enroll.rejected", "address": "1B101U" }
{ "method": "enroll.expired",  "address": "1B101U" }
```

`notification`(제목·본문)도 함께 오므로 앱이 아무것도 안 해도 알림은 뜹니다.
자세한 처리는 [2-3](#2-3-승인-결과를-받는다).

> **구현 메모** — 이 통보는 `can_call` 검사를 우회해 토큰으로 직접 보냅니다.
> 승인 직후 단말은 `can_call` 이 꺼져 있을 수 있고(제어만 준 경우), 거절·만료된
> 단말은 아예 `rtc_mobiles` 에 없기 때문입니다.
>
> 거절·만료는 [`push.ts` 의 `sendOne()`](../src/libs/push.ts) 을 씁니다 —
> `sendToTargets()` 는 결과를 `rtc_mobiles ... WHERE id = ?` 로 되쓰는데,
> 아직 그 표에 없는 단말의 대기 id 를 넘기면 **같은 번호를 가진 남의 단말 행이
> 비활성으로 내려갑니다.** 승인은 방금 `rtc_mobiles` 에 들어간 뒤라 새 id 로
> `sendToTargets()` 를 써서 토큰 건강 상태까지 기록합니다.

## 1. Firestore 단지 디렉터리 적용

앱은 앱스토어에서 한 벌로 배포되므로, **어느 단지의 어느 서버로 가야 하는지**를
어디선가 받아야 합니다. 그 목록이 Firestore 에 있습니다.

> 이건 릴레이의 MariaDB 와 **다른 저장소**입니다. 릴레이 표(`rtc_mobiles` 등)는
> `schema/*.sql` + `npm run db:migrate` 로 관리하고, 여기 Firestore 에는
> **단지 목록만** 둡니다. 서버 자격이나 개인키는 절대 올리지 않습니다.

### 1-1. Firestore 를 켠다

Firebase 콘솔 → 빌드 → **Firestore Database** → 데이터베이스 만들기.

- 위치: `asia-northeast3` (서울)
- 모드: **프로덕션 모드** (테스트 모드는 30일 뒤 전부 잠깁니다)
- Realtime Database 가 아니라 **Firestore** 입니다

### 1-2. 보안 규칙

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /regions/{doc} {
      allow read: if true;      // 아파트 이름·주소는 어차피 공개 정보다
      allow write: if false;    // 콘솔이나 Admin SDK 로만
    }
    match /{document=**} { allow read, write: if false; }
  }
}
```

마지막 줄이 중요합니다 — 나중에 다른 컬렉션이 생겨도 기본이 잠깁니다.

`allow read: if true` 는 의도된 것입니다. 앱이 로그인 전에 단지 목록을 그려야
하기 때문입니다. **그래서 `complexId` 는 비밀이 아닙니다** — 이 값을 인증에
쓰면 안 되는 이유가 여기 있습니다.

### 1-3. 문서 구조 — 지역당 하나

단지당 문서로 나누면 목록을 그릴 때 단지 수만큼 읽기가 발생합니다. 지역 문서
하나에 배열로 담으면 앱이 몇 개 단지를 보든 **2 reads** 로 끝납니다.

```
regions/_index
{ "regions": [ { "code": "41135", "name": "성남시 분당구" } ] }

regions/41135
{
  "name": "성남시 분당구",
  "updatedAt": <serverTimestamp>,
  "complexes": [
    {
      "complexId": "a3f19c04",
      "name": "플루토 1단지",
      "host": "c-a3f19c04.rtc.example.com",
      "minAppVersion": "1.0.0"
    }
  ]
}
```

### 1-4. 올린다

콘솔에서 손으로 넣어도 되지만 단지가 늘면 오타가 납니다. 도구가 있습니다.

```bash
cd services/websocket-relay
cp tools/directory.example.json tools/directory.json   # 편집
npm run directory -- check                             # 자격·연결만 확인
npm run directory -- push tools/directory.json --dry-run
npm run directory -- push tools/directory.json
npm run directory -- pull                              # 올라간 내용 확인
```

올리기 전에 **전부 검사하고**, 하나라도 문제가 있으면 아무것도 쓰지 않습니다.
절반만 올라가면 앱이 목록에는 있는데 열 수 없는 단지를 보게 되기 때문입니다.

이 도구는 `secrets/firebase-admin.json` 을 씁니다. 대시보드의 **푸시 키** 탭에서
올린 그 키입니다.

### 1-5. 서버 `.env` 와 맞춘다

디렉터리의 `complexId` 와 그 단지 서버의 `COMPLEX_ID` 가 **같아야** 합니다.
다르면 앱이 등록할 때 서버가 `403 complex_mismatch` 로 거절합니다.

```bash
openssl rand -hex 4     # 새 단지 ID
```

서버 쪽 값은 대시보드 개요 화면에서 확인·변경합니다 (비밀번호 재확인 필요).

---

## 2. 모바일 앱이 해야 할 것

### 2-1. 등록 요청 — 응답이 늘었습니다

```http
POST https://<host>/relay/register/mobile
Content-Type: application/json

{
  "uuid":      "<단말 고유 ID>",       // 필수. 이 값이 단말의 신원이다
  "email":     "user@example.com",     // 필수
  "complex":   "플루토 1단지",          // 필수. 표시용 이름
  "complexId": "a3f19c04",             // 디렉터리에서 받은 값
  "address":   "1B101U",               // 필수. <동>B<호>U
  "token":     "<FCM 등록 토큰>",       // 필수
  "phone":     "010-0000-0000",        // 선택
  "sip_user":  "1101",                 // 선택. 없으면 SIP 착신을 못 받는다
  "image":     "<base64>"              // 선택. 프로필 이미지
}
```

**`address` 형식이 강제됩니다.** `<동>B<호>U` 입니다 (`1B101U` = 1동 101호).
서버가 이 형식으로만 세대를 찾으므로 앱에서 조립할 때 맞춰야 합니다.

| 응답 | 뜻 | 앱이 할 일 |
|---|---|---|
| `200` `status:"approved"` | 이미 승인된 단말의 갱신 | 그대로 사용 |
| **`202`** `status:"pending"` | **대기에 올랐다. 아직 아무 권한 없음** | 대기 화면 (2-2) |
| `409` `no_wallpad` | 그 동/호에 월패드가 없다 | "월패드를 먼저 연결하세요" |
| `409` `home_full` | 이 세대 4대가 찼다 | "쓰지 않는 기기를 월패드에서 지우세요" |
| `409` `bad_address` | 동/호 형식이 아니다 | 입력 화면으로 되돌리기 |
| `403` `complex_mismatch` | 다른 단지 서버다 | 단지를 다시 고르게 |
| `400` | 필수값 누락 / `sip_user` 형식 오류 | 입력 오류 표시 |

**`202` 가 새로 생긴 것이 핵심입니다.** 예전에는 `200` 뿐이었고 그 즉시 전화를
받을 수 있었습니다. 지금은 `202` 를 성공으로 처리하되 **아직 못 쓰는 상태**로
다뤄야 합니다.

`202` 응답에는 `expiresAt` (ISO 8601) 이 함께 옵니다. 그때까지 승인되지 않으면
요청이 사라지므로 다시 등록해야 합니다.

### 2-2. 대기 화면

이 화면이 없으면 사용자는 그냥 고장으로 받아들입니다. 담아야 할 것:

- **무엇을 해야 하는지** — "댁내 월패드에서 승인해 주세요"
- **어디를 봐야 하는지** — 월패드의 승인 화면 위치
- **남은 시간** — `expiresAt` 까지. 지나면 "다시 요청" 버튼
- **다시 요청** — 같은 `uuid` 로 다시 POST 하면 행이 늘지 않고 갱신됩니다

### 2-3. 승인 결과를 받는다

FCM data 메시지 세 가지를 처리하면 됩니다. `data` 값은 FCM 규약상 **전부
문자열**입니다 — `"true"` / `"false"` 로 옵니다.

| `method` | 뜻 | 앱이 할 일 |
|---|---|---|
| `enroll.approved` | 승인됨 | 대기 화면을 닫고 정상 진입. `canCall`·`canControl` 로 쓸 수 있는 기능을 정함 |
| `enroll.rejected` | 거절됨 | 대기 화면을 닫고 사유 안내 |
| `enroll.expired` | 30분 안에 승인되지 않음 | 대기 화면을 닫고 "다시 요청" 제시 |

```json
{ "method": "enroll.approved", "address": "1B101U", "canCall": "true", "canControl": "false" }
```

`canCall` 이 `"false"` 면 **승인은 됐지만 전화는 오지 않습니다.** 그 상태를
정상으로 표시하면 사용자가 나중에 "전화가 안 온다" 고 합니다 — 화면에 드러내고
"월패드에서 통화를 켜세요" 를 안내하세요.

셋 다 `notification` 이 함께 오므로, 앱이 백그라운드여도 알림은 뜹니다.
포그라운드에서는 앱이 직접 그려야 합니다 (Android 는 포그라운드일 때
`notification` 을 시스템이 표시하지 않습니다).

### 2-4. 새 기기 등록 알림 (기존 단말)

이미 승인된 단말은 같은 세대에 **새 등록 요청이 들어올 때** FCM 을 받습니다.
이건 서버에 이미 들어가 있습니다.

```json
{ "method": "enroll.pending", "address": "1B101U", "email": "someone@example.com" }
```

`notification` 도 함께 오므로 아무것도 안 해도 알림은 뜹니다. 앱에서 다루면
"우리 집에 등록을 시도한 기기" 목록을 보여줄 수 있습니다.

**이 알림이 계정 탈취를 알아채는 유일한 신호일 수 있습니다.** 조용히 삼키지 마세요.

### 2-5. 통화·제어가 막혀 있을 때

승인은 됐지만 `can_call` 이 꺼져 있으면 초인종·전화가 오지 않습니다.
`can_control` 이 꺼져 있으면 제어 명령이 거부됩니다.

```
ERROR:이 세대에 제어가 허용된 단말이 없습니다. 월패드에서 승인하세요.
```

WebSocket 오류는 **JSON 이 아니라 `ERROR:` 로 시작하는 평문**입니다.
파싱하지 말고 접두사로 가르세요.

---

## 3. 월패드가 해야 할 것

### 3-1. 세대 등록 — 검증이 생겼습니다

```http
POST https://<host>/relay/register/complex_agents
Content-Type: application/json

{
  "complex":   "플루토 1단지",
  "type":      "wallpad",
  "building":  "1",              // 영문·숫자·- 8자 이내
  "unit":      "101",            // 영문·숫자·- 8자 이내
  "ipaddress": "192.168.0.9"
}
```

| 응답 | 뜻 |
|---|---|
| `200` | 등록/갱신 |
| `400` `invalid_place` | `building`/`unit` 형식 위반 |

**이 등록이 없으면 그 세대의 모바일은 등록조차 못 합니다** (`409 no_wallpad`).
월패드가 서버에 먼저 붙어야 합니다.

`complex_id` 는 앱이 보내지 않습니다 — 서버가 자기 단지 값으로 채웁니다.

### 3-2. IoT WebSocket 접속

```
wss://<host>/relay/iot
```

```json
{ "method": "create", "roomid": "<RoomID>", "clientid": 0,
  "address": "iot:1B101U@<호스트>",
  "payload": { "rooms": [...], "gadgets": [...] } }
```

> ⚠️ **`payload` 에 `rooms` 와 `gadgets` 를 반드시 넣으세요.**
> 빠뜨리면 이후 **그 방에 들어오는 모바일의 연결이 끊깁니다.**
> 서버가 모바일의 `join` 을 처리하면서 월패드의 payload 를 파싱하다 실패하는데,
> 그 오류가 모바일 연결을 닫습니다. 오류 문구(`Unexpected end of JSON input`)가
> 원인을 전혀 알려주지 않아 찾기 매우 어렵습니다.
> (서버 쪽에서도 고칠 예정이지만, 월패드가 채워 보내는 것이 맞습니다)

`address` 는 `iot:<동>B<호>U@<무엇이든>` 형식입니다. 서버는 `iot:` 접두사와
`@` 뒤를 떼고 `1B101U` 로 봅니다 — 이 값으로 세대를 가르므로 정확해야 합니다.

### 3-3. 등록 승인 — 이 소켓으로 주고받습니다

승인 권한의 근거는 **"IoT 방을 만든 쪽(initiator)"** 입니다. 방을 만들려면
RoomID 를 알아야 하고 RoomID 는 그 집 월패드에만 있으므로, **기존 제어 권한과
같은 경계**를 승인에도 씁니다.

#### 서버 → 월패드

```json
// 등록 요청이 들어왔을 때 (즉시)
{ "method": "enroll.pending", "address": "1B101U", "pending": [ ... ] }

// 접속 직후, 놓친 대기가 있으면 (없으면 안 보냄)
{ "method": "enroll.list", "address": "1B101U", "pending": [ ... ] }
```

`pending` 배열의 각 항목:

```json
{
  "id":           12,                       // 승인/거절에 쓸 값
  "address":      "1B101U",
  "email":        "user@example.com",
  "complex":      "플루토 1단지",
  "phone":        "010-0000-0000",
  "sip_user":     "1101",
  "user_agent":   "Dalvik/2.1.0 (Linux; ...)",   // 기기 구분용
  "ipaddress":    "203.0.113.5",
  "requested_at": "2026-08-29 06:12:03",
  "expires_at":   "2026-08-29 06:42:03"
}
```

`token` 과 `image` 는 싣지 않습니다 — 승인 화면이 쓸 일이 없고 `token` 은
FCM 자격입니다.

#### 월패드 → 서버

```json
{ "method": "enroll.list" }                    // 목록을 다시 달라

{ "method": "enroll.approve",
  "enrollmentId": 12, "canCall": true, "canControl": true }

{ "method": "enroll.reject", "enrollmentId": 12 }
```

> **`canCall` / `canControl` 을 안 보내면 둘 다 꺼짐입니다.** 등록만 되고 전화도
> 제어도 안 되는 상태가 됩니다. 반대로(기본 허용) 두지 않은 이유는, 그러면
> 실수 한 번이 그대로 권한 부여가 되기 때문입니다.

응답은 처리 후의 목록을 함께 실어 옵니다.

```json
{ "method": "enroll.approve", "enrollmentId": 12, "ok": true, "pending": [ ... ] }
{ "method": "enroll.approve", "enrollmentId": 12, "ok": false,
  "error": "home_full", "message": "..." , "pending": [ ... ] }
```

`ok:false` 의 `error` 는 `not_found`(이미 처리됐거나 만료) 또는 `home_full`
(4대가 찼다) 입니다.

### 3-4. 월패드 승인 화면

- **대기 목록** — `email` 과 `user_agent` 로 기기를 구분하게. 이 둘이 사용자가
  "내 폰이 맞나" 를 판단할 유일한 단서입니다
- **통화 / 제어를 따로** 고를 수 있게. 한쪽만 주는 경우가 실제로 있습니다
  (예: 부모님 폰은 전화만)
- **남은 시간** — `expires_at`
- **거절**
- **등록된 기기 목록과 해지** — 4대가 차면 새 등록이 막히므로, 지우는 길이
  월패드에 있어야 합니다

> 등록된 기기의 조회·해지 API 는 아직 WebSocket 에 없습니다. 지금은 관리자
> 대시보드에만 있습니다. 월패드에서도 해야 한다면 `enroll.*` 과 같은 방식으로
> `device.list` / `device.revoke` / `device.permissions` 를 추가하면 됩니다.

---

## 남은 설계 과제

### 월패드 인증은 아직 없다

지금 월패드의 신원은 **"RoomID 를 알고 IoT 방을 만든 소켓"** 입니다.
`/register/complex_agents` 도 무인증입니다. 즉 RoomID 를 아는 사람은 승인도
할 수 있습니다.

`nginx/generate_nginx_conf.py` 에 `ssl_verify_client` 가 있고
`nginx/cert/{ca,client}` 도 있으므로, **월패드에 클라이언트 인증서를 발급**하는
것이 이 프로젝트에 가장 자연스러운 답입니다. 범위가 커서 분리했습니다.

### `can_control` 의 한계

**세대 단위로만** 강제됩니다. WebSocket 메시지(`ClientMessage`·`IoTMessage`)에
단말 식별자가 없어 "이 소켓이 어느 등록 행인가" 를 서버가 알 수 없기 때문입니다.

| | |
|---|---|
| 막는 것 | 제어를 아무에게도 허용하지 않은 세대로의 제어 |
| 못 막는 것 | 같은 세대 안에서 제어가 꺼진 단말 하나만 골라 막기 |

단말 단위로 하려면 핸드셰이크가 `uuid`(또는 등록 토큰)를 실어 와야 합니다.
`ClientMessage.extendParam` 이 비어 있으므로 프로토콜을 깨지 않고 넣을 수 있고,
앱·월패드·서버를 함께 고치면 됩니다.

### 등록 요청 자체는 여전히 무인증

`/register/mobile` 은 아무나 부를 수 있습니다. 승인이 없으면 권한이 없으므로
피해는 없지만, **월패드 승인 목록을 스팸으로 채울 수는 있습니다.** 대기 상한(4)과
만료(30분), 오래된 것 축출로 완화했을 뿐 없애지는 못했습니다.

없애려면 등록 요청에 신원이 필요합니다 — 계정 로그인(Firebase Auth 등) 또는
월패드가 발급하는 1회용 코드입니다. IP 단위 횟수 제한은 그보다 먼저 넣을 수
있는 값싼 방어입니다.
