// What the watchdog decides, kept apart from what it does so it can be tested without Docker.
//
// Docker already restarts a container that exits (restart: unless-stopped). It does not act when a container is frozen,
// marked unhealthy, paused, stopped by mistake, or never created. This is the rule set for those cases.
import path from 'node:path';
import { STATE } from './platform.mjs';

/** Written by `npm run down`: the platform was stopped on purpose, so the watchdog must not start it again. */
export const STOPPED_FILE = path.join(STATE, 'stopped-on-purpose');
/** Written while `npm run up` is building and starting things, so the watchdog does not race it. */
export const UP_LOCK = path.join(STATE, 'up.running');
/** What the watchdog last saw and did; `npm run pm2:status` prints it. */
export const WATCHDOG_FILE = path.join(STATE, 'watchdog.json');

export const LIMITS = {
  // An unhealthy report must last this many checks in a row before the service is restarted (Docker's own check already retried).
  unhealthyChecks: 3,
  // At most this many actions on one service per window; after that it needs a person, and the watchdog says so instead of looping.
  maxActions: 3,
  windowMs: 30 * 60 * 1000,
  // `npm run up` can legitimately run this long; an older lock is a leftover from a crashed run.
  upLockMaxAgeMs: 30 * 60 * 1000,
};

/** `docker compose ps --all --format json` prints one JSON object per line (older versions print an array). */
export function parsePs(text) {
  const t = (text ?? '').trim();
  if (!t) return [];
  if (t.startsWith('[')) return JSON.parse(t);
  return t.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

/** The services that must stay up: everything Compose restarts by itself. Migration jobs and tools are one-shot by design. */
export function watchedServices(composeConfig) {
  return Object.entries(composeConfig.services ?? {})
    .filter(([, s]) => s.restart === 'unless-stopped' || s.restart === 'always')
    .map(([name]) => name);
}

/**
 * @param rows     container facts from `ps --all`: { Service, State, Health }
 * @param watched  names of the services that must stay up
 * @param memory   what earlier checks left behind: { [service]: { unhealthy: number, actions: number[] } }
 * @param now      milliseconds
 * @returns { actions: [{ service, action: 'up' | 'restart' | 'unpause', why }], alerts: [string], memory }
 */
export function decide({ rows, watched, memory = {}, now, limits = LIMITS }) {
  const next = {};
  const actions = [];
  const alerts = [];
  const byService = new Map(rows.map((r) => [r.Service, r]));

  for (const service of watched) {
    const before = memory[service] ?? { unhealthy: 0, actions: [] };
    const recent = before.actions.filter((t) => now - t < limits.windowMs);
    const row = byService.get(service);
    let want = null;
    let unhealthy = 0;

    if (!row) want = { action: 'up', why: 'the container does not exist' };
    else if (row.State === 'paused') want = { action: 'unpause', why: 'the container is paused' };
    else if (row.State === 'exited' || row.State === 'dead' || row.State === 'created') want = { action: 'up', why: `the container is ${row.State}` };
    else if (row.State === 'running' && row.Health === 'unhealthy') {
      unhealthy = before.unhealthy + 1;
      if (unhealthy >= limits.unhealthyChecks) want = { action: 'restart', why: `unhealthy for ${unhealthy} checks in a row` };
    }
    // 'restarting' is Docker's own loop and 'starting' is a health check still settling: neither is acted on.

    if (want && recent.length >= limits.maxActions) {
      alerts.push(`${service}: ${want.why}, and ${recent.length} fixes in the last ${Math.round(limits.windowMs / 60000)} minutes did not hold. A person needs to look (npm run logs).`);
      want = null;
    }
    if (want) {
      actions.push({ service, ...want });
      recent.push(now);
      unhealthy = 0;
    }
    next[service] = { unhealthy, actions: recent };
  }
  return { actions, alerts, memory: next };
}
