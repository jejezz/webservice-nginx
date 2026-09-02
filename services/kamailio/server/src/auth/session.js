const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('../utils/logger');

/**
 * manager가 발급한 세션 쿠키를 검증한다.
 *
 * 서비스마다 로그인을 따로 두지 않고, manager 로그인 하나로 모든 대시보드를 쓴다.
 * manager와 같은 시크릿(services/.session-secret)으로 HMAC을 검증하며,
 * manager 쿠키의 Path가 '/'이므로 /kamailio/... 요청에도 함께 전달된다.
 */
const SECRET_FILE = process.env.SESSION_SECRET_FILE || path.resolve(__dirname, '../../../..', '.session-secret');
const COOKIE_NAME = 'manager_session';

let secret = null;

function loadSecret() {
  if (secret !== null) return secret;

  try {
    secret = fs.readFileSync(SECRET_FILE, 'utf8').trim() || null;
  } catch {
    secret = null;
  }

  if (!secret) {
    log.warn(`세션 시크릿을 찾을 수 없습니다 (${SECRET_FILE}). 대시보드 접근이 모두 거부됩니다.`);
  }
  return secret;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;

  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      out[name] = part.slice(idx + 1).trim();
    }
  }
  return out;
}

function verifyToken(token) {
  const key = loadSecret();
  if (!key || typeof token !== 'string') return null;

  const [payloadB64, signature] = token.split('.');
  if (!payloadB64 || !signature) return null;

  const expected = crypto.createHmac('sha256', key).update(payloadB64).digest('base64url');
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

  return { username: payload.u, displayName: payload.n, expiresAt: payload.exp };
}

function userFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  return verifyToken(cookies[COOKIE_NAME]);
}

/** API용 — 인증 실패 시 401 JSON */
function requireAuth(req, res, next) {
  const user = userFromRequest(req);
  if (!user) {
    return res.status(401).json({
      error: 'unauthorized',
      message: '로그인이 필요합니다.',
      loginUrl: '/manager/login',
    });
  }
  req.user = user;
  next();
}

/** 페이지용 — 인증 실패 시 manager 로그인으로 보낸다 */
function requirePage(req, res, next) {
  const user = userFromRequest(req);
  if (!user) {
    const next_ = encodeURIComponent(req.originalUrl);
    return res.redirect(302, `/manager/login?next=${next_}`);
  }
  req.user = user;
  next();
}

module.exports = { requireAuth, requirePage, userFromRequest, SECRET_FILE, COOKIE_NAME };
