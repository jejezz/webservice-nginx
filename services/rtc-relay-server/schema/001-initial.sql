-- rtc-relay-server 스키마 (DB 이름: rtc_relay — DB 이름에는 하이픈을 쓸 수 없다)
--
-- database/database.ini 의 [database:rtc_relay] schema_dir 이 이 디렉토리를 가리킨다.
-- sudo database/setup_mariadb.sh 를 실행하면 이 디렉토리의 *.sql 이 이름순으로 실행된다.
-- 모든 파일은 여러 번 실행해도 안전해야 한다. (CREATE TABLE IF NOT EXISTS 등)
--
-- 이관 전에는 이 서비스가 MySQL 을 43306 포트로 찾다가 실패하고 SQLite 파일로
-- 폴백했다. 그래서 실데이터가 0행이었고, rtc_homenet 은 아예 만들어진 적이 없다
-- (SQLite 쪽 CREATE TABLE 은 rtc_mobiles 하나뿐이었다). 여기서 둘 다 정의한다.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    VARCHAR(64) NOT NULL,
  applied_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 등록된 모바일 단말. FCM 푸시 대상이 이 표에서 나온다.
--
-- uuid 가 단말의 신원이다. /register 는 uuid 로 찾아 없으면 INSERT, 있으면 UPDATE 하므로
-- UNIQUE 를 걸어 INSERT ... ON DUPLICATE KEY UPDATE 한 번으로 처리할 수 있게 한다.
-- address 로도 조회한다 (/room/invite 가 착신 단말의 token 을 찾을 때) — 인덱스를 둔다.
CREATE TABLE IF NOT EXISTS rtc_mobiles (
  id       INT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid     VARCHAR(191) NOT NULL,
  email    VARCHAR(255) NOT NULL,
  complex  VARCHAR(128) NOT NULL,
  address  VARCHAR(128) NOT NULL,
  token    VARCHAR(512) NOT NULL,
  phone    VARCHAR(32)      NULL,
  -- 단말이 보내는 프로필 이미지. base64 문자열로 들어오므로 TEXT 계열로 받는다.
  image    MEDIUMTEXT       NULL,
  active   TINYINT(1)   NOT NULL DEFAULT 1,
  created  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  modified DATETIME         NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_rtc_mobiles_uuid (uuid),
  KEY idx_rtc_mobiles_address (address),
  KEY idx_rtc_mobiles_active (active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 홈넷 장치. 단지/동/호 조합이 신원이다.
CREATE TABLE IF NOT EXISTS rtc_homenet (
  id        INT UNSIGNED NOT NULL AUTO_INCREMENT,
  complex   VARCHAR(128) NOT NULL,
  type      VARCHAR(64)  NOT NULL,
  building  VARCHAR(32)  NOT NULL,
  unit      VARCHAR(32)  NOT NULL,
  ipaddress VARCHAR(45)  NOT NULL,
  created   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  modified  DATETIME         NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_rtc_homenet_place (complex, building, unit)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO schema_migrations (version) VALUES ('001-initial');
