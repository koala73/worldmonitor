// Reads are user-facing — a fast timeout means we fall back to the upstream
// fetcher quickly when Redis is laggy. 1.5 s is well past Upstash's ~150 ms
// p99 in normal operation, so it only kicks in when something is wrong.
const REDIS_OP_TIMEOUT_MS = 1_500;

// Writes are inside `cachedFetchJson`'s critical path — the caller awaits
// them before returning the just-fetched payload to the user. A failed SET
// here is recoverable (next request just refetches from upstream), but the
// cost is a duplicate upstream call AND the wasted 1.5 s the caller spent
// waiting. 3 s gives enough headroom that transient Upstash latency
// (cold-start spike, parallel SET burst — e.g. live-sports doing 14
// SETs at once after a cache miss) doesn't trigger noisy timeouts.
const REDIS_SET_TIMEOUT_MS = 3_000;

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

// ── Value compression ─────────────────────────────────────────────────────
//
// Big JSON payloads (live-news digests, conflict-archive blobs, bootstrap
// keys) dominate Upstash bandwidth. Each Redis GET pulls the full value
// over the wire, so a 1 MB digest costs 1 MB of bandwidth per read — and
// we read these every 30 s under polling load.
//
// We gzip-encode large values before writing and detect-and-decompress on
// read. Typical JSON compresses ~4–6×; after base64 encoding (Upstash REST
// stores strings, so binary needs base64) the net wire reduction is ~3–4×.
//
// Storage shape (envelope) — a JSON object with a sentinel key:
//   { "__wmgz": 1, "d": "<base64-gzip>" }
//
// Why an envelope rather than a string prefix: lets us cleanly distinguish
// from a user value that happens to start with the prefix string, and
// makes the format self-describing if we ever add other compression
// algorithms.
//
// Reads are ALWAYS compression-aware. Writes are gated by the
// WM_REDIS_COMPRESSION env var so we can stage the rollout: deploy first
// (no behavior change), flip the flag once code is everywhere, observe.
// Rollback = unset the flag; existing compressed values keep working
// because the reader handles both formats indefinitely.

const COMPRESSION_THRESHOLD_BYTES = 1024;
const COMPRESSION_ENVELOPE_KEY = '__wmgz';

function isCompressionEnabled(): boolean {
  return process.env.WM_REDIS_COMPRESSION === '1';
}

function isCompressedEnvelope(v: unknown): v is { __wmgz: number; d: string } {
  return (
    typeof v === 'object' && v !== null
    && COMPRESSION_ENVELOPE_KEY in v
    && typeof (v as { d?: unknown }).d === 'string'
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK)),
    );
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function gzipString(input: string): Promise<Uint8Array> {
  const stream = new Response(input).body!.pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipToString(input: Uint8Array): Promise<string> {
  const stream = new Response(new Blob([input as BlobPart])).body!.pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}

/**
 * Encode a value for storage. Returns the JSON-encoded body to send to Upstash.
 * Compresses iff WM_REDIS_COMPRESSION=1 AND the serialized value exceeds the
 * threshold — small values gain nothing from gzip after base64 overhead.
 */
async function encodeForStorage(value: unknown): Promise<string> {
  const json = JSON.stringify(value);
  if (!isCompressionEnabled() || json.length < COMPRESSION_THRESHOLD_BYTES) {
    return json;
  }
  try {
    const gz = await gzipString(json);
    const b64 = bytesToBase64(gz);
    return JSON.stringify({ [COMPRESSION_ENVELOPE_KEY]: 1, d: b64 });
  } catch (err) {
    // Compression failed — fall back to raw JSON. Don't drop the write.
    console.warn('[redis] gzip encode failed, storing raw:', errMsg(err));
    return json;
  }
}

/**
 * Decode a value read from Upstash. Handles three shapes:
 *   1. Already-parsed object/array (Upstash dual-shape) — passed through,
 *      unless it's a compressed envelope.
 *   2. JSON string of an envelope — decompressed.
 *   3. Plain JSON string — parsed as today.
 *
 * Returns null on failure (matches existing behavior — caller treats null
 * as a cache miss and refetches).
 */
async function decodeFromStorage(raw: string | object): Promise<unknown | null> {
  let parsed: unknown;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  } else {
    parsed = raw;
  }
  if (isCompressedEnvelope(parsed)) {
    try {
      const bytes = base64ToBytes(parsed.d);
      const inner = await gunzipToString(bytes);
      return JSON.parse(inner);
    } catch (err) {
      console.warn('[redis] gzip decode failed:', errMsg(err));
      return null;
    }
  }
  return parsed;
}

/**
 * @param timeoutMs  Abort budget for the GET. Defaults to the
 *   user-facing `REDIS_OP_TIMEOUT_MS` (1.5 s). Cron callers reading
 *   large values (e.g. the v6 digest, a multi-MB compressed blob)
 *   should pass a higher value — there's no user waiting, and a timed-
 *   out digest read forces a destructive rebuild-from-scratch.
 */
export async function getCachedJson(
  key: string,
  raw = false,
  timeoutMs: number = REDIS_OP_TIMEOUT_MS,
  /**
   * When true, an operational failure (timeout / network / non-2xx /
   * decode error) THROWS instead of returning `null`. A genuine key-miss
   * still returns `null`. Lets a caller tell "the read failed" apart from
   * "the key is empty" — critical when an empty result would otherwise
   * trigger a destructive rebuild-from-scratch.
   */
  strict = false,
): Promise<unknown | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    if (strict) throw new Error('[redis] missing UPSTASH_REDIS_REST_URL/TOKEN');
    return null;
  }
  try {
    const finalKey = raw ? key : prefixKey(key);
    const resp = await fetch(`${url}/get/${encodeURIComponent(finalKey)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.warn(`[redis] getCachedJson HTTP ${resp.status} for "${finalKey}":`, body.slice(0, 200));
      if (strict) throw new Error(`[redis] getCachedJson HTTP ${resp.status} for "${finalKey}"`);
      return null;
    }
    // Dual-shape handling: Upstash sometimes returns the value as a string
    // (needs JSON.parse), sometimes as an already-parsed object (when the
    // value was stored via body-based POST and Upstash inferred its content
    // type). `decodeFromStorage` handles both, plus the compressed-envelope
    // case introduced for bandwidth reduction.
    const data = (await resp.json()) as { result?: string | object | null };
    if (data.result === undefined || data.result === null) return null;
    return await decodeFromStorage(data.result);
  } catch (err) {
    console.warn('[redis] getCachedJson failed:', errMsg(err));
    if (strict) throw err instanceof Error ? err : new Error(String(err));
    return null;
  }
}

/**
 * @param timeoutMs  Abort budget for the SET. Defaults to
 *   `REDIS_SET_TIMEOUT_MS` (3 s). Cron callers writing large values
 *   (e.g. the v6 digest, a multi-MB blob) should pass a higher value.
 * @returns `true` on a confirmed 2xx write, `false` on any failure
 *   (timeout / network / non-2xx) — lets callers retry.
 */
export async function setCachedJson(
  key: string,
  value: unknown,
  ttlSeconds: number,
  timeoutMs: number = REDIS_SET_TIMEOUT_MS,
): Promise<boolean> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return false;

  // Send the value in the POST body rather than URL-encoded into the path.
  //
  // Why: Upstash's path-based SET (`/set/{key}/{value}/EX/{seconds}`) silently
  // fails when the URL grows long enough — typical for any payload above a
  // few hundred chars (e.g. LLM-generated paragraph summaries). The fetch
  // resolves with a 4xx status, which our previous try/catch *did not
  // catch* because `fetch` only throws on network errors. Result: callers
  // saw "write succeeded" but nothing was in Redis. Body-based SET handles
  // arbitrarily large values cleanly.
  //
  // We also explicitly check `resp.ok` and surface non-2xx via console.warn
  // so the next time something like this fails, it's obvious in Vercel logs.
  const finalKey = prefixKey(key);
  try {
    const body = await encodeForStorage(value);
    const resp = await fetch(`${url}/set/${encodeURIComponent(finalKey)}?EX=${ttlSeconds}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) {
      const respBody = await resp.text().catch(() => '');
      console.warn(`[redis] setCachedJson HTTP ${resp.status} for "${finalKey}" (body ~${body.length} chars):`, respBody.slice(0, 200));
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[redis] setCachedJson failed:', errMsg(err));
    return false;
  }
}

const NEG_SENTINEL = '__WM_NEG__';
const SEED_META_TTL = 604800; // 7 days

/** Estimate record count from an RPC response object for seed-meta tracking. */
function estimateRecordCount(obj: unknown): number {
  if (!obj || typeof obj !== 'object') return 0;
  if (Array.isArray(obj)) return obj.length;
  // Check common array fields in RPC responses
  for (const v of Object.values(obj as Record<string, unknown>)) {
    if (Array.isArray(v)) return v.length;
  }
  return Object.keys(obj as Record<string, unknown>).length;
}

/** Write seed-meta for a cache key (fire-and-forget, throttled to once per 5 min per key). */
const seedMetaLastWrite = new Map<string, number>();
const SEED_META_THROTTLE_MS = 300_000; // 5 minutes

function writeSeedMeta(cacheKey: string, recordCount: number): void {
  const now = Date.now();
  const last = seedMetaLastWrite.get(cacheKey) ?? 0;
  if (now - last < SEED_META_THROTTLE_MS) return;
  seedMetaLastWrite.set(cacheKey, now);

  const metaKey = `seed-meta:${cacheKey.replace(/[-:]v\d+$/, '')}`;
  setCachedJson(metaKey, { fetchedAt: now, recordCount }, SEED_META_TTL)
    .catch((err: unknown) => console.warn(`[redis] seed-meta write failed for "${metaKey}":`, errMsg(err)));
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
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(pipeline),
      signal: AbortSignal.timeout(REDIS_PIPELINE_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.warn(`[redis] getCachedJsonBatch HTTP ${resp.status} for ${keys.length} keys:`, body.slice(0, 200));
      return result;
    }

    const data = (await resp.json()) as Array<{ result?: string | object | null }>;

    // Decode each result in parallel. `decodeFromStorage` handles both the
    // dual-shape Upstash response and the compressed-envelope format, and
    // returns null on parse/decompress failure.
    const decoded = await Promise.all(
      data.map((entry) => {
        const raw = entry?.result;
        if (raw === undefined || raw === null) return Promise.resolve(null);
        return decodeFromStorage(raw);
      }),
    );

    let parsedOk = 0;
    let parsedFail = 0;
    for (let i = 0; i < keys.length; i++) {
      const raw = data[i]?.result;
      if (raw === undefined || raw === null) continue;
      const parsed = decoded[i];
      if (parsed === null) {
        parsedFail++;
        if (parsedFail <= 2) {
          const sample = typeof raw === 'string' ? raw.slice(0, 120) : JSON.stringify(raw).slice(0, 120);
          console.warn(`[redis] getCachedJsonBatch decode failed for "${keys[i]}":`, sample);
        }
        continue;
      }
      if (parsed !== NEG_SENTINEL) {
        result.set(keys[i]!, parsed);
        parsedOk++;
      }
    }
    if (parsedFail > 0) {
      console.warn(`[redis] getCachedJsonBatch: ${parsedOk} parsed, ${parsedFail} malformed of ${keys.length} keys`);
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
  if (cached !== null) {
    writeSeedMeta(key, estimateRecordCount(cached));
    return cached as T;
  }

  const existing = inflight.get(key);
  if (existing) return existing as Promise<T | null>;

  const promise = fetcher()
    .then(async (result) => {
      if (result != null) {
        await setCachedJson(key, result, ttlSeconds);
        writeSeedMeta(key, estimateRecordCount(result));
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
  if (cached !== null) {
    writeSeedMeta(key, estimateRecordCount(cached));
    return { data: cached as T, source: 'cache' };
  }

  const existing = inflight.get(key);
  if (existing) {
    const data = (await existing) as T | null;
    return { data, source: 'fresh' };
  }

  const promise = fetcher()
    .then(async (result) => {
      if (result != null) {
        await setCachedJson(key, result, ttlSeconds);
        writeSeedMeta(key, estimateRecordCount(result));
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
