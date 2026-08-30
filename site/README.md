# 사이트 값

여러 서비스가 **함께 쓰는** 설정입니다. 항목 정의는 `settings-schema.json` 에
있고, 값은 `settings.ini` 에 있습니다(커밋하지 않습니다).

```bash
./site/apply.sh            # 지금 상태
./site/apply.sh --apply    # 반영 (릴레이 재시작 · sudo 불필요)
```

구축 마법사의 **첫 단계**이기도 합니다 — `/manager/setup` 에서 입력할 수 있습니다.

## 왜 서비스 위에 층이 하나 더 있나

설정 규약([../docs/settings-contract.md](../docs/settings-contract.md))의 단위는
서비스 하나였습니다. 그래서 여럿이 공유하는 값을 둘 자리가 없었고, 각자 자기
파일에 베껴 적었습니다.

그 대가를 실제로 치렀습니다. 앱에게 알려 줄 Janus 주소가 릴레이 `.env` 에는
개발용 호스트로, 진짜 주소는 `tools/directory.json` 에 따로 적혀 있었습니다.
둘이 어긋나도 서버는 멀쩡히 돌고 로그도 조용했습니다 — 단말에서 이름이 풀리지
않아 통화가 안 된다는 것을 앱 쪽에서 알려 줄 때까지 몰랐습니다.

`sip_domain` 도 같은 병입니다. `kamctlrc` 와 릴레이 `.env` 두 곳에 있고, 문서에
*"같아야 한다"* 고 적어 둔 것이 곧 증상입니다.

## 무엇을 여기 두나

**둘 이상이 쓰는 값만** 둡니다. 한 서비스만 쓰는 것은 그 서비스의
`settings.ini` 에 그대로 둡니다 (janus 의 미디어 포트 범위 같은 것).

| 값 | 지금 쓰는 곳 |
|---|---|
| `host` | websocket-relay 가 앱에게 알려 줄 Janus 주소(`wss://<host>/janus-ws`) |
| `complex_id` | websocket-relay 의 단지 검사 |
| `sip_domain` | websocket-relay 의 SIP 계정 발급 |

아직 옮기지 않은 것들입니다. 각 서비스의 `install.sh` 가 이 값을 읽게 하면
됩니다 — 한 번에 하지 않고 하나씩 옮깁니다.

| 값 | 지금 있는 곳 |
|---|---|
| nginx `server_name` · Let's Encrypt 도메인 | `nginx/public_ca/settings.ini` |
| Kamailio `SIP_DOMAIN` | `/etc/kamailio/kamctlrc` |
| `tools/directory.json` 의 `host` | 손으로 적음 (지금은 대조만 합니다) |
| Janus `public_ip` | `services/janus/settings.ini` |

## `.env` 가 이깁니다

사이트 값은 서비스 설정이 **비어 있을 때만** 쓰입니다. 한 장비만 다르게 두어야
하는 경우(개발기)를 막지 않기 위해서입니다. 대신 덮고 있으면 `npm run doctor`
가 그 사실을 말해 줍니다 — 조용히 어긋나는 것이 원래 문제였으니까요.

## 왜 DB 가 아닌가

nginx · Kamailio · Janus 셋은 systemd 가 띄우고 **시작할 때 파일을 읽습니다.**
DB 를 읽을 방법이 없습니다. DB 에 두면 결국 "DB 를 읽어 설정 파일을 만드는
도구" 가 필요한데, 그건 이미 각 서비스의 `install.sh` 가 하는 일입니다. 게다가
DB 자체가 설정된 대상이라(`database/database.ini`) 설정의 출처가 설정을
필요로 하게 됩니다.

DB 는 **런타임 상태**를 맡습니다 — 등록된 단말·SIP 계정·승인 대기. 지금도 그렇게
쓰고 있고, 그 경계가 맞습니다.
