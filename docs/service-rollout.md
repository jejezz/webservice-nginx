# 새 서비스를 안전하게 올리는 순서

[adding-a-service.md](adding-a-service.md) 가 **무엇을 써야 하는가**(선언 파일 셋)를
다룬다면, 이 문서는 **그 선언을 어떤 순서로 반영해야 기존 서비스가 안 죽는가**를
다룹니다. 세 시스템(nginx·pm2·database) 모두 "추가"가 원칙이지만, 반영 방식이
서로 달라서 순서를 잘못 잡으면 새 서비스가 아니라 **엉뚱한 서비스가 먼저
죽습니다.**

## 세 가지 원칙

### nginx — 훑어서 하나로 합친다, 그래서 반영은 전부 다시 쓴다

각 서비스가 `nginx-conf/*.ini` 에 라우트를 선언하면 `generate_nginx_conf.py` 가
**전체 서비스의 선언을 한 번에 훑어** `/etc/nginx/conf.d/path-routing.conf`
하나를 만듭니다. 그래서 서비스 하나를 추가할 때도 반영 명령은 **모든 서비스의
라우트를 다시 쓰고 nginx 를 reload** 합니다 — 이게 세 시스템 중 유일하게
"내 것만 바뀌는" 게 아니라 "전체가 다시 만들어지는" 지점입니다. 대신
`--check` 가 포트·location 충돌을 반영 **전에** 막고, `nginx -t` 가 실패하면
reload 자체를 하지 않습니다. 스키마: [nginx-conf.md](nginx-conf.md).

### pm2 — 훑어서 앱 목록을 만든다, 그래도 반영은 앱 하나만 건드릴 수 있다

`pm2-conf/*.ini` 도 마찬가지로 `ecosystem.config.js` 가 훑어 `apps` 배열을
만들지만, **적용은 서비스 단위입니다.** `pm2 start ecosystem.config.js --only
<이름>` 은 그 앱만 시작하고 이미 떠 있는 다른 앱은 건드리지 않습니다. `--only`
없이 `pm2 start ecosystem.config.js` 만 하면 선언에 있는 전부를 다시
훑지만, 이미 실행 중인 프로세스는 그대로 두고 새로 생긴 것만 추가합니다 —
그래도 새 서비스를 올릴 때는 습관적으로 `--only` 를 씁니다. 스키마:
[pm2-conf.md](pm2-conf.md).

### database — 추가·갱신만 하고, 지우지 않는다

`setup_mariadb.sh` 는 ini(또는 `db-conf/`)에 없는 DB 나 사용자를 **절대
지우지 않습니다.** 그래서 이 스크립트를 다시 돌리는 것 자체는 안전한
조작입니다 — 최악의 경우도 "아무 일도 안 일어남" 이지 "무언가 지워짐" 이
아닙니다. `services/*/db-conf/*.ini` 로 스스로 DB 를 선언하는 plug-in
서비스는 그 DB **하나에만** 권한을 갖는 전용 계정을 자동 발급받으므로,
다른 서비스의 DB 접근 권한에 영향을 줄 수 없습니다. 스키마:
[db-conf.md](db-conf.md), 공용 계정 정책: [../database/README.md](../database/README.md).

## 등록 순서

파일만 써서는 아무것도 바뀌지 않습니다. 아래는 **기존 서비스를 고장내지
않는** 순서입니다 — 뒤에 나올수록 되돌리기 어렵거나 다른 서비스에 영향을
줄 수 있는 단계이므로 뒤로 미룹니다.

```bash
# 0. 선언만 쓴다 (이 시점까지는 시스템에 아무 변화도 없음)
#    services/<이름>/nginx-conf/service.ini
#    services/<이름>/pm2-conf/app.ini
#    services/<이름>/db-conf/database.ini   (DB 가 필요하면, 이 저장소 밖에 사는 서비스만)

# 1. 셋 다 검사만 한다 — sudo 없이 되는 것부터
./nginx/install_nginx_stack.sh --check      # 포트·location 충돌
node pm2/ecosystem.config.js --check        # PORT 교차 검사, 이름 중복
sudo ./database/setup_mariadb.sh --dry-run  # 무엇이 만들어질지만 (sudo 는 필요하지만 아무것도 바꾸지 않음)

# 2. 데이터베이스 — 추가·갱신만 하므로 가장 먼저 해도 안전하다
sudo ./database/setup_mariadb.sh
cat database/secrets/<계정>.pw              # db-conf 로 새로 발급됐다면

# 3. pm2 — 새 서비스만 올린다. 다른 서비스는 건드리지 않는다
cd pm2 && pm2 start ecosystem.config.js --only <이름> && pm2 save && cd ..

# 4. 백엔드가 실제로 살아 있는지 먼저 확인한다 — nginx 에 알리기 전에
curl -s localhost:<포트>/health

# 5. nginx — 전체 라우팅을 다시 쓰는 유일한 단계이므로 맨 마지막
sudo ./nginx/install_nginx_stack.sh --skip-install

# 6. 반영 후 재확인 — "선언대로 됐다"가 아니라 "설치본이 선언과 같다"까지 본다
./nginx/install_nginx_stack.sh --check
node pm2/ecosystem.config.js --check
curl -s localhost/<라우트>/health
```

**왜 이 순서인가**

- **DB 를 가장 먼저 하는 이유** — `setup_mariadb.sh` 는 추가·갱신만 하는
  안전한 조작이고, 앱이 DB 없이 뜨면 `/health` 가 `degraded` 로 남아 4번에서
  바로 드러납니다. 반대로 순서를 바꿔 pm2 를 먼저 올리면 앱이 DB 접속
  실패로 재시작을 반복하다가, nginx 까지 반영된 뒤에야 (혹은 그 전에)
  문제를 알아차리게 됩니다.
- **pm2 에 `--only` 를 반드시 쓰는 이유** — `pm2 restart ecosystem.config.js`
  (전체)를 새 서비스 하나 때문에 돌리면, 선언과 실행 중인 값이 어긋나 있던
  **다른** 서비스까지 그 자리에서 재시작됩니다. 지금 당장 필요한 것은 새
  서비스 하나뿐이므로 범위를 그만큼만 건드립니다.
- **nginx 를 가장 나중에, 그리고 헬스 확인 뒤에 하는 이유** — nginx 반영은
  **전체 라우팅을 다시 쓰고 reload** 하는 단계라 세 시스템 중 유일하게
  "내 것만 바뀌는" 게 아닙니다. `--check` 로 선언 단계의 충돌은 미리
  걸렀지만, 그 선언이 가리키는 백엔드가 실제로 살아 있는지는 nginx 가 몰라
  확인해 주지 않습니다. 죽은 백엔드를 가리키는 라우트를 반영해 봤자 502 만
  하나 늘 뿐이고, 최악의 경우 `--check` 가 못 잡는 실수(예: 오탈자로 잘못된
  `default_route`)가 **모든** 서비스의 진입점에 영향을 줍니다. 그래서 nginx
  는 다른 모든 것이 실제로 살아 있다고 확인된 뒤 마지막에 반영합니다.
- **`--skip-install` 뒤에도 `--check` 를 다시 돌리는 이유** — 선언만 보는
  검사는 "선언은 고쳤는데 반영을 안 한" 상태를 잡지 못합니다
  ([check-contract.md](check-contract.md) 의 '설치본이 저장소와 같은가').
  반영 명령이 성공했다고 실제로 그 내용이 떠 있다는 뜻은 아닙니다.

## 문제 해결

세 시스템 각각의 상세한 문제 해결은 [../nginx/README.md](../nginx/README.md),
[../pm2/README.md](../pm2/README.md), [../database/README.md](../database/README.md)
에 있습니다. 여기서는 **셋 사이의 어긋남**에서만 나는 증상을 다룹니다.

### 대시보드에 "떠 있는데 중단" 으로 뜬다

`nginx-conf` 의 `[service] name`, `pm2-conf` 의 `[app] name`, `/health` 응답의
`service` 필드 — **이 셋이 정확히 같아야** 합니다. 하나라도 다르면 manager
가 헬스를 그 서비스와 짝짓지 못합니다. `curl -s localhost:<포트>/health |
grep service` 로 실제 응답 값을 확인하세요.

### 새 라우트가 502 를 낸다

거의 항상 `pm2-conf` 의 `[env] PORT` 와 `nginx-conf` 의 `[service] ports`
가 어긋난 경우입니다. `node pm2/ecosystem.config.js --check` 를 돌리면
직접 짚어 줍니다.

```
WARN    my-service    28090   pm2-conf PORT=28090 vs nginx-conf ports=28091
```

`pm2 list` 로 프로세스가 실제로 `online` 인지도 함께 확인하세요 — 포트가
맞아도 프로세스가 죽어 있으면 같은 증상이 납니다.

### `nginx --check` 가 다른 서비스와 충돌한다고 멈춘다

```
Error: duplicate location '/my-service/'
  services/janus/nginx-conf/service.ini
  services/my-service/nginx-conf/service.ini
```

새 서비스의 `location` 이 기존 서비스와 겹친 것입니다. **이 시점에서는
아직 아무것도 반영되지 않았으므로** 기존 서비스는 안전합니다 — 새 선언의
`location` 을 고치고 다시 `--check` 하면 됩니다. 포트가 겹친 경우도 같은
자리에서 같은 이유로 막힙니다.

### `--check` 는 통과했는데 라우트가 안 열린다

`--check` 는 **선언끼리** 충돌이 없는지만 봅니다. 실제로 nginx 가 그 라우트를
서비스하려면 `sudo ./nginx/install_nginx_stack.sh --skip-install` 을 돌려야
합니다. `--check` 가 "설치본이 지금 선언과 다릅니다" 라고 알려 주면 이
상태입니다.

### `데이터베이스 이름이 겹칩니다` 로 `setup_mariadb.sh` 가 멈춘다

`database/database.ini` 의 `[database:...]` 와 어떤 서비스의
`db-conf/database.ini` 가 같은 DB 이름을 각자 만들려고 한 것입니다. 오류
메시지가 두 선언의 경로를 그대로 보여 주므로, 이름을 바꾸거나 원래 어느
쪽이 그 DB 의 주인인지 정해서 한쪽 선언을 지우세요. **이 시점에서도 아직
아무 DB 도 만들어지지 않았으므로** 기존 DB 는 안전합니다.

### plug-in 서비스의 `schema_dir 없음` 이 계속 보인다

`db-conf/database.ini` 에 `schema_dir` 을 적지 않았거나, 그 서비스가 스스로
테이블을 만드는 앱이면 **정상입니다** — DB 와 전용 계정만 만들고
넘어갑니다. `finish()` 가 "건너뛴 스키마" 로 모아 보여 주는 것은 경고이지
실패가 아닙니다. 그 서비스가 실제로 스키마 파일을 갖고 있어야 하는데도
이 메시지가 뜬다면 `schema_dir` 경로(서비스 디렉토리 기준 상대경로)를
확인하세요.

### pm2 는 재시작됐는데 재부팅하면 사라진다

`pm2 start … --only <이름>` 뒤에 `pm2 save` 를 잊은 경우입니다. 재부팅
전까지는 증상이 없다가 재부팅 후에야 드러나므로 놓치기 쉽습니다 —
`node pm2/ecosystem.config.js --check` 가 "재부팅 목록에 없습니다" 로
미리 알려 줍니다.

### 새 서비스를 올렸더니 **다른** 서비스가 죽었다

새 서비스만 지웠는데도 안 고쳐진다면, 원인은 대부분 5단계(nginx 반영)에서
**전체** 라우팅이 다시 쓰였다는 사실 자체입니다. 되돌리는 방법:

```bash
# nginx — 방금 반영을 되돌린다 (백업이 자동으로 남습니다)
sudo ./nginx/install_nginx_stack.sh --check   # 지금 선언에 문제가 있는지 먼저 확인
# 선언 자체(ini 파일들)를 이전 커밋으로 되돌린 뒤 다시 반영
git checkout -- services/<새-서비스>/nginx-conf/
sudo ./nginx/install_nginx_stack.sh --skip-install

# pm2 — 새 서비스만 내린다. 다른 서비스는 건드리지 않는다
pm2 delete <새-서비스> && pm2 save

# database — 새로 만든 DB/계정만 있다면 그대로 둬도 다른 서비스에 영향이 없다
# (전용 계정은 그 DB 하나에만 권한을 가지므로). 완전히 지우려면:
sudo mariadb -e "DROP DATABASE <새-DB>; DROP USER '<새-계정>'@'localhost', '<새-계정>'@'127.0.0.1';"
```

DB 단계는 원칙 3(추가·갱신만, 지우지 않음) 덕분에 롤백에서 가장 마음
편한 단계입니다 — 새로 만든 것을 그대로 둬도 다른 서비스는 절대 영향받지
않습니다.

## 붙인 뒤 최종 확인

```bash
./nginx/install_nginx_stack.sh --check
node pm2/ecosystem.config.js --check
curl -s localhost:<포트>/health
```

manager 대시보드(`/manager`)에 카드가 새로 생기고 헬스가 초록이면 끝입니다.
