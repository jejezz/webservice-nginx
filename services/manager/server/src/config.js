const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('./logger');

const SERVER_DIR = path.resolve(__dirname, '..');
const MANAGER_DIR = path.resolve(SERVER_DIR, '..');

const DEFAULTS = {
  port: 28084,
  // Nginx가 127.0.0.1로 프록시하므로 루프백에만 묶는다.
  // 이렇게 해야 TLS를 우회해 백엔드 포트로 직접 들어오는 평문 접근이 차단된다.
  // 외부에 직접 노출해야 한다면 '0.0.0.0'으로 바꾼다.
  host: '127.0.0.1',
  // Nginx의 기본 웹페이지를 대신하므로 루트에 붙는다.
  // 하위 경로로 옮기려면 '/manager' 처럼 넣고 web/vite.config.js의 base도 함께 바꾼다.
  basePath: '',
  sessionSecret: '',
  sessionTtlMinutes: 120,
  cookieSecure: true,
  // MANAGER_DIR(Public/WebServices/services/manager) 기준 상대 경로.
  // servicesDir 아래의 */nginx-conf/*.ini 가 서비스 목록의 진실 공급원이다.
  // (install_nginx_stack.sh 가 읽는 파일과 같다)
  servicesDir: '..',
  nginxStackPath: '../../nginx/nginx-stack.conf',
  ecosystemPath: '../../pm2/ecosystem.config.js',
  healthTimeoutMs: 3000,
  pm2Enabled: true,
  auth: {
    provider: 'db',
    users: [],
  },
  // 로그인 화면의 설정 버튼으로 들어가는 관리자 콘솔 계정.
  // administrator 테이블 자체를 다루므로 일반 로그인 계정과 분리해 둔다.
  //
  // 이 계정 하나로 모든 관리자 계정을 만들고 지울 수 있고, 이 대시보드는 루트에
  // 붙어 있으므로 기본 비밀번호를 두지 않는다. 둘 다 비어 있으면 관리자 로그인은
  // 항상 실패한다(fail-closed). `npm run hash-password -- '<비밀번호>'`로 만든
  // scrypt$... 값을 config.json의 superAdmin.passwordHash에 넣어 사용한다.
  superAdmin: {
    username: 'zoomon',
    password: '',
    passwordHash: '',
    sessionTtlMinutes: 30,
  },
  database: {
    host: '127.0.0.1',
    port: 3306,
    user: 'jyahn',
    // MANAGER_DIR 기준 상대 경로. 비밀번호를 config.json에 두지 않는다.
    passwordFile: './secrets/manager-db.pw',
    passwordEnv: '',
    name: 'manager',
    connectionLimit: 5,
  },
};

function loadFile() {
  const configPath = process.env.MANAGER_CONFIG
    ? path.resolve(process.env.MANAGER_CONFIG)
    : path.join(MANAGER_DIR, 'config.json');

  if (!fs.existsSync(configPath)) {
    log.warn(`Config file not found: ${configPath} (using defaults)`);
    return { configPath, data: {} };
  }

  try {
    return { configPath, data: JSON.parse(fs.readFileSync(configPath, 'utf8')) };
  } catch (err) {
    throw new Error(`Failed to parse config file ${configPath}: ${err.message}`);
  }
}

const { configPath, data } = loadFile();

function normalizeBasePath(value) {
  const raw = String(value || '/').trim();
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  const trimmed = withSlash.replace(/\/+$/, '');
  return trimmed === '' ? '' : trimmed;
}

// 설정 파일 → 환경 변수 → 기본값 순으로 병합한다.
const merged = {
  ...DEFAULTS,
  ...data,
  auth: { ...DEFAULTS.auth, ...(data.auth || {}) },
  superAdmin: { ...DEFAULTS.superAdmin, ...(data.superAdmin || {}) },
  database: { ...DEFAULTS.database, ...(data.database || {}) },
};

// DB 비밀번호: 환경 변수 > 비밀번호 파일 순. config.json에는 두지 않는다.
function loadDbPassword(db) {
  if (db.passwordEnv && process.env[db.passwordEnv]) return process.env[db.passwordEnv];
  if (process.env.MANAGER_DB_PASSWORD) return process.env.MANAGER_DB_PASSWORD;

  if (db.passwordFile) {
    const file = path.isAbsolute(db.passwordFile)
      ? db.passwordFile
      : path.resolve(MANAGER_DIR, db.passwordFile);
    try {
      return fs.readFileSync(file, 'utf8').split('\n')[0].trim();
    } catch (err) {
      log.warn(`Cannot read DB password file ${file}: ${err.message}`);
    }
  }

  return '';
}

const port = parseInt(process.env.PORT, 10) || merged.port;
const host = process.env.MANAGER_HOST || merged.host;
const basePath = normalizeBasePath(process.env.MANAGER_BASE_PATH || merged.basePath);

// 서비스 대시보드들이 같은 로그인 세션을 공유하도록 시크릿을 파일 하나로 관리한다.
// (다른 서비스가 이 파일로 manager 쿠키를 검증하면 로그인은 한 번이면 된다)
const SECRET_FILE = process.env.SESSION_SECRET_FILE || path.resolve(MANAGER_DIR, '..', '.session-secret');

function loadSharedSecret() {
  try {
    const value = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (value) return value;
  } catch {
    /* 아래에서 새로 만든다 */
  }

  try {
    const generated = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_FILE, `${generated}\n`, { mode: 0o600 });
    log.info(`Created shared session secret: ${SECRET_FILE}`);
    return generated;
  } catch (err) {
    log.warn(`Cannot write ${SECRET_FILE} (${err.message}) — using an ephemeral secret. ` +
      'Sessions will not survive a restart and other service dashboards cannot verify them.');
    return crypto.randomBytes(32).toString('hex');
  }
}

const sessionSecret =
  process.env.MANAGER_SESSION_SECRET || merged.sessionSecret || loadSharedSecret();

module.exports = Object.freeze({
  configPath,
  managerDir: MANAGER_DIR,
  serverDir: SERVER_DIR,
  publicDir: path.join(SERVER_DIR, 'public'),

  port,
  host,
  basePath,
  sessionSecret,
  sessionTtlMs: (parseInt(merged.sessionTtlMinutes, 10) || 120) * 60 * 1000,
  cookieSecure: merged.cookieSecure !== false,
  cookieName: 'manager_session',

  servicesDir: path.resolve(MANAGER_DIR, merged.servicesDir),
  nginxStackPath: path.resolve(MANAGER_DIR, merged.nginxStackPath),
  ecosystemPath: path.resolve(MANAGER_DIR, merged.ecosystemPath),
  healthTimeoutMs: parseInt(merged.healthTimeoutMs, 10) || 3000,
  pm2Enabled: merged.pm2Enabled !== false,

  auth: merged.auth,
  superAdmin: {
    username: process.env.MANAGER_SUPERADMIN_USERNAME || merged.superAdmin.username,
    password: process.env.MANAGER_SUPERADMIN_PASSWORD || merged.superAdmin.password,
    passwordHash: process.env.MANAGER_SUPERADMIN_PASSWORD_HASH || merged.superAdmin.passwordHash,
    sessionTtlMs: (parseInt(merged.superAdmin.sessionTtlMinutes, 10) || 30) * 60 * 1000,
    cookieName: 'manager_admin',
  },
  database: {
    host: merged.database.host,
    port: parseInt(merged.database.port, 10) || 3306,
    user: merged.database.user,
    password: loadDbPassword(merged.database),
    name: merged.database.name,
    connectionLimit: parseInt(merged.database.connectionLimit, 10) || 5,
  },
});
