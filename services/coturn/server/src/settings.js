/**
 * 배포 설정 — 대시보드 '설정' 화면이 쓰고 `install.sh --apply` 가 읽는다.
 *
 * services/janus/server/src/settings.js 와 같은 얇은 어댑터입니다. 항목
 * 정의는 services/coturn/settings-schema.json 에, 읽고 쓰고 검증하는 코드는
 * lib/settings.js 한 곳에 있습니다. 규약은 docs/settings-contract.md 입니다.
 *
 * ⚠️ static_auth_secret 은 이 스키마에 없습니다 — 사람이 입력하는 값이
 *    아니라 install.sh --apply 가 생성하는 비밀이기 때문입니다
 *    (services/coturn/install.sh 의 ensure_secret, config.js 의 주석 참고).
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

module.exports = { SCHEMA, state, save };
