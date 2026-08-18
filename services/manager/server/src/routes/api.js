const express = require('express');
const config = require('../config');
const log = require('../logger');
const session = require('../auth/session');
const { createUserStore } = require('../auth/user-store');
const { loadServices } = require('../services/registry');
const health = require('../services/health');
const pm2 = require('../services/pm2');
const nginx = require('../services/nginx');
const host = require('../services/host');
const { router: adminRouter } = require('./admin');

const userStore = createUserStore(config.auth);

// --- 로그인 시도 제한 (IP 단위, 인메모리) ---
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;
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

function recordFailure(key) {
  const entry = attempts.get(key);
  if (!entry || Date.now() - entry.first > LOCKOUT_MS) {
    attempts.set(key, { count: 1, first: Date.now() });
  } else {
    entry.count += 1;
  }
}

function requireAuth(req, res, next) {
  const token = req.cookies?.[config.cookieName];
  const user = session.verify(token);
  if (!user) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  req.user = user;
  next();
}

const router = express.Router();

// --- 관리자 콘솔 (로그인 화면의 설정 버튼) ---
// 일반 로그인 세션과 별개의 인증을 쓰므로 requireAuth 바깥에 둔다.
router.use('/admin', adminRouter);

// --- 장비 식별 ---

// 로그인 화면이 "어느 장비인지" 를 띄우기 위해 부른다.
// 로그인 전에 응답해야 하므로 requireAuth 를 걸지 않는다. IP 는 마지막
// 옥텟만 나가고(services/host.js), 그 외에는 아무것도 드러내지 않는다.
router.get('/host', (req, res) => {
  res.json(host.identity());
});

// --- 인증 ---

// 로그인 아이디는 이메일만 받는다.
// 지나치게 엄격하면 정상 주소를 막으므로 구조만 확인한다.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

router.post('/login', async (req, res) => {
  const key = attemptKey(req);
  if (isLockedOut(key)) {
    return res.status(429).json({ error: 'too_many_attempts', message: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.' });
  }

  const { username, password, passwordConfirm } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'missing_credentials', message: '이메일과 비밀번호를 입력하세요.' });
  }

  const email = String(username).trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'invalid_email', message: '아이디는 이메일 주소여야 합니다.' });
  }

  const result = await userStore.authenticate(email, String(password), {
    ip: key,
    // 값이 없으면 넘기지 않는다. authenticate()는 '입력 없음'과 '빈 문자열'을 구분한다.
    passwordConfirm: passwordConfirm === undefined ? undefined : String(passwordConfirm),
  });

  switch (result.status) {
    case 'ok': {
      attempts.delete(key);
      const { token, expiresAt } = session.issue(result.user);
      res.cookie(config.cookieName, token, session.cookieOptions());
      log.info(`Login OK: ${result.user.username} from ${key}`);
      return res.json({ user: result.user, expiresAt });
    }

    case 'pending': {
      // 승인 대기는 실패 횟수에 넣지 않는다. 아직 자격 증명을 틀린 게 아니다.
      log.info(`Login pending approval: ${email} from ${key}`);

      let message = '승인 대기 중인 계정입니다. 관리자 승인 후 로그인할 수 있습니다.';
      if (result.firstRequest) {
        // 비밀번호가 저장됐다는 사실을 반드시 알린다. 이걸 모르면 나중에
        // 로그인이 안 될 때 원인을 찾을 수 없다.
        message =
          '승인 요청이 등록되었습니다. 방금 입력한 비밀번호가 이 계정의 비밀번호로 저장되었습니다. ' +
          '관리자 승인 후 로그인할 수 있습니다.';
      } else if (result.passwordUpdated) {
        message = '비밀번호를 다시 설정했습니다. 관리자 승인 후 로그인할 수 있습니다.';
      }

      return res.status(403).json({ error: 'pending_approval', message });
    }

    // 비밀번호가 새로 저장되는 경우다. 확인 입력을 받기 전에는 쓰지 않는다.
    // 자격 증명을 틀린 게 아니므로 실패 횟수에 넣지 않는다.
    case 'confirm_required':
      log.info(`Password confirmation required (${result.reason}) for ${email} from ${key}`);
      return res.status(403).json({
        error: 'password_confirm_required',
        reason: result.reason,
        message:
          result.reason === 'signup'
            ? '등록되지 않은 이메일입니다. 여기서 입력한 비밀번호가 이 계정의 비밀번호가 됩니다. 확인을 위해 한 번 더 입력하세요.'
            : '승인 대기 중인 계정입니다. 비밀번호를 다시 설정하려면 확인을 위해 한 번 더 입력하세요.',
      });

    case 'confirm_mismatch':
      return res.status(400).json({
        error: 'password_mismatch',
        reason: result.reason,
        message: '두 비밀번호가 일치하지 않습니다. 다시 입력하세요.',
      });

    case 'unavailable':
      log.error(`Login unavailable (DB) for ${email} from ${key}`);
      return res.status(503).json({
        error: 'service_unavailable',
        message: '인증 저장소에 접속할 수 없습니다. 잠시 후 다시 시도하세요.',
      });

    default:
      recordFailure(key);
      log.warn(`Login failed for "${email}" from ${key}`);
      return res.status(401).json({
        error: 'invalid_credentials',
        message: '이메일 또는 비밀번호가 올바르지 않습니다.',
      });
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie(config.cookieName, { ...session.cookieOptions(), maxAge: undefined });
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: { username: req.user.username, displayName: req.user.displayName }, expiresAt: req.user.expiresAt });
});

// --- 대시보드 데이터 ---

router.get('/overview', requireAuth, async (req, res, next) => {
  try {
    const { server, services: registered, source } = loadServices();

    const [checks, pm2Map, nginxStatus] = await Promise.all([
      health.checkAll(registered),
      pm2.list(),
      nginx.status(),
    ]);

    const services = registered.map((service, i) => ({
      ...service,
      health: checks[i],
      pm2: pm2Map.get(service.name) || null,
    }));

    const summary = {
      total: services.length,
      up: services.filter((s) => s.health.status === 'up').length,
      degraded: services.filter((s) => s.health.status === 'degraded').length,
      down: services.filter((s) => s.health.status === 'down').length,
      unknown: services.filter((s) => s.health.status === 'unknown').length,
    };

    res.json({
      nginx: nginxStatus,
      server,
      services,
      summary,
      source,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/services/:name/health', requireAuth, async (req, res, next) => {
  try {
    const { services } = loadServices();
    const service = services.find((s) => s.name === req.params.name);
    if (!service) return res.status(404).json({ error: 'not_found' });

    res.json({ name: service.name, health: await health.checkOne(service) });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, requireAuth };
