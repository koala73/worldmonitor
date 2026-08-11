import {
  allSettledWithConcurrency,
  fredFetchJson,
  getRedisCredentials,
  resolveProxyForConnect,
} from './_seed-utils.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';

export const FRED_KEY_PREFIX = 'economic:fred:v1';
export const STRESS_INDEX_KEY = 'economic:stress-index:v1';
export const STRESS_INDEX_TTL = 21600; // 6h
export const FRED_TTL = 93600; // 26h — survive daily cron scheduling drift

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

async function fetchOneFredSeries(seriesId, apiKey, fredFetchFn, proxyAuth) {
  const limit = 120;
  const obsParams = new URLSearchParams({
    series_id: seriesId, api_key: apiKey, file_type: 'json', sort_order: 'desc', limit: String(limit),
  });
  const metaParams = new URLSearchParams({
    series_id: seriesId, api_key: apiKey, file_type: 'json',
  });

  const [obsResp, metaResp] = await Promise.allSettled([
    fredFetchFn(`https://api.stlouisfed.org/fred/series/observations?${obsParams}`, proxyAuth),
    fredFetchFn(`https://api.stlouisfed.org/fred/series?${metaParams}`, proxyAuth),
  ]);

  if (obsResp.status === 'rejected') {
    throw new Error(`fetch failed — ${obsResp.reason?.message || obsResp.reason}`);
  }

  const obsData = obsResp.value;
  const observations = (obsData.observations || [])
    .map((o) => { const v = parseFloat(o.value); return Number.isNaN(v) || o.value === '.' ? null : { date: o.date, value: v }; })
    .filter(Boolean)
    .reverse();

  let title = seriesId, units = '', frequency = '';
  if (metaResp.status === 'fulfilled') {
    const meta = metaResp.value.seriess?.[0];
    if (meta) { title = meta.title || seriesId; units = meta.units || ''; frequency = meta.frequency || ''; }
  }

  return { seriesId, title, units, frequency, observations };
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
} = {}) {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) throw new Error('Missing FRED_API_KEY');

  const settled = await allSettledWithConcurrency(
    FRED_SEED_SERIES,
    concurrency,
    (seriesId) => fetchOneFredSeries(seriesId, apiKey, fredFetchFn, proxyAuth),
  );

  const results = {};
  settled.forEach((s, i) => {
    const seriesId = FRED_SEED_SERIES[i];
    if (s.status === 'fulfilled' && isUsableFredSeries(s.value)) results[seriesId] = s.value;
    else if (s.status === 'fulfilled') console.warn(`  FRED ${seriesId}: no usable observations`);
    else console.warn(`  FRED ${seriesId}: ${s.reason?.message || s.reason}`);
  });

  const fredCount = Object.keys(results).length;
  console.log(`  FRED series: ${fredCount}/${FRED_SEED_SERIES.length}`);
  if (fredCount === 0) console.warn('  [WARN] FRED series: 0 fetched — all series failed or returned no observations. Check FRED_API_KEY and PROXY_URL. FRED-dependent panels will go stale.');
  return results;
}
