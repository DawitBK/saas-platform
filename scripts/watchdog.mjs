#!/usr/bin/env node
/**
 * Keeps the platform's containers up, as a process supervised by pm2 (see ecosystem.config.cjs). Docker already restarts a
 * container that exits; this covers what Docker does not: a container that is frozen (unhealthy for several checks in a row),
 * paused, stopped by mistake, or missing.
 *
 *   npm run pm2:start        starts it (and brings the platform up first)
 *   npm run pm2:status       what pm2 and the watchdog see
 *
 * It stays out of the way when the platform was stopped on purpose (`npm run down`) and while `npm run up` is running.
 * Settings: WATCHDOG_INTERVAL_SECONDS in .env (default 20).
 */
import fs from 'node:fs';
import path from 'node:path';
import { compose, dockerReady, readEnvFile, ENV_FILE } from './lib/platform.mjs';
import { STOPPED_FILE, UP_LOCK, WATCHDOG_FILE, LIMITS, decide, parsePs, watchedServices } from './lib/supervise.mjs';

const intervalSeconds = Math.max(5, Number(readEnvFile(ENV_FILE).WATCHDOG_INTERVAL_SECONDS) || 20);
const stamp = () => new Date().toISOString();
const say = (...parts) => console.log(stamp(), ...parts);

let watched = [];
let watchedAt = 0;
let memory = {};
let lastStatus = '';
const history = [];

function writeStatus(state, extra = {}) {
  const body = { at: stamp(), intervalSeconds, state, watching: watched.length, recent: history.slice(-20), ...extra };
  fs.mkdirSync(path.dirname(WATCHDOG_FILE), { recursive: true });
  fs.writeFileSync(`${WATCHDOG_FILE}.tmp`, `${JSON.stringify(body, null, 2)}\n`);
  fs.renameSync(`${WATCHDOG_FILE}.tmp`, WATCHDOG_FILE);
  if (state !== lastStatus) say(state);
  lastStatus = state;
}

function upIsRunning() {
  try {
    return Date.now() - fs.statSync(UP_LOCK).mtimeMs < LIMITS.upLockMaxAgeMs;
  } catch {
    return false;
  }
}

function tick() {
  if (fs.existsSync(STOPPED_FILE)) return writeStatus('idle: the platform was stopped on purpose (npm run up starts it again)');
  if (upIsRunning()) return writeStatus('idle: npm run up is running');
  if (!dockerReady()) return writeStatus('waiting: Docker is not running');

  if (!watched.length || Date.now() - watchedAt > 10 * 60 * 1000) {
    const config = compose(['config', '--format', 'json'], { stdio: 'pipe' });
    if (config.status !== 0) return writeStatus('waiting: the platform is not configured (npm run configure)');
    watched = watchedServices(JSON.parse(config.stdout));
    watchedAt = Date.now();
  }

  const ps = compose(['ps', '--all', '--format', 'json'], { stdio: 'pipe' });
  if (ps.status !== 0) return writeStatus('waiting: Docker Compose did not answer');
  const result = decide({ rows: parsePs(ps.stdout), watched, memory, now: Date.now() });
  memory = result.memory;

  for (const { service, action, why } of result.actions) {
    say(`${action} ${service}: ${why}`);
    const args = action === 'up' ? ['up', '-d', '--no-build', '--no-deps', service] : [action, service];
    const r = compose(args, { stdio: 'pipe' });
    const ok = r.status === 0;
    history.push({ at: stamp(), service, action, why, ok });
    if (!ok) say(`  failed: ${(r.stderr ?? '').trim().split(/\r?\n/).slice(-2).join(' | ')}`);
  }
  for (const alert of result.alerts) {
    say(`ALERT ${alert}`);
    history.push({ at: stamp(), alert });
  }
  writeStatus(result.alerts.length ? 'attention: a service keeps failing' : 'ok', { alerts: result.alerts });
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));
say(`watchdog started, checking every ${intervalSeconds} s`);
for (;;) {
  try {
    tick();
  } catch (e) {
    say(`check failed: ${e.message}`);
  }
  await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
}
