#!/usr/bin/env node
//
// IMF WEO extended bundle — sequences the four WEO seeders that share the
// IMF SDMX 3.0 API. Run on the same monthly cadence as seed-imf-macro
// (wrapped via Railway cron). Spacing them within one bundle keeps API
// bursts low and shares the seed-bundle observability surface.
//
// Per WorldMonitor #3027.

import { runBundle, DAY } from './_bundle-runner.mjs';

await runBundle('imf-extended', [
  { label: 'IMF-Macro',    script: 'seed-imf-macro.mjs',    seedMetaKey: 'economic:imf-macro',    canonicalKey: 'economic:imf:macro:v2',    intervalMs: 30 * DAY, timeoutMs: 600_000 },
  { label: 'IMF-Growth',   script: 'seed-imf-growth.mjs',   seedMetaKey: 'economic:imf-growth',   canonicalKey: 'economic:imf:growth:v1',   intervalMs: 30 * DAY, timeoutMs: 600_000 },
  { label: 'IMF-Labor',    script: 'seed-imf-labor.mjs',    seedMetaKey: 'economic:imf-labor',    canonicalKey: 'economic:imf:labor:v1',    intervalMs: 30 * DAY, timeoutMs: 600_000 },
  { label: 'IMF-External', script: 'seed-imf-external.mjs', seedMetaKey: 'economic:imf-external', canonicalKey: 'economic:imf:external:v1', intervalMs: 30 * DAY, timeoutMs: 600_000 },
]);
