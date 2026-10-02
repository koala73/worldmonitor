// #4866 — wm_api_usage emission for the MCP surface.
//
// /mcp rewrites straight to this handler and never passes server/gateway.ts,
// so before this module the endpoint had ZERO rows in Axiom: auth rejections,
// quota 429s, and successes were all invisible (the #4859 paying-customer
// diagnosis had to be reconstructed from REST-side rows). One RequestEvent is
// emitted per POST / SSE-replay GET via ctx.waitUntil, reusing the gateway's
// builders so the envelope is byte-compatible with REST rows and joinable on
// customer_id.
import {
  buildRequestEvent,
  deriveAcceptLanguage,
  deriveCountry,
  deriveExecutionRegion,
  deriveHost,
  deriveIp,
  deriveIpCity,
  deriveIpRegion,
  deriveReferer,
  deriveReqBytes,
  deriveRequestId,
  deriveSentryTraceId,
  deriveUserAgent,
  emitUsageEvents,
  type RequestReason,
  type WaitUntilCtx,
} from '../../server/_shared/usage';
import type { AuthKind } from '../../server/_shared/usage-identity';
import { TOOL_REGISTRY } from './registry/index';
import type { McpAuthContext } from './types';

// Which stage of the /mcp funnel produced the terminal Response. Set by the
// handler at each return site; combined with the HTTP status it maps onto the
// closed RequestReason union without parsing response bodies.
export type McpPhase =
  | 'auth'       // credential resolution rejected (invalid key/bearer, backend down)
  | 'precheck'   // identity ok, entitlement/token pre-check rejected
  | 'billing'    // pre-check rejected with a billing-verification denial (#4770)
  | 'limit'      // per-minute rate limit or fail-closed free-tier limiter outage
  | 'dispatch'   // tools/call quota (429) / reservation unavailable (503)
  // Unparseable JSON-RPC envelope (HTTP 200 + -32600) OR an over-cap request
  // body rejected before parsing (HTTP 413 + -32600, #7406). Both map to
  // `malformed_request`, matching server/gateway.ts's F14 convention for
  // body-size rejections; the HTTP status on the same event separates them.
  | 'malformed'
  | 'transport'  // method/SSE-transport level (405, replay 4xx)
  | 'migration'  // a product-host alias was refused before auth or dispatch
  | 'ok';        // served (JSON-RPC-level errors still ride HTTP 200 → ok)

/** Registry name lookup — cardinality bound for tool_name (#8403). */
const REGISTERED_TOOL_NAMES: ReadonlySet<string> = new Set(
  TOOL_REGISTRY.map((tool) => tool.name),
);

/**
 * JSON-RPC methods this transport serves — cardinality bound for rpc_method
 * (#8403 / Strix). Anything else collapses to `_unregistered` so client-minted
 * strings cannot inflate the Axiom dimension.
 */
const SERVED_RPC_METHODS: ReadonlySet<string> = new Set([
  'initialize',
  'notifications/initialized',
  'ping',
  'tools/list',
  'tools/call',
  'prompts/list',
  'prompts/get',
  'skills/list',
  'skills/get',
  'resources/list',
  'resources/templates/list',
  'resources/read',
  'logging/setLevel',
]);

/** Fixed bucket for methods outside SERVED_RPC_METHODS — one cardinality slot. */
const UNREGISTERED_RPC_METHOD = '_unregistered';

export interface McpUsage {
  phase: McpPhase;
  authKind: AuthKind;
  customerId: string | null;
  principalId: string | null;
  /** Set true for surfaces that must not emit (OPTIONS/HEAD, manifest GET). */
  skip: boolean;
  /** Served JSON-RPC method, or `_unregistered` / null (#8403 cardinality). */
  rpcMethod: string | null;
  /** tools/call name when it matches TOOL_REGISTRY; never raw client input (#8403). */
  toolName: string | null;
}

export function createMcpUsage(): McpUsage {
  return {
    phase: 'ok',
    authKind: 'anon',
    customerId: null,
    principalId: null,
    skip: false,
    rpcMethod: null,
    toolName: null,
  };
}

/**
 * Record the JSON-RPC method (and, for tools/call, a registry-bounded tool
 * name) on the usage accumulator. Call once the envelope has been parsed —
 * before auth branches that may return early — so Axiom can distinguish
 * initialize / tools/list / tools/call without joining anything (#8403).
 *
 * Both fields are cardinality-bounded: methods outside SERVED_RPC_METHODS map
 * to `_unregistered`; tool names outside TOOL_REGISTRY stay null.
 */
export function setUsageRpc(
  usage: McpUsage,
  method: string,
  toolCallName?: unknown,
): void {
  usage.rpcMethod = SERVED_RPC_METHODS.has(method) ? method : UNREGISTERED_RPC_METHOD;
  if (usage.rpcMethod !== 'tools/call') {
    usage.toolName = null;
    return;
  }
  usage.toolName = typeof toolCallName === 'string' && REGISTERED_TOOL_NAMES.has(toolCallName)
    ? toolCallName
    : null;
}

/** Attribute the resolved principal. env_key principals are operator keys —
 *  never log raw key material; the hashed principal is already covered by the
 *  gateway's convention of leaving customer_id null for enterprise keys. */
export function setUsageContext(usage: McpUsage, context: McpAuthContext): void {
  if (context.kind === 'pro') {
    usage.authKind = 'mcp_oauth';
    usage.customerId = context.userId;
    usage.principalId = context.userId;
    return;
  }
  if (context.kind === 'user_key') {
    usage.authKind = 'user_api_key';
    usage.customerId = context.userId;
    usage.principalId = context.userId;
    return;
  }
  if (context.kind === 'free') {
    // U7: a free-tier caller is anonymous — no customer, no principal. Without
    // this arm it would fall through to `enterprise_api_key` below and every
    // free call would report as enterprise traffic in Axiom, corrupting the
    // one dataset the free tier is supposed to be measured by.
    usage.authKind = 'anon';
    usage.customerId = null;
    usage.principalId = null;
    return;
  }
  usage.authKind = 'enterprise_api_key';
}

export function mcpReasonFor(phase: McpPhase, status: number): RequestReason {
  switch (phase) {
    case 'auth':
      return status === 503 ? 'auth_unavailable' : 'auth_401';
    case 'precheck':
      return status === 503 ? 'auth_unavailable' : 'tier_403';
    case 'billing':
      // Mirrors server/gateway.ts's classification of the same denial: a
      // billing-verification 503 is provider-verification churn, not the
      // auth backend being unreachable — keeping it out of auth_unavailable
      // stops Axiom outage alerts from paging on ordinary billing states.
      return status === 503 ? 'billing_verification_503' : 'tier_403';
    case 'limit':
      return status === 503 ? 'rate_limit_degraded' : 'rate_limit_429';
    case 'dispatch':
      if (status === 429) return 'rate_limit_429';
      if (status === 503) return 'rate_limit_degraded';
      return 'ok';
    case 'malformed':
      return 'malformed_request';
    case 'transport':
      return status === 405 ? 'method_not_allowed' : 'malformed_request';
    case 'migration':
      return 'canonical_endpoint_required';
    default:
      return 'ok';
  }
}

/**
 * Resolve response size for telemetry. A missing/invalid Content-Length is
 * unknown — return null. Never treat `Number(null) === 0` as a real size
 * (#8403): streamed/SSE MCP responses omit the header and used to land as
 * fake zeros next to genuinely empty bodies.
 */
export function resolveMcpResBytes(res: Response): number | null {
  const raw = res.headers.get('content-length');
  if (raw === null || raw === '') return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

/**
 * Build + register the request event on ctx.waitUntil. Must NEVER throw or
 * delay the response — all failure modes are swallowed (emitUsageEvents
 * already no-ops without USAGE_TELEMETRY/token and circuit-breaks on sink
 * errors).
 */
export function emitMcpRequestEvent(
  req: Request,
  res: Response,
  usage: McpUsage,
  durationMs: number,
  ctx?: WaitUntilCtx,
): void {
  if (!ctx || usage.skip) return;
  try {
    const pathname = (() => {
      try { return new URL(req.url).pathname; } catch { return '/mcp'; }
    })();
    const event = buildRequestEvent({
      requestId: deriveRequestId(req),
      domain: 'mcp',
      route: pathname,
      method: req.method,
      status: res.status,
      durationMs,
      reqBytes: deriveReqBytes(req),
      resBytes: resolveMcpResBytes(res),
      customerId: usage.customerId,
      principalId: usage.principalId,
      authKind: usage.authKind,
      // Tier/planKey are not re-resolved here — the pre-checks consume the
      // entitlement internally and the extra lookup isn't worth a second
      // Convex round-trip per request. Join on customer_id in Axiom instead.
      tier: 0,
      planKey: null,
      country: deriveCountry(req),
      ipCity: deriveIpCity(req),
      ipRegion: deriveIpRegion(req),
      executionRegion: deriveExecutionRegion(req),
      executionPlane: 'vercel-edge',
      originKind: 'mcp',
      cacheTier: 'no-store',
      ip: deriveIp(req),
      userAgent: deriveUserAgent(req),
      uaHash: null,
      referer: deriveReferer(req),
      acceptLanguage: deriveAcceptLanguage(req),
      host: deriveHost(req),
      sentryTraceId: deriveSentryTraceId(req),
      reason: mcpReasonFor(usage.phase, res.status),
      rpcMethod: usage.rpcMethod,
      toolName: usage.toolName,
    });
    emitUsageEvents(ctx, [event]);
  } catch {
    // Telemetry must never affect the response path.
  }
}
