-- 단말 SIP 번호 — 동/호 + 순번
--
-- database/database.ini 의 [database:rtc_relay] schema_dir 이 이 디렉토리를 가리킨다.
-- 적용은 `npm run db:migrate` (또는 sudo database/setup_mariadb.sh) 가 한다.
-- 여러 번 실행해도 안전해야 한다.
--
-- 규격 전체는 docs/identity.md 에 있다. 여기서는 표에 무엇이 더해지는지만 적는다.
--
-- ══ 무엇을 더하는가 ═════════════════════════════════════════════
--
--     0101 0805 01      101동 805호 1번 단말
--     └동4┘└호4┘└순번2┘
--
-- 세대번호(앞 8자리)는 address 에서 계산되므로 저장하지 않는다. 저장하면 두
-- 값이 어긋날 수 있고, 어긋나면 인터폰이 건 번호로 그 집을 못 찾는다.
-- 저장해야 하는 것은 **순번뿐**이다 — 그것만이 계산으로 나오지 않는다.
--
-- ══ 왜 UNIQUE 인가 — 002 의 판단을 뒤집는다 ══════════════════════
--
-- 002-sip-user.sql 은 "UNIQUE 를 걸지 않는다 — 한 내선에 휴대폰·태블릿이 함께
-- 붙을 수 있고, 그 경우 모두에게 푸시를 보내는 것이 맞다" 고 적었다. 그때는
-- 내선이 **세대**를 가리켰으므로 맞는 말이었다.
--
-- 이제 번호는 **단말**을 가리킨다. 한 내선 = 한 단말이고, 여럿에게 보내는 일은
-- 세대번호로 그 집 단말을 모아 하는 쪽이 맡는다. 그래서 중복은 이제 사고다 —
-- 두 단말이 같은 번호를 가지면 Kamailio 의 등록이 서로를 덮어쓰고, 한 대는
-- 조용히 전화를 못 받는다.
--
-- 그리고 중복을 막을 방법은 **제약뿐**이다. "비었나 보고 쓴다" 는 관리자 둘이
-- 같은 집을 동시에 승인하면 그대로 깨진다. 여기서 막으면 그때 INSERT 가
-- 실패하고, 부르는 쪽이 다음 번호로 다시 시도한다 (libs/sipNumber.ts).
--
-- NULL 은 여러 개 허용된다(MariaDB). 번호를 아직 못 받은 옛 단말들이 서로
-- 부딪히지 않는다.

SET @col := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'rtc_mobiles' AND column_name = 'sip_seq'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE rtc_mobiles ADD COLUMN sip_seq TINYINT UNSIGNED NULL COMMENT ''세대 안의 단말 순번. 00 월패드 · 01~04 모바일 (docs/identity.md)''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 한 세대에서 순번은 하나뿐이다. 단지까지 넣는 것은 한 DB 에 여러 단지가
-- 섞여 들어온 배치를 위해서다 (대시보드가 '다른 단지로 등록된 단말' 을 세는
-- 것과 같은 이유).
SET @idx := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'rtc_mobiles' AND index_name = 'uq_rtc_mobiles_sip_seq'
);
SET @sql := IF(@idx = 0,
  'CREATE UNIQUE INDEX uq_rtc_mobiles_sip_seq ON rtc_mobiles (complex_id, address, sip_seq)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

INSERT INTO schema_migrations (version) VALUES ('007-sip-number')
ON DUPLICATE KEY UPDATE version = version;
