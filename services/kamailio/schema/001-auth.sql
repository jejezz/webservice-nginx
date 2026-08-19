-- kamailio 스키마 (DB 이름: kamailio)
--
-- database/database.ini 의 [database:kamailio] schema_dir 이 이 디렉토리를 가리킨다.
-- sudo database/setup_mariadb.sh 를 실행하면 이 디렉토리의 *.sql 이 이름순으로 실행된다.
--
-- 여러 번 실행해도 안전하도록 모두 IF NOT EXISTS 를 쓴다.
-- 기존 테이블의 컬럼은 바꾸지 않으므로, 구조 변경은 002-xxx.sql 처럼 새 파일로 추가한다.
--
-- 이 파일은 Kamailio 배포판의 auth_db-create.sql / standard-create.sql 을 옮긴 것이다.
-- 원본은 /usr/share/kamailio/mysql/ 에 있으며 CREATE TABLE 이 멱등하지 않아 그대로 쓸 수 없다.
-- 컬럼 이름과 table_version 은 원본과 정확히 같아야 한다 — Kamailio가 기동할 때 검사한다.
-- (5.5.4 패키지판과 5.7.7 소스빌드판의 정의가 동일함을 확인했다)

-- 각 테이블의 스키마 버전. Kamailio가 모듈을 올릴 때 이 값을 확인하고,
-- 맞지 않으면 기동을 거부한다.
CREATE TABLE IF NOT EXISTS version (
  id            INT(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  table_name    VARCHAR(32)      NOT NULL,
  table_version INT UNSIGNED     NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY table_name_idx (table_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Kamailio 테이블 스키마 버전';

-- SIP 계정. auth_db 모듈이 REGISTER/INVITE 인증에 사용한다.
--
-- password  평문 비밀번호. kamctlrc 의 STORE_PLAINTEXT_PW=0 이면 비워 둔다.
-- ha1       MD5(username:realm:password)      — digest 인증에 실제로 쓰이는 값
-- ha1b      MD5(username@domain:realm:password) — 일부 단말이 쓰는 변형
--
-- kamailio.cfg 가 calculate_ha1=yes 로 두면 평문 password 로 계산하지만,
-- 평문을 저장하지 않는 편이 안전하므로 ha1 을 채워 두는 방식을 권한다.
-- (kamctl add 는 두 방식 모두 알아서 처리한다)
CREATE TABLE IF NOT EXISTS subscriber (
  id       INT(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(64)      NOT NULL DEFAULT '' COMMENT '내선 번호 등 SIP 사용자명',
  domain   VARCHAR(64)      NOT NULL DEFAULT '' COMMENT 'SIP 도메인 (kamctlrc 의 SIP_DOMAIN)',
  -- PASSWORD 는 MariaDB 의 내장 함수 이름이기도 하므로 역따옴표로 감싼다.
  `password` VARCHAR(64)    NOT NULL DEFAULT '' COMMENT '평문 비밀번호 (저장하지 않는 것을 권장)',
  ha1      VARCHAR(128)     NOT NULL DEFAULT '',
  ha1b     VARCHAR(128)     NOT NULL DEFAULT '',
  PRIMARY KEY (id),
  UNIQUE KEY account_idx (username, domain),
  KEY username_idx (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Kamailio SIP 계정';

-- table_version 은 Kamailio 버전에 따라 올라갈 수 있으므로 갱신되게 둔다.
-- (INSERT IGNORE 를 쓰면 업그레이드 때 옛 값이 남아 기동이 막힌다)
INSERT INTO version (table_name, table_version) VALUES
  ('version', 1),
  ('subscriber', 7)
ON DUPLICATE KEY UPDATE table_version = VALUES(table_version);
