const crypto = require('crypto');
const config = require('../config');

// 상태를 서버에 두지 않는 HMAC 서명 토큰. 쿠키 하나로 세션을 유지한다.
function b64u(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(payloadB64) {
  return crypto.createHmac('sha256', config.sessionSecret).update(payloadB64).digest('base64url');
}

// 관리자 콘솔 토큰에만 붙는 표식.
// 일반 세션 토큰에는 없으므로 두 토큰을 서로 바꿔 쓸 수 없다.
const SUPER_SCOPE = 'super';

function issue(user) {
  const now = Date.now();
  const payload = {
    u: user.username,
    n: user.displayName,
    iat: now,
    exp: now + config.sessionTtlMs,
  };
  const payloadB64 = b64u(JSON.stringify(payload));
  return { token: `${payloadB64}.${sign(payloadB64)}`, expiresAt: payload.exp };
}

/** 서명과 만료만 확인해 payload를 돌려준다. 범위(scope) 판단은 호출한 쪽에서 한다. */
function decode(token) {
  if (typeof token !== 'string') return null;

  const [payloadB64, signature] = token.split('.');
  if (!payloadB64 || !signature) return null;

  const expected = sign(payloadB64);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!payload.exp || Date.now() >= payload.exp) return null;
  return payload;
}

function verify(token) {
  const payload = decode(token);
  // 관리자 콘솔 토큰을 일반 세션 쿠키에 넣어도 통과하지 않도록 막는다.
  if (!payload || payload.s) return null;

  return { username: payload.u, displayName: payload.n, expiresAt: payload.exp };
}

// --- 관리자 콘솔 (설정 버튼 → Admin 로그인) ---

function issueSuper(username) {
  const now = Date.now();
  const payload = {
    u: username,
    s: SUPER_SCOPE,
    iat: now,
    exp: now + config.superAdmin.sessionTtlMs,
  };
  const payloadB64 = b64u(JSON.stringify(payload));
  return { token: `${payloadB64}.${sign(payloadB64)}`, expiresAt: payload.exp };
}

function verifySuper(token) {
  const payload = decode(token);
  if (!payload || payload.s !== SUPER_SCOPE) return null;

  return { username: payload.u, expiresAt: payload.exp };
}

function superCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookieSecure,
    // 이 쿠키는 manager 자신만 쓴다. 다른 서비스로 새어 나가지 않도록 basePath에 묶는다.
    // 다만 루트에 붙어 있으면(basePath = '') 경로로 좁힐 수 없어 '/'가 된다 —
    // 같은 오리진의 다른 location(/face/, /complex/ …)에도 전달된다는 뜻이다.
    // 콘솔을 격리하려면 basePath를 '/manager' 같은 하위 경로로 옮긴다.
    path: config.basePath || '/',
    maxAge: config.superAdmin.sessionTtlMs,
  };
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    // Path를 '/'로 두어 다른 서비스의 대시보드(/cassini/, /complex/admin/ 등)에도 전달한다.
    // 각 서비스는 공유 시크릿으로 이 쿠키를 검증하므로 로그인은 한 번이면 된다.
    path: '/',
    maxAge: config.sessionTtlMs,
  };
}

module.exports = { issue, verify, cookieOptions, issueSuper, verifySuper, superCookieOptions };
