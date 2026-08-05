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
import type { McpAuthContext } from './types';

// Which stage of the /mcp funnel produced the terminal Response. Set by the
// handler at each return site; combined with the HTTP status it maps onto the
// closed RequestReason union without parsing response bodies.
export type McpPhase =
  | 'auth'       // credential resolution rejected (invalid key/bearer, backend down)
  | 'precheck'   // identity ok, entitlement/token pre-check rejected
  | 'billing'    // pre-check rejected with a billing-verification denial (#4770)
  | 'limit'      // per-minute rate limit
  | 'dispatch'   // tools/call quota (429) / reservation unavailable (503)
  | 'malformed'  // unparseable JSON-RPC envelope
  | 'transport'  // method/SSE-transport level (405, replay 4xx)
  | 'ok';        // served (JSON-RPC-level errors still ride HTTP 200 → ok)

export interface McpUsage {
  phase: McpPhase;
  authKind: AuthKind;
  customerId: string | null;
  principalId: string | null;
  /** Set true for surfaces that must not emit (OPTIONS/HEAD, manifest GET). */
  skip: boolean;
}

export function createMcpUsage(): McpUsage {
  return { phase: 'ok', authKind: 'anon', customerId: null, principalId: null, skip: false };
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
      return 'rate_limit_429';
    case 'dispatch':
      if (status === 429) return 'rate_limit_429';
      if (status === 503) return 'rate_limit_degraded';
      return 'ok';
    case 'malformed':
      return 'malformed_request';
    case 'transport':
      return status === 405 ? 'method_not_allowed' : 'malformed_request';
    default:
      return 'ok';
  }
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
    const resBytesRaw = Number(res.headers.get('content-length'));
    const event = buildRequestEvent({
      requestId: deriveRequestId(req),
      domain: 'mcp',
      route: pathname,
      method: req.method,
      status: res.status,
      durationMs,
      reqBytes: deriveReqBytes(req),
      resBytes: Number.isFinite(resBytesRaw) && resBytesRaw >= 0 ? resBytesRaw : 0,
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
    });
    emitUsageEvents(ctx, [event]);
  } catch {
    // Telemetry must never affect the response path.
  }
}
