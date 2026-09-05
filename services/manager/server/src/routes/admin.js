const express = require('express');
const config = require('../config');
const log = require('../logger');
const session = require('../auth/session');
const password = require('../auth/password');
const { DbUserStore } = require('../auth/db-user-store');

/**
 * 관리자 콘솔 (/manager/api/admin).
 *
 * 로그인 화면의 설정 버튼 → 고정 계정으로 로그인 → administrator 테이블 CRUD.
 * 일반 로그인 세션과는 쿠키·토큰이 모두 분리되어 있어 서로를 대신할 수 없다.
 *
 * 대상이 administrator 테이블 자체이므로 auth.provider 설정과 무관하게
 * 항상 DB 저장소를 직접 쓴다.
 */
const store = new DbUserStore();

// 비밀번호가 없으면 콘솔은 열리지 않는다. 로그인할 때마다 남기면 무차별 시도에
// 로그가 묻히므로, 기동할 때 한 번만 알린다.
if (!config.superAdmin.passwordHash && !config.superAdmin.password) {
  log.warn(
    '관리자 콘솔 비밀번호가 없습니다 — 콘솔은 열리지 않습니다. ' +
      "config.json 의 superAdmin.passwordHash 를 채우세요 " +
      "(printf '%s' '<비밀번호>' | node tools/hash-password.js --stdin)"
  );
}

// --- 로그인 시도 제한 (IP 단위, 인메모리) ---
//
// routes/api.js 의 일반 로그인과 같은 자리, 같은 규칙이다 — 계정이 하나뿐인
// 고정 로그인이라 가입 플로딩 걱정은 없고, 여기서는 창이 10분으로 더 길다
// (이 콘솔이 administrator 테이블 CRUD 를 통째로 쥐고 있어 더 보수적으로
// 잡았다). 잠긴 IP가 풀리는 방식은 routes/api.js 의 설명과 완전히 같다 —
// 사람이 해제할 방법은 없고, 그 IP의 첫 시도로부터 LOCKOUT_MS 가 지나면
// 자동으로 풀린다. 상태는 프로세스 메모리에만 있어 manager 재시작으로도
// 전부 풀린다.
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 10 * 60 * 1000;
const attempts = new Map();

function attemptKey(req) {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function isLockedOut(key) {
  const entry = attempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.first > LOCKOUT_MS) {
    attempts.delete(key);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

/** 지금부터 몇 초 뒤에 풀리는지. 잠긴 게 아니면 0. */
function lockoutRemainingSec(key) {
  const entry = attempts.get(key);
  if (!entry) return 0;
  const remainingMs = LOCKOUT_MS - (Date.now() - entry.first);
  return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
}

function recordFailure(key) {
  const entry = attempts.get(key);
  if (!entry || Date.now() - entry.first > LOCKOUT_MS) {
    attempts.set(key, { count: 1, first: Date.now() });
  } else {
    entry.count += 1;
  }
}

function checkCredentials(username, plain) {
  const { username: expectedUser, password: expectedPw, passwordHash } = config.superAdmin;

  // 비밀번호가 설정되지 않았으면 콘솔을 열지 않는다 (기본 비밀번호를 두지 않는다).
  // 이것이 없으면 빈 문자열끼리 비교가 통과해 누구나 들어온다.
  if (!passwordHash && !expectedPw) return false;

  // 아이디가 틀려도 비밀번호 검사를 건너뛰지 않는다. (응답 시간으로 아이디를 알아내지 못하게)
  const userOk = password.timingSafeEqualStr(String(username).trim(), expectedUser);
  const pwOk = passwordHash
    ? password.verifyHash(plain, passwordHash)
    : password.timingSafeEqualStr(plain, expectedPw);

  return userOk && pwOk;
}

function requireSuperAdmin(req, res, next) {
  const token = req.cookies?.[config.superAdmin.cookieName];
  const admin = session.verifySuper(token);
  if (!admin) {
    return res.status(401).json({ error: 'unauthorized', message: '관리자 인증이 필요합니다.' });
  }
  req.superAdmin = admin;
  next();
}

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const MIN_PASSWORD_LENGTH = 8;
const ROLES = ['admin', 'viewer'];

/** DB 행을 프런트엔드가 쓰는 형태로 바꾼다. password_hash 는 절대 내보내지 않는다. */
function toDto(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    approved: Boolean(row.approved),
    role: row.role,
    requestedAt: row.requested_at,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
    lastLoginAt: row.last_login_at,
    loginCount: row.login_count,
  };
}

/** DB 장애는 500이 아니라 503으로, 중복 이메일은 409로 돌려준다. */
function handleDbError(res, err, what) {
  if (err.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({ error: 'duplicate_email', message: '이미 등록된 이메일입니다.' });
  }
  log.error(`Admin console ${what} failed: ${err.code || err.message}`);
  return res.status(503).json({
    error: 'service_unavailable',
    message: `데이터베이스 작업에 실패했습니다. (${err.code || err.message})`,
  });
}

const router = express.Router();

// --- 인증 ---

router.post('/login', (req, res) => {
  const key = attemptKey(req);
  if (isLockedOut(key)) {
    const retryAfterSec = lockoutRemainingSec(key);
    return res.status(429).json({
      error: 'too_many_attempts',
      message: `로그인 시도가 너무 많습니다. ${retryAfterSec}초 뒤 다시 시도하세요.`,
      retryAfterSec,
    });
  }

  const { username, password: plain } = req.body || {};
  if (!username || !plain) {
    return res.status(400).json({ error: 'missing_credentials', message: '아이디와 비밀번호를 입력하세요.' });
  }

  if (!checkCredentials(username, String(plain))) {
    recordFailure(key);
    log.warn(`Admin console login failed for "${username}" from ${key}`);
    return res.status(401).json({
      error: 'invalid_credentials',
      message: '아이디 또는 비밀번호가 올바르지 않습니다.',
    });
  }

  attempts.delete(key);
  const { token, expiresAt } = session.issueSuper(config.superAdmin.username);
  res.cookie(config.superAdmin.cookieName, token, session.superCookieOptions());
  log.info(`Admin console login OK from ${key}`);
  res.json({ admin: { username: config.superAdmin.username }, expiresAt });
});

router.post('/logout', (req, res) => {
  res.clearCookie(config.superAdmin.cookieName, {
    ...session.superCookieOptions(),
    maxAge: undefined,
  });
  res.json({ ok: true });
});

router.get('/me', requireSuperAdmin, (req, res) => {
  res.json({ admin: { username: req.superAdmin.username }, expiresAt: req.superAdmin.expiresAt });
});

// --- administrator 테이블 CRUD ---

router.get('/administrators', requireSuperAdmin, async (req, res) => {
  try {
    const rows = await store.list();
    res.json({
      administrators: rows.map(toDto),
      approvedCount: rows.filter((r) => r.approved).length,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    handleDbError(res, err, 'list');
  }
});

router.post('/administrators', requireSuperAdmin, async (req, res) => {
  const { email, password: plain, displayName, approved, role } = req.body || {};

  const normalized = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(normalized)) {
    return res.status(400).json({ error: 'invalid_email', message: '이메일 형식이 올바르지 않습니다.' });
  }
  if (!plain || String(plain).length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({
      error: 'weak_password',
      message: `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.`,
    });
  }
  if (role !== undefined && !ROLES.includes(role)) {
    return res.status(400).json({ error: 'invalid_role', message: `권한은 ${ROLES.join(' / ')} 중 하나여야 합니다.` });
  }

  try {
    const created = await store.create({
      email: normalized,
      plainPassword: String(plain),
      displayName: displayName || null,
      approved: Boolean(approved),
      role: role || 'admin',
      actor: `console:${req.superAdmin.username}`,
    });
    res.status(201).json({ administrator: toDto(created) });
  } catch (err) {
    handleDbError(res, err, 'create');
  }
});

router.patch('/administrators/:id', requireSuperAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'invalid_id', message: '잘못된 대상입니다.' });
  }

  const { email, password: plain, displayName, approved, role } = req.body || {};
  const patch = {};

  if (email !== undefined) {
    const normalized = String(email).trim().toLowerCase();
    if (!EMAIL_RE.test(normalized)) {
      return res.status(400).json({ error: 'invalid_email', message: '이메일 형식이 올바르지 않습니다.' });
    }
    patch.email = normalized;
  }
  if (displayName !== undefined) patch.displayName = displayName ? String(displayName).trim() : null;
  if (approved !== undefined) patch.approved = Boolean(approved);
  if (role !== undefined) {
    if (!ROLES.includes(role)) {
      return res.status(400).json({ error: 'invalid_role', message: `권한은 ${ROLES.join(' / ')} 중 하나여야 합니다.` });
    }
    patch.role = role;
  }
  if (plain !== undefined && plain !== '') {
    if (String(plain).length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        error: 'weak_password',
        message: `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.`,
      });
    }
    patch.plainPassword = String(plain);
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'nothing_to_update', message: '변경할 내용이 없습니다.' });
  }

  try {
    const updated = await store.updateById(id, patch, `console:${req.superAdmin.username}`);
    if (!updated) return res.status(404).json({ error: 'not_found', message: '해당 계정을 찾을 수 없습니다.' });
    res.json({ administrator: toDto(updated) });
  } catch (err) {
    handleDbError(res, err, 'update');
  }
});

router.delete('/administrators/:id', requireSuperAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'invalid_id', message: '잘못된 대상입니다.' });
  }

  try {
    const removed = await store.removeById(id, `console:${req.superAdmin.username}`);
    if (!removed) return res.status(404).json({ error: 'not_found', message: '해당 계정을 찾을 수 없습니다.' });
    res.json({ ok: true });
  } catch (err) {
    handleDbError(res, err, 'delete');
  }
});

module.exports = { router, requireSuperAdmin };
