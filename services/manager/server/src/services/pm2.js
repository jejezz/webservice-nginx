const { execFile } = require('child_process');
const { promisify } = require('util');
const config = require('../config');
const log = require('../logger');

const execFileAsync = promisify(execFile);

const STATE_MAP = {
  online: 'online',
  stopping: 'stopping',
  stopped: 'stopped',
  launching: 'launching',
  errored: 'errored',
  'one-launch-status': 'launching',
};

/**
 * `pm2 jlist` 결과를 서비스 이름으로 색인해 반환한다.
 * PM2가 없거나 실행 중이 아니면 빈 Map을 돌려주고 대시보드는 PM2 정보 없이 동작한다.
 */
async function list() {
  if (!config.pm2Enabled) return new Map();

  try {
    const { stdout } = await execFileAsync('pm2', ['jlist'], {
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    });

    const procs = JSON.parse(stdout);
    const byName = new Map();

    for (const p of procs) {
      const env = p.pm2_env || {};
      byName.set(p.name, {
        name: p.name,
        pmId: p.pm_id,
        pid: p.pid || null,
        status: STATE_MAP[env.status] || env.status || 'unknown',
        cpu: p.monit?.cpu ?? null,
        memoryMb: p.monit?.memory ? Math.round(p.monit.memory / 1024 / 1024) : null,
        restarts: env.restart_time ?? 0,
        unstableRestarts: env.unstable_restarts ?? 0,
        uptimeSec: env.pm_uptime && env.status === 'online'
          ? Math.floor((Date.now() - env.pm_uptime) / 1000)
          : 0,
        execMode: env.exec_mode || null,
        nodeVersion: env.node_version || null,
        port: env.env?.PORT ? Number(env.env.PORT) : null,
      });
    }

    return byName;
  } catch (err) {
    log.warn(`pm2 jlist failed: ${err.message}`);
    return new Map();
  }
}

module.exports = { list };
