/**
 * 배포 설정 — 스키마는 서비스가 데이터로 갖고, 화면 둘이 그것을 함께 읽는다.
 *
 * 규약은 docs/settings-contract.md 에 있습니다. 이 파일은 그 구현입니다.
 *
 * ── 왜 공용으로 두는가 ──────────────────────────────────────────────────
 *
 * 공인 IP·포트 범위·SIP 도메인 같은 값은 **장비마다 다릅니다.** 사람이 설정
 * 파일을 직접 고치게 두면 자리표시자나 따옴표를 놓치기 쉽고, 틀려도 조용히
 * 무음이 될 뿐 오류가 뜨지 않습니다. 그래서 값만 따로 받습니다.
 *
 * 그 값을 받는 화면이 **둘**이 됐습니다 — 서비스 자신의 대시보드와 구축
 * 마법사(`/manager/setup`). 둘이 각자 스키마를 들고 있으면 언젠가 어긋납니다.
 * 그래서 스키마를 서비스 디렉터리의 `settings-schema.json` 하나로 내리고,
 * 읽고 쓰고 검증하는 코드를 여기 한 곳에 둡니다.
 *
 * ── 권한 경계 ───────────────────────────────────────────────────────────
 *
 * **이 모듈은 sudo 를 부르지 않습니다.** `settings.ini` 에 값을 적을 뿐이고,
 * 실제 적용은 사람이 그 서비스의 `--apply` 를 실행해야 일어납니다. 그리고
 * root 로 도는 그 스크립트가 **같은 검증을 한 번 더** 합니다 — 화면을 우회해
 * 파일을 손으로 고쳐도 같은 관문을 지나게 하려는 것입니다.
 */
const fs = require('fs');
const path = require('path');

const SCHEMA_FILE = 'settings-schema.json';

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** `키 = 값` 만 읽는다. 절(section)은 쓰지 않는다 — bash 쪽에서도 파싱해야 한다. */
function parseIni(text) {
  const out = {};
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function loadSchema(serviceDir) {
  const file = path.join(serviceDir, SCHEMA_FILE);
  const schema = JSON.parse(fs.readFileSync(file, 'utf8'));

  if (!Array.isArray(schema.fields) || schema.fields.length === 0) {
    throw new Error(`${file}: fields 가 비어 있습니다`);
  }
  return {
    service: schema.service || path.basename(serviceDir),
    applyCommand: schema.applyCommand || '',
    settingsFile: schema.settingsFile || 'settings.ini',
    appliedFile: schema.appliedFile || '.applied-settings',
    fields: schema.fields,
  };
}

function paths(serviceDir, schema) {
  return {
    settingsPath: path.join(serviceDir, schema.settingsFile),
    appliedPath: path.join(serviceDir, schema.appliedFile),
  };
}

// ── 검증 ────────────────────────────────────────────────────────────────
//
// 규칙은 전부 스키마에 **데이터로** 적혀 있다. 여기에 서비스 이름이나 키
// 이름을 박지 않는다 — 그러면 설정을 늘릴 때마다 이 파일을 고쳐야 한다.

function validateOne(field, rawValue) {
  const label = field.label || field.key;
  const value = String(rawValue ?? '').trim();

  if (!value) {
    if (field.optional) return { value: '' };
    return { error: `${label} 은(는) 비워 둘 수 없습니다.` };
  }

  if (field.pattern && !new RegExp(field.pattern).test(value)) {
    return { error: `${label} 의 형식이 맞지 않습니다 — ${field.patternHint || field.pattern}` };
  }

  if (field.type === 'ipv4') {
    if (value.split('.').some((o) => Number(o) > 255)) {
      return { error: `${label} 의 각 자리는 255 이하여야 합니다.` };
    }
  }

  if (field.type === 'port_range') {
    const [lo, hi] = value.split('-').map(Number);
    if (!(lo < hi)) return { error: `${label} 은(는) 시작이 끝보다 작아야 합니다.` };
    if (lo < 1024 || hi > 65535) return { error: `${label} 은(는) 1024~65535 안이어야 합니다.` };

    /*
     * 겹침은 조용히 실패한다 — 통화는 붙는데 소리만 안 나거나 한쪽만 들린다.
     * 적용 스크립트도 같은 검사를 하지만, 여기서 먼저 막는 편이 사람에게
     * 훨씬 빨리 보인다.
     */
    const clashes = (field.conflicts || []).filter((r) => lo <= r.hi && r.lo <= hi);
    if (clashes.length) {
      return { error: `${clashes.map((c) => `${c.name}(${c.lo}-${c.hi})`).join(', ')} 와 겹칩니다.` };
    }
  }

  return { value };
}

function validateAll(schema, input) {
  const values = {};
  const errors = {};
  for (const field of schema.fields) {
    const r = validateOne(field, input[field.key]);
    if (r.error) errors[field.key] = r.error;
    else values[field.key] = r.value;
  }
  return { values, errors, ok: Object.keys(errors).length === 0 };
}

// ── 상태 ────────────────────────────────────────────────────────────────

/**
 * 저장된 값과 마지막으로 적용된 값이 다른가 = 사람이 apply 를 해야 하는가.
 *
 * ⚠️ 적용 기록이 **아예 없으면** 비교할 대상이 없다. 그때는 "다르다" 가 아니라
 * "모른다" 이므로 pending 을 내지 않는다 (everApplied 로 구분한다). 없는 것을
 * 근거로 "아직 반영 안 됨" 이라고 말하면 늘 거짓 경보가 된다.
 */
function pendingKeys(schema, saved, applied) {
  return schema.fields
    .map((f) => f.key)
    .filter((k) => (saved[k] || '') !== (applied[k] || ''));
}

function state(serviceDir) {
  const schema = loadSchema(serviceDir);
  const { settingsPath, appliedPath } = paths(serviceDir, schema);

  const saved = parseIni(readFileSafe(settingsPath));
  const applied = parseIni(readFileSafe(appliedPath));
  const everApplied = Object.keys(applied).length > 0;

  return {
    service: schema.service,
    fields: schema.fields,
    values: Object.fromEntries(schema.fields.map((f) => [f.key, saved[f.key] ?? f.default ?? ''])),
    applied: Object.fromEntries(schema.fields.map((f) => [f.key, applied[f.key] ?? ''])),
    everApplied,
    pending: everApplied ? pendingKeys(schema, saved, applied) : [],
    // 값 파일이 아직 없으면 한 번도 저장한 적이 없다는 뜻이다.
    everSaved: Object.keys(saved).length > 0,
    applyCommand: schema.applyCommand,
    settingsPath,
    appliedPath,
  };
}

function save(serviceDir, input) {
  const schema = loadSchema(serviceDir);
  const { settingsPath } = paths(serviceDir, schema);

  const { values, errors, ok } = validateAll(schema, input);
  if (!ok) return { ok: false, errors };

  const lines = [
    `; ${schema.service} 배포 설정 — 값만 담습니다.`,
    '; 실제 적용은 사람이 아래를 실행해야 일어납니다:',
    `;     ${schema.applyCommand}`,
    '; 커밋하지 않습니다 — 장비마다 다른 값입니다.',
    `; 항목의 뜻은 ${SCHEMA_FILE} 에 있습니다.`,
    '',
    ...schema.fields.map((f) => `${f.key} = ${values[f.key] ?? ''}`),
    '',
  ];

  // 쓰다 만 파일을 root 로 도는 스크립트가 읽는 일이 없게 한다.
  const tmp = `${settingsPath}.tmp`;
  fs.writeFileSync(tmp, lines.join('\n'), { mode: 0o644 });
  fs.renameSync(tmp, settingsPath);

  return { ok: true, ...state(serviceDir) };
}

// ── 뼈대 만들기 ─────────────────────────────────────────────────────────
//
// 값을 받는 화면은 둘이지만(서비스 대시보드·구축 마법사), 규약은 **편집기로
// 직접 적는 것**도 허용합니다. 그런데 편집기로 여는 사람에게는 아무 파일도
// 없었습니다 — 무엇을 적어야 하는지 스키마를 직접 읽어야 했고, 그래서 "그냥
// 세 줄 만들어 넣으라" 는 식의 안내가 돌아다니게 됩니다. 그렇게 만든 파일은
// 머리말도 없고 검증도 받지 않습니다.
//
// 그래서 스키마에서 주석 달린 뼈대를 만들어 줍니다. 값은 채우지 않습니다 —
// 기본값이 있는 항목만 미리 넣고, 사람이 정해야 하는 자리는 비워 둡니다.

// 한글은 터미널에서 두 칸을 차지한다. 글자 수로 접으면 한글 줄만 화면을
// 넘어간다 — 폭으로 센다.
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

function displayWidth(text) {
  let w = 0;
  for (const ch of text) w += WIDE.test(ch) ? 2 : 1;
  return w;
}

function wrap(text, width) {
  const out = [];
  let line = '';
  for (const word of String(text).replace(/\*\*/g, '').split(/\s+/)) {
    if (!word) continue;
    if (line && displayWidth(line) + 1 + displayWidth(word) > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}

/** 편집기로 채울 뼈대. 파일에 쓰지 않고 문자열로 돌려준다. */
function template(serviceDir) {
  const schema = loadSchema(serviceDir);
  const lines = [
    `; ${schema.service} 배포 설정 — 값만 담습니다.`,
    '; 실제 적용은 사람이 아래를 실행해야 일어납니다:',
    `;     ${schema.applyCommand}`,
    '; 커밋하지 않습니다 — 장비마다 다른 값입니다.',
    `; 항목의 뜻은 ${SCHEMA_FILE} 에 있습니다.`,
    ';',
    '; ── 이 파일은 아직 뼈대입니다 ──',
    '; 빈 값을 채운 뒤 위 명령을 실행하세요. 구축 마법사(/manager/setup)의 폼으로',
    '; 넣으면 같은 검증을 받으며 이 파일이 채워집니다.',
    '',
  ];

  for (const field of schema.fields) {
    const required = field.optional ? '선택' : '필수';
    lines.push(`; ${field.label || field.key}  (${required})`);
    for (const part of ['help', 'patternHint', 'effect']) {
      if (!field[part]) continue;
      const prefix = part === 'patternHint' ? '형식: ' : part === 'effect' ? '반영: ' : '';
      for (const line of wrap(`${prefix}${field[part]}`, 74)) lines.push(`;   ${line}`);
    }
    // 값이 없는 자리에 공백을 남기지 않는다.
    const preset = field.default ?? '';
    lines.push(preset ? `${field.key} = ${preset}` : `${field.key} =`);
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = { loadSchema, parseIni, validateAll, state, save, template, SCHEMA_FILE };

// ── CLI ─────────────────────────────────────────────────────────────────
//
//     node lib/settings.js --init  <서비스 디렉터리>   뼈대를 만든다
//     node lib/settings.js --print <서비스 디렉터리>   만들지 않고 보여만 준다
//
// 값이 이미 있는 파일은 **덮지 않습니다.** 사람이 정한 값은 되돌릴 수 없습니다.
if (require.main === module) {
  const [mode, dir] = process.argv.slice(2);
  const usage = 'Usage: node lib/settings.js [--init|--print] <서비스 디렉터리>';

  if (!['--init', '--print'].includes(mode) || !dir) {
    console.error(usage);
    process.exit(2);
  }

  try {
    const serviceDir = path.resolve(dir);
    const schema = loadSchema(serviceDir);
    const { settingsPath } = paths(serviceDir, schema);

    if (mode === '--print') {
      process.stdout.write(template(serviceDir));
      process.exit(0);
    }

    if (fs.existsSync(settingsPath)) {
      console.error(`이미 있습니다: ${settingsPath}`);
      console.error('덮지 않습니다 — 편집기로 열거나, 마법사의 폼에서 고치세요.');
      process.exit(1);
    }

    fs.writeFileSync(settingsPath, template(serviceDir), { mode: 0o644 });
    console.log(`뼈대를 만들었습니다: ${settingsPath}`);
    console.log('빈 값을 채운 뒤 적용하세요:');
    console.log(`    ${schema.applyCommand}`);
  } catch (err) {
    console.error(`오류: ${err.message}`);
    process.exit(1);
  }
}
