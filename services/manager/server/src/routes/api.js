const express = require('express');
const config = require('../config');
const log = require('../logger');
const session = require('../auth/session');
const { createUserStore } = require('../auth/user-store');
const { loadServices } = require('../services/registry');
const health = require('../services/health');
const pm2 = require('../services/pm2');
const nginx = require('../services/nginx');
const cert = require('../services/cert');
const setup = require('../services/setup');
const attest = require('../services/setup-attest');
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

// --- 인증 ---

// 로그인 아이디는 이메일만 받는다.
// 지나치게 엄격하면 정상 주소를 막으므로 구조만 확인한다.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

router.post('/login', async (req, res) => {
  const key = attemptKey(req);
  if (isLockedOut(key)) {
    return res.status(429).json({ error: 'too_many_attempts', message: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.' });
  }

  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'missing_credentials', message: '이메일과 비밀번호를 입력하세요.' });
  }

  const email = String(username).trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'invalid_email', message: '아이디는 이메일 주소여야 합니다.' });
  }

  const result = await userStore.authenticate(email, String(password), { ip: key });

  switch (result.status) {
    case 'ok': {
      attempts.delete(key);
      const { token, expiresAt } = session.issue(result.user);
      res.cookie(config.cookieName, token, session.cookieOptions());
      log.info(`Login OK: ${result.user.username} from ${key}`);
      return res.json({ user: result.user, expiresAt });
    }

    case 'pending':
      // 승인 대기는 실패 횟수에 넣지 않는다. 아직 자격 증명을 틀린 게 아니다.
      log.info(`Login pending approval: ${email} from ${key}`);
      return res.status(403).json({
        error: 'pending_approval',
        message: result.firstRequest
          ? '승인 요청이 등록되었습니다. 관리자 승인 후 로그인할 수 있습니다.'
          : '승인 대기 중인 계정입니다. 관리자 승인 후 로그인할 수 있습니다.',
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

/**
 * 지금 로그인한 사람이 맞는지 **비밀번호로** 다시 확인한다.
 *
 * 서비스 대시보드가 민감한 값(예: janus 의 api_secret)을 화면에 꺼내기 전에
 * 부릅니다. 세션 쿠키만으로는 "자리를 비운 사이 누가 화면을 봤는가" 를 가릴 수
 * 없기 때문입니다.
 *
 * 세션에서 사용자를 얻으므로 **아무 프로세스나 부를 수 있는 비밀번호 확인기가
 * 아닙니다** — 그 사람의 유효한 세션 쿠키를 들고 있어야 합니다. 실패는 로그인과
 * 같은 IP 잠금 통에 넣습니다.
 */
router.post('/verify-password', requireAuth, async (req, res) => {
  const key = attemptKey(req);
  if (isLockedOut(key)) {
    return res.status(429).json({ error: 'too_many_attempts', message: '시도가 너무 많습니다. 잠시 후 다시 하세요.' });
  }

  const password = String(req.body?.password ?? '');
  if (!password) return res.status(400).json({ error: 'missing_password' });

  // verifyOnly — 확인만 한다. 승인 요청을 만들거나 비밀번호를 고치지 않는다.
  const result = await userStore.authenticate(req.user.username, password, { ip: key, verifyOnly: true });

  if (result.status === 'ok') {
    attempts.delete(key);
    return res.json({ ok: true });
  }
  if (result.status === 'unavailable') {
    return res.status(503).json({ error: 'service_unavailable', message: '인증 저장소에 접속할 수 없습니다.' });
  }

  recordFailure(key);
  log.warn(`verify-password failed for ${req.user.username} from ${key}`);
  return res.status(401).json({ error: 'invalid_password', message: '비밀번호가 맞지 않습니다.' });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: { username: req.user.username, displayName: req.user.displayName }, expiresAt: req.user.expiresAt });
});

// --- 대시보드 데이터 ---

router.get('/overview', requireAuth, async (req, res, next) => {
  try {
    const { server, services: registered, source } = loadServices();

    const [checks, pm2Map, nginxStatus, certStatus] = await Promise.all([
      health.checkAll(registered),
      pm2.list(),
      nginx.status(),
      // 인증서는 nginx 가 내미는 것을 본다. 포트·SNI 는 nginx-stack.conf 값이다.
      cert.status(server),
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
      cert: certStatus,
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

// --- 구축 마법사 (docs/setup-wizard.md) ---

// 단계 정의 + 각 단계의 마지막 점검 결과. 결과는 메모리에만 있으므로 재기동
// 뒤에는 비어 있고, 화면이 들어오면서 다시 점검한다.
router.get('/setup', requireAuth, (req, res) => {
  res.json(setup.overview());
});

// 그 단계의 점검 스크립트를 돌린다. 무엇을 돌릴지는 services/setup.js 의 표가
// 정한다 — :stepId 는 그 표에서 한 줄을 고르는 데만 쓴다.
router.post('/setup/check/:stepId', requireAuth, async (req, res, next) => {
  const step = setup.find(req.params.stepId);
  if (!step) return res.status(404).json({ error: 'unknown_step' });

  // manualOnly 단계는 돌릴 점검이 없다. 사람의 확인만 받는다 (아래 attest).
  if (!step.check) {
    return res.status(400).json({ error: 'manual_only', message: '사람이 확인하는 단계입니다.' });
  }

  try {
    res.json(await setup.check(step.id));
  } catch (err) {
    next(err);
  }
});

// 그 단계의 파라미터를 서비스의 settings.ini 에 쓴다. **값만 쓴다** — 설정
// 파일을 만지지도, 서비스를 재기동하지도 않는다. 반영은 사람이 --apply 로 한다.
router.put('/setup/settings/:stepId', requireAuth, (req, res, next) => {
  const step = setup.find(req.params.stepId);
  if (!step) return res.status(404).json({ error: 'unknown_step' });
  if (!step.settings) {
    return res.status(400).json({ error: 'no_settings', message: '파라미터를 받는 단계가 아닙니다.' });
  }

  try {
    const result = setup.saveSettings(step, req.body || {});
    // 형식이 틀리면 아무것도 쓰지 않고 어느 항목이 왜 틀렸는지 돌려준다.
    if (!result.ok) return res.status(400).json({ error: 'invalid_settings', errors: result.errors });
    res.json({ stepId: step.id, ...result });
  } catch (err) {
    next(err);
  }
});

// 사람의 확인을 기록한다. **통과로 바꾸는 것이 아니라 기록하는 것이다** —
// 점검이 problem 이면 확인 기록이 있어도 problem 으로 남는다 (services/setup.js).
router.post('/setup/attest/:stepId', requireAuth, (req, res) => {
  const step = setup.find(req.params.stepId);
  if (!step) return res.status(404).json({ error: 'unknown_step' });
  if (!step.attest) {
    return res.status(400).json({ error: 'not_attestable', message: '사람의 확인을 받는 단계가 아닙니다.' });
  }

  const record = attest.record(step.id, { by: req.user.username, note: req.body?.note });
  res.json({ stepId: step.id, attestation: record });
});

// 확인 기록을 지운다. 되돌렸거나 잘못 눌렀을 때 쓴다.
router.delete('/setup/attest/:stepId', requireAuth, (req, res) => {
  const step = setup.find(req.params.stepId);
  if (!step) return res.status(404).json({ error: 'unknown_step' });

  const removed = attest.remove(step.id);
  res.json({ stepId: step.id, removed });
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
