const path = require('path');
const { execFile } = require('child_process');
const config = require('../config');
const log = require('../logger');

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

// 점검이 매달리면 화면이 매달린다. 지금 붙인 것들은 모두 0.2초 안에 끝나지만,
// verify-call.sh 처럼 오래 걸리는 것이 3단계에서 들어온다 (열린 질문 1).
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

const STATES = new Set(['complete', 'incomplete', 'problem']);
const LEVELS = new Set(['ok', 'skip', 'pending', 'problem']);

/**
 * 단계 정의. 화면에 순서를 박지 않고 여기에 적는다 — 순서는 requires 에서 나온다.
 *
 * 2단계 범위: 뼈대를 확인하는 세 단계만 둔다 (kamailio · janus · nginx).
 * 13단계 전부와 manualOnly 는 3단계에서 붙인다.
 */
const STEPS = [
  {
    id: 'kamailio.deps',
    service: 'kamailio',
    title: 'Kamailio 패키지·그룹·DB',
    why:
      'SIP 코어가 없으면 Janus 는 할 일이 없습니다. 대시보드가 RPC FIFO 를 읽으려면 ' +
      '실행 계정이 kamailio 그룹에 있어야 하고, 계정 인증에는 DB 비밀번호 파일이 필요합니다.',
    requires: [],
    command: { cwd: 'services/kamailio', run: 'sudo ./bootstrap.sh --install', sudo: true },
    check: { cwd: 'services/kamailio', file: './bootstrap.sh', args: ['--check', '--json'] },
  },
  {
    id: 'janus.config',
    service: 'janus',
    title: 'Janus 설정과 systemd 유닛 설치',
    why:
      'Janus 는 배포본 설정 그대로면 SIP 플러그인도 /janus-api 도 뜨지 않습니다. ' +
      'Kamailio 가 먼저 떠 있어야 SIP 쪽이 붙을 상대가 생깁니다.',
    requires: ['kamailio.deps'],
    command: { cwd: 'services/janus', run: 'sudo ./install.sh --apply', sudo: true },
    check: { cwd: 'services/janus', file: './install.sh', args: ['--check', '--json'] },
  },
  {
    id: 'nginx.routes',
    service: 'nginx',
    title: 'nginx 라우트 반영',
    why:
      '라우트는 서비스가 뜬 뒤에 반영합니다. 뒤집으면 /janus-api 가 502 로 뜨고 ' +
      '대시보드에는 "중단" 으로 보입니다.',
    requires: ['janus.config'],
    command: { cwd: 'nginx', run: 'sudo ./install_nginx_stack.sh --skip-install', sudo: true },
    check: { cwd: 'nginx', file: './install_nginx_stack.sh', args: ['--check', '--json'] },
  },
];

const byId = new Map(STEPS.map((s) => [s.id, s]));

// 마지막 점검 결과. **메모리에만 둡니다** — 진행률을 저장하면 실물과 어긋나기
// 시작합니다 (docs/setup-wizard.md '상태를 최소로 둡니다'). 재기동하면 비고,
// 화면이 들어올 때 다시 점검합니다.
const lastResults = new Map();

// 같은 단계를 두 번 겹쳐 돌리지 않는다. 화면 여럿이 동시에 열려 있어도
// 자식 프로세스는 하나만 뜬다.
const inFlight = new Map();

function find(stepId) {
  return byId.get(stepId) || null;
}

/** 실행할 파일과 작업 디렉터리를 저장소 안으로 한정해 만든다. */
function resolveCheck(step) {
  const cwd = path.resolve(config.repoRoot, step.check.cwd);
  const file = path.resolve(cwd, step.check.file);

  const root = config.repoRoot.endsWith(path.sep) ? config.repoRoot : `${config.repoRoot}${path.sep}`;
  if (!file.startsWith(root) || !cwd.startsWith(root)) {
    throw new Error(`check path escapes repo root: ${file}`);
  }
  return { cwd, file };
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
  const { cwd, file } = resolveCheck(step);

  return new Promise((resolve) => {
    const startedAt = Date.now();

    execFile(
      file,
      step.check.args,
      {
        cwd,
        timeout: step.check.timeoutMs || DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        killSignal: 'SIGKILL',
        env: process.env,
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
 * 단계 정의 + 마지막 점검 결과. 결과가 없으면 result 는 null 이고, 화면은
 * "아직 점검하지 않음" 으로 그린다.
 *
 * 잠금(blockedBy)은 **점검 결과에서만** 나온다. 앞 단계가 complete 가 아니면
 * 다음 단계는 열리지 않는다 — 사람이 누른 것은 판정에 들어가지 않는다.
 */
function overview() {
  const steps = STEPS.map((step) => {
    const result = lastResults.get(step.id) || null;
    const blockedBy = step.requires.filter((id) => lastResults.get(id)?.state !== 'complete');

    return {
      id: step.id,
      service: step.service,
      title: step.title,
      why: step.why,
      requires: step.requires,
      manualOnly: Boolean(step.manualOnly),
      command: step.command,
      // 무엇을 돌리는지 화면에서도 보이게 한다. 실행은 위 정의로만 한다.
      checkCommand: `${step.check.file} ${step.check.args.join(' ')}`,
      checkCwd: step.check.cwd,
      blockedBy,
      result,
    };
  });

  return {
    steps,
    total: steps.length,
    complete: steps.filter((s) => s.result?.state === 'complete').length,
    updatedAt: new Date().toISOString(),
  };
}

module.exports = { STEPS, find, check, overview, deriveState, parseReport };
