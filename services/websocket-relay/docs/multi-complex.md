# 단지가 여러 개일 때 — 앱은 어느 서버로 가야 하는가

서버는 **단지마다 한 대**씩 설치되는데, 앱은 앱스토어에서 **한 벌**로 배포됩니다.
그래서 앱은 자기가 어느 단지인지, 그 단지의 서버가 어디인지를 어디선가 받아
와야 합니다.

이 문서는 그 설계와, **지금 서버에 들어간 부분 / 아직 남은 부분**을 적습니다.

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

## ❗ 아직 남은 것

### 1. 등록 인증 (가장 중요)

`/register` 는 **인증이 없습니다.** 지금은 서버가 NAT 뒤 DDNS 이름 하나로만
알려져 있어 가려져 있을 뿐입니다. **디렉터리가 단지 주소를 공개하는 순간 그
가림막이 사라집니다** — 아무나 `1B101U` 로 등록해 그 집 방문자 호출과 영상을
받을 수 있습니다.

단지 ID 로는 막지 못합니다(위 참고). 필요한 것:

```
등록 코드   K7P2-9MXQ    관리사무소·인터폰 화면이 발급
                         일회용 · 만료 있음 · 서버가 소진 처리
                         사람이 치는 값이라 오타에 강해야 한다
                         (Crockford Base32 + 체크문자 1자, 8자 정도)
```

QR 로 만들면 **인터폰 화면**에 띄우는 것이 자연스럽습니다 — 그 집에 물리적으로
들어갈 수 있는 사람만 스캔합니다.

표가 하나 더 필요합니다 (`rtc_enroll_codes`: code, address, expires_at, used_at).

### 2. TLS — 자체 도메인과 공인 인증서

**Firebase 는 이 문제를 해결하지 않습니다.** 디렉터리는 "주소를 어디서 받아
오나" 만 풀고, "그 주소를 앱이 신뢰할 수 있나" 는 남습니다.

지금 인증서는 사설 CA 가 발급한 것입니다:

```
issuer  : DevCA Root  (사설)
CN/SAN  : jejezzhome.iptime.org  (이 단지 전용 DDNS)
```

단지마다 CA 가 다르면 앱이 고정된 신뢰 앵커를 가질 수 없습니다. 등록 **전에**
CA 를 받아야 하는데 그 시점엔 신뢰할 통로가 없습니다.

- **권장**: 도메인을 소유하고 `c-<complexId>.rtc.<도메인>` 으로 단지마다
  서브도메인. DDNS 갱신은 단지 서버가. Let's Encrypt **HTTP-01**(80 포트만
  포워딩) 로 공인 인증서 → 앱은 시스템 신뢰 저장소만 씁니다.
  DNS-01 은 단지마다 DNS API 키를 쥐게 되니 `_acme-challenge` 위임으로 범위를
  좁히거나 클라우드에서 발급해 받아 가게 하세요.
- **대안**: CA 인증서를 Firestore 로 배포. 전달 경로(구글 TLS)는 믿을 수 있어
  기술적으로 성립하지만, 그때부터 단지마다 CA 를 **운영**하게 됩니다 — 발급·
  만료·교체·폐기를 도구 없이. 장기 비용이 큽니다.

### 3. 앱 쪽

- 지역 → 단지 선택 화면
- `host` 캐시, 실패했을 때만 디렉터리 재조회
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
