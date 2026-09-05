# coturn — 설치·운영·문제 해결

셀룰러 데이터를 쓰는 모바일이 Janus 의 WebRTC 미디어를 받을 수 있게 하는
TURN/STUN 서버입니다. Janus 의 `nat_1_1_mapping`(정적 1:1 매핑)은 LAN·같은
단지 WiFi 단말에는 충분하지만, 통신사 CGNAT 뒤의 모바일은 그것만으로 뚫리지
않습니다 — 무엇을 어떻게 확인했는지는 **[docs/plan.md](docs/plan.md)** 에
있습니다.

| | |
|---|---|
| 처음 세운다 | [설치](#설치) 를 0 부터 순서대로 |
| 이미 세워져 있다 | [운영](#운영) |
| 안 된다 | [문제 해결](#문제-해결) |
| 왜 이렇게 되어 있나 | [배경](#배경) |

```
설치 순서 (자세한 것은 아래 표)

  0 사전 조건(Janus) → 1 장비 값(settings.ini) → 2 설정 · 패키지 설치
    → 3 대시보드 빌드 → 4 pm2 등록 → 5 nginx 라우트(대시보드만)
    → 6 공유기 포트 포워딩 → 7 마지막 점검
```

## 이 디렉토리가 담는 것

**서비스 둘**을 담습니다. `services/kamailio/` 와 같은 구성입니다 —
apt 패키지 데몬(coturn)과 그것을 읽기만 하는 관찰용 웹입니다
([nginx-conf.md](../../docs/nginx-conf.md) 의 "폴더 안에 `.ini` 가
여러 개여도 됩니다").

| 서비스 | 무엇 | 포트 | 띄우는 주체 |
|---|---|---|---|
| `coturn` | TURN/STUN 서버 자체 | 3478(UDP/TCP) · 49160-49560(UDP 릴레이) | **systemd** (apt 패키지 유닛) |
| `coturn-dashboard` | 관찰 웹 | 28090 | **pm2** |

```
services/coturn/
├── README.md               이 문서 — 설치 순서, 운영, 문제 해결
├── docs/
│   └── plan.md             ★ 계획서 — ICE 실패 진단과 결정 사항
│
├── install.sh               ①②③ 점검 / 패키지·설정 설치 / 되돌리기   (sudo 필요한 동작만)
├── setup-dashboard.sh        대시보드 점검·빌드 (sudo 불필요) — janus/setup-dashboard.sh 와 같은 자리
├── turnserver.conf           /etc/turnserver.conf 로 설치될 원본 (자리표시자 포함)
├── settings-schema.json      장비마다 다른 값의 정의 (커밋함)
├── settings.ini              그 값 — 공인 IP · realm · 포트 범위 (커밋하지 않음)
├── secrets/                  static-auth-secret (600, 커밋 금지)
│
│   ── 규약 선언 ──
├── nginx-conf/
│   ├── service.ini          coturn            — STUN/TURN. enabled = false (프록시할 HTTP 가 없음)
│   └── dashboard.ini        coturn-dashboard  — 관찰 웹 (28090, pm2)
├── pm2-conf/
│   ├── app.ini              coturn — 껍데기. systemd(apt 유닛)가 띄운다
│   ├── dashboard.ini        coturn-dashboard — 진짜 프로세스
│   └── not-managed-by-pm2.sh
├── schema/
│   └── 000-unused.md        DB 테이블이 필요 없는 이유 (구조적 자리만 확보)
│
│   ── 대시보드 ──
├── server/                  대시보드 서버 — Node + Express
│   └── src/coturn.js          coturn 상태 읽기 (dpkg·systemctl·설정 비교, CLI 는 쓰지 않음)
└── web/                     대시보드 프런트 — React 18 + Vite + Tailwind + shadcn/ui
```

미디어 릴레이는 UDP 포트를 따로 쓰며 nginx 도 pm2 도 거치지 않습니다.
범위는 `turnserver.conf`(`settings-schema.json` 의 `relay_port_range`)가
정합니다 — Janus 의 두 범위, rtpengine/rtpproxy 범위와 겹치지 않는지
`install.sh` 가 매번 다시 확인합니다 (docs/plan.md ③ 절).

---

# 설치

| | 단계 | 명령 | 확인 |
|---|---|---|---|
| **0** | 사전 조건 — Janus | `services/janus` 가 이미 세워져 있어야 공인 IP 를 물려받습니다 | `services/janus/install.sh` |
| **1** | 이 장비의 값 | 기본값으로 충분하면 건너뛰어도 됨. 필요하면 `--init` 로 뼈대 | `./install.sh` |
| **2** | 설정 · 패키지 | `sudo ./install.sh --apply` | `systemctl status coturn` |
| **3** | 대시보드 빌드 | `./setup-dashboard.sh --build` | `./setup-dashboard.sh` |
| **4** | pm2 등록 | `cd ../../pm2 && ./restart.sh --restart` | `pm2 list` 에 `online` |
| **5** | nginx 라우트(대시보드만) | `sudo ../../nginx/install_nginx_stack.sh --skip-install` | `/coturn/dashboard` |
| **6** | 공유기 포트 포워딩 | UDP+TCP 3478, UDP 49160-49560 | 밖에서 `stun`/`turn` 진단 도구로 확인 |
| **7** | 마지막 점검 | `./install.sh` | 전부 초록 |

`./install.sh` 는 **아무것도 바꾸지 않고** 지금 어디까지 됐는지 알려 주며,
남은 것이 있으면 무엇을 해야 하는지 그대로 출력합니다.

## 0. 사전 조건 — Janus

이 서비스는 Janus 없이도 설치·기동할 수 있습니다. 다만 공인 IP 를 따로
넣지 않으면 `services/janus/settings.ini` 의 값을 물려받으므로
([docs/plan.md](docs/plan.md) ⑤ 절), Janus 가 먼저 세워져 있으면 이 값을
또 입력하지 않아도 됩니다.

## 1. 이 장비의 값 — `settings.ini`

전부 선택입니다 — 기본값(realm=`turn.local`, 릴레이 포트=`49160-49560`,
수신 포트=`3478`)만으로도 설치는 됩니다. 다만 **공인 IP 없이 설치하면
이 서비스를 만든 이유(셀룰러 모바일 NAT 통과)가 무효화됩니다** — LAN
전용으로 도는 TURN 서버는 있으나 마나입니다.

```bash
node ../../lib/settings.js --init .     # services/coturn 에서 (sudo 불필요)
```

| 키 | 없으면 | 무엇이 바뀌나 |
|---|---|---|
| `public_ip` | `services/janus/settings.ini` 의 값을 물려받음 (그것도 없으면 LAN 전용) | `turnserver.conf` 의 `external-ip=<공인IP>/<사설IP>` |
| `realm` | `site/settings.ini` 의 `host`, 그것도 없으면 `turn.local` | `turnserver.conf` 의 `realm=` |
| `relay_port_range` | `49160-49560` | `turnserver.conf` 의 `min-port`·`max-port` |
| `listening_port` | `3478` | `turnserver.conf` 의 `listening-port=` |
| `dashboard_port` | `28092` | `setup-dashboard.sh` 의 점검이 읽는 값. **`install.sh --apply` 가 반영하지 않습니다** — 실제로 그 포트에서 뜨려면 `nginx-conf/dashboard.ini` 의 `ports` 와 `pm2-conf/dashboard.ini` 의 `PORT` 도 손으로 같은 값으로 맞춰야 합니다 |

`static_auth_secret` 은 여기 없습니다 — 사람이 입력하는 값이 아니라
`install.sh --apply` 가 자동으로 만듭니다 (아래 2 단계).

## 2. 설정 · 패키지 설치 — `install.sh --apply`

```bash
./install.sh                      # 상태 점검 (sudo 불필요, apt/systemctl 건드리지 않음)
sudo ./install.sh --apply         # coturn 패키지 설치 + 설정 적용 + 기동. 실패하면 자동 롤백
sudo ./install.sh --apply -y      # 확인 없이 진행
```

이 스크립트는 Kamailio 와 달리 **패키지 설치까지 함께 합니다** — coturn 은
"패키지 하나 + 설정 파일 하나" 로 끝나는 단순한 구성이라, Kamailio 처럼
`bootstrap.sh` 를 따로 두는 이득이 작다고 판단했습니다. 점검(기본 모드)
에서는 `dpkg` 상태만 보고 `apt` 는 건드리지 않습니다.

`--apply` 가 하는 일:

1. `settings.ini` 검증 (형식·포트 겹침). 실패하면 아무것도 건드리지 않음
2. `coturn` 패키지가 없으면 `apt-get install`
3. `secrets/static-auth-secret` 이 없으면 생성 (있으면 그대로 씀)
4. 기존 `/etc/turnserver.conf` 백업 후, 이 저장소의 원본에 값을 채워 설치
5. `/etc/default/coturn` 의 `TURNSERVER_ENABLED` 를 `1` 로 (배포판 기본은 꺼짐)
6. `systemctl enable --now coturn` — 실패하면 백업으로 되돌리고 저널을 보여줌
7. 성공했을 때만 `.applied-settings` 에 설치한 값을 남김

## 3. 대시보드 빌드

```bash
./setup-dashboard.sh --build   # server/web 의존성 설치 + 프런트 빌드 + 점검까지
./setup-dashboard.sh           # 점검만 (sudo 불필요, 아무것도 바꾸지 않음)
./setup-dashboard.sh --json    # 구축 마법사·점검 규약 형식 (docs/check-contract.md)
```

janus·kamailio 와 같은 자리의 스크립트입니다 — 다만 이 대시보드는 janus.js
같은 외부 클라이언트 라이브러리를 받아 올 일도, 특별한 그룹 권한도 없어서
의존성·빌드·프로세스·`/health` 만 봅니다.

`node_modules/` 와 `web/dist/` 는 커밋하지 않으므로 이 저장소를 처음 받은
곳에서는 반드시 한 번 돌려야 합니다. 빠뜨리면 4 단계에서 화면이 대시보드
경로에 503 을 냅니다 (`/health` 는 정상이며 `details.dashboardBuilt` 가
`false` 로 알려 줍니다) — `setup-dashboard.sh` 가 바로 그 항목을 짚어 줍니다.

## 4. pm2 등록

```bash
cd ../../pm2 && ./restart.sh --restart
```

`coturn-dashboard` 만 올라옵니다. coturn 본체는 pm2 대상이 아닙니다 —
`pm2-conf/app.ini` 는 껍데기이고 `enabled = false` 입니다.

## 5. nginx 라우트 — 대시보드만

```bash
../../nginx/install_nginx_stack.sh --check              # 선언 검사 (sudo 불필요)
sudo ../../nginx/install_nginx_stack.sh --skip-install  # 반영
```

| 라우트 | 어디로 |
|---|---|
| `/coturn/` | 127.0.0.1:28090 — 대시보드 |

**coturn 자체는 nginx 라우트가 없습니다.** STUN/TURN 은 HTTP 가 아니라
UDP/TCP 로 클라이언트가 직접 여는 프로토콜이라 리버스 프록시로 앞에 세울
수 있는 대상이 아닙니다 (`nginx-conf/service.ini` 의 주석 참고). 모바일
앱은 이 서버의 3478 포트로 **직접** 붙습니다.

## 6. 공유기 포트 포워딩

이 장비는 공인 IP 를 직접 갖지 않습니다(`ip -4 addr show` 로 확인 —
`10.10.0.224` 하나뿐). Janus 와 같은 공유기 뒤에 있으므로 포워딩을 추가로
열어야 합니다 — **Janus 의 WebRTC 포워딩과는 다른 범위**입니다.

| 프로토콜 | 포트 | 용도 |
|---|---|---|
| UDP + TCP | `3478`(기본, `listening_port`) | STUN/TURN 수신 |
| UDP | `49160-49560`(기본, `relay_port_range`) | 릴레이된 미디어 |

`sudo ./install.sh --apply` 끝에 지금 설치된 값 그대로 이 안내가 다시 나옵니다.

## 7. 마지막 점검

```bash
./install.sh                     # 패키지 · 설정 · 기동 · 배포 설정
```

전부 초록이면 coturn 자체는 준비된 것입니다. **하지만 이것으로 끝이
아닙니다** — Janus 와 모바일 앱이 아직 이 TURN 서버를 전혀 쓰지 않습니다.
[docs/plan.md](docs/plan.md) 의 "아직 안 한 일" 을 보세요.

---

# 운영

## 대시보드

`https://<서버>/coturn/dashboard`

manager 로그인 하나로 들어갑니다. 화면은 **개요 · 설정 · 로그** 셋입니다.

coturn 을 **읽기만 합니다.** 재시작하거나 설정을 바꾸지 않습니다 — 그건
`install.sh` 가 sudo 로 하는 일입니다 (`kamailio-dashboard` 와 같은 자세).
활성 세션·릴레이 할당 개수는 어디에도 없습니다 — coturn 의 관리 CLI 를
이 배치에서는 껐기 때문입니다 (`turnserver.conf` 의 `no-cli`,
[docs/plan.md](docs/plan.md) ⑥ 절).

## 로그

이 서비스는 pm2 가 아니라 **apt 패키지의 systemd 유닛**이 띄우므로
`pm2 logs` 에 나오지 않습니다. 대시보드의 **로그** 탭이 저널을 그대로
보여 줍니다.

```bash
journalctl -u coturn -f            # coturn 본체
pm2 logs coturn-dashboard          # 대시보드
```

## 설정을 바꿀 때

`settings.ini` 를 고친 뒤 다시 설치합니다. `--apply` 는 언제 다시
실행해도 됩니다 (검사 실패 시 자동 롤백).

```bash
sudo ./install.sh --apply
```

## 되돌리기

```bash
sudo ./install.sh --remove        # 설정을 걷어내고 TURNSERVER_ENABLED 를 다시 끔 (패키지는 남긴다)
sudo apt remove coturn            # 패키지까지 지우려면 (사람이 직접 판단)
```

`secrets/` 는 남깁니다 — 다시 설치할 때 같은 `static-auth-secret` 으로
자격 증명 계산이 이어지게 하기 위해서입니다.

---

# 문제 해결

| 증상 | 항목 |
|---|---|
| 기동하지 않음 | [T-1](#t-1-기동하지-않음) |
| "설치본이 저장소와 다름"이 계속 뜸 | [T-2](#t-2-설치본이-저장소와-다름이-계속-뜸) |
| 대시보드가 pm2 에서 `errored` — `MODULE_NOT_FOUND` | [T-3](#t-3-대시보드가-pm2-에서-errored--module_not_found) |
| 공인 IP 경고가 계속 뜸 | [T-4](#t-4-공인-ip-경고가-계속-뜸) |
| 포트 범위 충돌 | [T-5](#t-5-포트-범위-충돌) |
| 셀룰러에서 여전히 통화가 안 됨 | [T-6](#t-6-셀룰러에서-여전히-통화가-안-됨) |

## T-1. 기동하지 않음

```bash
journalctl -u coturn -n 40 --no-pager
./install.sh                       # 설치본이 저장소와 같은가 · 무엇이 빠졌는가
```

`--apply` 는 검사에 실패하면 **자동으로 되돌립니다.** "적용했는데 옛
설정으로 돌고 있다" 면 롤백된 것입니다 — 저널에 이유가 남아 있습니다.

## T-2. "설치본이 저장소와 다름"이 계속 뜸

`--apply` 를 잊었거나, `/etc/turnserver.conf` 를 손으로 고친 것입니다.
비밀·자리표시자가 채워지는 줄은 비교에서 이미 제외되므로 (`install.sh` 의
`report_config_diff` 호출), 그 밖의 줄이 다르다는 뜻입니다.

```bash
sudo ./install.sh --apply
```

## T-3. 대시보드가 pm2 에서 `errored` — `MODULE_NOT_FOUND`

3 단계(대시보드 빌드)를 건너뛴 것입니다. `web/dist` 뿐 아니라
`server/node_modules` 도 커밋하지 않으므로, 저장소를 처음 받은 장비에서는
둘 다 준비해야 합니다. `./setup-dashboard.sh` 로 무엇이 빠졌는지 먼저 보고,
`--build` 로 한 번에 채우세요.

```bash
./setup-dashboard.sh --build
cd ../../pm2 && ./restart.sh --restart
```

## T-4. 공인 IP 경고가 계속 뜸

`public_ip` 가 이 서비스에도, `services/janus/settings.ini` 에도 없다는
뜻입니다. Janus 가 아직 안 세워졌거나, 둘 다 LAN 전용으로 두기로 한
것입니다. 후자라면 경고는 정상입니다 — 이 TURN 서버는 LAN 안에서는 애초에
필요 없습니다.

## T-5. 포트 범위 충돌

```
relay_port_range(49160-49560) 가 Janus WebRTC(20000-20200) 와 겹칩니다
```

이런 문구가 나오면 `settings.ini` 의 `relay_port_range` 를 겹치지 않는
대역으로 옮기고 다시 `--apply` 하세요. `install.sh` 는 Janus 의 두 범위와
rtpengine/rtpproxy 범위를 **매번 실물에서 읽어** 비교합니다
([docs/plan.md](docs/plan.md) ③ 절).

## T-6. 셀룰러에서 여전히 통화가 안 됨

**coturn 이 떠 있는 것과 실제로 쓰이는 것은 다릅니다.** 이 저장소는 아직
Janus 와 모바일 앱을 이 TURN 서버에 연결하지 않았습니다 —
[docs/plan.md](docs/plan.md) 의 "아직 안 한 일" 을 확인하세요. 그 작업이
끝나기 전까지는 coturn 을 세운 것만으로 증상이 사라지지 않습니다.

---

# 배경

## 왜 apt 패키지인가 — Kamailio 와 같은 자리

coturn 은 Debian/Ubuntu 표준 패키지(`apt install coturn`)이고, 배포판이
자기 systemd 유닛을 함께 설치합니다. Janus 는 소스 빌드라 유닛까지
우리가 소유하지만, coturn 은 Kamailio 와 정확히 같은 상황입니다 — 우리는
`/etc/turnserver.conf` 와 활성화 플래그(`/etc/default/coturn`)만
소유하고, 유닛 자체는 건드리지 않습니다.

## 관련 문서

- 계획서(ICE 실패 진단·결정 사항) → [docs/plan.md](docs/plan.md)
- 라우팅 선언 스키마 → [docs/nginx-conf.md](../../docs/nginx-conf.md)
- 프로세스 선언 스키마 → [docs/pm2-conf.md](../../docs/pm2-conf.md)
- 장비별 값 규약 → [docs/settings-contract.md](../../docs/settings-contract.md)
- 점검 출력 규약 → [docs/check-contract.md](../../docs/check-contract.md)
- `/health` 규약 → [docs/health-contract.md](../../docs/health-contract.md)
- WebRTC 게이트웨이 → [services/janus/README.md](../janus/README.md)
- SIP 서버 → [services/kamailio/README.md](../kamailio/README.md)
