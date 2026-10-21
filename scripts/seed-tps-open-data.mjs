#!/usr/bin/env node
/**
 * On-demand TPS Open Data fetch (#7012).
 *
 * NOT a seed-bundle-canada member. NOT a Railway cron. NOT a bootstrap
 * FAST/SLOW key. Capacity decision: the 486k-row MCI FeatureServer cannot
 * fit the Canada bundle's 570s wall budget; keep this as a bounded
 * on-demand worker. Invoke explicitly.
 *
 * Usage:
 *   node scripts/seed-tps-open-data.mjs
 */
import { runBundle } from './_bundle-runner.mjs';
import { loadEnvFile } from './_seed-utils.mjs';
import {
  TPS_CALLS_KEY,
  TPS_CALLS_META_KEY,
  TPS_MCI_KEY,
  TPS_MCI_META_KEY,
} from './lib/tps-open-data.mjs';

loadEnvFile(import.meta.url);

export { TPS_CALLS_KEY, TPS_MCI_KEY, TPS_CALLS_META_KEY, TPS_MCI_META_KEY };

export const TPS_ON_DEMAND_SECTIONS = Object.freeze([
  Object.freeze({
    label: 'TPS-Major-Crime-Indicators',
    script: 'seed-tps-mci.mjs',
    seedMetaKey: 'safety:tps-mci',
    canonicalKey: TPS_MCI_KEY,
    intervalMs: 0,
    timeoutMs: 180_000,
  }),
  Object.freeze({
    label: 'TPS-Calls-Attended',
    script: 'seed-tps-calls-attended.mjs',
    seedMetaKey: 'safety:tps-calls-attended',
    canonicalKey: TPS_CALLS_KEY,
    intervalMs: 0,
    timeoutMs: 180_000,
  }),
]);

if (process.argv[1]?.endsWith('seed-tps-open-data.mjs')) {
  await runBundle('tps-open-data-on-demand', TPS_ON_DEMAND_SECTIONS);
}
