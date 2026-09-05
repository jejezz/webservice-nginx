# `webservices` ↔ `webservices-nginx` 차이 (2026-09-03 조사)

두 저장소는 근본적으로 같은 프로젝트이고 대부분 이미 합쳐졌다. `diff -rq` 로
전체를 비교한 결과, **코드 차이는 `services/websocket-relay` 와
`site/settings-schema.json` 뿐**이었다 — kamailio·janus·manager·android 쪽은
이미 바이트 단위로 같다. 이 문서는 websocket-relay 에서 벌어진 차이만 다룬다.

방향은 한쪽으로 몰려 있다. **`webservices-nginx` 가 여섯 가지를 앞서 고쳤고,
`webservices` 는 아직 반영하지 않았다.** 반대 방향(webservices 에만 있는
websocket-relay 수정)은 없다.

고치는 작업은 하지 않았다 — 아래는 무엇을, 왜, 어떻게 옮길지의 기록이다.

---

## 1. (보안) 모바일 단말이 동/호를 바꿔도 재승인 없이 통과한다

- **위치**: `services/websocket-relay/src/libs/enrollment.ts` (`requestEnrollment`)
- **webservices-nginx 커밋**: `4a34a41` 단말 등록에서 동/호가 바뀌면 갱신이 아니라 재승인으로 다룬다

**문제**: 등록 요청을 `uuid` 하나로만 갈라, 이미 승인된 단말이면 무조건 "갱신"으로
처리한다. 그런데 uuid 는 단말 신원일 뿐 주소가 아니다. 504호에서 승인받은 단말이
505호를 자칭해 다시 등록해도(예: 앱 재설치 없이 설정만 바꿔도) uuid 가 같으므로
그냥 통과하고, 504호에서 받은 `can_call`/`can_control` 권한이 505호 앞으로 그대로
넘어간다. 505호 월패드는 그 단말을 승인한 적이 없다 — 파일 머리말의 "승인 없이는
아무 권한 없음" 원칙을 정면으로 어긴다.

**webservices-nginx 의 수정**: `known` 조회에 `address` 를 같이 읽어, 주소가
같을 때만 갱신 경로를 탄다. 주소가 달라졌으면(그리고 새 동/호에 월패드가 있으면)
`revokeDevice(...)` 로 옛 승인을 거둔 뒤 "새 단말" 경로로 흘려보내 새 동/호
월패드의 승인을 다시 받게 한다. 존재하지 않는 동/호를 잘못 불렀을 때(`no_wallpad`)
는 옛 승인을 건드리지 않도록, 거두는 순서를 월패드 확인 *뒤*에 둔 것도 눈여겨볼
점이다.

**옮기는 법**: `webservices-nginx` 의 `enrollment.ts` 해당 함수를 그대로
가져온다. `revokeDevice` 는 이미 양쪽에 있는 함수이므로 새로 만들 것은 없다.

---

## 2. 대시보드 로그인: 비밀번호 오타가 "세션 만료" 로 둔갑해 조용히 로그인 화면으로 튕긴다

> ✅ **처리됨** (`webservices` 커밋 `13b862b` 비밀번호 오타를 세션 만료가
> 아니라 403 으로 돌려준다). `reauth.ts`·`web/src/lib/api.js` 모두
> `webservices-nginx` 와 바이트 단위로 같다 — 이 절은 조사 당시 기록으로
> 남겨 둔다.

- **위치**: `services/websocket-relay/src/auth/reauth.ts` (`verifyPassword`)
- **webservices-nginx 커밋**: 없음(파일명 기준 단독 커밋 확인 안 됨, `websocket-relay` 편입 시점에 포함된 것으로 보임) — `git log -p` 로 직접 확인 필요

**문제**: manager 가 "비밀번호 틀림"에 HTTP 401 을 쓰는데, 그 값을 그대로
돌려주고 있다. 대시보드의 API 클라이언트(`web/src/lib/api.js`)는 401 을 전부
"세션이 끝났다" 로 해석해 **어떤 호출이든** 로그인 화면으로 보낸다. 그 결과
비밀번호를 한 글자만 틀려도 오류 메시지 대신 다이얼로그가 그냥 사라지고, 사람은
무엇이 잘못됐는지 알 수 없다. 로그에도 "재확인 실패"만 남아 원인이 가려진다.

**webservices-nginx 의 수정**: manager 응답을 status/error 코드로 다시 분류해
돌려준다 — 429(시도 초과)·503(manager 응답 없음/기능 없음)은 그대로, 401 +
`error: invalid_password` 는 **403** 으로 바꿔 돌려준다(진짜 세션 문제와 구분).
그 외의 401(쿠키 자체 거절)은 401 유지. 그 밖의 예상 못 한 응답(예: manager 가
이 기능을 아예 안 가진 구버전이라 404)은 503 + 원인을 로그에 남긴다.

**옮기는 법**: `reauth.ts` 의 분기 로직을 그대로 가져오면 된다. 프런트엔드가
403 을 "세션 만료 아님"으로 이미 다루고 있는지(즉 nginx 쪽 `api.js`/다이얼로그가
403 을 별도로 처리하는지) 확인 후 같이 옮긴다.

---

## 3. 대시보드 다이얼로그: 입력 중 초점이 튀어 타이핑이 끊긴다

- **위치**: `services/websocket-relay/web/src/components/ui/dialog.jsx`
- **웹 컴포넌트 버그** — SIP 프록시 기능과 무관하게 모든 다이얼로그(단지 ID
  변경 등)에 영향

**문제**: 다이얼로그를 여는 `useEffect` 가 `onOpenChange` 를 의존성 배열에
넣고 있다. 호출부가 인라인 화살표 함수를 넘기는 경우(`ComplexCard` 등)가
흔한데, 그러면 리렌더마다 함수 정체성이 바뀌어 effect 가 매번 다시 돈다. 이
effect 안에 "열리면 첫 입력칸으로 초점 이동"이 들어 있어서, **글자를 한 자
칠 때마다 리렌더 → effect 재실행 → 초점이 입력칸 밖으로 다시 튀는** 일이
벌어진다. 사람 눈에는 "입력이 안 먹는다"로 보인다.

**webservices-nginx 의 수정**: `onOpenChange` 를 ref 에 담아 최신 값만
참조하고, effect 의존성에서는 뺀다(`[open]` 만 남긴다). 곁들여 초점 이동 대상도
닫기(✕) 버튼을 건너뛰고 실제 입력칸을 우선하도록 고쳤다(`data-dialog-close`
표식).

**옮기는 법**: `dialog.jsx` 파일을 그대로 가져오면 된다. 다른 컴포넌트와의
결합이 없는 순수 UI 버그라 이식 위험이 가장 낮다.

---

## 4. 단지 ID 설정 전에 등록된 월패드 행이 나중에 중복 생성될 수 있다

- **위치**: `services/websocket-relay/src/libs/homenetRecord.ts`
- **webservices-nginx 커밋**: `cebe5b9` 월패드 upsert 가 단지 미설정 시절의 주인 없는 행을 인수하게 한다

**문제**: `COMPLEX_ID` 를 설정하기 전에 월패드가 먼저 등록되면 그 행의
`complex_id` 는 NULL 로 들어간다. 이후 `COMPLEX_ID` 를 설정해도, upsert 가 보는
유일 키는 `complex_key`(= `COALESCE(complex_id, '')`)를 포함하므로 옛 NULL 행의
키(빈 문자열)와 새로 들어오는 값의 키(실제 id)가 어긋난다. `INSERT ... ON
DUPLICATE KEY UPDATE` 가 옛 행을 못 찾고 같은 동/호로 새 행을 또 만들려
든다 — 초기 설치 순서(장비를 먼저 켜고 설정은 나중에)를 밟은 현장에서 실제로
겪을 수 있는 경로다.

**webservices-nginx 의 수정**: upsert 직전에 `UPDATE ... SET complex_id = ?
WHERE complex_id IS NULL AND building = ? AND unit = ?` 로, 주인 없는(=
complex_id NULL) 같은 동/호 행을 먼저 이 단지로 인수한다. 그 다음에 원래
upsert 를 그대로 돌린다.

**옮기는 법**: 해당 UPDATE 블록만 upsert 앞에 추가하면 된다. 부작용 없는
멱등 연산이라 이식 위험 낮음.

---

## 5. pm2 개발 실행 선언이 실제로 동작한 적 없는 값으로 남아 있다

- **위치**: `services/websocket-relay/pm2-conf/app.ini`
- **webservices-nginx 커밋**: `cbb855c` websocket-relay pm2 선언을 실물(dist+node)에 맞춘다

**문제**: `script = src/index.ts` + `interpreter = tsx` (watch 모드)로 선언돼
있는데, `tsconfig` 의 `module: nodenext` 때문에 tsx 로 진입점을 직접 돌리면
ESM 으로 실행되어 `__dirname` 을 쓰는 `config.ts`/`siteSettings.ts`/
`deviceCert.ts`/`index.ts` 가 전부 깨진다. 실제 운영에서 안정적으로 돈 것은
항상 `dist`(tsc 로 컴파일한 CommonJS)뿐이었다 — 즉 이 선언은 검증된 적 없는
죽은 설정이다. 누군가 이 `app.ini` 를 신뢰해 pm2 를 새로 세팅하면 그 자리에서
깨진다.

**webservices-nginx 의 수정**: `script = dist/index.js`, `watch = false` 로
선언을 실물에 맞춘다. 배포 전에 `npm run build` 를 먼저 돌려야 한다는 점을
주석으로 못박는다.

**옮기는 법**: `[app]` 섹션 세 줄(`script`/`interpreter` 삭제/`watch`)만
바꾸면 된다. 이 저장소가 `pm2/ecosystem.config.js` 로 직접 pm2 를 구성한다면
그쪽에도 같은 값이 반영돼 있는지 같이 확인한다.

---

## 6. (신규 기능) SIP 프록시(Kamailio) 주소를 앱에 알려 주는 경로 전체가 없다

- **webservices-nginx 커밋**: `9db3b47` 등록 응답에 단지별 SIP 프록시(Kamailio) 주소를 싣는다
- **관련 파일** (전부 `webservices` 쪽에 없음):
  - `src/libs/sipProxy.ts` (신규)
  - `web/src/components/SipProxyCard.jsx` (신규)
  - `src/config.ts` — `sip.proxy` 필드
  - `src/libs/sipAccount.ts` — 발급/조회한 자격에 `proxy` 를 얹는 `withProxy()`
  - `src/http/dashboardApi.ts` — `GET/PUT /sip-proxy`
  - `web/src/lib/api.js` — `sipProxy()`/`updateSipProxy()`
  - `web/src/pages/Overview.jsx` — `SipProxyCard` 배치
  - `scripts/lib/env.ts` — `detectSipProxy()`, `SIP_PROXY_RE`, `SIP_PROXY_ERROR`
  - `scripts/setup.ts` — 최초 설치 시 감지값을 물어보는 단계
  - `scripts/doctor.ts` — `checkSipProxy()` 진단
  - `.env.example` — `SIP_PROXY=`

**문제(정확히는 기능 공백)**: 지금 `webservices` 의 등록 응답에는 앱이 SIP
REGISTER 를 보낼 Kamailio 주소가 실리지 않는다. 단지마다 Kamailio 가 다른
사설 IP 를 쓰므로(`sip.domain`은 realm 이라 여러 단지가 같은 문자열을 쓸 수
있지만 `proxy` 는 그렇지 않다), 이 값이 없으면 앱은 빌드에 박힌 기본값에만
의존해야 한다. 단지를 늘릴 때마다 앱을 다시 빌드해야 하는 셈이다.

**webservices-nginx 의 구현 요지**:
- `detectSipProxy()` 가 `services/kamailio/settings.ini` 의
  `sip_listen_addr` 를 먼저 보고, 없으면 이 장비의 사설망 아닌 첫 IPv4 를
  쓴다(Kamailio 와 Janus 는 항상 한 PC 에 있다는 전제, `janus/install.sh` 의
  `resolve_lan` 과 같은 전제).
- `.env` 의 `SIP_PROXY` 가 있으면 그 값이 우선하고, 없으면 감지값을 쓴다.
  감지도 실패하면 응답에 아예 싣지 않는다(앱은 빌드 시점 기본값으로 자연히
  떨어짐 — 배포 순서를 가리지 않는 설계).
- 대시보드에서 즉시 바꿀 수 있게 `GET/PUT /sip-proxy` 를 열어 뒀고, `PUT` 은
  단지 ID 변경과 달리 비밀번호 재확인을 요구하지 않는다(틀려도 "새 등록이
  옛 프록시로 붙는다"뿐이라 위험도가 낮다는 판단 — `dashboardApi.ts` 주석
  참고).

**옮기는 법**: 기능 하나가 통째로 빠진 것이므로 부분 이식보다 위 파일 목록을
그대로 가져오는 편이 안전하다. 순서 제안:
1. `src/libs/sipProxy.ts` 를 가져온다(의존: `config.sip.proxy`,
   `./envFile` 의 `setEnvValue` — 이름이 `scripts/lib/env.ts` 의 것과 다르니
   `webservices` 에 `src/libs/envFile.ts` 가 있는지 먼저 확인).
2. `config.ts` 에 `sip.proxy` 필드 추가(§5 항목의 diff 그대로).
3. `sipAccount.ts` 의 `withProxy()` 적용.
4. `dashboardApi.ts` 라우트 + `web/src/lib/api.js` + `SipProxyCard.jsx` +
   `Overview.jsx` 배치.
5. `scripts/lib/env.ts` 의 `detectSipProxy`/정규식과 `scripts/setup.ts`/
   `scripts/doctor.ts` 훅.
6. `.env.example` 에 `SIP_PROXY=` 항목 추가.

이 기능은 §5(pm2 app.ini)와 독립적이므로 순서를 바꿔 먼저 옮겨도 무방하다.

---

## 참고 — 코드 문제가 아닌 차이 (조치 불필요)

- **`site/settings-schema.json`**: `host`/`complex_id`/`sip_domain` 의
  placeholder 예시 값이 다르다(`c-a3f19c04...` ↔ `c-1a2b3c4d...`,
  `pluto.org` ↔ `saturn.org`). 예시 문자열일 뿐 동작에 영향 없음 — 아마
  실제 값과 겹치지 않도록 한쪽에서 이름을 바꾼 것으로 보인다. 맞출지는
  취향 문제.
- **`.gitignore` 주석**: `webservices-nginx` 는 websocket-relay 를 이
  저장소가 직접 추적한다는 사실을 머리말 주석에 반영해 뒀는데
  (`services/websocket-relay 를 편입한다` 커밋), `webservices` 쪽 주석은
  아직 예전 문구(websocket-relay 를 "각자 자기 저장소를 가지는 서비스"로
  나열)로 남아 있다. 실제 추적 방식(둘 다 서브모듈 아님, 파일 그대로 커밋)은
  이미 같으므로 문서 문구만 뒤쳐진 것 — 코드에는 영향 없다.
- **`docs/health-contract.md`**: 두 저장소 모두 `degraded` → HTTP 200 으로
  이미 일치한다. 예전 커밋 메시지(`5dbf6cb`)에 "여기는 503, 저쪽은 200"
  이라는 기록이 남아 있어 확인했으나 현재는 해소된 상태였다.
- **`services/apartment-mgmt-server-node`, `services/route-a/b/c`,
  `services/stock-analyzer`**: `webservices` 에만 있고 `webservices-nginx`
  에는 아예 없다. websocket-relay 처럼 두 저장소가 공유하는 서비스가
  아니라 이 장비에서만 운용 중인 별개 서비스로 보여 이 비교에서 제외했다.
  실제로 양쪽에서 같이 굴릴 계획이라면 별도 확인 필요.
- **rtpengine 관련 커밋들** (`webservices-nginx` 로그의 `6bea580`,
  `7de61ae`, `b068e79`, `75070f4`, `b4cd82a` 등): 의도적으로 `webservices`
  쪽에 들여오지 않은 것으로 기억됨(22.04 는 rtpproxy 유지 방침). 이 문서의
  "고쳐야 할 차이" 목록에서 제외.

---

## 우선순위 제안

1. **§1 (재승인 우회)** — 보안/권한 경계 문제라 가장 먼저.
2. **§3 (다이얼로그 초점)**, **§2 (401→403)** — 대시보드를 쓰는 사람이
   바로 체감하는 버그.
3. **§4 (주인 없는 행)**, **§5 (pm2 선언)** — 특정 조건(초기 설치 순서,
   dev 모드로 pm2 재구성)에서만 터지지만 고치는 비용이 낮다.
4. **§6 (SIP 프록시 기능)** — 가장 크지만 기능 부재이지 버그는 아니다.
   여러 단지를 앱 재빌드 없이 운용해야 할 시점에 맞춰 이식.
