# Node.js 20 이상 설치하기

`bootstrap.sh` 가 **node 20 이상**을 요구하는데 22.04 의 배포판 기본값은
`12.22.9` 입니다. 24.04 도 `18` 이라 모자랍니다. **어느 OS 든 배포판 패키지만으로는
안 됩니다.** 이 문서는 그 한 칸을 채우는 방법입니다.

## 왜 20 인가

`services/*/server` 의 릴레이가 `fetch` 와 `AbortSignal.timeout` 을 씁니다. 둘 다
node 18~20 에서 안정화된 전역이라, 그 아래에서는 설치도 되고 `npm install` 도
지나간 다음 **띄우는 순간** `fetch is not defined` 로 죽습니다. 그래서
`bootstrap.sh` 가 버전을 미리 막습니다 — 늦게 드러날수록 원인을 찾기 어렵습니다.

## 어느 길로 갈까 — NodeSource

| | NodeSource (apt) | nvm |
|---|---|---|
| 설치 위치 | `/usr/bin/node` — 시스템 전역 | `~/.nvm/…` — 그 사용자만 |
| 보안 업데이트 | `apt upgrade` 에 실린다 | 손으로 | 
| pm2 · systemd | **보인다** | 보이지 않을 수 있다 |

**NodeSource 를 권합니다.** 이 저장소의 서비스는 pm2 가 띄우고 pm2 는 재부팅 뒤
systemd 가 되살립니다. systemd 유닛은 로그인 셸이 아니라서 `~/.bashrc` 를 읽지
않고, nvm 은 바로 거기에 `PATH` 를 심습니다. 즉 **터미널에서는 node 20 이 보이는데
재부팅하면 서비스가 죽는** 상태가 만들어집니다 — 그것도 부팅 직후에만.

nvm 은 한 장비에서 여러 node 버전을 오가야 할 때 쓰는 도구입니다. 이 서버는
한 버전만 쓰므로 쓸 이유가 없습니다.

## 설치

```bash
sudo apt-get install -y ca-certificates curl gnupg
```

```bash
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/nodesource.gpg
```

```bash
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | sudo tee /etc/apt/sources.list.d/nodesource.list
```

```bash
sudo apt-get update && sudo apt-get install -y nodejs
```

`nodistro` 는 오타가 아닙니다. NodeSource 는 2023년부터 배포판 코드명별로 나누지
않고 하나의 배포선을 씁니다. 그래서 **22.04 와 24.04 가 같은 줄**을 씁니다.

### ⚠️ `npm` 은 따로 설치하지 마세요

`bootstrap.sh` 가 `node` 와 `npm` 을 각각 확인하기 때문에 `apt install npm` 이
필요해 보입니다. **아닙니다.** npm 은 NodeSource 의 `nodejs` 패키지 안에 이미 들어
있습니다:

```bash
dpkg -S /usr/bin/npm
```

`nodejs: /usr/bin/npm` 이라고 답합니다. 배포판 `npm` 패키지(8.5.1)를 얹으려 하면
node 12 시절의 `node-*` 의존성 수십 개를 끌고 오려다 `held broken packages` 로
**실패**합니다. 장비가 망가지지는 않지만 시간을 버립니다.

## `libnode-dev` 와 부딪히면

배포판 node 12 가 깔려 있던 장비에서는 설치가 이렇게 멈춥니다:

```
trying to overwrite '/usr/include/node/common.gypi', which is also in package libnode-dev 12.22.9~dfsg-1ubuntu3.6
```

NodeSource 패키지가 선언하는 관계를 보면 이유가 보입니다:

```bash
dpkg -s nodejs | grep -E '^(Conflicts|Replaces)'
```

```
Conflicts: nodejs-dev, nodejs-doc, nodejs-legacy, npm (<= 1.2.14)
Replaces:  nodejs-dev (<= 0.8.22), nodejs-legacy, npm (<= 1.2.14)
```

`nodejs-dev` 를 비켜 가도록 만들어져 있는데 **우분투는 그 패키지를
`libnode-dev` 로 개명했습니다.** 이름이 어긋나 `Replaces` 가 걸리지 않고, 두
패키지가 `/usr/include/node/` 를 각자 자기 것이라 주장하다 dpkg 가 멈춥니다.
NodeSource 쪽 선언이 개명을 따라오지 못한 것이라, node 12 가 깔린 22.04 라면
누구나 밟습니다.

지울 때 딸려 나가는 것이 있는지 먼저 봅니다:

```bash
sudo apt-get remove -s libnode-dev
```

보통 그 하나뿐입니다. 그러면 지우고 다시 설치합니다:

```bash
sudo apt-get remove -y libnode-dev && sudo apt-get install -y nodejs
```

> `nodejs` 를 `purge` 로 먼저 지우지 마세요. 그 장비에서 `nodejs` 에 의존하는
> 패키지가 함께 끌려 나갑니다. 부딪히는 것은 **개발 헤더 패키지**지 런타임이
> 아닙니다.

배포판 `npm` 패키지가 깔린 장비라면 `/usr/bin/npm` 에서 같은 일이 한 번 더
납니다. 위의 `Replaces: npm (<= 1.2.14)` 이 jammy 의 npm `8.5.1` 을 덮지 못하기
때문입니다. 미리 함께 확인하십시오:

```bash
dpkg -l npm libnode-dev 2>/dev/null | grep ^ii
```

앞선 시도가 dpkg 를 중간에 끊어 놓았다면 이어서 정리합니다:

```bash
sudo apt-get -f install
```

## 확인

```bash
node -v && npm -v && ./bootstrap.sh --check
```

`v20.x` 와 `10.x` 가 나오고 `bootstrap.sh --check` 의 '필요한 도구' 칸이 전부
`[ok]` 면 됩니다.

## 이 서버(22.04)의 지금 상태 — 업데이트가 오지 않습니다

이 장비는 focal 에서 jammy 로 **dist-upgrade** 되었고, 그 과정에서 apt 가 서드파티
저장소를 전부 껐습니다:

```bash
ls /etc/apt/sources.list.d/ | grep nodesource
```

`nodesource.list.distUpgrade` — 이름 끝에 `.distUpgrade` 가 붙어 apt 가 읽지
않습니다. 그래서 node `20.19.5` 가 설치된 채 **멈춰 있습니다.** 보안 업데이트가
오지 않습니다.

당장 배포판 12 로 내려가지는 않습니다 — apt 는 우선순위만으로 다운그레이드하지
않기 때문입니다. 하지만 방치할 상태는 아닙니다. 되살리려면:

```bash
sudo mv /etc/apt/sources.list.d/nodesource.list.distUpgrade /etc/apt/sources.list.d/nodesource.list
```

```bash
sudo apt-get update && apt-cache policy nodejs
```

`Candidate` 가 `deb.nodesource.com` 에서 온 20.x 인지 보고 나서 `apt upgrade` 하십시오.

> 같은 디렉토리의 다른 `.distUpgrade` 들(`google-chrome` · `ondrej-*` ·
> `deadsnakes`)은 이 저장소와 무관합니다. 함께 되살리지 마세요.

## 되돌리기

```bash
sudo apt-get remove -y nodejs && sudo rm -f /etc/apt/sources.list.d/nodesource.list /usr/share/keyrings/nodesource.gpg
```

`/etc/apt/preferences.d/nodejs` 에 NodeSource 가 만든 핀(`Pin-Priority: 600`)이
남아 있습니다. 완전히 지우려면 그 파일도 함께 지우십시오.
