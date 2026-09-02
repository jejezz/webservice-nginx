const { execFile } = require('child_process');
const { promisify } = require('util');
const log = require('../logger');

const execFileAsync = promisify(execFile);

async function run(cmd, args) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 5000 });
    return { ok: true, out: `${stdout}${stderr}`.trim() };
  } catch (err) {
    // systemctl is-active는 비활성 상태일 때 종료 코드가 0이 아니므로 stdout을 그대로 쓴다.
    return { ok: false, out: `${err.stdout || ''}${err.stderr || ''}`.trim() || err.message };
  }
}

/**
 * systemd 타임스탬프("Fri 2026-08-14 05:58:01 KST")를 Date로 변환한다.
 * systemd 249에는 --timestamp=unix가 없고 요일/타임존 약어가 붙은 문자열은
 * Date가 파싱하지 못하므로 날짜·시각 부분만 뽑아 로컬 시간으로 해석한다.
 */
function parseSystemdTimestamp(value) {
  const m = String(value || '').match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);
  if (!m) return null;

  const date = new Date(`${m[1]}T${m[2]}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseShow(text) {
  const props = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) props[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return props;
}

/**
 * systemd에서 Nginx 서비스 상태를 읽는다. (읽기 전용이라 sudo 불필요)
 */
async function status() {
  const [active, show, version] = await Promise.all([
    run('systemctl', ['is-active', 'nginx']),
    run('systemctl', [
      'show',
      'nginx',
      '--property=ActiveState,SubState,MainPID,ExecMainStartTimestamp,NRestarts',
    ]),
    run('nginx', ['-v']),
  ]);

  const props = parseShow(show.out);
  const validStart = parseSystemdTimestamp(props.ExecMainStartTimestamp);

  if (!show.ok) log.warn(`systemctl show nginx failed: ${show.out}`);

  return {
    active: active.out === 'active',
    state: props.ActiveState || active.out || 'unknown',
    subState: props.SubState || null,
    mainPid: props.MainPID && props.MainPID !== '0' ? Number(props.MainPID) : null,
    startedAt: validStart ? validStart.toISOString() : null,
    uptimeSec: validStart ? Math.floor((Date.now() - validStart.getTime()) / 1000) : null,
    restarts: props.NRestarts ? Number(props.NRestarts) : null,
    // `nginx -v`는 버전을 stderr로 출력한다.
    version: (version.out.match(/nginx\/([\d.]+)/) || [])[1] || null,
  };
}

module.exports = { status };
