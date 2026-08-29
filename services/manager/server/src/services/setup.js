const path = require('path');
const { execFile } = require('child_process');
const config = require('../config');
const log = require('../logger');
const attest = require('./setup-attest');
const settings = require('./setup-settings');

/**
 * 구축 마법사의 단계 정의와 점검 실행기.
 *
 * 설계는 docs/setup-wizard.md, 점검 출력의 형식은 docs/check-contract.md 에
 * 있습니다. 이 파일은 그 둘을 잇는 곳입니다 — 단계를 데이터로 적어 두고,
 * 각 단계가 가리키는 점검 스크립트를 돌려 `--json` 을 읽습니다.
 *
 * ── 경계 (docs/setup-wizard.md '자식 프로세스를 돌리는 것에 관하여') ──────
 *
 *   1. 실행할 것은 아래 STEPS 에 **박혀 있는 것뿐**입니다. :stepId 는 이 표에서
 *      한 줄을 고르는 데만 쓰고, 문자열을 이어 붙여 명령을 만들지 않습니다.
 *   2. **점검 모드만** 돌립니다. --apply · --install 처럼 무언가를 바꾸는
 *      모드는 마법사가 실행하지 않습니다. sudo 도 부르지 않습니다.
 *   3. 셸을 거치지 않습니다 (execFile). 타임아웃과 출력 상한을 둡니다.
 *   4. 실행 파일은 저장소 안에 있어야 합니다 (아래 resolveCheck).
 */

// 점검이 매달리면 화면이 매달린다.
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * 점검에게 넘길 환경 변수. **process.env 를 그대로 주지 않는다.**
 *
 * manager 는 pm2 가 띄운 프로세스라 **자기 pm2 선언의 [env] 를 달고 있다**.
 * 그것을 자식에게 물려주면 점검이 manager 의 값을 자기 값으로 읽는다.
 *
 * 실제로 그랬다. manager 의 pm2-conf/app.ini 에 `PORT = 28084` 가 있고,
 * websocket-relay 의 doctor 는 PORT 로 자기 /health 주소를 만든다. 그래서
 * 마법사가 부르면 manager 의 /health 를 찔러 보고 "service 가 'manager'
 * 입니다" 라고 보고했다 — **점검은 옳았고 환경이 틀렸다.** 같은 점검을
 * 터미널에서 돌리면 통과했으므로 원인을 짚기도 어려웠다.
 *
 * 그 서비스의 .env 도 이기지 못한다. dotenv 는 이미 있는 값을 덮지 않는다.
 *
 * 그래서 **사람이 터미널에서 돌릴 때 있을 법한 것만** 넘긴다. 점검은 사람이
 * 직접 친 것과 같은 결과를 내야 한다 — 아래 resolveCheck 가 절대 경로 대신
 * 상대 경로로 실행하는 것과 같은 이유다.
 *
 * 여기에 없는 것이 필요한 점검이 생기면, 그 점검이 자기 설정 파일에서 읽게
 * 하는 편이 맞다. 환경 변수로 넘기기 시작하면 이 사고가 되돌아온다.
 */
const ENV_PASSTHROUGH = [
  'PATH',            // node · curl · dig · systemctl · mariadb 를 찾는다
  'HOME',            // pm2 가 ~/.pm2/dump.pm2 를 읽는다
  'USER', 'LOGNAME',
  'LANG', 'LC_ALL', 'LC_MESSAGES',
  'TZ',
  'TERM', 'TMPDIR',
];

function childEnv() {
  const env = {};
  for (const key of ENV_PASSTHROUGH) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

const STATES = new Set(['complete', 'incomplete', 'problem']);
const LEVELS = new Set(['ok', 'skip', 'pending', 'problem']);

/**
 * 단계 정의. 화면에 순서를 박지 않고 여기에 적는다 — 순서는 requires 에서 나온다.
 *
 *   check       점검 스크립트. 셸을 거치지 않으므로 file 과 args 를 나눠 적는다.
 *               interpreter: 'node' 면 node 로 돌린다 (pm2 선언은 셸 스크립트가 아니다).
 *   attest      사람만 확인할 수 있는 것. 있으면 사람의 확인까지 있어야 문이 열린다.
 *   manualOnly  자동 점검이 아예 불가능한 단계 (check 가 없다).
 *   optional    선택 기능. **필수 단계**가 이것을 requires 로 걸지 않는다
 *               (선택 단계끼리는 건다 — 공인 인증서 넷이 그렇다).
 */
const STEPS = [
  {
    id: 'database.schema',
    service: 'database',
    title: 'MariaDB 설치와 스키마 적용',
    why:
      '모든 서비스가 여기에 기댑니다. 특히 Kamailio 는 DB 가 없어도 기동은 되고 ' +
      '인증만 실패합니다 — child_init 에서 붙기 때문에, 화면에는 아무 오류 없이 ' +
      '등록만 안 되는 모양이 됩니다.',
    requires: [],
    command: { cwd: 'database', run: 'sudo ./setup_mariadb.sh', sudo: true },
    check: { cwd: 'database', file: './check-database.sh', args: ['--check', '--json'] },
  },
  {
    id: 'pm2.apps',
    service: 'pm2',
    title: 'pm2 설치와 부팅 등록',
    why:
      'node 서비스들이 여기서 뜹니다. 선언은 services/*/pm2-conf/app.ini 에 있고 ' +
      'ecosystem.config.js 가 그것을 모읍니다. pm2 를 kamailio 그룹 없이 재기동하면 ' +
      '대시보드가 RPC FIFO 를 읽지 못합니다.',
    requires: [],
    command: {
      cwd: 'pm2',
      run: './install_pm2.sh install\npm2 start ecosystem.config.js\npm2 save',
      sudo: true,
    },
    // pm2 선언은 셸 스크립트가 아니라 node 모듈이고, --json 은 이미 다른 뜻으로
    // 쓰이고 있다 (docs/check-contract.md 의 예외).
    check: {
      cwd: 'pm2',
      file: './ecosystem.config.js',
      args: ['--check-json'],
      interpreter: 'node',
    },
  },
  {
    id: 'kamailio.deps',
    service: 'kamailio',
    title: 'Kamailio 패키지·그룹·DB',
    why:
      'SIP 코어가 없으면 Janus 는 할 일이 없습니다. 대시보드가 RPC FIFO 를 읽으려면 ' +
      '실행 계정이 kamailio 그룹에 있어야 하고, 계정 인증에는 DB 비밀번호 파일이 필요합니다.',
    requires: ['database.schema'],
    command: { cwd: 'services/kamailio', run: 'sudo ./bootstrap.sh --install', sudo: true },
    check: { cwd: 'services/kamailio', file: './bootstrap.sh', args: ['--check', '--json'] },
  },
  {
    id: 'kamailio.config',
    service: 'kamailio',
    title: 'Kamailio 설정 포크 설치',
    why:
      '배포본 설정은 digest 인증도, SIP 도메인도, 착신 푸시 훅도 갖고 있지 않습니다. ' +
      '이 저장소의 포크를 설치해야 인터폰과 모바일이 같은 도메인에서 만납니다.',
    requires: ['kamailio.deps'],
    // 장비마다 다른 값 — SIP 도메인·수신 주소·푸시 주소 (settings-schema.json)
    settings: { dir: 'services/kamailio' },
    command: { cwd: 'services/kamailio', run: 'sudo ./install.sh --apply', sudo: true },
    check: { cwd: 'services/kamailio', file: './install.sh', args: ['--check', '--json'] },
  },
  {
    id: 'sip.accounts',
    service: 'kamailio',
    title: 'SIP 계정 만들기 (인터폰)',
    why:
      '**여기서 만들 것은 인터폰 계정뿐입니다.** 모바일(`<세대>01~04`)과 ' +
      '월패드(`<세대>00`)는 websocket-relay 가 승인·등록 때 스스로 만들고 ' +
      '비밀번호도 그때 발급합니다 (docs/identity.md). 인터폰은 사람이 장비에 ' +
      '값을 넣어야 하므로 그 자리만 남습니다. 무엇이 만들어져 있는지는 아래 ' +
      '점검이 보여 주고, **쓸 것이 다 있는지**는 사람이 판단합니다.',
    requires: ['kamailio.config'],
    command: {
      cwd: 'services/kamailio',
      run: "sudo /usr/sbin/kamctl add '<인터폰번호>' '<비밀번호>'\nsudo /usr/sbin/kamctl show",
      sudo: true,
    },
    guide: { text: 'kamailio 대시보드에서도 만들 수 있습니다', href: '/kamailio/' },
    // 무엇이 있는지는 기계가 보여 주고(도메인이 어긋난 계정·비밀번호가 빈 계정도
    // 잡는다), **쓸 것이 다 있는지**는 사람이 판단한다. 그 판단만은 대신할 수 없다.
    //
    // 모바일·월패드가 relay 로 넘어간 뒤에도 이 단계를 남기는 이유는, 인터폰이
    // 없으면 걸 사람이 없기 때문이다 — 그 계정은 여전히 사람이 만든다.
    check: { cwd: 'services/kamailio', file: './check-accounts.sh', args: ['--check', '--json'] },
    attest: { question: '인터폰이 쓸 계정이 위 목록에 있습니까? (모바일·월패드는 relay 가 만듭니다)' },
  },
  {
    id: 'janus.deps',
    service: 'janus',
    title: 'Janus 빌드 의존성',
    why:
      '소스 빌드에 필요한 패키지를 깝니다. 여기서 libsofia-sip-ua-dev 나 ' +
      'libmicrohttpd-dev 가 빠지면 빌드는 성공하는데 SIP 플러그인과 HTTP 트랜스포트가 ' +
      '없는 Janus 가 나옵니다.',
    requires: [],
    command: { cwd: 'services/janus', run: 'sudo ./bootstrap.sh --install', sudo: true },
    check: { cwd: 'services/janus', file: './bootstrap.sh', args: ['--check', '--json'] },
  },
  {
    id: 'janus.build',
    service: 'janus',
    title: 'Janus 소스 빌드',
    why:
      '오래 걸리고 실패 지점이 많아 사람이 보면서 해야 합니다. configure 끝의 요약에서 ' +
      '**SIP plugin 과 REST(HTTP) transport 가 yes** 인지 꼭 보세요 — 아니면 의존성이 ' +
      '빠진 것이고, 그대로 진행하면 다음 단계에서 모듈이 없다고 나옵니다.',
    requires: ['janus.deps'],
    manualOnly: true,
    command: {
      cwd: '~/Public/RetroLink',
      run:
        'git clone https://github.com/meetecho/janus-gateway\n' +
        'cd janus-gateway\n' +
        'sh autogen.sh\n' +
        './configure --prefix=/opt/janus --enable-post-processing --enable-data-channels\n' +
        'make && sudo make install && sudo make configs',
      sudo: true,
    },
    attest: { question: 'configure 요약에서 SIP plugin 과 REST transport 가 yes 였고, make install 이 끝났습니까?' },
  },
  {
    id: 'janus.config',
    service: 'janus',
    title: 'Janus 설정과 systemd 유닛 설치',
    why:
      'Janus 는 배포본 설정 그대로면 SIP 플러그인도 /janus-api 도 뜨지 않습니다. ' +
      'Kamailio 가 먼저 떠 있어야 SIP 쪽이 붙을 상대가 생깁니다.',
    requires: ['janus.build', 'kamailio.config'],
    // 장비마다 다른 값 — 공인 IP·미디어 포트 범위 (settings-schema.json)
    settings: { dir: 'services/janus' },
    command: { cwd: 'services/janus', run: 'sudo ./install.sh --apply', sudo: true },
    check: { cwd: 'services/janus', file: './install.sh', args: ['--check', '--json'] },
  },
  {
    id: 'janus.dashboard',
    service: 'janus',
    title: 'Janus 대시보드 빌드',
    why:
      'janus.js 는 커밋하지 않고 설치된 Janus 것을 복사합니다 — 버전이 어긋나면 ' +
      '조용히 실패하기 때문입니다. 그래서 Janus 를 세운 뒤에 빌드해야 합니다.',
    requires: ['janus.config'],
    command: { cwd: 'services/janus', run: './setup-dashboard.sh --build', sudo: false },
    check: { cwd: 'services/janus', file: './setup-dashboard.sh', args: ['--json'] },
  },
  {
    id: 'nginx.routes',
    service: 'nginx',
    title: 'nginx 라우트 반영',
    why:
      '라우트는 서비스가 뜬 뒤에 반영합니다. 뒤집으면 /janus-api 가 502 로 뜨고 ' +
      '대시보드에는 "중단" 으로 보입니다.',
    requires: ['janus.config', 'pm2.apps'],
    command: { cwd: 'nginx', run: 'sudo ./install_nginx_stack.sh --skip-install', sudo: true },
    check: { cwd: 'nginx', file: './install_nginx_stack.sh', args: ['--check', '--json'] },
  },
  {
    id: 'relay.service',
    service: 'websocket-relay',
    title: 'websocket-relay 설치와 기동',
    why:
      '모바일이 이 게이트웨이와 만나는 유일한 자리입니다 — WebRTC 시그널링도, IoT 도, ' +
      '**착신 푸시(FCM)도 전부 여기를 지납니다.** Kamailio 가 INVITE 를 붙들어 두고 깨우러 ' +
      '가는 상대가 이 서비스이고, 이것이 없으면 자고 있는 단말은 영영 깨지 않습니다. ' +
      '단말을 찾는 표(rtc_mobiles)도 이 서비스가 들고 있습니다.',
    // DB 는 이 서비스의 표가 있는 곳이고, pm2 가 이것을 띄웁니다. nginx 는 /relay/ 를
    // 바깥에 여는 자리 — 셋 다 있어야 doctor 가 통과합니다.
    requires: ['database.schema', 'pm2.apps', 'nginx.routes'],
    command: {
      cwd: 'services/websocket-relay',
      run:
        'npm install\n' +
        'npm run setup        # .env 를 만든다 (물어보는 값들이 있다)\n' +
        'npm run db:migrate\n' +
        'npm run web:build\n' +
        'npm start            # pm2 등록 + pm2 save',
      sudo: false,
    },
    guide: { text: '이 서비스의 대시보드', href: '/relay/dashboard' },
    // 점검은 npm run doctor 가 하는 그것입니다. 껍데기를 한 겹 두른 이유는
    // check-relay.sh 머리말에 있습니다 (node_modules 가 없으면 doctor 는
    // 실행조차 되지 않습니다).
    check: { cwd: 'services/websocket-relay', file: './check-relay.sh', args: ['--check', '--json'] },
  },
  {
    id: 'janus.verify.call',
    service: 'janus',
    title: '시험 통화',
    why:
      '"연결됨인데 소리가 안 난다" 가 이 게이트웨이에서 가장 자주 만나는 실패 모양입니다. ' +
      'verify-call.sh 는 헤드리스 크롬으로 실제 통화를 걸어 **RTP 가 양방향으로 왔는지** ' +
      '패킷 수로 판정합니다. 마법사는 그 통화를 대신 걸지 않고, ' +
      '**--run 이 남긴 결과 파일**을 읽어 판정합니다.',
    requires: ['janus.config', 'sip.accounts'],
    command: { cwd: 'services/janus', run: './verify-call.sh --run', sudo: false },
    // 마법사는 90초짜리 통화를 대신 돌리지 않는다. 대신 **--run 이 남긴 결과
    // 파일을 읽는다** — 사람의 확인 기록보다 낫다. 주장이 아니라 증거이고,
    // 언제 돌렸는지도 함께 남아 설정이 바뀐 뒤인지까지 가릴 수 있다.
    check: { cwd: 'services/janus', file: './verify-call.sh', args: ['--check', '--json'] },
  },
  {
    id: 'janus.publicip',
    service: 'janus',
    title: '외부 브라우저에서 붙기 (선택)',
    why:
      '집 밖에서 붙으려면 광고하는 공인 IP 가 실제 값과 같아야 하고, 공유기에 미디어 ' +
      '포트가 열려 있어야 합니다. 앞의 것은 기계가 보고, 포워딩은 사람이 확인합니다.',
    requires: ['nginx.routes'],
    optional: true,
    command: { cwd: 'services/janus', run: './check-public-ip.sh', sudo: false },
    check: { cwd: 'services/janus', file: './check-public-ip.sh', args: ['--json'] },
    attest: { question: '공유기에 UDP 20000-20200 · 30000-30200 포워딩을 열었습니까?' },
  },
  {
    id: 'push.incoming',
    service: 'kamailio',
    title: '인터폰 착신 푸시 (선택)',
    why:
      '자고 있는 모바일로 인터폰이 걸 때, INVITE 를 붙들어 두고(tsilo) FCM 으로 단말을 ' +
      '깨워 그 연결로 흘려보냅니다. 네 자리 중 하나만 비어도 아무 일도 일어나지 않습니다.',
    // 깨우러 갈 상대가 relay.service 다. 그것이 서 있어야 이 단계가 의미를 갖는다
    // (relay.service 가 nginx.routes 를 이미 걸고 있으므로 여기서는 겹쳐 적지 않는다).
    requires: ['sip.accounts', 'relay.service'],
    optional: true,
    command: { cwd: 'services/kamailio', run: 'sudo ./install.sh --apply', sudo: true },
    check: { cwd: 'services/kamailio', file: './check-push.sh', args: ['--check', '--json'] },
  },
  // ── 공인 인증서 (Let's Encrypt) ─────────────────────────────────────
  //
  // 사설 CA(nginx/generate_certs.sh)로도 TLS 는 돕니다. 아래 넷은 그것을
  // **공인 인증서로 옮기는** 절차입니다 — 앱이 CA 를 미리 심지 않아도 되게.
  //
  // 넷 다 선택으로 둡니다. LAN 전용 설치는 사설 CA 로 계속 도는 것이 옳고,
  // 공인 이름을 받을 수 없는 배치(도메인 없음·80 포트 막힘)도 있기 때문입니다.
  // 배포용에서는 넷 다 해야 하고, 안 끝났다는 사실은 대시보드의 TLS 카드가
  // 사설 CA 를 계속 warn 으로 두어 잊히지 않게 합니다.
  {
    id: 'public_ca.issue',
    service: 'nginx',
    title: "공인 인증서 발급 (Let's Encrypt)",
    why:
      '사설 CA 는 단지마다 CA 를 운영하고 앱마다 그것을 심어야 합니다. 공인 인증서로 ' +
      '옮기면 앱의 커스텀 TrustManager 가 통째로 없어지고, 갱신은 90일마다 certbot 이 ' +
      '알아서 합니다. **staging 을 건너뛰지 마세요** — 같은 이름 조합에 주 5건 제한이 ' +
      '있고, 설정을 더듬다 보면 놀랄 만큼 빨리 소진됩니다. 한 번 걸리면 일주일을 ' +
      '기다립니다.',
    // HTTP-01 챌린지는 반드시 80 으로 들어오는데, 80 은 전부 HTTPS 로 301 합니다.
    // 그 예외(acme_webroot)를 만드는 것이 nginx.routes 입니다. 뒤집으면 챌린지가
    // 301 로 튕겨 발급이 통과하지 못합니다.
    requires: ['nginx.routes'],
    optional: true,
    // 장비·단지마다 다른 값 — 도메인·알림 메일 (settings-schema.json)
    settings: { dir: 'nginx/public_ca' },
    command: {
      cwd: 'nginx/public_ca',
      run:
        './setup_letsencrypt.sh --check\n' +
        'sudo ./setup_letsencrypt.sh --staging\n' +
        'sudo ./setup_letsencrypt.sh --prod',
      sudo: true,
    },
    check: { cwd: 'nginx/public_ca', file: './setup_letsencrypt.sh', args: ['--check', '--json'] },
  },
  {
    id: 'public_ca.nginx',
    service: 'nginx',
    title: '발급받은 인증서를 nginx 에 물리기',
    why:
      '**발급받은 것과 내밀고 있는 것은 다릅니다.** nginx-stack.conf 의 [tls] 를 바꾸고 ' +
      '반영해야 바뀝니다. 그리고 `cert.pem` 이 아니라 **`fullchain.pem`** 입니다 — 중간 ' +
      '인증서가 빠지면 브라우저는 멀쩡한데 일부 안드로이드 기기에서만 실패하는, 찾기 아주 ' +
      '어려운 버그가 납니다. 점검은 파일이 아니라 **실제 접속해서** 무엇이 나가고 있는지 ' +
      '읽습니다.',
    requires: ['public_ca.issue'],
    optional: true,
    command: {
      cwd: 'nginx',
      run:
        '# nginx-stack.conf 의 [tls] 를 이렇게 바꾼 뒤 반영합니다.\n' +
        '#   cert_file = /etc/letsencrypt/live/<도메인>/fullchain.pem\n' +
        '#   key_file  = /etc/letsencrypt/live/<도메인>/privkey.pem\n' +
        '# 절대경로여도 됩니다 — 생성기가 cert_dir 을 무시합니다.\n' +
        'sudo ./install_nginx_stack.sh --skip-install',
      sudo: true,
    },
    check: { cwd: 'nginx/public_ca', file: './cert-status.sh', args: ['--check', '--json'] },
  },
  {
    id: 'public_ca.renew',
    service: 'nginx',
    title: '90일 자동 갱신',
    why:
      'certbot 은 설치될 때 자기 systemd 타이머를 함께 깝니다 — 유닛을 만들 필요가 ' +
      '없습니다. 문제는 **갱신 훅**입니다. 그것이 없으면 certbot 이 조용히 갱신해 두어도 ' +
      'nginx 는 메모리에 올린 옛 인증서를 계속 내밉니다. 파일은 최신인데 접속은 만료로 ' +
      '끊기는, 원인을 찾기 아주 어려운 상태가 됩니다. 셋 다 **터지기 전에는 아무 증상이 ' +
      '없어서** 만료를 기다리지 않고 지금 물어봅니다.',
    requires: ['public_ca.nginx'],
    optional: true,
    command: {
      cwd: 'nginx/public_ca',
      run:
        '# 타이머가 꺼져 있을 때만. 발급이 훅까지 함께 걸어 둡니다.\n' +
        'sudo systemctl enable --now certbot.timer\n' +
        '# 실제로 갱신되는지 미리 돌려 봅니다 (rate limit 을 쓰지 않습니다).\n' +
        'sudo certbot renew --dry-run',
      sudo: true,
    },
    check: { cwd: 'nginx/public_ca', file: './renew-status.sh', args: ['--check', '--json'] },
  },
  {
    id: 'public_ca.dns',
    service: 'nginx',
    title: '이름이 아직 이 서버를 가리키나',
    why:
      '이 회선은 유동 IP 인데 A 레코드는 등록기관에 고정값으로 들어 있고, 따라가는 장치가 ' +
      '없습니다. 어긋나면 앱이 **즉시, 전면** 못 붙고, certbot 갱신도 만료 30일 전부터 ' +
      '조용히 실패합니다. 앞엣것이 즉시 터지니 알아차리기는 하는데 **왜인지 모르는** ' +
      '상태가 됩니다. 이 점검이 그 답을 한 줄로 줍니다.',
    requires: ['public_ca.nginx'],
    optional: true,
    command: {
      cwd: 'nginx/public_ca',
      run:
        '# IP 가 바뀌면 등록기관에서 A 레코드를 고칩니다. TTL 이 600초라 10분 안에 퍼집니다.\n' +
        '# 크론에 걸어 두면 사람보다 먼저 압니다 (경로는 절대경로로):\n' +
        '#   */10 * * * * .../nginx/public_ca/check-dns.sh --quiet || echo "DNS 가 이 서버를 가리키지 않습니다" | logger -t dns-drift\n' +
        './check-dns.sh',
      sudo: false,
    },
    check: { cwd: 'nginx/public_ca', file: './check-dns.sh', args: ['--check', '--json'] },
  },
];

const byId = new Map(STEPS.map((s) => [s.id, s]));

// 마지막 점검 결과. **메모리에만 둡니다** — 진행률을 저장하면 실물과 어긋나기
// 시작합니다 (docs/setup-wizard.md '상태를 최소로 둡니다'). 재기동하면 비고,
// 화면이 들어올 때 다시 점검합니다.
//
// 사람의 확인 기록만 파일에 남습니다 (setup-attest.js) — 그것은 매번 다시
// 물어볼 수 없는 것이기 때문입니다.
const lastResults = new Map();

// 같은 단계를 두 번 겹쳐 돌리지 않는다.
const inFlight = new Map();

function find(stepId) {
  return byId.get(stepId) || null;
}

/** 실행할 파일과 작업 디렉터리를 저장소 안으로 한정해 만든다. */
function resolveCheck(step) {
  const cwd = path.resolve(config.repoRoot, step.check.cwd);
  const script = path.resolve(cwd, step.check.file);

  const root = config.repoRoot.endsWith(path.sep) ? config.repoRoot : `${config.repoRoot}${path.sep}`;
  if (!script.startsWith(root) || !cwd.startsWith(root)) {
    throw new Error(`check path escapes repo root: ${script}`);
  }

  // 실행은 **상대 경로로** 한다. 경계 검사는 위에서 절대 경로로 했고, 상대
  // 경로로 돌리면 스크립트가 내는 안내가 사람이 터미널에 치는 모양 그대로
  // 나온다 ($0 = ./install.sh). 절대 경로로 돌리면 그 안내가
  // "sudo /home/…/install.sh --apply" 가 되어 읽기 나쁘다.
  //
  // POSIX 의 exec 는 슬래시가 든 경로를 **자식의 cwd 기준**으로 푼다.
  if (step.check.interpreter === 'node') {
    // node 로 도는 것은 인터프리터를 앞에 세운다. 지금 도는 node 를 그대로 쓴다
    // (PATH 의 node 가 다른 판일 수 있다).
    return { cwd, file: process.execPath, args: [step.check.file, ...step.check.args] };
  }
  return { cwd, file: step.check.file, args: step.check.args };
}

/** 화면에 보여 줄 점검 명령. 실행은 위 정의로만 한다. */
function checkCommandText(step) {
  if (!step.check) return null;
  const prefix = step.check.interpreter === 'node' ? 'node ' : '';
  return `${prefix}${path.join(step.check.cwd, step.check.file)} ${step.check.args.join(' ')}`;
}

/**
 * checks 에서 판정을 다시 계산한다. docs/check-contract.md 의 규칙 그대로다.
 *
 * 스크립트가 낸 state 를 그냥 믿지 않는 이유: 화면이 "완료" 라고 말하는데
 * 실제로는 problem 줄이 섞여 있는 상태를 만들지 않기 위해서다. 어긋나면
 * 엄한 쪽(여기서 계산한 것)을 쓴다.
 */
function deriveState(checks) {
  if (checks.some((c) => c.level === 'problem')) return 'problem';
  if (checks.some((c) => c.level === 'pending')) return 'incomplete';
  return 'complete';
}

/** stdout 한 덩어리를 규약대로 읽는다. 읽지 못하면 null 을 돌려준다. */
function parseReport(stdout) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.checks)) return null;

  const checks = [];
  for (const entry of data.checks) {
    if (!entry || typeof entry !== 'object') continue;
    const level = LEVELS.has(entry.level) ? entry.level : null;
    if (!level) return null; // 모르는 레벨이 있으면 판정하지 않는다
    checks.push({ level, text: String(entry.text ?? '') });
  }

  return {
    step: typeof data.step === 'string' ? data.step : '',
    state: STATES.has(data.state) ? data.state : null,
    checks,
  };
}

function runScript(step) {
  const { cwd, file, args } = resolveCheck(step);

  return new Promise((resolve) => {
    const startedAt = Date.now();

    execFile(
      file,
      args,
      {
        cwd,
        timeout: step.check.timeoutMs || DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        killSignal: 'SIGKILL',
        // manager 의 pm2 [env] 가 새어 들어가지 않게 추린다 (위 ENV_PASSTHROUGH).
        env: childEnv(),
      },
      (err, stdout, stderr) => {
        resolve({
          // 점검이 문제를 찾으면 종료 코드가 1 이다. 그것은 실패가 아니라 결과다.
          exitCode: err ? (typeof err.code === 'number' ? err.code : null) : 0,
          timedOut: Boolean(err && err.killed),
          spawnError: err && typeof err.code === 'string' ? err.code : null,
          stdout: stdout || '',
          stderr: (stderr || '').trim(),
          durationMs: Date.now() - startedAt,
        });
      }
    );
  });
}

/**
 * 한 단계를 점검한다. 결과는 늘 같은 모양이다.
 *
 *   state : complete | incomplete | problem | unknown
 *
 * `unknown` 은 **점검을 하지 못했다**는 뜻이다 (스크립트가 없거나, 매달렸거나,
 * 출력을 읽지 못했거나). 통과로도 실패로도 위장하지 않는다 — 화면은 이것을
 * 보고 다음 단계를 열지 않는다.
 */
async function check(stepId) {
  const step = find(stepId);
  if (!step) throw new Error(`unknown step: ${stepId}`);
  if (!step.check) throw new Error(`step has no check: ${stepId}`);

  if (inFlight.has(stepId)) return inFlight.get(stepId);

  const promise = (async () => {
    let run;
    try {
      run = await runScript(step);
    } catch (err) {
      log.error(`setup check ${stepId} could not start: ${err.message}`);
      return record(stepId, {
        state: 'unknown',
        checks: [],
        error: `점검을 실행하지 못했습니다: ${err.message}`,
        exitCode: null,
        durationMs: 0,
      });
    }

    const base = { exitCode: run.exitCode, durationMs: run.durationMs };

    if (run.timedOut) {
      log.warn(`setup check ${stepId} timed out`);
      return record(stepId, {
        ...base,
        state: 'unknown',
        checks: [],
        error: `점검이 ${Math.round((step.check.timeoutMs || DEFAULT_TIMEOUT_MS) / 1000)}초 안에 끝나지 않았습니다.`,
      });
    }

    if (run.spawnError) {
      return record(stepId, {
        ...base,
        state: 'unknown',
        checks: [],
        error: `점검 스크립트를 실행할 수 없습니다 (${run.spawnError}): ${path.join(step.check.cwd, step.check.file)}`,
      });
    }

    const report = parseReport(run.stdout);
    if (!report) {
      log.warn(`setup check ${stepId}: unreadable --json output`);
      return record(stepId, {
        ...base,
        state: 'unknown',
        checks: [],
        error: '점검 출력을 읽지 못했습니다. --json 이 JSON 한 덩어리만 내는지 확인하세요.',
        stderr: run.stderr || null,
      });
    }

    // step id 가 다르면 우리가 다른 것을 돌린 것이다. 결과를 붙이지 않는다.
    if (report.step && report.step !== stepId) {
      return record(stepId, {
        ...base,
        state: 'unknown',
        checks: report.checks,
        error: `이 스크립트는 다른 단계를 보고했습니다: "${report.step}"`,
      });
    }

    const derived = deriveState(report.checks);
    if (report.state && report.state !== derived) {
      log.warn(`setup check ${stepId}: reported "${report.state}" but checks derive "${derived}"`);
    }

    return record(stepId, {
      ...base,
      state: derived,
      checks: report.checks,
      error: null,
      stderr: run.stderr || null,
    });
  })().finally(() => inFlight.delete(stepId));

  inFlight.set(stepId, promise);
  return promise;
}

function record(stepId, result) {
  const full = { stepId, ranAt: new Date().toISOString(), ...result };
  lastResults.set(stepId, full);
  return full;
}

/**
 * 한 단계의 상태. 점검 결과와 사람의 확인을 합친다.
 *
 *   complete    기계가 다 됐다고 본 것
 *   attested    **사람이 확인한 것.** 기계로는 확인되지 않았다 — 통과로 위장하지
 *               않되, 다음 단계는 열어 준다 (아니면 마법사가 여기서 멈춘다)
 *   incomplete  아직 남은 것이 있다 (사람의 확인이 아직 없는 경우 포함)
 *   problem     어긋난 것이 있다
 *   unknown     점검을 마치지 못했다
 *   null        아직 점검하지 않았다
 *
 * 사람의 확인이 점검을 이기지 못한다는 것이 중요하다 — 점검이 problem 이면
 * 확인 기록이 있어도 problem 이다.
 */
function stepState(step, result, attestation) {
  if (step.manualOnly) return attestation ? 'attested' : null;
  if (!result) return null;
  if (result.state !== 'complete') return result.state;
  if (step.attest) return attestation ? 'attested' : 'incomplete';
  return 'complete';
}

function isPassed(state) {
  return state === 'complete' || state === 'attested';
}

/**
 * 단계 정의 + 마지막 점검 결과 + 사람의 확인 기록.
 *
 * 잠금(blockedBy)은 **여기 한 곳에서만** 계산한다. 화면이 따로 계산하면 규칙이
 * 두 곳이 된다.
 */
function overview() {
  const attestations = attest.readAll();
  const states = new Map();

  const steps = STEPS.map((step) => {
    const result = lastResults.get(step.id) || null;
    const attestation = attestations[step.id] || null;
    const state = stepState(step, result, attestation);
    states.set(step.id, state);

    return {
      id: step.id,
      service: step.service,
      title: step.title,
      why: step.why,
      requires: step.requires,
      optional: Boolean(step.optional),
      manualOnly: Boolean(step.manualOnly),
      command: step.command || null,
      guide: step.guide || null,
      attest: step.attest || null,
      attestation,
      checkCommand: checkCommandText(step),
      checkCwd: step.check ? step.check.cwd : null,
      // 파라미터 폼. 판정에는 들어가지 않는다 — '저장했는데 아직 반영 안 됨' 은
      // 점검 스크립트가 직접 보고 pending 으로 낸다 (규칙을 한 곳에 둔다).
      settings: settings.read(step),
      state,
      result,
    };
  });

  for (const step of steps) {
    step.blockedBy = step.requires.filter((id) => !isPassed(states.get(id)));
  }

  const passed = steps.filter((s) => isPassed(s.state));

  return {
    steps,
    total: steps.length,
    complete: passed.length,
    required: {
      total: steps.filter((s) => !s.optional).length,
      complete: passed.filter((s) => !s.optional).length,
    },
    attestFile: attest.file,
    updatedAt: new Date().toISOString(),
  };
}

module.exports = { STEPS, find, check, overview, deriveState, parseReport, stepState, isPassed, saveSettings: settings.save };
