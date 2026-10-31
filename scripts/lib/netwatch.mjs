/**
 * What the network watch makes of its own records. Pure functions (no clock, no files), so they can be tested:
 * a record is one round of probes, `{ t, ssid, probes: { local, funnel, portal, issuer } }` where each probe is `{ ok, ms, status, error }`.
 */

/** Runs of failed rounds for one probe: [{ from, to, rounds, ssid }]. A run shorter than `minRounds` is a blip, not an outage. */
export function outagesOf(records, probe, minRounds = 2) {
  const out = [];
  let run = null;
  for (const r of records) {
    const p = r.probes?.[probe];
    if (!p) continue;
    if (!p.ok) {
      run ??= { from: r.t, to: r.t, rounds: 0, ssid: r.ssid ?? null, error: p.error ?? `status ${p.status}` };
      run.to = r.t;
      run.rounds += 1;
    } else if (run) {
      if (run.rounds >= minRounds) out.push({ ...run, endedBy: 'recovered' });
      run = null;
    }
  }
  if (run && run.rounds >= minRounds) out.push({ ...run, endedBy: 'still-down' });
  return out;
}

const percentile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);

/** Per probe: how many rounds, what share answered, and how long the answers took. */
export function statsOf(records, probe) {
  const rounds = records.filter((r) => r.probes?.[probe]);
  const ok = rounds.filter((r) => r.probes[probe].ok);
  const times = ok.map((r) => r.probes[probe].ms).sort((a, b) => a - b);
  return {
    rounds: rounds.length,
    answered: ok.length,
    availability: rounds.length ? ok.length / rounds.length : null,
    medianMs: percentile(times, 0.5),
    p95Ms: percentile(times, 0.95),
  };
}

/** The same statistics, one set per value of `keyOf(record)` (for example per Wi-Fi network). */
export function statsBy(records, probe, keyOf) {
  const groups = new Map();
  for (const r of records) {
    const k = keyOf(r) ?? 'unknown';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return Object.fromEntries([...groups].map(([k, rs]) => [k, statsOf(rs, probe)]));
}

/**
 * Where in the path a failure is, from one round: the first hop that fails while the ones before it answer.
 * `local` is the service on this machine, `funnel` the public tunnel to it, `portal` the Vercel front, `issuer` what other systems sign in against.
 */
export function diagnose(round) {
  const p = round.probes ?? {};
  if (!p.local?.ok) return 'the platform on this machine does not answer (Docker or the entry container)';
  if (!p.funnel?.ok) return 'the platform is fine, but the public tunnel (Tailscale Funnel) does not answer';
  if (!p.portal?.ok || !p.issuer?.ok) return 'the tunnel answers, but the Vercel front does not reach it';
  return 'everything answers';
}

/**
 * When to nudge Tailscale. Only when the platform answers here, the tunnel does not, and the reason is the connection to Tailscale
 * (not public DNS, which a nudge cannot fix). Gentle first (new sockets and a fresh look at the network), a full down/up only if that did
 * not help, and never more than one nudge per `gapMs`. `state` is `{ failing, lastAt, step }`; returns the action and the next state.
 */
export const HEAL = { afterRounds: 3, gapMs: 180_000, steps: ['rebind', 'restart'] };

export function healDecision(state, round, now) {
  const p = round.probes ?? {};
  const tunnelDown = p.local?.ok && !p.funnel?.ok && p.funnel?.error !== 'public DNS did not answer';
  if (!tunnelDown) return { action: null, state: { failing: 0, lastAt: state.lastAt, step: 0 } };
  const failing = state.failing + 1;
  if (failing < HEAL.afterRounds || now - (state.lastAt ?? 0) < HEAL.gapMs) return { action: null, state: { ...state, failing } };
  const action = HEAL.steps[Math.min(state.step, HEAL.steps.length - 1)];
  return { action, state: { failing, lastAt: now, step: state.step + 1 } };
}

const pct = (x) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const ms = (x) => (x === null ? 'n/a' : `${Math.round(x)} ms`);
const dur = (a, b) => {
  const s = Math.max(0, Math.round((new Date(b) - new Date(a)) / 1000)) + 10;
  return s < 90 ? `${s}s` : `${Math.round(s / 60)} min`;
};

/** The text the report command prints. */
export function renderReport(records, { hours }) {
  if (!records.length) return 'No records yet: start the watch with npm run pm2:start.';
  const lines = [];
  lines.push(`Network watch, last ${hours} h: ${records.length} rounds, from ${records[0].t} to ${records.at(-1).t}`);
  lines.push('');
  lines.push('Answers by probe:');
  for (const probe of ['local', 'funnel', 'portal', 'issuer']) {
    const s = statsOf(records, probe);
    lines.push(`  ${probe.padEnd(7)} ${pct(s.availability).padStart(7)}   median ${ms(s.medianMs).padStart(8)}   95th ${ms(s.p95Ms).padStart(8)}   (${s.answered}/${s.rounds})`);
  }
  lines.push('');
  lines.push('By Wi-Fi network (public funnel and Vercel portal):');
  const byFunnel = statsBy(records, 'funnel', (r) => r.ssid);
  const byPortal = statsBy(records, 'portal', (r) => r.ssid);
  for (const ssid of Object.keys(byFunnel)) {
    lines.push(
      `  ${String(ssid).padEnd(24)} funnel ${pct(byFunnel[ssid].availability).padStart(7)} (95th ${ms(byFunnel[ssid].p95Ms)})   portal ${pct(byPortal[ssid]?.availability ?? null).padStart(7)} (95th ${ms(byPortal[ssid]?.p95Ms ?? null)})   rounds ${byFunnel[ssid].rounds}`,
    );
  }
  lines.push('');
  for (const probe of ['funnel', 'portal', 'issuer']) {
    const outages = outagesOf(records, probe);
    lines.push(`Outages of ${probe} (two or more failed rounds in a row): ${outages.length}`);
    for (const o of outages.slice(-15)) {
      const where = diagnose(records.find((r) => r.t === o.from) ?? { probes: {} });
      lines.push(`  ${o.from}  ${dur(o.from, o.to).padStart(6)}  on ${o.ssid ?? 'unknown'}  (${o.error}; ${where}; ${o.endedBy})`);
    }
  }
  return lines.join('\n');
}
