#!/usr/bin/env node
import { runBundle } from './_bundle-runner.mjs';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

await runBundle('macro', [
  { label: 'BIS-Data', script: 'seed-bis-data.mjs', seedMetaKey: 'economic:bis', intervalMs: 12 * HOUR, timeoutMs: 300_000 },
  { label: 'BLS-Series', script: 'seed-bls-series.mjs', seedMetaKey: 'economic:bls-series', intervalMs: 3 * DAY, timeoutMs: 120_000 },
  { label: 'Eurostat', script: 'seed-eurostat-country-data.mjs', seedMetaKey: 'economic:eurostat-country-data', intervalMs: 3 * DAY, timeoutMs: 300_000 },
  { label: 'IMF-Macro', script: 'seed-imf-macro.mjs', seedMetaKey: 'economic:imf-macro', intervalMs: 35 * DAY, timeoutMs: 300_000 },
  { label: 'National-Debt', script: 'seed-national-debt.mjs', seedMetaKey: 'economic:national-debt', intervalMs: 35 * DAY, timeoutMs: 300_000 },
  { label: 'FAO-FFPI', script: 'seed-fao-food-price-index.mjs', seedMetaKey: 'economic:fao-ffpi', intervalMs: 30 * DAY, timeoutMs: 120_000 },
]);
