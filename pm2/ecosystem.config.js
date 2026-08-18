// pm2 process definitions for this server.
//
// 경로는 이 파일 위치에서 유도한다 — 절대 경로를 적어 두면 WebServices/ 를
// 옮길 때마다 다섯 줄을 고쳐야 하고, 실제로 예전에 그걸 놓쳐서 재부팅 복원이
// 끊긴 적이 있다. pm2 는 cwd 에 절대 경로를 요구하므로 '상대 경로로 두기' 가
// 아니라 '실행 시점에 절대 경로를 계산하기' 로 푼다.
//
// nginx is intentionally NOT managed here — it stays a systemd service
// (it needs root to bind :80/:443, and systemd already restarts it on
// crash/boot). See README.md for how to reload nginx after config changes.
//
// Usage:
//   pm2 start ecosystem.config.js         # start everything defined below
//   pm2 start ecosystem.config.js --only face-recognition-server
// See README.md for the full add/edit/remove workflow.

const path = require('path');

/** WebServices/services/<name> 의 절대 경로. 이 파일은 WebServices/pm2/ 에 있다. */
const service = (...segments) => path.resolve(__dirname, '..', 'services', ...segments);

module.exports = {
  apps: [
    {
      name: 'face-recognition-server',
      cwd: service('face-recognition-server'),
      script: './start_server.sh',
      interpreter: 'bash',
      // Tells the script to stay in the foreground and forward pm2's
      // stop/restart signal to its gunicorn (:5500) and log-relay (:5514)
      // children instead of detaching them with nohup. See start_server.sh.
      env: {
        FOREGROUND: 'true',
      },
      autorestart: true,
      // GPU warm-up (model load) takes a while; don't thrash-restart on
      // a slow-but-successful boot.
      min_uptime: '30s',
      max_restarts: 10,
      // Give the script's own graceful-stop trap time to drain gunicorn
      // workers and kill the log relays before pm2 sends SIGKILL.
      kill_timeout: 20000,
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      time: true,
    },
    {
      // Service management dashboard. nginx serves it at / (declared in
      // WebServices/services/manager/nginx-conf/service.ini) instead of the
      // default welcome page. Binds to loopback only; nginx terminates TLS.
      name: 'nginx-manager',
      cwd: service('manager', 'server'),
      script: 'src/index.js',
      env: {
        // Must match ports in WebServices/services/manager/nginx-conf/service.ini
        // and "port" in WebServices/services/manager/config.json.
        PORT: 28084,
        NODE_ENV: 'production',
      },
      autorestart: true,
      max_restarts: 10,
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      time: true,
    },
    {
      // Apartment management server. nginx routes /complex/* here, so it must
      // be supervised alongside the others — previously it was only startable
      // by hand from its own app/ecosystem.config.js, which left those routes
      // returning 502. (/cassini/ now belongs to the web-cassini entry below.)
      //
      // Runs the compiled output, not src/*.ts via tsx: `npm run build` in the
      // app directory must succeed before starting this. No `watch` here —
      // restarting a production server on every file touch is not wanted.
      name: 'Huygens-Server',
      cwd: service('apartment-mgmt-server', 'app'),
      script: 'dist/server.js',
      // The app forks its own cluster workers, so pm2 supervises one process
      // in fork mode and lets the app do the clustering. Do not use pm2's
      // cluster mode here — the two would fight over the listening socket.
      instances: 1,
      exec_mode: 'fork',
      env: {
        // Must match ports in
        // WebServices/services/apartment-mgmt-server/nginx-conf/service.ini.
        // pm2's env wins over the app's .env (dotenv does not overwrite
        // variables that are already set), so this pins the contract.
        PORT: 28092,
        NODE_ENV: 'production',
      },
      autorestart: true,
      // Cluster workers + DB connections take a moment to come up.
      min_uptime: '20s',
      max_restarts: 10,
      // Let the primary shut its workers down before pm2 sends SIGKILL.
      kill_timeout: 10000,
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      time: true,
    },
    {
      // Cassini 관리 화면의 정적 서버. 예전에는 vite 빌드 결과를
      // apartment-mgmt-server 의 app/public/cassini 로 복사해 그쪽 Express 가
      // 서빙했지만, 이제 독립 서비스로 자기 dist 를 직접 내려준다.
      //
      // 서버 코드에 의존성이 없어 실행 전 npm install 이 필요 없다.
      // 다만 dist 는 있어야 한다 — 없으면 /health 가 degraded 로 응답한다.
      //   cd services/web-cassini && npm install && npm run build
      name: 'web-cassini',
      cwd: service('web-cassini'),
      script: 'server/index.js',
      env: {
        // services/web-cassini/nginx-conf/service.ini 의 ports 와 같아야 한다.
        PORT: 28093,
        NODE_ENV: 'production',
      },
      autorestart: true,
      max_restarts: 10,
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      time: true,
    },
    {
      // WebRTC/IoT 시그널링 릴레이. nginx 가 /relay/* 를 여기로 보낸다
      // (services/websocket-relay/nginx-conf/service.ini).
      //
      // 예전에는 자체 서명 인증서로 스스로 HTTPS 를 열고 tsx 로 .ts 를 직접
      // 실행했다. 지금은 다른 서비스들과 같이 컴파일된 dist 를 돌리고 TLS 는
      // nginx 가 끊는다. 그래서 기동 전에 빌드가 되어 있어야 한다:
      //   cd services/websocket-relay && npm install && npm run build
      //
      // 방(room) 상태를 프로세스 메모리에 들고 있으므로 인스턴스는 하나뿐이다.
      // 여러 개로 늘리면 클라이언트마다 다른 방 테이블을 보게 된다.
      name: 'websocket-relay',
      cwd: service('websocket-relay'),
      script: 'dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        // services/websocket-relay/nginx-conf/service.ini 의 ports 와
        // 같아야 한다. 루프백에만 묶인다.
        PORT: 28090,
        HOST: '127.0.0.1',
        NODE_ENV: 'production',
      },
      autorestart: true,
      max_restarts: 10,
      // 열려 있는 WebSocket 을 정리할 틈을 준다 (index.ts 의 shutdown).
      kill_timeout: 12000,
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      time: true,
    },
  ],
};
