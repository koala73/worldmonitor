'use strict';

// Node twin of server/_shared/ai-routing-policy.ts for Railway jobs that put
// one user's data into an LLM prompt (AI alert impact, personalised digest
// prose). The policy lives in Convex `aiRoutingPolicies`; the relay reads it
// through `/relay/ai-routing-policy` with its delivery secret.
//
// Fail closed: when the lookup cannot answer, the decision is `unavailable`,
// which maps to an empty provider allowlist, so the call reaches no provider.

const DEFAULT_TTL_MS = 60_000;
const LOOKUP_TIMEOUT_MS = 5_000;

const DEFAULT_DECISION = Object.freeze({ kind: 'default' });
const UNAVAILABLE_DECISION = Object.freeze({ kind: 'unavailable' });

function parsePolicyBody(body) {
  if (!body || typeof body !== 'object' || !('policy' in body)) return null;
  const { policy } = body;
  if (policy === null) return DEFAULT_DECISION;
  const providers = policy && typeof policy === 'object' ? policy.allowedProviders : undefined;
  if (!Array.isArray(providers) || !providers.every((p) => typeof p === 'string')) return null;
  return Object.freeze({ kind: 'restricted', allowedProviders: Object.freeze([...providers]) });
}

/**
 * @param {{ siteUrl?: string, secret?: string, fetchImpl?: typeof fetch, ttlMs?: number, now?: () => number }} options
 * @returns {(userId: string | null | undefined) => Promise<{ kind: 'default' } | { kind: 'restricted', allowedProviders: readonly string[] } | { kind: 'unavailable' }>}
 */
function createAiRoutingPolicyResolver(options = {}) {
  const {
    siteUrl,
    secret,
    fetchImpl = (...args) => globalThis.fetch(...args),
    ttlMs = DEFAULT_TTL_MS,
    now = Date.now,
  } = options;
  const cache = new Map();

  return async function resolveAiRoutingPolicy(userId) {
    if (!userId) return DEFAULT_DECISION;
    const hit = cache.get(userId);
    if (hit && hit.expiresAt > now()) return hit.decision;
    if (!siteUrl || !secret) return UNAVAILABLE_DECISION;
    try {
      const resp = await fetchImpl(`${siteUrl}/relay/ai-routing-policy`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
          'User-Agent': 'worldmonitor-relay/1.0',
        },
        body: JSON.stringify({ userId }),
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      });
      if (!resp.ok) {
        console.warn(`[ai-routing] policy lookup HTTP ${resp.status}`);
        return UNAVAILABLE_DECISION;
      }
      const decision = parsePolicyBody(await resp.json());
      if (!decision) {
        console.warn('[ai-routing] policy lookup returned an unexpected shape');
        return UNAVAILABLE_DECISION;
      }
      // Only confirmed answers are cached; a failure is retried next time.
      cache.set(userId, { decision, expiresAt: now() + ttlMs });
      return decision;
    } catch (err) {
      console.warn(`[ai-routing] policy lookup failed: ${err?.message ?? err}`);
      return UNAVAILABLE_DECISION;
    }
  };
}

/** Provider allowlist to hand to llm-chain's callLLM, or undefined for unrestricted. */
function allowedProvidersFor(decision) {
  if (!decision || decision.kind === 'default') return undefined;
  if (decision.kind === 'unavailable') return [];
  return [...decision.allowedProviders];
}

/** Cache-key suffix so restricted users never read text another provider wrote. */
function aiRoutingCacheSuffix(decision) {
  if (!decision || decision.kind === 'default') return '';
  if (decision.kind === 'unavailable') return ':ai=none';
  return `:ai=${decision.allowedProviders.join('+')}`;
}

/**
 * Wrap `{ callLLM, cacheGet, cacheSet }` deps for one user: every LLM call is
 * limited to the user's providers (replacing the caller's own allowlist) and
 * every cache key gets the policy suffix. Unrestricted users get the deps back
 * unchanged.
 */
function withAiRoutingPolicy(deps, decision) {
  const allowedProviders = allowedProvidersFor(decision);
  if (!allowedProviders) return deps;
  const suffix = aiRoutingCacheSuffix(decision);
  return {
    ...deps,
    callLLM: (systemPrompt, userPrompt, opts = {}) =>
      deps.callLLM(systemPrompt, userPrompt, { ...opts, allowedProviders }),
    cacheGet: (key) => deps.cacheGet(`${key}${suffix}`),
    cacheSet: (key, value, ttl) => deps.cacheSet(`${key}${suffix}`, value, ttl),
  };
}

module.exports = {
  createAiRoutingPolicyResolver,
  allowedProvidersFor,
  aiRoutingCacheSuffix,
  withAiRoutingPolicy,
};
