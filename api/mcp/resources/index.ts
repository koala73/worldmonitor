// MCP resources registry — split into two tiers by data sensitivity:
//
//   1. PUBLIC_RESOURCE_REGISTRY (surfaced via `resources/list`) — concrete,
//      anonymously-readable, quota-exempt resources that return ONLY
//      non-sensitive freshness / health metadata (never billable data). An
//      anonymous agent (or an agent-readiness scanner) MUST be able to
//      `resources/read` every entry `resources/list` advertises, so these
//      are served without auth and without spending quota — the same public
//      posture as `prompts/list` and `describe_tool`. Their `read()` runs a
//      direct cache probe (no `dispatchToolsCall`, no Pro reservation).
//
//   2. TEMPLATE_RESOURCE_REGISTRY (surfaced via `resources/templates/list`) —
//      data-bearing URI templates. A concrete instantiation `resources/read`
//      routes through the SAME `dispatchToolsCall` path `tools/call` uses, so
//      auth, Pro daily quota, telemetry, and per-tool budget gating are
//      inherited unchanged. Asymmetric auth between resources and the
//      equivalent `tools/call` is a known MCP data-leak / quota-bypass vector
//      (a Pro user at the daily cap could otherwise keep reading data through
//      resources for free), so the symmetry is load-bearing and proven by
//      tests/mcp-resources.test.mjs. Templates live in
//      `resources/templates/list` (NOT `resources/list`) because a literal
//      `{iso2}` URI can never resolve to data — surfacing a template in
//      `resources/list` would break an anonymous validator's `resources/read`
//      probe of it.
//
// Stability contract:
//   - URIs use canonical kebab-case slugs (CHOKEPOINT_SLUGS in ./slugs.ts)
//     and ISO 3166-1 alpha-2 / uppercase tickers. Slugs are pinned in a
//     hand-curated table so a cache refresh / upstream rename never breaks
//     a bookmarked URI.
//   - Every resources/read response carries `cached_at` + `stale` in the
//     content payload. Cache-tool-backed resources already have this from
//     the cacheEnvelope shape; RPC-tool-backed resources (just country
//     risk in v1) get the envelope explicitly wrapped here; the public
//     seed-meta freshness resource IS the envelope.
//
// resources/read response shape (per MCP spec):
//   { contents: [{ uri, mimeType, text }] }
// where `text` is the JSON-stringified payload INCLUDING `cached_at` and
// `stale`. mimeType is `application/json` for every resource here.

import type {
  McpAccessClass,
  McpAuthContext,
  McpHandlerDeps,
  PublicResourceDef,
  TemplateResourceDef,
} from '../types';
import { TOOL_REGISTRY, toolAccess } from '../registry/index';
import { dispatchToolsCall } from '../dispatch';
import { evaluateFreshness } from '../freshness';
import { resolveDailyLimit } from '../quota';
import { rpcError, rpcOk, withMcpNoStore } from '../rpc';
import { readJsonFromUpstash } from '../../_upstash-json.js';
import {
  FREE_ACCOUNT_CALLS_PER_DAY,
  FREE_ACCOUNT_IDLE_GAP_MS,
  FREE_ACCOUNT_REQUESTS_PER_DAY,
  freeAccountCallsKey,
  freeAccountLastActivityKey,
  freeAccountRequestsKey,
} from '../free-account-allowance';
import { dailyCounterKey } from '../../../server/_shared/pro-mcp-token';
import { CHOKEPOINT_SLUGS } from './slugs';

// ---------------------------------------------------------------------------
// Public resource freshness reader
// ---------------------------------------------------------------------------
// Market-data bootstrap freshness is the stock seed-meta key at the same
// 30-minute budget the get_market_data cache tool uses, so the envelope this
// resource emits remains compatible with existing clients. It is a write-age
// probe only: sector valuation completeness and route diagnostics live in
// get_market_data's valuationCoverage. Robust by construction: a
// missing/unreachable cache yields a valid `{cached_at: null, stale: true}`
// envelope rather than an error, so the anonymous read never surfaces empty
// content.
const MARKET_FRESHNESS_CHECK = { key: 'seed-meta:market:stocks', maxStaleMin: 30 } as const;

async function readMarketFreshness(): Promise<string> {
  const meta = await readJsonFromUpstash(MARKET_FRESHNESS_CHECK.key).catch(() => null);
  const { cached_at, stale } = evaluateFreshness([MARKET_FRESHNESS_CHECK], [meta]);
  return JSON.stringify({ cached_at, stale });
}

// ---------------------------------------------------------------------------
// Public (concrete, anon-readable, quota-exempt) resources → resources/list
// ---------------------------------------------------------------------------
export const PUBLIC_RESOURCE_REGISTRY: PublicResourceDef[] = [
  {
    uri: 'worldmonitor://seed-meta/freshness',
    name: 'Seed-Meta Freshness',
    description: 'Write-age probe for the high-cadence stock market-data bootstrap pipeline. Returns ONLY the envelope (cached_at + stale) — no quote payload, no auth, no quota. It does not certify sector valuation completeness; use get_market_data for valuationCoverage, source status, and route diagnostics.',
    mimeType: 'application/json',
    read: readMarketFreshness,
  },
];

// Account-specific status is deliberately separate from the anonymous public
// registry and the data-bearing templates. It is returned by resources/list
// only after a user-bound credential is resolved, and its read path performs
// only a GET or read-only GET/PTTL Lua snapshot: no tool dispatch and no
// allowance reservation.
export const MCP_ALLOWANCE_RESOURCE_URI = 'worldmonitor://account/mcp-allowance';
export const ACCOUNT_RESOURCE_LIST_RESPONSE = [{
  uri: MCP_ALLOWANCE_RESOURCE_URI,
  name: 'MCP Allowance Status',
  description: 'Current authenticated account MCP usage, remaining daily calls, UTC reset time, and free-account request-window status when applicable. Reading this resource consumes no allowance.',
  mimeType: 'application/json',
  _meta: { 'worldmonitor/access': 'free-account' as const },
}];

export function isAccountResourceUri(uri: unknown): boolean {
  return uri === MCP_ALLOWANCE_RESOURCE_URI;
}

// A pipeline is not a Redis transaction. Read all three free-account keys in
// one read-only Lua command so the resource cannot expose an impossible
// snapshot while a concurrent allowance reservation is committing.
const READ_FREE_ACCOUNT_ALLOWANCE_SCRIPT = `
local calls = redis.call('GET', KEYS[1])
local requests = redis.call('GET', KEYS[2])
local activityPttl = redis.call('PTTL', KEYS[3])
return {calls or false, requests or false, activityPttl}
`;

function redisInteger(raw: unknown, missingValue?: number): number | null {
  if (raw === null || raw === undefined) return missingValue ?? null;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function countFromRedis(raw: unknown, limit: number | null): number | null {
  const used = redisInteger(raw, 0);
  if (used === null || used < 0) return null;
  return limit === null ? used : Math.min(used, limit);
}

function hasRedisResult(entry: unknown): entry is { result: unknown; error?: unknown } {
  return typeof entry === 'object'
    && entry !== null
    && Object.prototype.hasOwnProperty.call(entry, 'result');
}

/** Quota-exempt authenticated resources/read handler for current allowance. */
export async function buildAccountAllowanceResourceResponse(
  context: McpAuthContext,
  deps: McpHandlerDeps,
  body: { id?: unknown; params?: unknown },
  corsHeaders: Record<string, string>,
  mcpDailyLimit?: number | null,
  freeAccountAllowance = false,
  nowMs = Date.now(),
): Promise<Response> {
  const id = body.id ?? null;
  const params = body.params as { uri?: unknown } | null;
  if (!params || params.uri !== MCP_ALLOWANCE_RESOURCE_URI) {
    return rpcError(id, -32602, 'Invalid params: missing account allowance resource uri', corsHeaders);
  }
  if (context.kind !== 'pro' && context.kind !== 'user_key') {
    return rpcError(id, -32002, 'Account allowance status requires a user-bound credential.', corsHeaders);
  }

  const now = new Date(nowMs);
  const resetsAt = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  )).toISOString();
  const limit = freeAccountAllowance
    ? FREE_ACCOUNT_CALLS_PER_DAY
    : resolveDailyLimit(mcpDailyLimit);

  const commands: Array<Array<string | number>> = freeAccountAllowance
    ? [[
        'EVAL',
        READ_FREE_ACCOUNT_ALLOWANCE_SCRIPT,
        3,
        freeAccountCallsKey(context.userId, nowMs),
        freeAccountRequestsKey(context.userId, nowMs),
        freeAccountLastActivityKey(context.userId, nowMs),
      ]]
    : [['GET', dailyCounterKey(context.userId, now)]];

  let result: Array<{ result?: unknown; error?: unknown }> | null;
  try {
    result = await deps.redisPipeline(commands);
  } catch {
    result = null;
  }
  const firstResult = Array.isArray(result) ? result[0] : undefined;
  if (
    !Array.isArray(result)
    || result.length < commands.length
    || !hasRedisResult(firstResult)
    || result.some((entry) => entry?.error !== undefined && entry?.error !== null)
  ) {
    return rpcError(id, -32603, 'Allowance status is temporarily unavailable.', corsHeaders);
  }

  let used: number | null = null;
  let requestWindows: {
    used: number;
    limit: number;
    remaining: number;
    idleGapMs: number;
    active: boolean;
    expiresAt: string | null;
  } | null = null;

  if (freeAccountAllowance) {
    const tuple = firstResult.result;
    if (!Array.isArray(tuple) || tuple.length !== 3) {
      return rpcError(id, -32603, 'Allowance status is temporarily unavailable.', corsHeaders);
    }
    const [rawCalls, rawRequests, rawActivityPttl] = tuple;
    const callsMissing = rawCalls === null;
    const requestsMissing = rawRequests === null;
    const storedCalls = redisInteger(rawCalls, 0);
    const storedRequests = redisInteger(rawRequests, 0);
    const rawPttl = redisInteger(rawActivityPttl);
    if (
      rawCalls === undefined
      || rawRequests === undefined
      || storedCalls === null
      || storedCalls < 0
      || storedRequests === null
      || storedRequests < 0
      || callsMissing !== requestsMissing
      || storedRequests > storedCalls
      || rawPttl === null
      || rawPttl < -2
      || rawPttl === -1
      || (rawPttl > 0 && storedCalls === 0)
    ) {
      return rpcError(id, -32603, 'Allowance status is temporarily unavailable.', corsHeaders);
    }
    used = Math.min(storedCalls, FREE_ACCOUNT_CALLS_PER_DAY);
    const requestUsed = Math.min(storedRequests, FREE_ACCOUNT_REQUESTS_PER_DAY);
    const pttl = rawPttl > 0 ? rawPttl : null;
    requestWindows = {
      used: requestUsed,
      limit: FREE_ACCOUNT_REQUESTS_PER_DAY,
      remaining: Math.max(0, FREE_ACCOUNT_REQUESTS_PER_DAY - requestUsed),
      idleGapMs: FREE_ACCOUNT_IDLE_GAP_MS,
      active: pttl !== null,
      expiresAt: pttl === null ? null : new Date(nowMs + pttl).toISOString(),
    };
  } else {
    used = countFromRedis(firstResult.result, limit);
    if (used === null) {
      return rpcError(id, -32603, 'Allowance status is temporarily unavailable.', corsHeaders);
    }
  }

  const remaining = limit === null ? null : Math.max(0, limit - used);

  const text = JSON.stringify({
    access: freeAccountAllowance ? 'free-account' : 'subscription',
    used,
    limit,
    remaining,
    resetsAt,
    requestWindows,
  });
  return rpcOk(id, {
    contents: [{ uri: MCP_ALLOWANCE_RESOURCE_URI, mimeType: 'application/json', text }],
  }, corsHeaders);
}

// ---------------------------------------------------------------------------
// Template (data-bearing, gated, quota-symmetric) resources
//   → resources/templates/list
// ---------------------------------------------------------------------------
// URI parsing is hand-rolled: three templates don't justify a URI-template
// library. Each paramExtractor returns null when the URI doesn't even start
// with the right prefix (cheap reject), an {ok: false, reason} when the
// shape matches but a component is invalid, or an {ok: true, args} when
// the URI resolves cleanly to synthetic tools/call arguments.
export const TEMPLATE_RESOURCE_REGISTRY: TemplateResourceDef[] = [
  {
    uriTemplate: 'worldmonitor://countries/{iso2}/risk',
    name: 'Country Risk',
    description: 'Composite Instability Index at cii.combinedScore (0–100) with its four contributing components under cii.components — historical names whose meanings are domestic unrest, armed conflict, security and mobility, and the information environment — plus advisoryLevel and OFAC exposure as sanctionsActive/sanctionsCount, for a single ISO 3166-1 alpha-2 country. Check upstreamUnavailable before trusting a low score: when true, at least one required upstream read failed and the whole response was withheld, so the zeroed fields mean UNKNOWN, not calm. URI param {iso2} is lowercase alpha-2 (e.g. "de", "us", "ir").',
    mimeType: 'application/json',
    tool: 'get_country_risk',
    // RPC tool — wrap freshness against the regional-snapshot-canonical
    // risk-scores seed-meta key (30min budget matches the upstream cadence).
    freshnessWrap: { seedMetaKey: 'seed-meta:intelligence:risk-scores', maxStaleMin: 30 },
    paramExtractor: (uri: string) => {
      if (!uri.startsWith('worldmonitor://countries/')) return null;
      const m = /^worldmonitor:\/\/countries\/([a-z]{2})\/risk$/.exec(uri);
      const iso2 = m?.[1];
      if (!iso2) {
        return {
          ok: false,
          reason: 'Expected worldmonitor://countries/{iso2}/risk where {iso2} is lowercase ISO 3166-1 alpha-2.',
        };
      }
      return { ok: true, args: { country_code: iso2.toUpperCase() } };
    },
  },
  {
    uriTemplate: 'worldmonitor://chokepoints/{slug}/status',
    name: 'Chokepoint Status',
    description: 'Maritime chokepoint transit summary: today total / tanker / cargo counts, week-over-week change, risk level, incident count, disruption percentage, and risk narrative. URI param {slug} is one of the hand-curated kebab-case identifiers (suez, strait-of-malacca, strait-of-hormuz, bab-el-mandeb, panama-canal, taiwan-strait, cape-of-good-hope, strait-of-gibraltar, bosphorus, korea-strait, dover-strait, kerch-strait, lombok-strait).',
    mimeType: 'application/json',
    tool: 'get_chokepoint_status',
    paramExtractor: (uri: string) => {
      if (!uri.startsWith('worldmonitor://chokepoints/')) return null;
      const m = /^worldmonitor:\/\/chokepoints\/([a-z][a-z0-9-]*)\/status$/.exec(uri);
      const slug = m?.[1];
      if (!slug) {
        return {
          ok: false,
          reason: 'Expected worldmonitor://chokepoints/{slug}/status where {slug} is a hand-curated kebab-case identifier.',
        };
      }
      const matcher = CHOKEPOINT_SLUGS[slug];
      if (!matcher) {
        const known = Object.keys(CHOKEPOINT_SLUGS).join(', ');
        return { ok: false, reason: `Unknown chokepoint slug "${slug}". Known slugs: [${known}].` };
      }
      // Project envelope-only via a fixed jmespath argument is NOT applied
      // here — chokepoint status callers want the transit-summaries data
      // body, not just the freshness envelope. The cacheEnvelope from
      // get_chokepoint_status already includes {cached_at, stale}.
      return { ok: true, args: { chokepoint: matcher } };
    },
  },
  {
    uriTemplate: 'worldmonitor://markets/{symbol}/quote',
    name: 'Market Quote',
    description: 'Single-symbol quote slice from the market-data bootstrap cache. URI param {symbol} is the uppercase ticker (e.g. "AAPL", "GC=F", "BTC-USD"). Matches equity / commodity / crypto / Gulf / sector / ETF-flow tickers — same case-insensitive matcher as get_market_data({symbols: [...]}).',
    mimeType: 'application/json',
    tool: 'get_market_data',
    paramExtractor: (uri: string) => {
      if (!uri.startsWith('worldmonitor://markets/')) return null;
      // Symbol grammar: leading uppercase letter, then up to 15 more
      // uppercase letters / digits / dash / equals / dot. Covers AAPL,
      // BTC-USD, GC=F, BRK.B. Lowercase tickers are explicitly invalid —
      // canonical wire shape from the bootstrap cache is uppercase.
      const m = /^worldmonitor:\/\/markets\/([A-Z][A-Z0-9.=-]{0,15})\/quote$/.exec(uri);
      const symbol = m?.[1];
      if (!symbol) {
        return {
          ok: false,
          reason: 'Expected worldmonitor://markets/{symbol}/quote where {symbol} is an uppercase ticker (e.g. "AAPL", "GC=F", "BTC-USD").',
        };
      }
      return { ok: true, args: { symbols: [symbol], asset_class: ['equity', 'commodity', 'crypto', 'gulf', 'etf', 'sectors'] } };
    },
  },
];

// ---------------------------------------------------------------------------
// Public list shapes
// ---------------------------------------------------------------------------
// Per MCP spec, resources/list entries carry {uri, name, description,
// mimeType} and resources/templates/list entries carry {uriTemplate, name,
// description, mimeType}. Internal authoring fields (tool, paramExtractor,
// freshnessWrap, read) stay internal.
export interface PublicResourceShape {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  _meta: { 'worldmonitor/access': 'free' };
}

export interface ResourceTemplateShape {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string;
  _meta: { 'worldmonitor/access': McpAccessClass };
}

export const RESOURCE_LIST_RESPONSE: PublicResourceShape[] = PUBLIC_RESOURCE_REGISTRY.map((r) => ({
  uri: r.uri,
  name: r.name,
  description: r.description,
  mimeType: r.mimeType,
  _meta: { 'worldmonitor/access': 'free' },
}));

export const RESOURCE_TEMPLATE_LIST_RESPONSE: ResourceTemplateShape[] = TEMPLATE_RESOURCE_REGISTRY.map((r) => {
  const tool = TOOL_REGISTRY.find((candidate) => candidate.name === r.tool);
  if (!tool) throw new Error(`Resource template ${r.uriTemplate} references unknown tool ${r.tool}`);
  return {
    uriTemplate: r.uriTemplate,
    name: r.name,
    description: r.description,
    mimeType: r.mimeType,
    _meta: { 'worldmonitor/access': toolAccess(tool) },
  };
});

// Exact-match set of the concrete public URIs. The handler consults this to
// decide whether a `resources/read` is anonymously servable — ONLY the exact
// concrete URIs in PUBLIC_RESOURCE_REGISTRY qualify; a template
// instantiation (country risk, chokepoint, market quote) never does, so the
// data-leak / quota-bypass protection on those is untouched.
const PUBLIC_RESOURCE_URIS: ReadonlySet<string> = new Set(PUBLIC_RESOURCE_REGISTRY.map((r) => r.uri));

export function isPublicResourceUri(uri: unknown): boolean {
  return typeof uri === 'string' && PUBLIC_RESOURCE_URIS.has(uri);
}

// ---------------------------------------------------------------------------
// resources/read — public (anonymous, quota-exempt) dispatcher
// ---------------------------------------------------------------------------
// Serves a concrete PUBLIC_RESOURCE_REGISTRY entry via its direct `read()`.
// No auth context, no dispatchToolsCall, no Pro reservation — the content is
// metadata-only (a freshness envelope), so this is safe to serve to an
// anonymous caller, mirroring `prompts/list`. The handler
// only routes a request here when `isPublicResourceUri(uri)` is true, so the
// `-32602` fallback below is a fail-explicit guard for a broken invariant.
export async function buildPublicResourceResponse(
  body: { id?: unknown; params?: unknown },
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const outerId = body.id ?? null;
  const params = body.params as { uri?: unknown } | null;
  if (!params || typeof params.uri !== 'string') {
    return rpcError(outerId, -32602, 'Invalid params: missing resource uri', corsHeaders);
  }
  const def = PUBLIC_RESOURCE_REGISTRY.find((r) => r.uri === params.uri);
  if (!def) {
    return rpcError(outerId, -32602, `Unknown public resource uri "${params.uri}".`, corsHeaders);
  }
  // `read()` is documented "MUST be robust", but enforce it at the boundary so
  // a future PUBLIC_RESOURCE_REGISTRY entry whose reader throws surfaces a clean
  // -32603 (mirroring the sibling fail-explicit guards in buildResourceResponse)
  // instead of bubbling an unhandled rejection through mcpHandler to the edge
  // runtime. The current reader (readMarketFreshness) already catches internally.
  let text: string;
  try {
    text = await def.read();
  } catch {
    return rpcError(outerId, -32603, 'Internal error: resource reader failed', corsHeaders);
  }
  return rpcOk(
    outerId,
    { contents: [{ uri: def.uri, mimeType: def.mimeType, text }] },
    corsHeaders,
  );
}

// ---------------------------------------------------------------------------
// resources/read — gated (auth + quota-symmetric) template dispatcher
// ---------------------------------------------------------------------------
// Resolves a concrete template instantiation to its content by synthesizing a
// tools/call body and invoking dispatchToolsCall — that path runs the same
// Pro daily-quota reservation, telemetry emission, and per-tool budget gate
// the tools/call surface does, so auth + quota symmetry is structural rather
// than duplicated. Resource-shape wrapping happens AFTER dispatch returns:
//   1. Match the URI against a template; -32602 on no-match or malformed
//      component.
//   2. Synthesize a tools/call JSON-RPC body with the matched tool +
//      extracted args.
//   3. Await dispatchToolsCall — Response back is the standard JSON-RPC
//      envelope. Bubble up error envelopes (auth, quota cap exceeded,
//      tool errors, budget exceeded) by re-emitting them under the
//      OUTER id.
//   4. On success: extract the dispatcher's content[0].text. For cache-
//      tool-backed resources this already contains the cacheEnvelope
//      `{cached_at, stale, data}`. For RPC-tool-backed resources (just
//      country risk), read the configured seed-meta key and wrap with
//      `{cached_at, stale, ...rawPayload}` so the freshness contract
//      holds uniformly.
//   5. Re-emit as resources/read shape: `{contents: [{uri, mimeType, text}]}`
//      under the outer id, preserving the standard rpcOk envelope.
export async function buildResourceResponse(
  req: Request,
  context: McpAuthContext,
  deps: McpHandlerDeps,
  body: { id?: unknown; params?: unknown },
  corsHeaders: Record<string, string>,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
  // Forwarded verbatim to the dispatcher so a template read is capped at the
  // caller's PLAN allowance, exactly like the equivalent tools/call. Dropping
  // it here would reopen the quota asymmetry this path exists to close.
  mcpDailyLimit?: number | null,
  freeAccountAllowance?: boolean,
  // Forwarded so a denial raised inside the dispatcher carries the same
  // WWW-Authenticate as the equivalent tools/call (#6716).
  resourceMetadataUrl?: string,
): Promise<Response> {
  const outerId = body.id ?? null;
  const params = body.params as { uri?: unknown } | null;
  if (!params || typeof params.uri !== 'string') {
    return rpcError(outerId, -32602, 'Invalid params: missing resource uri', corsHeaders);
  }
  const uri = params.uri;

  // Find the first template entry whose paramExtractor returns non-null.
  // null = prefix mismatch (try next entry). ok:false = prefix matched but
  // component invalid (terminate with -32602). ok:true = resolved.
  let matched: { def: TemplateResourceDef; args: Record<string, unknown> } | null = null;
  let lastReason: string | null = null;
  for (const def of TEMPLATE_RESOURCE_REGISTRY) {
    const r = def.paramExtractor(uri);
    if (r === null) continue;
    if (!r.ok) {
      lastReason = r.reason;
      // Don't try further entries — the prefix matched, so this entry is
      // the one the caller meant. The reason explains the malformed
      // component (unknown slug, bad iso2 case, etc.).
      break;
    }
    matched = { def, args: r.args };
    break;
  }
  if (!matched) {
    const msg = lastReason
      ?? `Unknown resource uri "${uri}". Issue resources/list (concrete resources) and resources/templates/list (parameterised URI templates) to discover the supported URI shapes.`;
    return rpcError(outerId, -32602, msg, corsHeaders);
  }

  // Synthesize a tools/call body. The inner id is internal — never reaches
  // the wire — but dispatchToolsCall threads it through, so use a stable
  // sentinel for debuggability if a telemetry line leaks it.
  const innerBody = {
    id: '__resources_read__',
    params: { name: matched.def.tool, arguments: matched.args },
  };

  // dispatchToolsCall handles auth-symmetric quota reservation, per-tool
  // budget gate, and telemetry emission. Returns a Response with
  // the standard JSON-RPC envelope. We parse, repackage, and re-emit
  // under the OUTER id.
  const dispatched = await dispatchToolsCall(
    req,
    context,
    deps,
    innerBody,
    corsHeaders,
    ctx,
    mcpDailyLimit,
    freeAccountAllowance,
    resourceMetadataUrl,
  );

  // Parse the dispatched body. dispatched.json() is safe — the dispatcher
  // always emits JSON-RPC, never streams or returns null bodies for these
  // success/error cases.
  const innerBodyParsed: {
    error?: { code: number; message: string };
    result?: { content?: Array<{ type?: string; text?: string }> };
  } = await dispatched.json();

  if (innerBodyParsed.error) {
    // Preserve the inner code (quota -32029, budget-exceeded comes back as
    // a 200 with _budget_exceeded inside content[0].text — handled below
    // as a success-shape envelope, not an error — see PR 4 design).
    //
    // Forward Retry-After and X-Billing-Verification from the inner response
    // so quota-exhaustion (429 with seconds-until-UTC-midnight),
    // reservation-failure (503 with 5s), and mid-call billing denials
    // honour the same client contract tools/call does. Dropping
    // X-Billing-Verification (#7269) made a 503 look like rate-limit
    // degradation and a 403 look like an ordinary tier precheck.
    const errorHeaders: Record<string, string> = withMcpNoStore({ 'Content-Type': 'application/json', ...corsHeaders });
    for (const name of ['Retry-After', 'X-Billing-Verification'] as const) {
      const value = dispatched.headers.get(name);
      if (value !== null) errorHeaders[name] = value;
    }
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: outerId, error: innerBodyParsed.error }),
      { status: dispatched.status, headers: errorHeaders },
    );
  }

  const innerText = innerBodyParsed.result?.content?.[0]?.text;
  if (typeof innerText !== 'string') {
    return rpcError(outerId, -32603, 'Internal error: resource dispatcher returned no text payload', corsHeaders);
  }

  // Freshness wrap. Cache-tool-backed resources already carry
  // `{cached_at, stale, data}` from the cacheEnvelope; pass through
  // unchanged. RPC-tool-backed resources (just country risk) need an
  // explicit wrap against the configured seed-meta key.
  let wrappedText: string;
  if (matched.def.freshnessWrap) {
    let rawPayload: unknown;
    try {
      rawPayload = JSON.parse(innerText);
    } catch {
      // A parse failure means the underlying RPC returned non-JSON,
      // which should already have been a -32603 inside the dispatcher —
      // defensive fallback: surface as -32603.
      return rpcError(outerId, -32603, 'Internal error: resource payload was not valid JSON', corsHeaders);
    }
    // Soft-error envelopes (PR 4 _budget_exceeded, PR 1.4 _jmespath_error)
    // come back as 200 with the sentinel inside content[0].text — NOT as
    // a JSON-RPC error. Pass these through unwrapped so the structured
    // sentinel survives. Merging with {cached_at, stale} would otherwise
    // produce a hybrid shape where the soft-error sentinel sits alongside
    // freshness fields, and clients that detect via top-level key
    // presence would see "valid-looking" content with the error buried
    // as an inner field.
    if (
      rawPayload !== null
      && typeof rawPayload === 'object'
      && !Array.isArray(rawPayload)
      && (('_budget_exceeded' in rawPayload) || ('_jmespath_error' in rawPayload))
    ) {
      wrappedText = innerText;
    } else {
      const { seedMetaKey, maxStaleMin } = matched.def.freshnessWrap;
      const meta = await readJsonFromUpstash(seedMetaKey).catch(() => null);
      const { cached_at, stale } = evaluateFreshness(
        [{ key: seedMetaKey, maxStaleMin }],
        [meta],
      );
      // Merge envelope ahead of payload fields so the standard shape is
      // visible first when humans inspect the response.
      const merged = (rawPayload !== null && typeof rawPayload === 'object' && !Array.isArray(rawPayload))
        ? { cached_at, stale, ...(rawPayload as Record<string, unknown>) }
        : { cached_at, stale, data: rawPayload };
      wrappedText = JSON.stringify(merged);
    }
  } else {
    wrappedText = innerText;
  }

  return rpcOk(
    outerId,
    {
      contents: [{ uri, mimeType: matched.def.mimeType, text: wrappedText }],
    },
    corsHeaders,
  );
}
