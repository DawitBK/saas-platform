#!/usr/bin/env node
/**
 * Stops the platform on purpose.
 *
 *   npm run down              stop and remove the containers (data volumes are kept)
 *   npm run down -- -v        also delete the data volumes (everything), only for a throwaway copy
 *
 * It leaves a marker so the watchdog (npm run pm2:start) does not start the platform again; `npm run up` removes the marker.
 */
import fs from 'node:fs';
import { STATE, compose, dockerReady } from './lib/platform.mjs';
import { STOPPED_FILE } from './lib/supervise.mjs';

fs.mkdirSync(STATE, { recursive: true });
fs.writeFileSync(STOPPED_FILE, `${new Date().toISOString()}\n`);
if (!dockerReady()) {
  console.log('Docker is not running, so there is nothing to stop. The platform stays off until: npm run up');
  process.exit(0);
}
const r = compose(['down', ...process.argv.slice(2)]);
if (r.status === 0) console.log('\nStopped. Start it again with: npm run up');
process.exit(r.status ?? 1);
