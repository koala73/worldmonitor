#!/usr/bin/env node
import { runBundle, HOUR, WEEK } from './_bundle-runner.mjs';

// PW-Port-Activity was removed from this bundle on 2026-04-20 (see
// seed-bundle-portwatch-port-activity.mjs + Dockerfile.seed-bundle-portwatch-port-activity).
// Rationale: per-country EP3 fetches against ArcGIS consistently exceeded
// the section budget at scale, and the globalised variant (PR #3225)
// failed intermittently with "Invalid query parameters" plus 42s/page
// full-table scans. Running it in its own Railway cron with a longer
// wall-time budget decouples its worst-case runtime from the rest of the
// bundle. The three sections below are small and well-behaved.
await runBundle('portwatch', [
  { label: 'PW-Disruptions', script: 'seed-portwatch-disruptions.mjs', seedMetaKey: 'portwatch:disruptions', canonicalKey: 'portwatch:disruptions:active:v1', intervalMs: HOUR, timeoutMs: 120_000 },
  { label: 'PW-Main', script: 'seed-portwatch.mjs', seedMetaKey: 'supply_chain:portwatch', canonicalKey: 'supply_chain:portwatch:v1', intervalMs: 6 * HOUR, timeoutMs: 300_000 },
  { label: 'PW-Chokepoints-Ref', script: 'seed-portwatch-chokepoints-ref.mjs', seedMetaKey: 'portwatch:chokepoints-ref', canonicalKey: 'portwatch:chokepoints:ref:v1', intervalMs: WEEK, timeoutMs: 120_000 },
], { maxBundleMs: 540_000 });
