/**
 * @file reauth.ts
 * @brief 되돌리기 어려운 동작 앞에서 **비밀번호를 다시 확인**한다.
 *
 * ── 왜 세션만으로는 부족한가 ─────────────────────────────────────
 * 세션 쿠키는 로그인한 뒤 두 시간 동안 브라우저에 남아 있다. 자리를 비운 사이
 * 열려 있는 화면, 빌려준 노트북, 훔친 쿠키 — 어느 쪽이든 "지금 이 사람이 맞나"
 * 를 말해 주지 못한다. 단말 하나를 지우는 정도면 그 위험을 감수할 만하지만,
 * 단지 ID 처럼 **한 번 잘못 누르면 단지 전체가 전화를 못 받는** 동작은 다르다.
 *
 * ── 왜 서버가 확인하는가 ─────────────────────────────────────────
 * 화면에서 비밀번호를 받아 manager 에 물어보고, 통과하면 우리 API 를 부르는
 * 방식은 **아무것도 막지 못한다.** 공격자는 그 단계를 건너뛰고 우리 API 를
 * 바로 부르면 된다. 그래서 비밀번호를 우리가 받아, 우리가 manager 에 물어본다.
 *
 * manager 의 `/verify-password` 는 세션 소유자의 비밀번호만 확인하고
 * (아무나 부르는 비밀번호 확인기가 아니다), 실패를 로그인과 같은 IP 잠금 통에
 * 넣는다. 그래서 여기서 시도 횟수를 따로 셀 필요가 없다.
 */
import { Request } from 'express';
import config from '../config';
import logger from '../libs/logger';

export type ReauthResult =
    | { ok: true }
    /** 비밀번호가 틀렸거나 세션이 유효하지 않다 → 401 */
    | { ok: false; status: number; error: string; message: string };

/**
 * 요청을 보낸 사람의 비밀번호가 맞는지 manager 에 물어본다.
 *
 * **요청의 쿠키를 그대로 넘긴다.** manager 는 그 쿠키로 사람을 특정하고 그
 * 사람의 비밀번호만 본다. 즉 남의 비밀번호로는 통과할 수 없다.
 */
export async function verifyPassword(req: Request, password: string): Promise<ReauthResult> {
    if (!password) {
        return { ok: false, status: 400, error: 'missing_password', message: '비밀번호를 입력하세요.' };
    }

    let res: Response;
    try {
        res = await fetch(config.manager.verifyPasswordUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // 사람을 특정하는 것은 이 쿠키다. 없으면 manager 가 401 을 준다.
                Cookie: req.headers.cookie ?? '',
            },
            body: JSON.stringify({ password }),
            signal: AbortSignal.timeout(5000),
        });
    } catch (err: any) {
        // manager 가 내려가 있으면 **통과시키지 않는다.** 확인할 수 없는 것은
        // 확인되지 않은 것이다 — 여기서 열어 주면 manager 를 죽이는 것이
        // 곧 이 검사를 없애는 방법이 된다.
        logger.error(`비밀번호 재확인 실패 (manager 에 닿지 못함): ${err?.message ?? err}`);
        return {
            ok: false, status: 503, error: 'manager_unreachable',
            message: 'manager 에 확인할 수 없어 진행하지 않습니다. manager 가 떠 있는지 보세요.',
        };
    }

    if (res.ok) return { ok: true };

    const body: any = await res.json().catch(() => ({}));
    return {
        ok: false,
        // 429(시도 초과)와 401(틀림)을 그대로 전달해 화면이 구분해 말할 수 있게 한다.
        status: res.status === 429 ? 429 : res.status === 503 ? 503 : 401,
        error: body?.error ?? 'invalid_password',
        message: body?.message ?? '비밀번호가 맞지 않습니다.',
    };
}

export default verifyPassword;
