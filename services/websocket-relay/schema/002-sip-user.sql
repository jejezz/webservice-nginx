-- SIP 사용자명 ↔ FCM 토큰 연결
--
-- database/database.ini 의 [database:rtc_relay] schema_dir 이 이 디렉토리를 가리킨다.
-- sudo database/setup_mariadb.sh 로 적용한다. 여러 번 실행해도 안전해야 한다.
--
-- ── 왜 필요한가 ──────────────────────────────────────────────────
-- 인터폰이 Kamailio 를 통해 모바일로 걸면, 모바일이 자고 있어 등록 상태가 아니다.
-- Kamailio 는 그 INVITE 를 붙들어 두고(tsilo) 단말을 깨우는 푸시를 요청하는데,
-- 그때 넘어오는 것은 **SIP 사용자명**(예: 1001)뿐이다.
--
-- 그런데 rtc_mobiles 는 address(1B101U 같은 동/호)로만 찾게 되어 있어 SIP 쪽에서
-- 온 요청으로는 토큰을 찾을 수 없다. 그 연결 고리를 여기서 만든다.
--
-- 값은 단말이 /register 할 때 함께 보낸다. 안 보내면 NULL 이고, 그런 단말은
-- SIP 착신 푸시를 받지 못한다 (기존 WebRTC 경로는 그대로 동작한다).
--
-- UNIQUE 를 걸지 않는 이유: 한 내선에 여러 단말(휴대폰·태블릿)이 붙을 수 있고,
-- 그 경우 모두에게 푸시를 보내는 것이 맞다. rtc_mobiles 의 신원은 uuid 다.

-- 컬럼 추가는 멱등하지 않으므로(ADD COLUMN 은 IF NOT EXISTS 를 MariaDB 10.6 에서
-- 지원하지만 버전에 따라 다르다) information_schema 로 확인하고 실행한다.
SET @col := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'rtc_mobiles' AND column_name = 'sip_user'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE rtc_mobiles ADD COLUMN sip_user VARCHAR(64) NULL COMMENT ''SIP 사용자명(내선). SIP 착신 푸시 대상 조회에 쓴다''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'rtc_mobiles' AND index_name = 'idx_rtc_mobiles_sip_user'
);
SET @sql := IF(@idx = 0,
  'CREATE INDEX idx_rtc_mobiles_sip_user ON rtc_mobiles (sip_user)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

INSERT INTO schema_migrations (version) VALUES ('002-sip-user')
ON DUPLICATE KEY UPDATE version = version;
