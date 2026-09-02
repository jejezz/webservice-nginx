# 서비스를 하나 더 붙일 때

이 저장소의 설계는 **서비스가 자기를 스스로 선언하고, 스캐너가 그것을 줍는
것**입니다. 그래서 대부분은 파일 두 개를 만들면 끝납니다. 다만 **아직 스캔되지
않고 손으로 고쳐야 하는 자리가 셋** 있습니다 — 그것을 아는 것이 이 문서의 목적
입니다.

## 가장 짧은 길 — 파일 둘

```
services/<이름>/
├── nginx-conf/service.ini   어떤 경로로 들어오는가
└── pm2-conf/app.ini         어떻게 띄우는가
```

```ini
; nginx-conf/service.ini
[service]
name        = my-service      ; pm2 의 name · /health 의 service 와 **같아야** 합니다
host        = 127.0.0.1
ports       = 28090           ; 다른 서비스와 겹치면 --check 가 막습니다
protocol    = http
health_path = /health
enabled     = true

[route:main]
location  = /my-service/
websocket = false
```

```ini
; pm2-conf/app.ini
[app]
name   = my-service
script = index.js

[env]
NODE_ENV = production
PORT     = 28090
```

그리고 `/health` 를 냅니다 ([health-contract.md](health-contract.md)).

```jsonc
{ "service": "my-service", "status": "ok" }
```

이름 셋(`[service] name` · `[app] name` · `/health` 의 `service`)이 **같아야
합니다.** 다르면 대시보드가 "떠 있는데 중단" 처럼 보여 줍니다.

반영은 이렇습니다.

```bash
./nginx/install_nginx_stack.sh --check          # 선언 검사 (sudo 불필요)
node pm2/ecosystem.config.js --check
sudo ./nginx/install_nginx_stack.sh --skip-install
cd pm2 && pm2 start ecosystem.config.js --only my-service && pm2 save
```

## 저절로 되는 것

| 무엇 | 누가 줍나 |
|---|---|
| nginx 라우트·업스트림 | `nginx/generate_nginx_conf.py` 가 `services/*/nginx-conf/*.ini` 를 훑습니다 |
| pm2 앱 등록 | `pm2/ecosystem.config.js` 가 `services/*/pm2-conf/*.ini` 를 훑습니다 |
| manager 대시보드의 서비스 카드·헬스 | 같은 `nginx-conf` 선언을 읽습니다 |
| plug-in 서비스의 DB·전용 계정 | `database/setup_mariadb.sh` 가 `services/*/db-conf/*.ini` 를 훑습니다 ([db-conf.md](db-conf.md)) |
| 설정 입력 폼 | 그 디렉터리에 `settings-schema.json` 만 두면 화면이 생깁니다 ([settings-contract.md](settings-contract.md)) |
| 포트·경로 충돌 검사 | 위 두 `--check` 가 막습니다 |

**중앙 파일에 서비스 이름을 적을 일이 없습니다.** 서비스를 옮기거나 지우면
선언도 함께 따라갑니다.

## 손으로 고쳐야 하는 자리 — 셋

### ① DB 스키마를 쓴다면

서비스가 **이 저장소 안에** 이력째 들어와 있다면(`manager`·`kamailio`·
`janus`·`websocket-relay`) `database/database.ini` 에 손으로 등록합니다.

```ini
[database:my_service]
schema_dir = ../services/my-service/schema
```

`schema_dir` 안의 `*.sql` 을 **이름순으로** 실행합니다. 여기 등록하지 않으면
`npm run db:migrate` 도 `setup_mariadb.sh` 도 그 서비스를 보지 못합니다.

> DB 이름에는 하이픈을 쓸 수 없습니다 — `my-service` 디렉터리에 `my_service`
> 스키마가 되는 것이 정상입니다 (websocket-relay ↔ rtc_relay 와 같은 이유).

서비스가 **이 저장소 밖에 자기 저장소**를 가진 plug-in 이라면(예:
`apartment-mgmt-server-node`) `database.ini` 를 손댈 필요가 없습니다. 대신
`nginx-conf`·`pm2-conf` 와 같은 자리에 스스로 선언합니다.

```ini
; services/my-service/db-conf/database.ini
[database]
name = my_service
```

`setup_mariadb.sh` 가 `services/*/db-conf/*.ini` 를 스캔해 DB 와, 그 DB
하나에만 권한을 갖는 전용 계정을 자동으로 만듭니다. 이쪽은 손으로 고칠
자리가 아니므로 **이 문서의 "손으로 고쳐야 하는 자리"에 들어가지 않습니다.**
자세한 필드는 [db-conf.md](db-conf.md).

### ② 여럿이 쓰는 값이 필요하면 `site/settings-schema.json`

호스트·단지 ID 처럼 **다른 서비스도 쓰는 값**이면 사이트 층에 넣고 파생시킵니다
([site/README.md](../site/README.md)). 그 서비스만 쓰는 값이면 자기
`settings-schema.json` 에 두세요 — 사이트 층에 올리는 기준은 **"둘 이상이
쓰는가"** 하나입니다.

읽는 법은 언어별로 이미 있습니다.

| | |
|---|---|
| 셸 | `source lib/site.sh` → `site_get host` |
| TypeScript | `libs/siteSettings.ts` 를 본떠 (config 를 import 하지 않는 파일이어야 합니다) |
| 파이썬 | `nginx/generate_nginx_conf.py` 의 `site_get` |

우선순위는 **서비스 값이 이기고, 비어 있을 때만 사이트 값**입니다.

```bash
MY_VALUE="$(settings_get my_value "$(site_get host)")"
```

### ③ 구축 마법사에 단계를 넣으려면 `setup.js`

**여기만 스캔이 아닙니다.** 단계는
`services/manager/server/src/services/setup.js` 의 `STEPS` 배열에 손으로
적습니다.

```js
{
  id: 'my-service.install',
  service: 'my-service',
  title: '내 서비스 설치',
  why: '무엇을 왜 하는지. 사람이 읽고 판단할 수 있게.',
  requires: ['site.settings', 'pm2.apps'],
  command: { cwd: 'services/my-service', run: 'npm install\nnpm start' },
  check:   { cwd: 'services/my-service', file: './check.sh', args: ['--check', '--json'] },
}
```

점검 스크립트는 [check-contract.md](check-contract.md) 규약을 따릅니다 —
`--check --json` 으로 `{ step, state, checks[] }` 를 내면 됩니다. `lib/check-report.sh`
를 `source` 하면 그 형식이 저절로 나옵니다.

**주의할 것 둘.**

- `requires` 에 적은 단계가 `complete` 여야 열립니다. 영영 `complete` 가 되지
  않는 점검(예: "전환이 끝나면 지우세요" 같은 안내)을 `pend` 로 두면 **뒤따르는
  단계가 통째로 잠깁니다.** 그런 항목은 `skip` 으로 두세요 — 실제로 그렇게
  만들었다가 되돌린 적이 있습니다
- 새 단계는 순서 그래프에 들어갑니다. 어디에 끼울지는 `requires` 로만 정하고,
  배열 순서에 기대지 마세요

> **왜 이것만 중앙에 있나.** 단계에는 **순서**가 있습니다. 서비스마다 흩어 두면
> "Kamailio 가 Janus 보다 먼저" 같은 관계를 한눈에 볼 수 없고, 순환을 만들기도
> 쉽습니다. 지금은 그 그래프가 한 파일에 있어 읽을 수 있습니다.
>
> 서비스가 더 늘어 이 파일이 부담스러워지면, `services/*/setup-steps.json` 을
> 훑어 합치는 쪽으로 옮길 수 있습니다 — `nginx-conf`·`pm2-conf` 와 같은 모양이
> 됩니다. 그때도 `requires` 는 그대로 쓰면 되므로 그래프는 유지됩니다.

## 붙인 뒤 확인

```bash
./nginx/install_nginx_stack.sh --check      # 라우트·포트 충돌
node pm2/ecosystem.config.js --check        # 앱 선언
curl -s localhost:<포트>/health             # 이름 셋이 같은지
```

manager 대시보드(`/manager`)에 카드가 새로 생기고 헬스가 초록이면 붙은 것입니다.

## 서비스를 지울 때

선언이 서비스 디렉터리 안에 있으므로 **디렉터리를 지우면 대부분 따라갑니다.**
남는 것은 손으로 적었던 셋뿐입니다.

- `database/database.ini` 의 `[database:...]` 절 (DB 자체는 남습니다 — 지울지는
  사람이 정합니다). `db-conf` 로 선언한 DB 는 디렉터리를 지우면 선언은
  같이 사라지지만, DB 와 전용 계정은 `setup_mariadb.sh` 가 추가·갱신만 하고
  지우지 않으므로 서버에 그대로 남습니다 — 지우려면 손으로 `DROP DATABASE` ·
  `DROP USER` 를 해야 합니다
- `setup.js` 의 단계, 그리고 **다른 단계의 `requires` 에서 그 id**
- `site/settings-schema.json` 에 그 서비스만 쓰던 값이 있다면

지운 뒤 위의 `--check` 둘을 다시 돌리세요.
