const path = require('path');
const config = require('../config');
const log = require('../logger');
const { loadRoutes } = require('../nginx-conf');

// settings.ini/settings-schema.json 을 읽는 공용 구현. Kamailio·Janus·coturn
// 이 배포 마법사·자기 대시보드와 함께 쓰는 바로 그 모듈이다 (lib/settings.js).
// 여기서 새로 파싱하지 않는 이유는 docs/settings-contract.md 와 같다 —
// 스키마를 두 번 구현하면 언젠가 갈라진다.
const settingsLib = require(path.join(config.repoRoot, 'lib', 'settings'));

/**
 * 이 파일이 "훑어서" 얻을 수 없는 사실들 — 값이 아니라 **뜻**이다.
 *   - 이 포트가 무슨 역할인지
 *   - settings.ini 의 어느 키에서 값을 읽는지 (RTP 대역만 해당 — 나머지는
 *     프로토콜 표준이거나 이 저장소가 소유하지 않는 값이라 고정이다)
 *   - 공유기 포워딩이 필요한지
 * 왜 필요한지는 docs/port-map.md 에 있다. 숫자만 매번 다시 읽고, 이 표는
 * 그대로 둔다.
 */
const SERVICES_DIR = path.join(config.repoRoot, 'services');

function settingsValue(serviceDirName, key) {
  try {
    const st = settingsLib.state(path.join(SERVICES_DIR, serviceDirName));
    return st.values[key] ?? null;
  } catch (err) {
    log.warn(`port-map: ${serviceDirName}/settings-schema.json 을 읽지 못했습니다 (${err.message})`);
    return null;
  }
}

// rtpproxy 는 이 저장소가 소유하지 않는다 — 배포판 기본 설정을 그대로 둔다
// (services/kamailio/install.sh 의 "미디어 릴레이는 이 장비에 있는 것을
// 쓴다" 원칙). media_port_range 는 그래서 실제 적용값이 아니라 **겹침 검사가
// 보는 기준값**이다. rtpengine 이 돌고 있으면 이 값이 실제로 반영된다
// (install.sh --apply 가 rtpengine.conf 의 port-min/max 를 다시 쓴다).
function rtpRows() {
  return [
    {
      role: 'SIP 트렁크 미디어 (rtpproxy/rtpengine)',
      service: 'kamailio',
      settingKey: 'media_port_range',
      value: settingsValue('kamailio', 'media_port_range'),
      protocol: 'UDP',
      forwarded: false,
      note: 'rtpproxy 라면 값은 참고용 — 실제 설정은 /etc/default/rtpproxy 가 가진다 (docs/port-map.md §5).',
    },
    {
      role: 'Janus WebRTC (브라우저·모바일 앱)',
      service: 'janus',
      settingKey: 'rtp_port_range',
      value: settingsValue('janus', 'rtp_port_range'),
      protocol: 'UDP',
      forwarded: true,
    },
    {
      role: 'Janus ↔ Kamailio(SIP) 브리지',
      service: 'janus',
      settingKey: 'sip_rtp_port_range',
      value: settingsValue('janus', 'sip_rtp_port_range'),
      protocol: 'UDP',
      forwarded: false,
    },
    {
      role: 'coturn TURN 릴레이 (셀룰러 모바일)',
      service: 'coturn',
      settingKey: 'relay_port_range',
      value: settingsValue('coturn', 'relay_port_range'),
      protocol: 'UDP',
      forwarded: true,
    },
  ];
}

// 표준(5060·80·443)이거나 이 저장소가 손대지 않는 루프백 컨트롤 소켓이라
// 대부분 고정값이다. coturn 수신 포트만 settings.ini 값이다.
function controlRows() {
  return [
    { name: 'Kamailio SIP', value: '5060', protocol: 'UDP+TCP', forwarded: false, note: 'LAN 주소로만 수신. 외부 모바일은 Janus(WebRTC)를 거친다.' },
    { name: 'Kamailio WS 트랜스포트', value: '5080', protocol: 'TCP', forwarded: false, note: 'nginx가 TLS 종료 후 /sip/ 로 프록시 — 내부 HTTP 포트 표 참고.' },
    { name: 'rtpproxy 컨트롤 소켓', value: '7722', protocol: 'UDP (127.0.0.1)', forwarded: false },
    { name: 'rtpengine 컨트롤 소켓', value: '2223', protocol: 'UDP (127.0.0.1)', forwarded: false, note: '지금은 비활성 (WITH_RTPENGINE 꺼짐).' },
    { name: 'Janus HTTP/REST API', value: '8088', protocol: 'TCP', forwarded: false, note: 'nginx가 /janus-api 로 프록시 — 내부 HTTP 포트 표 참고.' },
    { name: 'Janus Admin API', value: '7088', protocol: 'TCP (127.0.0.1)', forwarded: false, note: '루프백 전용 — nginx 선언에 두면 안 된다.' },
    {
      name: 'coturn STUN/TURN 수신',
      value: settingsValue('coturn', 'listening_port'),
      settingKey: 'listening_port',
      service: 'coturn',
      protocol: 'UDP+TCP',
      forwarded: true,
    },
  ];
}

function internalHttpRows() {
  const { routes } = loadRoutes(config.nginxStackPath);
  return routes
    .map((r) => ({ name: r.name, ports: r.ports, location: r.location || null }))
    .sort((a, b) => (a.ports[0] || 0) - (b.ports[0] || 0));
}

// 공유기에서 열어야 하는 것만 뽑는다 — "포워딩 확인할 때" 화면이 바로 이걸
// 보여줘야 한다. 80/443 은 어느 settings.ini 에도 없는 값이라 고정으로 둔다
// (nginx/nginx-stack.conf 의 public_http_port/public_https_port 는 표준 포트를
// 그대로 넘기는 지금 배치에서는 비어 있는 것이 정상 — docs/port-map.md §4).
function forwardingChecklist(rtp, control) {
  const rows = [
    { protocol: 'TCP', port: '80', purpose: 'HTTP (Let\'s Encrypt 갱신·리다이렉트)' },
    { protocol: 'TCP', port: '443', purpose: 'HTTPS — 모든 웹/대시보드/API' },
  ];
  for (const r of [...rtp, ...control]) {
    if (!r.forwarded || !r.value) continue;
    rows.push({ protocol: r.protocol, port: r.value, purpose: r.role || r.name });
  }
  return rows;
}

function build() {
  const rtp = rtpRows();
  const control = controlRows();
  return {
    rtp,
    control,
    internalHttp: internalHttpRows(),
    forwardingChecklist: forwardingChecklist(rtp, control),
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { build };
