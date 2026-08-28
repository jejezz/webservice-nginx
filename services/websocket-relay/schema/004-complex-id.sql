-- 단지 식별자(complex_id)
--
-- database/database.ini 의 [database:rtc_relay] schema_dir 이 이 디렉토리를 가리킨다.
-- sudo database/setup_mariadb.sh 로 적용한다. 여러 번 실행해도 안전해야 한다.
--
-- ── 왜 필요한가 ──────────────────────────────────────────────────
-- 푸시 대상을 찾는 조회가 전부 `WHERE address = ? AND active = 1` 이었다.
-- address 는 `1B101U`(동/호) 형식이라 **단지 안에서만 유일하다.** 두 단지에 모두
-- 101동 101호가 있으므로, 단지가 둘이 되는 순간 A단지 인터폰 호출이 B단지
-- 주민 폰에서 울린다.
--
-- 짝이 되는 rtc_homenet 은 이미 UNIQUE (complex, building, unit) 로 단지를
-- 신원에 포함하고 있었다. 모바일 쪽만 빠져 있었다.
--
-- ── 왜 기존 complex 컬럼을 쓰지 않는가 ──────────────────────────
-- complex 는 사람이 읽는 **이름**이다 ('플루토 1단지'). 조회 키로 쓰면 재건축·
-- 명칭 변경 때 등록된 단말이 전부 떨어져 나간다. 그래서 바뀌지 않는 식별자를
-- 따로 둔다. complex 는 표시용으로 그대로 남긴다.
--
-- 값은 중앙(디렉터리)에서 **할당**한다. 이름에서 해시로 유도하지 않는다 —
-- 그러면 이름이 바뀔 때 값도 바뀌어 위와 같은 문제가 된다.
-- 형식은 32비트를 소문자 16진수 8자로 적는다 (예: a3f19c04).
--   생성:  openssl rand -hex 4

SET @col := (SELECT COUNT(*) FROM information_schema.columns
              WHERE table_schema = DATABASE() AND table_name = 'rtc_mobiles'
                AND column_name = 'complex_id');
SET @sql := IF(@col = 0,
  'ALTER TABLE rtc_mobiles ADD COLUMN complex_id VARCHAR(16) NULL COMMENT ''단지 식별자(32비트 hex 8자). 표시용 complex 와 달리 바뀌지 않는다''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 푸시 대상 조회에 맞춘 복합 인덱스. 003 에서 만든 (address, active) 를 확장한다.
SET @idx := (SELECT COUNT(*) FROM information_schema.statistics
              WHERE table_schema = DATABASE() AND table_name = 'rtc_mobiles'
                AND index_name = 'idx_rtc_mobiles_complex_address_active');
SET @sql := IF(@idx = 0,
  'ALTER TABLE rtc_mobiles ADD KEY idx_rtc_mobiles_complex_address_active (complex_id, address, active)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- (address, active) 는 남긴다.
--
-- 위 복합 인덱스의 왼쪽 접두사가 complex_id 라, complex_id 없이 address 로만
-- 찾는 조회는 그 인덱스를 쓰지 못한다. COMPLEX_ID 를 설정하지 않은 서버는
-- 지금까지처럼 address 로만 찾으므로 둘 다 필요하다.

-- 기존 행의 backfill 은 여기서 하지 않는다.
--
-- 이 서버가 어느 단지인지는 .env 의 COMPLEX_ID 가 알고 SQL 은 모른다.
-- 서버가 기동할 때 자기 값으로 NULL 인 행을 채운다 (src/libs/complex.ts).
-- 서버 한 대가 한 단지를 맡으므로 기존 행은 모두 그 단지 것이다.

INSERT IGNORE INTO schema_migrations (version) VALUES ('004-complex-id');
