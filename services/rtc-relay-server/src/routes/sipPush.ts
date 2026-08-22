/**
 * @file sipPush.ts
 * @brief Kamailio 가 부르는 착신 푸시 엔드포인트.
 *
 * ── 언제 불리는가 ────────────────────────────────────────────────
 * NAT 안의 인터폰이 Kamailio 를 통해 모바일로 걸었는데, 모바일이 자고 있어
 * 등록 상태가 아닐 때입니다. Kamailio 는 그 INVITE 를 tsilo 로 붙들어 두고
 * (발신자에게는 100 Trying 을 이미 보낸 상태) 여기로 요청을 던집니다.
 *
 *   인터폰 ──INVITE(1001)──▶ Kamailio
 *                            ├─ lookup 실패 → ts_store()
 *                            └─ POST /rtc-relay/sip-push  ← 여기
 *                                        │
 *                                   FCM ─┴─▶ 단말 기동
 *                                              │
 *                            ◀──REGISTER(WSS)──┘
 *                            └─ ts_append() → 붙들어 둔 INVITE 전달 → 벨
 *
 * ── 왜 rtc-relay-server 인가 ─────────────────────────────────────
 * FCM 자격 증명·토큰 테이블·발송 코드가 전부 이미 여기 있습니다. Kamailio 쪽에
 * 또 만들 이유가 없고, 토큰은 한 곳에서만 다루는 편이 안전합니다.
 *
 * ── 접근 제어 ────────────────────────────────────────────────────
 * 이 경로는 **루프백에서만** 받습니다. Kamailio 가 같은 호스트에 있고,
 * 외부에 열면 남의 단말을 임의로 깨울 수 있게 됩니다.
 * (mobile-crud-operation 과 같은 이유이고, 거기서 배운 대로 X-Forwarded-For 는
 *  믿지 않고 소켓의 실제 주소만 봅니다)
 */
import { Router, Request, Response } from 'express';
import { TokenMessage } from 'firebase-admin/messaging';

import { DbConn } from '../libs/dbConnection';
import { Firebase } from '../libs/firebaseAdmin';
import { CallFusion } from '../index';
import { Utils } from '../libs/utils';
import logger from '../libs/logger';

const router = Router();

/**
 * 루프백에서 온 요청만 통과시킨다.
 *
 * Nginx 를 거친 요청은 소켓 주소가 항상 127.0.0.1 이므로, 이 라우터는
 * **Nginx 경로에 붙이면 안 된다.** index.ts 에서 포트 직결 경로에만 붙인다.
 */
function loopbackOnly(req: Request, res: Response, next: () => void): void {
    const ip = req.socket.remoteAddress || '';
    const clean = ip.replace('::ffff:', '');
    if (clean === '127.0.0.1' || clean === '::1') {
        return next();
    }
    logger.warn(`sip-push 거부: ${ip}`);
    res.status(403).json({ error: 'forbidden', message: 'loopback only' });
}

/**
 * @brief 착신 푸시.
 *
 * 요청 본문
 *   aor      필수. 불린 SIP 사용자명 (예: "1001")
 *   caller   선택. 발신자 표시용
 *   callId   선택. 로그 대조용
 *
 * 응답
 *   200 { pushed: n }   n 대에 보냈다 (0 이면 대상 없음)
 *   400                 aor 없음
 *   503                 DB 또는 FCM 미설정
 *
 * **오래 붙들지 않는다.** Kamailio 는 이 응답을 기다리는 동안 트랜잭션을 쥐고
 * 있으므로, FCM 왕복까지 기다리지 않고 발송을 걸어 둔 뒤 바로 답한다.
 */
router.post('/', loopbackOnly, async (req: Request, res: Response) => {
    const aor = String(req.body?.aor ?? '').trim();
    const caller = String(req.body?.caller ?? '').trim();
    const callId = String(req.body?.callId ?? '').trim();

    if (!aor) {
        res.status(400).json({ error: 'aor_required' });
        return;
    }
    if (!DbConn.isConfigured()) {
        res.status(503).json({ error: 'database_not_configured' });
        return;
    }

    let rows: any[];
    try {
        // active 인 단말만 부른다. 해제된 단말에 보내면 FCM 이 무효 토큰으로 응답한다.
        rows = await DbConn.select(
            `SELECT token FROM ${CallFusion.getTableForMobile()}
              WHERE sip_user = ? AND active = 1 AND token <> ''`,
            [aor]
        );
    } catch (err: any) {
        logger.error(`sip-push 대상 조회 실패 (${aor}):`, err.message);
        res.status(503).json({ error: 'query_failed', message: err.message });
        return;
    }

    const tokens = rows.map((r) => r.token).filter(Boolean);
    if (tokens.length === 0) {
        // 오류가 아니다 — 그 내선에 연결된 모바일이 없을 뿐이다.
        // Kamailio 는 이 값을 보고 붙들고 있던 트랜잭션을 480 으로 끝낼 수 있다.
        logger.info(`sip-push: ${aor} 에 연결된 단말이 없습니다`);
        res.status(200).json({ pushed: 0 });
        return;
    }

    const messaging = Firebase.getMessaging();
    if (!messaging) {
        logger.warn('FCM 미설정 — sip-push 를 보내지 않습니다.');
        res.status(503).json({ error: 'fcm_not_configured' });
        return;
    }

    const message: TokenMessage = {
        token: '',
        notification: {
            title: `수신 전화 (${Utils.getDateTime()})`,
            body: caller ? `${caller} 님이 전화를 걸었습니다.` : '전화가 왔습니다.',
        },
        data: {
            // 단말이 이 값을 보고 깨어나 **Janus 에 붙어** SIP 플러그인에
            // register 를 요청한다 (단말은 SIP 를 직접 말하지 않는다 —
            // docs/client-guide.md). Janus 가 Kamailio 에 REGISTER 를 보내고,
            // 그 순간 Kamailio 가 붙들어 둔 INVITE 를 그 연결로 흘려보낸다.
            method: 'sip-incoming',
            aor,
            caller,
            callId,
        },
        android: {
            priority: 'high',
            notification: {
                channelId: 'callfusion_2_rtc',
                sound: 'doorbell.wav',
            },
        },
    };

    // 발송을 걸어 두고 바로 답한다. Kamailio 가 이 응답을 기다리는 동안
    // 트랜잭션을 쥐고 있으므로 FCM 왕복까지 붙들면 착신이 그만큼 늦어진다.
    messaging
        .sendEachForMulticast({ ...message, tokens })
        .then((r: any) => logger.info(`sip-push ${aor}: ${r.successCount}/${tokens.length} 성공`))
        .catch((err: any) => logger.error(`sip-push ${aor} 실패:`, err));

    logger.info(`sip-push ${aor}: ${tokens.length}대에 발송 요청 (caller=${caller || '-'}, callId=${callId || '-'})`);
    res.status(200).json({ pushed: tokens.length });
});

export default router;
