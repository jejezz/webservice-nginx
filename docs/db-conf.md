# `db-conf/` — 서비스가 선언하는 데이터베이스

`nginx-conf/` 가 "어떤 경로로 들어온다", `pm2-conf/` 가 "어떻게 띄운다"를
선언한다면, `db-conf/` 는 "어떤 DB 가 필요하다"를 선언합니다. 셋 다 서비스
디렉토리 안에 있어서, 서비스를 옮기거나 지울 때 선언이 함께 따라갑니다.

```
services/<서비스>/db-conf/database.ini
```

`database/setup_mariadb.sh` 가 중앙 `database.ini` 를 적용한 **다음에**
`services/*/db-conf/*.ini` 를 훑어 DB 와 전용 계정을 만듭니다. 이 저장소 밖에
자기 저장소를 가진 plug-in 서비스(예: `apartment-mgmt-server-node`)가
`database/database.ini` 를 손대지 않고도 DB 를 갖는 통로입니다.

> 폴더 안에 `.ini` 가 여러 개여도 됩니다 — 한 서비스 디렉토리가 DB 를
> 여럿 쓸 때 씁니다. 스캔은 `services/*/db-conf/` **한 단계만** 합니다.

## `[database]`

```ini
[database]
name = apartment_management_db
```

| 키 | 기본값 | 설명 |
|---|---|---|
| `name` | — (필수) | DB 이름. 영문/숫자/밑줄만 — **하이픈을 쓸 수 없습니다.** `apartment-mgmt-server-node` 디렉터리가 `apartment_management_db` 스키마가 되는 식입니다 (`websocket-relay` ↔ `rtc_relay` 와 같은 이유) |
| `charset` / `collation` | `database.ini` 의 `[server]` 값 | 보통 생략합니다 |
| `schema_dir` | — | `*.sql` 을 이름순으로 실행할 디렉토리. **이 ini 파일이 있는 서비스 디렉토리 기준 상대 경로**입니다 (`pm2-conf` 의 `cwd` 와 같은 규칙). 생략하면 앱이 기동 시 스스로 테이블을 만든다고 보고 DB 와 계정만 만듭니다 |
| `user` | `name` 과 같은 값 | 이 DB 전용 계정 이름 |
| `host` | `localhost, 127.0.0.1` | 그 계정이 붙을 수 있는 호스트. 쉼표로 여러 개 (`database/README.md` 의 host 규칙과 같습니다) |

## 왜 계정을 자동으로 만들어도 되는가

`database.ini` 의 `[user:...]` 는 `databases = a, b, c` 처럼 **사람이 범위를
정해서** 여러 DB 에 걸쳐 권한을 줍니다. 그 범위를 넓히는 것(공용 계정에 DB
하나를 더 추가하는 것)이 이 저장소에서 가장 위험한 조작이라, 손으로만
합니다.

`db-conf` 로 만드는 계정은 다릅니다 — **이 스캔이 만든 DB 정확히 하나에만**
`ALL` 권한을 갖습니다. 범위가 이미 스캔 시점에 고정돼 있어서, 그 이상 넓어질
방법이 없습니다. 그래서 사람이 매번 grant 문을 확인하지 않아도 안전하게
자동화할 수 있습니다. 비밀번호는 `database/secrets/<user>.pw` 에 새로
만들어 저장합니다 (이미 있으면 그대로 씁니다) — `database.ini` 의 계정과
같은 자리, 같은 규칙입니다.

## 붙인 뒤 확인

```bash
sudo ./database/setup_mariadb.sh --dry-run   # 무엇이 만들어질지만 본다
sudo ./database/setup_mariadb.sh             # 적용
```

"서비스 선언 데이터베이스 (db-conf)" 단계에 그 DB 와 계정이 나오면 붙은
것입니다. 앱의 `.env` (또는 그에 상응하는 설정)는 이 계정으로 접속하도록
`DB_USER` / `DB_PASSWORD` (→ `database/secrets/<user>.pw`) / `DB_NAME` 을
맞춰야 합니다 — 소스에 비밀번호를 하드코딩해 두면 이 계정을 새로 발급하는
의미가 없습니다.

## 서비스가 이 저장소 안에 같이 살면

`manager`·`kamailio`·`janus`·`websocket-relay` 처럼 이 저장소에 이력째
들어와 있는 서비스는 지금처럼 중앙 `database/database.ini` 의
`[database:...]` + `[user:...]` 를 씁니다 — 공용 계정(`jyahn`)을 여럿이
같이 쓰는 게 자연스럽고, 그 계정의 권한 범위는 사람이 계속 들여다봐야 하기
때문입니다. `db-conf` 는 **이 저장소 밖에 자기 저장소를 가진** 서비스를
위한 것입니다 ([adding-a-service.md](adding-a-service.md)).
