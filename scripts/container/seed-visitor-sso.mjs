// Runs INSIDE the sso container (mounted at /platform): the identity-provider half of the public sandbox login.
//
// Creates or resets ONE account, DEMO_EMAIL, in the administrators' group (the console and every launcher tile), with the administrator
// role in the document system (SYSTEM_ADMIN) and the guest system (super_admin). It never makes the account a platform administrator
// (it refuses if the address already is one) and never touches any other account.
// Safe to repeat: running it again resets this one account's password, which is how a vandalised demo is put right.
// The password is public by design: the portfolio page that shows it says so.
import { createRequire } from 'node:module';

const email = (process.env.DEMO_EMAIL ?? '').toLowerCase();
const password = process.env.DEMO_PASSWORD ?? '';
if (!email || password.length < 12) {
  console.error('DEMO_EMAIL and a DEMO_PASSWORD of at least 12 characters are required.');
  process.exit(2);
}
const require = createRequire('/app/backend/package.json');
const pg = require('pg');
const { hashPassword } = await import('/app/backend/dist/auth/password.js');

const ADMIN_GROUP = 'CN=EDAMS_Admins,OU=Groups,DC=examplecorp,DC=com';
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 8000 });
await db.connect();
try {
  const existing = (await db.query('select id, is_platform_admin from idp_users where lower(email) = $1', [email])).rows[0];
  if (existing?.is_platform_admin) throw new Error(`${email} is a platform administrator; refusing to publish it.`);
  const hash = await hashPassword(password);
  await db.query('begin');
  let id = existing?.id;
  if (id) {
    await db.query(
      `update idp_users set password_hash = $1, must_change_password = false, is_active = true, is_platform_admin = false,
         failed_logins = 0, locked_until = null, login_failures_cleared_at = now(), updated_at = now() where id = $2`,
      [hash, id],
    );
  } else {
    id = (
      await db.query(
        `insert into idp_users (email, email_verified, given_name, family_name, password_hash, source, is_active, must_change_password)
         values ($1, true, 'Demo', 'Administrator', $2, 'local', true, false) returning id`,
        [email, hash],
      )
    ).rows[0].id;
  }
  await db.query('insert into idp_user_groups (user_id, group_dn) values ($1, $2) on conflict do nothing', [id, ADMIN_GROUP]);
  for (const [client, role] of [['edams', 'SYSTEM_ADMIN'], ['gms', 'super_admin']]) {
    await db.query(`insert into idp_client_user_roles (email, client_id, role_name, granted_by) values ($1, $2, $3, 'seed-visitor') on conflict do nothing`, [email, client, role]);
  }
  await db.query('commit');
  console.log(`identity provider : ${email} ready (administrators' group, DMS SYSTEM_ADMIN, GMS super_admin)`);
} catch (e) {
  await db.query('rollback').catch(() => {});
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
