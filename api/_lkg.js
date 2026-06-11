/**
 * Last-known-good (LKG) response layer — Vercel Blob.
 *
 * The CDN's stale-if-error only rescues URL variants that happen to be primed
 * in a given PoP — a cold variant (quiet hours, new ?av=, fresh deploy) falls
 * through to whatever origin does. This layer makes ORIGIN itself always able
 * to answer: every healthy response is persisted as a last-known-good copy,
 * and when the live build fails (Redis down, key lost/empty) the handler
 * serves the LKG instead of a 503. The 503 → stale-if-error path remains as
 * the third net when even the LKG is missing or too old.
 *
 * Store: Vercel Blob — deliberately a DIFFERENT failure domain from Upstash
 * (the original incident was Redis-wide, so an LKG inside the same Redis
 * would have died with it). Blob reads are CDN-backed HTTPS GETs, so a full
 * fallback storm costs origin almost nothing.
 *
 * Envelope: gzip of `{ storedAt, payload }` at a fixed pathname per endpoint
 * (`lkg/<name>.json.gz`, overwritten in place, 60 s blob-CDN cache).
 *
 * Failure policy: never throws — a broken LKG layer must not break the live
 * path. No BLOB_READ_WRITE_TOKEN in the env → every call is a silent no-op
 * (mirrors _slack.js), so this deploys safely before the Blob store exists.
 *
 * Write throttling is two-layer: per-isolate memory (zero-cost early exit)
 * plus a `head()` check against the blob's own uploadedAt, so MANY isolates
 * collectively still write at most ~once per THROTTLE window. Data behind
 * these endpoints only changes every 15 min (cron cadence), so a 10-min
 * throttle loses nothing.
 */

import { put, head } from '@vercel/blob';

const PUT_THROTTLE_MS = 10 * 60_000;
const DEFAULT_MAX_AGE_MS = 48 * 3_600_000; // older than this → honest 503 beats silently stale

const lastPutAt = new Map();

function enabled() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

function pathFor(name) {
  return `lkg/${name}.json.gz`;
}

async function gzipBytes(text) {
  const stream = new Response(text).body.pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipText(bytes) {
  const stream = new Response(new Blob([bytes])).body.pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}

function errMsg(err) {
  return err instanceof Error ? err.message : String(err);
}

function isNotFound(err) {
  return err?.name === 'BlobNotFoundError' || /not.?found/i.test(errMsg(err));
}

/**
 * Persist a healthy response as the endpoint's last-known-good. Throttled,
 * never throws. Call it on every populated response — it exits in
 * microseconds outside the write window.
 *
 * @param {string} name     endpoint slug, e.g. 'live-news-v6', 'bootstrap-fast'
 * @param {unknown} payload the exact JSON-serializable value to restore later
 * @returns {Promise<boolean>} true iff a blob write actually happened
 */
export async function maybePutLkg(name, payload) {
  if (!enabled()) return false;
  const now = Date.now();
  if (now - (lastPutAt.get(name) ?? 0) < PUT_THROTTLE_MS) return false;
  lastPutAt.set(name, now); // claim the window before the slow part (no concurrent dupes)
  try {
    // Cross-isolate throttle: skip when another isolate refreshed it recently.
    try {
      const meta = await head(pathFor(name));
      if (meta?.uploadedAt && now - new Date(meta.uploadedAt).getTime() < PUT_THROTTLE_MS) {
        return false;
      }
    } catch (err) {
      if (!isNotFound(err)) throw err; // not-found just means first-ever write
    }

    const gz = await gzipBytes(JSON.stringify({ storedAt: now, payload }));
    await put(pathFor(name), new Blob([gz]), {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/gzip',
      cacheControlMaxAge: 60, // blob CDN refreshes within a minute of an overwrite
    });
    console.log(`[lkg] stored ${name} (${gz.length} bytes gz)`);
    return true;
  } catch (err) {
    console.warn(`[lkg] put failed for ${name}:`, errMsg(err));
    return false;
  }
}

/**
 * Fetch an endpoint's last-known-good. Returns null when the layer is
 * disabled, the blob is missing/corrupt, or it's older than maxAgeMs.
 * Never throws.
 *
 * @param {string} name
 * @param {number} [maxAgeMs]
 * @returns {Promise<{ payload: any, ageMs: number, ageMinutes: number } | null>}
 */
export async function getLkg(name, maxAgeMs = DEFAULT_MAX_AGE_MS) {
  if (!enabled()) return null;
  try {
    const meta = await head(pathFor(name));
    const resp = await fetch(meta.url, {
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
    if (!resp.ok) {
      console.warn(`[lkg] blob fetch HTTP ${resp.status} for ${name}`);
      return null;
    }
    const text = await gunzipText(new Uint8Array(await resp.arrayBuffer()));
    const { storedAt, payload } = JSON.parse(text);
    const ageMs = Date.now() - (typeof storedAt === 'number' ? storedAt : 0);
    if (payload === undefined || payload === null || ageMs > maxAgeMs) {
      console.warn(`[lkg] ${name} unusable (age ${Math.round(ageMs / 60_000)} min, max ${Math.round(maxAgeMs / 60_000)})`);
      return null;
    }
    return { payload, ageMs, ageMinutes: Math.round(ageMs / 60_000) };
  } catch (err) {
    if (!isNotFound(err)) console.warn(`[lkg] get failed for ${name}:`, errMsg(err));
    return null;
  }
}
