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
}

export interface BoundaryResult {
  endpoint: string;
  pass: boolean;
  status?: number;
  reason?: string;
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
    return { key: spec.key, shape: spec.shape, pass: false, reason: `fetch:${(err as Error).message}` };
  }
  if (!resp.ok) return { key: spec.key, shape: spec.shape, pass: false, reason: `redis:${resp.status}` };

  const body = (await resp.json()) as { result?: string };
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

export async function checkPublicBoundary(origin: string): Promise<BoundaryResult[]> {
  // Endpoints behind validateApiKey() (e.g. /api/bootstrap) used to accept the
  // trusted-browser-origin path without a key. PR #3557 closed that bypass: the
  // ONLY no-Pro path now is a wms_-prefixed HMAC-signed session token. Mint one
  // here ourselves — we share the WM_SESSION_SECRET environment with the
  // /api/wm-session endpoint, so an in-process issue is equivalent to round-
  // tripping through it (and avoids the extra network hop).
  // If WM_SESSION_SECRET isn't configured, fall back to the bare request — the
  // boundary check will surface the missing-secret error as a 401 from
  // /api/bootstrap, which is the right operator signal.
  let sessionToken: string | null = null;
  try { sessionToken = (await issueSessionToken()).token; } catch { /* no-op */ }

  return Promise.all(BOUNDARY_CHECKS.map(async ({ endpoint, requireSourceHeader }): Promise<BoundaryResult> => {
    try {
      const headers: Record<string, string> = {
        Origin: 'https://worldmonitor.app',
        'User-Agent': 'WorldMonitor-SeedContractProbe/1.0',
      };
      if (sessionToken) headers['X-WorldMonitor-Key'] = sessionToken;
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
      return { endpoint, pass: false, reason: `fetch:${(err as Error).message}` };
    }
  }));
}

export default async function handler(req: Request): Promise<Response> {
  const cors = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  // Reuse RELAY_SHARED_SECRET — already provisioned for Vercel↔Railway
  // internal auth, same trust boundary (ops/internal-only callers).
  const secret = req.headers.get('x-probe-secret');
  const expected = process.env.RELAY_SHARED_SECRET;
  if (!expected) return jsonResponse({ error: 'not-configured' }, 503, cors);
  if (secret !== expected) return jsonResponse({ error: 'unauthorized' }, 401, cors);

  const [checks, boundary] = await Promise.all([
    Promise.all(DEFAULT_PROBES.map(checkProbe)),
    checkPublicBoundary(new URL(req.url).origin),
  ]);

  const passedKeys = checks.filter(c => c.pass).length;
  const failedKeys = checks.length - passedKeys;
  const passedBoundary = boundary.filter(b => b.pass).length;
  const failedBoundary = boundary.length - passedBoundary;
  const ok = failedKeys === 0 && failedBoundary === 0;

  return jsonResponse({
    ok,
    summary: {
      probes: { passed: passedKeys, failed: failedKeys, total: checks.length },
      boundary: { passed: passedBoundary, failed: failedBoundary, total: boundary.length },
    },
    checks,
    boundary,
    checkedAt: new Date().toISOString(),
  }, ok ? 200 : 503, cors);
}
