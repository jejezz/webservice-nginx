/**
 * npm run db:migrate
 *
 * `schema/*.sql` 을 이름순으로 적용한다. 이미 적용된 것은 건너뛴다.
 *
 * ── 왜 서버가 하지 않는가 ────────────────────────────────────────
 * 서버가 부팅 때마다 DDL 을 돌리면 스키마의 실제 상태를 아무도 알 수 없게 되고,
 * 인스턴스가 둘 이상일 때 서로 다른 순서로 같은 표를 만들려 든다. 적용은
 * 사람이 한 번, 명시적으로 한다.
 *
 * ── 무엇이 적용됐는지 어떻게 아는가 ──────────────────────────────
 * `schema_migrations` 표 하나가 기록이다. 각 .sql 파일이 마지막 줄에서 자기
 * 이름을 넣게 되어 있으므로(001-initial 이 그 표를 만든다), 이 스크립트는
 * 그 표를 읽어 아직 없는 파일만 실행한다.
 *
 * DB·계정 자체를 만드는 일은 여기서 하지 않는다 — 이 모노레포에서는
 * `sudo database/setup_mariadb.sh` 가 database.ini 를 보고 한다.
 */

import mysql from 'mysql2/promise';
import { loadEnv, dbSettings, envExists, migrations, DB_SETUP } from './lib/env';
import { connectApp } from './lib/db';
import { Reporter, colors } from './lib/ui';

// 타입을 명시한다 — TS 는 `never` 를 돌려주는 호출로 흐름이 끝났다고 보려면
// 호출 대상이 **명시적으로 타입이 붙은** 이름이어야 한다 (추론된 타입은 안 된다).
const report: Reporter = new Reporter();

async function main(): Promise<void> {
    if (!envExists()) {
        report.bad('.env 가 없습니다.', 'npm run setup');
        report.finish();
    }

    loadEnv();
    const db = dbSettings();
    const files = migrations();

    report.step(`스키마 적용 — ${db.database} @ ${db.host}:${db.port}`);

    if (files.length === 0) {
        report.bad('schema/*.sql 을 찾을 수 없습니다.');
        report.finish();
    }

    const conn = await connectApp();

    try {
        const applied = await appliedVersions(conn);

        let ran = 0;
        for (const migration of files) {
            if (applied.has(migration.version)) {
                report.ok(`${migration.file} ${colors.DIM}(이미 적용됨)${colors.RESET}`);
                continue;
            }

            try {
                for (const statement of migration.statements) {
                    await conn.query(statement);
                }
                // 파일이 스스로 기록하지 않는 경우를 대비해 여기서도 넣어 둔다.
                // 001-initial 이 표를 만들기 전에는 이 질의가 실패하므로 무시한다.
                await conn
                    .query('INSERT IGNORE INTO schema_migrations (version) VALUES (?)', [migration.version])
                    .catch(() => undefined);
                report.ok(`${migration.file} 적용`);
                ran++;
            } catch (err) {
                report.bad(`${migration.file} 실패: ${message(err)}`);
                // 순서가 있는 변경이라 하나라도 실패하면 뒤를 돌리지 않는다.
                break;
            }
        }

        if (ran === 0 && report.problems === 0) {
            report.info('적용할 것이 없습니다.');
        }
    } finally {
        await conn.end();
    }

    report.finish('npm run db:status');
}

/**
 * 이미 적용된 버전 목록.
 *
 * 표가 없으면 (처음 돌리는 것이라) 빈 집합을 준다 — 001-initial 이 그 표를
 * 만든다. 접속 자체가 안 되는 경우와 구분하기 위해 오류 코드를 본다.
 */
async function appliedVersions(conn: mysql.Connection): Promise<Set<string>> {
    try {
        const [rows] = await conn.query<mysql.RowDataPacket[]>('SELECT version FROM schema_migrations');
        return new Set(rows.map((r) => String(r.version)));
    } catch (err: any) {
        if (err?.code === 'ER_NO_SUCH_TABLE') return new Set();
        report.bad(`schema_migrations 를 읽을 수 없습니다: ${message(err)}`, `sudo ${DB_SETUP}`);
        report.finish();
    }
}

function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

main().catch((err) => {
    console.error(`\n예상치 못한 오류: ${message(err)}`);
    process.exit(1);
});
