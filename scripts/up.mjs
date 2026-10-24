#!/usr/bin/env node
/**
 * Brings the whole platform up and waits until every service reports healthy.
 *
 *   npm run up
 *
 * 1. refreshes the generated settings (idempotent; secrets are kept)
 * 2. builds the images from the editions and the apps, runs each system's database migration, starts everything
 * 3. waits for the health checks, then prints the status
 *
 * Containers restart by themselves (restart: unless-stopped) whenever Docker is running, so after the first `npm run up` there
 * is nothing to start again: not after a crash, not after a reboot (as long as Docker Desktop starts when you sign in).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, STATE, composeOrExit, dockerReady, mustHaveDocker } from './lib/platform.mjs';
import { STOPPED_FILE, UP_LOCK } from './lib/supervise.mjs';

// Started at sign-in by pm2 (--wait-docker): Docker Desktop may still be starting, so wait for it (up to 10 minutes).
if (process.argv.includes('--wait-docker')) {
  for (let i = 0; i < 60 && !dockerReady(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10000));
}
mustHaveDocker();
// Starting is the opposite of "stopped on purpose" (`npm run down`), and while it runs the watchdog must not race it.
fs.mkdirSync(STATE, { recursive: true });
fs.rmSync(STOPPED_FILE, { force: true });
fs.writeFileSync(UP_LOCK, `${process.pid} ${new Date().toISOString()}\n`);
process.on('exit', () => fs.rmSync(UP_LOCK, { force: true }));
process.on('SIGINT', () => process.exit(130));
const run = (script) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', script)], { stdio: 'inherit', cwd: ROOT, windowsHide: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run('configure.mjs');
console.log('\nBuilding and starting (the first build takes several minutes)...');
composeOrExit(['up', '-d', '--build', '--remove-orphans', '--wait', '--wait-timeout', '600']);
console.log('');
run('status.mjs');
