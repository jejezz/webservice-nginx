/**
 * @file dashboardApi.ts
 * @brief 관리 대시보드용 API. 전부 manager 로그인 세션을 요구한다.
 *
 * 서비스 본연의 REST(/register, /room, /status ...)는 Android 클라이언트가 쓰는 것이고,
 * 여기 있는 것들은 사람이 보는 대시보드 전용이다. 경로가 겹치지 않게 분리해 둔다.
 */
import { Router, Request, Response } from 'express';
import { TokenMessage } from 'firebase-admin/messaging';
import { DbConn } from '../libs/dbConnection';
import { requireAuth } from '../auth/session';
import config from '../config';
import { getGateway } from '../gateway';
import { createMobileRecord, updateMobileRecord, statusFor } from '../libs/mobileRecord';
import { saveHomenetRecord, wallpadSipUser } from '../libs/homenetRecord';
import { Firebase } from '../libs/firebaseAdmin';
import { sendTest } from '../libs/push';
import * as sipAccount from '../libs/sipAccount';
import * as janusToken from '../libs/janusToken';
import { Utils } from '../libs/utils';
import { analyze, install, installedStatus, remove } from '../libs/firebaseKey';
import logger from '../libs/logger';
import { complexId, setComplexId, COMPLEX_ID_RE, COMPLEX_ID_ERROR } from '../libs/complex';
import { sipProxy, setSipProxy, detectSipProxy, SIP_PROXY_RE, SIP_PROXY_ERROR } from '../libs/sipProxy';
import { verifyPassword } from '../auth/reauth';
import {
    listPending, approve, reject, countApproved,
    MAX_APPROVED_PER_HOME, MAX_PENDING_PER_HOME, PENDING_TTL_MS, invalidateControlCache,
    setDevicePermissions,
} from '../libs/enrollment';
import { notifyWallpad } from '../libs/enrollmentEvents';
import { normalizeAddress } from '../libs/address';

/** 목록에 내보낼 컬럼. token 은 FCM 자격이라 싣지 않는다. */
// token 은 FCM 자격이라 싣지 않는다. 대신 그 토큰이 쓸 만한지를 알려 주는 값들을
// 싣는다 — sip_user 가 비어 있으면 인터폰 착신이 조용히 0건이고, push_error 가
// 있으면 그 단말에는 푸시가 닿지 않고 있다.
const PUBLIC_COLUMNS = 'id, uuid, email, complex, complex_id, address, phone, active, can_call, can_control, approved_at, approved_by, created, modified, sip_user, token_updated_at, push_error, push_failed_at, (token IS NOT NULL AND token <> \'\') AS has_token';

function fail(res: Response, err: any, what: string) {
    logger.error(`${what}:`, err.message);
    if (!DbConn.isConfigured()) {
        return res.status(503).json({ error: 'database is not configured' });
    }
    res.status(500).json({ error: what });
}

/**
 * 시험 푸시로 보낼 메시지.
 *
 * 초인종·착신과 **다른 method** 를 쓴다. `invite` 나 `sip-incoming` 으로 보내면
 * 앱이 통화 화면을 띄우거나 Janus 에 붙으려 든다 — 확인하려다 그 집 사람을
 * 받을 수 없는 전화 앞에 세우는 셈이다. 모르는 method 는 앱이 무시하고,
 * notification 이 실려 있으므로 알림 자체는 그대로 뜬다.
 *
 * 소리는 지정하지 않는다. 채널(channelId)에 묶인 기본값을 그대로 쓰면 실제
 * 착신과 같은 경로가 확인되고, 앱이 채널을 안 만들었으면 그 사실도 드러난다.
 */
function testMessage(address: string): TokenMessage {
    return {
        token: '',
        notification: {
            title: `시험 알림 (${Utils.getDateTime()})`,
            body: '이 알림이 보이면 이 단말로 푸시가 정상 도착합니다.',
        },
        data: {
            method: 'test-push',
            address: String(address ?? ''),
        },
        android: {
            priority: 'high',
            notification: { channelId: config.firebase.channelId },
        },
    };
}

export function createDashboardApi(): Router {
    const router = Router();

    // 이 아래 전부 로그인 필요
    router.use(requireAuth);

    /**
     * 방 정보를 보는 라우트가 쓰는 룸 테이블.
     *
     * 게이트웨이는 서버가 listen 한 뒤에 만들어지는데 앱은 그 전에 조립된다.
     * 그래서 값을 받아 두지 않고 그때그때 꺼낸다 — 부팅 중에 대시보드를 열면
     * 503 이 되고, 뜨고 나면 정상이다.
     */
    function roomTable(res: Response) {
        const gateway = getGateway();
        if (!gateway) {
            res.status(503).json({ error: 'relay gateway is not ready' });
            return null;
        }
        return gateway.roomTable;
    }

    /** 현재 로그인한 사용자 */
    router.get('/me', (req: Request, res: Response) => {
        res.json({ user: (req as any).user });
    });

    /** 개요 — 서비스 상태 한 눈에 */
    router.get('/overview', async (req: Request, res: Response) => {
        const table = roomTable(res);
        if (!table) return;

        let mobiles = null;
        let homenet = null;
        try {
            const [m] = await DbConn.select(
                `SELECT COUNT(*) AS total, SUM(active = 1) AS active FROM ${config.tables.mobile}`);
            const [h] = await DbConn.select(
                `SELECT COUNT(*) AS total FROM ${config.tables.homenet}`);
            mobiles = { total: Number(m.total) || 0, active: Number(m.active) || 0 };
            homenet = { total: Number(h.total) || 0 };
        } catch {
            // DB 가 끊겨도 개요는 보여준다. 카드에서 '—' 로 표시된다.
        }

        res.json({
            service: config.serviceName,
            uptimeSec: Math.floor(process.uptime()),
            pid: process.pid,
            memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
            nodeEnv: config.env,
            listen: `${config.host}:${config.port}`,
            complexId: complexId(),
            rooms: table.roomTable.size,
            // 두 용도를 나눠 센다. 합계만으로는 통화 중인지 홈넷 세션인지 모른다.
            roomsByKind: Array.from(table.roomTable.values()).reduce((acc: Record<string, number>, r) => {
                acc[r.kind] = (acc[r.kind] ?? 0) + 1;
                return acc;
            }, { rtc: 0, iot: 0, admin: 0, unknown: 0 }),
            connections: table.websocketCount(),
            database: await DbConn.ping(),
            mobiles,
            homenet,
        });
    });

    /** 활성 방과 접속 클라이언트 */
    router.get('/rooms', (req: Request, res: Response) => {
        const table = roomTable(res);
        if (!table) return;

        const rooms = Array.from(table.roomTable.entries()).map(([roomId, room]) => {
            const clients = Array.from(room.clients.values()).map((c) => ({
                clientId: c.cid,
                address: c.address,
                ipAddress: c.ipaddress,
                agent: c.agent,
                device: c.device,
                initiator: c.initiator,
                // alive 는 지난 ping 에 pong 이 왔는지다. 소켓이 실제로 열려
                // 있는지와는 다르다 — 등록만 되고 아직 붙지 않은 자리는
                // alive 가 참인 채로 소켓이 없을 수 있다. 둘 다 보여준다.
                alive: c.alive,
                connected: c.isOpened(),
                subscription: c.susbcription,
                queued: c.messageQueue.length,
            }));

            // 화면에서 판단하지 않고 여기서 정한다. 규칙(정원·홈넷 유무)이
            // 서버 쪽에 있으므로, 이상 여부도 같은 곳에서 말하는 편이 맞다.
            const warnings: string[] = [];
            const capacity = room.capacity();
            if (room.kind === 'rtc' && clients.length > capacity) {
                warnings.push(`통화 방에 ${clients.length}대가 들어와 있습니다 (정원 ${capacity}). 늦게 들어온 단말이 통화에 끼어들 수 있습니다.`);
            }
            if (room.kind === 'iot' && clients.length > 0 && !clients.some((c) => c.initiator)) {
                warnings.push('홈넷 장치가 없습니다. 제어 명령을 받을 대상이 없습니다.');
            }
            // 통화 방이 2/2 인 것은 **정상**이다 — 통화가 이어지고 있다는 뜻이라
            // 경고로 올리지 않는다. IoT 방이 차는 것은 다르다: 등록된 모바일이
            // 더 있는데 못 들어오고 있다는 뜻이므로 알려야 한다.
            if (room.kind !== 'rtc' && clients.length >= capacity) {
                warnings.push(`정원(${capacity})이 찼습니다. 더 들어올 수 없습니다.`);
            }

            return {
                roomId,
                kind: room.kind,
                capacity,
                clientCount: room.clients.size,
                subscriberCount: clients.filter((c) => c.subscription).length,
                registerTimeout: room.registerTimeout,
                warnings,
                clients,
            };
        });

        const byKind: Record<string, number> = { rtc: 0, iot: 0, admin: 0, unknown: 0 };
        for (const r of rooms) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;

        res.json({
            totalRooms: table.roomTable.size,
            totalConnections: table.websocketCount(),
            byKind,
            rooms,
        });
    });

    /** 등록된 모바일 단말 */
    router.get('/mobiles', async (req: Request, res: Response) => {
        try {
            const rows = await DbConn.select(
                `SELECT ${PUBLIC_COLUMNS} FROM ${config.tables.mobile} ORDER BY created DESC`);
            // 화면이 '다른 단지로 등록된 단말' 을 표시할 수 있게 이 서버의 값도 함께 준다.
            res.json({
                complexId: complexId(),
                records: rows.map((r: any) => ({
                    ...r,
                    active: r.active === 1,
                    can_call: r.can_call === 1,
                    can_control: r.can_control === 1,
                    // 토큰 자체는 싣지 않지만, **있는지 없는지**는 화면이 알아야 한다 —
                    // 없으면 시험 푸시를 눌러 봐야 400 밖에 돌아오지 않는다.
                    has_token: Number(r.has_token) === 1,
                })),
            });
        } catch (err: any) {
            fail(res, err, 'Failed to fetch mobile records');
        }
    });

    /**
     * 단말 등록을 새로 만든다.
     *
     * 통합 전 무번들 대시보드에만 있던 기능이다. React 화면에는 조회·토글·삭제밖에
     * 없어서, 단말을 손으로 넣으려면 내부 전용 `/mobile-crud-operation` 을 직접
     * 불러야 했다. 규칙은 그쪽과 **같은 모듈**을 쓴다 (libs/mobileRecord.ts).
     */
    router.post('/mobiles', async (req: Request, res: Response) => {
        try {
            const result = await createMobileRecord(req.body);
            if (!result.ok) return res.status(statusFor(result.kind)).json({ error: result.message });
            logger.info(`[dashboard] mobile ${result.value.id} created (by ${(req as any).user?.username})`);
            res.status(201).json({ id: result.value.id });
        } catch (err: any) {
            fail(res, err, 'Failed to create mobile record');
        }
    });

    /** 단말 등록을 고친다. 보내지 않은 필드는 건드리지 않는다. */
    router.put('/mobiles/:id', async (req: Request, res: Response) => {
        try {
            const result = await updateMobileRecord(req.params.id, req.body);
            if (!result.ok) return res.status(statusFor(result.kind)).json({ error: result.message });
            logger.info(`[dashboard] mobile ${req.params.id} updated (by ${(req as any).user?.username})`);
            res.json({ id: result.value.id });
        } catch (err: any) {
            fail(res, err, 'Failed to update mobile record');
        }
    });

    router.patch('/mobiles/:id/toggle-active', async (req: Request, res: Response) => {
        try {
            const result = await DbConn.execute(
                // 사람이 정한 상태라는 표시로 실패 코드를 지운다 (routes/mobile.ts 와 같은 이유).
                `UPDATE ${config.tables.mobile}
                    SET active = 1 - active, push_error = NULL, push_failed_at = NULL
                  WHERE id = ?`,
                [req.params.id]);
            if (result.affectedRows === 0) return res.status(404).json({ error: 'not found' });

            const rows = await DbConn.select(
                `SELECT active FROM ${config.tables.mobile} WHERE id = ?`, [req.params.id]);
            const active = rows[0]?.active === 1;
            logger.info(`[dashboard] mobile ${req.params.id} active → ${active} (by ${(req as any).user?.username})`);
            res.json({ id: Number(req.params.id), active });
        } catch (err: any) {
            fail(res, err, 'Failed to toggle active status');
        }
    });

    /**
     * 이 단말 **하나에** 시험 푸시를 보낸다.
     *
     * ── 왜 필요한가 ──────────────────────────────────────────────
     * "푸시가 안 온다" 는 신고가 들어오면 확인할 것이 네 겹이다 — 키가 살아
     * 있는가(푸시 키 화면), 그 단말의 토큰이 이 프로젝트 것인가, 토큰이 아직
     * 유효한가, 앱이 알림을 띄우는가. 앞의 하나만 화면에 있었고 나머지는
     * 서버에 들어가 `node tools/fcm.js send <토큰>` 을 쳐야 알 수 있었다.
     * 그러려면 DB 에서 토큰을 꺼내 와야 하는데, 토큰은 목록 API 가 일부러
     * 내려보내지 않는 값이다. 그래서 아무도 하지 않았다.
     *
     * 여기서는 서버가 토큰을 꺼내 쓰므로 **토큰이 밖으로 나가지 않는다.**
     *
     * ── 두 가지 방법 ────────────────────────────────────────────
     *   dryRun=true   구글에 물어보기만 한다. 단말에는 아무것도 가지 않고
     *                 DB 도 건드리지 않는다. 한밤중에 남의 폰을 울리지 않고
     *                 토큰이 살아 있는지 볼 때 쓴다.
     *   dryRun=false  진짜로 보낸다. 알림이 떠야 그 단말이 정말 받는다는
     *                 뜻이므로, 마지막 한 겹(앱이 띄우는가)은 이것만 답한다.
     *                 결과는 다른 발송과 **같은 규칙**으로 기록된다 —
     *                 무효 토큰이면 그 자리에서 비활성으로 내려간다.
     *
     * 기다렸다가 답한다. 사람이 버튼을 누르고 결과를 보려고 서 있기 때문이다.
     */
    router.post('/mobiles/:id/test-push', async (req: Request, res: Response) => {
        const dryRun = Boolean(req.body?.dryRun);
        const actor = (req as any).user?.username ?? 'unknown';

        try {
            const [row] = await DbConn.select(
                `SELECT id, address, email, token, push_error FROM ${config.tables.mobile} WHERE id = ?`,
                [req.params.id]);
            if (!row) return res.status(404).json({ error: 'not found' });

            if (!row.token) {
                return res.status(400).json({
                    error: 'no_token',
                    message: '이 단말에는 FCM 토큰이 없습니다. 앱이 /register 로 토큰을 올려야 합니다.',
                });
            }
            // 키가 없으면 sendTest 도 답을 못 준다. 여기서 끊는 편이 화면에 쓸 말이 분명하다.
            if (!Firebase.getMessaging()) {
                return res.status(503).json({
                    error: 'fcm_not_configured',
                    message: 'FCM 서비스 계정 키가 없습니다 — 푸시 키 화면에서 올리세요.',
                });
            }

            const result = await sendTest(
                { id: Number(row.id), token: row.token, push_error: row.push_error },
                testMessage(row.address),
                `시험 푸시 ${row.address} (${row.email})`,
                dryRun);

            logger.info(
                `[dashboard] 시험 푸시 ${dryRun ? '(검증만) ' : ''}${row.address} ${row.email}: ` +
                `${result.ok ? '성공' : result.code} (by ${actor})`);

            res.json({ id: Number(row.id), dryRun, ...result });
        } catch (err: any) {
            fail(res, err, 'Failed to send test push');
        }
    });

    router.delete('/mobiles/:id', async (req: Request, res: Response) => {
        try {
            // 지우기 **전에** 읽는다. 지운 뒤에는 어느 내선이었는지 알 길이 없다.
            const [before] = await DbConn.select(
                `SELECT address, sip_user FROM ${config.tables.mobile} WHERE id = ?`, [req.params.id]);
            // Janus 토큰도 지우기 전에 거둔다 (libs/janusToken.ts).
            await janusToken.removeForDevice({ id: req.params.id });
            const result = await DbConn.execute(
                `DELETE FROM ${config.tables.mobile} WHERE id = ?`, [req.params.id]);
            if (result.affectedRows === 0) return res.status(404).json({ error: 'not found' });

            if (before?.sip_user) await sipAccount.revoke(before.sip_user);
            // 마지막 제어 단말이 나가도 30초는 통과하던 것을 막는다 (libs/enrollment.ts).
            if (before?.address) invalidateControlCache(before.address);
            logger.info(`[dashboard] mobile ${req.params.id} deleted (by ${(req as any).user?.username})`);
            res.json({ id: Number(req.params.id) });
        } catch (err: any) {
            fail(res, err, 'Failed to delete mobile record');
        }
    });

    // ── 등록 승인 ────────────────────────────────────────────────
    //
    // 이 표(mobile_enrollments)에 있는 것은 **아무 권한이 없다.** 승인되어야
    // rtc_mobiles 로 옮겨 가고 그때 can_call / can_control 이 켜진다.
    // 규칙은 libs/enrollment.ts 한 곳에 있고 월패드 경로도 같은 것을 쓴다.

    /** 대기 중인 등록 요청. `?address=1B101U` 로 세대를 좁힌다. */
    router.get('/enrollments', async (req: Request, res: Response) => {
        const address = req.query.address ? normalizeAddress(String(req.query.address)) : undefined;
        try {
            res.json({
                records: await listPending(address),
                limits: {
                    approvedPerHome: MAX_APPROVED_PER_HOME,
                    pendingPerHome: MAX_PENDING_PER_HOME,
                    ttlMinutes: Math.round(PENDING_TTL_MS / 60000),
                },
            });
        } catch (err: any) {
            fail(res, err, 'Failed to fetch enrollments');
        }
    });

    /**
     * 요청을 인정한다. 무엇을 열어 줄지는 호출부가 정한다.
     *
     * 기본값은 **둘 다 꺼짐**이다. 실수로 body 를 비워 보내면 등록만 되고
     * 아무것도 못 하는 상태가 된다 — 반대로 기본을 켜 두면 실수 한 번이
     * 그대로 권한 부여가 된다.
     */
    router.post('/enrollments/:id/approve', async (req: Request, res: Response) => {
        const actor = (req as any).user?.username ?? 'unknown';
        try {
            const result = await approve(Number(req.params.id), {
                canCall: Boolean(req.body?.canCall),
                canControl: Boolean(req.body?.canControl),
            }, actor);

            if (!result.ok) {
                return res.status(result.reason === 'not_found' ? 404 : 409)
                          .json({ error: result.reason, message: result.message });
            }
            // 월패드 목록에서도 사라지도록 갱신본을 밀어 준다.
            invalidateControlCache(result.address);
            void notifyWallpad(result.address);
            res.json({ id: result.id, address: result.address, uuid: result.uuid });
        } catch (err: any) {
            fail(res, err, 'Failed to approve enrollment');
        }
    });

    /** 요청을 거절한다. 그냥 지운다 — 남겨 둘 이유가 없다. */
    router.delete('/enrollments/:id', async (req: Request, res: Response) => {
        const actor = (req as any).user?.username ?? 'unknown';
        try {
            const ok = await reject(Number(req.params.id), actor);
            if (!ok) return res.status(404).json({ error: 'not found' });
            res.json({ id: Number(req.params.id) });
        } catch (err: any) {
            fail(res, err, 'Failed to reject enrollment');
        }
    });

    /**
     * 이미 승인된 단말의 권한을 바꾼다.
     *
     * toggle-active 와 분리한다 — active 는 기계가 정하는 푸시 건강 상태이고
     * 이쪽은 사람이 정하는 권한이다 (schema/005-enrollment.sql).
     */
    router.patch('/mobiles/:id/permissions', async (req: Request, res: Response) => {
        const actor = (req as any).user?.username ?? 'unknown';
        try {
            // 규칙은 월패드 경로(device.permissions)와 **같은 모듈**을 쓴다.
            // 두 벌로 두면 캐시 무효화나 감사 로그가 한쪽에만 남는다.
            const result = await setDevicePermissions(
                { id: Number(req.params.id) },
                { canCall: req.body?.canCall, canControl: req.body?.canControl },
                actor);

            if (!result.ok) {
                return res.status(result.reason === 'not_found' ? 404 : 400)
                          .json({ error: result.reason, message: result.message });
            }
            res.json({ id: result.id, can_call: result.canCall, can_control: result.canControl });
        } catch (err: any) {
            fail(res, err, 'Failed to update permissions');
        }
    });

    /** 세대별 요약. 화면이 "이 집은 몇 대 남았나" 를 보여주는 데 쓴다. */
    router.get('/homes', async (_req: Request, res: Response) => {
        try {
            const rows = await DbConn.select(
                `SELECT h.building, h.unit, CONCAT(h.building, 'B', h.unit, 'U') AS address,
                        h.type, h.ipaddress, h.modified,
                        (SELECT COUNT(*) FROM ${config.tables.mobile} m
                          WHERE m.address = CONCAT(h.building, 'B', h.unit, 'U')
                            AND m.complex_id <=> h.complex_id) AS devices,
                        (SELECT COUNT(*) FROM mobile_enrollments e
                          WHERE e.address = CONCAT(h.building, 'B', h.unit, 'U')
                            AND e.complex_id <=> h.complex_id AND e.expires_at > NOW()) AS pending
                   FROM ${config.tables.homenet} h
                  WHERE h.complex_id <=> ?
                  ORDER BY h.building, h.unit`, [complexId()]);
            res.json({ records: rows, capacity: MAX_APPROVED_PER_HOME });
        } catch (err: any) {
            fail(res, err, 'Failed to fetch homes');
        }
    });

    // ── 단지 ID ──────────────────────────────────────────────────
    //
    // ⚠️ 이 값은 **비밀이 아니다.** 앱이 Firestore 디렉터리에서 공개로 받아 오는
    //    라우팅 키다 (docs/multi-complex.md 의 `allow read: if true`). 실제로
    //    /register 는 앱이 이 필드를 아예 안 보내면 서버 값으로 채우고 통과시킨다
    //    — 즉 값을 가려도 막히는 것이 없다.
    //
    //    위험한 것은 **바꾸는 쪽**이다. 바뀌는 순간 지금 등록된 단말의 complex_id
    //    와 어긋나 그 단말들이 착신 대상 조회에서 통째로 빠진다. 그래서 읽기는
    //    열어 두고 쓰기만 조인다: 영향 대수 → 재입력 확인 → 비밀번호 재확인.

    /** 지금 단지와, 바꿨을 때 무슨 일이 생기는지. */
    router.get('/complex', async (_req: Request, res: Response) => {
        const id = complexId();
        const gateway = getGateway();

        let registered: { total: number; matching: number; orphaned: number } | null = null;
        try {
            const [row] = await DbConn.select(
                `SELECT COUNT(*) AS total,
                        SUM(complex_id <=> ?) AS matching,
                        SUM(complex_id IS NOT NULL AND NOT (complex_id <=> ?)) AS orphaned
                   FROM ${config.tables.mobile} WHERE active = 1`, [id, id]);
            registered = {
                total: Number(row.total) || 0,
                matching: Number(row.matching) || 0,
                orphaned: Number(row.orphaned) || 0,
            };
        } catch {
            // DB 가 끊겨도 지금 값은 보여준다.
        }

        res.json({
            complexId: id,
            format: { pattern: COMPLEX_ID_RE.source, hint: COMPLEX_ID_ERROR },
            // 화면이 "왜 가리지 않는가" 를 설명할 수 있게 서버가 성격을 알려 준다.
            isSecret: false,
            registered,
            connectedWebsockets: gateway ? gateway.roomTable.websocketCount() : 0,
            activeRooms: gateway ? gateway.roomTable.roomTable.size : 0,
        });
    });

    /**
     * 단지를 바꾼다. 세 겹을 통과해야 한다.
     *
     *   ① 형식      소문자 16진수 8자 (또는 빈 값 = 단지 검사 끄기)
     *   ② 재입력    confirm 이 새 값과 같아야 한다 — 오타와 오클릭을 거른다
     *   ③ 비밀번호  manager 에 **서버가** 물어본다 (auth/reauth.ts)
     *
     * 등록된 단말이 있어도 막지는 않는다. 단지 ID 를 정말 바꿔야 하는 상황
     * (재발급·오설정 정정)이 있고, 그때 화면에서 고칠 길이 없으면 사람이 .env 를
     * 직접 고치게 되는데 그러면 이 검사들이 전부 무의미해진다. 대신 영향을
     * 숫자로 보여 주고 확인을 받는다.
     */
    router.put('/complex', async (req: Request, res: Response) => {
        const actor = (req as any).user?.username ?? 'unknown';
        const raw = String(req.body?.complexId ?? '').trim().toLowerCase();
        const confirm = String(req.body?.confirm ?? '').trim().toLowerCase();

        // ① 형식. 빈 값은 "단지 검사를 끈다" 는 뜻으로 받는다.
        if (raw !== '' && !COMPLEX_ID_RE.test(raw)) {
            return res.status(400).json({ error: 'invalid_format', message: COMPLEX_ID_ERROR });
        }
        const next = raw === '' ? null : raw;

        if (next === complexId()) {
            return res.status(400).json({ error: 'unchanged', message: '지금 값과 같습니다.' });
        }

        // ② 재입력.
        if (confirm !== raw) {
            return res.status(400).json({
                error: 'confirm_mismatch',
                message: '확인 입력이 새 단지 ID 와 다릅니다.',
            });
        }

        // ③ 비밀번호. 브라우저가 아니라 여기서 manager 에 물어본다.
        const reauth = await verifyPassword(req, String(req.body?.password ?? ''));
        if (!reauth.ok) {
            logger.warn(`[audit] 단지 ID 변경 거부 — 비밀번호 재확인 실패 (by ${actor}: ${reauth.error})`);
            return res.status(reauth.status).json({ error: reauth.error, message: reauth.message });
        }

        try {
            setComplexId(next, actor);
        } catch (err: any) {
            // .env 쓰기가 실패했다. 메모리 값은 이미 바뀌었으므로 사람에게 알린다 —
            // 재시작하면 옛 값으로 돌아간다.
            logger.error(`단지 ID 를 .env 에 적지 못했습니다: ${err.message}`);
            return res.status(500).json({
                error: 'persist_failed',
                message: `값은 적용됐지만 .env 에 기록하지 못했습니다 — 재시작하면 되돌아갑니다: ${err.message}`,
            });
        }

        res.json({ complexId: complexId() });
    });

    // ── SIP 프록시 ────────────────────────────────────────────────
    //
    // 앱이 REGISTER 를 보낼 이 단지의 Kamailio 주소. Kamailio 서버 자체를
    // 바꾸는 기능이 아니다 — 서버가 앱에게 알려 주는 주소만 고친다. 그래서
    // 단지 ID 와 달리 재입력·비밀번호 재확인을 요구하지 않는다: 틀려도 결과는
    // "새 등록이 옛 프록시로 붙는다" 뿐이고, 그마저 바로 여기서 다시 고치면
    // 그만이다.

    /** 지금 값과, 이 장비에서 자동으로 찾은 값. */
    router.get('/sip-proxy', (_req: Request, res: Response) => {
        res.json({
            value: sipProxy(),
            detected: detectSipProxy(),
            overridden: Boolean((process.env.SIP_PROXY ?? '').trim()),
            format: { pattern: SIP_PROXY_RE.source, hint: SIP_PROXY_ERROR },
        });
    });

    /** SIP 프록시를 바꾼다. 비우면 자동 감지로 되돌린다. */
    router.put('/sip-proxy', (req: Request, res: Response) => {
        const actor = (req as any).user?.username ?? 'unknown';
        const raw = String(req.body?.value ?? '').trim();

        if (raw !== '' && !SIP_PROXY_RE.test(raw)) {
            return res.status(400).json({ error: 'invalid_format', message: SIP_PROXY_ERROR });
        }
        const next = raw === '' ? null : raw;

        try {
            setSipProxy(next, actor);
        } catch (err: any) {
            logger.error(`SIP 프록시를 .env 에 적지 못했습니다: ${err.message}`);
            return res.status(500).json({
                error: 'persist_failed',
                message: `값은 적용됐지만 .env 에 기록하지 못했습니다 — 재시작하면 되돌아갑니다: ${err.message}`,
            });
        }

        res.json({ value: sipProxy(), detected: detectSipProxy() });
    });

    // ── FCM 서비스 계정 키 ───────────────────────────────────────
    //
    // 이 키 하나가 "자고 있는 집의 전화를 울릴 수 있는가" 를 결정한다. 잘못
    // 올리면 서비스는 멀쩡해 보이는데 착신만 조용히 죽으므로, 쓰기 전에
    // 판단할 수 있는 것은 전부 판단해서 보여 준다 (libs/firebaseKey.ts).

    /** 지금 키의 상태 + 바뀌었을 때의 영향 범위. */
    router.get('/firebase', async (_req: Request, res: Response) => {
        const status = installedStatus();
        const live = await Firebase.verifyLive();

        // 이 키가 죽으면 몇 집이 전화를 못 받는지. 숫자가 있어야 위험이 실감된다.
        let affectedDevices: number | null = null;
        try {
            const [row] = await DbConn.select(
                `SELECT COUNT(*) AS n FROM ${config.tables.mobile} WHERE active = 1`);
            affectedDevices = Number(row.n) || 0;
        } catch {
            // DB 가 끊겨도 키 상태는 보여준다.
        }

        res.json({ ...status, live, affectedDevices, channelId: config.firebase.channelId });
    });

    /**
     * 올리기 전에 살펴보기만 한다. **파일을 건드리지 않는다.**
     *
     * 화면이 파일을 고른 즉시 이걸 부른다 — 사람이 "적용" 을 누르기 전에
     * 프로젝트가 바뀐다는 사실을 알아야 하기 때문이다.
     */
    router.post('/firebase/analyze', (req: Request, res: Response) => {
        const raw = typeof req.body?.content === 'string' ? req.body.content : '';
        if (!raw.trim()) return res.status(400).json({ error: 'content 가 비어 있습니다.' });
        res.json(analyze(raw));
    });

    /** 키를 설치한다. 덮어쓰기 전에 백업하고, 설치 후 실제로 통하는지 확인한다. */
    router.post('/firebase', async (req: Request, res: Response) => {
        const raw = typeof req.body?.content === 'string' ? req.body.content : '';
        if (!raw.trim()) return res.status(400).json({ error: 'content 가 비어 있습니다.' });

        try {
            const result = await install(raw);
            if (!result.ok) {
                // 400 이지만 분석 결과를 그대로 실어 준다 — 화면이 왜 거부됐는지 보여줘야 한다.
                return res.status(400).json({ error: '사용할 수 없는 키입니다.', analysis: result.analysis });
            }
            logger.warn(`[dashboard] FCM 키 교체됨 (by ${(req as any).user?.username})`);
            res.json({ ...result, status: installedStatus() });
        } catch (err: any) {
            logger.error('FCM 키 설치 실패:', err.message);
            res.status(500).json({ error: `키를 저장하지 못했습니다: ${err.message}` });
        }
    });

    /** 지금 설치된 키가 실제로 통하는지 Google 에 물어본다. */
    router.post('/firebase/verify', async (_req: Request, res: Response) => {
        res.json(await Firebase.verifyLive());
    });

    /** 키를 내린다. 푸시만 꺼지고 중계는 계속 돈다. */
    router.delete('/firebase', async (req: Request, res: Response) => {
        try {
            const result = await remove();
            logger.warn(`[dashboard] FCM 키 내림 (by ${(req as any).user?.username})`);
            res.json({ ...result, status: installedStatus() });
        } catch (err: any) {
            logger.error('FCM 키 삭제 실패:', err.message);
            res.status(500).json({ error: `키를 지우지 못했습니다: ${err.message}` });
        }
    });

    /** 등록된 홈넷 장치 */
    router.get('/homenet', async (req: Request, res: Response) => {
        try {
            const rows = await DbConn.select(
                `SELECT id, complex_id, type, building, unit, ipaddress, created, modified
                   FROM ${config.tables.homenet} ORDER BY building, unit`);
            // 표시 이름(complex)은 더 이상 채우지 않는다. 화면은 단지코드를 보여준다
            // (schema/008-homenet-complex-id.sql).
            res.json({ complexId: complexId(), records: rows });
        } catch (err: any) {
            fail(res, err, 'Failed to fetch homenet records');
        }
    });

    /**
     * 홈넷 장치를 손으로 넣는다.
     *
     * 정상 경로는 월패드가 스스로 `POST /register/complex_agents` 를 부르는
     * 것이다. 이 화면은 **그 전에** 세대를 열어 둬야 할 때 쓴다 — 월패드가 아직
     * 없는 집의 모바일 등록을 시험하려면, 이 표에 그 동/호가 있어야 `409
     * no_wallpad` 를 넘어설 수 있기 때문이다 (libs/enrollment.ts).
     *
     * ⚠️ 여기에 넣은 세대는 **그 집 사람이 아닌 단말도 등록 대기까지 올 수 있게**
     *    한다. 대기는 아무 권한이 없고 승인이 있어야 통화·제어가 열리므로
     *    (schema/005-enrollment.sql) 곧바로 위험해지지는 않지만, 시험이 끝나면
     *    지우는 편이 맞다.
     *
     * 규칙은 장치 경로와 같은 것을 쓴다 (libs/homenetRecord.ts).
     */
    router.post('/homenet', async (req: Request, res: Response) => {
        try {
            const result = await saveHomenetRecord(req.body, 'create');
            if (!result.ok) return res.status(statusFor(result.kind)).json({ error: result.message });
            logger.info(`[dashboard] homenet ${result.value.id} created (by ${(req as any).user?.username})`);
            res.status(201).json({ id: result.value.id });
        } catch (err: any) {
            fail(res, err, 'Failed to create homenet record');
        }
    });

    router.delete('/homenet/:id', async (req: Request, res: Response) => {
        try {
            // 월패드 번호는 동/호에서 계산되므로 지우기 **전에** 동/호를 읽어야 한다.
            const [place] = await DbConn.select(
                `SELECT building, unit FROM ${config.tables.homenet} WHERE id = ?`, [req.params.id]);

            const result = await DbConn.execute(
                `DELETE FROM ${config.tables.homenet} WHERE id = ?`, [req.params.id]);
            if (result.affectedRows === 0) return res.status(404).json({ error: 'not found' });

            if (place) {
                const user = wallpadSipUser(place.building, place.unit);
                if (user) await sipAccount.revoke(user);
            }
            logger.info(`[dashboard] homenet ${req.params.id} deleted (by ${(req as any).user?.username})`);
            res.json({ id: Number(req.params.id) });
        } catch (err: any) {
            fail(res, err, 'Failed to delete homenet record');
        }
    });

    return router;
}

export default createDashboardApi;
