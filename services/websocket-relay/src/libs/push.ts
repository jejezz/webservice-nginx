/**
 * @file push.ts
 * @brief FCM 발송과 **토큰 건강 상태 기록**을 한 곳에 모은다.
 *
 * ── 왜 필요한가 ──────────────────────────────────────────────────
 * 발송하는 곳이 세 군데(방문자 호출 WS · /room/invite · SIP 착신)인데, 셋 다
 * `successCount` 만 로그에 남기고 **토큰별 결과를 보지 않았다.**
 *
 * 앱을 지웠거나 다시 깐 단말의 토큰은 FCM 이
 * `messaging/registration-token-not-registered` 로 분명히 알려 준다. 그걸
 * 버리고 있었으니 죽은 토큰이 영구히 남아, 초인종이 울릴 때마다 FCM 호출을
 * 낭비하고 성공률 로그를 흐렸다. 사람이 대시보드에서 지우기 전에는 줄지 않았다.
 *
 * ── 쓰기를 최소로 한다 ───────────────────────────────────────────
 * 정상 발송에서는 DB 를 **건드리지 않는다.** 실패했을 때, 그리고 예전에 실패로
 * 표시됐던 행이 이번에 성공했을 때만 쓴다. 대상 조회에서 `id` 를 함께 가져오게
 * 해서 갱신을 기본 키로 한다 — token 에는 인덱스가 없어 그 값으로 갱신하면
 * 발송마다 전체 스캔이 된다.
 */
import { TokenMessage } from 'firebase-admin/messaging';

import { Firebase } from './firebaseAdmin';
import { DbConn } from './dbConnection';
import config from '../config';
import logger from './logger';

/**
 * 푸시 대상 한 대.
 * 부르는 쪽은 `SELECT id, token, push_error ...` 로 뽑아 그대로 넘기면 된다.
 */
export interface PushTarget {
    id: number;
    token: string;
    /** 지금 DB 에 적혀 있는 실패 코드. 없으면 null. */
    push_error?: string | null;
}

/**
 * **이 코드만** 단말을 자동으로 내린다.
 *
 * 뜻이 하나뿐이라서다 — "이 토큰은 더 이상 그 단말의 것이 아니다". 다시 살아날
 * 일이 없으므로 계속 보내는 것은 낭비다.
 *
 * `messaging/invalid-argument` 는 넣지 않는다. 토큰이 잘못됐을 때도 나오지만
 * **메시지 자체가 잘못됐을 때도** 나온다. 후자라면 대상 전부를 한꺼번에 내리게
 * 되므로, 기록만 하고 판단은 사람에게 남긴다.
 */
const DEACTIVATE_ON = 'messaging/registration-token-not-registered';

/**
 * 여러 단말에 같은 메시지를 보내고, 결과를 토큰 건강 상태에 반영한다.
 *
 * **기다리지 않아도 된다.** 부르는 쪽이 트랜잭션을 쥐고 있는 경우(SIP 착신)를
 * 위해, 발송을 걸어 두고 바로 돌아갈 수 있게 Promise 를 돌려준다.
 *
 * @param targets 대상 목록 (id 와 token 이 있어야 한다)
 * @param message token 필드를 뺀 나머지가 채워진 메시지
 * @param label 로그에 남길 이름 (예: `초인종 1B101U`)
 */
export async function sendToTargets(
    targets: PushTarget[],
    message: TokenMessage,
    label: string
): Promise<void> {
    const usable = targets.filter((t) => t && t.token);
    if (usable.length === 0) {
        return;
    }

    const messaging = Firebase.getMessaging();
    if (!messaging) {
        logger.warn(`FCM 미설정 — ${label} 푸시를 보내지 않습니다.`);
        return;
    }

    let response: any;
    try {
        response = await messaging.sendEachForMulticast({
            ...message,
            tokens: usable.map((t) => t.token),
        });
    } catch (err: any) {
        // 발송 자체가 실패했다. 토큰 문제가 아니므로 아무 단말도 내리지 않는다.
        logger.error(`${label} 푸시 실패: ${err?.message ?? err}`);
        return;
    }

    const results: any[] = response?.responses ?? [];
    const deactivate: PushTarget[] = [];
    const failed: { target: PushTarget; code: string }[] = [];
    const recovered: PushTarget[] = [];

    usable.forEach((target, i) => {
        const r = results[i];
        if (r?.success) {
            // 예전에 실패로 표시된 행만 되돌린다. 정상 발송에서는 쓰지 않는다.
            if (target.push_error) {
                recovered.push(target);
            }
            return;
        }
        const code = String(r?.error?.code ?? 'unknown');
        if (code === DEACTIVATE_ON) {
            deactivate.push(target);
        } else {
            failed.push({ target, code });
        }
    });

    logger.info(
        `${label} 푸시: ${response.successCount}/${usable.length} 성공` +
        (deactivate.length ? ` · 무효 토큰 ${deactivate.length}대 비활성` : '') +
        (failed.length ? ` · 실패 ${failed.length}대` : '')
    );

    const table = config.tables.mobile;

    // DB 갱신이 실패해도 푸시 자체는 이미 끝났다. 여기서 던져 봐야 부르는 쪽이
    // 할 수 있는 일이 없으므로 기록만 남긴다.
    for (const t of deactivate) {
        try {
            await DbConn.execute(
                `UPDATE ${table} SET active = 0, push_error = ?, push_failed_at = NOW() WHERE id = ?`,
                [DEACTIVATE_ON, t.id]
            );
            logger.info(`단말 ${t.id}: FCM 이 모르는 토큰이라 비활성으로 내렸다`);
        } catch (err: any) {
            logger.error(`단말 ${t.id} 비활성 기록 실패: ${err.message}`);
        }
    }

    for (const { target, code } of failed) {
        try {
            await DbConn.execute(
                `UPDATE ${table} SET push_error = ?, push_failed_at = NOW() WHERE id = ?`,
                [code.slice(0, 64), target.id]
            );
        } catch (err: any) {
            logger.error(`단말 ${target.id} 실패 기록 실패: ${err.message}`);
        }
    }

    for (const t of recovered) {
        try {
            await DbConn.execute(
                `UPDATE ${table} SET push_error = NULL, push_failed_at = NULL WHERE id = ?`,
                [t.id]
            );
            logger.info(`단말 ${t.id}: 다시 도착해서 실패 표시를 지웠다`);
        } catch (err: any) {
            logger.error(`단말 ${t.id} 실패 표시 정리 실패: ${err.message}`);
        }
    }
}


/**
 * 토큰 하나에 보내고 **DB 는 건드리지 않는다.**
 *
 * ── 왜 sendToTargets 를 쓰면 안 되는가 ──────────────────────────
 * 위의 sendToTargets 는 발송 결과를 `rtc_mobiles ... WHERE id = ?` 로 되쓴다.
 * 그래서 `id` 는 **반드시 rtc_mobiles 의 기본 키**여야 한다.
 *
 * 그런데 등록 거절·만료 통보는 아직 rtc_mobiles 에 없는 단말에게 간다
 * (mobile_enrollments 에만 있다). 거기 id 를 그대로 넘기면 우연히 같은 번호를
 * 가진 **남의 단말 행이 비활성으로 내려간다.** 조용하고 재현하기 어려운 사고다.
 *
 * 그래서 되쓰기가 없는 길을 따로 둔다. 건강 상태를 기록하지 못하는 것은
 * 감수한다 — 어차피 그 단말은 아직 우리 표에 없다.
 *
 * @returns 보냈으면 true. 푸시가 꺼져 있거나 실패하면 false (던지지 않는다)
 */
export async function sendOne(token: string, message: TokenMessage, label: string): Promise<boolean> {
    if (!token) return false;

    const messaging = Firebase.getMessaging();
    if (!messaging) {
        logger.warn(`FCM 미설정 — ${label} 푸시를 보내지 않습니다.`);
        return false;
    }

    try {
        await messaging.send({ ...message, token });
        logger.info(`${label} 푸시 전송`);
        return true;
    } catch (err: any) {
        // 실패해도 부르는 쪽의 작업(승인·거절)은 이미 끝났다. 되돌리지 않는다.
        logger.warn(`${label} 푸시 실패: ${err?.message ?? err}`);
        return false;
    }
}
