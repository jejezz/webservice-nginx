/**
 * 스크립트가 보는 설정.
 *
 * src/config.ts 와 같은 `.env` 를 읽지만, **서비스 코드를 import 하지 않는다.**
 * import 하면 로거가 logs/ 를 만들고 DB 풀을 잡는 등, 일회성 스크립트에는 맞지
 * 않는 부수효과가 생긴다. 스크립트는 서비스가 아직 안 뜬 상태에서도 돌아야 한다.
 *
 * 그래서 기본값이 두 곳에 적히게 되는데, 어긋나면 진단이 거짓말을 하므로
 * src/config.ts 를 고칠 때 여기도 같이 본다.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import dotenv from 'dotenv';

/**
 * 서비스 디렉토리.
 *
 * __dirname 을 쓰지 않는다 — tsx 가 이 파일을 ESM 으로 읽으면 존재하지 않는다.
 * npm run 은 항상 package.json 이 있는 디렉토리에서 실행되므로 cwd 에서
 * 위로 올라가며 package.json 을 찾는다. 어느 모듈 방식이든 똑같이 동작한다.
 */
function findRoot(): string {
    let dir = process.cwd();
    for (let i = 0; i < 10; i++) {
        if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return process.cwd();
}

export const ROOT = findRoot();
/** 모노레포 루트 (services/<이 서비스> 의 두 단계 위). */
export const WEBSERVICES = path.resolve(ROOT, '..', '..');

export const ENV_PATH = path.join(ROOT, '.env');
export const ENV_EXAMPLE_PATH = path.join(ROOT, '.env.example');
/** 이 서비스가 소유한 스키마. database/database.ini 의 [database:rtc_relay] 가 가리킨다. */
export const SCHEMA_DIR = path.join(ROOT, 'schema');
/** 빌드된 대시보드. 없으면 /dashboard 가 503 을 준다. */
export const DASHBOARD_DIR = path.join(ROOT, 'web', 'dist');

export const APP_NAME = 'websocket-relay';
export const BASE_PATH = '/relay';
export const PM2_ECOSYSTEM = path.join(WEBSERVICES, 'pm2', 'ecosystem.config.js');
export const NGINX_INSTALLER = path.join(WEBSERVICES, 'nginx', 'install_nginx_stack.sh');
export const NGINX_LIVE_CONF = '/etc/nginx/conf.d/path-routing.conf';
export const DB_SETUP = path.join(WEBSERVICES, 'database', 'setup_mariadb.sh');

export function envExists(): boolean {
    return fs.existsSync(ENV_PATH);
}

let envLoaded = false;

/**
 * .env 를 읽어 process.env 에 채운다. 이미 있는 값은 덮어쓰지 않는다.
 * 여러 번 불려도 한 번만 읽는다 — 스크립트마다 부르는데 그때마다 dotenv
 * 배너가 찍히면 출력이 지저분해진다.
 */
export function loadEnv(): void {
    if (envLoaded) return;
    envLoaded = true;
    if (envExists()) dotenv.config({ path: ENV_PATH, quiet: true });
}

export function healthUrl(): string {
    return `http://${process.env.BIND_ADDR || '127.0.0.1'}:${Number(process.env.PORT) || 28099}/health`;
}

export interface DbSettings {
    host: string;
    port: number;
    user: string;
    password: string;
    /** 비밀번호를 어디서 얻었는지. 진단 메시지에 쓴다. */
    passwordFrom: string;
    passwordFile: string;
    database: string;
}

/**
 * 접속 정보.
 *
 * ⚠️ 비밀번호는 **파일에서 읽는다** — 이것이 이 모노레포의 규약이다
 * (database/README.md). .env 에 DB_PASSWORD 를 적어 두면 그것을 먼저 쓰지만,
 * 정석은 database/secrets/jyahn.pw 하나를 모든 서비스가 함께 보는 것이다.
 */
export function dbSettings(): DbSettings {
    const passwordFile = resolveFromRoot(
        process.env.DB_PASSWORD_FILE || '../../database/secrets/jyahn.pw',
    );

    let password = process.env.DB_PASSWORD || '';
    let passwordFrom = password ? '.env 의 DB_PASSWORD' : '';

    if (!password) {
        try {
            password = fs.readFileSync(passwordFile, 'utf8').split('\n')[0].trim();
            passwordFrom = passwordFile;
        } catch {
            password = '';
            passwordFrom = '';
        }
    }

    return {
        host: process.env.DB_HOST || '127.0.0.1',
        port: Number(process.env.DB_PORT) || 3306,
        user: process.env.DB_USER || 'jyahn',
        password,
        passwordFrom,
        passwordFile,
        // DB 이름에는 하이픈을 쓸 수 없어 서비스 이름과 다르다.
        database: process.env.DB_NAME || 'rtc_relay',
    };
}

export function resolveFromRoot(p: string): string {
    return path.isAbsolute(p) ? p : path.resolve(ROOT, p);
}

export const SIP_PROXY_RE = /^sip:[^\s:]+:\d+$/;
export const SIP_PROXY_ERROR = 'sip:<주소>:<포트> 형식이어야 합니다 (예: sip:10.10.0.224:5060).';

/**
 * SIP 프록시(Kamailio) 주소를 추정한다. Kamailio 와 Janus 는 반드시 한 PC 에
 * 설치되므로(services/janus/install.sh 의 resolve_lan 이 그 전제로 LAN IP 를
 * 고른다), Kamailio settings.ini 를 먼저 본다 — 없으면 이 서비스도 같은
 * 장비에서 돈다는 전제로 자신의 LAN IP 를 대신 쓴다.
 *
 * src/libs/sipProxy.ts 에 같은 함수가 있다 — 서비스가 뜨기 전에 도는 이
 * 스크립트는 서비스 코드를 import 하지 않으므로 의도된 중복이다 (env.ts 의
 * setEnvValue 와 같은 사정).
 */
export function detectSipProxy(): string | null {
    const file = path.join(WEBSERVICES, 'services', 'kamailio', 'settings.ini');
    let ip: string | null = null;
    try {
        const m = fs.readFileSync(file, 'utf8').match(/^[ \t]*sip_listen_addr[ \t]*=[ \t]*(\S+)[ \t]*$/m);
        if (m) ip = m[1];
    } catch { /* Kamailio 가 아직 없는 배치다 */ }

    if (!ip) {
        for (const addrs of Object.values(os.networkInterfaces())) {
            for (const a of addrs ?? []) {
                if (a.family === 'IPv4' && !a.internal) { ip = a.address; break; }
            }
            if (ip) break;
        }
    }
    return ip ? `sip:${ip}:5060` : null;
}

/** .env 의 한 항목만 바꾼다. 주석과 순서는 그대로 둔다. */
export function setEnvValue(key: string, value: string): void {
    let text = fs.readFileSync(ENV_PATH, 'utf8');
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');

    text = pattern.test(text) ? text.replace(pattern, line) : `${text.replace(/\n*$/, '\n')}${line}\n`;
    fs.writeFileSync(ENV_PATH, text);
}

/** 표 이름. 스키마와 진단이 같은 값을 봐야 한다. */
export function tableNames(): { mobile: string; homenet: string } {
    return {
        mobile: process.env.MOBILE_TABLE_NAME || 'rtc_mobiles',
        homenet: process.env.HOMENET_TABLE_NAME || 'rtc_homenet',
    };
}

export interface Migration {
    /** 파일 이름에서 확장자를 뗀 것. schema_migrations.version 에 들어가는 값이다. */
    version: string;
    file: string;
    statements: string[];
}

/**
 * schema/*.sql 을 이름순으로 읽는다.
 *
 * 문장 단위로 나눠 두는 이유: mysql2 의 multipleStatements 를 켜면 질의 하나에
 * 여러 문장을 실어 보낼 수 있게 되어 주입 사고의 여지가 커진다. 켜지 않는다.
 *
 * 주석을 먼저 걷어내고 나눈다. 순서가 반대면 주석 안의 세미콜론에서 문장이 잘린다.
 */
export function migrations(): Migration[] {
    if (!fs.existsSync(SCHEMA_DIR)) return [];

    return fs
        .readdirSync(SCHEMA_DIR)
        .filter((name) => name.endsWith('.sql'))
        .sort()
        .map((name) => {
            const sql = fs.readFileSync(path.join(SCHEMA_DIR, name), 'utf8');
            return {
                version: name.replace(/\.sql$/, ''),
                file: name,
                statements: sql
                    .replace(/^\s*--.*$/gm, '')
                    .split(';')
                    .map((statement) => statement.trim())
                    .filter((statement) => statement.length > 0),
            };
        });
}
