#!/usr/bin/env node
// Standalone Railway cron service for supply_chain:portwatch-ports.
//
// Split out of seed-bundle-portwatch.mjs on 2026-04-20 because ArcGIS
// Daily_Ports_Data queries scale poorly at the N-countries level: even
// with per-country ISO3-indexed WHERE clauses + concurrency 12, wall
// time exceeded the bundle's 540s budget. Globalising the fetch (PR
// #3225) traded timeouts for a different failure mode (42s full-table
// scans + intermittent "Invalid query parameters"). Giving this seeder
// its own container decouples its worst-case runtime from the main
// portwatch bundle and lets it run on an interval appropriate to the
// ~10-day upstream dataset lag.
//
// Railway service settings checklist (after merge):
//   1. Service: seed-bundle-portwatch-port-activity
//   2. Builder: DOCKERFILE, dockerfilePath: Dockerfile.seed-bundle-portwatch-port-activity
//   3. Root directory: "" (empty) — avoids NIXPACKS auto-detection (see
//      feedback_railway_dockerfile_autodetect_overrides_builder.md)
//   4. Cron schedule: "0 */12 * * *" (twice daily, UTC). Each run caps
//      cold refreshes at 30 countries to stay inside the ArcGIS and container
//      budgets. A 12h trigger lets a 54-country upstream advance recover in
//      two runs (~24h) instead of two daily runs (~48h), while the interval
//      gate below still prevents rapid-fire manual retriggers.
//   5. Env vars (copy from existing seed services):
//      UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN,
//      PROXY_URL (for 429 fallback)
//   6. Watch paths (in service settings):
//      scripts/seed-portwatch-port-activity.mjs,
//      scripts/seed-bundle-portwatch-port-activity.mjs,
//      scripts/_seed-utils.mjs,
//      scripts/_portwatch-content-freshness.mjs,
//      scripts/_proxy-utils.cjs,
//      scripts/_country-resolver.mjs,
//      scripts/_bundle-runner.mjs,
//      Dockerfile.seed-bundle-portwatch-port-activity
//   7. Monitor first run for STALE_SEED recovery on portwatch-ports.
import { runBundle, HOUR } from './_bundle-runner.mjs';

await runBundle('portwatch-port-activity', [
  {
    label: 'PW-Port-Activity',
    script: 'seed-portwatch-port-activity.mjs',
    seedMetaKey: 'supply_chain:portwatch-ports',
    canonicalKey: 'supply_chain:portwatch-ports:v1:_countries',
    // 12h interval gate matches the declared Railway cron and prevents
    // rapid-fire manual retriggers.
    intervalMs: 12 * HOUR,
    // 540s section timeout — full budget for the one section. Bundle
    // runner still SIGTERMs if the child hangs, and the seeder's
    // SIGTERM handler releases the lock + extends TTLs.
    timeoutMs: 540_000,
  },
], { maxBundleMs: 570_000 });
