/**
 * 서버 TLS 인증서 상태.
 *
 * ── 왜 파일을 읽지 않고 접속해서 보나 ────────────────────────────
 * 두 가지 이유가 있다.
 *
 * 1. Let's Encrypt 인증서는 /etc/letsencrypt/live/ 에 있고 그 디렉토리는
 *    0700 root 다. manager 는 sudo 없이 도는 서비스라 파일로는 못 읽는다.
 *    nginx.js 가 systemctl 을 읽기 전용으로만 쓰는 것과 같은 제약이다.
 *
 * 2. 파일이 최신이어도 nginx 가 reload 하지 않았으면 옛 인증서를 내민다.
 *    "무엇이 디스크에 있나" 보다 "무엇이 나가고 있나" 가 알고 싶은 것이다.
 *    갱신 훅이 빠진 사고가 정확히 이 차이로만 드러난다.
 *
 * 그래서 로컬 TLS 포트에 붙어 제시되는 인증서를 그대로 읽는다.
 * 같은 판단을 CLI 로 하는 것이 nginx/public_ca/cert-status.sh 다.
 */

const tls = require('tls');
const { execFile } = require('child_process');
const { promisify } = require('util');
const log = require('../logger');

const execFileAsync = promisify(execFile);

const CONNECT_TIMEOUT_MS = 4000;

/** 만료가 이만큼 남지 않으면 경고한다. certbot 은 30일 전부터 갱신을 시도한다. */
const WARN_DAYS = 30;
const CRITICAL_DAYS = 7;

/**
 * 제시되는 인증서를 받아온다. **검증하지 않는다**(rejectUnauthorized: false) —
 * 사설 CA 든 staging 이든 만료됐든, 지금 무엇이 나가고 있는지가 알고 싶은 것이다.
 * 검증해 버리면 정작 문제가 있을 때 아무것도 못 본다.
 */
function fetchPeerCertificate(port, servername) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host: '127.0.0.1', port, servername, rejectUnauthorized: false, timeout: CONNECT_TIMEOUT_MS },
      () => {
        const cert = socket.getPeerCertificate(false);
        socket.end();
        if (!cert || !cert.subject) return reject(new Error('no certificate presented'));
        resolve(cert);
      },
    );
    socket.on('timeout', () => { socket.destroy(); reject(new Error('timeout')); });
    socket.on('error', (err) => { socket.destroy(); reject(err); });
  });
}

/**
 * 발급자로 종류를 가른다.
 *
 * staging 인증서를 배포에 물려 두는 사고가 잦은데, 브라우저 오류를 보기 전까지
 * 눈치채기 어렵다. 대시보드에서 바로 드러나게 한다.
 */
function classify(issuer) {
  const o = `${issuer.O || ''} ${issuer.CN || ''}`;
  if (/STAGING|Fake LE/i.test(o)) return 'letsencrypt-staging';
  if (/Let's Encrypt/i.test(o)) return 'letsencrypt';
  if (/DevCA/i.test(o)) return 'private-ca';
  return 'unknown';
}

/** certbot 은 설치될 때 자기 타이머를 같이 깐다. 꺼져 있으면 90일 뒤 조용히 만료된다. */
async function renewTimerState() {
  try {
    const { stdout } = await execFileAsync('systemctl', ['is-active', 'certbot.timer'], { timeout: 5000 });
    return stdout.trim() || 'unknown';
  } catch (err) {
    // is-active 는 비활성일 때 종료 코드가 0이 아니므로 stdout 을 그대로 쓴다.
    const out = `${err.stdout || ''}`.trim();
    return out || 'absent';
  }
}

async function status(server) {
  const port = server?.sslPort || 443;
  const servername = server?.serverName || 'localhost';

  let cert;
  try {
    cert = await fetchPeerCertificate(port, servername);
  } catch (err) {
    log.warn(`TLS 인증서를 읽지 못했습니다 (127.0.0.1:${port}): ${err.message}`);
    return { ok: false, error: err.message, port };
  }

  const expiresAt = new Date(cert.valid_to);
  const daysLeft = Math.floor((expiresAt.getTime() - Date.now()) / 86400000);
  const kind = classify(cert.issuer || {});
  const renewTimer = await renewTimerState();

  let level = 'ok';
  if (daysLeft < WARN_DAYS) level = 'warn';
  if (daysLeft < CRITICAL_DAYS) level = 'critical';
  // staging 을 배포에 물린 것은 지금 당장 깨져 있다는 뜻이다.
  if (kind === 'letsencrypt-staging') level = 'critical';
  // 사설 CA 는 "도는" 상태이지 "끝난" 상태가 아니다. 이관이 안 끝났음을 남긴다.
  if (kind === 'private-ca') level = 'warn';
  // 타이머가 꺼져 있으면 갱신이 조용히 멈춘다.
  if (kind === 'letsencrypt' && renewTimer !== 'active') level = 'warn';

  return {
    ok: true,
    level,
    kind,
    port,
    subject: cert.subject?.CN || null,
    issuer: cert.issuer?.CN || cert.issuer?.O || null,
    sans: cert.subjectaltname || null,
    expiresAt: Number.isNaN(expiresAt.getTime()) ? null : expiresAt.toISOString(),
    daysLeft: Number.isNaN(daysLeft) ? null : daysLeft,
    renewTimer,
  };
}

module.exports = { status };
