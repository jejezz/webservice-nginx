const http = require('node:http');
const https = require('node:https');
const config = require('../config');

// /health가 정상으로 간주하는 status 값. 서비스마다 표현이 조금씩 다르다.
const HEALTHY_VALUES = new Set(['ok', 'healthy', 'up', 'pass', 'ready', 'green']);

const MAX_BODY_BYTES = 64 * 1024;

/**
 * 헬스 체크 요청. fetch 대신 node:http(s)를 쓰는 이유는
 * 자체 서명 인증서로 HTTPS를 제공하는 서비스(rtc-relay-server 등)를 위해
 * TLS 검증을 서비스 단위로 끌 수 있어야 하기 때문이다.
 */
function request(url, { timeoutMs, insecureTls }) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      reject(new Error(`Invalid health URL: ${url}`));
      return;
    }

    const client = target.protocol === 'https:' ? https : http;

    const req = client.request(
      target,
      {
        method: 'GET',
        headers: { accept: 'application/json' },
        timeout: timeoutMs,
        ...(target.protocol === 'https:' && insecureTls ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks = [];
        let size = 0;

        res.on('data', (chunk) => {
          size += chunk.length;
          if (size <= MAX_BODY_BYTES) chunks.push(chunk);
        });

        res.on('end', () => {
          resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') });
        });
      }
    );

    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end();
  });
}

function parseBody(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed.slice(0, 200);
  }
}

/**
 * 서비스의 /health를 호출해 상태를 판정한다.
 *  - up      : 2xx 응답 + (status 필드가 있다면) 정상 값
 *  - degraded: 2xx 응답이지만 status가 정상 값이 아님
 *  - down    : 연결 실패 / 타임아웃 / 2xx 아닌 응답
 *  - unknown : 헬스 URL을 만들 수 없음
 */
async function checkOne(service, timeoutMs = config.healthTimeoutMs) {
  const checkedAt = new Date().toISOString();

  if (!service.healthUrl) {
    return {
      status: 'unknown',
      checkedAt,
      error: service.proxyPass
        ? `Cannot resolve proxy_pass: "${service.proxyPass}"`
        : 'No health URL (PORT 또는 HEALTH_URL 설정 필요)',
    };
  }

  const startedAt = process.hrtime.bigint();
  const elapsed = () => Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);

  try {
    const res = await request(service.healthUrl, { timeoutMs, insecureTls: service.insecureTls });
    const latencyMs = elapsed();
    const body = parseBody(res.text);

    if (res.status < 200 || res.status >= 300) {
      return {
        status: 'down',
        httpStatus: res.status,
        latencyMs,
        checkedAt,
        error: `HTTP ${res.status}`,
        body,
      };
    }

    const reported = body && typeof body === 'object' ? body.status : undefined;
    const healthy = reported === undefined || HEALTHY_VALUES.has(String(reported).toLowerCase());

    return {
      status: healthy ? 'up' : 'degraded',
      httpStatus: res.status,
      latencyMs,
      checkedAt,
      error: healthy ? null : `Reported status: ${reported}`,
      body,
    };
  } catch (err) {
    const timedOut = err.code === 'ETIMEDOUT';
    return {
      status: 'down',
      latencyMs: elapsed(),
      checkedAt,
      error: timedOut ? `Timeout after ${timeoutMs}ms` : err.code || err.message,
      body: null,
    };
  }
}

function checkAll(services, timeoutMs) {
  return Promise.all(services.map((service) => checkOne(service, timeoutMs)));
}

module.exports = { checkOne, checkAll, HEALTHY_VALUES };
