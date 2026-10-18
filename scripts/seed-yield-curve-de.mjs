#!/usr/bin/env node
// Bundesbank daily term structure (Svensson) — par yields derived from the
// curve, daily since 1997-08-01, tenors 1–30Y.
// One wildcard SDMX request returns every tenor column at once.

import { CHROME_UA, loadEnvFile, runSeed } from './_seed-utils.mjs';
import { parseBundesbankCsv } from './lib/yield-curves/bundesbank.mjs';
import { countCurves } from './lib/yield-curves/model.mjs';
import { YIELD_CURVE_MAX_CONTENT_AGE_MIN, YIELD_CURVE_MAX_STALE_MIN, YIELD_CURVE_TTL_SECONDS, canonicalKey, latestExtraKeyEntry, makeValidate, markYieldCurveActivated, contentMeta, seedResource, yearExtraKeyEntry } from './seed-yield-curves-shared.mjs';

loadEnvFile(import.meta.url);

const BUNDESBANK_PAR_CSV =
  'https://api.statistiken.bundesbank.de/rest/data/BBSIS/D.I.ZAR.ZI.EUR.S1311.B.A604..R.A.A._Z._Z.A?format=csv';

export async function fetchBundesbankCurve() {
  const response = await fetch(BUNDESBANK_PAR_CSV, {
    headers: { Accept: 'text/csv, text/plain, */*', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Bundesbank HTTP ${response.status}`);
  const csv = await response.text();
  const curves = parseBundesbankCsv(csv);
  if (curves.length === 0) throw new Error('Bundesbank parsed no business days');
  console.log(`  Bundesbank: ${curves.length} business days, ${curves[0].date} → ${curves.at(-1).date}`);
  return { curves };
}

if (process.argv[1]?.endsWith('seed-yield-curve-de.mjs')) {
  const extraKeys = [latestExtraKeyEntry('DE')];
  const endYear = new Date().getUTCFullYear();
  for (let year = 1997; year <= endYear; year += 1) {
    extraKeys.push(yearExtraKeyEntry('DE', year, year === endYear));
  }
  runSeed('economic', seedResource('DE'), canonicalKey('DE'), fetchBundesbankCurve, {
    validateFn: makeValidate(3000, '1997-08'),
    ttlSeconds: YIELD_CURVE_TTL_SECONDS,
    sourceVersion: 'bundesbank-zar-sdmx-csv-v1',
    schemaVersion: 1,
    maxStaleMin: YIELD_CURVE_MAX_STALE_MIN,
    recordCount: countCurves,
    declareRecords: countCurves,
    contentMeta,
    maxContentAgeMin: YIELD_CURVE_MAX_CONTENT_AGE_MIN,
    extraKeys,
    afterPublish: markYieldCurveActivated('DE'),
  }).catch((err) => {
    console.error('FATAL:', err?.message || err);
    process.exit(1);
  });
}
