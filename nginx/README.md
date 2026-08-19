# nginx

리버스 프록시의 **서버 수준 설정**과 설치·인증서 스크립트를 담습니다.
nginx 프로세스 자체는 systemd 가 관리합니다 (80/443 바인딩에 root 가 필요해서).

**라우팅은 여기에 없습니다.** 각 서비스가 자기 디렉토리의
`nginx-conf/service.ini` 에 포트와 경로를 선언하고, 이 디렉토리의 생성기가
그것을 모아 `/etc/nginx/conf.d/path-routing.conf` 를 만듭니다.
스키마는 [../docs/nginx-conf.md](../docs/nginx-conf.md) 입니다.

## 파일

| 파일 | 역할 |
|---|---|
| `install_nginx_stack.sh` | **주 진입점.** 설정 생성 + 검사 + reload |
| `generate_nginx_conf.py` | `services/*/nginx-conf/*.ini` → upstream/location 블록 |
| `nginx-stack.conf` | listen 포트, TLS, mTLS, 포트 포워딩, default_route |
| `server.conf.template` | 생성될 설정의 골격 |
| `install_nginx.sh` | nginx 설치/업데이트 (apt) |
| `generate_certs.sh` | 사설 CA·서버·클라이언트 인증서 생성 |
| `cert/` | 인증서 원본. nginx 가 이 경로를 직접 읽습니다 |

## 자주 쓰는 명령

라우팅 선언을 바꾼 뒤 반영합니다. **sudo 가 필요합니다** (`/etc/nginx/` 에 씁니다).

```bash
sudo ./install_nginx_stack.sh --skip-install
```

반영 전에 선언만 검사합니다. 포트나 location 이 겹치면 설정을 쓰지 않고
종료하므로, 잘못된 선언이 nginx 까지 가지 않습니다. sudo 가 필요 없습니다.

```bash
./install_nginx_stack.sh --check
```

무엇이 만들어질지 미리 봅니다.

```bash
./install_nginx_stack.sh --dry-run
```

| 플래그 | 뜻 |
|---|---|
| `--check` | 파싱·충돌 검사만. 아무것도 쓰지 않음 |
| `--dry-run` | 만들어질 설정을 출력만 |
| `--skip-install` | apt 설치 단계를 건너뜀 (이미 설치된 서버에서 상시 사용) |
| `--skip-reload` | 설정만 쓰고 reload 하지 않음 |

`nginx -t` 가 실패하면 reload 하지 않고 종료합니다. 되돌리는 명령을 함께
출력하므로 그대로 붙여 넣으면 됩니다.

## `nginx-stack.conf`

**서버 수준 값만** 담습니다. location 이나 upstream 을 여기에 직접 적지 마세요 —
생성기가 덮어씁니다. 경로를 바꾸려면 그 서비스의 `nginx-conf/service.ini` 를 고칩니다.

| 키 | 지금 값 | 설명 |
|---|---|---|
| `server_name` | `localhost` | |
| `listen_port` / `ssl_port` | `80` / `443` | |
| `services_dir` | `../services` | `nginx-conf/` 를 훑을 곳 |
| `max_body` | (비움) | 비우면 nginx 기본값 1m |
| `default_route` | `/manager` | 루트 `/` 접속을 302 로 보냅니다 |
| `public_http_port` / `public_https_port` | `28080` / `28443` | 공유기 포워딩 |
| `[tls] cert_dir` … | `./cert` | 인증서 원본 위치 |
| `[tls] client_ca`, `verify_client` | `ca/ca.crt`, `optional` | mTLS |

### 포트 포워딩 (`public_*_port`)

공유기가 **외부 28080 → 내부 80**, **외부 28443 → 내부 443** 으로 넘기는 환경입니다.
nginx 는 이 대응을 알 수 없으므로 생성기가 `map` 을 만들어 Host 의 포트를 보고
HTTPS 목적지를 정합니다. 이 값이 비면 외부에서 HTTP 로 들어온 요청이 내부 443
으로 리다이렉트돼 **접속이 끊깁니다.**

같은 이유로 생성된 설정에는 다음 둘이 항상 들어갑니다.

- `absolute_redirect off` — 절대 URL 리다이렉트가 포트를 443 으로 바꾸는 것을 막음
- `error_page 497 https://$http_host$request_uri` — `host:28443` 을 http 로 입력한 경우 구제

## 인증서

`generate_certs.sh` 가 사설 CA 와 서버·클라이언트 인증서를 `cert/` 아래에 만듭니다.

```bash
./generate_certs.sh                                           # localhost용
./generate_certs.sh example.com                               # 특정 도메인용
./generate_certs.sh --auto                                    # 로컬/외부 IP 자동 감지
./generate_certs.sh --auto example.com                        # 자동 감지 + 도메인
./generate_certs.sh --ip 192.168.0.10 example.com             # IP 수동 추가
./generate_certs.sh --ip 192.168.0.10,192.168.0.11,10.0.0.1   # IP 여러개
```

`--auto` 는 로컬 네트워크 IPv4(도커 브릿지 대역 제외)와 공인 IP 를 SAN 에 넣습니다.

> CIDR 대역(`192.168.0.0/24`)은 X.509 표준(RFC 5280)이 지원하지 않습니다.
> 허용할 IP 를 개별로 나열해야 합니다.

```
cert/
├── ca/     ca.key(보관 주의), ca.crt
├── server/ server.key, server.crt      # nginx 가 읽는 것
└── client/ electron|android|ios/ *.key *.crt *.pem *.p12 ca.crt
```

인증서를 다시 만든 뒤에는 **반영 스크립트를 다시 돌려야** 합니다
(경로가 같아도 nginx 가 파일을 다시 읽어야 하므로 reload 가 필요합니다).

```bash
./generate_certs.sh example.com && sudo ./install_nginx_stack.sh --skip-install
```

### mTLS

`nginx-stack.conf` 의 `[tls]` 가 정합니다.

| 값 | 뜻 |
|---|---|
| `verify_client = optional` | 클라이언트 인증서가 있으면 검증, 없어도 허용 (현재 설정) |
| `verify_client = on` | 클라이언트 인증서 필수 |

`client_ca` 를 비우면 검증 블록 자체를 만들지 않습니다.

### 클라이언트별 사용

Electron:

```javascript
const agent = new https.Agent({
  cert: fs.readFileSync('cert/client/electron/electron.crt'),
  key:  fs.readFileSync('cert/client/electron/electron.key'),
  ca:   fs.readFileSync('cert/client/electron/ca.crt'),
});
```

Android — `ca.crt` 를 기기 신뢰 저장소에 설치하고 `android.p12` 를 앱에 포함합니다.

```kotlin
val keyStore = KeyStore.getInstance("PKCS12")
keyStore.load(context.assets.open("android.p12"), "".toCharArray())
```

iOS — `ca.crt` 설치 후 `설정 > 일반 > 정보 > 인증서 신뢰 설정`에서 활성화하고
`ios.p12` 를 앱 번들에 포함합니다.

## 재부팅

nginx 는 systemd 가 띄웁니다. 확인:

```bash
systemctl is-enabled nginx && systemctl is-active nginx
```

crontab 의 `@reboot` 로 설정을 다시 만들 필요는 없습니다 — 생성된 설정은
`/etc/nginx/conf.d/` 에 남아 있습니다. crontab 은 pm2 복원에만 씁니다
([../pm2/README.md](../pm2/README.md)).
