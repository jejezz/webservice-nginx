//////////////////////////////////////////
// file: src/route/user.js
// description: Mobile User 목록을 전달한다.
// author: jyahn
// date: 2022-04-14
//////////////////////////////////////////

import express, { Request, Response, NextFunction } from 'express';
import mysql, { MysqlError } from 'mysql';
import { CallFusion } from '../index';
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
    const findQry = `SELECT * FROM ${CallFusion.getTableForMobile()}`;
    let db = await DbConn.createSqlConnection();
    DbConn.sqlSelect(db, findQry, function (error: any, rows:any, fields:any) {
        if (error) {
            logger.error(error);
            res.status(401).send(error);
            return;
        }
        if (!rows) return;
        logger.info("User infos are ", rows);
        res.status(200).send(rows);
    });
}

export default Route2User;
