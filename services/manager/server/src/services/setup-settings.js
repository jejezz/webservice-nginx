const path = require('path');
const config = require('../config');
const log = require('../logger');

// 스키마를 읽고 쓰고 검증하는 코드는 저장소 공용입니다 — 서비스 자신의
// 대시보드도 같은 것을 씁니다 (docs/settings-contract.md).
const shared = require(path.join(config.repoRoot, 'lib', 'settings'));

/**
 * 구축 마법사의 **파라미터 입력**.
 *
 * 단계에 `settings` 가 붙어 있으면 그 서비스의 `settings-schema.json` 을 읽어
 * 폼을 그리고, 사람이 넣은 값을 그 서비스의 `settings.ini` 에 씁니다.
 *
 * ── 경계 ────────────────────────────────────────────────────────────────
 *
 *   1. **쓰는 파일은 단계 표가 정합니다.** 경로를 사람 입력에서 만들지 않고,
 *      저장소 밖으로 나가면 거부합니다.
 *   2. **값만 씁니다.** 설정 파일(.jcfg · kamailio-local.cfg)을 만지지 않고,
 *      서비스를 재기동하지도 않습니다. 반영은 사람이 `--apply` 로 합니다.
 *   3. 검증은 공용 구현이 하고, root 로 도는 적용 스크립트가 **한 번 더** 합니다.
 *
 * 마법사가 파일을 쓰는 곳은 여기와 사람의 확인 기록(setup-attest.js) 둘뿐입니다.
 */

function resolveDir(step) {
  const dir = path.resolve(config.repoRoot, step.settings.dir);
  const root = config.repoRoot.endsWith(path.sep) ? config.repoRoot : `${config.repoRoot}${path.sep}`;
  if (!dir.startsWith(root)) throw new Error(`settings dir escapes repo root: ${dir}`);
  return dir;
}

/** 화면이 쓸 상태. 스키마를 읽지 못하면 null 을 돌려주고 폼을 그리지 않는다. */
function read(step) {
  if (!step.settings) return null;

  try {
    const state = shared.state(resolveDir(step));
    return {
      ...state,
      // 화면에는 저장소 기준 경로만 보여 준다.
      settingsPath: path.relative(config.repoRoot, state.settingsPath),
      appliedPath: path.relative(config.repoRoot, state.appliedPath),
      applyCwd: step.settings.dir,
    };
  } catch (err) {
    log.warn(`setup settings ${step.id}: ${err.message}`);
    return null;
  }
}

/**
 * 값을 저장한다. 형식이 맞지 않으면 아무것도 쓰지 않고 어느 항목이 왜 틀렸는지
 * 돌려준다.
 */
function save(step, input) {
  if (!step.settings) throw new Error(`step has no settings: ${step.id}`);

  const dir = resolveDir(step);
  const result = shared.save(dir, input || {});
  if (!result.ok) return result;

  log.info(`setup settings saved: ${step.id} (${step.settings.dir}/settings.ini)`);
  return { ok: true, settings: read(step) };
}

module.exports = { read, save };
