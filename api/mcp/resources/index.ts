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
  McpAuthContext,
  McpHandlerDeps,
  PublicResourceDef,
  TemplateResourceDef,
} from '../types';
import { dispatchToolsCall } from '../dispatch';
import { evaluateFreshness } from '../freshness';
import { rpcError, rpcOk, withMcpNoStore } from '../rpc';
// @ts-expect-error — JS module, no declaration file
import { readJsonFromUpstash } from '../../_upstash-json.js';
import { CHOKEPOINT_SLUGS } from './slugs';

// ---------------------------------------------------------------------------
// Public resource freshness reader
// ---------------------------------------------------------------------------
// Market-data bootstrap freshness is a single seed-meta key at the same
// 30-minute budget the get_market_data cache tool uses (api/mcp/registry/
// cache-tools.ts `_seedMetaKey` / `_maxStaleMin`), so the envelope this
// resource emits is identical to the freshness portion of a
// get_market_data call — but computed WITHOUT dispatching the tool (no
// data fetch, no Pro reservation), because the resource surfaces only the
// envelope. Robust by construction: a missing/unreachable cache yields a
// valid `{cached_at: null, stale: true}` envelope rather than an error,
// so the anonymous read never surfaces empty content.
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
    description: 'Cache-freshness probe for the high-cadence market-data bootstrap pipeline. Returns ONLY the envelope (cached_at + stale) — no quote payload, no auth, no quota. Use this as a cheap health check to detect a stuck seeder. v1 covers market freshness only; an aggregate freshness resource spanning energy + maritime + risk feeds is a follow-up if customers ask.',
    mimeType: 'application/json',
    read: readMarketFreshness,
  },
];

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
    description: 'Composite Instability Index (CII) score 0–100 with unrest/conflict/security/news components, travel-advisory level, and OFAC sanctions exposure for a single ISO 3166-1 alpha-2 country. URI param {iso2} is lowercase alpha-2 (e.g. "de", "us", "ir").',
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
}

export interface ResourceTemplateShape {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string;
}

export const RESOURCE_LIST_RESPONSE: PublicResourceShape[] = PUBLIC_RESOURCE_REGISTRY.map((r) => ({
  uri: r.uri,
  name: r.name,
  description: r.description,
  mimeType: r.mimeType,
}));

export const RESOURCE_TEMPLATE_LIST_RESPONSE: ResourceTemplateShape[] = TEMPLATE_RESOURCE_REGISTRY.map((r) => ({
  uriTemplate: r.uriTemplate,
  name: r.name,
  description: r.description,
  mimeType: r.mimeType,
}));

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
// anonymous caller, mirroring `prompts/list` / `describe_tool`. The handler
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
  const dispatched = await dispatchToolsCall(req, context, deps, innerBody, corsHeaders, ctx);

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
    // Forward Retry-After from the inner response so quota-exhaustion
    // (429 with seconds-until-UTC-midnight) and reservation-failure (503
    // with 5s) honour the same client back-off contract tools/call does.
    // Without this, a correctly-implemented client back-off would retry
    // immediately on resources/read while waiting correctly on tools/call
    // — directly contradicting the auth-symmetry contract.
    const errorHeaders: Record<string, string> = withMcpNoStore({ 'Content-Type': 'application/json', ...corsHeaders });
    const retryAfter = dispatched.headers.get('Retry-After');
    if (retryAfter !== null) errorHeaders['Retry-After'] = retryAfter;
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
