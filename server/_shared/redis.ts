const REDIS_OP_TIMEOUT_MS = 1_500;
const REDIS_PIPELINE_TIMEOUT_MS = 5_000;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Environment-based key prefix to avoid collisions when multiple deployments
 * share the same Upstash Redis instance (M-6 fix).
 */
function getKeyPrefix(): string {
  const env = process.env.VERCEL_ENV; // 'production' | 'preview' | 'development'
  if (!env || env === 'production') return '';
  const sha = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) || 'dev';
  return `${env}:${sha}:`;
}

let cachedPrefix: string | undefined;
function prefixKey(key: string): string {
  if (cachedPrefix === undefined) cachedPrefix = getKeyPrefix();
  if (!cachedPrefix) return key;
  return `${cachedPrefix}${key}`;
}

/**
 * Like getCachedJson but throws on Redis/network failures instead of returning null.
 * Always uses the raw (unprefixed) key — callers that write via seed scripts (which bypass
 * the prefix system) must use this to read the same key they wrote.
 */
export async function getRawJson(key: string): Promise<unknown | null> {
  if (process.env.LOCAL_API_MODE === 'tauri-sidecar') {
    const { sidecarCacheGet } = await import('./sidecar-cache');
    return sidecarCacheGet(key);
  }
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis credentials not configured');
  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REDIS_OP_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`Redis HTTP ${resp.status}`);
  const data = (await resp.json()) as { result?: string };
  return data.result ? JSON.parse(data.result) : null;
}

export async function getCachedJson(key: string, raw = false): Promise<unknown | null> {
  if (process.env.LOCAL_API_MODE === 'tauri-sidecar') {
    const { sidecarCacheGet } = await import('./sidecar-cache');
    return sidecarCacheGet(key);
  }

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const finalKey = raw ? key : prefixKey(key);
    const resp = await fetch(`${url}/get/${encodeURIComponent(finalKey)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REDIS_OP_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { result?: string };
    return data.result ? JSON.parse(data.result) : null;
  } catch (err) {
    console.warn('[redis] getCachedJson failed:', errMsg(err));
    return null;
  }
}

export async function setCachedJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (process.env.LOCAL_API_MODE === 'tauri-sidecar') {
    const { sidecarCacheSet } = await import('./sidecar-cache');
    sidecarCacheSet(key, value, ttlSeconds);
    return;
  }

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;
  try {
    // Atomic SET with EX — single call avoids race between SET and EXPIRE (C-3 fix)
    await fetch(`${url}/set/${encodeURIComponent(prefixKey(key))}/${encodeURIComponent(JSON.stringify(value))}/EX/${ttlSeconds}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REDIS_OP_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn('[redis] setCachedJson failed:', errMsg(err));
  }
}

const NEG_SENTINEL = '__WM_NEG__';

/**
 * Batch GET using Upstash pipeline API — single HTTP round-trip for N keys.
 * Returns a Map of key → parsed JSON value (missing/failed/sentinel keys omitted).
 */
export async function getCachedJsonBatch(keys: string[]): Promise<Map<string, unknown>> {
  const result = new Map<string, unknown>();
  if (keys.length === 0) return result;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return result;

  try {
    const pipeline = keys.map((k) => ['GET', prefixKey(k)]);
    const resp = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(pipeline),
      signal: AbortSignal.timeout(REDIS_PIPELINE_TIMEOUT_MS),
    });
    if (!resp.ok) return result;

    const data = (await resp.json()) as Array<{ result?: string }>;
    for (let i = 0; i < keys.length; i++) {
      const raw = data[i]?.result;
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed !== NEG_SENTINEL) result.set(keys[i]!, parsed);
        } catch { /* skip malformed */ }
      }
    }
  } catch (err) {
    console.warn('[redis] getCachedJsonBatch failed:', errMsg(err));
  }
  return result;
}

/**
 * In-flight request coalescing map.
 * When multiple concurrent requests hit the same cache key during a miss,
 * only the first triggers the upstream fetch — others await the same promise.
 * This eliminates duplicate upstream API calls within a single Edge Function invocation.
 */
const inflight = new Map<string, Promise<unknown>>();

/**
 * Check cache, then fetch with coalescing on miss.
 * Concurrent callers for the same key share a single upstream fetch + Redis write.
 * When fetcher returns null, a sentinel is cached for negativeTtlSeconds to prevent request storms.
 */
export async function cachedFetchJson<T extends object>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T | null>,
  negativeTtlSeconds = 120,
): Promise<T | null> {
  const cached = await getCachedJson(key);
  if (cached === NEG_SENTINEL) return null;
  if (cached !== null) return cached as T;

  const existing = inflight.get(key);
  if (existing) return existing as Promise<T | null>;

  const promise = fetcher()
    .then(async (result) => {
      if (result != null) {
        await setCachedJson(key, result, ttlSeconds);
      } else {
        await setCachedJson(key, NEG_SENTINEL, negativeTtlSeconds);
      }
      return result;
    })
    .catch((err: unknown) => {
      console.warn(`[redis] cachedFetchJson fetcher failed for "${key}":`, errMsg(err));
      throw err;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, promise);
  return promise;
}

/**
 * Like cachedFetchJson but reports the data source.
 * Use when callers need to distinguish cache hits from fresh fetches
 * (e.g. to set provider/cached metadata on responses).
 *
 * Returns { data, source } where source is:
 *   'cache'  — served from Redis
 *   'fresh'  — fetcher ran (leader) or joined an in-flight fetch (follower)
 */
export async function cachedFetchJsonWithMeta<T extends object>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T | null>,
  negativeTtlSeconds = 120,
): Promise<{ data: T | null; source: 'cache' | 'fresh' }> {
  const cached = await getCachedJson(key);
  if (cached === NEG_SENTINEL) return { data: null, source: 'cache' };
  if (cached !== null) return { data: cached as T, source: 'cache' };

  const existing = inflight.get(key);
  if (existing) {
    const data = (await existing) as T | null;
    return { data, source: 'fresh' };
  }

  const promise = fetcher()
    .then(async (result) => {
      if (result != null) {
        await setCachedJson(key, result, ttlSeconds);
      } else {
        await setCachedJson(key, NEG_SENTINEL, negativeTtlSeconds);
      }
      return result;
    })
    .catch((err: unknown) => {
      console.warn(`[redis] cachedFetchJsonWithMeta fetcher failed for "${key}":`, errMsg(err));
      throw err;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, promise);
  const data = await promise;
  return { data, source: 'fresh' };
}

export async function geoSearchByBox(
  key: string, lon: number, lat: number,
  widthKm: number, heightKm: number, count: number, raw = false,
): Promise<string[]> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return [];
  try {
    const finalKey = raw ? key : prefixKey(key);
    const pipeline = [
      ['GEOSEARCH', finalKey, 'FROMLONLAT', String(lon), String(lat),
       'BYBOX', String(widthKm), String(heightKm), 'km', 'ASC', 'COUNT', String(count)],
    ];
    const resp = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(pipeline),
      signal: AbortSignal.timeout(REDIS_PIPELINE_TIMEOUT_MS),
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as Array<{ result?: string[] }>;
    return data[0]?.result ?? [];
  } catch (err) {
    console.warn('[redis] geoSearchByBox failed:', errMsg(err));
    return [];
  }
}

export async function getHashFieldsBatch(
  key: string, fields: string[], raw = false,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (fields.length === 0) return result;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return result;
  try {
    const finalKey = raw ? key : prefixKey(key);
    const pipeline = [['HMGET', finalKey, ...fields]];
    const resp = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(pipeline),
      signal: AbortSignal.timeout(REDIS_PIPELINE_TIMEOUT_MS),
    });
    if (!resp.ok) return result;
    const data = (await resp.json()) as Array<{ result?: (string | null)[] }>;
    const values = data[0]?.result;
    if (values) {
      for (let i = 0; i < fields.length; i++) {
        if (values[i]) result.set(fields[i]!, values[i]!);
      }
    }
  } catch (err) {
    console.warn('[redis] getHashFieldsBatch failed:', errMsg(err));
  }
  return result;
}

export async function runRedisPipeline(
  commands: Array<Array<string | number>>,
  raw = false,
): Promise<Array<{ result?: unknown }>> {
  if (commands.length === 0) return [];

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return [];

  const pipeline = commands.map((command) => {
    const [verb, ...rest] = command;
    if (raw || rest.length === 0 || typeof rest[0] !== 'string') {
      return command.map((part) => String(part));
    }
    return [String(verb), prefixKey(rest[0]), ...rest.slice(1).map((part) => String(part))];
  });

  try {
    const resp = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(pipeline),
      signal: AbortSignal.timeout(REDIS_PIPELINE_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn(`[redis] runRedisPipeline HTTP ${resp.status}`);
      return [];
    }
    return await resp.json() as Array<{ result?: unknown }>;
  } catch (err) {
    console.warn('[redis] runRedisPipeline failed:', errMsg(err));
    return [];
  }
}
