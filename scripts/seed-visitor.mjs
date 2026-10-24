#!/usr/bin/env node
/**
 * The public sandbox login: ONE system administrator who can open every demo. Creates it, or resets its password (which is how a
 * vandalised demo is put right).
 *
 *   npm run seed:visitor
 *
 * Uses DEMO_EMAIL and DEMO_PASSWORD from .env (the password is published on the portfolio on purpose). The account is made in the
 * identity provider's administrators' group (console and every launcher tile) with the administrator role in the document and guest
 * systems, as owner of Retail OS and admin of Martronics and Library, and as the owner of its own organisation in JobPilot.
 * It never makes the account a platform administrator and refuses if the address already is one. Safe to repeat.
 */
import { platform, compose, mustHaveDocker, mustHaveState, settings } from './lib/platform.mjs';

mustHaveDocker();
mustHaveState();
const s = settings({ requireAddresses: false });
const email = s.DEMO_EMAIL || 'demo.admin@examplecorp.com';
const password = s.DEMO_PASSWORD;
if (!password || password.length < 12) {
  console.error('Set DEMO_PASSWORD (at least 12 characters) in .env.');
  process.exit(2);
}
const env = ['-e', `DEMO_EMAIL=${email}`, '-e', `DEMO_PASSWORD=${password}`];
let failed = 0;
const run = (service, script, extra = []) => {
  const r = compose(['exec', '-T', ...env, ...extra, service, 'node', `/platform/${script}`]);
  if (r.status !== 0) failed += 1;
};

run('sso', 'seed-visitor-sso.mjs');
for (const [key, app] of Object.entries(platform.apps)) {
  const role = app.owner;
  run(app.service, 'seed-visitor-app.mjs', ['-e', `APP_KEY=${key}`, ...(role ? ['-e', `APP_ROLE=${role}`] : [])]);
}
console.log(failed ? `\n${failed} step(s) failed.` : '\nDone. The password is public by design; run this again to reset it.');
process.exit(failed ? 1 : 0);
