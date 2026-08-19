const PREFIX = '[kamailio-dashboard]';

function timestamp() {
  return new Date().toISOString();
}

module.exports = {
  info(...args) {
    console.log(timestamp(), PREFIX, ...args);
  },
  warn(...args) {
    console.warn(timestamp(), PREFIX, 'WARN', ...args);
  },
  error(...args) {
    console.error(timestamp(), PREFIX, 'ERROR', ...args);
  },
  debug(...args) {
    if (process.env.DEBUG) {
      console.log(timestamp(), PREFIX, 'DEBUG', ...args);
    }
  },
};
