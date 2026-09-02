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

// 파서는 저장소 공용이다 — 같은 선언 파일을 janus 대시보드도 읽는다.
const { parseIni, isTrue, isFalse } = require(require('path').resolve(__dirname, '../../../../lib/ini'));

function joinUrl(origin, pathname) {
  return `${String(origin).replace(/\/+$/, '')}/${String(pathname).replace(/^\/+/, '')}`;
}

/**
 * nginx location 지시자를 연산자와 경로로 나눈다.
 *   "= /relay/rtc"  → { modifier: '=',  pattern: '/relay/rtc' }
 *   "/relay/"       → { modifier: '',   pattern: '/relay/' }
 */
function splitLocation(location) {
  const m = String(location || '').trim().match(/^(\^~|~\*|~|=)?\s*(.*)$/);
  return { modifier: (m && m[1]) || '', pattern: ((m && m[2]) || '').trim() };
}

/**
 * 이 라우트를 **공개 기준 경로**로 쓸 수 있는가.
 *
 * 대시보드 링크와 공개 경로 표시는 "여기에 하위 경로를 붙이면 열린다" 를 전제한다.
 * 그런 자격이 없는 라우트가 있다.
 *
 *   =        정확 일치라 하위 경로가 붙지 않는다
 *   ~ ~*     정규식이라 경로를 만들 수 없다
 *   websocket  ws 전용 입구다. 브라우저로 여는 곳이 아니다
 *
 * 예전에는 order 가 가장 낮은 라우트를 그냥 대표로 삼았다. order 는 nginx 에
 * 생성되는 **순서**를 정하는 값이지 공개 입구를 고르는 값이 아니어서,
 * `= /relay/rtc`(order 10) 같은 WebSocket 전용 라우트가 대표가 되고
 * 대시보드 링크가 `= /relay/rtc/dashboard` 라는 열리지 않는 문자열이 됐다.
 */
function isBrowsableBase(route) {
  if (route.websocket) return false;
  const { modifier, pattern } = splitLocation(route.location);
  if (modifier === '=' || modifier === '~' || modifier === '~*') return false;
  return pattern.startsWith('/');
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

    // 하위 경로가 붙을 수 있는 것들 중 **가장 일반적인(짧은) 접두사**를 고른다.
    // 나머지 경로가 전부 그 아래 걸리기 때문이다. 같으면 order 가 낮은 쪽.
    const primary = declared
      .filter(isBrowsableBase)
      .sort((a, b) =>
        splitLocation(a.location).pattern.length - splitLocation(b.location).pattern.length ||
        a.order - b.order)[0] || null;
    // 연산자를 뗀 순수 경로. 링크와 표시에 쓰는 값이므로 지시자 문자열을 그대로
    // 쓰면 안 된다. 원본 지시자는 아래 routes[] 에 그대로 남는다.
    const primaryPath = primary ? splitLocation(primary.location).pattern : null;

    routes.push({
      name,
      location: primaryPath || '',
      // 예전 nginx.ini 의 proxy_pass 자리. 표시용으로만 쓴다.
      proxyPass: origin,
      websocket: declared.some((r) => r.websocket),
      healthPath,
      target,
      // 헬스 체크는 Nginx를 거치지 않고 백엔드에 직접 요청한다.
      healthUrl: joinUrl(origin, healthPath),
      // 외부에서 접근할 때의 경로 (참고용)
      publicPath: primaryPath ? joinUrl(primaryPath, healthPath) : null,
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
