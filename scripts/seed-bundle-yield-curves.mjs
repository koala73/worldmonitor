#!/usr/bin/env node
// Sovereign yield-curve bundle: the eight covered daily markets plus the OECD
// monthly 10Y fallback. Split from seed-bundle-macro because that bundle's
// 570s budget is already saturated by 22 sections — appending here would
// starve established members. Sections are independent: one market's failure
// retains its own last good through runSeed.

import { runBundle, DAY } from './_bundle-runner.mjs';

await runBundle('yield-curves', [
  // One CSV per market, full history. ~1.2 MB (JP) and ~0.4 MB (CA) downloads.
  { label: 'Yield-Curve-JP', script: 'seed-yield-curve-jp.mjs', seedMetaKey: 'economic:yield-curve-jp', canonicalKey: 'economic:yield-curve:jp:v1', completionMetaKey: 'seed-completion:economic:yield-curve-jp', intervalMs: DAY, timeoutMs: 180_000 },
  { label: 'Yield-Curve-CA', script: 'seed-yield-curve-ca.mjs', seedMetaKey: 'economic:yield-curve-ca', canonicalKey: 'economic:yield-curve:ca:v1', completionMetaKey: 'seed-completion:economic:yield-curve-ca', intervalMs: DAY, timeoutMs: 180_000 },
  // 3.5 MB SDMX CSV.
  { label: 'Yield-Curve-DE', script: 'seed-yield-curve-de.mjs', seedMetaKey: 'economic:yield-curve-de', canonicalKey: 'economic:yield-curve:de:v1', completionMetaKey: 'seed-completion:economic:yield-curve-de', intervalMs: DAY, timeoutMs: 180_000 },
  // Cold start: 39 MB archive + 8 workbook parses (~9s, ~1 GB peak RSS).
  // Warm path: 370 KB current-month zip. Timeout covers the cold start.
  { label: 'Yield-Curve-GB', script: 'seed-yield-curve-gb.mjs', seedMetaKey: 'economic:yield-curve-gb', canonicalKey: 'economic:yield-curve:gb:v1', completionMetaKey: 'seed-completion:economic:yield-curve-gb', intervalMs: DAY, timeoutMs: 420_000 },
  // 8 MB xlsx download + parse (~10s).
  { label: 'Yield-Curve-AU', script: 'seed-yield-curve-au.mjs', seedMetaKey: 'economic:yield-curve-au', canonicalKey: 'economic:yield-curve:au:v1', completionMetaKey: 'seed-completion:economic:yield-curve-au', intervalMs: DAY, timeoutMs: 300_000 },
  // 14 MB CSV.
  { label: 'Yield-Curve-CH', script: 'seed-yield-curve-ch.mjs', seedMetaKey: 'economic:yield-curve-ch', canonicalKey: 'economic:yield-curve:ch:v1', completionMetaKey: 'seed-completion:economic:yield-curve-ch', intervalMs: DAY, timeoutMs: 300_000 },
  // 1.4 MB SDMX CSV.
  { label: 'Yield-Curve-NO', script: 'seed-yield-curve-no.mjs', seedMetaKey: 'economic:yield-curve-no', canonicalKey: 'economic:yield-curve:no:v1', completionMetaKey: 'seed-completion:economic:yield-curve-no', intervalMs: DAY, timeoutMs: 180_000 },
  // 4 series × 8 windows of sequential JSON requests.
  { label: 'Yield-Curve-SE', script: 'seed-yield-curve-se.mjs', seedMetaKey: 'economic:yield-curve-se', canonicalKey: 'economic:yield-curve:se:v1', completionMetaKey: 'seed-completion:economic:yield-curve-se', intervalMs: DAY, timeoutMs: 300_000 },
  // 27 FRED series staggered at 150ms.
  { label: 'OECD-LT-Rates', script: 'seed-oecd-lt-rates.mjs', seedMetaKey: 'economic:oecd-lt-rates', canonicalKey: 'economic:yield-curve:oecd-lt:v1', completionMetaKey: 'seed-completion:economic:oecd-lt-rates', intervalMs: 7 * DAY, timeoutMs: 240_000 },
], {
  // Railway kills cron containers at 10 minutes. The GB cold start (420s) plus
  // any two mid-size sections cannot fit after it, so deferral sheds them to
  // the next tick; the freshness gate makes the next tick run them first.
  maxBundleMs: 570_000,
});
