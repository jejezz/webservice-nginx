const fs = require('fs');
const config = require('../config');
const log = require('../logger');
const { loadRoutes } = require('../nginx-conf');

/**
 * PM2 앱 목록을 읽는다. pm2/ecosystem.config.js 가 각 서비스의 pm2-conf 선언을
 * 스캔해 만든 배열이다.
 * Nginx 라우트가 없는 서비스(포트로 직접 접근하는 서비스)도 대시보드에 표시하기 위함이다.
 *
 * 각 앱의 env에서 다음 값을 사용한다.
 *   PORT                  : 기본 헬스 URL(http://127.0.0.1:PORT/health) 구성에 사용
 *   HEALTH_URL            : 헬스 URL을 직접 지정 (HTTPS 서비스 등)
 *   HEALTH_INSECURE_TLS   : 'true'면 자체 서명 인증서 검증을 건너뜀
 */
// 헬스 URL에서 대상 호스트/포트를 추출한다. (PORT 없이 HEALTH_URL만 지정된 서비스용)
function describeTarget(healthUrl) {
  if (!healthUrl) return null;
  try {
    const url = new URL(healthUrl);
    const protocol = url.protocol.replace(':', '');
    return {
      protocol,
      host: url.hostname,
      port: url.port ? Number(url.port) : protocol === 'https' ? 443 : 80,
    };
  } catch {
    return null;
  }
}

/**
 * 서비스 자체 대시보드의 공개 URL.
 * Nginx location과 서비스가 선언한 대시보드 경로를 합친다.
 * 둘 중 하나라도 없으면 브라우저에서 열 수 없으므로 null.
 */
function dashboardUrl(service, dashboardPath) {
  if (!dashboardPath || !service.location) return null;

  const base = service.location.replace(/\/+$/, '');
  const suffix = dashboardPath.startsWith('/') ? dashboardPath : `/${dashboardPath}`;
  return `${base}${suffix}`;
}

function loadEcosystem(ecosystemPath) {
  if (!ecosystemPath || !fs.existsSync(ecosystemPath)) return [];

  try {
    // 파일이 수정되면 재시작 없이 반영되도록 캐시를 지운다.
    delete require.cache[require.resolve(ecosystemPath)];
    const cfg = require(ecosystemPath);

    return (cfg.apps || []).map((app) => {
      const env = app.env || {};
      const port = env.PORT ? Number(env.PORT) : null;
      const explicitHealthUrl = env.HEALTH_URL || null;

      const healthUrl = explicitHealthUrl || (port ? `http://127.0.0.1:${port}/health` : null);

      return {
        name: app.name,
        port,
        script: app.script || null,
        explicitHealthUrl,
        healthUrl,
        target: describeTarget(healthUrl),
        insecureTls: String(env.HEALTH_INSECURE_TLS).toLowerCase() === 'true',
        // 서비스가 자체 대시보드를 제공하면 그 경로. (없으면 링크를 만들지 않는다)
        dashboardPath: env.DASHBOARD_PATH || null,
      };
    });
  } catch (err) {
    log.warn(`Failed to read ecosystem config (${ecosystemPath}): ${err.message}`);
    return [];
  }
}

/**
 * nginx-conf 라우트와 PM2 앱 목록을 이름 기준으로 합친다.
 * 각 서비스의 sources에 'nginx' / 'pm2'가 표시된다.
 */
function loadServices() {
  const { server, routes, source } = loadRoutes(config.nginxStackPath);
  const apps = loadEcosystem(config.ecosystemPath);

  const byName = new Map();

  for (const route of routes) {
    byName.set(route.name, {
      ...route,
      // HTTPS 백엔드는 대개 자체 서명 인증서를 쓰므로 검증을 건너뛴다.
      insecureTls: route.target?.protocol === 'https',
      // pm2 앱에서 DASHBOARD_PATH를 선언한 경우 아래 루프에서 채워진다.
      dashboardUrl: null,
      sources: ['nginx'],
    });
  }

  for (const app of apps) {
    const existing = byName.get(app.name);

    if (existing) {
      existing.sources.push('pm2');
      // ecosystem에 헬스 URL이 명시돼 있으면 그쪽을 우선한다.
      if (app.explicitHealthUrl) {
        existing.healthUrl = app.explicitHealthUrl;
        existing.insecureTls = app.insecureTls;
      }
      existing.dashboardUrl = dashboardUrl(existing, app.dashboardPath || existing.dashboardPath);
      continue;
    }

    byName.set(app.name, {
      name: app.name,
      location: null,
      proxyPass: null,
      websocket: false,
      healthPath: '/health',
      target: app.target,
      healthUrl: app.healthUrl,
      publicPath: null,
      insecureTls: app.insecureTls,
      // Nginx 라우트가 없으면 브라우저에서 열 수 없으므로 링크를 만들지 않는다.
      dashboardUrl: null,
      sources: ['pm2'],
    });
  }

  return {
    server,
    services: [...byName.values()],
    source: {
      ...source,
      ecosystemPath: fs.existsSync(config.ecosystemPath) ? config.ecosystemPath : null,
    },
  };
}

module.exports = { loadServices, loadEcosystem };
