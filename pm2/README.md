# pm2 운영 가이드

이 디렉토리는 `ecosystem.config.js`(pm2 앱 정의 파일)와 부팅 스크립트를 담습니다.
애플리케이션 소스는 `../services/` 아래에 서비스별로 있습니다.

> **이 문서의 경로와 명령은 모두 `WebServices/` 루트 기준입니다.**
> 예: `cd pm2` 는 `WebServices/pm2` 를 뜻합니다.
>
> 설치 위치나 계정 이름은 문서에 적지 않습니다. cron 처럼 절대 경로가
> 꼭 필요한 곳은 **루트에서 `$PWD` 로 만들어 넣습니다** — 그러면 어디에
> 두든 그 자리의 경로가 들어갑니다.

## 관리 대상 현황

| 앱 | pm2 관리 여부 | 비고 |
|---|---|---|
| `face-recognition-server` | ✅ pm2로 관리 | `../services/face-recognition-server` |
| `Huygens-Server` | ✅ pm2로 관리 | `../services/apartment-mgmt-server/app`. nginx가 `/complex/*`를 이 서비스(28092)로 보냅니다. 앱 디렉토리의 `ecosystem.config.js`는 개발용(watch + tsx)으로 남아 있으니 운영에서는 쓰지 마세요 |
| `web-cassini` | ✅ pm2로 관리 | `../services/apartment-mgmt-server/web-cassini`. nginx가 `/cassini/`를 이 서비스(28093)로 보냅니다. 예전에는 `Huygens-Server`가 복사본을 서빙했습니다 |
| `nginx-manager` | ✅ pm2로 관리 | `../services/manager/server`. 루트(`/`)의 서비스 관리 대시보드 |
| `websocket-relay` | ✅ pm2로 관리 | `../services/websocket-relay`. nginx가 `/relay/*`를 이 서비스(28099)로 보냅니다. WebRTC/IoT 시그널링 릴레이 |
| `ntp-server` | ✅ pm2로 관리 | `../services/ntp`. NTP 상태 사이드카(28094). **시각 제공은 chronyd(systemd)가 UDP 123 에서** 하고 이 프로세스는 상태만 보여줍니다 |
| `nginx` | ❌ systemd로 유지 | 80/443 바인딩에 root 권한이 필요해서 systemd가 더 적합. [nginx는 왜 pm2로 안 옮겼나](#nginx는-왜-pm2로-관리하지-않나) 참고 |
| `logd-server` | ⏳ 아직 미등록 | 현재 zip 파일만 있는 상태 |

> `Huygens-Server`는 컴파일 결과(`dist/server.js`)를 실행합니다.
> 시작 전에 `cd ../services/apartment-mgmt-server/app && npm run build`가 성공해야 합니다.
>
> `web-cassini`도 빌드 결과(`dist/`)가 있어야 합니다.
> 서버 코드 자체는 의존성이 없지만 빌드에는 devDependencies 가 필요합니다:
> `cd services/apartment-mgmt-server/web-cassini && npm install && npm run build`.
> `dist` 가 없으면 프로세스는 뜨지만 `/health` 가 `degraded` 로 응답합니다.

---

## 처음 올릴 때 — 서비스별 준비

`ecosystem.config.js`에 **정의**되어 있는 것과 실제로 **기동**된 것은 다릅니다.
정의는 다섯 개 모두 되어 있지만, 아래 준비가 끝난 것만 `pm2 start`로 띄울 수 있습니다.
준비 없이 띄우면 재시작 루프에 빠집니다.

지금 무엇이 떠 있는지는 `pm2 list`로, 라우팅이 실제로 닿는지는 nginx 경유로 확인합니다.

```bash
curl -sk -o /dev/null -w '%{http_code}\n' https://127.0.0.1/cassini/
```

`502`면 nginx 설정은 맞는데 뒤에 프로세스가 없다는 뜻입니다.

| 앱 | 기동 전 필요한 것 |
|---|---|
| `face-recognition-server` | conda 환경 `uniface-env3` 와 모델 파일. `BACKEND_TLS` 는 `false`(기본값) |
| `web-cassini` | `dist/` 빌드 결과. 서버 코드 자체는 의존성이 없습니다 |
| `Huygens-Server` | `dist/` 컴파일 결과 + `.env`의 `USE_HTTPS=false` |
| `nginx-manager` | npm 의존성, 프론트 빌드, `config.json`, DB 스키마 |
| `websocket-relay` | `dist/` 컴파일 결과, MariaDB DB·계정, `.env` 의 DB 접속 정보. FCM 푸시를 쓰면 `secrets/firebase-admin.json` |
| `ntp-server` | `dist/` 컴파일 결과. chrony 설치와 설정 배포는 `npm run ntp:install` |

### `face-recognition-server`

`start_server.sh` 가 `envsetup.sh` 로 conda 환경 `uniface-env3` 를 활성화한 뒤 gunicorn 을 띄웁니다.
환경 자체는 미리 만들어져 있어야 합니다 (`environment.yml`, `envsetup.sh` 참고).

**`BACKEND_TLS` 는 `false`(기본값)로 두세요.** `true` 면 gunicorn 이 TLS 로 응답하는데,
이 서비스의 `nginx-conf/service.ini` 는 `protocol = http` 로 선언돼 있어 `/face/` 가 깨집니다.
(바꿔야 한다면 선언의 `protocol` 도 함께 `https` 로 고쳐야 합니다)

```bash
cd pm2 && pm2 start ecosystem.config.js --only face-recognition-server && pm2 save
```

### `web-cassini`

빌드에만 devDependencies가 필요하고, 실행에는 node만 있으면 됩니다.

```bash
cd services/apartment-mgmt-server/web-cassini && npm install && npm run build
```

```bash
cd pm2 && pm2 start ecosystem.config.js --only web-cassini && pm2 save
```

`dist/`가 없어도 프로세스는 뜨지만 `/health`가 `degraded`로 응답합니다.

### `websocket-relay`

설치와 점검이 npm 스크립트로 되어 있습니다. **여러 번 돌려도 안전합니다.**

```bash
cd services/websocket-relay && npm install && npm run setup
```

`.env` 생성, 빌드, DB 생성·스키마 적용, pm2 기동, `pm2 save` 까지 한 번에 합니다.
그래서 아래 `pm2 start` 를 따로 칠 필요가 없습니다. 중간에 멈추면 (보통 `.env` 의
`DB_PASSWORD` 가 비어 있을 때) 안내대로 채우고 다시 실행하면 끝난 단계는 건너뜁니다.

nginx 반영만 따로입니다 — sudo 가 필요해 스크립트가 대신 하지 않습니다.

```bash
npm run nginx:apply
```

상태만 보려면 `npm run doctor` 입니다. 설정·빌드·DB·pm2·nginx·헬스를 순서대로
점검하고 문제마다 해결 명령을 붙여 주며, 문제가 있으면 종료 코드 1로 끝납니다.
DB 내용을 보려면 `npm run db:status`.

저장소는 **MariaDB** 하나입니다(sqlite 폴백 없음). DB 가 안 붙으면 프로세스는 뜨지만
`/health` 가 `degraded` 가 되고 등록 API 가 503 을 줍니다 — **WebSocket 중계는 계속
동작합니다.** 통화 중에 DB 가 끊겼다고 통화까지 끊을 이유는 없기 때문입니다.

FCM 푸시 키가 없어도 프로세스는 정상이고 푸시만 꺼집니다
(`/health` 의 `details.pushEnabled` 로 확인).

**인스턴스를 늘리지 마세요.** 방(room) 상태를 프로세스 메모리에 들고 있어서
여러 개를 띄우면 클라이언트마다 다른 방 테이블을 보게 됩니다.

자세한 내용은 [../services/websocket-relay/README.md](../services/websocket-relay/README.md).

### `ntp-server`

시각 제공은 이 프로세스가 하지 않습니다 — **chronyd 가 systemd 아래에서
UDP 123 을 엽니다.** pm2 가 띄우는 것은 상태를 HTTP 로 보여 주는 사이드카라,
죽어도 시각 제공은 멈추지 않습니다.

```bash
cd services/ntp && npm install && npm run setup
```

chrony 설치(apt)와 설정 배포(/etc)는 sudo 가 필요해 `setup` 이 물어봅니다.
`systemd-timesyncd` 는 클라이언트 전용이라 시각을 제공할 수 없고, chrony 를
설치하면 자동으로 비활성화됩니다.

상태는 `npm run ntp:status`, 전반 점검은 `npm run doctor` 입니다.
자세한 내용은 [../services/ntp/README.md](../services/ntp/README.md).

### `Huygens-Server`

`script`가 `dist/server.js`라 **컴파일 결과를 실행합니다.** `src/`만 고치고 띄우면 옛 코드가 돕니다.
`dist`가 `src`보다 오래됐는지 먼저 확인하세요.

```bash
cd services/apartment-mgmt-server/app && npm run build
```

띄우기 전에 **`app/.env`의 `USE_HTTPS`가 `false`인지 확인해야 합니다.**
nginx는 `proxy_pass http://complex_backend`로 보내므로, 앱이 TLS로 응답하면
`/complex/*` 라우트가 전부 깨집니다.

`ALLOWED_IPS`도 함께 봐 두면 좋습니다. 앱에 IP 허용목록이 있고 `trust proxy: true`라
nginx 뒤에서도 실제 클라이언트 IP를 봅니다. `/health`는 이 미들웨어보다 **위에** 등록돼 있어
대시보드는 영향을 받지 않지만, 목록이 낡았으면 실제 트래픽이 403이 날 수 있습니다.

```bash
cd pm2 && pm2 start ecosystem.config.js --only Huygens-Server && pm2 save
```

### `nginx-manager`

준비 단계가 가장 많습니다. 전체 절차는 [../services/manager/README.md](../services/manager/README.md)의 `## 설치`에 있고, 요약하면 네 가지입니다.

```bash
cd services/manager/server && npm install
```

```bash
cd services/manager/web && npm install && npm run build   # ../server/public 에 생성
```

```bash
cd services/manager && sudo ./schema/setup_database.sh    # DB 스키마 + 비밀번호 파일
```

```bash
cd services/manager && cp config.example.json config.json
```

`config.json`의 `superAdmin.passwordHash`는 **반드시 채웁니다.** 기본 비밀번호가 없어서
비어 있으면 관리자 로그인이 항상 실패합니다(fail-closed).
`cd server && npm run hash-password -- '<비밀번호>'` 결과인 `scrypt$…`를 넣으세요.

```bash
cd pm2 && pm2 start ecosystem.config.js --only nginx-manager && pm2 save
```

---

## 1. 설치

pm2는 이 서버의 nvm 관리 Node(`v24.18.1`)에 npm 전역 패키지로 설치되어 있습니다. sudo가 필요 없습니다.

```bash
npm install -g pm2
pm2 -v          # 설치 확인
```

이미 설치되어 있다면 업그레이드는 동일한 명령으로 됩니다 (npm이 기존 버전을 교체).

pm2 데몬(God process)은 최초로 `pm2` 명령을 실행하는 순간 백그라운드에 자동으로 떠서 계속 상주합니다. 별도로 "pm2 서버 시작" 같은 걸 할 필요는 없습니다 — 데몬이 죽으면(reboot 등) 다시 살리는 방법은 [부팅 시 자동 시작](#4-부팅-시-자동-시작) 참고.

## 2. 앱 정의: `ecosystem.config.js`

pm2가 관리하는 모든 앱은 이 파일의 `apps` 배열에 정의되어 있습니다.

```js
module.exports = {
  apps: [
    {
      name: 'face-recognition-server',
      cwd: service('face-recognition-server'),
      script: './start_server.sh',
      interpreter: 'bash',
      env: { FOREGROUND: 'true' },
      autorestart: true,
      min_uptime: '30s',
      max_restarts: 10,
      kill_timeout: 20000,
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      time: true,
    },
  ],
};
```

### `face-recognition-server`가 조금 특별한 이유

`start_server.sh`는 원래 gunicorn 과 log-relay 를 `nohup ... &`로 백그라운드에 띄우고
**즉시 종료**하는 스크립트입니다. pm2는 관리하는 프로세스가 포그라운드로 계속 살아있을
것을 기대하기 때문에, 그대로 두면 pm2가 "앱이 바로 종료됐다"고 판단하고 계속 재시작을
시도합니다(이미 포트를 점유한 프로세스가 있으니 매번 에러로 실패).

그래서 스크립트가 `FOREGROUND=true` 환경변수를 지원하도록 최소 수정했습니다:

- `FOREGROUND=true`일 때만 자식 프로세스의 PID를 모아 `wait`으로 블로킹합니다.
- pm2가 `stop`/`restart`로 보내는 SIGTERM/SIGINT에 트랩이 걸려, gunicorn 과 log-relay 에
  정상 종료 신호를 보내고 잠시 기다린 뒤 안 죽은 것만 `kill -9`로 정리합니다.
- `FOREGROUND` 없이 그냥 `./start_server.sh`로 수동 실행하면 **기존 동작(백그라운드
  detach 후 즉시 셸 복귀)이 그대로 유지**됩니다. pm2 없이 수동 운영하던 방식은 안 바뀝니다.

현재 이 스크립트는 gunicorn **한 개**(포트 5500)와 log-relay 한 개(TCP 5514)를 띄웁니다.
여러 인스턴스를 띄우던 `start_3_instances.sh` 는 `start_instances.sh` 로 정리되었고,
pm2가 실행하는 것은 `start_server.sh` 입니다. 인스턴스를 늘린다면 그 포트를
`services/face-recognition-server/nginx-conf/service.ini` 의 `ports` 에도 모두 적어야
`least_conn` 으로 분산됩니다.

### `nginx`는 왜 pm2로 관리하지 않나

nginx는 80/443 포트를 열려면 root 권한이 필요합니다. 지금은 systemd가 root로 nginx를 기동/재시작해주고 있고(이미 `enabled`+`active` 상태), 이 구조를 유지하는 게 가장 안전하고 재부팅 시 다운타임/권한 문제가 없습니다. pm2로 옮기려면 `setcap`으로 nginx 바이너리에 낮은 포트 바인딩 권한을 주거나 root용 pm2 인스턴스를 별도로 띄워야 하는데, 패키지 업그레이드마다 setcap을 다시 걸어야 하는 등 운영 부담이 늘어서 보류했습니다.

라우팅은 각 서비스의 `nginx-conf/service.ini`에 있습니다(스키마: `../docs/nginx-conf.md`).
선언을 바꾼 뒤 nginx에 반영하려면 다음을 사용하세요:

```bash
cd nginx
./install_nginx_stack.sh --skip-install   # conf.d 재생성 + nginx reload
```

(앱 인스턴스는 이제 pm2가 띄우므로 이 스크립트는 앱을 건드리지 않습니다.
반영 전에 선언만 검사하려면 `--check`를 쓰세요.)

## 3. 앱 등록 / 편집 / 삭제

### 지금 등록된 앱 전부 시작
```bash
cd pm2
pm2 start ecosystem.config.js
```

### 특정 앱만 시작
```bash
pm2 start ecosystem.config.js --only face-recognition-server
```

### 새 앱 등록하기
1. 앱 소스를 `services/` 아래에 둡니다.
2. `ecosystem.config.js`의 `apps` 배열에 새 객체를 추가합니다. 최소 필드:
   ```js
   {
     name: '앱이름',           // pm2 list에 표시되는 이름, 고유해야 함
     cwd: service('앱디렉토리'),   // path.resolve(__dirname, '../services', ...)
     script: './진입스크립트',  // 예: server.js, start.sh
     // Node 앱이면 interpreter 지정 불필요. bash 스크립트면 interpreter: 'bash'
   }
   ```
3. 그 스크립트/프로세스가 **포그라운드에서 종료 없이 계속 떠 있어야** 합니다. `nohup ... &` 후 즉시 리턴하는 형태면 pm2가 오작동합니다 — `face-recognition-server`처럼 `wait` + signal trap을 추가하거나, 원래부터 foreground로 도는 프로세스(예: `node server.js`, `gunicorn`을 직접 호출)를 쓰세요.
4. 반영:
   ```bash
   pm2 start ecosystem.config.js --only 앱이름
   pm2 save   # 아래 "부팅 시 자동 시작"에서 쓰는 스냅샷 갱신
   ```

### 기존 앱 설정 편집
`ecosystem.config.js`를 수정한 뒤:
```bash
pm2 reload ecosystem.config.js --only face-recognition-server   # 무중단(가능한 경우) 재시작
# 또는
pm2 restart ecosystem.config.js --only face-recognition-server  # 확실한 완전 재시작
pm2 save
```
`env` 값(예: 포트, `FOREGROUND`)을 바꿨다면 `reload`/`restart`가 아니라 `pm2 delete` 후 `pm2 start`로 완전히 새로 띄워야 반영되는 경우가 있습니다(환경변수는 프로세스 최초 fork 시점에 캐시됨).

### 앱 제거
```bash
pm2 delete face-recognition-server
pm2 save
```
`ecosystem.config.js`에서도 해당 객체를 지우는 걸 잊지 마세요 — 안 지우면 다음 `pm2 start ecosystem.config.js`에서 다시 등록됩니다.

## 4. 부팅 시 자동 시작

> **지금 이 서버의 crontab 은 깨져 있습니다.** 등록된 줄이
> `…/Public/pm2/pm2-boot.sh` 를 가리키는데 (`WebServices/` 가 빠졌습니다) 그런 경로가 없습니다
> (`WebServices/` 아래로 옮기기 전 경로가 그대로 남았습니다).
> **이 상태로 재부팅하면 pm2 앱이 하나도 복원되지 않습니다.**
> 아래 "지금 crontab 고치기" 를 먼저 보세요.

이전에는 nginx만 crontab의 `@reboot`로 재시작 스크립트를 돌렸습니다 (`register_nginx_cron.sh`가 등록한 항목). nginx 자체는 이제 `systemctl enable`된 상태(확인: `systemctl is-enabled nginx`)라 재부팅 시 자동으로 뜨므로, 이 cron 항목은 **삭제 대상**입니다.

대신 pm2가 재부팅 후 등록된 앱들을 복원하도록, crontab에 아래 한 줄을 등록합니다 (sudo 불필요, 사용자 crontab):

cron 은 실행 시점에 cwd 가 없어서 절대 경로여야 합니다. 그래서 경로를 문서에
적는 대신, **루트에서 `$PWD` 로 만들어** 넣습니다.

```bash
echo "@reboot sleep 20 && /bin/bash $PWD/pm2/pm2-boot.sh >> $PWD/pm2/pm2-boot.log 2>&1"
```

큰따옴표라 `$PWD` 가 지금 서 있는 자리로 펼쳐집니다. 출력된 줄을 crontab 에
넣으면 됩니다 (아래 "지금 crontab 고치기" 가 한 번에 해 줍니다).

`pm2-boot.sh`는 cron의 최소 환경에서도 nvm을 명시적으로 로드해서 `pm2 resurrect`를 실행합니다(`pm2 resurrect`는 가장 최근 `pm2 save`로 저장된 앱 목록을 다시 띄워줍니다). GPU 모델 로딩 시간을 감안해 20초 지연을 둡니다.

**주의:** `pm2 resurrect`가 복원하는 목록은 마지막 `pm2 save` 시점 기준입니다. 앱을 추가/수정/삭제했으면 반드시 `pm2 save`를 실행해서 스냅샷을 갱신하세요. 그렇지 않으면 재부팅 후 옛 목록이 복원됩니다.

### 지금 crontab 고치기

현재 등록된 내용은 이렇습니다 (`crontab -l`).

```
@reboot sleep 20 && /bin/bash …/Public/pm2/pm2-boot.sh ...              # ← WebServices/ 가 빠진 옛 경로
@reboot sleep 20 && /bin/bash .../nginx/install_nginx_stack.sh --skip-install ... # ← 이제 불필요
```

첫 줄은 경로가 틀려 아무 일도 하지 않고, 둘째 줄은 nginx 가 systemd 로 뜨므로
필요 없습니다. 아래 한 줄로 통째로 바꿉니다.

**`WebServices/` 루트에서** 실행하세요 — `$PWD` 가 그 경로로 펼쳐집니다.
먼저 백업해 두면 되돌리기 쉽습니다.

```bash
crontab -l > ~/crontab.backup
```

옛 항목은 명령 줄과 `# Added by ...` 주석 줄이 짝을 이루고 있어 **둘 다** 지웁니다.
주석만 남기면 다음 사람이 무엇을 지운 건지 헷갈립니다.

```bash
{ crontab -l 2>/dev/null \
    | grep -vE 'pm2-boot\.sh|install_nginx_stack\.sh' \
    | grep -vE '^# Added by (pm2/README\.md pm2-boot setup|register_nginx_cron\.sh)$' \
    | sed '/^[[:space:]]*$/d'
  echo "# Added by pm2/README.md — pm2 resurrect on boot"
  echo "@reboot sleep 20 && /bin/bash $PWD/pm2/pm2-boot.sh >> $PWD/pm2/pm2-boot.log 2>&1"
} | crontab -
crontab -l
```

`crontab -` 로 표준 입력에서 받습니다. 파일 경로를 인자로 주면 경로가 길 때
잘려서 실패하는 경우가 있습니다.

바꾼 뒤 확인:

```bash
crontab -l | grep -oP '/bin/bash \K[^ ]+' | xargs -I{} test -x {} && echo OK
```

바꾼 뒤에는 `pm2 save` 로 스냅샷이 최신인지 확인하세요. 복원되는 것은
crontab 이 아니라 **마지막 `pm2 save` 시점의 목록**입니다.

직접 편집하려면 `crontab -e` 로 위 두 줄을 지우고 새 줄을 넣으면 됩니다.

### (대안) systemd로 등록하는 방법
crontab 대신 systemd로 pm2를 등록할 수도 있습니다. 이건 pm2 데몬 자체가 죽었을 때도 systemd가 재시작해주는 장점이 있지만, `/etc/systemd/system/`에 유닛 파일을 쓰기 위해 **sudo가 필요**합니다:
```bash
pm2 startup systemd
# 안내되는 sudo 명령을 실행 (예: sudo env PATH=$PATH:... pm2 startup systemd)
pm2 save
```
이후 부팅 시 systemd가 `pm2-ptype.service`를 통해 pm2 데몬을 띄우고 `pm2 resurrect`를 자동 실행합니다. 제거는 `pm2 unstartup systemd`.

## 5. 자주 쓰는 명령

```bash
pm2 list                        # 전체 앱 상태 (pid, uptime, 재시작 횟수, cpu/mem)
pm2 describe face-recognition-server   # 상세 정보 (로그 경로, env 등)
pm2 logs face-recognition-server       # 실시간 로그 스트림
pm2 logs face-recognition-server --lines 100 --nostream   # 최근 100줄만
pm2 monit                       # 실시간 CPU/메모리 대시보드
pm2 restart face-recognition-server
pm2 stop face-recognition-server
pm2 flush                       # 로그 파일 비우기
pm2 save                        # 현재 목록을 스냅샷으로 저장 (재부팅 복원용)
```

## 6. 문제 해결

- **`pm2 list`에 앱이 계속 재시작(↺ 카운트 증가)됨**: 대부분 스크립트가 포그라운드에 남아있지 않고 바로 종료되는 경우입니다. `pm2 logs <앱> --lines 50`으로 마지막 로그를 확인하세요.
- **재부팅 후 앱이 안 뜸**: `pm2-boot.log`를 확인하세요. nvm 경로 문제이거나, `pm2 save`를 안 해서 저장된 dump가 없는 경우입니다 (`~/.pm2/dump.pm2` 존재 여부 확인).
- **face-recognition-server가 포트 충돌로 안 뜸**: `ss -ltnp 'sport = :5500'`으로 누가 5500을 점유 중인지 확인하세요. pm2 밖에서 수동으로 띄워둔 게 있다면 `stop_server.sh`(또는 여러 인스턴스를 띄웠다면 `stop_instances.sh`)로 먼저 정리합니다.
