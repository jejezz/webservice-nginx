const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('./config');
const log = require('./utils/logger');

/**
 * MariaDB 연결 풀 (Kamailio 계정 관리용).
 *
 * 비밀번호는 config 에 담지 않고 파일에서 읽는다. 대시보드의 /overview 가 설정을 그대로
 * 내보내기 때문이다. 파일을 읽지 못하면 풀을 만들지 않고, 계정 관리 기능만 비활성으로 동작한다.
 * (SIP 브릿지 본연의 기능은 DB 없이도 그대로 돌아간다)
 */
// server/src → 서비스 디렉토리(services/kamailio)
const SERVICE_DIR = path.resolve(__dirname, '../..');

let pool = null;
let password = null;
let passwordError = null;

function loadPassword() {
  if (password !== null || passwordError !== null) return password;

  if (process.env.DB_PASSWORD) {
    password = process.env.DB_PASSWORD;
    return password;
  }

  const file = path.isAbsolute(config.DATABASE.PASSWORD_FILE)
    ? config.DATABASE.PASSWORD_FILE
    : path.resolve(SERVICE_DIR, config.DATABASE.PASSWORD_FILE);

  try {
    password = fs.readFileSync(file, 'utf8').split('\n')[0].trim();
    if (!password) throw new Error('파일이 비어 있습니다');
    return password;
  } catch (err) {
    passwordError = `${file}: ${err.message}`;
    log.warn(`DB 비밀번호를 읽을 수 없습니다 (${passwordError}) — 계정 관리 기능이 비활성화됩니다.`);
    return null;
  }
}

function isConfigured() {
  return Boolean(config.DATABASE.HOST && config.DATABASE.NAME && loadPassword());
}

function getPool() {
  if (!isConfigured()) return null;

  if (!pool) {
    pool = mysql.createPool({
      host: config.DATABASE.HOST,
      port: config.DATABASE.PORT,
      user: config.DATABASE.USER,
      password: loadPassword(),
      database: config.DATABASE.NAME,
      connectionLimit: config.DATABASE.CONNECTION_LIMIT,
      waitForConnections: true,
      queueLimit: 0,
      charset: 'utf8mb4',
      // 문자열로 받아야 날짜 형식이 드라이버/서버 타임존에 흔들리지 않는다.
      dateStrings: true,
    });
    log.info(
      `DB pool created: ${config.DATABASE.USER}@${config.DATABASE.HOST}:${config.DATABASE.PORT}/${config.DATABASE.NAME}`
    );
  }

  return pool;
}

async function query(sql, params = []) {
  const p = getPool();
  if (!p) throw new Error(passwordError ? `Database is not configured (${passwordError})` : 'Database is not configured');
  const [rows] = await p.execute(sql, params);
  return rows;
}

/** 연결 확인. 실패해도 예외를 던지지 않고 상태를 돌려준다. */
async function ping() {
  if (!isConfigured()) {
    return { configured: false, ok: false, error: passwordError || 'not configured' };
  }

  try {
    const rows = await query('SELECT 1 AS ok');
    return { configured: true, ok: rows.length === 1, database: config.DATABASE.NAME };
  } catch (err) {
    return { configured: true, ok: false, error: err.code || err.message };
  }
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { query, ping, close, getPool, isConfigured };
