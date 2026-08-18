import mysql from 'mysql2';
import sqlite3  from 'sqlite3';
import logger from './logger'; // Import your configured logger

const mysqlconfig = {
    host: "localhost",
    port : 43306, //3306
    user: "jejezz",
    password: "__REDACTED__",
    database: "callfusion2rtc",
    pool: {
        max: 5,
        min: 0,
        acquire: 30000,
        idle: 10000
    }
};
    
export class DbConn {

    constructor() {
        /* do nothing */
    }

    public static async createSqlConnection() : Promise<any>  {
        return new Promise((resolve, reject) => {
            let timeoutId: NodeJS.Timeout;
            let conn : any;
            let timeout = 500; // 500ms;

            const attemptConnection = () => {
                conn = mysql.createConnection(mysqlconfig);
                conn.connect((err : Error) => {
                    if (err) {
                        logger.error('Error connecting to MySQL:', err.message);
                        const sqlite3db = sqlite3.verbose().Database;
                        conn = new sqlite3db('./cf2rtc-sqlite-db.db', (err) => {
                            if (err) {
                                logger.error('Failed to connect to the database:', err.message);
                                clearTimeout(timeoutId);
                                reject(err);
                            } else {
                                logger.info('Connected to the SQLite database.');
                                clearTimeout(timeoutId);
                                resolve({name: "sqlite", connection:conn});
                            }
                        });
                    } else {
                        logger.info('MySQL connection successful!');
                        clearTimeout(timeoutId);
                        resolve({name: "mysql", connection:conn});
                    }
                });
            };

            timeoutId = setTimeout(() => {
                if (conn) {
                    conn.end();
                }
                reject(new Error(`SQL connection timed out after ${timeout}ms`));
            }, timeout);

            attemptConnection();
        });
    }

    public static sqlQuery(db: any, sql: any, callback: Function) {
        if(db.name == "mysql") {
            db.connection.query(sql, function (error : any, results: any, fields: any) {
                if (error) {
                    logger.error(error);
                    callback(error);
                    return;
                }
                callback(null, results);
            });
        } else if(db.name == "sqlite") {
            db.connection.run(sql, [], (err : any) => {
                if (err) {
                    logger.error('Error executing SQLite query:', err.message);
                    callback(err);
                    return;
                }
                callback(null);
            });
        } else {
            logger.error('Invalid database connection type');
            callback(new Error('Invalid database connection type'));
        }
    }

    public static sqlSelect(db: any, sql: any, callback: Function) {
        if(db.name == "mysql") {
            db.connection.query(sql, (error : any, results : any, fields : any) =>{
                if (error) {
                    logger.error(error);
                    callback(error);
                    return;
                }
                callback(null, results);
            });
        } else if(db.name == "sqlite") {
            db.connection.all(sql, [], (err : any, rows : any) => {
                if (err) {
                    logger.error('Error executing SQLite query:', err.message);
                    callback(err);
                    return;
                }
                callback(null, rows);
            });
        } else {
            logger.error('Invalid database connection type');
            callback(new Error('Invalid database connection type'));
        }
    }
}

// module.exports = {
//   createSqlConnection: createSqlConnection,
//   sqlQuery: sqlQuery,
//   sqlSelect: sqlSelect
// };