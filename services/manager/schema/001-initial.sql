-- manager 스키마 (DB 이름: manager)
--
-- sudo ./schema/setup_database.sh 를 실행하면 이 디렉토리의 *.sql 이 이름순으로 실행된다.
--
-- 여러 번 실행해도 안전하도록 모두 IF NOT EXISTS 를 쓴다.
-- 기존 테이블의 컬럼은 바꾸지 않으므로, 구조 변경은 002-xxx.sql 처럼 새 파일로 추가한다.

-- 관리자 계정.
-- username은 이메일만 받는다. (애플리케이션에서도 형식을 검증한다)
-- 등록되지 않은 이메일로 로그인을 시도하면 approved=0 인 승인 요청 행이 만들어지고,
-- approved=1 이 되어야 실제 로그인이 성공한다.
CREATE TABLE IF NOT EXISTS administrator (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  email         VARCHAR(255)  NOT NULL                COMMENT '로그인 아이디 (이메일, 소문자로 저장)',
  display_name  VARCHAR(100)      NULL DEFAULT NULL   COMMENT '표시 이름',
  password_hash VARCHAR(255)  NOT NULL                COMMENT 'scrypt$<salt>$<hash>',
  approved      TINYINT(1)    NOT NULL DEFAULT 0      COMMENT '1이어야 로그인 가능',
  role          VARCHAR(32)   NOT NULL DEFAULT 'admin',
  requested_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '승인 요청 시각',
  approved_at   DATETIME          NULL DEFAULT NULL,
  approved_by   VARCHAR(255)      NULL DEFAULT NULL   COMMENT '승인한 관리자의 이메일',
  last_login_at DATETIME          NULL DEFAULT NULL,
  login_count   INT UNSIGNED  NOT NULL DEFAULT 0,
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_administrator_email (email),
  KEY idx_administrator_approved (approved)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='관리 대시보드 로그인 계정';

-- 로그인·승인 등 계정 관련 사건 기록.
-- 누가 언제 승인했는지, 어디서 로그인했는지를 남긴다.
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actor   VARCHAR(255)     NULL DEFAULT NULL COMMENT '행위자 (없으면 시스템)',
  action  VARCHAR(64)  NOT NULL             COMMENT 'login_ok / login_fail / signup_request / approve / revoke / password_change',
  target  VARCHAR(255)     NULL DEFAULT NULL COMMENT '대상 계정',
  ip      VARCHAR(45)      NULL DEFAULT NULL,
  detail  VARCHAR(500)     NULL DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_audit_at (at),
  KEY idx_audit_action (action),
  KEY idx_audit_target (target)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='관리자 계정 감사 로그';

-- 스키마 버전 기록. 구조를 바꿀 때마다 새 버전을 추가한다.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    VARCHAR(64) NOT NULL,
  applied_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO schema_migrations (version) VALUES ('001-initial');
