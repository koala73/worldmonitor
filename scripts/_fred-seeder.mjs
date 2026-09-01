import {
  allSettledWithConcurrency,
  fredFetchJson,
  getRedisCredentials,
  redisCommand,
  resolveProxyForConnect,
} from './_seed-utils.mjs';
import { getOptionalUpstashCreds } from './_upstash-rest.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';

export const FRED_KEY_PREFIX = 'economic:fred:v1';
export const STRESS_INDEX_KEY = 'economic:stress-index:v1';
export const STRESS_INDEX_TTL = 21600; // 6h
export const FRED_TTL = 93600; // 26h — survive daily cron scheduling drift

// Series metadata (title/units/frequency) is DESCRIPTIVE, not observational —
// DGS10's title and units do not change between hourly runs. Fetching it beside
// every observations call meant each series cost TWO proxied requests per run, so
// half of this seeder's FRED traffic re-read constants. api.stlouisfed.org carries
// the largest request count of any target on the residential proxy account
// (391K over 90 days), and seed-fred-rates is hourly × 24 series.
//
// One blob for all series: a single GET per run, and a SETEX only when something
// was actually fetched. The 30-day TTL is the guard against a renamed or re-based
// series being pinned forever — not a freshness requirement.
export const FRED_SERIES_META_KEY = 'economic:fred:series-meta:v1';
export const FRED_SERIES_META_TTL = 30 * 24 * 60 * 60; // 30d

export const FRED_SEED_SERIES = ['WALCL', 'FEDFUNDS', 'T10Y2Y', 'UNRATE', 'CPIAUCSL', 'DGS10', 'VIXCLS', 'GDP', 'M2SL', 'DCOILWTICO', 'BAMLH0A0HYM2', 'ICSA', 'MORTGAGE30US', 'BAMLC0A0CM', 'SOFR', 'DGS1MO', 'DGS3MO', 'DGS6MO', 'DGS1', 'DGS2', 'DGS5', 'DGS30', 'T10Y3M', 'STLFSI4'];

// Keep the 24-series loop inside runSeed's fetch-phase deadline even when the
// proxy is fully down. At concurrency 12, the 24 requests finish in two waves
// instead of turning a proxy outage into a sequential 24-series timeout.
export const FRED_CONCURRENCY = 12;

/** @param {number} v */
function clamp(v) { return Math.min(100, Math.max(0, v)); }

const STRESS_COMPONENTS = [
  { id: 'T10Y2Y', label: 'Yield Curve', weight: 0.20, score: (v) => clamp((0.5 - v) / (0.5 - (-1.5)) * 100) },
  { id: 'T10Y3M', label: 'Bank Spread', weight: 0.15, score: (v) => clamp((0.5 - v) / (0.5 - (-1.0)) * 100) },
  { id: 'VIXCLS', label: 'Volatility', weight: 0.20, score: (v) => clamp((v - 15) / (80 - 15) * 100) },
  { id: 'STLFSI4', label: 'Financial Stress', weight: 0.20, score: (v) => clamp((v - (-1)) / (5 - (-1)) * 100) },
  { id: 'GSCPI', label: 'Supply Chain', weight: 0.15, score: (v) => clamp((v - (-2)) / (4 - (-2)) * 100) },
  { id: 'ICSA', label: 'Job Claims', weight: 0.10, score: (v) => clamp((v - 180000) / (500000 - 180000) * 100) },
];

/** @param {number} score */
function stressLabel(score) {
  if (score < 20) return 'Low';
  if (score < 40) return 'Moderate';
  if (score < 60) return 'Elevated';
  if (score < 80) return 'Severe';
  return 'Critical';
}

/**
 * Extract GSCPI observations from the Redis-stored payload.
 * ais-relay writes the FRED-compatible shape `{ series: { observations } }`.
 * Earlier versions stored a flat `{ observations }` shape, so accept both.
 * @param {unknown} parsed
 * @returns {{ observations: { date: string; value: number }[] } | null}
 */
export function extractGscpiObservations(parsed) {
  const p = /** @type {any} */ (parsed);
  const obs = p?.series?.observations ?? p?.observations;
  return Array.isArray(obs) ? { observations: obs } : null;
}

/**
 * Read GSCPI from Redis (seeded by ais-relay from NY Fed, not available via FRED API).
 * @returns {Promise<{ observations: { date: string; value: number }[] } | null>}
 */
export async function fetchGscpiFromRedis() {
  try {
    const { url, token } = getRedisCredentials();
    const resp = await fetch(`${url}/get/${encodeURIComponent(`${FRED_KEY_PREFIX}:GSCPI:0`)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return null;
    const body = /** @type {{ result?: string | null; error?: unknown }} */ (await resp.json());
    if (body.error != null || !body.result) return null;
    return extractGscpiObservations(unwrapEnvelope(JSON.parse(body.result)).data);
  } catch {
    return null;
  }
}

/**
 * Keep only the metadata fields this seeder publishes, and only when FRED actually
 * described the series. Returning null for anything else is what stops the
 * `title = seriesId` fallback from being cached as if it were real metadata.
 * @param {unknown} entry
 * @returns {{ title: string; units: string; frequency: string } | null}
 */
export function normalizeFredSeriesMeta(entry) {
  const e = /** @type {any} */ (entry);
  const title = typeof e?.title === 'string' ? e.title.trim() : '';
  if (!title) return null;
  return {
    title,
    units: typeof e?.units === 'string' ? e.units : '',
    frequency: typeof e?.frequency === 'string' ? e.frequency : '',
  };
}

/**
 * Read the cached series-metadata blob. Any failure — Redis down, malformed JSON,
 * a non-object payload — degrades to `{}`, which makes every series a cache miss
 * and restores the previous fetch-metadata-every-run behaviour exactly.
 * @returns {Promise<Record<string, { title: string; units: string; frequency: string }>>}
 */
export async function readFredSeriesMetaCache() {
  // getRedisCredentials() calls process.exit(1) when Upstash is unconfigured — a
  // try/catch cannot contain that. This cache is an optimisation, so it must degrade,
  // never terminate the seeder: take the credentials through the optional helper.
  const creds = getOptionalUpstashCreds();
  if (!creds) return {};
  const { restUrl: url, token } = creds;
  try {
    const resp = await fetch(`${url}/get/${encodeURIComponent(FRED_SERIES_META_KEY)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return {};
    const body = /** @type {{ result?: string | null; error?: unknown }} */ (await resp.json());
    if (body.error != null || !body.result) return {};
    const parsed = JSON.parse(body.result);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    /** @type {Record<string, { title: string; units: string; frequency: string }>} */
    const clean = {};
    for (const [seriesId, entry] of Object.entries(parsed)) {
      const meta = normalizeFredSeriesMeta(entry);
      if (meta) clean[seriesId] = meta;
    }
    return clean;
  } catch {
    return {};
  }
}

/**
 * Persist the merged metadata blob, pruned to the current series list so a removed
 * series cannot linger. Best-effort: a failed write costs one extra metadata fetch
 * next run, never a failed seed.
 * @param {Record<string, { title: string; units: string; frequency: string }>} meta
 */
export async function writeFredSeriesMetaCache(meta) {
  // Same process.exit(1) hazard as the reader — see readFredSeriesMetaCache.
  const creds = getOptionalUpstashCreds();
  if (!creds) return;
  const { restUrl: url, token } = creds;
  try {
    const pruned = Object.fromEntries(
      FRED_SEED_SERIES.filter((seriesId) => meta[seriesId]).map((seriesId) => [seriesId, meta[seriesId]]),
    );
    if (Object.keys(pruned).length === 0) return;
    await redisCommand(
      url,
      token,
      ['SETEX', FRED_SERIES_META_KEY, String(FRED_SERIES_META_TTL), JSON.stringify(pruned)],
      { label: 'FRED series-meta cache' },
    );
  } catch (error) {
    console.warn(`  [FRED] series-meta cache write skipped — ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Compute the composite stress index from freshly-fetched FRED data.
 * Scan backwards through observations to skip FRED's end-of-series null sentinels.
 * @param {Record<string, { observations: { date: string; value: number }[] }>} fr
 * @returns {{ compositeScore: number; label: string; components: object[]; seededAt: string; unavailable: false } | null}
 */
export function computeStressIndex(fr) {
  const components = [];
  let weightedSum = 0;
  let totalWeight = 0;
  let missingCount = 0;

  for (const comp of STRESS_COMPONENTS) {
    const obs = fr[comp.id]?.observations;
    let rawValue = null;
    if (obs?.length > 0) {
      for (let j = obs.length - 1; j >= 0; j--) {
        const v = obs[j]?.value;
        if (typeof v === 'number' && Number.isFinite(v)) { rawValue = v; break; }
      }
    }

    if (rawValue === null) {
      missingCount++;
      if (comp.id !== 'GSCPI') {
        throw new Error(`StressIndex: required FRED component ${comp.id} missing — refusing to publish partial composite`);
      }
      console.warn(`  [StressIndex] ${comp.id} missing (ais-relay lag) — excluding`);
      components.push({ id: comp.id, label: comp.label, rawValue: null, missing: true, score: 0, weight: comp.weight });
      continue;
    }

    const score = comp.score(rawValue);
    weightedSum += score * comp.weight;
    totalWeight += comp.weight;
    console.log(`  [StressIndex] ${comp.id}: raw=${rawValue.toFixed(4)} score=${score.toFixed(1)}`);
    components.push({ id: comp.id, label: comp.label, rawValue, score, weight: comp.weight });
  }

  if (totalWeight === 0) {
    console.warn('  [StressIndex] No FRED data — skipping write');
    return null;
  }

  const compositeScore = Math.round((weightedSum / totalWeight) * 10) / 10;
  const label = stressLabel(compositeScore);
  console.log(`  [StressIndex] Composite: ${compositeScore} (${label}) — ${STRESS_COMPONENTS.length - missingCount}/${STRESS_COMPONENTS.length} components`);
  return { compositeScore, label, components, seededAt: new Date().toISOString(), unavailable: false };
}

async function fetchOneFredSeries(seriesId, apiKey, fredFetchFn, proxyAuth, cachedMeta = null) {
  const limit = 120;
  const obsParams = new URLSearchParams({
    series_id: seriesId, api_key: apiKey, file_type: 'json', sort_order: 'desc', limit: String(limit),
  });

  // Observations always go over the wire; the /fred/series description only when
  // it is not already cached. On a warm cache this halves the request count.
  const requests = [
    fredFetchFn(`https://api.stlouisfed.org/fred/series/observations?${obsParams}`, proxyAuth),
  ];
  if (!cachedMeta) {
    const metaParams = new URLSearchParams({
      series_id: seriesId, api_key: apiKey, file_type: 'json',
    });
    requests.push(fredFetchFn(`https://api.stlouisfed.org/fred/series?${metaParams}`, proxyAuth));
  }

  const [obsResp, metaResp] = await Promise.allSettled(requests);

  if (obsResp.status === 'rejected') {
    throw new Error(`fetch failed — ${obsResp.reason?.message || obsResp.reason}`);
  }

  const obsData = obsResp.value;
  const observations = (obsData.observations || [])
    .map((o) => { const v = parseFloat(o.value); return Number.isNaN(v) || o.value === '.' ? null : { date: o.date, value: v }; })
    .filter(Boolean)
    .reverse();

  // `fetched` is the only state that may be written back to the cache — a failed
  // metadata call still yields the historical `title = seriesId` fallback, and
  // caching that would pin a placeholder title for the whole 30-day TTL.
  let metaSource = 'fallback';
  let meta = cachedMeta ? normalizeFredSeriesMeta(cachedMeta) : null;
  if (meta) {
    metaSource = 'cache';
  } else if (metaResp?.status === 'fulfilled') {
    meta = normalizeFredSeriesMeta(metaResp.value.seriess?.[0]);
    if (meta) metaSource = 'fetched';
  }

  return {
    seriesId,
    title: meta?.title || seriesId,
    units: meta?.units || '',
    frequency: meta?.frequency || '',
    observations,
    metaSource,
  };
}

export function isUsableFredSeries(series) {
  return Array.isArray(series?.observations) && series.observations.length > 0;
}

// Fetch all FRED series with bounded concurrency. A fulfilled HTTP response
// with zero usable observations is not a published series: excluding it here
// keeps component keys and the batch recordCount aligned with real data.
export async function fetchFredSeries({
  fredFetchFn = fredFetchJson,
  concurrency = FRED_CONCURRENCY,
  proxyAuth = resolveProxyForConnect(),
  readMetaCache = readFredSeriesMetaCache,
  writeMetaCache = writeFredSeriesMetaCache,
} = {}) {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) throw new Error('Missing FRED_API_KEY');

  const cachedMeta = await readMetaCache();

  const settled = await allSettledWithConcurrency(
    FRED_SEED_SERIES,
    concurrency,
    (seriesId) => fetchOneFredSeries(seriesId, apiKey, fredFetchFn, proxyAuth, cachedMeta[seriesId]),
  );

  const results = {};
  /** @type {Record<string, { title: string; units: string; frequency: string }>} */
  const freshMeta = {};
  settled.forEach((s, i) => {
    const seriesId = FRED_SEED_SERIES[i];
    // Metadata is worth caching whenever FRED described the series, even if the
    // observations were unusable — the description is what the next run wants to skip.
    if (s.status === 'fulfilled' && s.value?.metaSource === 'fetched') {
      freshMeta[seriesId] = { title: s.value.title, units: s.value.units, frequency: s.value.frequency };
    }
    if (s.status === 'fulfilled' && isUsableFredSeries(s.value)) {
      const { metaSource, ...series } = s.value;
      results[seriesId] = series;
    } else if (s.status === 'fulfilled') console.warn(`  FRED ${seriesId}: no usable observations`);
    else console.warn(`  FRED ${seriesId}: ${s.reason?.message || s.reason}`);
  });

  if (Object.keys(freshMeta).length > 0) {
    await writeMetaCache({ ...cachedMeta, ...freshMeta });
  }

  const fredCount = Object.keys(results).length;
  // Count what the cache actually served, not "everything that wasn't fetched" — a
  // series whose whole request rejected never consulted the cache, and folding it in
  // would report a hit rate that rises when the seeder is failing.
  const metaHits = FRED_SEED_SERIES.filter((seriesId) => cachedMeta[seriesId]).length;
  console.log(`  FRED series: ${fredCount}/${FRED_SEED_SERIES.length} (series-meta cache: ${metaHits}/${FRED_SEED_SERIES.length} hits)`);
  if (fredCount === 0) console.warn('  [WARN] FRED series: 0 fetched — all series failed or returned no observations. Check FRED_API_KEY and PROXY_URL. FRED-dependent panels will go stale.');
  return results;
}
