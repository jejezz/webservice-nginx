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
const path = require('path');

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
function check(entries) {
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

    console.log(
      `  ${status.padEnd(6)}  ${app.name.padEnd(16)} ${(port || '-').padEnd(7)} ${where.padEnd(22)} ${note}`
    );
  }

  const enabledCount = entries.filter((e) => e.enabled).length;
  console.log(`\n${enabledCount} apps${problems ? `, ${problems} problem(s)` : ', no problems'}.`);
  return problems;
}

const entries = loadApps();

if (require.main === module) {
  console.log(`Scanning ${SERVICES_DIR}/*/pm2-conf/*.ini\n`);
  const problems = check(entries);

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ apps: entries.filter((e) => e.enabled).map((e) => e.app) }, null, 2));
  }
  process.exit(problems ? 1 : 0);
}

module.exports = { apps: entries.filter((e) => e.enabled).map((e) => e.app) };
