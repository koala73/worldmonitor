#!/usr/bin/env node
import { runBundle, HOUR, DAY } from './_bundle-runner.mjs';
import { CHINA_MACRO_CACHE_KEY } from './_china-macro-contract.mjs';
import { orderMacroSections } from './_macro-bundle-order.mjs';
import { EDUCATION_SECTION_TIMEOUT_MS } from './seed-education-attainment.mjs';
import { PHYSICAL_PREMIUM_SECTION_TIMEOUT_MS } from './seed-physical-premiums.mjs';

const EDUCATION_SECTION = { label: 'Education-Attainment', script: 'seed-education-attainment.mjs', seedMetaKey: 'resilience:education-attainment', canonicalKey: 'resilience:education-attainment:v1', completionMetaKey: 'seed-completion:resilience:education-attainment', intervalMs: 7 * DAY, timeoutMs: EDUCATION_SECTION_TIMEOUT_MS };
// SGE SHAU/SHAG daily PM benchmarks joined only to the already-seeded
// commodity and FX snapshots. Keep this section outside MACRO_SECTIONS so it
// always receives an early admission slot with 80 seconds of bundle headroom.
const PHYSICAL_PREMIUM_SECTION = { label: 'Physical-Premiums', script: 'seed-physical-premiums.mjs', seedMetaKey: 'market:physical-premium', canonicalKey: 'market:physical-premium:v1', completionMetaKey: 'seed-completion:market:physical-premium', intervalMs: DAY, timeoutMs: PHYSICAL_PREMIUM_SECTION_TIMEOUT_MS };

const MACRO_SECTIONS = [
  { label: 'BIS-Data', script: 'seed-bis-data.mjs', seedMetaKey: 'economic:bis', canonicalKey: 'economic:bis:policy:v1', completionMetaKey: 'seed-completion:economic:bis', intervalMs: 12 * HOUR, timeoutMs: 300_000 },
  // Bank of Russia official RUB rates + key policy rate. Three sequential cbr.ru
  // calls (daily table, prior day for change1d, KeyRate SOAP history); the two
  // required ones use withRetry(fn, 1, 2000) = 2 attempts x 15s + 2s backoff, so
  // the design worst case is 32 + 15 + 32 = 79s. The seeder caps its own fetch
  // phase at 90s (fetchPhaseTimeoutMs) so a slow cbr.ru — plausible behind
  // ddos-guard — aborts through runSeed's graceful last-good path rather than
  // being SIGTERM'd here, which the runner counts as a hard section failure.
  // 300_000 matches the peer sections and leaves the publish phase headroom.
  { label: 'CBR-Rates', script: 'seed-cbr-rates.mjs', seedMetaKey: 'economic:cbr-rates', canonicalKey: 'economic:cbr-rates:v1', completionMetaKey: 'seed-completion:economic:cbr-rates', intervalMs: DAY, timeoutMs: 300_000 },
  // Bank of Canada Valet (CAD FX + overnight target + 2/5/10y yields) and
  // Statistics Canada WDS (same-day cube radar + CPI/LFS for the CA overlay).
  // Independent clocks: Valet is recent=1, WDS is the seeder UTC date path.
  { label: 'BoC-Valet', script: 'seed-boc-valet.mjs', seedMetaKey: 'economic:boc-valet', canonicalKey: 'economic:boc-valet:v1', completionMetaKey: 'seed-completion:economic:boc-valet', intervalMs: DAY, timeoutMs: 120_000 },
  { label: 'StatCan-WDS', script: 'seed-statcan-wds.mjs', seedMetaKey: 'economic:statcan-wds', canonicalKey: 'economic:statcan-wds:v1', completionMetaKey: 'seed-completion:economic:statcan-wds', intervalMs: DAY, timeoutMs: 120_000 },
  // Official-source requests are sequential and bounded per host. Blocked
  // PBoC/GACC candidates stay explicitly unavailable rather than using proxies.
  { label: 'China-Macro', script: 'seed-china-macro.mjs', seedMetaKey: 'economic:china-macro', freshnessMetaKey: 'seed-meta:economic:china-macro-transport', completionMetaKey: 'seed-meta:economic:china-macro-complete', canonicalKey: CHINA_MACRO_CACHE_KEY, requireCanonical: true, intervalMs: 36 * HOUR, timeoutMs: 240_000 },
  { label: 'China-Release-Calendar', script: 'seed-china-release-calendar.mjs', seedMetaKey: 'economic:china-release-calendar', canonicalKey: 'economic:china:release-calendar:v1', intervalMs: 36 * HOUR, timeoutMs: 240_000 },
  // Six official agencies, each capped at one listing plus three documents with
  // a 400ms same-host cadence. The section is independent from macro sources:
  // failures retain the last valid policy event set through runSeed.
  { label: 'China-Policy-Events', script: 'seed-china-policy-events.mjs', seedMetaKey: 'china:policy-events', canonicalKey: 'china:policy-events:v1', intervalMs: 6 * HOUR, timeoutMs: 220_000 },
  { label: 'BIS-Extended', script: 'seed-bis-extended.mjs', seedMetaKey: 'economic:bis-extended', canonicalKey: 'economic:bis:dsr:v1', completionMetaKey: 'seed-completion:economic:bis-extended', intervalMs: 12 * HOUR, timeoutMs: 300_000 },
  { label: 'BLS-Series', script: 'seed-bls-series.mjs', seedMetaKey: 'economic:bls-series', canonicalKey: 'bls:series:v1', completionMetaKey: 'seed-completion:economic:bls-series', intervalMs: DAY, timeoutMs: 120_000 },
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
  { label: 'BIS-LBS', script: 'seed-bis-lbs.mjs', seedMetaKey: 'economic:bis-lbs', canonicalKey: 'economic:bis-lbs:v1', intervalMs: 7 * DAY, timeoutMs: 300_000 },
  // Cross-country capital flows: IMF BOP quarterly + annual + PIP and two BIS
  // LBS pulls, all in parallel, plus World Bank GDP. PIP (~43s) is the long
  // pole; per-call timeouts with one retry keep the worst case under 300_000.
  { label: 'Capital-Flows', script: 'seed-capital-flows.mjs', seedMetaKey: 'economic:capital-flows', canonicalKey: 'economic:capital-flows:v1', completionMetaKey: 'seed-completion:economic:capital-flows', intervalMs: 7 * DAY, timeoutMs: 300_000 },
  // FATF fetches 3 URLs (entry sequential, black+grey parallel) through a 6-tier
  // fallback chain (direct → proxy → wayback-cdx-direct → wayback-cdx-proxy →
  // wayback-snap-direct → wayback-snap-proxy, ≤125s/URL). Worst-case ≤250s;
  // 300_000 gives ~50s margin and matches peer sections. Pre-PR-#3415 the section
  // was 120_000 — too tight for the multi-tier fallback, would SIGTERM mid-fetch.
  { label: 'FATF-Listing', script: 'seed-fatf-listing.mjs', seedMetaKey: 'economic:fatf-listing', canonicalKey: 'economic:fatf-listing:v1', intervalMs: 30 * DAY, timeoutMs: 300_000 },
  // Full CPI history is six FRED series from 1947. Kept at the tail so a slow
  // FRED day cannot take the admission slot of an established member.
  { label: 'US-CPI', script: 'seed-us-cpi.mjs', seedMetaKey: 'economic:us-cpi', canonicalKey: 'economic:us-cpi:v1', completionMetaKey: 'seed-completion:economic:us-cpi', intervalMs: DAY, timeoutMs: 180_000 },
  // One Treasury XML document per year since 1990. The tail placement is the
  // same admission choice as US-CPI.
  { label: 'US-Treasury-Par-Yield', script: 'seed-us-treasury-par-yield.mjs', seedMetaKey: 'economic:us-treasury-par-yield', canonicalKey: 'economic:us-treasury-par-yield:v1', completionMetaKey: 'seed-completion:economic:us-treasury-par-yield', intervalMs: DAY, timeoutMs: 180_000 },
  // Twelve full-history FRED series. Kept at the tail for the same reason as US-CPI.
  { label: 'US-Interest-Rates', script: 'seed-us-interest-rates.mjs', seedMetaKey: 'economic:us-interest-rates', canonicalKey: 'economic:us-interest-rates:v1', completionMetaKey: 'seed-completion:economic:us-interest-rates', intervalMs: DAY, timeoutMs: 180_000 },
  // Worldwide CPI: five sources feeding one country-indexed read
  // (GetWorldCpiMonthly). Each section is a small, bounded fetch — the IMF
  // section is the largest at two ~2 MB CSV documents — and they share the
  // #8481 tail placement so a slow overlay cannot take an established member's
  // admission slot. Absent sources are tolerated by the read path, which
  // selects a per-country source with a staleness fall-through.
  { label: 'World-CPI-IMF', script: 'seed-world-cpi-imf.mjs', seedMetaKey: 'economic:world-cpi-imf', canonicalKey: 'economic:world-cpi:imf:v1', completionMetaKey: 'seed-completion:economic:world-cpi-imf', intervalMs: DAY, timeoutMs: 240_000 },
  { label: 'World-CPI-Eurostat', script: 'seed-world-cpi-eurostat.mjs', seedMetaKey: 'economic:world-cpi-eurostat', canonicalKey: 'economic:world-cpi:eurostat:v1', completionMetaKey: 'seed-completion:economic:world-cpi-eurostat', intervalMs: DAY, timeoutMs: 180_000 },
  { label: 'World-CPI-JP', script: 'seed-world-cpi-estat.mjs', requiredEnv: ['ESTAT_APPID'], seedMetaKey: 'economic:world-cpi-estat', canonicalKey: 'economic:world-cpi:estat:v1', completionMetaKey: 'seed-completion:economic:world-cpi-estat', intervalMs: DAY, timeoutMs: 120_000 },
  { label: 'World-CPI-AU', script: 'seed-world-cpi-abs.mjs', seedMetaKey: 'economic:world-cpi-abs', canonicalKey: 'economic:world-cpi:abs:v1', completionMetaKey: 'seed-completion:economic:world-cpi-abs', intervalMs: DAY, timeoutMs: 120_000 },
  // #9841: independent source jobs retain last-good data on report failures.
  // Each timeout is the source's fetchBudgetMs plus 15s for the last-good snapshot read
  // (FOOD_FETCH_MARGIN_MS) plus runSeed's 40s publish reserve, so the section timeout never
  // cuts the fetch phase short of its own collection budget.
  { label: 'Food-PIHPS', script: 'seed-food-prices-pihps.mjs', seedMetaKey: 'economic:food-prices-pihps', canonicalKey: 'economic:food-prices:pihps:v1', completionMetaKey: 'seed-completion:economic:food-prices-pihps', intervalMs: DAY, timeoutMs: 145_000 },
  { label: 'Food-PBS', script: 'seed-food-prices-pbs.mjs', seedMetaKey: 'economic:food-prices-pbs', canonicalKey: 'economic:food-prices:pbs:v1', completionMetaKey: 'seed-completion:economic:food-prices-pbs', intervalMs: DAY, timeoutMs: 115_000 },
  { label: 'Food-DA', script: 'seed-food-prices-da.mjs', seedMetaKey: 'economic:food-prices-da', canonicalKey: 'economic:food-prices:da:v1', completionMetaKey: 'seed-completion:economic:food-prices-da', intervalMs: DAY, timeoutMs: 115_000 },
  { label: 'Food-CBSL', script: 'seed-food-prices-cbsl.mjs', seedMetaKey: 'economic:food-prices-cbsl', canonicalKey: 'economic:food-prices:cbsl:v1', completionMetaKey: 'seed-completion:economic:food-prices-cbsl', intervalMs: DAY, timeoutMs: 115_000 },
  { label: 'Food-SNIIM', script: 'seed-food-prices-sniim.mjs', seedMetaKey: 'economic:food-prices-sniim', canonicalKey: 'economic:food-prices:sniim:v1', completionMetaKey: 'seed-completion:economic:food-prices-sniim', intervalMs: DAY, timeoutMs: 145_000 },
  { label: 'Food-GIEWS', script: 'seed-food-prices-giews.mjs', seedMetaKey: 'economic:food-prices-giews', canonicalKey: 'economic:food-prices:giews:v1', completionMetaKey: 'seed-completion:economic:food-prices-giews', intervalMs: DAY, timeoutMs: 285_000 },
  { label: 'Food-ONAGRI', script: 'seed-food-prices-onagri.mjs', seedMetaKey: 'economic:food-prices-onagri', canonicalKey: 'economic:food-prices:onagri:v1', completionMetaKey: 'seed-completion:economic:food-prices-onagri', intervalMs: DAY, timeoutMs: 85_000 },
  { label: 'Food-NABC', script: 'seed-food-prices-nabc.mjs', seedMetaKey: 'economic:food-prices-nabc', canonicalKey: 'economic:food-prices:nabc:v1', completionMetaKey: 'seed-completion:economic:food-prices-nabc', intervalMs: DAY, timeoutMs: 115_000 },
  { label: 'Food-NSCKG', script: 'seed-food-prices-nsckg.mjs', seedMetaKey: 'economic:food-prices-nsckg', canonicalKey: 'economic:food-prices:nsckg:v1', completionMetaKey: 'seed-completion:economic:food-prices-nsckg', intervalMs: DAY, timeoutMs: 115_000 },
  { label: 'Food-STATKZ', script: 'seed-food-prices-statkz.mjs', seedMetaKey: 'economic:food-prices-statkz', canonicalKey: 'economic:food-prices:statkz:v1', completionMetaKey: 'seed-completion:economic:food-prices-statkz', intervalMs: DAY, timeoutMs: 115_000 },
  { label: 'Food-STATUZ', script: 'seed-food-prices-statuz.mjs', seedMetaKey: 'economic:food-prices-statuz', canonicalKey: 'economic:food-prices:statuz:v1', completionMetaKey: 'seed-completion:economic:food-prices-statuz', intervalMs: DAY, timeoutMs: 85_000 },
  { label: 'Food-MAGA', script: 'seed-food-prices-maga.mjs', seedMetaKey: 'economic:food-prices-maga', canonicalKey: 'economic:food-prices:maga:v1', completionMetaKey: 'seed-completion:economic:food-prices-maga', intervalMs: DAY, timeoutMs: 85_000 },
  { label: 'Food-OCPV', script: 'seed-food-prices-ocpv.mjs', seedMetaKey: 'economic:food-prices-ocpv', canonicalKey: 'economic:food-prices:ocpv:v1', completionMetaKey: 'seed-completion:economic:food-prices-ocpv', intervalMs: DAY, timeoutMs: 145_000 },
  { label: 'Food-SIMA', script: 'seed-food-prices-sima.mjs', seedMetaKey: 'economic:food-prices-sima', canonicalKey: 'economic:food-prices:sima:v1', completionMetaKey: 'seed-completion:economic:food-prices-sima', intervalMs: DAY, timeoutMs: 115_000 },
  { label: 'Food-MIT', script: 'seed-food-prices-mit.mjs', seedMetaKey: 'economic:food-prices-mit', canonicalKey: 'economic:food-prices:mit:v1', completionMetaKey: 'seed-completion:economic:food-prices-mit', intervalMs: DAY, timeoutMs: 115_000 },
  { label: 'Food-UCDA', script: 'seed-food-prices-ucda.mjs', seedMetaKey: 'economic:food-prices-ucda', canonicalKey: 'economic:food-prices:ucda:v1', completionMetaKey: 'seed-completion:economic:food-prices-ucda', intervalMs: DAY, timeoutMs: 145_000 },
  { label: 'Food-AMMAN', script: 'seed-food-prices-amman.mjs', seedMetaKey: 'economic:food-prices-amman', canonicalKey: 'economic:food-prices:amman:v1', completionMetaKey: 'seed-completion:economic:food-prices-amman', intervalMs: DAY, timeoutMs: 115_000 },
  { label: 'Food-TCB', script: 'seed-food-prices-tcb.mjs', seedMetaKey: 'economic:food-prices-tcb', canonicalKey: 'economic:food-prices:tcb:v1', completionMetaKey: 'seed-completion:economic:food-prices-tcb', intervalMs: DAY, timeoutMs: 115_000 },

];

// Education is normally last so a persistent failure in the new flag-dark
// producer cannot starve established production members every day. Give it
// first priority on the 08:00 Sunday tick. The 09:00 retry always restores
// Physical to the first slot, even if Education failed and remains due.
const sections = orderMacroSections(
  new Date(),
  EDUCATION_SECTION,
  PHYSICAL_PREMIUM_SECTION,
  MACRO_SECTIONS,
);

await runBundle('macro', sections, {
  // Railway kills cron containers at 10 minutes. Defer sections whose full
  // timeout plus SIGTERM/SIGKILL grace cannot fit, preserving completed work
  // and the terminal reason in logs.
  maxBundleMs: 570_000,
});
