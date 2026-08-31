# 공인 인증서 — Let's Encrypt

앱이 **아무것도 미리 심지 않고** 이 서버를 믿게 만드는 것이 목적입니다.

관련: [../README.md](../README.md) · [../../services/websocket-relay/docs/multi-complex.md](../../services/websocket-relay/docs/multi-complex.md)

## 왜 이 디렉토리가 nginx/ 아래인가

[최상위 README](../../README.md) 의 경계표가 `nginx/` 를 **"TLS·listen 포트 등
서버 수준 설정, 인증서"** 로 정해 두었습니다. 공인 인증서는 새로운 역할이
아니라 **nginx 가 인증서를 얻는 방법**이라 그 안에 둡니다.

바로 옆의 [../generate_certs.sh](../generate_certs.sh) 가 사설 CA 로 같은 자리를
채웁니다. 둘은 같은 일을 하는 두 가지 방법이고, 배포용은 이쪽입니다.

**인증서 파일은 이 저장소에 없습니다.** certbot 이 `/etc/letsencrypt/` 에 두고
스스로 갱신합니다. 여기 있는 것은 받아오는 절차와 점검뿐입니다.

```
nginx/
├── cert/                     사설 CA 가 만든 파일들 (git 제외)
├── generate_certs.sh         사설 CA 발급          ← 개발용
└── public_ca/
    ├── README.md             이 문서
    ├── settings-schema.json  받을 값의 정의 (도메인·알림 메일)
    ├── settings.ini          이 장비의 값 (git 제외)
    ├── setup_letsencrypt.sh  공인 인증서 발급      ← 배포용
    ├── cert-status.sh        지금 무엇을 내밀고 있나
    ├── renew-status.sh       90일 갱신이 돌 준비가 됐나
    └── check-dns.sh          이름이 아직 이 서버를 가리키나
```

넷 다 `--check --json` 으로 구축 마법사가 읽는 판정을 냅니다
([check-contract.md](../../docs/check-contract.md)). 아래 '구축 마법사에서' 를
보세요.

## 무엇이 달라지나

| | 지금 (사설 CA) | 뒤 (공인) |
|---|---|---|
| 앱이 서버를 믿는 법 | CA 를 앱에 심어야 함 | 시스템 신뢰 저장소 그대로 |
| 단지가 늘면 | 단지마다 CA 운영 | 단지마다 인증서 하나. CA 는 없음 |
| 앱 코드 | 커스텀 TrustManager·hostnameVerifier | **전부 삭제** |
| 갱신 | 1년마다 손으로 | 90일마다 certbot 이 알아서 |

앱 쪽이 핵심입니다. `ANDROID_API_GUIDE.md` 의 SSL 설정 코드가 통째로 없어지고,
`hostname == "jejezzhome.iptime.org"` 처럼 박아 둔 검사도 같이 사라집니다.

> **클라이언트 인증서(mTLS)는 이것과 별개입니다.** 공인 CA 는 "서버가 진짜인가"
> 만 해결합니다. "접속한 기기가 진짜인가" 는 사설 CA 가 계속 맡습니다 —
> nginx 에서 `ssl_certificate`(내미는 것)와 `ssl_client_certificate`(검증하는
> 것)는 애초에 다른 지시자이고 같은 뿌리에서 나올 필요가 없습니다.
>
> 오히려 공인 인증서가 mTLS 를 **가능하게** 만듭니다. 신뢰할 수 있는 통로가
> 생겨야 그 통로로 단말 인증서를 안전하게 내려보낼 수 있기 때문입니다.

## 사전 조건

**1. 소유한 도메인.** DDNS 이름(`*.iptime.org`)으로는 안 됩니다 — 그 존의
레코드를 만들 권한이 없습니다.

**2. A 레코드가 이 서버를 가리킬 것.** 등록기관에서 만듭니다.

```bash
curl -s ifconfig.me          # 이 서버의 공인 IP
dig +short A <도메인>         # 같은 값이 나와야 한다
```

**3. 외부 80 포트가 열려 있을 것.** Let's Encrypt 의 HTTP-01 검증은 **반드시
80 번으로** 들어오고 포트를 지정할 수 없습니다. 28080 같은 포워딩으로는 안
됩니다.

> 80 을 열 수 없다면(CGNAT 등) HTTP-01 은 불가능합니다. DNS-01 로 가야 하고,
> 그때는 DNS 를 API 로 제어할 수 있어야 합니다.

## 절차

### 0. 도메인을 정합니다

도메인과 알림 메일은 **`settings.ini` 에서 읽습니다** — 장비·단지마다 다른
값이기 때문입니다 ([settings-contract.md](../../docs/settings-contract.md)).
구축 마법사의 폼이 이 파일을 쓰고, 손으로 적어도 됩니다.

```ini
domain = c-a3f19c04.rtc.zoomon.art
email  = you@example.com
```

아래 명령들은 전부 이 값을 씁니다. 인자로 주면 그쪽이 이깁니다.

### 1. 점검 — 아무것도 바꾸지 않습니다

```bash
./setup_letsencrypt.sh --check
```

DNS·80 포트·webroot·certbot 넷을 봅니다. **여기서 막히는 것을 먼저 없애세요.**
실제 실패의 대부분이 이 넷입니다.

### 2. 시험 발급

```bash
sudo ./setup_letsencrypt.sh --staging
```

**staging 을 건너뛰지 마세요.** Let's Encrypt 는 같은 이름 조합에 **주 5건**
제한이 있고, 설정을 더듬다 보면 놀랄 만큼 빨리 소진됩니다. 한 번 걸리면
일주일을 기다려야 합니다. staging 에는 이 제한이 사실상 없습니다.

staging 인증서는 **브라우저가 믿지 않습니다.** nginx 에 물리지 마세요.

이름을 `<도메인>-staging` 으로 따로 줍니다. 같은 이름이면 `--prod` 로 넘어갈 때
certbot 이 같은 계보를 갱신하려 들어 먼저 지워야 하는데, 나눠 두면 그냥 됩니다.

### 3. 실제 발급

```bash
sudo ./setup_letsencrypt.sh --prod
```

만료 알림 주소는 `settings.ini` 의 `email` 입니다. 없으면 **자동 갱신이 조용히
멈춘 것을 인증서가 만료된 뒤에야** 알게 됩니다.

성공하면 무엇을 발급했는지 `.applied-settings` 에 남깁니다. 저장한 값과 그것이
어긋나면 점검이 "아직 반영되지 않았습니다" 로 말합니다.

### 4. nginx 에 물리기

`../nginx-stack.conf` 의 `[tls]` 를 바꿉니다.

```ini
cert_file = /etc/letsencrypt/live/<도메인>/fullchain.pem
key_file  = /etc/letsencrypt/live/<도메인>/privkey.pem
```

> **`cert.pem` 이 아니라 `fullchain.pem` 입니다.** 중간 인증서가 빠지면 브라우저는
> 멀쩡한데 일부 안드로이드 기기에서만 실패하는, 찾기 아주 어려운 버그가 납니다.

경로가 절대경로여도 됩니다 — 생성기가 `os.path.join` 으로 조립하는데 오른쪽이
절대경로면 `cert_dir` 을 무시합니다. **생성기는 고칠 필요가 없습니다.**

```bash
sudo ../install_nginx_stack.sh --skip-install
```

`nginx -t` 로 먼저 검사하고 실패하면 reload 하지 않습니다.

### 5. 확인

```bash
./cert-status.sh      # 지금 무엇이 나가고 있나
./renew-status.sh     # 90일 뒤에도 나갈 것인가
```

## 구축 마법사에서

같은 절차가 `/manager/setup` 에 **네 단계**로 들어가 있습니다
([setup-wizard.md](../../docs/setup-wizard.md)). 터미널에서 하든 화면에서 하든
판정은 같은 스크립트가 냅니다 — 마법사는 새 지식을 만들지 않습니다.

| 단계 | 무엇을 묻나 | 점검 |
|---|---|---|
| `public_ca.issue` | 발급받았나 (그 전에 DNS·80 포트·webroot 가 준비됐나) | `setup_letsencrypt.sh --check --json` |
| `public_ca.nginx` | 발급받은 것을 **실제로 내밀고 있나** | `cert-status.sh --check --json` |
| `public_ca.renew` | 90일 뒤에도 내밀 것인가 | `renew-status.sh --check --json` |
| `public_ca.dns` | 이름이 아직 이 서버를 가리키나 | `check-dns.sh --check --json` |

`public_ca.issue` 는 `nginx.routes` 다음입니다. HTTP-01 챌린지는 반드시 80 으로
들어오는데 80 은 전부 HTTPS 로 301 하므로, 그 예외(`acme_webroot`)를 만드는
라우트 반영이 먼저 끝나 있어야 합니다. 뒤집으면 챌린지가 301 로 튕깁니다.

### 네 단계 다 '선택' 입니다

LAN 전용 설치는 사설 CA 로 계속 도는 것이 옳고, 공인 이름을 받을 수 없는
배치(도메인이 없거나 80 을 열 수 없는 경우)도 있기 때문입니다. **배포용에서는
넷 다 해야 합니다.**

안 끝났다는 사실이 잊히지는 않습니다 — 대시보드의 TLS 카드가 사설 CA 를 계속
`warn` 으로 두기 때문입니다 (아래 '대시보드에서 보기').

### 점검은 sudo 없이 돕니다

마법사는 sudo 를 부르지 않습니다. 그래서 점검 경로에 `run_root` 가 하나도
없어야 하는데, 두 군데가 걸렸습니다.

**80 포트 확인.** 예전에는 webroot 에 파일을 하나 넣고 200 이 오는지 봤습니다.
그 자리는 `root:www-data` 라 쓰려면 root 여야 합니다. 지금은 **없는 이름**을
부르고 404 가 오는지 봅니다 — 생성기가 만드는 예외 블록이 `try_files $uri =404`
라, 없는 이름의 정답이 404 입니다. 확인하려던 셋을 그대로 다 확인합니다.

| 응답 | 뜻 |
|---|---|
| `404` | 바깥에서 80 으로 들어왔고, 평문으로 응답했고, 예외 location 이 살아 있다 |
| `301` | 예외가 아직 반영되지 않았다 (`install_nginx_stack.sh --skip-install`) |
| 연결 실패 | 외부 80 이 닫혔다 |

**발급됐는지 확인.** `/etc/letsencrypt/live/` 는 `0700 root` 라 못 읽습니다.
대신 `/etc/letsencrypt/renewal/<이름>.conf` 를 읽습니다 — 그 디렉토리는 `0755`,
파일은 `0644` 이고, **발급의 결과로만 생깁니다.** 갱신 훅이 걸렸는지도 같은
파일에 적혀 있습니다.

## ⚠️ 유동 IP — 사람이 고쳐야 합니다

이 회선은 **유동 IP** 인데 A 레코드는 등록기관에 **고정값**으로 들어 있습니다.
예전에는 공유기의 DDNS 가 따라갔지만 그 이름은 삭제됐습니다. **지금은 자동으로
따라가는 장치가 없습니다.**

IP 가 바뀌면 고칠 때까지 이렇게 됩니다:

| | 언제 |
|---|---|
| 앱이 디렉터리 주소로 못 붙음 | **즉시, 전면** |
| SIP·Janus 의 ICE 후보 주소가 틀어짐 | 즉시 |
| certbot 갱신 실패 | 만료 30일 전부터 조용히 |

첫째가 즉시 터지니 알아차리기는 합니다. 문제는 **왜인지 모른다**는 것입니다.

```bash
./check-dns.sh          # 인증서의 이름이 아직 이 서버를 가리키나
```

manager 대시보드의 TLS 카드에도 같은 판단이 나옵니다. 어긋나면 `critical` 이고,
고칠 IP 를 함께 보여 줍니다.

크론에 걸어 두면 사람보다 먼저 압니다:

```
*/10 * * * * /home/jejezz/Public/webservices/nginx/public_ca/check-dns.sh --quiet || echo "DNS 가 이 서버를 가리키지 않습니다" | logger -t dns-drift
```

TTL 이 600초라 고치면 10분 안에 퍼집니다.

> **근본 해결은 DNS 를 API 로 고칠 수 있게 만드는 것입니다.** 가비아는 네임서버만
> 옮기면 되고(`zoomon.art` 는 메일도 웹도 없어 위험이 없습니다), 그러면 IP 가
> 바뀔 때 스크립트가 레코드를 갱신할 수 있습니다. 나중에 `ptype.co.kr` 을
> `_acme-challenge` 위임으로 붙일 때도 같은 것이 필요합니다.

## 되돌아가는 길 — 승격과 강등

`tls_mode` 는 한 번 정하고 끝나는 값이 아닙니다. 도메인이 생기면 올라가고,
갱신이 계속 실패하면 내려와야 합니다. **강등 경로를 미리 적어 두지 않으면
만료 당일에 처음 고민하게 됩니다.**

### 승격 — `private` → `public`

도메인이 생겼을 때입니다.

```bash
# 1. 이름을 정합니다 (site/settings.ini). 마법사 1단계의 폼도 같은 자리입니다.
#      host = c-<단지id>.rtc.<도메인>
# 2. A 레코드를 이 서버로 맞춥니다. 그다음 확인:
./check-dns.sh

# 3. 갈 수 있는 장비인지 봅니다
../tls-decide.sh

# 4. 발급 — staging 을 건너뛰지 마세요
./setup_letsencrypt.sh --check
sudo ./setup_letsencrypt.sh --staging
sudo ./setup_letsencrypt.sh --prod

# 5. 반영. tls_mode 가 auto 면 경로는 저절로 잡힙니다.
sudo ../install_nginx_stack.sh --skip-install
./cert-status.sh
```

`tls_mode` 를 손댈 필요가 **없습니다.** `auto` 로 두면 4번이 끝나는 순간
`renewal/<host>.conf` 가 생겨 판정이 `public` 으로 바뀝니다.

> 이미 사설 CA 로 단말을 배포했다면, 그 단말들은 공인 인증서도 **그대로
> 받아들입니다** — CA 를 심어 둔 것은 신뢰를 *더한* 것이지 다른 것을 막지
> 않습니다. 앱에 커스텀 `TrustManager` 를 넣어 **사설 CA 만** 믿게 해 두었다면
> 그 코드를 먼저 걷어내야 합니다.

### 강등 — `public` → `private`

**갱신이 계속 실패해 만료가 임박했을 때**입니다. 대개 원인은 A 레코드가 이 서버를
가리키지 않는 것(유동 IP)이거나 80 이 막힌 것입니다.

먼저 **강등이 정말 필요한지** 가릅니다. certbot 은 만료 30일 전부터 하루 두 번
시도하므로 기회가 60번쯤 있습니다 — 하루 이틀 어긋나는 것은 흡수됩니다.

```bash
./cert-status.sh        # daysLeft 와 kind
./check-dns.sh          # 이름이 아직 이 서버를 가리키나
sudo certbot renew --dry-run
```

`daysLeft < 7` 이고 갱신 시도가 계속 실패하면 강등합니다.

```bash
# 1. 사설 인증서가 있는지 확인하고, 없으면 만듭니다
ls ../cert/server/server.crt || ../generate_certs.sh --auto <host>

# 2. site/settings.ini
#      tls_mode = private          ← auto 로 두면 renewal/ 이 남아 있어 public 으로 갑니다
# 3. 반영
sudo ../install_nginx_stack.sh --skip-install
./cert-status.sh                   # kind = private-ca, status = warn
```

**`auto` 로 두면 안 됩니다.** 만료된 인증서라도 `renewal/<host>.conf` 는 그대로
남아 있어 판정이 계속 `public` 입니다. 강등은 **명시적으로** 못박아야 합니다.

#### 무엇을 잃나

| | |
|---|---|
| 스토어 앱 | **끊깁니다.** 사설 CA 를 믿게 만들 방법이 사실상 없습니다 |
| 브라우저 | 경고를 넘기면 들어갑니다 — **관리 화면은 삽니다** |
| LAN 내부 통화 | 영향 없습니다 |
| mTLS | 영향 없습니다 — 클라이언트 CA 는 원래 사설이라 그대로입니다 |

강등은 **관리 화면을 살려 두기 위한 것**이지 서비스를 살리는 것이 아닙니다.
앱이 붙어야 하는 배치라면 강등이 아니라 **원인(A 레코드·80 포트)을 고치는 것**이
답입니다.

#### 되올라갈 때

원인을 고친 뒤 위의 '승격' 을 그대로 밟되, `tls_mode` 를 `auto` 나 `public` 으로
**되돌리는 것을 잊지 마세요.** 못박아 둔 `private` 가 남아 있으면 발급이 성공해도
계속 사설을 내밉니다 — 그리고 그 상태는 `cert-status.sh` 의 `warn` 하나로만
보입니다.

## 갱신은 어떻게 도나

certbot 을 설치하면 **자기 systemd 타이머를 같이 깝니다.** 유닛을 쓸 필요가
없습니다.

```bash
systemctl list-timers certbot.timer
```

하루 두 번 깨어나 만료 30일 전이면 갱신합니다. `setup_letsencrypt.sh` 가
발급할 때 이 훅을 함께 걸어 둡니다:

```
--deploy-hook "systemctl reload nginx"
```

**이게 없으면 certbot 이 조용히 갱신해 두어도 nginx 는 메모리에 올린 옛 인증서를
계속 내밉니다.** 파일은 최신인데 접속은 만료로 끊기는, 원인을 찾기 어려운
상태가 됩니다. `cert-status.sh` 가 파일이 아니라 **실제 접속해서** 인증서를
읽는 이유가 이것입니다.

훅이 실제로 걸렸는지는 `renew-status.sh` 가 봅니다.

```bash
./renew-status.sh
```

90일 뒤에 조용히 끊기는 길이 셋 있고, 셋 다 **터지기 전에는 아무 증상이
없습니다.** 그래서 만료를 기다리지 않고 지금 물어봅니다.

| 보는 것 | 없으면 |
|---|---|
| `certbot.timer` 가 활성·부팅 등록 | 갱신 자체가 안 돈다 |
| 갱신 훅 (`renew_hook`) | 갱신은 되는데 nginx 가 옛것을 계속 내민다 |
| 만료까지 남은 날 | 30일 아래로 한참 내려왔으면 갱신이 실패하고 있다 |
| 마지막 시도의 종료 코드 | 왜 실패했는지 (`journalctl -u certbot.service`) |

만료가 30일 아래인 것 자체는 문제가 아닙니다 — certbot 이 거기서부터 갱신을
시작하니까요. **20일 아래**로 내려왔다면 열흘 넘게 시도해서 다 실패했다는
뜻이라, 그때부터 대기로 봅니다.

## 단지가 여러 개일 때

단지마다 이름 하나, 인증서 하나입니다.

```
c-a3f19c04.rtc.<도메인>      단지 A
c-7b2e9f13.rtc.<도메인>      단지 B
```

**와일드카드 하나로 묶지 마세요.** 편해 보이지만:

- 같은 개인키가 모든 단지에 복사됩니다. 한 곳이 털리면 전부 무너집니다.
- 90일마다 새 인증서를 전 단지에 안전하게 실어 나르는 파이프라인을 직접
  만들어 운영해야 합니다. **자동으로 도는 갱신을 수동 배포로 바꾸는 셈**입니다.
- 와일드카드는 HTTP-01 로 못 받습니다. DNS-01 이 필수입니다.

단지마다 받으면 개인키가 그 단지 밖으로 나가지 않고, 갱신은 각자 알아서 합니다.

## 막히는 곳

| 증상 | 원인 | 할 일 |
|---|---|---|
| 챌린지 경로가 `301` | 80 포트가 전부 HTTPS 로 넘어감 | `[tls] acme_webroot` 를 채우고 설정 반영 |
| `Connection refused` | 외부 80 이 닫힘 | 공유기 포워딩. 안 되면 DNS-01 로 |
| `NXDOMAIN` / 다른 IP | A 레코드 없음·오래됨 | 등록기관에서 수정. DDNS 면 갱신 확인 |
| `too many certificates` | rate limit 소진 | 일주일 대기. 다음부터 `--staging` 먼저 |
| 브라우저가 거부 | staging 인증서를 물림 | `--prod` 로 다시 받기 |
| 갱신됐는데 만료로 나옴 | `--deploy-hook` 누락 | `sudo certbot renew --force-renewal` 후 재설정 |

## 대시보드에서 보기

`cert-status.sh --json` 이 manager 대시보드가 그대로 쓸 수 있는 형태를 냅니다.

```json
{ "status": "warn", "kind": "private-ca", "daysLeft": 349, "renewTimer": "absent" }
```

**`sudo` 가 필요 없습니다.** `/etc/letsencrypt/live/` 는 `0700 root` 라 파일로는
못 읽지만, 로컬 TLS 포트에 붙어 제시되는 인증서를 읽으면 권한이 필요 없습니다.
manager 의 `services/nginx.js` 가 `systemctl` 을 읽기 전용으로만 쓰는 것과 같은
방식입니다.

`kind` 로 상태가 갈립니다:

| `kind` | `status` | 뜻 |
|---|---|---|
| `letsencrypt` | ok | 정상. 타이머가 꺼져 있으면 warn |
| `private-ca` | warn | 아직 이관 전 |
| `letsencrypt-staging` | critical | **시험 인증서가 배포에 물림** |

`private-ca` 를 warn 으로 둔 것은 의도적입니다 — 이관이 안 끝났다는 사실이
대시보드에 계속 남아 있게 합니다.

## 결정 기록

| 정한 것 | 이유 |
|---|---|
| `nginx/public_ca/` 에 둠 | README 경계표에서 인증서는 `nginx/` 의 몫 |
| 인증서를 저장소에 두지 않음 | certbot 이 `/etc/letsencrypt` 에서 소유·갱신 |
| systemd (pm2 아님) | 상주 프로세스가 아니고 root 가 필요. nginx 도 systemd |
| 단지마다 인증서 | 개인키가 이동하지 않음. 갱신이 각자 자동 |
| staging 을 거침 | 주 5건 제한. 한 번 걸리면 일주일 |
| 파일이 아니라 접속해서 확인 | 권한 불필요. reload 안 된 상태가 드러남 |
| `private-ca` 를 warn 으로 | 이관이 안 끝난 것을 잊지 않도록 |
| 도메인을 `settings.ini` 로 | 단지마다 다른 값. 화면과 스크립트가 같은 것을 읽어야 한다 |
| 마법사에서 네 단계 다 선택 | LAN 전용·도메인 없는 배치가 실재한다. 잊히는 것은 TLS 카드가 막는다 |
| 80 포트를 404 로 확인 | 점검은 sudo 없이 돌아야 한다. 404 도 같은 셋을 확인한다 |
| 발급 여부를 `renewal/*.conf` 로 | `live/` 는 0700 root. 발급의 결과로만 생기는 0644 파일이 그 옆에 있다 |
| 갱신을 따로 본다 (`renew-status.sh`) | 지금 멀쩡한 것과 90일 뒤 멀쩡한 것은 다르다 |
