# nginx

리버스 프록시의 **서버 수준 설정**과 설치 스크립트를 담습니다.
nginx 프로세스 자체는 systemd가 관리합니다 (80/443 바인딩에 root가 필요해서).

**라우팅은 여기에 없습니다.** 각 서비스가 자기 디렉토리의
`nginx-conf/service.ini` 에 포트와 경로를 선언하고, 이 디렉토리의 생성기가
그것을 모아 `/etc/nginx/conf.d/path-routing.conf` 를 만듭니다.
스키마는 [../docs/nginx-conf.md](../docs/nginx-conf.md) 입니다.

## 파일

| 파일 | 역할 |
|---|---|
| `install_nginx_stack.sh` | **주 진입점.** 설정 생성 + 인증서 배치 + reload |
| `generate_nginx_conf.py` | `services/*/nginx-conf/*.ini` → location/upstream 블록 |
| `nginx-stack.conf` | listen 포트, TLS, max_body 등 서버 수준 값 |
| `nginx/server.conf.template` | 생성될 설정의 골격 |
| `certs/` | 인증서 원본 (`cert.pem`, `key.pem`) |
| `generate_all_certificates.sh` | 사설 CA·서버 인증서 생성 |
| `generate_client_certificates.sh` | 클라이언트 인증서 (안드로이드·electron용) |

## 자주 쓰는 명령

라우팅 선언을 바꾼 뒤 반영합니다. **sudo 가 필요합니다** (`/etc/nginx/` 에 씁니다).

```bash
sudo ./install_nginx_stack.sh --skip-install
```

반영 전에 선언만 검사합니다. 포트나 location 이 겹치면 설정을 쓰지 않고
종료하므로, 잘못된 선언이 nginx까지 가지 않습니다. sudo가 필요 없습니다.

```bash
./install_nginx_stack.sh --check
```

무엇이 바뀔지 미리 봅니다.

```bash
./install_nginx_stack.sh --dry-run
```

| 플래그 | 뜻 |
|---|---|
| `--check` | 파싱·충돌 검사만. 아무것도 쓰지 않음 |
| `--dry-run` | 실행할 동작을 출력만 |
| `--skip-install` | apt 설치 단계를 건너뜀 (이미 설치된 서버에서 상시 사용) |
| `--skip-reload` | 설정만 쓰고 reload 하지 않음 |

## 인증서

`nginx-stack.conf` 의 `[tls]` 가 원본 위치를 정합니다.

```ini
[tls]
cert_dir=./certs      # 이 디렉토리 기준 상대 경로
cert_file=cert.pem
key_file=key.pem
```

설치 스크립트가 이 원본을 `/etc/nginx/certs/server.crt` 와 `server.key` 로
복사하고, 생성된 설정이 그 복사본을 가리킵니다. **원본을 갈아 끼운 뒤에는
스크립트를 다시 돌려야** 반영됩니다.

현재 인증서는 사설 CA(`Apartment Complex CA`)가 발급했고 이름은 다음과 같습니다.

```
CN  = callfusion.ptype.co.kr
SAN = DNS:callfusion.ptype.co.kr, IP:10.10.0.224
```

도메인과 IP 양쪽으로 접속해도 이름은 맞지만, **CA가 설치되지 않은 PC에서는
브라우저가 경고를 띄웁니다.** 그 상태에서는 크롬이 비밀번호 저장 제안도 하지
않으므로, 접속하는 PC에 `certs/ca_cert.pem` 을 신뢰 저장소로 등록해 두는 편이
좋습니다.

> 참고: 모든 서비스가 이 하나의 오리진(`https://<호스트>`) 아래 경로로 갈립니다.
> 브라우저 비밀번호 관리자는 **오리진 단위**로 저장하고 경로를 구분하지 않아서,
> 서로 다른 서비스의 로그인 정보가 한 바구니에 섞입니다. 서비스별로 분리하려면
> 서브도메인(`manager.…`, `cassini.…`)을 주고 인증서 SAN 과 `server_name` 을
> 나눠야 합니다.

## 구조를 바꿀 때

`nginx-stack.conf` 는 **서버 수준 값만** 담습니다. location 이나 upstream 을
여기에 직접 적지 마세요 — 생성기가 덮어씁니다. 경로를 바꾸려면 그 서비스의
`nginx-conf/service.ini` 를 고칩니다.

새 서비스를 붙이는 절차는 [../docs/nginx-conf.md](../docs/nginx-conf.md) 의
`서비스를 새로 붙일 때` 에 있습니다.

## 재부팅

nginx 는 systemd 가 띄웁니다. 확인:

```bash
systemctl is-enabled nginx && systemctl is-active nginx
```

예전에는 crontab 의 `@reboot` 로 `install_nginx_stack.sh` 를 돌렸지만 지금은
필요 없습니다. 그 줄이 남아 있다면 지우세요
([../pm2/README.md](../pm2/README.md) 의 `지금 crontab 고치기` 참고).

## 지난 문서

`SESSION_HANDOFF.md` 와 `documents/` 아래 문서들은 **이 구조가 만들어지기 전**
(얼굴인식 서버 앞에만 nginx 를 두던 시절)의 기록입니다. 지금 구조와 맞지 않으니
작업 지침으로 쓰지 마세요.

특히 `documents/automation-script-usage.md` 가 설명하는 `run_nginx_stack.py` 는
**앱 인스턴스를 직접 띄웁니다.** 지금은 프로세스 기동이 pm2 담당이라
이 스크립트를 쓰면 pm2 가 관리하는 프로세스와 충돌합니다.
