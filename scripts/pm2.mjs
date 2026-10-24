#!/usr/bin/env node
/**
 * The one way to drive pm2 for this platform. pm2 is a dependency of this repository (npm install), and its own files live in
 * .state/pm2, so nothing is installed globally and a second copy of the platform (SAAS_STATE_DIR) gets its own pm2.
 *
 *   npm run pm2:start     start the stack job and the watchdog (safe to repeat)
 *   npm run pm2:stop      stop watching (the containers keep running); `npm run down` stops the platform itself
 *   npm run pm2:status    pm2's list plus what the watchdog last saw and did
 *   npm run pm2:logs      follow the watchdog and stack logs
 *   npm run pm2:boot      Windows: start all this at every sign-in, in addition to starting it by hand
 *   npm run pm2:unboot    Windows: remove that
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, STATE } from './lib/platform.mjs';
import { WATCHDOG_FILE } from './lib/supervise.mjs';

const [command] = process.argv.slice(2);
const pm2Bin = path.join(ROOT, 'node_modules', 'pm2', 'bin', 'pm2');
if (!fs.existsSync(pm2Bin)) {
  console.error('pm2 is not installed here. Run: npm install');
  process.exit(1);
}
const env = { ...process.env, PM2_HOME: path.join(STATE, 'pm2') };
const pm2 = (args, stdio = 'inherit') => spawnSync(process.execPath, [pm2Bin, ...args], { cwd: ROOT, env, stdio, windowsHide: true });

function printWatchdog() {
  try {
    const w = JSON.parse(fs.readFileSync(WATCHDOG_FILE, 'utf8'));
    console.log(`\nWatchdog: ${w.state} (checked ${w.at}, every ${w.intervalSeconds} s, watching ${w.watching} services)`);
    for (const a of (w.alerts ?? [])) console.log(`  ALERT ${a}`);
    for (const r of w.recent.slice(-5)) console.log(`  ${r.at} ${r.alert ? `ALERT ${r.alert}` : `${r.action} ${r.service}: ${r.why}${r.ok ? '' : ' (failed)'}`}`);
  } catch {
    console.log('\nWatchdog: no report yet (it writes one on its first check).');
  }
}

function boot(action) {
  if (process.platform !== 'win32') {
    console.error('Starting at boot: on Linux or macOS run `npx pm2 startup` once, then `npx pm2 save` after pm2:start.');
    process.exit(1);
  }
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts', 'pm2-boot.ps1'), '-Action', action, '-Repo', ROOT, '-Node', process.execPath], { stdio: 'inherit', windowsHide: true });
  process.exit(r.status ?? 1);
}

switch (command) {
  case 'start': {
    fs.mkdirSync(path.join(STATE, 'logs'), { recursive: true });
    const r = pm2(['startOrRestart', path.join(ROOT, 'ecosystem.config.cjs'), '--update-env']);
    if (r.status !== 0) process.exit(r.status ?? 1);
    console.log('\nStarted. Check it with: npm run pm2:status');
    break;
  }
  case 'stop':
    pm2(['delete', 'saas-watchdog', 'saas-stack'], 'pipe');
    pm2(['kill'], 'pipe');
    console.log('pm2 stopped. The containers are still running (npm run down stops them).');
    break;
  case 'status':
    pm2(['list']);
    printWatchdog();
    break;
  case 'logs':
    pm2(['logs', '--lines', '40']);
    break;
  case 'boot':
  case 'unboot':
    boot(command === 'boot' ? 'install' : 'remove');
    break;
  default:
    console.error('Usage: npm run pm2:<start|stop|status|logs|boot|unboot>');
    process.exit(2);
}
