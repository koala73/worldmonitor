#!/usr/bin/env node
import { runBundle, HOUR, DAY } from './_bundle-runner.mjs';

await runBundle('macro', [
  { label: 'BIS-Data', script: 'seed-bis-data.mjs', seedMetaKey: 'economic:bis', canonicalKey: 'economic:bis:policy:v1', intervalMs: 12 * HOUR, timeoutMs: 300_000 },
  { label: 'BIS-Extended', script: 'seed-bis-extended.mjs', seedMetaKey: 'economic:bis-extended', canonicalKey: 'economic:bis:dsr:v1', intervalMs: 12 * HOUR, timeoutMs: 300_000 },
  { label: 'BLS-Series', script: 'seed-bls-series.mjs', seedMetaKey: 'economic:bls-series', canonicalKey: 'bls:series:v1', intervalMs: DAY, timeoutMs: 120_000 },
  { label: 'Eurostat', script: 'seed-eurostat-country-data.mjs', seedMetaKey: 'economic:eurostat-country-data', canonicalKey: 'economic:eurostat-country-data:v1', intervalMs: DAY, timeoutMs: 300_000 },
  { label: 'Eurostat-HousePrices', script: 'seed-eurostat-house-prices.mjs', seedMetaKey: 'economic:eurostat-house-prices', canonicalKey: 'economic:eurostat:house-prices:v1', intervalMs: 7 * DAY, timeoutMs: 300_000 },
  { label: 'Eurostat-GovDebtQ', script: 'seed-eurostat-gov-debt-q.mjs', seedMetaKey: 'economic:eurostat-gov-debt-q', canonicalKey: 'economic:eurostat:gov-debt-q:v1', intervalMs: 2 * DAY, timeoutMs: 300_000 },
  { label: 'Eurostat-IndProd', script: 'seed-eurostat-industrial-production.mjs', seedMetaKey: 'economic:eurostat-industrial-production', canonicalKey: 'economic:eurostat:industrial-production:v1', intervalMs: DAY, timeoutMs: 300_000 },
  { label: 'IMF-Macro', script: 'seed-imf-macro.mjs', seedMetaKey: 'economic:imf-macro', canonicalKey: 'economic:imf:macro:v2', intervalMs: 30 * DAY, timeoutMs: 300_000 },
  { label: 'National-Debt', script: 'seed-national-debt.mjs', seedMetaKey: 'economic:national-debt', canonicalKey: 'economic:national-debt:v1', intervalMs: 30 * DAY, timeoutMs: 300_000 },
  { label: 'FAO-FFPI', script: 'seed-fao-food-price-index.mjs', seedMetaKey: 'economic:fao-ffpi', canonicalKey: 'economic:fao-ffpi:v1', intervalMs: DAY, timeoutMs: 120_000 },
  // plan 2026-04-25-004 Phase 2: financialSystemExposure component seeders.
  // Bundle placement = Option A per Codex R1 #5 (less operational overhead
  // than provisioning a new bundle service). All 3 feed the new dim's
  // fail-closed preflight (RESILIENCE_FIN_SYS_EXPOSURE_ENABLED=true).
  { label: 'WB-External-Debt', script: 'seed-wb-external-debt.mjs', seedMetaKey: 'economic:wb-external-debt', canonicalKey: 'economic:wb-external-debt:v1', intervalMs: 30 * DAY, timeoutMs: 300_000 },
  { label: 'BIS-LBS', script: 'seed-bis-lbs.mjs', seedMetaKey: 'economic:bis-lbs', canonicalKey: 'economic:bis-lbs:v1', intervalMs: 7 * DAY, timeoutMs: 600_000 },
  { label: 'FATF-Listing', script: 'seed-fatf-listing.mjs', seedMetaKey: 'economic:fatf-listing', canonicalKey: 'economic:fatf-listing:v1', intervalMs: 30 * DAY, timeoutMs: 120_000 },
]);
