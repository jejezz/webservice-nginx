/**
 * 배포 설정 — 대시보드 '설정' 화면이 쓰고 `install.sh --apply` 가 읽는다.
 *
 * ── 이 파일이 얇아진 이유 ───────────────────────────────────────────────
 * 같은 값을 받는 화면이 **둘**이 됐습니다 — 이 대시보드와 구축 마법사
 * (`/manager/setup`). 둘이 각자 스키마를 들고 있으면 언젠가 어긋나므로,
 * 항목 정의는 `services/janus/settings-schema.json` 으로 내리고 읽고 쓰고
 * 검증하는 코드는 `lib/settings.js` 한 곳에 뒀습니다.
 * 규약은 `docs/settings-contract.md` 에 있습니다.
 *
 * 설정을 하나 늘리려면
 *   ① settings-schema.json 에 항목을 더하고
 *   ② janus.jcfg 에 자리표시자(__KEY_대문자__)를 넣고
 *   ③ install.sh 의 읽는 자리에 키를 더한다
 * 화면 코드도 이 파일도 손대지 않아도 됩니다.
 *
 * ── 권한 경계 ───────────────────────────────────────────────────────────
 * **이 모듈은 sudo 를 부르지 않습니다.** settings.ini 에 값을 적을 뿐이고,
 * 실제 적용은 사람이 `sudo ./install.sh --apply` 를 실행해야 일어납니다.
 * root 로 도는 그 스크립트가 같은 검증을 한 번 더 합니다.
 */
const path = require('path');
const shared = require('../../../../lib/settings');

const SERVICE_DIR = path.resolve(__dirname, '../..');

const schema = shared.loadSchema(SERVICE_DIR);
const SCHEMA = schema.fields;
const SETTINGS_FILE = path.join(SERVICE_DIR, schema.settingsFile);
const APPLIED_FILE = path.join(SERVICE_DIR, schema.appliedFile);

/** 화면이 기대하는 모양으로 돌려준다 (fields → schema). */
function shape(s) {
  return {
    schema: s.fields,
    values: s.values,
    applied: s.applied,
    everApplied: s.everApplied,
    pending: s.pending,
    applyCommand: s.applyCommand,
    settingsPath: s.settingsPath,
  };
}

function state() {
  return shape(shared.state(SERVICE_DIR));
}

function save(input) {
  const result = shared.save(SERVICE_DIR, input);
  if (!result.ok) return result;
  return { ok: true, ...shape(result) };
}

function validateAll(input) {
  return shared.validateAll(schema, input);
}

function readSettings() {
  return shared.state(SERVICE_DIR).values;
}

function readApplied() {
  return shared.state(SERVICE_DIR).applied;
}

module.exports = { SCHEMA, state, save, validateAll, readSettings, readApplied, SETTINGS_FILE, APPLIED_FILE };
