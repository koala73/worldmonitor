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

import { bootstrapTierFromPublicRequest } from '../../../api/_bootstrap-public-tier.js';
import { isBootstrapKvServingTier } from './kv-serve-mode.js';

export { bootstrapTierFromPublicRequest } from '../../../api/_bootstrap-public-tier.js';

// Staleness thresholds mirror KTD4 of the serving plan (fast 15 min, slow 60 min): a value older
// than this would fall through to origin at serve time, so it counts as a non-serving read here.
export const TIER_MAX_AGE_MS = Object.freeze({ fast: 15 * 60_000, slow: 60 * 60_000 });
const PROBE_CEILING_MS = 5_000; // bounds a pathological read; NOT a serving budget (this is waitUntil)
const AXIOM_TIMEOUT_MS = 1_500;
const AXIOM_INGEST_URL = 'https://api.axiom.co/v1/datasets/wm_api_usage/ingest';
const PROBE_TIMEOUT = Symbol('kv-probe-timeout');
const MAX_FUTURE_SKEW_MS = 5 * 60_000;

let isolateCold = true; // true until the first probe in this isolate — gives explicit cold/warm split
const loggedDeliveryFailures = new Set();

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
  if (!isPlainObject(envelope)
    || envelope.tier !== tier
    || !Number.isFinite(envelope.generatedAt)
    || !Number.isInteger(envelope.generatedAt)
    || envelope.generatedAt > now + MAX_FUTURE_SKEW_MS
    || !isPlainObject(envelope.payload)
    || !isPlainObject(envelope.payload.data)
    || !Array.isArray(envelope.payload.missing)) {
    return { outcome: 'fallback', reason: 'invalid' };
  }
  if (now - envelope.generatedAt > TIER_MAX_AGE_MS[tier]) return { outcome: 'fallback', reason: 'stale' };
  return { outcome: 'kv', reason: null };
}

function warnDeliveryFailure(failureClass) {
  if (loggedDeliveryFailures.has(failureClass)) return;
  loggedDeliveryFailures.add(failureClass);
  console.warn(JSON.stringify({
    event_type: 'bootstrap_kv_shadow_delivery',
    failure_class: failureClass,
  }));
}

// Exported so the U-K4 serving path (kv-serve.js) emits through the same Axiom client + delivery-
// failure dedup; the event_type field distinguishes bootstrap_kv_serve from bootstrap_kv_shadow.
export async function emit(env, event) {
  const token = env?.AXIOM_API_TOKEN;
  if (!token) {
    warnDeliveryFailure('missing_token');
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AXIOM_TIMEOUT_MS);
  try {
    const response = await fetch(AXIOM_INGEST_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'WorldMonitor Bootstrap KV Shadow/1.0',
      },
      body: JSON.stringify([{ _time: new Date().toISOString(), ...event }]),
      signal: controller.signal,
    });
    if (!response.ok) warnDeliveryFailure('http_error');
  } catch {
    warnDeliveryFailure(controller.signal.aborted ? 'timeout' : 'network_error');
  } finally {
    clearTimeout(timer);
  }
}

async function probeAndEmit(tier, env, cf) {
  const cold = isolateCold;
  isolateCold = false;
  const started = Date.now();
  let outcome = 'fallback';
  let reason = 'error';
  let ceilingTimer;
  try {
    const raw = await Promise.race([
      env.BOOTSTRAP_KV.get(tier, { type: 'text' }),
      new Promise((_, reject) => {
        ceilingTimer = setTimeout(() => reject(PROBE_TIMEOUT), PROBE_CEILING_MS);
      }),
    ]);
    ({ outcome, reason } = classifyKvEnvelope(tier, raw, Date.now()));
  } catch (err) {
    reason = err === PROBE_TIMEOUT ? 'timeout' : 'error';
  } finally {
    clearTimeout(ceilingTimer);
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
 * the binding exists, and ctx.waitUntil is available. Once a tier is actively served, its
 * bootstrap_kv_serve event owns latency/outcome telemetry, so skip the redundant shadow read.
 * Never affects the response.
 */
export function maybeShadowKvRead(request, url, env, ctx) {
  if (env?.BOOTSTRAP_KV_SHADOW !== '1' || !env?.BOOTSTRAP_KV || typeof ctx?.waitUntil !== 'function') return;
  const tier = bootstrapTierFromPublicRequest(request, url);
  if (!tier) return;
  if (isBootstrapKvServingTier(env, tier)) return;
  ctx.waitUntil(probeAndEmit(tier, env, request.cf));
}

export function __resetKvShadowForTests() {
  isolateCold = true;
  loggedDeliveryFailures.clear();
}
