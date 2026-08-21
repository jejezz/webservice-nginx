/**
 * pm2 앱 정의 — 적어 두는 파일이 아니라 훑어서 만드는 파일.
 *
 * services/<서비스>/pm2-conf/*.ini 를 스캔해 apps 배열을 만든다. pm2 는 설정이
 * .js 면 실행 결과를 쓰기 때문에, 여기서 파싱해 돌려주면 그대로 등록된다.
 * 서비스를 추가할 때 이 파일을 고칠 일은 없다.
 *
 *   pm2 start ecosystem.config.js
 *   pm2 start ecosystem.config.js --only manager
 *   node ecosystem.config.js --check     # 해석 결과 + nginx-conf 와 포트 교차 검사
 *
 * 스키마: ../docs/pm2-conf.md
 *
 * 경로는 이 파일 위치에서 유도한다 — 절대 경로를 적어 두면 저장소를 옮길 때마다
 * 여러 줄을 고쳐야 하고, 실제로 그걸 놓쳐 재부팅 복원이 끊기는 일이 잦다.
 * pm2 는 cwd 에 절대 경로를 요구하므로 '상대 경로로 두기' 가 아니라
 * '실행 시점에 절대 경로를 계산하기' 로 푼다.
 *
 * nginx 는 여기서 관리하지 않는다 — 80/443 바인딩에 root 가 필요해 systemd 가
 * 맡는다. 설정 반영은 ../nginx/install_nginx_stack.sh 를 쓴다.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SERVICES_DIR = path.resolve(__dirname, '..', 'services');
const LOG_DIR = path.join(__dirname, 'logs');

/** 아주 작은 INI 파서. 섹션·주석(#, ;)·`키 = 값` 만 다룬다. */
function parseIni(text) {
  const out = {};
  let section = '';

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;

    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      section = header[1].trim();
      out[section] = out[section] || {};
      continue;
    }

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!section) continue;
    out[section][key] = value;
  }

  return out;
}

function readIni(file) {
  return parseIni(fs.readFileSync(file, 'utf8'));
}

/** services/<서비스>/<sub>/*.ini 를 한 단계만 훑는다. */
function scan(sub) {
  if (!fs.existsSync(SERVICES_DIR)) return [];

  const found = [];
  for (const entry of fs.readdirSync(SERVICES_DIR, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;

    const dir = path.join(SERVICES_DIR, entry.name, sub);
    if (!fs.existsSync(dir)) continue;

    for (const file of fs.readdirSync(dir).sort()) {
      if (!file.endsWith('.ini')) continue;
      found.push({ serviceDir: path.join(SERVICES_DIR, entry.name), file: path.join(dir, file) });
    }
  }
  return found;
}

const isTrue = (v) => ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
const isFalse = (v) => ['0', 'false', 'no', 'off'].includes(String(v).trim().toLowerCase());

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (isTrue(value)) return true;
  if (isFalse(value)) return false;
  return fallback;
}

function num(value) {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** 값이 있을 때만 키를 넣는다. pm2 는 undefined 를 그대로 들고 가면 경고를 낸다. */
function put(target, key, value) {
  if (value !== undefined && value !== '') target[key] = value;
}

function buildApp({ serviceDir, file }) {
  const ini = readIni(file);
  const app = ini.app || {};

  const name = (app.name || path.basename(serviceDir)).trim();
  if (!app.script) throw new Error(`${file}: [app] 에 script 가 없습니다`);

  const cwd = path.resolve(serviceDir, app.cwd || '.');

  const out = {
    name,
    cwd,
    script: app.script.trim(),
    exec_mode: (app.exec_mode || 'fork').trim(),
    instances: num(app.instances) ?? 1,
    autorestart: bool(app.autorestart, true),
    log_date_format: (app.log_date_format || 'YYYY-MM-DD HH:mm:ss').trim(),
    merge_logs: bool(app.merge_logs, true),
    // 로그는 서비스마다 흩어지지 않게 pm2/logs 로 모은다.
    out_file: app.out_file
      ? path.resolve(serviceDir, app.out_file)
      : path.join(LOG_DIR, `${name}-out.log`),
    error_file: app.error_file
      ? path.resolve(serviceDir, app.error_file)
      : path.join(LOG_DIR, `${name}-error.log`),
  };

  // 'none' 이면 메모리 상한을 걸지 않는다. 상한이 없어야 하는 프로세스에
  // 기본값 256M 이 조용히 붙으면 멀쩡한 서비스가 재시작될 수 있다.
  const memory = (app.max_memory_restart || '256M').trim();
  if (!['none', 'off', '0'].includes(memory.toLowerCase())) out.max_memory_restart = memory;

  // pm2 는 interpreter 의 상대 경로를 앱의 cwd 가 아니라 pm2 를 실행한 위치에서
  // 찾는다. 어느 디렉토리에서 실행하든 동작하도록 절대 경로로 바꿔 준다.
  if (app.interpreter) out.interpreter = path.resolve(serviceDir, app.interpreter.trim());

  put(out, 'node_args', app.node_args || app.interpreter_args);
  put(out, 'min_uptime', app.min_uptime);
  put(out, 'max_restarts', num(app.max_restarts));
  put(out, 'restart_delay', num(app.restart_delay));
  put(out, 'kill_timeout', num(app.kill_timeout));

  // watch 는 true/false 또는 공백으로 구분한 경로 목록.
  const watch = (app.watch || '').trim();
  if (watch && !isTrue(watch) && !isFalse(watch)) {
    out.watch = watch.split(/\s+/);
  } else {
    out.watch = bool(watch, false);
  }
  if (out.watch !== false) {
    out.ignore_watch = (app.ignore_watch || 'node_modules logs').trim().split(/\s+/);
  }

  for (const [section, values] of Object.entries(ini)) {
    if (section === 'env') {
      out.env = { ...values };
    } else if (section.startsWith('env:')) {
      out[`env_${section.slice(4).trim()}`] = { ...values };
    } else if (section !== 'app') {
      throw new Error(`${file}: 알 수 없는 섹션 [${section}]`);
    }
  }

  return { app: out, file, serviceDir, enabled: bool(app.enabled, true) };
}

function loadApps() {
  const entries = scan('pm2-conf').map(buildApp);

  const byName = new Map();
  for (const entry of entries) {
    const previous = byName.get(entry.app.name);
    if (previous) {
      throw new Error(`앱 이름이 겹칩니다: ${entry.app.name}\n  ${previous.file}\n  ${entry.file}`);
    }
    byName.set(entry.app.name, entry);
  }

  return entries;
}

/** 같은 서비스의 nginx-conf 선언에서 [service] ports 를 읽는다. 없으면 null. */
function nginxPorts(serviceDir) {
  const dir = path.join(serviceDir, 'nginx-conf');
  if (!fs.existsSync(dir)) return null;

  const ports = [];
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.ini')) continue;
    const service = readIni(path.join(dir, file)).service || {};
    if (isFalse(service.enabled ?? 'true')) continue;
    for (const token of (service.ports || '').split(/\s+/).filter(Boolean)) ports.push(token);
  }
  return ports.length ? ports : null;
}

/**
 * 프로세스가 여는 포트와 nginx 가 보내는 포트가 어긋나면 그 경로는 502 인데,
 * 어느 쪽 선언도 혼자서는 그걸 알 수 없다. 그래서 여기서 맞춰 본다.
 */
/*
 * 점검 규약 (docs/check-contract.md) 의 항목들.
 *
 * 이 파일은 node 라 lib/check-report.sh 를 쓸 수 없어 같은 형식을 직접 낸다.
 *
 * ⚠️ 플래그가 --json 이 아니라 --check-json 이다. --check --json 은 이미
 *    "pm2 에 넘어가는 앱 객체를 덤프한다" 는 뜻으로 README 에 문서화돼 있어서,
 *    그것을 빼앗으면 쓰던 사람이 깨진다.
 */
const CHECK_ENTRIES = [];
const judge = (level, text) => CHECK_ENTRIES.push({ level, text });

function checkState() {
  const levels = new Set(CHECK_ENTRIES.map((e) => e.level));
  if (levels.has('problem')) return 'problem';
  if (levels.has('pending')) return 'incomplete';
  return 'complete';
}

/*
 * ── 선언대로 돌고 있는가 (docs/check-contract.md 의 '설치본이 저장소와 같은가')
 *
 * 다른 서비스들은 **파일**을 견주면 되지만 pm2 는 대상이 프로세스라 방식이
 * 다르다. 볼 것이 셋이다.
 *
 *   선언 (pm2-conf/*.ini)   지금 무엇을 돌려야 하는가
 *   실행 중 (pm2 jlist)     지금 무엇이 돌고 있는가
 *   dump.pm2 (pm2 save)     재부팅하면 무엇이 살아날 것인가
 *
 * 어긋나는 방식이 각각 다르다. 선언만 고치고 재기동을 안 하면 둘째가 낡고,
 * 재기동만 하고 `pm2 save` 를 잊으면 셋째가 낡는다. **뒤엣것은 재부팅 전까지
 * 아무 증상이 없다** — pm2/README 가 경고하는 바로 그 함정이다.
 *
 * 견주는 값은 선언이 정한 것만이다. pm2 는 부모 환경을 통째로 물려주므로 env
 * 를 전부 비교하면 소음만 커진다. 선언은 커밋된 ini 에서 오므로 여기 찍히는
 * 값에 비밀이 섞이지 않는다.
 */
const PM2_HOME = process.env.PM2_HOME || path.join(os.homedir(), '.pm2');

function pm2List() {
  try {
    const out = execFileSync('pm2', ['jlist'], {
      encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(out);
  } catch {
    return null;   // pm2 가 없거나 데몬이 없다. 못 본 것이지 잘못된 것이 아니다.
  }
}

function pm2Dump() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PM2_HOME, 'dump.pm2'), 'utf8'));
  } catch {
    return null;
  }
}

// jlist 는 pm2_env 안에, dump.pm2 는 그 자체가 같은 모양이다.
const envOf = (entry) => entry.pm2_env || entry;

/** 선언과 실물의 차이를 사람이 읽을 문장들로. 같으면 빈 배열. */
function compareApp(app, actual) {
  const a = envOf(actual);
  const out = [];
  const differ = (label, want, have) => {
    if (want === undefined || want === null) return;
    if (String(want) !== String(have ?? '')) out.push(`${label} 선언 ${want} ≠ 실물 ${have ?? '(없음)'}`);
  };

  differ('script', path.resolve(app.cwd || '.', app.script), a.pm_exec_path);
  differ('cwd', app.cwd, a.pm_cwd);
  if (app.interpreter) differ('interpreter', app.interpreter, a.exec_interpreter);
  if (app.watch !== undefined) differ('watch', JSON.stringify(app.watch), JSON.stringify(a.watch ?? false));

  for (const [key, want] of Object.entries(app.env || {})) {
    differ(`env.${key}`, want, a.env ? a.env[key] : undefined);
  }
  return out;
}

function checkRunning(entries) {
  const declared = entries.filter((e) => e.enabled).map((e) => e.app);
  const list = pm2List();

  if (!list) {
    skipLine('pm2 에 물어보지 못해 "선언대로 돌고 있는가" 를 건너뜁니다 (pm2 jlist)');
    return;
  }

  const byName = new Map(list.map((p) => [p.name, p]));
  let drift = 0;

  for (const app of declared) {
    const proc = byName.get(app.name);
    if (!proc) {
      judge('pending', `${app.name} — 선언돼 있는데 돌고 있지 않습니다 → cd pm2 && pm2 start ecosystem.config.js --only ${app.name} && pm2 save`);
      drift += 1;
      continue;
    }
    const status = envOf(proc).status;
    if (status !== 'online') {
      judge('problem', `${app.name} — 상태가 ${status} 입니다 (pm2 logs ${app.name})`);
      drift += 1;
      continue;
    }
    const diffs = compareApp(app, proc);
    if (diffs.length) {
      judge('pending', `${app.name} — 선언과 다르게 돌고 있습니다: ${diffs.join(' · ')} → pm2 restart ${app.name} --update-env && pm2 save`);
      drift += 1;
    }
  }

  // 선언에 없는데 돌고 있는 것. 껐다고 적어 둔 앱이 그대로 떠 있는 경우다.
  const declaredNames = new Set(declared.map((a) => a.name));
  for (const proc of list) {
    if (declaredNames.has(proc.name)) continue;
    judge('pending', `${proc.name} — 돌고 있는데 선언에 없습니다 (pm2 delete ${proc.name} && pm2 save 하거나 선언을 되살리세요)`);
    drift += 1;
  }

  if (!drift) judge('ok', `실행 중 ${list.length}개 — 선언대로 돌고 있습니다`);

  checkSaved(declared, list);
}

/** 재부팅하면 살아날 목록. pm2 save 를 잊으면 여기만 낡는다. */
function checkSaved(declared, list) {
  const dump = pm2Dump();
  if (!dump) {
    judge('pending', `재부팅 목록이 없습니다 (${path.join(PM2_HOME, 'dump.pm2')}) — pm2 save 를 한 번도 하지 않았습니다`);
    return;
  }

  const running = new Set(list.map((p) => p.name));
  const saved = new Map(dump.map((a) => [a.name, a]));
  const declaredNames = new Set(declared.map((a) => a.name));

  // 돌고 있는데 재부팅 목록에 없다 = 띄우고 pm2 save 를 잊었다.
  // **선언에 없는 것은 여기서 말하지 않는다** — 그건 위에서 이미 짚었고,
  // 거기에 대고 "pm2 save 를 하세요" 라고 하면 원하지 않는 앱을 굳혀 버린다.
  const notSaved = [...running].filter((n) => !saved.has(n) && declaredNames.has(n));
  // 재부팅 목록에는 있는데 지금 안 돌고 있다 = 지우고 pm2 save 를 잊었다.
  const ghosts = [...saved.keys()].filter((n) => !running.has(n));

  let mismatch = 0;
  if (notSaved.length) {
    judge('pending', `재부팅 목록에 없습니다: ${notSaved.join(', ')} — 지금은 돌고 있지만 재부팅하면 뜨지 않습니다. pm2 save 를 하세요`);
    mismatch += 1;
  }
  if (ghosts.length) {
    judge('pending', `재부팅하면 살아납니다: ${ghosts.join(', ')} — 지금은 돌고 있지 않습니다. 지운 뒤 pm2 save 를 하지 않았습니다`);
    mismatch += 1;
  }
  if (mismatch) return;

  // 목록은 같은데 설정이 옛것인 경우. 재기동은 했고 save 를 잊은 상태다.
  const stale = [];
  for (const app of declared) {
    const entry = saved.get(app.name);
    if (!entry) continue;
    const diffs = compareApp(app, entry);
    if (diffs.length) stale.push(`${app.name}(${diffs[0]})`);
  }

  if (stale.length) {
    judge('pending', `재부팅하면 옛 설정으로 뜹니다: ${stale.join(', ')} — pm2 save 를 하세요`);
  } else {
    judge('ok', `재부팅 목록도 같습니다 (${dump.length}개, pm2 save 됨)`);
  }
}

function skipLine(text) {
  judge('skip', text);
}

function check(entries, quiet = false) {
  let problems = 0;

  for (const { app, serviceDir, enabled } of entries) {
    const port = app.env && app.env.PORT ? String(app.env.PORT) : null;
    const ports = nginxPorts(serviceDir);
    const where = path.relative(SERVICES_DIR, serviceDir);

    let status = 'ok';
    let note = ports ? `nginx ${ports.join(' ')}` : '(nginx 라우트 없음 — 포트 직결)';

    if (!enabled) {
      status = 'skip';
      note = 'enabled = false';
    } else if (ports && port && !ports.includes(port)) {
      status = 'WARN';
      note = `pm2 PORT=${port} vs nginx ports=${ports.join(' ')}`;
      problems += 1;
    } else if (ports && !port && !(app.env && app.env.HEALTH_URL)) {
      status = 'WARN';
      note = `nginx ports=${ports.join(' ')} 인데 pm2 에 PORT 가 없습니다`;
      problems += 1;
    }

    judge(status === 'ok' ? 'ok' : status === 'skip' ? 'skip' : 'problem',
          `${app.name} — ${note}`);

    if (!quiet) {
      console.log(
        `  ${status.padEnd(6)}  ${app.name.padEnd(16)} ${(port || '-').padEnd(7)} ${where.padEnd(22)} ${note}`
      );
    }
  }

  // 선언이 옳은가 다음에, 그것이 실제로 돌고 있는가를 본다.
  // 사람 화면에는 이 절이 낸 줄만 따로 모아 찍는다 (앞의 선언 목록과 섞이지 않게).
  const before = CHECK_ENTRIES.length;
  checkRunning(entries);
  const runtimeEntries = CHECK_ENTRIES.slice(before);
  problems += runtimeEntries.filter((e) => e.level === 'problem' || e.level === 'pending').length;

  if (!quiet && runtimeEntries.length) {
    console.log('\n선언대로 돌고 있는가');
    const MARK = { ok: 'ok', problem: '!!', pending: '--', skip: '--' };
    for (const entry of runtimeEntries) {
      console.log(`  ${MARK[entry.level].padEnd(6)}  ${entry.text}`);
    }
  }

  const enabledCount = entries.filter((e) => e.enabled).length;
  if (!quiet) {
    console.log(`\n${enabledCount} apps${problems ? `, ${problems} problem(s)` : ', no problems'}.`);
  }
  return problems;
}

const entries = loadApps();

if (require.main === module) {
  // 규약 모드 — stdout 에 JSON 한 덩어리만 낸다.
  if (process.argv.includes('--check-json')) {
    check(entries, true);
    const state = checkState();
    process.stdout.write(
      JSON.stringify({ step: 'pm2.apps', state, checks: CHECK_ENTRIES }, null, 2) + '\n'
    );
    process.exit(state === 'complete' ? 0 : 1);
  }

  console.log(`Scanning ${SERVICES_DIR}/*/pm2-conf/*.ini\n`);
  const problems = check(entries);

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ apps: entries.filter((e) => e.enabled).map((e) => e.app) }, null, 2));
  }
  process.exit(problems ? 1 : 0);
}

module.exports = { apps: entries.filter((e) => e.enabled).map((e) => e.app) };
