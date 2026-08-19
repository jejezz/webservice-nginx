# `pm2-conf/` — 서비스가 선언하는 프로세스 정보

`nginx-conf/` 가 "이 서비스는 어떤 경로로 들어온다"를 선언한다면,
`pm2-conf/` 는 "이 서비스는 어떻게 띄운다"를 선언합니다. 둘 다 서비스 디렉토리
안에 있어서, 서비스를 옮기거나 지울 때 선언이 함께 따라갑니다.

```
services/<서비스>/pm2-conf/app.ini
```

`pm2/ecosystem.config.js` 는 더 이상 앱 목록을 **적어 두는** 파일이 아니라,
`services/*/pm2-conf/*.ini` 를 **훑어서 만드는** 파일입니다. pm2 는 설정이 `.js`
면 그 실행 결과를 쓰기 때문에, 파일 안에서 스캔·파싱해 `apps` 배열을 돌려주면
pm2 가 그대로 등록합니다. 별도 생성 단계도, 생성물 커밋도 없습니다.

```bash
cd pm2 && pm2 start ecosystem.config.js              # 선언된 것 전부
cd pm2 && pm2 start ecosystem.config.js --only manager
```

> `nginx-conf/` 와 마찬가지로 폴더 안에 `.ini` 가 여러 개여도 되고,
> 스캔은 `services/*/pm2-conf/` **한 단계만** 합니다.

## `[app]`

```ini
[app]
name   = ws-bridge
script = src/index.js
```

경로 값은 모두 **그 서비스 디렉토리 기준 상대 경로**입니다. 스캐너가 실행 시점에
절대 경로로 바꿔 pm2 에 넘깁니다. 저장소를 통째로 옮겨도 고칠 곳이 없습니다.

| 키 | 기본값 | 설명 |
|---|---|---|
| `name` | 폴더 이름 | pm2 목록에 뜨는 이름. **고유해야** 하고 `nginx-conf` 의 `[service] name` 과 같아야 합니다 |
| `script` | — | 진입점. `cwd` 기준 상대 경로 |
| `cwd` | 서비스 디렉토리 | 프로세스의 작업 디렉토리. 예: `server` |
| `interpreter` | — | 예: `server/node_modules/.bin/tsx`. **서비스 디렉토리 기준**으로 적으면 절대 경로로 변환됩니다 |
| `interpreter_args` | — | `node_args` 와 같은 뜻으로 씁니다 |
| `exec_mode` | `fork` | `cluster` 로 바꾸려면 앱이 자체 클러스터링을 하지 않는지 먼저 확인하세요 |
| `instances` | `1` | |
| `autorestart` | `true` | |
| `watch` | `false` | `true`/`false` 또는 공백으로 구분한 경로 목록 (`src`) |
| `ignore_watch` | `node_modules logs` | 공백으로 구분 |
| `max_memory_restart` | `256M` | `none` 이면 상한을 걸지 않습니다 (`rtc-relay-server` 가 이 경우) |
| `min_uptime` | — | 이 시간 안에 죽으면 비정상 종료로 셉니다 (`10s`) |
| `max_restarts` | — | |
| `restart_delay` | — | 밀리초 |
| `kill_timeout` | — | 밀리초. graceful 종료에 시간이 필요한 서비스에 |
| `node_args` | — | 예: `--enable-source-maps` |
| `out_file` / `error_file` | `pm2/logs/<name>-{out,error}.log` | 비워 두는 것을 권합니다 |
| `merge_logs` | `true` | |
| `log_date_format` | `YYYY-MM-DD HH:mm:ss` | |
| `enabled` | `true` | `false` 면 apps 배열에서 빠집니다 |

`enabled = false` 는 **선언을 남긴 채 프로세스만 빼는** 수단입니다. `nginx-conf`
의 같은 이름 키와 짝을 이룹니다 — 서비스를 잠시 내릴 때 둘 다 `false` 로 둡니다.

### `interpreter` 를 절대 경로로 바꾸는 이유

pm2 는 `interpreter` 의 상대 경로를 **앱의 `cwd` 가 아니라 `pm2` 명령을 실행한
위치** 기준으로 찾습니다. 지금 `ecosystem.config.js` 가 `path.join(...)` 으로
절대 경로를 만들어 두는 것도 같은 이유입니다. 스캐너가 이 변환을 대신하므로
선언에는 상대 경로만 적습니다.

## `[env]` 과 `[env:*]`

`[env]` 는 pm2 의 `env`, `[env:production]` 은 `env_production` 이 됩니다
(`pm2 start ... --env production` 으로 선택).

```ini
[env]
NODE_ENV       = production
PORT           = 28083
DASHBOARD_PATH = /dashboard
```

값은 모두 문자열로 전달됩니다. pm2 가 자식 프로세스에 넘길 때 어차피 문자열이
되므로 `PORT = 28083` 과 `PORT = "28083"` 은 같습니다.

manager 대시보드가 읽는 값이 셋 있습니다.

| 변수 | 쓰임 |
|---|---|
| `PORT` | 기본 헬스 URL(`http://127.0.0.1:PORT/health`) 구성 |
| `HEALTH_URL` | 헬스 URL 직접 지정. 자체 HTTPS 서비스용 (`rtc-relay-server`) |
| `HEALTH_INSECURE_TLS` | `true` 면 자체 서명 인증서 검증을 건너뜀 |

`DASHBOARD_PATH` 도 지금은 여기서 읽지만, 서비스 자체 관리 화면의 경로는
라우팅에 가까우므로 최종적으로 `nginx-conf` 의 `dashboard_path` 로 옮깁니다
([migration-plan.md](migration-plan.md) 7단계). 그 전까지는 이 변수가 유효합니다.

### `PORT` 는 두 곳에 적힌다

`pm2-conf` 의 `[env] PORT` 와 `nginx-conf` 의 `[service] ports` 는 **같은 값이어야
합니다.** 프로세스가 여는 포트와 nginx 가 보내는 포트가 어긋나면 그 경로는 502 인데,
어느 쪽도 혼자서는 그걸 알 수 없습니다.

그래서 스캐너에 교차 검사를 넣습니다. 직접 실행하면 해석 결과와 함께 어긋난 곳을
보여주고, 문제가 있으면 종료 코드 1 로 끝납니다. sudo 가 필요 없습니다.

```bash
node pm2/ecosystem.config.js --check
```

```
  ok      ws-bridge         28083   src/index.js
  ok      manager           28084   manager/server/src/index.js
  WARN    stock-analyzer    28085   pm2-conf PORT=28085 vs nginx-conf ports=28086
  ok      rtc-relay-server  -       nginx 28099
```

`nginx-conf` 없이 `pm2-conf` 만 있는 서비스는 경고가 아닙니다. Nginx 를 거치지
않고 포트로 직접 쓰는 서비스도 있을 수 있습니다. 지금은 모든 서비스가 라우트를 가집니다.
대시보드에도 `직결` 로 표시됩니다.

## 지금 앱을 이 형식으로 옮기면

`services/ecosystem.config.js` 의 앱들은 아래처럼 나뉩니다. 표현력이 모자라는
항목은 없습니다 — `env_production`/`env_staging` 도
`[env:production]`/`[env:staging]` 으로 그대로 옮겨집니다.

| 서비스 | pm2-conf 에서 주의할 점 |
|---|---|
| `route-a` `route-b` `route-c` | `cwd` 없이 `script = index.js` 만. 가장 단순 |
| `ws-bridge` | `DASHBOARD_PATH = /dashboard` |
| `manager` | `cwd = server`, `script = src/index.js` |
| `stock-analyzer` | `cwd = server`, `interpreter = server/node_modules/.bin/tsx`, `max_memory_restart = 512M`. 지금 로그를 절대 경로로 적어 둔 이유(cwd 가 `server` 라 `./logs` 가 흩어짐)는 로그 기본값이 `pm2/logs/` 로 통일되면서 사라집니다 |
| `rtc-relay-server` | `watch = src`, `HEALTH_URL = https://127.0.0.1:28099/health`, `HEALTH_INSECURE_TLS = true`. 자체 HTTPS 라 `PORT` 대신 `HEALTH_URL` 을 씁니다 |

## 부팅 복원

pm2 가 재부팅 후 복원하는 목록은 **마지막 `pm2 save` 시점**의 것입니다.
`pm2-conf` 를 고쳤어도 `pm2 start` + `pm2 save` 를 하지 않으면 재부팅 후 옛 정의가
돌아옵니다. 선언 파일이 곧 실행 상태는 아닙니다.

> **지금 이 서버는 재부팅하면 pm2 앱이 하나도 복원되지 않습니다.**
> `crontab -l` 이 비어 있고 `pm2-<사용자>.service` 도 없습니다.
> `~/.pm2/dump.pm2` 는 있는데 그것을 되살릴 주체가 없습니다.
> 구조 변경과 함께 `pm2/pm2-boot.sh` + crontab `@reboot` 를 등록합니다
> ([migration-plan.md](migration-plan.md) 8단계).
