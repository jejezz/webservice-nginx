# MariaDB 설치 / 설정

`database.ini` 하나로 MariaDB 서버 설정과 데이터베이스·사용자를 관리하는 도구입니다.
`nginx.ini` + `setup_nginx.sh`와 같은 방식입니다.

**장비마다 다른 세 값만 예외입니다** — `bind_address` · `port` ·
`innodb_buffer_pool_size` 는 `settings.ini` 가 갖습니다 (아래 '[server]').

```
database/
├── install_mariadb.sh     # 설치 / 업데이트 / 상태 / 제거
├── setup_mariadb.sh       # 선언 적용 (서버 설정 + DB/사용자)
├── database.ini           # 어느 장비에서나 같은 선언 (커밋한다)
├── settings-schema.json   # 장비마다 다른 [server] 값의 정의 (커밋한다)
├── settings.ini           # 그 값 — 마법사 폼이 쓴다 (커밋하지 않는다)
├── .applied-settings      # 실제로 반영한 값 (setup_mariadb.sh 가 쓴다)
├── lib_settings.sh        # 위 셋을 읽는 공용 구현
├── mariadb.cnf.template   # 서버 설정 템플릿
├── secrets/               # 생성된 비밀번호 (600, 커밋 금지)
├── backups/               # 덤프와 이전 설정 파일
└── README.md
```

## 이미 돌고 있는 것을 건드리지 않는다

이 스크립트들은 **MariaDB 가 이미 설치돼 데이터가 들어 있는 장비**에서 만들어졌습니다
(22.04 의 기본 패키지 10.6, `127.0.0.1:3306`, `kamailio` 데이터베이스 사용 중).
그래서 **기존 데이터를 건드리지 않도록** 만들어져 있습니다.

> 빈 장비에서는 아직 아무것도 없습니다. `install` 부터 시작하세요.
> 아래 성질은 그 뒤에도 그대로 유효합니다 — 여러 번 돌려도 안전하다는 뜻입니다.

- `install`은 기존 설치를 감지하면 아무것도 하지 않고 중단합니다.
- `setup`은 추가와 갱신만 하며, ini에 없는 DB나 사용자를 삭제하지 않습니다.
- 데이터를 지우는 동작은 `purge` 하나뿐이고, 정해진 문구를 그대로 입력해야 실행됩니다.

```bash
./install_mariadb.sh status        # 버전·서비스·포트
sudo ./install_mariadb.sh status   # DB 목록·크기·사용자까지
```

## 설치

```bash
./install_mariadb.sh install
```

`mariadb-server`와 `mariadb-client`를 배포판 패키지로 설치하고 서비스를 등록·시작합니다.
root 계정은 `unix_socket` 인증을 쓰므로 비밀번호 없이 `sudo mariadb`로 접속합니다.

> **더 새로운 버전이 필요하면** — Ubuntu 22.04의 기본 패키지는 10.6입니다.
> 11.x가 필요하면 MariaDB 공식 저장소를 직접 추가한 뒤 `install`을 실행하세요.
> 저장소 추가는 외부 스크립트를 받아 실행하는 과정이라 이 스크립트에 넣지 않았습니다.
> 자세한 절차는 <https://mariadb.org/download/> 의 "Repositories"를 참고하세요.

## 점검 — 무엇이 반영됐는지만 본다

`setup_mariadb.sh` 는 root 로 도는 적용 스크립트입니다. 확인만 하려면 이쪽을
쓰세요 — **sudo 가 필요 없습니다.**

```bash
./check-database.sh          # 서비스·서버 설정·계정 로그인·스키마
./check-database.sh --json   # 기계가 읽는 판정 (docs/check-contract.md)
```

접속은 공용 계정(jyahn)으로 합니다. root 소켓 인증을 쓰면 sudo 가 필요해져
구축 마법사(`/manager/setup`)에서 늘 "확인 불가" 가 되기 때문입니다.

## 업데이트

```bash
./install_mariadb.sh update
```

1. 업그레이드 대상이 있는지 확인 (없으면 바로 종료)
2. 중단이 발생함을 알리고 `yes` 확인을 받음
3. MariaDB 패키지만 업그레이드
4. 버전이 바뀌었으면 `mariadb-upgrade`로 시스템 테이블 갱신

## 설정

`database.ini`(어느 장비에서나 같은 것)와 `settings.ini`(이 장비의 값)를 수정한 뒤
적용합니다.

```bash
sudo ./setup_mariadb.sh --dry-run   # 무엇이 바뀌는지만 확인
sudo ./setup_mariadb.sh             # 실제 적용
```

| 옵션 | 설명 |
|------|------|
| `--dry-run` | 변경 사항만 출력하고 아무것도 바꾸지 않음 |
| `--yes`, `-y` | 확인 프롬프트 없이 진행 (재시작 포함) |
| `--no-restart` | 설정 파일만 쓰고 재시작하지 않음 |

수행 순서:

1. `[server]` 항목과 `settings.ini` 의 장비 값으로
   `/etc/mysql/mariadb.conf.d/99-project.cnf` 생성
2. `[security]` 항목 적용
3. `[database:*]` 생성 (이미 있으면 건너뜀)
4. `[user:*]` 생성/갱신 및 권한 부여
5. 서버 설정이 바뀐 경우에만 재시작 (확인 후)

### [server]

여기 적는 키는 **그대로 mysqld 옵션이 됩니다.** 목록에 없는 옵션도 자유롭게 추가할 수 있습니다.

```ini
[server]
character_set_server = utf8mb4
collation_server = utf8mb4_unicode_ci
max_connections = 151
slow_query_log = 1
long_query_time = 2
```

#### 장비마다 다른 값은 여기 없습니다

`bind_address` · `port` · `innodb_buffer_pool_size` 는 이 파일에 적지 않습니다.
**`database.ini` 는 커밋되는 파일**이기 때문입니다 — 장비에서 고치면 다음
`git pull` 과 부딪히고, 커밋해 버리면 한 장비의 결정이 다른 단지로 딸려 갑니다.

그래서 이 셋만 저장소의 설정 규약을 따릅니다
([docs/settings-contract.md](../docs/settings-contract.md)). `site` · `kamailio` ·
`janus` · `public_ca` 가 쓰는 것과 같은 방식입니다.

| 파일 | 누가 쓰는가 | 무엇을 뜻하는가 |
|---|---|---|
| `settings-schema.json` | 사람 (커밋) | 무엇을 받을 것인가 · 기본값 |
| `settings.ini` | 구축 마법사의 폼 · 편집기 | 이 장비가 정한 값 |
| `.applied-settings` | `setup_mariadb.sh` (root) | 실제로 반영된 값 |

값을 넣는 곳은 **구축 마법사의 DB 단계 폼**입니다. 폼을 쓰지 않는다면
`settings.ini` 를 손으로 적어도 됩니다 (`키 = 값`, 절은 쓰지 않습니다).
아무 데도 적지 않으면 `settings-schema.json` 의 기본값을 씁니다.

```ini
; database/settings.ini
bind_address = 127.0.0.1
port = 3306
innodb_buffer_pool_size = 256M
```

`bind_address`는 기본이 `127.0.0.1`(로컬 전용)입니다.

이 저장소는 단지마다 배포됩니다. 기본값이 `0.0.0.0` 이면 *"그 장비에서 열기로 정했다"*
가 아니라 *"아무도 정하지 않았다"* 가 되고, 3306 은 그 장비가 놓인 망 전체에 열린 채로
남습니다. **여는 것은 장비별 결정으로 남기고**, 열어야 하는 장비에서만 `0.0.0.0` 으로
바꾸되 방화벽으로 접근 범위를 반드시 제한하세요.

원거리에서 DB 에 닿아야 한다면 3306 을 여는 것 말고도 길이 있습니다 (아래 '원격 접속').

`innodb_buffer_pool_size`는 DB 전용 서버라면 물리 메모리의 50~70%가 일반적인 기준입니다.
이 서버는 다른 서비스와 함께 쓰므로 기본값을 256M으로 낮게 잡았습니다.

> **예전 장비에서 올라온 경우** — `database.ini` 의 `[server]` 에 이 셋이 아직
> 적혀 있으면 그 값이 그대로 쓰이고, `sudo ./setup_mariadb.sh` 가 **한 번
> `settings.ini` 로 옮겨 담습니다.** 열어 두기로 했던 3306 이 이사 중에 조용히
> 닫히지 않게 하려는 것입니다. 옮긴 뒤에는 `database.ini` 에서 그 줄을 지우세요 —
> 두 곳에 남아 있으면 점검이 알려 줍니다.

### [security]

```ini
[security]
remove_anonymous_users = true    # 익명 사용자 제거
remove_test_database = true      # 기본 test DB 제거
disallow_remote_root = true      # localhost 외의 root 계정 제거
```

`mysql_secure_installation`이 대화식으로 하는 일을 설정 파일로 대신합니다.
이미 처리된 항목은 "없음"으로 표시하고 넘어가므로 여러 번 실행해도 안전합니다.

### [database:이름]

```ini
[database:manager]
schema_dir = ../services/manager/schema
```

| 항목 | 설명 |
|------|------|
| `charset` / `collation` | 생략하면 `[server]` 값 사용 |
| `schema_dir` | 이 디렉토리의 `*.sql` 을 **이름순**으로 실행 |
| `schema_file` | 단일 파일을 실행 (`schema_dir` 뒤에 실행됨) |

**스키마 SQL은 각 서비스 디렉토리가 소유합니다.** 서비스 코드와 스키마가 같이 움직여야
확장·이동이 쉽기 때문입니다.

```
services/manager/schema/001-initial.sql
services/ws-bridge/schema/001-initial.sql
```

테이블을 추가할 때는 해당 서비스의 `schema/`에 `002-add-xxx.sql` 처럼 번호를 붙여 넣고
다시 적용하면 됩니다. 번호가 실행 순서를 고정합니다.

모든 파일은 매번 실행되므로 **여러 번 실행해도 안전하게**(`CREATE TABLE IF NOT EXISTS`,
`INSERT IGNORE`, `ALTER TABLE` 대신 새 파일) 작성해야 합니다.

`charset`/`collation`을 생략하면 `[server]` 값을 씁니다.
**이미 있는 데이터베이스의 문자셋은 바꾸지 않습니다.** 기존 데이터에 영향을 주는 변경이라 의도적으로 제외했습니다.
바꾸려면 직접 `ALTER DATABASE`를 실행하세요.

### [user:이름]

```ini
[user:appuser]
host = localhost
databases = appdb
privileges = ALL
```

| 항목 | 설명 |
|------|------|
| `host` | 접속 허용 호스트 (`localhost`, `%`, `192.168.0.%`) |
| `databases` | 권한을 줄 DB 목록, 쉼표 구분. `*`는 전체 |
| `privileges` | `ALL` 또는 `SELECT,INSERT,UPDATE,DELETE` |
| `password_env` | 비밀번호가 든 환경 변수 이름 |
| `password_file` | 비밀번호가 든 파일 경로 |

## 서비스별 스키마

서비스마다 스키마를 분리하고, 하나의 계정(`jyahn`)이 전부를 다룹니다.

| 스키마 | 서비스 | 스키마 위치 | 내용 |
|--------|--------|-------------|------|
| `manager` | Nginx manager | [services/manager/schema/](../services/manager/schema/) | `administrator`, `admin_audit_log`, `schema_migrations` |
| `ws_bridge` | ws-bridge | [services/ws-bridge/schema/](../services/ws-bridge/schema/) | `schema_migrations` (아직 저장할 데이터 미정) |
| `rtc_relay` | websocket-relay | [services/websocket-relay/schema/](../services/websocket-relay/schema/) | `rtc_mobiles`, `rtc_homenet`, `schema_migrations` |

> DB 이름에는 하이픈을 쓸 수 없어 서비스 이름 `ws-bridge`의 스키마는 `ws_bridge`입니다.

### manager 스키마

`administrator` 테이블이 관리 대시보드의 로그인 계정입니다.

| 컬럼 | 설명 |
|------|------|
| `email` | 로그인 아이디. **이메일만** 받으며 소문자로 저장 |
| `password_hash` | `scrypt$<salt>$<hash>` |
| `approved` | `1`이어야 로그인 성공. 기본 `0` |
| `requested_at` / `approved_at` / `approved_by` | 승인 이력 |
| `last_login_at` / `login_count` | 로그인 기록 |

등록되지 않은 이메일로 로그인을 시도하면 `approved=0` 행이 만들어집니다(승인 요청).
자세한 흐름과 승인 방법은 [services/manager/README.md](../services/manager/README.md)를 참고하세요.

`admin_audit_log`에는 로그인·승인·비밀번호 변경 같은 계정 사건이 남습니다.

### ws_bridge 스키마

지금은 `schema_migrations`만 있습니다. 세션 상태는 프로세스 메모리에 두는 것이 현재 설계라
DB로 옮기면 성격이 달라지므로, 필요해질 때 의도적으로 추가하도록 비워 두었습니다.
후보는 스키마 파일 주석에 적어 두었습니다.

## 공용 계정 (jyahn)

모든 서비스 스키마를 하나의 계정으로 다룹니다.

```ini
[user:jyahn]
host = 127.0.0.1
databases = manager, ws_bridge
privileges = ALL
```

이 계정 하나가 **전 서비스의 DB 에 `ALL` 권한**을 가집니다. 그만큼 닿을 수 있는 자리는
좁게 둡니다 — 서비스는 전부 같은 장비의 `127.0.0.1` 로 붙으므로 이 값으로 충분합니다.

비밀번호는 `secrets/jyahn.pw`에 있으며 바꾸려면 그 파일을 고치고 다시 적용하면 됩니다.

### 원격 접속 — 3306 을 열지 않고

출장 중에도 DB 에 닿아야 한다면, 요구는 *"원거리에서 닿는 것"* 이지 *"3306 을
인터넷에 여는 것"* 이 아닙니다. **SSH 터널**이 그 요구를 만족하면서 위의 기본값을
그대로 지킵니다.

```bash
ssh -L 3306:127.0.0.1:3306 <계정>@<서버>
```

터널은 **서버의 루프백에서 끝나므로** `bind_address = 127.0.0.1` 과 `jyahn@127.0.0.1`
을 그대로 두고도 붙습니다. MariaDB 인증이 뚫려도 SSH 한 겹이 더 남습니다.
상시 직결이 필요해지면 WireGuard 같은 VPN 으로 올립니다.

### ⚠️ 이미 `jyahn@%` 로 만들어 둔 장비

`host` 값을 바꾸는 것만으로는 좁혀지지 않습니다. `setup_mariadb.sh` 는 **추가·갱신만
하고 지우지 않으므로** 옛 계정이 그대로 남습니다. MariaDB 는 `user@host` 가 키라
`jyahn@%` 와 `jyahn@127.0.0.1` 은 **별개 계정**입니다.

```bash
sudo mariadb -e "SELECT user, host FROM mysql.user WHERE user = 'jyahn';"
sudo mariadb -e "DROP USER 'jyahn'@'%';"
```

지우기 전에 **그 계정으로 붙고 있는 것이 없는지** 확인하세요. 다른 장비에서
`jyahn@%` 로 붙고 있었다면 그쪽이 끊깁니다.

## 비밀번호

**`database.ini`에는 비밀번호를 쓰지 않습니다.** 세 가지 방법 중 하나를 씁니다.

**1. 자동 생성 (기본)** — `password_env`도 `password_file`도 없으면 32자리 비밀번호를 만들어
`secrets/<사용자>.pw`에 저장합니다. (권한 600) 이미 파일이 있으면 그 값을 그대로 씁니다.

```
secrets/appuser.pw
```

**2. 파일 지정**

```ini
[user:appuser]
password_file = ./secrets/appuser.pw
```

**3. 환경 변수**

```bash
sudo APPUSER_PASSWORD='...' ./setup_mariadb.sh
```

```ini
[user:appuser]
password_env = APPUSER_PASSWORD
```

`secrets/`와 `backups/`는 `.gitignore`에 등록되어 있습니다.

> 스크립트를 다시 실행하면 **기존 사용자의 비밀번호를 현재 값으로 다시 설정**합니다(`ALTER USER`).
> 비밀번호를 바꾸려면 `secrets/<사용자>.pw`를 수정하고 다시 실행하면 됩니다.
> 애플리케이션 쪽 접속 정보도 함께 바꿔야 합니다.

## 안전장치

설정 실수로 DB가 죽는 상황을 막기 위해 세 단계를 둡니다.

**옵션 이름 검사** — 적용 전에 `[server]`의 모든 키를 `mariadbd`가 인식하는 옵션 목록과 대조합니다.
오타가 있으면 파일을 쓰지 않고 중단합니다. MariaDB 10.6에는 `--validate-config`가 없어 이 방식을 씁니다.

```
Error: mariadbd가 모르는 옵션이 있습니다. 적용하지 않았습니다.
    max_connectionz
```

**재시작 실패 시 자동 롤백** — 값 자체가 문제라 서버가 뜨지 않으면
백업해 둔 이전 설정으로 되돌리고 다시 시작합니다. 새로 만든 파일이었다면 삭제합니다.

**설정 주입 방지** — ini에서 읽은 DB 이름·사용자 이름은 영문/숫자/밑줄만 허용하고,
비밀번호는 SQL 문자열로 이스케이프합니다.

이 밖에 재시작 전에는 현재 연결된 클라이언트 수를 보여주고 확인을 받습니다.

## 백업

`uninstall`과 `purge`는 실행 전에 전체 덤프를 뜹니다.

```
backups/all-databases-20260815-094500.sql.gz
```

수동으로 뜨려면:

```bash
sudo mariadb-dump --all-databases --single-transaction --routines --events | gzip > backup.sql.gz
```

복원:

```bash
gunzip -c backup.sql.gz | sudo mariadb
```

## 제거

```bash
./install_mariadb.sh uninstall   # 패키지만 제거, /var/lib/mysql 유지
./install_mariadb.sh purge       # 데이터까지 삭제 (되돌릴 수 없음)
```

`uninstall`은 사용 중인 데이터베이스 목록을 보여주고 전체 덤프를 뜬 뒤 `uninstall` 입력을 요구합니다.
다시 설치하면 남아 있는 데이터를 그대로 사용합니다.

`purge`는 `DELETE ALL DATA`를 그대로 입력해야 진행됩니다. 이때도 덤프는 먼저 뜨고
`backups/`에 남기므로, 실수했더라도 복원할 수 있습니다.

## 문제 해결

### `Access denied for user 'root'@'localhost' (using password: NO)`

`sudo mariadb`가 거부되는 경우입니다. **서버가 죽은 게 아닙니다** —
`systemctl status mariadb`가 `active (running)`이면 서비스는 정상이고, 접속 인증만 막힌 상태입니다.

원인은 `root@localhost`가 `unix_socket` 인증을 쓰지 않는 상태가 된 것입니다.
이러면 부팅 시 `/etc/mysql/debian-start`도 실패해 로그에 `FATAL ERROR: Upgrade failed`가 남습니다.
서버 자체는 정상 가동 중일 수 있으니 `systemctl is-active mariadb`로 먼저 구분하세요.

오류 번호가 원인을 알려줍니다.

| 오류 | 의미 |
|------|------|
| `ERROR 1045 ... (using password: NO)` | 비밀번호 기반 플러그인인데 비밀번호를 주지 않음 |
| `ERROR 1698 ...` | `unix_socket` 인증인데 OS 사용자가 맞지 않음 → `sudo`로 실행 |

> `/etc/mysql/debian.cnf`는 도움이 되지 않습니다. Ubuntu 22.04에서 이 파일은
> `user = root`에 비밀번호가 없는 **폐기 예정 스텁**이라 root 인증이 깨진 상황에서는 똑같이 거부됩니다.
> (예전 배포판의 `debian-sys-maint` 자격 증명을 담고 있지 않습니다)

### 먼저: 전권 계정을 알고 있다면 복구가 필요 없습니다

`setup_mariadb.sh` 는 관리자로 붙는 방법을 넷까지 시도합니다.

| | 무엇 | 언제 통하나 |
|---|---|---|
| 1 | `--no-defaults --protocol=socket -u root` | root 가 `unix_socket` 인증 |
| 2 | 기본 옵션 파일 | `/root/.my.cnf` 등이 유효 |
| 3 | `/etc/mysql/debian.cnf` | 예전 레이아웃의 배포판 |
| 4 | **계정·비밀번호를 물어봄** | 위가 전부 막혔을 때 |

**1과 2가 나뉘어 있는 것이 중요합니다.** `/root/.my.cnf` 에 낡은 비밀번호가 들어
있으면 옵션 파일을 읽는 순간 `Access denied ... (using password: YES)` 로 실패합니다 —
root 가 멀쩡히 `unix_socket` 인증인데도 그렇습니다. 그래서 옵션 파일을 무시하고
먼저 두드립니다.

4번은 `sudo` 로, **대화형 터미널에서만** 묻습니다. 자동화된 실행이 입력을 기다리며
멈추지 않게 하기 위해서입니다. 점검(`check-database.sh`)과 상태 표시는 1~3만 씁니다.

아래 복구는 **네 가지가 전부 막혔을 때** 하는 것입니다.

### 복구: `--init-file` (권장)

인증이 열린 채로 방치되는 구간이 없습니다.
이 배포판의 유닛 파일이 `ExecStart=/usr/sbin/mariadbd $MYSQLD_OPTS ...` 라서 아래가 동작합니다.

```bash
sudo tee /root/mariadb-fix-root.sql >/dev/null <<'SQL'
CREATE USER IF NOT EXISTS 'root'@'localhost' IDENTIFIED VIA unix_socket;
ALTER USER 'root'@'localhost' IDENTIFIED VIA unix_socket;
GRANT ALL PRIVILEGES ON *.* TO 'root'@'localhost' WITH GRANT OPTION;
FLUSH PRIVILEGES;
SQL

sudo systemctl set-environment MYSQLD_OPTS="--init-file=/root/mariadb-fix-root.sql"
sudo systemctl restart mariadb
sudo mariadb -e "SELECT CURRENT_USER();"        # root@localhost 나오면 성공

sudo systemctl unset-environment MYSQLD_OPTS    # 부팅마다 재실행되지 않도록 복귀
sudo systemctl restart mariadb
sudo rm -f /root/mariadb-fix-root.sql
```

### 복구: `--skip-grant-tables`

**서비스를 반드시 먼저 내려야 합니다.** 서비스가 떠 있는 채로 두 번째 인스턴스를 띄우면
데이터 디렉토리 잠금이 충돌해 이런 오류가 납니다.

```
[ERROR] mariadbd: Can't lock aria control file '/var/lib/mysql/aria_log_control'
        for exclusive use, error: 11. Will retry for 30 seconds
```

```bash
sudo systemctl stop mariadb
sudo mariadbd --skip-grant-tables --skip-networking --user=mysql &
sudo mariadb -u root
```

```sql
FLUSH PRIVILEGES;                                  -- 먼저 실행해야 ALTER USER가 동작
CREATE USER IF NOT EXISTS 'root'@'localhost' IDENTIFIED VIA unix_socket;
ALTER USER 'root'@'localhost' IDENTIFIED VIA unix_socket;
GRANT ALL PRIVILEGES ON *.* TO 'root'@'localhost' WITH GRANT OPTION;
FLUSH PRIVILEGES;
EXIT;
```

```bash
sudo pkill -f "mariadbd --skip-grant-tables"
sleep 3
sudo systemctl start mariadb
```

이 방법은 `--skip-networking` 때문에 3306이 닫히고 권한 검사도 꺼지므로,
그동안 DB를 쓰는 서비스(이 서버에서는 Kamailio)의 접속이 끊깁니다.

### 시스템 테이블 업그레이드

root 접속이 복구되면 확인합니다. 같은 마이너 계열(예: 10.6.22 → 10.6.23) 안에서는
구조가 같아 실행할 필요가 없고, 아래처럼 안내가 나오면 그대로 두면 됩니다.

```bash
sudo mariadb-upgrade
# This installation of MariaDB is already upgraded to 10.6.22-MariaDB.
# There is no need to run mysql_upgrade again for 10.6.23-MariaDB, because they're both 10.6.
```

### 서비스가 정말 죽었는지 확인하는 법

```bash
systemctl is-active mariadb          # active 면 정상
ss -ltn | grep 3306                  # 리스닝 여부
sudo journalctl -u mariadb -n 50 --no-pager
```

로그의 `[Warning] Access denied ...` 줄은 **누군가 접속을 시도했다가 거부된 기록**이지
서버 장애가 아닙니다. 타임스탬프를 보면 어떤 명령이 만든 것인지 알 수 있습니다.

## 운용

```bash
sudo systemctl status mariadb
sudo systemctl restart mariadb
sudo mariadb                       # root 접속 (unix_socket)

sudo tail -f /var/log/mysql/error.log
sudo tail -f /var/log/mysql/slow.log
```

접속 확인:

```bash
mariadb -u appuser -p appdb
```

현재 적용된 값 확인:

```bash
sudo mariadb -e "SHOW VARIABLES LIKE 'max_connections';"
sudo mariadb -e "SELECT user, host FROM mysql.user;"
sudo mariadb -e "SHOW GRANTS FOR 'appuser'@'localhost';"
```

## 예시: 새 애플리케이션용 DB 추가

`database.ini`에 두 섹션을 추가합니다.

```ini
[database:myapp]

[user:myapp]
host = localhost
databases = myapp
privileges = ALL
```

```bash
sudo ./setup_mariadb.sh --dry-run
sudo ./setup_mariadb.sh
cat secrets/myapp.pw
```

서버 설정(`[server]`)을 바꾸지 않았다면 재시작 없이 적용됩니다.
