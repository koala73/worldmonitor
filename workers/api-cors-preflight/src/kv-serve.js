// KV serving for the bootstrap public tiers (U-K4 of the KV serving plan; #5338 / #5300).
//
// Phase B of the same Worker that shadow-measured in U-K2. On a public-tier /api/bootstrap GET,
// when BOOTSTRAP_KV_SERVE enables the tier, serve the tier envelope's payload straight from KV at
// this POP — never touching Vercel/Redis, which is where the Redis egress overage comes from.
//
// Strictly additive (KTD3): any non-servable outcome — miss, invalid, stale, read error, or a KV
// read too slow to beat the client budget — yields the ORIGIN response instead, via the same
// pass-through the caller uses. The worst case is exactly today's behaviour. The serve-vs-fallback
// decision reuses the SAME classifyKvEnvelope the U-K2 shadow used (KTD4 staleness guard included),
// so what we serve and what we measured cannot drift.
//
// Slowness policy = HEDGE, not a hard timeout. U-K3 shadow data showed 10-18% of reads in real
// high-traffic metros (DEL/JNB/BKK) complete in the 500-1200 ms band — under the mobile budget but
// above any tight timeout. Abandoning those to the slower Redis path is a net loss. Instead we give
// KV a head start; only if it is still pending at HEDGE_DELAY_MS do we ALSO start origin and race
// them, serving whichever is usable first. A slow-but-valid KV read still wins and is served; a hung
// KV simply loses to origin (so no arbitrary read timeout is needed). Cost: one extra origin fetch
// on the ~1-4% of reads that outrun the hedge window — and those origin fetches often hit Vercel's
// edge cache rather than Redis.

import { bootstrapTierFromPublicRequest } from '../../../api/_bootstrap-public-tier.js';
import { classifyKvEnvelope, emit } from './kv-shadow.js';
import { isBootstrapKvServingTier } from './kv-serve-mode.js';

// Per-tier read cacheTtl (seconds): keep low-traffic POPs hot, trading a little staleness.
// fast=60 is the KV floor; with a 120s publish cadence that is <=3 min served worst-case (product
// accepted 2026-07-17). slow=300 against a 600s cadence. Truly remote POPs (read once per ~15 min)
// evict between reads regardless and stay cold-ish — still faster than Redis there.
const TIER_CACHE_TTL_S = Object.freeze({ fast: 60, slow: 300 });

// Head start before enlisting origin. ~99% of fast and ~96% of slow KV reads finish inside this
// window (U-K3 shadow), so the hedge — and its extra origin fetch — only engages on the slow tail.
const HEDGE_DELAY_MS = 500;

/** Cancellable hedge timer so a fast KV win doesn't leave a setTimeout dangling per request. */
function hedgeTimer(ms) {
  let id;
  const promise = new Promise((resolve) => { id = setTimeout(() => resolve({ kind: 'hedge' }), ms); });
  return { promise, cancel: () => clearTimeout(id) };
}

// Read + classify a tier, never rejecting. On a servable value it also lifts the payload body (a
// deliberate second parse kept OUT of classifyKvEnvelope so the live U-K2 shadow path stays
// byte-for-byte unchanged; ~1-2 ms on the 452 KB fast tier, negligible next to the KV read).
async function readKvEnvelope(env, tier) {
  let raw = null;
  try {
    raw = await env.BOOTSTRAP_KV.get(tier, { type: 'text', cacheTtl: TIER_CACHE_TTL_S[tier] });
  } catch {
    return { decision: { outcome: 'fallback', reason: 'error' } };
  }
  const decision = classifyKvEnvelope(tier, raw, Date.now());
  if (decision.outcome !== 'kv') return { decision };
  try {
    return { decision, body: JSON.stringify(JSON.parse(raw).payload) };
  } catch {
    return { decision: { outcome: 'fallback', reason: 'invalid' } };
  }
}

// Fire-and-forget serving metric — fixed allowlist, mirroring the U-K2 shadow's privacy discipline:
// no request/user/credential/header field can appear. Lets us gate the fallback rate post-cutover.
function recordServe(env, ctx, { tier, outcome, reason, durationMs, cf }) {
  if (typeof ctx?.waitUntil !== 'function') return;
  ctx.waitUntil(emit(env, {
    event_type: 'bootstrap_kv_serve',
    bootstrap_tier: tier,
    kv_outcome: outcome,   // 'served' | 'fallback'
    kv_reason: reason,     // null when served; miss|invalid|stale|error (bad value) or hedged (too slow)
    kv_duration_ms: durationMs,
    cf_colo: cf?.colo ?? null,
    cf_country: cf?.country ?? null,
  }));
}

function serveFromKv(env, ctx, { tier, body, cf, started, corsHeaders }) {
  recordServe(env, ctx, { tier, outcome: 'served', reason: null, durationMs: Date.now() - started, cf });
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

/**
 * Serve a public-tier bootstrap GET from KV, or return the origin response (via fetchOrigin) when
 * KV is not servable / too slow, or null when this isn't a servable request at all (so the caller
 * runs its normal pass-through). fetchOrigin is the caller's single origin+CORS path — invoked at
 * most once here, so origin is fetched exactly once across the whole request. Never throws.
 */
export async function maybeServeBootstrapFromKv(request, url, env, ctx, corsHeaders, fetchOrigin) {
  if (!env?.BOOTSTRAP_KV) return null;
  const tier = bootstrapTierFromPublicRequest(request, url);
  if (!tier || !isBootstrapKvServingTier(env, tier)) return null;

  const cf = request.cf;
  const started = Date.now();
  const kv = readKvEnvelope(env, tier).then((r) => ({ kind: 'kv', ...r }));

  // Phase 1 — hedge window: wait for KV, but no longer than HEDGE_DELAY_MS before enlisting origin.
  const hedge = hedgeTimer(HEDGE_DELAY_MS);
  const first = await Promise.race([kv, hedge.promise]);
  hedge.cancel();
  if (first.kind === 'kv' && first.decision.outcome === 'kv') {
    return serveFromKv(env, ctx, { tier, body: first.body, cf, started, corsHeaders });
  }

  // Phase 2 — origin needed. Start it once. If KV already answered unservable, origin is the answer;
  // otherwise KV is still in flight and races origin (a slow-but-valid KV read can still win).
  const origin = fetchOrigin().then((resp) => ({ kind: 'origin', resp }));
  const settled = first.kind === 'kv' ? await origin : await Promise.race([kv, origin]);
  if (settled.kind === 'kv' && settled.decision.outcome === 'kv') {
    return serveFromKv(env, ctx, { tier, body: settled.body, cf, started, corsHeaders });
  }

  // Fall back to origin. reason = KV's own failure if we have it, else 'hedged' (KV lost the race).
  const reason = first.kind === 'kv' ? first.decision.reason
    : settled.kind === 'kv' ? settled.decision.reason
      : 'hedged';
  recordServe(env, ctx, { tier, outcome: 'fallback', reason, durationMs: Date.now() - started, cf });
  return settled.kind === 'origin' ? settled.resp : (await origin).resp;
}
