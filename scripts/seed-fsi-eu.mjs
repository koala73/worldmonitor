#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';
import { tokensToContentMeta, DAY_MIN } from './_content-age-helpers.mjs';
loadEnvFile(import.meta.url);

// ECB SDMX REST API — free, no auth required.
// CISS (NEW): Composite Indicator of Systemic Stress (0–1 range, higher = more
// systemic stress). Daily frequency, Euro area aggregate.
//
// The legacy SS_CI series stopped publishing in May 2025 (issue #3845) while
// the endpoint kept returning HTTP 200 with the frozen final observation — so
// the seeder ran cleanly for ~12 months and republished a year-old value.
// SS_CIN ("NEW CISS" per ECB metadata) is the actively-maintained successor.
// See https://data.ecb.europa.eu/data/datasets/CISS.
//
// Window: trailing 1 year via startPeriod (~260 daily observations).
function buildCissUrl() {
  const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return `https://data-api.ecb.europa.eu/service/data/CISS/D.U2.Z0Z.4F.EC.SS_CIN.IDX?format=jsondata&startPeriod=${oneYearAgo}`;
}

const FSI_EU_KEY = 'economic:fsi-eu:v1';
// Daily cron — 259200s (3 days) TTL gives a 3× safety margin against
// cron-drift or missed runs (hits the seeder-canonical-ttl-vs-cron SAFETY_FACTOR).
const FSI_EU_TTL = 259200;
// Health staleness budgets:
//  - maxStaleMin 5760 (96h) tracks SEEDER liveness — covers an Easter Wed→Mon
//    gap on the daily cron. Mirrored in api/health.js SEED_META.euFsi.
//  - CISS_MAX_CONTENT_AGE_MIN (10 days) tracks DATA freshness via the
//    content-age contract: if the NEW series ever freezes the way SS_CI did,
//    /api/health flips to STALE_CONTENT within ~6 ECB business days instead of
//    staying green for a year. 10d absorbs a weekend + ECB holiday cluster +
//    one missed cron without false-positiving.
//
// CANONICAL source of the 10-day threshold. The server RPC + panel mirror it
// via src/shared/ciss-staleness.ts (the seeder is plain .mjs and cannot be
// imported by TS code); tests/ciss-stale-threshold-consistency.test.mjs
// asserts the two never drift.
const CISS_MAX_CONTENT_AGE_MIN = 10 * DAY_MIN;

function classifyLabel(value) {
  if (value < 0.2) return 'Low';
  if (value < 0.4) return 'Moderate';
  if (value < 0.6) return 'Elevated';
  return 'High';
}

async function fetchEcbCiss() {
  const url = buildCissUrl();
  const resp = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`ECB CISS API: HTTP ${resp.status}`);

  const json = await resp.json();

  // SDMX-JSON structure:
  //   dataSets[0].series["0:0:0:0:0:0:0"].observations = { "0": [value,...], "1": [...], ... }
  //   structure.dimensions.observation[0].values = [{ id: "2025-04-04", ... }, ...]
  const series = json?.dataSets?.[0]?.series?.['0:0:0:0:0:0:0'];
  if (!series) throw new Error('ECB CISS: unexpected response structure (missing series)');

  const obsMap = series.observations;
  if (!obsMap || typeof obsMap !== 'object') throw new Error('ECB CISS: no observations in response');

  const timeDim = json?.structure?.dimensions?.observation?.[0]?.values;
  if (!Array.isArray(timeDim) || timeDim.length === 0) throw new Error('ECB CISS: missing time dimension values');

  // Build sorted history array from index-keyed observations
  const history = Object.entries(obsMap)
    .map(([idxStr, arr]) => {
      const idx = parseInt(idxStr, 10);
      const date = timeDim[idx]?.id ?? null;
      const value = arr?.[0];
      if (!date || typeof value !== 'number' || !Number.isFinite(value)) return null;
      // Validate CISS is in [0, 1] range
      if (value < 0 || value > 1) {
        console.warn(`  ECB CISS: value ${value} out of [0,1] range on ${date} — skipping`);
        return null;
      }
      return { date, value };
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (history.length === 0) throw new Error('ECB CISS: no valid observations parsed');

  const latest = history.at(-1);
  const latestValue = latest.value;
  const latestDate = latest.date;
  const label = classifyLabel(latestValue);

  console.log(`  ECB CISS: latest=${latestValue.toFixed(4)} (${latestDate}) label=${label} points=${history.length}`);

  return {
    seededAt: new Date().toISOString(),
    latestValue,
    latestDate,
    label,
    history,
    unavailable: false,
  };
}

// Contract opt-in: canonical record count for envelope + health.
// FSI-EU payload is `{latestValue, latestDate, label, history[], ...}`.
// Records = daily CISS observations in the history array (~260 for a 1y window).
export function declareRecords(data) {
  return Array.isArray(data?.history) ? data.history.length : 0;
}

// Content-age contract: report the date span of the CISS history so
// /api/health can detect an upstream FREEZE (the SS_CI failure mode). The
// history is sorted ascending, so the last entry is the newest observation.
// Returns null when there are no datable observations → STALE_CONTENT.
export function cissContentMeta(data) {
  return tokensToContentMeta((Array.isArray(data?.history) ? data.history : []).map((h) => h?.date));
}

function validate(data) {
  return (
    data?.latestValue != null &&
    Number.isFinite(data.latestValue) &&
    data.latestValue >= 0 &&
    data.latestValue <= 1 &&
    Array.isArray(data.history) &&
    data.history.length > 0
  );
}

// isMain guard — required for scripts that export AND call runSeed at top level.
// Prevents runSeed() from firing when this module is imported in tests or CI.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runSeed('economic', 'fsi-eu', FSI_EU_KEY, fetchEcbCiss, {
    validateFn: validate,
    ttlSeconds: FSI_EU_TTL,
    sourceVersion: 'ecb-ciss-sdmx-v1',
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 5760, // 4 days — matches api/health.js SEED_META threshold
    contentMeta: cissContentMeta,
    maxContentAgeMin: CISS_MAX_CONTENT_AGE_MIN,
  }).catch((err) => {
    console.error('FATAL:', err.message || err);
    process.exit(1);
  });
}
