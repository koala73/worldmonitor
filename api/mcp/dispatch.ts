import { buildAttributionRider, mergeAttributionRider } from '../../shared/attribution-rider';
import { readExistsFlags, readJsonFromUpstash, redisPipeline } from '../_upstash-json.js';
import { isAppOwnedRedisKey } from '../_redis-key-ownership.js';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from '../_sentry-edge.js';
import { secondsUntilUtcMidnight } from '../../server/_shared/pro-mcp-token';
import { applyPerMinuteLimit, getMcpBillingVerificationDenial, wwwAuthHeader } from './auth';
import { BillingDenialError, RpcValidationError, ToolBackoffError } from './billing-denial';
import {
  BothSourcesFailedError,
  createMcpToolExecutionContext,
  downstreamErrorTags,
} from './downstream';
import { mcpErrorFingerprint } from './error-fingerprint';
import { argBool, summarizeData } from './filters';
import { evaluateFreshness } from './freshness';
import { applyJmespath } from './jmespath';
import { admitCountryPanel, admitForecastPanel, admitMarketPanel, admitNewsPanel, admitPredictionPanel, authorizePanelRead, PANEL_READ_LIMIT, PanelRequestError, type PaidPanelAdmission } from './panel-requests';
import { parseNewsDashboardRequest } from '../../shared/plugin-news-view';
import { forecastPanelReadSchema, marketPanelViewSchema, predictionPanelViewSchema, type PanelUsage } from '../../shared/panel-admission';
import { isSharedRestCounter, readDailyAllowance, reserveQuota, resolveDailyLimit, type McpBudget } from './quota';
import { reserveFreeAccountAllowance } from './free-account-allowance';
import { buildMcpStructuredDenial, type McpDenial } from './upgrade';
import { isQuotaExemptMetadataTool, toolAccess, toolWeight, TOOL_REGISTRY } from './registry/index';
import { rpcError, rpcOk, withMcpNoStore } from './rpc';
import { McpSourceUnavailableError } from './source-unavailable';
import { buildStructuredContent } from './structured-content';
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
// Currently the only stored-contract violation a post-filter can raise; add to this seam
// rather than widening the catch below if another dataset grows one.
import { isPhysicalDivergenceContractError as isMcpStoredContractError } from '../../server/_shared/physical-divergence-snapshot';

// ---------------------------------------------------------------------------
// Tool execution (cache tools — no _execute)
// ---------------------------------------------------------------------------
// Exported as a test seam (like `evaluateFreshness`) so the `_postFilter`
// throw/fall-back path can be exercised directly — it can't be triggered
// through the public handler for unexpected programming errors. Country
// validation errors are tested through dispatch and must propagate.
export async function executeTool(
  tool: CacheToolDef,
  params: Record<string, unknown> = {},
  now?: number,
  execution?: McpToolExecutionContext,
): Promise<{
  cached_at: string | null;
  stale: boolean;
  activationUnknown?: true;
  freshnessUnknown?: true;
  unreadable?: string[];
  contentFreshnessPendingUntil?: string;
  data: Record<string, unknown>;
}> {
  // Per-key namespace decision (#7674): most _cacheKeys / freshness keys are
  // written by the Railway seeder fleet and are read raw; the route-owned
  // exceptions (temporal anomalies snapshot + its stamp) ride the deployment
  // prefix so a preview deployment classifies its own producer instead of the
  // production rows.
  //
  // Each read is settled on its own. `readJsonFromUpstash` resolves null for a
  // miss but REJECTS when the request fails (AbortSignal.timeout, network
  // tear), and those two must stay apart: under a bare Promise.all one timed-out
  // key failed the whole tool as a raw TimeoutError (WORLDMONITOR-176/ZM/137),
  // while folding the failure into null would read an unreadable seed-meta as
  // "never seeded" and an unreadable data key as an empty section.
  const reads = tool._cacheKeys.map((k) => settleRead(readJsonFromUpstash(k, 3_000, !isAppOwnedRedisKey(k))));
  const freshnessChecks = tool._freshnessChecks;
  const metaReads = freshnessChecks.map((check) => settleRead(readJsonFromUpstash(check.key, 3_000, !isAppOwnedRedisKey(check.key))));
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
  // Activation markers are seeder-written (`seed-activated:*`) and are read
  // raw in every environment (#7674).
  const activationRead = activationKeys.length > 0
    ? redisPipeline(activationKeys.map((key) => ['EXISTS', key]), 5_000, true)
    : Promise.resolve([]);
  const [dataReads, metaOutcomes, activationResults] = await Promise.all([
    Promise.all(reads),
    Promise.all(metaReads),
    activationRead,
  ]);
  const results = dataReads.map((r) => (r.ok ? r.value : null));
  // An unreadable seed-meta enters evaluateFreshness as null, so `stale` fails
  // closed exactly as for an unreadable activation marker; `freshnessUnknown`
  // is what tells the caller the verdict rests on a read that failed.
  const metas = metaOutcomes.map((r) => (r.ok ? r.value : null));
  const freshnessUnknown = metaOutcomes.some((r) => !r.ok);
  const labels = tool._cacheKeys.map((key) => cacheKeyLabel(tool, key));
  const unreadable = labels.filter((_, i) => !dataReads[i]!.ok);
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
      fingerprint: ['api/mcp', 'activation-marker', 'Error'],
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
    // Nothing usable came back. If any of it was a failed read rather than a
    // genuine miss, that is Redis being unreachable, not an empty dataset:
    // report it as the source outage it is (warning level, own error kind).
    if (unreadable.length > 0) {
      throw new McpSourceUnavailableError(
        'cache_read_failed',
        labels.filter((_, i) => dataReads[i]!.ok),
        unreadable,
      );
    }
    throw new Error('cache_all_null');
  }
  if (unreadable.length > 0 || freshnessUnknown) {
    // The call still succeeds with what was readable, so nothing else would
    // record that Redis failed some reads. Warning level: one blip is noise,
    // a brownout escalates by volume under its own fingerprint.
    captureSilentError(new Error('mcp cache read failed'), {
      tags: { route: 'api/mcp', step: 'cache-read', tool: tool.name },
      extra: {
        unreadable,
        freshness_unreadable: freshnessChecks.filter((_, i) => !metaOutcomes[i]!.ok).map((check) => check.key),
      },
      fingerprint: ['api/mcp', 'cache-read', 'Error'],
      level: 'warning',
    });
  }

  const data: Record<string, unknown> = {};
  labels.forEach((label, i) => { data[label] = results[i]; });

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
      result = tool._postFilter(structuredClone(data), params, execution);
    } catch (err) {
      // Input validation must reach the caller instead of serving unfiltered data.
      // A stored-contract violation must NOT fall through to `data`: that path serves the
      // raw, unvalidated blob the filter just refused, which is the opposite of failing
      // closed (#6448 — an unknown state "must surface as an error, never silently map to
      // normal"). Let it out so the tool call errors instead.
      if (isMcpStoredContractError(err) || err instanceof RpcValidationError || execution?.panelScope === 'forecasts') throw err;
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
    ...(freshnessUnknown ? { freshnessUnknown: true } : {}),
    ...(unreadable.length > 0 ? { unreadable } : {}),
    ...(contentFreshnessPendingUntil === undefined ? {} : { contentFreshnessPendingUntil }),
    data: result,
  };
}

type SettledRead = { ok: true; value: unknown } | { ok: false };

function settleRead(read: Promise<unknown>): Promise<SettledRead> {
  return read.then((value) => ({ ok: true, value }), () => ({ ok: false }));
}

// Walk backward through ':'-delimited segments, skipping non-informative suffixes
// (version tags, bare numbers, internal format names) to produce a readable label.
const NON_LABEL = /^(v\d+|\d+|stale|sebuf)$/;

function cacheKeyLabel(tool: CacheToolDef, key: string): string {
  const parts = key.split(':');
  let label = '';
  for (let idx = parts.length - 1; idx >= 0; idx--) {
    const seg = parts[idx] ?? '';
    if (!NON_LABEL.test(seg)) { label = seg; break; }
  }
  return tool._cacheLabels?.[key] || label || (parts[0] ?? key);
}

/**
 * Structured JSON-RPC denial emitted from the dispatch seam (#6716).
 *
 * One builder for every denial here so the envelope cannot drift per site —
 * the drift that shipped an auth-shaped 401 for a quota state and a 401 with
 * no `WWW-Authenticate`. Callers choose code + status deliberately:
 *   -32001 / 401 — authentication (re-auth may help); MUST pass
 *                  `wwwAuthenticate` so RFC-9728 clients can discover metadata.
 *   -32002 / 403 — terminal entitlement denial (re-auth cannot help).
 *   -32029 / 429 — quota/allowance spent; pass `retryAfter`.
 */
function mcpDenialResponse(
  denial: McpDenial,
  code: number,
  status: number,
  id: unknown,
  corsHeaders: Record<string, string>,
  opts?: { retryAfter?: string; wwwAuthenticate?: string },
): Response {
  const { message, data } = buildMcpStructuredDenial(denial);
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, data } }),
    {
      status,
      headers: withMcpNoStore({
        'Content-Type': 'application/json',
        ...(opts?.retryAfter === undefined ? {} : { 'Retry-After': opts.retryAfter }),
        ...(opts?.wwwAuthenticate === undefined
          ? {}
          : { 'WWW-Authenticate': wwwAuthHeader(opts.wwwAuthenticate) }),
        ...corsHeaders,
      }),
    },
  );
}

/**
 * Reservation backend unreachable. Identical on both metering paths — a single
 * definition so the free branch and the Pro branch cannot answer the same
 * condition differently.
 */
function quotaBackendUnavailableResponse(
  id: unknown,
  corsHeaders: Record<string, string>,
): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Service temporarily unavailable, retry in a moment.' } }),
    { status: 503, headers: withMcpNoStore({ 'Content-Type': 'application/json', 'Retry-After': '5', ...corsHeaders }) },
  );
}

export async function dispatchToolsCall(
  req: Request,
  context: McpAuthContext,
  deps: McpHandlerDeps,
  body: { id?: unknown; params?: unknown },
  corsHeaders: Record<string, string>,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
  // Budget resolved by the context pre-check (api/mcp/auth.ts) from the
  // entitlement it already fetched: which counter to charge and its ceiling.
  // Omitted → the dedicated Pro counter at `PRO_DAILY_QUOTA_LIMIT`, so a caller
  // that skips the pre-check inherits the plan default rather than a wider cap.
  budget?: McpBudget,
  // Free-account paid-funnel path (#6716). When set, meters via the idle-gap
  // + call counters instead of reserveQuota.
  freeAccountAllowance?: boolean,
  // Resource-metadata URL for `WWW-Authenticate` on the 401 emitted here.
  // Optional so existing callers keep compiling; omitted → header omitted
  // rather than emitted with a guessed URL.
  resourceMetadataUrl?: string,
  toolBurstPerMinute?: number,
): Promise<Response> {
  const id = body.id ?? null;
  const p = body.params as { name?: string; arguments?: Record<string, unknown> } | null;
  const dedicatedPanel = !freeAccountAllowance && budget?.allowance !== 'api'
    && (context.kind === 'pro' || context.kind === 'user_key');
  const deferredBurst = toolBurstPerMinute !== undefined && dedicatedPanel && typeof p?.name === 'string' && p.arguments?.panel_request !== undefined
    && p.name !== 'open_country_brief' && p.name !== 'open_news_dashboard';
  if (toolBurstPerMinute !== undefined && !deferredBurst) {
    const limited = await applyPerMinuteLimit(context, corsHeaders, toolBurstPerMinute, id);
    if (limited) return limited;
  }
  if (!p || typeof p.name !== 'string') {
    return rpcError(id, -32602, 'Invalid params: missing tool name', corsHeaders);
  }
  const tool = TOOL_REGISTRY.find((t) => t.name === p.name);
  if (!tool) {
    if (deferredBurst) {
      const limited = await applyPerMinuteLimit(context, corsHeaders, toolBurstPerMinute, id);
      if (limited) return limited;
    }
    // Cap the echoed tool name — same reflection-amplification class as the
    // handler.ts method echo (see a2a.ts Greptile #4824 precedent).
    return rpcError(id, -32602, `Unknown tool: ${p.name.slice(0, 100)}`, corsHeaders);
  }

  // U7 fail-closed guard (defence in depth). A `free` principal is minted in
  // exactly one place — the handler's free-tier branch, after matching this
  // same `_freeTier` flag — but a free context reaching any other tool would be
  // an unauthenticated, unquota'd read of gated data. Re-checking here means
  // the promotion and the authorisation are not the same line of code, so a
  // future edit to the handler's matching cannot silently widen what a free
  // caller can reach.
  if (context.kind === 'free' && tool._freeTier !== true) {
    return mcpDenialResponse({ reason: 'no-account' }, -32001, 401, id, corsHeaders, {
      // Every 401 on this surface carries WWW-Authenticate — docs/mcp-error-catalog.mdx
      // states it as an invariant, and RFC-9728 clients discover the OAuth resource
      // metadata through it. `resourceMetadataUrl` is optional only because the
      // resources/read seam predates this parameter; when absent the header is
      // omitted rather than emitted with a wrong URL.
      wwwAuthenticate: resourceMetadataUrl,
    });
  }

  // Credentialed INCR-first reservation. Both cache-only AND RPC tools count
  // toward the caller's daily cap — EXCEPT free-tier tools and `describe_tool`
  // (v1.5.0). The latter is metadata-only and is actively encouraged by
  // SERVER_INSTRUCTIONS
  // when the compressed tools/list entry is ambiguous. Charging quota for
  // schema lookups would (a) discourage the LLM from using it, defeating
  // the v1.5.0 compression's UX hedge, and (b) lock out Pro users at the
  // daily cap from even seeing tool definitions. Exempt by name; rate-
  // limiter (60/min) still applies as the abuse guard.
  const isMetadataTool = isQuotaExemptMetadataTool(tool);

  // The free-account allowance covers only eligible cache-backed tools.
  // Explicit subscription tools (including sanctions cache reads) use the
  // same classifier as the advertised catalog and are denied before metering.
  // A tool with `_execute` fans out to server/gateway.ts, which runs its own
  // checkProMcpAccess re-check that this feature deliberately does not relax
  // (see api/mcp/types.ts's `freeAccountAllowance` note). Admitting one would
  // charge a free slot and then hand the caller a gateway 401 — burning the
  // day's allowance on errors it can never convert into data. Refuse BEFORE the
  // reservation so no slot is spent.
  //
  // Metadata and free-tier tools are exempt for the same reason they are exempt
  // from metering below: `describe_tool` has an `_execute`, but it is a purely
  // local registry read that never reaches the gateway, and it is the tool an
  // agent needs most while deciding what it may call.
  if (freeAccountAllowance && toolAccess(tool) === 'subscription') {
    return mcpDenialResponse({ reason: 'upgrade-required' }, -32002, 403, id, corsHeaders);
  }

  let panelRequest: PaidPanelAdmission | undefined;
  let panelUsage: PanelUsage | undefined;
  let panelRead: Awaited<ReturnType<typeof authorizePanelRead>> | undefined;
  const suppliedPanel = p.arguments?.panel_request;
  const callArguments = Object.fromEntries(Object.entries(p.arguments ?? {}).filter(([key]) => key !== 'panel_request'));
  let sourceArguments = callArguments;
  try {
    if (tool.name === 'get_prediction_markets') {
      if (!dedicatedPanel && ('refresh' in callArguments || 'request_id' in callArguments)) throw new PanelRequestError('Prediction refresh controls require a paid panel allowance.', 'invalid');
      if (dedicatedPanel) {
        const { summary: _summary, jmespath: _projection, ...view } = callArguments;
        const parsed = predictionPanelViewSchema.safeParse(view);
        if (!parsed.success) throw new PanelRequestError('Supply valid prediction filters and a request_id for refresh.', 'invalid');
        const { refresh, request_id: _requestId, ...filters } = parsed.data;
        sourceArguments = filters;
        if (suppliedPanel !== undefined && refresh) throw new PanelRequestError('Refresh the prediction panel without a reader token.', 'invalid');
        if (suppliedPanel === undefined) {
          panelRequest = await admitPredictionPanel(context, budget, deps.redisPipeline, parsed.data);
          panelUsage = panelRequest.usage;
          panelRead = await authorizePanelRead(context, deps.redisPipeline, tool.name, filters, panelRequest.token);
        }
      }
    }
    if (tool.name === 'get_market_data') {
      const { summary: _summary, jmespath: _projection, ...view } = callArguments;
      const parsed = marketPanelViewSchema.safeParse(view);
      if (!parsed.success) throw new PanelRequestError('Supply valid curated market filters and a request_id for refresh.', 'invalid');
      const { refresh, request_id: _requestId, ...filters } = parsed.data;
      sourceArguments = filters;
      if (suppliedPanel !== undefined && refresh) throw new PanelRequestError('Refresh the market panel without a reader token.', 'invalid');
      if (dedicatedPanel && suppliedPanel === undefined) {
        panelRequest = await admitMarketPanel(context, budget, deps.redisPipeline, parsed.data);
        panelUsage = panelRequest.usage;
        panelRead = await authorizePanelRead(context, deps.redisPipeline, tool.name, filters, panelRequest.token);
      }
    }
    if ((tool.name === 'get_forecast_case' || tool.name === 'get_forecast_theaters') && suppliedPanel === undefined) throw new PanelRequestError('Open a forecast panel before reading original evidence.', 'invalid');
    if (dedicatedPanel && tool.name === 'get_forecast_predictions' && suppliedPanel === undefined) {
      const admissionArgs = Object.fromEntries(Object.entries(callArguments).filter(([key]) => key !== 'jmespath' && key !== 'summary'));
      panelRequest = await admitForecastPanel(context, budget, deps.redisPipeline, admissionArgs);
      panelUsage = panelRequest.usage;
      const readArgs = forecastPanelReadSchema.parse(Object.fromEntries(Object.entries(admissionArgs).filter(([key]) => key !== 'refresh' && key !== 'request_id')));
      panelRead = await authorizePanelRead(context, deps.redisPipeline, tool.name, readArgs, panelRequest.token);
    } else if (dedicatedPanel && tool.name === 'open_country_brief') {
      panelRequest = await admitCountryPanel(context, budget, deps.redisPipeline, Object.fromEntries(Object.entries(callArguments).filter(([key]) => key !== 'jmespath')));
    } else if (dedicatedPanel && tool.name === 'open_news_dashboard') {
      if (suppliedPanel !== undefined) throw new PanelRequestError('Open or refresh the dashboard without a reader token.', 'invalid');
      panelRequest = await admitNewsPanel(context, budget, deps.redisPipeline, callArguments);
      panelRead = await authorizePanelRead(context, deps.redisPipeline, tool.name, {}, panelRequest.token);
    } else if (suppliedPanel !== undefined) {
      if (!dedicatedPanel || budget?.limit === 0) throw new PanelRequestError('This allowance does not support panel requests.', 'invalid');
      panelRead = await authorizePanelRead(context, deps.redisPipeline, tool.name,
        tool.name === 'get_forecast_predictions' || tool.name === 'get_forecast_case' || tool.name === 'get_forecast_theaters'
          ? callArguments
          : Object.fromEntries(Object.entries(sourceArguments).filter(([key]) => key !== 'jmespath')), suppliedPanel);
    }
    if (deferredBurst && panelRead) {
      const limited = await applyPerMinuteLimit(context, corsHeaders, PANEL_READ_LIMIT, id, { kind: 'panel', key: panelRead.rateLimitKey });
      if (limited) return limited;
    }
    await panelRead?.reserveUncachedRead();
    if ((tool.name === 'get_market_data' || tool.name === 'get_prediction_markets') && suppliedPanel !== undefined && panelRead
      && (context.kind === 'pro' || context.kind === 'user_key')) {
      const allowance = await readDailyAllowance(context.userId, deps.redisPipeline, budget);
      if (allowance && allowance.used > 0) panelUsage = { ...allowance, unit: 'requests' };
    }
  } catch (error) {
    if (!(error instanceof PanelRequestError)) throw error;
    if (deferredBurst && !panelRead) {
      const limited = await applyPerMinuteLimit(context, corsHeaders, toolBurstPerMinute, id);
      if (limited) return limited;
    }
    if (error.code === 'quota') return mcpDenialResponse({ reason: 'quota-exceeded', limit: error.limit ?? 0, sharedWithRestApi: false }, -32029, 429, id, corsHeaders, { retryAfter: String(secondsUntilUtcMidnight()) });
    if (error.code === 'backend') return quotaBackendUnavailableResponse(id, corsHeaders);
    return rpcError(id, error.code === 'reads' ? -32029 : -32602, error.message, { ...corsHeaders, ...(error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {}) }, undefined, error.code === 'reads' ? 429 : 200);
  }

  // user_key (#4859) consumes the same per-user daily budget as pro: cache
  // tools read Upstash directly (no downstream gateway metering), so an
  // unquota'd user_key would be an unmetered data loophole bounded only by
  // the 60/min limiter. Both credential classes resolve their budget through
  // the same `resolveMcpBudget`, so an API-tier caller charges its REST budget
  // whichever door it arrives through.
  if (
    (context.kind === 'pro' || context.kind === 'user_key')
    && tool._freeTier !== true
    && !isMetadataTool
    && !panelRequest
    && !panelRead
  ) {
    if (freeAccountAllowance) {
      const reservation = await reserveFreeAccountAllowance(
        context.userId,
        deps.redisPipeline,
      );
      if (!reservation.ok) {
        if (reservation.reason === 'allowance-exhausted') {
          // #6716 F2: a spent allowance is a QUOTA state, so it rides the same
          // envelope as the Pro cap below — -32029 at HTTP 429 with Retry-After.
          // It must never be -32001/401: docs/mcp-error-catalog.mdx documents that
          // pair as "re-authenticate via OAuth", so an RFC-9728 client would loop
          // (OAuth succeeds, retry, 401 again) on a condition re-auth cannot fix.
          return mcpDenialResponse({ reason: 'allowance-exhausted' }, -32029, 429, id, corsHeaders, {
            retryAfter: String(secondsUntilUtcMidnight()),
          });
        }
        return quotaBackendUnavailableResponse(id, corsHeaders);
      }
      // Slot charged for good once dispatch begins (same GHSA-hcq5 posture as
      // reserveQuota). No caller-side rollback after this point.
    } else {
      const reservation = await reserveQuota(
        context.userId,
        deps.redisPipeline,
        budget,
        toolWeight(tool),
      );
      if (!reservation.ok) {
        if (reservation.reason === 'cap-exceeded') {
          // `floor` is the limit the reservation actually enforced, so the copy
          // can never quote a different number from the one that rejected.
          // `sharedWithRestApi` is the fact the message alone cannot carry:
          // once REST enforcement is on, an API-tier budget IS the REST meter,
          // so this exhaustion may be traffic the agent never made. It rides
          // `data` like every other denial rather than leaving the agent to
          // string-match, and matches the field the allowance resource reports.
          return mcpDenialResponse(
            {
              reason: 'quota-exceeded',
              limit: reservation.floor,
              sharedWithRestApi: isSharedRestCounter(budget),
            },
            -32029,
            429,
            id,
            corsHeaders,
            { retryAfter: String(secondsUntilUtcMidnight()) },
          );
        }
        // Hard-cap correctness: NEVER dispatch on reservation failure.
        return quotaBackendUnavailableResponse(id, corsHeaders);
      }
      // No caller-side rollback of the reservation: once we pass this point the
      // tool runs and the daily slot is charged for good (GHSA-hcq5). The only
      // rollback is INSIDE reserveQuota, for the pre-dispatch cap-exceeded case.
      if (dedicatedPanel && tool._uiResourceUri) {
        const limit = resolveDailyLimit(budget?.limit);
        const reset = new Date();
        reset.setUTCHours(24, 0, 0, 0);
        panelUsage = { used: reservation.newCount, limit, remaining: limit === null ? null : Math.max(0, limit - reservation.newCount), resetsAt: reset.toISOString(), unit: 'requests' };
      }
    }
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
    if (panelRead?.cached !== undefined) {
      result = panelRead.cached;
    } else {
      execution = createMcpToolExecutionContext(req.url);
      execution.panelRequest = panelRequest;
      if (panelRead?.panel === 'forecasts') execution.panelScope = 'forecasts';
      if (tool._execute) result = await tool._execute(
        callArguments,
        execution.downstreamOrigin,
        context,
        execution,
      );
      else result = await executeTool(tool, execution.panelScope === 'forecasts' ? Object.fromEntries(Object.entries(callArguments).filter(([key]) => key !== 'summary')) : sourceArguments, undefined, execution);
    }
    if (panelRead && panelRead.cached === undefined) {
      if (tool.name === 'open_news_dashboard' && result && typeof result === 'object') {
        const { requestedView: _view, ...snapshot } = result as Record<string, unknown>;
        await panelRead.save(snapshot);
      } else if (tool.name === 'get_forecast_predictions' && result && typeof result === 'object') {
        const { panelRequest: _receipt, ...snapshot } = result as Record<string, unknown>;
        await panelRead.save(snapshot);
      } else await panelRead.save(result);
    }
    if (tool.name === 'get_forecast_predictions' && panelRead?.panel === 'forecasts' && tool._execute === undefined && argBool(callArguments.summary) && result && typeof result === 'object' && 'data' in result) {
      const data = (result as { data: Record<string, unknown> }).data;
      result = { ...result, data: tool._summarize ? tool._summarize(data) : summarizeData(data) };
    }
    if (tool.name === 'get_forecast_predictions' && panelRequest && result && typeof result === 'object') result = { ...result, panelRequest };
    if (tool.name === 'open_news_dashboard' && panelRequest && result && typeof result === 'object') {
      const parsed = parseNewsDashboardRequest(callArguments);
      result = { ...result, requestedView: parsed.success ? parsed.data.view : {}, panelRequest };
    }
    if ((tool.name === 'get_market_data' || tool.name === 'get_prediction_markets' && dedicatedPanel) && tool._execute === undefined && result && typeof result === 'object') {
      const snapshot = result as Awaited<ReturnType<typeof executeTool>>;
      if (argBool(callArguments.summary)) result = { ...snapshot, data: tool._summarize ? tool._summarize(snapshot.data) : summarizeData(snapshot.data) };
      if (panelRequest) result = { ...result as Record<string, unknown>, panelRequest };
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
    const { text: projectedText, value: projectedValue, failed } = applyJmespath(result, jmespathArg);
    // Attribution accompaniment. A projection can detach a redistribution-
    // permitted value from the licence fields sitting beside it in the
    // unprojected payload, so a licence-bearing tool declares an extraction
    // (`_attribution`) and the sources it names are re-attached here.
    //
    // Two properties carry the whole safety argument:
    //   1. the rider is built from `result` — the payload BEFORE
    //      `jmespath.search` — so an expression cannot narrow what it sees;
    //   2. it is merged AFTER the search, by concatenating bytes around the
    //      projected document, so no expression can name, reach, or displace
    //      it (`mergeAttributionRider`).
    // It rides on the `{_jmespath_error, original_keys}` soft-fail envelope
    // too: that envelope is the response for a projected call, so it carries
    // the same obligation.
    //
    // No `jmespath` argument → no rider and byte-identical output, because the
    // unprojected payload already carries its attribution inline.
    const rider = jmespathUsed && tool._attribution !== undefined
      ? buildAttributionRider(result, tool._attribution)
      : null;
    const text = rider === null ? projectedText : mergeAttributionRider(projectedText, rider);
    const latencyMs = Date.now() - tStart;
    // Budget gate: always compute byte length for the budget check. This
    // replaces the previous telemetry-only perf gate for the post-JMESPath
    // measurement — budget enforcement requires the walk unconditionally.
    // Measured on the merged text, so the rider counts toward the budget: it
    // is bytes on the wire, and a projection that only fits by shedding its
    // attribution is not a projection we can serve.
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
      const envelope = {
        _budget_exceeded: true,
        budget_bytes: budget,
        actual_bytes: textBytes,
        hint,
      };
      return rpcOk(id, { content: [{ type: 'text', text: JSON.stringify(envelope) }], structuredContent: envelope, ...(panelUsage ? { _meta: { 'worldmonitor/usage': panelUsage } } : {}) }, corsHeaders);
    }
    // Every tool advertises an `outputSchema`, so a strict client rejects a
    // result without `structuredContent` before the model sees it (#8328). A
    // soft-fail envelope is already an object in its own advertised branch. A
    // payload reshaped by the caller — a `jmespath` projection, or a cache
    // tool's `summary: true`, which turns lists into `{count, sample}` — is no
    // longer the documented shape and is carried under `projection`.
    const summaryUsed = tool._execute === undefined && argBool(p.arguments?.summary);
    const structuredContent = buildStructuredContent(projectedValue, {
      reshaped: failed === undefined && (jmespathUsed || summaryUsed),
      rider,
    });
    return rpcOk(id, { content: [{ type: 'text', text }], structuredContent, ...(panelUsage ? { _meta: { 'worldmonitor/usage': panelUsage } } : {}) }, corsHeaders);
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
    if (err instanceof ToolBackoffError) {
      return rpcError(
        id,
        err.status === 429 ? -32029 : -32603,
        err.status === 429 ? 'Too many requests' : 'Service temporarily unavailable',
        { ...corsHeaders, ...(err.retryAfter === null ? {} : { 'Retry-After': err.retryAfter }) },
        undefined,
        err.status,
      );
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
    // #6559: proto/sebuf ValidationError 400s keep their field/detail pairs as
    // structured JSON-RPC error data (`error.data.violations`). This is NOT a
    // tools/call result envelope (`result.content` / `isError`) — agents read
    // `error.code === -32602` and `error.data.violations[]`.
    if (err instanceof RpcValidationError) {
      return rpcError(id, -32602, 'Invalid params', corsHeaders, {
        violations: err.violations,
      });
    }
    return rpcError(id, -32603, 'Internal error: data fetch failed', corsHeaders);
  }
}
