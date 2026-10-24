// ENV_PREFIX is shared with the entitlement cache so Convex's cache delete
// (convex/payments/cacheActions.ts) and this reader use one namespace.
import { ENV_PREFIX, getConvexSharedSecret, getConvexSiteUrl } from './entitlement-check';
import type { LlmRoutingPolicy } from './llm';
import { TRUSTED_USER_ID_HEADER } from './mcp-internal-hmac';
import { getCachedJson, setCachedJson } from './redis.js';

// Per-customer AI routing restriction (e.g. a contract that says the
// customer's AI traffic goes to Anthropic directly and nowhere else).
//
// Scope: LLM calls that carry the caller's own input — their queries, context,
// framework text, chat messages, submitted text. Shared content generated in
// the background for everyone stays on the default chain.
//
// Source of truth: Convex `aiRoutingPolicies`, keyed by the Clerk user id the
// gateway authenticated (`x-user-id`, which the gateway strips from inbound
// requests and sets only after auth). Operator keys carry no user id and are
// never restricted.
//
// Fail closed: when the lookup cannot answer for a signed-in caller, the
// decision is `unavailable`, which maps to an empty provider allowlist, so
// the call reaches no provider instead of the default chain.

const CACHE_TTL_SECONDS = 60;
const LOOKUP_TIMEOUT_MS = 3_000;
const CONVEX_PATH = '/api/internal-ai-routing-policy';

export type AiRoutingDecision =
  | { kind: 'default' }
  | { kind: 'restricted'; allowedProviders: string[] }
  | { kind: 'unavailable' };

const DEFAULT_DECISION: AiRoutingDecision = { kind: 'default' };
const UNAVAILABLE_DECISION: AiRoutingDecision = { kind: 'unavailable' };

function cacheKey(userId: string): string {
  return `ai-routing:${ENV_PREFIX}:${userId}`;
}

function parsePolicy(value: unknown): { ok: true; allowedProviders: string[] | null } | { ok: false } {
  if (!value || typeof value !== 'object' || !('policy' in value)) return { ok: false };
  const policy = (value as { policy: unknown }).policy;
  if (policy === null) return { ok: true, allowedProviders: null };
  if (!policy || typeof policy !== 'object') return { ok: false };
  const providers = (policy as { allowedProviders?: unknown }).allowedProviders;
  if (!Array.isArray(providers) || !providers.every((p) => typeof p === 'string')) return { ok: false };
  return { ok: true, allowedProviders: providers as string[] };
}

function toDecision(allowedProviders: string[] | null): AiRoutingDecision {
  return allowedProviders === null ? DEFAULT_DECISION : { kind: 'restricted', allowedProviders };
}

export async function getAiRoutingDecisionForUser(userId: string | null | undefined): Promise<AiRoutingDecision> {
  if (!userId) return DEFAULT_DECISION;
  try {
    const cached = parsePolicy(await getCachedJson(cacheKey(userId), true));
    if (cached.ok) return toDecision(cached.allowedProviders);

    const siteUrl = getConvexSiteUrl();
    const secret = getConvexSharedSecret();
    if (!siteUrl || !secret) return UNAVAILABLE_DECISION;

    const response = await fetch(`${siteUrl}${CONVEX_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'worldmonitor-gateway/1.0',
        'x-convex-shared-secret': secret,
      },
      body: JSON.stringify({ userId }),
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`[ai-routing] policy lookup HTTP ${response.status}`);
      return UNAVAILABLE_DECISION;
    }
    const body = await response.json();
    const parsed = parsePolicy(body);
    if (!parsed.ok) {
      console.warn('[ai-routing] policy lookup returned an unexpected shape');
      return UNAVAILABLE_DECISION;
    }
    try {
      await setCachedJson(cacheKey(userId), { policy: parsed.allowedProviders === null ? null : { allowedProviders: parsed.allowedProviders } }, CACHE_TTL_SECONDS, true);
    } catch { /* a cache write failure must not change the decision */ }
    return toDecision(parsed.allowedProviders);
  } catch (err) {
    // sentry-coverage-ok: fail-closed decision; the caller's LLM call reaches no provider.
    console.warn('[ai-routing] policy lookup failed:', err instanceof Error ? err.message : String(err));
    return UNAVAILABLE_DECISION;
  }
}

/**
 * Decision for a gateway-routed request. The gateway-set user id wins; a
 * handler that authenticated the caller itself (resolvePremiumCallerIdentity)
 * passes that user id as the fallback, which covers routes where the gateway
 * does not resolve a Clerk session (free modes, cache reads). A call with no
 * identity at all (an internal invocation, an anonymous caller) is
 * unrestricted, like any other caller without a user id.
 */
export function resolveAiRouting(
  request: Request | undefined,
  fallbackUserId?: string | null,
): Promise<AiRoutingDecision> {
  return getAiRoutingDecisionForUser(request?.headers?.get(TRUSTED_USER_ID_HEADER) || fallbackUserId || null);
}

/** The `routingPolicy` to pass to llm.ts. */
export function toLlmRoutingPolicy(decision: AiRoutingDecision): LlmRoutingPolicy | null {
  if (decision.kind === 'default') return null;
  if (decision.kind === 'unavailable') return { allowedProviders: [] };
  return { allowedProviders: decision.allowedProviders };
}

/**
 * Cache-key suffix for LLM-backed responses. Unrestricted callers keep the
 * existing shared keys (empty suffix); restricted callers get their own
 * namespace so they are never served text another provider wrote.
 */
export function aiRoutingCacheSuffix(decision: AiRoutingDecision): string {
  if (decision.kind === 'default') return '';
  if (decision.kind === 'unavailable') return ':ai=none';
  return `:ai=${decision.allowedProviders.join('+')}`;
}

/** True when the caller may use features that only exist on the default chain (e.g. OpenRouter embeddings). */
export function allowsProvider(decision: AiRoutingDecision, provider: string): boolean {
  if (decision.kind === 'default') return true;
  if (decision.kind === 'unavailable') return false;
  return decision.allowedProviders.includes(provider);
}
