// Shared helpers for every script in this folder: where things are, how to read settings, how to call Docker Compose.
// Nothing in here names a machine, a user or a drive: the root is wherever this repository was cloned, and everything that
// differs between machines comes from .env.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Where the generated settings live, and which settings file to read. Both can be switched with SAAS_STATE_DIR and SAAS_ENV_FILE
// (relative to this folder) to run a second, completely separate copy of the platform, for example to rehearse a change.
const stateRel = (process.env.SAAS_STATE_DIR || '.state').replaceAll('\\', '/').replace(/^\.\//, '');
export const STATE_REL = `./${stateRel}`;
export const STATE = path.join(ROOT, stateRel);
export const ENV_DIR = path.join(STATE, 'env');
export const ENV_FILE = path.join(ROOT, process.env.SAAS_ENV_FILE || '.env');
export const INFRA_ENV = path.join(STATE, 'infra.env');
export const SECRETS_FILE = path.join(STATE, 'secrets.json');
export const platform = JSON.parse(fs.readFileSync(path.join(ROOT, 'platform.json'), 'utf8'));

/** Parses KEY=VALUE lines. Values may be wrapped in single or double quotes. Comments and blank lines are skipped. */
export function parseEnvText(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

export function readEnvFile(file) {
  return fs.existsSync(file) ? parseEnvText(fs.readFileSync(file, 'utf8')) : {};
}

/** The machine's settings from .env, with the three addresses checked. Throws a plain message when .env is missing or wrong. */
export function settings({ requireAddresses = true } = {}) {
  if (!fs.existsSync(ENV_FILE)) {
    throw new Error(`There is no .env yet. Copy .env.example to .env and fill in the addresses (${ENV_FILE}).`);
  }
  const s = readEnvFile(ENV_FILE);
  if (requireAddresses) {
    for (const key of ['PUBLIC_ORIGIN', 'BACKEND_ORIGIN']) {
      if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(s[key] ?? '') || /example\.(com|ts\.net)$/i.test(s[key])) {
        throw new Error(`${key} in .env must be your real https address without a path (it is "${s[key] ?? ''}").`);
      }
    }
  }
  return s;
}

export const hostOf = (origin) => new URL(origin).host;

/** Runs Docker Compose for this project with the settings files attached. Returns the spawn result. */
export function compose(args, { stdio = 'inherit', env = {}, input } = {}) {
  const files = ['--env-file', ENV_FILE];
  if (fs.existsSync(INFRA_ENV)) files.push('--env-file', INFRA_ENV);
  return spawnSync('docker', ['compose', ...files, ...args], {
    cwd: ROOT,
    stdio,
    input,
    encoding: stdio === 'pipe' ? 'utf8' : undefined,
    env: { ...process.env, STATE_DIR: STATE_REL, ...env },
    windowsHide: true,
  });
}

/** Like compose(), but stops the script with the command's exit code when it fails. */
export function composeOrExit(args, options) {
  const r = compose(args, options);
  if (r.status !== 0) process.exit(r.status ?? 1);
  return r;
}

export function dockerReady() {
  const r = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function mustHaveDocker() {
  const version = dockerReady();
  if (!version) {
    console.error('Docker is not running. Start Docker Desktop (set it to start when you sign in) and try again.');
    process.exit(1);
  }
  return version;
}

export function mustHaveState() {
  if (!fs.existsSync(INFRA_ENV) || !fs.existsSync(path.join(ENV_DIR, 'sso.env'))) {
    console.error('The platform is not configured yet. Run: npm run configure');
    process.exit(1);
  }
}

/** The service names and their published/health facts, for status and tests. */
export const SERVICES = [
  'postgres', 'valkey', 'minio', 'backup', 'sso', 'gms', 'dms', 'dms-worker',
  ...Object.values(platform.apps).map((a) => a.service),
  'entry',
];

export function log(...parts) {
  console.log(...parts);
}
