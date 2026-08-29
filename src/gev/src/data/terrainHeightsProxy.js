// Pure server-side mechanics for the Re:Earth terrain-heights proxy.
// Kept free of Vite/Node middleware state so cache reconstruction and retry
// behavior can be exercised by the offline node:test suite.

/** Decimal precision used by the terrain client when serializing lon/lat. */
export const TERRAIN_POINT_PRECISION = 5;

/** Maximum time retries may add after the first upstream attempt settles. */
export const TERRAIN_RETRY_BUDGET_MS = 10_000;

/** One initial attempt plus three bounded retries. */
export const TERRAIN_MAX_ATTEMPTS = 4;

/** @param {number} ms */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse the proxy's `points=lon,lat;...` query parameter.
 * @param {string|null|undefined} raw
 * @returns {Array<[number, number]>|null}
 */
export function parseTerrainPoints(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const pairs = text.split(';').map((part) => part.trim()).filter(Boolean);
  if (pairs.length === 0) return null;
  const points = [];
  for (const pair of pairs) {
    const parts = pair.split(',');
    if (parts.length !== 2) return null;
    const lon = Number(parts[0]);
    const lat = Number(parts[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    points.push([lon, lat]);
  }
  return points;
}

/**
 * Canonical per-point cache key, matching the client's 5dp request format.
 * @param {[number, number]} point lon/lat pair
 */
export function terrainPointKey([lon, lat]) {
  return `${lon.toFixed(TERRAIN_POINT_PRECISION)},${lat.toFixed(TERRAIN_POINT_PRECISION)}`;
}

/** @param {[number, number]} point */
function canonicalTerrainPoint(point) {
  const key = terrainPointKey(point);
  return { key, point: key.split(',').map(Number) };
}

/** Only a real numeric ellipsoid height is cacheable/servable. */
export function validTerrainResult(result) {
  return Boolean(result) && Number.isFinite(result.ellipsoid);
}

/**
 * Convert Retry-After (delta-seconds or HTTP-date) to milliseconds.
 * @param {string|null|undefined} value
 * @param {number} nowMs
 * @returns {number|null}
 */
export function terrainRetryAfterMs(value, nowMs = Date.now()) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(text);
  if (!Number.isFinite(dateMs)) return null;
  return Math.max(0, dateMs - nowMs);
}

/**
 * Fetch one upstream chunk with jittered exponential backoff. Network errors,
 * 429, and 5xx retry; other HTTP failures and malformed successes fail fast.
 * Retry sleeps and retry attempts share a 10s budget after attempt one.
 *
 * Dependencies are injectable for deterministic offline tests.
 * @param {Array<[number, number]>} points
 * @param {object} [options]
 * @returns {Promise<Array<object>>}
 */
export async function fetchTerrainChunkWithRetry(points, {
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  random = Math.random,
  now = Date.now,
  makeSignal = (timeoutMs) => AbortSignal.timeout(timeoutMs),
  attemptTimeoutMs = 30_000,
  retryBudgetMs = TERRAIN_RETRY_BUDGET_MS,
  maxAttempts = TERRAIN_MAX_ATTEMPTS,
} = {}) {
  const pointsParam = points.map(terrainPointKey).join(';');
  const url = `https://terrain.reearth.land/heights.json?points=${encodeURIComponent(pointsParam)}`;
  let retryStartedAt = null;
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let timeoutMs = attemptTimeoutMs;
    if (attempt > 0) {
      const remaining = retryBudgetMs - (now() - retryStartedAt);
      if (remaining <= 0) break;
      timeoutMs = Math.max(1, Math.min(attemptTimeoutMs, remaining));
    }

    try {
      const signal = makeSignal(timeoutMs);
      const res = await fetchImpl(url, signal ? { signal } : {});
      if (!res.ok) {
        const error = new Error(`HTTP ${res.status}`);
        error.retryable = res.status === 429 || res.status >= 500;
        error.retryAfter = res.headers?.get?.('retry-after') ?? null;
        throw error;
      }
      const json = await res.json();
      if (!Array.isArray(json?.results)) {
        const error = new Error('malformed upstream response (no results array)');
        error.retryable = false;
        throw error;
      }
      return json.results;
    } catch (error) {
      lastError = error;
      const retryable = error?.retryable !== false;
      if (!retryable || attempt >= maxAttempts - 1) break;
      if (retryStartedAt == null) retryStartedAt = now();
      const remaining = retryBudgetMs - (now() - retryStartedAt);
      if (remaining <= 0) break;

      const retryAfterMs = terrainRetryAfterMs(error?.retryAfter, now());
      const backoffMs = Math.round(350 * (2 ** attempt) * (0.75 + random() * 0.5));
      const requestedDelay = retryAfterMs ?? backoffMs;
      const delayMs = Math.min(requestedDelay, remaining);
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  throw lastError || new Error('terrain heights upstream retry budget exhausted');
}

/**
 * Resolve a requested point batch against a per-point cache and a missing-only
 * fetcher. Results are reconstructed by canonical key in exact request order,
 * including duplicates. Stale values remain eligible only when refresh fails.
 * If any position has no real height, return 502 with no fabricated result.
 *
 * @param {object} options
 * @param {Array<[number, number]>} options.points
 * @param {Map<string, {at:number, result:object}>} options.cache
 * @param {(points:Array<[number, number]>)=>Promise<Array<object>>} options.fetchMissing
 * @param {number} options.ttlMs
 * @param {()=>number} [options.now]
 */
export async function resolveTerrainHeightRequest({
  points,
  cache,
  fetchMissing,
  ttlMs,
  now = Date.now,
}) {
  const requested = points.map(canonicalTerrainPoint);
  const unique = new Map();
  for (const item of requested) {
    if (!unique.has(item.key)) unique.set(item.key, item.point);
  }

  const requestStartedAt = now();
  const missing = [];
  for (const [key, point] of unique) {
    const entry = cache.get(key);
    if (entry && validTerrainResult(entry.result) && requestStartedAt - entry.at < ttlMs) continue;
    missing.push({ key, point });
  }

  let cacheChanged = false;
  let upstreamError = null;
  if (missing.length > 0) {
    try {
      const fetched = await fetchMissing(missing.map((item) => item.point));
      if (!Array.isArray(fetched)) throw new Error('malformed upstream response (no results array)');
      const fetchedAt = now();
      for (let i = 0; i < missing.length; i += 1) {
        const result = fetched[i];
        if (!validTerrainResult(result)) continue;
        cache.set(missing[i].key, { at: fetchedAt, result });
        cacheChanged = true;
      }
      if (fetched.length !== missing.length || missing.some((_, i) => !validTerrainResult(fetched[i]))) {
        upstreamError = new Error('upstream omitted one or more terrain heights');
      }
    } catch (error) {
      upstreamError = error;
    }
  }

  const results = requested.map(({ key }) => {
    const entry = cache.get(key);
    return entry && validTerrainResult(entry.result) ? entry.result : null;
  });
  if (results.some((result) => result == null)) {
    return {
      status: 502,
      body: { error: 'terrain heights fetch failed and no cache available for every point' },
      cacheChanged,
      upstreamError,
    };
  }
  return {
    status: 200,
    body: { results },
    cacheChanged,
    upstreamError,
  };
}
