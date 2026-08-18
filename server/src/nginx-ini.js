const fs = require('fs');

/**
 * nginx.ini 파서.
 * setup_nginx.sh와 동일한 파일을 읽어 대시보드가 라우트 목록을 그대로 사용한다.
 * '#'과 ';'로 시작하는 줄은 주석으로 처리한다.
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

function parseProxyPass(proxyPass) {
  try {
    const url = new URL(proxyPass);
    return {
      protocol: url.protocol.replace(':', ''),
      host: url.hostname,
      port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
      origin: url.origin,
    };
  } catch {
    return null;
  }
}

function joinUrl(origin, pathname) {
  return `${origin.replace(/\/+$/, '')}/${String(pathname).replace(/^\/+/, '')}`;
}

/**
 * nginx.ini를 읽어 서버 설정과 라우트 목록을 반환한다.
 * 라우트 섹션에 health_path를 지정하면 기본값(/health) 대신 사용한다.
 */
function loadRoutes(iniPath) {
  const text = fs.readFileSync(iniPath, 'utf8');
  const { sections, order } = parseIni(text);
  const stat = fs.statSync(iniPath);

  const server = sections.server || {};

  const routes = order
    .filter((name) => name !== 'server')
    .map((name) => {
      const s = sections[name];
      const target = parseProxyPass(s.proxy_pass || '');
      const healthPath = s.health_path || '/health';

      return {
        name,
        location: s.location || '',
        proxyPass: s.proxy_pass || '',
        websocket: String(s.websocket).toLowerCase() === 'true',
        healthPath,
        target,
        // 헬스 체크는 Nginx를 거치지 않고 백엔드에 직접 요청한다.
        healthUrl: target ? joinUrl(target.origin, healthPath) : null,
        // 외부에서 접근할 때의 경로 (참고용)
        publicPath: s.location ? joinUrl(s.location, healthPath) : null,
      };
    });

  return {
    server: {
      serverName: server.server_name || '',
      listenPort: Number(server.listen_port) || null,
      sslPort: Number(server.ssl_port) || null,
      sslVerifyClient: server.ssl_verify_client || 'off',
      mtls: Boolean(server.ssl_client_ca && server.ssl_verify_client),
    },
    routes,
    source: {
      path: iniPath,
      modifiedAt: stat.mtime.toISOString(),
    },
  };
}

module.exports = { parseIni, parseProxyPass, loadRoutes };
