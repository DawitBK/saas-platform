#!/usr/bin/env node
/**
 * First step on a new machine: fetches the repositories the platform is built from and creates .env.
 *
 *   npm install
 *   npm run setup
 *
 * Clones the three editions and the four product apps next to this file (each is its own repository; this repository ignores
 * them), at the branches listed in platform.json. A folder that already exists is left alone. Then creates .env from .env.example
 * if it is missing and tells you what to fill in.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ENV_FILE, ROOT, platform } from './lib/platform.mjs';

const git = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
if (git.status !== 0) {
  console.error('git is not installed.');
  process.exit(1);
}

const wanted = [
  ...platform.editions.map((e) => ({ dir: e.name, repo: e.repo, ref: e.ref })),
  ...Object.values(platform.apps).map((a) => ({ dir: a.dir, repo: a.repo, ref: a.ref })),
];
let failed = 0;
for (const { dir, repo, ref } of wanted) {
  const target = path.join(ROOT, dir);
  if (fs.existsSync(path.join(target, '.git'))) {
    console.log(`have   ${dir}`);
    continue;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  console.log(`clone  ${dir}  (${repo}, ${ref})`);
  const r = spawnSync('git', ['clone', '--branch', ref, repo, target], { stdio: 'inherit', windowsHide: true });
  if (r.status !== 0) failed += 1;
}
if (failed) {
  console.error(`\n${failed} repository(ies) could not be cloned. The editions are private: sign in to GitHub (gh auth login) as an account that can read them.`);
  process.exit(1);
}

if (!fs.existsSync(ENV_FILE)) {
  fs.copyFileSync(path.join(ROOT, '.env.example'), ENV_FILE);
  console.log('\nCreated .env from .env.example. Open it and set PUBLIC_ORIGIN and BACKEND_ORIGIN (and APP_WEB_ORIGINS), then run: npm run up');
} else {
  console.log('\n.env already exists. Next: npm run up');
}
