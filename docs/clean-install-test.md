# 깨끗한 장비에서 처음부터 끝까지 — 재현성 시험 절차

**이 문서의 목적은 하나입니다.** git 에서 클론한 사람이 이 저장소만으로 지금
돌고 있는 것과 같은 상태에 도달할 수 있는가를 **증명하는 것**입니다.

이미 설치된 장비에서는 증명할 수 없습니다. 무엇을 돌려도 "이미 돼 있어서
통과한 것" 과 구분되지 않기 때문입니다. 그래서 빈 장비가 필요합니다.

기록을 남기는 것까지가 이 절차입니다 — 맨 끝의 표를 채우면 그 자체가 증거가
됩니다. **막힌 자리는 실패가 아니라 이 시험의 결과물입니다.** 그 자리가 곧
다음에 고칠 곳입니다.

---

## 0. 무엇을 준비하나

### 환경 고르기

| | 되나 | 왜 |
|---|---|---|
| **VM (권장)** | ✅ | systemd·커널 모듈·UDP 포트가 실제와 같다. Multipass·VirtualBox·KVM 아무거나 |
| **LXD 컨테이너** | ✅ | systemd 가 돈다. VM 보다 가볍다. `lxc launch ubuntu:22.04` |
| **Docker** | ⚠️ 권하지 않음 | systemd 가 없다. Kamailio·Janus·nginx 가 전부 systemd 유닛이다 |
| 실제 여분 장비 | ✅ | 가장 정확하지만 되돌리기 어렵다 |

**Ubuntu 22.04** 를 쓰세요. 이 저장소가 그 위에서 만들어졌습니다 —
MariaDB 10.6, Kamailio 5.5.4(패키지), Janus 는 `/opt/janus` 소스 빌드입니다.

### 자원

Janus 를 소스에서 빌드하므로 넉넉해야 합니다.

- CPU 2코어 이상 · RAM 4GB 이상 · 디스크 20GB 이상
- 인터넷 (apt · npm · Janus 소스)

### 만들기 (LXD 예)

```bash
lxc launch ubuntu:22.04 relay-test
lxc exec relay-test -- bash
```

VM 이라면 SSH 로 들어가면 됩니다.

---

## 1. 밑바닥 (장비 안에서)

```bash
sudo apt update
sudo apt install -y git curl nodejs npm
node --version        # v20 이상이어야 합니다
```

> ⚠️ Ubuntu 22.04 의 기본 `nodejs` 는 **v12** 입니다. 그대로 두면 릴레이가 뜨지
> 않습니다(`fetch`·`AbortSignal.timeout` 을 씁니다). NodeSource 나 nvm 으로
> 20 이상을 넣으세요.
>
> ```bash
> curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
> sudo apt install -y nodejs
> ```

---

## 2. 한 줄

```bash
git clone <이 저장소> webservices
cd webservices
./bootstrap.sh
```

**여기서 볼 것**

- 도구 확인이 전부 ✓ 인가 (node 20 이상 포함)
- `pm2 가 없습니다` 가 나오면 안내대로 `./pm2/install_pm2.sh install` 을 돌리고
  `./bootstrap.sh` 를 다시 (여러 번 돌려도 안전합니다)
- 마지막에 **마법사 주소**가 나오는가

### 브라우저로 들어가기

manager 는 `127.0.0.1:28084` 에만 붙습니다. 밖에서 바로 열리지 않습니다.

```bash
# 시험 장비 밖(내 PC)에서
ssh -L 28084:127.0.0.1:28084 <시험장비>
lxc exec relay-test -- ... 를 쓴다면 lxc 의 proxy 장치로 뚫어도 됩니다
```

그다음 브라우저로 `http://127.0.0.1:28084/manager/setup`.
관리자 콘솔(로그인 화면의 설정 버튼)은 **`zoomon`** 과 `bootstrap.sh` 에서 정한
비밀번호로 들어갑니다. **기본 비밀번호는 없습니다.**

---

## 3. 마법사 19단계

**마법사는 sudo 를 부르지 않습니다.** sudo 가 필요한 단계는 명령을 보여 주기만
하고, 사람이 터미널에서 실행합니다. 그러니 브라우저와 터미널을 나란히 두세요.

각 단계에서 확인할 것은 셋뿐입니다.

1. **왜 하는지** 설명이 이해되는가 (안 되면 그 문구가 고칠 대상입니다)
2. 명령을 그대로 복사해 돌렸을 때 **끝나는가**
3. 점검이 **초록**으로 바뀌는가 (안 바뀌면 그 점검의 문구가 다음에 무엇을
   해야 하는지 말해 주는가)

| # | 단계 | sudo | 여기서 특히 볼 것 |
|---|---|---|---|
| 1 | 사이트 값 | — | `host`·`complex_id`·`sip_domain`. 시험 장비에는 진짜 도메인이 없으므로 아무 이름이나(예: `c-test0001.rtc.example.test`) 넣고, **그 값이 뒤에서 어떻게 쓰이는지** 봅니다 |
| 2 | MariaDB | ✅ | `sudo database/setup_mariadb.sh`. 비밀번호 파일이 생기는지 |
| 3 | pm2 | ✅ | 부팅 등록(`pm2 startup`)까지 되는지 |
| 4~5 | Kamailio | ✅ | 패키지 설치 → 설정 포크 설치. `sip_domain` 이 1단계 값에서 오는지 |
| 6 | SIP 계정 (인터폰) | ✅ | **여기는 사람이 정합니다.** 시험에서는 건너뛰어도 됩니다 (인터폰이 없으므로) |
| 7~8 | Janus 빌드 | ✅ | **가장 오래 걸립니다** (수 분~십수 분). `configure` 요약에 SIP plugin·REST transport 가 yes 인지 |
| 9 | Janus 설정 | ✅ | `token_auth` 가 켜지는지 |
| 10 | Janus 대시보드 | — | 빌드 |
| 11 | nginx 라우트 | ✅ | 사설 CA 인증서가 만들어지고 라우트가 반영되는지 |
| 12 | websocket-relay | — | `npm run setup` 이 `.env` 를 만들고, 스키마 9개가 적용되는지 |
| 13 | **시험 통화** | — | `ensure-test-accounts.sh` → `verify-call.sh --run`. **여기까지 오면 핵심은 다 된 것입니다** |
| 14 | 외부 브라우저 (선택) | ✅ | 공인 IP 가 없으면 건너뜁니다 |
| 15 | 착신 푸시 (선택) | ✅ | FCM 키가 필요합니다 (아래 참고) |
| 16~19 | 공인 인증서 (선택) | ✅ | **시험 장비에서는 안 됩니다** (아래 참고) |

### 13단계가 이 시험의 합격선입니다

`verify-call.sh --run` 이 5-1~5-4 를 전부 통과하면, **브라우저 ↔ Janus ↔
Kamailio ↔ rtpproxy 경로가 실제로 소리를 나른다**는 뜻입니다. 협상만이 아니라
RTP 패킷 수까지 셉니다.

```
5-1 등록  →  ok
5-2 발신·수락  →  ok
5-3 미디어  →  ok — 양방향 수신 (A ...pkt / B ...pkt)
5-4 끊기 / 재발신  →  ok
5단계: 통과
```

---

## 4. 시험 장비에서 **안 되는 것** (실패가 아닙니다)

| 무엇 | 왜 | 시험에서는 |
|---|---|---|
| 공인 인증서 (16~19) | 실재하는 도메인과 그 존의 A 레코드, 그리고 인터넷에서 80 포트로 닿는 것이 필요합니다 | 건너뜁니다. 사설 CA 로 TLS 는 이미 돕니다 |
| 착신 푸시 (15) | Firebase 서비스 계정 키가 필요합니다 | 키가 있으면 대시보드에서 올려 보고, 없으면 건너뜁니다 |
| 외부 브라우저 (14) | 공인 IP 와 포트 포워딩 | 건너뜁니다 |
| 인터폰 착신 | 실제 SIP 장비 | 13단계의 브라우저↔브라우저 통화로 대신합니다 |
| 앱 등록 | 실제 안드로이드 단말과 FCM | 릴레이의 REST 로 흉내 낼 수 있습니다 (`docs/client-migration.md` 의 '확인하는 법') |

---

## 5. 끝났는지 확인 — 점검을 한 줄씩

마법사 밖에서도 같은 판정을 볼 수 있습니다. 전부 초록이면 재현된 것입니다.

```bash
./site/apply.sh                          # 사이트 값
./database/check-database.sh             # DB·스키마
node ./pm2/ecosystem.config.js --check   # pm2 선언
./services/kamailio/check-accounts.sh    # SIP 계정
./services/kamailio/check-push.sh        # 착신 네 자리
./services/janus/install.sh              # Janus 설정·토큰
./services/janus/verify-call.sh          # 마지막 시험 통화 결과
./services/websocket-relay/check-relay.sh
./nginx/install_nginx_stack.sh --check
```

---

## 6. 기록 (이 표를 채우세요)

시험한 사람·날짜·환경을 적고, 단계마다 결과를 남깁니다. **막힌 자리에는 그때
화면에 나온 문구를 그대로** 붙여 주세요 — 그것이 다음에 고칠 문장입니다.

```
시험자:            날짜:            환경: (LXD/VM/실장비, Ubuntu __)
node:              pm2:             총 소요:
```

| # | 단계 | 결과 (ok/막힘/건너뜀) | 걸린 시간 | 막혔다면 화면에 나온 말 |
|---|---|---|---|---|
| 0 | 밑바닥 (node 20) | | | |
| 1 | `./bootstrap.sh` | | | |
| 2 | 마법사 접속 | | | |
| 3 | 사이트 값 | | | |
| 4 | MariaDB | | | |
| 5 | pm2 | | | |
| 6 | Kamailio | | | |
| 7 | Janus 빌드 | | | |
| 8 | Janus 설정 | | | |
| 9 | nginx | | | |
| 10 | websocket-relay | | | |
| 11 | **시험 통화** | | | |
| 12 | 점검 한 줄씩 (5절) | | | |

### 합격 기준

- **필수**: 1~13단계가 끝나고 `verify-call.sh --run` 이 통과
- **문서 기준**: 막힌 자리마다 **화면이 다음에 무엇을 할지 알려 주었는가**.
  알려 주지 못한 자리가 진짜 결함입니다 — 명령이 틀린 것보다 나쁩니다

---

## 7. 정리

```bash
lxc delete --force relay-test        # LXD
# VM 이면 스냅샷으로 되돌리거나 삭제
```

시험 전에 **스냅샷을 찍어 두면** 중간부터 다시 할 수 있습니다. Janus 빌드가
길기 때문에, 7~8단계 직후에 하나 찍어 두는 것을 권합니다.
