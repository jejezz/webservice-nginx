# 단지가 여러 개일 때 — 앱은 어느 서버로 가야 하는가

서버는 **단지마다 한 대**씩 설치되는데, 앱은 앱스토어에서 **한 벌**로 배포됩니다.
그래서 앱은 자기가 어느 단지인지, 그 단지의 서버가 어디인지를 어디선가 받아
와야 합니다.

이 문서는 그 설계와, **지금 서버에 들어간 부분 / 아직 남은 부분**을 적습니다.

이 문서는 **왜 그렇게 정했는가**를 적습니다. 실제로 어떻게 하는지(디렉터리에서
주소를 받아 등록하고 통화하기까지)는 [enrollment.md](enrollment.md) 에 있습니다.

관련: [../ReadMe.md](../ReadMe.md) · [../ANDROID_API_GUIDE.md](../ANDROID_API_GUIDE.md) · [enrollment.md](enrollment.md)

## 구조

```
   앱 (앱스토어)                Firebase                 단지 서버
        │                          │                        │
        │  ① 지역 목록 읽기        │                        │
        ├─────────────────────────▶│                        │
        │  ② 지역 선택 → 단지 목록  │                        │
        ├─────────────────────────▶│                        │
        │     { name, complexId, host }                     │
        │                                                   │
        │  ③ 등록 (complexId + 등록 코드)                    │
        ├──────────────────────────────────────────────────▶│
        │                                    complexId 확인 ─┤
        │  ④ host 를 저장. 이후 Firebase 를 보지 않는다      │
```

`host` 는 **스킴이 없는 호스트 이름**입니다 — `c-a3f19c04.rtc.example.com`.
스킴은 쓰는 쪽이 붙입니다. REST 는 `https://<host>`, WebSocket 은 `wss://<host>`
입니다. 값 하나로 두 스킴을 다 만들어야 하므로 디렉터리에 스킴을 담지 않습니다.

## Firebase 에 둘 것 — 지역당 문서 하나

단지당 문서로 나누면 목록을 그릴 때 단지 수만큼 읽기가 발생합니다. **지역
문서 하나에 배열로** 담으면 앱이 몇 번 읽든 `2 reads` 로 끝납니다.

```
Firestore  regions/_index
{
  "regions": [
    { "code": "41135", "name": "성남시 분당구" },
    { "code": "41171", "name": "안양시 만안구" }
  ]
}

Firestore  regions/41135
{
  "name": "성남시 분당구",
  "updatedAt": 1756370000,
  "complexes": [
    {
      "complexId": "a3f19c04",
      "name": "플루토 1단지",
      "host": "c-a3f19c04.rtc.example.com",
      "minAppVersion": "1.2.0"
    }
  ]
}
```

`host` 에 `https://` 나 `wss://` 를 넣지 마세요. 넣으면 앱이 `wss://https://...`
를 만들게 되고, 그 단지는 **목록에는 보이는데 접속만 안 되는** 상태가 됩니다.
`npm run directory -- push` 가 올리기 전에 막습니다.

보안 규칙:

```
match /regions/{doc} {
  allow read: if true;      // 아파트 이름·주소는 어차피 공개 정보다
  allow write: if false;    // 콘솔이나 Admin SDK 로만
}
```

**서버 자격이나 CA 개인키 같은 건 절대 여기 두지 않습니다.**

### 만드는 방법

**1. Firestore 를 켭니다**

Firebase 콘솔 → 빌드 → **Firestore Database** → 데이터베이스 만들기.
위치는 `asia-northeast3`(서울). 모드는 **프로덕션 모드**로 시작하고 규칙을 아래로
바꿉니다 (테스트 모드는 30일 뒤 전부 잠깁니다).

> Realtime Database 가 아니라 Firestore 입니다. 목록이 작아 둘 다 되지만,
> 지역별 문서와 문서 단위 보안 규칙이 이 구조에 맞습니다.

**2. 보안 규칙**

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

마지막 줄이 중요합니다 — 나중에 다른 컬렉션이 생겨도 기본이 잠김입니다.

**3. 내용을 올립니다**

콘솔에서 손으로 넣어도 되지만 단지가 늘면 오타가 납니다. 도구를 두었습니다.

```bash
cd services/websocket-relay
cp tools/directory.example.json tools/directory.json   # 편집
npm run directory -- push tools/directory.json --dry-run
npm run directory -- push tools/directory.json
```

올리기 전에 **전부 검사합니다** — 절반만 올라가면 앱이 목록에는 있는데 열 수
없는 단지를 보게 되므로, 하나라도 문제가 있으면 아무것도 쓰지 않습니다.

```
· complexId 는 소문자 16진수 8자여야 합니다 — ZZZ
· complexId 가 겹칩니다 — a3f19c04 (regions[0].complexes[1] 와 중복)
· name 이 없습니다.
· host 는 스킴 없는 호스트 이름이어야 합니다 (https:// · wss:// · 경로 · 끝의 / 를 빼세요) — https://c-a3f19c04.rtc.example.com
```

반영은 한 번의 batch 로 합니다. `updatedAt` 은 올리는 쪽 시계를 믿지 않고
서버 시각(`serverTimestamp`)으로 넣습니다.

| 명령 | 하는 일 |
|---|---|
| `npm run directory -- check` | 자격과 연결만 확인. 아무것도 쓰지 않음 |
| `npm run directory -- pull` | 지금 올라가 있는 내용 |
| `npm run directory -- push <파일>` | 올림 (`--dry-run` 으로 미리 보기) |

**4. `complexId` 를 서버 `.env` 와 맞춥니다**

디렉터리의 `complexId` 와 그 단지 서버 `.env` 의 `COMPLEX_ID` 가 **같아야**
합니다. 다르면 앱이 등록할 때 서버가 `403 complex_mismatch` 로 거절합니다.

```bash
openssl rand -hex 4     # 새 단지 ID 생성
```

### 앱이 시작할 때마다 읽으면 안 됩니다

등록이 끝나면 `host` 를 앱에 저장하고 **다시 읽지 않습니다.** 다시 읽는 경우는
두 가지뿐입니다 — 등록이 실패할 때, 사용자가 "단지 변경" 을 할 때.

이유가 있습니다. 이 프로젝트는 **푸시(FCM)와 단지 발견이 같은 Firebase 프로젝트**
를 씁니다. 시작할 때마다 읽으면 그 프로젝트가 흔들릴 때 **이미 등록된 사용자까지**
앱이 뜨지 않습니다. 캐시해 두면 새로 등록하는 사람만 영향을 받습니다.

(2026-08-28 에 이 프로젝트의 FCM 서비스 계정이 무효가 된 것을 발견했습니다 —
 `invalid_grant: account not found`. 실제로 일어나는 일입니다.)

## 단지 ID

**32비트를 소문자 16진수 8자로** 적습니다. 생성:

```bash
openssl rand -hex 4
```

- **해시가 아닙니다.** 이름에서 유도하면 명칭이 바뀔 때 ID 가 바뀌고, 등록된
  단말이 전부 자기 단지를 잃습니다. 중앙에서 **할당**합니다.
- 16비트(65,536)는 전수 조회가 몇 초라 안 됩니다. 64비트는 필요 없습니다 —
  서버는 자기 값 하나와 비교만 하므로 계산이 없고, 목록이 어차피 공개라
  숨겨서 얻는 보안도 없습니다. 충돌 회피와 다루기 편함만 보면 32비트로 충분합니다.
- 서버는 `.env` 의 `COMPLEX_ID` 로 자기 값을 고정합니다. **한 번 정하면
  바꾸지 않습니다.**

### ⚠️ 단지 ID 는 인증이 아닙니다

앱이 Firebase 에서 받아 오는 값이므로 **앱을 깐 누구나 알 수 있습니다.**
Firebase 클라이언트 API 키는 설계상 비밀이 아니고(구글이 명시합니다), 보안은
Security Rules 로만 걸리는데 앱이 읽어야 하니 규칙은 열려 있어야 합니다.

그래서 단지 ID 는 **"이 등록이 이 서버로 올 것이 맞나"** 를 보는 라우팅 키입니다.
**"이 사람이 그 집 사람인가"** 는 가리지 못합니다.

## ✅ 서버에 들어간 것 (2026-08-28)

| | |
|---|---|
| `rtc_mobiles.complex_id` | [schema/004-complex-id.sql](../schema/004-complex-id.sql) |
| 인덱스 `(complex_id, address, active)` | EXPLAIN 으로 `ref: const,const,const` 확인 |
| `.env` 의 `COMPLEX_ID` | 기동 로그에 표시. 비우면 검사하지 않음 |
| `/register` 검증 | 없음 → 서버 값으로 채움 · 다름 → 403 · 형식 오류 → 400 |
| 푸시 대상 조회 | `AND complex_id = ?` (WS 방문자 호출 · `/room/invite`) |
| `receiver` 의 `@` 뒤 | 단지 ID 형식이면 검사, 옛 호스트 이름이면 무시 |
| 기동 시 backfill | `complex_id IS NULL` 인 행을 이 서버 값으로 |
| 대시보드 | 개요에 단지 ID, 단말 목록에 열 + 다른 단지 경고 |

`complex`(이름)는 표시용으로 그대로 둡니다.

### `receiver` 에 단지를 싣는 법

인터폰이 보내는 `rtc:1B101U@호스트` 에서 서버는 지금까지 **`@` 뒤를 버리고
있었습니다**. 그 빈자리에 단지 ID 를 넣으면 프로토콜을 깨지 않고 실을 수 있습니다.

```
rtc:1B101U@a3f19c04     ← 이 단지. 통과
rtc:1B101U@deadbeef     ← 다른 단지. 거부 ("this server serves another complex")
rtc:1B101U@호스트이름    ← 옛 형식. 판단하지 않고 통과
```

단지 ID 형식(16진수 8자)일 때만 값으로 인정하므로, 지금 도는 인터폰을 그대로
두고 하나씩 옮길 수 있습니다.

## 남은 것 / 끝난 것

셋 중 둘이 끝났습니다. 아래 1·2 는 기록으로 남깁니다 — **무엇을 어떻게 정했는지**가
나중에 같은 고민을 다시 하지 않게 해 줍니다.


### 1. ~~등록 인증~~ ✅ 끝났습니다 — 다만 방식이 다릅니다

여기에는 **등록 코드**(관리사무소·인터폰이 발급하는 일회용 코드)가 필요하다고
적혀 있었습니다. 실제로는 **월패드 승인**으로 풀었습니다
([../schema/005-enrollment.sql](../schema/005-enrollment.sql)).

```
등록          →  mobile_enrollments (대기표). 아무 권한 없음
월패드 승인    →  rtc_mobiles 로 이동. can_call / can_control 이 켜진다
```

승인 전 단말은 `rtc_mobiles` 에 아예 없으므로 **착신 대상 조회에 잡히지
않습니다.** "단지 + 동 + 호 세 값만 알면 그 집 영상을 받는다" 는 구멍이
닫혔습니다.

**등록 코드보다 나은 선택이었습니다.** 코드는 발급·전달·만료·소진을 운영해야
하고 사람이 옮겨 적다 새어 나갑니다. 월패드는 **그 집 안에 물리적으로 있는
것**이라, 증명하려는 사실("이 사람이 그 집 사람인가")과 수단이 같은 자리에
있습니다. 표도 하나 덜 만듭니다.

`/register` 자체는 여전히 무인증입니다. 아무나 대기표에 행을 만들 수는 있어서,
그건 표 크기 상한으로 막습니다 (같은 파일 참고). 권한이 나가지 않으므로
도배는 성가심이지 위험이 아닙니다.

### 2. ~~TLS — 자체 도메인과 공인 인증서~~ ✅ 끝났습니다 (2026-08-29)

공인 인증서로 옮겼습니다. **앱이 CA 를 미리 심지 않아도 됩니다.**

```
issuer  : Let's Encrypt          (공인)
CN/SAN  : c-a3f19c04.rtc.zoomon.art
검증    : Verify return code 0   ← 시스템 신뢰 저장소만으로
갱신    : certbot.timer active   ← 90일마다 자동
```

절차와 운영은 [../../../nginx/public_ca/README.md](../../../nginx/public_ca/README.md)
에 있습니다. 요점만:

- **단지마다 인증서 하나.** 와일드카드로 묶지 않습니다 — 같은 개인키가 모든
  단지에 복사되고, 갱신 때마다 전 단지에 실어 나르는 파이프라인을 직접
  운영하게 됩니다.
- **사설 CA 를 Firestore 로 배포하는 대안은 버렸습니다.** 단지마다 CA 를
  운영하는 장기 비용이 큽니다.
- **mTLS 는 별개로 남습니다.** 공인 CA 는 "서버가 진짜인가" 만 풉니다.
  "이 기기가 진짜인가" 는 사설 CA 가 계속 맡되, 공인 인증서가 생긴 덕분에
  단말 인증서를 안전하게 내려보낼 통로가 생겼습니다.

이름은 설계대로 `c-<complexId>.rtc.<도메인>` 입니다. 단지 ID 는 서버 `.env` 의
`COMPLEX_ID` 와 같은 값이라 인증서 이름만 보고도 어느 단지인지 압니다.

남은 것은 **도메인**입니다. 지금은 개인 도메인(`zoomon.art`)으로 운용 중이고,
배포용(`ptype.co.kr`)으로 옮길 때는 **네임서버를 옮기지 말고** `rtc.` 하위 존만
위임하세요 — apex 에 회사 메일(mailplug)과 SPF 가 걸려 있어, 레코드를 하나라도
빠뜨리면 회사 메일이 죽습니다.

### 3. 앱 쪽

절차는 [enrollment.md §2](enrollment.md#2-모바일-앱이-해야-할-것) 에 있습니다.
여기는 목록만 둡니다.

- 지역 → 단지 선택 화면
- `host` 캐시, 실패했을 때만 디렉터리 재조회
- 저장한 `host` 앞에 스킴을 붙여 쓰기 — REST `https://<host>`, WS `wss://<host>`
- `/register` 에 `complexId` 를 함께 보내기
- 403 `complex_mismatch` 를 받으면 단지 선택으로 되돌리기

## 결정 기록

| 정한 것 | 이유 |
|---|---|
| 디렉터리를 Firebase 로 | 이미 스택에 있음. 운영할 서버가 늘지 않음 |
| 지역당 문서 하나 | 단지당 문서면 목록 한 번에 단지 수만큼 읽기 |
| 32비트 hex 8자 | 서버는 상수 비교뿐. 충돌 회피와 가독성만 보면 됨 |
| 이름이 아니라 코드 | 명칭 변경 때 등록이 통째로 끊기는 것을 막음 |
| ID 를 인증으로 쓰지 않음 | 앱이 읽는 값이라 비밀이 될 수 없음 |
| `COMPLEX_ID` 없으면 검사 안 함 | 단지가 하나인 지금 배치를 그대로 돌리기 위해 |
| `@` 뒤가 옛 형식이면 무시 | 지금 도는 인터폰을 깨지 않고 옮기기 위해 |
| 공인 인증서(Let's Encrypt) | 앱이 CA 를 심지 않아도 됨. 단지가 늘어도 앵커가 고정 |
| 등록 코드가 아니라 월패드 승인 | 그 집 안에 물리적으로 있는 것이 월패드뿐. 운영할 코드 체계가 없음 |
| 단지마다 인증서 하나 | 개인키가 단지 밖으로 나가지 않음. 갱신이 각자 자동 |
| `host` 에 스킴을 담지 않음 | 같은 값으로 `https://` 와 `wss://` 를 둘 다 만들어야 함 |
