/**
 * @file dbConnection.ts
 * @brief MariaDB 연결 풀.
 *
 * 이 프로젝트의 DB 규약은 database/README.md 에 있다. 요약하면
 *
 *   - 스키마는 서비스가 소유한다 → services/rtc-relay-server/schema/*.sql
 *   - database/database.ini 의 [database:rtc_relay] 가 그 디렉토리를 가리킨다
 *   - 접속 계정은 공용 jyahn 하나이고, 비밀번호는 database/secrets/jyahn.pw 에 있다
 *   - 비밀번호는 소스에 쓰지 않는다
 *
 * 이관 전에는 이 파일이 MySQL 을 43306 포트로 찾다가 실패하면 SQLite 파일로
 * 폴백했다. 그 포트는 열린 적이 없어 사실상 항상 SQLite 로 떨어졌고, 요청마다
 * 새 연결을 만들면서 닫지 않아 누수가 있었다. 지금은 풀 하나를 공유한다.
 */
import fs from 'fs';
import path from 'path';
import mysql, { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import logger from './logger';

/** 서비스 디렉토리 (src 의 상위). 아래 상대 경로들의 기준점이다. */
const SERVICE_DIR = path.resolve(__dirname, '..', '..');

export const DATABASE = {
    HOST: process.env.DB_HOST || '127.0.0.1',
    PORT: parseInt(process.env.DB_PORT || '3306', 10),
    USER: process.env.DB_USER || 'jyahn',
    NAME: process.env.DB_NAME || 'rtc_relay',
    CONNECTION_LIMIT: parseInt(process.env.DB_CONNECTION_LIMIT || '5', 10),
    /** 서비스 디렉토리 기준 상대 경로. database/ 가 소유하는 파일이다. */
    PASSWORD_FILE: process.env.DB_PASSWORD_FILE || '../../database/secrets/jyahn.pw',
};

let pool: Pool | null = null;
let password: string | null = null;
let passwordError: string | null = null;

function loadPassword(): string | null {
    if (password !== null || passwordError !== null) return password;

    if (process.env.DB_PASSWORD) {
        password = process.env.DB_PASSWORD;
        return password;
    }

    const file = path.isAbsolute(DATABASE.PASSWORD_FILE)
        ? DATABASE.PASSWORD_FILE
        : path.resolve(SERVICE_DIR, DATABASE.PASSWORD_FILE);

    try {
        const value = fs.readFileSync(file, 'utf8').split('\n')[0].trim();
        if (!value) throw new Error('파일이 비어 있습니다');
        password = value;
        return password;
    } catch (err: any) {
        passwordError = `${file}: ${err.message}`;
        logger.warn(`DB 비밀번호를 읽을 수 없습니다 (${passwordError}) — 단말 등록 기능이 비활성화됩니다.`);
        return null;
    }
}

export function isConfigured(): boolean {
    return Boolean(DATABASE.HOST && DATABASE.NAME && loadPassword());
}

function getPool(): Pool | null {
    if (!isConfigured()) return null;

    if (!pool) {
        pool = mysql.createPool({
            host: DATABASE.HOST,
            port: DATABASE.PORT,
            user: DATABASE.USER,
            password: loadPassword() as string,
            database: DATABASE.NAME,
            connectionLimit: DATABASE.CONNECTION_LIMIT,
            waitForConnections: true,
            queueLimit: 0,
            charset: 'utf8mb4',
            // 문자열로 받아야 날짜 형식이 드라이버/서버 타임존에 흔들리지 않는다.
            dateStrings: true,
        });
        logger.info(
            `DB pool created: ${DATABASE.USER}@${DATABASE.HOST}:${DATABASE.PORT}/${DATABASE.NAME}`
        );
    }

    return pool;
}

/**
 * @brief SELECT 실행. 행 배열을 돌려준다.
 * @param sql    ? 플레이스홀더를 쓴 SQL. 값을 문자열로 이어붙이지 말 것.
 * @param params 플레이스홀더에 채울 값
 */
export async function select<T extends RowDataPacket = RowDataPacket>(
    sql: string,
    params: any[] = []
): Promise<T[]> {
    const p = getPool();
    if (!p) throw new Error(passwordError ? `Database is not configured (${passwordError})` : 'Database is not configured');
    const [rows] = await p.execute<T[]>(sql, params);
    return rows;
}

/**
 * @brief INSERT/UPDATE/DELETE 실행. 영향받은 행 수 등을 담은 헤더를 돌려준다.
 */
export async function execute(sql: string, params: any[] = []): Promise<ResultSetHeader> {
    const p = getPool();
    if (!p) throw new Error(passwordError ? `Database is not configured (${passwordError})` : 'Database is not configured');
    const [result] = await p.execute<ResultSetHeader>(sql, params);
    return result;
}

/** @brief 연결 확인. 실패해도 예외를 던지지 않고 상태를 돌려준다. (/health 용) */
export async function ping(): Promise<{ configured: boolean; ok: boolean; database?: string; error?: string }> {
    if (!isConfigured()) {
        return { configured: false, ok: false, error: passwordError || 'not configured' };
    }
    try {
        const rows = await select('SELECT 1 AS ok');
        return { configured: true, ok: rows.length === 1, database: DATABASE.NAME };
    } catch (err: any) {
        return { configured: true, ok: false, error: err.code || err.message };
    }
}

/** @brief 종료 시 풀을 닫는다. */
export async function close(): Promise<void> {
    if (pool) {
        await pool.end();
        pool = null;
    }
}

export const DbConn = { select, execute, ping, close, isConfigured };
export default DbConn;
