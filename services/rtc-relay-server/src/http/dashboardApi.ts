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
import { CallFusion } from '../index';
import logger from '../libs/logger';

/** 목록에 내보낼 컬럼. token 은 FCM 자격이라 싣지 않는다. */
const PUBLIC_COLUMNS = 'id, uuid, email, complex, address, phone, active, created, modified';

function fail(res: Response, err: any, what: string) {
    logger.error(`${what}:`, err.message);
    if (!DbConn.isConfigured()) {
        return res.status(503).json({ error: 'database is not configured' });
    }
    res.status(500).json({ error: what });
}

export function createDashboardApi(callFusion: CallFusion): Router {
    const router = Router();

    // 이 아래 전부 로그인 필요
    router.use(requireAuth);

    /** 현재 로그인한 사용자 */
    router.get('/me', (req: Request, res: Response) => {
        res.json({ user: (req as any).user });
    });

    /** 개요 — 서비스 상태 한 눈에 */
    router.get('/overview', async (req: Request, res: Response) => {
        const table = callFusion.roomTable;

        let mobiles = null;
        let homenet = null;
        try {
            const [m] = await DbConn.select(
                `SELECT COUNT(*) AS total, SUM(active = 1) AS active FROM ${CallFusion.getTableForMobile()}`);
            const [h] = await DbConn.select(
                `SELECT COUNT(*) AS total FROM ${CallFusion.getTableForHomenet()}`);
            mobiles = { total: Number(m.total) || 0, active: Number(m.active) || 0 };
            homenet = { total: Number(h.total) || 0 };
        } catch {
            // DB 가 끊겨도 개요는 보여준다. 카드에서 '—' 로 표시된다.
        }

        res.json({
            service: 'rtc-relay-server',
            uptimeSec: Math.floor(process.uptime()),
            pid: process.pid,
            memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
            nodeEnv: process.env.NODE_ENV ?? 'unknown',
            httpsPort: Number(process.env.HTTPS_PORT) || 28090,
            rooms: table.roomTable.size,
            connections: table.websocketCount(),
            database: await DbConn.ping(),
            mobiles,
            homenet,
        });
    });

    /** 활성 방과 접속 클라이언트 */
    router.get('/rooms', (req: Request, res: Response) => {
        const table = callFusion.roomTable;

        const rooms = Array.from(table.roomTable.entries()).map(([roomId, room]) => ({
            roomId,
            clientCount: room.clients.size,
            registerTimeout: room.registerTimeout,
            clients: Array.from(room.clients.values()).map((c) => ({
                clientId: c.cid,
                address: c.address,
                ipAddress: c.ipaddress,
                agent: c.agent,
                device: c.device,
                initiator: c.initiator,
                alive: c.alive,
                subscription: c.susbcription,
                queued: c.messageQueue.length,
            })),
        }));

        res.json({
            totalRooms: table.roomTable.size,
            totalConnections: table.websocketCount(),
            rooms,
        });
    });

    /** 등록된 모바일 단말 */
    router.get('/mobiles', async (req: Request, res: Response) => {
        try {
            const rows = await DbConn.select(
                `SELECT ${PUBLIC_COLUMNS} FROM ${CallFusion.getTableForMobile()} ORDER BY created DESC`);
            res.json({ records: rows.map((r: any) => ({ ...r, active: r.active === 1 })) });
        } catch (err: any) {
            fail(res, err, 'Failed to fetch mobile records');
        }
    });

    router.patch('/mobiles/:id/toggle-active', async (req: Request, res: Response) => {
        try {
            const result = await DbConn.execute(
                `UPDATE ${CallFusion.getTableForMobile()} SET active = 1 - active WHERE id = ?`,
                [req.params.id]);
            if (result.affectedRows === 0) return res.status(404).json({ error: 'not found' });

            const rows = await DbConn.select(
                `SELECT active FROM ${CallFusion.getTableForMobile()} WHERE id = ?`, [req.params.id]);
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
                `DELETE FROM ${CallFusion.getTableForMobile()} WHERE id = ?`, [req.params.id]);
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
                   FROM ${CallFusion.getTableForHomenet()} ORDER BY complex, building, unit`);
            res.json({ records: rows });
        } catch (err: any) {
            fail(res, err, 'Failed to fetch homenet records');
        }
    });

    router.delete('/homenet/:id', async (req: Request, res: Response) => {
        try {
            const result = await DbConn.execute(
                `DELETE FROM ${CallFusion.getTableForHomenet()} WHERE id = ?`, [req.params.id]);
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
