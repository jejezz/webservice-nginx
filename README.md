# WebServices

이 서버가 웹으로 제공하는 것들을 한 곳에 모아 둔 디렉토리입니다.
역할에 따라 넷으로 나뉩니다.

```
WebServices/
├── docs/        # 서비스 사이의 약속 — nginx-conf 스키마, /health 규약
├── nginx/       # 리버스 프록시 설정과 설치 스크립트 (systemd가 nginx 자체를 관리)
├── pm2/         # 프로세스 오케스트레이션 — ecosystem.config.js, 부팅 스크립트
└── services/    # 서비스 코드. 하나의 서비스 = 하나의 디렉토리
    ├── manager/                  # 서비스 관리 대시보드 (루트 '/' 에서 응답)
    ├── face-recognition-server/  # /face/
    ├── apartment-mgmt-server/    # /complex/*
    ├── web-cassini/              # /cassini/
    ├── websocket-relay/          # /relay/   (WebSocket 릴레이)
    └── logd-server/              # 아직 미등록 — zip 파일만 있고 라우팅·프로세스 없음
```

경계는 이렇습니다.

| 디렉토리 | 담는 것 | 담지 않는 것 |
|---|---|---|
| `docs/` | 서비스가 지켜야 할 규약 | 특정 서비스의 사정 |
| `nginx/` | TLS·listen 포트 등 서버 수준 설정, `install_nginx_stack.sh` | 라우팅(각 서비스가 선언), 서비스 코드 |
| `pm2/` | `ecosystem.config.js`, `pm2-boot.sh`, 부팅 로그 | 서비스 코드 |
| `services/` | 서비스별 소스와 각자의 설정 | 오케스트레이션 설정 |

`services/` 아래의 디렉토리는 각자 독립된 git 저장소일 수 있습니다.
그래서 `ecosystem.config.js`를 `services/` 안이 아니라 `pm2/`에 두었습니다 —
`services/`는 "서비스 하나당 디렉토리 하나"만 유지합니다.

## 서로를 가리키는 방법

절대 경로는 `pm2/ecosystem.config.js`의 `cwd`(앱마다 한 줄, 현재 5개)와
사용자 crontab 의 `@reboot` 줄에만 있습니다. 나머지는 모두 스크립트 자기 위치
기준의 상대 경로이므로, `WebServices/` 전체를 옮길 때 이 둘만 고치면 됩니다.

> 실제로 예전에 이 디렉토리를 옮기면서 crontab 의 경로가 그대로 남아
> 재부팅 복원이 끊긴 적이 있습니다. 옮겼다면 `crontab -l` 로 확인하세요.

| 참조 | 경로 |
|---|---|
| manager → 서비스 선언 | `../services/*/nginx-conf/*.ini` |
| manager → nginx 서버 설정 | `../../nginx/nginx-stack.conf` |
| manager → PM2 앱 목록 | `../../pm2/ecosystem.config.js` |
| nginx 설치 스크립트 → 인증서 원본 | `nginx/certs/` (`nginx-stack.conf` 의 `[tls] cert_dir`) |
| nginx 가 실제로 읽는 인증서 | `/etc/nginx/certs/server.{crt,key}` (설치 스크립트가 복사) |
| 공유 세션 시크릿 | `services/.session-secret` |

## 서비스를 올리려면

각 서비스는 `nginx-conf/service.ini`로 자기 라우팅을 선언하고, `pm2`가 프로세스를 띄웁니다.
둘은 별개입니다 — **선언이 있어도 프로세스가 안 떠 있으면 그 경로는 502**입니다.

기동 전에 서비스마다 필요한 것(빌드 결과, `.env`, DB 스키마 등)이 다릅니다.
서비스별 준비 절차는 [pm2/README.md](pm2/README.md)의 `처음 올릴 때 — 서비스별 준비`에 있습니다.

라우팅 선언을 바꾼 뒤에는 다음으로 nginx에 반영합니다.

```bash
cd nginx && sudo ./install_nginx_stack.sh --skip-install
```

반영 전에 선언만 검사하려면 `--check`를 씁니다. 포트나 location이 겹치면
설정을 쓰지 않고 종료하므로, 잘못된 선언이 nginx까지 가지 않습니다.

## 어디서부터 읽을지

- 라우팅을 바꾸려면 → 그 서비스의 `nginx-conf/service.ini` ([스키마](docs/nginx-conf.md))
- 서버 수준 설정(listen 포트·TLS)을 바꾸려면 → [nginx/README.md](nginx/README.md)
- `/health` 응답 형식 → [docs/health-contract.md](docs/health-contract.md)
- 서비스를 추가·제거하거나 기동하려면 → [pm2/README.md](pm2/README.md)
- 대시보드와 로그인 → [services/manager/README.md](services/manager/README.md)
