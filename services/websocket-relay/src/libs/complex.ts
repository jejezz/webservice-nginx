/**
 * @file complex.ts
 * @brief 이 서버가 맡은 **단지**의 신원을 다루는 규칙들.
 *
 * ── 무엇을 푸는가 ────────────────────────────────────────────────
 * 서버는 단지마다 한 대씩 설치되지만, 앱은 앱스토어에서 한 벌로 배포된다.
 * 그래서 앱은 자기가 어느 단지인지 어디선가 받아 와야 하고(디렉터리),
 * 서버는 들어온 등록이 **자기 단지 것인지** 확인할 수 있어야 한다.
 *
 * ── 이 값은 인증이 아니다 ────────────────────────────────────────
 * 단지 ID 는 앱이 디렉터리에서 받아 오는 값이므로 앱을 깐 누구나 알 수 있다.
 * 그래서 **라우팅 키**로만 쓴다 — "이 등록이 이 서버로 올 것이 맞나" 를 보는
 * 안전망이지, "이 사람이 그 집 사람인가" 를 가리지는 못한다. 후자는 별도의
 * 일회용 등록 토큰이 필요하다 (docs/multi-complex.md).
 *
 * ── 이름이 아니라 코드다 ─────────────────────────────────────────
 * rtc_mobiles.complex 는 사람이 읽는 이름이라 바뀔 수 있다. 조회 키로 쓰면
 * 명칭이 바뀔 때 등록된 단말이 전부 떨어져 나간다. 그래서 바뀌지 않는 값을
 * 따로 둔다. 이름에서 해시로 유도하지 않고 중앙에서 **할당**한다.
 *
 * 값 자체를 읽고 검사하는 일은 config 가 한다 — 이 파일은 그 값을 **쓰는**
 * 규칙만 갖는다.
 */
import config, { COMPLEX_ID_RE, COMPLEX_ID_ERROR } from '../config';
import { DbConn } from './dbConnection';
import { setEnvValue } from './envFile';
import logger from './logger';

export { COMPLEX_ID_RE, COMPLEX_ID_ERROR };

/**
 * 이 서버가 맡은 단지. 설정하지 않으면 `null` 이고, 그때는 단지 검사를
 * **하지 않는다** — 단지가 하나뿐인 배치를 그대로 돌리기 위해서다.
 *
 * ── 왜 상수가 아니라 함수로 꺼내는가 ─────────────────────────────
 * 대시보드에서 바꿀 수 있게 되면서 값이 프로세스 수명 동안 고정이 아니게 됐다.
 * 예전처럼 `export const COMPLEX_ID` 로 두면 이 모듈을 import 한 파일들이
 * **모듈 로드 시점의 값을 각자 복사해 갖는다.** 그러면 여기서 바꿔도
 * register.ts 는 옛 값으로 계속 검사하고, 그 어긋남은 "등록은 되는데 전화가
 * 안 온다" 로만 드러난다 — 찾기 가장 어려운 종류의 버그다.
 *
 * 그래서 값을 꺼내는 길을 함수 하나로 좁힌다. 부르는 쪽은 매번 지금 값을 본다.
 */
let current: string | null = config.complexId;

/** 지금 이 서버가 맡은 단지. 매 호출마다 최신 값이다. */
export function complexId(): string | null {
    return current;
}

/**
 * 단지를 바꾼다. **되돌리기 어려운 동작이다.**
 *
 * 이 값이 바뀌면 지금 등록된 단말의 `complex_id` 와 어긋나, 그 단말들이
 * 착신 대상 조회에서 통째로 빠진다. 각 단말이 앱을 열어 다시 등록하기 전까지
 * 전화를 받지 못한다. 부르는 쪽(대시보드 API)이 영향 대수를 사람에게 보여 주고
 * 확인을 받은 뒤에만 부른다.
 *
 * `.env` 에도 함께 적어 재시작 후에도 유지되게 한다. 메모리만 바꾸면 다음
 * 재시작에 조용히 옛 값으로 돌아간다.
 */
export function setComplexId(next: string | null, actor: string): void {
    const before = current;
    current = next;

    // .env 는 서비스가 소유하는 파일이라 여기서 고쳐도 된다.
    // 실패하면 메모리 값은 이미 바뀐 상태이므로, 던져서 부르는 쪽이 알게 한다.
    setEnvValue('COMPLEX_ID', next ?? '');

    logger.warn(
        `[audit] 단지 ID 변경: ${before ?? '(없음)'} → ${next ?? '(없음)'} (by ${actor})`,
    );
}

/**
 * 푸시 대상 조회에 붙일 단지 조건.
 *
 * 단지가 설정돼 있지 않으면 빈 조각을 돌려주므로, 부르는 쪽은 조건을 그대로 이어
 * 붙이기만 하면 된다.
 *
 * @example
 *   const c = complexClause();
 *   const sql = `SELECT ... WHERE address = ? AND active = 1${c.sql}`;
 *   const params = [address, ...c.params];
 */
export function complexClause(): { sql: string; params: string[] } {
    const id = complexId();
    return id
        ? { sql: ' AND complex_id = ?', params: [id] }
        : { sql: '', params: [] };
}

/**
 * agent 문자열 `rtc:1B101U@...` 의 `@` 뒤에서 단지 ID 를 꺼낸다.
 *
 * 그 자리는 지금까지 **버려지고 있었다** (websocketService 의 getAddressFrom 이
 * `rtc:` 와 `@` 사이만 뽑는다). 인터폰들은 거기에 호스트 이름을 넣어 보내고
 * 있으므로, **단지 ID 형식일 때만** 값으로 인정한다. 그래야 지금 동작하는
 * 인터폰을 깨지 않고 옮겨 갈 수 있다.
 *
 * @returns 단지 ID, 또는 없거나 형식이 아니면 null
 */
export function complexFromAgent(agent: string): string | null {
    const at = (agent ?? '').indexOf('@');
    if (at < 0) return null;
    const tail = agent.slice(at + 1).trim().toLowerCase();
    return COMPLEX_ID_RE.test(tail) ? tail : null;
}

/**
 * agent 문자열이 **다른 단지**를 가리키는지 본다.
 *
 * 옛 형식(호스트 이름)이거나 이 서버에 단지가 없으면 false — 즉
 * 판단하지 않는다. 확실히 다를 때만 true 다.
 */
export function pointsToAnotherComplex(agent: string): boolean {
    const id = complexId();
    if (!id) return false;
    const found = complexFromAgent(agent);
    return found !== null && found !== id;
}

/**
 * 기동할 때 complex_id 가 비어 있는 행을 이 서버의 값으로 채운다.
 *
 * 서버 한 대가 한 단지를 맡으므로, 이 DB 에 이미 있는 행은 모두 이 단지 것이다.
 * SQL 마이그레이션은 .env 를 모르므로 여기서 한다. 여러 번 실행해도 안전하다.
 */
export async function backfillComplexId(): Promise<void> {
    const id = complexId();
    if (!id || !DbConn.isConfigured()) return;

    try {
        const r = await DbConn.execute(
            `UPDATE ${config.tables.mobile} SET complex_id = ? WHERE complex_id IS NULL`,
            [id]
        );
        if (r.affectedRows > 0) {
            logger.info(`단지 ID 를 채웠습니다: ${r.affectedRows}개 단말 → ${id}`);
        }
    } catch (err: any) {
        // 채우지 못해도 서버는 뜬다. 그 행들은 조회에 걸리지 않을 뿐이고,
        // 단말이 다시 /register 하면 채워진다.
        logger.error(`단지 ID backfill 실패: ${err.message}`);
    }
}
