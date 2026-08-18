const mysql = require('mysql2/promise');
const config = require('./config');
const log = require('./logger');

/**
 * MariaDB 연결 풀.
 * 설정이 없으면 풀을 만들지 않고, DB를 쓰는 기능(auth.provider=db)은 비활성으로 동작한다.
 */
let pool = null;

function isConfigured() {
  return Boolean(config.database && config.database.host && config.database.name);
}

function getPool() {
  if (!isConfigured()) return null;

  if (!pool) {
    pool = mysql.createPool({
      host: config.database.host,
      port: config.database.port,
      user: config.database.user,
      password: config.database.password,
      database: config.database.name,
      connectionLimit: config.database.connectionLimit,
      waitForConnections: true,
      queueLimit: 0,
      charset: 'utf8mb4',
      // 문자열로 받아야 날짜 형식이 드라이버/서버 타임존에 흔들리지 않는다.
      dateStrings: true,
    });
    log.info(`DB pool created: ${config.database.user}@${config.database.host}:${config.database.port}/${config.database.name}`);
  }

  return pool;
}

async function query(sql, params = []) {
  const p = getPool();
  if (!p) throw new Error('Database is not configured');
  const [rows] = await p.execute(sql, params);
  return rows;
}

/** 연결 확인. 실패해도 예외를 던지지 않고 상태를 돌려준다. */
async function ping() {
  if (!isConfigured()) return { configured: false, ok: false, error: 'not configured' };

  try {
    const rows = await query('SELECT 1 AS ok');
    return { configured: true, ok: rows.length === 1, database: config.database.name };
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
