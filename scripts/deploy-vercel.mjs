#!/usr/bin/env node
/**
 * Puts the web parts on Vercel. The platform's data and servers stay on this machine; Vercel serves the pages and forwards API calls
 * to the tunnel.
 *
 *   npm run deploy:vercel -- portal                 the portal: one address for /sso /dms /gms, and the routing to this machine
 *   npm run deploy:vercel -- apps [--only a,b]      the four product apps' web parts
 *   npm run deploy:vercel -- frontends [--only x,y] the identity, guest and document systems' web parts (sso, gms, dms)
 *   add --dry-run to any of them to see what would be written and run, without doing it
 *
 * Uses the Vercel command-line tool signed in with `vercel login`. The Vercel projects must already exist (named
 * <VERCEL_PREFIX>-portal, -sso, -gms, -dms, -retail, -jobpilot, -martronics, -library); the first run in a folder links it to its
 * project. Settings come from .env (PUBLIC_ORIGIN, BACKEND_ORIGIN, APP_WEB_ORIGINS, FRONTEND_ORIGINS, VERCEL_PREFIX, VERCEL_TEAM)
 * and from .state/env/frontends/ (addresses only, no secrets: the front-end builds bake them in). Nothing secret is ever uploaded:
 * a temporary .vercelignore keeps every env file and dependency folder out.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ENV_DIR, ROOT, STATE, platform, readEnvFile, settings } from './lib/platform.mjs';

const [command, ...rest] = process.argv.slice(2);
const dry = rest.includes('--dry-run');
const onlyIdx = rest.indexOf('--only');
const only = onlyIdx >= 0 ? rest[onlyIdx + 1].split(',') : null;
const s = settings();
const origin = s.PUBLIC_ORIGIN.replace(/\/+$/, '');
const backend = s.BACKEND_ORIGIN.replace(/\/+$/, '');
const prefix = s.VERCEL_PREFIX || 'saas';
const team = s.VERCEL_TEAM || '';
const scope = team ? ['--scope', team] : [];
const appOrigins = s.APP_WEB_ORIGINS ? JSON.parse(s.APP_WEB_ORIGINS) : {};
const frontendOrigins = s.FRONTEND_ORIGINS ? JSON.parse(s.FRONTEND_ORIGINS) : {};

const win = process.platform === 'win32';
function vercel(args, { cwd, input, quiet } = {}) {
  if (dry) {
    console.log(`  [dry run] vercel ${args.join(' ')}${cwd ? `   (in ${path.relative(ROOT, cwd) || '.'})` : ''}`);
    return { status: 0 };
  }
  return spawnSync('vercel', args, { cwd, input, shell: win, encoding: 'utf8', stdio: quiet ? 'pipe' : input ? ['pipe', 'inherit', 'inherit'] : 'inherit', windowsHide: true });
}

function link(cwd, project) {
  if (!dry && fs.existsSync(path.join(cwd, '.vercel', 'project.json'))) return;
  const r = vercel(['link', '--yes', '--project', project, ...scope], { cwd });
  if (r.status !== 0) {
    console.error(`Could not link ${path.relative(ROOT, cwd) || '.'} to the Vercel project "${project}". Does it exist, and are you signed in (vercel login)?`);
    process.exit(1);
  }
}

function setEnv(cwd, vars) {
  for (const [name, value] of Object.entries(vars)) {
    const r = vercel(['env', 'add', name, 'production', '--force', ...scope], { cwd, input: value, quiet: true });
    if (r.status !== 0) {
      console.error(`Could not set ${name}.`);
      process.exit(1);
    }
  }
  console.log(`  ${Object.keys(vars).length} variables set`);
}

function deploy(cwd) {
  const ignoreFile = path.join(cwd, '.vercelignore');
  const had = fs.existsSync(ignoreFile);
  const previous = had ? fs.readFileSync(ignoreFile, 'utf8') : '';
  if (!dry) fs.writeFileSync(ignoreFile, `${previous}\n.env\n.env.*\n**/.env\n**/.env.*\nnode_modules\n**/node_modules\n.next\n**/.next\n.turbo\n**/.turbo\ndist\n**/dist\n.git\nlogs\n.state\n`);
  try {
    const r = vercel(['deploy', '--prod', '--yes', ...scope], { cwd });
    if (r.status !== 0) {
      console.error('vercel deploy failed.');
      process.exit(r.status ?? 1);
    }
  } finally {
    if (!dry) {
      if (had) fs.writeFileSync(ignoreFile, previous);
      else fs.rmSync(ignoreFile, { force: true });
    }
  }
}

function portal() {
  for (const k of ['sso', 'dms', 'gms']) {
    if (!/^https:\/\//.test(frontendOrigins[k] ?? '')) {
      console.error(`FRONTEND_ORIGINS in .env must name the address of the ${k} front end (for example {"sso":"https://...","dms":"https://...","gms":"https://..."}).`);
      process.exit(1);
    }
  }
  const config = {
    $schema: 'https://openapi.vercel.sh/vercel.json',
    // Redirects run first. A bare /sso, /dms or /gms used to loop forever (each web app removes the trailing slash the rewrite adds).
    redirects: [
      { source: '/', destination: '/sso/portal', permanent: false },
      { source: '/sso', destination: '/sso/portal', permanent: false },
      { source: '/dms', destination: '/dms/login', permanent: false },
      { source: '/gms', destination: '/gms/login', permanent: false },
    ],
    rewrites: [
      // The servers on this machine, through the tunnel (the specific paths first).
      { source: '/gms/__sso', destination: `${backend}/gms/__sso` },
      { source: '/dms/api/v1/:path*', destination: `${backend}/dms/api/v1/:path*` },
      { source: '/dms/socket.io/:path*', destination: `${backend}/dms/socket.io/:path*` },
      { source: '/api/:path*', destination: `${backend}/api/:path*` },
      { source: '/socket.io/:path*', destination: `${backend}/socket.io/:path*` },
      // The web parts, each already built for its own base path.
      { source: '/sso/:path*', destination: `${frontendOrigins.sso}/sso/:path*` },
      { source: '/dms/:path*', destination: `${frontendOrigins.dms}/dms/:path*` },
      { source: '/gms/:path*', destination: `${frontendOrigins.gms}/gms/:path*` },
    ],
    headers: [{ source: '/(.*)', headers: [{ key: 'X-Content-Type-Options', value: 'nosniff' }, { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }] }],
  };
  const dir = path.join(STATE, 'vercel-portal');
  fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'vercel.json'), `${JSON.stringify(config, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'public', 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=/sso/portal"><title>Portal</title><a href="/sso/portal">Continue</a>\n');
  console.log(`portal routing written to ${path.relative(ROOT, path.join(dir, 'vercel.json'))}`);
  link(dir, `${prefix}-portal`);
  deploy(dir);
}

function apps() {
  for (const [key, app] of Object.entries(platform.apps)) {
    if (only && !only.includes(key)) continue;
    const web = appOrigins[key];
    if (!/^https:\/\//.test(web ?? '')) {
      console.error(`APP_WEB_ORIGINS in .env has no https address for ${key}.`);
      process.exit(1);
    }
    console.log(`\n== ${key}`);
    const cwd = path.join(ROOT, app.dir);
    link(cwd, `${prefix}-${app.service}`);
    setEnv(cwd, { ENABLE_EXPERIMENTAL_COREPACK: '1', API_URL: `${backend}/app-api/${key}`, APP_ORIGIN: web.replace(/\/+$/, '') });
    deploy(cwd);
  }
}

function frontends() {
  const targets = {
    sso: { cwd: path.join(ROOT, 'sso-saas', 'frontend') },
    gms: { cwd: path.join(ROOT, 'gms-saas') },
    dms: { cwd: path.join(ROOT, 'dms-saas') },
  };
  for (const [key, t] of Object.entries(targets)) {
    if (only && !only.includes(key)) continue;
    const file = path.join(ENV_DIR, 'frontends', `${key}.env`);
    if (!fs.existsSync(file)) {
      console.error(`${path.relative(ROOT, file)} is missing. Run: npm run configure`);
      process.exit(1);
    }
    const vars = Object.fromEntries(Object.entries(readEnvFile(file)).filter(([k]) => k.startsWith('NEXT_PUBLIC_') || k === 'SSO_BACKEND_URL'));
    console.log(`\n== ${key} front end`);
    link(t.cwd, `${prefix}-${key}`);
    setEnv(t.cwd, vars);
    deploy(t.cwd);
  }
}

const commands = { portal, apps, frontends };
if (!commands[command]) {
  console.error('Usage: npm run deploy:vercel -- <portal|apps|frontends> [--only a,b] [--dry-run]');
  process.exit(2);
}
commands[command]();
console.log('\nDone. Check it: npm run smoke');
