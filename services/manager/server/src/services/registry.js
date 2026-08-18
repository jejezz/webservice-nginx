const fs = require('fs');
const config = require('../config');
const log = require('../logger');
const { loadDeclarations, loadServerConfig } = require('../nginx-conf');

/**
 * PM2 ecosystem.config.js에서 프로세스 목록을 읽는다.
 * nginx-conf 를 선언하지 않은 서비스(포트로 직접 접근하는 서비스)도 보여주기 위함이다.
 *
 * 각 앱의 env에서 다음 값을 사용한다.
 *   PORT                  : 선언과 대조할 포트
 *   HEALTH_URL            : 헬스 URL을 직접 지정 (HTTPS 서비스 등)
 *   HEALTH_INSECURE_TLS   : 'true'면 자체 서명 인증서 검증을 건너뜀
 *   DASHBOARD_PATH        : 서비스가 자체 관리 페이지를 제공할 때의 경로
 */
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
function dashboardUrl(location, dashboardPath) {
  if (!dashboardPath || !location) return null;

  const base = location.replace(/\/+$/, '');
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
        dashboardPath: env.DASHBOARD_PATH || null,
      };
    });
  } catch (err) {
    log.warn(`Failed to read ecosystem config (${ecosystemPath}): ${err.message}`);
    return [];
  }
}

/**
 * 선언 하나를 포트 단위 서비스로 펼친다.
 * 업스트림에 포트가 여러 개면 least_conn 으로 분산되므로, 각 백엔드를
 * 따로 헬스 체크해야 어느 인스턴스가 죽었는지 알 수 있다.
 *   ports = 5501 5502  ->  face-recognition-server[5501], face-recognition-server[5502]
 */
function expandDeclaration(declaration) {
  const { ports, protocol, host } = declaration;
  const multi = ports.length > 1;

  return ports.map((port) => ({
    // 인스턴스가 하나면 이름을 그대로 쓴다. 여럿이면 포트로 구분한다.
    name: multi ? `${declaration.name}[${port}]` : declaration.name,
    serviceName: declaration.name,
    directory: declaration.directory,
    location: declaration.location,
    locations: declaration.locations,
    proxyPass: `${protocol}://${host}:${port}`,
    upstream: declaration.upstream,
    websocket: declaration.websocket,
    healthPath: declaration.healthPath,
    target: { protocol, host, port },
    // 헬스 체크는 Nginx를 거치지 않고 백엔드에 직접 요청한다.
    healthUrl: `${protocol}://${host}:${port}${declaration.healthPath}`,
    publicPath: declaration.location,
    // 백엔드가 HTTPS면 대개 자체 서명 인증서를 쓰므로 검증을 건너뛴다.
    insecureTls: protocol === 'https',
    dashboardUrl: dashboardUrl(declaration.location, declaration.dashboardPath),
    routeCount: declaration.routes.length,
    declaredIn: declaration.source,
    sources: ['nginx'],
  }));
}

/**
 * nginx-conf 선언과 PM2 프로세스 목록을 합친다.
 * 이름이 같으면 합치고, 다르면 PORT(또는 HEALTH_URL의 포트)가 같을 때 합친다.
 * 각 서비스의 sources에 'nginx' / 'pm2'가 표시된다.
 */
function loadServices() {
  const { services: declarations, errors, scannedAt } = loadDeclarations(config.servicesDir);
  const apps = loadEcosystem(config.ecosystemPath);

  for (const err of errors) {
    log.warn(`Invalid nginx-conf (${err.path}): ${err.message}`);
  }

  const services = declarations.flatMap(expandDeclaration);
  const byName = new Map(services.map((s) => [s.name, s]));
  const byPort = new Map();
  for (const s of services) {
    // 같은 포트를 여럿이 선언할 수는 없지만, 먼저 온 것을 유지한다.
    if (!byPort.has(s.target.port)) byPort.set(s.target.port, s);
  }

  for (const app of apps) {
    const appPort = app.port || app.target?.port || null;
    const existing =
      byName.get(app.name) ||
      services.find((s) => s.serviceName === app.name) ||
      (appPort ? byPort.get(appPort) : null);

    if (existing) {
      if (!existing.sources.includes('pm2')) existing.sources.push('pm2');
      // 선언과 프로세스 이름이 다르면 운영자가 아는 PM2 이름으로 부른다.
      if (existing.name !== app.name) {
        byName.delete(existing.name);
        existing.name = app.name;
        byName.set(app.name, existing);
      }
      if (app.explicitHealthUrl) {
        existing.healthUrl = app.explicitHealthUrl;
        existing.insecureTls = app.insecureTls;
      }
      if (app.dashboardPath) {
        existing.dashboardUrl = dashboardUrl(existing.location, app.dashboardPath);
      }
      continue;
    }

    byName.set(app.name, {
      name: app.name,
      serviceName: app.name,
      directory: null,
      location: null,
      locations: [],
      proxyPass: null,
      upstream: null,
      websocket: false,
      healthPath: '/health',
      target: app.target,
      healthUrl: app.healthUrl,
      publicPath: null,
      insecureTls: app.insecureTls,
      // nginx-conf 선언이 없으면 브라우저에서 열 수 없으므로 링크를 만들지 않는다.
      dashboardUrl: null,
      routeCount: 0,
      declaredIn: null,
      sources: ['pm2'],
    });
  }

  return {
    server: loadServerConfig(config.nginxStackPath),
    services: [...byName.values()],
    source: {
      servicesDir: config.servicesDir,
      ecosystemPath: fs.existsSync(config.ecosystemPath) ? config.ecosystemPath : null,
      declarations: declarations.length,
      errors,
      scannedAt,
    },
  };
}

module.exports = { loadServices, loadEcosystem, expandDeclaration };
