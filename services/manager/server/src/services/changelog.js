const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const config = require('../config');

const execFileAsync = promisify(execFile);

// 레코드/필드 구분자로 쓴다 — 커밋 메시지에 나올 일이 없는 제어 문자라
// 콜론·파이프 같은 걸 구분자로 쓸 때 생기는 오염이 없다.
const RS = '\x1e';
const FS = '\x1f';
const LOG_FORMAT = `%H${FS}%ad${FS}%an${FS}%s${RS}`;

/**
 * scope 는 화면에서 고를 수 있는 값만 받는다 — 임의 경로를 그대로 git 인자에
 * 넘기지 않는다. `--` 뒤에 두므로 옵션으로 해석될 위험은 원래 없지만, 그와
 * 별개로 "무엇을 볼 수 있는가" 를 화이트리스트로 굳혀 둔다.
 *
 *   (없음)   저장소 전체
 *   'docs'   docs/ 아래
 *   그 밖    services/<scope>/ — 실제 존재하는 디렉토리인지 확인한다
 */
function resolvePathspec(scope) {
  const s = String(scope || '').trim();
  if (!s) return null;
  if (s === 'docs') return 'docs';

  if (!/^[a-zA-Z0-9_-]+$/.test(s)) {
    const err = new Error(`알 수 없는 범위입니다: ${scope}`);
    err.code = 'INVALID_SCOPE';
    throw err;
  }
  const dir = path.join(config.repoRoot, 'services', s);
  if (!fs.existsSync(dir)) {
    const err = new Error(`services/${s} 가 없습니다`);
    err.code = 'INVALID_SCOPE';
    throw err;
  }
  return `services/${s}`;
}

function parseLog(stdout) {
  return stdout
    .split(RS)
    .map((rec) => rec.replace(/^\n/, '').trim())
    .filter(Boolean)
    .map((rec) => {
      const [hash, date, author, subject] = rec.split(FS);
      return { hash: hash.slice(0, 10), date, author, subject };
    });
}

async function recent({ scope, limit = 60 } = {}) {
  const pathspec = resolvePathspec(scope);
  const args = [
    'log',
    `--max-count=${Math.min(Math.max(parseInt(limit, 10) || 60, 1), 200)}`,
    '--date=iso-strict',
    `--pretty=format:${LOG_FORMAT}`,
  ];
  if (pathspec) args.push('--', pathspec);

  const { stdout } = await execFileAsync('git', args, {
    cwd: config.repoRoot,
    maxBuffer: 8 * 1024 * 1024,
  });
  return parseLog(stdout);
}

/** 화면의 범위 선택지 — docs/ 와 services/ 아래 실제 디렉토리들. */
function scopes() {
  const servicesDir = path.join(config.repoRoot, 'services');
  let services = [];
  try {
    services = fs
      .readdirSync(servicesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    services = [];
  }
  return { docs: true, services };
}

module.exports = { recent, scopes };
