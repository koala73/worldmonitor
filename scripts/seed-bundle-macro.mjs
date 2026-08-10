#!/usr/bin/env node
import { runBundle, HOUR, DAY } from './_bundle-runner.mjs';
import { CHINA_MACRO_CACHE_KEY } from './_china-macro-contract.mjs';

await runBundle('macro', [
  { label: 'BIS-Data', script: 'seed-bis-data.mjs', seedMetaKey: 'economic:bis', canonicalKey: 'economic:bis:policy:v1', intervalMs: 12 * HOUR, timeoutMs: 300_000 },
  // Bank of Russia official RUB rates + key policy rate. Three sequential cbr.ru
  // calls (daily table, prior day for change1d, KeyRate SOAP history); the two
  // required ones use withRetry(fn, 1, 2000) = 2 attempts x 15s + 2s backoff, so
  // the design worst case is 32 + 15 + 32 = 79s. The seeder caps its own fetch
  // phase at 90s (fetchPhaseTimeoutMs) so a slow cbr.ru — plausible behind
  // ddos-guard — aborts through runSeed's graceful last-good path rather than
  // being SIGTERM'd here, which the runner counts as a hard section failure.
  // 300_000 matches the peer sections and leaves the publish phase headroom.
  { label: 'CBR-Rates', script: 'seed-cbr-rates.mjs', seedMetaKey: 'economic:cbr-rates', canonicalKey: 'economic:cbr-rates:v1', intervalMs: DAY, timeoutMs: 300_000 },
  // Official-source requests are sequential and bounded per host. Blocked
  // PBoC/GACC candidates stay explicitly unavailable rather than using proxies.
  { label: 'China-Macro', script: 'seed-china-macro.mjs', seedMetaKey: 'economic:china-macro', freshnessMetaKey: 'seed-meta:economic:china-macro-transport', completionMetaKey: 'seed-meta:economic:china-macro-complete', canonicalKey: CHINA_MACRO_CACHE_KEY, requireCanonical: true, intervalMs: 36 * HOUR, timeoutMs: 240_000 },
  { label: 'China-Release-Calendar', script: 'seed-china-release-calendar.mjs', seedMetaKey: 'economic:china-release-calendar', canonicalKey: 'economic:china:release-calendar:v1', intervalMs: 36 * HOUR, timeoutMs: 240_000 },
  // Six official agencies, each capped at one listing plus three documents with
  // a 400ms same-host cadence. The section is independent from macro sources:
  // failures retain the last valid policy event set through runSeed.
  { label: 'China-Policy-Events', script: 'seed-china-policy-events.mjs', seedMetaKey: 'china:policy-events', canonicalKey: 'china:policy-events:v1', intervalMs: 6 * HOUR, timeoutMs: 220_000 },
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
  // FATF fetches 3 URLs (entry sequential, black+grey parallel) through a 6-tier
  // fallback chain (direct → proxy → wayback-cdx-direct → wayback-cdx-proxy →
  // wayback-snap-direct → wayback-snap-proxy, ≤125s/URL). Worst-case ≤250s;
  // 300_000 gives ~50s margin and matches peer sections. Pre-PR-#3415 the section
  // was 120_000 — too tight for the multi-tier fallback, would SIGTERM mid-fetch.
  { label: 'FATF-Listing', script: 'seed-fatf-listing.mjs', seedMetaKey: 'economic:fatf-listing', canonicalKey: 'economic:fatf-listing:v1', intervalMs: 30 * DAY, timeoutMs: 300_000 },
  // Education dimension seeder. Same bundle-placement reasoning as the three
  // above: one more annual World Bank pull does not justify a new Railway
  // service.
  //
  // 600_000 rather than the 300_000 baseline, matching the BIS-LBS bump above.
  // This seeder uses a 16-year date window instead of the `mrv=5` its
  // precedents use — deliberately, so the 39 countries whose latest survey is
  // 5-15 years old keep their observation instead of being dropped. That costs
  // page count: measured 8 pages / 3975 rows, against ~3 for an mrv=5 fetch,
  // and the pages are fetched sequentially (single indicator, no Promise.all
  // to hide latency). Each page can take 60s worst case — 30s direct plus a
  // 30s proxy retry — so a World Bank degradation that forces the proxy path
  // on most pages reaches ~480s and blows a 300s budget.
  //
  // This matters beyond this seeder: a member killed by SIGTERM settles
  // without a status field, so runBundle counts it as a hard failure rather
  // than GRACEFUL_FAIL, which fails the whole bundle's exit code and paints
  // Railway "Deploy Crashed!" for all 18 members — every daily tick, for as
  // long as the upstream degradation lasts.
  { label: 'Education-Attainment', script: 'seed-education-attainment.mjs', seedMetaKey: 'resilience:education-attainment', canonicalKey: 'resilience:education-attainment:v1', intervalMs: 7 * DAY, timeoutMs: 600_000 },
]);
