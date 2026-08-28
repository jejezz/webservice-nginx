/**
 * npm run db:status
 *
 * DB 에 무엇이 들어 있는지 본다. 적용된 마이그레이션, 표별 행 수와 인덱스,
 * 최근 등록 몇 건.
 *
 * "등록이 됐는데 푸시가 안 온다" 같은 문의가 왔을 때 제일 먼저 볼 화면이다.
 * 대시보드가 안 뜨는 상황에서도 쓸 수 있어야 하므로 서비스와 무관하게 동작한다.
 */

import mysql from 'mysql2/promise';
import { loadEnv, dbSettings, envExists, tableNames, migrations } from './lib/env';
import { connectApp } from './lib/db';
import { Reporter, colors } from './lib/ui';

const report = new Reporter();

async function main(): Promise<void> {
    if (!envExists()) {
        report.bad('.env 가 없습니다.', 'npm run setup');
        report.finish();
    }

    loadEnv();
    const db = dbSettings();
    const { mobile, homenet } = tableNames();

    const conn = await connectApp();

    try {
        const [ver] = await conn.query<mysql.RowDataPacket[]>('SELECT VERSION() AS v');
        report.step(`${db.database} @ ${db.host}:${db.port}`);
        report.ok(`서버 ${ver[0].v}, 계정 ${db.user}`);
        report.info(`비밀번호 출처: ${db.passwordFrom || '(읽지 못함)'}`);

        await reportMigrations(conn);

        report.step('표');
        for (const table of [mobile, homenet]) {
            await describeTable(conn, db.database, table);
        }

        // 최근 등록. 토큰은 찍지 않는다 — 로그나 화면에 남으면 그 단말로 푸시를 보낼 수 있다.
        const [recent] = await conn.query<mysql.RowDataPacket[]>(
            `SELECT id, email, \`address\`, active, push_error, created
               FROM \`${mobile}\` ORDER BY created DESC LIMIT 5`,
        );
        if (recent.length > 0) {
            console.log(`\n  ${colors.DIM}최근 등록 ${recent.length}건${colors.RESET}`);
            for (const row of recent) {
                const state = row.active ? '활성' : '비활성';
                // push_error 가 있으면 그 단말에는 푸시가 닿지 않고 있다는 뜻이다.
                const note = row.push_error ? `  ${colors.YELLOW}${row.push_error}${colors.RESET}` : '';
                console.log(
                    `    #${String(row.id).padEnd(5)} ${String(row.address).padEnd(12)} ` +
                    `${String(row.email).padEnd(24)} ${state}  ${row.created ?? ''}${note}`,
                );
            }
        }
    } catch (err) {
        report.bad(`조회 실패: ${message(err)}`);
    } finally {
        await conn.end();
    }

    report.finish();
}

/** schema/*.sql 중 무엇이 적용됐는지. 안 맞으면 db:migrate 를 알려 준다. */
async function reportMigrations(conn: mysql.Connection): Promise<void> {
    report.step('마이그레이션');

    let applied: Set<string>;
    try {
        const [rows] = await conn.query<mysql.RowDataPacket[]>('SELECT version FROM schema_migrations');
        applied = new Set(rows.map((r) => String(r.version)));
    } catch {
        report.bad('schema_migrations 표가 없습니다 — 스키마가 한 번도 적용되지 않았습니다.', 'npm run db:migrate');
        return;
    }

    for (const migration of migrations()) {
        if (applied.has(migration.version)) report.ok(migration.file);
        else report.bad(`${migration.file} 미적용`, 'npm run db:migrate');
    }
}

/** 표 하나의 존재 여부·행 수·인덱스를 보고한다. */
async function describeTable(conn: mysql.Connection, schema: string, table: string): Promise<void> {
    const [exists] = await conn.query<mysql.RowDataPacket[]>(
        'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = ?',
        [schema, table],
    );

    if (exists[0].n === 0) {
        report.bad(`표 ${table} 이 없습니다.`, 'npm run db:migrate');
        return;
    }

    const [count] = await conn.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${table}\``);

    // 인덱스가 빠지면 조용히 느려지기만 하므로 눈에 보이게 해 둔다.
    const [indexes] = await conn.query<mysql.RowDataPacket[]>(
        'SELECT DISTINCT index_name FROM information_schema.statistics WHERE table_schema = ? AND table_name = ?',
        [schema, table],
    );
    const names = indexes.map((r) => r.index_name).join(', ');

    report.ok(`${table}: ${count[0].n}행  ${colors.DIM}[${names}]${colors.RESET}`);
}

function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

main().catch((err) => {
    console.error(`\n예상치 못한 오류: ${message(err)}`);
    process.exit(1);
});
