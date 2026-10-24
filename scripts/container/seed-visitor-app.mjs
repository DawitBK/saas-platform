// Runs INSIDE a product app's container (mounted at /platform): the app's half of the public sandbox login.
//
// Creates or resets the DEMO_EMAIL account with the app's top role (APP_ROLE: owner or admin), or, for JobPilot (APP_KEY=jobpilot,
// no staff roles), signs the account up through the app's own API, which also creates the organisation they own.
// It refuses to touch an account that is a platform administrator, and changes no other account.
import { createRequire } from 'node:module';

const email = (process.env.DEMO_EMAIL ?? '').toLowerCase();
const password = process.env.DEMO_PASSWORD ?? '';
const key = process.env.APP_KEY ?? '';
const role = process.env.APP_ROLE ?? '';
if (!email || password.length < 12 || !key) {
  console.error('DEMO_EMAIL, DEMO_PASSWORD (12 characters or more) and APP_KEY are required.');
  process.exit(2);
}
const require = createRequire('/app/package.json');
const pg = require('pg');
const { hashPassword } = await import('/app/dist/auth/auth.service.js');
const hash = await hashPassword(password);

const db = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL, connectionTimeoutMillis: 8000 });
await db.connect();
try {
  // Older databases have no platform-administrator column; then there is nothing to guard or clear.
  const guard = (await db.query("select 1 from information_schema.columns where table_name = 'users' and column_name = 'platform_admin'")).rowCount > 0;
  const live = key === 'jobpilot' ? '' : ' and deleted_at is null';
  let have = (await db.query(`select id${guard ? ', platform_admin' : ''} from users where lower(email) = $1${live}`, [email])).rows[0];
  if (have?.platform_admin) throw new Error(`${email} is a platform administrator in ${key}; refusing.`);

  if (key === 'jobpilot') {
    if (!have) {
      const res = await fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: `${password}Aa1!`, fullName: 'Demo Administrator' }),
      });
      if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text()}`);
      have = (await db.query('select id from users where lower(email) = $1', [email])).rows[0];
    }
    await db.query(`update users set password_hash = $1${guard ? ', platform_admin = false' : ''} where id = $2`, [hash, have.id]);
    console.log(`${key.padEnd(10)}: ${email} ready (owner of its own organisation)`);
  } else {
    if (!role) throw new Error('APP_ROLE is required for this app.');
    if (have) {
      await db.query(`update users set password_hash = $1, role = $2${guard ? ', platform_admin = false' : ''} where id = $3`, [hash, role, have.id]);
    } else {
      await db.query('insert into users (email, password_hash, first_name, last_name, role) values ($1, $2, $3, $4, $5)', [email, hash, 'Demo', 'Administrator', role]);
    }
    console.log(`${key.padEnd(10)}: ${email} ready (${role})`);
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
