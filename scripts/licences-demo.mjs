#!/usr/bin/env node
/**
 * Gives this demo platform valid licences for the three systems, the documented way for a NON-LIVE environment
 * (SSO's docs/operations/PLATFORM-LICENSING.md, section 9.3 and 9.4): a licence-signing key made for this platform, trusted by the
 * three systems, and one never-expiring "demo" licence per system written into the identity provider's database.
 *
 *   npm run licences:demo
 *
 * Why it exists: in production mode every system is unusable until it holds a verified licence. A real deployment gets its licences
 * from the owner through the identity provider's console (with owner verification) or by signing offline; this command is only for
 * a sandbox like this one, and it says so in every record it writes ("Example Corp (demo)"). It is safe to run again.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT, STATE, compose, composeOrExit, mustHaveDocker, mustHaveState, settings } from './lib/platform.mjs';

mustHaveDocker();
mustHaveState();
const s = settings({ requireAddresses: false });
void s;

console.log('1. licence-signing key (kept in .state/licence, never committed)');
composeOrExit(['run', '--rm', '--build', 'sso-tools', 'node', '/platform/licence-keygen.mjs']);

console.log('\n2. settings: the three systems trust that key');
const cfg = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'configure.mjs')], { stdio: 'inherit', cwd: ROOT, windowsHide: true });
if (cfg.status !== 0) process.exit(cfg.status ?? 1);

console.log('\n3. demo licences in the identity provider (one per system, never expiring)');
const db = 'sso_saas';
const issue = compose(
  ['run', '--rm', '-e', `I_UNDERSTAND_THIS_ISSUES_LICENCES=${db}`, 'sso-tools', 'npx', 'tsx', 'scripts/license-dev-issue.ts', '--customer', 'Example Corp (demo)', '--expires', 'never', '--modes', 'sso', '--systems', 'sso,gms,dms'],
);
if (issue.status !== 0) process.exit(issue.status ?? 1);

console.log(`\nDone. Restart the systems so they load the key: npm run up   (state is in ${STATE})`);
