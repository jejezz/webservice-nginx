/**
 * @file address.ts
 * @brief 동/호 표기를 다루는 **한 곳**.
 *
 * 같은 집을 두 가지로 적고 있었다.
 *
 *   rtc_mobiles.address   `1B101U`            한 덩어리
 *   rtc_homenet           building='1', unit='101'   나뉘어 있음
 *
 * 둘을 오가는 규칙이 여기저기 흩어지면 반드시 어긋난다 — 그리고 그 어긋남은
 * "월패드는 등록돼 있는데 모바일 등록이 거부된다" 처럼, 원인을 짐작하기 어려운
 * 모양으로 나타난다. 그래서 변환을 이 파일에만 둔다.
 *
 * 표기의 근거: 사람에게 보여 줄 때 `B`→'동', `U`→'호' 로 바꾼다
 * (websocketService 의 방문자 호출 알림). 즉 `<동>B<호>U` 다.
 */

/** `1B101U` — 동은 숫자·영문, 호도 마찬가지. 길이를 묶어 쓰레기 값을 막는다. */
export const ADDRESS_RE = /^([A-Za-z0-9-]{1,8})B([A-Za-z0-9-]{1,8})U$/;

export const ADDRESS_ERROR = 'address 는 `1B101U` 형식이어야 합니다 (동B호U).';

/** 동·호 각각의 허용 형식. rtc_homenet 이 받는 값을 좁히는 데 쓴다. */
export const PLACE_PART_RE = /^[A-Za-z0-9-]{1,8}$/;

/**
 * WebSocket 이 실어 오는 주소를 등록 표기로 깎는다.
 *
 * 등록은 `1B101U` 로 오는데, WebSocket 클라이언트는 `iot:1B101U@호스트` 처럼
 * 접두사와 꼬리를 달고 온다. 비교하려면 같은 모양이어야 한다.
 */
export function normalizeAddress(raw: string): string {
    let v = (raw ?? '').trim();
    if (v.startsWith('iot:') || v.startsWith('rtc:')) v = v.slice(4);
    const at = v.indexOf('@');
    if (at >= 0) v = v.slice(0, at);
    return v.toUpperCase();
}

/** `1B101U` → `{ building: '1', unit: '101' }`. 형식이 아니면 null. */
export function parseAddress(address: string): { building: string; unit: string } | null {
    const m = ADDRESS_RE.exec(normalizeAddress(address));
    return m ? { building: m[1], unit: m[2] } : null;
}

/** `('1', '101')` → `1B101U`. */
export function formatAddress(building: string, unit: string): string {
    return `${String(building).trim()}B${String(unit).trim()}U`.toUpperCase();
}

/** 사람이 읽는 표기. `1B101U` → `1동 101호`. */
export function toKorean(address: string): string {
    const parsed = parseAddress(address);
    return parsed ? `${parsed.building}동 ${parsed.unit}호` : address;
}
