const fs = require('fs');
const path = require('path');

/**
 * services/<서비스>/nginx-conf/*.ini 파서.
 *
 * install_nginx_stack.sh(정확히는 generate_nginx_conf.py)가 읽는 파일과
 * 같은 파일을 읽는다. 라우팅의 진실 공급원이 하나이므로 대시보드가 보여주는
 * 내용과 실제 nginx 설정이 어긋날 수 없다.
 *
 * 스키마: WebServices/docs/nginx-conf.md
 */

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PROTOCOL = 'http';
const DEFAULT_HEALTH_PATH = '/health';
const DEFAULT_ORDER = 100;

/** '#'과 ';'로 시작하는 줄은 주석으로 처리한다. */
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
      sections[current][kvMatch[1].trim().toLowerCase()] = kvMatch[2].trim();
    }
  }

  return { sections, order };
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parsePorts(value) {
  return String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0 && n <= 65535);
}

/** generate_nginx_conf.py 의 upstream_name() 과 같은 규칙이어야 한다. */
function upstreamName(serviceName) {
  const slug = String(serviceName)
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  return `${slug}_backend`;
}

/**
 * location 지시자에서 사람이 읽을 경로만 뽑는다.
 *   '= /health'  -> /health
 *   '/face/'     -> /face/
 *   '~ ^/x/(a|b)$' -> ^/x/(a|b)$  (정규식은 그대로 둔다)
 */
function locationPath(spec) {
  const cleaned = String(spec).replace(/^[=~*^\s]+/, '').trim();
  return cleaned || String(spec);
}

/**
 * 서비스를 한 줄로 대표할 경로.
 *
 * 접두사 라우트만 본다 ('= /health' 나 정규식은 설명이 되지 않는다).
 * 접두사가 여럿이면 공통 부분을 쓴다 — /complex/admin/ 하나만 골라 보여주면
 * 나머지 라우트가 없는 것처럼 보이기 때문이다.
 *   /complex/admin/, /complex/client/, /complex/public/  ->  /complex/
 */
function primaryLocation(routes) {
  const prefixes = routes.map((r) => r.location).filter((l) => /^\//.test(l));

  if (prefixes.length === 0) return routes[0] ? locationPath(routes[0].location) : null;
  if (prefixes.length === 1) return prefixes[0];

  let common = prefixes[0];
  for (const candidate of prefixes.slice(1)) {
    let i = 0;
    while (i < common.length && i < candidate.length && common[i] === candidate[i]) i += 1;
    common = common.slice(0, i);
  }

  // 경로 중간에서 자르지 않도록 마지막 '/' 까지만 남긴다.
  const cut = common.lastIndexOf('/');
  return cut >= 0 ? common.slice(0, cut + 1) : common;
}

function readServiceFile(iniPath, directoryName) {
  const { sections, order } = parseIni(fs.readFileSync(iniPath, 'utf8'));

  const service = sections.service;
  if (!service) throw new Error('[service] 섹션이 없습니다');

  const name = (service.name || directoryName).trim();
  const ports = parsePorts(service.ports);
  if (ports.length === 0) throw new Error('[service] 에 ports 가 없습니다');

  const protocol = (service.protocol || DEFAULT_PROTOCOL).trim().toLowerCase();

  const routes = order
    .filter((key) => key === 'route' || key.startsWith('route:'))
    .map((key) => {
      const s = sections[key];
      return {
        key: key.includes(':') ? key.split(':', 2)[1] : key,
        location: (s.location || '').trim(),
        proxyPath: (s.proxy_path || '').trim(),
        websocket: parseBool(s.websocket),
        buffering: (s.buffering || 'on').trim().toLowerCase() !== 'off',
        order: Number(s.order) || DEFAULT_ORDER,
      };
    })
    .filter((r) => r.location)
    .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));

  return {
    name,
    directory: directoryName,
    host: (service.host || DEFAULT_HOST).trim(),
    ports,
    protocol,
    healthPath: (service.health_path || DEFAULT_HEALTH_PATH).trim(),
    dashboardPath: (service.dashboard_path || '').trim() || null,
    enabled: parseBool(service.enabled, true),
    upstream: upstreamName(name),
    routes,
    location: primaryLocation(routes),
    locations: routes.map((r) => locationPath(r.location)),
    websocket: routes.some((r) => r.websocket),
    source: iniPath,
  };
}

/**
 * servicesDir 아래의 모든 nginx-conf/*.ini 를 읽는다.
 * 파일 하나가 잘못돼도 나머지는 보여줘야 하므로, 실패는 errors 로 모아 돌려준다.
 * (생성기는 같은 상황에서 멈추지만, 대시보드는 그 사실을 화면에 드러내는 게 낫다)
 */
function loadDeclarations(servicesDir) {
  const services = [];
  const errors = [];

  let entries;
  try {
    entries = fs.readdirSync(servicesDir, { withFileTypes: true });
  } catch (err) {
    return { services, errors: [{ path: servicesDir, message: err.message }], scannedAt: new Date().toISOString() };
  }

  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const confDir = path.join(servicesDir, entry.name, 'nginx-conf');

    let files;
    try {
      files = fs.readdirSync(confDir).filter((f) => f.endsWith('.ini')).sort();
    } catch {
      // nginx-conf/ 가 없는 디렉토리는 그냥 서비스가 아니다. 조용히 넘어간다.
      continue;
    }

    for (const file of files) {
      const iniPath = path.join(confDir, file);
      try {
        const service = readServiceFile(iniPath, entry.name);
        if (service.enabled) services.push(service);
      } catch (err) {
        errors.push({ path: iniPath, message: err.message });
      }
    }
  }

  return { services, errors, scannedAt: new Date().toISOString() };
}

/**
 * nginx-stack.conf 의 서버 수준 설정.
 * 라우트는 여기 없다 — 리스닝 포트와 TLS 정보만 들어 있다.
 * 읽지 못해도 대시보드는 떠야 하므로 기본값으로 넘어간다.
 */
function loadServerConfig(stackConfPath) {
  const fallback = {
    serverName: '_',
    listenPort: 80,
    sslPort: 443,
    sslVerifyClient: 'off',
    mtls: false,
    certDir: null,
    source: stackConfPath,
    readable: false,
  };

  let text;
  try {
    text = fs.readFileSync(stackConfPath, 'utf8');
  } catch {
    return fallback;
  }

  const { sections } = parseIni(text);
  const general = sections.general || {};
  const tls = sections.tls || {};

  return {
    // 템플릿이 server_name 을 와일드카드로 두므로 고정값이다.
    serverName: '_',
    listenPort: Number(general.listen_port) || 80,
    sslPort: Number(general.ssl_port) || 443,
    sslVerifyClient: general.ssl_verify_client || 'off',
    mtls: Boolean(general.ssl_verify_client && general.ssl_verify_client !== 'off'),
    certDir: tls.cert_dir || null,
    source: stackConfPath,
    readable: true,
  };
}

module.exports = {
  parseIni,
  parsePorts,
  upstreamName,
  locationPath,
  loadDeclarations,
  loadServerConfig,
};
