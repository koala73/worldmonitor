#!/usr/bin/env node

// PR 1 of the resilience repair plan. Railway cron bundle wrapping
// the three World Bank seeders that feed the v2 energy construct:
//
//   - seed-low-carbon-generation.mjs   → resilience:low-carbon-generation:v1
//   - seed-fossil-electricity-share.mjs → resilience:fossil-electricity-share:v1
//   - seed-power-reliability.mjs       → resilience:power-losses:v1
//
// Cadence: per-slot interval is 7 days; data is annual at source so polling
// more frequently just hammers the World Bank API without gaining fresh
// data. The per-slot intervalMs gate inside _bundle-runner.mjs enforces the
// 7-day minimum between actual seeds — the Railway cron only needs to fire
// often enough to catch the next-eligible day after the interval expires.
//
// Cron schedule: DAILY 06:00 UTC ("0 6 * * *"), not weekly Monday-only.
// Why daily instead of weekly: the 7-day per-slot interval is anchored to
// the previous successful seed's wall-clock time, NOT to a calendar day.
// If a previous seed happened on a non-Monday (e.g. Friday from a manual
// run, an initial provisioning fire, or any backfill), then with a
// Monday-only cron the next eligible Monday is "previous seed + 3 days,
// still inside 7-day interval, skip" → the seed waits another full 7 days
// (10 days total). The maxStaleMin alarm fires at day 8 — 2 days before
// the next cron-eligible Monday. Daily cron eliminates this dead window:
// the 7-day interval auto-resyncs to whichever wall-clock day the seed
// last fired, regardless of weekday. Verified against the 2026-04-24
// Friday-seed → 2026-04-27 Monday-skip → 2026-05-04 Monday-fire
// production incident that triggered this fix.
//
// Railway service config (set up manually via Railway dashboard or
// `railway service`):
//   - Service name: seed-bundle-resilience-energy-v2
//   - Builder: NIXPACKS (root Dockerfile not used for this bundle)
//   - rootDirectory: "" (repo root)
//   - Watch paths: scripts/seed-low-carbon-generation.mjs,
//     scripts/seed-fossil-electricity-share.mjs,
//     scripts/seed-power-reliability.mjs, scripts/_seed-utils.mjs,
//     scripts/_bundle-runner.mjs, scripts/seed-bundle-resilience-energy-v2.mjs
//   - Cron schedule: "0 6 * * *" (daily 06:00 UTC; per-slot interval gates real seeds)
//   - Required env: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
//
// IMPORTANT: After merging this PR, update the Railway service's cron
// schedule to "0 6 * * *". Code-side change alone is not sufficient —
// the Railway cron is configured in the dashboard, not in this file.

import { runBundle, DAY } from './_bundle-runner.mjs';

await runBundle('resilience-energy-v2', [
  {
    label: 'Low-Carbon-Generation',
    script: 'seed-low-carbon-generation.mjs',
    seedMetaKey: 'resilience:low-carbon-generation',
    canonicalKey: 'resilience:low-carbon-generation:v1',
    intervalMs: 7 * DAY,
    timeoutMs: 300_000,
  },
  {
    label: 'Fossil-Electricity-Share',
    script: 'seed-fossil-electricity-share.mjs',
    seedMetaKey: 'resilience:fossil-electricity-share',
    canonicalKey: 'resilience:fossil-electricity-share:v1',
    intervalMs: 7 * DAY,
    timeoutMs: 300_000,
  },
  {
    label: 'Power-Losses',
    script: 'seed-power-reliability.mjs',
    seedMetaKey: 'resilience:power-losses',
    canonicalKey: 'resilience:power-losses:v1',
    intervalMs: 7 * DAY,
    timeoutMs: 300_000,
  },
]);
