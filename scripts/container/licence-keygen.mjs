// Runs INSIDE the sso-tools container (mounted at /platform). Makes a licence-signing key pair for this demo platform, once:
// the private key (PKCS#8 PEM) goes to /state/licence, which is .state/licence on the host and is never committed, and the
// public half is written as /state/licence/trust.json, the list `npm run configure` puts into LICENSE_TRUST_PUBLIC_KEYS.
// The private key is never printed. If a key already exists nothing is changed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const dir = '/state/licence';
fs.mkdirSync(dir, { recursive: true });
const existing = fs.readdirSync(dir).find((f) => /^license-private-.*\.pem$/.test(f));
if (existing) {
  console.log(`A licence key already exists (${existing}); nothing changed.`);
  process.exit(0);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
const { n, e } = publicKey.export({ format: 'jwk' });
// RFC 7638 thumbprint: SHA-256 of the required members in lexicographic order.
const kid = crypto.createHash('sha256').update(JSON.stringify({ e, kty: 'RSA', n })).digest('base64url');
const jwk = { kty: 'RSA', n, e, kid, alg: 'RS256', use: 'sig' };
const privatePath = path.join(dir, `license-private-${kid.slice(0, 8)}.pem`);
fs.writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
fs.writeFileSync(path.join(dir, 'trust.json'), `${JSON.stringify([jwk], null, 2)}\n`);
console.log(`Licence key ${kid.slice(0, 8)} created. Run npm run configure, then npm run up.`);
