/**
 * @file janusToken.ts
 * @brief 단말마다 다른 **Janus 토큰**을 발급하고 거둔다.
 *
 * ── 왜 필요한가 ──────────────────────────────────────────────────
 * 앱은 Janus 에 붙을 때 `apisecret` 을 싣는다. 그 값은 **단지에 하나**라 모든
 * 폰에 같은 값이 들어간다. 한 대에서 새면 그 단지의 게이트웨이 전체가 열리고,
 * 그 한 대만 막을 방법이 없다. 사람이 앱 설정에 손으로 넣어야 하는 것도 같은
 * 값 하나이기 때문이다.
 *
 * 승인 응답에는 이미 SIP 비밀번호가 실려 나간다 — 그쪽이 더 민감하다. 같은
 * 경로에 토큰을 얹으면 두 문제가 함께 사라진다.
 *
 * ── Janus 는 토큰을 **메모리에만** 갖고 있다 ─────────────────────
 * `add_token` 으로 넣은 값은 Janus 가 재시작하면 전부 사라진다. 그런데 우리
 * 표에는 남아 있으니 릴레이는 정상이라고 믿고, 모든 단말이 403 을 받는다 —
 * 조용히 전 세대 통화가 죽는 사고다.
 *
 * 그래서 두 겹을 둔다.
 *   ① 등록 응답을 만들 때마다 다시 넣는다 (`ensureForDevice`). 앱이 재등록하면
 *      스스로 복구된다. 이미 있으면 Janus 가 그냥 성공으로 답한다.
 *   ② 부팅할 때 표와 Janus 를 맞춘다 (`reconcile`). 릴레이가 나중에 뜬 경우를
 *      잡는다.
 * ①만으로는 릴레이가 살아 있는 채 Janus 만 재시작한 경우를 늦게 잡고,
 * ②만으로는 릴레이가 계속 떠 있는 동안의 재시작을 못 잡는다. 둘 다 있어야 한다.
 *
 * ── 던지지 않는다 ────────────────────────────────────────────────
 * Admin API 가 죽어 있어도 등록은 성공해야 한다. 이 파일의 함수는 실패를
 * null/false 로 돌려주고 기록만 남긴다 — 통화 하나 때문에 등록 전체를 실패시키면
 * 안 된다. `sip` 가 없어도 승인이 나가는 것과 같은 규칙이다.
 *
 * ── 토큰을 로그에 남기지 않는다 ──────────────────────────────────
 * 앞 6자와 길이만 남긴다. 원문이 로그에 있으면 로그를 읽을 수 있는 누구나 그
 * 단말이 된다.
 */
import crypto from 'crypto';
import fs from 'fs';

import { DbConn } from './dbConnection';
import config from '../config';
import logger from './logger';

/** 로그에 쓸 수 있는 형태. 원문은 절대 남기지 않는다. */
function brief(token: string): string {
    return `${token.slice(0, 6)}…(${token.length}자)`;
}

let adminSecret: string | null = null;
let secretError: string | null = null;

function loadAdminSecret(): string | null {
    if (adminSecret !== null || secretError !== null) return adminSecret;
    try {
        const value = fs.readFileSync(config.janus.adminSecretFile, 'utf8').split('\n')[0].trim();
        if (!value) throw new Error('파일이 비어 있습니다');
        adminSecret = value;
        return adminSecret;
    } catch (err: any) {
        secretError = `${config.janus.adminSecretFile}: ${err.message}`;
        logger.warn(`Janus admin secret 을 읽을 수 없습니다 (${secretError}) — 단말별 토큰을 발급하지 않습니다.`);
        return null;
    }
}

/** 토큰 발급이 켜져 있고 자격도 있는가. */
export function isEnabled(): boolean {
    return config.janus.tokenAuth && Boolean(loadAdminSecret());
}

/**
 * Admin API 를 한 번 부른다.
 *
 * **admin_port 는 루프백에만 열려 있어야 한다.** 이 문 하나로 세션 조회·토큰
 * 발급·핸들 강제 종료가 전부 된다 (services/janus/janus.transport.http.jcfg).
 */
async function adminCall(body: Record<string, unknown>): Promise<any | null> {
    const secret = loadAdminSecret();
    if (!secret) return null;

    try {
        const res = await fetch(config.janus.adminUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...body,
                transaction: crypto.randomBytes(6).toString('hex'),
                admin_secret: secret,
            }),
            signal: AbortSignal.timeout(config.janus.adminTimeoutMs),
        });
        const json: any = await res.json();
        if (json?.janus === 'error') {
            // 490 은 token_auth 가 꺼져 있다는 뜻이다. 설정을 켜기 전까지는
            // 이 경로가 통째로 조용히 실패하므로 그 사실이 보이게 남긴다.
            logger.warn(`Janus admin ${body.janus} 실패: ${json.error?.code} ${json.error?.reason}`);
            return null;
        }
        return json;
    } catch (err: any) {
        logger.warn(`Janus admin ${body.janus} 호출 실패: ${err?.message ?? err}`);
        return null;
    }
}

/**
 * 새 토큰 값. **최소 32바이트 난수**다.
 *
 * uuid·내선번호·이메일에서 유도하지 않는다 — 추측할 수 있는 토큰은 토큰이 아니다.
 */
function mint(): string {
    return crypto.randomBytes(32).toString('base64url');
}

/**
 * Janus 에 토큰을 넣는다. 이미 있으면 Janus 가 그냥 성공으로 답한다.
 *
 * `plugins` 를 **반드시 좁힌다.** 비워 두면 videoroom 등 그 Janus 에 올라간
 * 모든 플러그인이 이 토큰으로 열린다.
 */
async function add(token: string): Promise<boolean> {
    const r = await adminCall({
        janus: 'add_token',
        token,
        plugins: config.janus.tokenPlugins,
    });
    return Boolean(r);
}

/** Janus 에서 토큰을 거둔다. 없어도 오류로 보지 않는다. */
export async function remove(token: string | null | undefined): Promise<void> {
    if (!token || !isEnabled()) return;
    const r = await adminCall({ janus: 'remove_token', token });
    if (r) logger.info(`Janus 토큰 폐기 ${brief(token)}`);
}

/** 지금 Janus 가 들고 있는 토큰들. 못 읽으면 null (빈 배열과 구분해야 한다). */
export async function list(): Promise<string[] | null> {
    const r = await adminCall({ janus: 'list_tokens' });
    const tokens = r?.data?.tokens;
    if (!Array.isArray(tokens)) return null;
    return tokens.map((t: any) => String(t?.token ?? '')).filter(Boolean);
}

/**
 * 이 단말의 토큰을 보장한다. **있으면 그대로 쓰고 없을 때만 만든다.**
 *
 * `libs/sipAccount.ts` 의 `ensure` 와 같은 성질이다 — 재등록마다 값이 바뀌면
 * 앱은 매번 새 토큰을 저장해야 하고 그 사이 통화가 끊긴다.
 *
 * 값이 이미 있어도 **Janus 에는 다시 넣는다.** 그것이 재시작 대비의 ①이다.
 *
 * @returns 토큰. 발급이 꺼져 있거나 실패하면 null (등록은 계속 성공한다)
 */
export async function ensureForDevice(uuid: string): Promise<string | null> {
    if (!uuid || !isEnabled()) return null;

    let row: any;
    try {
        [row] = await DbConn.select(
            `SELECT id, janus_token, can_call FROM ${config.tables.mobile} WHERE uuid = ?`, [uuid]);
    } catch (err: any) {
        logger.warn(`Janus 토큰 조회 실패 (uuid=${uuid}): ${err.message}`);
        return null;
    }
    if (!row) return null;

    // 통화가 막힌 단말에는 발급하지도, 다시 넣지도 않는다. 권한과 토큰이
    // 어긋나면 권한만 끈 단말이 Janus 에는 계속 붙을 수 있다.
    if (row.can_call !== 1) return null;

    const existing: string | null = row.janus_token || null;
    const token = existing ?? mint();

    if (!(await add(token))) return existing;   // 넣지 못했다. 새 값을 저장하지 않는다.

    if (!existing) {
        try {
            await DbConn.execute(
                `UPDATE ${config.tables.mobile} SET janus_token = ? WHERE id = ?`, [token, row.id]);
            logger.info(`Janus 토큰 발급 단말 ${row.id} ${brief(token)}`);
        } catch (err: any) {
            // Janus 에는 들어갔는데 표에 못 적었다. 다음 등록에서 또 새로 만들고
            // 앞의 것은 재시작 때 사라진다 — 새는 것은 아니지만 남기긴 한다.
            logger.error(`Janus 토큰을 기록하지 못했습니다 (단말 ${row.id}): ${err.message}`);
            return token;
        }
    }
    return token;
}

/** 단말 행에서 토큰을 읽어 거둔다. 지우기 **전에** 부른다. */
export async function removeForDevice(where: { id?: number | string; uuid?: string }): Promise<void> {
    if (!isEnabled()) return;
    const [column, value] = where.id !== undefined ? ['id', where.id] : ['uuid', where.uuid];
    if (value === undefined || value === null || value === '') return;

    try {
        const [row] = await DbConn.select(
            `SELECT janus_token FROM ${config.tables.mobile} WHERE ${column} = ?`, [value]);
        await remove(row?.janus_token);
    } catch (err: any) {
        logger.warn(`Janus 토큰을 거두지 못했습니다 (${column}=${value}): ${err.message}`);
    }
}

/**
 * 표에 있는 토큰을 Janus 에 다시 넣는다. **부팅할 때 한 번 부른다.**
 *
 * 재시작 대비의 ②다. 릴레이가 Janus 보다 늦게 뜬 경우(둘 다 재부팅)를 잡는다.
 * 이미 있는 것은 Janus 가 성공으로 답하므로 그냥 다시 넣어도 된다 —
 * `list_tokens` 로 비교하는 것보다 짧고, 목록을 못 읽는 경우에도 동작한다.
 *
 * 통화가 막힌 단말(`can_call = 0`)은 넣지 않는다. 권한과 토큰이 어긋나면
 * 권한만 끈 단말이 Janus 에는 계속 붙을 수 있다.
 */
export async function reconcile(): Promise<void> {
    if (!isEnabled()) return;

    let rows: any[];
    try {
        rows = await DbConn.select(
            `SELECT id, janus_token FROM ${config.tables.mobile}
              WHERE janus_token IS NOT NULL AND janus_token <> '' AND can_call = 1`);
    } catch (err: any) {
        logger.warn(`Janus 토큰 재등록 대상을 읽지 못했습니다: ${err.message}`);
        return;
    }
    if (rows.length === 0) return;

    let ok = 0;
    for (const r of rows) {
        if (await add(r.janus_token)) ok++;
    }
    logger.info(`Janus 토큰 재등록: ${ok}/${rows.length}`);
}
