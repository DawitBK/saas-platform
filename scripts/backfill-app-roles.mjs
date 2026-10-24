#!/usr/bin/env node
/**
 * One-time: gives the people who already have an account in an application the role they hold there, in the identity provider's console.
 *
 *   npm run roles:backfill                 write the grants
 *   npm run roles:backfill -- --dry-run    only say what would be written
 *
 * Once an application is managed from the console, only people who hold one of its roles can sign in to it. Everyone who had an account
 * before that would be locked out until an administrator gave each of them a role by hand; this reads each application's own accounts
 * (the query is `grantsFrom` in platform.json) and writes the same role into the identity provider for every person who has an identity
 * there. It never creates an identity provider account, never changes what an application holds, never removes a grant, and is safe to repeat.
 *
 * MOS keeps its accounts in its own database: set MOS_PEOPLE_FILE in .env to its tools/mos-people.json (login and role per person) to include it.
 */
import fs from 'node:fs';
import { compose, mustHaveDocker, mustHaveState, platform, settings } from './lib/platform.mjs';

mustHaveDocker();
mustHaveState();
const s = settings({ requireAddresses: false });
const dry = process.argv.includes('--dry-run');
const SAFE_EMAIL = /^[^\s'"\\;]+@[^\s'"\\;]+$/;

const psql = (db, sql) => {
  const r = compose(['exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', db, '-At', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: 'pipe' });
  if (r.status !== 0) throw new Error(`${db}: ${r.stderr || r.stdout}`);
  return r.stdout.split(/\r?\n/).filter(Boolean).map((line) => line.split('\t'));
};

// The roles platform.json lists, in the form the identity provider's catalog stores them. The provider seeds the same rows at its start
// (and never overwrites an edit); writing them here first is what lets the grants go in BEFORE the provider is restarted with the new
// code, so nobody is locked out of an application in between.
const lit = (v) => `'${String(v).replaceAll("'", "''")}'`;
const listed = [];
for (const [key, app] of Object.entries(platform.apps)) (app.roles ?? []).forEach((r, i) => listed.push([key, r.name, r.label, (i + 1) * 10]));
if (s.MOS_ORIGIN) (platform.externalClients?.mos?.roles ?? []).forEach((r, i) => listed.push(['mos', r.name, r.label, (i + 1) * 10]));
if (!dry && listed.length > 0) {
  psql(
    platform.databases.sso,
    `insert into idp_client_roles (client_id, role_name, display_name, office_scoped, sort_order) values ${listed
      .map(([c, n, l, o]) => `(${lit(c)}, ${lit(n)}, ${lit(l)}, false, ${o})`)
      .join(', ')} on conflict (client_id, role_name) do nothing`,
  );
}

// Which roles the console offers for each client, and which identities exist: only those are written.
const catalog = new Map();
const addToCatalog = (client, role) => {
  if (!catalog.has(client)) catalog.set(client, new Set());
  catalog.get(client).add(role);
};
for (const [client, role] of psql(platform.databases.sso, 'select client_id, role_name from idp_client_roles')) addToCatalog(client, role);
if (dry) for (const [client, role] of listed) addToCatalog(client, role); // what the catalog will hold once written
const identities = new Set(psql(platform.databases.sso, 'select lower(email) from idp_users').map(([e]) => e));

const wanted = []; // [email, client, role]
const note = [];
for (const [key, app] of Object.entries(platform.apps)) {
  if (!app.grantsFrom || !catalog.has(key)) {
    note.push(`${key}: not managed from the console (no role catalog), skipped`);
    continue;
  }
  let rows;
  try {
    rows = psql(app.db, app.grantsFrom);
  } catch (e) {
    note.push(`${key}: could not read its accounts (${String(e.message).split('\n')[0]}), skipped`);
    continue;
  }
  let kept = 0;
  for (const [email, role] of rows) {
    const e = email.toLowerCase();
    if (!SAFE_EMAIL.test(e) || !identities.has(e) || !catalog.get(key).has(role)) continue;
    wanted.push([e, key, role]);
    kept += 1;
  }
  note.push(`${key}: ${rows.length} account(s) in the application, ${kept} with an identity and a matching role`);
}

if (s.MOS_PEOPLE_FILE && catalog.has('mos')) {
  const people = JSON.parse(fs.readFileSync(s.MOS_PEOPLE_FILE, 'utf8'));
  let kept = 0;
  for (const p of people) {
    const e = String(p.login ?? '').toLowerCase();
    if (!SAFE_EMAIL.test(e) || !identities.has(e) || !catalog.get('mos').has(p.role)) continue;
    wanted.push([e, 'mos', p.role]);
    kept += 1;
  }
  note.push(`mos: ${people.length} person(s) in ${s.MOS_PEOPLE_FILE}, ${kept} with an identity and a matching role`);
} else if (catalog.has('mos')) {
  note.push('mos: MOS_PEOPLE_FILE is not set in .env, skipped');
}
// The people who administer MOS (it grants the administrator role itself, inside MOS): they only need the role that lets them in here.
if (catalog.has('mos')) {
  const admins = (s.MOS_ADMIN_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  let kept = 0;
  for (const e of admins) {
    if (!SAFE_EMAIL.test(e) || !identities.has(e)) continue;
    wanted.push([e, 'mos', 'admin']);
    kept += 1;
  }
  if (admins.length > 0) note.push(`mos: ${admins.length} administrator address(es) in MOS_ADMIN_EMAILS, ${kept} with an identity`);
}

for (const line of note) console.log(line);
if (wanted.length === 0) {
  console.log('\nNothing to write.');
  process.exit(0);
}
if (dry) {
  console.log(`\n${wanted.length} grant(s) would be written:`);
  for (const [e, c, r] of wanted) console.log(`  ${e}  ${c}  ${r}`);
  process.exit(0);
}
const values = wanted.map(([e, c, r]) => `('${e}', '${c}', '${r}', 'backfill')`).join(',\n');
const before = Number(psql(platform.databases.sso, 'select count(*) from idp_client_user_roles')[0][0]);
psql(
  platform.databases.sso,
  `insert into idp_client_user_roles (email, client_id, role_name, granted_by) values ${values} on conflict do nothing`,
);
const after = Number(psql(platform.databases.sso, 'select count(*) from idp_client_user_roles')[0][0]);
console.log(`\n${after - before} new grant(s) written (${wanted.length - (after - before)} already there).`);
