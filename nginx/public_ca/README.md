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
├── cert/                    사설 CA 가 만든 파일들 (git 제외)
├── generate_certs.sh        사설 CA 발급          ← 개발용
└── public_ca/
    ├── README.md            이 문서
    ├── setup_letsencrypt.sh 공인 인증서 발급      ← 배포용
    └── cert-status.sh       지금 무엇을 내밀고 있나
```

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

### 1. 점검 — 아무것도 바꾸지 않습니다

```bash
./setup_letsencrypt.sh --check www.zoomon.art
```

DNS·80 포트·webroot·certbot 넷을 봅니다. **여기서 막히는 것을 먼저 없애세요.**
실제 실패의 대부분이 이 넷입니다.

### 2. 시험 발급

```bash
./setup_letsencrypt.sh --staging www.zoomon.art
```

**staging 을 건너뛰지 마세요.** Let's Encrypt 는 같은 이름 조합에 **주 5건**
제한이 있고, 설정을 더듬다 보면 놀랄 만큼 빨리 소진됩니다. 한 번 걸리면
일주일을 기다려야 합니다. staging 에는 이 제한이 사실상 없습니다.

staging 인증서는 **브라우저가 믿지 않습니다.** nginx 에 물리지 마세요.

이름을 `<도메인>-staging` 으로 따로 줍니다. 같은 이름이면 `--prod` 로 넘어갈 때
certbot 이 같은 계보를 갱신하려 들어 먼저 지워야 하는데, 나눠 두면 그냥 됩니다.

### 3. 실제 발급

```bash
./setup_letsencrypt.sh --prod -m <메일주소> www.zoomon.art
```

`-m` 은 만료 알림을 받을 주소입니다. 없으면 **자동 갱신이 조용히 멈춘 것을
인증서가 만료된 뒤에야** 알게 됩니다.

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
./cert-status.sh
```

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
