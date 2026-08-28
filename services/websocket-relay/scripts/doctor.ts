/**
 * npm run doctor
 *
 * 지금 상태가 맞는지 점검한다. **아무것도 고치지 않는다.**
 * 문제가 있으면 항목마다 해결 명령을 붙이고 종료 코드 1로 끝난다.
 *
 * 몇 달 뒤 "왜 안 되지" 싶을 때 제일 먼저 돌릴 것.
 */

import fs from 'fs';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import mysql from 'mysql2/promise';
import {
    loadEnv, dbSettings, envExists, tableNames, migrations, healthUrl,
    ROOT, APP_NAME, BASE_PATH, DASHBOARD_DIR, NGINX_INSTALLER, NGINX_LIVE_CONF, DB_SETUP,
    resolveFromRoot,
} from './lib/env';
import { Reporter } from './lib/ui';

const report = new Reporter();

async function main(): Promise<void> {
    loadEnv();

    checkEnv();
    checkDeps();
    checkDashboard();
    checkPush();
    await checkDatabase();
    checkPm2();
    checkNginx();
    await checkHealth();

    report.finish('npm run setup');
}

// ── 설정 ─────────────────────────────────────────────
function checkEnv(): void {
    report.step('설정');

    if (!envExists()) {
        report.bad('.env 가 없습니다.', 'npm run setup');
        return;
    }
    report.ok('.env 있음');

    const db = dbSettings();
    report.ok(`DB 대상: ${db.user}@${db.host}:${db.port}/${db.database}`);

    if (!db.password) {
        report.bad(`DB 비밀번호를 읽을 수 없습니다: ${db.passwordFile}`, `sudo ${DB_SETUP}`);
    } else {
        report.info(`비밀번호 출처: ${db.passwordFrom}`);
    }

    // 단지 ID 는 틀린 형식이면 서버가 조용히 검사를 끄고 뜬다. 여기서 드러낸다.
    const complex = (process.env.COMPLEX_ID ?? '').trim();
    if (complex === '') {
        report.warn('COMPLEX_ID 미설정 — 단지 검사를 하지 않습니다 (단지가 하나뿐인 배치라면 정상).');
    } else if (!/^[0-9a-f]{8}$/.test(complex.toLowerCase())) {
        report.bad(`COMPLEX_ID 형식이 잘못됐습니다: "${complex}"`, '.env 에 소문자 16진수 8자로 (openssl rand -hex 4)');
    } else {
        report.ok(`단지 ${complex.toLowerCase()}`);
    }

    // manager 로그인 세션을 이 시크릿으로 검증한다. 없으면 대시보드가 전부 막힌다.
    const secret = resolveFromRoot(process.env.SESSION_SECRET_FILE || '../.session-secret');
    if (fs.existsSync(secret)) report.ok('manager 세션 시크릿 있음');
    else report.bad(`세션 시크릿이 없어 대시보드 접근이 모두 거부됩니다: ${secret}`, 'services/manager 를 먼저 기동하세요.');
}

// ── 의존성 ───────────────────────────────────────────
function checkDeps(): void {
    report.step('의존성');

    if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
        report.bad('node_modules 가 없습니다.', 'npm install');
        return;
    }
    report.ok('node_modules 있음');

    // pm2 는 tsx 로 src/index.ts 를 바로 실행한다 (pm2-conf/app.ini).
    // 그래서 dist/ 는 필요 없지만 tsx 는 반드시 있어야 한다.
    if (fs.existsSync(path.join(ROOT, 'node_modules', '.bin', 'tsx'))) report.ok('tsx 있음');
    else report.bad('tsx 가 없습니다 — pm2 가 서비스를 실행할 수 없습니다.', 'npm install');
}

// ── 대시보드 ─────────────────────────────────────────
function checkDashboard(): void {
    report.step('관리 대시보드');

    const indexHtml = path.join(DASHBOARD_DIR, 'index.html');
    if (!fs.existsSync(indexHtml)) {
        report.bad('web/dist 빌드가 없습니다 — /dashboard 가 503 을 줍니다.', 'npm run web:build');
        return;
    }

    // 소스가 빌드보다 새로우면 화면이 옛것이다. 눈에 안 보이는 종류의 문제라 표시한다.
    const builtAt = fs.statSync(indexHtml).mtimeMs;
    const newest = newestFileTime(path.join(ROOT, 'web', 'src'));
    if (newest > builtAt) report.bad('web/dist 가 소스보다 오래됐습니다.', 'npm run web:build');
    else report.ok(`빌드 있음 (${BASE_PATH}${process.env.DASHBOARD_PATH || '/dashboard'})`);
}

function newestFileTime(dir: string): number {
    if (!fs.existsSync(dir)) return 0;
    let newest = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) newest = Math.max(newest, newestFileTime(full));
        else newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
    return newest;
}

// ── FCM ──────────────────────────────────────────────
function checkPush(): void {
    report.step('FCM 푸시 (선택)');

    const configured = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || 'secrets/firebase-admin.json';
    const keyPath = resolveFromRoot(configured);

    if (!fs.existsSync(keyPath)) {
        report.warn(`키가 없어 푸시가 꺼집니다 — 중계 자체는 정상 동작합니다. (${configured})`);
        return;
    }

    try {
        const account = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
        // 웹 SDK 설정(apiKey…)을 잘못 넣는 사례가 흔하다. 서버용 키는 private_key 가 있어야 한다.
        if (!account.private_key || !account.client_email) {
            report.bad(`서버용 FCM 키가 아닙니다 (private_key 없음): ${configured}`);
            return;
        }
        report.ok(`서비스 계정 키 있음 (${account.project_id})`);
    } catch (err) {
        report.bad(`FCM 키를 읽을 수 없습니다: ${message(err)}`);
    }

    // 키 파일은 600 이어야 한다 (database/secrets/*.pw 와 같은 규약).
    const mode = fs.statSync(keyPath).mode & 0o777;
    if (mode & 0o077) report.bad(`키 파일 권한이 넓습니다 (${mode.toString(8)}).`, `chmod 600 ${configured}`);
}

// ── DB ───────────────────────────────────────────────
async function checkDatabase(): Promise<void> {
    report.step('MariaDB');

    const db = dbSettings();
    if (!db.password) {
        report.warn('비밀번호를 읽지 못해 확인을 건너뜁니다 (위 설정 항목 참고).');
        return;
    }

    let conn: mysql.Connection;
    try {
        conn = await mysql.createConnection({
            host: db.host, port: db.port, user: db.user,
            password: db.password, database: db.database, connectTimeout: 5000,
        });
    } catch (err) {
        report.bad(`접속 실패: ${message(err)}`, `sudo ${DB_SETUP}`);
        return;
    }

    try {
        report.ok(`'${db.database}' 접속됨`);

        const { mobile, homenet } = tableNames();
        const [rows] = await conn.query<mysql.RowDataPacket[]>(
            'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ?',
            [db.database],
        );
        const present = new Set(rows.map((r) => String(r.t)));

        for (const table of [mobile, homenet]) {
            if (present.has(table)) report.ok(`표 ${table}`);
            else report.bad(`표 ${table} 이 없습니다.`, 'npm run db:migrate');
        }

        if (!present.has('schema_migrations')) {
            report.bad('schema_migrations 가 없습니다 — 스키마가 적용되지 않았습니다.', 'npm run db:migrate');
        } else {
            const [applied] = await conn.query<mysql.RowDataPacket[]>('SELECT version FROM schema_migrations');
            const have = new Set(applied.map((r) => String(r.version)));
            const missing = migrations().filter((m) => !have.has(m.version));
            if (missing.length > 0) {
                report.bad(`미적용 마이그레이션 ${missing.length}개: ${missing.map((m) => m.file).join(', ')}`, 'npm run db:migrate');
            } else {
                report.ok(`마이그레이션 ${have.size}개 모두 적용됨`);
            }
        }
    } finally {
        await conn.end();
    }
}

// ── pm2 ──────────────────────────────────────────────
function checkPm2(): void {
    report.step('pm2');

    let list: any[];
    try {
        list = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    } catch {
        report.bad('pm2 를 실행할 수 없습니다.', 'npm install -g pm2');
        return;
    }

    const app = list.find((a) => a.name === APP_NAME);
    if (!app) {
        report.bad(`'${APP_NAME}' 가 pm2 목록에 없습니다.`, 'npm start');
    } else if (app.pm2_env.status !== 'online') {
        report.bad(`'${APP_NAME}' 가 ${app.pm2_env.status} 입니다.`, 'npm run logs');
    } else {
        report.ok(`'${APP_NAME}' online (재시작 ${app.pm2_env.restart_time}회)`);
    }

    // 통합 전 이름으로 남아 있는 프로세스. 두 개가 같은 포트를 물면 하나가 조용히 죽는다.
    for (const stale of ['rtc-relay-server', 'websocket-relay-gateway']) {
        if (list.some((a) => a.name === stale)) {
            report.bad(`옛 이름의 프로세스가 남아 있습니다: '${stale}'`, `pm2 delete ${stale} && pm2 save`);
        }
    }

    // 재부팅 복원 목록. pm2 save 를 빼먹으면 재부팅 후 조용히 사라진다.
    const dump = path.join(process.env.HOME || '', '.pm2', 'dump.pm2');
    if (fs.existsSync(dump) && fs.readFileSync(dump, 'utf8').includes(`"${APP_NAME}"`)) {
        report.ok('재부팅 복원 목록에 포함됨');
    } else {
        report.bad('pm2 스냅샷에 없습니다 — 재부팅하면 안 뜹니다.', 'pm2 save');
    }
}

// ── nginx ────────────────────────────────────────────
function checkNginx(): void {
    report.step('nginx');

    if (fs.existsSync(NGINX_INSTALLER)) {
        const result = spawnSync(NGINX_INSTALLER, ['--check'], { encoding: 'utf8' });
        if (result.status === 0) report.ok('라우팅 선언 유효 (충돌 없음)');
        else report.bad('라우팅 선언에 문제가 있습니다.', 'npm run nginx:check');
    }

    try {
        if (fs.readFileSync(NGINX_LIVE_CONF, 'utf8').includes(`location ${BASE_PATH}/`)) {
            report.ok(`nginx 에 ${BASE_PATH}/ 반영됨`);
        } else {
            report.bad('nginx 에 아직 반영되지 않았습니다.', 'npm run nginx:apply');
        }
    } catch {
        report.warn('nginx 설정을 읽을 수 없어 반영 여부를 확인하지 못했습니다.');
    }
}

// ── 동작 ─────────────────────────────────────────────
async function checkHealth(): Promise<void> {
    report.step('동작 확인');

    const url = healthUrl();
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        const body: any = await res.json();

        if (body.service !== APP_NAME) {
            report.bad(`/health 의 service 가 '${body.service}' 입니다 — '${APP_NAME}' 이어야 합니다.`);
        }

        if (body.status === 'ok') {
            report.ok(`/health → ok (룸 ${body.details?.rooms}, 연결 ${body.details?.websockets})`);
            return;
        }

        report.bad(`/health → ${body.status}`);
        if (body.details?.database?.error) report.fix(`DB: ${body.details.database.error}`);
        if (body.details?.dashboardBuild === false) report.fix('npm run web:build');
    } catch (err) {
        report.bad(`${url} 응답 없음: ${message(err)}`, 'npm run logs');
    }
}

function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

main().catch((err) => {
    console.error(`\n예상치 못한 오류: ${message(err)}`);
    process.exit(1);
});
