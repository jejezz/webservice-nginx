# 운영판 인계 — DB 와 클라이언트가 무엇이 달라지는가

`webservice-nginx/services/websocket-relay`(실제 단지에서 도는 판)를 이 저장소로
그대로 옮겼다. 두 저장소는 공통 조상이 없어 git 으로 합칠 수 없었고, 돌고 있는
쪽을 정본으로 두고 파일을 통째로 가져왔다. 이 문서는 그 과정에서 **데이터베이스와
클라이언트가 어떻게 달라지는지**만 적는다. 코드 배치가 어떻게 옮겨졌는지는
`git show` 로 볼 수 있으므로 여기 적지 않는다.

한 줄 요약: **DB 는 버리고 새로 만든다. 앱은 등록 흐름이 바뀌므로 반드시 함께
올려야 한다. 월패드의 WebSocket 은 그대로 붙는다.**

---

## 1. 데이터베이스

### 1.1 DB 자체가 바뀐다

| | 이전 | 이후 |
|---|---|---|
| 스키마 이름 | `websocket_relay` | `rtc_relay` |
| 스키마 적용 | 부팅할 때 서버가 `src/db/schema.sql` 을 실행 | `npm run db:migrate` 가 `schema/*.sql` 을 이름순으로 실행 |
| 이력 | 없음 | `schema_migrations` 표에 적용한 버전이 남는다 |
| 비밀번호 | `.env` 의 `DB_PASSWORD` | `.env` 가 없으면 `DB_PASSWORD_FILE` (기본 `../../database/secrets/jyahn.pw`) |

**서버는 이제 런타임에 DDL 을 돌리지 않는다.** 부팅할 때마다 `CREATE TABLE` 을
실행하면 스키마의 실제 상태를 아무도 알 수 없게 되기 때문이다. 표를 만드는 것은
`npm run db:migrate` 하나뿐이다.

이 장비의 `websocket_relay` 는 0행이었으므로 옮길 데이터가 없다. 그대로 버린다.

```bash
mysql -h127.0.0.1 -ujyahn -p -e "DROP DATABASE IF EXISTS websocket_relay; CREATE DATABASE rtc_relay CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

```bash
npm run db:migrate && npm run db:status
```

> 실데이터가 있는 장비였다면 `rtc_mobiles`·`rtc_homenet` 두 표를 덤프해 옮긴 뒤
> 마이그레이션을 돌려야 한다. 새로 생긴 열은 전부 NULL 또는 기본값을 갖도록
> 되어 있어 옛 행이 그대로 살아난다 — 다만 `can_call` 이 기본 0 이라 **옛 단말은
> 전부 통화 불가 상태로 들어온다.** 아래 1.3 을 보라.

### 1.2 표가 어떻게 달라지나

`rtc_mobiles` 에 붙은 열 (마이그레이션 002~009):

| 열 | 넣은 곳 | 무엇 |
|---|---|---|
| `sip_user` | 002 | SIP 내선. 인터폰 착신 푸시가 이 값으로 단말을 찾는다 |
| `token_updated_at`, `push_error`, `push_failed_at` | 003 | FCM 발송 결과. 죽은 토큰을 스스로 비활성으로 내린다 |
| `complex_id` | 004 | 단지 식별자(hex 8자). 표시용 `complex` 와 달리 바뀌지 않는다 |
| `can_call`, `can_control` | 005 | 통화 수신·홈넷 제어 허용. **기본 0(불가)** |
| `approved_at`, `approved_by` | 005 | 승인 시각과 주체 |
| `cert_serial`, `cert_issued_at`, `cert_expires_at` | 006 | 발급한 클라이언트 인증서(mTLS) 추적 |
| `sip_seq` | 007 | 세대 안의 단말 순번 (00 월패드 · 01~04 모바일) |
| `janus_token` | 009 | 이 단말만의 Janus 토큰. Janus 는 메모리에만 갖고 있어 여기가 원본이다 |

새 표:

- **`mobile_enrollments`** (005) — 아직 승인되지 않은 등록 요청이 여기서 기다린다.
  `expires_at` 이 지나면 사라진다. 승인되면 `rtc_mobiles` 로 옮겨진다.

`rtc_homenet` 변경:

- `complex_id` 추가 (005). 서버가 자기 단지 값으로 채운다.
- `complex`(표시 이름)이 **NULL 허용으로 바뀌고 더는 쓰이지 않는다** (008).
  단지는 서버가 안다 — 이 서버에 온 등록은 정의상 이 서버의 단지다.
- 유일 키가 `(complex, building, unit)` → `(complex_key, building, unit)` 로 바뀐다.
  `complex_key` 는 `COALESCE(complex_id, '')` 를 담는 가상 열이다 (008).

인덱스 정리 (003, 004): `idx_rtc_mobiles_address` 와 `idx_rtc_mobiles_active` 를
합친 `idx_rtc_mobiles_address_active` 로 바꾸고, 단지까지 얹은
`idx_rtc_mobiles_complex_address_active` 를 더한다. 초인종이 울릴 때마다 도는
조회가 이 모양이기 때문이다.

### 1.3 ⚠️ `can_call` 이 기본 0 이라는 것의 뜻

이전 판은 `/register/mobile` 을 받으면 곧바로 `rtc_mobiles` 에 넣었다. 그래서
**단지 + 동 + 호 세 값만 알면 그 집 초인종 영상·음성을 받고 방문자와 대화까지
됐다.** 셋 중 비밀은 하나도 없다.

새 판은 그 집 안의 월패드가 인정해야 들어온다. 그 결과:

- 새로 등록하는 단말은 승인 전까지 `mobile_enrollments` 에 머무르고 푸시를 못 받는다.
- 마이그레이션으로 넘어온 옛 행은 `can_call = 0` 이라 **초대 푸시 대상에서 빠진다**
  (`routes/room.ts` 의 조회에 `can_call = 1` 이 들어 있다).

옛 단말을 그대로 살리려면 한 번 열어 줘야 한다. 이 장비는 0행이라 해당 없다.

```sql
UPDATE rtc_mobiles SET can_call = 1, can_control = 1, approved_at = NOW(), approved_by = 'migration';
```

### 1.4 다른 스키마에 손을 댄다

SIP 계정 발급을 켜면 이 서비스가 **`kamailio.subscriber`** 에 행을 쓴다
(`SIP_SUBSCRIBER_TABLE`). 같은 MariaDB 인스턴스의 다른 스키마이고, 접속 계정
하나가 두 스키마 권한을 갖는 구조다. Kamailio 가 없는 장비에서는
`SIP_PROVISION=false` 로 꺼 둔다 — 번호는 배정하되 계정은 만들지 않는다.

---

## 2. 클라이언트

### 2.1 그대로인 것

- **WebSocket 주소** — `/relay/rtc`, `/relay/iot`.
- **WebSocket 메시지 형식** — `ClientMessage`·`IoTMessage`·`ServerMessage` 의
  필드가 한 글자도 바뀌지 않았다. RTC 시그널링(`invite`/`offer`/`answer`/
  `candidate`/`bye` …)과 IoT(`create`/`join`/`subscribe`/`iot-control` …) 분기도
  같다.
- **`POST /relay/room/invite`**, **`GET /relay/register/findip`**,
  **`POST /relay/unregister/mobile`** 의 요청 형식.

즉 **월패드(IoT)는 고치지 않아도 붙는다.** 지금 운영 중인 101동 504호가 그렇다.

### 2.2 ⚠️ `POST /relay/register/mobile` — 흐름이 바뀐다

가장 큰 변화다. 앱을 함께 올려야 한다.

**응답이 두 갈래가 된다.**

| 상태 | 코드 | 뜻 |
|---|---|---|
| 이미 승인된 단말 | `200` + `"status": "approved"` | 예전과 같다. 토큰만 갱신됐다 |
| 처음 보는 단말 | `202` + `"status": "pending"` | **아직 등록되지 않았다.** 월패드에서 승인해야 한다 |
| 세대가 꽉 참 | `409` `home_full` | 이 세대에 더 넣을 수 없다 (승인 4대) |
| **월패드가 없음** | `409` `no_wallpad` | **그 동/호의 월패드가 아직 등록하지 않았다.** 아래를 보라 |
| 단지가 다름 | `403` `complex_mismatch` | 이 서버가 맡은 단지가 아니다 |

> **⚠️ 월패드가 먼저 등록해야 모바일이 등록된다.**
>
> 등록 요청을 받으려면 `rtc_homenet` 에 그 동/호의 행이 있어야 한다
> (`libs/enrollment.ts` 의 `no_wallpad` 검사). 승인할 주체가 없는 요청을 대기에
> 올려 봐야 아무도 승인할 수 없기 때문이다.
>
> 그 행은 **`POST /register/complex_agents` 만** 만든다. 월패드가 WebSocket 으로
> 붙어 있는 것으로는 생기지 않는다 — WS 경로는 이 표에 손대지 않는다.
>
> 옮겨 온 직후에는 이 표가 비어 있으므로 **모든 모바일 등록이 409 로 막힌다.**
> 월패드를 한 번 재부팅해 재등록시키면 풀린다. (2.3 의 필수 필드 변경 탓에 옛
> 서버에서 이 호출이 400 으로 실패하고 있었다면, 표는 처음부터 비어 있다.)

`202` 를 성공으로 읽으면 앱은 등록됐다고 믿지만 초인종 푸시는 영영 오지 않는다.
**앱은 `202` 를 받으면 "월패드에서 승인해 주세요" 를 보여 주고, 아래 결과 푸시를
기다리거나 주기적으로 다시 등록해야 한다.** 대기는 30분 뒤 스스로 사라지고, 한
세대에 대기 4개·승인 4대까지 들어간다 (그 이상은 409).

결과는 FCM 으로 온다. `data.method` 로 구분한다.

| `data.method` | 언제 | 함께 오는 것 |
|---|---|---|
| `enroll.approved` | 월패드가 인정했다 | `address`, `canCall`, `canControl` (문자열 `"true"`/`"false"`) |
| `enroll.rejected` | 월패드가 거절했다 | `address` |
| `enroll.expired` | 30분 동안 아무도 안 봤다 | `address` |
| `enroll.revoked` | 인정했던 것을 해지했다 | `address` |

**요청에 붙는 선택 필드**

| 필드 | 무엇 |
|---|---|
| `complexId` | 단지 식별자. 안 보내면 서버가 자기 값으로 채운다(옛 앱 호환). 보냈는데 다르면 403 |
| `sip_user` | SIP 내선. **안 보내면 기존 값을 건드리지 않고, 빈 문자열이면 연결을 끊는다** |
| `phone`, `image` | 승인 화면이 "어느 것이 내 폰인가" 를 가리는 데 쓴다 |
| `csr` | 보내면 응답에 클라이언트 인증서(`clientCert`)가 실린다 |

**승인된 단말의 200 응답에 실리는 것** (없으면 키 자체가 빠진다)

```jsonc
{
  "title": "websocket-relay",       // 이전에는 "CallFusion2RTC"
  "result": "success",
  "status": "approved",
  "canCall": true,                  // 지금 이 단말에 열려 있는 권한
  "canControl": false,
  "sip":  { /* 내선 자격 — Janus 에 등록할 때 쓴다 */ },
  "janus": { "url": "wss://…/janus-ws", "token": "…" },
  "clientCert": "-----BEGIN CERTIFICATE-----…"   // csr 을 보냈을 때만
}
```

`canCall`/`canControl` 은 등록할 때마다 현재 값이 온다. 승인 푸시로 한 번 받은 뒤
월패드에서 권한이 바뀌면 앱이 알 길이 없었기 때문이다.

### 2.3 ⚠️ `POST /relay/register/complex_agents` — 월패드 등록

- `complex` 를 **더 이상 받지 않는다.** 보내와도 무시할 뿐 오류는 아니다.
- 필수가 `complex, building, unit` → **`type, building, unit, ipaddress`** 로 바뀐다.
  `type` 과 `ipaddress` 가 새로 필수다.
- 응답에 월패드 자리(`<세대>00`)의 `sip` 자격이 실릴 수 있다. 쓰지 않으면 무시하면 된다.

### 2.4 ⚠️ 초대 푸시 payload — `roomId` → `roomid`

```diff
  "data": {
    "method": "invite",
-   "sender":   "rtc:101B504U",          // 접두사만 붙였다
-   "receiver": "rtc:101B504U",
-   "roomId":   "a1b2c3d4"
+   "sender":   "rtc:101B504U@<호스트>",  // 호스트까지 붙는다
+   "receiver": "rtc:101B504U@<호스트>",
+   "roomid":   "a1b2c3d4"
  }
```

- **`roomId` 가 `roomid` 로 바뀐다.** WebSocket 규약의 철자와 맞춘 것이다. 앱이 두
  철자를 모두 다루지 않으면 방을 못 찾는다.
- `sender`/`receiver` 에 `@<호스트>` 가 붙는다. 서버의 주소 파서가 `rtc:` 와 `@`
  사이만 잘라 쓰는데, `@` 가 없으면 빈 문자열이 나왔다.

### 2.5 월패드가 새로 쓸 수 있는 WebSocket method

`/relay/iot` 위에 등록 승인 대화가 얹혔다. **기존 method 는 그대로이므로 쓰지
않으면 아무 영향이 없다.**

| method | 무엇 |
|---|---|
| `enroll.list` | 대기 중인 등록 요청 목록 |
| `enroll.approve` / `enroll.reject` | 그 요청을 인정 / 거절 |
| `device.list` | 이미 인정한 단말 목록 |
| `device.revoke` | 그 단말의 등록 해지 |
| `device.permissions` | 그 단말의 통화·제어 권한 변경 |

세대의 월패드만 부를 수 있다(서버가 접속한 주소로 확인한다). 대기 요청이 생기면
월패드에 즉시 알리고, 접속 중이 아니면 다음 접속 때 알린다.

### 2.6 경로 노출 범위가 바뀐다

nginx 가 **접두사를 잘라내지 않는다**(`proxy_path` 없음). 원본 URI 가 그대로
백엔드에 도착하고, 내부 전용 경로는 앱에만 붙어 있어 프록시로는 404 가 된다.

| 경로 | 이전 | 이후 |
|---|---|---|
| `/relay/status/rooms` | 내부 전용 | **공개** (문서화된 Android 클라이언트가 쓴다) |
| `/relay/status/summary` | 있었음 | **없어졌다** — 대시보드 API 로 옮겨졌다 |
| `/relay/user/all` | 내부 전용 | 프록시로 **닿지 않는다** (포트 직결 + 사설망만) |
| `/relay/mobile-crud-operation/*` | 내부 전용 | 프록시로 **닿지 않는다** |
| `/relay/admin/` (무인증 정적 대시보드) | 있었음 | **없어졌다** |
| `/relay/dashboard` | — | 새로 생김. manager 로그인 세션을 요구한다 |
| `/sip-push` | — | 새로 생김. 루프백 전용 (Kamailio 착신) |

> `/relay/status/rooms` 응답에는 접속자의 `address`·`ipAddress` 가 들어 있다.
> 공개로 둔 것은 문서화된 클라이언트를 깨지 않기 위한 선택이지, 안전해서가 아니다.

---

## 3. 이 장비에서 해야 하는 일

> **이 절의 전제는 사라졌다.** 두 오케스트레이션 저장소가 하나로 합쳐지면서
> 바깥 구조가 같아졌다 — 생성기·pm2 스캐너·manager 가 같은 것이고, 양쪽 모두
> `dashboard_path` 를 `nginx-conf` 에서 읽는다. 아래는 그 전에 무엇이 달랐고
> 무엇을 손봤는지의 기록으로 남긴다.
>
> 서비스가 어느 저장소 아래에 놓이든 상관없도록, 이 문서와 코드에서는 상위
> 저장소를 이름으로 부르지 않고 **`[프로젝트 루트]`** 로 쓴다.

이 서비스가 놓인 오케스트레이션 저장소와 `webservice-nginx` 는 바깥 구조가
달랐다. 서비스 안에서 고친 것은 `nginx-conf/service.ini` 의 `dashboard_path`
한 줄뿐이었고, 나머지는 서비스 **바깥**에 있었다.

1. **포트** — 이 서비스는 28099 를 쓴다(이전 28090). `pm2/ecosystem.config.js` 의
   `PORT` 와 `.env` 를 함께 고친다. `nginx-conf/service.ini` 는 이미 28099 다.
2. **`.env`** — `DB_NAME=rtc_relay` 로 바꾼다. 이 장비에는 Janus·Kamailio 가 없으므로
   `SIP_PROVISION=false`, `JANUS_TOKEN_AUTH=false` 로 둔다.
3. **대시보드 빌드** — `npm run web:build`. 없으면 `/relay/dashboard` 가 503 을 준다.
4. **`site/settings.ini` 가 없다** — `webservice-nginx` 는 저장소 뿌리에 여러 서비스가
   함께 쓰는 값(host·complex_id·sip_domain)을 두는데 이 저장소에는 그 층이 없다.
   `libs/siteSettings.ts` 는 없으면 빈 값을 돌려주도록 되어 있어 그대로 돌지만,
   **`JANUS_WS_URL` 이 비게 되므로** 앱에 Janus 주소를 알려 주려면 `.env` 에 직접 적어야 한다.
5. **`services/.session-secret`** — 이미 있다. 대시보드 로그인이 이 값으로 manager 세션을
   검증한다.
6. `pm2-conf/app.ini` 는 `webservice-nginx` 의 pm2 생성기가 읽는 파일이다. 이 저장소의
   `pm2/ecosystem.config.js` 는 손으로 적는 방식이라 이 파일을 읽지 않는다. 지우지 않고
   두되, 이 장비에서 실제로 쓰이는 것은 `pm2/ecosystem.config.js` 쪽이다.
7. **등록할 때마다 `kamailio.subscriber` 경고가 뜬다.**

   ```
   SIP 자격을 읽지 못했습니다 (0101050400): SELECT command denied ... `kamailio`.`subscriber`
   ```

   `SIP_PROVISION=false` 는 계정을 **만드는** 것만 끈다. 이미 있는 자격을 **읽는**
   경로(`libs/sipAccount.ts` 의 `credentialFor`)는 그대로 돌고, 이 장비에는 Kamailio
   스키마가 없어 매번 실패한다. 읽기가 실패하면 응답에서 `sip` 키가 빠질 뿐이라
   등록 자체는 정상으로 끝난다 — 로그가 시끄러운 것이 전부다. Kamailio 를 함께
   올릴 때 저절로 사라지므로 코드는 손대지 않았다.
