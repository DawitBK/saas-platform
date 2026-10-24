// The watchdog's rules (scripts/lib/supervise.mjs) and the pm2 process list, tested without Docker or pm2.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { ROOT } from '../scripts/lib/platform.mjs';
import { LIMITS, decide, parsePs, watchedServices } from '../scripts/lib/supervise.mjs';

const row = (Service, State = 'running', Health = 'healthy') => ({ Service, State, Health });
const run = (rows, memory, now = 1_000_000, watched = ['sso', 'retail']) => decide({ rows, watched, memory, now });

test('healthy services get no action', () => {
  const r = run([row('sso'), row('retail')]);
  assert.deepEqual(r.actions, []);
  assert.deepEqual(r.alerts, []);
});

test('a stopped, missing or paused service is put back', () => {
  assert.deepEqual(run([row('sso'), row('retail', 'exited', '')]).actions.map((a) => [a.service, a.action]), [['retail', 'up']]);
  assert.deepEqual(run([row('sso')]).actions.map((a) => [a.service, a.action]), [['retail', 'up']]);
  assert.deepEqual(run([row('sso', 'paused', ''), row('retail')]).actions.map((a) => [a.service, a.action]), [['sso', 'unpause']]);
});

test('Docker\'s own restart loop and a health check still settling are left alone', () => {
  assert.deepEqual(run([row('sso', 'restarting', ''), row('retail', 'running', 'starting')]).actions, []);
});

test('an unhealthy service is restarted only after several checks in a row, and a healthy check resets the count', () => {
  assert.deepEqual(run([row('sso', 'running', 'unhealthy'), row('retail')]).actions, [], 'one unhealthy report alone is never enough');
  assert.ok(LIMITS.unhealthyChecks >= 2);
  let memory;
  for (let i = 1; i < LIMITS.unhealthyChecks; i += 1) {
    const r = run([row('sso', 'running', 'unhealthy'), row('retail')], memory, 1_000_000 + i);
    assert.deepEqual(r.actions, [], `check ${i} must not act yet`);
    memory = r.memory;
  }
  // one healthy check in between starts the count again
  memory = run([row('sso'), row('retail')], memory, 1_000_100).memory;
  for (let i = 1; i < LIMITS.unhealthyChecks; i += 1) memory = run([row('sso', 'running', 'unhealthy'), row('retail')], memory, 1_000_200 + i).memory;
  const last = run([row('sso', 'running', 'unhealthy'), row('retail')], memory, 1_000_300);
  assert.deepEqual(last.actions.map((a) => [a.service, a.action]), [['sso', 'restart']]);
  assert.equal(last.memory.sso.unhealthy, 0, 'the count restarts after acting');
});

test('a service that keeps failing is reported to a person instead of being fixed forever, and is tried again later', () => {
  let memory;
  const stopped = [row('sso'), row('retail', 'exited', '')];
  for (let i = 0; i < LIMITS.maxActions; i += 1) {
    const r = run(stopped, memory, 1_000_000 + i * 1000);
    assert.equal(r.actions.length, 1);
    memory = r.memory;
  }
  const blocked = run(stopped, memory, 1_000_000 + 10_000);
  assert.deepEqual(blocked.actions, []);
  assert.equal(blocked.alerts.length, 1);
  assert.match(blocked.alerts[0], /retail/);
  const later = run(stopped, blocked.memory, 1_000_000 + LIMITS.windowMs + 60_000);
  assert.equal(later.actions.length, 1, 'after the window the watchdog tries again');
});

test('only services Compose restarts by itself are watched: migration jobs end by design', () => {
  const config = { services: { postgres: { restart: 'unless-stopped' }, 'migrate-sso': { restart: 'no' }, sso: { restart: 'unless-stopped' }, tool: {} } };
  assert.deepEqual(watchedServices(config), ['postgres', 'sso']);
});

test('docker compose ps output is read as one object per line or as an array', () => {
  const a = { Service: 'sso', State: 'running' };
  const b = { Service: 'gms', State: 'exited' };
  assert.deepEqual(parsePs(`${JSON.stringify(a)}\n${JSON.stringify(b)}\n`), [a, b]);
  assert.deepEqual(parsePs(JSON.stringify([a, b])), [a, b]);
  assert.deepEqual(parsePs(''), []);
});

test('the pm2 process list names the job and the watchdog and points at scripts that exist', () => {
  const eco = createRequire(import.meta.url)(path.join(ROOT, 'ecosystem.config.cjs'));
  const byName = Object.fromEntries(eco.apps.map((a) => [a.name, a]));
  assert.deepEqual(Object.keys(byName).sort(), ['saas-stack', 'saas-watchdog']);
  for (const app of eco.apps) assert.ok(fs.existsSync(path.join(ROOT, app.script)), `${app.script} exists`);
  assert.equal(byName['saas-stack'].autorestart, false, 'the start job runs once');
  assert.match(byName['saas-stack'].args, /--wait-docker/, 'at sign-in it must wait for Docker Desktop');
  assert.equal(byName['saas-watchdog'].autorestart, true);
  for (const app of eco.apps) assert.equal(app.windowsHide, true);
});

test('stopping on purpose and starting again are paired: down leaves the marker, up removes it and holds the lock', () => {
  const down = fs.readFileSync(path.join(ROOT, 'scripts', 'down.mjs'), 'utf8');
  const up = fs.readFileSync(path.join(ROOT, 'scripts', 'up.mjs'), 'utf8');
  assert.match(down, /writeFileSync\(STOPPED_FILE/);
  assert.match(up, /rmSync\(STOPPED_FILE/);
  assert.match(up, /writeFileSync\(UP_LOCK/);
  assert.match(up, /rmSync\(UP_LOCK/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts.down, 'node scripts/down.mjs');
});
