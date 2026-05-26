import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
// @ts-expect-error — JS module, no declaration file
import { resolveBearerToContext } from '../_oauth-token.js';
// @ts-expect-error — JS module, no declaration file
import { timingSafeIncludes } from '../_crypto.js';
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
import { rpcError } from './rpc';
import type {
  AuthResolution,
  AuthResolutionRejected,
  McpAuthContext,
  McpHandlerDeps,
} from './types';

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

function getMcpRatelimit(): Ratelimit | null {
  if (mcpRatelimit) return mcpRatelimit;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  mcpRatelimit = new Ratelimit({
    redis: new Redis({ url, token }),
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
    redis: new Redis({ url, token }),
    limiter: Ratelimit.slidingWindow(60, '60 s'),
    prefix: 'rl:mcp:pro-min',
    analytics: false,
  });
  return mcpProMinRatelimit;
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
  if (context.kind === 'env_key') {
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
          { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '5', ...corsHeaders } },
        ),
      };
    }
    if (!context) {
      return {
        ok: false,
        response: new Response(
          JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Invalid or expired OAuth token. Re-authenticate via /oauth/token.' } }),
          { status: 401, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': wwwAuthHeader(resourceMetadataUrl, 'invalid_token'), ...corsHeaders } },
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
        { status: 401, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': wwwAuthHeader(resourceMetadataUrl), ...corsHeaders } },
      ),
    };
  }
  const validKeys = (process.env.WORLDMONITOR_VALID_KEYS || '').split(',').filter(Boolean);
  if (!await timingSafeIncludes(candidateKey, validKeys)) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Invalid API key' } }),
        { status: 401, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': wwwAuthHeader(resourceMetadataUrl, 'invalid_token'), ...corsHeaders } },
      ),
    };
  }
  return { ok: true, context: { kind: 'env_key', apiKey: candidateKey } };
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
      { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '5', ...corsHeaders } },
    );
  }

  const validation = await deps.validateProMcpToken(context.mcpTokenId);
  if (!validation || validation.userId !== context.userId) {
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'MCP authorization revoked. Re-authorize at https://worldmonitor.app/mcp-grant.' } }),
      { status: 401, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': wwwAuthHeader(resourceMetadataUrl, 'invalid_token'), ...corsHeaders } },
    );
  }

  let ent: Awaited<ReturnType<typeof deps.getEntitlements>> = null;
  try {
    ent = await deps.getEntitlements(context.userId);
  } catch (err) {
    // Fail-closed per memory `entitlement-signal-server-outlier-sweep`.
    captureSilentError(err, { tags: { route: 'api/mcp', step: 'pro-entitlement-recheck' }, ctx });
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Subscription not active.' } }),
      { status: 401, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': wwwAuthHeader(resourceMetadataUrl, 'invalid_token'), ...corsHeaders } },
    );
  }
  const tier = ent?.features?.tier ?? 0;
  const mcpAccess = ent?.features?.mcpAccess === true;
  const validUntil = ent?.validUntil ?? 0;
  if (!ent || tier < 1 || !mcpAccess || validUntil < Date.now()) {
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Subscription not active.' } }),
      { status: 401, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': wwwAuthHeader(resourceMetadataUrl, 'invalid_token'), ...corsHeaders } },
    );
  }
  return null;
}

/** Per-minute rate limit. Both paths fail-OPEN on Upstash error (graceful);
 *  the daily quota is the hard-cap fail-CLOSED gate. Returns null on success
 *  or pass-through, a Response on a real 60/min limit hit. */
export async function applyPerMinuteLimit(context: McpAuthContext): Promise<Response | null> {
  if (context.kind === 'env_key') {
    const rl = getMcpRatelimit();
    if (!rl) return null;
    try {
      const { success } = await rl.limit(`key:${context.apiKey}`);
      if (!success) return rpcError(null, -32029, 'Rate limit exceeded. Max 60 requests per minute per API key.');
    } catch { /* graceful degradation */ }
    return null;
  }
  const rl = getMcpProMinRatelimit();
  if (!rl) return null;
  try {
    const { success } = await rl.limit(`pro-user:${context.userId}`);
    if (!success) return rpcError(null, -32029, 'Rate limit exceeded. Max 60 requests per minute per Pro user.');
  } catch { /* graceful degradation */ }
  return null;
}
