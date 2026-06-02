import { unwrapEnvelope } from './seed-envelope';
import { buildUpstreamEvent, getUsageScope, sendToAxiom } from './usage';

// Default Upstash REST timeouts are tuned for production (Vercel ↔ Upstash
// same-datacenter latency is sub-50ms, 1.5s leaves >20× headroom). They
// become a problem only when running scripts that fan out 30+ parallel
// reads against Upstash REST from a workstation — `getCachedJson` then
// silently times out and the caller falls through to score=0 / null,
// which masquerades as missing data. Set REDIS_OP_TIMEOUT_MS=10000 (or
// REDIS_PIPELINE_TIMEOUT_MS=30000) when running e.g.
// scripts/compare-resilience-current-vs-proposed.mjs locally so the
// acceptance-gate output reflects real production behavior, not
// timeout-induced zeros. Production should keep the defaults.
//
// Guard intentionally requires a strictly-positive integer. `|| default`
// alone would reject 0 (good — AbortSignal.timeout(0) would abort instantly)
// but pass through NEGATIVE values, which AbortSignal.timeout rejects with
// a TypeError that escapes unguarded callers (e.g. getRawJson) per the
// WHATWG spec. So fall back to the default for any non-positive / non-numeric
// value rather than letting a typo'd env var poison every Redis read.
export function parseTimeoutEnv(raw: string | undefined, defaultMs: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return parsed > 0 ? parsed : defaultMs;
}
const REDIS_OP_TIMEOUT_MS = parseTimeoutEnv(process.env.REDIS_OP_TIMEOUT_MS, 1_500);
const REDIS_PIPELINE_TIMEOUT_MS = parseTimeoutEnv(process.env.REDIS_PIPELINE_TIMEOUT_MS, 5_000);

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hasRemoteRedisConfig(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
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

// Test-only: invalidate the memoized key prefix so a test that mutates
// process.env.VERCEL_ENV / VERCEL_GIT_COMMIT_SHA sees the new value on the
// next read. No production caller should ever invoke this.
export function __resetKeyPrefixCacheForTests(): void {
  cachedPrefix = undefined;
}

type CacheReadResult = { status: 'hit'; value: unknown } | { status: 'miss' } | { status: 'error'; error: unknown };

async function readCachedJson(key: string, raw = false): Promise<CacheReadResult> {
  if (process.env.LOCAL_API_MODE === 'tauri-sidecar') {
    try {
      const { sidecarCacheGet } = await import('./sidecar-cache');
      const value = sidecarCacheGet(key);
      return value == null ? { status: 'miss' } : { status: 'hit', value };
    } catch (error) {
      return { status: 'error', error };
    }
  }

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { status: 'miss' };
  try {
    const finalKey = raw ? key : prefixKey(key);
    const resp = await fetch(`${url}/get/${encodeURIComponent(finalKey)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REDIS_OP_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`Redis HTTP ${resp.status}`);
    const data = (await resp.json()) as { result?: string };
    if (!data.result) return { status: 'miss' };
    // Envelope-aware by default — RPC consumers get the bare payload regardless
    // of whether the writer has migrated to contract mode. Legacy shapes pass
    // through unchanged (unwrapEnvelope returns {_seed: null, data: raw}).
    return {
      status: 'hit',
      value: unwrapEnvelope(JSON.parse(data.result)).data,
    };
  } catch (error) {
    return { status: 'error', error };
  }
}

function logCacheReadError(key: string, err: unknown): void {
  // Structured timeout log goes to Sentry via Vercel integration. Large-
  // payload timeouts used to silently return null and let downstream callers
  // cache zero-state — see docs/plans/chokepoint-rpc-payload-split.md for
  // the incident that added this tag.
  //
  // AbortSignal.timeout() throws DOMException name='TimeoutError' (on V8
  // runtimes incl. Vercel Edge); manual controller.abort() throws
  // 'AbortError'. Checking only 'AbortError' meant the [REDIS-TIMEOUT] log
  // never fired — every timeout fell through to the generic console.warn.
  const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
  if (isTimeout) {
    console.error(`[REDIS-TIMEOUT] getCachedJson key=${key} timeoutMs=${REDIS_OP_TIMEOUT_MS}`);
  } else {
    console.warn('[redis] getCachedJson failed:', errMsg(err));
  }
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
  if (!data.result) return null;
  // Envelope-aware: contract-mode canonical keys are stored as {_seed, data}.
  // unwrapEnvelope is a no-op on legacy (non-envelope) shapes.
  return unwrapEnvelope(JSON.parse(data.result)).data;
}

/**
 * Read a key's value as a raw Upstash string — no JSON.parse, no envelope unwrap.
 * Use when a seeder stores a bare scalar (e.g., a snapshot_id pointer) via
 * `['SET', key, bareString]` without JSON.stringify. getCachedJson() on these
 * keys silently returns null because JSON.parse throws on unquoted strings,
 * and the try/catch swallows the error.
 *
 * Always uses the raw (unprefixed) key — matches the seed-script write path
 * (seeders don't know about the Vercel env-prefix scheme).
 */
export async function getCachedRawString(key: string): Promise<string | null> {
  if (process.env.LOCAL_API_MODE === 'tauri-sidecar') {
    const { sidecarCacheGet } = await import('./sidecar-cache');
    const v = sidecarCacheGet(key);
    return typeof v === 'string' ? v : null;
  }
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REDIS_OP_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { result?: string | null };
    return typeof data.result === 'string' && data.result.length > 0 ? data.result : null;
  } catch (err) {
    // AbortSignal.timeout() throws DOMException name='TimeoutError' (on V8
    // runtimes incl. Vercel Edge); manual controller.abort() throws 'AbortError'.
    // Match both so the [REDIS-TIMEOUT] structured log actually fires.
    const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    if (isTimeout) console.error(`[REDIS-TIMEOUT] getCachedRawString key=${key} timeoutMs=${REDIS_OP_TIMEOUT_MS}`);
    else console.warn('[redis] getCachedRawString failed:', errMsg(err));
    return null;
  }
}

export async function getCachedJson(key: string, raw = false): Promise<unknown | null> {
  const read = await readCachedJson(key, raw);
  if (read.status === 'hit') return read.value;
  if (read.status === 'error') logCacheReadError(key, read.error);
  return null;
}

export async function setCachedJson(key: string, value: unknown, ttlSeconds: number, raw = false): Promise<boolean> {
  if (process.env.LOCAL_API_MODE === 'tauri-sidecar') {
    const { sidecarCacheSet } = await import('./sidecar-cache');
    sidecarCacheSet(key, value, ttlSeconds);
    return true;
  }

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return false;
  try {
    const finalKey = raw ? key : prefixKey(key);
    // Atomic SET with EX — single call avoids race between SET and EXPIRE (C-3 fix).
    // Body-mode (`POST /` with command array) instead of URL-path encoding because
    // `encodeURIComponent(JSON.stringify(value))` for payloads like `news:digest:v1`
    // (~126KB) blows past Node's default ~16KB URL limit on `http.createServer` —
    // the self-hosted `docker/redis-rest-proxy.mjs` silently drops the request with
    // ECONNRESET/EPIPE and the key never persists. Pipeline timeout (5s) instead of
    // the 1.5s op timeout because large payloads legitimately need the headroom and
    // this matches the body-mode pattern used by `runRedisPipeline` below.
    const resp = await fetch(`${url}/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(['SET', finalKey, JSON.stringify(value), 'EX', String(ttlSeconds)]),
      signal: AbortSignal.timeout(REDIS_PIPELINE_TIMEOUT_MS),
    });
    const data = (await resp.json().catch(() => null)) as {
      result?: string;
      error?: string;
    } | null;
    if (!resp.ok || data?.error) {
      console.warn(`[redis] setCachedJson failed:`, data?.error ?? `HTTP ${resp.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[redis] setCachedJson failed:', errMsg(err));
    return false;
  }
}

const NEG_SENTINEL = '__WM_NEG__';
const FETCH_ERROR_NEGATIVE_TTL_SECONDS = 30;
const REDIS_FAILURE_POSITIVE_TTL_SECONDS = 30;
const LOCAL_FALLBACK_MAX_ENTRIES = 5000;

const localNegativeUntil = new Map<string, number>();
const localPositiveFallback = new Map<string, { value: unknown; expiresAt: number }>();

function evictOldestLocalFallbackEntries<T>(map: Map<string, T>): void {
  while (map.size > LOCAL_FALLBACK_MAX_ENTRIES) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) return;
    map.delete(oldestKey);
  }
}

function effectiveFetchErrorNegativeTtlSeconds(negativeTtlSeconds: number): number {
  return Math.max(1, Math.min(negativeTtlSeconds, FETCH_ERROR_NEGATIVE_TTL_SECONDS));
}

function armLocalNegativeCooldown(key: string, ttlSeconds: number): void {
  localNegativeUntil.set(key, Date.now() + ttlSeconds * 1000);
  evictOldestLocalFallbackEntries(localNegativeUntil);
}

function hasLocalNegativeCooldown(key: string): boolean {
  const expiresAt = localNegativeUntil.get(key);
  if (expiresAt === undefined) return false;
  if (expiresAt > Date.now()) return true;
  localNegativeUntil.delete(key);
  return false;
}

function effectiveRedisFailurePositiveTtlSeconds(ttlSeconds: number): number {
  return Math.max(1, Math.min(ttlSeconds, REDIS_FAILURE_POSITIVE_TTL_SECONDS));
}

// Positive fallback is only a short isolate-local bridge for Redis outages.
// Keep it capped and clamp caller TTLs so stale fresh data never lingers.
function armLocalPositiveFallback(key: string, value: unknown, ttlSeconds: number): void {
  const effectiveTtlSeconds = effectiveRedisFailurePositiveTtlSeconds(ttlSeconds);
  localPositiveFallback.set(key, {
    value,
    expiresAt: Date.now() + effectiveTtlSeconds * 1000,
  });
  evictOldestLocalFallbackEntries(localPositiveFallback);
}

function readLocalPositiveFallback(key: string): unknown | undefined {
  const cached = localPositiveFallback.get(key);
  if (cached === undefined) return undefined;
  if (cached.expiresAt > Date.now()) return cached.value;
  localPositiveFallback.delete(key);
  return undefined;
}

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
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
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
          if (parsed === NEG_SENTINEL) continue;
          // Envelope-aware: unwrap contract-mode canonical keys; legacy values
          // pass through.
          result.set(keys[i]!, unwrapEnvelope(parsed).data);
        } catch {
          /* skip malformed */
        }
      }
    }
  } catch (err) {
    console.warn('[redis] getCachedJsonBatch failed:', errMsg(err));
  }
  return result;
}

export type RedisPipelineCommand = Array<string | number>;

function normalizePipelineCommand(command: RedisPipelineCommand, raw: boolean): RedisPipelineCommand {
  if (raw || command.length < 2) return [...command];
  const [verb, key, ...rest] = command;
  if (typeof verb !== 'string' || typeof key !== 'string') return [...command];
  return [verb, prefixKey(key), ...rest];
}

export async function runRedisPipeline(commands: RedisPipelineCommand[], raw = false): Promise<Array<{ result?: unknown }>> {
  if (process.env.LOCAL_API_MODE === 'tauri-sidecar') return [];
  if (commands.length === 0) return [];

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return [];

  try {
    const response = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands.map((command) => normalizePipelineCommand(command, raw))),
      signal: AbortSignal.timeout(REDIS_PIPELINE_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`[redis] runRedisPipeline HTTP ${response.status}`);
      return [];
    }
    return (await response.json()) as Array<{ result?: unknown }>;
  } catch (err) {
    console.warn('[redis] runRedisPipeline failed:', errMsg(err));
    return [];
  }
}

export async function compareAndDeleteRedisKey(key: string, expectedValue: string, raw = false): Promise<boolean> {
  if (process.env.LOCAL_API_MODE === 'tauri-sidecar') return false;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token || !expectedValue) return false;

  const finalKey = raw ? key : prefixKey(key);
  const script = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
  try {
    const response = await fetch(`${url}/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(['EVAL', script, '1', finalKey, expectedValue]),
      signal: AbortSignal.timeout(REDIS_PIPELINE_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`[redis] compareAndDeleteRedisKey HTTP ${response.status}`);
      return false;
    }
    const data = (await response.json().catch(() => null)) as {
      result?: unknown;
      error?: string;
    } | null;
    if (data?.error) {
      console.warn('[redis] compareAndDeleteRedisKey failed:', data.error);
      return false;
    }
    return data?.result === 1;
  } catch (err) {
    console.warn('[redis] compareAndDeleteRedisKey failed:', errMsg(err));
    return false;
  }
}

/**
 * In-flight request coalescing map.
 * When multiple concurrent requests hit the same cache key during a miss,
 * only the first triggers the upstream fetch — others await the same promise.
 * This eliminates duplicate upstream API calls within a single Edge Function invocation.
 */
const inflight = new Map<string, Promise<unknown>>();

/**
 * Default upper bound on how long a single fetcher may run before its
 * inflight entry is forced to settle (#3539).
 *
 * Without this, a fetcher with no internal timeout (no AbortController, no
 * `fetch` `signal`) that truly never settles persists in the inflight Map
 * for the lifetime of the Vercel isolate — every subsequent caller for that
 * key gets handed the same unresolved promise, permanently poisoning it.
 *
 * 30s comfortably exceeds well-behaved HTTP fetchers (UPSTREAM_TIMEOUT_MS is
 * typically 5–15s), so this only fires on misbehaving callers. Callers whose
 * fetcher legitimately runs longer (LLM reasoning, multi-stage aggregations)
 * MUST pass an explicit `opts.timeoutMs` set above their internal budget,
 * otherwise the cache layer will pre-empt the caller's own timeout/fallback.
 */
const FETCHER_TIMEOUT_MS_DEFAULT = 30_000;
let fetcherTimeoutDefaultMs = FETCHER_TIMEOUT_MS_DEFAULT;

// Test-only: override the DEFAULT inflight timeout so unit tests can exercise
// the timeout branch without sleeping for 30s. Per-call `opts.timeoutMs` still
// wins. No production caller should ever invoke this.
export function __setFetcherTimeoutForTests(ms: number): void {
  fetcherTimeoutDefaultMs = ms;
}
export function __resetFetcherTimeoutForTests(): void {
  fetcherTimeoutDefaultMs = FETCHER_TIMEOUT_MS_DEFAULT;
}

/**
 * Race the fetcher promise against a setTimeout so the inflight slot is
 * guaranteed to settle even if the fetcher hangs forever. The timer is
 * cleared as soon as the fetcher wins so we don't leak handles or keep the
 * isolate awake unnecessarily.
 *
 * Known limitation: this only times out the cache-layer wrapper — the
 * underlying fetcher promise is NOT cancelled. A truly hung upstream
 * fetcher continues running in the background until the isolate recycles
 * (~socket + small heap residue per orphan). Inflight-slot release means
 * subsequent callers re-fetch successfully, so user-facing behavior is
 * correct; only resource-cost is affected. True cancellation would require
 * threading an AbortSignal through the fetcher contract, which is a wider
 * refactor across every cached-fetch call site.
 */
function withFetcherTimeout<T>(promise: Promise<T>, key: string, timeoutMs: number, callerName: 'cachedFetchJson' | 'cachedFetchJsonWithMeta'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${callerName} timeout after ${timeoutMs}ms for "${key}"`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Per-call cache-helper options.
 *
 * - `timeoutMs`: Hard upper bound on the fetcher. Defaults to 30s. Pass a
 *   value above the caller's internal timeout (LLM `timeoutMs`, aggregated
 *   `UPSTREAM_TIMEOUT_MS` sum) so the cache layer doesn't pre-empt the
 *   caller's own bound. The cache safety net should be the LAST resort.
 */
export interface CachedFetchOpts {
  timeoutMs?: number;
}

/**
 * Check cache, then fetch with coalescing on miss.
 * Concurrent callers for the same key share a single upstream fetch + Redis write.
 * When fetcher returns null, a sentinel is cached for negativeTtlSeconds to prevent request storms.
 *
 * The fetcher is force-rejected after `opts.timeoutMs` (default 30s, #3539)
 * so a misbehaving fetcher cannot poison the inflight Map for the isolate
 * lifetime. Callers with legitimately long-running fetchers (LLM, multi-stage
 * upstream aggregation) MUST pass `opts.timeoutMs` above their internal bound.
 */
export async function cachedFetchJson<T extends object>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T | null>,
  negativeTtlSeconds = 120,
  opts?: CachedFetchOpts,
): Promise<T | null> {
  const cached = await readCachedJson(key);
  if (cached.status === 'hit') {
    if (cached.value === NEG_SENTINEL) return null;
    return cached.value as T;
  }
  const localPositive = readLocalPositiveFallback(key);
  if (localPositive !== undefined) return localPositive as T;
  const hadCacheReadError = cached.status === 'error';
  if (cached.status === 'error') {
    logCacheReadError(key, cached.error);
    if (hasLocalNegativeCooldown(key)) return null;
  }

  const existing = inflight.get(key);
  if (existing) return existing as Promise<T | null>;

  const timeoutMs = opts?.timeoutMs ?? fetcherTimeoutDefaultMs;
  const promise = withFetcherTimeout(fetcher(), key, timeoutMs, 'cachedFetchJson')
    .then(async (result) => {
      if (result != null) {
        const wrote = await setCachedJson(key, result, ttlSeconds);
        // Remote Redis write/read failures should not force every caller back
        // upstream while the isolate is still warm. Sidecar/local mode skips
        // this bridge because hasRemoteRedisConfig() is false there.
        if (hadCacheReadError || (!wrote && hasRemoteRedisConfig())) {
          armLocalPositiveFallback(key, result, ttlSeconds);
        }
      } else {
        armLocalNegativeCooldown(key, negativeTtlSeconds);
        await setCachedJson(key, NEG_SENTINEL, negativeTtlSeconds);
      }
      return result;
    })
    .catch(async (err: unknown) => {
      const errorTtlSeconds = effectiveFetchErrorNegativeTtlSeconds(negativeTtlSeconds);
      armLocalNegativeCooldown(key, errorTtlSeconds);
      await setCachedJson(key, NEG_SENTINEL, errorTtlSeconds);
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
 * Per-call usage-telemetry hook for upstream event emission (issue #3381).
 *
 * The only required field is `provider` — its presence is what tells the
 * helper "emit an upstream event for this call." Everything else is filled
 * in by the gateway-set UsageScope (request_id, customer_id, route, tier,
 * ctx) via AsyncLocalStorage. Pass overrides explicitly if you need to.
 *
 * Use this when calling fetchJson / cachedFetchJsonWithMeta from a code
 * path that runs inside a gateway-handled request. For helpers used
 * outside any request (cron, scripts), no scope exists and emission is
 * skipped silently.
 */
export interface UsageHook {
  provider: string;
  operation?: string;
  host?: string;
  // Overrides — leave unset to inherit from gateway-set UsageScope.
  ctx?: { waitUntil: (p: Promise<unknown>) => void };
  requestId?: string;
  customerId?: string | null;
  route?: string;
  tier?: number;
}

/**
 * Like cachedFetchJson but reports the data source.
 * Use when callers need to distinguish cache hits from fresh fetches
 * (e.g. to set provider/cached metadata on responses).
 *
 * Returns { data, source } where source is:
 *   'cache'  — served from Redis
 *   'fresh'  — fetcher ran (leader) or joined an in-flight fetch (follower)
 *
 * If `opts.usage` is supplied, an upstream event is emitted on the fresh
 * path (issue #3381). Pass-through for callers that don't care about
 * telemetry — backwards-compatible.
 */
export async function cachedFetchJsonWithMeta<T extends object>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T | null>,
  negativeTtlSeconds = 120,
  opts?: { usage?: UsageHook; timeoutMs?: number },
): Promise<{ data: T | null; source: 'cache' | 'fresh' }> {
  const cached = await readCachedJson(key);
  if (cached.status === 'hit') {
    if (cached.value === NEG_SENTINEL) return { data: null, source: 'cache' };
    return { data: cached.value as T, source: 'cache' };
  }
  const localPositive = readLocalPositiveFallback(key);
  if (localPositive !== undefined) return { data: localPositive as T, source: 'cache' };
  const hadCacheReadError = cached.status === 'error';
  if (cached.status === 'error') {
    logCacheReadError(key, cached.error);
    if (hasLocalNegativeCooldown(key)) return { data: null, source: 'cache' };
  }

  const existing = inflight.get(key);
  if (existing) {
    const data = (await existing) as T | null;
    return { data, source: 'fresh' };
  }

  const fetchT0 = Date.now();
  let upstreamStatus = 0;
  let cacheStatus: 'miss' | 'neg-sentinel' = 'miss';

  const timeoutMs = opts?.timeoutMs ?? fetcherTimeoutDefaultMs;
  const promise = withFetcherTimeout(fetcher(), key, timeoutMs, 'cachedFetchJsonWithMeta')
    .then(async (result) => {
      // Only count an upstream call as a 200 when it actually returned data.
      // A null result triggers the neg-sentinel branch below — these are
      // empty/failed upstream calls and must NOT show up as `status=200` in
      // dashboards (would poison the cache-hit-ratio recipe and per-provider
      // error rates). Use status=0 for the empty branch; cache_status carries
      // the structural detail.
      if (result != null) {
        upstreamStatus = 200;
        const wrote = await setCachedJson(key, result, ttlSeconds);
        // See cachedFetchJson(): this short in-process bridge is only for
        // remote Redis outages, not local sidecar cache writes.
        if (hadCacheReadError || (!wrote && hasRemoteRedisConfig())) {
          armLocalPositiveFallback(key, result, ttlSeconds);
        }
      } else {
        upstreamStatus = 0;
        cacheStatus = 'neg-sentinel';
        armLocalNegativeCooldown(key, negativeTtlSeconds);
        await setCachedJson(key, NEG_SENTINEL, negativeTtlSeconds);
      }
      return result;
    })
    .catch(async (err: unknown) => {
      upstreamStatus = 0;
      cacheStatus = 'neg-sentinel';
      const errorTtlSeconds = effectiveFetchErrorNegativeTtlSeconds(negativeTtlSeconds);
      armLocalNegativeCooldown(key, errorTtlSeconds);
      await setCachedJson(key, NEG_SENTINEL, errorTtlSeconds);
      console.warn(`[redis] cachedFetchJsonWithMeta fetcher failed for "${key}":`, errMsg(err));
      throw err;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, promise);
  let data: T | null;
  try {
    data = await promise;
  } finally {
    emitUpstreamFromHook(opts?.usage, upstreamStatus, Date.now() - fetchT0, cacheStatus);
  }
  return { data, source: 'fresh' };
}

function emitUpstreamFromHook(usage: UsageHook | undefined, status: number, durationMs: number, cacheStatus: 'miss' | 'fresh' | 'stale-while-revalidate' | 'neg-sentinel'): void {
  // Emit only when caller labels the provider — avoids "unknown" pollution.
  if (!usage?.provider) return;
  // Single waitUntil() registered synchronously here — no nested
  // ctx.waitUntil() inside Axiom delivery. Static import keeps the call
  // synchronous so the runtime registers it during the request phase.
  const scope = getUsageScope();
  const ctx = usage.ctx ?? scope?.ctx;
  if (!ctx) return;
  const event = buildUpstreamEvent({
    requestId: usage.requestId ?? scope?.requestId ?? '',
    customerId: usage.customerId ?? scope?.customerId ?? null,
    route: usage.route ?? scope?.route ?? '',
    tier: usage.tier ?? scope?.tier ?? 0,
    provider: usage.provider,
    operation: usage.operation ?? 'fetch',
    host: usage.host ?? '',
    status,
    durationMs,
    requestBytes: 0,
    responseBytes: 0,
    cacheStatus,
  });
  try {
    ctx.waitUntil(sendToAxiom([event]));
  } catch {
    /* telemetry must never throw */
  }
}

export async function geoSearchByBox(key: string, lon: number, lat: number, widthKm: number, heightKm: number, count: number, raw = false): Promise<string[]> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return [];
  try {
    const finalKey = raw ? key : prefixKey(key);
    const pipeline = [['GEOSEARCH', finalKey, 'FROMLONLAT', String(lon), String(lat), 'BYBOX', String(widthKm), String(heightKm), 'km', 'ASC', 'COUNT', String(count)]];
    const resp = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
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

export async function getHashFieldsBatch(key: string, fields: string[], raw = false): Promise<Map<string, string>> {
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
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
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

/**
 * Deletes a single Redis key via Upstash REST API.
 *
 * @param key - The key to delete
 * @param raw - When true, skips the environment prefix (use for global keys like entitlements)
 */
export async function deleteRedisKey(key: string, raw = false): Promise<void> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;

  try {
    const finalKey = raw ? key : prefixKey(key);
    await fetch(`${url}/del/${encodeURIComponent(finalKey)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REDIS_OP_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn('[redis] deleteRedisKey failed:', errMsg(err));
  }
}
