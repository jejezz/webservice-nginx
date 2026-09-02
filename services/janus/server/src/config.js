/**
 * janus-dashboard 런타임 설정.
 *
 * 이 서비스는 Janus 를 **관찰만** 합니다. 미디어나 시그널링에 관여하지 않고,
 * Janus 를 재시작하거나 설정을 바꾸지도 않습니다. 그런 일은
 * services/janus/install.sh 가 sudo 로 합니다. (kamailio-dashboard 와 같은 자세)
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

// install.sh --apply 가 남긴 값 → settings.ini → 기본 경로의 LAN 주소 순으로 본다.
function sipLocalIp() {
  const dir = path.resolve(__dirname, '../..');
  for (const f of ['.applied-settings', 'settings.ini']) {
    try {
      const m = fs.readFileSync(path.join(dir, f), 'utf8')
        .match(/^[ \t]*sip_local_ip[ \t]*=[ \t]*(\S+)[ \t]*$/m);
      if (m) return m[1];
    } catch { /* 없으면 다음 것을 본다 */ }
  }
  for (const [, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '127.0.0.1';   // 여기까지 오면 통화는 안 되지만, 화면은 떠야 한다
}

module.exports = {
  SERVICE_NAME: 'janus-dashboard',

  PORT: parseInt(process.env.PORT, 10) || 28087,
  // Nginx 가 127.0.0.1 로 프록시하므로 루프백에만 묶는다.
  HOST: process.env.HOST || '127.0.0.1',

  // Nginx 가 이 서비스를 프록시할 때 쓰는 경로 접두사.
  // proxy_path 를 비워 두므로 원본 URI(/janus/...)가 그대로 온다.
  BASE_PATH: process.env.BASE_PATH || '/janus',
  DASHBOARD_PATH: process.env.DASHBOARD_PATH || '/dashboard',

  // Janus 시그널링 API. base_path 는 janus.transport.http.jcfg 와 같아야 한다.
  // 브라우저는 nginx 를 거쳐 같은 경로로 가고, 이 프로세스는 루프백으로 직접 간다.
  JANUS_API_BASE: process.env.JANUS_API_BASE || 'http://127.0.0.1:8088/janus-api',

  // manager 의 API. 민감한 값을 화면에 꺼내기 전에 "지금 이 사람이 맞는지" 를
  // 비밀번호로 다시 확인할 때 부른다 (POST /verify-password). 계정은 manager 가
  // 소유하므로 이 서비스는 물어볼 뿐이다.
  MANAGER_API_BASE: process.env.MANAGER_API_BASE || 'http://127.0.0.1:28084/manager/api',

  // Admin API. 루프백에만 열려 있고 nginx 라우트가 없다.
  // 세션·핸들·미디어 상태를 여기서 읽는다.
  JANUS_ADMIN_BASE: process.env.JANUS_ADMIN_BASE || 'http://127.0.0.1:7088/admin',

  // install.sh 가 만드는 비밀 파일. 서비스 디렉토리(services/janus) 기준.
  //
  // admin-secret : Admin API 호출에 필요. **브라우저로 내려보내지 않는다.**
  // api-secret   : 브라우저가 Janus 를 부를 때 필요. 로그인된 세션에만 내려준다
  //                (docs/plan.md ⑤).
  ADMIN_SECRET_FILE: process.env.JANUS_ADMIN_SECRET_FILE
    || path.resolve(__dirname, '../..', 'secrets', 'admin-secret'),
  API_SECRET_FILE: process.env.JANUS_API_SECRET_FILE
    || path.resolve(__dirname, '../..', 'secrets', 'api-secret'),

  // 브라우저가 Janus 에 붙을 공개 경로. nginx-conf/service.ini 의 location 이다.
  // 절대 URL 을 만들지 않고 상대 경로로 준다 — 공유기 포트 포워딩(28443) 환경에서
  // 호스트·포트를 서버가 알 수 없기 때문이다. 브라우저가 현재 주소로 해석한다.
  JANUS_PUBLIC_PATH: process.env.JANUS_PUBLIC_PATH || '/janus-api',

  // 시험 클라이언트가 register 에 쓸 기본값. 사람이 화면에서 고칠 수 있다.
  //
  // ⚠️ 루프백이 아니라 LAN 주소다. 127.0.0.1 로 붙으면 시그널링은 되는데
  //    SDP 에 실리는 주소가 어긋나 소리가 안 난다 (docs/plan.md ③).
  //
  // 주소를 박아 두지 않는다 — install.sh --apply 가 정한 값을 따라간다.
  // 장비마다 다른 값이라, 박아 두면 다른 장비에서 조용히 틀린 곳으로 건다.
  SIP_PROXY: process.env.SIP_PROXY || `sip:${sipLocalIp()}:5060`,
  SIP_DOMAIN: process.env.SIP_DOMAIN || 'pluto.org',

  REQUEST_TIMEOUT_MS: parseInt(process.env.REQUEST_TIMEOUT_MS, 10) || 3000,
};
