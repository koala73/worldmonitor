import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
// @ts-expect-error — JS module, no declaration file
import { jsonResponse } from '../_json-response.js';
// @ts-expect-error — JS module, no declaration file
import { resolveBearerToContext } from '../_oauth-token.js';
// @ts-expect-error — JS module, no declaration file
import { timingSafeIncludes } from '../_crypto.js';
// @ts-expect-error — JS module, no declaration file
import { getClientIp, hasCloudflareTransitProof } from '../_client-ip.js';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from '../_sentry-edge.js';
import { redisPipeline as rawRedisPipeline } from '../_upstash-json.js';
import { resolvePlanDrivenMcpAllowance } from './quota';
import {
  getBillingVerificationDenial,
  getEntitlements,
  isEntitlementBackendConfigured,
} from '../../server/_shared/entitlement-check';
import { checkProMcpAccess } from '../../server/_shared/pro-mcp-gate';
import type { BillingVerificationCode } from './billing-denial';
import {
  buildInternalMcpHeaders,
  signInternalMcpRequest,
} from '../../server/_shared/mcp-internal-hmac';
import { validateProMcpToken } from '../../server/_shared/pro-mcp-token';
import { validateUserApiKey } from '../../server/_shared/user-api-key';
import {
  checkFailClosedScopedIpRateLimit,
  RATE_LIMIT_DEGRADED_HEADERS,
  reportRateLimitDegraded,
} from '../../server/_shared/rate-limit';
import { rpcError, withMcpNoStore } from './rpc';
import type {
  AuthResolution,
  AuthResolutionRejected,
  McpAuthContext,
  McpHandlerDeps,
  McpPreCheckResult,
} from './types';
import { emitMcpRateLimitHit } from './telemetry';
import { FREE_ACCOUNT_CALLS_PER_DAY } from './upgrade-constants';
import { buildMcpStructuredDenial, type McpDenialReason } from './upgrade';

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------
//   - Legacy per-key 60/min (Starter+ env-key bearers): prefix `rl:mcp`,
//     keyed `key:<apiKey>`. Unchanged from pre-U7.
//   - Pro per-user 60/min: prefix `rl:mcp:pro-min`, keyed `pro-user:<userId>`.
//     Independent limiter so a Pro user with two Claude installations sees
//     combined 60/min across both bearers (same userId).
// ---------------------------------------------------------------------------

let mcpRatelimit: Ratelimit | null = null;
let mcpProMinRatelimit: Ratelimit | null = null;
// Anonymous MCP discovery limiter (initialize / tools/list without credentials).
// Keyed by client IP so a public discovery surface can't be hammered by an
// unauthenticated caller. Separate prefix from the authed per-key/per-user
// limiters above so anon traffic never shares a bucket with a real principal.
let mcpAnonRatelimit: Ratelimit | null = null;

function getMcpRatelimit(): Ratelimit | null {
  if (mcpRatelimit) return mcpRatelimit;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  mcpRatelimit = new Ratelimit({
    redis: new Redis({ url, token, retry: false }),
    limiter: Ratelimit.slidingWindow(60, '60 s'),
    prefix: 'rl:mcp',
    analytics: false,
  });
  return mcpRatelimit;
}

function getMcpProMinRatelimit(): Ratelimit | null {
  if (mcpProMinRatelimit) return mcpProMinRatelimit;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  mcpProMinRatelimit = new Ratelimit({
    redis: new Redis({ url, token, retry: false }),
    limiter: Ratelimit.slidingWindow(60, '60 s'),
    prefix: 'rl:mcp:pro-min',
    analytics: false,
  });
  return mcpProMinRatelimit;
}

function getMcpAnonRatelimit(): Ratelimit | null {
  if (mcpAnonRatelimit) return mcpAnonRatelimit;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  mcpAnonRatelimit = new Ratelimit({
    redis: new Redis({ url, token, retry: false }),
    limiter: Ratelimit.slidingWindow(60, '60 s'),
    prefix: 'rl:mcp:anon',
    analytics: false,
  });
  return mcpAnonRatelimit;
}

/**
 * Build the Authorization header set for a downstream `_execute` fetch.
 *
 *   - env_key → `X-WorldMonitor-Key: <apiKey>` (existing, unchanged).
 *   - pro     → `X-WM-MCP-Internal: <ts>.<sig>` + `X-WM-MCP-User-Id: <userId>`.
 *               Signature binds method+pathname+queryHash+bodyHash+userId.
 *
 * `body` MUST be the EXACT bytes the caller passes to `fetch()` so the
 * signed payload matches the wire bytes. For JSON, pre-stringify on the
 * caller side and pass the same string here.
 */
export async function buildAuthHeaders(
  context: McpAuthContext,
  method: string,
  url: string,
  body: BodyInit | null | undefined,
): Promise<Record<string, string>> {
  if (context.kind === 'env_key' || context.kind === 'user_key') {
    // user_key (#4859): the downstream REST gateway validates the raw key
    // itself (Convex hash lookup + the #4611 apiAccess gate + per-account
    // limits), so usage attributes to the key owner exactly like a direct
    // REST call — no internal-HMAC identity smuggling needed.
    return { 'X-WorldMonitor-Key': context.apiKey };
  }
  if (context.kind === 'free') {
    // U7: a free-tier context has no principal to authenticate as, so there is
    // nothing honest to sign. Throwing is the fail-closed choice — the
    // alternative (falling through to the `pro` HMAC branch below) would mint
    // an internally-trusted signature for an anonymous caller, which is the
    // one outcome the free tier must never produce. A free-tier tool that
    // reaches here is misconfigured: it declared `_freeTier` while calling a
    // credentialed downstream.
    throw new Error('buildAuthHeaders: free-tier context has no credentials — a free-tier tool must not call a credentialed downstream');
  }
  // context.kind === 'pro'
  const secret = process.env.MCP_INTERNAL_HMAC_SECRET ?? '';
  if (!secret) {
    // Should never happen in production (deploy gate at U10) — surface as
    // an error so the tool fetch fails fast rather than silently 401-ing
    // at the gateway with a confusing "invalid_internal_mcp_signature".
    throw new Error('MCP_INTERNAL_HMAC_SECRET not configured');
  }
  const signed = await signInternalMcpRequest({
    method,
    url,
    body,
    userId: context.userId,
    secret,
  });
  return buildInternalMcpHeaders(signed);
}

export const PRODUCTION_DEPS: McpHandlerDeps = {
  resolveBearerToContext,
  // Preserve the validator's revoked/transient distinction: revoked grants
  // are 401 invalid_token, while a Convex/network outage is a retryable 503.
  validateProMcpToken,
  getEntitlements,
  validateUserApiKey,
  guardUserApiKeyValidation: (request, corsHeaders) => checkFailClosedScopedIpRateLimit(
    request,
    'mcp:user-api-key:pre-auth-validation',
    60,
    '60 s',
    corsHeaders,
  ),
  redisPipeline: rawRedisPipeline,
};

// ---------------------------------------------------------------------------
// Auth + Pro-pre-check helpers (extracted from mcpHandler so the top-level
// handler stays under the cognitive-complexity threshold).
// ---------------------------------------------------------------------------

export function wwwAuthHeader(resourceMetadataUrl: string, errorParam = ''): string {
  const errSegment = errorParam ? `, error="${errorParam}"` : '';
  return `Bearer realm="worldmonitor"${errSegment}, resource_metadata="${resourceMetadataUrl}"`;
}

/**
 * JSON-RPC denial with machine-readable reason + upgrade URL (#6716).
 * Defaults to HTTP 401 + WWW-Authenticate for auth-shaped denials. Callers may
 * select a terminal 403/-32002 denial; those responses deliberately omit the
 * Bearer challenge so clients do not enter an OAuth retry loop.
 */
export function mcpStructuredDenialResponse(
  reason: McpDenialReason,
  resourceMetadataUrl: string,
  corsHeaders: Record<string, string>,
  id: unknown = null,
  opts?: { wwwAuthError?: string; message?: string; code?: number; status?: number },
): Response {
  const built = buildMcpStructuredDenial(reason);
  const { data } = built;
  // A caller may keep its own, more specific `message` (e.g. the credential
  // mechanics on the auth-resolution 401s) while still gaining the machine-
  // readable `data`. Overriding the message never changes `data.reason`, so an
  // agent branching on the reason sees one vocabulary regardless of copy.
  const message = opts?.message ?? built.message;
  const status = opts?.status ?? 401;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...corsHeaders,
  };
  if (status === 401) {
    headers['WWW-Authenticate'] = opts?.wwwAuthError !== undefined
      ? wwwAuthHeader(resourceMetadataUrl, opts.wwwAuthError)
      : wwwAuthHeader(resourceMetadataUrl, reason === 'no-account' ? '' : 'invalid_token');
  }
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: id ?? null,
      error: { code: opts?.code ?? -32001, message, data },
    }),
    {
      status,
      headers: withMcpNoStore(headers),
    },
  );
}

function userKeyValidationBackpressureResponse(
  response: Response,
  corsHeaders: Record<string, string>,
  id: unknown = null,
): Response {
  const limited = response.status === 429;
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: id ?? null,
      error: {
        code: limited ? -32029 : -32603,
        message: limited ? 'Too many requests' : 'Auth service temporarily unavailable. Try again.',
      },
    }),
    {
      status: response.status,
      headers: withMcpNoStore({
        ...Object.fromEntries(response.headers.entries()),
        ...corsHeaders,
        'Content-Type': 'application/json',
      }),
    },
  );
}

export function getMcpBillingVerificationDenial(
  entitlements: {
    billingStatus?: BillingVerificationCode;
    retryAfterSeconds?: number;
    // Transient entitlement-lookup failure marker from getEntitlements()
    // (server/_shared/entitlement-check.ts) — mapped to the same retryable
    // envelope as a gateway-synthesized entitlement_verification_unavailable.
    verificationUnavailable?: boolean;
  } | null | undefined,
  corsHeaders: Record<string, string>,
  id: unknown = null,
): Response | null {
  const billingStatus = entitlements?.verificationUnavailable
    ? 'entitlement_verification_unavailable'
    : entitlements?.billingStatus;
  if (billingStatus === 'entitlement_verification_unavailable') {
    // Gateway-synthesized backend-unreachable 503 (server/gateway.ts wm_-key
    // branch). The shared Convex-facing helper doesn't recognize this code, so
    // build the same retryable envelope here; clamp mirrors the shared helper.
    const raw = entitlements?.retryAfterSeconds;
    const retryAfter = Number.isFinite(raw)
      ? Math.max(1, Math.min(60, Math.ceil(raw as number)))
      : 5;
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: id ?? null,
        error: {
          code: -32603,
          message: 'Unable to verify API access. Retry shortly.',
          data: { code: billingStatus },
        },
      }),
      {
        status: 503,
        headers: new Headers({
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'Retry-After': String(retryAfter),
          'X-Billing-Verification': billingStatus,
        }),
      },
    );
  }

  // The shared helper owns status, retry normalization, no-store, and billing
  // headers. Its parameter asks only for the billing fields, so both the
  // McpHandlerDeps entitlement shape and dispatch's synthesized
  // BillingDenialError shape are directly assignable.
  const denial = getBillingVerificationDenial(
    billingStatus ? { billingStatus, retryAfterSeconds: entitlements?.retryAfterSeconds } : null,
    corsHeaders,
  );
  if (!denial || !billingStatus) return null;

  const retryable = denial.status === 503;
  const message = {
    subscription_lapsed: 'Subscription lapsed. Re-authenticating will not help — resubscribe to restore access.',
    renewal_verification_pending: 'Renewal verification pending. Retry shortly.',
    renewal_verification_failed: 'Renewal verification failed. Retry shortly.',
  }[billingStatus];
  const headers = new Headers(denial.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('Content-Type', 'application/json');

  // #6716 — confirmed lapse stays on the billing envelope (-32002 / 403) but
  // also carries the agent-facing upgrade attribution fields so clients can
  // distinguish lapsed-subscription from never-subscribed free accounts.
  const structured = billingStatus === 'subscription_lapsed'
    ? buildMcpStructuredDenial('lapsed-subscription')
    : null;

  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: id ?? null,
      error: {
        // -32002 is the confirmed-lapse code (HTTP 403, no WWW-Authenticate).
        // -32001 stays reserved for authentication failures at HTTP 401 per
        // docs/mcp-error-catalog.mdx — reusing it here sent doc-following
        // agents into a pointless OAuth re-auth loop.
        code: retryable ? -32603 : -32002,
        // #6716 F22: the MESSAGE stays the existing lapse copy. Its
        // "Re-authenticating will not help" clause is load-bearing — it is what
        // stops a doc-following agent from re-entering OAuth on a terminal
        // billing state, and docs/mcp-error-catalog.mdx quotes it verbatim.
        // The upgrade attribution belongs in `data`, which is additive, so
        // agents gain reason/nextStep/upgradeUrl without losing the warning.
        message,
        data: structured
          ? { code: billingStatus, ...structured.data }
          : { code: billingStatus },
      },
    }),
    { status: denial.status, headers },
  );
}

export async function resolveAuthContext(
  req: Request,
  deps: McpHandlerDeps,
  resourceMetadataUrl: string,
  corsHeaders: Record<string, string>,
  id: unknown = null,
): Promise<AuthResolution | AuthResolutionRejected> {
  const authHeader = req.headers.get('Authorization') ?? '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    let context: McpAuthContext | null;
    try {
      context = await deps.resolveBearerToContext(token);
    } catch {
      return {
        ok: false,
        response: new Response(
          JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code: -32603, message: 'Auth service temporarily unavailable. Try again.' } }),
          { status: 503, headers: withMcpNoStore({ 'Content-Type': 'application/json', 'Retry-After': '5', ...corsHeaders }) },
        ),
      };
    }
    if (!context) {
      // #6716 F19: SERVER_INSTRUCTIONS promises agents a structured denial with
      // reason + upgrade URL on unauthenticated gated calls. These auth-
      // resolution 401s are the ones an agent hits FIRST, so they must carry it
      // too — otherwise the promise holds only for the rarest branch. The
      // specific credential guidance stays as the message.
      return {
        ok: false,
        response: mcpStructuredDenialResponse('no-account', resourceMetadataUrl, corsHeaders, id, {
          wwwAuthError: 'invalid_token',
          message: 'Invalid or expired OAuth token. Re-authenticate via /oauth/token.',
        }),
      };
    }
    return { ok: true, context };
  }

  const candidateKey = req.headers.get('X-WorldMonitor-Key') ?? '';
  if (!candidateKey) {
    // #6716 F19: the single most common denial on this surface — no credential
    // at all against a gated tool. It now carries the same structured `data`
    // every other denial does, which is what SERVER_INSTRUCTIONS advertises.
    return {
      ok: false,
      response: mcpStructuredDenialResponse('no-account', resourceMetadataUrl, corsHeaders, id, {
        message: 'Authentication required. Use OAuth (/oauth/token) or pass your API key via X-WorldMonitor-Key header.',
      }),
    };
  }
  const validKeys = (process.env.WORLDMONITOR_VALID_KEYS || '').split(',').filter(Boolean);
  if (await timingSafeIncludes(candidateKey, validKeys)) {
    return { ok: true, context: { kind: 'env_key', apiKey: candidateKey } };
  }

  // #4859: customer-issued dashboard keys (Convex userApiKeys). The env
  // allowlist above holds only legacy operator keys; every key a user mints
  // in the dashboard lives in Convex — before this fallback, ALL of them got
  // "Invalid API key" here while the same keys worked on the REST gateway.
  // Identity resolution only: the owner's mcpAccess entitlement is enforced
  // at the gated-method pre-check (runUserKeyPreChecks), symmetric with the
  // pro path, so a lapsed owner can still list tools but never call them.
  if (candidateKey.startsWith('wm_')) {
    let userKey: { userId: string } | null = null;
    try {
      // Identity is not known until after this Convex-backed lookup, so the
      // normal per-user MCP limit cannot protect it. Bound rotating unknown
      // wm_ guesses by client IP first; otherwise each unique key evades the
      // per-hash negative cache and reaches the auth backend.
      const validationGuardResponse = await deps.guardUserApiKeyValidation(req, corsHeaders);
      if (validationGuardResponse) {
        return {
          ok: false,
          response: userKeyValidationBackpressureResponse(validationGuardResponse, corsHeaders, id),
        };
      }
      userKey = await deps.validateUserApiKey(candidateKey);
    } catch {
      // validateUserApiKey throws UserApiKeyUnavailableError when Convex is
      // unreachable/misconfigured — 503 mirrors the bearer path (not 401).
      return {
        ok: false,
        response: new Response(
          JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code: -32603, message: 'Auth service temporarily unavailable. Try again.' } }),
          { status: 503, headers: withMcpNoStore({ 'Content-Type': 'application/json', 'Retry-After': '5', ...corsHeaders }) },
        ),
      };
    }
    if (userKey) {
      return { ok: true, context: { kind: 'user_key', apiKey: candidateKey, userId: userKey.userId } };
    }
  }

  // #6716 F19: same structured payload as the other credential-less/bad-credential
  // denials, so an agent can branch on `data.reason` uniformly.
  return {
    ok: false,
    response: mcpStructuredDenialResponse('no-account', resourceMetadataUrl, corsHeaders, id, {
      wwwAuthError: 'invalid_token',
      message: 'Invalid API key',
    }),
  };
}

/**
 * Pro-only pre-checks: validate Convex row + cross-user-binding + entitlement
 * re-check. On success the result also carries the plan's daily MCP allowance
 * (plan 2026-07-25-001 U3) — this is the one place on the gated path that has
 * the entitlement object in hand, so resolving it here spares the dispatcher a
 * second Convex round-trip.
 */
export async function runProPreChecks(
  context: Extract<McpAuthContext, { kind: 'pro' }>,
  deps: McpHandlerDeps,
  resourceMetadataUrl: string,
  corsHeaders: Record<string, string>,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
  id: unknown = null,
): Promise<McpPreCheckResult> {
  // F12: Pro path is unusable without MCP_INTERNAL_HMAC_SECRET — every
  // tool fetch will throw inside buildAuthHeaders. Surface the misconfig
  // at auth-resolution time so operators see a single clear 503 rather
  // than a confusing mid-tool-fetch -32603. Belt-and-suspenders with the
  // U10 deploy gate; matches the runtime check in `buildAuthHeaders`.
  if (!process.env.MCP_INTERNAL_HMAC_SECRET) {
    captureSilentError(new Error('MCP_INTERNAL_HMAC_SECRET unset'), {
      tags: { route: 'api/mcp', step: 'pro-secret-preflight' },
      ctx,
    });
    return { ok: false, response: new Response(
      JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code: -32603, message: 'Service temporarily unavailable, retry in a moment.' } }),
      { status: 503, headers: withMcpNoStore({ 'Content-Type': 'application/json', 'Retry-After': '5', ...corsHeaders }) },
    ) };
  }

  const validation = await validateProMcpAuthorization(context, deps, resourceMetadataUrl, corsHeaders, ctx, id);
  if (!validation.ok) return validation;

  return checkMcpEntitlementGate(context.userId, deps, resourceMetadataUrl, corsHeaders, 'pro-entitlement-recheck', ctx, id);
}

/**
 * Re-check the durable Pro grant behind a bearer-derived context.
 *
 * Bearer parsing proves only that the signed token is structurally valid. The
 * authoritative mcpProTokens row can have been revoked since minting, so any
 * path that grants a credentialed per-user bucket must run this check first —
 * including always-free tools, which deliberately skip the entitlement and
 * daily-quota gates after the grant itself is validated.
 */
export async function validateProMcpAuthorization(
  context: Extract<McpAuthContext, { kind: 'pro' }>,
  deps: McpHandlerDeps,
  resourceMetadataUrl: string,
  corsHeaders: Record<string, string>,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
  id: unknown = null,
): Promise<McpPreCheckResult> {
  // #4860: this await was the only unguarded step on the gated path — the
  // wired helper never rejects today, but a rejection here previously escaped
  // mcpHandler (no top-level catch) as a raw 500 with zero Sentry. Fail
  // closed with the same retryable 503 shape as the bearer-resolve catch.
  let validation: Awaited<ReturnType<typeof deps.validateProMcpToken>> = null;
  try {
    validation = await deps.validateProMcpToken(context.mcpTokenId);
  } catch (err) {
    captureSilentError(err, { tags: { route: 'api/mcp', step: 'pro-token-validate' }, ctx });
    return { ok: false, response: new Response(
      JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code: -32603, message: 'Service temporarily unavailable, retry in a moment.' } }),
      { status: 503, headers: withMcpNoStore({ 'Content-Type': 'application/json', 'Retry-After': '5', ...corsHeaders }) },
    ) };
  }
  if (validation && 'ok' in validation && validation.ok === 'transient') {
    captureSilentError(new Error('Pro MCP token validation temporarily unavailable'), {
      tags: { route: 'api/mcp', step: 'pro-token-validate' },
      ctx,
    });
    return { ok: false, response: new Response(
      JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code: -32603, message: 'Service temporarily unavailable, retry in a moment.' } }),
      { status: 503, headers: withMcpNoStore({ 'Content-Type': 'application/json', 'Retry-After': '5', ...corsHeaders }) },
    ) };
  }
  const validationUserId = validation && 'ok' in validation
    ? (validation.ok === 'valid' ? validation.userId : null)
    : validation?.userId ?? null;
  if (!validationUserId || validationUserId !== context.userId) {
    return {
      ok: false,
      response: mcpStructuredDenialResponse('no-account', resourceMetadataUrl, corsHeaders, id, {
        wwwAuthError: 'invalid_token',
        message: 'MCP authorization revoked. Re-authorize at https://worldmonitor.app/mcp-grant.',
      }),
    };
  }
  return { ok: true };
}

/**
 * Shared mcpAccess entitlement gate for identity-resolved contexts (pro AND
 * user_key). Fail-closed per memory `entitlement-signal-server-outlier-sweep`.
 * Passes when the owner has an active tier>=1 + mcpAccess entitlement, or when
 * the shared gate confirms eligibility for the metered free-account path.
 * Authentication failures remain 401; terminal entitlement failures are 403;
 * unverifiable entitlement reads are retryable 503 responses.
 *
 * A passing result also reports `mcpDailyLimit`, read straight off the
 * entitlement this call already fetched — but only for plan-driven plan
 * families (`resolvePlanDrivenMcpAllowance`): API-tier subscribers reach this
 * gate through the same OAuth door, and their catalog allowance must not
 * out-rank the 50/day their `user_key` is capped at. A row with no
 * `planLimits` (legacy shape) or a non-plan-driven plan reports `undefined`,
 * which the quota layer resolves to the plan default — the entitlement is
 * NOT re-fetched to fill the gap.
 *
 * Only `free_account` is admitted to the metered allowance. Other insufficient
 * entitlement states remain auth denials; thrown or unverifiable reads remain
 * retryable availability failures.
 */
async function checkMcpEntitlementGate(
  userId: string,
  deps: McpHandlerDeps,
  resourceMetadataUrl: string,
  corsHeaders: Record<string, string>,
  sentryStep: string,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
  id: unknown = null,
): Promise<McpPreCheckResult> {
  /**
   * Availability failure, not a billing verdict. Mirrors the retryable shape
   * `validateProMcpAuthorization` already uses for its own catch — 503 denies
   * the call (still fail-closed) without asserting anything false about the
   * caller's subscription.
   */
  const unavailable = (): McpPreCheckResult => ({
    ok: false,
    response: new Response(
      JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code: -32603, message: 'Service temporarily unavailable, retry in a moment.' } }),
      { status: 503, headers: withMcpNoStore({ 'Content-Type': 'application/json', 'Retry-After': '5', ...corsHeaders }) },
    ),
  });

  let ent: Awaited<ReturnType<typeof deps.getEntitlements>> = null;
  try {
    ent = await deps.getEntitlements(userId);
  } catch (err) {
    captureSilentError(err, { tags: { route: 'api/mcp', step: sentryStep }, ctx });
    // #6716 F21: a THROWN entitlement lookup is the backend being unreachable.
    // Reporting it as 'no-account' told an already-authenticated caller — a
    // paying subscriber, possibly — to "sign in and subscribe", and buried a
    // real outage as a routine upsell. Fail closed on a retryable envelope.
    return unavailable();
  }
  const passed = (): McpPreCheckResult => ({
    ok: true,
    mcpDailyLimit: resolvePlanDrivenMcpAllowance(ent?.planKey, ent?.features?.planLimits?.mcpCallsPerDay),
  });
  // Single-source Pro MCP decision. A current fallback entitlement still wins
  // over billing uncertainty; this caller keeps the JSON-RPC denial rendering.
  const gate = checkProMcpAccess(ent, Date.now(), {
    backendConfigured: isEntitlementBackendConfigured(),
  });
  if (!gate) {
    return passed();
  }
  // Billing-verification states keep their existing envelopes (403/-32002 for
  // a confirmed lapse; 503 for renewal/unverifiable). Do not flatten a lapse
  // into the free-account structured 401 — agents must not OAuth-loop on
  // -32001 for a terminal billing state (docs/mcp-error-catalog.mdx).
  // getMcpBillingVerificationDenial already attaches upgrade attribution on
  // lapsed responses (#6716).
  if (gate.kind === 'billing_verification') {
    const billingDenial = getMcpBillingVerificationDenial(ent, corsHeaders, id);
    if (billingDenial) return { ok: false, response: billingDenial };
    // #6716 F10: reaching here means the gate classified a billing state that
    // `ent` alone cannot render — in practice `unverifiableEntitlementDenial`,
    // returned when the entitlement backend is unconfigured and getEntitlements
    // yields a bare null (entitlement-check.ts's own "MISCONFIGURATION HAZARD").
    // That state is RETRYABLE. Answering it with a terminal
    // 'lapsed-subscription' told a paying subscriber their subscription ended
    // because of OUR deploy misconfiguration — the exact retryable/terminal
    // flattening pro-mcp-gate.ts forbids, and the shape of #5600.
    return unavailable();
  }
  if (gate.kind === 'free_account') {
    // MCP call-site ONLY reinterpretation (#6716). OAuth issuance and the
    // gateway still refuse this verdict. Admission here is eligibility; the
    // idle-gap + call counters live in dispatch.
    return {
      ok: true,
      mcpDailyLimit: FREE_ACCOUNT_CALLS_PER_DAY,
      freeAccountAllowance: true,
    };
  }

  // A non-free insufficient entitlement (expired/disabled paid row or a
  // malformed shape) must not inherit the free allowance.
  return {
    ok: false,
    response: mcpStructuredDenialResponse('upgrade-required', resourceMetadataUrl, corsHeaders, id, {
      code: -32002,
      status: 403,
      message: 'Subscription not active.',
    }),
  };
}

/**
 * user_key (#4859) pre-check: the key row proved identity at auth-resolution
 * time; data methods must additionally verify the OWNER still has an active
 * mcpAccess entitlement. Without this, a user_key context would be the one
 * credential class that skips the entitlement gate (env_key is operator-owned
 * and intentionally ungated; pro re-checks on every gated call).
 */
export async function runUserKeyPreChecks(
  context: Extract<McpAuthContext, { kind: 'user_key' }>,
  deps: McpHandlerDeps,
  resourceMetadataUrl: string,
  corsHeaders: Record<string, string>,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
  id: unknown = null,
): Promise<McpPreCheckResult> {
  const gate = await checkMcpEntitlementGate(context.userId, deps, resourceMetadataUrl, corsHeaders, 'user-key-entitlement', ctx, id);
  // KTD6: the entitlement verdict applies, the plan's MCP allowance does NOT —
  // except the free-account paid-funnel ceiling (#6716), which is not a plan
  // catalog allowance. user_key callers otherwise stay on the hardcoded daily
  // cap whatever their API plan advertises.
  if (!gate.ok) return gate;
  if (gate.freeAccountAllowance) {
    return {
      ok: true,
      mcpDailyLimit: gate.mcpDailyLimit,
      freeAccountAllowance: true,
    };
  }
  return { ok: true };
}

/**
 * Kind-dispatched pre-checks for gated (data/quota) methods. env_key needs
 * none; pro and user_key each run their own. Single entry point so a future
 * context kind can't silently ship without deciding its gate (the tracer
 * finding on #4859: mapping user keys onto env_key would have bypassed
 * entitlements entirely).
 */
export async function runContextPreChecks(
  context: McpAuthContext,
  deps: McpHandlerDeps,
  resourceMetadataUrl: string,
  corsHeaders: Record<string, string>,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
  id: unknown = null,
): Promise<McpPreCheckResult> {
  if (context.kind === 'pro') {
    return runProPreChecks(context, deps, resourceMetadataUrl, corsHeaders, ctx, id);
  }
  if (context.kind === 'user_key') {
    return runUserKeyPreChecks(context, deps, resourceMetadataUrl, corsHeaders, ctx, id);
  }
  if (context.kind === 'free') {
    // U7: no entitlement to check — admission was already decided by the
    // free-tier roster in the handler, and the abuse ceiling there is what
    // bounds this caller. Reaching the entitlement gate would fail closed on a
    // caller who correctly has no entitlement.
    return { ok: true };
  }
  // env_key: operator-owned, ungated, and never metered by the daily counter.
  return { ok: true };
}

/** Per-minute rate limit. Both paths fail-OPEN on Upstash error (graceful);
 *  the daily quota is the hard-cap fail-CLOSED gate. Returns null on success
 *  or pass-through, a Response on a real 60/min limit hit.
 *  user_key (#4859) shares the per-USER limiter with pro — the principal is
 *  the key OWNER, so a user with an OAuth connection and a dashboard key gets
 *  one combined 60/min budget instead of two stackable ones. */
export async function applyPerMinuteLimit(context: McpAuthContext, headers: Record<string, string> = {}): Promise<Response | null> {
  if (context.kind === 'env_key') {
    const rl = getMcpRatelimit();
    if (!rl) return null;
    try {
      const { success } = await rl.limit(`key:${context.apiKey}`);
      if (!success) {
        emitMcpRateLimitHit(context, {
          dimension: 'mcp_minute_burst',
          limit: 60,
          windowSeconds: 60,
        });
        return rpcError(null, -32029, 'Rate limit exceeded. Max 60 requests per minute per API key.', headers);
      }
    } catch { /* graceful degradation */ }
    return null;
  }
  if (context.kind === 'free') {
    // U7: a free principal has no per-user bucket to key on — its ceiling is
    // `applyFreeTierLimit`, applied by IP on the anon branch before the context
    // is minted. Returning null here is not a bypass: this function is only
    // reached on the credentialed branch, and the free caller was already
    // bounded. Keying an anonymous caller into the per-USER limiter would be
    // worse than useless — every free caller would share one bucket.
    return null;
  }
  const rl = getMcpProMinRatelimit();
  if (!rl) return null;
  try {
    const { success } = await rl.limit(`pro-user:${context.userId}`);
    if (!success) {
      emitMcpRateLimitHit(context, {
        dimension: 'mcp_minute_burst',
        limit: 60,
        windowSeconds: 60,
      });
      return rpcError(null, -32029, 'Rate limit exceeded. Max 60 requests per minute per user.', headers);
    }
  } catch { /* graceful degradation */ }
  return null;
}

/** Per-IP rate limit for the UNAUTHENTICATED discovery path (initialize /
 *  tools/list without credentials — the metadata surface agent scanners probe).
 *  Keyed on the trusted client IP (cf-connecting-ip / x-real-ip; falls back to a
 *  shared bucket so x-forwarded-for spoofing can't rotate identities). Fail-OPEN
 *  on Upstash error, matching `applyPerMinuteLimit` — the discovery response is a
 *  cheap in-memory payload, so availability beats strict enforcement here.
 *  Returns null on success/skip, a Response on a real 60/min limit hit. */
export async function applyAnonDiscoveryLimit(req: Request, headers: Record<string, string> = {}): Promise<Response | null> {
  const rl = getMcpAnonRatelimit();
  if (!rl) return null;
  try {
    const { success } = await rl.limit(`ip:${getClientIp(req)}`);
    if (!success) return rpcError(null, -32029, 'Rate limit exceeded. Max 60 unauthenticated discovery requests per minute per IP.', headers);
  } catch { /* graceful degradation */ }
  return null;
}

// U7 (R15): the always-free tool subset's own ceiling, deliberately separate
// from the discovery limiter above.
//
// The discovery limiter's fail-OPEN is justified in its own comment by the
// response carrying no data — that justification does not survive contact with
// a tool that returns real data, so this one fails CLOSED: an unreachable
// limiter refuses the call rather than serving unlimited free data. The
// budget is also far tighter than 60/min, because 60/min sustained is ~86k
// free calls a day from a single IP.
const FREE_TIER_LIMIT_PER_MINUTE = 10;
let mcpFreeTierRatelimit: Ratelimit | null = null;
let freeTierMissingConfigReported = false;
let freeTierEdgeProofReported = false;

function getMcpFreeTierRatelimit(): Ratelimit | null {
  if (mcpFreeTierRatelimit) return mcpFreeTierRatelimit;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  mcpFreeTierRatelimit = new Ratelimit({
    redis: new Redis({ url, token, retry: false }),
    limiter: Ratelimit.slidingWindow(FREE_TIER_LIMIT_PER_MINUTE, '60 s'),
    prefix: 'rl:mcp:free',
    analytics: false,
  });
  return mcpFreeTierRatelimit;
}

function freeTierRateLimitDegradedResponse(id: unknown, headers: Record<string, string>): Response {
  return jsonResponse(
    {
      jsonrpc: '2.0',
      id: id ?? null,
      error: { code: -32603, message: 'Rate-limit service temporarily unavailable. Try again.' },
    },
    503,
    withMcpNoStore({ ...RATE_LIMIT_DEGRADED_HEADERS, ...headers }),
  );
}

function freeTierRateLimitExhaustedResponse(
  id: unknown,
  reset: number,
  headers: Record<string, string>,
): Response {
  const resetSeconds = Number.isFinite(reset)
    ? Math.max(1, Math.ceil((reset - Date.now()) / 1000))
    : 60;
  return jsonResponse(
    {
      jsonrpc: '2.0',
      id: id ?? null,
      error: {
        code: -32029,
        message: `Free-tier rate limit. Max ${FREE_TIER_LIMIT_PER_MINUTE} unauthenticated tool calls per minute per IP.`,
      },
    },
    429,
    withMcpNoStore({
      'RateLimit-Policy': `"mcp-free";q=${FREE_TIER_LIMIT_PER_MINUTE};w=60`,
      'RateLimit-Limit': String(FREE_TIER_LIMIT_PER_MINUTE),
      'RateLimit-Remaining': '0',
      'RateLimit-Reset': String(resetSeconds),
      RateLimit: `"mcp-free";r=0;t=${resetSeconds}`,
      'Retry-After': String(resetSeconds),
      ...headers,
    }),
  );
}

/**
 * Fail-CLOSED ceiling for uncredentialed calls to the always-free tool subset.
 * Returns null when the call may proceed, a Response when it must not — and a
 * Response (never null) when the limiter itself cannot be reached or errors.
 */
export async function applyFreeTierLimit(
  req: Request,
  headers: Record<string, string> = {},
  id: unknown = null,
): Promise<Response | null> {
  // A Cloudflare client-IP header without the configured transit proof makes
  // getClientIp fall back to the shared Cloudflare-PoP x-real-ip. For a tight
  // 10/min public-data budget that would turn one caller into a 429 for every
  // user on the PoP. Report the stable deployment drift once per isolate and
  // fail closed explicitly; the header itself is caller-controlled on a direct
  // origin request, so logging every rejection would create an amplification
  // path.
  if (req.headers.get('cf-connecting-ip') && !hasCloudflareTransitProof(req)) {
    if (!freeTierEdgeProofReported) {
      freeTierEdgeProofReported = true;
      reportRateLimitDegraded(
        'mcpFreeTierRateLimit:edge-proof',
        new Error('Cloudflare client IP arrived without a valid x-wm-edge-proof'),
        'api',
      );
    }
    return freeTierRateLimitDegradedResponse(id, headers);
  }
  const rl = getMcpFreeTierRatelimit();
  // No limiter configured is an UNBOUNDED free-data path, not a green light.
  if (!rl) {
    const stage = 'mcpFreeTierRateLimit:missing-config';
    // A deploy misconfiguration is stable for the lifetime of this isolate.
    // Report it once rather than emitting one identical Sentry event per call.
    if (!freeTierMissingConfigReported) {
      freeTierMissingConfigReported = true;
      reportRateLimitDegraded(
        stage,
        new Error('UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN missing'),
        'api',
      );
    }
    return freeTierRateLimitDegradedResponse(id, headers);
  }
  try {
    const result = await rl.limit(`ip:${getClientIp(req)}`);
    // @upstash/ratelimit can resolve a timeout as success:true rather than
    // rejecting. Treat that as unavailable, not as verified headroom.
    if (result.reason === 'timeout') {
      reportRateLimitDegraded(
        'mcpFreeTierRateLimit:timeout',
        new Error('Upstash free-tier rate-limit decision timed out'),
        'api',
      );
      return freeTierRateLimitDegradedResponse(id, headers);
    }
    if (!result.success) return freeTierRateLimitExhaustedResponse(id, result.reset, headers);
  } catch (err) {
    // Fail closed: an unreachable counter must not serve free data.
    reportRateLimitDegraded('mcpFreeTierRateLimit', err, 'api');
    return freeTierRateLimitDegradedResponse(id, headers);
  }
  return null;
}
