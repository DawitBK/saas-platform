#!/usr/bin/env node
/**
 * What the network watch saw: outages and availability, overall and per Wi-Fi network.
 *   npm run netwatch:report            last 24 hours
 *   npm run netwatch:report -- 3       last 3 hours
 */
import fs from 'node:fs';
import path from 'node:path';
import { STATE } from './lib/platform.mjs';
import { renderReport } from './lib/netwatch.mjs';

const hours = Number(process.argv[2]) || 24;
const logs = path.join(STATE, 'logs');
const since = Date.now() - hours * 3_600_000;
const records = [];
for (const f of fs.existsSync(logs) ? fs.readdirSync(logs).sort() : []) {
  if (!/^netwatch-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
  for (const line of fs.readFileSync(path.join(logs, f), 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (r.kind === 'probe' && new Date(r.t).getTime() >= since) records.push(r);
    } catch {
      // a half-written last line is not an error
    }
  }
}
console.log(renderReport(records, { hours }));
