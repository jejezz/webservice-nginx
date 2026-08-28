/**
 * 스크립트용 DB 접속.
 *
 * src/libs/dbConnection.ts 는 서비스가 쓰는 풀이라 여기서는 안 쓴다 — import
 * 하면 로거가 붙고 재접속 타이머가 도는 등, 일회성 스크립트에는 맞지 않는
 * 부수효과가 생긴다. 스크립트는 접속 하나 열고 닫으면 그만이다.
 */

import mysql from 'mysql2/promise';
import { dbSettings, envExists, loadEnv, DB_SETUP } from './env';

function options() {
    const db = dbSettings();
    return {
        host: db.host,
        port: db.port,
        user: db.user,
        password: db.password,
        database: db.database,
        connectTimeout: 5000,
        charset: 'utf8mb4',
        dateStrings: true as const,
    };
}

/**
 * 앱 계정으로 붙는다. 실패하면 이유를 찍고 종료한다.
 * 호출부가 매번 같은 오류 처리를 반복하지 않도록 여기서 끝낸다.
 */
export async function connectApp(): Promise<mysql.Connection> {
    if (!envExists()) {
        console.error('  ✗ .env 가 없습니다.');
        console.error('    → npm run setup');
        process.exit(1);
    }

    loadEnv();
    const db = dbSettings();

    if (!db.password) {
        console.error(`  ✗ DB 비밀번호를 읽을 수 없습니다: ${db.passwordFile}`);
        console.error(`    → sudo ${DB_SETUP}`);
        process.exit(1);
    }

    try {
        return await mysql.createConnection(options());
    } catch (err) {
        console.error(`  ✗ 접속 실패: ${err instanceof Error ? err.message : String(err)}`);
        console.error(`    → sudo ${DB_SETUP}`);
        process.exit(1);
    }
}

/** 있는지 없는지만 본다. doctor 처럼 실패해도 계속 가야 하는 곳에서 쓴다. */
export async function tryConnectApp(): Promise<mysql.Connection | null> {
    const db = dbSettings();
    if (!db.password) return null;
    try {
        return await mysql.createConnection(options());
    } catch {
        return null;
    }
}
