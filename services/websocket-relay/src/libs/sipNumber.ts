/**
 * @file sipNumber.ts
 * @brief 동/호에서 SIP 번호를 만드는 **한 곳**. 규격은 docs/identity.md 에 있다.
 *
 *     0101 0805 01      101동 805호 1번 단말
 *     └동4┘└호4┘└순번2┘
 *
 * ── 왜 고정폭인가 ────────────────────────────────────────────────
 * 두 가지가 여기에 걸려 있다.
 *
 *   ① `1동 101호` 와 `11동 01호` 가 가변폭에서는 둘 다 `1101` 이 된다.
 *      두 집에 같은 번호가 나가고, 한 집은 남의 전화를 받는다.
 *   ② Kamailio 가 단말번호에서 세대번호를 되돌릴 때
 *      `$(tU{s.substr,0,8})` 로 앞 8자리를 자른다. 폭이 흔들리면 그 줄이
 *      조용히 엉뚱한 세대를 가리킨다 (services/kamailio/docs/incoming-call.md).
 *
 * ── 왜 단지가 없는가 ─────────────────────────────────────────────
 * 단지마다 서버와 SIP 도메인이 다르고 서버 간 통화가 없다. 단지를 가르는 일은
 * 도메인이 이미 하고 있으므로 번호에 또 넣을 이유가 없다. `complex_id` 는
 * 등록 절차에서만 쓴다 — 등록되지 않으면 어차피 통화가 되지 않는다.
 */
import { parseAddress } from './address';

/** 동·호 각각의 자릿수. */
export const PART_WIDTH = 4;
/** 순번 자릿수. */
export const SEQ_WIDTH = 2;

/** 세대번호 길이 (동4+호4). 인터폰이 거는 번호다. */
export const HOME_NUMBER_LEN = PART_WIDTH * 2;
/** 단말번호 길이 (세대8+순번2). */
export const DEVICE_NUMBER_LEN = HOME_NUMBER_LEN + SEQ_WIDTH;

/** 월패드 자리. 홈넷 등록 때 한 번 만들고 이후 건드리지 않는다. */
export const WALLPAD_SEQ = 0;
/** 모바일에 줄 수 있는 순번의 범위. */
export const MOBILE_SEQ_MIN = 1;
export const MOBILE_SEQ_MAX = 4;

/**
 * 한 세대가 인정할 수 있는 모바일 수.
 *
 * 상한을 두 곳에 적지 않는다 — 순번 대역에서 유도한다. 대역을 넓히면 상한도
 * 따라 넓어지고, 둘이 어긋나 "승인은 되는데 번호가 없는 단말" 이 생기지 않는다.
 */
export const MOBILE_CAPACITY = MOBILE_SEQ_MAX - MOBILE_SEQ_MIN + 1;

/** 숫자만, 그리고 자릿수 안에 들어오는가. */
function fits(part: string): boolean {
    return /^[0-9]+$/.test(part) && part.length <= PART_WIDTH;
}

/**
 * `101B805U` → `01010805`.
 *
 * **번호를 만들 수 없는 주소가 있다.** `ADDRESS_RE` 가 영문과 `-` 를 허용하므로
 * `A동` 같은 값이 들어올 수 있고, 5자리를 넘는 동/호도 있을 수 있다. 그런
 * 세대는 SIP 번호를 갖지 않는다 — 인터폰 착신만 못 받고 WebRTC 초인종 호출은
 * `address` 로 도므로 그대로 동작한다.
 *
 * @returns 8자리 숫자. 만들 수 없으면 null.
 */
export function homeNumber(address: string): string | null {
    const place = parseAddress(address);
    if (!place) return null;
    if (!fits(place.building) || !fits(place.unit)) return null;
    return place.building.padStart(PART_WIDTH, '0') + place.unit.padStart(PART_WIDTH, '0');
}

/** `('101B805U', 1)` → `0101080501`. 주소나 순번이 범위 밖이면 null. */
export function deviceNumber(address: string, seq: number): string | null {
    const home = homeNumber(address);
    if (home === null) return null;
    if (!Number.isInteger(seq) || seq < 0 || seq > 99) return null;
    return home + String(seq).padStart(SEQ_WIDTH, '0');
}

/** `0101080501` → `{ home: '01010805', seq: 1 }`. 형식이 아니면 null. */
export function splitDeviceNumber(value: string): { home: string; seq: number } | null {
    const v = (value ?? '').trim();
    if (v.length !== DEVICE_NUMBER_LEN || !/^[0-9]+$/.test(v)) return null;
    return {
        home: v.slice(0, HOME_NUMBER_LEN),
        seq: Number(v.slice(HOME_NUMBER_LEN)),
    };
}

/** 인터폰이 건 번호가 **세대**번호인가. 단말번호(10자리)와 길이로 가른다. */
export function isHomeNumber(value: string): boolean {
    const v = (value ?? '').trim();
    return v.length === HOME_NUMBER_LEN && /^[0-9]+$/.test(v);
}

/**
 * 이미 쓰이고 있는 순번들에서 **비어 있는 가장 작은** 모바일 순번을 고른다.
 *
 * 이것만으로는 중복을 막지 못한다 — 관리자 둘이 같은 집을 동시에 승인하면
 * 둘 다 같은 답을 얻는다. 실제 방어는 `uq_rtc_mobiles_sip_seq` 이고, 부르는
 * 쪽은 INSERT 가 중복으로 실패하면 이 함수를 다시 불러 다음 자리를 쓴다.
 *
 * @returns 순번. 자리가 없으면 null.
 */
export function nextFreeSeq(used: Iterable<number>): number | null {
    const taken = new Set<number>();
    for (const n of used) {
        if (Number.isInteger(n)) taken.add(Number(n));
    }
    for (let seq = MOBILE_SEQ_MIN; seq <= MOBILE_SEQ_MAX; seq++) {
        if (!taken.has(seq)) return seq;
    }
    return null;
}
