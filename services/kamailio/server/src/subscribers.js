const crypto = require('crypto');
const db = require('./db');

/**
 * Kamailio 의 subscriber 테이블 (SIP 계정).
 *
 * ── 어느 컬럼이 실제로 인증에 쓰이는가 ──────────────────────────────
 * 이 서버의 kamailio.cfg 는 아래와 같이 설정되어 있다.
 *
 *   modparam("auth_db", "calculate_ha1", yes)
 *   modparam("auth_db", "password_column", "password")
 *   modparam("auth_db", "use_domain", 0)        // MULTIDOMAIN 미정의
 *
 * 따라서 auth_db 는 **평문 password 컬럼**을 읽어 요청의 realm 으로 ha1 을 직접 계산한다.
 * ha1 / ha1b 컬럼과 domain 컬럼은 조회에도 검증에도 쓰이지 않는다. (실측으로 확인)
 * 평문이 비어 있으면 어떤 비밀번호로도 인증되지 않는다.
 *
 * 그래서 password 컬럼을 반드시 채운다. ha1 / ha1b 도 함께 계산해 두는데,
 * kamctl 이 STORE_PLAINTEXT_PW=1 일 때 하는 것과 같고, 나중에 calculate_ha1 을 끄는
 * 방식으로 옮길 때 그대로 쓸 수 있기 때문이다.
 *
 *   ha1  = MD5("user:domain:password")
 *   ha1b = MD5("user@domain:domain:password")
 *
 * 위 계산은 kamctl.base 의 _gen_ha1 / _gen_ha1b 와 바이트 단위로 같다.
 * 이때 realm 자리에 들어가는 것은 subscriber.domain 이므로, calculate_ha1 을 끄고
 * 쓰려면 그 값이 단말이 보내는 From 도메인과 같아야 한다.
 *
 * 비밀번호와 해시는 어떤 응답에도 포함하지 않는다.
 */
const md5 = (input) => crypto.createHash('md5').update(input, 'utf8').digest('hex');

function ha1(username, domain, password) {
  return md5(`${username}:${domain}:${password}`);
}

function ha1b(username, domain, password) {
  return md5(`${username}@${domain}:${domain}:${password}`);
}

// SIP 사용자명에 쓸 수 있는 문자. RFC 3261 의 user 부분보다 좁게 잡아 두었다.
// 넓히더라도 '@' 와 ':' 는 허용하면 안 된다 — URI 와 해시 계산이 모두 깨진다.
const USERNAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MIN_PASSWORD_LENGTH = 6;

function validateUsername(username) {
  const value = String(username || '').trim();
  if (!USERNAME_RE.test(value)) {
    return { error: '사용자명은 영문·숫자·. _ - 만 쓸 수 있고 64자 이내여야 합니다.' };
  }
  return { value };
}

function validatePassword(password) {
  const value = String(password || '');
  if (value.length < MIN_PASSWORD_LENGTH) {
    return { error: `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.` };
  }
  return { value };
}

/**
 * 목록. 비밀번호와 해시는 내보내지 않고 상태만 알려준다.
 *
 * canAuthenticate 는 password 컬럼 기준이다 — 이 설정에서 실제로 인증에 쓰이는 값이다.
 * hashOnly 는 예전에 해시만 저장한 계정을 뜻하며, 그대로 두면 로그인할 수 없다.
 */
async function list() {
  const rows = await db.query(
    `SELECT id, username, domain,
            (password <> '') AS has_password,
            (password = '' AND ha1 <> '') AS hash_only
       FROM subscriber
      ORDER BY domain, username`
  );

  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    domain: row.domain,
    canAuthenticate: Boolean(Number(row.has_password)),
    hashOnly: Boolean(Number(row.hash_only)),
  }));
}

async function getById(id) {
  const rows = await db.query('SELECT id, username, domain FROM subscriber WHERE id = ? LIMIT 1', [
    Number(id),
  ]);
  return rows[0] || null;
}

/**
 * @param {string} domain  필수. **설정 상수를 기본값으로 두지 않는다** —
 *   예전에 SIP_DOMAIN 상수를 두었다가 Kamailio 설정과 어긋나 엉뚱한 계정이
 *   만들어질 뻔했다. 호출부(api.js)가 core.aliases_list 로 받은 실제 도메인을 넘긴다.
 */
async function create({ username, password, domain }) {
  const targetDomain = String(domain || '').trim();
  if (!targetDomain) throw new Error('domain 이 필요합니다');

  await db.query(
    'INSERT INTO subscriber (username, domain, password, ha1, ha1b) VALUES (?, ?, ?, ?, ?)',
    [
      username,
      targetDomain,
      // calculate_ha1=yes 이므로 이 컬럼이 실제 인증에 쓰인다. 비우면 로그인할 수 없다.
      password,
      ha1(username, targetDomain, password),
      ha1b(username, targetDomain, password),
    ]
  );

  const rows = await db.query(
    'SELECT id, username, domain FROM subscriber WHERE username = ? AND domain = ? LIMIT 1',
    [username, targetDomain]
  );
  return rows[0] || null;
}

/**
 * 사용자명·도메인·비밀번호를 바꾼다. 주어진 것만 반영한다.
 *
 * 해시에는 사용자명과 도메인이 들어가므로 이름을 바꾸면 해시도 다시 계산해야 한다.
 * 평문을 갖고 있으므로 비밀번호를 다시 받지 않고도 계산할 수 있다.
 * 다만 예전에 해시만 저장한 계정은 평문이 없어 계산할 수 없으니, 그때는 비밀번호를 받아야 한다.
 * (그런 계정은 어차피 지금 인증되지 않는 상태다)
 */
async function update(id, { username, domain, password }) {
  const rows = await db.query(
    'SELECT id, username, domain, password FROM subscriber WHERE id = ? LIMIT 1',
    [Number(id)]
  );
  const current = rows[0];
  if (!current) return null;

  const nextUsername = username === undefined ? current.username : username;
  const nextDomain = domain === undefined ? current.domain : String(domain).trim();

  // 새 비밀번호가 없으면 저장돼 있는 평문으로 해시를 다시 만든다.
  const effectivePassword = password || current.password;

  const sets = ['username = ?', 'domain = ?'];
  const params = [nextUsername, nextDomain];

  if (effectivePassword) {
    sets.push('password = ?', 'ha1 = ?', 'ha1b = ?');
    params.push(
      effectivePassword,
      ha1(nextUsername, nextDomain, effectivePassword),
      ha1b(nextUsername, nextDomain, effectivePassword)
    );
  }

  params.push(Number(id));
  await db.query(`UPDATE subscriber SET ${sets.join(', ')} WHERE id = ?`, params);

  return getById(id);
}

/** 평문이 없어 해시를 다시 계산할 수 없는 계정인가. (예전 방식으로 만들어진 것) */
async function needsPassword(id) {
  const rows = await db.query('SELECT password FROM subscriber WHERE id = ? LIMIT 1', [Number(id)]);
  if (!rows[0]) return false;
  return rows[0].password === '';
}

async function remove(id) {
  const rows = await db.query('DELETE FROM subscriber WHERE id = ?', [Number(id)]);
  return rows.affectedRows > 0;
}

module.exports = {
  list,
  getById,
  create,
  update,
  remove,
  needsPassword,
  validateUsername,
  validatePassword,
  MIN_PASSWORD_LENGTH,
  // 테스트용
  ha1,
  ha1b,
};
