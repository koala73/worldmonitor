#!/usr/bin/env node
// OECD MEI long-term (10Y) government bond yields via FRED reprints
// (IRLTLT01<CC>M156N, monthly). This is the cross-country fallback for
// markets without a covered daily fitted curve — served through
// GetGovernmentYieldCurve as measure "monthly-10y".
//
// FRED's keyless fredgraph.csv endpoint serves each series. Requests are
// staggered per the repo's FRED-pacing convention.

import { CHROME_UA, sleep } from './_seed-utils.mjs';
import { DAY_MIN, tokensToContentMeta } from './_content-age-helpers.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';
import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import { OECD_LT_MARKETS, parseFredCsv, buildOecdLtPayload, declareOecdRecords } from './lib/yield-curves/oecd-lt.mjs';

loadEnvFile(import.meta.url);

export const OECD_LT_CANONICAL_KEY = 'economic:yield-curve:oecd-lt:v1';
export const OECD_LT_ACTIVATION_KEY = 'seed-activated:economic:oecd-lt-rates';
export const OECD_LT_LATEST_KEY = 'economic:yield-curve:oecd-lt:v1:latest';

// 3x the 7-day bundle interval, per the canonical-TTL-vs-cron gate. Monthly
// data makes staleness content-age-driven, not TTL-driven.
const TTL_SECONDS = 21 * 24 * 60 * 60;
const MAX_STALE_MIN = 60 * 24 * 14; // monthly source; 14d = 2x monthly interval
const MAX_CONTENT_AGE_MIN = 60 * 24 * 80; // monthly prints; 80d ≈ 2.5 months of observed lag
const FRED_CSV_BASE = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=';
const STAGGER_MS = 150;

export async function fetchOecdLtRates() {
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
  const payload = buildOecdLtPayload(series);
  const marketCount = Object.keys(payload.countries).length;
  if (marketCount < 10) throw new Error(`OECD LT only ${marketCount} markets parsed`);
  return payload;
}

function validate(data) {
  const countries = data?.countries;
  if (!countries || typeof countries !== 'object') return false;
  const count = Object.keys(countries).length;
  if (count < 10) return false;
  return Object.values(countries).every((entry) => entry?.curves?.length > 0);
}

function contentMeta(data) {
  const dates = Object.values(data?.countries ?? {})
    .flatMap((entry) => [entry?.curves?.[0]?.date, entry?.curves?.at(-1)?.date])
    .filter(Boolean);
  return tokensToContentMeta(dates.slice(0, 2).concat(dates.at(-1)));
}

export function latestTransform(data) {
  const latest = {};
  for (const [market, entry] of Object.entries(data?.countries ?? {})) {
    const last = entry?.curves?.at(-1);
    if (last) latest[market] = { curves: [last] };
  }
  return { countries: latest };
}

if (process.argv[1]?.endsWith('seed-oecd-lt-rates.mjs')) {
  const markActivated = async () => {
    try {
      const creds = getOptionalUpstashCreds();
      if (!creds) return;
      await upstashCommand(creds, ['SET', OECD_LT_ACTIVATION_KEY, '1']);
    } catch (err) {
      console.warn(`  WARN: OECD LT activation marker write failed: ${err?.message || err}`);
    }
  };

  runSeed('economic', 'oecd-lt-rates', OECD_LT_CANONICAL_KEY, fetchOecdLtRates, {
    validateFn: validate,
    ttlSeconds: TTL_SECONDS,
    lockTtlMs: 240_000,
    fetchPhaseTimeoutMs: 220_000,
    sourceVersion: 'fred-oecd-mei-csv-v1',
    schemaVersion: 1,
    maxStaleMin: MAX_STALE_MIN,
    recordCount: declareOecdRecords,
    declareRecords: declareOecdRecords,
    contentMeta,
    maxContentAgeMin: MAX_CONTENT_AGE_MIN,
    extraKeys: [
      { key: OECD_LT_LATEST_KEY, transform: latestTransform, declareRecords: declareOecdRecords },
    ],
    afterPublish: markActivated,
  }).catch((err) => {
    console.error('FATAL:', err?.message || err);
    process.exit(1);
  });
}
