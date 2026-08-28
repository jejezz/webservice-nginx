/**
 * @file enrollmentEvents.ts
 * @brief 등록 요청이 생겼을 때 **누구에게 알릴지**.
 *
 * 두 곳에 알린다.
 *
 *   월패드   지금 열려 있는 WebSocket 으로 즉시. 승인 화면을 띄우라는 뜻이다.
 *   기존 단말 FCM 으로. "우리 집에 새 기기가 등록을 요청했다" 를 알아야
 *            모르는 사이에 승인되는 일을 눈치챌 수 있다.
 *
 * ── 월패드가 꺼져 있으면 ─────────────────────────────────────────
 * 이벤트는 사라진다. 그래도 괜찮다 — 대기 목록은 DB 에 있으므로, 월패드가
 * 다시 붙을 때 `pendingFor()` 로 받아 가면 된다 (websocketService 의 IoT
 * 방 생성 경로에서 부른다). **이벤트를 저장해 두지 않는 것이 핵심이다.**
 * 저장하면 그 큐를 또 관리해야 하는데, 진실은 이미 대기 표에 있다.
 */
import { TokenMessage } from 'firebase-admin/messaging';

import { DbConn } from './dbConnection';
import { complexId } from './complex';
import { listPending } from './enrollment';
import { sendToTargets, PushTarget } from './push';
import { getGateway } from '../gateway';
import { normalizeAddress } from './address';
import config from '../config';
import logger from './logger';

/** WebSocket 으로 나가는 이벤트 이름. 월패드가 이 값으로 분기한다. */
export const ENROLL_EVENT = 'enroll.pending';

/** 그 세대의 월패드(IoT 방의 initiator)를 찾는다. 없으면 null. */
function findWallpad(address: string) {
    const gateway = getGateway();
    if (!gateway) return null;

    const want = normalizeAddress(address);
    for (const room of gateway.roomTable.roomTable.values()) {
        if (room.kind !== 'iot') continue;
        for (const client of room.clients.values()) {
            // initiator 가 방을 만든 쪽 = 월패드다. 모바일은 뒤에 들어온다.
            if (client.initiator && normalizeAddress(client.getAddress()) === want) {
                return client;
            }
        }
    }
    return null;
}

/** 월패드가 접속할 때 건네줄 대기 목록. 이벤트를 놓쳤어도 여기서 따라잡는다. */
export async function pendingFor(address: string): Promise<any[]> {
    try {
        return await listPending(normalizeAddress(address));
    } catch (err: any) {
        logger.error(`대기 목록 조회 실패 (${address}): ${err.message}`);
        return [];
    }
}

/**
 * 대기 중인 등록이 있다고 월패드에 알린다.
 *
 * 목록 전체를 실어 보낸다. 개수만 보내면 월패드가 다시 물어봐야 하고, 목록이
 * 세대당 4건뿐이라 그 왕복을 아낄 이유가 없다.
 */
export async function notifyWallpad(address: string): Promise<boolean> {
    const client = findWallpad(address);
    if (!client) return false;

    try {
        client.send({
            method: ENROLL_EVENT,
            address: normalizeAddress(address),
            pending: await pendingFor(address),
        } as any);
        return true;
    } catch (err: any) {
        logger.warn(`월패드에 등록 이벤트를 보내지 못했습니다 (${address}): ${err.message}`);
        return false;
    }
}

/**
 * 이미 승인된 단말들에게 "새 기기가 등록을 요청했다" 를 알린다.
 *
 * 막지는 못하지만 **알게 한다.** 계정이 탈취돼 조용히 승인되는 상황에서,
 * 집에 있는 사람의 폰이 울리는 것이 유일한 신호일 수 있다.
 * 첫 등록이면 받을 사람이 없다 — 그건 정상이다.
 */
async function notifyExistingDevices(address: string, email: string): Promise<void> {
    let rows: any[];
    try {
        rows = await DbConn.select(
            `SELECT id, token, push_error FROM ${config.tables.mobile}
              WHERE address = ? AND complex_id <=> ? AND active = 1 AND can_call = 1 AND token <> ''`,
            [normalizeAddress(address), complexId()]);
    } catch (err: any) {
        logger.error(`등록 알림 대상 조회 실패 (${address}): ${err.message}`);
        return;
    }
    if (rows.length === 0) return;

    const message: TokenMessage = {
        token: '',
        notification: {
            title: '새 기기 등록 요청',
            body: `${email} 이(가) 우리 집에 기기를 등록하려고 합니다. 월패드에서 확인하세요.`,
        },
        data: {
            method: ENROLL_EVENT,
            address: normalizeAddress(address),
            email,
        },
        android: {
            // 초인종과 달리 지금 당장 받아야 하는 알림이 아니다. 소리도 따로 두지 않는다.
            priority: 'normal',
            notification: { channelId: config.firebase.channelId },
        },
    };

    const targets: PushTarget[] = rows.map((r) => ({
        id: Number(r.id), token: r.token, push_error: r.push_error,
    }));
    await sendToTargets(targets, message, `등록 요청 알림 ${normalizeAddress(address)}`);
}

/**
 * 등록 요청이 대기에 오른 직후에 부른다.
 *
 * 실패해도 등록 자체는 이미 받아 뒀다. 그래서 던지지 않고 기록만 한다 —
 * 알림이 안 갔다고 요청을 되돌리면 사용자는 이유 없이 실패한 것으로 본다.
 */
export async function onEnrollmentPending(address: string, email = ''): Promise<void> {
    try {
        const reached = await notifyWallpad(address);
        logger.info(`등록 대기 알림: ${normalizeAddress(address)} — 월패드 ${reached ? '전달' : '미접속(다음 접속 때 전달)'}`);
        await notifyExistingDevices(address, email);
    } catch (err: any) {
        logger.error(`등록 대기 알림 실패 (${address}): ${err.message}`);
    }
}
