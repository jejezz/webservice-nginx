/**
 * 최소 SIP 단말 — 평문 SIP/UDP + 평문 RTP(G.711). WebRTC 를 전혀 쓰지 않는다.
 *
 * 6단계가 검증하려는 것이 정확히 이것이다. 브라우저 ↔ 브라우저(5단계)는 양쪽이
 * 다 크롬이라 opus 로 붙어서, Janus 가 WebRTC 를 평문 RTP 로 바꾸는 부분과
 * ⑥의 PCMU/PCMA 교집합이 한 번도 시험되지 않았다.
 *
 * baresip 을 쓰지 않는 이유는 설치에 sudo 가 필요해서이기도 하지만, 이쪽이
 * **협상 결과와 패킷 수를 프로그램으로 단언**할 수 있기 때문이다. 사람이 귀로
 * 듣는 대신 payload type 과 inbound 패킷 수를 센다.
 *
 *   node sipua.js --user 9999999904 --pw-file <경로> --domain pluto.org \
 *                 --proxy 192.168.0.252:5060 --mode answer --duration 8
 *
 * --mode answer : 등록하고 걸려 오는 전화를 받는다
 * --mode call   : 등록하고 --peer 에게 건다
 *
 * 끝나면 판정을 JSON 한 줄로 stdout 에 낸다.
 */
const dgram = require('dgram');
const crypto = require('crypto');
const fs = require('fs');

// ── 인자 ────────────────────────────────────────────────────────────────
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const USER = arg('user', '9999999904');
const DOMAIN = arg('domain', 'pluto.org');
const [PROXY_HOST, PROXY_PORT] = arg('proxy', '192.168.0.252:5060').split(':');
const SECRET = fs.readFileSync(arg('pw-file'), 'utf8').trim();
const MODE = arg('mode', 'answer');
const PEER = arg('peer', '9999999901');
const DURATION = parseInt(arg('duration', '8'), 10);
/*
 * 통화가 걸려 오기를 기다리는 시간. DURATION 과 반드시 나눠야 한다.
 * 헤드리스 크롬은 뜨고 등록해서 발신하기까지 30초 넘게 걸리는 일이 흔한데,
 * 안전장치를 DURATION 기준으로 잡았더니 통화 2초 만에 스스로 끊어 버렸다.
 */
const WAIT = parseInt(arg('wait', '120'), 10);
const LOCAL_IP = arg('local-ip', '192.168.0.252');
const SIP_PORT = parseInt(arg('sip-port', '45060'), 10);
const RTP_PORT = parseInt(arg('rtp-port', '40100'), 10);
/*
 * 영상 m-line 을 함께 낸다 (7단계 진단용).
 *
 * 실단말(인터폰·안드로이드)은 음성과 영상을 함께 제시하는데, m-line 이 둘일 때
 * 음성만 죽는 일이 있다. 그것이 상대 단말의 문제인지 이 경로의 문제인지 가르려면
 * **통제 가능한 상대**로 같은 모양을 만들어 봐야 한다. 영상 RTP 를 실제로 보내지는
 * 않고, 받은 것만 센다 — 관심사는 어디까지나 음성이 함께 흐르는가이다.
 */
const WITH_VIDEO = process.argv.includes('--with-video');
const VIDEO_RTP_PORT = parseInt(arg('video-rtp-port', String(RTP_PORT + 2)), 10);
/** 이 단말이 제시하는 코덱. **평문 G.711 만** 낸다 — 그것이 이 시험의 요점이다. */
const OFFER_CODECS = [
  { pt: 0, name: 'PCMU/8000' },
  { pt: 8, name: 'PCMA/8000' },
];

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
const rnd = (n = 8) => crypto.randomBytes(n).toString('hex');
const T0 = Date.now();
const log = (...a) => console.error(`[ua +${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
process.on('uncaughtException', (e) => { log('!! uncaughtException:', e.stack || e.message); });
process.on('unhandledRejection', (e) => { log('!! unhandledRejection:', (e && e.stack) || e); });

const state = {
  registered: false,
  callEstablished: false,
  negotiatedPt: null,
  negotiatedName: null,
  remoteRtp: null,
  rtpIn: 0,
  rtpOut: 0,
  rtpInPts: new Set(),
  error: null,
  hangupReason: null,
};

// ── SIP 소켓 ────────────────────────────────────────────────────────────
const sip = dgram.createSocket('udp4');
const rtp = dgram.createSocket('udp4');

const callId = rnd(12);
const fromTag = rnd(6);
let cseq = 1;
let toTag = null;          // 상대가 정해 준다
let dialogRemoteUri = null;
let lastInvite = null;     // 착신 INVITE (ACK 대조용)
let authHeaderFor = null;  // 재전송할 때 붙일 Authorization

function via(branch) {
  return `Via: SIP/2.0/UDP ${LOCAL_IP}:${SIP_PORT};branch=z9hG4bK${branch};rport`;
}

function contact() {
  return `Contact: <sip:${USER}@${LOCAL_IP}:${SIP_PORT}>`;
}

function send(msg, host = PROXY_HOST, port = parseInt(PROXY_PORT, 10)) {
  sip.send(Buffer.from(msg, 'utf8'), port, host);
}

/** WWW-Authenticate / Proxy-Authenticate 를 풀어 Authorization 을 만든다. */
function buildAuth(headerValue, method, uri, headerName) {
  const get = (k) => {
    const m = headerValue.match(new RegExp(`${k}="?([^",]+)"?`));
    return m ? m[1] : null;
  };
  const realm = get('realm');
  const nonce = get('nonce');
  const qop = get('qop');
  const opaque = get('opaque');
  const ha1 = md5(`${USER}:${realm}:${SECRET}`);
  const ha2 = md5(`${method}:${uri}`);

  let response;
  let extra = '';
  if (qop && qop.includes('auth')) {
    const nc = '00000001';
    const cnonce = rnd(4);
    response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`);
    extra = `, qop=auth, nc=${nc}, cnonce="${cnonce}"`;
  } else {
    response = md5(`${ha1}:${nonce}:${ha2}`);
  }
  const name = headerName === 'Proxy-Authenticate' ? 'Proxy-Authorization' : 'Authorization';
  return `${name}: Digest username="${USER}", realm="${realm}", nonce="${nonce}", `
       + `uri="${uri}", response="${response}"${opaque ? `, opaque="${opaque}"` : ''}${extra}`;
}

// ── SDP ─────────────────────────────────────────────────────────────────
function makeSdp(ptList) {
  const pts = ptList.map((c) => c.pt).join(' ');
  const maps = ptList.map((c) => `a=rtpmap:${c.pt} ${c.name}`).join('\r\n');
  return [
    'v=0',
    `o=- ${Date.now()} 1 IN IP4 ${LOCAL_IP}`,
    's=-',
    `c=IN IP4 ${LOCAL_IP}`,
    't=0 0',
    `m=audio ${RTP_PORT} RTP/AVP ${pts}`,
    maps,
    'a=sendrecv',
    'a=ptime:20',
    ...(WITH_VIDEO ? [
      `m=video ${VIDEO_RTP_PORT} RTP/AVP 103`,
      `c=IN IP4 ${LOCAL_IP}`,
      'a=rtpmap:103 H264/90000',
      'a=fmtp:103 profile-level-id=42001e; packetization-mode=1',
      'a=rtcp-fb:103 nack pli',
      'a=sendrecv',
    ] : []),
    '',                 // 마지막 줄도 CRLF 로 끝나야 한다 (RFC 4566)
  ].join('\r\n');
}

/** 상대 SDP 에서 미디어 주소·포트와 공통 코덱을 고른다. */
function parseSdp(body) {
  const cLine = body.match(/^c=IN IP4 ([\d.]+)/m);
  const mLine = body.match(/^m=audio (\d+) RTP\/A?V?P?F? ?([\d ]*)/m);
  if (!cLine || !mLine) return null;
  const offered = mLine[2].trim().split(/\s+/).filter(Boolean).map(Number);
  // 우리가 낼 수 있는 것 중 상대가 제시한 첫 번째를 고른다.
  const chosen = OFFER_CODECS.find((c) => offered.includes(c.pt));
  return {
    host: cLine[1],
    port: parseInt(mLine[1], 10),
    offered,
    chosen: chosen || null,
  };
}

// ── RTP ─────────────────────────────────────────────────────────────────
function linearToUlaw(sample) {
  const BIAS = 0x84, CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let m = 0x4000; (sample & m) === 0 && exponent > 0; exponent--, m >>= 1) { /* 탐색 */ }
  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  return (~(sign | (exponent << 4) | mantissa)) & 0xFF;
}
function linearToAlaw(sample) {
  const CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  let exponent = 7;
  for (let m = 0x4000; (sample & m) === 0 && exponent > 0; exponent--, m >>= 1) { /* 탐색 */ }
  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  let a = (exponent << 4) | mantissa;
  if (exponent === 0) a = (sample >> 4) & 0x0F;
  return (a ^ 0x55 ^ (sign ? 0 : 0x80)) & 0xFF;
}

let rtpTimer = null;
let seq = Math.floor(Math.random() * 30000);
let ts = 0;
const ssrc = crypto.randomBytes(4).readUInt32BE(0);

function startRtp() {
  if (rtpTimer || !state.remoteRtp || state.negotiatedPt === null) return;
  const encode = state.negotiatedPt === 8 ? linearToAlaw : linearToUlaw;
  let phase = 0;
  log(`RTP 시작 → ${state.remoteRtp.host}:${state.remoteRtp.port} pt=${state.negotiatedPt}`);
  rtpTimer = setInterval(() => {
   try {
    const payload = Buffer.alloc(160);
    for (let i = 0; i < 160; i++) {
      // 440Hz 톤 — 크롬의 가짜 장치와 같은 주파수라 로그에서 헷갈리지 않는다.
      const s = Math.round(Math.sin(phase) * 8000);
      phase += (2 * Math.PI * 440) / 8000;
      payload[i] = encode(s);
    }
    const header = Buffer.alloc(12);
    header[0] = 0x80;
    header[1] = state.negotiatedPt & 0x7F;
    header.writeUInt16BE(seq++ & 0xFFFF, 2);
    header.writeUInt32BE(ts, 4);
    header.writeUInt32BE(ssrc, 8);
    ts = (ts + 160) >>> 0;
    rtp.send(Buffer.concat([header, payload]), state.remoteRtp.port, state.remoteRtp.host, (err) => {
      if (err) { state.sendErrors = (state.sendErrors || 0) + 1; state.lastSendError = `${err.code || ''} ${err.message}`; }
    });
    state.rtpOut++;
   } catch (e) { log('RTP 루프 예외:', e.message); }
  }, 20);
}

function stopRtp() {
  if (rtpTimer) { clearInterval(rtpTimer); rtpTimer = null; }
}

const vrtp = WITH_VIDEO ? dgram.createSocket('udp4') : null;
if (vrtp) {
  vrtp.on('error', (e) => log(`영상 RTP 소켓 오류: ${e.code || ''} ${e.message}`));
  vrtp.on('message', (m) => { if (m.length >= 12) { state.videoIn = (state.videoIn || 0) + 1; state.videoInPts = state.videoInPts || new Set(); state.videoInPts.add(m[1] & 0x7F); } });
  vrtp.bind(VIDEO_RTP_PORT, LOCAL_IP, () => log(`영상 RTP 대기 ${LOCAL_IP}:${VIDEO_RTP_PORT}`));
}

rtp.on('error', (e) => log(`RTP 소켓 오류: ${e.code || ''} ${e.message}`));
sip.on('error', (e) => log(`SIP 소켓 오류: ${e.code || ''} ${e.message}`));

rtp.on('message', (msg) => {
  if (msg.length < 12) return;
  state.rtpIn++;
  state.rtpInPts.add(msg[1] & 0x7F);
});

// ── SIP 처리 ────────────────────────────────────────────────────────────
function headerOf(msg, name) {
  const m = msg.match(new RegExp(`^${name}\\s*:\\s*(.*)$`, 'im'));
  return m ? m[1].trim() : null;
}
/**
 * 같은 이름의 헤더를 **나온 순서 그대로** 모두 돌려준다.
 *
 * 응답에는 요청의 Via 를 전부, 순서를 바꾸지 않고 되돌려야 한다. Kamailio 가
 * 자기 Via 를 앞에 얹으므로 우리에게 온 INVITE 에는 Via 가 둘 이상이고,
 * 하나만 되돌리면 응답이 발신자까지 못 돌아간다 (여기서 실제로 막혔다).
 * Record-Route 도 같은 이유로 그대로 돌려줘야 이후 ACK·BYE 가 길을 찾는다.
 */
function headersAll(msg, name) {
  const out = [];
  const re = new RegExp(`^${name}\\s*:\\s*(.*)$`, 'gim');
  let m;
  while ((m = re.exec(msg)) !== null) out.push(m[1].trim());
  return out;
}
function bodyOf(msg) {
  const i = msg.indexOf('\r\n\r\n');
  return i < 0 ? '' : msg.slice(i + 4);
}

function sendRegister(authLine) {
  const uri = `sip:${DOMAIN}`;
  const msg = [
    `REGISTER ${uri} SIP/2.0`,
    via(rnd(6)),
    'Max-Forwards: 70',
    `From: <sip:${USER}@${DOMAIN}>;tag=${fromTag}`,
    `To: <sip:${USER}@${DOMAIN}>`,
    `Call-ID: ${callId}`,
    `CSeq: ${cseq} REGISTER`,
    contact(),
    'Expires: 300',
    'User-Agent: webservices-sipua/1.0',
    ...(authLine ? [authLine] : []),
    'Content-Length: 0', '', '',
  ].join('\r\n');
  send(msg);
}

function sendInvite(authLine) {
  const uri = `sip:${PEER}@${DOMAIN}`;
  inviteBranch = rnd(6);
  const sdp = makeSdp(OFFER_CODECS);
  const msg = [
    `INVITE ${uri} SIP/2.0`,
    via(inviteBranch),
    'Max-Forwards: 70',
    `From: <sip:${USER}@${DOMAIN}>;tag=${fromTag}`,
    `To: <sip:${PEER}@${DOMAIN}>`,
    `Call-ID: ${callId}`,
    `CSeq: ${cseq} INVITE`,
    contact(),
    'User-Agent: webservices-sipua/1.0',
    ...(authLine ? [authLine] : []),
    'Content-Type: application/sdp',
    `Content-Length: ${Buffer.byteLength(sdp)}`,
  ].join('\r\n') + '\r\n\r\n' + sdp;
  send(msg);
}
let inviteBranch = null;

function respond(reqMsg, code, reason, sdp) {
  const fromH = headerOf(reqMsg, 'From');
  let toH = headerOf(reqMsg, 'To');
  const cid = headerOf(reqMsg, 'Call-ID');
  const cs = headerOf(reqMsg, 'CSeq');
  if (code >= 180 && !/tag=/.test(toH)) {
    toTag = toTag || rnd(6);
    toH = `${toH};tag=${toTag}`;
  }
  const lines = [
    `SIP/2.0 ${code} ${reason}`,
    ...headersAll(reqMsg, 'Via').map((v) => `Via: ${v}`),
    ...headersAll(reqMsg, 'Record-Route').map((v) => `Record-Route: ${v}`),
    `From: ${fromH}`,
    `To: ${toH}`,
    `Call-ID: ${cid}`,
    `CSeq: ${cs}`,
    contact(),
  ];
  /*
   * ⚠️ Content-Length 는 **실제로 보내는 본문 바이트 수와 정확히 같아야 한다.**
   *    처음에 길이는 본문 전체로 재고 본문에서는 끝 CRLF 를 지워 보냈더니 2바이트가
   *    어긋났고, Kamailio 가 그 200 OK 를 버렸다. 180 Ringing 은 본문이 없어
   *    그대로 통과해서, 화면에는 "벨은 울리는데 안 받아지는" 모양으로 보였다.
   */
  const body = sdp || '';
  lines.push(...(sdp ? ['Content-Type: application/sdp'] : []));
  lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
  send(lines.join('\r\n') + '\r\n\r\n' + body);
}

function sendAck(toUri, viaBranch, extraAuth) {
  const msg = [
    `ACK ${toUri} SIP/2.0`,
    via(viaBranch),
    'Max-Forwards: 70',
    `From: <sip:${USER}@${DOMAIN}>;tag=${fromTag}`,
    `To: <sip:${PEER}@${DOMAIN}>${toTag ? `;tag=${toTag}` : ''}`,
    `Call-ID: ${callId}`,
    `CSeq: ${cseq} ACK`,
    ...(extraAuth ? [extraAuth] : []),
    'Content-Length: 0', '', '',
  ].join('\r\n');
  send(msg);
}

function sendBye() {
  cseq++;
  const target = dialogRemoteUri || `sip:${PEER}@${DOMAIN}`;
  const msg = [
    `BYE ${target} SIP/2.0`,
    via(rnd(6)),
    'Max-Forwards: 70',
    `From: <sip:${USER}@${DOMAIN}>;tag=${fromTag}`,
    `To: <sip:${PEER}@${DOMAIN}>${toTag ? `;tag=${toTag}` : ''}`,
    `Call-ID: ${callId}`,
    `CSeq: ${cseq} BYE`,
    ...(authHeaderFor ? [authHeaderFor] : []),
    'Content-Length: 0', '', '',
  ].join('\r\n');
  send(msg);
}

sip.on('message', (buf) => {
  const msg = buf.toString('utf8');
  const first = msg.split('\r\n')[0];
  // Kamailio 의 keepalive(빈 줄)는 무시한다.
  if (!first.trim()) return;

  // ── 응답 ──────────────────────────────────────────────────────────
  if (first.startsWith('SIP/2.0')) {
    const code = parseInt(first.split(' ')[1], 10);
    const cs = headerOf(msg, 'CSeq') || '';
    const method = cs.split(/\s+/)[1];
    log(`← ${code} (${method})`);

    if (code === 401 || code === 407) {
      const hName = code === 401 ? 'WWW-Authenticate' : 'Proxy-Authenticate';
      const h = headerOf(msg, hName);
      if (!h) { state.error = `${code} 인데 ${hName} 가 없다`; return finish(); }
      cseq++;
      if (method === 'REGISTER') {
        sendRegister(buildAuth(h, 'REGISTER', `sip:${DOMAIN}`, hName));
      } else if (method === 'INVITE') {
        // 실패한 INVITE 트랜잭션을 ACK 로 닫고 새 CSeq 로 다시 건다.
        const toH = headerOf(msg, 'To') || '';
        const tm = toH.match(/tag=([^;>\s]+)/);
        if (tm) toTag = tm[1];
        sendAck(`sip:${PEER}@${DOMAIN}`, inviteBranch, null);
        toTag = null;
        authHeaderFor = buildAuth(h, 'INVITE', `sip:${PEER}@${DOMAIN}`, hName);
        sendInvite(authHeaderFor);
      }
      return;
    }

    if (method === 'REGISTER' && code === 200) {
      state.registered = true;
      log('등록됨');
      if (MODE === 'call') { cseq++; setTimeout(() => sendInvite(authHeaderFor), 300); }
      return;
    }

    if (method === 'INVITE' && code >= 200 && code < 300) {
      const toH = headerOf(msg, 'To') || '';
      const tm = toH.match(/tag=([^;>\s]+)/);
      if (tm) toTag = tm[1];
      const ct = headerOf(msg, 'Contact');
      if (ct) { const m = ct.match(/<([^>]+)>/); if (m) dialogRemoteUri = m[1]; }
      const info = parseSdp(bodyOf(msg));
      if (info && info.chosen) {
        state.negotiatedPt = info.chosen.pt;
        state.negotiatedName = info.chosen.name;
        state.remoteRtp = { host: info.host, port: info.port };
        state.callEstablished = true;
        log(`200 OK — 코덱 ${info.chosen.name}, 미디어 ${info.host}:${info.port}`);
        startRtp();
      } else {
        state.error = `200 OK 인데 공통 코덱이 없다 (상대 제시: ${info ? info.offered.join(',') : '없음'})`;
      }
      sendAck(dialogRemoteUri || `sip:${PEER}@${DOMAIN}`, inviteBranch, authHeaderFor);
      return;
    }

    if (method === 'INVITE' && code >= 400) {
      state.error = `발신 거절: ${first}`;
      sendAck(`sip:${PEER}@${DOMAIN}`, inviteBranch, null);
      return finish();
    }
    return;
  }

  // ── 요청 ──────────────────────────────────────────────────────────
  const method = first.split(' ')[0];
  log(`← ${method}`);

  if (method === 'INVITE') {
    lastInvite = msg;
    const ct = headerOf(msg, 'Contact');
    if (ct) { const m = ct.match(/<([^>]+)>/); if (m) dialogRemoteUri = m[1]; }
    const info = parseSdp(bodyOf(msg));
    if (!info || !info.chosen) {
      state.error = `착신인데 공통 코덱이 없다 (상대 제시: ${info ? info.offered.join(',') : '없음'})`;
      respond(msg, 488, 'Not Acceptable Here');
      return finish();
    }
    state.negotiatedPt = info.chosen.pt;
    state.negotiatedName = info.chosen.name;
    state.remoteRtp = { host: info.host, port: info.port };
    log(`착신 — 상대 제시 [${info.offered.join(',')}] → 고른 것 ${info.chosen.name}, 미디어 ${info.host}:${info.port}`);
    respond(msg, 100, 'Trying');
    respond(msg, 180, 'Ringing');
    setTimeout(() => {
      respond(msg, 200, 'OK', makeSdp([info.chosen]));
      state.callEstablished = true;
      startRtp();
    }, 400);
    return;
  }

  if (method === 'ACK') return;

  if (method === 'BYE') {
    respond(msg, 200, 'OK');
    /*
     * 통화 중이 아닐 때 오는 BYE 는 **앞선 실행이 남긴 대화의 잔재**다.
     * Kamailio 가 같은 AoR 의 contact 로 재전송하는데, 이걸 그대로 종료로
     * 받으면 새로 뜬 단말이 시작하자마자 죽는다 (실제로 그렇게 당했다).
     * 200 만 돌려주고 무시한다.
     */
    if (!state.callEstablished) { log('통화 중이 아닌데 온 BYE — 무시'); return; }
    state.hangupReason = 'BYE 수신';
    stopRtp();
    return finish();
  }

  if (method === 'OPTIONS') { respond(msg, 200, 'OK'); return; }
  if (method === 'CANCEL') { respond(msg, 200, 'OK'); state.hangupReason = 'CANCEL'; return finish(); }
});

// ── 마무리 ──────────────────────────────────────────────────────────────
let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  stopRtp();
  const verdict = {
    ok: state.registered && state.callEstablished && state.rtpIn > 0 && state.rtpOut > 0 && !state.error,
    registered: state.registered,
    callEstablished: state.callEstablished,
    codec: state.negotiatedName,
    payloadType: state.negotiatedPt,
    rtpPacketsIn: state.rtpIn,
    rtpPacketsOut: state.rtpOut,
    rtpInPayloadTypes: [...state.rtpInPts],
    ...(WITH_VIDEO ? { videoPacketsIn: state.videoIn || 0, videoInPayloadTypes: [...(state.videoInPts || [])] } : {}),
    remoteRtp: state.remoteRtp,
    hangup: state.hangupReason,
    error: state.error,
  };
  console.log(JSON.stringify(verdict));
  setTimeout(() => process.exit(verdict.ok ? 0 : 1), 100);
}

setInterval(() => {
  if (state.callEstablished && !finished) {
    log(`heartbeat in=${state.rtpIn} out=${state.rtpOut} sendErr=${state.sendErrors || 0} ${state.lastSendError || ''}`);
  }
}, 1000);

rtp.bind(RTP_PORT, LOCAL_IP, () => log(`RTP 대기 ${LOCAL_IP}:${RTP_PORT}`));
sip.bind(SIP_PORT, LOCAL_IP, () => {
  log(`SIP 대기 ${LOCAL_IP}:${SIP_PORT} — ${USER}@${DOMAIN} → ${PROXY_HOST}:${PROXY_PORT} (${MODE})`);
  sendRegister(null);
});

// 통화가 붙으면 DURATION 만큼 흘려보내고 끊는다.
setInterval(() => {
  if (state.callEstablished && !finished) {
    if (!state.callStartedAt) state.callStartedAt = Date.now();
    else if (Date.now() - state.callStartedAt > DURATION * 1000) {
      state.hangupReason = '시간 다 되어 BYE 보냄';
      sendBye();
      setTimeout(finish, 700);
    }
  }
}, 200);

// 전체 안전장치.
// 통화가 아예 안 걸려 오면 WAIT 뒤에 포기한다. 걸려 왔으면 아래 통화 타이머가 맡는다.
setTimeout(() => {
  if (state.callEstablished) return;      // 통화 중이면 건드리지 않는다
  state.error = state.error || `${WAIT}초 안에 전화가 걸려 오지 않았다`;
  finish();
}, WAIT * 1000);

// 통화가 붙은 뒤의 최종 안전장치 — 통화 시간 + 넉넉히.
setInterval(() => {
  if (!state.callEstablished || finished || !state.callStartedAt) return;
  if (Date.now() - state.callStartedAt > (DURATION + 20) * 1000) {
    state.hangupReason = state.hangupReason || '상대가 BYE 를 보내지 않아 시간 초과로 종료';
    finish();
  }
}, 1000);
