-- 푸시 토큰의 건강 상태 + 조회 인덱스 정리
--
-- database/database.ini 의 [database:rtc_relay] schema_dir 이 이 디렉토리를 가리킨다.
-- sudo database/setup_mariadb.sh 로 적용한다. 여러 번 실행해도 안전해야 한다.
--
-- ── 왜 필요한가 ──────────────────────────────────────────────────
-- 1) 죽은 토큰이 쌓이기만 했다.
--    앱을 지우거나 다시 깐 단말의 토큰은 FCM 이 'registration-token-not-registered'
--    로 알려 주는데, 지금까지는 successCount 만 로그에 남기고 개별 결과를 보지
--    않았다. 그래서 무효 토큰이 영구히 남아 초인종이 울릴 때마다 FCM 호출을
--    낭비했고, 사람이 대시보드에서 지우기 전에는 줄지 않았다.
--
-- 2) 인덱스가 실제 쿼리와 맞지 않았다.
--    푸시 대상 조회는 전부 `WHERE address = ? AND active = 1` 인데 address 와
--    active 에 인덱스가 **따로** 걸려 있어 한쪽만 쓰였다. active 는 값이 둘뿐이라
--    (0/1) 단독 인덱스로는 거의 걸러 내지 못한다.

-- ── 컬럼 ────────────────────────────────────────────────────────
-- ADD COLUMN 은 멱등하지 않으므로(IF NOT EXISTS 지원이 버전마다 다르다)
-- information_schema 로 확인하고 실행한다. 002-sip-user.sql 과 같은 방식.

SET @col := (SELECT COUNT(*) FROM information_schema.columns
              WHERE table_schema = DATABASE() AND table_name = 'rtc_mobiles'
                AND column_name = 'token_updated_at');
SET @sql := IF(@col = 0,
  'ALTER TABLE rtc_mobiles ADD COLUMN token_updated_at DATETIME NULL COMMENT ''토큰이 마지막으로 바뀐 시각. 오래된 토큰을 찾는 데 쓴다''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
              WHERE table_schema = DATABASE() AND table_name = 'rtc_mobiles'
                AND column_name = 'push_error');
SET @sql := IF(@col = 0,
  'ALTER TABLE rtc_mobiles ADD COLUMN push_error VARCHAR(64) NULL COMMENT ''FCM 이 돌려준 마지막 실패 코드. NULL 이면 사람이 관리하는 행이다''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
              WHERE table_schema = DATABASE() AND table_name = 'rtc_mobiles'
                AND column_name = 'push_failed_at');
SET @sql := IF(@col = 0,
  'ALTER TABLE rtc_mobiles ADD COLUMN push_failed_at DATETIME NULL COMMENT ''마지막 푸시 실패 시각''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 이미 등록된 행에는 토큰이 언제 들어왔는지 기록이 없다. created 로 채워 둔다 —
-- 정확하지는 않지만 NULL 보다 낫고, 다음 /register 때 실제 값으로 바뀐다.
UPDATE rtc_mobiles SET token_updated_at = created WHERE token_updated_at IS NULL;

-- ── 인덱스 ──────────────────────────────────────────────────────
-- 푸시 대상 조회에 맞는 복합 인덱스를 넣는다.
SET @idx := (SELECT COUNT(*) FROM information_schema.statistics
              WHERE table_schema = DATABASE() AND table_name = 'rtc_mobiles'
                AND index_name = 'idx_rtc_mobiles_address_active');
SET @sql := IF(@idx = 0,
  'ALTER TABLE rtc_mobiles ADD KEY idx_rtc_mobiles_address_active (address, active)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- address 단독 인덱스는 위 복합 인덱스의 왼쪽 접두사라 중복이다.
SET @idx := (SELECT COUNT(*) FROM information_schema.statistics
              WHERE table_schema = DATABASE() AND table_name = 'rtc_mobiles'
                AND index_name = 'idx_rtc_mobiles_address');
SET @sql := IF(@idx > 0, 'ALTER TABLE rtc_mobiles DROP KEY idx_rtc_mobiles_address', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- active 단독 인덱스는 값이 둘뿐이라 거의 걸러 내지 못한다. 개수를 세는
-- 쿼리(COUNT/SUM)는 위 복합 인덱스로도 덮인다.
SET @idx := (SELECT COUNT(*) FROM information_schema.statistics
              WHERE table_schema = DATABASE() AND table_name = 'rtc_mobiles'
                AND index_name = 'idx_rtc_mobiles_active');
SET @sql := IF(@idx > 0, 'ALTER TABLE rtc_mobiles DROP KEY idx_rtc_mobiles_active', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

INSERT IGNORE INTO schema_migrations (version) VALUES ('003-push-health');
