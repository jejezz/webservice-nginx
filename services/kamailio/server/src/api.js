/**
 * 대시보드 API.
 *
 * 모든 경로가 manager 세션을 요구합니다. 서비스마다 로그인을 따로 두지 않고
 * manager 로그인 하나를 검증합니다 (auth/session.js).
 *
 * 데이터 출처는 둘입니다.
 *   Kamailio JSON-RPC (FIFO)  살아 있는 상태 — 등록 단말, WS 연결, 통계
 *   MariaDB                    설정된 것 — SIP 계정(subscriber)
 */
const express = require('express');
const os = require('os');

const rpc = require('./rpc');
const db = require('./db');
const subscribers = require('./subscribers');
const config = require('./config');
const journal = require(require('path').resolve(__dirname, '../../../../lib/journal'));
const stats = require('./stats');
const { requireAuth } = require('./auth/session');
const log = require('./utils/logger');
const pkg = require('../package.json');

/** stats.get_statistics 는 "group:name = value" 문자열 배열을 준다. 객체로 편다. */
function parseStats(rows) {
  const out = {};
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    const m = /^([^:]+):([^=]+?)\s*=\s*(.*)$/.exec(row);
    if (!m) continue;
    const [, group, name, value] = m;
    (out[group] ||= {})[name.trim()] = /^\d+$/.test(value) ? Number(value) : value;
  }
  return out;
}

/**
 * core.aliases_list 에서 SIP 도메인만 골라낸다.
 *
 * 목록에는 자동 생성된 소켓 alias(localhost:5060 등)와 설정에 적은 도메인
 * alias 가 섞여 있다. 뒤엣것은 포트가 없고(port="*") 프로토콜도 지정되지 않는다.
 *     { proto: "*", address: "pluto.org", port: "*" }
 * 그것만 추린다.
 */
function domainAliases(result) {
  const rows = result?.aliases || [];
  return rows
    .map((r) => r.alias || r)
    .filter((a) => String(a.port) === '*' || a.port === undefined)
    .map((a) => a.address)
    .filter(Boolean);
}

/**
 * core.ps 는 [pid, 설명, pid, 설명, ...] 처럼 평평한 배열을 준다. 짝지어 편다.
 * 여기서 WEBSOCKET 워커가 보이면 websocket 모듈이 실제로 올라온 것이다.
 */
function parseProcesses(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (let i = 0; i + 1 < rows.length; i += 2) {
    out.push({ pid: rows[i], description: String(rows[i + 1]) });
  }
  return out;
}

/**
 * ul.dump 를 화면에서 쓰기 좋은 모양으로 편다.
 *
 * 원본은 Domains[].Domain.AoRs[].{Info.Contacts[].Contact} 처럼 한 겹씩 감싸여
 * 있어서 그대로 내보내면 프런트가 그 구조를 알아야 한다. 여기서 평평하게 만든다.
 */
function flattenRegistrations(dump) {
  const rows = [];
  for (const d of dump?.Domains || []) {
    const domain = d.Domain || {};
    for (const aor of domain.AoRs || []) {
      const info = aor.Info || aor;
      const username = info.AoR ?? info.Username ?? '(unknown)';
      for (const c of info.Contacts || []) {
        const contact = c.Contact || c;
        rows.push({
          aor: username,
          domain: domain.Domain,
          contact: contact.Address ?? contact.Contact ?? null,
          expires: contact.Expires ?? null,
          userAgent: contact['User-Agent'] ?? contact.User_Agent ?? null,
          received: contact.Received ?? null,
          path: contact.Path ?? null,
          // WS 단말은 여기가 ws/wss 로 나온다 — UDP 단말과 구분하는 근거.
          transport: /transport=(\w+)/i.exec(contact.Address || '')?.[1]?.toLowerCase()
            ?? (contact.Received?.startsWith('ws') ? 'ws' : null),
          callId: contact['Call-ID'] ?? null,
          state: contact.State ?? null,
        });
      }
    }
  }
  return rows;
}

function createApiRouter() {
  const router = express.Router();

  // 모든 API 는 로그인을 요구한다. 401 이면 프런트가 manager 로그인으로 보낸다.
  router.use(requireAuth);

  /** 개요 — 서비스 자신 + Kamailio 요약 */

  /**
   * systemd 저널 — 이 서비스는 pm2 가 아니라 systemd 가 띄우므로 로그가
   * 저널에만 있습니다. 터미널을 열지 않고도 볼 수 있게 그대로 내려 줍니다.
   *
   * **읽기 전용이고 유닛 이름은 여기 박혀 있습니다.** 사람이 넣는 값은 줄 수와
   * 필터뿐이고, 셸을 거치지 않습니다 (lib/journal.js 의 경계).
   */
  router.get('/logs', async (req, res) => {
    res.json(await journal.read('kamailio', {
      lines: req.query.lines,
      grep: req.query.grep,
      minutes: req.query.minutes,
    }));
  });

  router.get('/overview', async (req, res) => {
    const data = await rpc.callAll({
      version: ['core.version'],
      uptime: ['core.uptime'],
      shmem: ['core.shmmem'],
      // core.pkgmem 은 5.5.4 에 없다 ("Method Not Found"). pkg.stats 가 워커별로 준다.
      pkg: ['pkg.stats'],
      procs: ['core.ps'],
      aliases: ['core.aliases_list'],
      ws: ['ws.dump'],
      ul: ['ul.dump'],
    });

    const registrations = flattenRegistrations(data.ul);
    const mem = process.memoryUsage();

    res.json({
      service: {
        name: config.SERVICE_NAME,
        version: pkg.version,
        pid: process.pid,
        nodeVersion: process.version,
        hostname: os.hostname(),
        uptimeSec: Math.floor((Date.now() - stats.startedAt) / 1000),
        memoryMb: Math.round(mem.rss / 1024 / 1024),
      },
      kamailio: {
        version: typeof data.version === 'string' ? data.version.trim() : null,
        uptimeSec: data.uptime?.uptime ?? null,
        upSince: data.uptime?.up_since ?? null,
        // 설정 상수가 아니라 Kamailio 가 실제로 아는 도메인을 보여준다.
        domains: domainAliases(data.aliases),
        // core.shmmem 은 Kamailio 버전에 따라 필드가 달라 그대로 넘긴다.
        shmem: data.shmem ?? null,
        // pkg.stats 는 워커마다 한 줄이다. 합계만 내고 상세는 워커 표에 둔다.
        pkgTotal: Array.isArray(data.pkg)
          ? data.pkg.reduce((a, w) => ({
              used: a.used + (w.used || 0),
              real_used: a.real_used + (w.real_used || 0),
              total_size: a.total_size + (w.total_size || 0),
            }), { used: 0, real_used: 0, total_size: 0 })
          : null,
        workers: parseProcesses(data.procs),
        error: data.version?.error ?? data.uptime?.error ?? null,
      },
      summary: {
        registrations: registrations.length,
        websockets: data.ws?.info?.wscounter ?? 0,
        transports: registrations.reduce((acc, r) => {
          const k = r.transport || 'udp';
          acc[k] = (acc[k] || 0) + 1;
          return acc;
        }, {}),
      },
      stats: stats.snapshot(),
      updatedAt: new Date().toISOString(),
    });
  });

  /** 등록 단말 — 지금 붙어 있는 것 */
  router.get('/registrations', async (req, res) => {
    try {
      const dump = await rpc.call('ul.dump');
      const rows = flattenRegistrations(dump);
      res.json({
        registrations: rows,
        // 원본의 Stats 도 함께 낸다 — 화면에 안 보이는 것을 눈치채는 데 쓴다.
        raw: (dump?.Domains || []).map((d) => ({
          domain: d.Domain?.Domain,
          size: d.Domain?.Size,
          records: d.Domain?.Stats?.Records ?? 0,
        })),
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      res.status(503).json({ error: err.message });
    }
  });

  /** WebSocket 연결 — SIP over WS 단말 */
  router.get('/websockets', async (req, res) => {
    try {
      const dump = await rpc.call('ws.dump');
      res.json({
        connections: dump?.connections ?? [],
        count: dump?.info?.wscounter ?? 0,
        truncated: dump?.info?.truncated === 'yes',
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      res.status(503).json({ error: err.message });
    }
  });

  /** 통계 — 그룹별로 정리해서 */
  router.get('/stats', async (req, res) => {
    try {
      const rows = await rpc.call('stats.get_statistics', ['all']);
      res.json({ groups: parseStats(rows), updatedAt: new Date().toISOString() });
    } catch (err) {
      res.status(503).json({ error: err.message });
    }
  });

  /**
   * SIP 계정 — subscriber 테이블.
   *
   * 비밀번호 계열(password/ha1/ha1b)은 어떤 응답에도 넣지 않는다.
   * 어느 컬럼이 실제 인증에 쓰이는지는 subscribers.js 의 주석에 있다.
   */

  /** Kamailio 가 "내 것" 으로 아는 도메인. 계정을 만들 때 기본값으로 쓴다. */
  async function knownDomains() {
    try {
      return domainAliases(await rpc.call('core.aliases_list'));
    } catch {
      return null; // 못 물어봤다. "없다" 와 구별한다.
    }
  }

  function dbGuard(res) {
    if (db.isConfigured()) return false;
    res.status(503).json({ error: '데이터베이스가 설정되지 않았습니다.' });
    return true;
  }

  function dbError(res, err, what) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'duplicate', message: '같은 사용자명과 도메인의 계정이 이미 있습니다.' });
    }
    log.error(`subscriber ${what} 실패: ${err.message}`);
    res.status(503).json({ error: err.message });
  }

  router.get('/accounts', async (req, res) => {
    if (dbGuard(res)) return;
    try {
      const [rows, aliases] = await Promise.all([subscribers.list(), knownDomains()]);

      // 계정의 domain 이 Kamailio 가 아는 도메인에 없으면 그 계정으로는 등록이 되지
      // 않는다. route[SIPOUT] 의 `if (uri==myself) return;` 에 걸리지 않아 REGISTER 가
      // 외부로 릴레이되기 때문이다. (인증 자체는 use_domain=0 이라 통과할 수 있다)
      //
      // 비교 대상을 설정 상수로 두지 않고 Kamailio 에 직접 묻는다 — 상수로 두었다가
      // 설정을 바꾼 뒤 이쪽을 안 고쳐 엉뚱한 경고가 계속 뜬 적이 있다.
      const domains = [...new Set(rows.map((r) => r.domain))];
      const missing = aliases ? domains.filter((d) => !aliases.includes(d)) : [];

      res.json({
        accounts: rows,
        aliases,
        domains,
        minPasswordLength: subscribers.MIN_PASSWORD_LENGTH,
        maxPasswordLength: subscribers.MAX_PASSWORD_LENGTH,
        warning: missing.length
          ? `계정 도메인(${missing.join(', ')})이 Kamailio 의 alias 목록에 없습니다`
            + `${aliases.length ? ` (등록된 것: ${aliases.join(', ')})` : ''}. `
            + '이 도메인으로 온 REGISTER 는 외부로 릴레이되어 등록되지 않습니다.'
          : null,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      dbError(res, err, 'list');
    }
  });

  router.post('/accounts', async (req, res) => {
    if (dbGuard(res)) return;
    const { username, password, domain } = req.body || {};

    const name = subscribers.validateUsername(username);
    if (name.error) return res.status(400).json({ error: 'invalid_username', message: name.error });

    const pw = subscribers.validatePassword(password);
    if (pw.error) return res.status(400).json({ error: 'weak_password', message: pw.error });

    // 도메인을 안 주면 Kamailio 가 아는 것 중 첫째를 쓴다. 그것도 없으면 거절한다 —
    // 임의로 정하면 등록되지 않는 계정이 조용히 만들어진다.
    const aliases = await knownDomains();
    const target = String(domain || '').trim() || (aliases && aliases[0]);
    if (!target) {
      return res.status(400).json({
        error: 'no_domain',
        message: 'domain 을 지정하세요. Kamailio 의 alias 목록을 읽지 못해 기본값을 정할 수 없습니다.',
      });
    }
    if (aliases && !aliases.includes(target)) {
      return res.status(400).json({
        error: 'unknown_domain',
        message: `${target} 은 Kamailio 의 alias 가 아닙니다 (등록된 것: ${aliases.join(', ')}). `
          + '이대로 만들면 등록되지 않는 계정이 됩니다.',
      });
    }

    try {
      const account = await subscribers.create({ username: name.value, password: pw.value, domain: target });
      log.info(`SIP 계정 생성: ${name.value}@${target} (by ${req.user.username})`);
      res.status(201).json({ account });
    } catch (err) {
      dbError(res, err, 'create');
    }
  });

  /** 비밀번호 변경 · 사용자명/도메인 수정. 준 것만 반영한다. */
  router.patch('/accounts/:id', async (req, res) => {
    if (dbGuard(res)) return;
    const { username, password, domain } = req.body || {};
    const patch = {};

    if (username !== undefined) {
      const name = subscribers.validateUsername(username);
      if (name.error) return res.status(400).json({ error: 'invalid_username', message: name.error });
      patch.username = name.value;
    }
    if (password !== undefined) {
      const pw = subscribers.validatePassword(password);
      if (pw.error) return res.status(400).json({ error: 'weak_password', message: pw.error });
      patch.password = pw.value;
    }
    if (domain !== undefined) patch.domain = String(domain).trim();

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'empty', message: '바꿀 값이 없습니다.' });
    }

    // 평문이 없는(예전 방식) 계정은 해시를 다시 계산할 수 없어 비밀번호가 필요하다.
    if (patch.password === undefined && (patch.username || patch.domain)) {
      if (await subscribers.needsPassword(req.params.id)) {
        return res.status(400).json({
          error: 'password_required',
          message: '이 계정은 평문 비밀번호가 없어 해시를 다시 만들 수 없습니다. 비밀번호를 함께 지정하세요.',
        });
      }
    }

    try {
      const account = await subscribers.update(req.params.id, patch);
      if (!account) return res.status(404).json({ error: 'not_found' });
      log.info(`SIP 계정 수정: id=${req.params.id} [${Object.keys(patch).join(', ')}] (by ${req.user.username})`);
      res.json({ account });
    } catch (err) {
      dbError(res, err, 'update');
    }
  });

  router.delete('/accounts/:id', async (req, res) => {
    if (dbGuard(res)) return;
    try {
      const before = await subscribers.getById(req.params.id);
      if (!before) return res.status(404).json({ error: 'not_found' });
      await subscribers.remove(req.params.id);
      log.info(`SIP 계정 삭제: ${before.username}@${before.domain} (by ${req.user.username})`);
      res.json({ deleted: true });
    } catch (err) {
      dbError(res, err, 'delete');
    }
  });

  /** 임의 RPC 는 열지 않는다. 필요한 명령이 생기면 위처럼 경로를 추가한다. */

  return router;
}

module.exports = { createApiRouter, parseStats, flattenRegistrations, parseProcesses, domainAliases };
