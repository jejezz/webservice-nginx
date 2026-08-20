/**
 * Janus 클라이언트 — 시그널링 API(info)와 Admin API 를 읽는다.
 *
 * **읽기만 합니다.** 세션을 만들거나 끊지 않고, 설정도 바꾸지 않습니다.
 * Admin API 는 강제 종료까지 되지만 이 서비스는 그런 요청을 보내지 않습니다.
 *
 * 두 곳을 부릅니다.
 *
 *   GET  <JANUS_API_BASE>/info      비밀 없이 응답. 버전·플러그인·트랜스포트
 *   POST <JANUS_ADMIN_BASE>         admin_secret 필요. 세션·핸들·미디어 상태
 *
 * Node 20 의 내장 fetch 를 씁니다. 의존성을 늘리지 않으려는 것입니다.
 */
const fs = require('fs');
const config = require('./config');
const log = require('./utils/logger');

let adminSecret = null;
let adminSecretError = null;

/**
 * Admin API 비밀번호를 읽는다. install.sh 가 만들고 600 으로 두므로,
 * 이 프로세스가 그 파일을 읽을 수 있는 사용자로 떠야 한다.
 *
 * 한 번 읽고 캐시한다. 파일이 바뀌는 일은 --apply 를 다시 돌릴 때뿐이고,
 * 그때는 프로세스도 다시 띄우게 된다.
 */
function loadAdminSecret() {
  if (adminSecret !== null || adminSecretError !== null) return adminSecret;

  try {
    adminSecret = fs.readFileSync(config.ADMIN_SECRET_FILE, 'utf8').trim() || null;
    if (!adminSecret) {
      adminSecretError = `비밀 파일이 비어 있습니다: ${config.ADMIN_SECRET_FILE}`;
    }
  } catch (err) {
    adminSecretError = err.code === 'ENOENT'
      ? `비밀 파일이 없습니다: ${config.ADMIN_SECRET_FILE} — sudo ./install.sh --apply 를 먼저 실행하세요`
      : `비밀 파일을 읽을 수 없습니다: ${config.ADMIN_SECRET_FILE} (${err.code})`;
  }

  if (adminSecretError) log.warn(`Admin API — ${adminSecretError}`);
  return adminSecret;
}

/** 브라우저에 내려줄 api_secret. 없으면 null (Janus 가 요구하지 않는 설정일 수도 있다). */
function loadApiSecret() {
  try {
    return fs.readFileSync(config.API_SECRET_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

async function withTimeout(fn) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.REQUEST_TIMEOUT_MS);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET <base>/info — 비밀 없이 응답한다. 그래서 nginx-conf 의 health_path 로도 쓴다.
 * 이 함수의 성패가 곧 "Janus 가 떠 있는가" 이다.
 */
async function info() {
  const startedAt = Date.now();
  try {
    const res = await withTimeout((signal) =>
      fetch(`${config.JANUS_API_BASE}/info`, { signal })
    );
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}`, latencyMs: Date.now() - startedAt };
    }
    return { ok: true, data: await res.json(), latencyMs: Date.now() - startedAt };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: err.name === 'AbortError' ? '응답 없음 (타임아웃)' : err.message,
    };
  }
}

/**
 * Admin API 요청 하나.
 *
 * Janus 는 모든 요청에 고유한 transaction 을 요구한다. 그리고 응답의
 * janus 필드가 "success" 가 아니면 error 객체가 온다 — HTTP 상태는 200 일 수
 * 있으므로 그것만 보면 안 된다.
 */
let txCounter = 0;

async function admin(request, extra = {}) {
  const secret = loadAdminSecret();
  if (!secret) return { ok: false, error: adminSecretError || 'admin_secret 없음' };

  txCounter += 1;
  const body = {
    janus: request,
    transaction: `dash-${Date.now().toString(36)}-${txCounter}`,
    admin_secret: secret,
    ...extra,
  };

  try {
    const res = await withTimeout((signal) =>
      fetch(config.JANUS_ADMIN_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
    );

    const data = await res.json().catch(() => null);

    if (!res.ok || !data) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    if (data.janus === 'error') {
      // 403 은 대개 비밀번호가 어긋난 것이다. 설정을 다시 설치하면 맞춰진다.
      return { ok: false, error: `${data.error?.code}: ${data.error?.reason}` };
    }
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: err.name === 'AbortError' ? '응답 없음 (타임아웃)' : err.message,
    };
  }
}

/** Admin API 가 닿는지만 가볍게 본다. /health 에서 쓴다. */
async function ping() {
  const res = await admin('ping');
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

module.exports = { info, admin, ping, loadApiSecret, loadAdminSecret };
