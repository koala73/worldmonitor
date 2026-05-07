#!/usr/bin/env node
import { runBundle, DAY, WEEK } from './_bundle-runner.mjs';

await runBundle('ecb-eu', [
  { label: 'ECB-FX-Rates', script: 'seed-ecb-fx-rates.mjs', seedMetaKey: 'economic:ecb-fx-rates', canonicalKey: 'economic:ecb-fx-rates:v1', intervalMs: DAY, timeoutMs: 120_000 },
  { label: 'ECB-Short-Rates', script: 'seed-ecb-short-rates.mjs', seedMetaKey: 'economic:ecb-short-rates', intervalMs: DAY, timeoutMs: 120_000 },
  { label: 'Yield-Curve-EU', script: 'seed-yield-curve-eu.mjs', seedMetaKey: 'economic:yield-curve-eu', canonicalKey: 'economic:yield-curve-eu:v1', intervalMs: DAY, timeoutMs: 120_000 },
  { label: 'FSI-EU', script: 'seed-fsi-eu.mjs', seedMetaKey: 'economic:fsi-eu', canonicalKey: 'economic:fsi-eu:v1', intervalMs: WEEK, timeoutMs: 120_000 },
]);
