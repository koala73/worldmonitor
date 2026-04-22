#!/usr/bin/env node

// PR 1 of the resilience repair plan. Railway cron bundle wrapping
// the three World Bank seeders that feed the v2 energy construct:
//
//   - seed-low-carbon-generation.mjs   → resilience:low-carbon-generation:v1
//   - seed-fossil-electricity-share.mjs → resilience:fossil-electricity-share:v1
//   - seed-power-reliability.mjs       → resilience:power-losses:v1
//
// Cadence: weekly (7 days); data is annual at source so polling more
// frequently just hammers the World Bank API without gaining fresh
// data. maxStaleMin in api/health.js is set to 8 days (2× interval).
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
//   - Cron schedule: "0 6 * * 1" (Monday 06:00 UTC, weekly)
//   - Required env: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN

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
