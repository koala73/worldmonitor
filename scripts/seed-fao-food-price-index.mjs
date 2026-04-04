#!/usr/bin/env node

/**
 * Seed script: fetches the FAO Food Price Index (FFPI) CSV and writes
 * the past 12 months to Upstash Redis.
 *
 * Source: https://www.fao.org/media/docs/worldfoodsituationlibraries/default-document-library/food_price_indices_data.csv
 * Released: first Friday of each month ~08:30 UTC
 *
 * Railway cron: 45 8 * * *   (daily at 08:45 UTC — over-seeds safely; FAO releases ~first Friday of month)
 */

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'economic:fao-ffpi:v1';
const CACHE_TTL = 90 * 24 * 60 * 60; // 90 days — monthly seed, 3x interval per gold standard
const CSV_URL = 'https://www.fao.org/media/docs/worldfoodsituationlibraries/default-document-library/food_price_indices_data.csv';
const MONTHS_TO_KEEP = 12;

async function fetchFaoFfpi() {
  const resp = await globalThis.fetch(CSV_URL, {
    headers: { 'User-Agent': CHROME_UA, 'Accept': 'text/csv,text/plain,*/*' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) throw new Error(`FAO CSV HTTP ${resp.status}`);

  const raw = await resp.text();
  // Strip BOM if present
  const text = raw.startsWith('\ufeff') ? raw.slice(1) : raw;

  // CSV structure:
  //   Row 0: "FAO Food Price Index"  (title)
  //   Row 1: "2014-2016=100"         (base note)
  //   Row 2: "Date,Food Price Index,Meat,Dairy,Cereals,Oils,Sugar"  (header)
  //   Row 3: blank
  //   Row 4+: YYYY-MM,value,...
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  const dataLines = lines.filter(l => /^\d{4}-\d{2},/.test(l));
  if (dataLines.length === 0) throw new Error('FAO CSV: no data rows found');

  function parseVal(s) {
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : 0;
  }

  const allPoints = dataLines.map(line => {
    const [date, ffpi, meat, dairy, cereals, oils, sugar] = line.split(',').map(s => s.trim());
    return {
      date,
      ffpi:    parseVal(ffpi),
      meat:    parseVal(meat),
      dairy:   parseVal(dairy),
      cereals: parseVal(cereals),
      oils:    parseVal(oils),
      sugar:   parseVal(sugar),
    };
  });

  // Need MONTHS_TO_KEEP + 1 points: 12 for display + 1 year-ago for YoY
  const recentPoints = allPoints.slice(-(MONTHS_TO_KEEP + 1));

  if (recentPoints.length < 2) throw new Error('FAO CSV: insufficient data rows');

  const last = recentPoints[recentPoints.length - 1];
  const prev = recentPoints[recentPoints.length - 2];
  const yearAgo = recentPoints.length >= 13 ? recentPoints[recentPoints.length - 13] : null;

  const momPct = prev.ffpi > 0
    ? +((last.ffpi - prev.ffpi) / prev.ffpi * 100).toFixed(2)
    : 0;

  const yoyPct = yearAgo && yearAgo.ffpi > 0
    ? +((last.ffpi - yearAgo.ffpi) / yearAgo.ffpi * 100).toFixed(2)
    : 0;

  // Store only the last 12 months in the response
  const points = recentPoints.slice(-MONTHS_TO_KEEP);

  console.log(`  Latest: ${last.date} FFPI=${last.ffpi} MoM=${momPct}% YoY=${yoyPct}%`);

  return {
    points,
    fetchedAt: new Date().toISOString(),
    currentFfpi: last.ffpi,
    momPct,
    yoyPct,
  };
}

const isMain = process.argv[1]?.endsWith('seed-fao-food-price-index.mjs');
if (isMain) {
  await runSeed('economic', 'fao-ffpi', CANONICAL_KEY, fetchFaoFfpi, {
    ttlSeconds: CACHE_TTL,
    validateFn: (data) => data?.points?.length > 0,
    recordCount: (data) => data?.points?.length || 0,
  });
}
