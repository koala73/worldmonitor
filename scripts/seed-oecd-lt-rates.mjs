#!/usr/bin/env node
// Monthly 10Y government bond yields for markets without a covered daily
// fitted curve, served through GetGovernmentYieldCurve as measure
// "monthly-10y". EU markets come from the ECB IRS dataset (one keyless CSV)
// with FRED's OECD MEI reprints (IRLTLT01<CC>M156N) as history backfill and
// fallback; non-EU markets are FRED-only. FRED requests are staggered per the
// repo's FRED-pacing convention.

import { CHROME_UA, sleep } from './_seed-utils.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';
import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import { ECB_IRS_URL, OECD_LT_MARKETS, OECD_LT_MAX_CONTENT_AGE_MIN, parseEcbIrsCsv, parseFredCsv, buildOecdLtPayload, declareOecdRecords, oecdLatestContentMeta, oecdContentFreshness } from './lib/yield-curves/oecd-lt.mjs';

loadEnvFile(import.meta.url);

export const OECD_LT_CANONICAL_KEY = 'economic:yield-curve:oecd-lt:v1';
export const OECD_LT_ACTIVATION_KEY = 'seed-activated:economic:oecd-lt-rates';
export const OECD_LT_LATEST_KEY = 'economic:yield-curve:oecd-lt:v1:latest';

// Daily bundle section: TTL and liveness match the daily yield-curve siblings
// (7d TTL, 72h = 3x interval). Content staleness is per-market and
// source-aware, see OECD_LT_SOURCE_BUDGET_MIN.
const TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_STALE_MIN = 4320;
const FRED_CSV_BASE = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=';
const STAGGER_MS = 150;

async function fetchEcbIrsSeries() {
  try {
    const response = await fetch(ECB_IRS_URL, {
      headers: { Accept: 'text/csv, text/plain, */*', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const series = parseEcbIrsCsv(await response.text());
    const markets = Object.keys(series);
    if (markets.length === 0) throw new Error('parsed no observations');
    for (const market of markets) {
      console.log(`  ECB IRS ${market}: ${series[market].length} months, latest ${series[market].at(-1).date}`);
    }
    return series;
  } catch (err) {
    console.warn(`  WARN: ECB IRS unavailable, serving EU markets from FRED only: ${err?.message || err}`);
    return null;
  }
}

export async function fetchOecdLtRates() {
  const ecb = await fetchEcbIrsSeries();
  const series = {};
  for (const [market, seriesId] of Object.entries(OECD_LT_MARKETS)) {
    const response = await fetch(`${FRED_CSV_BASE}${seriesId}`, {
      headers: { Accept: 'text/csv, text/plain, */*', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`FRED ${seriesId} HTTP ${response.status}`);
    const points = parseFredCsv(await response.text());
    if (points.length === 0) throw new Error(`FRED ${seriesId} parsed no observations`);
    series[market] = points;
    console.log(`  OECD ${market} (${seriesId}): ${points.length} months, latest ${points.at(-1).date}`);
    await sleep(STAGGER_MS);
  }
  const payload = buildOecdLtPayload({ fred: series, ecb });
  const marketCount = Object.keys(payload.countries).length;
  if (marketCount < 10) throw new Error(`OECD LT only ${marketCount} markets parsed`);
  for (const [market, entry] of Object.entries(payload.countries)) {
    console.log(`  ${market}: latest ${entry.curves.at(-1).date} from ${entry.source}`);
  }
  return payload;
}

function validate(data) {
  const countries = data?.countries;
  if (!countries || typeof countries !== 'object') return false;
  const count = Object.keys(countries).length;
  if (count < 10) return false;
  return Object.values(countries).every((entry) => entry?.curves?.length > 0);
}

export function latestTransform(data) {
  const latest = {};
  for (const [market, entry] of Object.entries(data?.countries ?? {})) {
    const last = entry?.curves?.at(-1);
    if (last) latest[market] = { source: entry.source, sources: entry.sources, curves: [last] };
  }
  return { countries: latest };
}

if (process.argv[1]?.endsWith('seed-oecd-lt-rates.mjs')) {
  const markActivated = async (data) => {
    try {
      const creds = getOptionalUpstashCreds();
      if (creds) await upstashCommand(creds, ['SET', OECD_LT_ACTIVATION_KEY, '1']);
    } catch (err) {
      console.warn(`  WARN: OECD LT activation marker write failed: ${err?.message || err}`);
    }
    return { freshnessMetaPatch: { contentFreshness: oecdContentFreshness(data) } };
  };

  runSeed('economic', 'oecd-lt-rates', OECD_LT_CANONICAL_KEY, fetchOecdLtRates, {
    validateFn: validate,
    ttlSeconds: TTL_SECONDS,
    lockTtlMs: 240_000,
    fetchPhaseTimeoutMs: 220_000,
    sourceVersion: 'ecb-irs-fred-oecd-mei-csv-v2',
    schemaVersion: 1,
    maxStaleMin: MAX_STALE_MIN,
    recordCount: declareOecdRecords,
    declareRecords: declareOecdRecords,
    contentMeta: oecdLatestContentMeta,
    maxContentAgeMin: OECD_LT_MAX_CONTENT_AGE_MIN,
    extraKeys: [
      { key: OECD_LT_LATEST_KEY, transform: latestTransform, declareRecords: declareOecdRecords },
    ],
    afterPublish: markActivated,
  }).catch((err) => {
    console.error('FATAL:', err?.message || err);
    process.exit(1);
  });
}
