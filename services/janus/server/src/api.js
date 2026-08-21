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
const config = require('./config');
const { requireAuth } = require('./auth/session');

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
