# 구축 마법사 — 설계

서비스를 **어떤 순서로 무엇을 채워야 하는지** 화면이 안내하고, 사람이 한 일을
**실제로 됐는지 확인한 뒤** 다음으로 넘기는 웹 화면의 설계입니다.

> 상태: **여섯 단계 모두 구현됨. 열린 질문 다섯도 닫혔습니다.**
> 점검 규약(`--json`)이 진입점 18곳에 붙었고 ([check-contract.md](check-contract.md)),
> manager 의 `/manager/setup` 이 **18단계 전부**(필수 12 · 선택 6)를 돌립니다.
> 뒤의 넷은 공인 인증서(Let's Encrypt)입니다 — 발급 · nginx 에 물리기 ·
> 90일 갱신 · 이름이 이 서버를 가리키나 (아래 '5단계에서 정한 것'). 기계가 확인할 수
> 없는 것은 사람의 확인을 기록하되 `attested` 로 따로 표시하고, 장비마다 다른
> 값은 단계 안의 폼에서 받아 그 서비스의 `settings.ini` 에 씁니다
> ([settings-contract.md](settings-contract.md)). 설치본이 저장소보다 낡은 것도
> 잡습니다 (아래 '설치본이 낡은 것을 잡는다').
>
> 이 장비의 현황과 다시 볼 때의 순서는 맨 아래 '지금 어디까지 왔나' 에 있습니다.
>
> 초안을 쓰면서 전제 하나가 실측으로 뒤집혔습니다 — 점검 스크립트의 종료
> 코드를 판정에 쓸 수 없습니다. 그 결과 만드는 순서가 바뀌었습니다
> (아래 '종료 코드는 쓸 수 없습니다').

관련: [check-contract.md](check-contract.md) · [settings-contract.md](settings-contract.md) ·
[health-contract.md](health-contract.md) · [nginx-conf.md](nginx-conf.md) ·
[pm2-conf.md](pm2-conf.md) · [migration-plan.md](migration-plan.md)

## 왜 필요한가

지금 구축 절차는 **여덟 곳에 흩어져 있습니다.**

```
database/setup_mariadb.sh          nginx/install_nginx_stack.sh
pm2/ecosystem.config.js --check    services/kamailio/bootstrap.sh
services/kamailio/install.sh       services/janus/bootstrap.sh
services/janus/install.sh          services/janus/setup-dashboard.sh
```

각각은 잘 만들어져 있습니다 — 점검 모드가 있고, `[ok]/[--]/[!!]` 로 말하고,
실패하면 롤백합니다. **문제는 그것들 사이의 순서와 의존이 사람 머릿속에만 있다는
것입니다.** 순서를 뒤집으면 조용히 깨집니다.

| 뒤집으면 | 무슨 일이 나는가 |
|---|---|
| nginx 를 Janus 보다 먼저 | `/janus-api` 가 502, manager 에 "중단" 으로 뜸 |
| Kamailio 없이 Janus | 등록이 안 되는데 화면에는 아무 오류가 없음 |
| DB 없이 Kamailio | 기동은 되고 인증만 실패 (`child_init` 에서 붙으므로) |
| pm2 를 kamailio 그룹 없이 재기동 | 대시보드가 RPC FIFO 를 못 읽음 |

이 마법사는 **새 지식을 만들지 않습니다.** 이미 스크립트들이 아는 것을
순서대로 꺼내 보여 주고, 사람이 한 일을 검증하는 껍데기입니다.

## 어디에 두는가 — `manager`

`/manager/setup` 에 둡니다.

이 화면은 **여러 서비스를 가로지릅니다.** database·nginx·pm2·kamailio·janus·
websocket-relay 가 한 흐름 안에 들어옵니다. 어느 한 서비스의 대시보드에 두면
그 서비스가 다른 서비스를 아는 이상한 의존이 생깁니다.

`manager` 는 이미 그 일을 하고 있습니다.

| manager 가 이미 아는 것 | 어디서 |
|---|---|
| 서비스 목록과 라우트 | `nginx-conf` 스캐너 (`services/nginx.js`) |
| 프로세스 정의와 상태 | `pm2-conf` 스캐너 (`services/pm2.js`) |
| 살아 있는가 | `/health` 폴링 (`services/health.js`) |
| 로그인 세션 | 다른 대시보드들이 이미 이것을 빌려 씁니다 |

## 한 단계는 무엇으로 이루어지는가

```
 ┌─ 설명 ────────────────────────────────────────────┐
 │  무엇을 왜 하는가. 뒤집으면 무슨 일이 나는가.       │
 ├─ 입력 ────────────────────────────────────────────┤
 │  파라미터가 필요하면 폼. (예: 공인 IP, 포트 범위)   │
 │  → 서비스의 설정 파일에 쓴다                       │
 ├─ 지시 ────────────────────────────────────────────┤
 │  실행할 명령. sudo 가 필요하면 **보여 주기만** 한다 │
 ├─ 확인 ────────────────────────────────────────────┤
 │  사람이 "했습니다" 를 누른다                        │
 ├─ 점검 ────────────────────────────────────────────┤
 │  마법사가 그 서비스의 점검 스크립트를 돌려          │
 │  **정말 됐는지 본다.** 통과해야 다음으로 간다        │
 └───────────────────────────────────────────────────┘
```

핵심은 **확인과 점검이 다르다**는 것입니다. 사람이 눌렀다고 넘어가지 않습니다 —
눌렀을 때 비로소 점검을 돌리고, 그 결과가 다음 단계의 문을 엽니다.

## 단계 정의 — 데이터로 둡니다

화면에 순서를 박지 않습니다. 단계 하나를 이렇게 적습니다.

```js
{
  id: 'janus.config',
  service: 'janus',
  title: 'Janus 설정과 systemd 유닛 설치',
  why: 'Janus 는 배포본 설정 그대로면 SIP 플러그인도 /janus-api 도 뜨지 않습니다.',
  requires: ['kamailio.running', 'janus.build'],   // 선행 단계
  settings: { dir: 'services/janus' },              // 파라미터 폼 (선택)
  command: { cwd: 'services/janus', run: 'sudo ./install.sh --apply', sudo: true },
  // 점검은 셸을 거치지 않고 돌리므로 파일과 인자를 나눠 적습니다 (아래 '점검 계약')
  check:   { cwd: 'services/janus', file: './install.sh', args: ['--check', '--json'] },
  manualOnly: false,     // true 면 자동 점검이 불가능 (사람의 확인만 기록)
}
```

단계를 늘릴 때 **화면 코드는 손대지 않습니다.** janus 설정 화면에서 쓴 것과 같은
자세입니다 (`server/src/settings.js` 의 `SCHEMA`).

## 점검을 어떻게 읽는가 — 이미 있는 관례를 계약으로 승격

모든 점검 스크립트가 이미 같은 모양으로 말합니다.

```
  [ok]   kamailio 실행 중
  [--]   settings.ini 없음 — LAN 전용으로 설치됩니다
  [!!]   Kamailio 가 떠 있지 않습니다 — services/kamailio/bootstrap.sh
```

| 표시 | 뜻 |
|---|---|
| `[ok]` | 됐다 |
| `[--]` | 아직 안 했다 / 안 해도 되는 것이다 (**둘이 섞여 있다**) |
| `[!!]` | 문제다 |

### ⚠️ 종료 코드는 쓸 수 없습니다 — 실측으로 확인했습니다

설계 초안에서는 *"종료 코드를 1차 판정으로 삼는다"* 고 적었습니다. **틀렸습니다.**
일부러 깨뜨려 보고 알았습니다.

| 시험 | 결과 |
|---|---|
| `janus/install.sh` 에서 `secrets/api-secret` 을 치우고 실행 | `[--]` 로 보고, **종료 코드 0** |
| `janus/setup-dashboard.sh` 에서 `web/dist` 를 치우고 실행 | 경고 1줄, **종료 코드 0** |

원인은 분명합니다 — `install.sh` 의 `report()` 는 문제 개수와 무관하게 항상
`return 0` 입니다. 그 스크립트 입장에서는 옳습니다. **"점검을 정상적으로
마쳤다"** 는 뜻이지 "모두 갖춰졌다" 가 아니기 때문입니다.

종료 코드로 판정하는 것은 제가 이번에 쓴 것들(`bootstrap.sh`·`verify-*.sh`·
`check-public-ip.sh`)뿐이고, 기존 스크립트들은 그렇지 않습니다. **관례가 아예
없었던 것입니다.**

### `[--]` 도 판정에 쓸 수 없습니다

같은 표시가 두 가지를 뜻합니다.

```
[--]   settings.ini 없음 — LAN 전용으로 설치됩니다      ← 안 해도 되는 것
[--]   secrets/ 없음 — 아직 install.sh --apply 를 안 돌렸습니다  ← 아직 안 한 것
```

앞의 것은 통과여야 하고 뒤의 것은 막아야 합니다. 화면이 텍스트를 읽어 구분할
방법이 없습니다.

### 그래서 — 기계가 읽을 판정을 **먼저** 만듭니다

`--json` 을 1단계 전제로 올립니다. 초안에서 4단계로 미뤄 둔 것을 앞으로
당깁니다. 판정 근거가 없으면 마법사가 조용히 틀린 진행을 시키기 때문입니다.

```json
{
  "step": "janus.config",
  "state": "incomplete",          // complete | incomplete | problem
  "checks": [
    { "level": "ok",      "text": "바이너리: /opt/janus/bin/janus (1.4.1)" },
    { "level": "pending", "text": "secrets/ 없음 — install.sh --apply 를 돌리세요" },
    { "level": "problem", "text": "Kamailio 가 떠 있지 않습니다" }
  ]
}
```

- `[--]` 를 **`pending`(아직 안 함)과 `skip`(안 해도 됨)으로 쪼갭니다.** 지금
  섞여 있는 것을 여기서 가릅니다.
- 사람이 보는 텍스트 출력은 **그대로 둡니다.** `--json` 은 더하는 것이지 바꾸는
  것이 아닙니다 — 터미널에서 쓰던 사람의 습관을 깨지 않습니다.
- 이 형식을 `docs/check-contract.md` 로 못박습니다. `health-contract.md` 가
  `/health` 에 한 것과 같습니다.

작업량은 진입점 8개에 각각 출력 함수 하나씩입니다. `ok()`/`no()`/`warn()` 이 이미
한 곳에 모여 있으므로, 그 셋이 JSON 배열에도 담게 하면 나머지는 따라옵니다.

## sudo 경계 — 마법사는 넘지 않습니다

**마법사는 sudo 를 부르지 않습니다.** 명령을 보여 주고, 사람이 터미널에서
실행하고, 돌아와서 "했습니다" 를 누르면 마법사가 점검합니다.

janus 의 '설정' 화면에서 이미 이 방식을 썼고 동작을 확인했습니다. 이유도 같습니다 —
서비스를 재기동하는 일을 웹 단추 하나에 걸어 두지 않습니다.

| 단계 유형 | 마법사가 하는 일 |
|---|---|
| 점검만 (sudo 불필요) | 직접 실행하고 결과를 보여 줌 |
| 파라미터 입력 | 서비스의 설정 파일에 씀 (`settings.ini` 방식) |
| sudo 필요 | **명령을 보여 주기만.** 복사 단추 |
| 사람만 아는 것 | 아래 참고 |

## 자동으로 점검할 수 없는 단계

전부를 기계가 확인할 수는 없습니다.

- 공유기에 UDP 포워딩을 열었는가
- 인터폰이 쓸 SIP 계정을 만들었는가 (모바일·월패드는 relay 가 만듭니다 — `docs/identity.md`)
- 인터폰을 설치했는가

이런 단계는 `manualOnly: true` 로 두고, 사람의 확인을 **시각과 함께 기록**하되
**"확인되지 않음" 으로 표시합니다.** 통과로 위장하지 않는 것이 중요합니다 —
나중에 무언가 안 될 때 여기부터 의심할 수 있어야 합니다.

## 단계 그래프

의존을 `requires` 로 적으면 순서는 거기서 나옵니다. 지금 시스템의 모양은 이렇습니다.

```
database ─┬─────────────────────────────────────────┐
          │                                         │
          ├─▶ kamailio ─┬─▶ janus ─▶ janus-dashboard │
          │             │                           │
          │             └─▶ websocket-relay ◀──────┘
          │                    (착신 푸시)
          └─▶ manager

  pm2 ────────────────────▶ (모든 node 서비스)
  nginx ──────────────────▶ (모든 라우트)   ※ 서비스가 뜬 뒤에 반영
```

| # | 단계 | id | sudo | 점검 |
|---|---|---|---|---|
| 1 | MariaDB 설치·스키마 | `database.schema` | ✅ | `database/check-database.sh` ⭐ |
| 2 | pm2 설치·부팅 등록 | `pm2.apps` | ✅ | `pm2/ecosystem.config.js --check-json` |
| 3 | Kamailio 패키지·그룹·DB | `kamailio.deps` | ✅ | `services/kamailio/bootstrap.sh` |
| 4 | Kamailio 설정 포크 설치 | `kamailio.config` | ✅ | `services/kamailio/install.sh` |
| 5 | SIP 계정 만들기 (인터폰) | `sip.accounts` | ❌ 사람 | `check-accounts.sh` ⭐ + **인터폰 계정이 있는지는 사람의 확인** |
| 6 | Janus 빌드 의존성 | `janus.deps` | ✅ | `services/janus/bootstrap.sh` |
| 7 | **Janus 소스 빌드** | `janus.build` | ✅ 사람 | **사람의 확인만** — 오래 걸리고 실패 지점이 많음 |
| 8 | Janus 설정·유닛 | `janus.config` | ✅ | `services/janus/install.sh` |
| 9 | 대시보드 빌드 | `janus.dashboard` | ❌ | `services/janus/setup-dashboard.sh` |
| 10 | nginx 라우트 반영 | `nginx.routes` | ✅ | `nginx/install_nginx_stack.sh` |
| 11 | **websocket-relay 설치·기동** | `relay.service` | ❌ | `services/websocket-relay/check-relay.sh` (= `npm run doctor`) |
| 12 | 시험 통화 | `janus.verify.call` | ❌ | `verify-call.sh --check` — **`--run` 이 남긴 결과 파일을 읽는다** |
| 13 | 외부 브라우저 (선택) | `janus.publicip` | ❌ | `check-public-ip.sh` + **포워딩은 사람의 확인** |
| 14 | 착신 푸시 (선택) | `push.incoming` | ✅ | `services/kamailio/check-push.sh` ⭐ |
| 15 | 공인 인증서 발급 (선택) | `public_ca.issue` | ✅ | `nginx/public_ca/setup_letsencrypt.sh` ⭐ |
| 16 | nginx 에 물리기 (선택) | `public_ca.nginx` | ✅ | `nginx/public_ca/cert-status.sh` ⭐ |
| 17 | 90일 자동 갱신 (선택) | `public_ca.renew` | ✅ | `nginx/public_ca/renew-status.sh` ⭐ |
| 18 | 이름이 이 서버를 가리키나 (선택) | `public_ca.dns` | ❌ | `nginx/public_ca/check-dns.sh` |

⭐ 는 3단계(1·5·14)와 5단계(15·16·17)에서 새로 쓴 점검입니다. 1·14 는 붙일 곳이 없었습니다 —
`setup_mariadb.sh` 는 root 로 도는 적용 스크립트고, 착신 푸시는 네 조각이
서로 다른 서비스에 흩어져 있어 주인이 없었습니다.

11 은 websocket-relay 입니다. 모바일이 이 게이트웨이와 만나는 유일한 자리라
필수로 둡니다 (아래 '6단계에서 정한 것'). 15~18 은 공인 인증서(Let's Encrypt)입니다. 넷 다 **선택**입니다 — LAN 전용
설치는 사설 CA 로 계속 도는 것이 옳고, 공인 이름을 받을 수 없는 배치도 있기
때문입니다. 자세한 것은 아래 '5단계에서 정한 것' 과
[nginx/public_ca/README.md](../nginx/public_ca/README.md) 에 있습니다.

## 화면

```
 구축 마법사                                    3 / 11 단계 (선택 6)

 ✅ 1. MariaDB            ✅ 2. pm2            ▶ 3. Kamailio
 ○  4. 설정 설치          ○  5. SIP 계정        ○ 6. Janus 의존성  …

 ┌─ 3. Kamailio 패키지·그룹·DB ───────────────────────────┐
 │                                                        │
 │  왜 필요한가                                            │
 │    SIP 코어가 없으면 Janus 는 할 일이 없습니다.          │
 │    대시보드가 RPC FIFO 를 읽으려면 kamailio 그룹이…      │
 │                                                        │
 │  실행할 것                          [ 명령 복사 ]        │
 │    cd services/kamailio                                │
 │    sudo ./bootstrap.sh --install                       │
 │                                                        │
 │  [ 했습니다 — 점검하기 ]                                │
 │                                                        │
 │  ── 점검 결과 ────────────────────────────────────────  │
 │   [ok]   kamailio                    SIP 서버 본체      │
 │   [!!]   jejezz 가 kamailio 그룹에 없습니다              │
 │                                                        │
 │   ⚠️ 아직 통과하지 못했습니다. 위 [!!] 를 해결하세요.     │
 └────────────────────────────────────────────────────────┘
```

- 진행 상태는 **점검 결과로만** 결정됩니다. 사람이 누른 것은 점검을 부르는 방아쇠일 뿐입니다.
- 이미 통과한 단계는 다시 눌러 재점검할 수 있습니다 (구축 후 진단용으로도 씁니다).
- 마법사에 들어오면 **모든 단계를 한 번 점검해** 어디까지 됐는지 먼저 보여 줍니다.
  처음 세우는 사람과 이미 세운 사람이 같은 화면을 씁니다.

## 서버 쪽에서 필요한 것

| | 무엇 | |
|---|---|---|
| `GET /manager/api/setup` | 단계 정의 + 각 단계의 마지막 점검 결과 | ✅ |
| `POST /manager/api/setup/check/:stepId` | 그 단계의 점검 스크립트를 돌리고 `{state, checks[], exitCode, …}` 반환 | ✅ |
| `PUT /manager/api/setup/settings/:stepId` | 그 단계의 파라미터를 서비스의 `settings.ini` 에 씀 | ✅ |
| `POST /manager/api/setup/attest/:stepId` | 사람의 확인 기록 | ✅ |
| `DELETE /manager/api/setup/attest/:stepId` | 그 기록을 지움 (되돌렸을 때) | ✅ |
| 상태 저장 | 확인 기록만 파일 하나에. 나머지는 매번 점검해서 얻습니다 | ✅ |

구현은 [`services/manager/server/src/services/setup.js`](../services/manager/server/src/services/setup.js)
(단계 표 + 점검 실행기)와 [`web/src/pages/Setup.jsx`](../services/manager/web/src/pages/Setup.jsx)
두 곳입니다. 초안이 적어 둔 `{ok, exitCode, lines[]}` 는 규약이 자리를 잡으면서
`{state, checks[]}` 가 됐습니다 — 화면이 `[--]` 두 가지를 갈라 그려야 하기 때문입니다.

**상태를 최소로 둡니다.** 진행률을 DB 에 적어 두면 실물과 어긋나기 시작합니다 —
누군가 터미널에서 되돌려도 화면은 "완료" 로 남습니다. 매번 점검해 얻는 편이
느리지만 정직합니다.

### ⚠️ 자식 프로세스를 돌리는 것에 관하여

manager 가 셸 스크립트를 실행하게 됩니다. 지금까지 이 대시보드들은 그런 일을
하지 않았습니다.

- **인자를 사람 입력에서 만들지 않습니다.** 실행할 명령은 위 단계 정의에 **박혀
  있는 것만** 씁니다. `:stepId` 는 그 표의 키를 고르는 데만 쓰고, 문자열을 이어
  붙여 명령을 만들지 않습니다.
- **점검 모드만 돌립니다.** `--apply` · `--install` 처럼 무언가를 바꾸는 모드는
  마법사가 실행하지 않습니다.
- 타임아웃과 출력 상한을 둡니다 (점검이 매달리면 화면이 매달립니다).

## 2단계에서 정한 것 — 만들면서

### 화면에는 상태가 하나 더 있습니다 — `unknown`

규약의 `state` 는 셋입니다 (`complete` · `incomplete` · `problem`). 그것은
**점검을 마쳤을 때**의 값입니다. 마법사에는 점검을 *마치지 못한* 경우가 따로
있습니다.

| 언제 | 무슨 뜻인가 |
|---|---|
| 스크립트를 실행하지 못했다 | 경로가 바뀌었거나 실행 권한이 없다 |
| 매달렸다 | 30초 안에 끝나지 않았다 |
| 출력을 읽지 못했다 | `--json` 인데 다른 것이 섞여 나왔다 |
| 다른 단계를 보고했다 | `step` id 가 우리가 부른 것과 다르다 |

이것을 `problem` 으로 뭉치면 "고장났다" 로 읽히고, `incomplete` 로 뭉치면
"사람이 할 일이 남았다" 로 읽힙니다. 둘 다 거짓말입니다. 그래서 `unknown` 을
두고 **통과로도 실패로도 위장하지 않습니다.** 다음 단계는 열리지 않습니다.

`manualOnly` 가 "확인되지 않음" 을 통과로 위장하지 않는 것과 같은 자세입니다.

### 스크립트가 낸 `state` 를 그대로 믿지 않습니다

`checks` 에서 다시 계산해 씁니다. 규칙은 규약 그대로이고, 어긋나면 로그에
남긴 뒤 **계산한 쪽**을 씁니다.

방어를 한 겹 더 두는 값이 아닙니다 — 화면이 "통과" 라고 말하는데 그 안에
`[!!]` 가 섞여 있는 상태를 만들지 않기 위해서입니다. 그건 아무것도 없는 것보다
나쁩니다.

### 점검 명령에 `--check` 를 명시적으로 붙입니다

`--json` 만으로도 지금은 점검 모드가 됩니다 — 세 스크립트 모두 기본 모드가
`check` 입니다. 그래도 `--check --json` 으로 적습니다. 기본 모드가 언젠가
바뀌어도 마법사가 무언가를 **바꾸는** 모드를 돌리는 일은 없어야 합니다.

### 잠금은 서버가 가진 마지막 결과에서만 나옵니다

`requires` 판정을 화면에서도 계산하면 규칙이 두 곳이 됩니다. 점검을 한 번 돌릴
때마다 `GET /manager/api/setup` 을 다시 읽습니다 — 그것은 메모리만 읽으므로
자식 프로세스가 다시 돌지 않습니다.

### 실측 — 지금 세 점검은 동기로 기다려도 됩니다

| 점검 | 걸린 시간 |
|---|---|
| `kamailio/bootstrap.sh --check --json` | 0.08 초 |
| `janus/install.sh --check --json` | 0.14 초 |
| `nginx/install_nginx_stack.sh --check --json` | 0.03 초 |

화면에 들어오면서 셋을 차례로 돌려도 0.3초입니다. 열린 질문 1
(`verify-call.sh` 는 90초)은 그 단계가 들어오는 3단계에서 답하면 됩니다.

### 실행 경계 — 실제로 건 것

| | |
|---|---|
| 무엇을 돌리는가 | `services/setup.js` 의 표에 박힌 것만. `:stepId` 는 표에서 한 줄을 고르는 데만 쓴다 |
| 어떻게 | `execFile` — **셸을 거치지 않는다.** 문자열을 이어 붙여 명령을 만들지 않는다 |
| 어디까지 | 실행 파일이 저장소 밖으로 나가면 거부한다 |
| 얼마나 | 타임아웃 30초, 출력 상한 1MB, 같은 단계는 겹쳐 돌지 않는다 |
| 무엇을 안 하는가 | `--apply` · `--install` 같은 바꾸는 모드. sudo |

### 진행률은 저장하지 않습니다 — 메모리에도 최소로

마지막 점검 결과는 manager 프로세스 안에만 있습니다. 재기동하면 비고, 화면이
들어오면서 다시 점검합니다. 느리지만 실물과 어긋나지 않습니다.

## 3단계에서 정한 것 — 13단계를 다 붙이면서

### 확인 기록은 파일에 둡니다 — DB 가 1단계이기 때문입니다

열린 질문 2의 답입니다. manager 는 MariaDB 를 씁니다. 그런데 **MariaDB 를
세우는 것이 이 마법사의 1단계입니다.** 확인 기록을 DB 에 두면 DB 가 아직 없는
동안에는 아무것도 기록할 수 없습니다 — 마법사가 자기 자신을 기다리는 모양이
됩니다.

`services/manager/setup-attest.json` 하나에 둡니다. 이 장비 한 대의 구축
이력이고 크기도 열댓 줄입니다. 커밋하지 않습니다.

### 90초짜리 시험 통화는 마법사가 돌리지 않습니다

열린 질문 1의 답입니다. `verify-call.sh` 는 이미 두 모드를 갖고 있습니다 —
`--check` 는 준비 상태만 보고 끝나고, `--run` 이 실제로 겁니다. 마법사는
`--check --json` 만 돌립니다. 통화 자체는 사람이 터미널에서 돌리고, 그 결과를
확인으로 기록합니다.

sudo 명령을 다루는 방식과 같습니다 — **오래 걸리고 되돌리기 어려운 일은 사람의
손에 둡니다.** 작업 큐와 폴링은 만들지 않았습니다. 그것이 필요한 점검이 이
하나뿐이라, 하나 때문에 구조를 늘리지 않습니다.

### 상태가 하나 더 늘었습니다 — `attested`

"확인되지 않음" 으로만 표시하고 문을 열지 않으면 마법사는 5단계(SIP 계정)에서
영원히 멈춥니다. 그렇다고 `complete` 로 두면 거짓말입니다.

그래서 `attested` 를 둡니다. 다음 단계는 열어 주되 초록색 "통과" 가 아니라
**"사람이 확인함"** 으로 그리고, 누가 언제 눌렀는지를 함께 보여 줍니다.

**사람의 확인이 점검을 이기지 못합니다.** 점검이 `problem` 이면 확인 기록이
있어도 `problem` 입니다. 확인은 기계가 볼 수 없는 자리를 메우는 것이지, 기계가
본 것을 덮는 것이 아닙니다.

| 단계 | 점검 | 확인 | 결과 |
|---|---|---|---|
| 7 (사람만) | 없음 | 있음 | `attested` |
| 5 · 12 (둘 다) | `complete` | 없음 | `incomplete` — "남은 것은 사람의 확인입니다" |
| 5 · 12 (둘 다) | `complete` | 있음 | `attested` |
| 5 · 12 (둘 다) | `problem` | 있음 | `problem` — **확인이 덮지 못합니다** |

### 점검이 없던 두 자리를 새로 썼습니다

1단계에서 진입점 10곳에 `--json` 을 붙였지만, 13단계 표의 두 자리는 붙일 곳이
아예 없었습니다.

- **1단계(MariaDB).** `setup_mariadb.sh` 는 root 로 도는 적용 스크립트입니다
  (`--dry-run` 도 "무엇이 바뀔지" 를 보여 줄 뿐입니다). 확인만 하는 입구를
  `database/check-database.sh` 로 따로 뒀습니다. **공용 계정(jyahn)으로**
  확인합니다 — root 소켓 인증을 쓰면 sudo 없이 도는 마법사에서 늘 "확인 불가"
  가 되기 때문입니다.
- **13단계(착신 푸시).** 네 조각(tsilo 훅 · `wt_timer` · websocket-relay ·
  `sip_user` 매핑)이 서로 다른 서비스에 흩어져 있어 주인이 없었습니다.
  `services/kamailio/check-push.sh` 가 그 넷을 한 줄씩 봅니다.

**그리고 이것을 붙이자마자 하나가 걸렸습니다.** 설치본
`/etc/kamailio/kamailio.cfg` 에 `wt_timer` 가 없었습니다 — 저장소에는 있는데
설치가 그보다 이틀 앞선 것이었습니다. 붙들어 둔 INVITE 가 기본값 5초에
사라지는 상태였고, FCM 왕복이 2~8초이므로 **실제로는 못 받습니다.** 화면
어디에도 오류로 보이지 않는 종류의 어긋남입니다.

    [--]  wt_timer 가 설치본에 없습니다 — 붙들어 둔 INVITE 가 기본값 5초에
          사라져 FCM 왕복(2~8초)을 못 기다립니다 → sudo services/kamailio/install.sh --apply

마법사가 처음으로 잡아낸 실물 문제입니다. 만든 이유가 이것입니다.

### 13단계를 다 돌리는 데 1.3초

| | |
|---|---|
| 점검 11개 (사람 확인 2개 제외) | 합계 **1.3초** |
| 가장 느린 것 | `janus.dashboard` 0.36초 · `janus.deps` 0.34초 |
| 가장 빠른 것 | `nginx.routes` 0.03초 |

화면에 들어올 때마다 전부 돌려도 됩니다. 진행률을 저장하지 않는 값이 이만큼
싸다는 뜻입니다.

### 단계 하나를 주소로 가리킬 수 있습니다

`/manager/setup?step=janus.config` — "이 단계를 보세요" 를 링크 하나로 건네기
위해서입니다.

## 4단계에서 정한 것 — 파라미터를 받으면서

### 스키마를 데이터로 내렸습니다 — 화면이 둘이 됐기 때문입니다

열린 질문 3의 답입니다. 값을 받는 화면이 janus 대시보드 하나였을 때는 항목
정의가 그 서비스의 코드 안에 있어도 괜찮았습니다. 마법사가 같은 값을 받게
되면서 화면이 둘이 됐고, 둘이 각자 정의를 들면 언젠가 어긋납니다.

```
services/<서비스>/settings-schema.json   무엇을 받을 것인가   (커밋한다)
services/<서비스>/settings.ini           사람이 정한 값       (커밋하지 않는다)
services/<서비스>/.applied-settings      실제로 설치된 값     (--apply 가 쓴다)
```

읽고 쓰고 검증하는 코드는 `lib/settings.js` 한 곳입니다. janus 대시보드의
설정 화면도 이제 그것을 씁니다 — 그 서비스의 `settings.js` 는 껍데기만
남았습니다. 규약은 [settings-contract.md](settings-contract.md) 입니다.

### kamailio 에도 붙였습니다 — 거기 이 장비의 주소가 박혀 있었습니다

`services/kamailio/install.sh` 안에 이렇게 적혀 있었습니다.

```bash
SIP_LISTEN_ADDR="192.168.0.252"      # ← 이 장비의 LAN 주소
```

새 장비에서 이 마법사를 쓰는 사람은 **13단계를 다 통과하고도 SIP 가 안 뜹니다.**
`listen=` 에 자기 것이 아닌 주소가 들어가기 때문입니다. 마법사를 만드는 이유가
"새 장비에서 다시 세울 수 있게" 인데, 그 장비의 주소가 스크립트에 박혀 있으면
앞의 노력이 거기서 무너집니다.

세 값(`sip_domain` · `sip_listen_addr` · `sip_push_url`)을 `settings.ini` 로
옮겼습니다. `sip_listen_addr` 만 **기본값을 두지 않았습니다** — 한 장비의
주소를 다른 장비가 물려받을 수 없기 때문입니다. 없으면 점검이 "아직 정하지
않았다" 로 보고합니다.

### 형식은 화면이, 현실은 스크립트가 봅니다

`sip_listen_addr = 10.9.9.9` 는 IPv4 로는 멀쩡합니다. 그런데 그 주소가 이
장비에 없으면 Kamailio 는 바인딩에 실패해 죽고, 문법 검사(`kamailio -c`)는
통과하므로 **재시작에서야** 드러납니다.

이런 검사는 장비를 아는 쪽이 합니다 — `install.sh` 의 `validate_settings` 가
`ip -o -4 addr` 로 실제 주소 목록과 맞춰 봅니다. 스키마에는 형식만 적습니다.

### 저장과 반영은 다릅니다 — 그리고 점검이 그것을 말합니다

폼에서 값을 저장하는 것은 **파일에 적는 것뿐**입니다. 반영은 사람이 `--apply`
를 돌려야 일어납니다. 그 사이의 상태를 화면이 조용히 넘기면, 값을 입력한 사람은
적용했다고 착각합니다.

그래서 두 `install.sh` 의 **점검**이 저장된 값과 `.applied-settings` 를 비교해
`[--]` 로 보고하게 했습니다. 판정을 마법사가 따로 계산하지 않는 이유이기도
합니다 — 규칙이 두 곳이 되지 않습니다.

    [--]  public_ip 가 아직 반영되지 않았습니다:
          설치본 '125.242.8.15' → 저장한 값 '203.0.113.9' (sudo ./install.sh --apply)

폼에서 값을 바꾸면 그 단계가 곧바로 '통과' 에서 '아직' 으로 내려갑니다.

### 마법사가 파일을 쓰는 곳은 둘뿐입니다

| 무엇 | 어디에 |
|---|---|
| 사람의 확인 기록 | `services/manager/setup-attest.json` |
| 파라미터 | `services/<서비스>/settings.ini` |

둘 다 **값 파일**이고, 경로는 단계 표가 정합니다(사람 입력에서 만들지 않고,
저장소 밖으로 나가면 거부합니다). 설정 파일 자체(`.jcfg`·`kamailio-local.cfg`)
는 건드리지 않고, 서비스를 재기동하지도 않습니다.

### 곁다리 — 1단계에서 놓친 호출 하나

`kamailio/install.sh` 에 `no "WITH_AUTH 없음"` 이 남아 있었습니다. `no()` 는
1단계에서 `skip`/`pend` 로 쪼개며 없앤 함수인데 호출만 살아 있었습니다.
`WITH_AUTH` 가 **없을 때만** 실행되는 자리라 지금까지 아무도 밟지 않았습니다 —
점검이 문제를 보고해야 하는 바로 그 순간에 스크립트가 죽었을 것입니다.
`warn` 으로 고쳤습니다.

## 5단계에서 정한 것 — 공인 인증서를 붙이면서

발급 절차와 점검 스크립트는 이미 `nginx/public_ca/` 에 있었습니다
([README](../nginx/public_ca/README.md)). 마법사에 넣으면서 정한 것들입니다.

### 한 덩어리를 넷으로 쪼갰습니다

"공인 인증서를 쓴다" 는 한 가지 일처럼 보이지만, **실패하는 자리가 넷**이고
서로 다릅니다.

| 단계 | 묻는 것 | 여기서 실패하면 |
|---|---|---|
| `public_ca.issue` | 발급받았나 | 아무것도 시작되지 않음 |
| `public_ca.nginx` | 발급받은 것을 **내밀고 있나** | 파일은 새것인데 나가는 건 옛것 |
| `public_ca.renew` | 90일 뒤에도 내밀 것인가 | **90일 뒤에** 전면 장애 |
| `public_ca.dns` | 이름이 아직 이 서버를 가리키나 | 즉시 전면 장애 + 갱신도 조용히 실패 |

특히 가운데 둘이 한 단계였으면 "통과" 가 두 가지를 뜻하게 됩니다. **발급은
됐는데 reload 를 잊은 상태**와 **갱신 훅이 빠진 상태**는 둘 다 지금은 멀쩡해
보이고, 각각 다른 날 다른 이유로 터집니다.

### 점검이 sudo 를 넘지 않게 두 곳을 고쳤습니다

마법사는 sudo 를 부르지 않습니다. 그런데 이 영역은 root 소유 자리를 봐야 합니다.

**80 포트 확인.** 예전 `--check` 는 webroot 에 파일을 하나 넣고 200 이 오는지
봤습니다. 그 자리는 `root:www-data` 입니다. 지금은 **없는 이름**을 부르고 404 가
오는지 봅니다 — 생성기가 만드는 예외 블록이 `try_files $uri =404` 라, 없는
이름의 정답이 404 입니다. 확인하려던 셋(바깥에서 80 이 열렸나 · 평문으로
응답하나 · 예외 location 이 살아 있나)을 그대로 다 확인하면서 권한이 필요
없어졌습니다. 301 이 오면 예외가 아직 반영 안 된 것이라 그 자체로 진단입니다.

**발급 여부.** `/etc/letsencrypt/live/` 는 `0700 root` 라 못 읽습니다. 대신
`/etc/letsencrypt/renewal/<이름>.conf` 를 읽습니다 — `0755` 디렉토리의 `0644`
파일이고, **발급의 결과로만 생깁니다.** 갱신 훅이 걸렸는지, 운영 서버에서
받았는지 시험 서버에서 받았는지도 같은 파일에 있습니다.

### `--json` 이 이미 다른 뜻이던 자리 — `--check` 로 가릅니다

`cert-status.sh --json` 은 원래 대시보드가 읽는 형식입니다. pm2 선언이
`--check-json` 을 쓴 것과 같은 상황인데, 여기서는 **`--check` 를 더해서**
갈랐습니다.

```
./cert-status.sh              사람이 읽는 형식      (그대로)
./cert-status.sh --json       대시보드용            (그대로)
./cert-status.sh --check      판정 줄               (새로)
./cert-status.sh --check --json   점검 규약          (새로)
```

`check_args` 가 `--json` 만 걸러내므로 두 형식이 한 파일에서 공존합니다.
기존 두 모드는 손대지 않았습니다.

### 넷 다 '선택' 입니다 — 그런데 잊히지는 않습니다

LAN 전용 설치는 사설 CA 로 계속 도는 것이 옳고, 공인 이름을 받을 수 없는
배치(도메인이 없거나 80 을 열 수 없는 회선)도 실재합니다. 필수로 두면 그런
장비에서 마법사가 영원히 "11/15" 를 가리키게 됩니다.

대신 대시보드의 TLS 카드가 사설 CA 를 계속 `warn` 으로 둡니다. **이관이 안
끝났다는 사실은 거기 남아 있습니다** — 선택으로 둔 것이 "안 해도 된다" 가
되지 않게.

선택 단계끼리는 `requires` 로 겁니다 (`nginx` → `renew` → `dns`). `optional` 의
뜻이 "아무도 requires 로 걸지 않는다" 에서 **"필수 단계가 걸지 않는다"** 로
좁아졌습니다.

### 도메인은 `settings.ini` 로 받습니다

단지마다 이름 하나·인증서 하나이므로 장비마다 다른 값입니다
([settings-contract.md](settings-contract.md)). 폼에서 받아
`nginx/public_ca/settings.ini` 에 쓰고, 네 스크립트가 전부 그것을 읽습니다.
`--prod` 가 성공하면 무엇을 발급했는지 `.applied-settings` 에 남기므로,
도메인이나 메일을 바꿔 놓고 다시 받지 않은 상태가 `pending` 으로 드러납니다.

## 6단계에서 정한 것 — websocket-relay 를 붙이면서

점검은 이미 있었습니다. `npm run doctor` 가 여덟 자리(설정·의존성·대시보드
빌드·FCM·DB·pm2·nginx·`/health`)를 보고 문제마다 해결 명령을 붙여 줍니다.
**판정을 낼 통로만 없었습니다.**

그래서 착신 푸시(`push.incoming`)가 relay 의 `/health` 한 줄만 보고 있었습니다.
그 서비스가 제대로 설치됐는지 — `.env` 가 있는지, 마이그레이션이 다 돌았는지,
재부팅 뒤에도 뜰지 — 는 마법사 어디에도 없었습니다.

### 필수로 둡니다

모바일이 이 게이트웨이와 만나는 **유일한 자리**입니다. WebRTC 시그널링도
IoT 도 착신 푸시도 전부 여기를 지나고, 깨울 단말을 찾는 표(`rtc_mobiles`)도
이 서비스가 들고 있습니다. 이것이 없으면 Kamailio 가 INVITE 를 붙들어 둔 채
깨우러 갈 데가 없습니다.

`push.incoming` 의 `requires` 를 `nginx.routes` 에서 `relay.service` 로 바꿨습니다.
깨우러 갈 상대가 서 있어야 그 단계가 의미를 갖고, `relay.service` 가 이미
`nginx.routes` 를 걸고 있어 순서는 그대로입니다.

### `bad` 하나를 `pend` 와 `bad` 로 쪼갰습니다

`Reporter` 는 `ok`·`warn`·`bad` 셋만 알았습니다. 규약에는 넷이 있고, 그중
**`pending`(아직 안 한 것)과 `problem`(잘못된 것)의 차이가 판정을 가릅니다.**

```
✗ .env 가 없습니다.            → npm run setup      ← 아직 안 한 것   pending
✗ COMPLEX_ID 형식이 잘못됐습니다                      ← 잘못된 것      problem
```

앞은 새로 세우는 장비의 정상적인 상태이고, 뒤는 고장입니다. 한 레벨로 묶으면
처음 세우는 사람에게 마법사가 온통 "문제" 라고 말하게 됩니다.

**사람이 보는 출력은 둘 다 그대로 `✗` 입니다** — `check-report.sh` 가 `skip` 과
`pend` 를 둘 다 `[--]` 로 두는 것과 같은 이유입니다. `contract()` 를 부르지
않으면 `Reporter` 는 예전과 똑같이 동작하므로 `setup`·`db-migrate`·`db-status`
는 아무것도 달라지지 않았습니다.

`warn` 은 `skip` 이 됩니다. doctor 의 `warn` 은 원래 "선택 기능이 꺼져 있다"
(FCM 키 없음)거나 "확인하지 못했다"(DB 비밀번호를 못 읽음) 였고, 둘 다
판정에 넣으면 안 되는 것들입니다.

### 껍데기를 한 겹 둘렀습니다 — `check-relay.sh`

`doctor.ts` 는 `tsx` 로 도는데 `tsx` 는 `node_modules` 안에 있습니다. **아직
`npm install` 을 안 한 장비에서는 점검이 실행조차 되지 않습니다.** 그대로 두면
마법사는 `unknown` 과 함께 "실행할 수 없습니다 (ENOENT)" 만 말합니다 — 사실이지만
무엇을 해야 하는지는 알려 주지 않습니다.

셸 껍데기가 그 한 경우만 먼저 잡아 `pending` 으로 바꿔 줍니다.

```json
{ "level": "pending", "text": "node_modules 가 없어 점검을 돌릴 수 없습니다 → cd services/websocket-relay && npm install" }
```

이유가 하나 더 있습니다. 마법사의 실행기는 **셸 스크립트와 node 만** 압니다
(`setup.js` 의 `resolveCheck`). `tsx` 는 모릅니다.

### 값을 받는 폼은 두지 않았습니다

`settings.ini` 는 `키 = 값` 이고 `.env` 는 dotenv 형식이라 같은 파일이 될 수
없습니다. 그리고 무엇을 물어야 하는지는 `npm run setup` 이 이미 알고 있습니다
(DB 비밀번호 확인, 단지 ID 생성까지 합니다). 마법사는 **그 결과**를 봅니다 —
`.env` 가 있는가, `COMPLEX_ID` 가 소문자 16진수 8자인가, 세션 시크릿이 있는가.

## 설치본이 낡은 것을 잡는다 — 열린 질문 4

`wt_timer` 가 그렇게 걸렸습니다. 저장소에는 있는데 설치본에는 없었고, 훅이
있는지만 grep 하던 점검은 통과로 보고했습니다. **표식이나 특정 줄만 보는 검사는
그 줄만 봅니다.**

그래서 파일 단위로 "설치본이 저장소와 같은가" 를 보는 공용 비교를 만들었습니다
([`lib/config-diff.sh`](../lib/config-diff.sh), 규약은
[check-contract.md](check-contract.md) 의 같은 이름 절).

붙이자마자 **또 하나 나왔습니다.**

    [--]  설치본이 지금 선언과 다릅니다 (20줄) — 반영하세요:
          sudo ./install_nginx_stack.sh --skip-install

`/etc/nginx/conf.d/path-routing.conf` 에 `/sip/` 라우트와 `kamailio_backend`
업스트림이 그대로 남아 있었습니다. 저장소에서는 커밋 `6ff541f`("/sip/ 라우트를
끈다 — 쓸 클라이언트가 없다")로 끈 지 오래인데, nginx 에 반영을 안 해서 계속
서비스되고 있었습니다. **결정은 저장소에 남았고 장비는 모르고 있었습니다.**

| 견주는 것 | 어디서 |
|---|---|
| `kamailio.cfg` · `kamailio-local.cfg` | `services/kamailio/install.sh` |
| `.jcfg` 넷 · `janus.service` | `services/janus/install.sh` |
| `path-routing.conf` | `nginx/generate_nginx_conf.py` (선언대로 만든 것과 견줌) |
| 선언 ↔ 실행 중 ↔ `dump.pm2` | `pm2/ecosystem.config.js` (파일이 아니라 프로세스) |
| `99-project.cnf` | `database/check-database.sh` (`database.ini` 로 만든 것과 견줌) |

세 가지를 지켰습니다.

- **자리표시자 자리는 눌러서 비교합니다.** 값이 맞는지는 `settings.ini` ↔
  `.applied-settings` 쪽이 봅니다. 여기서 보는 것은 구조입니다.
- **판정은 `pending`.** 고장이 아니라 아직 반영하지 않은 것입니다.
- **다른 줄의 내용을 함부로 찍지 않습니다.** 설치본에는 비밀이 들어 있습니다 —
  저장소 쪽 줄만 보여 주고 설치본 쪽은 개수만 말합니다.

그리고 원인 하나를 고쳤습니다. `kamailio-local.cfg` 의 **주석에**
`__DBURL__` 이라고 적혀 있어서, 치환이 파일 전체를 훑는 바람에 설치본 주석에
DB 비밀번호가 박히고 있었습니다.

## 사람의 확인보다 증거가 낫다 — 11단계를 바꿨습니다

3단계에서 시험 통화(11)는 "사람이 `--run` 을 돌리고 결과를 확인으로 기록" 하게
두었습니다. 그런데 `verify-call.sh --run` 은 이미 결과를 파일로 남깁니다
(`test-harness/last-run/result.json` — 통과 여부·패킷 수·코덱까지).

**주장 대신 증거를 읽으면 됩니다.** 점검이 그 파일을 읽어 판정합니다.

```
[ok]   통과 (08-22 03:04)
```

사람의 확인 기록보다 나은 점이 둘입니다.

- **언제 돌렸는지가 남습니다.** 그래서 그 뒤에 Janus 설정이나
  `kamailio-local.cfg` 가 바뀌었으면 "지금 설정으로 다시 걸어 보세요" 라고
  말할 수 있습니다. 확인 기록으로는 그 판단을 할 수 없습니다.
- 사람이 "통과했다" 고 누른 것과, 도구가 "297패킷 양방향, opus" 라고 적어 둔
  것은 무게가 다릅니다.

마법사가 그 90초짜리 통화를 **대신 돌리지는 않습니다** — 그건 그대로입니다.
`.applied-settings` 를 읽는 것과 같은 자세입니다. 사람이 한 일의 흔적을 읽을
뿐, 사람에게 다시 묻지 않습니다.

같은 이유로 5단계(SIP 계정)에도 점검을 붙였습니다. 무엇이 만들어져 있는지는
기계가 보여 주고(도메인이 어긋난 계정과 비밀번호가 빈 계정도 잡습니다),
**쓸 것이 다 있는지**만 사람이 판단합니다. 그 판단은 대신할 수 없습니다.

## 만들지 않는 것

- **sudo 대행.** 명령을 보여 줄 뿐입니다.
- **되돌리기.** 각 스크립트가 이미 자기 롤백을 갖고 있습니다.
- **원격 장비 구축.** 이 장비 하나만 봅니다.
- **진행률 저장.** 위 참고.

## 단계별로 만들기

| | 범위 | |
|---|---|---|
| 1 | **점검 스크립트에 `--json` 추가** + `check-contract.md` — 판정 근거를 먼저 만든다 | ✅ 진입점 10곳 |
| 2 | manager 가 점검을 실행하고 결과를 보여 줌. 단계 3개(kamailio·janus·nginx)로 뼈대 확인 | ✅ |
| 3 | 13단계 전부 + `manualOnly` 확인 기록 | ✅ |
| 4 | 파라미터 입력 폼 (janus `settings.ini` 방식을 다른 서비스로) | ✅ |
| 5 | **공인 인증서** 발급·물리기·갱신·DNS 네 단계 (`nginx/public_ca/`) | ✅ |
| 6 | **websocket-relay** — 이미 있던 `npm run doctor` 를 규약에 잇는다 | ✅ |

**1단계를 앞으로 당긴 것이 이번 설계의 가장 큰 변경입니다.** 판정 근거 없이 화면을
먼저 만들면, 마법사가 "완료" 라고 말하는데 실제로는 안 된 상태를 만들어 냅니다.
그건 아무것도 없는 것보다 나쁩니다.

2단계도 위험합니다 — manager 가 자식 프로세스를 돌리는 것이 처음이라, 거기서
경계를 잘못 잡으면 나머지가 다 그 위에 쌓입니다.

## 지금 어디까지 왔나 (2026-08-22 확인 · 11 과 15~18 은 2026-08-29)

이 장비에서 마법사를 한 바퀴 돌린 결과입니다. **필수 12단계 중 10 통과.**

| # | 단계 | 상태 |
|---|---|---|
| 1 | `database.schema` | ✅ |
| 2 | `pm2.apps` | ✅ 선언 · 실행 중 · 재부팅 목록 셋이 같음 |
| 3 | `kamailio.deps` | ✅ |
| 4 | `kamailio.config` | ✅ |
| 5 | `sip.accounts` | 계정 8개 확인 — **사람의 확인만 남음** |
| 6 | `janus.deps` | ✅ |
| 7 | `janus.build` | 1.4.1 설치됨 — **사람의 확인만 남음** |
| 8 | `janus.config` | ✅ |
| 9 | `janus.dashboard` | ✅ |
| 10 | `nginx.routes` | ✅ |
| 11 | `relay.service` | ✅ 여덟 자리 전부 — `.env` · 의존성 · 대시보드 빌드 · FCM 키 · 마이그레이션 6개 · pm2 · nginx · `/health` |
| 12 | `janus.verify.call` | ✅ 실제 통화 통과 (양방향 297패킷, opus) |
| 13 | `janus.publicip` (선택) | 공인 IP 일치 — **포워딩 확인만 남음** |
| 14 | `push.incoming` (선택) | 서버 쪽 네 자리 다 붙음 — **단말이 `sipUser` 를 보내면 채워짐** |
| 15 | `public_ca.issue` (선택) | ✅ `c-a3f19c04.rtc.zoomon.art` 운영 서버에서 발급됨 |
| 16 | `public_ca.nginx` (선택) | ✅ 설정도 실물도 공인 인증서 (`fullchain.pem`) |
| 17 | `public_ca.renew` (선택) | ✅ 타이머 활성·부팅 등록 · 갱신 훅 있음 · 89일 남음 |
| 18 | `public_ca.dns` (선택) | ✅ A 레코드가 현재 공인 IP 와 같음 |

11 과 15~18 은 **이미 되어 있던 것을 마법사가 확인한 것**입니다. 이 장비는 이관이
끝나 있었고, 마법사는 그것을 판정할 통로가 없었을 뿐입니다. 넷 다 돌리는 데
1.3초입니다 (대부분 DNS·80 포트 확인의 네트워크 왕복).

### 마법사를 만들면서 실제로 잡은 것

만들어 두니 곧바로 세 가지가 걸렸습니다. 셋 다 **어디에도 오류로 보이지 않던**
것들입니다.

| 무엇 | 어떤 상태였나 |
|---|---|
| `wt_timer` 가 설치본에 없음 | 착신 푸시로 붙들어 둔 INVITE 가 5초에 사라져 FCM 왕복(2~8초)을 못 기다림 |
| `/sip/` 라우트가 nginx 에 남아 있음 | 저장소에서 끈 지 오래인데 계속 서비스 중 |
| `kamailio-local.cfg` 주석에 DB 비밀번호 | 주석에 자리표시자를 적어 둬 치환이 그것까지 채움 |

### 다시 볼 때

화면으로 보려면 `/manager/setup` 에서 **전체 점검**을 누릅니다. 들어올 때마다
전부 다시 돌리므로(11개에 1.3초) 저장된 진행률과 실물이 어긋날 일이 없습니다.
단계 하나를 가리키려면 `?step=<id>` 를 붙입니다.

터미널로 보려면 각 점검을 그대로 돌리면 됩니다. 모두 sudo 가 필요 없습니다.

```bash
database/check-database.sh
node pm2/ecosystem.config.js --check
services/kamailio/bootstrap.sh
services/kamailio/install.sh
services/kamailio/check-accounts.sh
services/janus/bootstrap.sh
services/janus/install.sh
services/janus/setup-dashboard.sh
nginx/install_nginx_stack.sh --check
services/janus/verify-call.sh            # --run 은 실제로 90초 걸린다
services/janus/check-public-ip.sh
services/kamailio/check-push.sh
services/websocket-relay/check-relay.sh          # = npm run doctor
nginx/public_ca/setup_letsencrypt.sh --check    # 발급 전 준비 + 발급 여부
nginx/public_ca/cert-status.sh --check          # 지금 무엇이 나가고 있나
nginx/public_ca/renew-status.sh                 # 90일 뒤에도 나갈 것인가
nginx/public_ca/check-dns.sh                    # 이름이 아직 이 서버를 가리키나
```

## 열린 질문

1. ~~**점검이 오래 걸리는 것들**~~ — 답했습니다. 마법사는 `--check` 만 돌리고
   `--run` 은 사람이 돌립니다 (위 '90초짜리 시험 통화').
2. ~~**`manualOnly` 확인 기록을 어디에 둘지**~~ — 답했습니다. 파일입니다.
   DB 를 세우는 것이 1단계이기 때문입니다 (위 '확인 기록은 파일에').
3. ~~**다른 서비스의 설정도 `settings.ini` 방식으로 옮길지**~~ — 답했습니다.
   스키마를 데이터로 내리고 kamailio 에도 붙였습니다 (위 '스키마를 데이터로').
   `websocket-relay` 는 아직 두었습니다. 11단계로 들어왔지만 값은 여전히
   자기 `.env` 가 받습니다 — `settings.ini` 는 `키 = 값` 이고 `.env` 는
   dotenv 형식이라 같은 파일이 될 수 없고, 무엇을 물어야 하는지는
   `npm run setup` 이 이미 알고 있습니다. 점검은 그 결과(`.env` 가 있는가,
   `COMPLEX_ID` 형식이 맞는가)를 봅니다.
4. ~~**설치본이 저장소보다 낡은 것을 어떻게 알아챌지**~~ — 답했습니다.
   `lib/config-diff.sh` 로 파일 단위 비교를 넣었고, 붙이자마자 nginx 에서
   하나 더 나왔습니다 (위 '설치본이 낡은 것을 잡는다').
5. ~~**pm2 는 어떻게 볼지**~~ — 답했습니다. 파일이 아니라 프로세스라
   **셋**(선언 · `pm2 jlist` · `dump.pm2`)을 견줍니다
   ([check-contract.md](check-contract.md) 의 'pm2 는 파일이 아니라').
   재기동만 하고 `pm2 save` 를 잊은 상태는 **재부팅 전까지 아무 증상이
   없어서**, 이 셋 중 셋째를 보지 않으면 잡을 방법이 없습니다.
