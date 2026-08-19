const http = require('http');

const SERVICE_NAME = 'route-b';
const port = process.env.PORT || 28081;
const startedAt = Date.now();

// Nginx가 URI를 그대로 전달하므로(/route-b/...) 접두사를 제거한 뒤 라우팅한다.
const BASE_PATH = process.env.BASE_PATH || '/route-b';

function normalize(url) {
  const path = (url || '/').split('?')[0];
  if (path === BASE_PATH) return '/';
  if (path.startsWith(BASE_PATH + '/')) return path.slice(BASE_PATH.length) || '/';
  return path;
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const path = normalize(req.url);

  // 모든 서비스가 반드시 제공해야 하는 상태 확인 엔드포인트
  if (path === '/health' || path === '/health/') {
    return json(res, 200, {
      service: SERVICE_NAME,
      status: 'ok',
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      pid: process.pid,
      timestamp: new Date().toISOString(),
      details: {
        memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
    });
  }

  if (path === '/' ) {
    return json(res, 200, { service: SERVICE_NAME, status: 'ok' });
  }

  json(res, 404, { service: SERVICE_NAME, error: 'not_found', path });
});

server.listen(port, () => {
  console.log(`${SERVICE_NAME} listening on port ${port}`);
});
