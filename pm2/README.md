# pm2 운영 가이드

이 디렉토리는 pm2 앱 목록을 **만드는** `ecosystem.config.js` 와 부팅 스크립트를
담습니다. 앱 정의 자체는 각 서비스의 `pm2-conf/app.ini` 에 있습니다
(스키마: [../docs/pm2-conf.md](../docs/pm2-conf.md)).

> 이 문서의 경로와 명령은 `webservices/` 루트 기준입니다.

## 관리 대상

> 이 표는 `node ecosystem.config.js --check` (또는 manager 대시보드의
> [포트 지도](../docs/port-map.md))가 실시간으로 보여주는 것을 사람이 읽기
> 좋게 옮겨 적은 것입니다 — 서비스를 추가·제거했다면 표보다 그 명령을
> 먼저 믿으세요.

| 앱 | 포트 | 위치 | 비고 |
|---|---|---|---|
| `manager` | 28084 | `services/manager` | 관리 대시보드. nginx `/manager` |
| `huygens-server` | 28092 | `services/apartment-mgmt-server-node` | nginx `/complex/*`. apartment-mgmt-server-node 는 별도 저장소(plug-in) |
| `web-cassini` | 28093 | `services/apartment-mgmt-server-node` | nginx `/cassini/`. huygens-server 와 같은 디렉터리, 다른 서비스 |
| `kamailio-dashboard` | 28086 | `services/kamailio` | nginx `/kamailio/`. Kamailio 본체는 apt 패키지 + systemd — pm2 대상이 아니다 |
| `janus-dashboard` | 28087 | `services/janus` | nginx `/janus/`. Janus 본체는 소스 빌드 + 자체 systemd 유닛 — pm2 대상이 아니다 |
| `coturn-dashboard` | 28090 | `services/coturn` | nginx `/coturn/`. coturn 본체는 apt 패키지 + systemd — kamailio 와 같은 자리, pm2 대상이 아니다. 포트는 `settings.ini`의 `dashboard_port` — 장비마다 다를 수 있다 |
| `stock-analyzer` | 28085 | `services/stock-analyzer` | nginx `/stock-analyzer`. tsx 로 TS 직접 실행 |
| `websocket-relay` | 28099 | `services/websocket-relay` | nginx `/relay/`, 자체 대시보드 `/relay/dashboard`. tsx 로 TS 직접 실행 |
| `nginx` | 80/443 | — | ❌ pm2 아님. systemd 가 유지 |

> 이 표는 이 장비에서 실제로 도는 앱만 담습니다. 다른 현장은 plug-in
> 서비스(자기 저장소를 가진 것)가 다를 수 있습니다 — 예: 다른 현장의
> `ws-bridge`·`route-a/b/c`(예제)·`callfusion-v2-server`·
> `webrtc-signal-server`. 그 현장의 실제 목록은 그쪽 저장소에서
> `node ecosystem.config.js --check` 로 확인하세요.

## 1. 설치

pm2 는 npm 전역 패키지로 `/usr/local/bin/pm2` 에 설치돼 있습니다.

```bash
./install_pm2.sh install     # 설치 (sudo 사용)
./install_pm2.sh update      # 업데이트
```

pm2 데몬은 처음 `pm2` 명령을 실행하는 순간 백그라운드에 떠서 상주합니다.

## 2. 앱 목록은 스캔해서 만든다

`ecosystem.config.js` 는 앱을 적어 두는 파일이 아니라 `services/*/pm2-conf/*.ini`
를 훑어 `apps` 배열을 만드는 파일입니다. pm2 는 설정이 `.js` 면 실행 결과를 쓰기
때문에 그대로 등록됩니다. **서비스를 추가할 때 이 파일을 고칠 일은 없습니다.**

```bash
cd pm2
pm2 start ecosystem.config.js                  # 선언된 것 전부
pm2 start ecosystem.config.js --only manager   # 하나만
pm2 save                                       # 재부팅 복원용 스냅샷 갱신
```

해석 결과를 보고 `nginx-conf` 와 포트가 맞는지 검사합니다 (sudo 불필요).

```bash
node ecosystem.config.js --check
node ecosystem.config.js --check --json   # 실제로 pm2 에 넘어가는 객체까지
```

경로는 실행 시점에 이 파일 위치에서 계산합니다. 절대 경로를 적어 두면 저장소를
옮길 때마다 여러 줄을 고쳐야 하고, 실제로 그걸 놓쳐 재부팅 복원이 끊기기 쉽습니다.

### 새 앱 등록

1. `services/<이름>/pm2-conf/app.ini` 를 씁니다. 최소한 이것뿐입니다.

   ```ini
   [app]
   name   = my-service
   script = src/index.js

   [env]
   NODE_ENV = production
   PORT     = 29000
   ```

2. 그 프로세스는 **포그라운드에서 종료 없이 떠 있어야** 합니다.
   `nohup ... &` 후 즉시 리턴하는 스크립트면 pm2 가 계속 재시작을 시도합니다.
3. 반영:

   ```bash
   cd pm2 && pm2 start ecosystem.config.js --only my-service && pm2 save
   ```

nginx 경로도 필요하면 `services/<이름>/nginx-conf/service.ini` 를 함께 씁니다
([../docs/nginx-conf.md](../docs/nginx-conf.md)).

### 편집 / 삭제

```bash
pm2 restart ecosystem.config.js --only my-service   # 확실한 재시작
pm2 save
```

`env` 를 바꿨다면 `--update-env` 를 붙이거나 `pm2 delete` 후 다시 `start` 해야
반영됩니다 (환경변수는 최초 fork 시점에 캐시됩니다).

삭제는 pm2 에서 지우고 선언도 지웁니다 — 선언이 남아 있으면 다음
`pm2 start ecosystem.config.js` 에서 되살아납니다. 잠시만 내릴 거라면 선언의
`enabled = false` 를 쓰세요.

```bash
pm2 delete my-service && pm2 save
```

## 3. 부팅 시 자동 시작

사용자 crontab 의 `@reboot` 한 줄이 `pm2-boot.sh` 를 부릅니다 (sudo 불필요).
2026-08-18 에 등록했습니다.

```bash
crontab -l
```

```
# Added by webservices/pm2 — pm2 resurrect on boot
@reboot sleep 20 && /bin/bash /home/jejezz/Public/webservices/pm2/pm2-boot.sh >> …/pm2-boot.log 2>&1
```

경로를 다시 만들려면 **루트에서** 다음을 실행해 나온 줄을 넣습니다.

```bash
echo "@reboot sleep 20 && /bin/bash $PWD/pm2/pm2-boot.sh >> $PWD/pm2/pm2-boot.log 2>&1"
```

cron 은 `PATH=/usr/bin:/bin` 으로 돌아서 `/usr/local/bin/pm2` 를 못 찾습니다.
`pm2-boot.sh` 가 PATH 를 먼저 넓히는 이유입니다 (nvm 이 있는 서버면 함께 로드).

**`pm2 resurrect` 가 복원하는 것은 마지막 `pm2 save` 시점의 목록입니다.**
선언을 고쳤어도 `pm2 start` + `pm2 save` 를 하지 않으면 옛 목록이 돌아옵니다.

이 어긋남은 **재부팅 전까지 아무 증상이 없습니다.** 그래서 점검이 대신 봅니다.

```bash
node ecosystem.config.js --check        # 선언 · 실행 중 · 재부팅 목록 셋을 견준다
```

```
선언대로 돌고 있는가
  ok      실행 중 8개 — 선언대로 돌고 있습니다
  ok      재부팅 목록도 같습니다 (8개, pm2 save 됨)
```

어긋나면 무엇을 해야 하는지 경우마다 다르게 알려 줍니다 — 돌고 있는데 선언에
없는 앱에 대고 `pm2 save` 를 하면 원하지 않는 앱이 굳어 버리기 때문입니다.
규칙은 [docs/check-contract.md](../docs/check-contract.md) 의 'pm2 는 파일이
아니라 프로세스라 셋을 견줍니다' 에 있습니다.

### (대안) systemd

```bash
pm2 startup systemd    # 안내되는 sudo 명령을 실행
pm2 save
```

데몬 자체가 죽어도 systemd 가 살려 주지만 유닛 파일을 쓰는 데 sudo 가 필요합니다.
지금은 crontab 방식을 씁니다.

## 3-1. 데몬을 다시 띄울 때 — `restart.sh`

```bash
./restart.sh              # 점검만 (아무것도 바꾸지 않음)
./restart.sh --restart    # pm2 kill 후 다시 띄우고, 잠시 뒤 확인까지
./restart.sh --restart --sg   # 다시 로그인하지 않고 sg 로 감싸서 (임시 조치)
```

보조 그룹이 있어야 도는 앱이 있습니다 (`pm2-conf/*.ini` 의 `groups`).
보조 그룹은 **로그인할 때** 정해져 자식에게 상속되므로, `usermod -aG` 를 하고
`pm2 restart` 를 해도 바뀌지 않습니다 — **데몬 자체를 다시 띄워야** 합니다.

이 스크립트가 선언에서 필요한 그룹을 읽어, 지금 셸에 없으면 무엇을 해야 하는지
알려 주고(다시 로그인 / `--sg`), 다시 띄운 뒤 **데몬과 앱이 실제로 그 그룹을
받았는지 확인**합니다.

## 4. 자주 쓰는 명령

```bash
pm2 list                      # 상태 (pid, uptime, 재시작 횟수, cpu/mem)
pm2 describe manager          # 상세 (로그 경로, env)
pm2 logs manager              # 실시간 로그
pm2 logs manager --lines 100 --nostream
pm2 monit
pm2 flush                     # 로그 비우기
pm2 save
```

로그는 서비스마다 흩어지지 않게 **`pm2/logs/<앱>-{out,error}.log`** 로 모읍니다.
`pm2-conf` 에서 `out_file` / `error_file` 을 지정하면 그쪽이 우선합니다.

## 5. 문제 해결

- **재시작(↺)이 계속 늘어남** — 대부분 프로세스가 바로 종료되는 경우입니다.
  `pm2 logs <앱> --lines 50` 으로 마지막 로그를 보세요.
- **경로가 502** — nginx 선언은 있는데 프로세스가 없다는 뜻입니다.
  `pm2 list` 와 `node ecosystem.config.js --check` 를 함께 보세요.
- **재부팅 후 앱이 안 뜸** — `pm2-boot.log` 를 확인합니다. PATH 문제이거나
  `pm2 save` 를 안 해 `~/.pm2/dump.pm2` 가 낡은 경우입니다.
- **포트 충돌** — `ss -ltnp 'sport = :28084'` 로 누가 점유 중인지 확인합니다.
