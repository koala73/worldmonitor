#!/usr/bin/env node
/**
 * Annual mineral production & processing shares (USGS MCS + BGS fill).
 *
 * Stages: MCS ingest → BGS fill for commodities MCS lacks → per-commodity
 * × stage share/HHI. IEA is skipped (redistribution terms).
 */

import { allSettledWithConcurrency, isAllowedRouteHost, loadEnvFile, runSeed } from './_seed-utils.mjs';
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
export const TTL_SECONDS = 450 * 24 * 3600;
export const SOURCE_VERSION = 'usgs-mcs-bgs-v1';
export const MAX_STALE_MIN = 60 * 24 * 400;
export const MAX_CONTENT_AGE_MIN = 18 * 30 * 24 * 60;

const USGS_UA = 'WorldMonitor/1.0 (mineral-production seeder; +https://worldmonitor.app)';
const PINNED_MCS_2026_CSV = 'https://www.sciencebase.gov/catalog/file/get/69837e43b66b01367d7ec7c7?f=__disk__d3%2Fac%2F84%2Fd3ac8466552946c5e8caa2c2c6338d9e1aff655d';
const SCIENCEBASE_SEARCH = 'https://www.sciencebase.gov/catalog/items?q=Mineral%20Commodity%20Summaries%20Commodity%20Salient&format=json&max=10&fields=title,files';
const BGS_ITEMS = 'https://ogcapi.bgs.ac.uk/collections/world-mineral-statistics/items';

// The ScienceBase catalog response is upstream-controlled data, so the CSV URL
// it hands back is untrusted input: without this allowlist any entry that wins
// the discovery sort would be fetched from an arbitrary host and its contents
// published to the canonical key and served by the public RPC/MCP tool.
const MCS_ALLOWED_HOSTS = ['sciencebase.gov', 'usgs.gov'];

// The BGS loop was sequential, so with a 45s per-request timeout the 16-name
// worst case was ~720s against the bundle's 180s budget -- only 4 requests
// could ever complete before the bundle killed the member. 6-wide with a
// tighter per-request timeout bounds the worst case to ceil(16/6)*30s = 90s,
// leaving real headroom under 180s while staying polite to one upstream.
const BGS_FETCH_CONCURRENCY = 6;
const BGS_FETCH_TIMEOUT_MS = 30_000;

async function fetchUsgsCsv(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': USGS_UA, Accept: 'text/csv,*/*' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return decodeUsgsCsvText(Buffer.from(await resp.arrayBuffer()));
}

async function fetchJson(url, timeoutMs = 45_000) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': USGS_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
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
    if (picked && !isAllowedRouteHost(picked.url, MCS_ALLOWED_HOSTS)) {
      // ScienceBase "link"-type files can carry an arbitrary `url`, so a
      // catalog entry could otherwise redirect the seeder off-host.
      console.warn(`[seed] mineral-production: discovered CSV host not allowlisted (${picked.url}); using pinned MCS 2026 CSV`);
    } else if (picked) {
      console.log(`[seed] mineral-production: USGS MCS ${picked.year} → ${picked.title}`);
      return { url: picked.url, edition: `mcs-${picked.year}` };
    } else {
      // Catalog fetch succeeded but matched nothing (renamed file, changed
      // shape, query fell out of the top 10). Without this the seeder would
      // republish the frozen pinned edition every cycle in total silence.
      console.warn('[seed] mineral-production: ScienceBase returned no matching commodities_data.csv; using pinned MCS 2026 CSV');
    }
  } catch (err) {
    console.warn(`[seed] mineral-production: ScienceBase discovery failed (${err.message}); using pinned MCS 2026 CSV`);
  }
  return { url: PINNED_MCS_2026_CSV, edition: 'mcs-2026-pinned' };
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
  let failed = 0;
  const settled = await allSettledWithConcurrency(names, BGS_FETCH_CONCURRENCY, async (name) => {
    const qs = new URLSearchParams({
      f: 'json',
      limit: '2000',
      filter: `commodity='${name.replace(/'/g, "''")}' AND statistic_type='Production'`,
    });
    const body = await fetchJson(`${BGS_ITEMS}?${qs}`, BGS_FETCH_TIMEOUT_MS);
    const features = Array.isArray(body?.features) ? body.features : [];
    return features.map((feat) => {
      const p = feat.properties || {};
      return {
        commodity: p.commodity || p.Commodity || name,
        sub_commodity: p.sub_commodity || p.subCommodity || '',
        country: p.country || p.Country || '',
        year: p.year || p.Year,
        statistic_type: p.statistic_type || p.statisticType || 'Production',
        value: p.value ?? p.Value,
        unit: p.unit || p.Unit || '',
      };
    });
  });
  for (const [i, result] of settled.entries()) {
    if (result.status === 'fulfilled') {
      collected.push(...result.value);
    } else {
      failed += 1;
      console.warn(`[seed] mineral-production: BGS fetch skipped for ${names[i]} (${result.reason?.message || result.reason})`);
    }
  }
  // A total BGS outage must not look like "BGS had nothing to add": the caller
  // needs to tell an empty-but-healthy fill from a fill that never ran, so the
  // 8-commodity floor cannot be cleared by USGS alone while uranium silently
  // drops out of the published payload.
  if (names.length > 0 && failed === names.length) {
    const err = new Error(`BGS fill failed for all ${names.length} commodity names`);
    // Marked so buildPayload can rethrow this specific case: a partial BGS
    // failure is tolerable, but a TOTAL outage must not be published as though
    // BGS simply had nothing to add -- the USGS-only payload still clears the
    // commodity floor while uranium silently vanishes from the key.
    err.totalBgsOutage = true;
    throw err;
  }
  console.log(`[seed] mineral-production: BGS fill rows=${collected.length} names=${names.length} failed=${failed}`);
  return collected;
}

// Fraction of the shipped vocabulary that must carry at least one stage for a
// payload to be publishable. Deriving the floor from the vocab is the point:
// a hardcoded 8 against a 14-commodity vocab tolerated losing 6 commodities
// (43%) with every gate still green, and grew more permissive each time a
// commodity was added. USGS publishes a world table for 13 of the 14 (uranium
// is the BGS-only gap), so 70% (10 today) keeps real headroom while still
// failing closed on a mass parse regression -- e.g. USGS relabelling the
// Statistics column, which parseUsgsMcsCsv matches case-sensitively.
export const MIN_STAGED_COMMODITY_RATIO = 0.7;

export function minStagedCommodities(vocab = loadMineralVocab()) {
  return Math.ceil((vocab.commodities?.length || 0) * MIN_STAGED_COMMODITY_RATIO);
}

export function validateFn(data) {
  if (!data || typeof data !== 'object') return false;
  const commodities = data.commodities;
  if (!commodities || typeof commodities !== 'object') return false;
  const withStage = Object.values(commodities).filter((c) => c?.stages?.mine || c?.stages?.refinery);
  return withStage.length >= minStagedCommodities();
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
    // Fail the run rather than publish a BGS-less payload that still passes the
    // commodity floor: runSeed leaves the previous canonical value in place
    // under its TTL, which is strictly better than dropping the BGS-only
    // commodities (uranium) from a payload that looks healthy everywhere.
    if (err?.totalBgsOutage) throw err;
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
