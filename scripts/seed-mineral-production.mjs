#!/usr/bin/env node
/**
 * Annual mineral production & processing shares (USGS MCS + BGS fill).
 *
 * Stages: MCS ingest → BGS fill for commodities MCS lacks → per-commodity
 * × stage share/HHI. IEA is skipped (redistribution terms).
 */

import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import {
  CANONICAL_KEY,
  SCHEMA_VERSION,
  loadMineralVocab,
  decodeUsgsCsvText,
  parseUsgsMcsCsv,
  parseBgsRecords,
  mergeUsgsThenBgs,
  buildMineralProductionPayload,
} from './shared/mineral-production-parse.mjs';

loadEnvFile(import.meta.url);

export { CANONICAL_KEY };
export const TTL_SECONDS = 180 * 24 * 3600;
export const SOURCE_VERSION = 'usgs-mcs-bgs-v1';
export const MAX_STALE_MIN = 60 * 24 * 400;
export const MAX_CONTENT_AGE_MIN = 18 * 30 * 24 * 60;

const USGS_UA = 'WorldMonitor/1.0 (mineral-production seeder; +https://worldmonitor.app)';
const PINNED_MCS_2026_CSV = 'https://www.sciencebase.gov/catalog/file/get/69837e43b66b01367d7ec7c7?f=__disk__d3%2Fac%2F84%2Fd3ac8466552946c5e8caa2c2c6338d9e1aff655d';
const SCIENCEBASE_SEARCH = 'https://www.sciencebase.gov/catalog/items?q=Mineral%20Commodity%20Summaries%20Commodity%20Salient&format=json&max=10&fields=title,files';
const BGS_ITEMS = 'https://ogcapi.bgs.ac.uk/collections/world-mineral-statistics/items';

async function fetchUsgsCsv(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': USGS_UA, Accept: 'text/csv,*/*' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return decodeUsgsCsvText(Buffer.from(await resp.arrayBuffer()));
}

async function fetchJson(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': USGS_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(45_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.json();
}

export function pickUsgsMcsCsvFromCatalog(catalog) {
  const items = Array.isArray(catalog?.items) ? catalog.items : [];
  const scored = [];
  for (const item of items) {
    const title = String(item.title || '');
    const yearMatch = title.match(/20\d{2}/);
    const year = yearMatch ? Number(yearMatch[0]) : 0;
    const files = Array.isArray(item.files) ? item.files : [];
    const csv = files.find((f) => /commodities_data\.csv$/i.test(f.name || ''));
    if (!csv?.downloadUri && !csv?.url) continue;
    scored.push({ year, title, url: csv.downloadUri || csv.url });
  }
  scored.sort((a, b) => b.year - a.year);
  return scored[0] || null;
}

export async function discoverUsgsMcsCsv() {
  try {
    const catalog = await fetchJson(SCIENCEBASE_SEARCH);
    const picked = pickUsgsMcsCsvFromCatalog(catalog);
    if (picked) {
      console.log(`[seed] mineral-production: USGS MCS ${picked.year} → ${picked.title}`);
      return { url: picked.url, edition: `mcs-${picked.year}` };
    }
  } catch (err) {
    console.warn(`[seed] mineral-production: ScienceBase discovery failed (${err.message}); using pinned MCS 2026 CSV`);
  }
  return { url: PINNED_MCS_2026_CSV, edition: 'mcs-2026' };
}

function bgsFillNames(vocab, usgsRows = []) {
  const have = new Set();
  for (const row of usgsRows) {
    if (row.stage === 'mine' || row.stage === 'refinery') have.add(`${row.commodityId}:${row.stage}`);
  }
  const names = new Set();
  for (const item of vocab.commodities) {
    const needsFill = !have.has(`${item.id}:mine`) || !have.has(`${item.id}:refinery`);
    if (!needsFill) continue;
    for (const n of item.bgsNames || []) names.add(n);
  }
  return [...names];
}

export async function fetchBgsFill(vocab, usgsRows = []) {
  const names = bgsFillNames(vocab, usgsRows);
  const collected = [];
  for (const name of names) {
    const qs = new URLSearchParams({
      f: 'json',
      limit: '2000',
      filter: `commodity='${name.replace(/'/g, "''")}' AND statistic_type='Production'`,
    });
    try {
      const body = await fetchJson(`${BGS_ITEMS}?${qs}`);
      const features = Array.isArray(body?.features) ? body.features : [];
      for (const feat of features) {
        const p = feat.properties || {};
        collected.push({
          commodity: p.commodity || p.Commodity || name,
          sub_commodity: p.sub_commodity || p.subCommodity || '',
          country: p.country || p.Country || '',
          year: p.year || p.Year,
          statistic_type: p.statistic_type || p.statisticType || 'Production',
          value: p.value ?? p.Value,
          unit: p.unit || p.Unit || '',
        });
      }
    } catch (err) {
      console.warn(`[seed] mineral-production: BGS fetch skipped for ${name} (${err.message})`);
    }
  }
  console.log(`[seed] mineral-production: BGS fill rows=${collected.length}`);
  return collected;
}

export function validateFn(data) {
  if (!data || typeof data !== 'object') return false;
  const commodities = data.commodities;
  if (!commodities || typeof commodities !== 'object') return false;
  const withStage = Object.values(commodities).filter((c) => c?.stages?.mine || c?.stages?.refinery);
  return withStage.length >= 8;
}

export function declareRecords(data) {
  if (!data?.commodities) return 0;
  return Object.values(data.commodities).filter((c) => c?.stages?.mine || c?.stages?.refinery).length;
}

export function contentMeta(data) {
  const year = Number(data?.dataYear);
  if (!Number.isInteger(year)) return null;
  const newestItemAt = Date.parse(`${year}-12-31T00:00:00.000Z`);
  if (!Number.isFinite(newestItemAt) || newestItemAt <= 0) return null;
  return { newestItemAt, oldestItemAt: newestItemAt };
}

export async function buildPayload() {
  const vocab = loadMineralVocab();
  const discovered = await discoverUsgsMcsCsv();
  const csv = await fetchUsgsCsv(discovered.url);
  const usgs = parseUsgsMcsCsv(csv, { vocab });
  console.log(`[seed] mineral-production: USGS rows=${usgs.rows.length} unmapped=${usgs.unmapped.length}`);
  if (usgs.unmapped.length) {
    const sample = usgs.unmapped.slice(0, 12).map((u) => `${u.country} (${u.commodity})`).join(', ');
    console.warn(`[seed] mineral-production: unmapped countries (${usgs.unmapped.length}): ${sample}`);
  }
  let bgsRows = [];
  try {
    const bgsRecords = await fetchBgsFill(vocab, usgs.rows);
    const parsed = parseBgsRecords(bgsRecords, { vocab });
    bgsRows = parsed.rows;
    if (parsed.unmapped.length) {
      console.warn(`[seed] mineral-production: BGS unmapped=${parsed.unmapped.length}`);
    }
  } catch (err) {
    console.warn(`[seed] mineral-production: BGS fill failed (${err.message})`);
  }
  const merged = mergeUsgsThenBgs(usgs.rows, bgsRows);
  const sources = ['usgs-mcs'];
  if (bgsRows.length) sources.push('bgs');
  return buildMineralProductionPayload(merged, {
    edition: discovered.edition,
    sources,
    fetchedAt: new Date().toISOString(),
  });
}

const isMain = process.argv[1]?.endsWith('seed-mineral-production.mjs');
if (isMain) {
  runSeed('supply-chain', 'mineral-production', CANONICAL_KEY, buildPayload, {
    validateFn,
    ttlSeconds: TTL_SECONDS,
    sourceVersion: SOURCE_VERSION,
    declareRecords,
    schemaVersion: SCHEMA_VERSION,
    maxStaleMin: MAX_STALE_MIN,
    contentMeta,
    maxContentAgeMin: MAX_CONTENT_AGE_MIN,
    lockTtlMs: 180_000,
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
