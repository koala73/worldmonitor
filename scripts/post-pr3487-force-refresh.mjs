#!/usr/bin/env node
//
// Post-PR-#3487 ONE-SHOT: force-refresh the import-hhi seeder so the
// retry-hardening fix actually picks up AE (and any other rate-limit
// casualties) without waiting for the 30-day bundle-freshness gate.
//
// Why this script exists: scripts/seed-bundle-resilience-recovery.mjs:8
// has Import-HHI on `intervalMs: 30 * DAY`, and
// scripts/_bundle-runner.mjs:240 skips a section when canonical-key
// elapsed < intervalMs * 0.8 (= 24 days). The 2026-04-28 incident's
// canonical envelope (`resilience:recovery:import-hhi:v1`) is fresh —
// it just doesn't contain AE — so the next bundle tick AFTER PR #3487
// merges would SKIP Import-HHI for up to ~24 days, leaving the AE gap
// live. This script is the standard post-merge force-run pattern
// (mirrors scripts/post-pr3427-force-refresh.mjs).
//
// What happens when run: the seeder's resume logic reads the existing
// checkpoint + canonical, identifies which reporters are still needed
// (`todo = ALL_REPORTERS.filter(iso2 => !countries[iso2])`), and only
// fetches the missing ones. AE is the primary target; any other
// reporters that were drained by the same rate-limit failure mode
// will also be picked up. The seeder writes the canonical key at the
// end with the merged result, so the next score-warmup tick (~6h)
// reads the AE-included payload.
//
// Run AFTER PR #3487 merges, ideally BEFORE the next
// `seed-resilience-scores` cron tick so AE's importConcentration dim
// surfaces with the real HHI value on the first ranking refresh.
//
// Usage: COMTRADE_API_KEYS=<keys> node scripts/post-pr3487-force-refresh.mjs

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const SEEDER = 'seed-recovery-import-hhi.mjs';

console.log('[post-pr3487] Force-refreshing import-hhi seeder to close the AE coverage gap.');
console.log('[post-pr3487] Bypasses scripts/_bundle-runner.mjs 30-day freshness gate.');
console.log('[post-pr3487] Resume logic only fetches reporters NOT already in the canonical key,');
console.log('[post-pr3487] so this run is incremental — AE plus any other rate-limit casualties.');
console.log('');

if (!process.env.COMTRADE_API_KEYS) {
  console.error('[post-pr3487] COMTRADE_API_KEYS not set. Export the comma-separated keys and retry.');
  process.exit(1);
}

const path = resolve(here, SEEDER);
console.log(`[post-pr3487] Running: ${SEEDER}`);
console.log(`[post-pr3487] (set IMPORT_HHI_VERBOSE=1 for per-country diagnostic output)`);
console.log('');

const result = spawnSync('node', [path], {
  stdio: 'inherit',
  env: { ...process.env, FORCE_RESEED: 'true' },
});

if (result.status !== 0) {
  console.error(`[post-pr3487] FAILED: ${SEEDER} (exit ${result.status})`);
  process.exit(1);
}

console.log('');
console.log('[post-pr3487] OK. Verify AE in the canonical key:');
console.log('  redis-cli GET resilience:recovery:import-hhi:v1 | jq .countries.AE');
console.log('');
console.log('[post-pr3487] Then trigger a fresh ranking warmup so AE\'s importConcentration dim');
console.log('[post-pr3487] re-scores against the new HHI value (or wait ~6h for the next cron tick):');
console.log('  WORLDMONITOR_API_KEY=<key> node scripts/seed-resilience-scores.mjs');
