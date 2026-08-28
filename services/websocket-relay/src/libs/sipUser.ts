/**
 * @file sipUser.ts
 * @brief SIP 내선(sip_user) 검증. **여러 입구가 같은 규칙을 써야 한다.**
 *
 * 예전에는 이 규칙이 register.ts 안에만 있었고, 단말 관리 CRUD 는 sip_user 를
 * 아예 다루지 못했다. 두 입구가 생기면 규칙도 두 벌이 되기 쉬워서 여기에 모은다.
 */

/**
 * SIP 내선에 쓸 수 있는 문자.
 *
 * services/kamailio 의 subscriber 검증(USERNAME_RE)과 같게 맞춘다 — 이쪽에서만
 * 넓게 받으면 Kamailio 에 없는 내선이 저장되어, 푸시는 나가는데 통화는 안 되는
 * 상태가 된다. '@' 와 ':' 는 절대 허용하면 안 된다 (URI 와 해시 계산이 깨진다).
 */
export const SIP_USER_RE = /^[A-Za-z0-9._-]{1,64}$/;

export const SIP_USER_ERROR =
    'sip_user 는 영문·숫자·. _ - 만 쓸 수 있고 64자 이내여야 합니다.';

/**
 * 요청에서 온 sip_user 를 저장할 값으로 바꾼다.
 *
 * 세 가지를 구분한다.
 *   보내지 않음(undefined/null) → `null` → 부르는 쪽이 **기존 값을 건드리지 않는다**
 *   빈 문자열                   → `''`   → 연결 해제. 착신 푸시 조회에 걸리지 않는다
 *   값이 있음                   → 형식을 보고 그대로
 *
 * 안 보낸 것을 '지움' 으로 다루면, 이 필드를 모르는 옛 앱이 갱신할 때마다
 * 연결이 조용히 끊긴다. 그래서 '건드리지 않음' 을 기본으로 둔다.
 *
 * @returns `{ ok: true, value }` 또는 `{ ok: false }`
 */
export function normalizeSipUser(raw: unknown): { ok: true; value: string | null } | { ok: false } {
    if (raw === undefined || raw === null) {
        return { ok: true, value: null };
    }
    const v = String(raw).trim();
    if (v !== '' && !SIP_USER_RE.test(v)) {
        return { ok: false };
    }
    return { ok: true, value: v };
}
