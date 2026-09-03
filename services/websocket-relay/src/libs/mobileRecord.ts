/**
 * @file mobileRecord.ts
 * @brief 단말 등록 행을 **만들고 고치는 규칙**. 입구가 둘이라 여기에 모은다.
 *
 * ── 왜 따로 있는가 ───────────────────────────────────────────────
 * 같은 일을 하는 입구가 둘이다.
 *
 *   routes/mobile.ts        `/mobile-crud-operation`  — 내부 도구
 *   http/dashboardApi.ts    `/dashboard/api/mobiles`  — 관리 화면
 *
 * 통합 전에는 관리 화면(무번들 대시보드)이 앞의 것을 직접 불렀고, React 화면은
 * 조회·토글·삭제만 할 수 있었다. 대시보드를 한 벌로 합치면서 React 쪽에도
 * 생성·수정을 넣어야 했는데, 그 규칙을 복사하면 **이번에 없앤 종류의 중복이
 * 그대로 되살아난다** — sip_user 형식이나 token_updated_at 처리 같은 것들이
 * 두 곳에서 조용히 갈라진다. 그래서 규칙은 여기 한 벌만 둔다.
 *
 * 이 모듈은 HTTP 를 모른다. 결과를 태그된 값으로 돌려주고, 상태 코드로 옮기는
 * 일은 각 라우트가 한다.
 */
import { DbConn } from './dbConnection';
import { complexId } from './complex';
import { normalizeSipUser, SIP_USER_ERROR } from './sipUser';
import config from '../config';
import logger from './logger';

export type MobileResult<T> =
    | { ok: true; value: T }
    /** 입력이 잘못됐다 → 400 */
    | { ok: false; kind: 'invalid'; message: string }
    /** uuid 가 이미 있다 → 409 */
    | { ok: false; kind: 'duplicate'; message: string }
    /** 대상 행이 없다 → 404 */
    | { ok: false; kind: 'notFound'; message: string };

/**
 * 갱신 가능한 컬럼 **화이트리스트**.
 *
 * req.body 의 키를 그대로 쓰면 컬럼 이름이 요청에서 오게 되므로 SQL 에 사용자
 * 입력이 섞인다. 값은 플레이스홀더로 가더라도 컬럼 이름은 그렇지 않다.
 */
const UPDATABLE = ['uuid', 'email', 'complex', 'address', 'token', 'phone', 'image', 'active', 'sip_user'] as const;

/** 생성에 반드시 있어야 하는 값. */
const REQUIRED = ['uuid', 'email', 'complex', 'address', 'token'] as const;

/**
 * 새 단말 등록 행을 만든다.
 *
 * complex_id 는 요청에서 받지 않고 **이 서버의 단지**로 넣는다. 관리 화면에서
 * 만드는 행은 늘 이 단지 것이기 때문이다 (libs/complex.ts).
 */
export async function createMobileRecord(body: any): Promise<MobileResult<{ id: number }>> {
    const missing = REQUIRED.filter((k) => !body?.[k]);
    if (missing.length > 0) {
        return { ok: false, kind: 'invalid', message: `Missing required fields: ${missing.join(', ')}` };
    }

    const sipUser = normalizeSipUser(body?.sip_user);
    if (!sipUser.ok) return { ok: false, kind: 'invalid', message: SIP_USER_ERROR };

    const active = body?.active === undefined ? true : Boolean(body.active);

    try {
        const result = await DbConn.execute(
            `INSERT INTO ${config.tables.mobile}
                (uuid, email, complex, complex_id, address, token, phone, image, active, sip_user, token_updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
            [body.uuid, body.email, body.complex, complexId(), body.address, body.token,
             body.phone ?? null, body.image ?? null, active ? 1 : 0, sipUser.value]
        );
        logger.info(`Mobile record created with ID: ${result.insertId}`);
        return { ok: true, value: { id: result.insertId } };
    } catch (err: any) {
        if (err.code === 'ER_DUP_ENTRY') {
            return { ok: false, kind: 'duplicate', message: 'uuid already registered' };
        }
        throw err;
    }
}

/**
 * 있는 행을 고친다. 보내지 않은 컬럼은 건드리지 않는다.
 *
 * 두 가지 뒷정리가 붙는다.
 *
 *   token 을 바꿨다   → token_updated_at 갱신 + 옛 실패 표시 삭제.
 *                       손으로 넣은 새 토큰에 옛 실패 코드가 남으면 화면이
 *                       "푸시 안 됨" 이라고 거짓말을 한다.
 *   active 를 정했다  → 실패 표시만 삭제. 사람이 이 행을 맡았다는 뜻이므로,
 *                       다음 /register 의 자동 복구가 그 판단을 뒤집지 않게 한다
 *                       (routes/register.ts 의 UPSERT 주석 참고).
 */
export async function updateMobileRecord(id: string | number, body: any): Promise<MobileResult<{ id: number }>> {
    // sip_user 는 형식이 정해져 있다 — /register 와 같은 규칙을 쓴다.
    // 여기서만 넓게 받으면 Kamailio 에 없는 내선이 저장되어, 푸시는 나가는데
    // 통화는 안 되는 상태가 된다.
    let sipUserValue: string | null | undefined;
    if (body?.sip_user !== undefined) {
        const parsed = normalizeSipUser(body.sip_user);
        if (!parsed.ok) return { ok: false, kind: 'invalid', message: SIP_USER_ERROR };
        sipUserValue = parsed.value;
    }

    const sets: string[] = [];
    const params: any[] = [];
    for (const col of UPDATABLE) {
        const v = col === 'sip_user' ? sipUserValue : body?.[col];
        if (v === undefined) continue;
        sets.push(`${col} = ?`);
        params.push(col === 'active' ? (v ? 1 : 0) : v);
    }

    if (body?.token !== undefined) {
        sets.push('token_updated_at = NOW()', 'push_error = NULL', 'push_failed_at = NULL');
    } else if (body?.active !== undefined) {
        sets.push('push_error = NULL', 'push_failed_at = NULL');
    }

    if (sets.length === 0) {
        return { ok: false, kind: 'invalid', message: 'No fields to update' };
    }
    params.push(id);

    try {
        const result = await DbConn.execute(
            `UPDATE ${config.tables.mobile} SET ${sets.join(', ')} WHERE id = ?`, params);
        if (result.affectedRows === 0) {
            return { ok: false, kind: 'notFound', message: 'Mobile record not found' };
        }
        logger.info(`Mobile record updated: ID ${id}`);
        return { ok: true, value: { id: Number(id) } };
    } catch (err: any) {
        if (err.code === 'ER_DUP_ENTRY') {
            return { ok: false, kind: 'duplicate', message: 'uuid already registered' };
        }
        throw err;
    }
}

/** 실패 종류를 HTTP 상태 코드로 옮긴다. 두 라우트가 같은 표를 쓰도록. */
export function statusFor(kind: 'invalid' | 'duplicate' | 'notFound'): number {
    return kind === 'invalid' ? 400 : kind === 'duplicate' ? 409 : 404;
}
