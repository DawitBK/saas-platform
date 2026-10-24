#!/usr/bin/env node
/**
 * Checks this machine and this checkout against what the platform needs, and says exactly what to do about anything wrong.
 *
 *   npm run doctor
 *
 * Read-only. Exit code 1 when anything FAILS; warnings do not fail it.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ENV_FILE, INFRA_ENV, ROOT, STATE, compose, dockerReady, platform, readEnvFile } from './lib/platform.mjs';

let failures = 0;
const out = (level, what, hint = '') => {
  if (level === 'FAIL') failures += 1;
  console.log(`${level.padEnd(4)} ${what}${hint ? `\n       -> ${hint}` : ''}`);
};
const ok = (what) => out('ok', what);

// ---- the machine
const major = Number(process.versions.node.split('.')[0]);
major >= 22 ? ok(`Node ${process.versions.node}`) : out('FAIL', `Node ${process.versions.node} is too old`, 'install Node 22 or newer');
const docker = dockerReady();
docker ? ok(`Docker engine ${docker}`) : out('FAIL', 'Docker is not running', 'start Docker Desktop and set it to start when you sign in');
const git = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
git.status === 0 ? ok(git.stdout.trim()) : out('FAIL', 'git is not installed');

// ---- settings
let env = {};
if (!fs.existsSync(ENV_FILE)) {
  out('FAIL', '.env is missing', 'run npm run setup, then edit .env');
} else {
  env = readEnvFile(ENV_FILE);
  for (const key of ['PUBLIC_ORIGIN', 'BACKEND_ORIGIN']) {
    /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(env[key] ?? '') && !/example\.(com|ts\.net)$/i.test(env[key])
      ? ok(`${key} = ${env[key]}`)
      : out('FAIL', `${key} in .env is not a real https address`, 'edit .env');
  }
}
fs.existsSync(INFRA_ENV) && fs.existsSync(path.join(STATE, 'env', 'sso.env'))
  ? ok('settings generated (.state)')
  : out('FAIL', 'settings not generated', 'run npm run configure');

// ---- checkouts
for (const dir of [...platform.editions.map((e) => e.name), ...Object.values(platform.apps).map((a) => a.dir)]) {
  const p = path.join(ROOT, dir);
  if (!fs.existsSync(path.join(p, '.git'))) {
    out('FAIL', `${dir} is not cloned`, 'run npm run setup');
    continue;
  }
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: p, encoding: 'utf8', windowsHide: true }).stdout.trim().split('\n').filter(Boolean).length;
  dirty ? out('warn', `${dir} has ${dirty} uncommitted change(s)`, 'the image is built from the working copy, so they are included') : ok(`${dir} clean`);
}

// ---- the network range and the published ports
if (docker) {
  const subnet = env.PLATFORM_SUBNET || '172.29.181';
  const nets = spawnSync('docker', ['network', 'ls', '-q'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\s+/).filter(Boolean);
  const insp = nets.length ? JSON.parse(spawnSync('docker', ['network', 'inspect', ...nets], { encoding: 'utf8', windowsHide: true }).stdout || '[]') : [];
  const clash = insp.filter((n) => !/_default$/.test(n.Name) || !n.Name.startsWith(env.COMPOSE_PROJECT_NAME || 'saas-hosting')).filter((n) => (n.IPAM?.Config ?? []).some((c) => c.Subnet?.startsWith(`${subnet}.`)));
  clash.length ? out('FAIL', `another Docker network already uses ${subnet}.0/24 (${clash.map((n) => n.Name).join(', ')})`, 'set PLATFORM_SUBNET in .env to a free range') : ok(`network range ${subnet}.0/24 is free or ours`);

  const running = compose(['ps', '--format', 'json'], { stdio: 'pipe' });
  const up = (running.stdout ?? '').split(/\r?\n/).filter(Boolean).length;
  up ? ok(`${up} container(s) of this project exist`) : out('warn', 'no containers yet', 'run npm run up');
}

// ---- the tunnel
const ts = spawnSync('tailscale', ['funnel', 'status'], { encoding: 'utf8', windowsHide: true });
if (ts.status === 0) {
  const entry = env.ENTRY_PORT || '15080';
  new RegExp(`127\\.0\\.0\\.1:${entry}\\b`).test(ts.stdout) ? ok(`Tailscale Funnel points at the entry (port ${entry})`) : out('warn', `Tailscale Funnel does not point at port ${entry}`, `run: tailscale funnel --bg ${entry}`);
} else {
  out('warn', 'could not read Tailscale Funnel status', 'if you use another tunnel, point it at the entry port from .env');
}

// ---- backups
const dumps = fs.existsSync(path.join(STATE, 'backups')) ? fs.readdirSync(path.join(STATE, 'backups')).filter((f) => f.endsWith('.dump')) : [];
if (dumps.length) {
  const newest = Math.max(...dumps.map((f) => fs.statSync(path.join(STATE, 'backups', f)).mtimeMs));
  const hours = Math.round((Date.now() - newest) / 3600000);
  hours <= 36 ? ok(`newest nightly dump is ${hours} h old`) : out('warn', `newest nightly dump is ${hours} h old`, 'is the backup service running? npm run status');
} else {
  out('warn', 'no nightly dumps yet', 'the backup service writes the first one a minute after it starts');
}

console.log(failures ? `\n${failures} problem(s) to fix.` : '\nNothing blocking.');
process.exit(failures ? 1 : 0);
