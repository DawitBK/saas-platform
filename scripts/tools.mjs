#!/usr/bin/env node
/**
 * The operator tools of the identity provider, run inside a container that has its source (they are TypeScript and are not in
 * the production image). They need a real terminal: answers and codes are never accepted from a pipe or an argument.
 *
 *   npm run owner:enroll     first-time owner verification set-up (three questions, mailbox, recovery codes)
 *   npm run owner:status     whether the owner is enrolled, locked, how many recovery codes are left
 *   npm run owner:recover    enrol again (replaces the earlier enrolment)
 *   npm run licences:demo    issue never-expiring demo licences for the three systems (a non-live environment only)
 */
import { composeOrExit, mustHaveDocker, mustHaveState } from './lib/platform.mjs';

mustHaveDocker();
mustHaveState();
const tool = process.argv[2];
const commands = {
  'owner-enroll': ['npx', 'tsx', 'scripts/owner-enroll.ts', 'production'],
  'owner-status': ['npx', 'tsx', 'scripts/owner-status.ts', 'production'],
  'owner-recover': ['npx', 'tsx', 'scripts/owner-recover.ts', 'production'],
};
if (tool === 'licences-demo') {
  await import('./licences-demo.mjs');
} else if (commands[tool]) {
  composeOrExit(['run', '--rm', '--build', 'sso-tools', ...commands[tool]]);
} else {
  console.error(`Unknown tool "${tool}". Known: ${[...Object.keys(commands), 'licences-demo'].join(', ')}`);
  process.exit(2);
}
