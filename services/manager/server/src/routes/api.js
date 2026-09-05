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
const cert = require('../services/cert');
const setup = require('../services/setup');
const attest = require('../services/setup-attest');
const portMap = require('../services/port-map');
const docs = require('../services/docs');
const changelog = require('../services/changelog');
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

/**
 * 구축 마법사 전용 — 일반 세션 **또는** 관리자 콘솔 세션.
 *
 * 빈 장비에서는 일반 세션을 낼 수가 없다. 그 세션은 POST /login 에서만 나고,
 * 그 라우트는 계정을 MariaDB 의 administrator 테이블에서 찾는데, **MariaDB 를
 * 세우는 것이 이 마법사의 2단계**다. 들어가야 세울 수 있고 세워야 들어갈 수
 * 있는 상태였다.
 *
 * 관리자 콘솔 세션은 그 고리 밖에 있다 — config.json 만으로 인증되고 DB 를
 * 쓰지 않는다. 그래서 이 문을 그쪽에도 연다.
 *
 * **권한이 넓어지는 것이 아니다.** superAdmin 은 이미 모든 관리자 계정을 만들고
 * 지울 수 있는, 이 시스템에서 가장 높은 자격이다. 그것이 서버 구축을 못 할
 * 이유가 없다. 그리고 비밀번호가 없으면 콘솔 자체가 열리지 않으므로
 * (routes/admin.js 의 fail-closed) 기본값으로 열리는 문이 생기지도 않는다.
 *
 * 여는 범위는 /setup* 뿐이다. /overview 나 /services/:name/health 처럼 운영
 * 데이터를 보는 자리는 그대로 일반 세션만 받는다 — 필요하지 않은 것까지
 * 넓히지 않는다.
 *
 * 콘솔로 들어온 경우 req.user.username 은 'console:<아이디>' 다.
 * admin_audit_log 가 쓰는 표기와 같게 두어, 확인 기록(setup-attest.json)에도
 * "누가 눌렀는가" 가 구분되어 남는다.
 */
function requireAuthOrConsole(req, res, next) {
  const user = session.verify(req.cookies?.[config.cookieName]);
  if (user) {
    req.user = user;
    req.viaConsole = false;
    return next();
  }

  const admin = session.verifySuper(req.cookies?.[config.superAdmin.cookieName]);
  if (admin) {
    req.user = { username: `console:${admin.username}`, displayName: admin.username };
    req.viaConsole = true;
    return next();
  }

  return res.status(401).json({ error: 'unauthorized' });
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
    // 값이 없으면 넘기지 않는다. authenticate() 는 '입력 없음' 과 '빈 문자열' 을 구분한다.
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

      // 비밀번호가 저장됐다는 사실을 반드시 알린다. 이걸 모르면 승인이 난 뒤
      // 로그인이 안 될 때 원인을 찾을 수 없다.
      let message = '승인 대기 중인 계정입니다. 관리자 승인 후 로그인할 수 있습니다.';
      if (result.firstRequest) {
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
router.get('/setup', requireAuthOrConsole, (req, res) => {
  res.json(setup.overview());
});

// 그 단계의 점검 스크립트를 돌린다. 무엇을 돌릴지는 services/setup.js 의 표가
// 정한다 — :stepId 는 그 표에서 한 줄을 고르는 데만 쓴다.
router.post('/setup/check/:stepId', requireAuthOrConsole, async (req, res, next) => {
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
router.put('/setup/settings/:stepId', requireAuthOrConsole, (req, res, next) => {
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
router.post('/setup/attest/:stepId', requireAuthOrConsole, (req, res) => {
  const step = setup.find(req.params.stepId);
  if (!step) return res.status(404).json({ error: 'unknown_step' });
  if (!step.attest) {
    return res.status(400).json({ error: 'not_attestable', message: '사람의 확인을 받는 단계가 아닙니다.' });
  }

  const record = attest.record(step.id, { by: req.user.username, note: req.body?.note });
  res.json({ stepId: step.id, attestation: record });
});

// 확인 기록을 지운다. 되돌렸거나 잘못 눌렀을 때 쓴다.
router.delete('/setup/attest/:stepId', requireAuthOrConsole, (req, res) => {
  const step = setup.find(req.params.stepId);
  if (!step) return res.status(404).json({ error: 'unknown_step' });

  const removed = attest.remove(step.id);
  res.json({ stepId: step.id, removed });
});

// RTP·시그널링·내부 HTTP 포트 전체 지도. 공유기를 바꾸거나 포워딩을 다시
// 확인할 때 보는 화면이다 (docs/port-map.md).
router.get('/port-map', requireAuth, (req, res, next) => {
  try {
    res.json(portMap.build());
  } catch (err) {
    next(err);
  }
});

// --- 문서 (docs/*.md, 각 서비스의 README.md 등 git 이 추적하는 .md 전부) ---
//
// 목록·내용 둘 다 docs.listPaths() 가 매번 다시 만드는 git 추적 목록을
// 기준으로 한다 — 클라이언트가 보낸 경로를 그 목록에 있는지만 확인하고
// 읽으므로, 목록에 없는 경로(상위 디렉토리 접근 포함)는 애초에 못 읽는다.
router.get('/docs', requireAuth, async (req, res, next) => {
  try {
    res.json({ files: await docs.list() });
  } catch (err) {
    next(err);
  }
});

router.get('/docs/content', requireAuth, async (req, res, next) => {
  try {
    const result = await docs.getContent(String(req.query.path || ''));
    res.json(result);
  } catch (err) {
    if (err instanceof docs.NotFoundError) return res.status(404).json({ error: 'not_found', message: err.message });
    next(err);
  }
});

// --- 변경 이력 (git log) ---
//
// scope 는 화면에서 고르는 값만 받는다 — docs / services/<이름>. 그 밖의
// 값은 changelog.recent() 가 400 으로 거절한다.
router.get('/changelog', requireAuth, async (req, res, next) => {
  try {
    const commits = await changelog.recent({ scope: req.query.scope, limit: req.query.limit });
    res.json({ commits, scopes: changelog.scopes() });
  } catch (err) {
    if (err.code === 'INVALID_SCOPE') return res.status(400).json({ error: 'invalid_scope', message: err.message });
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
