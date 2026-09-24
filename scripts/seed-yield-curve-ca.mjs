#!/usr/bin/env node
// Bank of Canada benchmark bond yields + treasury-bill averages, daily.
// Source: Bank of Canada Valet CSV groups (terms: free use with attribution).
// bond_yields_benchmark starts 2001-01-02; TBILL_ALL daily averages run from
// the 2000s. The covered-market registry declares 1990 to keep the shard grid
// stable; empty pre-2001 shards are skipped via skipWhenEmpty.

import { CHROME_UA, loadEnvFile, runSeed } from './_seed-utils.mjs';
import { mergeBocCurves, parseBocBenchmarkCsv, parseBocTbillCsv } from './lib/yield-curves/boc.mjs';
import { countCurves } from './lib/yield-curves/model.mjs';
import { YIELD_CURVE_MAX_CONTENT_AGE_MIN, YIELD_CURVE_MAX_STALE_MIN, YIELD_CURVE_TTL_SECONDS, canonicalKey, latestExtraKeyEntry, makeValidate, markYieldCurveActivated, contentMeta, seedResource, yearExtraKeyEntry } from './seed-yield-curves-shared.mjs';

loadEnvFile(import.meta.url);

const BENCHMARK_CSV = 'https://www.bankofcanada.ca/valet/observations/group/bond_yields_benchmark/csv?start_date=1990-01-01';
const TBILL_CSV = 'https://www.bankofcanada.ca/valet/observations/group/TBILL_ALL/csv?start_date=1990-01-01';

async function fetchCsv(url) {
  const response = await fetch(url, {
    headers: { Accept: 'text/csv, text/plain, */*', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`BoC Valet HTTP ${response.status} for ${url}`);
  return response.text();
}

export async function fetchBocCurve() {
  const [benchmarkCsv, tbillCsv] = await Promise.all([fetchCsv(BENCHMARK_CSV), fetchCsv(TBILL_CSV)]);
  const benchmark = parseBocBenchmarkCsv(benchmarkCsv);
  const tbill = parseBocTbillCsv(tbillCsv);
  const curves = mergeBocCurves(benchmark, tbill);
  if (curves.length === 0) throw new Error('BoC Valet parsed no observations');
  console.log(`  BoC: ${curves.length} business days (${benchmark.length} benchmark, ${tbill.length} tbill), ${curves[0].date} → ${curves.at(-1).date}`);
  return { curves };
}

if (process.argv[1]?.endsWith('seed-yield-curve-ca.mjs')) {
  const extraKeys = [latestExtraKeyEntry('CA')];
  const endYear = new Date().getUTCFullYear();
  for (let year = 1990; year <= endYear; year += 1) {
    extraKeys.push(yearExtraKeyEntry('CA', year, year === endYear));
  }
  runSeed('economic', seedResource('CA'), canonicalKey('CA'), fetchBocCurve, {
    validateFn: makeValidate(3000, '2000-01'),
    ttlSeconds: YIELD_CURVE_TTL_SECONDS,
    sourceVersion: 'boc-valet-benchmark+tbill-csv-v1',
    schemaVersion: 1,
    maxStaleMin: YIELD_CURVE_MAX_STALE_MIN,
    recordCount: countCurves,
    declareRecords: countCurves,
    contentMeta,
    maxContentAgeMin: YIELD_CURVE_MAX_CONTENT_AGE_MIN,
    extraKeys,
    afterPublish: markYieldCurveActivated('CA'),
  }).catch((err) => {
    console.error('FATAL:', err?.message || err);
    process.exit(1);
  });
}
