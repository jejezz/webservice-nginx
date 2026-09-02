# 인터폰 → 모바일 착신 — FCM 으로 단말 깨우기

NAT 안의 인터폰이 Kamailio 를 통해 모바일로 걸 때, 자고 있는 모바일을 깨워
전화를 받게 하는 흐름입니다.

관련 문서: [websocket-plan.md](websocket-plan.md) (전체 구조·단계) ·
[identity.md](../../../docs/identity.md) (세대·단말 번호 체계 — ⑤⑥ 의 `aor` 가 무엇인가)

네 조각이 다 붙었는지 한 번에 보려면:

```bash
services/kamailio/check-push.sh          # tsilo 훅 · wt_timer · 릴레이 · sip_user 매핑
services/kamailio/check-push.sh --json   # 구축 마법사가 읽는 형식
```

## 문제

모바일은 배터리 때문에 WebSocket 을 계속 붙들고 있지 않습니다. 그래서 걸려올 때
**Kamailio 에 등록되어 있지 않습니다.** `lookup("location")` 이 실패하고, 배포판
설정은 그 자리에서 `404 Not Found` 를 돌려줍니다.

전화를 받게 하려면 그 사이에 세 가지가 필요합니다.

1. INVITE 를 버리지 않고 **붙들어 둔다**
2. 단말을 **깨운다** (FCM)
3. 단말이 등록하면 붙들어 둔 INVITE 를 **그 연결로 흘려보낸다**

## 흐름

```
 ① 인터폰 ──INVITE sip:0101080501@pluto.org──▶ Kamailio
                                          │
 ② Kamailio ──100 Trying──▶ 인터폰        │   500ms 안에. 안 보내면 발신측이
                                          │   T1(500ms)부터 INVITE 를 재전송하고
                                          │   32초(Timer B)에 포기한다.
                                          │
 ③                        lookup("location") 실패 (모바일 미등록)
                                          │
 ④                        ts_store()  ← INVITE 를 붙들어 둔다
                                          │
 ⑤ Kamailio ──POST /sip-push──▶ websocket-relay (127.0.0.1:28099)
                {aor:"0101080501", caller:"...", callId:"..."}
                                          │
 ⑥                        rtc_mobiles 에서 sip_user='0101080501' 인 토큰 조회
                                          │
 ⑦                        FCM ──▶ 단말 기동
                                          │
 ⑧ 단말 ──WSS──▶ Janus ──REGISTER (평문 SIP)──▶ Kamailio
                                          │
 ⑨                        save("location") 성공
                          ts_append()  ← 붙들어 둔 INVITE 를 새 contact 로 분기
                                          │
 ⑩ Kamailio ──INVITE──▶ Janus ──WSS──▶ 단말    벨이 울린다
```

> ⚠️ ⑧⑩ 은 **2026-08-21 에 바뀌었습니다.** 예전 계획은 단말이 SIP over WebSocket
> 으로 Kamailio 에 직접 붙는 것이었습니다. 지금은 단말이 SIP 를 말하지 않고
> **Janus 가 단말을 대신해 등록하고 통화합니다**
> ([mobile-transport.md](mobile-transport.md) 7절). 그래서 ⑧ 의 REGISTER 를 보내는
> 것은 Janus 이고, 단말이 하는 일은 Janus 에 붙어 SIP 플러그인에 `register` 를
> 요청하는 것입니다. 앱 쪽 절차는 [클라이언트 안내](../../../docs/client-guide.md)
> 에 있습니다.

②와 ⑩ 사이가 FCM 지연 구간입니다. 현실적으로 2~8초이고 그동안 발신자는 무음이라,
`183 Session Progress` 로 링백을 흘리는 것을 권합니다.

`100 Trying` 이후에는 프록시 Timer C(최소 3분)라 프로토콜상 여유가 충분합니다.

## 각 조각

### ① Kamailio — 붙들고 깨우기

`tsilo` 모듈이 이 목적으로 만들어졌습니다. 이미 설치돼 있습니다.

| 넣을 곳 | 넣을 것 |
|---|---|
| `route[LOCATION]` | `lookup` 실패 시 `t_newtran()` · `ts_store()` · 푸시 요청 |
| `route[REGISTRAR]` | `save()` 뒤 `ts_append()` |

푸시 요청은 **`http_client`**(동기)로 보냅니다.

> **정정 두 번.** 처음에는 "`http_async_client` 는 저장소에 없어 소스 빌드가
> 필요하다" 고 적었다가, `kamailio-extra-modules` 의 **설명**에 그 이름이 있는 것을
> 보고 "apt 로 된다" 고 고쳤습니다. **둘 다 틀렸습니다.** 그 패키지가 실제로
> 담고 있는 것은 `acc_json evapi gzcompress janssonrpcc jansson uuid` 뿐입니다.
> 설명이 아니라 `dpkg -L` 로 확인해야 했습니다.
>
> 확인한 사실:
>
> | 모듈 | 패키지 | 실제 포함 |
> |---|---|---|
> | `http_client` (동기) | `kamailio-utils-modules` | ✅ (`dpkg -c` 로 확인) |
> | `evapi` (비동기) | `kamailio-extra-modules` | ✅ 설치됨 |
> | `http_async_client` | — | ❌ 배포판 5.5.4 에 없음 |

동기 호출이 워커를 붙드는 것은 맞지만 이 배치에서는 문제되지 않습니다 —
`/sip-push` 가 **FCM 왕복을 기다리지 않고** 발송을 걸어 둔 뒤 바로 답하므로,
붙드는 시간이 루프백 HTTP 왕복(수 ms)뿐입니다. 인터폰 몇 대 수준의 착신량에서는
충분합니다.

착신량이 늘면 **`evapi`** 로 옮길 수 있습니다 (이미 설치돼 있습니다).
`evapi_async_relay` 로 트랜잭션을 매달고 외부 앱이 `t_continue` 로 깨우는 방식이라
워커를 붙들지 않지만, 움직이는 조각이 늘어납니다.

### ② websocket-relay — 푸시 발송  ✅ 구현됨

`POST /sip-push` (루프백 전용)

```json
{ "aor": "0101080501", "caller": "1002", "callId": "..." }
```

| 응답 | 뜻 |
|---|---|
| `200 {"pushed": n}` | n 대에 발송을 걸었다 |
| `200 {"pushed": 0}` | **그 내선에 연결된 모바일이 없다** — Kamailio 는 붙들고 있던 트랜잭션을 480 으로 끝내면 된다 |
| `400 {"error":"aor_required"}` | aor 누락 |
| `503` | DB 또는 FCM 미설정 |

**FCM 왕복을 기다리지 않습니다.** 발송을 걸어 둔 뒤 바로 답합니다 — Kamailio 가
이 응답을 기다리는 동안 트랜잭션을 쥐고 있기 때문입니다.

**루프백에서만 받습니다.** 외부에 열면 남의 단말을 임의로 깨울 수 있습니다.
`mobile-crud-operation` 과 같은 이유로 Nginx 경로가 아니라 포트 직결에만 붙였고,
`X-Forwarded-For` 는 믿지 않고 소켓의 실제 주소만 봅니다.

확인:

```
루프백 HTTPS      → 400 (aor 필요)      ✓
LAN 주소          → 403                 ✓
Nginx 경유        → 404 (존재하지 않음)  ✓
```

### ③ SIP 사용자명 ↔ FCM 토큰  ✅ 스키마 작성됨

`rtc_mobiles` 는 `address`(`1B101U` 같은 동/호)로만 찾게 되어 있어, SIP 에서 온
사용자명(`1001`)으로는 토큰을 찾을 수 없었습니다. `sip_user` 컬럼을 추가합니다.

```
services/websocket-relay/schema/002-sip-user.sql
```

UNIQUE 를 걸지 않습니다 — 한 내선에 휴대폰·태블릿이 함께 붙을 수 있고, 그때는
모두에게 푸시를 보내는 것이 맞습니다.

~~단말이 `/register` 할 때 이 값을 함께 보내야 합니다.~~ **이제 서버가 정합니다.**
승인 시점에 relay 가 동/호에서 번호(`동4+호4+순번2`)를 계산해 배정하고 Kamailio
계정까지 만듭니다 — 앱이 보내던 `sip_user` 는 필요 없어졌습니다. 규격은
[identity.md](../../../docs/identity.md) 에 있습니다.

그래서 아래 ④(`sip_user` 가 비어 조용히 착신 0건)는 새로 승인되는 단말에서는
생기지 않습니다. 규칙이 생기기 전에 승인된 단말은
`npm run sip:backfill` 로 채웁니다.

적용:

```bash
cd database && sudo ./setup_mariadb.sh
```

## Kamailio 설정 — A안(포크)으로 구현했습니다  ✅

`route[LOCATION]` 과 `route[REGISTRAR]` 은 배포판이 정의하고, Kamailio 에는 기존
라우트에 코드를 끼워 넣는 수단이 없습니다. 그래서 배포판 설정을 포크했습니다.

```
services/kamailio/kamailio.cfg    ← 포크 (install.sh 가 /etc/kamailio/ 로 설치)
```

**원본에서 줄을 지우지 않았습니다** — 100줄을 더했을 뿐입니다 (주석 포함).
변경 지점은 셋이고 전부 `KAMAILIO-FORK` 로 표시했습니다.

```bash
grep -n KAMAILIO-FORK /etc/kamailio/kamailio.cfg
```

| 지점 | 무엇 |
|---|---|
| `route[REGISTRAR]` | `save()` 뒤 `ts_append("location", "$tu")` |
| `route[LOCATION]` | `lookup` 실패 시 `ts_store()` + `http_client_query(...)` + `183`/`480` |

동기 호출이라 응답 처리 라우트가 따로 필요 없어, 변경 지점이 **둘**로 줄었습니다.

모듈 로딩·`modparam`·`SIP_PUSH_URL` define 은 **오버라이드**(`kamailio-local.cfg`)에
두어 포크의 diff 를 작게 유지했습니다.

### 오버라이드에 둘 수 있는 것과 없는 것

`loadmodule` · `modparam` · `#!define` 은 오버라이드(`kamailio-local.cfg`)에 둡니다.
포크의 diff 를 작게 유지하기 위해서입니다.

**라우트 안의 코드는 둘 수 없습니다.** 처음에 응답 처리 라우트를 오버라이드에
두려다 이 오류를 만났습니다.

```
unknown command, missing loadmodule?   ← t_reply, xlog
```

`tm.so` / `xlog.so` 는 배포판 설정 262행 부근에서 로드되는데 오버라이드는
**127행**에서 import 되므로 그 시점에는 두 함수를 모릅니다. 여기서 직접
`loadmodule` 하면 배포판이 나중에 또 로드해 "load the same module twice" 로
기동이 막힙니다.

> `loadmodule` 자체는 오버라이드에 둬도 됩니다 — 로딩은 파스 시점 심볼을
> 요구하지 않기 때문입니다. `ts_store()` · `http_client_query()` 를 부르는 코드만
> 포크 안(라우트 안)에 있으면 됩니다.

### 검증 — 그리고 스텁 검증에서 배운 것

`http_client.so` 가 아직 설치되지 않아 `kamailio -c` 로 전체를 검사할 수 없습니다.
그래서 **`http_client_query(...)` 호출 한 줄만** 스텁으로 바꾸고 나머지는 원문
그대로 검사합니다.

```
config file ok, exiting...
```

처음에는 스텁 범위를 넓게 잡아 조건식까지 바꿔치기했는데, **하필 그 조건식이
틀려 있었습니다.** 검증을 통과했다고 보고했지만 실제 설치에서 터졌습니다.

```
line 804, column 44: syntax error     ← $var(pushbody) !~ "..."
```

Kamailio 에 **`!~` 연산자는 없습니다.** `!( ... =~ ... )` 로 써야 합니다.
최소 설정으로 직접 확인했습니다.

| 표현식 | 결과 |
|---|---|
| `$var(x) =~ "b"` | ✅ |
| `$var(x) !~ "b"` | ❌ syntax error |
| `!($var(x) =~ "b")` | ✅ |
| `$rc == 200 && !($var(x) =~ "b")` | ✅ |

**스텁은 검증하려는 것을 가려서는 안 됩니다.** 지금은 모듈이 없어 검사할 수 없는
함수 호출 한 줄만 대체합니다.

같은 계기로 README 를 읽어 두 가지를 더 바로잡았습니다.

- 반환값은 대입이 아니라 **`$rc`** 로 받습니다 (`$var(x) = http_client_query(...)` 아님)
- 인자는 **네 개** — `(url, post-data, hdrs, result)`. `Content-Type: application/json`
  을 빠뜨리면 안 됩니다. websocket-relay 가 `express.json()` 으로 받으므로
  헤더가 없으면 본문이 파싱되지 않아 `aor_required` 가 옵니다.

남은 미검증 부분은 그 함수 호출의 인자 개수뿐이고, 패키지 README 의 4인자 예제를
그대로 따랐습니다. 모듈이 들어오면 `install.sh --apply` 가 설치 전에 전체를 다시
검사하고, 실패하면 되돌립니다 — 방금 그 경로가 실제로 동작하는 것을 확인했습니다.

### 롤백

메인 설정까지 소유하게 되어 되돌릴 파일이 늘었습니다. `install.sh` 가
이번 실행에서 만든 백업들을 기억했다가 되돌립니다 — `kamailio.cfg` 를 그냥
지우면 Kamailio 가 아예 뜨지 못하므로 `rm` 만으로는 부족합니다.

처음 설치할 때 배포판 원본을 `kamailio.cfg.dpkg-orig` 로 남겨 둡니다. 패키지가
업그레이드될 때 새 원본과 우리 변경점을 비교하는 기준입니다.

## 진행 순서

| | 단계 | 상태 |
|---|---|---|
| 1 | `sudo apt install kamailio-utils-modules` | ⬜ `http_client` |
| 2 | `cd database && sudo ./setup_mariadb.sh` | ⬜ `sip_user` 컬럼 |
| 3 | `sudo ./install.sh --apply` | ⬜ 포크 설치 + 검증 + 롤백 |
| 4 | 단말 `/register` 에 `sipUser` 추가 | ⬜ **앱 변경** |
| 5 | 인터폰 → 모바일 실제 통화 | ⬜ |

1~2 는 SIP 라우팅에 영향이 없습니다. 3 부터 바뀝니다.

## 정해야 할 것

**`pushed: 0` 일 때 무엇을 돌려줄 것인가.** 지금은 `480 Temporarily Unavailable`
입니다. `404 Not Found` 가 나을 수도 있는데 인터폰 표시가 달라지므로 장비 동작을
보고 정하는 편이 좋습니다. (`route[SIP_PUSH_REPLY]` 한 줄)

**깨우기 실패 시 얼마나 기다릴 것인가.** 지금은 Timer C(3분)까지 붙들고 있습니다.
발신자가 3분을 기다릴 리 없으니 짧은 타이머(예: 20초)를 두고 480 으로 끝내는 편이
낫습니다. `t_set_fr()` 로 조정합니다.

**인터폰과 모바일이 같은 내선에 함께 등록된 경우.** 지금은 `lookup` 이 성공하면
푸시 없이 그대로 보냅니다 — 모바일은 깨어나지 않습니다. 병렬로 울리게 하려면
`ts_store()` 를 lookup 성공 경로에도 넣어야 합니다.

---

## 실측 (2026-08-21) — 흐름은 이어지지만 **붙들어 두는 시간이 너무 짧습니다**

전 구간을 실제로 돌려 봤습니다. 인터폰 역할은 평문 SIP 단말
(`../../janus/test-harness/sipua.js`), 깨어난 모바일 역할도 같은 것으로 했습니다.

### 되는 것

```
INVITE 2005 (미등록)
  → lookup 실패 → ts_store() → POST /sip-push → {"pushed":1}
  → 183 Session Progress            발신자에게 링백
  → (5초 뒤) 2005 가 REGISTER
  → ts_append 가 붙들린 INVITE 재전송 → 착신 도착 → PCMU 통화 성립
```

**설계대로 동작합니다.** tsilo 가 INVITE 를 붙들고, 단말이 등록하는 순간
이어 줍니다.

### ⚠️ 그런데 창이 10초 안팎입니다

같은 시험을 등록 지연만 바꿔 반복했습니다.

| 등록까지 걸린 시간 | 결과 |
|---|---|
| 5초 | ✅ 착신 도착 |
| 12초 | ❌ 오지 않음 |
| 25초 | ❌ |
| 35초 | ❌ |

### ✅ 범인은 `wt_timer` 입니다 (확정)

`modparam("tm", "fr_inv_timer", 120000)` 을 보고 120초를 기대했는데 그렇지
않았습니다. 런타임에 값을 바꿔 가며(`kamctl rpc cfg.seti tm …`) 갈랐습니다.

| 바꾼 값 | 35초 시험 |
|---|---|
| `fr_timer` 30초 → **90초** | ❌ 그대로 실패 |
| `wt_timer` 5초 → **90초** | ✅ **통과** |
| `wt_timer` 되돌리고 `max_inv_lifetime` 만 180초 | ❌ 다시 실패 (반대 확인) |

**왜 대기 타이머인가** — `lookup()` 이 실패한 이 트랜잭션은 아무 데도 relay 하지
않고 `t_newtran()` + 로컬 `t_reply("183")` 만 합니다. **나가는 브랜치가 하나도
없으므로** tm 이 곧바로 '완료' 로 보아 대기 타이머(`wt_timer`, 기본 5초)에
올립니다. 그 시간이 지나면 트랜잭션이 사라지고 tsilo 기록도 함께 사라집니다.

### 고침

```
modparam("tm", "wt_timer", 60000)
```

**대가가 있습니다.** 이 값은 *모든* 완료된 트랜잭션이 메모리에 머무는 시간이기도
합니다. 기본값의 12배가 되므로 shm 사용이 늘어납니다. 이 서버 규모(동시 통화 한
자릿수)에서는 무시할 만하지만, 트래픽이 늘면 다시 볼 값입니다. 트랜잭션 하나에만
거는 방법은 tm 에 없습니다 — `t_set_fr()` 은 fr 계열만 건드리고, 위 표대로
그것으로는 해결되지 않습니다.

### 이것이 왜 조용한 실패인가

창이 지나면 **발신자에게 아무 최종 응답도 가지 않습니다.** 183 을 받은 채로
계속 기다리다 단말 쪽 타임아웃까지 갑니다. Kamailio 저널에도 그 시점에 아무것도
남지 않습니다.

```
[ua +0.3s]  ← 183 (INVITE)
[ua +33.4s] (아무것도 오지 않음)
[ua +63.4s] (아무것도 오지 않음)
```

### 왜 문제인가 — 모바일은 10초 안에 못 깨어납니다

FCM 지연 + 앱 콜드 스타트 + (Janus 를 쓰면) 세션 생성 · `attach` · REGISTER
왕복까지 더해집니다. 실제로 헤드리스 브라우저로 재 봤을 때 등록까지 **33초**가
걸렸고, 그 시험은 착신을 받지 못했습니다.

`kamailio.cfg` 에 넣었습니다. **반영에는 `sudo ./install.sh --apply` 가
필요합니다** — 그전까지는 기본값 5초 그대로입니다.

### 곁가지 — `/register` 가 `sip_user` 를 저장하지 않고 있었습니다

`002-sip-user.sql` 은 *"값은 단말이 `/register` 할 때 함께 보낸다"* 고 적어
두었지만 그 코드가 없어서, `rtc_mobiles.sip_user` 를 채울 방법이 아예
없었습니다. `sipPush.ts` 는 그 컬럼으로 조회하므로 **푸시가 영원히 `pushed:0`**
이었습니다. 이번에 채워 넣었습니다 (websocket-relay 커밋 참고).
