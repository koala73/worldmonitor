/**
 * Per-request "this is a premium call" marker shared by `premiumFetch`
 * (src/services/premium-fetch.ts) and the wm-session fetch interceptor
 * (src/services/wm-session.ts) — issue #5674.
 *
 * ## Why a per-request marker exists at all
 *
 * Both layers need to answer "is this request premium?", but until now only
 * one of them could: `PREMIUM_RPC_PATHS` is a static *path* set, and a path is
 * the wrong granularity for a route whose premium-ness depends on the request
 * itself.
 *
 * `/api/news/v1/summarize-article` is exactly that route. The gateway decides
 * per request, from the body (`shouldReserveGatewayDirectLlmQuota` in
 * server/gateway.ts):
 *
 *   - `mode: 'translate'` — free, and REQUIRES the anonymous wms_ cookie
 *     (verified against prod: no cookie ⇒ 401 "API key required").
 *   - any other mode — spend-bearing, requires a Clerk identity, so an
 *     anonymous caller gets 401 "Pro authentication required" no matter how
 *     fresh their session cookie is.
 *
 * That is why the path is deliberately kept OUT of `PREMIUM_RPC_PATHS` (see
 * `DIRECT_LLM_PREMIUM_BYPASS_ALLOWLIST` in tests/premium-paths-guard.test.mts):
 * adding it would make the interceptor step aside for translate too, no wms_
 * would be attached, and free translation would break for every anonymous
 * visitor.
 *
 * ## The bug this closes (#5674)
 *
 * The client already knows which mode it is sending — summarize goes through
 * `premiumFetch(..., { forcePremium: true })`, translate through the plain
 * client — but that intent died inside `premiumFetch`. The interceptor judged
 * premium-ness from the static path set alone, so when `premiumFetch` could
 * not resolve any credential (anonymous visitor, signed-in free user, or a
 * Clerk boot-window token race) its unauthenticated fallback 401 was read as a
 * *rejected session cookie*: mint a fresh one, replay, 401 again, and
 * `markWmSessionDead('retry_401')` suppressed ALL anonymous API calls for 15
 * minutes (#5219) — a dashboard of blank widgets.
 *
 * This module carries that intent across the boundary so both layers agree:
 * a 401 on a premium-intent request is an expected auth denial, never
 * evidence that the anonymous session cookie is dead.
 *
 * ## Mechanism
 *
 * The marker rides on the `RequestInit` object rather than on the wire. It is
 * deliberately NOT a header: a custom header on a cross-origin request forces
 * a CORS preflight and would need server-side `Access-Control-Allow-Headers`
 * cooperation, so a purely client-side concern would become a wire contract.
 * Unknown `RequestInit` properties are ignored by the platform, and the
 * interceptor reads the very same object `premiumFetch` passed to
 * `globalThis.fetch`.
 *
 * ## Why this is its own module
 *
 * It is a contract between two peers, and neither should own it. Putting it in
 * `premium-fetch.ts` would make `wm-session.ts` import that module's whole
 * graph (and vice versa) purely to read one boolean, coupling the interceptor
 * to the auth-injection layer it deliberately knows nothing about. Keeping the
 * marker dependency-free lets either side import it for free.
 *
 * (Not, as an earlier revision of this comment claimed, because its consumers
 * would otherwise be un-loadable under `tsx --test` — both `premium-fetch.ts`
 * and `wm-session.ts` are already exercised there. That constraint is real for
 * summarize-gate.ts, whose consumer pulls in `@/services/i18n`; it is not the
 * reason this file exists.)
 */

/**
 * Property name carrying the marker. Exported so guards can assert the two
 * sides use one key instead of two silently-diverging string literals.
 */
export const PREMIUM_INTENT_INIT_KEY = 'wmPremiumIntent';

/** A `RequestInit` that may carry the premium-intent marker. */
export type PremiumIntentInit = RequestInit & { [PREMIUM_INTENT_INIT_KEY]?: boolean };

/**
 * Tag `init` as a premium-intent request.
 *
 * Returns a new object — callers pass the result straight to
 * `globalThis.fetch`, and mutating a caller-supplied init would leak the
 * marker onto a request object the caller may reuse for a non-premium call.
 */
export function withPremiumIntent(init?: RequestInit): PremiumIntentInit {
  return { ...(init ?? {}), [PREMIUM_INTENT_INIT_KEY]: true };
}

/**
 * Whether this request was dispatched as a premium call that `premiumFetch`
 * could not authenticate — i.e. a 401 here is an expected auth denial and must
 * NOT be treated as a rejected anonymous session cookie.
 *
 * Strict `=== true` so a truthy-but-unintended value (a caller spreading an
 * unrelated object, a deserialized init) cannot silently opt a request out of
 * session recovery.
 */
export function hasPremiumIntent(init?: RequestInit | null): boolean {
  if (!init || typeof init !== 'object') return false;
  return (init as PremiumIntentInit)[PREMIUM_INTENT_INIT_KEY] === true;
}
