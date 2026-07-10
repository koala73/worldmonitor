import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
// @ts-expect-error — JS module, no declaration file
import { resolveBearerToContext } from '../_oauth-token.js';
// @ts-expect-error — JS module, no declaration file
import { timingSafeIncludes } from '../_crypto.js';
// @ts-expect-error — JS module, no declaration file
import { getClientIp } from '../_client-ip.js';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from '../_sentry-edge.js';
// @ts-expect-error — JS module, no declaration file
import { redisPipeline as rawRedisPipeline } from '../_upstash-json.js';
import { getEntitlements } from '../../server/_shared/entitlement-check';
import {
  buildInternalMcpHeaders,
  signInternalMcpRequest,
} from '../../server/_shared/mcp-internal-hmac';
import { validateProMcpTokenOrNull } from '../../server/_shared/pro-mcp-token';
import { validateUserApiKey } from '../../server/_shared/user-api-key';
import { rpcError, withMcpNoStore } from './rpc';
import type {
  AuthResolution,
  AuthResolutionRejected,
  McpAuthContext,
  McpHandlerDeps,
} from './types';
import { emitMcpRateLimitHit } from './telemetry';

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
  // Per-request validate path uses the legacy `userId | null` wrapper —
  // transient Convex blips fail-closed (401 prompts the client to retry
  // via OAuth, which is the correct safety direction here). The refresh-
  // grant path in api/oauth/token.ts uses the discriminated-union form
  // to distinguish revoked from transient (F3 of the U7+U8 review pass).
  validateProMcpToken: validateProMcpTokenOrNull,
  getEntitlements,
  validateUserApiKey,
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

export async function resolveAuthContext(
  req: Request,
  deps: McpHandlerDeps,
  resourceMetadataUrl: string,
  corsHeaders: Record<string, string>,
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
          JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Auth service temporarily unavailable. Try again.' } }),
          { status: 503, headers: withMcpNoStore({ 'Content-Type': 'application/json', 'Retry-After': '5', ...corsHeaders }) },
        ),
      };
    }
    if (!context) {
      return {
        ok: false,
        response: new Response(
          JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Invalid or expired OAuth token. Re-authenticate via /oauth/token.' } }),
          { status: 401, headers: withMcpNoStore({ 'Content-Type': 'application/json', 'WWW-Authenticate': wwwAuthHeader(resourceMetadataUrl, 'invalid_token'), ...corsHeaders }) },
        ),
      };
    }
    return { ok: true, context };
  }

  const candidateKey = req.headers.get('X-WorldMonitor-Key') ?? '';
  if (!candidateKey) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Authentication required. Use OAuth (/oauth/token) or pass your API key via X-WorldMonitor-Key header.' } }),
        { status: 401, headers: withMcpNoStore({ 'Content-Type': 'application/json', 'WWW-Authenticate': wwwAuthHeader(resourceMetadataUrl), ...corsHeaders }) },
      ),
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
      userKey = await deps.validateUserApiKey(candidateKey);
    } catch {
      // Production validateUserApiKey fail-softs to null; a throw means the
      // auth backend itself is unreachable — 503 mirrors the bearer path.
      return {
        ok: false,
        response: new Response(
          JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Auth service temporarily unavailable. Try again.' } }),
          { status: 503, headers: withMcpNoStore({ 'Content-Type': 'application/json', 'Retry-After': '5', ...corsHeaders }) },
        ),
      };
    }
    if (userKey) {
      return { ok: true, context: { kind: 'user_key', apiKey: candidateKey, userId: userKey.userId } };
    }
  }

  return {
    ok: false,
    response: new Response(
      JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Invalid API key' } }),
      { status: 401, headers: withMcpNoStore({ 'Content-Type': 'application/json', 'WWW-Authenticate': wwwAuthHeader(resourceMetadataUrl, 'invalid_token'), ...corsHeaders }) },
    ),
  };
}

/**
 * Pro-only pre-checks: validate Convex row + cross-user-binding + entitlement
 * re-check. Returns null on success; a 401 Response on any check failure.
 */
export async function runProPreChecks(
  context: Extract<McpAuthContext, { kind: 'pro' }>,
  deps: McpHandlerDeps,
  resourceMetadataUrl: string,
  corsHeaders: Record<string, string>,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response | null> {
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
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Service temporarily unavailable, retry in a moment.' } }),
      { status: 503, headers: withMcpNoStore({ 'Content-Type': 'application/json', 'Retry-After': '5', ...corsHeaders }) },
    );
  }

  // #4860: this await was the only unguarded step on the gated path — the
  // wired helper never rejects today, but a rejection here previously escaped
  // mcpHandler (no top-level catch) as a raw 500 with zero Sentry. Fail
  // closed with the same retryable 503 shape as the bearer-resolve catch.
  let validation: Awaited<ReturnType<typeof deps.validateProMcpToken>> = null;
  try {
    validation = await deps.validateProMcpToken(context.mcpTokenId);
  } catch (err) {
    captureSilentError(err, { tags: { route: 'api/mcp', step: 'pro-token-validate' }, ctx });
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Service temporarily unavailable, retry in a moment.' } }),
      { status: 503, headers: withMcpNoStore({ 'Content-Type': 'application/json', 'Retry-After': '5', ...corsHeaders }) },
    );
  }
  if (!validation || validation.userId !== context.userId) {
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'MCP authorization revoked. Re-authorize at https://worldmonitor.app/mcp-grant.' } }),
      { status: 401, headers: withMcpNoStore({ 'Content-Type': 'application/json', 'WWW-Authenticate': wwwAuthHeader(resourceMetadataUrl, 'invalid_token'), ...corsHeaders }) },
    );
  }

  return checkMcpEntitlementGate(context.userId, deps, resourceMetadataUrl, corsHeaders, 'pro-entitlement-recheck', ctx);
}

/**
 * Shared mcpAccess entitlement gate for identity-resolved contexts (pro AND
 * user_key). Fail-closed per memory `entitlement-signal-server-outlier-sweep`.
 * Returns null when the owner has an active tier>=1 + mcpAccess entitlement;
 * a 401 Response otherwise.
 */
async function checkMcpEntitlementGate(
  userId: string,
  deps: McpHandlerDeps,
  resourceMetadataUrl: string,
  corsHeaders: Record<string, string>,
  sentryStep: string,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response | null> {
  const rejected = () => new Response(
    JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Subscription not active.' } }),
    { status: 401, headers: withMcpNoStore({ 'Content-Type': 'application/json', 'WWW-Authenticate': wwwAuthHeader(resourceMetadataUrl, 'invalid_token'), ...corsHeaders }) },
  );

  let ent: Awaited<ReturnType<typeof deps.getEntitlements>> = null;
  try {
    ent = await deps.getEntitlements(userId);
  } catch (err) {
    captureSilentError(err, { tags: { route: 'api/mcp', step: sentryStep }, ctx });
    return rejected();
  }
  const tier = ent?.features?.tier ?? 0;
  const mcpAccess = ent?.features?.mcpAccess === true;
  const validUntil = ent?.validUntil ?? 0;
  if (!ent || tier < 1 || !mcpAccess || validUntil < Date.now()) {
    return rejected();
  }
  return null;
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
): Promise<Response | null> {
  return checkMcpEntitlementGate(context.userId, deps, resourceMetadataUrl, corsHeaders, 'user-key-entitlement', ctx);
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
): Promise<Response | null> {
  if (context.kind === 'pro') {
    return runProPreChecks(context, deps, resourceMetadataUrl, corsHeaders, ctx);
  }
  if (context.kind === 'user_key') {
    return runUserKeyPreChecks(context, deps, resourceMetadataUrl, corsHeaders, ctx);
  }
  return null;
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
