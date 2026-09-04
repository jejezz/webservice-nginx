/**
 * coturn 상태 읽기 — systemctl · dpkg · 설정 파일 비교뿐입니다.
 *
 * ── 왜 CLI 를 쓰지 않는가 ─────────────────────────────────────────────────
 *
 * coturn 은 telnet 기반 관리 CLI(기본 포트 5766)를 갖고 있고, 그걸 쓰면
 * 지금 몇 개의 세션·릴레이 할당이 떠 있는지까지 볼 수 있습니다. 그런데
 * 그러려면 turnserver.conf 에 cli-password 를 심고 그 포트를 열어야 하는데,
 * 그 문은 세션을 강제로 끊을 수도 있는 관리 채널입니다 — Janus 의 Admin
 * API 와 같은 성격입니다. 이 서비스는 **읽기 전용 관찰자**로 v1 을 잡았고
 * (kamailio-dashboard 가 재시작·설정 변경 없이 FIFO 로만 읽는 것과 같은
 * 판단), 세션 개수 하나를 보여주자고 관리 채널을 여는 것은 배보다 배꼽이
 * 크다고 판단해 아예 껐습니다 (turnserver.conf 의 no-cli).
 *
 * 그래서 이 모듈은 **가짜 데이터를 만들지 않습니다.** 세션·할당 개수는
 * 이 화면 어디에도 없습니다 — CLI 를 열기로 마음이 바뀌면 이 파일에
 * cli 접속 함수를 추가하고 turnserver.conf 의 no-cli 를 지우세요.
 */
const fs = require('fs');
const { execFile } = require('child_process');
const config = require('./config');

const EXEC_TIMEOUT_MS = 5000;

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: EXEC_TIMEOUT_MS }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** dpkg 상태로 패키지가 설치돼 있는지 본다. apt 를 건드리지 않는다. */
async function packageInstalled() {
  const { code, stdout } = await run('dpkg-query', ['-W', '-f=${Status}', 'coturn']);
  return code === 0 && /install ok installed/.test(stdout);
}

/** systemctl is-active 그대로. 'active' · 'inactive' · 'failed' · 'unknown' */
async function serviceState() {
  const { stdout } = await run('systemctl', ['is-active', config.UNIT_NAME]);
  return stdout.trim() || 'unknown';
}

async function serviceEnabled() {
  const { code } = await run('systemctl', ['is-enabled', '--quiet', config.UNIT_NAME]);
  return code === 0;
}

/** /etc/default/coturn 의 TURNSERVER_ENABLED=1 인지. 배포판 기본은 꺼짐이다. */
function defaultFileEnabled() {
  try {
    const text = fs.readFileSync(config.DEFAULT_FILE, 'utf8');
    return /^[ \t]*TURNSERVER_ENABLED[ \t]*=[ \t]*1/m.test(text);
  } catch {
    return false;
  }
}

/**
 * 설치본이 저장소 원본과 같은가 — lib/config-diff.sh 와 같은 발상을 JS 로
 * 옮긴 것입니다. 자리표시자가 채워지는 줄은 키 기준으로 눌러 비교하고,
 * install.sh 가 통째로 지울 수 있는 줄(external-ip)은 양쪽에서 뺍니다.
 *
 * 셸 스크립트의 config-diff.sh 를 그대로 불러 쓰지 않는 이유는 이 프로세스가
 * 이미 Node 이고, 여기서 보는 것은 "같다/다르다" 하나뿐이라 셸을 fork 하는
 * 것보다 직접 읽는 편이 간단하기 때문입니다. 판정 기준(어떤 줄을 누르고
 * 빼는가)은 install.sh 의 report_config_diff 호출과 반드시 같게 유지해야
 * 합니다 — 둘이 갈리면 대시보드와 install.sh 의 점검이 서로 다른 말을 하게
 * 됩니다.
 */
function maskLine(line) {
  if (/^static-auth-secret=/.test(line)) return 'static-auth-secret=«';
  if (/^realm=/.test(line)) return 'realm=«';
  if (/^listening-port=/.test(line)) return 'listening-port=«';
  if (/^min-port=/.test(line)) return 'min-port=«';
  if (/^max-port=/.test(line)) return 'max-port=«';
  return line;
}

function renderLines(text) {
  return text
    .split('\n')
    .filter((l) => !/external-ip/.test(l))
    .map(maskLine);
}

function configDiff() {
  let template;
  try {
    template = fs.readFileSync(config.TEMPLATE_CONFIG, 'utf8');
  } catch {
    return { state: 'no-template' };
  }

  let installed;
  try {
    installed = fs.readFileSync(config.INSTALLED_CONFIG, 'utf8');
  } catch (err) {
    return { state: err.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }

  const want = renderLines(template).join('\n');
  const have = renderLines(installed).join('\n');
  return want === have ? { state: 'same' } : { state: 'differs' };
}

function staticAuthSecretPresent() {
  try {
    const stat = fs.statSync(config.STATIC_AUTH_SECRET_FILE);
    return stat.size > 0;
  } catch {
    return false;
  }
}

async function status() {
  const [installed, active, enabled] = await Promise.all([
    packageInstalled(),
    serviceState(),
    serviceEnabled(),
  ]);

  return {
    packageInstalled: installed,
    serviceState: active,
    serviceEnabled: enabled,
    defaultFileEnabled: defaultFileEnabled(),
    config: configDiff(),
    staticAuthSecretPresent: staticAuthSecretPresent(),
  };
}

module.exports = { status, packageInstalled, serviceState, serviceEnabled, defaultFileEnabled, configDiff, staticAuthSecretPresent };
