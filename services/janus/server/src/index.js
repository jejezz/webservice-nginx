/**
 * janus-dashboard — Janus 관찰용 웹 서비스이자 시험 클라이언트를 내려주는 곳.
 *
 * Janus 자체는 systemd 가 띄웁니다 (services/janus/pm2-conf/app.ini 참고).
 * 이 프로세스는 그 옆에서 상태를 읽어 보여주기만 합니다 — 시그널링이나 미디어에
 * 관여하지 않고, Janus 를 재시작하거나 설정을 바꾸지도 않습니다.
 *
 * 브라우저 시험 클라이언트(janus.js)도 여기서 정적 파일로 내려갑니다. nginx
 * 라우트는 프록시만 만들 수 있어 정적 root 를 선언할 수단이 없고, 어차피
 * /health 와 세션 검증을 할 프로세스가 필요하기 때문입니다.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const config = require('./config');
const janus = require('./janus');
const log = require('./utils/logger');
const { createApiRouter } = require('./api');
const { requirePage } = require('./auth/session');
const pkg = require('../package.json');

// server/src → 서비스 디렉토리(services/janus) 아래의 web/dist
const DASHBOARD_DIR = path.resolve(__dirname, '../..', 'web', 'dist');

const startedAt = Date.now();

async function main() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '64kb' }));

  // 루트 경로와 Nginx 접두사(/janus) 양쪽에서 동일하게 응답한다.
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
   * 여기서 status 는 **이 대시보드 프로세스**의 상태입니다. Janus 가 죽어
   * 있어도 ok 로 두고 details 로 드러냅니다 — 둘은 다른 프로세스이고,
   * 대시보드가 살아 있어야 Janus 가 죽은 것을 볼 수 있기 때문입니다.
   * (kamailio-dashboard 와 같은 판단)
   *
   * Janus 자체의 헬스는 nginx-conf/service.ini 가 /janus-api/info 로 따로
   * 선언합니다. manager 는 그쪽을 봅니다.
   */
  router.get('/health', async (req, res) => {
    const [info, admin] = await Promise.all([janus.info(), janus.ping()]);

    res.status(200).json({
      service: config.SERVICE_NAME,
      status: 'ok',
      version: pkg.version,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      pid: process.pid,
      timestamp: new Date().toISOString(),
      details: {
        memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        janus: info.ok
          ? { ok: true, version: info.data?.version_string, latencyMs: info.latencyMs }
          : { ok: false, error: info.error },
        janusAdmin: admin.ok ? { ok: true } : { ok: false, error: admin.error },
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
    // janus.js 하나만 따로 준다. 정적 파일이라 인증을 걸지 않는다.
    //
    // dist 전체를 express.static 으로 열지 않는 이유는 index.html 까지 인증
    // 없이 나가기 때문이다. 아래 requirePage 를 지나야 화면이 뜬다.
    //
    // 이 파일은 setup-dashboard.sh --build 가 /opt/janus 에서 복사해 vite 가
    // dist 로 옮긴 것이다 (docs/plan.md 의 "janus.js 는 커밋하지 않는다").
    router.get(`${dashboard}/janus.js`, (req, res) => {
      const file = path.join(DASHBOARD_DIR, 'janus.js');
      if (!fs.existsSync(file)) {
        return res.status(503).type('text/plain')
          .send('janus.js not found. Run: services/janus/setup-dashboard.sh --build');
      }
      return res.sendFile(file);
    });

    router.get(`${dashboard}`, requirePage, (req, res) => res.sendFile(indexHtml));
    router.get(`${dashboard}/*`, requirePage, (req, res) => res.sendFile(indexHtml));
  } else {
    log.warn(`대시보드 빌드를 찾을 수 없습니다: ${DASHBOARD_DIR} — "./setup-dashboard.sh --build"`);
    router.get(`${dashboard}*`, (req, res) => {
      res.status(503).type('text/plain')
        .send('Dashboard build not found. Run: services/janus/setup-dashboard.sh --build');
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
    log.info(`janus-dashboard listening on ${config.HOST}:${config.PORT}`);
    log.info(`Dashboard: ${config.BASE_PATH}${dashboard}${hasBuild ? '' : ' (빌드 없음)'}`);

    // 기동 직후 Janus 에 닿는지 알려 둔다. 사용자가 화면을 열어 보기 전에
    // 로그에서 먼저 알아챌 수 있다.
    const probe = await janus.info();
    if (probe.ok) {
      log.info(`Janus 연결 확인 — ${probe.data.version_string} (${probe.latencyMs}ms)`);
      const admin = await janus.ping();
      if (admin.ok) log.info('Janus Admin API 연결 확인');
      else log.warn(`Janus Admin API 에 닿지 않습니다: ${admin.error}`);
    } else {
      log.warn(`Janus 에 닿지 않습니다: ${probe.error} (${config.JANUS_API_BASE})`);
      log.warn('  sudo services/janus/install.sh --apply 를 실행했는지 확인하세요.');
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
