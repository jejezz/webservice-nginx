# 점검 규약 — `--json`

점검 스크립트가 **기계에게** 결과를 말하는 형식입니다. 구축 마법사
([setup-wizard.md](setup-wizard.md))가 이것을 읽어 단계의 통과 여부를 정합니다.

구현은 [`lib/check-report.sh`](../lib/check-report.sh) 하나에 모여 있습니다.

## 왜 필요한가 — 종료 코드로는 안 됩니다

처음에는 종료 코드로 판정하려 했습니다. 실측해 보니 안 됩니다.

| 일부러 깨뜨린 것 | 결과 |
|---|---|
| `services/janus/install.sh` 에서 `secrets/api-secret` 을 치움 | `[--]` 로 보고, **종료 코드 0** |
| `services/janus/setup-dashboard.sh` 에서 `web/dist` 를 치움 | 경고 1줄, **종료 코드 0** |

`report()` 가 문제 개수와 무관하게 항상 `return 0` 이기 때문입니다. **그 스크립트
입장에서는 옳습니다** — 종료 코드는 *"점검을 정상적으로 마쳤다"* 는 뜻이지
*"모두 갖춰졌다"* 가 아닙니다. 사람이 터미널에서 볼 때는 화면의 `[!!]` 를 읽으면
되니 문제가 없었습니다.

화면이 읽으려면 별도의 통로가 필요합니다. 그것이 `--json` 입니다.

## 또 하나 — `[--]` 하나가 두 가지를 뜻했습니다

```
[--]  settings.ini 없음 — LAN 전용으로 설치됩니다        ← 안 해도 되는 것
[--]  secrets/ 없음 — 아직 install.sh --apply 를 안 돌렸습니다  ← 아직 안 한 것
```

앞은 통과여야 하고 뒤는 막아야 하는데, 텍스트로는 구분할 수 없습니다.
`--json` 에서 `skip` 과 `pending` 으로 쪼갭니다.

**사람이 보는 출력은 둘 다 `[--]` 로 그대로 둡니다.** 터미널에서 쓰던 사람의
눈에는 달라지는 것이 없습니다.

## 형식

```
./install.sh --json
```

```json
{
  "step": "janus.config",
  "state": "incomplete",
  "checks": [
    { "level": "ok",      "text": "바이너리: /opt/janus/bin/janus (1.4.1)" },
    { "level": "skip",    "text": "settings.ini 없음 — LAN 전용으로 설치됩니다" },
    { "level": "pending", "text": "secrets/ 없음 — install.sh --apply 를 돌리세요" },
    { "level": "problem", "text": "Kamailio 가 떠 있지 않습니다" }
  ]
}
```

### `level`

| 값 | 사람 화면 | 뜻 | 판정에 |
|---|---|---|---|
| `ok` | `[ok]` | 됐다 | 영향 없음 |
| `skip` | `[--]` | **안 해도 되는 것** (선택 기능을 안 켠 상태) | 영향 없음 |
| `pending` | `[--]` | **아직 안 한 것** (해야 하는데 안 됨) | `incomplete` |
| `problem` | `[!!]` | 잘못된 것 | `problem` |

`pending` 과 `problem` 의 차이는 **순서 때문인가, 고장인가** 입니다.
아직 차례가 안 온 것은 `pending`, 차례가 지났는데 어긋난 것은 `problem` 입니다.

### ⚠️ "확인할 수 없음" 은 `problem` 이 아니라 `skip` 입니다

**마법사는 sudo 없이 돕니다.** 그래서 root 만 읽을 수 있는 것을 확인하지 못하는
일이 자주 생깁니다.

```
[!!]  MariaDB 에 접속할 수 없어 확인을 건너뜁니다 (sudo 로 실행해 보세요)
```

이것을 `problem` 으로 두면 **그 단계가 영원히 막힙니다.** 실제로 잘못된 것이
아니라 우리가 못 본 것뿐입니다. 이런 줄은 `skip` 이어야 합니다.

가르는 기준:

| 문구가 말하는 것 | 레벨 |
|---|---|
| "…을 확인할 수 없습니다 / 읽지 못했습니다 (권한)" | `skip` |
| "…이 잘못돼 있습니다 / 없습니다 / 어긋납니다" | `problem` |

`kamailio/install.sh` 를 변환하면서 실제로 이 오분류가 하나 있었습니다 —
그 한 줄 때문에 `kamailio.config` 단계가 sudo 없이는 절대 통과하지 못했습니다.

### `state`

`checks` 에서 기계적으로 나옵니다.

```
problem 이 하나라도 있으면        → "problem"
아니고 pending 이 있으면          → "incomplete"
둘 다 없으면                      → "complete"
```

### 종료 코드

**`--json` 일 때만** 판정을 따릅니다.

| `state` | 종료 코드 |
|---|---|
| `complete` | 0 |
| `incomplete` · `problem` | 1 |

**사람이 보는 모드의 종료 코드는 바꾸지 않습니다.** 기존 습관과 다른 스크립트의
호출을 깨지 않기 위해서입니다. 판정이 필요하면 `--json` 을 쓰세요.

## 스크립트에 붙이는 법

```bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../lib/check-report.sh"

check_init "janus.config"     # 마법사의 단계 id 와 같게
check_args "$@"               # --json 을 걸러낸다
set -- "${CHECK_REST[@]:-}"   # 남은 인자로 원래 파싱을 계속한다

info "Janus 설치"
ok   "바이너리: ${JANUS_BIN}"
pend "secrets/ 없음 — install.sh --apply 를 돌리세요"

check_finish                  # JSON 이면 여기서 출력하고 종료
```

`ok` · `warn` · `info` 는 이름과 동작이 예전과 같습니다. **바꿔야 하는 것은
기존 `no()` 호출뿐입니다** — 각 자리에서 `skip` 인지 `pend` 인지 판단해 나눕니다.

## 지켜야 할 것

- **`--json` 일 때 다른 출력을 내지 마세요.** JSON 한 덩어리만 stdout 으로 나가야
  합니다. 오류·진단은 stderr 로 보내세요.
- **`check_finish` 를 빠뜨리지 마세요.** 없으면 `--json` 이 조용히 무시됩니다.
- **`step` 은 마법사의 단계 id 와 같아야 합니다.** 화면이 그것으로 결과를
  붙입니다.
- **판정을 바꾸는 것은 `pending`/`problem` 뿐입니다.** 안내를 늘리고 싶으면
  `info` 나 `skip` 을 쓰세요.

## 붙인 곳

| 진입점 | `step` | 상태 |
|---|---|---|
| `services/janus/bootstrap.sh` | `janus.deps` | ⬜ |
| `services/janus/install.sh` | `janus.config` | ✅ |
| `services/janus/setup-dashboard.sh` | `janus.dashboard` | ⬜ |
| `services/janus/verify-call.sh` | `janus.verify.call` | ⬜ |
| `services/janus/verify-bridge.sh` | `janus.verify.bridge` | ⬜ |
| `services/janus/check-public-ip.sh` | `janus.publicip` | ⬜ |
| `services/kamailio/bootstrap.sh` | `kamailio.deps` | ⬜ |
| `services/kamailio/install.sh` | `kamailio.config` | ✅ |
| `nginx/install_nginx_stack.sh` | `nginx.routes` | ⬜ |
| `pm2/ecosystem.config.js` | `pm2.apps` | ⬜ (node — 같은 형식을 직접 낸다) |
