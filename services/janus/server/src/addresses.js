/**
 * 접속 주소 — 이 서비스 디렉터리가 **선언한** 입구들.
 *
 * 클라이언트를 짜는 사람이 가장 먼저 찾는 것이 "어디로 붙어야 하는가" 인데,
 * 그 답이 지금까지 nginx 선언 파일 안에만 있었습니다. 실제로 WebSocket 주소를
 * 찾지 못해 헤맨 일이 있었습니다. 화면에 그대로 꺼내 놓습니다.
 *
 * ── 어디서 읽는가 ───────────────────────────────────────────────────────
 *
 * `services/janus/nginx-conf/*.ini` 입니다. nginx 생성기가 읽는 **같은 파일**
 * 이라 화면과 실제 라우팅이 어긋나지 않습니다. 주소를 여기에 따로 적어 두면
 * 언젠가 반드시 어긋납니다.
 *
 * ⚠️ 선언이 곧 반영은 아닙니다. `sudo ./install_nginx_stack.sh --skip-install`
 *    을 아직 안 돌렸으면 화면의 주소는 아직 nginx 에 없습니다. 그래서 뒤에서
 *    **실제로 듣고 있는지**를 함께 확인합니다.
 *
 * 밖에서 쓸 주소의 오리진(https://호스트)은 브라우저가 붙입니다 — 이 대시보드가
 * 같은 nginx 뒤에 있으므로 브라우저가 아는 것이 가장 정확합니다.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const config = require('./config');

const SERVICE_DIR = path.resolve(__dirname, '../..');
const NGINX_CONF_DIR = path.join(SERVICE_DIR, 'nginx-conf');
const { parseIni, isTrue } = require(path.resolve(SERVICE_DIR, '../../lib/ini'));

/**
 * 라우트가 무엇에 쓰이는지. **라우팅 스키마에 화면용 문구를 넣지 않으려고**
 * 여기 둡니다 (docs/nginx-conf.md 는 라우팅만 다룹니다).
 */
const ROLE = {
  'janus/api': {
    label: '시그널링 (REST)',
    use: 'janus.js · 대시보드 시험 통화 · 헬스',
    note: '끝에 슬래시를 붙이지 마세요. POST /janus-api/ 는 301 이 되어 본문을 잃습니다.',
  },
  'janus/ws': {
    label: '시그널링 (WebSocket)',
    use: 'WebRTC 클라이언트',
    note: '서브프로토콜 janus-protocol 을 요청해야 합니다. janus.js 는 알아서 붙입니다.',
  },
  'janus-dashboard/main': {
    label: '관찰 대시보드',
    use: '지금 보고 있는 이 화면',
  },
};

function readDeclarations() {
  let files = [];
  try {
    files = fs.readdirSync(NGINX_CONF_DIR).filter((f) => f.endsWith('.ini')).sort();
  } catch {
    return [];
  }

  const out = [];
  for (const file of files) {
    let sections;
    try {
      ({ sections } = parseIni(fs.readFileSync(path.join(NGINX_CONF_DIR, file), 'utf8')));
    } catch {
      continue;
    }

    const service = sections.service;
    if (!service) continue;

    const name = (service.name || '').trim();
    const host = (service.host || '127.0.0.1').trim();
    const protocol = (service.protocol || 'http').trim();
    const ports = String(service.ports || '')
      .split(/[\s,]+/)
      .filter(Boolean);
    const enabled = service.enabled === undefined ? true : isTrue(service.enabled);

    for (const key of Object.keys(sections)) {
      if (key !== 'route' && !key.startsWith('route:')) continue;
      const route = sections[key];
      const routeKey = key.includes(':') ? key.split(':')[1] : 'main';
      const port = (route.port || '').trim() || ports[0] || '';

      out.push({
        service: name,
        key: routeKey,
        file: `nginx-conf/${file}`,
        enabled,
        location: (route.location || '').trim(),
        websocket: isTrue(route.websocket),
        host,
        port,
        protocol,
      });
    }
  }
  return out;
}

/** 그 포트가 실제로 듣고 있는가. 프로토콜은 묻지 않는다 — 연결만 본다. */
function listening(host, port, timeoutMs = 700) {
  return new Promise((resolve) => {
    if (!port) return resolve(false);

    const socket = net.connect({ host, port: Number(port) });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** 관리 API 는 nginx 선언이 없다 — 밖으로 내지 않기 때문이다. 따로 얹는다. */
function adminEntry() {
  let url;
  try {
    url = new URL(config.JANUS_ADMIN_BASE);
  } catch {
    return null;
  }
  return {
    service: 'janus',
    key: 'admin',
    label: 'Admin API',
    use: '이 대시보드가 세션·핸들을 읽는 곳',
    // 밖으로 열려 있지 않다는 말은 화면이 external: null 로 이미 한다. 겹쳐 적지 않는다.
    note: '',
    external: null,
    internal: config.JANUS_ADMIN_BASE,
    host: url.hostname,
    port: url.port || (url.protocol === 'https:' ? '443' : '80'),
    websocket: false,
    enabled: true,
    file: 'server/src/config.js',
  };
}

async function list() {
  const declared = readDeclarations().map((d) => {
    const role = ROLE[`${d.service}/${d.key}`] || {};
    const scheme = d.websocket ? 'ws' : d.protocol;

    return {
      ...d,
      label: role.label || `${d.service} (${d.key})`,
      use: role.use || '',
      note: role.note || '',
      // 밖에서 쓸 주소는 경로만 준다. 오리진은 브라우저가 붙인다.
      external: d.location ? { path: d.location, secure: d.websocket ? 'wss' : 'https' } : null,
      internal: d.port ? `${scheme}://${d.host}:${d.port}${d.websocket ? '' : d.location}` : null,
    };
  });

  const admin = adminEntry();
  const entries = admin ? [...declared, admin] : declared;

  // 선언이 곧 반영은 아니다. 실제로 듣고 있는지 함께 본다.
  await Promise.all(
    entries.map(async (e) => {
      e.listening = await listening(e.host, e.port);
    })
  );

  return {
    basePath: config.BASE_PATH,
    declaredIn: 'services/janus/nginx-conf/',
    entries,
  };
}

module.exports = { list };
