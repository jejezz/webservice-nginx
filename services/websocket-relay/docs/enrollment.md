# 단말 등록 — 디렉터리에서 통화까지

앱이 **자기 단지 서버를 찾아** 등록하고 통화할 수 있게 되기까지의 전 과정입니다.
서버 쪽은 다 들어갔고, 남은 것은 앱과 월패드 화면입니다.

1. [Firestore 단지 디렉터리 적용](#1-firestore-단지-디렉터리-적용) — 운영
2. [모바일 앱이 해야 할 것](#2-모바일-앱이-해야-할-것) — 앱
3. [월패드가 해야 할 것](#3-월패드가-해야-할-것) — 월패드

설계 배경(왜 Firestore인가, 왜 단지 ID가 인증이 아닌가)은
[multi-complex.md](multi-complex.md) 에 있습니다. 이 문서는 **어떻게 하는가**만
다룹니다. API 사전은 [../ANDROID_API_GUIDE.md](../ANDROID_API_GUIDE.md) 입니다.

## 전체 흐름

```
  Firestore                    단지 서버                    앱
      │                            │                        │
      │ ① regions/_index           │                        │
      ├───────────────────────────────────────────────────▶ │  지역 목록
      │ ② regions/41135            │                        │
      ├───────────────────────────────────────────────────▶ │  단지 목록
      │    { complexId, host, name }                        │
      │                            │                        │
      │           ③ POST /relay/register/mobile             │  host 에 스킴을
      │                            │◀───────────────────────┤  붙여 접속
      │                            │  202 pending           │
      │                            ├───────────────────────▶│  대기 화면
      │                            │                        │
      │          ④ 월패드가 승인    │                        │
      │                            │  FCM: approved         │
      │                            ├───────────────────────▶│
      │                            │                        │
      │           ⑤ 재등록 (+ CSR) │                        │
      │                            │◀───────────────────────┤
      │                            │  200 + clientCert      │
      │                            ├───────────────────────▶│  인증서 저장
      │                            │                        │
      │           ⑥ wss://<host>/relay/rtc                  │  통화
      │                            │◀──────────────────────▶│
```

**①②는 등록할 때와 실패했을 때만 합니다.** 시작할 때마다 읽으면 안 됩니다
([이유](#시작할-때마다-읽지-마세요)).

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
| 공인 인증서 (Let's Encrypt) | ✅ 앱이 CA 를 심지 않아도 됨 |
| 클라이언트 인증서 발급 (mTLS) | ✅ 발급까지. **아직 강제하지 않음** ([2-6](#2-6-클라이언트-인증서-받기)) |
| 디렉터리에서 단지 고르기 | ❌ 앱에 만들어야 함 ([2-0](#2-0-단지를-고르고-주소를-얻는다)) |
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
- **Native 모드** ← 아래 참고. 여기서 잘못 고르면 되돌리기 번거롭습니다
- 보안 규칙: **프로덕션 모드**로 시작 (테스트 모드는 30일 뒤 전부 잠깁니다)
- Realtime Database 가 아니라 **Firestore** 입니다

> ⚠️ **Native 모드 / Datastore 모드**
>
> 데이터베이스를 만들 때 고르는 값인데, 나중에 이 도구를 돌릴 때에야 잘못을
> 알게 됩니다. Datastore 모드로 만들면 이렇게 실패합니다.
>
> ```
> 9 FAILED_PRECONDITION: The Cloud Firestore API is not available for
> Firestore in Datastore Mode database projects/<프로젝트>/databases/(default).
> ```
>
> Firestore 클라이언트 SDK(= `firebase-admin` 의 `firestore()`)는 **Native
> 모드에서만** 동작합니다. GCP 콘솔에서 만들면 Datastore 모드가 기본으로 잡히는
> 경우가 있습니다.
>
> **고치는 법 ① — 모드를 바꾼다 (비어 있을 때)**
>
> ```bash
> gcloud firestore databases update --type=firestore-native --database='(default)'
> ```
>
> - 데이터가 **하나라도 있으면 거부됩니다.** 전부 지우고 다시 하세요
> - 몇 분 걸리고 그동안 쓰기가 거부됩니다
> - `gcloud` 를 깔지 않았다면 브라우저의 **Cloud Shell** 에서 그대로 실행하면 됩니다
>
> **고치는 법 ② — 지우고 다시 만든다**
>
> ```bash
> gcloud firestore databases delete --database='(default)'
> # 삭제한 ID 는 약 5분 뒤에 다시 쓸 수 있습니다
> gcloud firestore databases create --database='(default)' \
>        --location=asia-northeast3 --type=firestore-native
> ```
>
> ①과 결과는 같습니다. 비어 있다면 ①이 더 간단합니다 — 삭제도 대기도 없습니다.
> **콘솔에서 다시 만들지 마세요.** 애초에 Datastore 모드가 된 경로가 그쪽이라
> 같은 실수를 반복하기 쉽습니다. `--type` 을 명시하는 편이 확실합니다.
>
> **고치는 법 ③ — Native 모드 DB 를 따로 만든다**
>
> 기본 DB 를 Datastore 모드로 쓰고 있어 건드릴 수 없을 때입니다.
>
> ```bash
> gcloud firestore databases create --database=directory \
>        --location=asia-northeast3 --type=firestore-native
> ```
>
> 그리고 도구에 그 이름을 줍니다. `.env` 에 적어 두면 매번 붙이지 않아도 됩니다.
>
> ```bash
> # .env 에 한 번 적어 둔다
> FIRESTORE_DATABASE_ID=directory
> ```
>
> ```bash
> # 또는 그때만 앞에 붙인다 (.env 값보다 우선한다)
> FIRESTORE_DATABASE_ID=directory npm run directory -- push tools/directory.json
> ```
>
> `npm run directory -- check` 가 실패하면 이 안내를 그대로 출력합니다.

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

`host` 는 **스킴 없는 호스트 이름**입니다. 앞에 `https://` 나 `wss://` 를 넣지
마세요 — 아래 `<host>` 가 나오는 자리는 전부 이 값을 그대로 끼워 넣는 자리이고,
스킴이 섞여 있으면 `wss://https://...` 가 됩니다. `push` 가 올리기 전에 막습니다.

### 1-4. 올린다

콘솔에서 손으로 넣어도 되지만 단지가 늘면 오타가 납니다. 도구가 있습니다.

```bash
cd services/websocket-relay
cp tools/directory.example.json tools/directory.json   # 편집
npm run directory -- check                             # 자격·연결만 확인

# 기본 DB 가 Datastore 모드라 별도 DB 를 만든 경우 (1-1 참고).
# .env 의 FIRESTORE_DATABASE_ID 를 읽는다. 앞에 붙이면 그 값이 이긴다.
FIRESTORE_DATABASE_ID=directory npm run directory -- check
npm run directory -- push tools/directory.json --dry-run
npm run directory -- push tools/directory.json
npm run directory -- pull                              # 올라간 내용 확인
```

올리기 전에 **전부 검사하고**, 하나라도 문제가 있으면 아무것도 쓰지 않습니다.

#### 지역을 뺐을 때

`push` 는 덮어쓸 뿐 **지우지 않습니다.** 파일에서 지역을 하나 빼고 올리면 그
문서가 Firestore 에 그대로 남습니다. `_index` 에는 없으므로 **앱에는 안 보이는데
DB 에는 있는** 상태가 되고, 콘솔을 열어 본 사람은 살아 있는 단지로 오해합니다.

그래서 push 가 끝나면 남은 것을 알려 줍니다.

```
⚠️  파일에 없는 지역 문서가 2개 남아 있습니다:
      11680  서울시 강남구
   _index 에 없으므로 앱에는 보이지 않습니다. 지우려면 --prune 을 주세요.
```

지우려면 `--prune` 을 줍니다. 자동으로 지우지 않는 것은 의도적입니다 — 일부만
담은 파일을 실수로 올렸을 때 나머지가 조용히 사라지는 편이 더 위험합니다.
절반만 올라가면 앱이 목록에는 있는데 열 수 없는 단지를 보게 되기 때문입니다.

#### ⚠️ 콘솔에서 `regions/_index` 를 지우지 마세요

지역 목록을 담은 문서입니다. 지우면 **앱이 첫 화면부터 진행하지 못합니다** —
지역 문서(`regions/41135`)는 지역 코드를 이미 알아야 읽을 수 있어서, 단지
데이터가 다 남아 있어도 앱에게는 없는 것과 같습니다.

실제로 한 번 일어났습니다. 그래서 `check` 가 내용까지 봅니다.

```bash
npm run directory -- check
```

```
⚠️  디렉터리 내용에 문제가 있습니다:
      regions/_index 가 없습니다. 앱이 지역 목록을 받을 수 없습니다.
   대부분 다시 올리면 고쳐집니다: npm run directory -- push tools/directory.json
```

`_index` 유무, `_index` 가 가리키는 지역 문서가 실제로 있는지, 반대로 `_index` 에
없는 문서가 남아 있는지를 봅니다. 문제가 있으면 **종료 코드 1** 이라 크론에도
걸 수 있습니다. 다시 push 하면 복구됩니다.

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

### 2-0. 단지를 고르고 주소를 얻는다

**여기서부터가 시작입니다.** 앱에는 서버 주소가 들어 있지 않습니다 — 단지마다
다르기 때문입니다. Firestore 에서 받아 옵니다.

읽기 전용이고 로그인이 필요 없습니다 (`allow read: if true`). 그래서 단지를
고르는 화면은 로그인 전에 그릴 수 있습니다.

**① 지역 목록** — 문서 하나만 읽습니다.

```
regions/_index
{ "regions": [ { "code": "41135", "name": "성남시 분당구" }, ... ] }
```

**② 그 지역의 단지 목록** — 지역을 고르면 문서 하나를 더 읽습니다.

```
regions/41135
{
  "name": "성남시 분당구",
  "complexes": [
    { "complexId": "a3f19c04", "name": "플루토 1단지",
      "host": "c-a3f19c04.rtc.zoomon.art", "minAppVersion": "1.0.0" }
  ]
}
```

**단지 수가 몇이든 읽기는 2회로 끝납니다.** 단지당 문서로 나누지 않은 이유입니다.

**③ 고른 단지의 `complexId` 와 `host` 를 저장합니다.** 이후 등록과 통화에 씁니다.

```kotlin
val db = Firebase.firestore
val index = db.collection("regions").document("_index").get().await()
// 지역 선택 후
val region = db.collection("regions").document(code).get().await()
val complexes = region.get("complexes") as List<Map<String, Any>>
// 단지 선택 후 저장
prefs.host = complex["host"] as String            // "c-a3f19c04.rtc.zoomon.art"
prefs.complexId = complex["complexId"] as String  // "a3f19c04"
```

#### `host` 에는 스킴이 없습니다

**앱이 붙입니다.** 값 하나로 두 가지를 만들어야 하기 때문입니다.

```kotlin
val rest = "https://${prefs.host}/relay"        // REST
val ws   = "wss://${prefs.host}/relay/rtc"      // WebSocket
```

포트도 붙이지 않습니다. 표준 443 입니다.

> `host` 에 `https://` 가 들어 있는 경우는 없습니다 — 올릴 때 도구가 막습니다.
> 혹시 들어 있다면 그건 디렉터리 데이터가 잘못된 것이니 `wss://https://...`
> 같은 것을 만들지 말고 오류로 처리하세요.

#### 시작할 때마다 읽지 마세요

등록이 끝나면 `host` 를 저장하고 **다시 읽지 않습니다.** 다시 읽는 경우는
두 가지뿐입니다.

| 언제 | 왜 |
|---|---|
| 접속·등록이 실패할 때 | 단지 서버 주소가 바뀌었을 수 있습니다 |
| 사용자가 "단지 변경" 을 할 때 | 이사 등 |

**이 재조회가 중요합니다.** 도메인이나 주소를 옮겨도 앱이 스스로 복구할 수 있는
유일한 경로입니다. 이게 없으면 주소를 바꾸는 순간 그 단지 전체가 앱을 새로
배포하기 전까지 복구되지 않습니다.

시작할 때마다 읽으면 안 되는 이유는 따로 있습니다 — 푸시(FCM)와 단지 발견이
**같은 Firebase 프로젝트**를 씁니다. 그 프로젝트가 흔들릴 때 시작할 때마다
읽으면 **이미 등록된 사용자까지** 앱이 뜨지 않습니다. 캐시해 두면 새로 등록하는
사람만 영향을 받습니다.

#### 서버가 맞는지는 저절로 확인됩니다

서버는 Let's Encrypt 공인 인증서를 씁니다. **CA 를 앱에 심을 필요가 없고,
커스텀 TrustManager 도 필요 없습니다.** 기본 `OkHttpClient()` 로 충분합니다.

인증서 핀닝은 **하지 마세요.** 90일마다 갱신되며 공개키가 바뀝니다 — 핀을 박으면
분기마다 앱이 통째로 접속 불가가 됩니다. 자세히는
[../ANDROID_API_GUIDE.md](../ANDROID_API_GUIDE.md) 의 TLS 절.

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

### 2-6. 클라이언트 인증서 받기

서버가 단말에게 **클라이언트 인증서**를 발급합니다. mTLS 로 "우리 앱이 맞나" 를
가리는 데 씁니다.

> **지금은 없어도 다 됩니다.** 서버가 `verify_client = optional` 이라 인증서
> 없이도 통과합니다. 앱이 준비되고 돌고 있는 단말이 한 번씩 받아 간 뒤에 켤
> 예정입니다. **미리 넣어 두면 그때 끊기지 않습니다.**

**개인키는 단말 밖으로 내보내지 않습니다.** Android Keystore 안에서 만들고,
올려 보내는 것은 CSR(공개), 내려받는 것은 인증서(공개)뿐입니다.

**① 키쌍과 CSR 을 만든다** — 한 번만 합니다. 갱신 때도 같은 키를 씁니다.

```kotlin
val kpg = KeyPairGenerator.getInstance("RSA", "AndroidKeyStore")
kpg.initialize(KeyGenParameterSpec.Builder("relay-client", PURPOSE_SIGN)
    .setDigests(KeyProperties.DIGEST_SHA256)
    .setSignaturePaddings(KeyProperties.SIGNATURE_PADDING_RSA_PKCS1)
    .build())
val pair = kpg.generateKeyPair()
// CSR 은 BouncyCastle(PKCS10CertificationRequestBuilder) 등으로 만든다.
```

**② 등록할 때 함께 보낸다** — 2-1 의 본문에 `csr` 한 칸을 더합니다.

```json
{ "uuid": "...", "email": "...", "complex": "...", "address": "1B101U",
  "token": "...", "csr": "-----BEGIN CERTIFICATE REQUEST-----\n..." }
```

**③ 승인된 뒤 받는다** — `200 approved` 응답에 실려 옵니다.

```json
{ "status": "approved", "clientCert": "-----BEGIN CERTIFICATE-----\n..." }
```

`202 pending` 일 때는 오지 않습니다. **승인된 단말에만 발급**하기 때문입니다.
그래서 순서는 늘 이렇습니다 — 등록(202) → 월패드 승인 → 재등록(200 + 인증서).
2-3 에서 승인 FCM 을 받은 뒤 한 번 더 등록하면 그 자리에서 받습니다.

| 응답 필드 | 뜻 |
|---|---|
| `clientCert` | 발급됨. Keystore 의 키와 짝지어 저장 |
| `clientCertError` | 발급 실패. **등록 자체는 성공이다** — 무시하고 진행 |
| (없음) | `csr` 을 안 보냈거나 아직 승인 전 |

**④ 90일마다 갱신한다.** 유효기간이 90일입니다. 만료 전에 `csr` 을 다시 실어
등록하면 새 인증서가 옵니다 — **발급과 갱신이 같은 경로**입니다.

```kotlin
if (cert == null || cert.notAfter.before(Date(now + 14.days))) {
    body.put("csr", csrPem)   // 없거나 2주 안에 만료면 다시 받는다
}
```

**⑤ 접속할 때 제시한다.**

```kotlin
val km = KeyManagerFactory.getInstance("X509").apply { init(keyStore, null) }
OkHttpClient.Builder()
    .sslSocketFactory(sslContext(km).socketFactory, systemTrustManager)
    .build()
```

> **인증서는 "우리 앱이 맞나" 까지만 말합니다.** 어느 세대인지, 통화 권한이
> 있는지는 서버가 DB 로 판단합니다. A단지에서 받은 인증서로 B단지 서버에 TLS
> 접속은 되지만 `403 complex_mismatch` 를 받습니다 — 정상입니다.

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

> **월패드 없이 앱을 시험할 때** — 관리 대시보드의 `홈넷 장치 → 장치 추가` 로
> 세대를 손으로 넣을 수 있습니다. 규칙은 이 경로와 같고(동/호 형식, 단지 채우기),
> `ipaddress` 만 비워 둘 수 있습니다 — 진짜 월패드가 붙으면 제 값으로 바뀝니다.
> 시험이 끝나면 같은 화면에서 지우세요. 이 표에 있는 세대는 그 집 사람이 아닌
> 단말도 **등록 대기까지는** 올라올 수 있게 하기 때문입니다 (승인 전까지 권한은
> 없습니다).

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
