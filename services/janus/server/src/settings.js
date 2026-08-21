/**
 * 배포 설정 — 대시보드 '설정' 화면이 쓰고 `install.sh --apply` 가 읽는다.
 *
 * ── 왜 이렇게 나누는가 ──────────────────────────────────────────────
 * 공인 IP 나 포워딩 포트 범위는 **장비마다 다르고 회선 따라 바뀝니다.** 그렇다고
 * 사람이 .jcfg 를 직접 고치게 두면 자리표시자·따옴표를 놓치기 쉽고, 틀려도
 * 조용히 무음이 될 뿐 오류가 뜨지 않습니다. 그래서 값만 따로 받습니다.
 *
 * ── 권한 경계 ───────────────────────────────────────────────────────
 * **이 모듈은 sudo 를 부르지 않습니다.** settings.ini 에 값을 적을 뿐이고,
 * 실제 적용은 사람이 `sudo ./install.sh --apply` 를 실행해야 일어납니다.
 * 대시보드가 root 권한으로 무언가를 하는 길은 만들지 않습니다.
 *
 * 그래도 이 파일은 **root 로 도는 스크립트가 읽는 입력**이므로, 검증을 여기서
 * 한 번 하고 install.sh 에서 또 합니다. 둘 다 통과해야 설치됩니다 — 대시보드를
 * 우회해 파일을 직접 고쳐도 install.sh 가 막습니다.
 */
const fs = require('fs');
const path = require('path');

const SERVICE_DIR = path.resolve(__dirname, '../..');
const SETTINGS_FILE = process.env.JANUS_SETTINGS_FILE || path.join(SERVICE_DIR, 'settings.ini');
/** install.sh --apply 가 마지막으로 설치한 값. 적용 대기 여부를 이걸로 가른다. */
const APPLIED_FILE = process.env.JANUS_APPLIED_FILE || path.join(SERVICE_DIR, '.applied-settings');

const APPLY_COMMAND = 'sudo ./install.sh --apply';

/**
 * 화면은 이 스키마로 그린다. 설정을 하나 늘리려면
 *   ① 여기에 항목을 더하고
 *   ② janus.jcfg 에 자리표시자(__KEY_대문자__)를 넣고
 *   ③ install.sh 의 SETTING_KEYS 에 키를 더한다
 * 화면 코드는 손대지 않아도 된다.
 */
const SCHEMA = [
  {
    key: 'public_ip',
    label: '공인 IP',
    help: '외부(인터넷) 브라우저를 받을 때만 씁니다. 비워 두면 LAN 전용으로 설치됩니다.',
    placeholder: '125.242.8.15',
    optional: true,
    // 자리표시자를 sed 로 밀어 넣으므로 형식을 좁게 잡는다.
    pattern: '^\\d{1,3}(\\.\\d{1,3}){3}$',
    patternHint: 'IPv4 (예: 125.242.8.15)',
    effect: '설정하면 janus.jcfg 의 nat_1_1_mapping 이 켜집니다. 비우면 그 줄이 지워집니다.',
  },
  {
    key: 'rtp_port_range',
    label: 'WebRTC 미디어 포트 범위',
    help: '공유기에서 이 범위를 UDP 로 포워딩해야 외부 통화의 소리가 납니다.',
    placeholder: '20000-20200',
    optional: false,
    default: '20000-20200',
    pattern: '^\\d{4,5}-\\d{4,5}$',
    patternHint: '시작-끝 (예: 20000-20200)',
    effect: 'janus.jcfg 의 media.rtp_port_range 가 됩니다. SIP 미디어(30000-30200)·rtpproxy(10200-19999)와 겹치면 안 됩니다.',
  },
];

const byKey = Object.fromEntries(SCHEMA.map((s) => [s.key, s]));

// ── 파일 읽고 쓰기 ──────────────────────────────────────────────────────
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

function readFileSafe(f) {
  try { return fs.readFileSync(f, 'utf8'); } catch { return ''; }
}

function readSettings() {
  return parseIni(readFileSafe(SETTINGS_FILE));
}

function readApplied() {
  return parseIni(readFileSafe(APPLIED_FILE));
}

// ── 검증 ────────────────────────────────────────────────────────────────
function validateOne(key, rawValue) {
  const spec = byKey[key];
  if (!spec) return { error: `모르는 설정입니다: ${key}` };

  const value = String(rawValue ?? '').trim();

  if (!value) {
    if (spec.optional) return { value: '' };
    return { error: `${spec.label} 은(는) 비워 둘 수 없습니다.` };
  }

  if (!new RegExp(spec.pattern).test(value)) {
    return { error: `${spec.label} 의 형식이 맞지 않습니다 — ${spec.patternHint}` };
  }

  if (key === 'public_ip') {
    if (value.split('.').some((o) => Number(o) > 255)) {
      return { error: '공인 IP 의 각 자리는 255 이하여야 합니다.' };
    }
  }

  if (key === 'rtp_port_range') {
    const [lo, hi] = value.split('-').map(Number);
    if (lo >= hi) return { error: '포트 범위는 시작이 끝보다 작아야 합니다.' };
    if (lo < 1024 || hi > 65535) return { error: '포트 범위는 1024~65535 안이어야 합니다.' };
    /*
     * 겹침은 조용히 실패한다 — 통화는 붙는데 소리만 안 나거나 한쪽만 들린다.
     * install.sh 의 점검이 같은 검사를 하지만, 여기서 먼저 막아 주는 편이
     * 사람에게 훨씬 빨리 보인다.
     */
    const clashes = [
      { name: 'SIP 미디어', lo: 30000, hi: 30200 },
      { name: 'rtpproxy', lo: 10200, hi: 19999 },
    ].filter((r) => lo <= r.hi && r.lo <= hi);
    if (clashes.length) {
      return { error: `${clashes.map((c) => `${c.name}(${c.lo}-${c.hi})`).join(', ')} 와 겹칩니다.` };
    }
  }

  return { value };
}

function validateAll(input) {
  const values = {};
  const errors = {};
  for (const spec of SCHEMA) {
    const r = validateOne(spec.key, input[spec.key]);
    if (r.error) errors[spec.key] = r.error;
    else values[spec.key] = r.value;
  }
  return { values, errors, ok: Object.keys(errors).length === 0 };
}

// ── 상태 ────────────────────────────────────────────────────────────────
/** 저장된 값과 마지막으로 적용된 값이 다른가 = 사람이 apply 를 해야 하는가. */
function pendingKeys(saved, applied) {
  return SCHEMA.map((s) => s.key).filter((k) => (saved[k] || '') !== (applied[k] || ''));
}

function state() {
  const saved = readSettings();
  const applied = readApplied();
  const pending = pendingKeys(saved, applied);
  return {
    schema: SCHEMA,
    values: Object.fromEntries(SCHEMA.map((s) => [s.key, saved[s.key] ?? (s.default ?? '')])),
    applied: Object.fromEntries(SCHEMA.map((s) => [s.key, applied[s.key] ?? ''])),
    // .applied-settings 가 아예 없으면 한 번도 적용한 적이 없다는 뜻이다.
    everApplied: Object.keys(applied).length > 0,
    pending,
    applyCommand: APPLY_COMMAND,
    settingsPath: SETTINGS_FILE,
  };
}

function save(input) {
  const { values, errors, ok } = validateAll(input);
  if (!ok) return { ok: false, errors };

  const lines = [
    '; janus 배포 설정 — 대시보드 설정 화면이 씁니다.',
    '; 이 파일은 값만 담습니다. 실제 적용은 사람이 아래를 실행해야 일어납니다:',
    `;     ${APPLY_COMMAND}`,
    '; 커밋하지 않습니다 (.gitignore) — 장비마다 다른 값입니다.',
    '',
    ...SCHEMA.map((s) => `${s.key} = ${values[s.key] ?? ''}`),
    '',
  ];
  fs.writeFileSync(SETTINGS_FILE, lines.join('\n'), { mode: 0o644 });
  return { ok: true, ...state() };
}

module.exports = { SCHEMA, state, save, validateAll, readSettings, readApplied, SETTINGS_FILE, APPLIED_FILE };
