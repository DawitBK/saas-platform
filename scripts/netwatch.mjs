#!/usr/bin/env node
/**
 * Watches the road between the public internet and this machine, because that is where "the SSO portal works sometimes" lives:
 * the applications are fine in Docker; what changes is the network the laptop is on (home Wi-Fi, a pocket 4G router, a phone).
 *
 * Every NETWATCH_INTERVAL_SECONDS (default 10) it asks four questions and times each answer:
 *   local   the platform on this machine (the entry container)
 *   funnel  the public tunnel, through Tailscale's real public addresses (not this machine's own shortcut to itself)
 *   portal  the public portal page on Vercel, which has to reach the tunnel
 *   issuer  the sign-in discovery document every other system (MOS, DMS, GMS, the apps) uses to find the identity provider
 * and, once a minute, which Wi-Fi network this is, its signal, the machine's address, and what Tailscale itself says.
 * When the platform answers here but the tunnel does not for three rounds, it nudges Tailscale (see healDecision; NETWATCH_HEAL=off turns that off).
 *
 * Everything goes to .state/logs/netwatch-YYYY-MM-DD.jsonl (14 days kept). `npm run netwatch:report [hours]` turns it into outages
 * and availability per network. Apart from that nudge it only observes.
 */
import { execFile } from 'node:child_process';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { ENV_FILE, readEnvFile, STATE } from './lib/platform.mjs';
import { diagnose, healDecision, outagesOf } from './lib/netwatch.mjs';

const env = readEnvFile(ENV_FILE);
const intervalMs = Math.max(3, Number(process.env.NETWATCH_INTERVAL_SECONDS ?? env.NETWATCH_INTERVAL_SECONDS) || 10) * 1000;
const LOGS = path.join(STATE, 'logs');
const STATUS_FILE = path.join(STATE, 'netwatch.json');
const KEEP_DAYS = 14;
const funnel = new URL(env.BACKEND_ORIGIN);
const portal = new URL(env.PUBLIC_ORIGIN);
const entryPort = Number(env.ENTRY_PORT) || 15080;

const stamp = () => new Date().toISOString();
const say = (...parts) => console.log(stamp(), ...parts);

/** One request with the time of each step. `ip` pins the address (to test a public address and not this machine's shortcut). */
function timed(url, { ip, timeoutMs }) {
  const started = performance.now();
  return new Promise((resolve) => {
    const phases = {};
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      resolve({ ...result, ms: Math.round(performance.now() - started), phases });
    };
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        host: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { host: url.host, 'user-agent': 'netwatch', accept: '*/*' },
        servername: url.hostname,
        agent: false,
        timeout: timeoutMs,
        ...(ip ? { lookup: (_h, opts, cb) => (opts?.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4)) } : {}),
      },
      (res) => {
        phases.firstByte = Math.round(performance.now() - started);
        res.resume();
        res.on('end', () => finish({ ok: res.statusCode < 500, status: res.statusCode }));
        res.on('error', (e) => finish({ ok: false, error: e.code ?? e.message }));
      },
    );
    req.on('socket', (socket) => {
      socket.on('lookup', () => (phases.dns = Math.round(performance.now() - started)));
      socket.on('connect', () => (phases.connect = Math.round(performance.now() - started)));
      socket.on('secureConnect', () => (phases.tls = Math.round(performance.now() - started)));
    });
    req.on('timeout', () => {
      const where = phases.tls ? 'waiting for the answer' : phases.connect ? 'in the TLS handshake' : 'connecting';
      req.destroy();
      finish({ ok: false, error: `timeout ${where}` });
    });
    req.on('error', (e) => finish({ ok: false, error: e.code ?? e.message }));
    req.end();
  });
}

// Tailscale's public ingress addresses for the tunnel, asked of public resolvers (this machine's own answer is its Tailscale address).
const resolver = new dns.promises.Resolver({ timeout: 4000, tries: 1 });
resolver.setServers(['1.1.1.1', '8.8.8.8']);
let ingress = { ips: [], at: 0 };
let turn = 0;

/** Plain DNS first; when a router mangles that, DNS over HTTPS (which it cannot see into). */
async function publicAddresses(host) {
  try {
    const ips = await resolver.resolve4(host);
    if (ips.length) return ips;
  } catch {
    // fall through to DNS over HTTPS
  }
  try {
    const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`, { signal: AbortSignal.timeout(5000) });
    const body = await res.json();
    return (body.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data);
  } catch {
    return [];
  }
}

async function ingressIp() {
  if (!ingress.ips.length || Date.now() - ingress.at > 120_000) {
    const ips = await publicAddresses(funnel.hostname);
    ingress = ips.length ? { ips, at: Date.now() } : { ips: ingress.ips, at: Date.now() - 100_000 };
  }
  return ingress.ips.length ? ingress.ips[turn++ % ingress.ips.length] : null;
}

function run(cmd, args, timeout) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1 << 22 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

async function networkFacts() {
  const facts = { ssid: null, bssid: null, signal: null, rate: null, ip: null, tailscale: null };
  const wifi = await run('netsh', ['wlan', 'show', 'interfaces'], 8000);
  if (wifi) {
    const get = (k) => wifi.match(new RegExp(`^\\s*${k}\\s*:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? null;
    facts.ssid = get('SSID');
    facts.bssid = get('AP BSSID');
    facts.signal = get('Signal');
    facts.rate = get('Receive rate \\(Mbps\\)');
  }
  const wlan = os.networkInterfaces()['Wi-Fi']?.find((a) => a.family === 'IPv4');
  facts.ip = wlan?.address ?? null;
  const ts = await run('tailscale', ['status', '--json'], 20_000);
  if (ts) {
    try {
      const d = JSON.parse(ts);
      facts.tailscale = { state: d.BackendState, health: d.Health ?? [], relay: d.Self?.Relay ?? null, online: d.Self?.Online ?? null };
    } catch {
      facts.tailscale = { state: 'unreadable' };
    }
  } else {
    facts.tailscale = { state: 'no answer from the tailscale command' };
  }
  return facts;
}

function append(record) {
  fs.mkdirSync(LOGS, { recursive: true });
  fs.appendFileSync(path.join(LOGS, `netwatch-${record.t.slice(0, 10)}.jsonl`), `${JSON.stringify(record)}\n`);
}

function prune() {
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  for (const f of fs.existsSync(LOGS) ? fs.readdirSync(LOGS) : []) {
    const m = f.match(/^netwatch-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (m && new Date(m[1]).getTime() < cutoff) fs.rmSync(path.join(LOGS, f), { force: true });
  }
}

const recent = [];
let facts = { ssid: null };
let round = 0;
let last = { up: null, ssid: undefined, ip: undefined, ts: undefined };
let heal = { failing: 0, lastAt: 0, step: 0 };
const healing = (process.env.NETWATCH_HEAL ?? env.NETWATCH_HEAL ?? 'on') !== 'off';

async function tick() {
  const t = stamp();
  if (round % 6 === 0) {
    facts = await networkFacts();
    const tsState = `${facts.tailscale?.state}/${facts.tailscale?.relay}/${(facts.tailscale?.health ?? []).join('|')}`;
    if (facts.ssid !== last.ssid || facts.ip !== last.ip || tsState !== last.ts) {
      say(`network: ${facts.ssid ?? 'no Wi-Fi'} ${facts.signal ?? ''} ${facts.ip ?? ''}; tailscale ${tsState}`);
      append({ t, kind: 'net', ...facts });
      last = { ...last, ssid: facts.ssid, ip: facts.ip, ts: tsState };
    }
  }
  round += 1;
  const ip = await ingressIp();
  const [local, tunnel, front, issuer] = await Promise.all([
    timed(new URL(`http://127.0.0.1:${entryPort}/sso-backend/health`), { timeoutMs: 3000 }),
    ip
      ? timed(new URL(`${funnel.origin}/sso-backend/health`), { ip, timeoutMs: 10_000 })
      : Promise.resolve({ ok: false, ms: 0, error: 'public DNS did not answer', phases: {} }),
    timed(new URL(`${portal.origin}/sso/portal`), { timeoutMs: 15_000 }),
    timed(new URL(`${portal.origin}/sso/.well-known/openid-configuration`), { timeoutMs: 15_000 }),
  ]);
  const record = { t, kind: 'probe', ssid: facts.ssid, probes: { local, funnel: { ...tunnel, ip }, portal: front, issuer } };
  append(record);
  recent.push(record);
  if (recent.length > 4000) recent.shift();

  const decided = healDecision(heal, record, Date.now());
  heal = decided.state;
  if (decided.action && healing) {
    const args = decided.action === 'rebind' ? [['debug', 'rebind'], ['debug', 'restun']] : [['down'], ['up', '--timeout=60s']];
    say(`HEAL: the tunnel has not answered for ${decided.state.failing} rounds while the platform is fine; tailscale ${decided.action}`);
    append({ t: stamp(), kind: 'heal', action: decided.action, failing: decided.state.failing, ssid: facts.ssid });
    for (const a of args) await run('tailscale', a, 90_000);
  }

  const up = tunnel.ok && front.ok && issuer.ok;
  if (up !== last.up) {
    say(up ? 'UP: tunnel, portal and sign-in discovery all answer' : `DOWN: ${diagnose(record)} (funnel ${tunnel.error ?? tunnel.status}, portal ${front.error ?? front.status}, issuer ${issuer.error ?? issuer.status})`);
    last.up = up;
  }
  fs.writeFileSync(
    STATUS_FILE,
    `${JSON.stringify({ at: t, intervalSeconds: intervalMs / 1000, up, diagnosis: diagnose(record), network: facts, latest: record.probes, recentOutages: ['funnel', 'portal', 'issuer'].flatMap((p) => outagesOf(recent, p).map((o) => ({ probe: p, ...o }))).slice(-10) }, null, 2)}\n`,
  );
}

prune();
say(`watching: local :${entryPort}, funnel ${funnel.hostname}, portal ${portal.host}, every ${intervalMs / 1000}s; logs in ${path.relative(process.cwd(), LOGS)}`);
let busy = false;
const loop = async () => {
  if (busy) return;
  busy = true;
  try {
    await tick();
  } catch (e) {
    say(`probe error: ${e.message}`);
  } finally {
    busy = false;
  }
};
await loop();
setInterval(loop, intervalMs);
setInterval(prune, 6 * 3_600_000);
