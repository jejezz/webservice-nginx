//////////////////////////////////////////
// file: src/route/register.js
// description: Mobile Registration 을 담당한다.
// author: jyahn
// date: 2022-04-14
//////////////////////////////////////////

import express, { Request, Response, NextFunction } from 'express';
import { MysqlError } from 'mysql';
import { CallFusion } from '../index';
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
    const d = new Date();
    let datestring = d.getFullYear() + "-" + (d.getMonth() + 1)
        + "-" + d.getDate() + " " + d.getHours() + ":" + d.getMinutes() + ":" + d.getSeconds();

    const findQry = `SELECT COUNT(*) AS cnt FROM ${CallFusion.getTableForMobile()} WHERE uuid="${req.body.uuid}"`;
    let db = await DbConn.createSqlConnection();
    DbConn.sqlSelect(db, findQry, function (error:any, rows:any, fields:any) {
        if (error) {
            logger.error(error);
            res.status(401).send(error);
            return;
        }
        if (!rows) {
            logger.error("table not found");
            res.status(200).send("table not found");
            return;
        }
        logger.info("mobile devices - results = ", rows[0].cnt);
        if (rows[0].cnt > 0) {
            const deleteQry = `DELETE FROM ${CallFusion.getTableForMobile()} WHERE uuid="${req.body.uuid}"`;
            DbConn.sqlQuery(db, deleteQry, function (error:any, results:any, fields:any) {
                if (error) {
                    logger.error(error);
                    res.status(401).send(error);
                    return;
                }
                res.status(200).send(`{ 
                    title: "CallFusion2RTC",
                    result: "success",
                    message: "Your token has been updated successfully." 
                }`);
            });
        }
    });
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