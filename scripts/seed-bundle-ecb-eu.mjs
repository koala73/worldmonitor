#!/usr/bin/env node
import { runBundle, DAY, WEEK } from './_bundle-runner.mjs';

await runBundle('ecb-eu', [
  { label: 'ECB-FX-Rates', script: 'seed-ecb-fx-rates.mjs', seedMetaKey: 'economic:ecb-fx-rates', intervalMs: DAY, timeoutMs: 120_000 },
  { label: 'ECB-Short-Rates', script: 'seed-ecb-short-rates.mjs', seedMetaKey: 'economic:ecb-short-rates', intervalMs: DAY, timeoutMs: 120_000 },
  { label: 'Yield-Curve-EU', script: 'seed-yield-curve-eu.mjs', seedMetaKey: 'economic:yield-curve-eu', intervalMs: DAY, timeoutMs: 120_000 },
  { label: 'FSI-EU', script: 'seed-fsi-eu.mjs', seedMetaKey: 'economic:fsi-eu', intervalMs: WEEK, timeoutMs: 120_000 },
]);
