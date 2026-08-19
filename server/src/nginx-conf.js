const fs = require('fs');
const path = require('path');

/**
 * services/<서비스>/nginx-conf/*.ini 스캐너.
 *
 * nginx 생성기(nginx/generate_nginx_conf.py)와 **같은 파일**을 읽어, 대시보드가
 * 실제로 반영된 라우팅과 어긋나지 않게 한다. 예전에는 nginx.ini 한 파일이
 * 그 역할을 했다 (src/nginx-ini.js — 이관 후 제거).
 *
 * 서버 수준 값(server_name, listen/ssl 포트, mTLS)은 nginx/nginx-stack.conf 에 있다.
 *
 * 스키마: docs/nginx-conf.md
 */

function parseIni(text) {
  const sections = {};
  const order = [];
  let current = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;

    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      current = sectionMatch[1].trim();
      if (!sections[current]) {
        sections[current] = {};
        order.push(current);
      }
      continue;
    }

    const kvMatch = line.match(/^([^=]+)=(.*)$/);
    if (kvMatch && current) {
      sections[current][kvMatch[1].trim()] = kvMatch[2].trim();
    }
  }

  return { sections, order };
}

const isTrue = (v) => ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
const isFalse = (v) => ['0', 'false', 'no', 'off'].includes(String(v).trim().toLowerCase());

function joinUrl(origin, pathname) {
  return `${String(origin).replace(/\/+$/, '')}/${String(pathname).replace(/^\/+/, '')}`;
}

/** nginx-stack.conf — 서버 수준 값과 services 디렉토리 위치. */
function loadStack(stackPath) {
  const { sections } = parseIni(fs.readFileSync(stackPath, 'utf8'));
  const general = sections.general || {};
  const tls = sections.tls || {};
  const base = path.dirname(path.resolve(stackPath));

  return {
    servicesDir: path.resolve(base, general.services_dir || '../services'),
    server: {
      serverName: general.server_name || '',
      listenPort: Number(general.listen_port) || null,
      sslPort: Number(general.ssl_port) || null,
      sslVerifyClient: tls.verify_client || 'off',
      mtls: Boolean(tls.client_ca && tls.verify_client),
      defaultRoute: general.default_route || '',
    },
  };
}

/** services/<서비스>/nginx-conf/*.ini 를 한 단계만 훑는다. */
function scan(servicesDir) {
  if (!fs.existsSync(servicesDir)) return [];

  const found = [];
  const entries = fs
    .readdirSync(servicesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const dir = path.join(servicesDir, entry.name, 'nginx-conf');
    if (!fs.existsSync(dir)) continue;

    for (const file of fs.readdirSync(dir).sort()) {
      if (file.endsWith('.ini')) found.push({ dirName: entry.name, file: path.join(dir, file) });
    }
  }
  return found;
}

/**
 * 선언을 읽어 서비스 하나당 항목 하나를 만든다.
 * 라우트가 여러 개면 order 가 가장 낮은 것을 대표 location 으로 쓴다
 * (대시보드 링크와 공개 경로 표시에 쓰인다).
 */
function loadRoutes(stackPath) {
  const { servicesDir, server } = loadStack(stackPath);
  const files = scan(servicesDir);

  const routes = [];
  let newest = 0;

  for (const { dirName, file } of files) {
    const stat = fs.statSync(file);
    if (stat.mtimeMs > newest) newest = stat.mtimeMs;

    const { sections, order } = parseIni(fs.readFileSync(file, 'utf8'));
    const service = sections.service;
    if (!service) continue;
    if (isFalse(service.enabled ?? 'true')) continue;

    const name = (service.name || dirName).trim();
    const host = (service.host || '127.0.0.1').trim();
    const protocol = (service.protocol || 'http').trim().toLowerCase();
    const healthPath = (service.health_path || '/health').trim();
    const ports = String(service.ports || '')
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);

    if (!ports.length) continue;

    const port = ports[0];
    const origin = `${protocol}://${host}:${port}`;
    const target = { protocol, host, port, origin };

    const declared = order
      .filter((s) => s === 'route' || s.startsWith('route:'))
      .map((s) => ({
        key: s.includes(':') ? s.split(':')[1] : s,
        location: (sections[s].location || '').trim(),
        proxyPath: (sections[s].proxy_path || '').trim(),
        websocket: isTrue(sections[s].websocket),
        order: Number(sections[s].order) || 100,
      }))
      .filter((r) => r.location);

    const primary = [...declared].sort((a, b) => a.order - b.order)[0] || null;

    routes.push({
      name,
      location: primary ? primary.location : '',
      // 예전 nginx.ini 의 proxy_pass 자리. 표시용으로만 쓴다.
      proxyPass: origin,
      websocket: declared.some((r) => r.websocket),
      healthPath,
      target,
      // 헬스 체크는 Nginx를 거치지 않고 백엔드에 직접 요청한다.
      healthUrl: joinUrl(origin, healthPath),
      // 외부에서 접근할 때의 경로 (참고용)
      publicPath: primary ? joinUrl(primary.location, healthPath) : null,
      // 부가 정보 — 여러 포트/여러 라우트를 선언한 서비스용
      ports,
      routes: declared,
      dashboardPath: (service.dashboard_path || '').trim() || null,
      declaredIn: file,
    });
  }

  return {
    server,
    routes,
    source: {
      path: path.join(servicesDir, '*', 'nginx-conf', '*.ini'),
      stackPath: path.resolve(stackPath),
      modifiedAt: newest ? new Date(newest).toISOString() : null,
    },
  };
}

module.exports = { parseIni, loadRoutes, loadStack };
