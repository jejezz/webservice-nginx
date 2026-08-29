/**
 * @file enrollment.ts
 * @brief 단말 등록 **승인** 규칙. 거주 증명이 여기서 이뤄진다.
 *
 * ── 무엇을 푸는가 ────────────────────────────────────────────────
 * 이전에는 `/register/mobile` 이 uuid·email·complex·address·token 만 받고
 * 곧바로 `rtc_mobiles` 에 넣었다. 인증도 횟수 제한도 없었으므로, **단지 +
 * 동 + 호 세 값만 알면 그 집 초인종 영상·음성을 받고 방문자와 대화까지 됐다.**
 * 세 값 중 비밀은 하나도 없다 — 단지 ID 는 공개 디렉터리에 있고 동/호는
 * 건물에 적혀 있다.
 *
 * 그 집 안에 물리적으로 있는 것은 **월패드뿐**이다. 그래서 신뢰의 뿌리를
 * 월패드로 옮긴다.
 *
 *     등록 요청  →  mobile_enrollments (대기).  아무 권한 없음
 *     승인       →  rtc_mobiles 로 이동.        can_call / can_control 이 켜진다
 *
 * ── 왜 대기를 다른 표에 두는가 ───────────────────────────────────
 * `rtc_mobiles` 는 "이 세대가 인정한 단말" 이라는 자산이고, 대기는 익명의
 * 누구나 만들 수 있는 임시 데이터다. 한 표에 섞으면 조회마다 status 조건이
 * 붙고 **한 군데라도 빠지면 미승인 단말이 착신 대상에 조용히 섞인다** —
 * 정확히 이 모듈이 막으려는 사고다. 나누면 대기 표는 통째로 비워도 안전하다.
 *
 * ── 상한을 구조로 건다 ───────────────────────────────────────────
 * `/register` 가 무인증인 이상 아무나 행을 만들 수 있으므로, 갯수를 코드가 아니라
 * 구조로 묶는다 (schema/005-enrollment.sql 의 머리말 참고).
 */
import { DbConn } from './dbConnection';
import { complexId } from './complex';
import { normalizeAddress, parseAddress, toKorean, ADDRESS_ERROR } from './address';
import { sendToTargets, sendOne } from './push';
import { TokenMessage } from 'firebase-admin/messaging';
import config from '../config';
import logger from './logger';
import * as deviceCert from './deviceCert';

/** 한 세대가 인정할 수 있는 단말 수. */
export const MAX_APPROVED_PER_HOME = 4;

/**
 * 한 세대의 대기 슬롯 수.
 *
 * 승인된 것과 따로 센다. 대기는 아무나 만들 수 있으므로 여기에도 상한이
 * 없으면 표가 무제한이 된다.
 */
export const MAX_PENDING_PER_HOME = 4;

/**
 * 대기가 살아 있는 시간.
 *
 * 월패드까지 걸어가기엔 충분하고, 방치된 요청은 스스로 사라진다. 조회는 늘
 * `expires_at > NOW()` 로 거르므로 정리가 늦어도 만료된 것이 목록에 보이지 않는다.
 */
export const PENDING_TTL_MS = 30 * 60 * 1000;

/** 등록 요청이 담고 있는 것. 승인되면 이대로 rtc_mobiles 로 옮겨 간다. */
export interface EnrollmentPayload {
    uuid: string;
    email: string;
    complex: string;
    address: string;
    token: string;
    phone?: string | null;
    image?: string | null;
    sip_user?: string | null;
}

/**
 * 승인된 단말에게 클라이언트 인증서를 발급하고 기록을 남긴다.
 *
 * **승인된 단말에만 부른다.** 이 함수는 그 확인을 하지 않는다 — 부르는 쪽이
 * 이미 rtc_mobiles 에 있는 행을 손에 쥐고 있어야 한다.
 *
 * 주체는 서버가 아는 값으로 쓴다. CSR 에 적힌 것은 보지 않는다 (deviceCert.ts).
 *
 * @returns 인증서 PEM. CA 가 없거나 CSR 이 잘못됐으면 null — 발급만 안 될 뿐
 *          등록 자체는 성공으로 둔다. mTLS 는 아직 선택적 기능이다.
 */
export async function issueDeviceCert(
    uuid: string,
    csrPem: string,
): Promise<string | null> {
    const issued = deviceCert.sign(csrPem, { uuid, complexId: complexId() });
    if (!issued) return null;

    try {
        await DbConn.execute(
            `UPDATE ${config.tables.mobile}
                SET cert_serial = ?, cert_issued_at = NOW(), cert_expires_at = ?
              WHERE uuid = ? AND complex_id <=> ?`,
            [issued.serial, issued.expiresAt, uuid, complexId()]);
    } catch (err: any) {
        // 기록만 실패한 것이다. 인증서는 이미 유효하게 만들어졌으므로 내려준다.
        // 여기서 막으면 006-device-cert.sql 을 아직 적용하지 않은 배치에서
        // 발급이 통째로 멈춘다.
        logger.warn(`인증서 발급 기록에 실패했습니다 (uuid=${uuid}): ${err.message}`);
    }
    return issued.pem;
}

/** 요청을 누가 어디서 보냈는지. 월패드 승인 화면이 단말을 가리는 데 쓴다. */
export interface RequestMeta {
    userAgent?: string | null;
    ipaddress?: string | null;
}

export type EnrollmentResult =
    /** 이미 승인된 단말이 토큰을 갱신했다. 권한은 그대로다. */
    | { kind: 'refreshed'; id: number }
    /** 대기 목록에 올랐다. 월패드가 승인해야 쓸 수 있다. */
    | { kind: 'pending'; id: number; expiresAt: string }
    /** 받아 줄 수 없다. */
    | { kind: 'rejected'; reason: 'home_full' | 'no_wallpad' | 'bad_address'; message: string };


/**
 * 요청한 단말에게 결과를 알린다.
 *
 * ── 왜 필요한가 ──────────────────────────────────────────────────
 * 이게 없으면 앱은 202(대기)를 받은 뒤 **아무 일도 일어나지 않는 것처럼**
 * 보인다. 월패드에서 승인이 끝나도 앱은 모르고, 사용자는 고장으로 받아들인다.
 * 등록 흐름의 마지막 한 칸이다.
 *
 * ── 왜 권한 검사를 우회하는가 ────────────────────────────────────
 * 승인 직후의 단말은 `can_call` 이 꺼져 있을 수 있고(통화는 막고 제어만 준
 * 경우), 거절·만료된 단말은 아예 rtc_mobiles 에 없다. 일반 푸시 조회를 쓰면
 * 정작 결과를 알아야 할 단말에 닿지 못한다. 그래서 토큰으로 직접 보낸다.
 *
 * 이 메시지는 **알림 하나** 이상의 권한을 주지 않는다 — 대상이 자기 등록의
 * 결과를 받는 것뿐이다.
 */
type EnrollOutcome = 'approved' | 'rejected' | 'expired';

const OUTCOME_TEXT: Record<EnrollOutcome, { title: string; body: (place: string) => string }> = {
    approved: {
        title: '등록이 승인되었습니다',
        body: (place) => `${place} 기기 등록이 승인되었습니다.`,
    },
    rejected: {
        title: '등록이 거절되었습니다',
        body: (place) => `${place} 기기 등록 요청이 거절되었습니다.`,
    },
    expired: {
        title: '등록 요청이 만료되었습니다',
        body: (place) => `${place} 등록 요청이 승인되지 않아 만료되었습니다. 다시 시도하세요.`,
    },
};

function outcomeMessage(
    outcome: EnrollOutcome,
    address: string,
    grants?: { canCall: boolean; canControl: boolean },
): TokenMessage {
    const text = OUTCOME_TEXT[outcome];
    return {
        token: '',
        notification: { title: text.title, body: text.body(toKorean(address)) },
        data: {
            // 앱은 이 값으로 대기 화면을 닫는다. FCM data 는 값이 전부 문자열이어야 한다.
            method: `enroll.${outcome}`,
            address,
            ...(grants ? { canCall: String(grants.canCall), canControl: String(grants.canControl) } : {}),
        },
        android: {
            // 초인종과 달리 지금 당장 받아야 하는 알림은 아니다.
            priority: 'normal',
            notification: { channelId: config.firebase.channelId },
        },
    };
}

/** `expires_at` 에 넣을 값. DB 시계가 아니라 앱 시계를 쓴다 (둘 다 같은 호스트다). */
function expiryFromNow(): Date {
    return new Date(Date.now() + PENDING_TTL_MS);
}

/** 이 세대가 이미 인정한 단말 수. */
export async function countApproved(rawAddress: string): Promise<number> {
    const id = complexId();
    const address = normalizeAddress(rawAddress);
    const [row] = await DbConn.select(
        `SELECT COUNT(*) AS n FROM ${config.tables.mobile}
          WHERE address = ? AND complex_id <=> ?`, [address, id]);
    return Number(row.n) || 0;
}

/**
 * 등록 요청을 받는다.
 *
 * **이미 승인된 단말이면 그냥 갱신한다.** 앱은 토큰이 바뀔 때마다 다시 등록하는데,
 * 그때마다 승인을 다시 받게 하면 쓸 수 없는 물건이 된다. uuid 가 단말의 신원이므로
 * 그것으로 가른다.
 */
export async function requestEnrollment(
    payload: EnrollmentPayload,
    meta: RequestMeta = {},
): Promise<EnrollmentResult> {
    const id = complexId();
    const address = normalizeAddress(payload.address);

    // ── 주소 형식 ──
    //
    // 형식을 안 보면 `address` 에 아무 문자열이나 들어와 표가 무한히 늘어난다.
    // 여기서 거르면 주소 공간이 실제 동/호 조합으로 묶인다.
    const place = parseAddress(address);
    if (!place) {
        return { kind: 'rejected', reason: 'bad_address', message: ADDRESS_ERROR };
    }

    // ── 이미 인정된 단말인가 ──
    const known = await DbConn.select(
        `SELECT id FROM ${config.tables.mobile} WHERE uuid = ?`, [payload.uuid]);

    if (known.length > 0) {
        await DbConn.execute(
            `UPDATE ${config.tables.mobile}
                SET email = ?, complex = ?, address = ?, complex_id = COALESCE(?, complex_id),
                    phone = ?, image = COALESCE(?, image),
                    sip_user = COALESCE(?, sip_user),
                    token_updated_at = IF(token <> ?, NOW(), token_updated_at),
                    push_error = IF(token <> ?, NULL, push_error),
                    push_failed_at = IF(token <> ?, NULL, push_failed_at),
                    active = IF(token <> ? AND push_error IS NOT NULL, 1, active),
                    token = ?
              WHERE uuid = ?`,
            [payload.email, payload.complex, address, id,
             payload.phone ?? null, payload.image ?? null, payload.sip_user ?? null,
             payload.token, payload.token, payload.token, payload.token,
             payload.token, payload.uuid]);
        logger.info(`등록 갱신: ${payload.uuid} (${address})`);
        return { kind: 'refreshed', id: Number(known[0].id) };
    }

    // ── 그 집에 월패드가 있는가 ──
    //
    // ⚠️ 이것은 **거주 증명이 아니다.** 실재하는 집은 전부 월패드가 등록돼
    //    있으므로, 동/호를 아는 공격자는 이 검사를 그대로 통과한다. 실제
    //    방어는 아래의 '승인 없이는 아무 권한 없음' 이 한다.
    //
    //    여기서 얻는 것은 **용량 상한**이다 — 존재하지 않는 주소로 대기 행을
    //    만들 수 없으므로, 표 크기가 실제 세대 수에 묶인다.
    //
    //    방(roomTable)이 아니라 rtc_homenet 을 본다. 방은 메모리에 있고 비면
    //    사라지므로, 월패드가 재부팅하는 동안 등록이 막힐 것이다.
    const home = await DbConn.select(
        `SELECT id FROM ${config.tables.homenet}
          WHERE complex_id <=> ? AND building = ? AND unit = ?`,
        [id, place.building, place.unit]);

    if (home.length === 0) {
        return {
            kind: 'rejected', reason: 'no_wallpad',
            message: '이 동/호에 등록된 월패드가 없습니다. 댁내 월패드가 서버에 연결된 뒤 다시 시도하세요.',
        };
    }

    // ── 새 단말 ──
    //
    // 정원이 찼으면 대기에 올리지 않는다. 올려 봐야 승인할 수 없고, 사람에게는
    // "승인을 기다리는 중" 으로 보여 원인을 알 수 없게 만든다.
    if (await countApproved(address) >= MAX_APPROVED_PER_HOME) {
        return {
            kind: 'rejected', reason: 'home_full',
            message: `이 세대에 등록할 수 있는 단말은 ${MAX_APPROVED_PER_HOME}대까지입니다. 월패드나 관리자 화면에서 쓰지 않는 단말을 지우고 다시 시도하세요.`,
        };
    }

    const expiresAt = expiryFromNow();

    // 같은 단말의 재요청은 행이 늘지 않고 갱신된다 (UNIQUE uq_enroll_device).
    // 앱이 재시도하거나 사용자가 여러 번 눌러도 월패드 목록이 지저분해지지 않는다.
    const result = await DbConn.execute(
        `INSERT INTO mobile_enrollments
            (complex_id, address, uuid, email, complex, token, phone, image, sip_user,
             user_agent, ipaddress, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            email = VALUES(email), complex = VALUES(complex), token = VALUES(token),
            phone = VALUES(phone), image = VALUES(image), sip_user = VALUES(sip_user),
            user_agent = VALUES(user_agent), ipaddress = VALUES(ipaddress),
            requested_at = NOW(), expires_at = VALUES(expires_at)`,
        [id, address, payload.uuid, payload.email, payload.complex, payload.token,
         payload.phone ?? null, payload.image ?? null, payload.sip_user ?? null,
         meta.userAgent ?? null, meta.ipaddress ?? null, expiresAt]);

    // 대기 슬롯이 넘치면 **거절이 아니라 가장 오래된 것을 밀어낸다.**
    //
    // 거절로 두면 공격자가 슬롯을 채워 진짜 주민의 등록을 막을 수 있다.
    // 축출 방식이면 방금 들어온 요청이 늘 최신이라 살아남는다.
    await evictOverflow(address);

    logger.info(`등록 대기: ${payload.uuid} (${address}) — 월패드 승인 필요`);
    return {
        kind: 'pending',
        id: Number(result.insertId) || 0,
        expiresAt: expiresAt.toISOString(),
    };
}

/** 세대별 대기 슬롯을 넘긴 만큼 오래된 것부터 지운다. */
async function evictOverflow(address: string): Promise<void> {
    const id = complexId();
    const rows = await DbConn.select(
        `SELECT id FROM mobile_enrollments
          WHERE address = ? AND complex_id <=> ? AND expires_at > NOW()
          ORDER BY requested_at DESC, id DESC`, [address, id]);

    const overflow = rows.slice(MAX_PENDING_PER_HOME);
    for (const row of overflow) {
        await DbConn.execute('DELETE FROM mobile_enrollments WHERE id = ?', [row.id]);
    }
    if (overflow.length > 0) {
        logger.info(`대기 슬롯 초과로 ${overflow.length}건을 밀어냈습니다 (${address})`);
    }
}

/** 대기 목록. 만료된 것은 보이지 않는다. address 를 주면 그 세대만. */
export async function listPending(address?: string): Promise<any[]> {
    const id = complexId();
    const where = address ? 'AND address = ?' : '';
    const params = address ? [id, address] : [id];
    // token 과 image 는 싣지 않는다 — 승인 화면이 쓸 일이 없고, token 은 FCM 자격이다.
    return DbConn.select(
        `SELECT id, complex_id, address, uuid, email, complex, phone, sip_user,
                user_agent, ipaddress, requested_at, expires_at
           FROM mobile_enrollments
          WHERE complex_id <=> ? AND expires_at > NOW() ${where}
          ORDER BY requested_at DESC`, params);
}

export type ApproveResult =
    | { ok: true; id: number; address: string; uuid: string }
    | { ok: false; reason: 'not_found' | 'home_full'; message: string };

/**
 * 대기 중인 요청을 인정한다. 행을 `rtc_mobiles` 로 옮긴다.
 *
 * @param grants 무엇을 열어 줄지. 둘 다 끄면 등록만 되고 아무것도 못 한다.
 * @param actor  'wallpad' 또는 관리자 계정 이름
 */
export async function approve(
    enrollmentId: number,
    grants: { canCall: boolean; canControl: boolean },
    actor: string,
): Promise<ApproveResult> {
    const id = complexId();
    const rows = await DbConn.select(
        `SELECT * FROM mobile_enrollments
          WHERE id = ? AND complex_id <=> ? AND expires_at > NOW()`, [enrollmentId, id]);

    if (rows.length === 0) {
        return { ok: false, reason: 'not_found', message: '대기 중인 등록 요청이 아닙니다 (이미 처리됐거나 만료됐습니다).' };
    }
    const e: any = rows[0];

    // 승인 시점에 다시 센다. 대기하는 동안 다른 단말이 먼저 승인됐을 수 있다.
    if (await countApproved(e.address) >= MAX_APPROVED_PER_HOME) {
        return {
            ok: false, reason: 'home_full',
            message: `이 세대는 이미 ${MAX_APPROVED_PER_HOME}대가 등록되어 있습니다. 쓰지 않는 단말을 지우고 다시 승인하세요.`,
        };
    }

    const inserted = await DbConn.execute(
        `INSERT INTO ${config.tables.mobile}
            (uuid, email, complex, complex_id, address, token, phone, image, sip_user,
             active, can_call, can_control, approved_at, approved_by, token_updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NOW(), ?, NOW())`,
        [e.uuid, e.email, e.complex, e.complex_id, e.address, e.token,
         e.phone, e.image, e.sip_user,
         grants.canCall ? 1 : 0, grants.canControl ? 1 : 0, actor]);

    await DbConn.execute('DELETE FROM mobile_enrollments WHERE id = ?', [enrollmentId]);

    /*
     * 승인됐다고 알린다. **여기서는 sendToTargets 를 쓴다** — 이 단말은 방금
     * rtc_mobiles 에 들어갔으므로 id 가 유효하고, 죽은 토큰이면 그 사실이
     * 바로 기록된다 (앱을 지웠다 다시 깐 뒤 승인하는 경우가 있다).
     *
     * 기다리지 않는다. 푸시가 늦거나 실패해도 승인 자체는 이미 끝났다.
     */
    void sendToTargets(
        [{ id: Number(inserted.insertId), token: e.token, push_error: null }],
        outcomeMessage('approved', e.address, grants),
        `등록 승인 통보 ${e.address}`,
    );

    logger.warn(
        `[audit] 단말 승인: ${e.address} ${e.email} (uuid=${e.uuid}) ` +
        `통화=${grants.canCall ? '허용' : '불가'} 제어=${grants.canControl ? '허용' : '불가'} (by ${actor})`);

    return { ok: true, id: enrollmentId, address: e.address, uuid: e.uuid };
}

/** 대기 요청을 거절한다. 그냥 지운다 — 남겨 둘 이유가 없다. */
export async function reject(enrollmentId: number, actor: string): Promise<boolean> {
    const id = complexId();
    const rows = await DbConn.select(
        `SELECT address, email, uuid, token FROM mobile_enrollments WHERE id = ? AND complex_id <=> ?`,
        [enrollmentId, id]);
    if (rows.length === 0) return false;

    await DbConn.execute('DELETE FROM mobile_enrollments WHERE id = ?', [enrollmentId]);
    logger.warn(`[audit] 등록 요청 거절: ${rows[0].address} ${rows[0].email} (by ${actor})`);

    // 거절도 알려야 앱이 기다리기를 멈춘다.
    // 이 단말은 rtc_mobiles 에 없으므로 되쓰기 없는 길로 보낸다 (push.ts 의 sendOne).
    void sendOne(rows[0].token, outcomeMessage('rejected', rows[0].address), `등록 거절 통보 ${rows[0].address}`);
    return true;
}

/**
 * 만료된 대기를 지운다.
 *
 * 조회가 이미 `expires_at > NOW()` 로 거르므로 이건 **디스크 정리**일 뿐,
 * 안전에 필요한 것이 아니다. 그래서 실패해도 조용히 넘어간다.
 */
export async function pruneExpired(): Promise<number> {
    if (!DbConn.isConfigured()) return 0;
    try {
        // 지우기 전에 대상을 읽는다. 지운 뒤에는 누구에게 알려야 할지 알 수 없다.
        const expired = await DbConn.select(
            'SELECT address, token FROM mobile_enrollments WHERE expires_at <= NOW()');

        const r = await DbConn.execute('DELETE FROM mobile_enrollments WHERE expires_at <= NOW()');
        if (r.affectedRows > 0) {
            logger.info(`만료된 등록 대기 ${r.affectedRows}건을 정리했습니다.`);
        }

        // 만료도 알린다. 안 그러면 앱이 영영 '승인 대기 중' 으로 남는다.
        for (const row of expired) {
            void sendOne(row.token, outcomeMessage('expired', row.address), `등록 만료 통보 ${row.address}`);
        }
        return r.affectedRows;
    } catch (err: any) {
        logger.error(`등록 대기 정리 실패: ${err.message}`);
        return 0;
    }
}

/** 주기적으로 정리한다. 프로세스를 붙들지 않도록 unref 한다. */
export function startPruneTimer(intervalMs = 10 * 60 * 1000): void {
    void pruneExpired();
    setInterval(() => { void pruneExpired(); }, intervalMs).unref();
}


/**
 * 이 세대에 **제어를 허용받은 단말이 있는가.**
 *
 * ── 왜 세대 단위인가 (그리고 그 한계) ───────────────────────────
 * WebSocket 메시지에는 단말 식별자(uuid)가 없다. IoT 클라이언트가 스스로
 * 밝히는 것은 주소(`rtc:2B202U@...`)뿐이라, "이 소켓이 어느 등록 행인가" 를
 * 서버가 알 수 없다. 그래서 지금 강제할 수 있는 것은 세대 단위다.
 *
 *   막는 것    제어를 아무에게도 허용하지 않은 세대로의 제어
 *   못 막는 것 같은 세대 안에서 제어가 꺼진 단말 하나만 골라 막기
 *
 * 완전한 단말 단위 강제는 WS 핸드셰이크가 uuid(또는 등록 토큰)를 실어 와야
 * 가능하다 — 앱 변경이 필요하다. 그때까지 이 검사는 "한 겹 더" 이지
 * "충분한 한 겹" 이 아니다. 제어의 실질적 관문은 여전히 RoomID 다.
 *
 * 제어 메시지마다 DB 를 때리지 않도록 짧게 캐시한다. 권한을 끈 뒤 최대
 * 이 시간만큼은 이전 판정이 남는다.
 */
const CONTROL_CACHE_MS = 30_000;
const controlCache = new Map<string, { allowed: boolean; at: number }>();

export async function homeAllowsControl(rawAddress: string): Promise<boolean> {
    const address = normalizeAddress(rawAddress);
    const hit = controlCache.get(address);
    if (hit && Date.now() - hit.at < CONTROL_CACHE_MS) return hit.allowed;

    let allowed = false;
    try {
        const [row] = await DbConn.select(
            `SELECT COUNT(*) AS n FROM ${config.tables.mobile}
              WHERE address = ? AND complex_id <=> ? AND can_control = 1`,
            [address, complexId()]);
        allowed = (Number(row.n) || 0) > 0;
    } catch (err: any) {
        // DB 가 끊겼다. **막지 않는다** — 홈넷 제어는 집 안에서 쓰는 기능이고,
        // DB 장애로 조명이 안 켜지는 편이 더 나쁘다. 로그로 남긴다.
        logger.error(`제어 권한 조회 실패 (${address}) — 통과시킨다: ${err.message}`);
        return true;
    }

    controlCache.set(address, { allowed, at: Date.now() });
    return allowed;
}

/** 권한을 바꾼 뒤 부른다. 캐시 때문에 30초간 옛 판정이 남는 것을 막는다. */
export function invalidateControlCache(rawAddress?: string): void {
    if (rawAddress) controlCache.delete(normalizeAddress(rawAddress));
    else controlCache.clear();
}
