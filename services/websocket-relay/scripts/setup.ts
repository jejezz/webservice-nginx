/**
 * npm run setup
 *
 * 처음부터 끝까지 한 번에. 여러 번 돌려도 안전하다 (이미 된 것은 건너뛴다).
 *
 *   .env 만들기 → 대시보드 빌드 → 스키마 적용 → pm2 기동 → 점검
 *
 * 고치지 않고 상태만 보고 싶으면 `npm run doctor` 를 쓴다.
 *
 * ── 하지 않는 일 ─────────────────────────────────────────────────
 * DB 와 계정을 만들지 않는다. 이 모노레포에서는 `database/database.ini` 가
 * 그것을 선언하고 `sudo database/setup_mariadb.sh` 가 적용한다. 여기서 또
 * 만들면 계정과 권한을 정하는 곳이 둘이 되어, 어느 쪽이 진짜인지 알 수 없게 된다.
 *
 * nginx 반영도 하지 않는다 — sudo 가 필요하고, 다른 서비스의 라우팅까지 함께
 * 건드리기 때문이다. 필요하면 마지막에 `npm run nginx:apply` 를 안내한다.
 */

import fs from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import {
    loadEnv, envExists, dbSettings, setEnvValue, detectSipProxy,
    ENV_PATH, ENV_EXAMPLE_PATH, ROOT, APP_NAME, PM2_ECOSYSTEM, DASHBOARD_DIR, DB_SETUP,
} from './lib/env';
import { Reporter, ask, confirm, closePrompt, colors } from './lib/ui';

const report = new Reporter();

async function main(): Promise<void> {
    console.log(`${colors.BOLD}${APP_NAME} 설치${colors.RESET}`);

    createEnv();
    loadEnv();
    await configureSipProxy();
    await buildDashboard();
    await applySchema();
    await startPm2();

    closePrompt();

    console.log(`\n${colors.BOLD}다음${colors.RESET}`);
    console.log('  npm run doctor        상태 점검');
    console.log('  npm run db:status     DB 내용 확인');
    console.log('  npm run nginx:apply   nginx 반영 (sudo. 최초 1회와 라우팅을 바꿨을 때만)');

    report.finish('npm run doctor');
}

// ── .env ─────────────────────────────────────────────
function createEnv(): void {
    report.step('.env');

    if (envExists()) {
        report.ok('이미 있습니다 (건드리지 않습니다).');
        return;
    }

    if (!fs.existsSync(ENV_EXAMPLE_PATH)) {
        report.bad('.env.example 이 없어 .env 를 만들 수 없습니다.');
        return;
    }

    fs.copyFileSync(ENV_EXAMPLE_PATH, ENV_PATH);
    // .env 에는 비밀값을 두지 않는 것이 규약이지만, 경로와 포트가 들어가므로
    // 다른 설정 파일과 같은 권한으로 좁혀 둔다.
    fs.chmodSync(ENV_PATH, 0o600);
    report.ok('.env.example 에서 만들었습니다.');
    report.info('COMPLEX_ID 와 JANUS_WS_URL 은 배치에 맞게 채우세요.');
}

// ── SIP 프록시 ───────────────────────────────────────
/**
 * 앱이 REGISTER 를 보낼 이 단지의 Kamailio 주소.
 *
 * Kamailio 와 Janus 는 반드시 한 PC 에 설치되므로, 이 장비에서 자동으로
 * 찾을 수 있다(`detectSipProxy` — Kamailio settings.ini, 없으면 LAN IP).
 * 대개는 그대로 두면 되므로, 찾은 값을 기본값으로 보여 주고 엔터만 치면
 * 넘어가게 한다. 나중에 바뀌면 대시보드에서 고칠 수 있다.
 */
async function configureSipProxy(): Promise<void> {
    report.step('SIP 프록시');

    const current = (process.env.SIP_PROXY ?? '').trim();
    if (current) {
        report.ok(`이미 설정돼 있습니다: ${current}`);
        return;
    }

    const detected = detectSipProxy();
    if (!detected) {
        report.warn('Kamailio 주소를 찾지 못했습니다 — 앱은 빌드 시점 기본값을 씁니다. 필요하면 .env 에 SIP_PROXY 를 직접 넣거나 대시보드에서 넣으세요.');
        return;
    }

    const answer = await ask('앱이 등록할 SIP 프록시 주소', detected);
    setEnvValue('SIP_PROXY', answer);
    process.env.SIP_PROXY = answer;
    report.ok(`SIP_PROXY=${answer} 로 저장했습니다.`);
}

// ── 대시보드 ─────────────────────────────────────────
async function buildDashboard(): Promise<void> {
    report.step('관리 대시보드');

    if (fs.existsSync(`${DASHBOARD_DIR}/index.html`)) {
        report.ok('빌드가 이미 있습니다.');
        return;
    }

    if (!(await confirm('web/dist 빌드가 없습니다. 지금 빌드할까요?', true))) {
        report.warn('건너뜁니다 — /dashboard 는 503 을 줍니다. 나중에: npm run web:build');
        return;
    }

    const result = spawnSync('npm', ['run', 'web:build'], { cwd: ROOT, stdio: 'inherit' });
    if (result.status === 0) report.ok('빌드 완료');
    else report.bad('빌드 실패 — 위 출력을 확인하세요.', 'npm run web:build');
}

// ── 스키마 ───────────────────────────────────────────
async function applySchema(): Promise<void> {
    report.step('스키마');

    const db = dbSettings();
    if (!db.password) {
        report.bad(`DB 비밀번호를 읽을 수 없습니다: ${db.passwordFile}`, `sudo ${DB_SETUP}`);
        report.info('DB 와 계정은 database/database.ini 가 선언하고 위 스크립트가 만듭니다.');
        return;
    }

    const result = spawnSync('npx', ['tsx', 'scripts/db-migrate.ts'], { cwd: ROOT, stdio: 'inherit' });
    if (result.status === 0) report.ok('적용 완료');
    else report.bad('스키마 적용에 실패했습니다.', 'npm run db:migrate');
}

// ── pm2 ──────────────────────────────────────────────
async function startPm2(): Promise<void> {
    report.step('pm2');

    let list: any[];
    try {
        list = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    } catch {
        report.bad('pm2 를 실행할 수 없습니다.', 'npm install -g pm2');
        return;
    }

    // 통합 전 이름의 프로세스가 남아 있으면 같은 포트를 두고 다툰다. 먼저 정리한다.
    for (const stale of ['rtc-relay-server', 'websocket-relay-gateway', 'websocket-relay']) {
        if (stale !== APP_NAME && list.some((a) => a.name === stale)) {
            if (await confirm(`옛 이름의 프로세스 '${stale}' 를 삭제할까요?`, true)) {
                spawnSync('pm2', ['delete', stale], { stdio: 'inherit' });
                report.ok(`'${stale}' 삭제`);
            } else {
                report.bad(`'${stale}' 가 남아 있으면 포트가 겹칩니다.`, `pm2 delete ${stale}`);
            }
        }
    }

    if (list.some((a) => a.name === APP_NAME)) {
        spawnSync('pm2', ['restart', APP_NAME], { stdio: 'inherit' });
        report.ok(`'${APP_NAME}' 재시작`);
    } else {
        const started = spawnSync('pm2', ['start', PM2_ECOSYSTEM, '--only', APP_NAME], { stdio: 'inherit' });
        if (started.status !== 0) {
            report.bad('pm2 기동 실패 — 위 출력을 확인하세요.');
            return;
        }
        report.ok(`'${APP_NAME}' 기동`);
    }

    // save 를 빼먹으면 재부팅 후 조용히 사라진다.
    spawnSync('pm2', ['save'], { stdio: 'ignore' });
    report.ok('재부팅 복원 목록에 저장');
}

main().catch((err) => {
    closePrompt();
    console.error(`\n예상치 못한 오류: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});
