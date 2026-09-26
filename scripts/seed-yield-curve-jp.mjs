#!/usr/bin/env node
// Japan MOF constant-maturity JGB par yields, daily since 1974-09-24.
// Source: https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/
// The historical CSV ends at the previous month; jgbcme.csv supplies current data.

import { CHROME_UA, loadEnvFile, runSeed } from './_seed-utils.mjs';
import { parseJgbCsv } from './lib/yield-curves/jgb.mjs';
import { collapseCurves, countCurves } from './lib/yield-curves/model.mjs';
import { YIELD_CURVE_MAX_CONTENT_AGE_MIN, YIELD_CURVE_MAX_STALE_MIN, YIELD_CURVE_TTL_SECONDS, canonicalKey, latestExtraKeyEntry, makeValidate, markYieldCurveActivated, contentMeta, seedResource, yearExtraKeyEntry } from './seed-yield-curves-shared.mjs';

loadEnvFile(import.meta.url);

const JGB_ALL_CSV = 'https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/historical/jgbcme_all.csv';

const JGB_CURRENT_CSV = 'https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/jgbcme.csv';

async function fetchJgbCsv(url) {
  const response = await fetch(url, {
    headers: { Accept: 'text/csv, text/plain, */*', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`MOF JGB HTTP ${response.status}`);
  const csv = await response.text();
  const curves = parseJgbCsv(csv);
  if (curves.length === 0) throw new Error('MOF JGB parsed no business days');
  return curves;
}

export async function fetchJgbCurve() {
  const history = await fetchJgbCsv(JGB_ALL_CSV);
  const current = await fetchJgbCsv(JGB_CURRENT_CSV);
  const curves = collapseCurves([...history, ...current]);
  console.log(`  JGB: ${curves.length} business days, ${curves[0].date} → ${curves.at(-1).date}`);
  return { curves };
}

if (process.argv[1]?.endsWith('seed-yield-curve-jp.mjs')) {
  const extraKeys = [latestExtraKeyEntry('JP')];
  const endYear = new Date().getUTCFullYear();
  for (let year = 1974; year <= endYear; year += 1) {
    extraKeys.push(yearExtraKeyEntry('JP', year, year === endYear));
  }
  runSeed('economic', seedResource('JP'), canonicalKey('JP'), fetchJgbCurve, {
    validateFn: makeValidate(5000, '1974-09'),
    ttlSeconds: YIELD_CURVE_TTL_SECONDS,
    sourceVersion: 'mof-jgb-cmt-csv-v1',
    schemaVersion: 1,
    maxStaleMin: YIELD_CURVE_MAX_STALE_MIN,
    recordCount: countCurves,
    declareRecords: countCurves,
    contentMeta,
    maxContentAgeMin: YIELD_CURVE_MAX_CONTENT_AGE_MIN,
    extraKeys,
    afterPublish: markYieldCurveActivated('JP'),
  }).catch((err) => {
    console.error('FATAL:', err?.message || err);
    process.exit(1);
  });
}
