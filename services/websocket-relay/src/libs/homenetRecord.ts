/**
 * @file homenetRecord.ts
 * @brief 홈넷 장치(월패드) 행을 **만드는 규칙**. 입구가 둘이라 여기에 모은다.
 *
 * ── 왜 따로 있는가 ───────────────────────────────────────────────
 *   routes/register.ts     `POST /register/complex_agents`  장치가 스스로
 *   http/dashboardApi.ts   `POST /dashboard/api/homenet`    관리자가 손으로
 *
 * 이 표는 "그 집에 월패드가 있는가" 를 판단하는 근거다 (libs/enrollment.ts).
 * 동/호 형식 검사나 단지 채우기가 한쪽에만 있으면, 다른 입구로 들어온 행이
 * 모바일 등록의 상한을 조용히 무너뜨린다 — 형식이 자유로우면 행을 끝없이
 * 만들 수 있고, 공격자가 게이트를 직접 심고 그 주소로 등록하면 되기 때문이다.
 * 그래서 규칙은 여기 한 벌만 둔다 (libs/mobileRecord.ts 와 같은 이유).
 *
 * 두 입구는 **이미 있는 세대를 만났을 때만** 다르게 군다.
 *
 *   장치   upsert — 부팅할 때마다 부르므로 IP 갱신이 맞다
 *   관리자 create — 이미 있다고 알려 주는 편이 맞다. 손으로 넣는 값이라
 *                   조용히 덮어쓰면 무엇이 언제 바뀌었는지 아무도 모른다
 *
 * 이 모듈은 HTTP 를 모른다. 결과를 태그된 값으로 돌려주고, 상태 코드로 옮기는
 * 일은 각 라우트가 한다.
 */
import { DbConn } from './dbConnection';
import { complexId } from './complex';
import { PLACE_PART_RE } from './address';
import config from '../config';
import logger from './logger';

export type HomenetResult<T> =
    | { ok: true; value: T }
    /** 입력이 잘못됐다 → 400. `code` 는 응답의 `error` 로 나간다 */
    | { ok: false; kind: 'invalid'; code: string; message: string }
    /** 그 세대가 이미 있다 → 409 */
    | { ok: false; kind: 'duplicate'; code: string; message: string };

/** 이 표에 반드시 있어야 하는 값. `ipaddress` 는 빠져 있다 — 아래 참고. */
const REQUIRED = ['complex', 'type', 'building', 'unit'] as const;

export const PLACE_ERROR = 'building 과 unit 은 영문·숫자·- 8자 이내여야 합니다.';

/**
 * 홈넷 장치 행을 만들거나 갱신한다.
 *
 * `ipaddress` 는 없으면 `0.0.0.0` 으로 둔다. 관리자가 화면에서 미리 넣어 두는
 * 세대는 장치가 아직 붙기 전이라 IP 를 알 수 없다. 값이 쓰이는 곳은 목록
 * 표시뿐이고(실시간 조회는 방을 본다 — routes/register.ts 의 findip), 장치가
 * 처음 접속하면서 upsert 로 제 값을 채운다.
 *
 * @param mode 'upsert' 면 있는 세대를 갱신하고, 'create' 면 있다고 알린다.
 */
export async function saveHomenetRecord(
    body: any,
    mode: 'upsert' | 'create',
): Promise<HomenetResult<{ id: number; created: boolean }>> {
    const missing = REQUIRED.filter((k) => !body?.[k]);
    if (missing.length > 0) {
        return {
            ok: false, kind: 'invalid', code: 'missing_fields',
            message: `${missing.join(', ')} 은(는) 필수입니다.`,
        };
    }

    const complex = String(body.complex).trim();
    const type = String(body.type).trim();
    const building = String(body.building).trim();
    const unit = String(body.unit).trim();

    if (!PLACE_PART_RE.test(building) || !PLACE_PART_RE.test(unit)) {
        return { ok: false, kind: 'invalid', code: 'invalid_place', message: PLACE_ERROR };
    }

    const ipaddress = String(body.ipaddress ?? '').trim() || '0.0.0.0';

    /*
     * complex_id — 이 서버의 단지로 못박는다.
     *
     * 표시용 `complex` 는 자유 문자열이라 그것만으로는 단지를 셀 수 없다.
     * 모바일과 같은 규칙이다 (schema/004-complex-id.sql).
     */
    const id = complexId();

    /*
     * 중복 판정은 **표의 UNIQUE 가 아니라 등록이 보는 것**으로 한다.
     *
     * UNIQUE 는 (complex, building, unit) — 표시 이름이 열쇠에 들어 있다.
     * 그래서 같은 집을 "플루토 1단지" 와 "플루토1단지" 로 두 번 넣을 수 있고,
     * 모바일 등록은 (complex_id, building, unit) 으로 찾으므로 **둘 다 맞는
     * 세대로 본다.** 화면에서 지울 때 하나만 지우면 남은 행이 계속 문을 열어
     * 둔다. 그래서 손으로 넣는 쪽은 등록이 보는 것과 같은 조건으로 막는다.
     */
    if (mode === 'create') {
        const existing = await DbConn.select(
            `SELECT id FROM ${config.tables.homenet}
              WHERE complex_id <=> ? AND building = ? AND unit = ?`,
            [id, building, unit]);
        if (existing.length > 0) {
            return {
                ok: false, kind: 'duplicate', code: 'duplicate_place',
                message: `${building}동 ${unit}호는 이미 등록돼 있습니다.`,
            };
        }
    }

    // (complex, building, unit) 에 UNIQUE 가 걸려 있다.
    const result = await DbConn.execute(
        `INSERT INTO ${config.tables.homenet}
            (complex, complex_id, type, building, unit, ipaddress)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            complex_id = COALESCE(VALUES(complex_id), complex_id),
            type = VALUES(type), ipaddress = VALUES(ipaddress)`,
        [complex, id, type, building, unit, ipaddress]);

    // affectedRows 는 새로 넣었으면 1, 갱신했으면 2다 (ON DUPLICATE KEY UPDATE).
    const created = result.affectedRows === 1;
    logger.info(`homenet ${created ? 'registered' : 'updated'}: ${complex}/${building}/${unit}`);
    return { ok: true, value: { id: Number(result.insertId) || 0, created } };
}
