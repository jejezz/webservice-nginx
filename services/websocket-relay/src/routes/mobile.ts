/**
 * @file mobile.ts
 * @brief 등록된 모바일 단말의 CRUD. 내부망에서만 접근한다 (index.ts 의 미들웨어).
 *
 * 이관 전에는 sqlite3 를 직접 열고 요청마다 파일을 여닫았다. 지금은 프로젝트 규약대로
 * MariaDB(rtc_relay) 풀을 쓴다 — database/README.md 참고.
 * 쿼리는 원래도 ? 플레이스홀더를 쓰고 있어 그 방식을 그대로 유지한다.
 */
import { Router, Request, Response } from 'express';
import { DbConn } from '../libs/dbConnection';
import logger from '../libs/logger.js';
import config from '../config';
import { createMobileRecord, updateMobileRecord, statusFor } from '../libs/mobileRecord';

const router = Router();

/**
 * 목록·상세에서 내보낼 컬럼. token 은 FCM 자격이라 절대 싣지 않는다.
 *
 * 대신 그 토큰이 **쓸 만한지**를 알려 주는 값들을 싣는다 — sip_user 가 비어 있으면
 * 인터폰 착신이 조용히 0건이 되고, push_error 가 있으면 그 단말에는 푸시가 닿지
 * 않고 있다는 뜻이다. 예전에는 둘 다 어느 API 로도 볼 수 없었다.
 */
const PUBLIC_COLUMNS = 'id, uuid, email, complex, complex_id, address, phone, active, created, modified, sip_user, token_updated_at, push_error, push_failed_at';

/** MariaDB 의 TINYINT(1) 을 boolean 으로 바꿔 내보낸다. */
function toRecord(row: any) {
    return { ...row, active: row.active === 1 };
}

/** 라우트 공통 오류 처리. DB 미설정과 질의 실패를 구분한다. */
function fail(res: Response, err: any, what: string) {
    logger.error(`${what}:`, err.message);
    if (!DbConn.isConfigured()) {
        return res.status(503).json({ error: 'database is not configured' });
    }
    res.status(500).json({ error: what });
}

// CREATE
//
// 생성·수정 규칙은 libs/mobileRecord.ts 한 곳에 있다. 대시보드 API 도 같은 것을
// 부른다 — 두 벌로 두면 sip_user 형식이나 token 뒷정리가 조용히 갈라진다.
router.post('/', async (req: Request, res: Response) => {
    try {
        const result = await createMobileRecord(req.body);
        if (!result.ok) return res.status(statusFor(result.kind)).json({ error: result.message });
        res.status(201).json({ id: result.value.id, message: 'Mobile record created successfully' });
    } catch (err: any) {
        fail(res, err, 'Failed to create mobile record');
    }
});

// READ - 목록
router.get('/', async (req: Request, res: Response) => {
    const { active } = req.query;
    // LIMIT/OFFSET 은 프리페어드 문에서 문자열로 바인딩되면 문법 오류가 나므로 정수로 고정한다.
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '100'), 10) || 100, 1), 1000);
    const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);

    const where = active !== undefined ? 'WHERE active = ?' : '';
    const params = active !== undefined ? [active === 'true' ? 1 : 0] : [];

    try {
        const rows = await DbConn.select(
            `SELECT ${PUBLIC_COLUMNS} FROM ${config.tables.mobile}
             ${where} ORDER BY created DESC LIMIT ${limit} OFFSET ${offset}`,
            params
        );
        res.json({ records: rows.map(toRecord), total: rows.length, limit, offset });
    } catch (err: any) {
        fail(res, err, 'Failed to fetch mobile records');
    }
});

// READ - 통계. 목록보다 먼저 선언해야 '/:id' 에 먹히지 않는다.
router.get('/stats/summary', async (req: Request, res: Response) => {
    try {
        const [row] = await DbConn.select(
            `SELECT COUNT(*) AS total,
                    SUM(active = 1) AS active,
                    SUM(active = 0) AS inactive,
                    SUM(created > NOW() - INTERVAL 7 DAY) AS recent
               FROM ${config.tables.mobile}`
        );
        res.json({
            total: Number(row.total) || 0,
            active: Number(row.active) || 0,
            inactive: Number(row.inactive) || 0,
            recentlyAdded: Number(row.recent) || 0,
            timestamp: new Date().toISOString(),
        });
    } catch (err: any) {
        fail(res, err, 'Failed to get stats');
    }
});

// READ - uuid 로 조회. '/:id' 보다 먼저 선언한다.
router.get('/uuid/:uuid', async (req: Request, res: Response) => {
    try {
        const rows = await DbConn.select(
            `SELECT ${PUBLIC_COLUMNS} FROM ${config.tables.mobile} WHERE uuid = ?`,
            [req.params.uuid]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Mobile record not found' });
        res.json(toRecord(rows[0]));
    } catch (err: any) {
        fail(res, err, 'Failed to fetch mobile record');
    }
});

// READ - id 로 조회
router.get('/:id', async (req: Request, res: Response) => {
    try {
        const rows = await DbConn.select(
            `SELECT ${PUBLIC_COLUMNS} FROM ${config.tables.mobile} WHERE id = ?`,
            [req.params.id]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Mobile record not found' });
        res.json(toRecord(rows[0]));
    } catch (err: any) {
        fail(res, err, 'Failed to fetch mobile record');
    }
});

// UPDATE - 부분 갱신
router.put('/:id', async (req: Request, res: Response) => {
    try {
        const result = await updateMobileRecord(req.params.id, req.body);
        if (!result.ok) return res.status(statusFor(result.kind)).json({ error: result.message });
        res.json({ id: result.value.id, message: 'Mobile record updated successfully' });
    } catch (err: any) {
        fail(res, err, 'Failed to update mobile record');
    }
});

// UPDATE - active 뒤집기. 조회 없이 한 번으로 끝낸다.
router.patch('/:id/toggle-active', async (req: Request, res: Response) => {
    try {
        const result = await DbConn.execute(
            // 사람이 정한 상태라는 표시로 실패 코드를 지운다 — 그래야 다음
            // /register 의 자동 복구가 이 판단을 뒤집지 않는다.
            `UPDATE ${config.tables.mobile}
                SET active = 1 - active, push_error = NULL, push_failed_at = NULL
              WHERE id = ?`,
            [req.params.id]);
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Mobile record not found' });

        const rows = await DbConn.select(
            `SELECT active FROM ${config.tables.mobile} WHERE id = ?`, [req.params.id]);
        const active = rows[0]?.active === 1;
        logger.info(`Mobile record ${req.params.id} active → ${active}`);
        res.json({ message: 'Active status toggled successfully', id: Number(req.params.id), active });
    } catch (err: any) {
        fail(res, err, 'Failed to toggle active status');
    }
});

// DELETE
router.delete('/:id', async (req: Request, res: Response) => {
    try {
        const result = await DbConn.execute(
            `DELETE FROM ${config.tables.mobile} WHERE id = ?`, [req.params.id]);
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Mobile record not found' });
        logger.info(`Mobile record deleted: ID ${req.params.id}`);
        res.json({ message: 'Mobile record deleted successfully', id: Number(req.params.id) });
    } catch (err: any) {
        fail(res, err, 'Failed to delete mobile record');
    }
});

export default router;
