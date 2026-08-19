/**
 * kamailio-dashboard — Kamailio 관찰용 웹 서비스.
 *
 * Kamailio 자체는 systemd 가 띄웁니다 (services/kamailio/pm2-conf/app.ini 참고).
 * 이 프로세스는 그 옆에서 상태를 읽어 보여주기만 합니다 — SIP 처리에 관여하지
 * 않고, Kamailio 를 재시작하거나 설정을 바꾸지도 않습니다.
 *
 * **kamailio 그룹으로 실행되어야 합니다.** JSON-RPC FIFO 가 그룹 권한으로만
 * 열려 있기 때문입니다. 자세한 내용은 src/rpc.js 의 주석.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const config = require('./config');
const stats = require('./stats');
const rpc = require('./rpc');
const db = require('./db');
const log = require('./utils/logger');
const { createApiRouter } = require('./api');
const { requirePage } = require('./auth/session');
const pkg = require('../package.json');

// server/src → 서비스 디렉토리(services/kamailio) 아래의 web/dist
const DASHBOARD_DIR = path.resolve(__dirname, '../..', 'web', 'dist');

async function main() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '64kb' }));

  app.use((req, res, next) => {
    stats.apiRequest();
    next();
  });

  // 루트 경로와 Nginx 접두사(/kamailio) 양쪽에서 동일하게 응답한다.
  const router = express.Router();

  router.get('/', (req, res) => {
    res.json({
      service: config.SERVICE_NAME,
      status: 'ok',
      dashboard: `${config.BASE_PATH}${config.DASHBOARD_PATH}`,
    });
  });

  /**
   * 모든 서비스가 제공해야 하는 상태 확인 엔드포인트.
   *
   * 여기서 status 는 **이 대시보드 프로세스**의 상태입니다. Kamailio 가 죽어
   * 있어도 ok 로 두고 details 로 드러냅니다 — 둘은 다른 프로세스이고, 대시보드가
   * 살아 있어야 Kamailio 가 죽은 것을 볼 수 있기 때문입니다.
   */
  router.get('/health', async (req, res) => {
    const [kamailio, database] = await Promise.all([rpc.ping(), db.ping()]);

    res.status(200).json({
      service: config.SERVICE_NAME,
      status: 'ok',
      version: pkg.version,
      uptimeSec: Math.floor((Date.now() - stats.startedAt) / 1000),
      pid: process.pid,
      timestamp: new Date().toISOString(),
      details: {
        memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        kamailio,
        database,
      },
    });
  });

  // --- 관리 대시보드 ---
  const dashboard = config.DASHBOARD_PATH;
  const indexHtml = path.join(DASHBOARD_DIR, 'index.html');
  const hasBuild = fs.existsSync(indexHtml);

  router.use(`${dashboard}/api`, createApiRouter());

  if (hasBuild) {
    // 정적 에셋은 인증 없이 준다 (데이터가 없는 JS/CSS).
    router.use(
      `${dashboard}/assets`,
      express.static(path.join(DASHBOARD_DIR, 'assets'), { immutable: true, maxAge: '1y' })
    );
    router.get(`${dashboard}`, requirePage, (req, res) => res.sendFile(indexHtml));
    router.get(`${dashboard}/*`, requirePage, (req, res) => res.sendFile(indexHtml));
  } else {
    log.warn(`대시보드 빌드를 찾을 수 없습니다: ${DASHBOARD_DIR} — "cd web && npm install && npm run build"`);
    router.get(`${dashboard}*`, (req, res) => {
      res.status(503).type('text/plain')
        .send('Dashboard build not found. Run: cd services/kamailio/web && npm install && npm run build');
    });
  }

  app.use('/', router);
  app.use(config.BASE_PATH, router);

  const server = http.createServer(app);

  // 기동 실패(EADDRINUSE 등)는 살려 둘 이유가 없다. 듣지도 못하는 프로세스가
  // 남으면 pm2 는 정상으로 본다.
  server.on('error', (err) => {
    if (!server.listening) {
      log.error(`서버를 시작할 수 없습니다 (${config.HOST}:${config.PORT}): ${err.message}`);
      process.exit(1);
    }
    log.error(`HTTP 서버 오류 (계속 실행): ${err.message}`);
  });

  server.listen(config.PORT, config.HOST, async () => {
    log.info(`kamailio-dashboard listening on ${config.HOST}:${config.PORT}`);
    log.info(`Dashboard: ${config.BASE_PATH}${dashboard}${hasBuild ? '' : ' (빌드 없음)'}`);

    // 기동 직후 RPC 가 닿는지 알려 둔다. 여기서 실패하면 대부분 그룹 권한 문제라,
    // 사용자가 대시보드를 열어 보기 전에 로그에서 먼저 알아챌 수 있다.
    const probe = await rpc.ping();
    if (probe.ok) {
      log.info(`Kamailio RPC 연결 확인 (uptime ${probe.uptime}s)`);
    } else {
      log.warn(`Kamailio RPC 에 닿지 않습니다: ${probe.error}`);
    }
  });

  async function shutdown(signal) {
    log.info(`${signal} received, shutting down...`);
    await db.close().catch(() => {});
    server.close(() => {
      log.info('Server closed');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/**
 * 최후의 안전망. 기록하되 프로세스는 살려 둔다.
 * 관찰용 서비스라 죽는 것보다 살아서 오류를 보여주는 편이 낫다.
 */
process.on('uncaughtException', (err) => {
  log.error('UNCAUGHT EXCEPTION (프로세스는 계속 실행):', err.stack || err.message);
});
process.on('unhandledRejection', (reason) => {
  log.error('UNHANDLED REJECTION (프로세스는 계속 실행):', reason instanceof Error ? reason.stack : reason);
});

main().catch((err) => {
  log.error('Fatal:', err.message);
  process.exit(1);
});
