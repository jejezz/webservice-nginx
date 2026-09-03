/**
 * @file clientCert.ts
 * @brief nginx 가 검증한 클라이언트 인증서(mTLS) 결과를 읽는다.
 *
 * ── 왜 헤더로 오나 ───────────────────────────────────────────────
 * nginx 가 443 에서 TLS 를 끊고 이 서버에는 평문으로 넘긴다. 그래서 백엔드는
 * 클라이언트 인증서를 직접 볼 수 없다 — nginx 가 알려 줘야만 안다.
 *
 * nginx/generate_nginx_conf.py 가 프록시하는 모든 location 에 넣는다:
 *
 *     proxy_set_header X-SSL-Client-Verify $ssl_client_verify;
 *     proxy_set_header X-SSL-Client-DN     $ssl_client_s_dn;
 *
 * ── 이 헤더를 믿어도 되는 이유 ───────────────────────────────────
 * `proxy_set_header` 는 클라이언트가 같은 이름으로 보낸 헤더를 **덮어쓴다.**
 * 값이 빈 문자열이면 nginx 는 그 헤더를 아예 보내지 않으므로, 클라이언트가
 * 붙여 보낸 것도 함께 사라진다. 실측으로 확인했다:
 *
 *     인증서 없음 + `X-SSL-Client-Verify: SUCCESS` 를 붙여 보냄  ->  NONE
 *     정상 인증서 + `X-SSL-Client-DN: CN=attacker` 를 붙여 보냄  ->  진짜 DN
 *
 * **단, nginx 를 거쳤을 때만이다.** 이 서버는 루프백에만 묶여 있지만, 같은
 * 기계 안에서 127.0.0.1:28099 로 직접 붙으면 nginx 를 우회하고 헤더도 마음대로
 * 붙일 수 있다. 그래서 이것을 유일한 인증 수단으로 쓰면 안 된다 —
 * 사람 확인(세대·승인 상태)은 DB 로 계속 해야 한다.
 *
 * ── 지금은 무엇도 막지 않는다 ────────────────────────────────────
 * nginx 가 `verify_client = optional` 이라 인증서가 없어도 통과한다. 이 파일은
 * **읽기만** 한다. 강제는 발급 경로(CSR)를 만든 뒤의 일이다.
 * 설계는 docs/multi-complex.md 를 보라.
 */

import type { Request } from 'express';

/** nginx 의 `$ssl_client_verify` 가 낼 수 있는 값. */
export type ClientCertVerify =
    /** 검증 통과. */
    | 'SUCCESS'
    /** 인증서를 내밀지 않았다. `optional` 일 때 정상적으로 나오는 값이다. */
    | 'NONE'
    /** 내밀었으나 우리 CA 로 검증되지 않았다 (만료·폐기·다른 CA). */
    | 'FAILED'
    /** 헤더 자체가 없다 — nginx 를 거치지 않았거나 mTLS 설정이 꺼져 있다. */
    | 'ABSENT';

export interface ClientCertInfo {
    verify: ClientCertVerify;
    /** 인증서 주체. 예: `OU=a3f19c04,CN=device-12345`. 없으면 null. */
    dn: string | null;
    /** 검증을 통과한 인증서를 제시했는가. 이것만으로 인가를 판단하지 말 것. */
    verified: boolean;
}

/**
 * `$ssl_client_verify` 는 실패 사유를 붙여 `FAILED:reason` 형태로 오기도 한다.
 * 앞부분만 본다.
 */
function parseVerify(raw: string | undefined): ClientCertVerify {
    if (!raw) return 'ABSENT';
    const head = raw.split(':')[0].trim().toUpperCase();
    if (head === 'SUCCESS' || head === 'NONE' || head === 'FAILED') return head;
    return 'ABSENT';
}

/** 요청에 실려 온 클라이언트 인증서 정보. 헤더가 없으면 `ABSENT` 다. */
export function clientCert(req: Request): ClientCertInfo {
    const verify = parseVerify(req.header('X-SSL-Client-Verify') ?? undefined);
    const dn = req.header('X-SSL-Client-DN') || null;
    return {
        verify,
        // DN 은 검증에 성공했을 때만 의미가 있다. 실패한 인증서의 주체를
        // 그대로 들고 다니면 어딘가에서 신원으로 오해하기 쉽다.
        dn: verify === 'SUCCESS' ? dn : null,
        verified: verify === 'SUCCESS',
    };
}

/**
 * 이 배치에서 mTLS 가 실제로 도는가.
 *
 * 헤더가 오면 nginx 가 클라이언트 인증서를 물어보고는 있다는 뜻이다
 * (`NONE` 이어도 물어본 것이다). 헤더 자체가 없으면 꺼져 있거나 nginx 를
 * 거치지 않은 요청이다.
 */
export function mtlsActive(req: Request): boolean {
    return parseVerify(req.header('X-SSL-Client-Verify') ?? undefined) !== 'ABSENT';
}
