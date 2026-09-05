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

#### 같은 점검이 터미널과 화면에서 다르게 나올 수 있습니다

권한은 사용자가 아니라 **프로세스의 그룹 목록**이 정합니다. 마법사를 돌리는
manager 는 pm2 데몬이 띄운 프로세스라, 그 데몬이 뜨던 시점의 그룹을 갖고
있습니다. 사람이 뒤에 `usermod -aG` 로 그룹을 더해도 **이미 로그인해 있던
셸에는 반영되지 않습니다.**

실제로 이 저장소에서 갈렸습니다.

```
[--]  kamailio-local.cfg 는 root 만 읽을 수 있어 확인을 건너뜁니다   ← 터미널 (kamailio 그룹 없음)
[ok]  푸시 요청 주소(SIP_PUSH_URL)가 설정에 있습니다                 ← 마법사 (kamailio 그룹 있음)
```

둘 다 맞는 출력입니다. 그래서 "확인 불가" 를 `problem` 으로 두면 안 되는
이유가 하나 더 늘어납니다 — 그 판정은 **누가 돌렸느냐에 따라 달라집니다.**

### `state`

`checks` 에서 기계적으로 나옵니다.

```
problem 이 하나라도 있으면        → "problem"
아니고 pending 이 있으면          → "incomplete"
둘 다 없으면                      → "complete"
```

**마법사는 이 값을 그대로 믿지 않습니다** — 같은 규칙으로 `checks` 에서 다시
계산하고, 어긋나면 로그에 남긴 뒤 계산한 쪽을 씁니다. 화면이 "통과" 라고 말하는데
그 안에 `[!!]` 가 섞여 있는 상태를 만들지 않기 위해서입니다. 그러니 `state` 를
손으로 적지 마세요 — `check_finish` 가 계산합니다.

### 종료 코드

**`--json` 일 때만** 판정을 따릅니다.

| `state` | 종료 코드 |
|---|---|
| `complete` | 0 |
| `incomplete` · `problem` | 1 |

**사람이 보는 모드의 종료 코드는 바꾸지 않습니다.** 기존 습관과 다른 스크립트의
호출을 깨지 않기 위해서입니다. 판정이 필요하면 `--json` 을 쓰세요.

## 설치본이 저장소와 같은가

점검이 "떠 있다" 고 말하는데 **떠 있는 것이 옛 설정**인 경우가 있습니다.
저장소에서 설정을 고치고 `--apply` 를 잊으면 그렇게 됩니다. 서비스는 멀쩡히
돌고 있고, 어디에도 오류로 보이지 않습니다.

실제로 두 번 그랬습니다.

| 무엇 | 어떻게 드러났나 |
|---|---|
| `/etc/kamailio/kamailio.cfg` 에 `wt_timer` 가 없었다 | 착신 푸시로 붙들어 둔 INVITE 가 5초에 사라짐. 훅이 있는지만 grep 하던 점검은 **통과**로 보고 |
| `/etc/nginx/conf.d/path-routing.conf` 에 `/sip/` 라우트가 남아 있었다 | 저장소에서 끈 지 오래인데 nginx 는 계속 서비스 중. 선언만 보던 점검은 **통과**로 보고 |

둘 다 **표식이나 특정 줄만 grep 하는 검사**의 한계입니다. 그 줄만 보기
때문입니다. 파일 전체를 원본과 맞춰 보면 한 번에 드러납니다.

구현은 [`lib/config-diff.sh`](../lib/config-diff.sh) 에 있습니다 (파이썬인
nginx 생성기는 같은 규칙을 직접 냅니다).

```bash
source "${SCRIPT_DIR}/../../lib/config-diff.sh"

report_config_diff "kamailio.cfg" "sudo $0 --apply" "$MAIN_CFG" "$MAIN_TEMPLATE"
```

### 자리표시자가 들어간 자리는 눌러서 비교합니다

설치본은 대개 템플릿을 치환해 만듭니다. 그대로 비교하면 늘 다릅니다. 그래서
**키를 기준으로 양쪽을 같은 모양으로 눌러** 비교합니다.

```bash
report_config_diff "kamailio-local.cfg" "sudo $0 --apply" \
    -n 's%^#!define DBURL .*%#!define DBURL «%' \
    -n 's%^alias=.*%alias=«%' \
    -x 'nat_1_1_mapping' \
    "$LOCAL_CFG" "$TEMPLATE"
```

| 옵션 | 뜻 |
|---|---|
| `-n <sed식>` | 양쪽에 똑같이 적용해 값 자리를 지웁니다 |
| `-x <정규식>` | 설치 때 지워질 수 있는 줄을 양쪽에서 뺍니다 |
| `-s <말+조사>` | 원본을 뭐라고 부를지 (`database.ini 로 만든 것과`) |

**값이 맞는지는 이 비교가 보지 않습니다.** 그것은 `settings.ini` 와
`.applied-settings` 를 견주는 쪽의 일입니다 ([settings-contract.md](settings-contract.md)).
여기서 보는 것은 **구조가 낡았는가** 입니다.

### 판정은 `pending` 입니다

고장이 아니라 **아직 반영하지 않은 것**이기 때문입니다. 읽지 못하면 `skip` 이고,
그것은 문제로 세지 않습니다 — 마법사는 sudo 없이 돌기 때문입니다.

### ⚠️ 다른 줄의 내용을 함부로 찍지 마세요

설치본에는 비밀이 들어 있습니다 (`DBURL` 의 비밀번호, `admin_secret` 따위).
그 줄을 그대로 찍으면 점검 출력에 비밀이 섞이고, 그 출력은 화면과 JSON 을 타고
나갑니다.

`report_config_diff` 는 **저장소 쪽 줄만** 보여 주고(커밋된 파일이라 자리표시자만
들어 있습니다), 설치본에만 있는 줄은 개수만 말합니다.

### 자리표시자를 주석에 적지 마세요

치환이 파일 전체를 훑으므로, 주석에 `__DBURL__` 이라고 적어 두면 **설치본
주석에 DB 비밀번호가 박힙니다.** 실제로 그랬습니다
(`services/kamailio/kamailio-local.cfg`).

### 붙인 곳

| 점검 | 견주는 것 |
|---|---|
| `services/kamailio/install.sh` | `kamailio.cfg` · `kamailio-local.cfg` |
| `services/janus/install.sh` | `.jcfg` 넷 · `janus.service` |
| `nginx/generate_nginx_conf.py` | `/etc/nginx/conf.d/path-routing.conf` (선언대로 만든 것과) |
| `database/check-database.sh` | `99-project.cnf` (`database.ini` 로 만든 것과) |
| `pm2/ecosystem.config.js` | 선언 ↔ 실행 중 ↔ `dump.pm2` (아래) |

### pm2 는 파일이 아니라 프로세스라 셋을 견줍니다

| 무엇 | 어디서 오는가 |
|---|---|
| 선언 | `services/*/pm2-conf/*.ini` |
| 실행 중 | `pm2 jlist` |
| 재부팅하면 살아날 것 | `~/.pm2/dump.pm2` (`pm2 save` 가 씁니다) |

어긋나는 방식이 각각 다릅니다. 선언만 고치고 재기동을 안 하면 **둘째**가 낡고,
재기동만 하고 `pm2 save` 를 잊으면 **셋째**가 낡습니다.

**뒤엣것은 재부팅 전까지 아무 증상이 없습니다.** 그날 `pm2 resurrect` 가
복원하는 것은 마지막 `pm2 save` 시점의 목록이라, 몇 주 전 설정으로 서비스가
올라옵니다. 그래서 여기서 봅니다.

견주는 값은 **선언이 정한 것만**입니다 — `script` · `cwd` · `interpreter` ·
`watch` · 선언에 적힌 `env` 키들. pm2 는 부모 환경을 통째로 물려주므로 `env` 를
전부 비교하면 소음만 커집니다. 선언은 커밋된 ini 에서 오므로 그 값에 비밀이
섞이지 않습니다.

안내하는 명령이 경우마다 다릅니다. **"돌고 있는데 선언에 없는" 앱에 대고
`pm2 save` 를 권하면 원하지 않는 앱을 굳혀 버립니다.**

| 어긋남 | 할 일 |
|---|---|
| 선언돼 있는데 안 돎 | `pm2 start … --only <이름> && pm2 save` |
| 선언과 다르게 돎 | `pm2 restart <이름> --update-env && pm2 save` |
| 돌고 있는데 선언에 없음 | `pm2 delete <이름> && pm2 save` 하거나 선언을 되살리기 |
| 돌고 있는데 재부팅 목록에 없음 | `pm2 save` |
| 재부팅 목록에만 있음 | 지운 뒤 `pm2 save` 를 잊은 것 |

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

## ⚠️ 예외 — `--json` 이 이미 다른 뜻이던 두 자리

`pm2/ecosystem.config.js` 는 **`--json` 을 이미 다른 뜻으로 쓰고 있습니다.**
`--check --json` 이 "pm2 에 실제로 넘어가는 앱 객체를 덤프한다" 는 뜻으로
`pm2/README.md` 에 문서화돼 있습니다.

그것을 빼앗으면 쓰던 사람이 깨지므로, 이 파일에서만 규약 플래그를
**`--check-json`** 으로 둡니다.

```bash
node pm2/ecosystem.config.js --check-json
```

셸이 아니라 node 라 `lib/check-report.sh` 를 쓸 수 없어 같은 형식을 직접 냅니다.
`nginx` 도 마찬가지로 파이썬 생성기가 직접 냅니다 (래퍼는 `--json` 을 그쪽으로
넘기기만 합니다). `websocket-relay` 는 TypeScript 라 `scripts/lib/ui.ts` 의
`Reporter` 가 같은 형식을 냅니다 — 그쪽은 `ok`·`warn`·`bad` 셋만 알던 것에
`pend` 를 더해 `pending` 과 `problem` 을 갈랐습니다.

### `cert-status.sh` 는 `--check` 를 더해서 갈랐습니다

`nginx/public_ca/cert-status.sh --json` 은 **manager 대시보드가 읽는 형식**으로
이미 쓰이고 있었습니다. 같은 상황인데 여기서는 플래그 이름을 바꾸는 대신
`--check` 를 하나 더 받게 했습니다.

```bash
./cert-status.sh                  사람이 읽는 형식
./cert-status.sh --json           대시보드용
./cert-status.sh --check --json   점검 규약 (이 문서)
```

`check_args` 가 `--json` 만 걸러 가므로 두 형식이 한 파일에서 공존합니다.
**기존 두 모드는 손대지 않았습니다.** 마법사가 다른 단계에도 `--check` 를
붙여 부르고 있으므로 (`setup.js` 의 `args`), 명령 모양도 나머지와 같아집니다.

새로 만드는 스크립트라면 이 방식이 낫습니다 — `--check-json` 은 pm2 처럼
`--json` 을 빼앗을 수 없을 때의 마지막 수단입니다.

## 지켜야 할 것

- **`--json` 일 때 다른 출력을 내지 마세요.** JSON 한 덩어리만 stdout 으로 나가야
  합니다. 오류·진단은 stderr 로 보내세요.
- **제목·빈 줄에 생 `echo` 를 쓰지 마세요 — `info` 를 쓰세요.** `echo` 는 JSON
  모드에서도 그대로 나가 출력을 오염시킵니다. 변환한 다섯 스크립트 중 둘이 실제로
  이것 때문에 파싱이 깨졌습니다.
- **`check_finish` 를 빠뜨리지 마세요.** 없으면 `--json` 이 조용히 무시됩니다.
- **`step` 은 마법사의 단계 id 와 같아야 합니다.** 화면이 그것으로 결과를
  붙입니다.
- **판정을 바꾸는 것은 `pending`/`problem` 뿐입니다.** 안내를 늘리고 싶으면
  `info` 나 `skip` 을 쓰세요.

## 붙인 곳

| 진입점 | `step` | 상태 |
|---|---|---|
| `services/janus/bootstrap.sh` | `janus.deps` | ✅ |
| `services/janus/install.sh` | `janus.config` | ✅ |
| `services/janus/setup-dashboard.sh` | `janus.dashboard` | ✅ |
| `services/janus/verify-call.sh` | `janus.verify.call` | ✅ |
| `services/janus/verify-bridge.sh` | `janus.verify.bridge` | ✅ |
| `services/janus/check-public-ip.sh` | `janus.publicip` | ✅ |
| `services/kamailio/bootstrap.sh` | `kamailio.deps` | ✅ |
| `services/kamailio/install.sh` | `kamailio.config` | ✅ |
| `services/kamailio/check-accounts.sh` | `sip.accounts` | ✅ 확인 전용 |
| `services/kamailio/check-push.sh` | `push.incoming` | ✅ 확인 전용 |
| `services/coturn/install.sh` | `coturn.config` | ✅ |
| `services/coturn/setup-dashboard.sh` | `coturn.dashboard` | ✅ |
| `database/check-database.sh` | `database.schema` | ✅ 확인 전용 |
| `nginx/install_nginx_stack.sh` | `nginx.routes` | ✅ (생성기가 낸다) |
| `pm2/ecosystem.config.js` | `pm2.apps` | ✅ **`--check-json`** (위 예외) |
| `nginx/public_ca/setup_letsencrypt.sh` | `public_ca.issue` | ✅ |
| `nginx/public_ca/cert-status.sh` | `public_ca.nginx` | ✅ **`--check --json`** (위 예외) |
| `nginx/public_ca/renew-status.sh` | `public_ca.renew` | ✅ 확인 전용 |
| `nginx/public_ca/check-dns.sh` | `public_ca.dns` | ✅ 확인 전용 |
| `services/websocket-relay/check-relay.sh` | `relay.service` | ✅ 확인 전용 (`npm run doctor` 를 감싼다) |

**"확인 전용"** 은 적용 기능이 없는 스크립트라는 뜻입니다. 나머지는 원래
적용도 하는 스크립트에 점검 모드가 함께 있는 것들입니다.

`database` 와 착신 푸시에는 붙일 곳이 아예 없어 새로 썼습니다 —
`setup_mariadb.sh` 는 root 로 도는 적용 스크립트고, 착신 푸시는 네 조각이
서로 다른 서비스에 흩어져 있어 주인이 없었습니다
([setup-wizard.md](setup-wizard.md) 의 '점검이 없던 두 자리').
