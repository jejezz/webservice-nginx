/**
 * 대시보드가 부르는 API. 모두 manager 세션이 있어야 한다.
 *
 * 개요 · 로그 · 설정 셋뿐입니다. **모두 읽기 전용**입니다 — coturn 을 재시작
 * 하거나 /etc/turnserver.conf 를 다시 쓰는 길은 두지 않습니다. 그건
 * `sudo ./install.sh --apply` 가 사람 손으로 하는 일입니다
 * (kamailio-dashboard 와 같은 자세, README.md 참고).
 */
const express = require('express');
const coturn = require('./coturn');
const settings = require('./settings');
const config = require('./config');
const journal = require(require('path').resolve(__dirname, '../../../../lib/journal'));
const { requireAuth } = require('./auth/session');

function createApiRouter() {
  const router = express.Router();
  router.use(requireAuth);

  /**
   * 개요 — 패키지가 있는가, 떠 있는가, 설치본이 저장소와 같은가.
   *
   * coturn 이 죽어 있어도 200 으로 답한다. 대시보드와 coturn 은 다른
   * 프로세스이고, 대시보드가 살아 있어야 coturn 이 죽은 것을 볼 수 있다
   * (janus-dashboard · kamailio-dashboard 와 같은 판단).
   */
  router.get('/overview', async (req, res) => {
    const status = await coturn.status();
    const settingsState = settings.state();

    res.json({
      status,
      // 화면이 "왜 이 값이 이렇게 됐는가"를 설명할 때 쓴다 — 예를 들어
      // public_ip 가 비어 있으면 이 서비스를 만든 이유(셀룰러 NAT 통과) 가
      // 무효화된다는 경고를 여기 값으로 판단한다.
      settings: settingsState.values,
    });
  });

  /**
   * systemd 저널 — 이 서비스는 pm2 가 아니라 apt 패키지의 systemd 유닛이
   * 띄우므로 로그가 저널에만 있습니다. janus-dashboard · kamailio-dashboard
   * 와 같은 방식입니다 (lib/journal.js).
   */
  router.get('/logs', async (req, res) => {
    res.json(await journal.read(config.UNIT_NAME, {
      lines: req.query.lines,
      grep: req.query.grep,
      minutes: req.query.minutes,
    }));
  });

  /**
   * 배포 설정 (공인 IP · realm · 포트 범위 …).
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

  return router;
}

module.exports = { createApiRouter };
