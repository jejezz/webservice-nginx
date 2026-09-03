//////////////////////////////////////////
// file: src/route/user.js
// description: Mobile User 목록을 전달한다.
// author: jyahn
// date: 2022-04-14
//////////////////////////////////////////

import express, { Request, Response, NextFunction } from 'express';
import config from '../config';
import { DbConn } from '../libs/dbConnection';
import logger from '../libs/logger'; // Import your configured logger

const Route2User = express.Router();

Route2User.use(function timeLog(req: Request, res: Response, next: NextFunction) {
    logger.info(`[register] ------ new request [ ${Date.now()} ]------`);
    next();
});

Route2User.get('/all', function (req: Request, res: Response) {
    responseToGetAll(req, res);
});

async function responseToGetAll(req: Request, res: Response) {
    try {
        // token 은 FCM 자격이라 목록에 싣지 않는다.
        const rows = await DbConn.select(
            `SELECT id, uuid, email, complex, complex_id, address, phone, active, created, modified, sip_user, token_updated_at, push_error, push_failed_at
               FROM ${config.tables.mobile}
              ORDER BY created DESC`);
        res.status(200).json(rows);
    } catch (err: any) {
        logger.error('사용자 목록 조회 실패:', err.message);
        res.status(500).json({ error: 'query failed' });
    }
}

export default Route2User;
