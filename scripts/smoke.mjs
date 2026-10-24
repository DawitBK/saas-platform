#!/usr/bin/env node
/**
 * Proves the platform works the way a visitor uses it, and judges by what the PAGE says, never by the address alone.
 *
 *   npm run smoke:local   no browser: asks the entry for each service's health (seconds)
 *   npm run smoke         a real browser: signs in at the public portal as the sandbox administrator and opens every app
 *
 * The browser run needs Chromium once: npx playwright install chromium. It signs in with DEMO_EMAIL / DEMO_PASSWORD from .env
 * (the public sandbox login), opens each tile of the launcher and checks that the page you land on is the app, signed in:
 * not the sign-in form, not an error page, not an address that still says authorize, error or login.
 * Exit code 1 if anything fails.
 */
import { platform, settings } from './lib/platform.mjs';

const s = settings({ requireAddresses: false });
const local = process.argv.includes('--local');
const entry = `http://127.0.0.1:${s.ENTRY_PORT || '15080'}`;
const results = [];
const record = (ok, what, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `  ${detail}` : ''}`);
};

if (local) {
  const checks = [
    ['entry', '/healthz'],
    ['identity provider', '/sso-backend/health'],
    ['guest system', '/api/v1/health'],
    ...Object.entries(platform.apps).map(([key]) => [`${key} API`, `/app-api/${key}/api/v1/health`]),
  ];
  for (const [label, p] of checks) {
    try {
      const res = await fetch(`${entry}${p}`, { signal: AbortSignal.timeout(10000) });
      record(res.ok, label, `${res.status} ${p}`);
    } catch (e) {
      record(false, label, e.cause?.code ?? e.message);
    }
  }
  try {
    const doc = await (await fetch(`${entry}/sso-backend/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10000) })).json();
    record(doc.issuer === `${s.PUBLIC_ORIGIN.replace(/\/+$/, '')}/sso`, 'sign-in document issuer', doc.issuer);
  } catch (e) {
    record(false, 'sign-in document', e.message);
  }
} else {
  let chromium;
  try {
    ({ chromium } = await import('@playwright/test'));
  } catch {
    console.error('Playwright is not installed. Run: npm install');
    process.exit(2);
  }
  const origin = s.PUBLIC_ORIGIN.replace(/\/+$/, '');
  const email = s.DEMO_EMAIL || 'demo.admin@examplecorp.com';
  const password = s.DEMO_PASSWORD;
  if (!password) {
    console.error('Set DEMO_PASSWORD in .env (the public sandbox password) to run the browser check.');
    process.exit(2);
  }
  let browser;
  try {
    browser = await chromium.launch();
  } catch {
    console.error('Chromium is not installed for Playwright. Run once: npx playwright install chromium');
    process.exit(2);
  }
  const web = s.APP_WEB_ORIGINS ? JSON.parse(s.APP_WEB_ORIGINS) : {};
  const BAD_TEXT = /LICENSE_REQUIRED|not licensed|Internal Server Error|Bad Gateway|Service Unavailable|Application error|ERR_/i;
  // What the landing page of each tile must show once signed in (a phrase that is on the app's own home page).
  const tiles = [
    { name: 'Document Management', host: new URL(origin).host, path: /^\/dms\/dashboard/, text: /Enterprise DMS/ },
    { name: 'Guest Management', host: new URL(origin).host, path: /^\/gms\/admin/, text: /Admin Control/ },
    { name: 'Retail OS', host: web['retail-os'] && new URL(web['retail-os']).host, path: /^\/(?!login)/, text: /Retail OS/ },
    { name: 'JobPilot', host: web.jobpilot && new URL(web.jobpilot).host, path: /^\/(?!login)/, text: /JobPilot/ },
    { name: 'Martronics', host: web.martronics && new URL(web.martronics).host, path: /^\/(?!login)/, text: /Sign out/ },
    { name: 'Library', host: web.library && new URL(web.library).host, path: /^\/(?!login)/, text: /Library/ },
  ];
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.setDefaultTimeout(90000);
  try {
    await page.goto(`${origin}/sso/portal`, { waitUntil: 'load' });
    await page.fill('#email', email);
    await page.fill('#password', password);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL(`${origin}/sso/portal**`);
    await page.waitForTimeout(2500);
    const portal = await page.locator('body').innerText();
    record(portal.includes('Welcome,') && !BAD_TEXT.test(portal), 'sign in at the portal', email);
    for (const tile of tiles) {
      await page.goto(`${origin}/sso/portal`, { waitUntil: 'load' });
      await page.waitForTimeout(1200);
      const link = page.getByText(tile.name, { exact: false }).first();
      if (!(await link.count())) {
        record(false, tile.name, 'no such tile on the launcher');
        continue;
      }
      await link.click();
      await page.waitForURL((u) => !/\/sso\/(authorize|interaction)/.test(u.pathname), { timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(3500);
      const url = new URL(page.url());
      const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
      const stuck = /authorize|interaction/.test(url.pathname) || /error=/.test(url.search);
      const hostOk = !tile.host || url.host === tile.host;
      const ok = hostOk && !stuck && tile.path.test(url.pathname) && tile.text.test(body) && !BAD_TEXT.test(body);
      record(ok, tile.name, `${url.host}${url.pathname}${url.search ? ' (' + url.search.slice(0, 40) + ')' : ''} | ${body.slice(0, 70)}`);
    }
  } finally {
    await browser.close();
  }
}
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
