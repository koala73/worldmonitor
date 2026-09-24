#!/usr/bin/env node
// Norges Bank government zero-coupon yields (NSS fitted), daily since
// 2015-01-02, tenors 6M 9M 12M 2Y–10Y.
// One SDMX-CSV request covers the full history (~1.4 MB).

import { CHROME_UA, loadEnvFile, runSeed } from './_seed-utils.mjs';
import { parseNorgesZeroCouponCsv } from './lib/yield-curves/norges.mjs';
import { countCurves } from './lib/yield-curves/model.mjs';
import { YIELD_CURVE_MAX_CONTENT_AGE_MIN, YIELD_CURVE_MAX_STALE_MIN, YIELD_CURVE_TTL_SECONDS, canonicalKey, latestExtraKeyEntry, makeValidate, markYieldCurveActivated, contentMeta, seedResource, yearExtraKeyEntry } from './seed-yield-curves-shared.mjs';

loadEnvFile(import.meta.url);

const NORGES_CSV = 'https://data.norges-bank.no/api/data/GOVT_ZEROCOUPON/B...?startPeriod=2015-01-01&format=csv&bom=include&locale=en';

export async function fetchNorgesCurve() {
  const response = await fetch(NORGES_CSV, {
    headers: { Accept: 'text/csv, text/plain, */*', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Norges Bank HTTP ${response.status}`);
  const csv = await response.text();
  const curves = parseNorgesZeroCouponCsv(csv);
  if (curves.length === 0) throw new Error('Norges Bank parsed no business days');
  console.log(`  Norges: ${curves.length} business days, ${curves[0].date} → ${curves.at(-1).date}`);
  return { curves };
}

if (process.argv[1]?.endsWith('seed-yield-curve-no.mjs')) {
  const extraKeys = [latestExtraKeyEntry('NO')];
  const endYear = new Date().getUTCFullYear();
  for (let year = 2015; year <= endYear; year += 1) {
    extraKeys.push(yearExtraKeyEntry('NO', year, year === endYear));
  }
  runSeed('economic', seedResource('NO'), canonicalKey('NO'), fetchNorgesCurve, {
    validateFn: makeValidate(1000, '2015-01'),
    ttlSeconds: YIELD_CURVE_TTL_SECONDS,
    sourceVersion: 'norges-govt-zerocoupon-sdmx-csv-v1',
    schemaVersion: 1,
    maxStaleMin: YIELD_CURVE_MAX_STALE_MIN,
    recordCount: countCurves,
    declareRecords: countCurves,
    contentMeta,
    maxContentAgeMin: YIELD_CURVE_MAX_CONTENT_AGE_MIN,
    extraKeys,
    afterPublish: markYieldCurveActivated('NO'),
  }).catch((err) => {
    console.error('FATAL:', err?.message || err);
    process.exit(1);
  });
}
