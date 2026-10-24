// Guards the promises this repository makes: it is self-contained, nothing names a machine or the employer's system,
// and compose.yml, platform.json and the nginx entry agree about the services.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ROOT, platform } from '../scripts/lib/platform.mjs';

const SKIP_DIRS = new Set(['node_modules', '.state', '.git', 'sso-saas', 'dms-saas', 'gms-saas', 'apps']);
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.endsWith('.old-history')) walk(path.join(dir, entry.name), out);
    } else if (!/\.(png|jpg|webp|tgz)$/i.test(entry.name) && entry.name !== 'package-lock.json' && !entry.name.startsWith('.env') || entry.name === '.env.example') {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}
// This file lists the forbidden words, so it cannot be scanned for them.
const files = walk(ROOT).filter((f) => !f.endsWith(`${path.sep}.env`) && f !== fileURLToPath(import.meta.url));

test('no file names a machine, a user, a drive or the employer system', () => {
  const forbidden = [/C:[\\/]Users/i, /\\Users\\[a-z]/i, /\/Users\/[a-z]/i, /kerchanshe/i, /DAWIT-WORKSPACE/i, /\bB:\\/];
  const hits = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const re of forbidden) if (re.test(text)) hits.push(`${path.relative(ROOT, f)} matches ${re}`);
  }
  assert.deepEqual(hits, []);
});

test('every app in platform.json has a nginx route with its own port', () => {
  const conf = fs.readFileSync(path.join(ROOT, 'docker', 'entry', 'default.conf.template'), 'utf8');
  for (const [key, app] of Object.entries(platform.apps)) {
    assert.match(conf, new RegExp(`/app-api/${key}/api/v1/`), `${key} has no location`);
    assert.match(conf, new RegExp(`http://${app.service}:${app.port}`), `${key} upstream is not ${app.service}:${app.port}`);
  }
});

function composeConfig() {
  const env = path.join(os.tmpdir(), `saas-platform-test-${process.pid}.env`);
  fs.writeFileSync(env, ['POSTGRES_PASSWORD=x', 'EDAMS_APP_DB_PASSWORD=x', 'VALKEY_PASSWORD=x', 'MINIO_ROOT_PASSWORD=x', 'PUBLIC_HOST=portal.test'].join('\n'));
  const r = spawnSync('docker', ['compose', '--env-file', env, 'config', '--format', 'json'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  fs.rmSync(env, { force: true });
  return r.status === 0 ? JSON.parse(r.stdout) : null;
}
const cfg = composeConfig();

test('compose.yml is valid and defines the three systems, the apps and the entry', { skip: cfg ? false : 'docker is not available' }, () => {
  const names = Object.keys(cfg.services);
  for (const s of ['postgres', 'valkey', 'minio', 'backup', 'sso', 'gms', 'dms', 'dms-worker', 'entry', ...Object.values(platform.apps).map((a) => a.service)]) {
    assert.ok(names.includes(s), `missing service ${s}`);
  }
});

test('only the entry and the data-plane tool ports are published, and only on loopback', { skip: cfg ? false : 'docker is not available' }, () => {
  const published = [];
  for (const [name, svc] of Object.entries(cfg.services)) {
    for (const p of svc.ports ?? []) published.push({ name, host_ip: p.host_ip });
  }
  assert.ok(published.length > 0);
  for (const p of published) assert.equal(p.host_ip, '127.0.0.1', `${p.name} publishes on ${p.host_ip}`);
  const allowed = new Set(['postgres', 'valkey', 'minio', 'entry']);
  for (const p of published) assert.ok(allowed.has(p.name), `${p.name} must not publish a port`);
});

test('internal ports in platform.json match the services', { skip: cfg ? false : 'docker is not available' }, () => {
  const exposed = (name) => (cfg.services[name].expose ?? []).map(String);
  assert.ok(exposed('sso').includes(String(platform.ports.sso)));
  assert.ok(exposed('sso').includes(String(platform.ports.gateway)));
  assert.ok(exposed('gms').includes(String(platform.ports.gms)));
  assert.ok(exposed('dms').includes(String(platform.ports.dms)));
});

test('every long-running service restarts by itself', { skip: cfg ? false : 'docker is not available' }, () => {
  for (const [name, svc] of Object.entries(cfg.services)) {
    if (name.startsWith('migrate-') || name === 'sso-tools') continue;
    assert.equal(svc.restart, 'unless-stopped', `${name} has no restart policy`);
  }
});

test('fixed addresses lie outside the range other containers are given addresses from', { skip: cfg ? false : 'docker is not available' }, () => {
  const ipam = cfg.networks.default.ipam.config[0];
  assert.ok(ipam.ip_range, 'the network has no ip_range: a container without a fixed address can take one that is reserved');
  const start = Number(ipam.ip_range.split('/')[0].split('.')[3]);
  const bits = Number(ipam.ip_range.split('/')[1]);
  const end = start + 2 ** (32 - bits) - 1;
  for (const [name, svc] of Object.entries(cfg.services)) {
    const ip = svc.networks?.default?.ipv4_address;
    if (!ip) continue;
    const last = Number(ip.split('.')[3]);
    assert.ok(last < start || last > end, `${name} (${ip}) is inside the dynamic range ${ipam.ip_range}`);
  }
});

test('a location that sets its own proxy headers repeats the common ones (nginx drops the inherited set otherwise)', () => {
  const conf = fs.readFileSync(path.join(ROOT, 'docker', 'entry', 'default.conf.template'), 'utf8');
  const blocks = conf.split(/\n\s*location\s/).slice(1);
  const need = ['Host', 'X-Forwarded-For', 'X-Real-IP', 'X-Forwarded-Proto'];
  const bad = [];
  for (const block of blocks) {
    const head = block.split('{')[0].trim();
    const body = block.slice(block.indexOf('{'), block.indexOf('\n  }'));
    if (!/proxy_set_header/.test(body)) continue;
    for (const h of need) if (!new RegExp(`proxy_set_header\\s+${h}\\s`).test(body)) bad.push(`location ${head} lacks ${h}`);
  }
  assert.deepEqual(bad, []);
});
