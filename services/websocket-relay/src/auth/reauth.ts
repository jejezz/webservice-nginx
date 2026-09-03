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
    /**
     * 통과하지 못했다. `status` 를 그대로 응답 코드로 쓴다.
     *
     *   400 비밀번호를 안 보냈다
     *   403 비밀번호가 틀렸다        ← **401 이 아니다.** 아래를 보라
     *   401 세션이 유효하지 않다     (manager 가 우리 쿠키를 거절했다)
     *   429 시도가 너무 많다
     *   503 확인할 수 없다           (manager 가 안 뜸 · 이 기능이 없음)
     */
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

    if (res.status === 429) {
        return {
            ok: false, status: 429, error: body?.error ?? 'too_many_attempts',
            message: body?.message ?? '시도가 너무 많습니다. 잠시 후 다시 하세요.',
        };
    }
    if (res.status === 503) {
        return {
            ok: false, status: 503, error: body?.error ?? 'service_unavailable',
            message: body?.message ?? '인증 저장소에 접속할 수 없습니다.',
        };
    }

    /*
     * 비밀번호가 틀렸다 → **403 으로 돌려준다. 401 이 아니다.**
     *
     * manager 는 여기에 401 을 쓰지만, 그 값을 그대로 흘리면 대시보드가 삼킨다.
     * 화면의 API 클라이언트는 401 을 "세션이 끝났다" 로 읽고 **어떤 호출이든**
     * 로그인으로 보내기 때문이다 (web/src/lib/api.js). 그래서 비밀번호를 한 자
     * 틀리면 오류 문구 대신 다이얼로그가 그냥 사라지고, 사람은 무엇이 잘못됐는지
     * 알 수 없었다. 세션은 멀쩡한데 이번 동작만 거절된 것이므로 403 이 맞다.
     */
    if (res.status === 401 && (body?.error ?? 'invalid_password') === 'invalid_password') {
        return {
            ok: false, status: 403, error: 'invalid_password',
            message: body?.message ?? '비밀번호가 맞지 않습니다.',
        };
    }
    if (res.status === 401) {
        // invalid_password 가 아닌 401 은 manager 가 우리 쿠키를 거절한 것이다.
        // 이것은 진짜 세션 문제라 로그인으로 보내는 편이 맞다.
        return {
            ok: false, status: 401, error: body?.error ?? 'unauthorized',
            message: body?.message ?? '세션이 유효하지 않습니다. 다시 로그인하세요.',
        };
    }

    /*
     * 그 밖의 응답은 **비밀번호 문제가 아니다.**
     *
     * manager 가 이 기능을 갖고 있지 않으면 404 가 온다. 예전에는 그것까지
     * 401 로 접어 넣어서, 화면은 "세션 만료" 로 읽고 조용히 로그인으로 튕겼다 —
     * 겉으로는 다이얼로그가 사라지는 것 말고 아무 일도 일어나지 않는 것처럼
     * 보였고, 로그에도 "비밀번호 재확인 실패" 라고만 남아 원인이 가려졌다.
     */
    logger.error(
        `비밀번호 재확인: manager 가 예상 밖의 응답을 주었습니다 (HTTP ${res.status}) — ${config.manager.verifyPasswordUrl}`
    );
    return {
        ok: false, status: 503, error: 'reauth_unavailable',
        message: `manager 가 비밀번호 확인에 응답하지 않습니다 (HTTP ${res.status}). `
            + 'manager 가 이 기능을 지원하는 판인지, MANAGER_VERIFY_URL 이 맞는지 확인하세요.',
    };
}

export default verifyPassword;
