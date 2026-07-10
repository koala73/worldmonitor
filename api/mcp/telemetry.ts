import { hashKeySync } from '../../server/_shared/usage-identity';
import type { McpAuthContext } from './types';

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------
// One structured log per `tools/call` (tag `mcp.toolcall`) and one per
// `initialize` (tag `mcp.tools_list_emitted`). Vercel log drain → analytics
// consumer reads these as production data on payload sizes, JMESPath
// adoption %, latency P95, and tool usage histogram. Gated behind
// `MCP_TELEMETRY` so tests that snapshot stdout can suppress noise; default
// ON in every other environment.
//
// Payload is passed to `console.log` as an object (not a pre-stringified
// blob) so Vercel's logs UI renders it as a collapsible structured tree
// instead of one long horizontal line. The Edge runtime serializes objects
// to JSON when forwarding to log drains, so downstream parsers still see
// valid JSON.
export function telemetryEnabled(): boolean {
  const v = process.env.MCP_TELEMETRY;
  return v !== 'false' && v !== '0';
}
export function emitTelemetry(event: string, payload: Record<string, unknown>): void {
  if (!telemetryEnabled()) return;
  try {
    console.log({ tag: event, ts: new Date().toISOString(), ...payload });
  } catch {
    // Never throw out of telemetry — a serializer failure on an unexpected
    // payload value must not break the request path.
  }
}

// Closed-key allowlists for the two telemetry events. Locking the schema at
// the module boundary makes "while-I'm-here" additions visible at code
// review: any new top-level key on an emitted line requires updating the
// matching allowlist below, and `tests/mcp-telemetry-schema.test.mjs`
// asserts the actual emitted JSON line keys ⊆ the declared set AND that
// none of `arguments`, `params`, `payload`, `response`, `content`, `text`,
// `result` ever appear here — those are request/response body fields and
// MUST NOT be logged.
//
// Both sets include `tag` + `ts` because `emitTelemetry` adds them to every
// line; the per-event payload keys follow the literal call-sites in
// dispatchToolsCall (both success + error path) and the `initialize`
// handler. Keep this in sync with those call-sites — the schema test will
// fail by name if you don't.
export const MCP_TOOLCALL_TELEMETRY_KEYS = Object.freeze([
  'tag',
  'ts',
  'tool',
  'auth_kind',
  'user_id',
  'latency_ms',
  'bytes_pre_jmespath',
  'bytes_post_jmespath',
  'jmespath_used',
  'jmespath_failed',
  'ok',
  'error_kind',
  'budget_exceeded',
] as const);

export const MCP_TOOLS_LIST_TELEMETRY_KEYS = Object.freeze([
  'tag',
  'ts',
  'auth_kind',
  'user_id',
  'tools_array_bytes',
  'tool_count',
  'client_user_agent',
] as const);

export const MCP_RATE_LIMIT_HIT_TELEMETRY_KEYS = Object.freeze([
  'tag',
  'ts',
  'auth_kind',
  'user_id',
  'principal_id',
  'dimension',
  'limit',
  'window_seconds',
] as const);

// Log-safe principal id derived from the resolved auth context:
//   - Pro / user_key: raw Clerk `userId` (internal ID, not a secret; matches
//              the REST gateway's `customer_id` convention — user_key carries
//              the resolved key OWNER, #4859).
//   - env_key: FNV-64 hash of the API key (secret — never log raw key
//              material; mirrors `principal_id` in
//              server/_shared/usage-identity.ts).
export function principalIdForLog(context: McpAuthContext): string {
  return context.kind === 'env_key' ? hashKeySync(context.apiKey) : context.userId;
}

export function emitMcpRateLimitHit(
  context: McpAuthContext,
  payload: { dimension: 'mcp_minute_burst'; limit: number; windowSeconds: number },
): void {
  emitTelemetry('mcp.rate_limit_hit', {
    auth_kind: context.kind,
    user_id: context.kind === 'pro' ? context.userId : null,
    principal_id: principalIdForLog(context),
    dimension: payload.dimension,
    limit: payload.limit,
    window_seconds: payload.windowSeconds,
  });
}
