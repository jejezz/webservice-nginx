/**
 * coturn-dashboard 런타임 설정.
 *
 * 이 서비스는 coturn 을 **관찰만** 합니다. TURN/STUN 처리에 관여하지 않고,
 * coturn 을 재시작하거나 설정을 바꾸지도 않습니다. 그런 일은
 * services/coturn/install.sh 가 sudo 로 합니다. (janus-dashboard ·
 * kamailio-dashboard 와 같은 자세)
 */
const path = require('path');

module.exports = {
  SERVICE_NAME: 'coturn-dashboard',

  PORT: parseInt(process.env.PORT, 10) || 28090,
  // Nginx 가 127.0.0.1 로 프록시하므로 루프백에만 묶는다.
  HOST: process.env.HOST || '127.0.0.1',

  // Nginx 가 이 서비스를 프록시할 때 쓰는 경로 접두사.
  // proxy_path 를 비워 두므로 원본 URI(/coturn/...)가 그대로 온다.
  BASE_PATH: process.env.BASE_PATH || '/coturn',
  DASHBOARD_PATH: process.env.DASHBOARD_PATH || '/dashboard',

  // manager 의 API. 이 대시보드는 비밀을 화면에 내려 주지 않으므로(아래 참고)
  // 지금은 부르지 않지만, janus·kamailio 와 구조를 맞춰 자리를 남겨 둔다.
  MANAGER_API_BASE: process.env.MANAGER_API_BASE || 'http://127.0.0.1:28084/manager/api',

  // coturn 은 systemd(apt 패키지 유닛)가 띄운다 — pm2 도, 우리가 만든 유닛도
  // 아니다. 상태는 systemctl·journalctl 로만 읽는다 (server/src/coturn.js).
  UNIT_NAME: 'coturn',

  // install.sh 가 설치하는 실제 설정과, 이 저장소가 커밋한 원본(자리표시자
  // 포함). 서비스 디렉토리(services/coturn) 기준.
  INSTALLED_CONFIG: '/etc/turnserver.conf',
  TEMPLATE_CONFIG: path.resolve(__dirname, '../..', 'turnserver.conf'),
  DEFAULT_FILE: '/etc/default/coturn',

  // install.sh 가 만드는 비밀. **브라우저로 내려보내지 않는다** — 이 값을
  // 알면 임의로 TURN 자격 증명을 계산해 릴레이를 공짜로 쓸 수 있다. 존재
  // 여부만 화면에 보여준다 (janus 의 api-secret 이 값 자체를 보여주는 것과는
  // 다르다 — 그건 브라우저가 Janus 를 부르는 데 실제로 필요하지만, 이
  // 비밀은 이 대시보드가 쓸 일이 없다).
  STATIC_AUTH_SECRET_FILE: process.env.COTURN_STATIC_AUTH_SECRET_FILE
    || path.resolve(__dirname, '../..', 'secrets', 'static-auth-secret'),

  REQUEST_TIMEOUT_MS: parseInt(process.env.REQUEST_TIMEOUT_MS, 10) || 3000,
};
