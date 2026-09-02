/**
 * 대시보드가 부르는 API. 모두 manager 세션이 있어야 한다.
 *
 * 개요·시험 클라이언트(3단계)에 더해 세션·핸들·SIP·미디어(8단계)를 냅니다.
 * 모두 **읽기 전용**입니다 — 세션을 끊거나 설정을 바꾸는 길은 두지 않습니다.
 */
const express = require('express');
const janus = require('./janus');
const sessions = require('./sessions');
const settings = require('./settings');
const addresses = require('./addresses');
const config = require('./config');
const journal = require(require('path').resolve(__dirname, '../../../../lib/journal'));
const { requireAuth } = require('./auth/session');
const log = require('./utils/logger');

function createApiRouter() {
  const router = express.Router();
  router.use(requireAuth);

  /**
   * 개요 — Janus 가 살아 있는가, 무엇이 올라와 있는가.
   *
   * Janus 가 죽어 있어도 200 으로 답하고 running:false 로 알린다. 대시보드가
   * 오류 화면 대신 "Janus 가 떠 있지 않습니다" 를 보여줄 수 있어야 한다.
   */
  router.get('/overview', async (req, res) => {
    const [i, adminPing] = await Promise.all([janus.info(), janus.ping()]);

    if (!i.ok) {
      return res.json({
        running: false,
        error: i.error,
        latencyMs: i.latencyMs,
        admin: { ok: false, error: adminPing.error },
        apiBase: config.JANUS_API_BASE,
      });
    }

    const d = i.data;
    return res.json({
      running: true,
      latencyMs: i.latencyMs,
      apiBase: config.JANUS_API_BASE,
      server: {
        name: d.name,
        version: d.version_string,
        commit: d['commit-hash'],
        compiledAt: d['compile-time'],
        serverName: d['server-name'],
        localIp: d['local-ip'],
        sessionTimeout: d['session-timeout'],
        acceptingNewSessions: d['accepting-new-sessions'],
      },
      ice: {
        lite: d['ice-lite'],
        tcp: d['ice-tcp'],
        fullTrickle: d['full-trickle'],
        ipv6: d.ipv6,
        nomination: d['ice-nomination'],
      },
      // 이름만 추린다. 화면에서 "무엇이 올라와 있는가" 만 보면 된다.
      plugins: Object.keys(d.plugins || {}).sort(),
      transports: Object.keys(d.transports || {}).sort(),
      admin: { ok: adminPing.ok, error: adminPing.error || null },
    });
  });


  /**
   * systemd 저널 — 이 서비스는 pm2 가 아니라 systemd 가 띄우므로 로그가
   * 저널에만 있습니다. 터미널을 열지 않고도 볼 수 있게 그대로 내려 줍니다.
   *
   * **읽기 전용이고 유닛 이름은 여기 박혀 있습니다.** 사람이 넣는 값은 줄 수와
   * 필터뿐이고, 셸을 거치지 않습니다 (lib/journal.js 의 경계).
   */
  router.get('/logs', async (req, res) => {
    res.json(await journal.read('janus', {
      lines: req.query.lines,
      grep: req.query.grep,
      minutes: req.query.minutes,
    }));
  });
  /**
   * 시그널링 API 비밀 — **비밀번호를 다시 받아야** 내려 준다.
   *
   * 클라이언트를 만들려면 이 값이 필요한데, 서버에 들어가 파일을 열어 보는 것
   * 말고는 길이 없었습니다. 화면에서 꺼낼 수 있게 하되 세션 쿠키만으로는 주지
   * 않습니다 — 자리를 비운 사이 열린 화면으로 새어 나가지 않게, 지금 이 사람이
   * 맞는지 로그인 비밀번호로 한 번 더 확인합니다.
   *
   * 계정은 manager 가 소유하므로 확인도 manager 에게 맡깁니다. **사용자의 세션
   * 쿠키를 그대로 넘겨** 물어보므로, 이 서비스가 비밀번호를 판단하지도, 그것을
   * 저장하지도 않습니다.
   */
  router.post('/api-secret', async (req, res) => {
    const password = String(req.body?.password ?? '');
    if (!password) return res.status(400).json({ error: 'missing_password' });

    let verdict;
    try {
      const upstream = await fetch(`${config.MANAGER_API_BASE}/verify-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // 세션 주인을 manager 가 쿠키로 가린다. 사용자 이름을 우리가 말하지 않는다.
          cookie: req.headers.cookie || '',
        },
        body: JSON.stringify({ password }),
        signal: AbortSignal.timeout(5000),
      });
      verdict = { status: upstream.status, body: await upstream.json().catch(() => ({})) };
    } catch (err) {
      log.warn(`verify-password 호출 실패: ${err.message}`);
      return res.status(503).json({ error: 'verify_unavailable', message: '확인 서버에 닿지 못했습니다.' });
    }

    if (verdict.status !== 200) {
      return res.status(verdict.status).json(verdict.body || { error: 'invalid_password' });
    }

    const secret = janus.loadApiSecret();
    if (!secret) {
      return res.status(404).json({ error: 'no_secret', message: 'secrets/api-secret 이 없습니다 — sudo ./install.sh --apply' });
    }

    log.info(`api_secret 열람: ${req.user?.username ?? '?'}`);
    res.json({ apiSecret: secret });
  });

  /**
   * 접속 주소 — 이 서비스 디렉터리가 선언한 입구들.
   *
   * 클라이언트를 짜는 사람이 가장 먼저 찾는 것이 "어디로 붙는가" 인데, 그 답이
   * nginx 선언 파일 안에만 있었습니다. 같은 파일을 읽어 화면에 꺼내 놓습니다.
   * 밖에서 쓸 주소의 오리진은 브라우저가 붙입니다.
   */
  router.get('/addresses', async (req, res) => {
    res.json(await addresses.list());
  });

  /**
   * 세션 · 핸들 · SIP 상태 · 미디어 (8-2 ~ 8-4).
   *
   * Janus 가 죽어 있어도 200 으로 답하고 ok:false 로 알린다 — /overview 와 같은
   * 자세다. 화면이 오류 대신 "Janus 가 떠 있지 않습니다" 를 그릴 수 있어야 한다.
   */
  router.get('/sessions', async (req, res) => {
    res.json(await sessions.snapshot());
  });

  /**
   * 배포 설정 (공인 IP · 미디어 포트 범위 …).
   *
   * ⚠️ 이 대시보드에서 **유일하게 쓰기가 있는 자리**입니다. 그래도 하는 일은
   *    settings.ini 에 값을 적는 것뿐이고, sudo 를 부르지 않습니다. 적용은
   *    사람이 `sudo ./install.sh --apply` 를 실행해야 일어납니다.
   */
  router.get('/settings', (req, res) => {
    res.json(settings.state());
  });

  router.put('/settings', (req, res) => {
    const result = settings.save(req.body || {});
    if (!result.ok) return res.status(400).json({ error: '입력을 확인하세요', errors: result.errors });
    res.json(result);
  });

  /**
   * 시험 클라이언트가 Janus 에 붙는 데 필요한 값.
   *
   * api_secret 이 여기에 실려 브라우저로 내려간다. **로그인된 세션에만** 준다는
   * 것이 이 엔드포인트의 존재 이유다 (docs/plan.md ⑤). 완전한 방어는 아니고,
   * 진짜 관문은 Kamailio 의 digest 인증이다.
   */
  router.get('/testcall-config', (req, res) => {
    res.json({
      // 상대 경로다. 공유기가 외부 28443 을 내부 443 으로 넘기므로 서버는
      // 브라우저가 아는 호스트·포트를 알 수 없다. 브라우저가 현재 주소로 푼다.
      janusPath: config.JANUS_PUBLIC_PATH,
      apiSecret: janus.loadApiSecret(),
      sipProxy: config.SIP_PROXY,
      sipDomain: config.SIP_DOMAIN,
    });
  });

  return router;
}

module.exports = { createApiRouter };
