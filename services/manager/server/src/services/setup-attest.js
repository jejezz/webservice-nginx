const fs = require('fs');
const path = require('path');
const config = require('../config');
const log = require('../logger');

/**
 * `manualOnly` 단계의 **사람 확인 기록**.
 *
 * 기계가 확인할 수 없는 것들이 있습니다 — 공유기에 포워딩을 열었는가, 인터폰을
 * 설치했는가, 시험 통화에서 소리가 났는가. 이런 것은 사람의 확인을 시각과 함께
 * 적어 두되 **통과로 위장하지 않습니다** (docs/setup-wizard.md).
 *
 * ── 왜 DB 가 아니라 파일인가 ────────────────────────────────────────────
 *
 * manager 는 MariaDB 를 씁니다. 그런데 **MariaDB 를 세우는 것이 이 마법사의
 * 1단계입니다.** 확인 기록을 DB 에 두면, DB 가 아직 없는 동안에는 아무것도
 * 기록할 수 없습니다 — 마법사가 자기 자신을 기다리는 모양이 됩니다.
 *
 * 기록은 이 장비 한 대의 구축 이력이고, 크기도 열댓 줄입니다. 파일 하나로
 * 충분합니다. 사람이 열어 읽고 지울 수 있다는 것도 이 용도에는 장점입니다.
 */

const FILE = path.join(config.managerDir, 'setup-attest.json');
const VERSION = 1;

function readAll() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return data && typeof data.records === 'object' && data.records ? data.records : {};
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`Cannot read ${FILE}: ${err.message}`);
    return {};
  }
}

// 쓰다 만 파일을 남기지 않는다 — 임시 파일에 쓰고 이름을 바꾼다.
function writeAll(records) {
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: VERSION, records }, null, 2)}\n`);
  fs.renameSync(tmp, FILE);
}

function get(stepId) {
  return readAll()[stepId] || null;
}

function record(stepId, { by, note }) {
  const records = readAll();
  records[stepId] = {
    at: new Date().toISOString(),
    by: by || 'unknown',
    ...(note ? { note: String(note).slice(0, 500) } : {}),
  };
  writeAll(records);
  log.info(`setup attest: ${stepId} by ${by}`);
  return records[stepId];
}

function remove(stepId) {
  const records = readAll();
  if (!(stepId in records)) return false;
  delete records[stepId];
  writeAll(records);
  log.info(`setup attest cleared: ${stepId}`);
  return true;
}

module.exports = { readAll, get, record, remove, file: FILE };
