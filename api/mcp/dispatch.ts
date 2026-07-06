// @ts-expect-error — JS module, no declaration file
import { readJsonFromUpstash } from '../_upstash-json.js';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from '../_sentry-edge.js';
import {
  PRO_DAILY_QUOTA_LIMIT,
  secondsUntilUtcMidnight,
} from '../../server/_shared/pro-mcp-token';
import { mcpErrorFingerprint } from './error-fingerprint';
import { argBool, summarizeData } from './filters';
import { evaluateFreshness } from './freshness';
import { applyJmespath } from './jmespath';
import { reserveQuota } from './quota';
import { TOOL_REGISTRY } from './registry/index';
import { rpcError, rpcOk, withMcpNoStore } from './rpc';
import {
  emitTelemetry,
  principalIdForLog,
  telemetryEnabled,
} from './telemetry';
import type { CacheToolDef, McpAuthContext, McpHandlerDeps } from './types';
import { utf8ByteLength } from './utils';

// ---------------------------------------------------------------------------
// Tool execution (cache tools — no _execute)
// ---------------------------------------------------------------------------
// Exported as a test seam (like `evaluateFreshness`) so the `_postFilter`
// throw/fall-back path can be exercised directly — it can't be triggered
// through the public handler because every registry `_postFilter` is
// defensively written and won't throw on JSON-RPC input.
export async function executeTool(
  tool: CacheToolDef,
  params: Record<string, unknown> = {},
): Promise<{ cached_at: string | null; stale: boolean; data: Record<string, unknown> }> {
  const reads = tool._cacheKeys.map(k => readJsonFromUpstash(k));
  const freshnessChecks = tool._freshnessChecks?.length
    ? tool._freshnessChecks
    : [{ key: tool._seedMetaKey, maxStaleMin: tool._maxStaleMin }];
  const metaReads = freshnessChecks.map((check) => readJsonFromUpstash(check.key));
  const [results, metas] = await Promise.all([Promise.all(reads), Promise.all(metaReads)]);
  const { cached_at, stale } = evaluateFreshness(freshnessChecks, metas);

  // F6: if every cache key returned null/undefined AND the tool actually
  // had keys configured, this is a degenerate-empty result (Redis transient
  // / stampede). Throw so dispatchToolsCall reports a normal tool-execution
  // failure; for Pro callers the already-reserved daily slot stays charged
  // because this check runs after the tool has executed.
  //
  // Cache-tools always have at least one key (validated in the registry
  // type). The all-null case is structurally distinguishable from "the
  // upstream returned an empty list" (which is a JSON value, not null).
  if (
    tool._cacheKeys.length > 0 &&
    results.every((v: unknown) => v === null || v === undefined)
  ) {
    throw new Error('cache_all_null');
  }

  const data: Record<string, unknown> = {};
  // Walk backward through ':'-delimited segments, skipping non-informative suffixes
  // (version tags, bare numbers, internal format names) to produce a readable label.
  const NON_LABEL = /^(v\d+|\d+|stale|sebuf)$/;
  tool._cacheKeys.forEach((key, i) => {
    const parts = key.split(':');
    let label = '';
    for (let idx = parts.length - 1; idx >= 0; idx--) {
      const seg = parts[idx] ?? '';
      if (!NON_LABEL.test(seg)) { label = seg; break; }
    }
    data[label || (parts[0] ?? key)] = results[i];
  });

  // Optional in-memory post-filter (declared per-tool, mirrors that tool's
  // inputSchema.properties). A filter bug must NEVER break the tool — on throw
  // we fall back to the unfiltered data and report to Sentry, because a
  // narrowing filter failing open is strictly safer than a -32603 to the user.
  //
  // The filter is handed a `structuredClone` of `data`, NOT `data` itself: the
  // helpers (narrowNested, capArrays, mapNested, ...) narrow in place, so a
  // mid-filter throw would otherwise leave `data` partially mutated and the
  // catch below would "fall back" to a half-narrowed object. Cloning keeps the
  // original pristine so the fall-through is genuinely the full payload.
  // Redis output is JSON-safe and the data map is small (tens of KB), so the
  // clone is cheap.
  let result: Record<string, unknown> = data;
  if (tool._postFilter) {
    try {
      result = tool._postFilter(structuredClone(data), params);
    } catch (err) {
      // Same minified-frame over-grouping guard as the tool-execution catch
      // below — key on step + tool + error type so a post-filter bug in one
      // tool doesn't merge into the shared api/mcp catch-all (WORLDMONITOR-T8).
      captureSilentError(err, {
        tags: { route: 'api/mcp', step: 'post-filter', tool: tool.name },
        fingerprint: mcpErrorFingerprint('post-filter', tool.name, err),
      });
      result = data;
    }
  }

  // Summary mode (issue #3678) — collapse to counts + samples. Applied AFTER
  // the filter so it composes (`country: "DE", summary: true` → counts/samples
  // for DE). Independent of filter success: a thrown filter still pristine-
  // summarises.
  if (argBool(params.summary)) result = summarizeData(result);

  return { cached_at, stale, data: result };
}

export async function dispatchToolsCall(
  req: Request,
  context: McpAuthContext,
  deps: McpHandlerDeps,
  body: { id?: unknown; params?: unknown },
  corsHeaders: Record<string, string>,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response> {
  const id = body.id ?? null;
  const p = body.params as { name?: string; arguments?: Record<string, unknown> } | null;
  if (!p || typeof p.name !== 'string') {
    return rpcError(id, -32602, 'Invalid params: missing tool name', corsHeaders);
  }
  const tool = TOOL_REGISTRY.find((t) => t.name === p.name);
  if (!tool) {
    return rpcError(id, -32602, `Unknown tool: ${p.name}`, corsHeaders);
  }

  // Pro-only INCR-first reservation. Both cache-only AND RPC tools count
  // toward the daily 50/day cap — EXCEPT `describe_tool` (v1.5.0), which
  // is metadata-only and is actively encouraged by SERVER_INSTRUCTIONS
  // when the compressed tools/list entry is ambiguous. Charging quota for
  // schema lookups would (a) discourage the LLM from using it, defeating
  // the v1.5.0 compression's UX hedge, and (b) lock out Pro users at the
  // 50/day cap from even seeing tool definitions. Exempt by name; rate-
  // limiter (60/min) still applies as the abuse guard.
  const isMetadataTool = p.name === 'describe_tool';
  // user_key (#4859) consumes the same per-user daily quota as pro: cache
  // tools read Upstash directly (no downstream gateway metering), so an
  // unquota'd user_key would be an unmetered data loophole bounded only by
  // the 60/min limiter. Raising API-plan MCP allowances above the Pro cap is
  // a deliberate follow-up, not a default.
  if ((context.kind === 'pro' || context.kind === 'user_key') && !isMetadataTool) {
    const reservation = await reserveQuota(context.userId, deps.redisPipeline);
    if (!reservation.ok) {
      if (reservation.reason === 'cap-exceeded') {
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32029, message: `Daily MCP quota exceeded (${PRO_DAILY_QUOTA_LIMIT}/day). Resets at next UTC midnight.` } }),
          { status: 429, headers: withMcpNoStore({ 'Content-Type': 'application/json', 'Retry-After': String(secondsUntilUtcMidnight()), ...corsHeaders }) },
        );
      }
      // Hard-cap correctness: NEVER dispatch on reservation failure.
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Service temporarily unavailable, retry in a moment.' } }),
        { status: 503, headers: withMcpNoStore({ 'Content-Type': 'application/json', 'Retry-After': '5', ...corsHeaders }) },
      );
    }
    // No caller-side rollback of the reservation: once we pass this point the
    // tool runs and the daily slot is charged for good (GHSA-hcq5). The only
    // rollback is INSIDE reserveQuota, for the pre-dispatch cap-exceeded case.
  }

  const jmespathArg = p.arguments?.jmespath;
  const jmespathUsed = typeof jmespathArg === 'string' && jmespathArg.length > 0;
  // tStart is captured AFTER the Pro reservation round-trip — `latency_ms`
  // reports time-in-tool, not time-in-tool-plus-time-in-quota-reservation.
  // TODO(v1.6.x): include `mcpTokenId` in the telemetry payload for Pro
  // contexts so downstream per-tenant aggregation can join on it. Out of
  // scope for v1 since the dashboards we ship next only need `auth_kind`.
  const tStart = Date.now();
  try {
    let result: unknown;
    if (tool._execute) {
      const baseUrl = new URL(req.url).origin;
      result = await tool._execute(p.arguments ?? {}, baseUrl, context);
    } else {
      result = await executeTool(tool, p.arguments ?? {});
    }
    // Convex `internal-validate-pro-mcp-token` schedules touchProMcpTokenLastUsed
    // itself (convex/http.ts:1035-1040), so no waitUntil needed here.
    //
    // Universal JMESPath projection (v1.4.0). `applyJmespath` never throws
    // — soft-failure modes return a `_jmespath_error` envelope as `text`
    // inside the normal response, so a bad expression is a *user* error after
    // a successful dispatch, not a thrown system error. Genuine tool-execution
    // throws (e.g. `cache_all_null`) still hit the catch below. Single
    // JSON.stringify per request when
    // telemetry is off; one extra stringify when MCP_TELEMETRY is enabled
    // so we can report `bytes_pre_jmespath` separately from the projected
    // size.
    const { text, failed } = applyJmespath(result, jmespathArg);
    const latencyMs = Date.now() - tStart;
    // Budget gate: always compute byte length for the budget check. This
    // replaces the previous telemetry-only perf gate for the post-JMESPath
    // measurement — budget enforcement requires the walk unconditionally.
    const textBytes = utf8ByteLength(text);
    const budget = tool._outputBudgetBytes;
    const budgetExceeded = textBytes > budget;
    if (telemetryEnabled()) {
      let bytesPre: number;
      if (jmespathUsed) {
        // Telemetry stringify must never escape into the outer catch — a
        // circular `result` with a clean JMESPath projection would otherwise
        // turn a successful request into a 5xx tool error. On
        // failure, report `bytes_pre_jmespath: -1` (sentinel: measurement
        // unavailable) and keep the response intact.
        try {
          const preStr = JSON.stringify(result);
          bytesPre = utf8ByteLength(preStr === undefined ? 'null' : preStr);
        } catch {
          bytesPre = -1;
        }
      } else {
        bytesPre = textBytes;
      }
      emitTelemetry('mcp.toolcall', {
        tool: tool.name,
        auth_kind: context.kind,
        user_id: principalIdForLog(context),
        latency_ms: latencyMs,
        bytes_pre_jmespath: bytesPre,
        bytes_post_jmespath: textBytes,
        jmespath_used: jmespathUsed,
        jmespath_failed: failed ?? null,
        ok: true,
        budget_exceeded: budgetExceeded,
      });
    }
    if (budgetExceeded) {
      // GHSA-hcq5: do NOT refund the Pro daily slot here. `_execute()` already
      // ran its full upstream fetch/compute before we measured the output, so
      // the cost is sunk — refunding let a Pro token drive unlimited real cost
      // by always exceeding the budget. The user still gets an actionable hint.
      const hint = jmespathUsed
        ? 'Response still exceeds tool output budget after JMESPath projection. Use a more selective expression to project fewer fields, or apply tool-level filters to narrow the result set.'
        : 'Response exceeds tool output budget. Use the jmespath argument to project only the fields you need, or apply filters to narrow the result set.';
      return rpcOk(id, { content: [{ type: 'text', text: JSON.stringify({
        _budget_exceeded: true,
        budget_bytes: budget,
        actual_bytes: textBytes,
        hint,
      }) }] }, corsHeaders);
    }
    return rpcOk(id, { content: [{ type: 'text', text }] }, corsHeaders);
  } catch (err: unknown) {
    // `latency_ms` is time-in-tool (from tStart, captured after the quota
    // reservation) so the P95 error-path dashboard isn't skewed by reservation
    // latency.
    const latencyMs = Date.now() - tStart;
    // GHSA-hcq5: do NOT refund the Pro daily slot on a tool-execution error.
    // `_execute()` above already incurred the upstream cost, so the slot stays
    // charged — refunding let a Pro token bypass the daily cap by driving calls
    // that reliably error after the costly fetch. Pre-execution failures
    // (reservation/validation) are handled before dispatch and never reach here.
    // HTTP 4xx from an internal sibling fetch (e.g. `feed-digest HTTP 401`)
    // is expected-but-trackable: transient HMAC/auth/quota drift, replay-window
    // skew, or a single user's expired context. Report at `warning` so single
    // occurrences don't drown real 5xx bugs in alerts; the pattern still
    // surfaces if it recurs. Non-HTTP errors and 5xx stay at default `error`.
    // Log-drain consumers (Vercel, Datadog) read console severity, so route
    // the `console.*` call to match the Sentry level — otherwise log alerts
    // fire on 4xx while Sentry does not, defeating the downgrade.
    const message = err instanceof Error ? err.message : String(err);
    const isClient4xx = /HTTP 4\d\d\b/.test(message);
    const log = isClient4xx ? console.warn : console.error;
    log('[mcp] tool execution error:', err);
    captureSilentError(err, {
      tags: { route: 'api/mcp', step: 'tool-execution', tool: tool.name },
      ctx,
      // Split the api/mcp catch-all (WORLDMONITOR-T8) into per-tool,
      // per-status groups — see api/mcp/error-fingerprint.ts.
      fingerprint: mcpErrorFingerprint('tool-execution', tool.name, err),
      ...(isClient4xx ? { level: 'warning' as const } : {}),
    });
    emitTelemetry('mcp.toolcall', {
      tool: tool.name,
      auth_kind: context.kind,
      user_id: principalIdForLog(context),
      latency_ms: latencyMs,
      bytes_pre_jmespath: 0,
      bytes_post_jmespath: 0,
      jmespath_used: jmespathUsed,
      jmespath_failed: null,
      ok: false,
      error_kind: isClient4xx ? 'client_4xx' : 'server_error',
      budget_exceeded: false,
    });
    return rpcError(id, -32603, 'Internal error: data fetch failed', corsHeaders);
  }
}
