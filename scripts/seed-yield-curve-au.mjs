#!/usr/bin/env node
// RBA F2 capital-market yields — Australian Government bonds (interpolated
// AGS), daily since 2013-05-20, series 2Y 3Y 5Y 10Y.
// f2-data.csv covers the full daily history (~200 KB). Fetch directly and retain
// bounded rejection evidence; an HTTP 403 alone cannot identify its cause.

import { CHROME_UA, loadEnvFile, runSeed } from './_seed-utils.mjs';
import { parseRbaCsv } from './lib/yield-curves/rba.mjs';
import { countCurves } from './lib/yield-curves/model.mjs';
import { YIELD_CURVE_MAX_CONTENT_AGE_MIN, YIELD_CURVE_MAX_STALE_MIN, YIELD_CURVE_TTL_SECONDS, canonicalKey, latestExtraKeyEntry, makeValidate, markYieldCurveActivated, contentMeta, seedResource, yearExtraKeyEntry } from './seed-yield-curves-shared.mjs';

loadEnvFile(import.meta.url);

// The same F2 table as tables/xls/f02d.xlsx, whose 8.2 MB ExcelJS load peaked
// at 1.69 GB RSS and killed the AU section in the 2 GB yield-curves container.
const F2_CSV = 'https://www.rba.gov.au/statistics/tables/csv/f2-data.csv';

async function describeRbaRejection(response, elapsedMs) {
  const sample = Buffer.alloc(2048);
  let sampledBytes = 0;
  let bodyState = response.body ? 'complete' : 'absent';
  if (response.body) {
    const reader = response.body.getReader();
    let timer;
    const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(null), 250); });
    try {
      while (sampledBytes < sample.length) {
        const chunk = await Promise.race([reader.read(), deadline]);
        if (chunk === null) { bodyState = 'timeout'; break; }
        if (chunk.done) break;
        const bytes = chunk.value.subarray(0, sample.length - sampledBytes);
        sample.set(bytes, sampledBytes);
        sampledBytes += bytes.length;
        if (sampledBytes === sample.length) bodyState = 'limit';
      }
    } catch {
      bodyState = 'error';
    } finally {
      clearTimeout(timer);
      // A stalled cancellation must not delay the original HTTP failure.
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  const text = sample.subarray(0, sampledBytes).toString('utf8');
  const bodyMarker = /captcha|cf-chl-|just a moment/i.test(text) ? 'challenge_marker'
    : /access denied|forbidden/i.test(text) ? 'denial_marker' : sampledBytes ? 'other' : 'empty';
  const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  const server = response.headers.get('server')?.trim().toLowerCase();
  const length = response.headers.get('content-length');
  const declaredBytes = length && /^\d{1,16}$/.test(length) && Number.isSafeInteger(Number(length)) ? Number(length) : null;
  return {
    event: 'rba_http_rejection', status: response.status, elapsedMs,
    redirected: response.redirected, expectedUrl: response.url === F2_CSV,
    contentType: !type ? 'missing' : type === 'text/html' ? 'html' : type === 'application/json' ? 'json' : 'other',
    server: !server ? 'missing' : server === 'apache' ? 'apache' : server === 'cloudflare' ? 'cloudflare' : 'other',
    declaredBytes, bodyState, bodyMarker, sampledBytes,
  };
}

export async function fetchRbaCurve() {
  const started = performance.now();
  const response = await fetch(F2_CSV, {
    headers: { Accept: 'text/csv, */*', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    const diagnostic = await describeRbaRejection(response, Math.round(performance.now() - started));
    throw new Error(`RBA HTTP ${response.status}: ${JSON.stringify(diagnostic)}`);
  }
  const curves = parseRbaCsv(await response.text());
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
    sourceVersion: 'rba-f2-csv-v1',
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
