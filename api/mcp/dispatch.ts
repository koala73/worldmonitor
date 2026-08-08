import { readExistsFlags, readJsonFromUpstash, redisPipeline } from '../_upstash-json.js';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from '../_sentry-edge.js';
import { secondsUntilUtcMidnight } from '../../server/_shared/pro-mcp-token';
import { getMcpBillingVerificationDenial } from './auth';
import { BillingDenialError } from './billing-denial';
import {
  BothSourcesFailedError,
  createMcpToolExecutionContext,
  downstreamErrorTags,
} from './downstream';
import { mcpErrorFingerprint } from './error-fingerprint';
import { argBool, summarizeData } from './filters';
import { evaluateFreshness } from './freshness';
import { applyJmespath } from './jmespath';
import { reserveQuota } from './quota';
import { TOOL_REGISTRY } from './registry/index';
import { rpcError, rpcOk, withMcpNoStore } from './rpc';
import { McpSourceUnavailableError } from './source-unavailable';
import {
  emitTelemetry,
  principalIdForLog,
  telemetryEnabled,
} from './telemetry';
import type {
  CacheToolDef,
  McpAuthContext,
  McpHandlerDeps,
  McpToolExecutionContext,
} from './types';
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
  now?: number,
): Promise<{
  cached_at: string | null;
  stale: boolean;
  activationUnknown?: true;
  contentFreshnessPendingUntil?: string;
  data: Record<string, unknown>;
}> {
  const reads = tool._cacheKeys.map(k => readJsonFromUpstash(k));
  const freshnessChecks = tool._freshnessChecks?.length
    ? tool._freshnessChecks
    : [{ key: tool._seedMetaKey, maxStaleMin: tool._maxStaleMin }];
  const metaReads = freshnessChecks.map((check) => readJsonFromUpstash(check.key));
  // #6080 deployment-order grace. Only checks declaring a content contract pay
  // for this read, so it is one extra command on get_chokepoint_status and
  // none at all on every other tool.
  const activationKeys = [...new Set(
    freshnessChecks
      .map((check) => check.contentFreshnessActivationKey)
      .filter((key): key is string => typeof key === 'string' && key !== ''),
  )];
  // EXISTS, not GET — the marker's meaning is presence, and both health
  // surfaces read it that way through the shared `readExistsFlags` helper.
  // Reading it as JSON instead would make MCP disagree with them for any marker
  // value that is not valid JSON, which is the same class of cross-surface
  // divergence #6080 exists to close.
  // redisPipeline never rejects — it returns null on any failure — so this
  // cannot turn a freshness hint into a hard tool-execution failure.
  const activationRead = activationKeys.length > 0
    ? redisPipeline(activationKeys.map((key) => ['EXISTS', key]))
    : Promise.resolve([]);
  const [results, metas, activationResults] = await Promise.all([
    Promise.all(reads),
    Promise.all(metaReads),
    activationRead,
  ]);
  // Three-valued on purpose: only a marker we actually read and found ABSENT
  // earns the deployment-order grace. An unreadable marker stays out of the
  // map, so evaluateFreshness evaluates the block and fails closed rather than
  // granting a grace that would never expire.
  const activationStates = readExistsFlags(activationResults, activationKeys);
  // A marker this tool needed could not be read, so `stale` below was computed
  // WITHOUT knowing whether the producer has ever published. Both health
  // surfaces publish exactly this as `activationUnknown` (api/health.js,
  // api/seed-health.js) for a reason api/health.js states outright: otherwise a
  // verdict resting on an unreadable marker is byte-identical to one resting on
  // evidence, and the two need different remediations. MCP alarmed on this but
  // told its CALLER nothing — `stale: true` looked the same whether the marker
  // was unreadable, the producer regressed, or the grace window closed. One
  // boolean drives both the alarm and the wire field so they cannot drift.
  const activationUnknown = activationKeys.length > 0
    && activationStates.size !== activationKeys.length;
  if (activationUnknown) {
    captureSilentError(new Error('mcp activation marker read failed'), {
      tags: { route: 'api/mcp', step: 'activation-marker', tool: tool.name },
    });
  }
  // Sample wall time AFTER the Redis reads, never at function entry. The same
  // rule api/health.js applies via snapshotNow(): a request that begins inside
  // an activation window but finishes after it must not report the grace as
  // still live, or MCP briefly disagrees with the health surfaces at the exact
  // instant the deadline passes. `now` stays injectable as a test seam.
  const evaluatedAt = now ?? Date.now();
  const { cached_at, stale, contentFreshnessPendingUntil } = evaluateFreshness(
    freshnessChecks,
    metas,
    evaluatedAt,
    activationStates,
  );

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
    data[tool._cacheLabels?.[key] || label || (parts[0] ?? key)] = results[i];
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
  if (argBool(params.summary)) result = tool._summarize ? tool._summarize(result) : summarizeData(result);

  return {
    cached_at,
    stale,
    ...(activationUnknown ? { activationUnknown: true } : {}),
    ...(contentFreshnessPendingUntil === undefined ? {} : { contentFreshnessPendingUntil }),
    data: result,
  };
}

export async function dispatchToolsCall(
  req: Request,
  context: McpAuthContext,
  deps: McpHandlerDeps,
  body: { id?: unknown; params?: unknown },
  corsHeaders: Record<string, string>,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
  // Daily allowance resolved by the context pre-check (api/mcp/auth.ts) from
  // the entitlement it already fetched. Omitted → `PRO_DAILY_QUOTA_LIMIT`;
  // null → unlimited. Only the `pro` context ever supplies one (KTD6), so a
  // caller that skips the pre-check simply inherits the plan default.
  mcpDailyLimit?: number | null,
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
  // toward the caller's daily cap — EXCEPT `describe_tool` (v1.5.0), which
  // is metadata-only and is actively encouraged by SERVER_INSTRUCTIONS
  // when the compressed tools/list entry is ambiguous. Charging quota for
  // schema lookups would (a) discourage the LLM from using it, defeating
  // the v1.5.0 compression's UX hedge, and (b) lock out Pro users at the
  // daily cap from even seeing tool definitions. Exempt by name; rate-
  // limiter (60/min) still applies as the abuse guard.
  const isMetadataTool = p.name === 'describe_tool';
  // user_key (#4859) consumes the same per-user daily quota as pro: cache
  // tools read Upstash directly (no downstream gateway metering), so an
  // unquota'd user_key would be an unmetered data loophole bounded only by
  // the 60/min limiter. Raising API-plan MCP allowances above the Pro cap is
  // a deliberate follow-up, not a default — which is why `mcpDailyLimit`
  // arrives unset for that kind (api/mcp/auth.ts::runUserKeyPreChecks).
  if ((context.kind === 'pro' || context.kind === 'user_key') && !isMetadataTool) {
    const reservation = await reserveQuota(context.userId, deps.redisPipeline, mcpDailyLimit);
    if (!reservation.ok) {
      if (reservation.reason === 'cap-exceeded') {
        // `floor` is the limit the reservation actually enforced, so the copy
        // can never quote a different number from the one that rejected.
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32029, message: `Daily MCP quota exceeded (${reservation.floor}/day). Resets at next UTC midnight.` } }),
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
  let execution: McpToolExecutionContext | undefined;
  try {
    let result: unknown;
    if (tool._execute) {
      execution = createMcpToolExecutionContext(req.url);
      result = await tool._execute(
        p.arguments ?? {},
        execution.downstreamOrigin,
        context,
        execution,
      );
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
    // A typed billing denial (incl. its 503 pending/failed variants) is an
    // expected, handled customer state — warning-level, not error-level, so
    // Sentry/log alerts don't page on ordinary billing churn.
    const isExpectedDenial = err instanceof BillingDenialError;
    const isExpectedSourceOutage = err instanceof McpSourceUnavailableError;
    const downstreamTags = downstreamErrorTags(err);
    const isBothFailed = err instanceof BothSourcesFailedError;
    const log = isClient4xx || isExpectedDenial || isExpectedSourceOutage ? console.warn : console.error;
    log('[mcp] tool execution error:', err);
    captureSilentError(err, {
      tags: {
        route: 'api/mcp',
        step: 'tool-execution',
        tool: tool.name,
        auth_kind: context.kind,
        ...(execution ? {
          inbound_host_class: execution.inboundHostClass,
          downstream_origin: execution.downstreamOriginTag,
        } : {}),
        ...downstreamTags,
      },
      ...(isBothFailed ? {
        extra: {
          civilian_failure_detail: err.civilianFailureDetail,
          military_failure_detail: err.militaryFailureDetail,
        },
      } : {}),
      ctx,
      // Split the api/mcp catch-all (WORLDMONITOR-T8) into per-tool,
      // per-status groups — see api/mcp/error-fingerprint.ts.
      fingerprint: mcpErrorFingerprint('tool-execution', tool.name, err),
      ...(isClient4xx || isExpectedDenial || isExpectedSourceOutage ? { level: 'warning' as const } : {}),
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
      error_kind: isClient4xx
        ? 'client_4xx'
        : isExpectedSourceOutage
          ? 'source_unavailable'
          : 'server_error',
      budget_exceeded: false,
    });
    // #4770: a mid-request billing denial from the gateway keeps its full
    // contract (status, Retry-After, X-Billing-Verification, data.code)
    // instead of flattening into the generic -32603. The pre-dispatch
    // entitlement gate catches most billing denials; this covers the window
    // between that pre-check and the tool's downstream fetch.
    if (err instanceof BillingDenialError) {
      const denial = getMcpBillingVerificationDenial(
        { billingStatus: err.billingCode, retryAfterSeconds: err.retryAfterSeconds },
        corsHeaders,
        id,
      );
      if (denial) return denial;
    }
    if (err instanceof McpSourceUnavailableError) {
      return rpcError(
        id,
        -32003,
        'Required data inputs are unavailable',
        corsHeaders,
        {
          retryable: true,
          stale: true,
          unavailable_inputs: err.unavailableInputs,
          failed_inputs: err.failedInputs,
        },
      );
    }
    return rpcError(id, -32603, 'Internal error: data fetch failed', corsHeaders);
  }
}
