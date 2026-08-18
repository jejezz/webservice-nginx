const fs = require('fs');
const path = require('path');
const express = require('express');
const config = require('./config');
const log = require('./logger');
const db = require('./db');
const { router: apiRouter } = require('./routes/api');

const pkg = require('../package.json');
const startedAt = Date.now();

const app = express();
app.disable('x-powered-by');
// Nginx 뒤에서 동작하므로 X-Forwarded-* 헤더를 신뢰한다. (req.ip, req.protocol)
app.set('trust proxy', true);

app.use(express.json({ limit: '64kb' }));

// 쿠키 파서 (의존성 없이 최소 구현)
app.use((req, res, next) => {
  req.cookies = {};
  const header = req.headers.cookie;
  if (header) {
    for (const part of header.split(';')) {
      const idx = part.indexOf('=');
      if (idx < 0) continue;
      const name = part.slice(0, idx).trim();
      if (!name) continue;
      try {
        req.cookies[name] = decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        req.cookies[name] = part.slice(idx + 1).trim();
      }
    }
  }
  next();
});

const router = express.Router();

// manager 자신의 상태 확인 엔드포인트 (인증 불필요 — 다른 서비스와 동일한 규약)
router.get('/health', async (req, res) => {
  // DB는 로그인에 필요하지만, 끊겨도 서비스 자체는 살아 있으므로 status는 ok로 둔다.
  // 대신 details.database 로 상태를 드러내 대시보드에서 확인할 수 있게 한다.
  const database = await db.ping();

  res.status(200).json({
    service: 'manager',
    status: 'ok',
    version: pkg.version,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    pid: process.pid,
    timestamp: new Date().toISOString(),
    details: {
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      configPath: config.configPath,
      authProvider: config.auth.provider,
      database,
    },
  });
});

router.use('/api', apiRouter);

// --- 정적 프론트엔드 (web/dist 빌드 결과) ---
const indexHtml = path.join(config.publicDir, 'index.html');
const hasBuild = fs.existsSync(indexHtml);

if (hasBuild) {
  router.use(
    express.static(config.publicDir, {
      index: false,
      setHeaders: (res, filePath) => {
        // 해시가 붙은 에셋은 장기 캐시, 그 외에는 캐시하지 않는다.
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    })
  );

  // SPA 폴백 — 클라이언트 라우팅(/login, /dashboard 등)을 index.html이 처리한다.
  router.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(indexHtml);
  });
} else {
  log.warn(`Frontend build not found at ${config.publicDir} — run "npm run build" in manager/web`);
  router.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.status(503).type('text/plain').send('Frontend build not found. Run: cd manager/web && npm install && npm run build');
  });
}

// 기본값은 루트(basePath = '')다. Nginx의 location / 이 이 서버로 그대로 넘긴다.
// basePath를 지정하면 그 경로와 루트 양쪽에 마운트해 포트로 직접 접근할 때도 동작한다.
if (config.basePath) app.use(config.basePath, router);
app.use('/', router);

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  log.error(`${req.method} ${req.originalUrl}:`, err.message);
  res.status(500).json({ error: 'internal_error', message: err.message });
});

const server = app.listen(config.port, config.host, () => {
  log.info(`Manager listening on ${config.host}:${config.port} (basePath: ${config.basePath || '/'})`);
  log.info(`Config: ${config.configPath}`);
  log.info(`서비스 선언: ${config.servicesDir}/*/nginx-conf/*.ini`);
  log.info(`nginx 서버 설정: ${config.nginxStackPath}`);

  if (!config.superAdmin.passwordHash && !config.superAdmin.password) {
    log.warn(
      '관리자 콘솔 비밀번호가 설정되지 않아 로그인 화면의 설정 버튼이 동작하지 않습니다. ' +
        "config.json 의 superAdmin.passwordHash 에 `npm run hash-password -- '<비밀번호>'` 결과를 넣으세요."
    );
  }
});

function shutdown(signal) {
  log.info(`${signal} received, shutting down...`);
  server.close(async () => {
    await db.close().catch(() => {});
    log.info('Server closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
