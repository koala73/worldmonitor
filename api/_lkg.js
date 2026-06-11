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
 * Talks to the Blob REST API with raw `fetch` instead of the @vercel/blob
 * SDK: the SDK (v2) depends on undici → Node built-ins, which the Edge
 * runtime can't bundle (it broke the build for every edge function importing
 * this file). The wire protocol below mirrors SDK v2.4.0 exactly:
 *   PUT  {API}/?pathname=<path>   headers: x-api-version:12, x-vercel-blob-
 *        access, x-content-type, x-add-random-suffix, x-allow-overwrite,
 *        x-cache-control-max-age — body = raw bytes → JSON { url, ... }
 *   GET  {API}/?url=<pathname>    same auth → JSON metadata { url,
 *        uploadedAt, ... }, 404 when the blob doesn't exist
 *
 * Envelope: gzip of `{ storedAt, payload }` at a fixed pathname per endpoint
 * (`lkg/<name>.json.gz`, overwritten in place, 60 s blob-CDN cache).
 *
 * Failure policy: never throws — a broken LKG layer must not break the live
 * path. No BLOB_READ_WRITE_TOKEN in the env → every call is a silent no-op
 * (mirrors _slack.js), so this deploys safely before the Blob store exists.
 *
 * Write throttling is two-layer: per-isolate memory (zero-cost early exit)
 * plus a metadata check against the blob's own uploadedAt, so MANY isolates
 * collectively still write at most ~once per THROTTLE window. Data behind
 * these endpoints only changes every 15 min (cron cadence), so a 10-min
 * throttle loses nothing.
 */

const BLOB_API = 'https://vercel.com/api/blob';
const BLOB_API_VERSION = '12';

const PUT_THROTTLE_MS = 10 * 60_000;
const DEFAULT_MAX_AGE_MS = 48 * 3_600_000; // older than this → honest 503 beats silently stale

const lastPutAt = new Map();

function token() {
  return process.env.BLOB_READ_WRITE_TOKEN || null;
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

/** GET blob metadata. Returns { url, uploadedAt, ... } | null (missing) —
 *  throws only on operational failure (non-2xx other than 404, network). */
async function headBlob(pathname, tok) {
  const resp = await fetch(`${BLOB_API}/?url=${encodeURIComponent(pathname)}`, {
    headers: { authorization: `Bearer ${tok}`, 'x-api-version': BLOB_API_VERSION },
    signal: AbortSignal.timeout(5_000),
  });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`blob head HTTP ${resp.status}`);
  return await resp.json();
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
  const tok = token();
  if (!tok) return false;
  const now = Date.now();
  if (now - (lastPutAt.get(name) ?? 0) < PUT_THROTTLE_MS) return false;
  lastPutAt.set(name, now); // claim the window before the slow part (no concurrent dupes)
  try {
    // Cross-isolate throttle: skip when another isolate refreshed it recently.
    const meta = await headBlob(pathFor(name), tok);
    if (meta?.uploadedAt && now - new Date(meta.uploadedAt).getTime() < PUT_THROTTLE_MS) {
      return false;
    }

    const gz = await gzipBytes(JSON.stringify({ storedAt: now, payload }));
    const params = new URLSearchParams({ pathname: pathFor(name) });
    const resp = await fetch(`${BLOB_API}/?${params.toString()}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${tok}`,
        'x-api-version': BLOB_API_VERSION,
        'x-vercel-blob-access': 'public',
        'x-content-type': 'application/gzip',
        'x-add-random-suffix': '0',
        'x-allow-overwrite': '1',
        'x-cache-control-max-age': '60', // blob CDN refreshes within a minute of an overwrite
      },
      body: gz,
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`blob put HTTP ${resp.status}: ${body.slice(0, 120)}`);
    }
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
  const tok = token();
  if (!tok) return null;
  try {
    const meta = await headBlob(pathFor(name), tok);
    if (!meta?.url) return null;
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
    console.warn(`[lkg] get failed for ${name}:`, errMsg(err));
    return null;
  }
}
