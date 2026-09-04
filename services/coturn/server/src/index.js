/**
 * coturn-dashboard — coturn(TURN/STUN) 관찰용 웹 서비스.
 *
 * coturn 자체는 apt 패키지의 systemd 유닛(coturn.service)이 띄웁니다
 * (services/coturn/pm2-conf/app.ini 참고). 이 프로세스는 그 옆에서 상태를
 * 읽어 보여주기만 합니다 — STUN/TURN 처리에 관여하지 않고, coturn 을
 * 재시작하거나 설정을 바꾸지도 않습니다.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const config = require('./config');
const coturn = require('./coturn');
const log = require('./utils/logger');
const { createApiRouter } = require('./api');
const { requirePage } = require('./auth/session');
const pkg = require('../package.json');

// server/src → 서비스 디렉토리(services/coturn) 아래의 web/dist
const DASHBOARD_DIR = path.resolve(__dirname, '../..', 'web', 'dist');

const startedAt = Date.now();

async function main() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '64kb' }));

  // 루트 경로와 Nginx 접두사(/coturn) 양쪽에서 동일하게 응답한다.
  const router = express.Router();

  router.get('/', (req, res) => {
    res.json({
      service: config.SERVICE_NAME,
      status: 'ok',
      dashboard: `${config.BASE_PATH}${config.DASHBOARD_PATH}`,
    });
  });

  /**
   * 모든 서비스가 제공해야 하는 상태 확인 엔드포인트 (docs/health-contract.md).
   *
   * 여기서 status 는 **이 대시보드 프로세스**의 상태입니다. coturn 이 죽어
   * 있어도 ok 로 두고 details 로 드러냅니다 — 둘은 다른 프로세스이고,
   * 대시보드가 살아 있어야 coturn 이 죽은 것을 볼 수 있기 때문입니다.
   *
   * details 에는 세션·할당 개수를 넣지 않습니다 — coturn CLI 를 켜지 않기로
   * 했으므로(turnserver.conf 의 no-cli, server/src/coturn.js 의 주석) 그
   * 숫자를 알 방법이 없습니다. 없는 데이터를 지어내는 대신 여기서 그렇다고
   * 밝힙니다.
   */
  router.get('/health', async (req, res) => {
    const status = await coturn.status();

    res.status(200).json({
      service: config.SERVICE_NAME,
      status: 'ok',
      version: pkg.version,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      pid: process.pid,
      timestamp: new Date().toISOString(),
      details: {
        memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        coturn: {
          packageInstalled: status.packageInstalled,
          serviceState: status.serviceState,
          config: status.config.state,
        },
        // 세션/할당 개수는 의도적으로 없습니다 — 위 주석 참고.
        dashboardBuilt: fs.existsSync(path.join(DASHBOARD_DIR, 'index.html')),
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
        .send('Dashboard build not found. Run: cd services/coturn/web && npm install && npm run build');
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
    log.info(`coturn-dashboard listening on ${config.HOST}:${config.PORT}`);
    log.info(`Dashboard: ${config.BASE_PATH}${dashboard}${hasBuild ? '' : ' (빌드 없음)'}`);

    // 기동 직후 coturn 이 떠 있는지 알려 둔다. 사용자가 화면을 열어 보기
    // 전에 로그에서 먼저 알아챌 수 있다.
    const status = await coturn.status();
    if (status.serviceState === 'active') {
      log.info(`coturn 구동 확인 (패키지 ${status.packageInstalled ? '설치됨' : '설치 안 됨(?)'})`);
    } else {
      log.warn(`coturn 이 떠 있지 않습니다 (상태: ${status.serviceState})`);
      if (!status.packageInstalled) {
        log.warn('  sudo services/coturn/install.sh --apply 를 실행했는지 확인하세요.');
      }
    }
  });

  function shutdown(signal) {
    log.info(`${signal} received, shutting down...`);
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
