// pm2 process list for the platform. Start it with `npm run pm2:start` (never call pm2 directly: the wrapper keeps pm2's own
// files inside this folder's .state and refuses to run when something is missing).
//
//  - saas-stack     runs `npm run up` once (configure, build, migrate, start, wait until healthy), then ends. It shows as
//                   "stopped" in pm2 afterwards; that is normal, it is a job and not a service.
//  - saas-watchdog  runs for good: fixes a container that is frozen, paused, stopped by mistake or missing (scripts/watchdog.mjs).
//
// The applications themselves still run in Docker. pm2 starts and watches the stack; it does not replace Docker.
const path = require('node:path');

const state = (process.env.SAAS_STATE_DIR || '.state').replace(/^\.[\\/]/, '');
const logs = path.join(__dirname, state, 'logs');

const common = {
  cwd: __dirname,
  interpreter: process.execPath,
  windowsHide: true,
  time: true,
  merge_logs: true,
};

module.exports = {
  apps: [
    {
      ...common,
      name: 'saas-stack',
      script: 'scripts/up.mjs',
      args: '--wait-docker',
      autorestart: false,
      out_file: path.join(logs, 'stack.log'),
      error_file: path.join(logs, 'stack.log'),
    },
    {
      ...common,
      name: 'saas-watchdog',
      script: 'scripts/watchdog.mjs',
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 100,
      out_file: path.join(logs, 'watchdog.log'),
      error_file: path.join(logs, 'watchdog.log'),
    },
  ],
};
