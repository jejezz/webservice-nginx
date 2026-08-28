//////////////////////////////////////////
// file: src/route/register.js
// description: Mobile Registration 을 담당한다.
// author: jyahn
// date: 2022-04-14
//////////////////////////////////////////

import express, { Request, Response, NextFunction } from 'express';
import config from '../config';
import { DbConn } from '../libs/dbConnection';
import logger from '../libs/logger'; // Import your configured logger

const Route2Unregister = express.Router();

Route2Unregister.use(function timeLog(req: Request, res: Response, next: NextFunction) {
    logger.info(`[register] ------ new request [ ${Date.now()} ]------`);
    next();
});

Route2Unregister.post('/mobile', function (req: Request, res: Response) {
    responseToPostMobile(req, res);
});


Route2Unregister.get('/about', function (req: Request, res: Response) {
    res.send('this is de-registration module');
});


async function responseToPostMobile(req: Request, res: Response) {
    const uuid = req.body?.uuid;
    if (!uuid) {
        res.status(400).json({ error: 'uuid 는 필수입니다.' });
        return;
    }

    try {
        // 조회 없이 바로 지운다. 없으면 affectedRows 가 0 이다.
        const result = await DbConn.execute(
            `DELETE FROM ${config.tables.mobile} WHERE uuid = ?`, [uuid]);

        if (result.affectedRows === 0) {
            logger.info(`unregister: 대상 없음 (${uuid})`);
            res.status(404).json({ error: 'not registered' });
            return;
        }
        logger.info(`unregister: ${uuid}`);
        res.status(200).json({
            title: 'websocket-relay',
            result: 'success',
            message: 'Your registration has been removed successfully.',
        });
    } catch (err: any) {
        logger.error('unregister 실패:', err.message);
        res.status(500).json({ error: 'unregister failed' });
    }
}


// router.get('/users', function(req, res) {
//     db.connect();
//     const sql = `SELECT * FROM rtc_mobiles`;
//     //console.log('sql: ', sql);
//     db.query(sql, function(error, rows, fields) {
//         if(error) throw error;
//         res.send(rows);
//     });
//     db.end();
// });
export default Route2Unregister;