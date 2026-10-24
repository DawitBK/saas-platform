#!/usr/bin/env node
/**
 * Proves, in a real browser through the public portal, that the identity provider's console controls who may use the applications:
 *
 *   npm run smoke:access
 *
 * It makes one throwaway person (qa.access.<random>@..., in no group), then:
 *   1. an administrator opens the person's page in the console and gives them a role in Retail OS and in Library;
 *   2. the person signs in at the portal: only those two applications are on their launcher, each opens signed in, the accounts were created
 *      there at the first sign-in, and hold the roles that were given;
 *   3. the administrator changes the Retail OS role and takes Library away;
 *   4. the person signs in again: Retail OS has the new role, Library is gone from the launcher, and going to it directly is refused with a clear
 *      message (not "did not complete").
 * Then it removes everything it made. It signs in as the public sandbox administrator (DEMO_EMAIL / DEMO_PASSWORD from .env) and needs
 * `npx playwright install chromium` once. Nothing is touched for anyone but the throwaway person.
 */
import crypto from 'node:crypto';
import { compose, mustHaveDocker, mustHaveState, platform, settings } from './lib/platform.mjs';

mustHaveDocker();
mustHaveState();
const s = settings();
const origin = s.PUBLIC_ORIGIN.replace(/\/+$/, '');
const web = JSON.parse(s.APP_WEB_ORIGINS);
const adminEmail = s.DEMO_EMAIL || 'demo.admin@examplecorp.com';
const adminPassword = s.DEMO_PASSWORD;
if (!adminPassword) {
  console.error('Set DEMO_PASSWORD in .env (the public sandbox password).');
  process.exit(2);
}
const tag = crypto.randomBytes(4).toString('hex');
const email = `qa.access.${tag}@examplecorp.com`;
const password = `Qa-${crypto.randomBytes(9).toString('base64url')}-1!`;

let failures = 0;
const check = (ok, what, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `  ${detail}` : ''}`);
};

const psql = (db, sql) => {
  const r = compose(['exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', db, '-At', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: 'pipe' });
  if (r.status !== 0) throw new Error(`${db}: ${r.stderr || r.stdout}`);
  return r.stdout.split(/\r?\n/).filter(Boolean).map((l) => l.split('\t'));
};

// The throwaway person: made inside the identity provider's container so the password is hashed exactly as a real one.
function makePerson() {
  const script = `
    const { createRequire } = await import('node:module');
    const require = createRequire('/app/backend/package.json');
    const pg = require('pg');
    const { hashPassword } = await import('/app/backend/dist/auth/password.js');
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    await db.query("insert into idp_users (email, email_verified, given_name, family_name, password_hash, source, is_active, must_change_password) values ($1, true, 'Quinn', 'Access', $2, 'local', true, false)", [process.env.QA_EMAIL, await hashPassword(process.env.QA_PASSWORD)]);
    await db.end();`;
  const r = compose(['exec', '-T', '-e', `QA_EMAIL=${email}`, '-e', `QA_PASSWORD=${password}`, 'sso', 'node', '--input-type=module', '-e', script], { stdio: 'pipe' });
  if (r.status !== 0) throw new Error(`could not make the person: ${r.stderr || r.stdout}`);
}

function cleanUp() {
  const quiet = (fn) => {
    try {
      fn();
    } catch (e) {
      console.log(`cleanup: ${String(e.message).split('\n')[0]}`);
    }
  };
  for (const [key, app] of Object.entries(platform.apps)) {
    quiet(() => psql(app.db, `delete from refresh_tokens where user_id in (select id from users where email = '${email}')`));
    quiet(() => psql(app.db, `delete from users where email = '${email}'`));
    void key;
  }
  quiet(() => psql(platform.databases.sso, `delete from idp_client_user_roles where email = '${email}'`));
  quiet(() => psql(platform.databases.sso, `delete from idp_users where email = '${email}'`));
}

let chromium;
try {
  ({ chromium } = await import('@playwright/test'));
} catch {
  console.error('Playwright is not installed. Run: npm install');
  process.exit(2);
}
const browser = await chromium.launch();
const open = async () => {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
  page.setDefaultTimeout(90000);
  return page;
};
async function signInAtPortal(page, who, pass) {
  await page.goto(`${origin}/sso/portal`, { waitUntil: 'load' });
  await page.fill('#email', who);
  await page.fill('#password', pass);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL(`${origin}/sso/portal**`);
  await page.getByText('Welcome,').first().waitFor();
  await page.waitForTimeout(1500);
}
const tiles = async (page) => {
  await page.goto(`${origin}/sso/portal`, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  const text = await page.locator('body').innerText();
  return Object.fromEntries(['Document Management', 'Guest Management', 'Retail OS', 'JobPilot', 'Martronics', 'Library', 'MOS'].map((n) => [n, text.includes(n)]));
};
async function openFromLauncher(page, name) {
  await page.goto(`${origin}/sso/portal`, { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  await page.getByText(name, { exact: false }).first().click();
  await page.waitForURL((u) => !/\/sso\/(authorize|interaction)/.test(u.pathname), { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3500);
  return { url: new URL(page.url()), body: (await page.locator('body').innerText()).replace(/\s+/g, ' ') };
}

try {
  makePerson();
  console.log(`throwaway person: ${email}`);
  const admin = await open();
  await signInAtPortal(admin, adminEmail, adminPassword);

  // The console: find the person and give them roles.
  const personId = psql(platform.databases.sso, `select id from idp_users where email = '${email}'`)[0][0];
  async function openPersonInConsole() {
    await admin.goto(`${origin}/sso/admin/users/${personId}`, { waitUntil: 'load' });
    await admin.getByText('Application roles').first().waitFor();
  }
  async function setRoles(roles) {
    await openPersonInConsole();
    for (const [client, role] of Object.entries(roles)) await admin.selectOption(`#app_role_${client}`, role);
    await admin.getByRole('button', { name: 'Save application roles' }).click();
    await admin.getByText('Application roles saved').first().waitFor();
    await admin.waitForTimeout(800);
  }
  async function selection(client) {
    return admin.locator(`#app_role_${client}`).inputValue();
  }

  await openPersonInConsole();
  const offered = await admin.locator('select[id^="app_role_"]').evaluateAll((els) => els.map((e) => e.id.replace('app_role_', '')));
  check(['retail-os', 'library', 'martronics', 'jobpilot'].every((c) => offered.includes(c)), 'the console offers a role for every application', offered.join(', '));
  check((await selection('retail-os')) === '' && (await selection('library')) === '', 'a new person has no access to any of them');

  await setRoles({ 'retail-os': 'cashier', library: 'librarian' });
  check((await selection('retail-os')) === 'cashier' && (await selection('library')) === 'librarian', 'the roles are saved and shown again', 'cashier, librarian');

  // The person signs in: only what was given.
  const person = await open();
  await signInAtPortal(person, email, password);
  const seen = await tiles(person);
  check(seen['Retail OS'] && seen['Library'] && !seen['Martronics'] && !seen['JobPilot'] && !seen['MOS'], 'the launcher shows only the two applications given', JSON.stringify(Object.entries(seen).filter(([, v]) => v).map(([k]) => k)));

  const retail = await openFromLauncher(person, 'Retail OS');
  check(retail.url.host === new URL(web['retail-os']).host && !/\/login/.test(retail.url.pathname) && /Retail OS/.test(retail.body), 'Retail OS opens signed in', `${retail.url.host}${retail.url.pathname}`);
  const library = await openFromLauncher(person, 'Library');
  check(library.url.host === new URL(web.library).host && !/\/login/.test(library.url.pathname) && /Library/.test(library.body), 'Library opens signed in', `${library.url.host}${library.url.pathname}`);
  const roleIn = (key) => psql(platform.apps[key].db, `select role from users where email = '${email}'`)[0]?.[0];
  check(roleIn('retail-os') === 'cashier' && roleIn('library') === 'librarian', 'the accounts were created in the applications with those roles', `${roleIn('retail-os')}, ${roleIn('library')}`);

  // The administrator changes one and removes the other.
  await setRoles({ 'retail-os': 'manager', library: '' });
  check((await selection('retail-os')) === 'manager' && (await selection('library')) === '', 'the change and the removal are saved');

  const again = await open();
  await signInAtPortal(again, email, password);
  const seenAgain = await tiles(again);
  check(seenAgain['Retail OS'] && !seenAgain['Library'], 'the launcher now shows Retail OS only', JSON.stringify(Object.entries(seenAgain).filter(([, v]) => v).map(([k]) => k)));
  await openFromLauncher(again, 'Retail OS');
  check(roleIn('retail-os') === 'manager', 'Retail OS gave the person the new role at the next sign-in', roleIn('retail-os'));

  // Going to the removed application directly is refused, in words.
  await again.goto(`${web.library.replace(/\/+$/, '')}/login/sso`, { waitUntil: 'load' });
  await again.waitForURL((u) => /\/login/.test(u.pathname) && /error=/.test(u.search), { timeout: 60000 }).catch(() => {});
  await again.waitForTimeout(1500);
  const refused = (await again.locator('body').innerText()).replace(/\s+/g, ' ');
  check(/error=no-access/.test(again.url()) && /not been given access/i.test(refused) && !/did not complete/i.test(refused), 'going to the removed application is refused with a clear message', again.url().replace(/^https:\/\//, '').slice(0, 70));
} catch (e) {
  failures += 1;
  console.log(`FAIL ${String(e.message).split('\n')[0]}`);
} finally {
  await browser.close();
  cleanUp();
  console.log('the throwaway person and its accounts are removed');
}
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
