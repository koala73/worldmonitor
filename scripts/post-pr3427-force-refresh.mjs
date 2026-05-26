#!/usr/bin/env node
//
// Post-PR-#3427 ONE-SHOT: force-refresh the two recovery seeders
// affected by the mrv=5/null-skip/HIC=0 fix.
//
// Why this script exists: the recovery bundle runs weekly with a 30d
// freshness gate (`scripts/_bundle-runner.mjs:240` skips when elapsed
// < intervalMs * 0.8). After PR #3427 merges, the new seeder code
// will not RUN on Railway until either (a) the canonical envelope
// ages past 24 days, OR (b) the canonical key is deleted, OR (c) the
// seeder runs out-of-band. This script is option (c) — invokes both
// seeders directly, bypassing the bundle runner and its freshness gate.
//
// Run AFTER PR #3427 merges, BEFORE the next `seed-resilience-scores`
// cron tick, so score warmup picks up the corrected debt seed
// immediately rather than waiting up to ~24 days for the bundle gate
// to time out.
//
// Usage: node scripts/post-pr3427-force-refresh.mjs

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const SEEDERS = [
  'seed-recovery-external-debt.mjs',
  'seed-recovery-reserve-adequacy.mjs',
];

console.log('[post-pr3427] Force-refreshing recovery seeders affected by mrv=1 trap fix.');
console.log('[post-pr3427] Bypasses scripts/_bundle-runner.mjs freshness gate.');
console.log('');

let failed = 0;
for (const seeder of SEEDERS) {
  const path = resolve(here, seeder);
  console.log(`[post-pr3427] Running: ${seeder}`);
  const result = spawnSync('node', [path], {
    stdio: 'inherit',
    env: { ...process.env, FORCE_RESEED: 'true' },
  });
  if (result.status !== 0) {
    console.error(`[post-pr3427] FAILED: ${seeder} (exit ${result.status})`);
    failed++;
  } else {
    console.log(`[post-pr3427] OK: ${seeder}`);
  }
  console.log('');
}

if (failed > 0) {
  console.error(`[post-pr3427] ${failed}/${SEEDERS.length} seeders failed. Investigate before triggering seed-resilience-scores.`);
  process.exit(1);
}

console.log('[post-pr3427] All seeders refreshed. Now run:');
console.log('  WORLDMONITOR_API_KEY=<key> node scripts/seed-resilience-scores.mjs');
console.log('to bulk-warm the v15 score cache against the corrected seed data.');
