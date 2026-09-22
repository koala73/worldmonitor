#!/usr/bin/env node
// Daily US Treasury par yield curve. Treasury publishes one XML document per
// calendar year. The canonical Redis value is the full history. Year shards
// and the latest business day are what the RPC reads, because a single GET of
// the full curve exceeds the 1.5s Redis read budget.

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';
import { DAY_MIN, tokensToContentMeta } from './_content-age-helpers.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';

loadEnvFile(import.meta.url);

export const TREASURY_CANONICAL_KEY = 'economic:us-treasury-par-yield:v1';
export const TREASURY_LATEST_KEY = 'economic:us-treasury-par-yield:latest:v1';
export const TREASURY_ACTIVATION_KEY = 'seed-activated:economic:us-treasury-par-yield';
export const TREASURY_START_YEAR = 1990;
export const TENOR_TAGS = [
  ['BC_1MONTH', 'oneMonth'],
  ['BC_1_5MONTH', 'oneAndAHalfMonth'],
  ['BC_2MONTH', 'twoMonth'],
  ['BC_3MONTH', 'threeMonth'],
  ['BC_4MONTH', 'fourMonth'],
  ['BC_6MONTH', 'sixMonth'],
  ['BC_1YEAR', 'oneYear'],
  ['BC_2YEAR', 'twoYear'],
  ['BC_3YEAR', 'threeYear'],
  ['BC_5YEAR', 'fiveYear'],
  ['BC_7YEAR', 'sevenYear'],
  ['BC_10YEAR', 'tenYear'],
  ['BC_20YEAR', 'twentyYear'],
  ['BC_30YEAR', 'thirtyYear'],
];

const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_STALE_MIN = 4320;
const TREASURY_MAX_CONTENT_AGE_MIN = 10 * DAY_MIN;
const TREASURY_XML = 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=';

export function treasuryYearKey(year) {
  return `${TREASURY_CANONICAL_KEY}:${year}`;
}

function fieldValue(entry, tag) {
  const match = new RegExp(`<d:${tag}(?![A-Z0-9_])([^>]*)(?:/>|>([^<]*)</d:${tag}>)`).exec(entry);
  if (!match) return undefined;
  if (/\bm:null="true"/.test(match[1] ?? '')) return undefined;
  const text = (match[2] ?? '').trim();
  if (!text) return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

export function parseTreasuryYieldXml(xml) {
  const byDate = new Map();
  for (const entry of String(xml ?? '').split('<entry>').slice(1)) {
    const dateMatch = /<d:NEW_DATE\b[^>]*>(\d{4}-\d{2}-\d{2})/.exec(entry);
    if (!dateMatch) continue;
    const curve = { date: dateMatch[1] };
    let present = false;
    for (const [tag, field] of TENOR_TAGS) {
      const value = fieldValue(entry, tag);
      if (value == null) continue;
      curve[field] = value;
      present = true;
    }
    if (present) byDate.set(curve.date, curve);
  }
  return [...byDate.values()].sort((left, right) => (left.date < right.date ? -1 : 1));
}

export function treasuryYearShard(data, year) {
  return {
    curves: (data?.curves ?? []).filter((curve) => curve.date.startsWith(`${year}-`)),
  };
}

export function countCurves(data) {
  return Array.isArray(data?.curves) ? data.curves.length : data?.date ? 1 : 0;
}

function validate(data) {
  const curves = data?.curves;
  if (!Array.isArray(curves) || curves.length < 5000) return false;
  if (!curves[0]?.date?.startsWith('1990-01')) return false;
  const latest = curves.at(-1);
  return typeof latest?.tenYear === 'number' || typeof latest?.twoYear === 'number';
}

async function fetchYear(year) {
  const response = await fetch(`${TREASURY_XML}${year}`, {
    headers: { Accept: 'application/atom+xml, application/xml, text/xml', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Treasury yield curve ${year} HTTP ${response.status}`);
  const xml = await response.text();
  const curves = parseTreasuryYieldXml(xml);
  if (curves.length === 0) throw new Error(`Treasury yield curve ${year} parsed no business days`);
  console.log(`  Treasury ${year}: ${curves.length} business days`);
  return curves;
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function fetchTreasuryCurve() {
  const endYear = new Date().getUTCFullYear();
  const years = [];
  for (let year = TREASURY_START_YEAR; year <= endYear; year += 1) years.push(year);
  const batches = await mapPool(years, 4, fetchYear);
  const byDate = new Map();
  for (const curves of batches) {
    for (const curve of curves) byDate.set(curve.date, curve);
  }
  return {
    curves: [...byDate.values()].sort((left, right) => (left.date < right.date ? -1 : 1)),
  };
}

function contentMeta(data) {
  const curves = data?.curves ?? [];
  return tokensToContentMeta([curves[0]?.date, curves.at(-1)?.date]);
}

async function markActivated() {
  try {
    const creds = getOptionalUpstashCreds();
    if (!creds) return;
    await upstashCommand(creds, ['SET', TREASURY_ACTIVATION_KEY, '1']);
  } catch (err) {
    console.warn(`  WARN: Treasury activation marker write failed: ${err?.message || err}`);
  }
}

if (process.argv[1]?.endsWith('seed-us-treasury-par-yield.mjs')) {
  const endYear = new Date().getUTCFullYear();
  const extraKeys = [
    {
      key: TREASURY_LATEST_KEY,
      transform: (data) => data.curves.at(-1),
      declareRecords: () => 1,
    },
  ];
  for (let year = TREASURY_START_YEAR; year <= endYear; year += 1) {
    extraKeys.push({
      key: treasuryYearKey(year),
      transform: (data) => treasuryYearShard(data, year),
      declareRecords: countCurves,
      skipWhenEmpty: true,
      allowMissingOnSkip: year === endYear,
    });
  }

  runSeed('economic', 'us-treasury-par-yield', TREASURY_CANONICAL_KEY, fetchTreasuryCurve, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL_SECONDS,
    lockTtlMs: 180_000,
    fetchPhaseTimeoutMs: 160_000,
    sourceVersion: 'treasury-par-yield-xml-v1',
    schemaVersion: 1,
    maxStaleMin: MAX_STALE_MIN,
    recordCount: countCurves,
    declareRecords: countCurves,
    contentMeta,
    maxContentAgeMin: TREASURY_MAX_CONTENT_AGE_MIN,
    extraKeys,
    afterPublish: markActivated,
  }).catch((err) => {
    console.error('FATAL:', err?.message || err);
    process.exit(1);
  });
}
