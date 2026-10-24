#!/usr/bin/env node
/**
 * Writes everything the containers read, from .env and from the secrets kept in .state/. Safe to run again: secrets are
 * generated once and kept, only addresses change.
 *
 *   npm run configure
 *
 * Writes .state/infra.env (passwords for the data plane, read by Docker Compose), .state/secrets.json (every generated secret),
 * and .state/env/<service>.env (one file per service). Templates are the editions' own .env example files, so a setting an edition
 * adds later is picked up here too; settings this script does not know keep the template's value, and a template value that is
 * still a placeholder stops the run with a clear message.
 */
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ENV_DIR, INFRA_ENV, ROOT, SECRETS_FILE, STATE, hostOf, platform, readEnvFile, settings } from './lib/platform.mjs';

const s = settings();
const origin = s.PUBLIC_ORIGIN.replace(/\/+$/, '');
const backendOrigin = s.BACKEND_ORIGIN.replace(/\/+$/, '');
const mosOrigin = (s.MOS_ORIGIN ?? '').replace(/\/+$/, '');
const mosInternal = (s.MOS_INTERNAL_URL || 'http://host.docker.internal:8069').replace(/\/+$/, '');
const appOrigins = s.APP_WEB_ORIGINS ? JSON.parse(s.APP_WEB_ORIGINS) : {};
// The systems' internal APIs answer only the addresses listed here (an exact-address list; "*" is refused in production). The
// containers have fixed addresses on the platform network, so the list is the three systems and nothing else (compose.yml).
const subnet = s.PLATFORM_SUBNET || '172.29.181';
const ip = { sso: `${subnet}.10`, gms: `${subnet}.20`, dms: `${subnet}.30` };
const loopback = '127.0.0.1,::1,::ffff:127.0.0.1';

for (const edition of platform.editions) {
  if (!fs.existsSync(path.join(ROOT, edition.name))) {
    console.error(`${edition.name} is not here yet. Run: npm run setup`);
    process.exit(1);
  }
}
fs.mkdirSync(ENV_DIR, { recursive: true });
fs.mkdirSync(path.join(STATE, 'owner'), { recursive: true });
fs.mkdirSync(path.join(STATE, 'backups'), { recursive: true });

// ---------------------------------------------------------------------------------------------- secrets
const secrets = fs.existsSync(SECRETS_FILE) ? JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8')) : {};
const secret = (name, bytes = 32) => (secrets[name] ??= randomBytes(bytes).toString('base64url'));
const rsa = () => {
  if (!secrets.rsa) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    secrets.rsa = {
      private: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64'),
      public: Buffer.from(publicKey.export({ type: 'spki', format: 'pem' })).toString('base64'),
    };
  }
  return secrets.rsa;
};

// The data plane's passwords: kept if they exist (an existing database cannot change its password by editing a file).
const infra = readEnvFile(INFRA_ENV);
for (const key of ['POSTGRES_PASSWORD', 'EDAMS_APP_DB_PASSWORD', 'VALKEY_PASSWORD', 'MINIO_ROOT_PASSWORD']) {
  infra[key] ||= randomBytes(24).toString('base64url');
}
infra.PUBLIC_HOST = hostOf(origin);
fs.writeFileSync(INFRA_ENV, `${Object.entries(infra).map(([k, v]) => `${k}=${v}`).join('\n')}\n`, { mode: 0o600 });

// Optional outbound mail: .state/smtp.json = { host, port, user, pass, address, names: { gms, dms, mos } }. Without it the systems get a
// placeholder mail server and send nothing.
const smtpFile = path.join(STATE, 'smtp.json');
const smtp = fs.existsSync(smtpFile) ? JSON.parse(fs.readFileSync(smtpFile, 'utf8')) : null;
// The licence key made by `npm run licences:demo`: the public half every system trusts, and the private half the identity
// provider signs with (a file inside its container). Without it the licence settings are left as the editions ship them.
const licenceDir = path.join(STATE, 'licence');
const trustFile = path.join(licenceDir, 'trust.json');
const trust = fs.existsSync(trustFile) ? JSON.stringify(JSON.parse(fs.readFileSync(trustFile, 'utf8'))) : null;
const signingKey = fs.existsSync(licenceDir) ? fs.readdirSync(licenceDir).find((f) => /^license-private-.*\.pem$/.test(f)) : null;
const licenceValues = trust ? { LICENSE_TRUST_PUBLIC_KEYS: trust } : {};
// The product apps registered with the identity provider: client id and secret per app, carried over from the previous setup.
const productFile = path.join(STATE, 'apps-sso.json');
const productSso = fs.existsSync(productFile) ? JSON.parse(fs.readFileSync(productFile, 'utf8')) : null;
// The roles the identity provider's console offers for each application it manages (platform.json): the four apps, and MOS when it is registered.
// Seeded into the provider's role catalog at its start; roles added or renamed in the console afterwards are never overwritten.
const rolesOf = (roles) => roles.map((r, i) => ({ name: r.name, display_name: r.label, sort_order: (i + 1) * 10 }));
const clientRoles = {
  ...Object.fromEntries(Object.entries(platform.apps).filter(([, app]) => app.roles?.length).map(([key, app]) => [key, rolesOf(app.roles)])),
  ...(mosOrigin && platform.externalClients?.mos?.roles?.length ? { mos: rolesOf(platform.externalClients.mos.roles) } : {}),
};

// ---------------------------------------------------------------------------------------------- writing
const PLACEHOLDER = /replace[-_]with|must-match|your_password|change-me|change-this|^replace/i;
const needsQuotes = (v) => /[\s#$"'`\\{}]/.test(v) || v === '';

/** Keeps the template's lines, sets what we know, appends what the template does not list. */
function build(templatePath, values, target) {
  const lines = fs.readFileSync(templatePath, 'utf8').split(/\r?\n/);
  const seen = new Set();
  const out = [];
  const render = (k, v) => `${k}=${needsQuotes(String(v)) ? `'${String(v).replaceAll("'", '')}'` : v}`;
  for (const line of lines) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!m) {
      out.push(line);
      continue;
    }
    const [, key, raw] = m;
    seen.add(key);
    if (key in values) {
      if (values[key] !== null) out.push(render(key, values[key]));
    } else if (PLACEHOLDER.test(raw.replace(/\s+#.*$/, ''))) {
      throw new Error(`${path.basename(templatePath)}: ${key} is a placeholder and configure does not set it`);
    } else {
      out.push(line);
    }
  }
  const extra = Object.entries(values).filter(([k, v]) => !seen.has(k) && v !== null);
  if (extra.length) {
    out.push('', '# ---- set by npm run configure (not in the template) ----');
    for (const [k, v] of extra) out.push(render(k, v));
  }
  fs.writeFileSync(target, out.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
  console.log(`wrote ${path.relative(ROOT, target)}`);
}

const P = platform.ports;
const pgUrl = (db, user = 'postgres', pw = infra.POSTGRES_PASSWORD) => `postgresql://${user}:${encodeURIComponent(pw)}@postgres:${P.postgres}/${db}`;
const valkey = `redis://:${encodeURIComponent(infra.VALKEY_PASSWORD)}@valkey:${P.valkey}`;
const sso = `http://sso:${P.sso}`;
const shared = {
  dmsInternal: secret('shared.DMS_INTERNAL_API_KEY'),
  gmsInternal: secret('shared.GMS_INTERNAL_API_KEY'),
  ssoRoles: secret('shared.SSO_ROLES_API_KEY'),
  edamsClient: secret('shared.EDAMS_CLIENT_SECRET'),
};
const tpl = (edition, ...p) => path.join(ROOT, edition, ...p);

// ---------------------------------------------------------------------------------------------- identity provider
const apps = Object.entries(platform.apps);
const productClients = productSso
  ? productSso.clients.map((c) => {
      const app = platform.apps[c.client_id];
      return app ? { ...c, backchannel_logout_uri: `http://${app.service}:${app.port}/api/v1/auth/backchannel-logout` } : c;
    })
  : null;

build(
  tpl('sso-saas', 'backend', '.env.production.example'),
  {
    NODE_ENV: 'production',
    PORT: String(P.sso),
    // The container's own network is the boundary; the services default to loopback, which no other container could reach.
    HOST: '0.0.0.0',
    INTERNAL_API_ALLOWED_IPS: `${ip.gms},${loopback}`,
    IDP_ISSUER: `${origin}/sso`,
    IDP_INTERNAL_URL: sso,
    DATABASE_URL: pgUrl(platform.databases.sso),
    // REDIS_URL is left unset on purpose: the identity provider's own template says so (one process, in-memory rate limiting is
    // correct), and with it set the process stops at start-up.
    TRUST_PROXY_HOPS: '1',
    COOKIE_KEYS: `${secret('sso.cookie1')},${secret('sso.cookie2')}`,
    TOTP_ENCRYPTION_KEY: secret('sso.totp'),
    IDP_AUDIT_HMAC_SECRET: secret('sso.audit'),
    LOGIN_LOCKOUT_ENABLED: 'true',
    DMS_OIDC_AUTHORIZE_URL: `${origin}/dms/api/v1/auth/oidc/authorize`,
    DMS_BACKCHANNEL_LOGOUT_URI: `${origin}/dms/api/v1/auth/backchannel-logout`,
    DMS_API_BASE_URL: `http://dms:${P.dms}/api/v1`,
    DMS_INTERNAL_API_KEY: shared.dmsInternal,
    EDAMS_CLIENT_SECRET: shared.edamsClient,
    EDAMS_REDIRECT_URIS: `${origin}/dms/auth/callback`,
    EDAMS_LOGOUT_URIS: `${origin}/dms/login`,
    GMS_CLIENT_SECRET: secret('sso.GMS_CLIENT_SECRET'),
    GMS_REDIRECT_URIS: `${origin}/sso/bridge/gms/callback`,
    GMS_LOGOUT_URIS: `${origin}/gms/login`,
    PORTAL_CLIENT_SECRET: secret('sso.PORTAL_CLIENT_SECRET'),
    GMS_INTERNAL_API_KEY: shared.gmsInternal,
    GMS_FRONTEND_URL: `${origin}/gms`,
    GMS_API_BASE: `http://gms:${P.gms}/api/v1`,
    SSO_ROLES_API_KEY: shared.ssoRoles,
    GATEWAY_PORT: String(P.gateway),
    GATEWAY_URL: `${origin}/gms`,
    // The guest system's web part runs on Vercel, so the gateway has no local frontend to proxy; its API target is the container.
    GMS_FRONTEND_TARGET: 'http://127.0.0.1:7201',
    GMS_API_TARGET: `http://gms:${P.gms}`,
    METRICS_API_KEY: secret('sso.metrics'),
    // Owner verification: the sealed owner store's key lives in .state/owner, which is mounted into the container.
    OWNER_STORE_KEY_FILE: '/state/owner/owner-store.key',
    ...licenceValues,
    ...(signingKey ? { LICENSE_SIGNING_KEY_FILE: `/state/licence/${signingKey}` } : {}),
    ...(productClients ? { PRODUCT_CLIENTS_JSON: JSON.stringify(productClients), PRODUCT_APPS_JSON: JSON.stringify(productSso.tiles) } : {}),
    ...(Object.keys(clientRoles).length > 0 ? { CLIENT_ROLES_JSON: JSON.stringify(clientRoles) } : {}),
    ...(mosOrigin
      ? {
          MOS_ENABLED: 'true',
          MOS_CLIENT_SECRET: secret('mos.client_secret'),
          MOS_REDIRECT_URIS: `${mosOrigin}/mos/oidc/callback`,
          MOS_LOGOUT_URIS: `${mosOrigin}/odoo`,
          MOS_PORTAL_URL: `${mosOrigin}/mos/oidc/login`,
          MOS_BACKCHANNEL_LOGOUT_URI: `${mosInternal}/mos/oidc/backchannel-logout`,
        }
      : {}),
  },
  path.join(ENV_DIR, 'sso.env'),
);

// ---------------------------------------------------------------------------------------------- guest system
const smtpFor = (who, placeholderSecret) => ({
  SMTP_HOST: smtp ? smtp.host : 'smtp.invalid',
  SMTP_PORT: smtp ? String(smtp.port) : '587',
  SMTP_USER: smtp ? smtp.user : 'noreply@example.invalid',
  SMTP_PASS: smtp ? smtp.pass : secret(placeholderSecret, 12),
  [who === 'gms' ? 'FROM_EMAIL' : 'EMAIL_FROM']: smtp ? (who === 'gms' ? smtp.address : `"${smtp.names.dms}" <${smtp.address}>`) : who === 'gms' ? 'noreply@example.invalid' : 'DMS <noreply@example.invalid>',
});
build(
  tpl('gms-saas', 'backend', '.env.example'),
  {
    NODE_ENV: 'production',
    PORT: String(P.gms),
    HOST: '0.0.0.0',
    INTERNAL_API_ALLOWED_IPS: `${ip.sso},${loopback}`,
    CLIENT_URL: `${origin}/gms`,
    CORS_ALLOWED_ORIGINS: origin,
    DB_HOST: 'postgres',
    DB_PORT: String(P.postgres),
    DB_USER: 'postgres',
    DB_PASSWORD: infra.POSTGRES_PASSWORD,
    DB_NAME: platform.databases.gms,
    REDIS_URL: valkey,
    JWT_SECRET: secret('gms.jwt'),
    JWT_REFRESH_SECRET: secret('gms.jwtRefresh'),
    SSO_INTERNAL_API_KEY: shared.gmsInternal,
    SSO_API_BASE: sso,
    LICENSE_SSO_URL: sso,
    SSO_ROLES_API_KEY: shared.ssoRoles,
    ...licenceValues,
    ...smtpFor('gms', 'gms.smtpPlaceholder'),
    SMTP_FROM_NAME: smtp ? smtp.names.gms : null,
    // SMTP is the mail route; leaving SendGrid's sender set would demand a SendGrid key.
    SENDGRID_FROM_EMAIL: null,
    UNIFI_ACCESS_API_KEY: 'not-configured',
    UNIFI_ACCESS_WEBHOOK_SECRET: secret('gms.unifiWebhook'),
    ENABLE_UNIFI_ACCESS_POLLING: 'false',
    TRUST_PROXY: '1',
  },
  path.join(ENV_DIR, 'gms.env'),
);

// ---------------------------------------------------------------------------------------------- document system
const keys = rsa();
const dmsValues = {
  NODE_ENV: 'production',
  HOST: '0.0.0.0',
  INTERNAL_API_ALLOWED_IPS: `${ip.sso},${loopback}`,
  DB_HOST: 'postgres',
  DB_PORT: String(P.postgres),
  DB_USER: 'edams_app',
  DB_PASSWORD: infra.EDAMS_APP_DB_PASSWORD,
  PORT: String(P.dms),
  DB_NAME: platform.databases.dms,
  DB_MIGRATE_USER: 'postgres',
  DB_MIGRATE_PASSWORD: infra.POSTGRES_PASSWORD,
  AUDIT_HMAC_SECRET: secret('dms.audit'),
  REDIS_URL: valkey,
  MINIO_ENDPOINT: 'minio',
  MINIO_PORT: String(P.minio),
  MINIO_ACCESS_KEY: infra.MINIO_ROOT_USER ?? 'saasminio',
  MINIO_SECRET_KEY: infra.MINIO_ROOT_PASSWORD,
  MINIO_USE_SSL: 'false',
  STORAGE_DRIVER: 'minio',
  SEARCH_ENGINE: 'postgres',
  ...smtpFor('dms', 'dms.smtpPlaceholder'),
  CLAMAV_ENABLED: 'false',
  ENABLE_QUEUE_WORKERS: 'true',
  ENABLE_OUTBOX_POLLING: 'true',
  ENABLE_API_DOCS: 'false',
  PUBLIC_BASE_PATH: '/dms',
  CLIENT_URL: `${origin}/dms`,
  CORS_ORIGINS: origin,
  DMS_INTERNAL_API_KEY: shared.dmsInternal,
  OIDC_CLIENT_ID: 'edams',
  OIDC_CLIENT_SECRET: shared.edamsClient,
  OIDC_REDIRECT_URI: `${origin}/dms/auth/callback`,
  OIDC_TOKEN_ENDPOINT: `${sso}/token`,
  CAMS_VERIFY_BASE_URL: `${origin}/dms/verify`,
  LOCAL_JWT_MOCK: 'false',
  AUTH_ISSUER: `${origin}/sso`,
  AUTH_AUDIENCE: 'edams-api',
  AUTH_JWKS_URI: `${sso}/jwks`,
  LICENSE_SSO_URL: sso,
  ...licenceValues,
  DEV_VAULT_MOCK: 'false',
  VAULT_BACKEND: 'env',
  VAULT_MASTER_KEY: secret('dms.vaultMaster'),
  VAULT_MASTER_KEY_CURRENT_VERSION: '1',
  JWT_SECRET: secret('dms.jwt'),
  JWT_REFRESH_SECRET: secret('dms.jwtRefresh'),
  DEV_RSA_PRIVATE_KEY: keys.private,
  DEV_RSA_PUBLIC_KEY: keys.public,
  ADMIN_ALERT_EMAIL_TO: 'admin@example.invalid',
  // These take priority over AUTH_ISSUER/AUTH_AUDIENCE when signing, so production refuses them.
  DEV_JWT_ISSUER: null,
  DEV_JWT_AUDIENCE: null,
  TRUST_PROXY: '1',
};
build(tpl('dms-saas', 'backend', '.env.example'), dmsValues, path.join(ENV_DIR, 'dms.env'));
// The migration job connects as the database owner (it creates tables and row-level-security policies); the app never gets that login.
build(tpl('dms-saas', 'backend', '.env.example'), { ...dmsValues, DB_USER: 'postgres', DB_PASSWORD: infra.POSTGRES_PASSWORD }, path.join(ENV_DIR, 'dms-migrate.env'));

// ---------------------------------------------------------------------------------------------- frontends (built on Vercel)
// Addresses only, no secrets: `npm run deploy:vercel` sets them as the Vercel projects' build variables.
const frontendDir = path.join(ENV_DIR, 'frontends');
fs.mkdirSync(frontendDir, { recursive: true });
build(
  tpl('sso-saas', 'frontend', '.env.production.example'),
  { NEXT_PUBLIC_BASE_PATH: '/sso', SSO_BACKEND_URL: `${backendOrigin}/sso-backend`, NEXT_PUBLIC_APP_ORIGIN: origin },
  path.join(frontendDir, 'sso.env'),
);
build(
  tpl('gms-saas', 'frontend', '.env.example'),
  {
    NEXT_PUBLIC_BASE_PATH: '/gms',
    NEXT_PUBLIC_API_BASE_URL: `${origin}/api/v1`,
    NEXT_PUBLIC_SOCKET_URL: origin,
    NEXT_PUBLIC_APP_URL: `${origin}/gms`,
    NEXT_PUBLIC_SSO_LOGIN_URL: `${origin}/sso/bridge/gms/start`,
    NEXT_PUBLIC_ENABLE_LIVE_DEMO: 'true',
  },
  path.join(frontendDir, 'gms.env'),
);
build(
  tpl('dms-saas', 'frontend', '.env.development.example'),
  { NEXT_PUBLIC_BASE_PATH: '/dms', NEXT_PUBLIC_API_BASE_URL: `${origin}/dms/api/v1`, NEXT_PUBLIC_SOCKET_URL: origin, NEXT_PUBLIC_DEV_LOGIN: 'false' },
  path.join(frontendDir, 'dms.env'),
);

// ---------------------------------------------------------------------------------------------- product apps
for (const [key, app] of apps) {
  const owner = key.replace(/[^a-z0-9]/g, '_');
  const dbPw = secret(`apps.${key}.db`, 18);
  const runtimeUser = app.twoRoles ? `${owner}_app` : owner;
  const runtimePw = app.twoRoles ? secret(`apps.${key}.db.app`, 18) : dbPw;
  const url = (user, pw) => `postgres://${user}:${encodeURIComponent(pw)}@postgres:${P.postgres}/${app.db}`;
  const values = {
    NODE_ENV: 'production',
    PORT: String(app.port),
    LOG_LEVEL: 'info',
    TRUST_PROXY_HOPS: '1',
    DATABASE_URL: url(runtimeUser, runtimePw),
    JWT_SECRET: secret(`apps.${key}.jwt`, 48),
    ...(app.twoRoles ? { MIGRATION_DATABASE_URL: url(owner, dbPw) } : {}),
    OIDC_ISSUER: `${origin}/sso`,
    // Server-to-server calls to the identity provider stay on the platform network; the issuer above stays the public address.
    OIDC_INTERNAL_URL: sso,
    OIDC_CLIENT_ID: key,
    OIDC_CLIENT_SECRET: secret(`apps.${key}.oidc`, 32),
    ...app.extraEnv,
  };
  const file = path.join(ENV_DIR, `${key}.env`);
  fs.writeFileSync(file, `${Object.entries(values).map(([k, v]) => `${k}=${needsQuotes(String(v)) ? `'${v}'` : v}`).join('\n')}\n`, { mode: 0o600 });
  console.log(`wrote ${path.relative(ROOT, file)}`);
}

fs.writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2), { mode: 0o600 });
void appOrigins;
console.log(`\nConfigured for ${origin} (secrets ${createHash('sha256').update(JSON.stringify(secrets)).digest('hex').slice(0, 8)} in .state/secrets.json; keep .state out of git and back it up).`);
