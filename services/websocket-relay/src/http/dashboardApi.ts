/**
 * @file dashboardApi.ts
 * @brief 관리 대시보드용 API. 전부 manager 로그인 세션을 요구한다.
 *
 * 서비스 본연의 REST(/register, /room, /status ...)는 Android 클라이언트가 쓰는 것이고,
 * 여기 있는 것들은 사람이 보는 대시보드 전용이다. 경로가 겹치지 않게 분리해 둔다.
 */
import { Router, Request, Response } from 'express';
import { DbConn } from '../libs/dbConnection';
import { requireAuth } from '../auth/session';
import config from '../config';
import { getGateway } from '../gateway';
import { createMobileRecord, updateMobileRecord, statusFor } from '../libs/mobileRecord';
import logger from '../libs/logger';
import { COMPLEX_ID } from '../libs/complex';

/** 목록에 내보낼 컬럼. token 은 FCM 자격이라 싣지 않는다. */
// token 은 FCM 자격이라 싣지 않는다. 대신 그 토큰이 쓸 만한지를 알려 주는 값들을
// 싣는다 — sip_user 가 비어 있으면 인터폰 착신이 조용히 0건이고, push_error 가
// 있으면 그 단말에는 푸시가 닿지 않고 있다.
const PUBLIC_COLUMNS = 'id, uuid, email, complex, complex_id, address, phone, active, created, modified, sip_user, token_updated_at, push_error, push_failed_at';

function fail(res: Response, err: any, what: string) {
    logger.error(`${what}:`, err.message);
    if (!DbConn.isConfigured()) {
        return res.status(503).json({ error: 'database is not configured' });
    }
    res.status(500).json({ error: what });
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
            complexId: COMPLEX_ID,
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
                complexId: COMPLEX_ID,
                records: rows.map((r: any) => ({ ...r, active: r.active === 1 })),
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

    router.delete('/mobiles/:id', async (req: Request, res: Response) => {
        try {
            const result = await DbConn.execute(
                `DELETE FROM ${config.tables.mobile} WHERE id = ?`, [req.params.id]);
            if (result.affectedRows === 0) return res.status(404).json({ error: 'not found' });
            logger.info(`[dashboard] mobile ${req.params.id} deleted (by ${(req as any).user?.username})`);
            res.json({ id: Number(req.params.id) });
        } catch (err: any) {
            fail(res, err, 'Failed to delete mobile record');
        }
    });

    /** 등록된 홈넷 장치 */
    router.get('/homenet', async (req: Request, res: Response) => {
        try {
            const rows = await DbConn.select(
                `SELECT id, complex, type, building, unit, ipaddress, created, modified
                   FROM ${config.tables.homenet} ORDER BY complex, building, unit`);
            res.json({ records: rows });
        } catch (err: any) {
            fail(res, err, 'Failed to fetch homenet records');
        }
    });

    router.delete('/homenet/:id', async (req: Request, res: Response) => {
        try {
            const result = await DbConn.execute(
                `DELETE FROM ${config.tables.homenet} WHERE id = ?`, [req.params.id]);
            if (result.affectedRows === 0) return res.status(404).json({ error: 'not found' });
            logger.info(`[dashboard] homenet ${req.params.id} deleted (by ${(req as any).user?.username})`);
            res.json({ id: Number(req.params.id) });
        } catch (err: any) {
            fail(res, err, 'Failed to delete homenet record');
        }
    });

    return router;
}

export default createDashboardApi;
