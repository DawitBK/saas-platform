#!/usr/bin/env node
/**
 * A backup you can restore from, right now: every database, the object storage, and the generated settings and secrets.
 *
 *   npm run backup
 *
 * Writes .state/backups/<stamp>/ with one custom-format dump per database, miniodata.tgz and a copy of .state (secrets, env files,
 * the owner key). The platform also dumps every database nightly by itself (the `backup` service); this is the full, on-demand one.
 * Keep a copy somewhere other than this machine: backups in the same place as the data are not a backup.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, STATE, compose, mustHaveDocker, mustHaveState, settings } from './lib/platform.mjs';

mustHaveDocker();
mustHaveState();
const s = settings({ requireAddresses: false });
const project = s.COMPOSE_PROJECT_NAME || 'saas-hosting';
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const dir = path.join(STATE, 'backups', stamp);
fs.mkdirSync(dir, { recursive: true });

const list = compose(['exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-Atc', "select datname from pg_database where not datistemplate and datname <> 'postgres'"], { stdio: 'pipe' });
if (list.status !== 0) {
  console.error('Could not list the databases. Is the platform running? (npm run up)');
  process.exit(1);
}
for (const db of list.stdout.split(/\r?\n/).filter(Boolean)) {
  const out = fs.openSync(path.join(dir, `${db}.dump`), 'w');
  const r = spawnSync('docker', ['compose', '--env-file', path.join(ROOT, '.env'), '--env-file', path.join(STATE, 'infra.env'), 'exec', '-T', 'postgres', 'pg_dump', '-U', 'postgres', '-Fc', db], { cwd: ROOT, stdio: ['ignore', out, 'inherit'], windowsHide: true });
  fs.closeSync(out);
  console.log(`${r.status === 0 ? 'ok  ' : 'FAIL'} database ${db} (${fs.statSync(path.join(dir, `${db}.dump`)).size} bytes)`);
  if (r.status !== 0) process.exit(1);
}

const tar = spawnSync('docker', ['run', '--rm', '-v', `${project}_miniodata:/data:ro`, '-v', `${dir}:/out`, 'alpine', 'tar', 'czf', '/out/miniodata.tgz', '-C', '/data', '.'], { stdio: 'inherit', windowsHide: true });
console.log(`${tar.status === 0 ? 'ok  ' : 'FAIL'} object storage (miniodata.tgz)`);

// Settings and secrets, without the backups folder itself.
fs.cpSync(STATE, path.join(dir, 'state'), { recursive: true, filter: (src) => !src.startsWith(path.join(STATE, 'backups')) });
console.log('ok   settings and secrets (state/)');
console.log(`\nBackup written to ${dir}\nCopy it off this machine.`);
