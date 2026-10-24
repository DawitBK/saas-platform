#!/usr/bin/env node
/**
 * What is running and whether it answers.
 *
 *   npm run status
 *
 * Reads Docker's own view (container state and health) and then asks the entry for the three things a visitor depends on: the
 * entry itself, the identity provider through it, and the identity provider's published sign-in document (its issuer must be the
 * public address, or every sign-in would fail).
 */
import { compose, mustHaveDocker, mustHaveState, settings } from './lib/platform.mjs';

mustHaveDocker();
mustHaveState();
const s = settings({ requireAddresses: false });
const entryPort = s.ENTRY_PORT || '15080';

const ps = compose(['ps', '--all', '--format', 'json'], { stdio: 'pipe' });
const rows = (ps.stdout ?? '')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .sort((a, b) => a.Service.localeCompare(b.Service));

let bad = 0;
for (const r of rows) {
  const oneShot = r.Service.startsWith('migrate-');
  const ok = oneShot ? r.State === 'exited' && r.ExitCode === 0 : r.State === 'running' && (!r.Health || r.Health === 'healthy');
  if (!ok) bad += 1;
  const what = oneShot ? `${r.State} (exit ${r.ExitCode})` : `${r.State}${r.Health ? `, ${r.Health}` : ''}`;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${r.Service.padEnd(18)} ${what}`);
}
if (!rows.length) {
  console.log('Nothing is running. Start it with: npm run up');
  process.exit(1);
}

async function probe(label, url, check) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const body = await res.text();
    const verdict = check ? check(res, body) : res.ok;
    console.log(`${verdict ? 'ok  ' : 'FAIL'} ${label.padEnd(18)} ${verdict === true ? `${res.status}` : verdict}`);
    if (verdict !== true) bad += 1;
  } catch (e) {
    console.log(`FAIL ${label.padEnd(18)} ${e.cause?.code ?? e.message}`);
    bad += 1;
  }
}
console.log('');
await probe('entry', `http://127.0.0.1:${entryPort}/healthz`);
await probe('identity (entry)', `http://127.0.0.1:${entryPort}/sso-backend/health`);
await probe('sign-in document', `http://127.0.0.1:${entryPort}/sso-backend/.well-known/openid-configuration`, (res, body) => {
  if (!res.ok) return `${res.status}`;
  const issuer = JSON.parse(body).issuer;
  const want = `${(s.PUBLIC_ORIGIN ?? '').replace(/\/+$/, '')}/sso`;
  return issuer === want ? true : `issuer is ${issuer}, expected ${want}`;
});
console.log(bad ? `\n${bad} problem(s). Logs: npm run logs` : '\nAll good.');
process.exit(bad ? 1 : 0);
