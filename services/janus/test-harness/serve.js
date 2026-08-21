/**
 * 시험 통화 하니스의 로컬 서버. verify-call.sh 가 띄운다.
 *
 * 왜 대시보드의 /janus/dashboard/test-call 을 그대로 쓰지 않는가 —
 * 그 페이지는 manager 로그인 세션을 요구한다. 자동으로 돌리려면 사람의
 * 비밀번호를 다뤄야 하므로, 같은 janus.js 로직을 헤드리스 크롬에서 직접 돌린다.
 *
 * 이 서버가 하는 일 다섯:
 *
 *   /             test.html
 *   /janus.js     Janus 가 설치한 라이브러리 그대로. 번들에 넣지 않는 이유는
 *                 setup-dashboard.sh 와 같다 — 버전이 어긋나면 조용히 실패한다
 *   /adapter.js   webrtc-adapter (janus.js 가 전역 adapter 를 요구한다)
 *   /janus-api*   → 127.0.0.1:8088 프록시. **같은 오리진**이라 CORS 가 없다
 *   /log /result  브라우저가 보내는 진행 로그와 최종 판정
 *
 * api_secret 과 SIP 비밀번호는 /config 응답으로만 나간다. argv 에도 페이지
 * 소스에도 박히지 않는다.
 *
 * 환경변수 (verify-call.sh 가 넣는다):
 *   HARNESS_PORT   이 서버가 들을 포트
 *   HARNESS_RUNDIR accounts.json 을 읽고 result.json 을 쓸 디렉토리
 *   HARNESS_OUTDIR result.json · browser.log 를 남길 디렉토리
 *   JANUS_HTTP_PORT  Janus HTTP 트랜스포트 포트 (기본 8088)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const SERVICE_DIR = path.resolve(HERE, '..');
const JANUS_JS = process.env.JANUS_JS_PATH || '/opt/janus/share/janus/javascript/janus.js';
const ADAPTER_JS = path.join(SERVICE_DIR, 'web/node_modules/webrtc-adapter/out/adapter.js');

const PORT = parseInt(process.env.HARNESS_PORT, 10) || 28199;
const RUNDIR = process.env.HARNESS_RUNDIR || HERE;
const OUTDIR = process.env.HARNESS_OUTDIR || path.join(HERE, 'last-run');
const JANUS_HOST = '127.0.0.1';
const JANUS_PORT = parseInt(process.env.JANUS_HTTP_PORT, 10) || 8088;
/** 브라우저가 아무 결과도 보내지 않을 때 하니스가 영원히 남지 않게 한다. */
const HARD_TIMEOUT_MS = parseInt(process.env.HARNESS_TIMEOUT_MS, 10) || 150000;

const cfg = JSON.parse(fs.readFileSync(path.join(RUNDIR, 'accounts.json'), 'utf8'));

fs.mkdirSync(OUTDIR, { recursive: true });

const log = [];
let finished = false;

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => resolve(buf));
  });
}

function writeOutputs(resultJson) {
  if (resultJson !== null) fs.writeFileSync(path.join(OUTDIR, 'result.json'), resultJson);
  fs.writeFileSync(path.join(OUTDIR, 'browser.log'), log.join('\n') + '\n');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  /*
   * Janus 시그널링 프록시.
   *
   * janus.js 는 server + "/" + sessionId 로 주소를 만들므로 경로를 손대지
   * 않고 그대로 넘긴다. 끝 슬래시를 붙이면 // 가 되어 세션 생성이 깨진다
   * (3단계에서 nginx 쪽으로 같은 문제를 겪었다).
   */
  if (url.pathname === '/janus-api' || url.pathname.startsWith('/janus-api/')) {
    const body = await readBody(req);
    const up = http.request({
      host: JANUS_HOST, port: JANUS_PORT, path: url.pathname + url.search,
      method: req.method, headers: { 'Content-Type': 'application/json' },
    }, (ur) => {
      res.writeHead(ur.statusCode, { 'Content-Type': 'application/json' });
      ur.pipe(res);
    });
    up.on('error', (e) => send(res, 502, 'application/json', JSON.stringify({ error: e.message })));
    if (body) up.write(body);
    up.end();
    return;
  }

  if (url.pathname === '/janus.js') return send(res, 200, 'application/javascript', fs.readFileSync(JANUS_JS));
  if (url.pathname === '/adapter.js') return send(res, 200, 'application/javascript', fs.readFileSync(ADAPTER_JS));
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(HERE, 'test.html')));
  }
  if (url.pathname === '/config') return send(res, 200, 'application/json', JSON.stringify(cfg));

  if (url.pathname === '/log' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const e = JSON.parse(body);
      const line = `[${String(e.t).padStart(6)}ms] ${e.who ?? '--'} ${e.level ?? 'info'}: ${e.msg}`;
      log.push(line);
      console.log(line);
    } catch { /* 로그 한 줄이 깨져도 시험은 계속한다 */ }
    return send(res, 204, 'text/plain', '');
  }

  if (url.pathname === '/result' && req.method === 'POST') {
    const body = await readBody(req);
    send(res, 204, 'text/plain', '');
    if (finished) return;
    finished = true;
    writeOutputs(body);
    let ok = false;
    try { ok = JSON.parse(body).ok === true; } catch { /* 판정 불가 = 실패 */ }
    console.log('=== RESULT ===');
    console.log(body);
    // 응답이 나갈 틈을 준 뒤 종료 코드로 판정을 알린다.
    setTimeout(() => { server.close(); process.exit(ok ? 0 : 1); }, 200);
    return;
  }

  send(res, 404, 'text/plain', 'not found');
});

server.listen(PORT, '127.0.0.1', () => console.log(`하니스: http://127.0.0.1:${PORT}`));

setTimeout(() => {
  if (finished) return;
  console.log('=== TIMEOUT — 브라우저가 결과를 보내지 않았습니다 ===');
  writeOutputs(null);
  process.exit(2);
}, HARD_TIMEOUT_MS);
