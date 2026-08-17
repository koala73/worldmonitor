// @ts-expect-error — JS module, no declaration file
import { validateApiKey } from '../../api/_api-key.js';
// @ts-expect-error — JS module, no declaration file
import { timingSafeIncludes } from '../../api/_crypto.js';
import { validateBearerToken } from '../auth-session';
import {
  classifyBillingVerification,
  getEntitlements,
  isEntitlementBackendConfigured,
  unverifiableEntitlementDenial,
  type BillingVerificationDenial,
  type BillingVerificationInput,
} from './entitlement-check';
import {
  INTERNAL_MCP_VERIFIED_HEADER,
  TRUSTED_USER_ID_HEADER,
  getInternalMcpVerifiedNonce,
} from './mcp-internal-hmac';
import { validateUserApiKey } from './user-api-key';
import {
  DIRECT_LLM_UNVERIFIED_DAILY_QUOTA_LIMIT,
  resolveActiveDirectLlmLimit,
} from './direct-llm-quota';

export type PremiumCallerIdentity =
  | { isPremium: true; userId: string; kind: 'internal-mcp'; quotaExempt: true }
  | {
      isPremium: true;
      userId: string;
      kind: 'user-api-key' | 'bearer';
      quotaExempt: false;
      /**
       * Daily direct-LLM budget for this caller. `null` is unlimited.
       *
       * REQUIRED, not optional: every arm that builds this identity must state
       * the budget explicitly. When it was optional an arm was added without
       * it, and the absent field fell through to the paid default — so the two
       * surfaces sharing this counter enforced two different caps. Always
       * source it from `resolveActiveDirectLlmLimit`.
       */
      directLlmDailyLimit: number | null;
    }
  | { isPremium: true; userId: null; kind: 'enterprise'; quotaExempt: true }
  | {
    isPremium: false;
    userId: null;
    kind: null;
    quotaExempt: false;
    /**
     * The billing-verification classification behind this denial, when the
     * denial rests on something OTHER than a confirmed non-premium answer
     * (#5622) — a lookup that failed, a renewal re-check in flight, or a
     * provider-confirmed lapse. Absent for a genuine free/unauthenticated
     * caller.
     *
     * The field is additive and optional on purpose: `isPremium: false` keeps
     * its exact meaning ("do not grant premium"), so all ~25 existing callers
     * — including every `isCallerPremium()` boolean consumer — are unaffected.
     * A caller that wants the retryable posture opts in by reading this and
     * rendering it via renderBillingVerificationDenial instead of a terminal 403.
     *
     * It carries the whole classification rather than a boolean because there
     * are FOUR of these states, not one. An earlier version of this field was
     * `verificationUnavailable?: true`, which silently dropped
     * `renewal_verification_pending` / `renewal_verification_failed` — states
     * convex/http.ts really does emit — back onto the terminal upsell, i.e. the
     * exact #5600 failure mode this field exists to remove.
     */
    billingDenial?: BillingVerificationDenial;
    /**
     * True when the denial rests on the ABSENCE of a usable credential (#5619)
     * — nothing was presented, or what was presented did not validate — rather
     * than on a verdict about an identified account's plan.
     *
     * Without it every denial looked the same, so `api/chat-analyst.ts` told a
     * signed-out visitor to buy a Pro subscription. The fix for that caller is a
     * session, not a purchase, and the client classifier has carried a
     * `sign_in_required` verdict since #5608 that no 403 on this route could
     * ever reach.
     *
     * Additive and optional for the same reason as `billingDenial` above:
     * `isPremium: false` keeps its exact meaning, so every existing consumer —
     * including all `isCallerPremium()` boolean callers — is unaffected. A
     * caller opts in by rendering 401 instead of the Pro 403.
     *
     * Mutually exclusive with `billingDenial` by construction: a billing
     * classification only exists once a userId was resolved and looked up.
     */
    unauthenticated?: true;
  };

/** The deny arm of the union, named so `{ ...DENIED, billingDenial }` stays in it. */
type DeniedIdentity = Extract<PremiumCallerIdentity, { isPremium: false }>;

/**
 * Deny with no information about WHY — a confirmed non-premium caller.
 *
 * Frozen because this is now ONE shared object returned by reference from
 * several deny arms, where the pre-#5622 code built a fresh literal at each
 * site. A caller that stamped a field onto a returned identity would otherwise
 * poison every subsequent denial in the isolate. `denyFor`'s
 * `{ ...DENIED, billingDenial }` spread still produces a fresh mutable copy.
 */
const DENIED: DeniedIdentity = Object.freeze({
  isPremium: false,
  userId: null,
  kind: null,
  quotaExempt: false,
});

/**
 * Deny because no usable credential arrived (#5619).
 *
 * Reached by exactly two paths: a bearer token that failed validation, and the
 * fall-through at the end of the resolver — no bearer, plus whatever other
 * credential was tried (an unknown `wm_` key, a spoofed internal-MCP marker, a
 * rejected `X-WorldMonitor-Key`) having failed. Every one of those is a
 * statement about the credential, never about a plan, so none of them may
 * produce an upsell.
 *
 * Frozen for the same reason as `DENIED`.
 */
const UNAUTHENTICATED: DeniedIdentity = Object.freeze({
  isPremium: false,
  userId: null,
  kind: null,
  quotaExempt: false,
  unauthenticated: true,
});

/**
 * A deny-side entitlement answer, tagged with its billing classification when
 * the row carries one.
 *
 * Same authorization outcome either way — nothing is granted. The tag only lets
 * a caller choose retryable-vs-terminal wording.
 */
function denyFor(entitlements: BillingVerificationInput | null): DeniedIdentity {
  // An absent row is a verdict about the account only when a lookup could
  // actually run. With CONVEX_SITE_URL or the shared secret missing,
  // getEntitlements returns null BEFORE attempting one — for everyone, paying
  // customers included — and a bare DENIED renders as the Pro upsell, selling
  // subscribers the plan they already own because of OUR deploy defect. This is
  // the same guard pro-entitlement.ts applies at the browser gates; every arm
  // that reaches here has already resolved an identity, so the caller is a
  // known user and this is never the anonymous path (#5619, precedent #5600).
  if (!entitlements && !isEntitlementBackendConfigured()) {
    return { ...DENIED, billingDenial: unverifiableEntitlementDenial() };
  }
  const billingDenial = classifyBillingVerification(entitlements);
  return billingDenial ? { ...DENIED, billingDenial } : DENIED;
}

type RpcApiErrorLike = Error & {
  statusCode: number;
  body: string;
  retryAfter?: number;
  exposeMessage?: boolean;
};

type RpcApiErrorConstructor<T extends RpcApiErrorLike> =
  new (statusCode: number, message: string, body: string) => T;

type PremiumRpcBillingApiError<T extends RpcApiErrorLike> = T & {
  billingVerificationCode: BillingVerificationDenial['code'];
};

/**
 * RPC billing denials have two transport shapes:
 * - response-envelope RPCs use `ServiceError` for retryable verification
 *   states and `AuthError` for the provider-confirmed terminal lapse;
 * - exception-style RPCs throw their generated service's own `ApiError`.
 *
 * Both put the stable billing code in `statusDetail`/`ApiError.body`. Confirmed
 * free and unauthenticated callers have no billing denial and keep the
 * handler's existing Pro-required rendering.
 */
export function getPremiumRpcBillingErrorType(
  denial: BillingVerificationDenial,
): 'AuthError' | 'ServiceError' {
  return denial.retryable ? 'ServiceError' : 'AuthError';
}

function createPremiumRpcBillingDenialError<T extends RpcApiErrorLike>(
  identity: PremiumCallerIdentity,
  ApiErrorConstructor: RpcApiErrorConstructor<T>,
): PremiumRpcBillingApiError<T> | null {
  if (identity.isPremium || !identity.billingDenial) return null;
  const denial = identity.billingDenial;

  const error = new ApiErrorConstructor(
    denial.status,
    denial.message,
    denial.code,
  ) as PremiumRpcBillingApiError<T>;
  error.billingVerificationCode = denial.code;
  if (denial.status === 503) {
    error.retryAfter = denial.retryAfterSeconds;
    error.exposeMessage = true;
  }
  return error;
}

/**
 * Enforces a hard-denying premium RPC gate while preserving why verification
 * failed. The generated constructor keeps `instanceof ApiError` service-local;
 * the fallback message preserves each endpoint's existing `PRO`/`Pro` copy.
 */
export async function requirePremiumRpcAccess<T extends RpcApiErrorLike>(
  request: Request,
  ApiErrorConstructor: RpcApiErrorConstructor<T>,
  fallbackMessage: string,
): Promise<void> {
  const identity = await resolvePremiumCallerIdentity(request);
  if (identity.isPremium) return;

  const billingError = createPremiumRpcBillingDenialError(identity, ApiErrorConstructor);
  if (billingError) throw billingError;
  throw new ApiErrorConstructor(403, fallbackMessage, '');
}

/**
 * Resolves premium status and the user-bound identity for spend controls.
 */
export async function resolvePremiumCallerIdentity(request: Request): Promise<PremiumCallerIdentity> {
  // Internal-MCP context: trusted markers are set by the gateway AFTER an
  // HMAC verification on `X-WM-MCP-Internal` succeeds. Inbound copies of
  // these headers are stripped at the gateway entry (defense-in-depth) so
  // a client cannot reach this branch by injecting them directly.
  //
  // The verified-marker value is a per-process-startup random nonce. We
  // compare with timing-safe equality, not just `=== '1'`, so an attacker
  // hitting a direct (non-gateway-routed) edge function with a spoofed
  // marker fails closed — the gateway is the ONLY entity that knows the
  // nonce, and only it produces the value.
  //
  // Defensive re-fetch of getEntitlements (cache-hot, ~free): catches any
  // future code path where someone forgets to verify upstream, and any
  // mid-request entitlement lapse (tier just dropped to 0). The gateway
  // already entitlement-checks before propagating, so this is belt-and-
  // suspenders — but cheap and worth it for a security-critical gate.
  const verifiedMarker = request.headers.get(INTERNAL_MCP_VERIFIED_HEADER);
  const trustedUserId = request.headers.get(TRUSTED_USER_ID_HEADER);
  if (verifiedMarker && trustedUserId) {
    const expectedNonce = getInternalMcpVerifiedNonce();
    // Length-safe-then-byte-compare. JS strings cannot leak per-char timing
    // the way C strcmp does, but we still avoid early-exit branches.
    let diff = verifiedMarker.length ^ expectedNonce.length;
    const len = Math.max(verifiedMarker.length, expectedNonce.length);
    for (let i = 0; i < len; i++) {
      const a = i < verifiedMarker.length ? verifiedMarker.charCodeAt(i) : 0;
      const b = i < expectedNonce.length ? expectedNonce.charCodeAt(i) : 0;
      diff |= a ^ b;
    }
    if (diff === 0) {
      const ent = await getEntitlements(trustedUserId);
      if (
        ent &&
        ent.features.tier >= 1 &&
        // mcpAccess lands in U10. Until then the field is undefined for
        // existing entitlement rows; treat undefined as false (fail-closed)
        // so a misconfigured / pre-U10 row cannot grant premium semantics
        // through the internal-MCP path.
        (ent.features as { mcpAccess?: boolean }).mcpAccess === true
      ) {
        return { isPremium: true, userId: trustedUserId, kind: 'internal-mcp', quotaExempt: true };
      }
      return denyFor(ent);
    }
    // Marker present but nonce mismatch: do NOT short-circuit. Fall
    // through to the normal auth flow — an attacker spoofing the marker
    // gets exactly the same auth surface as one without the marker, no
    // information leak about the nonce.
  }

  // Browser tester keys — validateApiKey returns required:false for trusted origins
  // even when a valid key is present, so we check the header directly first.
  const wmKey =
    request.headers.get('X-WorldMonitor-Key') ??
    request.headers.get('X-Api-Key') ??
    '';
  // Set when the wm_-key lookup could not COMPLETE (below). Read only at the
  // terminal fall-through, so a co-present bearer still wins if it resolves.
  let userKeyLookupUnavailable = false;
  if (wmKey) {
    const validKeys = (process.env.WORLDMONITOR_VALID_KEYS ?? '')
      .split(',').map((k) => k.trim()).filter(Boolean);
    if (await timingSafeIncludes(wmKey, validKeys)) {
      return { isPremium: true, userId: null, kind: 'enterprise', quotaExempt: true };
    }

    // Check user-owned API keys (wm_ prefix) via Convex lookup.
    // Key existence alone is not sufficient — verify the owner's entitlement.
    // Transient validation outages throw UserApiKeyUnavailableError — do not
    // treat them as invalid keys; fall through so a co-present bearer can still
    // grant premium, and fail closed for the user-key path itself.
    try {
      const userKey = await validateUserApiKey(wmKey);
      if (userKey) {
        const ent = await getEntitlements(userKey.userId);
        if (ent && ent.features.apiAccess === true) {
          return {
            isPremium: true,
            userId: userKey.userId,
            kind: 'user-api-key',
            quotaExempt: false,
            // apiAccess proves the plan sells API access; it does NOT prove the
            // subscription is still current. resolveActiveDirectLlmLimit
            // re-checks tier + validUntil so a lapsed row cannot keep spending
            // its old allowance against the shared daily counter.
            directLlmDailyLimit: resolveActiveDirectLlmLimit(ent),
          };
        }
        // Preserve main's billing-verification tag on confirmed denials (#5622).
        return denyFor(ent);
      }
    } catch {
      // Transient validation outage: do not grant premium, but fall through so
      // a co-present bearer can still resolve. Matches UserApiKeyUnavailableError
      // semantics from the negative-cache fix (#5384 / #5599).
      //
      // Remember it. Without this the fall-through below answers UNAUTHENTICATED
      // — telling a machine client holding a perfectly good key that the key is
      // bad and retrying is futile, which is exactly what user-api-key.ts says
      // these outages must never become (#5619 follow-up).
      userKeyLookupUnavailable = true;
    }
  }

  const keyCheck = (await validateApiKey(request, {})) as { valid: boolean; required: boolean };
  // Only treat as premium when an explicit API key was validated (required: true).
  // Trusted-origin short-circuits (required: false) do NOT imply PRO entitlement.
  if (keyCheck.valid && keyCheck.required) {
    return { isPremium: true, userId: null, kind: 'enterprise', quotaExempt: true };
  }

  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const session = await validateBearerToken(authHeader.slice(7));
    // An invalid token is a confirmed answer about the CREDENTIAL, not a failed
    // entitlement lookup — and not a statement about any plan either, so it
    // denies as unauthenticated rather than as a free account (#5619).
    //
    // But `valid: false` alone does not mean the token was judged: a missing
    // issuer domain or a failed JWKS fetch lands here too, and neither says
    // anything about the credential. Only a CONFIRMED-bad token may be told
    // that signing in again is the fix.
    if (!session.valid) {
      if (session.reason === 'unverifiable') {
        return { ...DENIED, billingDenial: unverifiableEntitlementDenial() };
      }
      return UNAUTHENTICATED;
    }
    if (session.role === 'pro' && session.userId) {
      // A Clerk-role grant is premium WITHOUT a Convex row to price it: the Dodo
      // pipeline never syncs publicMetadata.role (see server/gateway.ts), so
      // this arm is complimentary/tester/legacy grants, not paying subscribers.
      // Unpriceable is exactly the unverified case, so name the floor here
      // rather than letting an absent field fall through to the paid default.
      return {
        isPremium: true,
        userId: session.userId,
        kind: 'bearer',
        quotaExempt: false,
        directLlmDailyLimit: DIRECT_LLM_UNVERIFIED_DAILY_QUOTA_LIMIT,
      };
    }
    // Clerk role isn't 'pro' — check Dodo entitlement tier as second signal.
    // A Dodo subscriber (tier >= 1) is premium regardless of Clerk role.
    if (session.userId) {
      const ent = await getEntitlements(session.userId);
      if (ent && ent.features.tier >= 1) {
        return {
          isPremium: true,
          userId: session.userId,
          kind: 'bearer',
          quotaExempt: false,
          // Premium-ness here keys on tier alone (pre-existing contract). The
          // SPEND limit is stricter on purpose: a lapsed row must not keep its
          // paid allowance, and an Enterprise row's null must not skip the
          // meter once it has expired.
          directLlmDailyLimit: resolveActiveDirectLlmLimit(ent),
        };
      }
      return denyFor(ent);
    }
  }
  // A wm_ key was presented and its lookup never completed. That is an outage,
  // not a missing credential, so it takes the retryable contract rather than the
  // 401 below — checked first because the credential WAS supplied.
  if (userKeyLookupUnavailable) {
    return { ...DENIED, billingDenial: unverifiableEntitlementDenial() };
  }
  // No credential resolved an identity: no bearer at all, a bearer that carried
  // no subject, an unknown `wm_` key, a rejected `X-WorldMonitor-Key`, or a
  // spoofed internal-MCP marker that fell through. Every arm that DID identify
  // someone, or that failed for a reason other than the credential, has already
  // returned above, so this is the credential denial (#5619).
  return UNAUTHENTICATED;
}

/**
 * Returns true when the caller has a valid API key OR a PRO bearer token.
 * Used by handlers where the RPC endpoint is public but certain fields
 * (e.g. framework/systemAppend) should only be honored for premium callers.
 *
 * DELIBERATELY LOSSY (#5622): a boolean cannot express "we could not verify".
 * That is acceptable for this function's actual job — the majority of its ~25
 * callers use it to decide whether to *enrich* a public response (honor
 * `framework`, return populated vs empty arrays), where the worst case of a
 * transient failure is a degraded payload rather than a wrong verdict about the
 * user's plan.
 *
 * It is NOT acceptable for a caller that turns `false` into a terminal
 * "Pro subscription required" 403 — that flattens a backend blip into a
 * misleading upsell for a paying customer. Those callers must use
 * `resolvePremiumCallerIdentity()` and render `identity.billingDenial` via
 * `getBillingVerificationDenial` instead (see api/chat-analyst.ts). Threading
 * the signal through this boolean would mean changing its return type and every
 * caller, which is why the identity API carries it instead.
 *
 * Known remaining hard-deniers on this boolean, tracked in #5652: the RPC
 * surfaces under server/worldmonitor/. They share this flattening, but NOT one
 * response shape — the #5652 fix has to handle both:
 *   - an in-body `errorType: 'AuthError'` (only summarize-article.ts does this)
 *   - a thrown `ApiError(403, ...)`, which server/error-mapper.ts renders as a
 *     plain `{ message }` with no `errorType` at all (run-scenario.ts,
 *     trigger-simulation.ts, get-scenario-status.ts, route-intelligence.ts,
 *     shipping/v2/{list-webhooks,register-webhook}.ts)
 * Neither envelope has an HTTP status of its own, so the fix is a different
 * shape than the two edge routes and is deliberately not bundled here.
 */
export async function isCallerPremium(request: Request): Promise<boolean> {
  return (await resolvePremiumCallerIdentity(request)).isPremium;
}
