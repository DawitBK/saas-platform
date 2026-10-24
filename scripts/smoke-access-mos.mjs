#!/usr/bin/env node
/**
 * The MOS half of `npm run smoke:access`: proves, in a real browser, that the identity provider's console decides who may use MOS and as what.
 *
 * It makes one throwaway person in the identity provider (qa.mos.<random>@..., no group), then:
 *   1. with no role for MOS: sign-in is refused with a clear message, and no MOS account is made;
 *   2. with the `guard` role: the person signs in, lands in Odoo, and MOS has made their account at that first sign-in: active, bound to
 *      their identity, holding the gate guard role and not the administrator role;
 *   3. with the role changed to `analyst`: the next sign-in leaves them holding the lab analyst role and no longer the gate guard role;
 *   4. with the role removed: sign-in is refused again.
 * Then it removes the person from the identity provider and archives their MOS account (MOS keeps the account: its tamper-evident audit
 * chain refers to it, so it cannot be deleted).
 *
 * MOS runs from its own repository, so this needs two settings in .env: MOS_ORIGIN (its public address, also used to register it) and
 * MOS_ENV_FILE (the file holding MOS_DB_PASSWORD). MOS_DB_CONTAINER names its database container (default mos-odoo-db-1). Without
 * MOS_ORIGIN and MOS_ENV_FILE this says so and succeeds, because there is nothing to check.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { compose, mustHaveDocker, mustHaveState, platform, settings } from './lib/platform.mjs';

mustHaveDocker();
mustHaveState();
const s = settings({ requireAddresses: false });
if (!s.MOS_ORIGIN || !s.MOS_ENV_FILE) {
  console.log('MOS is not set up here (MOS_ORIGIN and MOS_ENV_FILE in .env): nothing to check.');
  process.exit(0);
}
const origin = s.MOS_ORIGIN.replace(/\/+$/, '');
const dbContainer = s.MOS_DB_CONTAINER || 'mos-odoo-db-1';
const mosPassword = (fs.readFileSync(s.MOS_ENV_FILE, 'utf8').match(/^MOS_DB_PASSWORD=(.*)$/m) ?? [])[1]?.trim().replace(/^['"]|['"]$/g, '');
if (!mosPassword) {
  console.error(`MOS_DB_PASSWORD is not in ${s.MOS_ENV_FILE}.`);
  process.exit(2);
}
const tag = crypto.randomBytes(4).toString('hex');
const email = `qa.mos.${tag}@examplecorp.com`;
const password = `Qa-${crypto.randomBytes(9).toString('base64url')}-1!`;

let failures = 0;
const check = (ok, what, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `  ${detail}` : ''}`);
};
const rows = (stdout) => stdout.split(/\r?\n/).filter(Boolean).map((l) => l.split('\t'));
const idp = (sql) => {
  const r = compose(['exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', platform.databases.sso, '-At', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: 'pipe' });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return rows(r.stdout);
};
const mos = (sql) => {
  const r = spawnSync('docker', ['exec', '-e', `PGPASSWORD=${mosPassword}`, dbContainer, 'psql', '-U', 'odoo', '-d', 'mos', '-At', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return rows(r.stdout);
};
const rolesOf = (login) =>
  mos(`select coalesce(string_agg(g.name->>'en_US', ', '), '') from res_groups g join res_groups_users_rel r on r.gid = g.id join res_users u on u.id = r.uid where u.login = '${login}'`)[0]?.[0] ?? '';

// The throwaway person: made inside the identity provider's container so the password is hashed exactly as a real one.
const makePerson = `
  const { createRequire } = await import('node:module');
  const require = createRequire('/app/backend/package.json');
  const pg = require('pg');
  const { hashPassword } = await import('/app/backend/dist/auth/password.js');
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query("insert into idp_users (email, email_verified, given_name, family_name, password_hash, source, is_active, must_change_password) values ($1, true, 'Quinn', 'Gate', $2, 'local', true, false)", [process.env.QA_EMAIL, await hashPassword(process.env.QA_PASSWORD)]);
  await db.end();`;

let chromium;
try {
  ({ chromium } = await import('@playwright/test'));
} catch {
  console.error('Playwright is not installed. Run: npm install');
  process.exit(2);
}
const browser = await chromium.launch();
async function signInToMos() {
  const page = await (await browser.newContext({ viewport: { width: 1300, height: 900 } })).newPage();
  page.setDefaultTimeout(90000);
  await page.goto(`${origin}/web/login`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('link', { name: /sign in with sso/i }).first().click();
  await page.waitForURL(/\/sso\//, { timeout: 60000 });
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL((u) => u.href.startsWith(origin), { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(4000);
  return { url: page.url(), body: (await page.locator('body').innerText()).replace(/\s+/g, ' ') };
}
const grant = (role) => {
  idp(`delete from idp_client_user_roles where email = '${email}' and client_id = 'mos'`);
  if (role) idp(`insert into idp_client_user_roles (email, client_id, role_name, granted_by) values ('${email}', 'mos', '${role}', 'smoke-access')`);
};

try {
  const made = compose(['exec', '-T', '-e', `QA_EMAIL=${email}`, '-e', `QA_PASSWORD=${password}`, 'sso', 'node', '--input-type=module', '-e', makePerson], { stdio: 'pipe' });
  if (made.status !== 0) throw new Error(`could not make the person: ${made.stderr || made.stdout}`);
  console.log(`throwaway person for MOS: ${email}`);

  const none = await signInToMos();
  check(/not been given access to MOS/i.test(none.body) && !/did not complete/i.test(none.body), 'with no role the person is refused with a clear message');
  check(mos(`select count(*) from res_users where login = '${email}'`)[0][0] === '0', 'and no MOS account is made');

  grant('guard');
  const first = await signInToMos();
  check(/\/odoo/.test(first.url), 'with the guard role the person signs in and lands in Odoo', first.url.replace(/^https:\/\//, '').slice(0, 60));
  const row = mos(`select active, (oauth_uid is not null) from res_users where login = '${email}'`)[0];
  check(row?.[0] === 't' && row?.[1] === 't', 'MOS made the account at that first sign-in, active and bound to the identity');
  const guardRoles = rolesOf(email);
  check(/Gate guard/.test(guardRoles) && !/Administrator/.test(guardRoles), 'it holds the gate guard role and not the administrator role', guardRoles);

  grant('analyst');
  const second = await signInToMos();
  const analystRoles = rolesOf(email);
  check(/\/odoo/.test(second.url) && /Lab analyst/.test(analystRoles) && !/Gate guard/.test(analystRoles), 'a role changed in the console is in force at the next sign-in', analystRoles);

  grant(null);
  const gone = await signInToMos();
  check(/not been given access to MOS/i.test(gone.body), 'with the role removed the person is refused again');
} catch (e) {
  failures += 1;
  console.log(`FAIL ${String(e.message).split('\n')[0]}`);
} finally {
  await browser.close();
  try {
    idp(`delete from idp_client_user_roles where email = '${email}'`);
    idp(`delete from idp_users where email = '${email}'`);
  } catch (e) {
    console.log(`cleanup (identity provider): ${String(e.message).split('\n')[0]}`);
  }
  try {
    mos(`update res_users set active = false where login = '${email}'`);
  } catch (e) {
    console.log(`cleanup (MOS): ${String(e.message).split('\n')[0]}`);
  }
  console.log('the throwaway person is removed from the identity provider and archived in MOS');
}
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
