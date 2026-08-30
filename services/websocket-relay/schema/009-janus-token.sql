-- 단말마다 다른 Janus 토큰
--
-- database/database.ini 의 [database:rtc_relay] schema_dir 이 이 디렉토리를 가리킨다.
-- 적용은 `npm run db:migrate` (또는 sudo database/setup_mariadb.sh) 가 한다.
-- 여러 번 실행해도 안전해야 한다.
--
-- ══ 무엇을 푸는가 ═══════════════════════════════════════════════
--
-- 앱은 Janus 에 붙을 때 `apisecret` 을 싣는다. 그 값은 **단지에 하나**라 모든
-- 폰에 같은 값이 들어간다. 한 대에서 새면 그 단지의 게이트웨이 전체가 열리고,
-- 특정 단말만 막을 방법이 없다.
--
-- 단말마다 다른 토큰을 주면 두 문제가 함께 사라진다. 승인 응답에는 이미 SIP
-- 비밀번호가 실려 나가므로 — 그쪽이 더 민감한 값이다 — 같은 경로에 얹는다.
--
-- ══ 왜 값을 저장하는가 ══════════════════════════════════════════
--
-- Janus 의 `add_token` 은 **메모리에만** 넣는다. 재시작하면 전부 사라진다.
-- 우리가 값을 들고 있어야 그때 다시 넣어 줄 수 있다 (libs/janusToken.ts 의
-- `ensureForDevice` 가 등록 때마다 다시 넣는다).
--
-- 그래서 이 값은 비밀이지만 SIP 비밀번호와 같은 성질이다 — 서버가 알고 있고,
-- 단말에게 등록 응답으로 내려준다. 로그에는 남기지 않는다.

SET @col := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'rtc_mobiles' AND column_name = 'janus_token'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE rtc_mobiles ADD COLUMN janus_token VARCHAR(64) NULL COMMENT ''이 단말만의 Janus 토큰. Janus 는 메모리에만 갖고 있어 여기 값이 원본이다''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

INSERT INTO schema_migrations (version) VALUES ('009-janus-token')
ON DUPLICATE KEY UPDATE version = version;
