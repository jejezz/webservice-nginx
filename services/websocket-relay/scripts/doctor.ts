/**
 * npm run doctor
 *
 * 지금 상태가 맞는지 점검한다. **아무것도 고치지 않는다.**
 * 문제가 있으면 항목마다 해결 명령을 붙이고 종료 코드 1로 끝난다.
 *
 * 몇 달 뒤 "왜 안 되지" 싶을 때 제일 먼저 돌릴 것.
 *
 * ── 구축 마법사도 이것을 읽는다 ──────────────────────────────────
 *
 *     npm run doctor -- --check --json
 *
 * 같은 점검을 docs/check-contract.md 의 형식으로 낸다 (단계 relay.service).
 * 마법사가 부르는 자리는 ../check-relay.sh 다 — node_modules 가 없으면 이
 * 파일은 실행조차 되지 않으므로, 그 경우를 셸 쪽에서 먼저 말해 준다.
 *
 * 그래서 여기서는 `bad`(잘못된 것)와 `pend`(아직 안 한 것)를 가른다. 사람이
 * 보는 출력은 둘 다 똑같이 ✗ 다 — 갈라지는 것은 마법사가 읽는 판정뿐이다.
 */

import fs from 'fs';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import mysql from 'mysql2/promise';
import {
    loadEnv, dbSettings, envExists, tableNames, migrations, healthUrl,
    ROOT, APP_NAME, BASE_PATH, DASHBOARD_DIR, NGINX_INSTALLER, NGINX_LIVE_CONF, DB_SETUP,
    resolveFromRoot, detectSipProxy, SIP_PROXY_RE, SIP_PROXY_ERROR,
} from './lib/env';
import { Reporter } from './lib/ui';

const report = new Reporter();

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const asJson = argv.includes('--json');
    if (asJson || argv.includes('--check')) report.contract('relay.service', asJson);

    loadEnv();

    checkEnv();
    checkDeps();
    checkDashboard();
    checkPush();
    await checkJanusToken();
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
        report.pend('.env 가 없습니다.', 'npm run setup');
        return;
    }
    report.ok('.env 있음');

    const db = dbSettings();
    report.ok(`DB 대상: ${db.user}@${db.host}:${db.port}/${db.database}`);

    if (!db.password) {
        report.pend(`DB 비밀번호를 읽을 수 없습니다: ${db.passwordFile}`, `sudo ${DB_SETUP}`);
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

    checkJanusUrl(complex);
    checkSipProxy();

    // manager 로그인 세션을 이 시크릿으로 검증한다. 없으면 대시보드가 전부 막힌다.
    const secret = resolveFromRoot(process.env.SESSION_SECRET_FILE || '../.session-secret');
    if (fs.existsSync(secret)) report.ok('manager 세션 시크릿 있음');
    else report.pend(`세션 시크릿이 없어 대시보드 접근이 모두 거부됩니다: ${secret}`, 'services/manager 를 먼저 기동하세요.');
}

/**
 * 사이트 값(`site/settings.ini`). 없으면 빈 값이다.
 *
 * doctor 는 릴레이 소스를 import 하지 않으므로(빌드 없이 tsx 로 돈다) 여기서
 * 직접 읽는다. 형식은 `libs/siteSettings.ts` 와 같은 `키 = 값` 이다.
 */
function readSiteSettings(): { host: string; complexId: string; sipDomain: string } {
    const file = path.resolve(ROOT, '..', '..', 'site', 'settings.ini');
    const out: Record<string, string> = {};
    try {
        for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
            const line = raw.trim();
            if (!line || line.startsWith('#') || line.startsWith(';')) continue;
            const eq = line.indexOf('=');
            if (eq !== -1) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
        }
    } catch {
        // 사이트 층을 아직 만들지 않은 배치다.
    }
    return {
        host: out.host ?? '',
        complexId: (out.complex_id ?? '').toLowerCase(),
        sipDomain: out.sip_domain ?? '',
    };
}

/**
 * 앱에게 알려 줄 Janus 주소가 **이 단지의 것인지** 본다.
 *
 * ── 왜 대조가 필요한가 ──────────────────────────────────────────
 * 이 값은 두 곳으로 나간다 — 등록 응답의 `janus.url` 과 착신 푸시의 `janusUrl`.
 * 둘 다 단말이 그대로 믿고 접속하는 주소다.
 *
 * 그런데 값은 사람이 `.env` 에 손으로 적고, 진짜 주소는 `tools/directory.json`
 * 에 따로 적혀 있다. 둘이 어긋나도 서버는 멀쩡히 돌고 로그도 조용하다. 실제로
 * 개발용 호스트(`jejezzhome.iptime.org`)가 그대로 앱에 나갔고, 단말에서는
 * 이름이 풀리지 않아 통화가 되지 않았다 — 앱 쪽에서 알려 줄 때까지 몰랐다.
 *
 * 근본 해법은 두 값을 한 곳에서 파생시키는 것이다. 그 전까지는 여기서 대조한다.
 */
/** 디렉터리 항목은 있는데 host 를 적지 않은 상태. 사이트 값을 물려받는다는 뜻이다. */
const DERIVED = '(derived)';

function checkJanusUrl(complexId: string): void {
    const site = readSiteSettings();
    const override = (process.env.JANUS_WS_URL ?? '').trim();
    const derived = site.host ? `wss://${site.host}/janus-ws` : '';
    const raw = override || derived;

    if (raw === '') {
        // 없으면 응답에서 키를 빼고 보낸다. 앱은 저장해 둔 값을 쓴다.
        report.info('Janus 주소가 없습니다 — 등록 응답에 janus.url 을 싣지 않습니다.');
        return;
    }

    // .env 로 덮는 것 자체는 막지 않는다(개발기). 다만 사이트 값과 다르면
    // 그것이 곧 옛 사고의 모양이므로 드러낸다.
    if (override && derived && override !== derived) {
        report.warn(`.env 의 JANUS_WS_URL 이 사이트 값을 덮고 있습니다 (${override} ≠ ${derived}).`);
        report.fix('한 곳에서 나오게 하려면 .env 의 JANUS_WS_URL 줄을 지우세요 (site/settings.ini 의 host 를 씁니다)');
    } else if (!override && derived) {
        report.ok('Janus 주소를 site/settings.ini 의 host 에서 만듭니다.');
    }

    let host: string;
    try {
        host = new URL(raw).host;
    } catch {
        report.bad(`JANUS_WS_URL 이 URL 이 아닙니다: "${raw}"`, '.env 에 wss://<호스트>/janus-ws 형식으로');
        return;
    }

    // 디렉터리는 앱이 단지를 고를 때 받는 값의 원본이다. 없으면 대조할 것이 없다.
    const dirFile = path.join(ROOT, 'tools', 'directory.json');
    if (!complexId || !fs.existsSync(dirFile)) {
        report.ok(`Janus 주소: ${host}`);
        return;
    }

    let expected: string | null = null;
    try {
        const dir = JSON.parse(fs.readFileSync(dirFile, 'utf8'));
        for (const region of dir.regions ?? []) {
            for (const c of region.complexes ?? []) {
                if (String(c.complexId).toLowerCase() !== complexId.toLowerCase()) continue;
                // 항목은 있는데 host 가 비어 있으면 "사이트 값을 물려받는다" 는 뜻이다
                // (tools/directory.js 가 push 할 때 채운다). 없는 것과 구분한다.
                expected = c.host ? String(c.host) : DERIVED;
            }
        }
    } catch (err) {
        report.warn(`tools/directory.json 을 읽지 못해 대조를 건너뜁니다: ${message(err)}`);
        return;
    }

    if (!expected) {
        report.warn(`디렉터리에 단지 ${complexId} 가 없습니다 — 앱이 이 서버를 찾지 못합니다.`);
        report.fix('tools/directory.json 에 넣고 npm run directory -- push tools/directory.json');
        return;
    }
    if (expected === DERIVED) {
        report.ok(`Janus 주소: ${host} (디렉터리도 이 값을 물려받습니다)`);
        return;
    }
    if (host !== expected) {
        report.bad(
            `JANUS_WS_URL 의 호스트가 이 단지의 것이 아닙니다 (${host} ≠ ${expected}).`,
            `.env 를 JANUS_WS_URL=wss://${expected}/janus-ws 로 고치세요 — 이 값은 등록 응답과 착신 푸시로 단말에 그대로 나갑니다.`,
        );
        return;
    }
    report.ok(`Janus 주소: ${host} (디렉터리와 일치)`);
}

/**
 * 앱이 REGISTER 를 보낼 이 단지의 Kamailio 주소.
 *
 * Kamailio 와 Janus 는 반드시 한 PC 에 설치되므로, 이 장비의 Kamailio
 * settings.ini(또는 LAN IP)에서 자동으로 찾을 수 있다 (`detectSipProxy`).
 * `.env` 가 못박아 두면 그 값이 이기지만, 감지값과 다르면 오설정일 수
 * 있으므로 드러낸다 — `checkJanusUrl` 과 같은 자세다.
 */
function checkSipProxy(): void {
    const override = (process.env.SIP_PROXY ?? '').trim();
    const detected = detectSipProxy();
    const raw = override || detected || '';

    if (raw === '') {
        report.info('SIP 프록시를 찾지 못했습니다 — 등록 응답에 sip.proxy 를 싣지 않습니다 (앱은 빌드 시점 기본값을 씁니다).');
        return;
    }

    if (!SIP_PROXY_RE.test(raw)) {
        report.bad(`SIP_PROXY 형식이 잘못됐습니다: "${raw}"`, SIP_PROXY_ERROR);
        return;
    }

    if (override && detected && override !== detected) {
        report.warn(`.env 의 SIP_PROXY 가 이 장비에서 자동으로 찾은 값과 다릅니다 (${override} ≠ ${detected}). 의도적으로 고친 값이 아니라면 확인하세요.`);
        return;
    }
    if (!override && detected) {
        report.ok(`SIP 프록시: ${detected} (Kamailio 에서 자동으로 찾음)`);
        return;
    }
    report.ok(`SIP 프록시: ${raw}`);
}

// ── 의존성 ───────────────────────────────────────────
function checkDeps(): void {
    report.step('의존성');

    if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
        report.pend('node_modules 가 없습니다.', 'npm install');
        return;
    }
    report.ok('node_modules 있음');

    // pm2 는 tsx 로 src/index.ts 를 바로 실행한다 (pm2-conf/app.ini).
    // 그래서 dist/ 는 필요 없지만 tsx 는 반드시 있어야 한다.
    if (fs.existsSync(path.join(ROOT, 'node_modules', '.bin', 'tsx'))) report.ok('tsx 있음');
    else report.pend('tsx 가 없습니다 — pm2 가 서비스를 실행할 수 없습니다.', 'npm install');
}

// ── 대시보드 ─────────────────────────────────────────
function checkDashboard(): void {
    report.step('관리 대시보드');

    const indexHtml = path.join(DASHBOARD_DIR, 'index.html');
    if (!fs.existsSync(indexHtml)) {
        report.pend('web/dist 빌드가 없습니다 — /dashboard 가 503 을 줍니다.', 'npm run web:build');
        return;
    }

    // 소스가 빌드보다 새로우면 화면이 옛것이다. 눈에 안 보이는 종류의 문제라 표시한다.
    const builtAt = fs.statSync(indexHtml).mtimeMs;
    const newest = newestFileTime(path.join(ROOT, 'web', 'src'));
    if (newest > builtAt) report.pend('web/dist 가 소스보다 오래됐습니다.', 'npm run web:build');
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
/**
 * 단말별 Janus 토큰 (docs/client-migration.md).
 *
 * 스위치가 둘이다 — Janus 의 `token_auth` 와 여기의 `JANUS_TOKEN_AUTH`.
 * **순서가 있다.** Janus 를 먼저 켜야 하고, 반대로 하면 발급이 매번 490 으로
 * 실패한다. 로그에는 남지만 아무도 안 보므로, 그 어긋남을 여기서 말한다.
 *
 * Janus 쪽 상태는 파일이 아니라 Admin API 에 물어본다 — 설치본 janus.jcfg 는
 * root 전용이라 읽을 수 없고, 물어보면 확실하다(꺼져 있으면 490).
 */
async function checkJanusToken(): Promise<void> {
    report.step('Janus 단말 토큰 (선택)');

    const relayOn = /^(true|1|yes|on)$/i.test((process.env.JANUS_TOKEN_AUTH || '').trim());
    const adminUrl = (process.env.JANUS_ADMIN_URL || 'http://127.0.0.1:7088/admin').trim();
    const secretPath = resolveFromRoot(process.env.JANUS_ADMIN_SECRET_FILE || '../janus/secrets/admin-secret');

    let janusOn: boolean | null = null;
    let secret = '';
    try {
        secret = fs.readFileSync(secretPath, 'utf8').split('\n')[0].trim();
    } catch {
        // 못 읽으면 발급 자체가 안 된다. 켜져 있다고 주장할 때만 문제다.
    }

    if (secret) {
        try {
            const res = await fetch(adminUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ janus: 'list_tokens', transaction: 'doctor', admin_secret: secret }),
                signal: AbortSignal.timeout(2000),
            });
            const body: any = await res.json();
            if (body?.janus === 'success') janusOn = true;
            else if (body?.error?.code === 490) janusOn = false;
        } catch {
            // Admin API 가 응답하지 않는다. 아래에서 모름으로 다룬다.
        }
    }

    if (!relayOn && janusOn !== true) {
        report.info('꺼져 있습니다 — 모든 단말이 같은 api_secret 으로 붙습니다.');
        return;
    }

    if (relayOn && janusOn === false) {
        // 순서가 뒤바뀐 것이다. 릴레이는 발급을 시도하지만 매번 거절당한다.
        report.bad(
            'Janus 의 token_auth 가 꺼져 있어 토큰 발급이 매번 실패합니다.',
            'cd services/janus && sudo ./install.sh --apply',
        );
        return;
    }
    if (relayOn && janusOn === null) {
        report.warn(`Janus Admin API 에 닿지 못해 확인하지 못했습니다 (${adminUrl}).`);
        return;
    }
    if (!relayOn && janusOn === true) {
        report.pend('Janus 는 받을 준비가 됐는데 릴레이가 발급하지 않습니다.',
                    '.env 에 JANUS_TOKEN_AUTH=true 를 넣고 pm2 restart websocket-relay --update-env');
        return;
    }

    if (!secret) {
        report.bad(`admin secret 을 읽을 수 없어 발급하지 못합니다: ${secretPath}`);
        return;
    }
    report.ok('발급 켜져 있음 — 단말마다 다른 토큰으로 Janus 에 붙습니다.');
}

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
            else report.pend(`표 ${table} 이 없습니다.`, 'npm run db:migrate');
        }

        if (!present.has('schema_migrations')) {
            report.pend('schema_migrations 가 없습니다 — 스키마가 적용되지 않았습니다.', 'npm run db:migrate');
        } else {
            const [applied] = await conn.query<mysql.RowDataPacket[]>('SELECT version FROM schema_migrations');
            const have = new Set(applied.map((r) => String(r.version)));
            const missing = migrations().filter((m) => !have.has(m.version));
            if (missing.length > 0) {
                report.pend(`미적용 마이그레이션 ${missing.length}개: ${missing.map((m) => m.file).join(', ')}`, 'npm run db:migrate');
            } else {
                report.ok(`마이그레이션 ${have.size}개 모두 적용됨`);
            }
        }
    } finally {
        await conn.end();
    }
}

// ── pm2 ──────────────────────────────────────────────
// pm2 가 이 서비스를 아직 안 띄웠으면 /health 가 안 되는 것은 결과이지 원인이
// 아니다. 그때 '고장' 이라고 말하면 엉뚱한 데를 뒤지게 만든다.
let started = true;

function checkPm2(): void {
    report.step('pm2');

    let list: any[];
    try {
        list = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    } catch {
        report.pend('pm2 를 실행할 수 없습니다.', 'npm install -g pm2');
        started = false;
        return;
    }

    const app = list.find((a) => a.name === APP_NAME);
    if (!app) {
        // 아직 안 띄운 것이지 고장이 아니다. 아래 '동작 확인' 도 이것을 본다.
        report.pend(`'${APP_NAME}' 가 pm2 목록에 없습니다.`, 'npm start');
        started = false;
    } else if (app.pm2_env.status !== 'online') {
        report.bad(`'${APP_NAME}' 가 ${app.pm2_env.status} 입니다.`, 'npm run logs');
        started = false;
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
        report.pend('pm2 스냅샷에 없습니다 — 재부팅하면 안 뜹니다.', 'pm2 save');
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
            report.pend('nginx 에 아직 반영되지 않았습니다.', 'npm run nginx:apply');
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
            // 주소를 함께 말한다. 이 오보의 원인은 대개 "서비스가 고장났다" 가
            // 아니라 "엉뚱한 데를 찔렀다" 이고, 주소가 없으면 그것이 안 보인다.
            // PORT 가 다른 서비스의 값으로 덮여 있으면 여기로 나온다.
            report.bad(
                `${url} 의 service 가 '${body.service}' 입니다 — '${APP_NAME}' 이어야 합니다.`,
                'PORT 가 다른 서비스의 값으로 덮여 있지 않은지 보세요 (.env 의 PORT=28099).',
            );
        }

        if (body.status === 'ok') {
            report.ok(`/health → ok (룸 ${body.details?.rooms}, 연결 ${body.details?.websockets})`);
            return;
        }

        report.bad(`/health → ${body.status}`);
        if (body.details?.database?.error) report.fix(`DB: ${body.details.database.error}`);
        if (body.details?.dashboardBuild === false) report.fix('npm run web:build');
    } catch (err) {
        if (started) report.bad(`${url} 응답 없음: ${message(err)}`, 'npm run logs');
        else report.pend(`${url} 응답 없음 — 아직 뜨지 않았습니다 (위 pm2 항목을 먼저)`, 'npm start');
    }
}

function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

main().catch((err) => {
    console.error(`\n예상치 못한 오류: ${message(err)}`);
    process.exit(1);
});
