// KV serving for the bootstrap public tiers (U-K4 of the KV serving plan; #5338 / #5300).
//
// Phase B of the same Worker that shadow-measured in U-K2. On a public-tier /api/bootstrap GET,
// when BOOTSTRAP_KV_SERVE enables the tier, serve the tier envelope's payload straight from KV at
// this POP — never touching Vercel/Redis, which is where the Redis egress overage comes from.
//
// Strictly additive (KTD3): ANY problem — miss, invalid, stale, read error, read timeout — returns
// null so the caller falls through to the existing origin pass-through. The worst case is exactly
// today's behaviour. The serve-vs-fallback decision reuses the SAME classifyKvEnvelope the U-K2
// shadow used (KTD4 staleness guard included), so what we serve and what we measured cannot drift.
//
// U-K3 (2026-07-16, docs/solutions/2026-07-16-bootstrap-kv-verify.md) proved KV clears the mobile
// budget for 99.6% of global traffic vs Redis's 82.4%. The residual over-budget tail is low-traffic
// remote POPs; the per-tier read cacheTtl below keeps those POPs hotter to shrink it.

import { bootstrapTierFromPublicRequest } from '../../../api/_bootstrap-public-tier.js';
import { classifyKvEnvelope, emit } from './kv-shadow.js';

// Per-tier read cacheTtl (seconds): keep low-traffic POPs hot, trading a little staleness.
// fast=60 is the KV floor; with a 120s publish cadence that is <=3 min served worst-case (product
// accepted 2026-07-17). slow=300 against a 600s cadence. Truly remote POPs (read once per ~15 min)
// evict between reads regardless and stay cold-ish — still faster than Redis there.
const TIER_CACHE_TTL_S = Object.freeze({ fast: 60, slow: 300 });

// Bound a hung KV read so a stuck get() can never hang the response; on timeout we fall through to
// origin. Generous vs the measured p99 (~0.8s global, ~4s worst remote-POP cell) so a legitimately
// slow read still serves rather than bouncing to (also-slow) Redis.
const SERVE_READ_TIMEOUT_MS = 3_000;
const READ_TIMEOUT = Symbol('kv-serve-timeout');

/**
 * Staged serving flag. `off`/unset => serve nothing (Phase-A shadow-only, deploy is inert).
 * `slow` => serve the slow tier only (safest first cutover). `all` => serve both public tiers.
 */
function serveEnabledForTier(env, tier) {
  const mode = env?.BOOTSTRAP_KV_SERVE;
  if (mode === 'all') return true;
  if (mode === 'slow') return tier === 'slow';
  return false;
}

// Fire-and-forget serving metric — fixed allowlist, mirroring the U-K2 shadow's privacy discipline:
// no request/user/credential/header field can appear. Lets us gate the fallback rate post-cutover.
function recordServe(env, ctx, { tier, outcome, reason, durationMs, cf }) {
  if (typeof ctx?.waitUntil !== 'function') return;
  ctx.waitUntil(emit(env, {
    event_type: 'bootstrap_kv_serve',
    bootstrap_tier: tier,
    kv_outcome: outcome,   // 'served' | 'fallback'
    kv_reason: reason,     // null when served; miss|invalid|stale|timeout|error on fallback
    kv_duration_ms: durationMs,
    cf_colo: cf?.colo ?? null,
    cf_country: cf?.country ?? null,
  }));
}

/**
 * Serve a public-tier bootstrap GET from KV, or return null to fall through to the origin.
 * Returns a Response only when serving is enabled for the tier AND the envelope is valid + fresh;
 * every other path returns null (KTD3). Never throws into the request.
 */
export async function maybeServeBootstrapFromKv(request, url, env, ctx, corsHeaders) {
  if (!env?.BOOTSTRAP_KV) return null;
  const tier = bootstrapTierFromPublicRequest(request, url);
  if (!tier || !serveEnabledForTier(env, tier)) return null;

  const cf = request.cf;
  let raw = null;
  let failure = null;
  let ceilingTimer;
  const started = Date.now();
  try {
    raw = await Promise.race([
      env.BOOTSTRAP_KV.get(tier, { type: 'text', cacheTtl: TIER_CACHE_TTL_S[tier] }),
      new Promise((_, reject) => { ceilingTimer = setTimeout(() => reject(READ_TIMEOUT), SERVE_READ_TIMEOUT_MS); }),
    ]);
  } catch (err) {
    failure = err === READ_TIMEOUT ? 'timeout' : 'error';
  } finally {
    clearTimeout(ceilingTimer);
  }
  const durationMs = Date.now() - started;

  const decision = failure
    ? { outcome: 'fallback', reason: failure }
    : classifyKvEnvelope(tier, raw, Date.now());

  if (decision.outcome !== 'kv') {
    recordServe(env, ctx, { tier, outcome: 'fallback', reason: decision.reason, durationMs, cf });
    return null; // origin pass-through handles it
  }

  // classifyKvEnvelope already proved the envelope shape. Re-parse to lift the payload — a deliberate
  // second parse kept OUT of classifyKvEnvelope so the live U-K2 shadow path stays byte-for-byte
  // unchanged; ~1-2 ms on the 452 KB fast tier, negligible next to the KV read itself.
  let body;
  try {
    body = JSON.stringify(JSON.parse(raw).payload);
  } catch {
    // Unreachable given classifyKvEnvelope passed, but never emit a 500 from here — fall through.
    recordServe(env, ctx, { tier, outcome: 'fallback', reason: 'invalid', durationMs, cf });
    return null;
  }

  recordServe(env, ctx, { tier, outcome: 'served', reason: null, durationMs, cf });
  // Mirror the headers the origin sets for this route (the Worker is the CORS source of truth, so
  // corsHeaders is spread first). x-vercel-* / age are intentionally absent; the source marker
  // makes a KV-served response identifiable in curl/devtools.
  return new Response(body, {
    status: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-WorldMonitor-Bootstrap-Source': 'kv',
    },
  });
}
