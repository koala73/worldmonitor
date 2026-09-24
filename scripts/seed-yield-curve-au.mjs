#!/usr/bin/env node
// RBA F2 capital-market yields — Australian Government bonds (interpolated
// AGS), daily since 2013-05-20, series 2Y 3Y 5Y 10Y.
// f02d.xlsx covers the full daily history (~8 MB). curl's fingerprint is
// blocked (403) but Node fetch is accepted, so no proxy path is wired.

import ExcelJS from 'exceljs';
import { CHROME_UA, loadEnvFile, runSeed } from './_seed-utils.mjs';
import { parseRbaWorkbook } from './lib/yield-curves/rba.mjs';
import { countCurves } from './lib/yield-curves/model.mjs';
import { YIELD_CURVE_MAX_CONTENT_AGE_MIN, YIELD_CURVE_MAX_STALE_MIN, YIELD_CURVE_TTL_SECONDS, canonicalKey, latestExtraKeyEntry, makeValidate, markYieldCurveActivated, contentMeta, seedResource, yearExtraKeyEntry } from './seed-yield-curves-shared.mjs';

loadEnvFile(import.meta.url);

const F02D_XLSX = 'https://www.rba.gov.au/statistics/tables/xls/f02d.xlsx';

export async function fetchRbaCurve() {
  const response = await fetch(F02D_XLSX, {
    headers: { Accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, */*', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`RBA HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const curves = parseRbaWorkbook(workbook);
  if (curves.length === 0) throw new Error('RBA F2 parsed no business days');
  console.log(`  RBA: ${curves.length} business days, ${curves[0].date} → ${curves.at(-1).date}`);
  return { curves };
}

if (process.argv[1]?.endsWith('seed-yield-curve-au.mjs')) {
  const extraKeys = [latestExtraKeyEntry('AU')];
  const endYear = new Date().getUTCFullYear();
  for (let year = 2013; year <= endYear; year += 1) {
    extraKeys.push(yearExtraKeyEntry('AU', year, year === endYear));
  }
  runSeed('economic', seedResource('AU'), canonicalKey('AU'), fetchRbaCurve, {
    validateFn: makeValidate(1000, '2013-05'),
    ttlSeconds: YIELD_CURVE_TTL_SECONDS,
    sourceVersion: 'rba-f02d-xlsx-v1',
    schemaVersion: 1,
    maxStaleMin: YIELD_CURVE_MAX_STALE_MIN,
    recordCount: countCurves,
    declareRecords: countCurves,
    contentMeta,
    maxContentAgeMin: YIELD_CURVE_MAX_CONTENT_AGE_MIN,
    extraKeys,
    afterPublish: markYieldCurveActivated('AU'),

    lockTtlMs: 300_000,
    fetchPhaseTimeoutMs: 280_000,  }).catch((err) => {
    console.error('FATAL:', err?.message || err);
    process.exit(1);
  });
}
