// MCP resources registry — four read-only addressable URIs surfaced via
// resources/list + resources/read. Each entry routes through the SAME
// dispatchToolsCall path the tools/call method uses, so auth, Pro daily
// quota, telemetry, and per-tool budget gating are inherited unchanged —
// asymmetric auth between resources and the equivalent tools/call is a
// known MCP data-leak vector (a Pro user at the daily cap could otherwise
// keep reading data through resources for free), so the symmetry is
// load-bearing and proven by tests/mcp-resources.test.mjs.
//
// Stability contract:
//   - URIs use canonical kebab-case slugs (CHOKEPOINT_SLUGS in ./slugs.ts)
//     and ISO 3166-1 alpha-2 / uppercase tickers. Slugs are pinned in a
//     hand-curated table so a cache refresh / upstream rename never breaks
//     a bookmarked URI.
//   - Every resources/read response carries `cached_at` + `stale` in the
//     content payload. Cache-tool-backed resources already have this from
//     the cacheEnvelope shape; RPC-tool-backed resources (just country
//     risk in v1) get the envelope explicitly wrapped here.
//
// Spec-shape note: resources/list returns the four template-shaped URIs
// (e.g. `worldmonitor://countries/{iso2}/risk`) verbatim. Strict 2025-06-18
// reading would route templates through resources/templates/list, but
// surfacing them via resources/list is the pragmatic posture (Claude
// Desktop / MCP Inspector both render the literal URI; the user / model
// substitutes the placeholder before issuing resources/read). If a future
// client complains, splitting out a templates/list method is a
// non-breaking additive change.
//
// resources/read response shape (per MCP spec):
//   { contents: [{ uri, mimeType, text }] }
// where `text` is the JSON-stringified payload INCLUDING `cached_at` and
// `stale`. mimeType is `application/json` for every resource here.

import type { McpAuthContext, McpHandlerDeps, McpResourceDef } from '../types';
import { dispatchToolsCall } from '../dispatch';
import { evaluateFreshness } from '../freshness';
import { rpcError, rpcOk } from '../rpc';
// @ts-expect-error — JS module, no declaration file
import { readJsonFromUpstash } from '../../_upstash-json.js';
import { CHOKEPOINT_SLUGS } from './slugs';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
// URI parsing is hand-rolled: four resources don't justify a URI-template
// library. Each paramExtractor returns null when the URI doesn't even start
// with the right prefix (cheap reject), an {ok: false, reason} when the
// shape matches but a component is invalid, or an {ok: true, args} when
// the URI resolves cleanly to synthetic tools/call arguments.
export const RESOURCE_REGISTRY: McpResourceDef[] = [
  {
    uri: 'worldmonitor://countries/{iso2}/risk',
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
    uri: 'worldmonitor://chokepoints/{slug}/status',
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
    uri: 'worldmonitor://seed-meta/freshness',
    name: 'Seed-Meta Freshness',
    description: 'Cache-freshness audit for the high-cadence market-data bootstrap pipeline. Returns only the envelope (cached_at + stale) — no quote payload. Use this as a cheap probe to detect a stuck seeder. v1 covers market freshness only; an aggregate freshness resource spanning energy + maritime + risk feeds is a follow-up if customers ask.',
    mimeType: 'application/json',
    tool: 'get_market_data',
    paramExtractor: (uri: string) => {
      if (uri !== 'worldmonitor://seed-meta/freshness') {
        if (uri.startsWith('worldmonitor://seed-meta/')) {
          return { ok: false, reason: 'Expected worldmonitor://seed-meta/freshness (no further path segments).' };
        }
        return null;
      }
      // summary: true collapses the payload to counts + samples (cheap
      // wire shape); the jmespath projection then strips data entirely and
      // emits only the envelope. The dispatcher's per-budget gate runs
      // against the projected size — well under 1 KB.
      return { ok: true, args: { summary: true, jmespath: '{cached_at: cached_at, stale: stale}' } };
    },
  },
  {
    uri: 'worldmonitor://markets/{symbol}/quote',
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
// resources/list public shape
// ---------------------------------------------------------------------------
// Per MCP spec, resources/list entries carry {uri, name, description,
// mimeType}. Internal authoring fields (tool, paramExtractor,
// freshnessWrap) stay internal.
export interface PublicResourceShape {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export const RESOURCE_LIST_RESPONSE: PublicResourceShape[] = RESOURCE_REGISTRY.map((r) => ({
  uri: r.uri,
  name: r.name,
  description: r.description,
  mimeType: r.mimeType,
}));

// ---------------------------------------------------------------------------
// resources/read dispatcher
// ---------------------------------------------------------------------------
// Resolves a URI to its content by synthesizing a tools/call body and
// invoking dispatchToolsCall — that path runs the same Pro daily-quota
// reservation, telemetry emission, and per-tool budget gate the tools/call
// surface does, so auth + quota symmetry is structural rather than
// duplicated. Resource-shape wrapping happens AFTER dispatch returns:
//   1. Match the URI; -32602 on no-match or malformed component.
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
//      holds uniformly across all four resources.
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

  // Find the first registry entry whose paramExtractor returns non-null.
  // null = prefix mismatch (try next entry). ok:false = prefix matched but
  // component invalid (terminate with -32602). ok:true = resolved.
  let matched: { def: McpResourceDef; args: Record<string, unknown> } | null = null;
  let lastReason: string | null = null;
  for (const def of RESOURCE_REGISTRY) {
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
      ?? `Unknown resource uri "${uri}". Issue resources/list to discover the four supported URI shapes.`;
    return rpcError(outerId, -32602, msg, corsHeaders);
  }

  // Synthesize a tools/call body. The inner id is internal — never reaches
  // the wire — but dispatchToolsCall threads it through, so use a stable
  // sentinel for debuggability if a telemetry line leaks it.
  const innerBody = {
    id: '__resources_read__',
    params: { name: matched.def.tool, arguments: matched.args },
  };

  // dispatchToolsCall handles auth-symmetric quota reservation + rollback
  // + per-tool budget gate + telemetry emission. Returns a Response with
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
    const errorHeaders: Record<string, string> = { 'Content-Type': 'application/json', ...corsHeaders };
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
