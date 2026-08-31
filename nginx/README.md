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
| `generate_certs.sh` | 사설 CA·서버·클라이언트 인증서 생성 (**처음 한 번**) |
| `generate_client_certificates.sh` | 단말 하나에 배포할 클라이언트 번들 (**단말이 늘 때마다**) |
| `cert/` | 인증서 원본. nginx 가 이 경로를 직접 읽습니다 |

## 자주 쓰는 명령

라우팅 선언을 바꾼 뒤 반영합니다. **sudo 가 필요합니다** (`/etc/nginx/` 에 씁니다).

```bash
sudo ./install_nginx_stack.sh --skip-install
```

반영 전에 선언을 검사하고, **설치본이 지금 선언과 같은지**도 봅니다.
포트나 location 이 겹치면 설정을 쓰지 않고 종료하므로 잘못된 선언이 nginx 까지
가지 않습니다. sudo 가 필요 없습니다.

```bash
./install_nginx_stack.sh --check
```

선언만 보는 검사는 **"선언은 고쳤는데 반영을 안 한"** 상태를 잡지 못합니다.
그때 nginx 는 옛 라우트를 그대로 서비스하고 있고 어디에도 오류로 보이지
않습니다. 실제로 `/sip/` 라우트를 끈 뒤에도 한동안 그렇게 남아 있었습니다.
그래서 만들어질 내용과 설치본을 맞춰 봅니다
([docs/check-contract.md](../docs/check-contract.md) 의 '설치본이 저장소와 같은가').

```
[--]  설치본이 지금 선언과 다릅니다 (20줄) — 반영하세요:
      sudo ./install_nginx_stack.sh --skip-install
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
| `[tls] cert_file`, `key_file` | (비움) | 비우면 **사설 CA** (`server/server.crt`) |
| `[tls] client_ca`, `verify_client` | `ca/ca.crt`, `optional` | mTLS |

### 서버 인증서 경로는 `tls_mode` 에서 나옵니다

**이 파일은 커밋됩니다.** 예전에는 이 자리에 한 장비의 Let's Encrypt 경로가
박혀 있었고, 클론한 새 서버에서는 그 디렉토리가 없어 `nginx -t` 가 실패했습니다.
그 실패는 화면에 *"설정이 틀렸다"* 로 보여서, 원인이 남의 장비 이름이라는 것을
알아채기까지 오래 걸립니다.

그래서 **비워 두는 것이 정상**이고, 비면 [site/settings.ini](../site/README.md) 의
`tls_mode` 에서 경로가 파생됩니다.

| `tls_mode` | 서버 인증서 |
|---|---|
| `private` | `<cert_dir>/server/server.crt` · `server.key` (`generate_certs.sh`) |
| `public` | `/etc/letsencrypt/live/<site.host>/fullchain.pem` · `privkey.pem` |
| `auto` (기본) | 그 이름으로 발급받은 것이 있으면 `public`, 없으면 `private` |

`site/settings.ini` 는 커밋되지 않으므로 **장비별 값이 커밋되는 파일에 박히지
않습니다.**

#### `auto` 는 `renewal/` 로 판정합니다

`live/` 를 보지 **않습니다.** 거기는 `0700 root` 라 sudo 없이 읽을 수 없고, 이
생성기는 `--check` 로 sudo 없이 도는 경로가 있습니다. 파일 유무로 갈랐다면 같은
장비가 **sudo 로 돌릴 때와 아닐 때 다른 판정**을 내게 됩니다.

그 옆의 `/etc/letsencrypt/renewal/<이름>.conf` 는 `0755` 라 누구나 읽고, 그
파일이 있다는 것은 곧 *certbot 이 이 이름으로 발급해 갱신까지 걸어 두었다* 는
뜻입니다 — 알고 싶은 것이 정확히 그것입니다.

#### 어느 쪽으로 갈렸는지는 매번 보고합니다

조용히 사설 CA 로 떨어지는 것이 가장 나쁘기 때문입니다 — 서버는 멀쩡히 뜨고
브라우저만 경고를 내므로, 앱이 안 붙는다는 신고가 올 때까지 아무도 모릅니다.

```
  --      서버 인증서 사설 CA — …/cert/server/server.crt
            auto — c-test.rtc.example.test 로 발급받은 공인 인증서가 없습니다
  ok      서버 인증서 공인 — /etc/letsencrypt/live/…/fullchain.pem
            auto — certbot 이 … 로 발급해 두었습니다
```

사설 CA 판정은 `problem` 이 아니라 `skip` 입니다. LAN 전용 배치에서는 그것이
옳은 선택이라 마법사를 막지 않습니다 ([check-contract.md](../docs/check-contract.md)).

#### 직접 적으면 그것이 이깁니다

파생이 맞지 않는 장비를 위한 탈출구입니다. **다만 둘 중 하나만 적지 마세요** —
공인 인증서에 사설 개인키가 짝지어져 nginx 가 `key values mismatch` 로 거절합니다.
생성기가 그 상태를 미리 잡습니다.

```ini
cert_file = /etc/letsencrypt/live/<이 장비의 host>/fullchain.pem
key_file  = /etc/letsencrypt/live/<이 장비의 host>/privkey.pem
```

`ssl_client_certificate`(mTLS) 는 이것과 **직교**합니다. 내미는 인증서가
공인이어도 클라이언트를 검증하는 CA 는 사설 그대로입니다 — 검증하는 쪽이
다르기 때문입니다.

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

### ⚠️ 단말이 늘 때는 `generate_certs.sh` 를 다시 돌리지 않습니다

이 스크립트는 **CA 부터 새로 만듭니다.** 다시 돌리면 이미 배포한 단말의 인증서가
전부 무효가 되고, 되돌리려면 그 단말들을 하나씩 다시 방문해야 합니다. CA 개인키는
"다시 만들면 되는 것" 이 아니라 **따로 백업해야 하는 자산**입니다.

단말을 더할 때는 `generate_client_certificates.sh` 를 씁니다. **이미 있는 CA 로
서명만** 하므로 CA·서버 인증서는 그대로입니다.

```bash
./generate_client_certificates.sh wallpad-102          # cert/client/wallpad-102/
./generate_client_certificates.sh --days 730 intercom-3f
./generate_client_certificates.sh --p12-password 'secret' android-app
```

| | 산출물 |
|---|---|
| 웹 · Electron | `<name>.crt` `<name>.key` `<name>.pem` |
| Android | `<name>.p12` + `ca.crt` |
| iOS | `<name>.p12` + `ca.cer` (DER — 구성 프로파일이 이 형식을 요구합니다) |

**서버 쪽은 손댈 것이 없습니다.** `client_ca` 가 그 CA 를 이미 가리키고 있으므로
새 단말의 인증서는 reload 없이 그대로 검증됩니다.

CA 가 없으면 스크립트가 멈춥니다. **없다고 새로 만들지 않는 것이 의도**입니다 —
nginx 가 검증에 쓰는 CA 와 갈라지면 단말은 인증서를 가졌는데 서버가 거절하는
상태가 되고, 그 실패는 TLS 단계에서 나므로 앱 로그에 아무것도 남지 않습니다.

`.p12` 비밀번호는 기본이 빈 값입니다. 빈 비밀번호를 거부하는 단말이 있으므로,
그럴 때는 `--p12-password` 로 다시 발급합니다.

### `private` 배치 — CA 배포가 절차의 일부입니다

공인 인증서는 앱이 **OS 신뢰 저장소로** 검증하므로 서버 쪽만 갖추면 끝납니다.
사설 CA 는 그렇지 않습니다 — **단말마다 그 CA 를 심어야** 하고, 심기 전에는
`tls_mode = private` 인 서버에 아무 앱도 붙지 못합니다. 그 절차가 빠지면
"서버는 다 됐는데 앱만 안 붙는" 상태가 됩니다.

#### 무엇을 어디로 보내나

```
nginx/cert/
├── ca/ca.crt                    ← 이것을 단말에 심는다 (공개. 보내도 된다)
├── ca/ca.key                    ← ⚠️ 절대 내보내지 않는다
├── server/server.crt · .key     ← 서버만 씁니다
└── client/<단말>/               ← generate_client_certificates.sh 가 만든다
```

| 대상 | 보낼 것 | 어떻게 |
|---|---|---|
| 브라우저 (관리 화면) | `ca/ca.crt` | OS·브라우저의 신뢰할 수 있는 루트에 등록 |
| Android 앱 | `ca.crt` | `res/xml/network_security_config.xml` 에 넣고 앱에 **빌드해 넣습니다** |
| iOS 앱 | `ca.cer` (DER) | 구성 프로파일로 설치 + *설정 → 일반 → 정보 → 인증서 신뢰 설정* 에서 **손으로 켜야** 합니다 |
| Electron | `ca.crt` | `https.Agent` 의 `ca` 로 읽습니다 |

`generate_client_certificates.sh` 가 만드는 번들에 `ca.crt` 와 `ca.cer` 이 함께
들어 있습니다 — mTLS 를 쓰지 않더라도 **CA 를 배포하려고** 그 명령을 쓸 수 있습니다.

#### ⚠️ 개인키를 함께 보내지 마세요

`cert/` 를 통째로 압축해 보내면 **CA 개인키(`ca/ca.key`)가 딸려 갑니다.** 그것이
새면 누구나 이 단지의 이름으로 인증서를 만들 수 있고, 되돌리려면 CA 를 새로 만들어
**이미 배포한 단말을 전부 다시 방문**해야 합니다. 보낼 것은 `ca.crt`(공개 인증서)와
그 단말의 번들뿐입니다.

같은 이유로 CA 개인키는 **따로 백업해야 하는 자산**입니다. 잃어버리면 기존 단말과
같은 CA 로는 다시 발급할 수 없습니다.

#### 이 길의 한계 — 스토어 앱에는 사실상 못 씁니다

| | 왜 |
|---|---|
| iOS | ATS 아래서 사용자가 프로파일을 깔고 신뢰를 **손으로 켜야** 합니다 |
| Android | API 24+ 부터 앱은 자기가 선언한 CA 만 씁니다. 사용자가 설치한 CA 를 앱이 기본으로 믿지 않습니다 |
| 단지 증가 | CA 를 앱에 심으면 단지가 늘 때마다 **앱 업데이트 + 스토어 심사** 가 따라옵니다 |
| CA 교체 | 키를 바꾸려면 다시 스토어 심사이고, 그동안 구버전 앱은 전부 끊깁니다 |

그래서 `private` 는 **LAN 전용 설치와 개발기의 자리**입니다. 스토어로 배포되는
앱이 붙어야 하는 배치라면 [공인 인증서](public_ca/README.md)로 가세요.

> **mTLS 는 이 제약을 받지 않습니다.** 클라이언트 인증서는 앱이 *믿어야* 하는
> 것이 아니라 *가지고만* 있으면 되는 자격 증명이라, Keychain·KeyStore 에 넣고
> 제시하는 것으로 끝이고 사용자 개입이 없습니다.

#### 잊히지 않습니다

사설 CA 로 도는 동안 `public_ca/cert-status.sh` 는 계속 `warn` 을 냅니다
(`kind = private-ca`). 대시보드 TLS 카드에 남아 이관이 안 끝났음을 알립니다.
**이것은 고장 신호가 아니라 미완료 표시입니다** — LAN 전용 설치에서는 그대로
두어도 됩니다.

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
