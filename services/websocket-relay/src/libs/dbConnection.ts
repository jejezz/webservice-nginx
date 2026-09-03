/**
 * @file dbConnection.ts
 * @brief MariaDB 연결 풀.
 *
 * 이 프로젝트의 DB 규약은 database/README.md 에 있다. 요약하면
 *
 *   - 스키마는 서비스가 소유한다 → services/websocket-relay/schema/*.sql
 *   - database/database.ini 의 [database:rtc_relay] 가 그 디렉토리를 가리킨다
 *   - 접속 계정은 공용 jyahn 하나이고, 비밀번호는 database/secrets/jyahn.pw 에 있다
 *   - 비밀번호는 소스에 쓰지 않는다
 *
 * 이관 전에는 이 파일이 MySQL 을 43306 포트로 찾다가 실패하면 SQLite 파일로
 * 폴백했다. 그 포트는 열린 적이 없어 사실상 항상 SQLite 로 떨어졌고, 요청마다
 * 새 연결을 만들면서 닫지 않아 누수가 있었다. 지금은 풀 하나를 공유한다.
 *
 * ⚠️ **런타임에 테이블을 만들지 않는다.** 스키마 적용은 `npm run db:migrate`
 *    (또는 sudo database/setup_mariadb.sh) 가 한다. 서버가 부팅 때마다 DDL 을
 *    돌리면 스키마의 실제 상태를 아무도 알 수 없게 되고, 마이그레이션 기록
 *    (schema_migrations)과도 어긋난다.
 */
import fs from 'fs';
import mysql, { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import config from '../config';
import logger from './logger';

/**
 * 예전에 이 파일이 직접 읽던 값들. 부르는 쪽 호환을 위해 남겨 두지만,
 * 실제 출처는 config 하나다.
 */
export const DATABASE = {
    HOST: config.db.host,
    PORT: config.db.port,
    USER: config.db.user,
    NAME: config.db.name,
    CONNECTION_LIMIT: config.db.connectionLimit,
    PASSWORD_FILE: config.db.passwordFile,
};

let pool: Pool | null = null;
let password: string | null = null;
let passwordError: string | null = null;

/** 마지막으로 확인한 접속 상태. /health 가 매번 DB 를 때리지 않도록 캐시해 둔다. */
let ready = false;
let lastError: string | null = null;

function loadPassword(): string | null {
    if (password !== null || passwordError !== null) return password;

    if (config.db.password) {
        password = config.db.password;
        return password;
    }

    try {
        const value = fs.readFileSync(config.db.passwordFile, 'utf8').split('\n')[0].trim();
        if (!value) throw new Error('파일이 비어 있습니다');
        password = value;
        return password;
    } catch (err: any) {
        passwordError = `${config.db.passwordFile}: ${err.message}`;
        lastError = passwordError;
        logger.warn(`DB 비밀번호를 읽을 수 없습니다 (${passwordError}) — 단말 등록 기능이 비활성화됩니다.`);
        return null;
    }
}

export function isConfigured(): boolean {
    return Boolean(config.db.host && config.db.name && loadPassword());
}

function getPool(): Pool | null {
    if (!isConfigured()) return null;

    if (!pool) {
        pool = mysql.createPool({
            host: config.db.host,
            port: config.db.port,
            user: config.db.user,
            password: loadPassword() as string,
            database: config.db.name,
            connectionLimit: config.db.connectionLimit,
            waitForConnections: true,
            // 큐를 무제한으로 두면 DB 가 느려질 때 요청이 끝없이 쌓인다.
            queueLimit: 100,
            charset: 'utf8mb4',
            // 커넥션이 방화벽에 조용히 끊기는 것을 막는다.
            enableKeepAlive: true,
            keepAliveInitialDelay: 10000,
            // 문자열로 받아야 날짜 형식이 드라이버/서버 타임존에 흔들리지 않는다.
            dateStrings: true,
        });
        logger.info(
            `DB pool created: ${config.db.user}@${config.db.host}:${config.db.port}/${config.db.name}`
        );
    }

    return pool;
}

function notConfigured(): Error {
    return new Error(
        passwordError ? `Database is not configured (${passwordError})` : 'Database is not configured'
    );
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
    if (!p) throw notConfigured();
    const [rows] = await p.execute<T[]>(sql, params);
    return rows;
}

/**
 * @brief INSERT/UPDATE/DELETE 실행. 영향받은 행 수 등을 담은 헤더를 돌려준다.
 */
export async function execute(sql: string, params: any[] = []): Promise<ResultSetHeader> {
    const p = getPool();
    if (!p) throw notConfigured();
    const [result] = await p.execute<ResultSetHeader>(sql, params);
    return result;
}

/** @brief 연결 확인. 실패해도 예외를 던지지 않고 상태를 돌려준다. (/health 용) */
export async function ping(): Promise<{ configured: boolean; ok: boolean; database?: string; error?: string }> {
    if (!isConfigured()) {
        ready = false;
        return { configured: false, ok: false, error: passwordError || 'not configured' };
    }
    try {
        const rows = await select('SELECT 1 AS ok');
        if (!ready) logger.info('MariaDB 연결됨.');
        ready = rows.length === 1;
        lastError = null;
        return { configured: true, ok: ready, database: config.db.name };
    } catch (err: any) {
        const message = err.code || err.message;
        // 같은 오류를 15초마다 반복해서 찍지 않는다.
        if (ready || lastError !== message) {
            logger.error(`MariaDB 연결 실패: ${message}`);
        }
        ready = false;
        lastError = message;
        return { configured: true, ok: false, error: message };
    }
}

/**
 * 지금 DB 를 쓸 수 있는지 (**캐시된 값** — 질의를 보내지 않는다).
 * /health 가 5초마다 불리므로 여기서 DB 를 때리면 안 된다.
 */
export function isReady(): boolean {
    return ready;
}

/** 마지막 오류. /health 의 details 에 실어 원인을 바로 보이게 한다. */
export function lastErrorMessage(): string | null {
    return lastError;
}

/**
 * 부팅 시 한 번 확인하고, 이후 주기적으로 상태를 갱신한다.
 *
 * 실패해도 예외를 던지지 않는다 — 끊긴 채로 떠서 /health 가 degraded 를
 * 보고하고, DB 가 필요한 라우트만 실패한다. 죽이면 pm2 가 재시작만 반복하고
 * 원인이 로그에 묻힌다.
 */
export async function monitor(intervalMs = 15000): Promise<void> {
    await ping();

    // unref 라 이 타이머 때문에 프로세스가 살아 있지는 않는다.
    const timer = setInterval(() => { void ping(); }, intervalMs);
    timer.unref();
}

/** @brief 종료 시 풀을 닫는다. */
export async function close(): Promise<void> {
    if (pool) {
        await pool.end();
        pool = null;
    }
    ready = false;
}

export const DbConn = { select, execute, ping, close, isConfigured, isReady, lastErrorMessage, monitor };
export default DbConn;
