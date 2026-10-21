#!/usr/bin/env node
// Bank of England gilt nominal spot curves (Anderson–Sleath), daily since
// 1979. The daily zip refreshes the current month; the archive zip holds the
// full history as one workbook per era. Refresh the archive on cold start and
// month rollover so missed month-end observations can be recovered.
//
// BoE publishes no API; both zips are public downloads. exceljs and jszip are
// already seed-runtime dependencies.

import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { CHROME_UA, loadEnvFile, readCanonicalValue, runSeed } from './_seed-utils.mjs';
import { countCurves, mergeCurveHistory } from './lib/yield-curves/model.mjs';
import { BOE_NOMINAL_ENTRY_MATCHER, parseBoeNominalWorkbook } from './lib/yield-curves/boe.mjs';
import { YIELD_CURVE_MAX_CONTENT_AGE_MIN, YIELD_CURVE_MAX_STALE_MIN, YIELD_CURVE_TTL_SECONDS, canonicalKey, latestExtraKeyEntry, makeValidate, markYieldCurveActivated, contentMeta, seedResource, yearExtraKeyEntry } from './seed-yield-curves-shared.mjs';

loadEnvFile(import.meta.url);

const LATEST_ZIP = 'https://www.bankofengland.co.uk/-/media/boe/files/statistics/yield-curves/latest-yield-curve-data.zip';
const ARCHIVE_ZIP = 'https://www.bankofengland.co.uk/-/media/boe/files/statistics/yield-curves/glcnominalddata.zip';

async function fetchZip(url, timeoutMs) {
  const response = await fetch(url, {
    headers: { Accept: 'application/zip, */*', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`BoE HTTP ${response.status} for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function parseZipCurves(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.keys(zip.files).filter((name) => BOE_NOMINAL_ENTRY_MATCHER.test(name));
  if (entries.length === 0) throw new Error('BoE zip contains no nominal workbook');
  const points = [];
  for (const name of entries) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await zip.file(name).async('nodebuffer'));
    const parsed = parseBoeNominalWorkbook(workbook);
    console.log(`  BoE ${name}: ${parsed.length} business days`);
    points.push(...parsed);
  }
  return points;
}

export async function fetchBoeCurve() {
  const previous = await readCanonicalValue(canonicalKey('GB')).catch(() => null);
  const hasHistory = Array.isArray(previous?.curves) && previous.curves.length > 1000;

  const latest = await parseZipCurves(await fetchZip(LATEST_ZIP, 60_000));
  if (latest.length === 0) throw new Error('BoE latest zip contains no observations');
  const previousMonth = previous?.curves?.at(-1)?.date?.slice(0, 7);
  const latestMonth = latest.at(-1).date.slice(0, 7);
  // An archive failure must fail this run, preserving the old month so the
  // next attempt still backfills it before advancing the canonical history.
  const refreshArchive = !hasHistory || previousMonth !== latestMonth;
  const archive = refreshArchive
    ? await parseZipCurves(await fetchZip(ARCHIVE_ZIP, 240_000))
    : [];
  if (refreshArchive && archive.length === 0) throw new Error('BoE archive contains no observations');
  const fetched = [...archive, ...latest];

  const merged = mergeCurveHistory(previous, fetched);
  console.log(`  BoE: fetched ${fetched.length} days, merged history ${merged.curves.length} days, ${merged.curves[0]?.date} → ${merged.curves.at(-1)?.date}`);
  return merged;
}

if (process.argv[1]?.endsWith('seed-yield-curve-gb.mjs')) {
  const extraKeys = [latestExtraKeyEntry('GB')];
  const endYear = new Date().getUTCFullYear();
  for (let year = 1979; year <= endYear; year += 1) {
    extraKeys.push(yearExtraKeyEntry('GB', year, year === endYear));
  }
  runSeed('economic', seedResource('GB'), canonicalKey('GB'), fetchBoeCurve, {
    validateFn: makeValidate(1000, '1979-'),
    ttlSeconds: YIELD_CURVE_TTL_SECONDS,
    sourceVersion: 'boe-glc-nominal-xlsx-v1',
    schemaVersion: 1,
    maxStaleMin: YIELD_CURVE_MAX_STALE_MIN,
    recordCount: countCurves,
    declareRecords: countCurves,
    contentMeta,
    maxContentAgeMin: YIELD_CURVE_MAX_CONTENT_AGE_MIN,
    extraKeys,
    afterPublish: markYieldCurveActivated('GB'),

    lockTtlMs: 420_000,
    fetchPhaseTimeoutMs: 400_000,  }).catch((err) => {
    console.error('FATAL:', err?.message || err);
    process.exit(1);
  });
}
