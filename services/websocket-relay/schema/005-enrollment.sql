-- 단말 등록 승인 (거주 증명) + 표 크기 상한
--
-- database/database.ini 의 [database:rtc_relay] schema_dir 이 이 디렉토리를 가리킨다.
-- 적용은 `npm run db:migrate` (또는 sudo database/setup_mariadb.sh) 가 한다.
-- 여러 번 실행해도 안전해야 한다.
--
-- ══ 무엇을 고치는가 ═════════════════════════════════════════════
--
-- 지금까지 착신 대상 조회는 이것이 전부였다.
--
--     SELECT token FROM rtc_mobiles WHERE address = ? AND active = 1 AND complex_id = ?
--
-- 그리고 /register/mobile 은 인증도 횟수 제한도 없이 uuid·email·complex·
-- address·token 만 받았다. 즉 **단지 + 동 + 호 세 값만 알면 그 집 초인종
-- 영상·음성을 받고 방문자와 대화까지 됐다.** 동/호 조합은 한 단지에 수백~수천
-- 개뿐이라 열거도 가능했다.
--
-- 세 값 중 어느 것도 비밀이 아니다. 단지 ID 는 앱이 공개 디렉터리에서 받아
-- 오고(docs/multi-complex.md 의 `allow read: if true`), 동/호는 건물에 적혀
-- 있다. 그 집 안에 물리적으로 있는 것은 **월패드뿐**이다.
--
-- 그래서 신뢰의 뿌리를 월패드로 옮긴다.
--
--     등록(email 등)        → 아무 권한 없음. 대기 목록에만 들어간다
--     월패드가 승인         → 통화 수신 / 홈넷 제어 권한이 켜진다
--
-- ══ 표 크기는 어떻게 묶이는가 ═══════════════════════════════════
--
-- /register 가 무인증인 이상 아무나 행을 만들 수 있다. 그래서 상한을 구조로
-- 건다.
--
--     rtc_homenet        ≤ 실제 세대 수     (complex_id 로 단지를 고정)
--     rtc_mobiles        ≤ 4 × 세대 수      (승인된 것만 들어온다)
--     mobile_enrollments 휘발성             (세대당 소수 + TTL)
--
-- 핵심은 **승인 전에는 rtc_mobiles 에 행을 만들지 않는 것**이다. 상한을
-- "승인된 것만" 세기로 했으므로, 미승인을 같은 표에 두면 그쪽이 무제한이 된다.

-- ── ① rtc_mobiles — 권한 컬럼 ───────────────────────────────────
--
-- ⚠️ 기존 `active` 를 권한으로 재사용하지 않는다.
--
--    active 는 **푸시 건강 상태**다. FCM 이 'registration-token-not-registered'
--    를 돌려주면 서버가 자동으로 0 으로 내리고, 단말이 새 토큰으로 다시
--    등록하면 1 로 되살린다 (src/libs/push.ts, routes/register.ts 의 UPSERT).
--    여기에 권한을 얹으면 **FCM 실패 한 번에 권한이 사라지고 재등록으로
--    되살아난다** — 승인이라는 말의 뜻이 없어진다. 축은 분리한다.
--
--        active      기계가 정한다 (이 토큰이 살아 있는가)
--        can_*       사람이 정한다 (이 단말을 들여보낼 것인가)
--
-- 기본값 0 이 이 마이그레이션의 핵심이다. 새 단말은 승인 전까지 아무것도
-- 받지 못한다. (등록된 단말이 아직 없어 소급 처리는 필요 없다)

SET @col := (SELECT COUNT(*) FROM information_schema.columns
              WHERE table_schema = DATABASE() AND table_name = 'rtc_mobiles'
                AND column_name = 'can_call');
SET @sql := IF(@col = 0,
  'ALTER TABLE rtc_mobiles ADD COLUMN can_call TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''통화 수신 허용. 월패드나 관리자가 켠다. 기본 불가''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
              WHERE table_schema = DATABASE() AND table_name = 'rtc_mobiles'
                AND column_name = 'can_control');
SET @sql := IF(@col = 0,
  'ALTER TABLE rtc_mobiles ADD COLUMN can_control TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''홈넷 제어 허용. 월패드나 관리자가 켠다. 기본 불가''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
              WHERE table_schema = DATABASE() AND table_name = 'rtc_mobiles'
                AND column_name = 'approved_at');
SET @sql := IF(@col = 0,
  'ALTER TABLE rtc_mobiles ADD COLUMN approved_at DATETIME NULL COMMENT ''대기 목록에서 옮겨 온 시각''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 누가 들여보냈는지. 'wallpad' 또는 관리자 계정 이름이다.
-- 사고가 났을 때 "월패드에서 눌린 것인가, 대시보드에서 눌린 것인가" 를
-- 가릴 수 있어야 한다.
SET @col := (SELECT COUNT(*) FROM information_schema.columns
              WHERE table_schema = DATABASE() AND table_name = 'rtc_mobiles'
                AND column_name = 'approved_by');
SET @sql := IF(@col = 0,
  'ALTER TABLE rtc_mobiles ADD COLUMN approved_by VARCHAR(64) NULL COMMENT ''승인 주체. wallpad 또는 관리자 계정''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- ── ② rtc_homenet — 단지 고정 ───────────────────────────────────
--
-- 이 표가 먼저 무제한이었다. /register/homenet 은 무인증인데 `complex` 가
-- **자유 문자열**이라, 아무 값이나 넣어 행을 끝없이 만들 수 있었다.
--
-- 그래서 "월패드가 등록한 동/호만 모바일 등록 허용" 이라는 규칙도 그대로는
-- 성립하지 않았다 — 공격자가 /register/homenet 으로 게이트를 직접 심은 뒤
-- 그 주소로 모바일을 등록하면 됐기 때문이다.
--
-- complex_id 를 두고 이 서버의 단지만 받으면 행 수가 실제 세대 수로 묶인다.
-- rtc_mobiles 와 같은 이유·같은 형식이다 (004-complex-id.sql).
--
-- ⚠️ 이 컬럼이 곧 인증은 아니다. 월패드를 무엇으로 증명할지는 따로 풀어야
--    한다 (클라이언트 인증서가 유력하다 — nginx/cert/ 에 기반이 있다).
--    여기서 얻는 것은 **용량 상한**이지 거주 증명이 아니다.

SET @col := (SELECT COUNT(*) FROM information_schema.columns
              WHERE table_schema = DATABASE() AND table_name = 'rtc_homenet'
                AND column_name = 'complex_id');
SET @sql := IF(@col = 0,
  'ALTER TABLE rtc_homenet ADD COLUMN complex_id VARCHAR(16) NULL COMMENT ''단지 식별자(32비트 hex 8자). 서버가 자기 값으로 채운다''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- "이 동/호에 월패드가 있는가" 를 등록마다 확인하므로 조회 경로에 맞춘다.
SET @idx := (SELECT COUNT(*) FROM information_schema.statistics
              WHERE table_schema = DATABASE() AND table_name = 'rtc_homenet'
                AND index_name = 'idx_rtc_homenet_complex_place');
SET @sql := IF(@idx = 0,
  'ALTER TABLE rtc_homenet ADD KEY idx_rtc_homenet_complex_place (complex_id, building, unit)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- ── ③ mobile_enrollments — 미승인 대기 ──────────────────────────
--
-- **왜 rtc_mobiles 에 status 컬럼을 두지 않는가**
--
-- 그 표는 "이 세대가 인정한 단말" 이라는 자산이다. 여기 들어오는 것은
-- 익명의 누구나 만들 수 있는 임시 데이터다. 성격이 다른 둘을 한 표에 섞으면
--
--   - 상한이 조건부가 된다 (승인된 것만 4대인데 표 자체는 무제한)
--   - 모든 조회에 status 조건이 붙고, 한 군데라도 빠지면 미승인 단말이
--     착신 대상에 섞여 들어간다 — 조용히, 그리고 그게 이 마이그레이션이
--     막으려는 바로 그 사고다
--   - 지우기가 무서워진다 (잘못 지우면 진짜 등록이 날아간다)
--
-- 분리하면 이 표는 통째로 비워도 안전하다. TTL 이 지난 행은 그냥 사라진다.

CREATE TABLE IF NOT EXISTS mobile_enrollments (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- 어느 집에 들어가려는 요청인가. rtc_mobiles 와 같은 표기를 쓴다.
  complex_id  VARCHAR(16)  NULL,
  address     VARCHAR(128) NOT NULL,

  -- 승인되면 그대로 rtc_mobiles 로 옮겨 갈 등록 내용이다.
  -- 승인 순간에 단말이 다시 등록할 필요가 없도록 전부 담아 둔다.
  uuid        VARCHAR(191) NOT NULL,
  email       VARCHAR(255) NOT NULL,
  complex     VARCHAR(128) NOT NULL,
  token       VARCHAR(512) NOT NULL,
  phone       VARCHAR(32)      NULL,
  image       MEDIUMTEXT       NULL,
  sip_user    VARCHAR(64)      NULL,

  -- 월패드 승인 화면이 "어느 것이 내 폰인가" 를 가릴 수 있게 하는 값들.
  -- user_agent 는 요청 헤더에서 그냥 얻어지므로 앱을 고치지 않아도 된다.
  user_agent  VARCHAR(255)     NULL,
  ipaddress   VARCHAR(45)      NULL,

  requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- 살아 있는 기간. 월패드까지 걸어가기엔 충분하고, 방치된 요청은 스스로
  -- 사라진다. 조회는 늘 expires_at > NOW() 로 거르므로, 정리가 늦어도
  -- 만료된 행이 승인 목록에 보이는 일은 없다.
  expires_at   DATETIME NOT NULL,

  PRIMARY KEY (id),

  -- 같은 단말이 다시 요청하면 행이 늘지 않고 갱신된다.
  -- (앱이 재시도하거나 사용자가 등록을 여러 번 눌러도 목록이 지저분해지지 않는다)
  UNIQUE KEY uq_enroll_device (complex_id, address, uuid),

  -- 월패드가 자기 집 대기 목록을 읽는 경로.
  KEY idx_enroll_place (complex_id, address, expires_at),

  -- 만료 정리가 훑는 경로.
  KEY idx_enroll_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO schema_migrations (version) VALUES ('005-enrollment');
