# 구조 변경 계획 — `nginx/` → `webservices/`

`../webservices-nginx` 가 설명하는 구조로 옮기고, 거기에 더해 pm2 도 서비스별
선언을 스캔하도록 바꾸는 계획입니다. **현재 서비스는 유지한 채** 진행합니다.

- 라우팅 선언: `nginx.ini` 한 파일 → `services/*/nginx-conf/*.ini` ([스키마](nginx-conf.md))
- 프로세스 선언: `services/ecosystem.config.js` 한 파일 → `services/*/pm2-conf/*.ini` ([스키마](pm2-conf.md))
- 서버 수준 값: `nginx.ini [server]` → `nginx/nginx-stack.conf`

## 실행 기록 (2026-08-18)

아래 계획대로 진행했고, **모두 끝났습니다.**

| 단계 | 상태 | 결과 |
|---|---|---|
| 1. 백업 | ✅ | `../nginx.bak.20260818-193136`, `~/dump.pm2.before-migration`, `~/crontab.backup` |
| 2. 뼈대 | ✅ | `docs/` `nginx/` `pm2/` 생성, 스크립트·인증서 복사 |
| 3. 선언 파일 | ✅ | `nginx-conf` 6개(route-a/b/c 는 `enabled=false`), `pm2-conf` 8개 |
| 4. 생성기 확장 + 검증 | ✅ | 아래 `검증 결과` |
| 5. 루트 이름 변경 | ✅ | `nginx/` → `webservices/`. 프로세스는 살아남음 |
| 6. nginx 컷오버 | ✅ | `/etc/nginx/conf.d/path-routing.conf` 생성, 옛 sites-enabled 링크 제거, 무중단 reload |
| 7. pm2 컷오버 | ✅ | 8개 재등록 + `pm2 save`. 전부 online |
| 8. 마무리 | ✅ | manager 로더 교체·재빌드, 옛 파일 `.migration-backup/`, README 재작성, `@reboot` 등록 |

### 컷오버 확인 (2026-08-18 19:52)

reload 는 무중단으로 들어갔습니다 — master 프로세스는 그대로고 worker 만 교체됐습니다.

| 항목 | 결과 |
|---|---|
| `/etc/nginx/conf.d/path-routing.conf` | 생성 (root:root 0644) |
| `sites-enabled/` | 비어 있음 — legacy·default 링크 제거됨 |
| 인증서 경로 | `Public/webservices/nginx/cert/...` |
| `/` → `/manager` | 302 |
| `/manager`, `/stock-analyzer` | 301 (트레일링 슬래시) |
| `/ws-bridge/dashboard` | 302 (로그인 리다이렉트) |
| `/health` 3종 | 200 |
| HTTP:80 → HTTPS | 301 |
| `error.log` | reload notice 만 |

이름 변경으로 사라졌던 인증서 경로를 더는 참조하지 않습니다. `sudo systemctl
restart nginx` 로 실제 재기동까지 확인했습니다 — master 프로세스가 새로 뜨고
라우트·`/health` 전부 그대로였습니다. 부팅 후 nginx 기동은 안전합니다.

### 이후 변경 — 중복 서비스 정리 (2026-08-18)

아래 문서의 구조 그림에는 지금 없는 서비스 둘이 남아 있습니다. 마이그레이션
직후에 제거했기 때문입니다. 그림은 이관 당시 기록으로 그대로 둡니다.

| 제거 | 이유 |
|---|---|
| `webrtc-signal-server` | `rtc-relay-server`(당시 `callfusion-ts-server`) 가 이 코드의 JS→TS 이식이자 파일 단위 상위집합. pm2·nginx 미등록, GitHub 에 원본 보존 |
| `callfusion-v2-server` | V1 과 와이어 프로토콜이 다르고(`type` 분기 vs V1 의 `method` 분기) `firebase-admin` 이 없어 FCM 푸시를 못 보냄 — V1 을 대체하지 못하는 별개 재작성 |

사본: `/home/jejezz/Public/removed-services.20260818/`. pm2 앱 `callfusion-v2`(28091)
도 함께 삭제하고 `pm2 save` 했습니다. 남은 앱 7개.

이어서 `callfusion-ts-server` 를 **`rtc-relay-server`** 로 개명했습니다 — 이름이
너무 일반적이라 서비스를 특정하기 어려웠기 때문입니다. 디렉토리, pm2 앱 이름,
`process.title`, `/health` 의 `service` 필드, `package.json` 의 `name` 을 모두 맞췄습니다.
Android 알림 채널 ID `callfusion_2_rtc` 는 외부와 맞물려 있어 그대로 둡니다.
아래 구조 그림은 이관 당시 이름으로 남아 있습니다.

> **정정 (2026-08-21).** 원래 이 자리에 *"MariaDB 스키마 `callfusion2rtc` 도 그대로
> 둡니다"* 라고 적혀 있었는데, 실제로는 **`rtc_relay` 로 개명됐습니다.**
> `database/database.ini` 의 `[user:jyahn]` 선언(`rtc_relay`)과 실제 권한이 맞고,
> `callfusion2rtc` 라는 DB 는 존재하지 않습니다.
>
> 이 줄이 사람을 헷갈리게 합니다 — 없는 이름으로 접속하면 MariaDB 가 "없는 DB"
> 가 아니라 **`Access denied`** 를 돌려주기 때문에, 권한 문제로 오해하기 쉽습니다.

### 검증 결과

**nginx 설정** — 생성된 설정과 이관 전 `/etc/nginx/sites-available/reverse-proxy.conf`
의 차이는 다음이 전부였습니다. 사라진 지시자는 없습니다.

| 차이 | 성격 |
|---|---|
| upstream 블록 도입 (`proxy_pass http://127.0.0.1:28084` → `http://manager_backend`) | 기능 동일 + `max_fails=3 fail_timeout=10s` |
| `proxy_connect_timeout 5s`, `proxy_send/read_timeout 120s` 추가 | 이전엔 nginx 기본값(60s). WebSocket 에는 유리 |
| `Connection "upgrade"` → `$connection_upgrade` (map) | 개선. 업그레이드가 아닌 요청(`/ws-bridge/dashboard`)에 `upgrade` 를 붙이지 않음 |
| 인증서 절대 경로 | 이름 변경 반영 |
| 주석·라우트 이름 표시 | 표시용 |

**pm2 앱 정의** — 8개를 옛 `ecosystem.config.js` 와 필드 단위로 비교했습니다.

| 차이 | 성격 |
|---|---|
| `cwd` 가 `services/` → 서비스 디렉토리, `script` 는 그만큼 짧아짐 | 최종 실행 파일 동일. 소스에 `process.cwd()` 사용이 없어 안전(확인함) |
| 로그가 `services/logs/` → `pm2/logs/` | 의도된 통일 |
| `autorestart` 명시(`true`) | pm2 기본값과 같음 |
| `env` 의 숫자가 문자열로 | pm2 가 어차피 문자열로 넘김 |

`callfusion2rtc` 는 이관 전 메모리 상한이 없었으므로 `max_memory_restart = none`
으로 명시했습니다 — 기본값 256M 이 조용히 붙는 것을 막습니다.

## 목표 구조

```
webservices/
├── docs/                     # 서비스 사이의 약속
│   ├── nginx-conf.md
│   ├── pm2-conf.md
│   ├── health-contract.md
│   └── migration-plan.md     # 이 문서
├── nginx/                    # 서버 수준 설정과 설치 스크립트
│   ├── nginx-stack.conf      # listen/TLS/mTLS/포트포워딩/default_route
│   ├── generate_nginx_conf.py
│   ├── server.conf.template
│   ├── install_nginx_stack.sh
│   ├── install_nginx.sh
│   ├── generate_certs.sh
│   └── cert/{ca,server,client}
├── pm2/                      # 프로세스 오케스트레이션
│   ├── ecosystem.config.js   # 정의가 아니라 pm2-conf 스캐너
│   ├── pm2-boot.sh
│   ├── install_pm2.sh
│   └── logs/
├── database/                 # MariaDB (참조 저장소에는 없음, 그대로 유지)
├── services/                 # 서비스 하나 = 디렉토리 하나
│   ├── .session-secret       # 대시보드 공통 세션 서명 키 (600, 커밋 금지)
│   ├── manager/{nginx-conf,pm2-conf}/
│   ├── ws-bridge/{nginx-conf,pm2-conf}/
│   ├── stock-analyzer/{nginx-conf,pm2-conf}/
│   ├── route-a|route-b|route-c/{nginx-conf,pm2-conf}/
│   ├── callfusion-ts-server/pm2-conf/     # nginx 라우트 없음 (포트 직결)
│   ├── callfusion-v2-server/pm2-conf/     # nginx 라우트 없음 (포트 직결)
│   └── webrtc-signal-server/              # 미등록 — 선언 없음
└── README.md
```

경계는 이렇습니다.

| 디렉토리 | 담는 것 | 담지 않는 것 |
|---|---|---|
| `docs/` | 서비스가 지켜야 할 규약 | 특정 서비스의 사정 |
| `nginx/` | TLS·listen 포트 등 서버 수준 설정, 설치 스크립트 | 라우팅(각 서비스가 선언), 서비스 코드 |
| `pm2/` | 스캐너, 부팅 스크립트, 로그 | 앱 정의(각 서비스가 선언), 서비스 코드 |
| `services/` | 서비스별 소스와 각자의 선언 | 오케스트레이션 설정 |

`services/` 아래에는 이미 독립 git 저장소가 둘 있습니다 (`manager`,
`webrtc-signal-server`). 선언을 서비스 안으로 내리면 그 저장소가 자기 라우팅과
프로세스 정의를 함께 커밋하게 됩니다 — 이 구조의 핵심 이득입니다.

`stock-analyzer-electron/` 은 웹 전환의 원본이라 서비스가 아닙니다.
`services/` 밖에 그대로 두거나 `services/stock-analyzer/` 안으로 넣습니다 (열린 항목).

## 파일 이동

| 현재 | 새 위치 | 비고 |
|---|---|---|
| `nginx.ini [server]` | `nginx/nginx-stack.conf` | 키 이름 대부분 그대로 |
| `nginx.ini` 라우트 섹션 | `services/*/nginx-conf/service.ini` | 아래 변환표 |
| `nginx.conf.template` | `nginx/server.conf.template` | 자리표시자를 `__NAME__` 형식으로 |
| `location.conf.template` | (없어짐) | 생성기가 파이썬으로 직접 렌더 |
| `setup_nginx.sh` | `nginx/install_nginx_stack.sh` + `generate_nginx_conf.py` | bash INI 파서 → 파이썬 |
| `install_nginx.sh`, `generate_certs.sh` | `nginx/` | 그대로 |
| `cert/` | `nginx/cert/` | 경로는 `nginx-stack.conf [tls]` 가 가짐 |
| `services/ecosystem.config.js` | `pm2/ecosystem.config.js` (스캐너) + `services/*/pm2-conf/app.ini` | |
| `services/install_pm2.sh` | `pm2/install_pm2.sh` | |
| `services/logs/` | `pm2/logs/` | 로그 기본 경로 통일 |
| `services/.session-secret` | 그대로 | 서비스들이 공유하므로 `services/` 에 남습니다 |
| `services/.migration-backup/`, `migrate_callfusion.sh` | 그대로 | 1회성 유물 |
| `database/` | 그대로 | 최상위 유지 |

## 선언 변환

`nginx.ini` 의 라우트 3개와 `ecosystem.config.js` 의 앱 8개가 이렇게 나뉩니다.

| 서비스 | nginx-conf | pm2-conf | 지금 상태 |
|---|---|---|---|
| `manager` | `/manager` → 28084 | `cwd=server` | 둘 다 있음 |
| `ws-bridge` | `/ws-bridge/` → 28083, ws | `DASHBOARD_PATH=/dashboard` | 둘 다 있음 |
| `stock-analyzer` | `/stock-analyzer` → 28085 | tsx interpreter, 512M | 둘 다 있음 |
| `route-a` `route-b` `route-c` | `enabled = false` | 28080·28081·28082 | 라우트가 `;` 주석 처리돼 있음 |
| `callfusion2rtc` | 없음 | `HEALTH_URL` (자체 HTTPS 28099) | pm2 만 |
| `callfusion-v2` | 없음 | env 3종, 28091 | pm2 만 |
| `webrtc-signal-server` | 없음 | 없음 | 미등록 |

세 라우트 모두 `proxy_pass` 에 경로가 없으므로 **`proxy_path` 를 비워 둡니다.**
그래야 지금처럼 원본 URI 가 그대로 백엔드에 전달되고, manager 의 `basePath`
(`/manager`)와 ws-bridge 의 경로 처리가 그대로 동작합니다.

## 생성기에 채워야 할 기능

참조 저장소의 `generate_nginx_conf.py` / `server.conf.template` 에는 없는데
이 서버가 **실제로 쓰고 있는** 것들입니다. 그냥 옮기면 접속이 깨집니다.

| 기능 | 왜 필요한가 | 어디에 |
|---|---|---|
| `ssl_client_certificate` + `ssl_verify_client` | mTLS. `cert/client/{android,ios,electron}` 발급본이 쓰이고 있음 | `[tls] client_ca`, `verify_client` |
| `map $http_host $public_https_host` | 공유기 포워딩(외부 28080/28443). 없으면 외부 HTTP 접속이 내부 443 으로 리다이렉트돼 끊김 | `[general] public_http_port`, `public_https_port` |
| `absolute_redirect off` | 절대 URL 리다이렉트가 포트를 443 으로 바꿔버리는 것을 막음 | 템플릿 고정 |
| `error_page 497 https://$http_host$request_uri` | `host:28443` 을 http 로 입력한 경우 구제 | 템플릿 고정 |
| `location = / { return 302 <경로>; }` | 루트 접속 → `/manager`. **유지하기로 결정** | `[general] default_route` |
| `server_name` | 참조 구현은 `_` 고정 | `[general] server_name` |
| `ssl_ciphers`, `ssl_session_cache/timeout` | 지금 설정에 있음 | 템플릿 고정 |

### 의도적으로 다르게 두는 것

참조 구현을 그대로 따르면 **동작이 미묘하게 바뀌는** 항목입니다. 이번 이관에서는
현재 동작을 우선합니다.

| 항목 | 참조 구현 | 이번 결정 |
|---|---|---|
| `X-Forwarded-Proto` | `https` 고정 | **`$scheme` 유지.** 지금 동작과 같게 |
| 비 WebSocket 라우트의 `Connection` | `""` (upstream keepalive) | 헤더를 넣지 않음. upstream 에 `keepalive` 지시자가 없어 실익이 없고, 차이를 만들 이유가 없음 |
| 출력 경로 | `/etc/nginx/conf.d/path-routing.conf` | 같게 감. 단 **컷오버 때 옛 `sites-enabled/reverse-proxy.conf` 심볼릭 링크를 반드시 제거** — 둘 다 살아 있으면 `default_server` 중복으로 `nginx -t` 가 실패합니다 |
| 인증서 배치 | 원본을 `/etc/nginx/certs/` 로 **복사** | 지금처럼 저장소 경로를 직접 가리킴. 복사 단계를 늘리지 않음 |

## 절차

각 단계의 **중단 여부**를 함께 적었습니다. 실제로 트래픽이 끊길 수 있는 곳은
5단계와 6단계뿐이고, 둘 다 초 단위입니다.

### 1. 백업 — 중단 없음

```bash
cp -a /home/jejezz/Public/nginx /home/jejezz/Public/nginx.bak.$(date +%Y%m%d)
pm2 save && cp ~/.pm2/dump.pm2 ~/dump.pm2.before-migration
crontab -l > ~/crontab.backup 2>/dev/null || true
```

`/etc/nginx/sites-available/reverse-proxy.conf` 도 따로 떠 둡니다 (sudo 필요).

### 2. 뼈대 생성 — 중단 없음

`docs/` `nginx/` `pm2/` 를 만들고 기존 파일을 **복사**합니다. 옮기지 않습니다.
이 시점에는 옛 경로가 그대로 살아 있어 무엇을 해도 서비스에 영향이 없습니다.

### 3. 선언 파일 작성 — 중단 없음

서비스마다 `nginx-conf/service.ini` 와 `pm2-conf/app.ini` 를 씁니다. 기존
`nginx.ini` / `ecosystem.config.js` 에서 기계적으로 옮기는 작업이고, 아직 아무것도
적용하지 않습니다.

### 4. 생성기 확장 + 동등성 검증 — 중단 없음

위 표의 기능을 채운 뒤, 새로 생성한 설정과 **지금 돌고 있는 설정을 diff** 합니다.
이 단계가 이 계획의 핵심 안전장치입니다.

```bash
./nginx/install_nginx_stack.sh --check      # 선언 파싱·충돌 검사 (sudo 불필요)
./nginx/install_nginx_stack.sh --dry-run    # 생성 결과를 표준 출력으로
node pm2/ecosystem.config.js --check        # pm2 선언 해석 + 포트 교차 검사
```

diff 에서 남아야 할 차이는 순서·주석·공백뿐입니다. 지시자가 사라졌거나
새로 생겼으면 그 자리에서 멈추고 원인을 찾습니다.

### 5. 루트 이름 변경 — **여기서만 실제 위험이 있음**

```bash
mv /home/jejezz/Public/nginx /home/jejezz/Public/webservices
```

- **실행 중인 프로세스는 살아남습니다.** 같은 파일시스템 안의 `mv` 는 inode 를
  바꾸지 않아 열려 있는 fd 와 cwd 가 그대로 유효합니다.
- 그러나 **기록된 절대 경로는 전부 낡습니다.**
  - `~/.pm2/dump.pm2` 에 옛 경로가 71 곳 있습니다 → 재등록 전에는 `pm2 restart`
    를 하면 안 됩니다.
  - `/etc/nginx/sites-available/reverse-proxy.conf` 의 인증서 경로가 사라집니다
    → **6단계 전에 nginx 를 reload/restart 하면 뜨지 않습니다.** 이미 떠 있는
    nginx 는 인증서를 메모리에 들고 있어 계속 서비스합니다.
  - `.claude/settings.local.json` 에도 옛 경로가 있습니다 (동작에는 영향 없음).
- 안전망: 되돌리려면 같은 `mv` 를 반대로 하면 끝입니다. 불안하면 이관 기간 동안
  `ln -s webservices /home/jejezz/Public/nginx` 로 옛 경로를 살려 둡니다.

5·6·7 단계는 **한 번에 이어서** 하는 것을 전제로 합니다.

### 6. nginx 컷오버 — reload 순간만, 무중단

sudo 가 필요하므로 스크립트로 만들어 드리고 실행은 직접 하십니다.

```bash
sudo ./nginx/install_nginx_stack.sh --skip-install
```

스크립트가 하는 일: 설정 생성 → `conf.d/path-routing.conf` 쓰기 →
**옛 `sites-enabled/reverse-proxy.conf` 심볼릭 링크 제거** → `nginx -t` →
`systemctl reload nginx`. reload 는 graceful 이라 기존 연결이 끊기지 않습니다.

`nginx -t` 가 실패하면 아무것도 reload 하지 않고 종료합니다. 롤백은 심볼릭 링크를
되살리고 새 conf 를 지운 뒤 reload — 30초면 됩니다.

### 7. pm2 컷오버 — 서비스당 1~2초

이름 8개를 그대로 유지하지만, 5단계에서 경로가 바뀌었으므로 **재등록이
필요합니다.** 한 번에 하지 말고 하나씩 합니다. 그러면 어느 순간에도 내려가 있는
서비스는 하나뿐입니다.

```bash
cd /home/jejezz/Public/webservices/pm2
pm2 delete ws-bridge && pm2 start ecosystem.config.js --only ws-bridge
# 헬스 확인 후 다음 서비스로
pm2 save
```

`manager` 는 자기가 대시보드라 마지막에 합니다.

### 8. 마무리 — 중단 없음

- manager 의 nginx 로더를 `nginx.ini` 파서에서 `nginx-conf` 스캐너로 교체하고
  `config.json` 의 `nginxIniPath` / `ecosystemPath` 를 새 경로로 바꿉니다.
  `ecosystemPath` 는 스캐너를 가리키면 되고, 스캐너의 출력 모양이 지금 배열과
  같으므로 pm2 쪽 코드는 그대로 둡니다.
- 옛 파일(`nginx.ini`, `setup_nginx.sh`, `*.template`, `services/ecosystem.config.js`)
  을 `.migration-backup/` 으로 옮깁니다. 지우지 않습니다.
- **부팅 복원을 등록합니다.** 지금은 crontab 이 비어 있고 pm2 systemd 유닛도 없어
  재부팅하면 아무것도 복원되지 않습니다.

  ```bash
  echo "@reboot sleep 20 && /bin/bash $PWD/pm2/pm2-boot.sh >> $PWD/pm2/pm2-boot.log 2>&1"
  ```

  `webservices/` 루트에서 실행해 나온 줄을 crontab 에 넣습니다. 절대 경로가
  필요한 곳은 여기 한 줄뿐입니다.
- README 를 새 구조에 맞게 다시 씁니다.

## 검증 체크리스트

컷오버 직후 확인합니다.

```bash
curl -sk -o /dev/null -w '%{http_code}\n' https://127.0.0.1/manager
curl -sk -o /dev/null -w '%{http_code}\n' https://127.0.0.1/ws-bridge/
curl -sk -o /dev/null -w '%{http_code}\n' https://127.0.0.1/stock-analyzer
curl -sk -o /dev/null -w '%{http_code}\n' https://127.0.0.1/          # 302 → /manager
curl -s  -o /dev/null -w '%{http_code}\n' http://127.0.0.1/           # 301 → https
```

`502` 면 nginx 설정은 맞는데 뒤에 프로세스가 없다는 뜻입니다.

- [ ] 위 5개 응답 코드가 이관 전과 같다
- [ ] 사용자 Mac 브라우저에서 외부 주소(`:28443`)로 접속 — 포워딩 map 과
      `error_page 497` 이 살아 있는지는 루프백으로 확인되지 않습니다
- [ ] 클라이언트 인증서로 접속되는지 (mTLS)
- [ ] `pm2 list` 8개 online, 재시작 카운트가 늘지 않음
- [ ] manager 대시보드에 8개 서비스가 모두 보이고 헬스가 정상
- [ ] ws-bridge 대시보드 링크가 살아 있음 (`location` + `DASHBOARD_PATH` 결합)
- [ ] manager 로그인 후 다른 서비스 대시보드로 SSO 가 이어짐
- [ ] `crontab -l` 의 경로가 실재함

## 열린 항목

1. `webrtc-signal-server` — 선언을 만들지, 미등록으로 둘지
2. `stock-analyzer-electron/` — `services/stock-analyzer/` 안으로 넣을지, 밖에 둘지
3. `route-a/b/c` — 라우트가 주석 처리된 상태로 pm2 에만 떠 있습니다.
   `enabled = false` 로 선언을 남길지, 서비스 자체를 정리할지
4. `stock-analyzer` 와 `callfusion-v2` 의 `/health` 응답 정리
   ([health-contract.md](health-contract.md) `현재 상태`)
5. 루트 저장소의 git 초기화 여부 — 지금 최상위에는 `.git` 이 없습니다
