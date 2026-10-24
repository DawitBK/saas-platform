#!/usr/bin/env node
// Passes its arguments to `docker compose` for this project, with .env and .state/infra.env attached.
//   npm run compose -- ps
//   npm run compose -- exec postgres psql -U postgres
import { compose, mustHaveDocker, mustHaveState } from './lib/platform.mjs';

mustHaveDocker();
mustHaveState();
const r = compose(process.argv.slice(2));
process.exit(r.status ?? 1);
