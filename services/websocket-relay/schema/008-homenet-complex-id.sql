-- 홈넷 세대의 열쇠를 이름에서 코드로 옮긴다
--
-- database/database.ini 의 [database:rtc_relay] schema_dir 이 이 디렉토리를 가리킨다.
-- 적용은 `npm run db:migrate` (또는 sudo database/setup_mariadb.sh) 가 한다.
-- 여러 번 실행해도 안전해야 한다.
--
-- ══ 무엇이 문제였나 ═════════════════════════════════════════════
--
-- 001 이 건 열쇠는 `UNIQUE (complex, building, unit)` 였다. `complex` 는 사람이
-- 읽는 **표시 이름**이고, 월패드가 등록할 때 보내는 자유 문자열이다.
--
--     "플루토 1단지" 101동 805호
--     "플루토1단지"  101동 805호      ← 다른 집으로 들어간다
--
-- 같은 집이 두 행이 되고, 그 두 행이 각각 모바일 등록 게이트를 연다
-- (libs/enrollment.ts 의 no_wallpad 검사). 오타 한 번이 조용히 세대를 복제한다.
--
-- libs/homenetRecord.ts 는 이 위험을 이미 알고 있어서, 손으로 넣는 경로만
-- complex_id 로 중복을 확인하는 우회 코드를 갖고 있었다. 장치가 스스로 부르는
-- 경로(upsert)는 그 보호를 받지 못했다.
--
-- 004-complex-id.sql 이 모바일 쪽에서 내린 결론과 같다 — **이름이 아니라 코드다.**
-- 홈넷 표만 그 교훈을 아직 받지 않았을 뿐이다.
--
-- ══ 왜 complex_id 를 그대로 쓰지 않는가 ═════════════════════════
--
-- `complex_id` 는 NULL 일 수 있다. 단지가 하나뿐인 배치는 그 값을 설정하지 않고
-- 돌리며, 그때는 단지 검사를 하지 않는다 (libs/complex.ts).
--
-- 그런데 UNIQUE 는 **NULL 을 서로 다른 값으로 본다.** `(complex_id, building,
-- unit)` 에 그대로 걸면 complex_id 가 NULL 인 배치에서는 같은 동/호를 몇 번이든
-- 넣을 수 있다 — 고치려던 바로 그 구멍이 그대로 남는다.
--
-- 그래서 NULL 을 빈 문자열로 접은 값을 따로 두고 거기에 건다. 가상 컬럼이라
-- 저장 공간을 쓰지 않고 complex_id 와 어긋날 수도 없다.

-- 표시 이름은 이제 아무도 채우지 않는다. NOT NULL 을 풀어 둔다.
SET @nn := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'rtc_homenet'
     AND column_name = 'complex' AND is_nullable = 'NO'
);
SET @sql := IF(@nn > 0,
  'ALTER TABLE rtc_homenet MODIFY complex VARCHAR(128) NULL COMMENT ''옛 표시 이름. 더는 쓰지 않는다 (docs 참고)''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- NULL 을 접은 단지 키. 이 값에만 열쇠를 건다.
SET @col := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'rtc_homenet' AND column_name = 'complex_key'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE rtc_homenet ADD COLUMN complex_key VARCHAR(16) AS (COALESCE(complex_id, '''')) VIRTUAL',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 옛 열쇠(complex 가 들어 있는 것)를 걷어낸다. 이름으로 갈라져 있던 행이 있으면
-- 여기서 걸린다 — 그때는 사람이 어느 행을 남길지 정해야 하므로, 자동으로
-- 지우지 않고 마이그레이션이 실패하게 둔다.
SET @old := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'rtc_homenet'
     AND index_name = 'uq_rtc_homenet_place' AND column_name = 'complex'
);
SET @sql := IF(@old > 0, 'DROP INDEX uq_rtc_homenet_place ON rtc_homenet', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'rtc_homenet' AND index_name = 'uq_rtc_homenet_place'
);
SET @sql := IF(@idx = 0,
  'CREATE UNIQUE INDEX uq_rtc_homenet_place ON rtc_homenet (complex_key, building, unit)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

INSERT INTO schema_migrations (version) VALUES ('008-homenet-complex-id')
ON DUPLICATE KEY UPDATE version = version;
