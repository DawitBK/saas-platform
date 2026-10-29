#!/usr/bin/env node
/**
 * Fills Retail OS with six months of connected demo trading (sales, purchases, returns, damage, stock counts, expenses), replayed
 * through the app's own services inside its container.
 *
 *   npm run seed:retail                 # 180 days
 *   npm run seed:retail -- --days=90
 *
 * Safe to repeat: a finished seed says so and changes nothing; an interrupted one resumes. It never deletes anything, and it needs an
 * owner, a manager, an accountant and a cashier to exist in Retail OS already (the sandbox ones do). Takes one to three minutes.
 */
import { compose, mustHaveDocker, mustHaveState } from './lib/platform.mjs';

mustHaveDocker();
mustHaveState();
const extra = process.argv.slice(2).filter((a) => /^--days=\d+$/.test(a));
const r = compose(['run', '--rm', '--no-deps', 'retail', 'node', 'dist/seed-demo.js', '--allow-production', ...extra]);
process.exit(r.status ?? 1);
