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
import path from 'node:path';
import { ROOT, composeOrExit, mustHaveDocker } from './lib/platform.mjs';

mustHaveDocker();
const run = (script) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', script)], { stdio: 'inherit', cwd: ROOT, windowsHide: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run('configure.mjs');
console.log('\nBuilding and starting (the first build takes several minutes)...');
composeOrExit(['up', '-d', '--build', '--remove-orphans', '--wait', '--wait-timeout', '600']);
console.log('');
run('status.mjs');
