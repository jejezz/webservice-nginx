/**
 * kamailio-dashboard 런타임 설정.
 *
 * 이 서비스는 Kamailio 를 **관찰만** 합니다. SIP 처리에 관여하지 않고, Kamailio 를
 * 재시작하거나 설정을 바꾸지도 않습니다. 그런 일은 services/kamailio/ 의
 * install.sh · setup-websocket.sh 가 sudo 로 합니다.
 */
module.exports = {
  SERVICE_NAME: 'kamailio-dashboard',

  PORT: parseInt(process.env.PORT, 10) || 28086,
  // Nginx 가 127.0.0.1 로 프록시하므로 루프백에만 묶는다.
  HOST: process.env.HOST || '127.0.0.1',

  // Nginx 가 이 서비스를 프록시할 때 쓰는 경로 접두사.
  // proxy_path 를 비워 두므로 원본 URI(/kamailio/...)가 그대로 온다.
  BASE_PATH: process.env.BASE_PATH || '/kamailio',
  DASHBOARD_PATH: process.env.DASHBOARD_PATH || '/dashboard',

  // SIP 도메인은 여기에 두지 않는다.
  //
  // 예전에는 SIP_DOMAIN 상수를 두고 subscriber.domain 과 비교했는데, Kamailio 쪽
  // 설정을 바꾼 뒤 이 값을 안 고쳐 "도메인이 다릅니다" 라는 엉뚱한 경고가 계속
  // 떴다. 지금은 core.aliases_list RPC 로 **Kamailio 에 직접 묻는다.**
  // 설정이 두 곳에 존재하지 않으므로 어긋날 수가 없다.

  // Kamailio 가 WS 를 듣는 곳. /health 로 살아있는지 확인한다.
  KAMAILIO_WS_URL: process.env.KAMAILIO_WS_URL || 'http://127.0.0.1:5080',

  // SIP 계정(subscriber) 조회용. Kamailio 데몬과는 다른 계정을 쓴다
  // (데몬은 kamailio@localhost, 여기는 공용 jyahn).
  DATABASE: {
    HOST: process.env.DB_HOST || '127.0.0.1',
    PORT: parseInt(process.env.DB_PORT, 10) || 3306,
    USER: process.env.DB_USER || 'jyahn',
    NAME: process.env.DB_NAME || 'kamailio',
    CONNECTION_LIMIT: parseInt(process.env.DB_CONNECTION_LIMIT, 10) || 3,
    // 서비스 디렉토리(services/kamailio) 기준 상대 경로
    PASSWORD_FILE: process.env.DB_PASSWORD_FILE || '../../database/secrets/jyahn.pw',
  },
};
