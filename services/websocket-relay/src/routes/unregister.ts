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
import * as sipAccount from '../libs/sipAccount';
import * as janusToken from '../libs/janusToken';

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
        // 내선 번호는 지우기 **전에** 읽어 둔다. 지운 뒤에는 알 길이 없고,
        // 남겨 두면 표에서 사라진 단말이 SIP 로는 계속 등록할 수 있다.
        const sipUser = await sipAccount.sipUserOf({ uuid });
        await janusToken.removeForDevice({ uuid });

        const result = await DbConn.execute(
            `DELETE FROM ${config.tables.mobile} WHERE uuid = ?`, [uuid]);

        if (result.affectedRows === 0) {
            logger.info(`unregister: 대상 없음 (${uuid})`);
            res.status(404).json({ error: 'not registered' });
            return;
        }
        if (sipUser) await sipAccount.revoke(sipUser);
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