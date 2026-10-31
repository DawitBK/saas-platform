// What the network watch makes of its records: outages, availability per network, and where in the path a failure is. No network, no files.
import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnose, outagesOf, renderReport, statsBy, statsOf } from '../scripts/lib/netwatch.mjs';

const ok = (ms = 100) => ({ ok: true, ms, status: 200 });
const bad = (error = 'timeout connecting') => ({ ok: false, ms: 10_000, error });
const at = (n) => new Date(Date.UTC(2026, 9, 31, 12, 0, n * 10)).toISOString();
const round = (n, probes, ssid = 'wifi-a') => ({ t: at(n), ssid, probes: { local: ok(), funnel: ok(), portal: ok(), issuer: ok(), ...probes } });

test('one failed round is a blip, two in a row are an outage with the error and the network', () => {
  const records = [round(0, {}), round(1, { funnel: bad() }), round(2, {}), round(3, { funnel: bad('ECONNRESET') }), round(4, { funnel: bad('ECONNRESET') }), round(5, {})];
  const out = outagesOf(records, 'funnel');
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].from, out[0].to, out[0].rounds, out[0].ssid, out[0].error, out[0].endedBy], [at(3), at(4), 2, 'wifi-a', 'ECONNRESET', 'recovered']);
});

test('an outage that has not ended is reported as still down', () => {
  const out = outagesOf([round(0, {}), round(1, { portal: bad() }), round(2, { portal: bad() }), round(3, { portal: bad() })], 'portal');
  assert.equal(out[0].rounds, 3);
  assert.equal(out[0].endedBy, 'still-down');
});

test('availability and the 95th percentile are worked out from the answered rounds only', () => {
  const records = [...Array(19)].map((_, i) => round(i, { funnel: ok(100 + i) })).concat(round(19, { funnel: bad() }));
  const s = statsOf(records, 'funnel');
  assert.equal(s.rounds, 20);
  assert.equal(s.answered, 19);
  assert.equal(s.availability, 0.95);
  assert.equal(s.medianMs, 109);
});

test('statistics are kept apart per Wi-Fi network', () => {
  const records = [round(0, {}, 'home'), round(1, {}, 'home'), round(2, { funnel: bad() }, 'pocket'), round(3, { funnel: bad() }, 'pocket'), round(4, {}, 'pocket')];
  const by = statsBy(records, 'funnel', (r) => r.ssid);
  assert.equal(by.home.availability, 1);
  assert.equal(by.pocket.availability, 1 / 3);
});

test('diagnosis names the first hop that fails', () => {
  assert.match(diagnose(round(0, { local: bad() })), /on this machine/);
  assert.match(diagnose(round(0, { funnel: bad(), portal: bad() })), /public tunnel/);
  assert.match(diagnose(round(0, { portal: bad() })), /Vercel front/);
  assert.match(diagnose(round(0, { issuer: bad() })), /Vercel front/);
  assert.equal(diagnose(round(0, {})), 'everything answers');
});

test('the report says so when there is nothing yet, and lists outages per probe when there is', () => {
  assert.match(renderReport([], { hours: 3 }), /No records yet/);
  const text = renderReport([round(0, {}), round(1, { funnel: bad() }), round(2, { funnel: bad() }), round(3, {})], { hours: 3 });
  assert.match(text, /Outages of funnel .*: 1/);
  assert.match(text, /Outages of portal .*: 0/);
  assert.match(text, /wifi-a/);
});

// ---- nudging Tailscale ----
import { HEAL, healDecision } from '../scripts/lib/netwatch.mjs';

const fresh = { failing: 0, lastAt: 0, step: 0 };
const down = round(0, { funnel: bad('timeout in the TLS handshake') });

test('Tailscale is nudged only after several failed rounds in a row, gently first and a full restart only if that did not help', () => {
  let state = fresh;
  const acted = [];
  for (let i = 0; i < 12; i++) {
    const d = healDecision(state, down, i * 10_000_000);
    state = d.state;
    acted.push(d.action);
  }
  assert.deepEqual(acted.slice(0, HEAL.afterRounds - 1), [null, null]);
  assert.equal(acted[HEAL.afterRounds - 1], 'rebind');
  assert.equal(acted[HEAL.afterRounds], 'restart');
});

test('a nudge is never repeated within the waiting time', () => {
  let state = { failing: 5, lastAt: 1_000_000, step: 1 };
  assert.equal(healDecision(state, down, 1_000_000 + HEAL.gapMs - 1).action, null);
  assert.equal(healDecision(state, down, 1_000_000 + HEAL.gapMs).action, 'restart');
});

test('no nudge when the platform itself is down, when public DNS failed, or when the tunnel answers; the count starts over', () => {
  const state = { failing: 9, lastAt: 0, step: 1 };
  for (const r of [round(0, { local: bad() }), round(0, { funnel: { ok: false, ms: 0, error: 'public DNS did not answer' } }), round(0, {})]) {
    const d = healDecision(state, r, 9e12);
    assert.equal(d.action, null);
    assert.deepEqual([d.state.failing, d.state.step], [0, 0]);
  }
});
