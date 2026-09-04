# 이 디렉토리는 지금 비어 있습니다 — 일부러입니다

coturn 은 DB 에 상태를 두지 않습니다. 자격 증명은 `use-auth-secret`(TURN REST
API) 방식이라 계정 테이블이 필요 없고(`../turnserver.conf` 의 주석 참고),
할당·세션 상태는 coturn 프로세스 메모리 안에서만 살아 있다가 통화가 끝나면
사라집니다. 그래서 `database/database.ini` 의 `[database:coturn]` 절도
아직 없습니다 — 적용할 `*.sql` 이 없는데 절만 먼저 만들어 두면
`setup_mariadb.sh` 가 빈 스키마 디렉토리를 훑고도 아무 일도 안 하는
자리만 늘어납니다.

그런데도 이 디렉토리 자체는 만들어 둡니다. `services/kamailio/schema/` ·
`services/websocket-relay/schema/` 처럼, DB 를 쓰는 서비스는 모두 이 자리에
마이그레이션을 둡니다 (`database/README.md`, `docs/adding-a-service.md` 의
"① DB 스키마를 쓴다면"). 이 자리가 없으면 나중에 coturn 이 정말 테이블이
필요해졌을 때 — 예를 들어 TURN REST API 자격 증명을 만료시켜 재발급 이력을
남기거나, 할당 로그를 쌓아 통계를 내야 할 때 — 마이그레이션을 어디에 둘지부터
다시 정해야 합니다. 지금 정해 두면 그 결정을 다시 할 필요가 없습니다.

## 실제로 테이블이 필요해지면

1. `schema/001-<이름>.sql` 을 이 디렉토리에 추가합니다 (`IF NOT EXISTS` 로 —
   `services/kamailio/schema/001-auth.sql` 의 머리말 참고. 여러 번 실행해도
   안전해야 `setup_mariadb.sh` 를 다시 돌려도 됩니다).
2. `database/database.ini` 에 아래를 더합니다.

   ```ini
   [database:coturn]
   schema_dir = ../services/coturn/schema
   ```

3. 이 파일(`000-unused.md`)은 지워도 되고, 다음 사람을 위해 "왜 비어
   있었는지" 를 아는 채로 남겨 두어도 됩니다 — 둘 다 무해합니다.
