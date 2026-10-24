#!/usr/bin/env node
/**
 * Restores one database from a dump made by `npm run backup` or by the nightly backup service.
 *
 *   npm run restore -- <path to a .dump file> [database]
 *
 * The database name defaults to the dump's file name without the date prefix and extension. The database is dropped and recreated
 * from the dump, so everything written since the backup is lost: stop the services that use it first
 * (npm run compose -- stop sso gms dms dms-worker) and start them again afterwards (npm run up).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { INFRA_ENV, ENV_FILE, ROOT, compose, mustHaveDocker, mustHaveState } from './lib/platform.mjs';

mustHaveDocker();
mustHaveState();
const [file, nameArg] = process.argv.slice(2);
if (!file || !fs.existsSync(file)) {
  console.error('Usage: npm run restore -- <path to a .dump file> [database]');
  process.exit(2);
}
const base = path.basename(file, '.dump');
const db = nameArg ?? base.replace(/^\d{8}-\d{6}-/, '');
if (!/^[a-z0-9_]+$/.test(db)) {
  console.error(`"${db}" is not a plain database name.`);
  process.exit(2);
}

const sql = (text) => compose(['exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', text]);
if (sql(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).status !== 0 || sql(`CREATE DATABASE ${db}`).status !== 0) process.exit(1);
const input = fs.openSync(file, 'r');
const r = spawnSync('docker', ['compose', '--env-file', ENV_FILE, '--env-file', INFRA_ENV, 'exec', '-T', 'postgres', 'pg_restore', '-U', 'postgres', '--no-owner', '-d', db], { cwd: ROOT, stdio: [input, 'inherit', 'inherit'], windowsHide: true });
fs.closeSync(input);
console.log(r.status === 0 ? `\nRestored ${db} from ${file}.` : `\npg_restore reported problems (exit ${r.status}); check the output above.`);
process.exit(r.status ?? 1);
