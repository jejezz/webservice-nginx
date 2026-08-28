/**
 * @file sipPush.ts
 * @brief Kamailio 가 부르는 착신 푸시 엔드포인트 — **자는 모바일을 Janus 로 끌어온다.**
 *
 * ── 언제 불리는가 ────────────────────────────────────────────────
 * 인터폰이 Kamailio 를 통해 모바일 내선으로 걸었는데, 그 내선이 등록돼 있지
 * 않을 때입니다. Kamailio 는 그 INVITE 를 tsilo 로 붙들어 두고 여기로 요청을
 * 던집니다.
 *
 *   인터폰 ──INVITE(1001)──▶ Kamailio
 *                            ├─ lookup 실패 → ts_store()
 *                            └─ POST /sip-push  ← 여기
 *                                        │
 *                                   FCM ─┴─▶ 앱 기동
 *                                            Janus 접속 (WSS)
 *                                            janus.plugin.sip → register(1001)
 *                            ◀──REGISTER(Janus 가 대신)──┘
 *                            └─ ts_append() → 붙들어 둔 INVITE 전달 → 벨
 *                                                    │
 *                                              Janus ─ 미디어 (WebRTC ↔ RTP)
 *
 * ── 모바일은 SIP 를 말하지 않는다 ────────────────────────────────
 * 예전 설계에서는 단말의 SIP 스택이 직접 WSS 로 REGISTER 했습니다. 지금은
 * **Janus 가 그 모바일을 대신해** Kamailio 에 등록합니다
 * (services/janus 의 janus.plugin.sip). Kamailio 입장에서는 누가 등록했는지
 * 구분하지 않으므로 라우트는 그대로이고, 달라지는 것은 이 푸시가 앱에게
 * "무엇을 하라" 고 말하는 내용뿐입니다.
 *
 * ── 왜 websocket-relay 인가 ─────────────────────────────────────
 * FCM 자격 증명·토큰 테이블·발송 코드가 전부 이미 여기 있습니다. Janus 에는
 * 푸시 기능이 없고(플러그인·이벤트 핸들러 어디에도 없습니다), 애초에 깨워야 할
 * 단말은 그 시점에 Janus 와 연결돼 있지 않습니다.
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
import { sendToTargets, PushTarget } from '../libs/push';
import { complexClause } from '../libs/complex';
import config from '../config';
import { Utils } from '../libs/utils';
import logger from '../libs/logger';

const router = Router();

/**
 * 앱이 붙어야 할 Janus 주소. 없으면 payload 에 싣지 않는다.
 *
 * 앱은 평소 통화에서도 이 주소를 알고 있지만, 푸시에 함께 실어 주면 앱이
 * 저장해 둔 값이 낡았을 때도 따라올 수 있다. 공개 주소이므로 서버가 스스로
 * 알 수 없어 설정으로 받는다.
 */
const JANUS_WS_URL = config.janus.wsUrl;

/**
 * 루프백에서 온 요청만 통과시킨다.
 *
 * Nginx 를 거친 요청은 소켓 주소가 항상 127.0.0.1 이므로, 이 라우터는
 * **Nginx 경로에 붙이면 안 된다.** index.ts 에서 앱에 직접 붙인다.
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
 *   aor      필수. 불린 SIP 내선 (예: "1001")
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
        // id 와 push_error 를 함께 뽑는 것은 발송 결과를 기본 키로 되쓰기 위해서다
        // (libs/push.ts). 단지 조건은 다른 조회들과 같은 이유다 (libs/complex.ts).
        const c = complexClause();
        rows = await DbConn.select(
            `SELECT id, token, push_error FROM ${config.tables.mobile}
              WHERE sip_user = ? AND active = 1 AND token <> ''${c.sql}`,
            [aor, ...c.params]
        );
    } catch (err: any) {
        logger.error(`sip-push 대상 조회 실패 (${aor}):`, err.message);
        res.status(503).json({ error: 'query_failed', message: err.message });
        return;
    }

    const targets: PushTarget[] = rows
        .filter((r) => r.token)
        .map((r) => ({ id: Number(r.id), token: r.token, push_error: r.push_error }));

    if (targets.length === 0) {
        // 오류가 아니다 — 그 내선에 연결된 모바일이 없을 뿐이다.
        // Kamailio 는 이 값을 보고 붙들고 있던 트랜잭션을 480 으로 끝낼 수 있다.
        logger.info(`sip-push: ${aor} 에 연결된 단말이 없습니다`);
        res.status(200).json({ pushed: 0 });
        return;
    }

    const message: TokenMessage = {
        token: '',
        notification: {
            title: `수신 전화 (${Utils.getDateTime()})`,
            body: caller ? `${caller} 님이 전화를 걸었습니다.` : '전화가 왔습니다.',
        },
        data: {
            // 단말이 이 값을 보고 **Janus 에 붙어** sip 플러그인으로 내선을 등록한다.
            // 등록이 끝나면 Kamailio 가 붙들어 둔 INVITE 를 그 경로로 보낸다.
            // (예전에는 단말이 자기 SIP 스택으로 직접 REGISTER 했다)
            method: 'sip-incoming',
            sipUser: aor,
            ...(JANUS_WS_URL ? { janusUrl: JANUS_WS_URL } : {}),
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

    // FCM 이 없으면 **여기서 끝내야 한다.**
    //
    // sendToTargets 는 키가 없으면 경고만 남기고 넘어가지만, 이 경로에서는 그러면
    // 안 된다. Kamailio 는 200 을 받으면 183 Session Progress 로 답하고 단말이
    // 등록되기를 Timer C(약 3분)까지 기다린다. 푸시가 아예 나가지 않았는데
    // 3분을 기다리게 하는 것보다, 503 으로 답해 480 Temporarily Unavailable 로
    // 바로 끝내는 편이 낫다. (services/kamailio/docs/incoming-call.md)
    if (!Firebase.getMessaging()) {
        logger.warn('FCM 미설정 — sip-push 를 보내지 않습니다.');
        res.status(503).json({ error: 'fcm_not_configured' });
        return;
    }

    // 발송을 걸어 두고 바로 답한다. Kamailio 가 이 응답을 기다리는 동안
    // 트랜잭션을 쥐고 있으므로 FCM 왕복까지 붙들면 착신이 그만큼 늦어진다.
    // 무효 토큰 정리는 sendToTargets 안에서 한다.
    void sendToTargets(targets, message, `sip-push ${aor}`);

    logger.info(`sip-push ${aor}: ${targets.length}대에 발송 요청 (caller=${caller || '-'}, callId=${callId || '-'})`);
    res.status(200).json({ pushed: targets.length });
});

export default router;
