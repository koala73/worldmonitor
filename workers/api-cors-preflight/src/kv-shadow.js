// KV shadow measurement for the bootstrap public tiers (U-K2 of the KV serving plan; #5338 / #5300).
//
// Rides on this Worker's existing pass-through. On real public-tier /api/bootstrap traffic it
// measures how long `env.BOOTSTRAP_KV.get(tier)` takes AT THIS POP and emits it per region —
// WITHOUT serving from KV. Every read runs in ctx.waitUntil; the response is never touched.
//
// Purpose: prove (or disprove) that KV beats the incumbent Redis in the far cohorts (hkg1/syd1/
// bom1/sin1) before any serving cutover (U-K3 gate). This is the "measure, don't assume" step —
// KV's docs promise local-POP reads, but the decision rides on your traffic, not the docs.
//
// Gated by BOOTSTRAP_KV_SHADOW: unset/"0" makes every function here a no-op, so the Worker
// deploys inert and the measurement is flipped on/off by a single var. Privacy: the emitted event
// is a fixed allowlist — never a request, user, credential, or header field.

const PUBLIC_TIERS = new Set(['fast', 'slow']);
// Staleness thresholds mirror KTD4 of the serving plan (fast 15 min, slow 60 min): a value older
// than this would fall through to origin at serve time, so it counts as a non-serving read here.
export const TIER_MAX_AGE_MS = Object.freeze({ fast: 15 * 60_000, slow: 60 * 60_000 });
const PROBE_CEILING_MS = 5_000; // bounds a pathological read; NOT a serving budget (this is waitUntil)
const AXIOM_INGEST_URL = 'https://api.axiom.co/v1/datasets/wm_api_usage/ingest';
const PROBE_TIMEOUT = Symbol('kv-probe-timeout');

let isolateCold = true; // true until the first probe in this isolate — gives explicit cold/warm split

/**
 * The bare tier name for a public-tier bootstrap GET, else null. Mirrors
 * api/bootstrap.js#isPublicTierBootstrapRequest exactly: GET /api/bootstrap with precisely
 * `tier=fast|slow` and `public=1` and no other params.
 */
export function bootstrapTierFromPublicRequest(request, url) {
  if (request.method !== 'GET') return null;
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  if (pathname !== '/api/bootstrap') return null;
  const keys = [...url.searchParams.keys()];
  if (keys.some((k) => k !== 'tier' && k !== 'public')) return null;
  const tiers = url.searchParams.getAll('tier');
  const pub = url.searchParams.getAll('public');
  if (tiers.length !== 1 || pub.length !== 1 || pub[0] !== '1') return null;
  return PUBLIC_TIERS.has(tiers[0]) ? tiers[0] : null;
}

/** Classify a raw KV value the way the serving path would decide to serve vs fall through. */
export function classifyKvEnvelope(tier, raw, now) {
  if (raw == null) return { outcome: 'fallback', reason: 'miss' };
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return { outcome: 'fallback', reason: 'invalid' };
  }
  if (!envelope || envelope.tier !== tier || typeof envelope.generatedAt !== 'number' || !envelope.payload) {
    return { outcome: 'fallback', reason: 'invalid' };
  }
  if (now - envelope.generatedAt > TIER_MAX_AGE_MS[tier]) return { outcome: 'fallback', reason: 'stale' };
  return { outcome: 'kv', reason: null };
}

async function emit(env, event) {
  const token = env?.AXIOM_API_TOKEN;
  if (!token) return; // no token (e.g. inert deploy) → measured silently, never throws
  try {
    await fetch(AXIOM_INGEST_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ _time: new Date().toISOString(), ...event }]),
    });
  } catch {
    // Observability must never surface into the request path.
  }
}

async function probeAndEmit(tier, env, cf) {
  const cold = isolateCold;
  isolateCold = false;
  const started = Date.now();
  let outcome = 'fallback';
  let reason = 'error';
  try {
    const raw = await Promise.race([
      env.BOOTSTRAP_KV.get(tier, { type: 'text' }),
      new Promise((_, reject) => setTimeout(() => reject(PROBE_TIMEOUT), PROBE_CEILING_MS)),
    ]);
    ({ outcome, reason } = classifyKvEnvelope(tier, raw, Date.now()));
  } catch (err) {
    reason = err === PROBE_TIMEOUT ? 'timeout' : 'error';
  }
  const kvDurationMs = Date.now() - started;
  // Fixed allowlist — no request/user/credential/header fields can appear here.
  await emit(env, {
    event_type: 'bootstrap_kv_shadow',
    bootstrap_tier: tier,
    kv_outcome: outcome,
    kv_reason: reason,
    kv_duration_ms: kvDurationMs,
    execution_cold: cold,
    cf_colo: cf?.colo ?? null,
    cf_country: cf?.country ?? null,
  });
}

/**
 * Fire-and-forget KV shadow read for a public-tier bootstrap GET. No-op unless the flag is on,
 * the binding exists, and ctx.waitUntil is available. Never affects the response.
 */
export function maybeShadowKvRead(request, url, env, ctx) {
  if (env?.BOOTSTRAP_KV_SHADOW !== '1' || !env?.BOOTSTRAP_KV || typeof ctx?.waitUntil !== 'function') return;
  const tier = bootstrapTierFromPublicRequest(request, url);
  if (!tier) return;
  ctx.waitUntil(probeAndEmit(tier, env, request.cf));
}
