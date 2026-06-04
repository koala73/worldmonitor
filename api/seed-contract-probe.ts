/**
 * Seed-contract compliance probe.
 *
 * Validates that the envelope dual-write migration (PR #3097) is working
 * end-to-end in production. Returns HTTP 200 + `{ ok: true }` when every
 * sampled key satisfies its contract (envelope-wrapped where expected, bare
 * where seed-meta:* is required) and no public-boundary response leaks `_seed`.
 *
 * Usage:
 *   curl -H "x-probe-secret: $RELAY_SHARED_SECRET" \
 *        https://api.worldmonitor.app/api/seed-contract-probe
 *
 * On failure returns 503 + the failing `checks`/`boundary` entries so CI or
 * operators can pinpoint the regression. Replaces the curl/jq shell ritual.
 *
 * Expected lifecycle:
 *   PR #3097 merge  → probe returns green once seeders cycle (24–48h bake)
 *   PR 3 merge      → probe gets stricter mode asserting seed-meta:* keys gone
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders } from './_cors.js';
// @ts-expect-error — JS module, no declaration file
import { jsonResponse } from './_json-response.js';
// @ts-expect-error — JS module, no declaration file
import { issueSessionToken } from './_session.js';
import { timingSafeEqual } from '../server/_shared/internal-auth';

type ProbeShape = 'envelope' | 'bare';

export interface ProbeSpec {
  key: string;
  shape: ProbeShape;
  /** Fields that must be present on `.data` (envelope) or the root (bare). */
  dataHas?: string[];
  /** Floor for `_seed.recordCount` (envelope only). */
  minRecords?: number;
}

export interface ProbeResult {
  key: string;
  shape: ProbeShape;
  pass: boolean;
  reason?: string;
  state?: string;
  records?: number;
  ageMs?: number;
  /** Set when the first attempt failed but the retry passed (transient blip). */
  recovered?: boolean;
}

export interface BoundaryResult {
  endpoint: string;
  pass: boolean;
  status?: number;
  reason?: string;
  /** Set when the first attempt failed but the retry passed (transient blip). */
  recovered?: boolean;
}

/**
 * A transient infra blip — an Upstash read timing out under its 3s budget, a
 * Vercel cold-start on a boundary endpoint, or the sub-second window while a
 * seeder rewrites a probed key — would otherwise flip this AND-of-12 health
 * check to 503 on a single unlucky poll, surfacing as recurring ~3-minute
 * "incidents" in uptime monitors even though no contract regressed.
 *
 * Retry each FAILING check exactly once: a real regression fails both attempts
 * and still 503s; a transient passes the retry and stays green. Passing checks
 * never retry, so the happy (all-green) path keeps its single-round-trip cost.
 * `recovered` flags a check that only passed on the second attempt so operators
 * can still see genuine flakiness in the response body.
 */
const RETRY_DELAY_MS = 500;

export async function withRetry<T extends { pass: boolean; recovered?: boolean }>(
  attempt: () => Promise<T>,
  delayMs: number = RETRY_DELAY_MS,
): Promise<T> {
  const first = await attempt();
  if (first.pass) return first;
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  const second = await attempt();
  if (second.pass) second.recovered = true;
  return second;
}

/**
 * The probe set is intentionally small (~10 keys) to stay under Upstash's
 * per-request latency budget and keep this endpoint cheap enough to call from
 * CI on every deploy. Adding a new key is one line — keep it focused on the
 * diff surface of PR #3097 (seeders migrated, extra-keys, public boundary).
 */
export const DEFAULT_PROBES: ProbeSpec[] = [
  // Canonical keys migrated by runSeed contract mode — must envelope.
  { key: 'economic:fsi-eu:v1',         shape: 'envelope', dataHas: ['latestValue', 'history'] },
  { key: 'climate:zone-normals:v1',    shape: 'envelope', dataHas: ['normals'], minRecords: 13 },
  { key: 'wildfire:fires:v1',          shape: 'envelope', dataHas: ['fireDetections'] },
  { key: 'seismology:earthquakes:v1',  shape: 'envelope', dataHas: ['earthquakes'] },

  // Multi-panel canonical + extras — regression guard for publishTransform
  // shape-mismatch bug that previously skipped all 3 writes (token-panels).
  // Every panel needs minRecords ≥ 1; without the floor, an extra-key
  // declareRecords regressed to 0 would still pass this probe as long as
  // `.tokens` existed on the payload.
  { key: 'market:defi-tokens:v1',      shape: 'envelope', dataHas: ['tokens'], minRecords: 1 },
  { key: 'market:ai-tokens:v1',        shape: 'envelope', dataHas: ['tokens'], minRecords: 1 },
  { key: 'market:other-tokens:v1',     shape: 'envelope', dataHas: ['tokens'], minRecords: 1 },

  // Direct writers (ais-relay.cjs) — regression guard for envelope wrap.
  { key: 'product-catalog:v2',         shape: 'envelope', dataHas: ['tiers'] },

  // Invariant: seed-meta:* keys must NEVER envelope (shouldEnvelopeKey guard).
  { key: 'seed-meta:energy:oil-stocks-analysis', shape: 'bare', dataHas: ['fetchedAt'] },
  { key: 'seed-meta:economic:fsi-eu',            shape: 'bare', dataHas: ['fetchedAt'] },
];

/** Detect envelope shape without unwrapping — mirrors unwrapEnvelope's gate. */
function hasEnvelopeShape(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const seed = (parsed as { _seed?: unknown })._seed;
  return !!seed && typeof seed === 'object' && typeof (seed as { fetchedAt?: unknown }).fetchedAt === 'number';
}

/**
 * Serialise a thrown value for an operator-facing reason string. Strict-mode
 * `catch` binds `err` as `unknown`, so a non-Error throw (`throw "str"`, a
 * rejected plain object) would make `(err as Error).message` resolve to
 * `undefined` at runtime — `String(err)` keeps the message useful.
 */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function checkProbe(spec: ProbeSpec): Promise<ProbeResult> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { key: spec.key, shape: spec.shape, pass: false, reason: 'no-redis-creds' };

  let resp: Response;
  try {
    resp = await fetch(`${url}/get/${encodeURIComponent(spec.key)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3_000),
    });
  } catch (err) {
    return { key: spec.key, shape: spec.shape, pass: false, reason: `fetch:${errMessage(err)}` };
  }
  if (!resp.ok) return { key: spec.key, shape: spec.shape, pass: false, reason: `redis:${resp.status}` };

  let body: { result?: string };
  try {
    body = (await resp.json()) as { result?: string };
  } catch {
    // Upstash returned a non-JSON body (a transient proxy/5xx error page served
    // with a 2xx status). Surface it as a transient fail so withRetry() can
    // recover it, instead of letting the throw bubble up and crash the edge
    // function into an opaque Vercel platform 503.
    return { key: spec.key, shape: spec.shape, pass: false, reason: 'redis-bad-json-body' };
  }
  if (!body.result) return { key: spec.key, shape: spec.shape, pass: false, reason: 'missing' };

  let parsed: unknown;
  try { parsed = JSON.parse(body.result); }
  catch { return { key: spec.key, shape: spec.shape, pass: false, reason: 'malformed-json' }; }

  const isEnvelope = hasEnvelopeShape(parsed);

  if (spec.shape === 'envelope') {
    if (!isEnvelope) return { key: spec.key, shape: spec.shape, pass: false, reason: 'expected-envelope-got-bare' };
    const env = parsed as { _seed: { fetchedAt: number; recordCount: number; state: string }; data: Record<string, unknown> };
    for (const field of spec.dataHas ?? []) {
      if (env.data?.[field] === undefined) {
        return { key: spec.key, shape: spec.shape, pass: false, reason: `missing-field:${field}` };
      }
    }
    if (spec.minRecords != null && env._seed.recordCount < spec.minRecords) {
      return {
        key: spec.key, shape: spec.shape, pass: false,
        reason: `records:${env._seed.recordCount}<${spec.minRecords}`,
      };
    }
    return {
      key: spec.key, shape: spec.shape, pass: true,
      state: env._seed.state, records: env._seed.recordCount,
      ageMs: Date.now() - env._seed.fetchedAt,
    };
  }

  // shape === 'bare' — seed-meta:* invariant path.
  if (isEnvelope) return { key: spec.key, shape: spec.shape, pass: false, reason: 'expected-bare-got-envelope' };
  const bare = parsed as Record<string, unknown>;
  for (const field of spec.dataHas ?? []) {
    if (bare[field] === undefined) {
      return { key: spec.key, shape: spec.shape, pass: false, reason: `missing-field:${field}` };
    }
  }
  return { key: spec.key, shape: spec.shape, pass: true };
}

interface BoundaryCheck {
  endpoint: string;
  /** Optional: require a specific `X-*-Source` header value to prove the
   *  intended code-path served the response (e.g. `'cache'` for product-catalog
   *  so we know the enveloped-read path actually ran, not fallback). */
  requireSourceHeader?: { name: string; value: string };
}

const BOUNDARY_CHECKS: BoundaryCheck[] = [
  { endpoint: '/api/product-catalog', requireSourceHeader: { name: 'x-product-catalog-source', value: 'cache' } },
  { endpoint: '/api/bootstrap' },
];

export async function checkPublicBoundary(
  origin: string,
  retryDelayMs: number = RETRY_DELAY_MS,
): Promise<BoundaryResult[]> {
  // Endpoints behind validateApiKey() (e.g. /api/bootstrap) used to accept the
  // trusted-browser-origin path without a key. PR #3557 closed that bypass: the
  // ONLY no-Pro path now is a wms_-prefixed HMAC-signed session token. Mint one
  // here ourselves — we share the WM_SESSION_SECRET environment with the
  // /api/wm-session endpoint, so an in-process issue is equivalent to round-
  // tripping through it (and avoids the extra network hop).
  // If WM_SESSION_SECRET isn't configured, fall back to the bare request — the
  // boundary check will surface the missing-secret error as a 401 from
  // /api/bootstrap, which is the right operator signal.
  // Mint the token ONCE and share it across both endpoints and any retry, so a
  // recovered transient never pays for an extra signing round.
  let sessionToken: string | null = null;
  try { sessionToken = (await issueSessionToken()).token; } catch { /* no-op */ }

  const headers: Record<string, string> = {
    Origin: 'https://worldmonitor.app',
    'User-Agent': 'WorldMonitor-SeedContractProbe/1.0',
  };
  if (sessionToken) headers['X-WorldMonitor-Key'] = sessionToken;

  return Promise.all(
    BOUNDARY_CHECKS.map((check) =>
      withRetry(() => probeBoundaryOnce(origin, check, headers), retryDelayMs),
    ),
  );
}

async function probeBoundaryOnce(
  origin: string,
  { endpoint, requireSourceHeader }: BoundaryCheck,
  headers: Record<string, string>,
): Promise<BoundaryResult> {
  try {
    const r = await fetch(`${origin}${endpoint}`, {
      signal: AbortSignal.timeout(5_000),
      headers,
    });
    const text = await r.text();
    // Detect any envelope leak in the response body. A substring match on
    // the literal `"_seed":` is sufficient because `_seed` only appears on
    // our envelopes — no third-party API we consume emits that key.
    if (/"_seed"\s*:/.test(text)) {
      return { endpoint, pass: false, status: r.status, reason: 'seed-leak' };
    }
    if (!r.ok) return { endpoint, pass: false, status: r.status, reason: `status:${r.status}` };
    if (requireSourceHeader) {
      // Header names are ASCII case-insensitive per RFC 7230; Response.headers.get()
      // handles that. Comparing values case-insensitively too so a casing drift
      // in the handler doesn't mask a broken cache-hit path.
      const actual = r.headers.get(requireSourceHeader.name);
      if ((actual ?? '').toLowerCase() !== requireSourceHeader.value.toLowerCase()) {
        return {
          endpoint, pass: false, status: r.status,
          reason: `source:${actual ?? 'missing'}!=${requireSourceHeader.value}`,
        };
      }
    }
    return { endpoint, pass: true, status: r.status };
  } catch (err) {
    return { endpoint, pass: false, reason: `fetch:${errMessage(err)}` };
  }
}

export default async function handler(req: Request): Promise<Response> {
  const cors = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  try {
    // Reuse RELAY_SHARED_SECRET — already provisioned for Vercel↔Railway
    // internal auth, same trust boundary (ops/internal-only callers).
    // Constant-time compare via the shared helper avoids the timing oracle
    // a `!==` comparison would leak (see issue #3803 / PR #3823).
    const secret = req.headers.get('x-probe-secret') ?? '';
    const expected = process.env.RELAY_SHARED_SECRET;
    if (!expected) return jsonResponse({ error: 'not-configured' }, 503, cors);
    if (!(await timingSafeEqual(secret, expected))) {
      return jsonResponse({ error: 'unauthorized' }, 401, cors);
    }

    // Each check retries once on failure so a single transient blip (Upstash
    // timeout, cold-start, mid-rewrite key) doesn't flap the probe to 503.
    const [checks, boundary] = await Promise.all([
      Promise.all(DEFAULT_PROBES.map((spec) => withRetry(() => checkProbe(spec)))),
      checkPublicBoundary(new URL(req.url).origin),
    ]);

    const passedKeys = checks.filter(c => c.pass).length;
    const failedKeys = checks.length - passedKeys;
    const passedBoundary = boundary.filter(b => b.pass).length;
    const failedBoundary = boundary.length - passedBoundary;
    const recovered = [...checks, ...boundary].filter(r => r.recovered).length;
    const ok = failedKeys === 0 && failedBoundary === 0;

    return jsonResponse({
      ok,
      summary: {
        probes: { passed: passedKeys, failed: failedKeys, total: checks.length },
        boundary: { passed: passedBoundary, failed: failedBoundary, total: boundary.length },
        recovered,
      },
      checks,
      boundary,
      checkedAt: new Date().toISOString(),
    }, ok ? 200 : 503, cors);
  } catch (err) {
    // A guard slipped somewhere (an unexpected throw from issueSessionToken, a
    // malformed upstream response, etc.). Return a clean, debuggable 503 rather
    // than letting the edge function crash into an opaque Vercel platform 503 —
    // which would read identically to a real seed-contract failure in the
    // uptime monitor and send operators chasing the wrong thing.
    return jsonResponse({ ok: false, error: `probe-exception:${errMessage(err)}` }, 503, cors);
  }
}
