/**
 * systemd 저널 읽기 — 대시보드가 서비스 로그를 보여 주기 위한 것.
 *
 * ── 왜 필요한가 ─────────────────────────────────────────────────────────
 *
 * node 서비스는 pm2 가 로그를 파일로 남깁니다 (`pm2 logs`, `pm2/logs/*.log`).
 * 그런데 **janus 와 kamailio 는 systemd 가 띄웁니다.** 로그가 저널에만 있어서,
 * 그 둘만 "로그를 어떻게 보지?" 가 됩니다. 대시보드가 그 자리를 메웁니다.
 *
 * ── 경계 ────────────────────────────────────────────────────────────────
 *
 *   1. **유닛 이름은 부르는 쪽이 박아 넣습니다.** 사람 입력에서 만들지 않습니다.
 *   2. 읽기만 합니다. journalctl 에 주는 것은 --unit / -n / --grep / --since 뿐입니다.
 *   3. 셸을 거치지 않습니다 (execFile). 타임아웃과 출력 상한을 둡니다.
 *   4. **sudo 를 부르지 않습니다.** 프로세스가 adm(또는 systemd-journal) 그룹에
 *      있어야 읽힙니다. 못 읽으면 그 사실을 그대로 돌려줍니다 — 빈 화면으로
 *      두면 "로그가 없다" 로 오해합니다.
 */
const { execFile } = require('child_process');

const DEFAULT_LINES = 200;
const MAX_LINES = 2000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 10000;

function clampLines(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return DEFAULT_LINES;
  return Math.min(Math.max(n, 1), MAX_LINES);
}

/**
 * @param unit    systemd 유닛 이름. **호출하는 쪽이 정한다** (예: 'janus')
 * @param options lines · grep(정규식) · minutes(최근 N분만)
 */
function read(unit, options = {}) {
  const lines = clampLines(options.lines);
  const args = ['--unit', unit, '--no-pager', '--output', 'short-iso', '-n', String(lines)];

  // 사람이 넣는 값은 둘뿐이고, 셸을 거치지 않으므로 인자 하나로 그대로 들어간다.
  const grep = String(options.grep ?? '').trim();
  if (grep) args.push('--grep', grep.slice(0, 200));

  const minutes = parseInt(options.minutes, 10);
  if (Number.isFinite(minutes) && minutes > 0) args.push('--since', `${Math.min(minutes, 43200)} min ago`);

  return new Promise((resolve) => {
    execFile(
      'journalctl',
      args,
      { timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          const message = (stderr || err.message || '').trim();
          // 권한 문제와 그 밖의 실패를 가른다 — 사람이 할 일이 다르다.
          const denied = /permission|access|not.*allowed/i.test(message);
          return resolve({
            ok: false,
            unit,
            lines: [],
            error: message || 'journalctl 을 실행하지 못했습니다',
            denied,
          });
        }

        const out = String(stdout || '')
          .split('\n')
          .filter((line) => line.length > 0);

        resolve({
          ok: true,
          unit,
          lines: out,
          // 필터가 걸린 채 비어 있는 것과 정말 로그가 없는 것은 다르다.
          filtered: Boolean(grep) || Boolean(minutes),
          error: null,
          denied: false,
        });
      }
    );
  });
}

module.exports = { read, DEFAULT_LINES, MAX_LINES };
