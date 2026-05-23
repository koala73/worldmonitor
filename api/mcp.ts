import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import jmespath from 'jmespath';
// @ts-expect-error — JS module, no declaration file
import { getPublicCorsHeaders } from './_cors.js';
// @ts-expect-error — JS module, no declaration file
import { jsonResponse } from './_json-response.js';
// @ts-expect-error — JS module, no declaration file
import { readJsonFromUpstash, redisPipeline as rawRedisPipeline, getRedisCredentials } from './_upstash-json.js';
// @ts-expect-error — JS module, no declaration file
import { resolveBearerToContext } from './_oauth-token.js';
// @ts-expect-error — JS module, no declaration file
import { timingSafeIncludes } from './_crypto.js';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from './_sentry-edge.js';
import COUNTRY_BBOXES from '../shared/country-bboxes.js';
// @ts-expect-error — generated JS module, no declaration file
import MINING_SITES_RAW from '../shared/mining-sites.js';
// Generated .js mirror (+ .d.ts) of shared/iso2-to-iso3.json — a bare `.json`
// import would throw ERR_IMPORT_ATTRIBUTE_MISSING under `node --test` and the
// `with { type: 'json' }` form trips the Vercel edge bundler. See
// scripts/generate-iso3-maps.cjs.
import ISO2_TO_ISO3 from '../shared/iso2-to-iso3.js';
import { getEntitlements } from '../server/_shared/entitlement-check';
import {
  validateProMcpTokenOrNull,
  dailyCounterKey,
  secondsUntilUtcMidnight,
  PRO_DAILY_QUOTA_LIMIT,
  PRO_DAILY_QUOTA_TTL_SECONDS,
} from '../server/_shared/pro-mcp-token';
import {
  signInternalMcpRequest,
  buildInternalMcpHeaders,
} from '../server/_shared/mcp-internal-hmac';
import { hashKeySync } from '../server/_shared/usage-identity';

export const config = { runtime: 'edge' };

// MCP protocol versions this server can speak on the initialize handshake.
// Bumping the supported set is a wire-visible default-behavior change, so the
// bumped floor ships behind an env-var gate (`MCP_PROTOCOL_FLOOR_2025_06_18`)
// per the operational rollout cadence: off default → staging `on` ≥24h →
// prod `on` ≥48h → follow-up commit flips the default → remove the env var
// the version after. The published server-card
// (public/.well-known/mcp/server-card.json) advertises the bumped floor
// unconditionally — the card is a static capability declaration; the live
// initialize handler is what actually negotiates with each client.
//
// Negotiation rule (per MCP lifecycle spec): if the client's requested
// `protocolVersion` is in MCP_SUPPORTED_PROTOCOL_VERSIONS, the server MUST
// respond with that same version; otherwise the server MUST respond with
// another version it supports — by convention the latest. The server keeps
// both versions in the set while the floor is being bumped so callers pinned
// to the older version continue to work unchanged across the env-var flip.
//
// Version history (protocol floor — distinct from SERVER_VERSION below):
//   - 2025-03-26 — initial floor; streamable HTTP transport.
//   - 2025-06-18 (declared 2026-05-23, env-var gated, default off) — unlocks
//     spec-native `outputSchema` per tool in a follow-up. When the env var
//     is on, the server supports BOTH 2025-03-26 and 2025-06-18 so old and
//     new clients are both served correctly during the rollout window.
const MCP_PROTOCOL_FLOOR_2025_06_18_ENABLED =
  process.env.MCP_PROTOCOL_FLOOR_2025_06_18 === 'on';
export const MCP_SUPPORTED_PROTOCOL_VERSIONS: readonly string[] =
  MCP_PROTOCOL_FLOOR_2025_06_18_ENABLED
    ? ['2025-03-26', '2025-06-18']
    : ['2025-03-26'];
// Latest supported version — used as the fallback when the client requests
// a version this server does not support. Always the last entry of
// MCP_SUPPORTED_PROTOCOL_VERSIONS above (invariant asserted in tests). Kept
// as a top-level export for downstream code that needs the canonical
// "what would the server prefer" value.
export const MCP_PROTOCOL_VERSION: string = MCP_PROTOCOL_FLOOR_2025_06_18_ENABLED
  ? '2025-06-18'
  : '2025-03-26';

// Negotiate the protocol version returned in the initialize response.
// Lenient on missing/non-string input (some test fixtures + older clients
// omit the field): fall back to the server's latest supported version,
// matching the spec's "respond with what you support" stance.
export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === 'string'
    && MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : MCP_PROTOCOL_VERSION;
}

// Hand-curated minimum-version matrix for MCP clients validated against
// MCP_PROTOCOL_VERSION's current floor. Comment-grade documentation; no
// handler reads it. Update entries (or add new clients) when bumping the
// floor — reviewers should sanity-check that real-world clients have caught
// up before flipping the env-var default.
export const MCP_SUPPORTED_CLIENT_MATRIX: Record<string, string> = {
  // source: Claude Desktop release notes — first version shipping MCP support
  'Claude Desktop': '0.7.0',
  // source: Claude Code CLI ships current MCP support without a pinned floor
  'Claude Code': 'any current',
  // source: MCP Inspector release notes
  'MCP Inspector': '0.6.0',
  // source: https://docs.cursor.com/ MCP integration — exact minimum not
  // confirmed against the live docs at write time; treat as approximate and
  // re-verify before flipping the env-var default on prod
  'Cursor': '0.40.0',
};

const SERVER_NAME = 'worldmonitor';
// Bumped 1.0 → 1.1.0 (2026-05-11) reflecting:
//   - PR #3658 Tier-1+2 expansion (6 new tools added: displacement, health,
//     energy, consumer-prices, tariffs, chokepoint)
//   - PR #3662 Tier-4 parity (_apiPaths metadata + CI-enforced parity test)
// Bumped 1.1.0 → 1.2.0 (2026-05-14, issue #3677) reflecting:
//   - inputSchema completion: all 27 cache tools now declare filter
//     properties (country/dataset/limit/...) backed by per-tool `_postFilter`
//     in-memory narrowing. Purely additive — omitting all arguments returns
//     the pre-1.2.0 payload byte-for-byte.
// Bumped 1.2.0 → 1.3.0 (2026-05-15, issue #3678) reflecting:
//   - Default `limit` cap of DEFAULT_LIST_LIMIT (30) applied by every cache
//     tool when the call omits `limit`. Pass `limit: 0` for the full payload.
//     This IS a contract change — a no-args call now returns ≤30 items per
//     list — issued as a minor bump.
//   - Universal `summary: true` flag advertised on every cache tool: collapses
//     each array/large-map to counts + 3-item samples, composable with filters.
// Bumped 1.3.0 → 1.4.0 (2026-05-17) reflecting:
//   - Universal `jmespath` string parameter advertised on every tool (cache
//     AND RPC) — server-side projection of the response BEFORE serialization.
//     Composition order: `_postFilter → summary → jmespath`. Soft-fails via
//     `{_jmespath_error, original_keys}` envelopes inside the normal result.
//   - Input gate `JMESPATH_MAX_EXPR_BYTES` (1024) + output gate
//     `JMESPATH_MAX_OUTPUT_BYTES` (256 KB) protect against pathological
//     expressions and multiselect-hash duplication blow-ups. Both gates
//     count UTF-8 bytes via `TextEncoder`, not UTF-16 code units.
//   - `initialize.result.instructions` field carries the grammar URL, three
//     worked examples, the byte caps, and the bad-expression quota note —
//     ~600 bytes emitted once per session vs ×38 schema-bloat across tools.
//   - Purely additive — omitting `jmespath` returns the v1.3.0 payload
//     byte-for-byte. Bundle delta +57.8 KB raw / +9.4 KB gzipped.
// Bumped 1.4.0 → 1.5.0 (2026-05-18) reflecting:
//   - tools/list TOOL descriptions are now compressed to ≤120 UTF-8 bytes
//     (first sentence or byte-truncate). Reduces per-session input-token
//     cost on session-init. Property descriptions intentionally NOT
//     compressed in v1 (audit found 53% encode contract details).
//   - New `describe_tool({tool_name})` RPC returns the full uncompressed
//     definition on demand. Same public shape as a tools/list entry.
//   - Both surfaces flow through a single `buildPublicTool` helper —
//     can never drift. Property schemas + injected SUMMARY_SCHEMA/
//     JMESPATH_SCHEMA are `structuredClone`'d before injection so the
//     module-level consts can't be mutated through returned objects.
//   - Tool count bumped 38 → 39 (describe_tool added).
//   - Purely additive — omitting all v1.5.0 args returns a compressed
//     description in tools/list (observable shape change); describe_tool
//     recovers full text.
// Bumped 1.5.0 → 1.6.0 (2026-05-23) reflecting:
//   - Every tool now declares the spec-defined MCP 2025-06-18 `Tool.outputSchema`
//     field. The LLM can now write a JMESPath projection against the response
//     on the FIRST call — previously the only path was call-then-discover-then-
//     retry, which burned a daily quota slot on a non-projected response.
//   - Schemas are emitted UNCONDITIONALLY on every tools/list, regardless of
//     MCP_PROTOCOL_FLOOR_2025_06_18 — the spec convention is clients ignore
//     unknown fields, and discovery on 2025-03-26 sessions should still benefit.
//   - Purely additive on the wire — no input contract change. Bundle delta is
//     documented in the v1.6.0 PR body.
// Bumped 1.6.0 → 1.7.0 (2026-05-23) reflecting:
//   - De-blanket the `Tool.annotations` object. Previously buildPublicTool
//     hard-coded `{ readOnlyHint: true, openWorldHint: true }` for every
//     tool. Now each tool declares all four spec hints (readOnlyHint,
//     destructiveHint, idempotentHint, openWorldHint) explicitly on its
//     registry entry — same per-tool authorship discipline as
//     _outputBudgetBytes (v1.6.0 PR 4) and outputSchema (v1.6.0 PR 6).
//   - Hint shape extends from 2 booleans → 4 booleans per tool. Wire delta
//     is small (~50 B × 39 tools); hints unchanged for tools that already
//     matched the old blanket. Cache tools + pure-internal RPCs now
//     correctly advertise `openWorldHint: false` (closed-world like a
//     memory tool — they read our seeded Redis cache); LLM-synthesized
//     tools AND live external-API reads (live ADS-B, live maritime, live
//     flight pricing) advertise `idempotentHint: false` so MCP clients
//     don't dedup / cache responses whose content drifts between calls.
//   - Purely additive on the wire — clients that read only the legacy two
//     hints keep working; new four-hint clients get a richer signal.
// Keep aligned with public/.well-known/mcp/server-card.json::serverInfo.version
// — discovery scanners cross-check both values.
const SERVER_VERSION = '1.7.0';

// MCP logging capability — valid severity levels per the 2025-03-26 spec
// (RFC 5424 subset). Stateless HTTP transport: we ACK the level but do not
// push async `notifications/message` log events.
const MCP_LOG_LEVELS: ReadonlySet<string> = new Set([
  'debug', 'info', 'notice', 'warning',
  'error', 'critical', 'alert', 'emergency',
]);

// Universal JMESPath projection caps (v1.4.0) — applied at the dispatch
// boundary AFTER `_postFilter` and `summary`, before serialization. Two
// gates protect the edge function: an input gate against pathological-parse
// expressions and an output gate against multiselect-hash / multiselect-
// list duplication blow-ups. Both gates fail soft via `_jmespath_error`
// envelopes — the tool call still succeeds, the JSON-RPC layer still
// returns 200, and the agent's next retry can self-correct using the
// `original_keys` echo.
//
// Caps are intentionally generous: typical real expressions are ~50–200
// bytes, observed unprojected cache payloads ~5–10 KB (max ~80 KB).
// Defined here (rather than near the `applyJmespath` helper) so the
// `SERVER_INSTRUCTIONS` template below can quote them. Exported so tests
// can assert on them.
export const JMESPATH_MAX_EXPR_BYTES = 1024;
export const JMESPATH_MAX_OUTPUT_BYTES = 256 * 1024;
export type JmespathFailKind = 'expression_too_long' | 'projection_too_large' | 'invalid_expression';

// tools/list tool-description compression cap (v1.5.0). Defined here
// rather than near `compressDescription` so SERVER_INSTRUCTIONS can
// quote it without a temporal-dead-zone error. The compressDescription
// helper definition lives later, with the rest of the helpers.
export const TOOL_DESCRIPTION_MAX_BYTES = 120;

// Session-level discovery instructions. Per MCP 2025-03-26 lifecycle spec,
// servers MAY return an `instructions` string in the `initialize` result;
// clients SHOULD surface this to the model. We carry the JMESPath contract
// (grammar URL, projection guide URL, limits) and the describe_tool affordance
// here — once per session — so per-tool advertisements stay terse. Worked
// examples used to live inline; they now live in docs/mcp-jmespath.mdx, which
// the LLM can fetch on demand instead of amortising ~500 bytes per session.
const SERVER_INSTRUCTIONS = [
  'Every tool accepts an optional `jmespath` string argument. The server applies the expression server-side AFTER any per-tool filter/summary args, projecting the response before serialization. This is the single most effective way to reduce response tokens — typical 80-95% reduction when you only need a subset of fields.',
  '',
  'Grammar: https://jmespath.org/specification.html',
  'Guide with 12 worked examples against real response shapes: https://www.worldmonitor.app/docs/mcp-jmespath',
  '',
  `Limits: expression ≤ ${JMESPATH_MAX_EXPR_BYTES} bytes; projected payload ≤ ${JMESPATH_MAX_OUTPUT_BYTES} bytes. Failures return {_jmespath_error, original_keys} inside the normal result envelope. Bad expressions DO consume one daily quota unit on retry — original_keys is echoed so you can self-correct in one extra call.`,
  '',
  `tools/list returns COMPRESSED tool descriptions (first sentence, ≤${TOOL_DESCRIPTION_MAX_BYTES}B per tool). Call describe_tool({tool_name}) to get the full uncompressed definition for any tool you're considering — especially useful when the compressed entry is ambiguous about behaviour or argument semantics. describe_tool is metadata-only and is EXEMPT from the Pro daily quota (still counts toward the 60/min rate limit), so use it freely while exploring. describe_tool({tool_name: 'nonexistent'}) returns {error: 'unknown_tool', available: [...]} so you can self-correct.`,
].join('\n');

// Country-code whitelist for get_consumer_prices. The consumer-prices seeder
// currently only produces data for AE (UAE); future markets will be added
// here as they're seeded. Kept near COUNTRY_BBOXES (the other ISO-3166 alpha-2
// lookup table used by tools) so adding a market is a single-file change.
const SUPPORTED_CONSUMER_PRICES_COUNTRIES = new Set(['ae']);

// Default cap applied by every cache tool's `_postFilter` when the call omits
// `limit` — issue #3678 ("MCP tool responses are very large"). Reasonable
// per-list cap that keeps a typical multi-key bundle response under ~5–10 KB.
// Clients that want the full payload pass `limit: 0`; the cap helpers treat
// `n <= 0` as a no-op, so `0` is the explicit opt-out sentinel.
const DEFAULT_LIST_LIMIT = 30;

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

// ---------------------------------------------------------------------------
// Auth-context shape passed into tool _execute. U7 widened the previous
// `apiKey: string` to a discriminated union so per-tool fetches can branch
// header construction (`X-WorldMonitor-Key` for env_key, internal-HMAC for
// Pro) from a single point.
// ---------------------------------------------------------------------------

export type McpAuthContext =
  | { kind: 'env_key'; apiKey: string }
  | { kind: 'pro'; userId: string; mcpTokenId: string };

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
async function buildAuthHeaders(
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

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------
interface BaseToolDef {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown>; required: string[] };
  // Per-tool output budget. When serialised tool output exceeds this AFTER
  // _postFilter + summary + JMESPath, the server returns a `_budget_exceeded`
  // envelope instead of the oversized payload. Required so a new tool can't
  // be added without an explicit budget choice.
  _outputBudgetBytes: number;
  // Spec-defined `Tool.outputSchema` (MCP 2025-06-18+). JSON Schema fragment
  // describing the tool's normal (non-envelope) response shape so a compliant
  // client can validate `tools/call` results AND so the LLM can write a
  // JMESPath projection against the response on the FIRST call (instead of
  // having to invoke once just to discover the shape).
  //
  // Required field with NO default — every new tool must make the schema
  // an explicit deliberate authorship step, same discipline as
  // `_outputBudgetBytes`. Source of truth: the tool's `_execute` / cache-key
  // contract (NOT auto-inferred from a single fixture, which would lock in
  // every observed enum value and required-flag forever).
  //
  // Wire behavior: emitted unconditionally on every `tools/list`. Per the
  // MCP JSON-RPC convention, clients negotiated to 2025-03-26 ignore
  // unknown fields, so emitting `outputSchema` on a 2025-03-26 session is
  // practically safe and lets every LLM client benefit during the rollout
  // window before MCP_PROTOCOL_FLOOR_2025_06_18 flips default-on.
  outputSchema: object;
  // Spec-defined `Tool.annotations` (MCP 2025-06-18+). Required object with
  // all four booleans declared so a new tool can't be added without an
  // explicit per-hint decision — same discipline as `_outputBudgetBytes` and
  // `outputSchema`. Per spec, annotations are HINTS (advisory only) — a
  // misclassification is hint-fidelity, not correctness, but the discipline
  // forces a deliberate choice per tool. Spec reference:
  // https://modelcontextprotocol.io/specification/2025-06-18/server/tools
  //
  //   - readOnlyHint: "If true, the tool does not modify its environment."
  //     Every tool here is true — none write/mutate any user-visible state.
  //     Consuming a daily Pro quota counter is NOT environment modification
  //     in the spec sense (which targets the read/write split on the data
  //     plane, not metering on the auth plane).
  //   - destructiveHint: "If true, the tool may perform destructive updates
  //     to its environment." Meaningful only when readOnlyHint == false;
  //     we set it explicitly false on every tool to make the choice visible.
  //   - idempotentHint: "If true, calling the tool repeatedly with the same
  //     arguments will have no additional effect on the its environment."
  //     Spec definition is environmental (every read-only tool satisfies
  //     this). We use the stricter and more operationally useful "same
  //     args → same result content over short windows" reading, because
  //     downstream MCP clients use this hint to decide whether to dedup,
  //     cache, or auto-retry tool calls. Two classes of tool earn `false`:
  //       1. LLM-synthesized tools (get_world_brief, get_country_brief,
  //          analyze_situation, generate_forecasts) — the model output is
  //          non-deterministic across calls.
  //       2. Live external-API reads with rapidly-changing content
  //          (get_airspace, get_maritime_activity, search_flights,
  //          search_flight_prices_by_date) — flight prices and live
  //          positions drift minute-to-minute, so a client that dedupes
  //          on `idempotentHint: true` would silently serve stale data
  //          as authoritative.
  //     Cache tools and pure-internal RPCs are `true` — those serve a
  //     deliberate snapshot from our seeded cache with `cached_at` /
  //     `stale` envelope metadata, and client-side dedup of the snapshot
  //     within a single request burst is desirable.
  //   - openWorldHint: "If true, this tool may interact with an 'open world'
  //     of external entities. If false, the tool's domain of interaction is
  //     closed. For example, the world of a web search tool is open, whereas
  //     that of a memory tool is not." Cache tools read our own internal
  //     Redis cache (controlled, bounded, like a memory tool) → false. RPC
  //     tools that hit external APIs at execution time (live ADS-B, live
  //     maritime, Google Flights) or external LLM providers → true.
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

interface FreshnessCheck {
  key: string;
  maxStaleMin: number;
}

// Cache-read tool: reads one or more Redis keys and returns them with staleness info.
interface CacheToolDef extends BaseToolDef {
  _cacheKeys: string[];
  _seedMetaKey: string;
  _maxStaleMin: number;
  _freshnessChecks?: FreshnessCheck[];
  _execute?: never;
  // Optional in-memory post-filter applied to the label-walked `data` map
  // AFTER the Redis reads + freshness + cache_all_null guard. Pure narrowing:
  // receives the assembled data object plus the tools/call `arguments`, returns
  // a (possibly) narrowed data object. MUST be additive — when no recognised
  // argument is passed it returns `data` unchanged, and unknown/invalid values
  // are no-ops, never errors. Every property a `_postFilter` reads MUST be
  // declared in the same tool's `inputSchema.properties` (schema and behaviour
  // co-located so the advertised contract can never drift from what runs).
  _postFilter?: (data: Record<string, unknown>, params: Record<string, unknown>) => Record<string, unknown>;
  // U3 (Tier-4 parity): REQUIRED. Every OpenAPI operation served by this
  // tool's cache keys ("METHOD path") so the U5 MCP↔API parity test can
  // verify every op in docs/api/*.openapi.json is covered by some tool's
  // `_apiPaths` or explicitly excluded. Empty `[]` is valid for tools
  // whose cache keys aren't served by any OpenAPI op (bootstrap aggregates).
  _apiPaths: string[];
}

// AI inference tool: calls an internal RPC endpoint and returns the raw response.
// Hybrid variant: when an _execute tool also reads cache keys directly
// (e.g. parameterised by country_code), it MAY declare `_coverageKeys` so the
// U7 Tier 3 parity test can verify that every BOOTSTRAP_KEYS/STANDALONE_KEYS
// entry it owns is covered by some tool — cache-tool's `_cacheKeys` and
// hybrid _execute's `_coverageKeys` are equivalent for that audit.
interface RpcToolDef extends BaseToolDef {
  _cacheKeys?: never;
  _seedMetaKey?: never;
  _maxStaleMin?: never;
  _freshnessChecks?: never;
  _execute: (params: Record<string, unknown>, base: string, context: McpAuthContext) => Promise<unknown>;
  _coverageKeys?: string[];
  // U3 (Tier-4 parity): REQUIRED. Every OpenAPI operation this `_execute`
  // body proxies via fetch (extracted from `${base}/api/...` callsites),
  // using the OPENAPI-declared method (not the runtime fetch method) so the
  // parity test's source-of-truth is the public spec.
  //
  // Empty `[]` is valid ONLY when:
  //   (a) The tool hits no HTTP endpoint at all (e.g. AI tools reading a
  //       static JSON registry — see get_commodity_geo), OR
  //   (b) The tool's _execute fetches an endpoint whose runtime method
  //       drifts from the OpenAPI spec AND no covering op exists in the
  //       spec (e.g. generate_forecasts POSTs /api/forecast/v1/get-forecasts
  //       but the spec declares only GET — that GET is owned by
  //       get_forecast_predictions). Document the drift inline; an EXCLUDED
  //       entry is the wrong fix (the op IS covered, just via a sibling
  //       tool with matching method).
  //
  // A new tool whose POST endpoint IS in the spec MUST list it here —
  // don't default to `[]` when the spec actually exposes the path.
  _apiPaths: string[];
}

type ToolDef = CacheToolDef | RpcToolDef;

// `ISO2_TO_ISO3` (imported above) — ISO 3166-1 alpha-2 → alpha-3, uppercase
// keys. Lets the `country` filter stay uniformly alpha-2 across every tool even
// though a few cached payloads (e.g. economic:national-debt:v1 `entries[].iso3`)
// are keyed alpha-3.

// ---------------------------------------------------------------------------
// Cache-tool filter helpers
//
// Shared by the `_postFilter` bodies in the registry below. Every helper is
// defensive: a missing/wrong-typed argument or an unexpected payload shape
// degrades to a no-op, so a `tools/call` carrying junk arguments still returns
// the full payload instead of erroring. This is what keeps the filter contract
// strictly ADDITIVE — omit all arguments and the response is byte-identical to
// the pre-filter behaviour.
// ---------------------------------------------------------------------------

// Coerce an argument to a lowercase, trimmed string list. Accepts a single
// string or an array; anything else → []. For multi-value filters (symbols,
// countries, dataset, ...).
function argStrList(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : v == null || v === '' ? [] : [v];
  return raw.map((x) => String(x).toLowerCase().trim()).filter(Boolean);
}

// Coerce an argument to a finite number, or null when absent/unparseable.
function argNum(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// Coerce an argument to a single lowercase, trimmed string ('' when absent).
function argStr(v: unknown): string {
  return typeof v === 'string' ? v.toLowerCase().trim() : '';
}

// Coerce an argument to a boolean (accepts true / "true" / 1 / "1").
function argBool(v: unknown): boolean {
  return v === true || v === 'true' || v === 1 || v === '1';
}

// ---------------------------------------------------------------------------
// JMESPath projection helpers (v1.4.0)
//
// `applyJmespath` is invoked at the dispatch boundary AFTER `_postFilter`
// and `summary` (both inside `executeTool`). Single insertion point in
// `dispatchToolsCall` covers both cache and RPC tools uniformly.
//
// The helper returns the wire-ready JSON string in `text` so dispatch can
// write it straight into `content[0].text` without re-serializing. Two
// gates protect the edge function — both fail soft, never throw.
// ---------------------------------------------------------------------------

// Edge-safe UTF-8 byte counter. Uses `TextEncoder` (Web Platform, available
// unconditionally on Vercel edge) rather than `text.length` (UTF-16 code
// units — undercounts emoji / CJK / accented content) or `Buffer.byteLength`
// (Node intrinsic — not reliably shimmed in every edge runtime).
//
// Used by BOTH JMESPath gates AND `scripts/measure-jmespath-savings.mjs`
// so the runtime contract and the reported PR numbers operate on the same
// byte definition. Exported for the measurement script.
export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

// ---------------------------------------------------------------------------
// tools/list description compression (v1.5.0)
//
// `tools/list` is the largest fixed per-session input-token cost. v1.4.0's
// catalog is ~41.8 KB UTF-8; ~8 KB of that is tool-level `description`
// prose. The first sentence of a tool description carries nearly all the
// selection signal — the long tail is rarely load-bearing. Compress the
// top-level `description` to first-sentence-or-cap; route LLMs that want
// full text to the new `describe_tool` RPC (added in U3 below).
//
// PROPERTY descriptions are NOT compressed in v1 — audit found 53% of
// them encode contract details (defaults, optional flags, "currently
// supported" lists, examples) where naive compression would regress
// correctness. Deferred to a future PR with a per-property hand-audit.
//
// Both compress + describe_tool surfaces go through `buildPublicTool`
// (added in U2) so there's a single source of truth for the public shape.
// ---------------------------------------------------------------------------

// TOOL_DESCRIPTION_MAX_BYTES is declared above with the version-bump caps
// block so SERVER_INSTRUCTIONS can quote it without a TDZ. Referenced here
// by compressDescription's default call sites.

// Compress a description string to at most `maxBytes` UTF-8 bytes.
// - If the text already fits, returns it unchanged (identity).
// - Otherwise, extracts the first sentence (terminated by `. ! ?` followed
//   by whitespace or end-of-string) and truncates to the byte cap.
// - If no sentence boundary exists, falls back to plain byte truncation.
// - Never cuts inside a UTF-8 codepoint (uses TextEncoder bytewise walk).
//
// Pure, no I/O. Pure function; idempotent.
export function compressDescription(text: string, maxBytes: number): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  if (utf8ByteLength(text) <= maxBytes) return text;
  // First-sentence extraction. The /(?:\s|$)/ tail prevents `e.g.` / `i.e.`
  // mis-splits when the abbreviation is mid-sentence (followed by ` ` not
  // `<EOL>`), though it does still split on a leading `e.g. ...` — that
  // edge case is documented in U1 test scenarios. Tool descriptions in
  // TOOL_REGISTRY don't start with abbreviations, audited at write-time.
  const sentenceMatch = text.match(/^[\s\S]+?[.!?](?:\s|$)/);
  const candidate = sentenceMatch ? sentenceMatch[0].trim() : text;
  if (utf8ByteLength(candidate) <= maxBytes) return candidate;
  // Byte-truncate without splitting a codepoint mid-cut. TextEncoder
  // produces one byte per UTF-8 byte; walk codepoints forward and stop
  // when adding the next would exceed maxBytes.
  const encoder = new TextEncoder();
  let out = '';
  let used = 0;
  for (const ch of candidate) {
    const chBytes = encoder.encode(ch).length;
    if (used + chBytes > maxBytes) break;
    out += ch;
    used += chBytes;
  }
  return out;
}

// Defensive snapshot of the top-level keys / shape of an unprojected value.
// Echoed inside every `_jmespath_error` envelope so the LLM can self-correct
// on its next `tools/call` without refetching the (already-paid-for) payload.
// Bounded at 50 keys to defend against pathological objects.
function jmespathOriginalKeys(v: unknown): string[] {
  if (Array.isArray(v)) return [`<array length=${v.length}>`];
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v as object);
    if (keys.length <= 50) return keys;
    return [...keys.slice(0, 50), `...<${keys.length - 50} more>`];
  }
  return [`<${typeof v}>`];
}

// Result envelope. `text` is always the wire-ready JSON the dispatcher will
// emit in `content[0].text`. `failed` is set only on a soft-failure path,
// and its value is the same enum string used as the `_jmespath_error`
// envelope prefix (no drift).
export interface ApplyJmespathResult {
  text: string;
  failed?: JmespathFailKind;
}

// Apply a JMESPath expression to a value. Always returns `{ text }`. Pure;
// never throws. Identity path (no `exprArg`, empty string, non-string) skips
// projection entirely and returns `JSON.stringify(value)`. See module-doc
// for the two-gate contract.
export function applyJmespath(value: unknown, exprArg: unknown): ApplyJmespathResult {
  if (typeof exprArg !== 'string' || exprArg.length === 0) {
    // `JSON.stringify(undefined)` returns the literal value `undefined`
    // (not a string), which would propagate up to `rpcOk(...content[0].text)`
    // and serialize the field away — clients would see a missing `text`
    // field. Same guard as the projection path: stringify-then-coerce-to-'null'.
    const text = JSON.stringify(value);
    return { text: text === undefined ? 'null' : text };
  }

  // Input gate — reject before parser.
  const exprBytes = utf8ByteLength(exprArg);
  if (exprBytes > JMESPATH_MAX_EXPR_BYTES) {
    const envelope = {
      _jmespath_error: `expression_too_long: ${exprBytes} > ${JMESPATH_MAX_EXPR_BYTES}`,
      original_keys: jmespathOriginalKeys(value),
    };
    return { text: JSON.stringify(envelope), failed: 'expression_too_long' };
  }

  let projected: unknown;
  try {
    projected = jmespath.search(value, exprArg);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const envelope = {
      _jmespath_error: `invalid_expression: ${message}`,
      original_keys: jmespathOriginalKeys(value),
    };
    return { text: JSON.stringify(envelope), failed: 'invalid_expression' };
  }

  const text = JSON.stringify(projected);
  // `JSON.stringify(undefined)` returns the string "undefined" in legacy
  // contexts but actually returns `undefined` in JS — guard so the wire
  // payload is always a valid JSON document.
  const safeText = text === undefined ? 'null' : text;

  // Output gate — reject after stringify (single serialization).
  const outputBytes = utf8ByteLength(safeText);
  if (outputBytes > JMESPATH_MAX_OUTPUT_BYTES) {
    const envelope = {
      _jmespath_error: `projection_too_large: ${outputBytes} > ${JMESPATH_MAX_OUTPUT_BYTES}`,
      original_keys: jmespathOriginalKeys(value),
    };
    return { text: JSON.stringify(envelope), failed: 'projection_too_large' };
  }

  return { text: safeText };
}

// Drop undefined/empty entries from a string list — used after mapping a
// friendly `dataset` enum value through a per-tool alias table (a typo'd enum
// value maps to undefined and is silently dropped).
function compact(arr: (string | undefined)[]): string[] {
  return arr.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

// Case-insensitive substring test, tolerant of non-string haystacks. For
// free-text fields (country names, titles, place strings).
function ciIncludes(hay: unknown, needle: string): boolean {
  return typeof hay === 'string' && hay.toLowerCase().includes(needle);
}

// True when `value` — a scalar code or an array of codes — matches any entry
// in `codes` (case-insensitive exact). Empty `codes` → true (no filter active).
// Handles both scalar ISO fields (item.countryCode) and array ISO fields
// (item.cc, item.countryCodes, event.countries).
function matchesCode(value: unknown, codes: string[]): boolean {
  if (codes.length === 0) return true;
  const pool = Array.isArray(value) ? value : [value];
  return pool.some((v) => typeof v === 'string' && codes.includes(v.toLowerCase()));
}

// In-place: replace the array at data[label] with its filtered subset.
// No-op when data[label] is not an array (e.g. a flat-array payload like
// sanctions:entities whose label-walked value IS the array).
function narrowArray(
  data: Record<string, unknown>,
  label: string,
  pred: (item: Record<string, unknown>) => boolean,
): void {
  const arr = data[label];
  if (Array.isArray(arr)) data[label] = (arr as Record<string, unknown>[]).filter(pred);
}

// In-place: replace the array at data[label][child] with its filtered subset.
// Handles the dominant cache shape — a payload object wrapping one array
// (e.g. data['ucdp-events'].events, data['stocks-bootstrap'].quotes).
function narrowNested(
  data: Record<string, unknown>,
  label: string,
  child: string,
  pred: (item: Record<string, unknown>) => boolean,
): void {
  const parent = data[label];
  if (parent && typeof parent === 'object' && !Array.isArray(parent)) {
    const arr = (parent as Record<string, unknown>)[child];
    if (Array.isArray(arr)) {
      (parent as Record<string, unknown>)[child] = (arr as Record<string, unknown>[]).filter(pred);
    }
  }
}

// Return a copy of an entity-keyed object map keeping only keys in `codes`
// (case-insensitive). Empty `codes` or a non-object → returned unchanged. A
// request that matches NOTHING also returns the original — additive: a typo'd
// country code must not collapse the payload to empty.
function pickMapKeys(obj: unknown, codes: string[]): unknown {
  if (codes.length === 0 || !obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(obj as Record<string, unknown>)) {
    if (codes.includes(k.toLowerCase())) out[k] = val;
  }
  return Object.keys(out).length > 0 ? out : obj;
}

// In-place: narrow an entity-keyed map nested at data[label][child] (e.g. the
// IMF `data.macro.countries` / Eurostat `data['house-prices'].countries` maps).
function pickNestedMap(data: Record<string, unknown>, label: string, child: string, codes: string[]): void {
  const node = data[label];
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    (node as Record<string, unknown>)[child] = pickMapKeys((node as Record<string, unknown>)[child], codes);
  }
}

// In-place: cap an entity-keyed map at data[label][child] to its first `n` keys
// in insertion order. The keyed-object analogue of `capNested` (which slices
// arrays). `n` null or ≤ 0 → no-op, so callers can pass the customer-facing
// `limit: 0` opt-out value through unchanged.
function capNestedMap(data: Record<string, unknown>, label: string, child: string, n: number | null): void {
  if (n == null || n <= 0) return;
  const parent = data[label];
  if (parent && typeof parent === 'object' && !Array.isArray(parent)) {
    const map = (parent as Record<string, unknown>)[child];
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      const entries = Object.entries(map as Record<string, unknown>);
      if (entries.length > n) {
        (parent as Record<string, unknown>)[child] = Object.fromEntries(entries.slice(0, n));
      }
    }
  }
}

// In-place: replace data[label][child] with fn(data[label][child]). The generic
// "reach one level into a payload object and transform a value" helper, used
// for keyed-object payloads whose narrowing doesn't fit pickNestedMap.
function mapNested(
  data: Record<string, unknown>,
  label: string,
  child: string,
  fn: (value: unknown) => unknown,
): void {
  const node = data[label];
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    const n = node as Record<string, unknown>;
    n[child] = fn(n[child]);
  }
}

// Return a copy of an id-keyed object map keeping only entries whose VALUE
// satisfies `pred` (for payloads keyed by an opaque id — fuel-shortages
// keyed by shortage id, disruptions keyed by event id). Non-object → unchanged.
//
// No-match → `{}` is intentional and correct: this is a VALUE PREDICATE, the
// object-map analogue of `narrowArray` / `narrowNested` — "country=DE has no
// fuel shortages" is a legitimate empty result, exactly like a country filter
// emptying an events array. It deliberately does NOT use the
// `Object.keys(out).length ? out : obj` fall-back that `pickMapKeys` has:
// `pickMapKeys` is a KEY SELECTOR where a no-match means "you named keys that
// don't exist" (a likely typo, so don't nuke the map), whereas a value
// predicate matching nothing is a real answer, not a malformed request.
function filterMapValues(
  obj: unknown,
  pred: (value: Record<string, unknown>) => boolean,
): unknown {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (v && typeof v === 'object' && pred(v as Record<string, unknown>)) out[k] = v;
  }
  return out;
}

// Like pickMapKeys but matches keys by case-insensitive SUBSTRING — for the
// chokepoint keyed-object payloads whose ids vary in shape across keys
// (`hormuz_strait` vs `Strait of Hormuz`). Empty needle / no match → unchanged.
function pickMapKeysLike(obj: unknown, needle: string): unknown {
  if (!needle || !obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k.toLowerCase().includes(needle)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : obj;
}

// Return a copy of the `data` map keeping only the requested labels — the
// `dataset` selector shared by the multi-key bundle tools. Unknown labels are
// ignored; an empty request or one matching nothing → `data` unchanged.
function selectDatasets(data: Record<string, unknown>, labels: string[]): Record<string, unknown> {
  if (labels.length === 0) return data;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(data)) {
    if (labels.includes(k.toLowerCase())) out[k] = data[k];
  }
  return Object.keys(out).length > 0 ? out : data;
}

// In-place: cap every top-level array in `data` to `n` items. `n` ≤ 0 or null → no-op.
function capArrays(data: Record<string, unknown>, n: number | null): void {
  if (n == null || n <= 0) return;
  for (const k of Object.keys(data)) {
    const v = data[k];
    if (Array.isArray(v)) data[k] = v.slice(0, n);
  }
}

// In-place: cap the nested array at data[label][child] to `n` items.
function capNested(data: Record<string, unknown>, label: string, child: string, n: number | null): void {
  if (n == null || n <= 0) return;
  const parent = data[label];
  if (parent && typeof parent === 'object' && !Array.isArray(parent)) {
    const arr = (parent as Record<string, unknown>)[child];
    if (Array.isArray(arr)) (parent as Record<string, unknown>)[child] = arr.slice(0, n);
  }
}

// Summary mode (issue #3678) — collapse every array and every large entity-keyed
// object inside `data` to a count + small sample, leaving scalars and small typed
// payload objects intact. Applied AFTER `_postFilter` so it composes with the
// per-tool filters: `country: "DE", summary: true` returns counts + samples for
// DE specifically. Single-level summarisation is intentional — enough to convey
// shape/size, cheap to compute, predictable output.
const SUMMARY_SAMPLE_SIZE = 3;
const SUMMARY_MAP_THRESHOLD = 5; // an inner object with >5 keys is treated as an entity map

function summarizeMap(obj: Record<string, unknown>): { count: number; sample_keys: string[] } {
  const keys = Object.keys(obj);
  return { count: keys.length, sample_keys: keys.slice(0, SUMMARY_SAMPLE_SIZE) };
}

function summarizeField(v: unknown): unknown {
  if (Array.isArray(v)) return { count: v.length, sample: v.slice(0, SUMMARY_SAMPLE_SIZE) };
  if (v && typeof v === 'object') {
    const inner = Object.keys(v as Record<string, unknown>);
    if (inner.length > SUMMARY_MAP_THRESHOLD) return summarizeMap(v as Record<string, unknown>);
  }
  return v;
}

function summarizeData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [label, payload] of Object.entries(data)) {
    if (Array.isArray(payload)) {
      out[label] = { count: payload.length, sample: payload.slice(0, SUMMARY_SAMPLE_SIZE) };
    } else if (payload && typeof payload === 'object') {
      const keys = Object.keys(payload as Record<string, unknown>);
      const allObjValues = keys.length > 0 && keys.every((k) => {
        const v = (payload as Record<string, unknown>)[k];
        return v != null && typeof v === 'object';
      });
      if (keys.length > SUMMARY_MAP_THRESHOLD && allObjValues) {
        // Entity-keyed map at the top level (e.g. data._all = { US: {...}, ... }).
        out[label] = summarizeMap(payload as Record<string, unknown>);
      } else {
        // Typed payload object — recurse one level into its fields.
        const recursed: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
          recursed[k] = summarizeField(v);
        }
        out[label] = recursed;
      }
    } else {
      out[label] = payload;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// outputSchema authoring helpers (v1.6.0)
// ---------------------------------------------------------------------------
// Every cache tool returns a uniform envelope from `executeTool`:
//
//   { cached_at: string|null, stale: boolean, data: { [label]: ... } }
//
// where each `label` is derived from one of the tool's `_cacheKeys` via the
// NON_LABEL regex in executeTool. `cacheEnvelope(dataProps)` returns the spec
// outputSchema for that envelope so the per-tool declarations stay readable
// and consistent (the load-bearing per-tool detail is the `data.properties`
// dictionary — everything else is uniform).
//
// Schema authorship rules:
//   - Source of truth is the tool's `_execute` / cache-key contract, NOT a
//     single captured fixture (an inferred schema would freeze every observed
//     enum value + required flag forever and reject valid future responses).
//   - Only the envelope (`cached_at`, `stale`, `data`) is `required`. The
//     per-label `data` properties are intentionally NOT required because any
//     single cache key may be transiently null without tripping the
//     `cache_all_null` guard (which fires only when ALL keys are null).
//   - `additionalProperties` is left implicit (true) so forward-compat fields
//     added to a payload by a producer don't suddenly fail validation.
//   - Per-array `items.properties` lists known top-level fields with types but
//     does NOT enumerate every observed key — this is the LLM's hint surface
//     for JMESPath, not an exhaustive bytecode-level contract.
function cacheEnvelope(dataProperties: Record<string, object>): object {
  return {
    type: 'object',
    required: ['cached_at', 'stale', 'data'],
    properties: {
      cached_at: {
        type: ['string', 'null'],
        description: 'ISO-8601 timestamp of the OLDEST contributing cache key, or null when no valid seed-meta is present.',
      },
      stale: {
        type: 'boolean',
        description: 'True when any contributing cache key is older than its per-key maxStaleMin freshness budget.',
      },
      data: { type: 'object', properties: dataProperties },
    },
  };
}

// Common dataset-label shape: `{ <label>: { type: ..., properties: {...} } }`
// stays an array of objects under a single key. Most cache datasets follow
// `{ <listKey>: [ ... ] }` plus assorted top-level metadata.
const TOOL_REGISTRY: ToolDef[] = [
  {
    name: 'get_market_data',
    _outputBudgetBytes: 131072,
    description: 'Real-time equity quotes, commodity prices (including gold futures GC=F), crypto prices, forex FX rates (USD/EUR, USD/JPY etc.), sector performance, ETF flows, and Gulf market quotes from WorldMonitor\'s curated bootstrap cache.',
    inputSchema: {
      type: 'object',
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tickers to keep, e.g. ["AAPL","GC=F","BTC"]. Case-insensitive; matches equity/commodity/crypto/gulf quotes, sector ETFs, and ETF-flow tickers. Omit for the full snapshot.',
        },
        asset_class: {
          type: 'array',
          items: { type: 'string', enum: ['equity', 'commodity', 'crypto', 'sectors', 'etf', 'gulf', 'sentiment'] },
          description: 'Restrict the response to one or more asset classes. Omit for all.',
        },
        limit: { type: 'number', description: 'Cap each per-class quote list (stocks/commodities/crypto/gulf/sectors/ETF flows) to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      'stocks-bootstrap': {
        type: ['object', 'null'],
        properties: {
          quotes: { type: 'array', items: { type: 'object', properties: { symbol: { type: 'string' }, price: { type: 'number' }, changePercent: { type: 'number' } } } },
          finnhubSkipped: { type: 'boolean' },
          skipReason: { type: 'string' },
          rateLimited: { type: 'boolean' },
        },
      },
      'commodities-bootstrap': {
        type: ['object', 'null'],
        properties: {
          quotes: { type: 'array', items: { type: 'object', properties: { symbol: { type: 'string' }, price: { type: 'number' }, changePercent: { type: 'number' } } } },
        },
      },
      crypto: {
        type: ['object', 'null'],
        properties: {
          quotes: { type: 'array', items: { type: 'object', properties: { symbol: { type: 'string' }, price: { type: 'number' }, changePercent: { type: 'number' } } } },
        },
      },
      sectors: {
        type: ['object', 'null'],
        properties: {
          sectors: { type: 'array', items: { type: 'object', properties: { symbol: { type: 'string' }, name: { type: 'string' }, changePercent: { type: 'number' } } } },
          valuations: { type: ['object', 'array', 'null'] },
        },
      },
      'etf-flows': {
        type: ['object', 'null'],
        properties: {
          timestamp: { type: ['string', 'number', 'null'] },
          summary: { type: ['object', 'null'] },
          etfs: { type: 'array', items: { type: 'object', properties: { ticker: { type: 'string' }, flow: { type: 'number' } } } },
          rateLimited: { type: 'boolean' },
        },
      },
      'gulf-quotes': {
        type: ['object', 'null'],
        properties: {
          quotes: { type: 'array', items: { type: 'object', properties: { symbol: { type: 'string' }, price: { type: 'number' }, changePercent: { type: 'number' } } } },
          rateLimited: { type: 'boolean' },
        },
      },
      'fear-greed': {
        type: ['object', 'null'],
        properties: {
          timestamp: { type: ['string', 'number', 'null'] },
          composite: { type: ['object', 'number', 'null'], properties: {
            score: { type: 'number' }, label: { type: 'string' }, previous: { type: ['number', 'null'] },
          } },
          categories: { type: ['object', 'array', 'null'] },
          headerMetrics: { type: ['object', 'array', 'null'] },
          sectorPerformance: { type: ['object', 'array', 'null'] },
          unavailable: { type: 'boolean' },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const symbols = argStrList(params.symbols);
      if (symbols.length > 0) {
        for (const label of ['stocks-bootstrap', 'commodities-bootstrap', 'crypto', 'gulf-quotes']) {
          narrowNested(data, label, 'quotes', (q) => matchesCode(q.symbol, symbols));
        }
        narrowNested(data, 'sectors', 'sectors', (s) => matchesCode(s.symbol, symbols));
        narrowNested(data, 'etf-flows', 'etfs', (e) => matchesCode(e.ticker, symbols));
      }
      const limit = argNum(params.limit) ?? DEFAULT_LIST_LIMIT;
      for (const label of ['stocks-bootstrap', 'commodities-bootstrap', 'crypto', 'gulf-quotes']) {
        capNested(data, label, 'quotes', limit);
      }
      capNested(data, 'sectors', 'sectors', limit);
      capNested(data, 'etf-flows', 'etfs', limit);
      const cls = argStrList(params.asset_class);
      if (cls.length > 0) {
        const map: Record<string, string> = {
          equity: 'stocks-bootstrap', commodity: 'commodities-bootstrap', crypto: 'crypto',
          sectors: 'sectors', etf: 'etf-flows', gulf: 'gulf-quotes', sentiment: 'fear-greed',
        };
        return selectDatasets(data, compact(cls.map((c) => map[c])));
      }
      return data;
    },
    _cacheKeys: [
      'market:stocks-bootstrap:v1',
      'market:commodities-bootstrap:v1',
      'market:crypto:v1',
      'market:sectors:v2',
      'market:etf-flows:v1',
      'market:gulf-quotes:v1',
      'market:fear-greed:v1',
    ],
    _seedMetaKey: 'seed-meta:market:stocks',
    _maxStaleMin: 30,
    // NOTE: `GET /api/market/v1/get-gold-intelligence` is NOT covered here.
    // The audit-time cross-reference matched on the single `market:commodities-bootstrap:v1`
    // key shared between this tool and the gold-intel handler, but the handler also reads 4
    // gold-specific keys (COT, gold-extended, gold-ETF-flows, gold-CB-reserves) that this
    // tool's `_cacheKeys` does NOT expose. Excluded as `deferred-to-future-tool` in
    // tests/mcp-api-parity.test.mjs until a future commodities-expansion tool bundles those.
    _apiPaths: [
      "GET /api/market/v1/get-fear-greed-index",
      "GET /api/market/v1/get-sector-summary",
      "GET /api/market/v1/list-commodity-quotes",
      "GET /api/market/v1/list-crypto-quotes",
      "GET /api/market/v1/list-etf-flows",
      "GET /api/market/v1/list-gulf-quotes",
      "GET /api/market/v1/list-market-quotes",
    ],
  },
  {
    name: 'get_conflict_events',
    _outputBudgetBytes: 131072,
    description: 'Active armed conflict events (UCDP, Iran), unrest events with geo-coordinates, and country risk scores. Covers ongoing conflicts, protests, and instability indices worldwide.',
    inputSchema: {
      type: 'object',
      properties: {
        country: {
          type: 'string',
          description: 'Filter to one country — matches the country name on conflict/unrest events and the ISO 3166-1 alpha-2 region code on risk scores (case-insensitive).',
        },
        min_fatalities: {
          type: 'number',
          description: 'Drop events below this fatality count (UCDP deathsBest / unrest fatalities).',
        },
        limit: { type: 'number', description: 'Cap each event list to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      'ucdp-events': {
        type: ['object', 'null'],
        properties: {
          events: { type: 'array', items: { type: 'object', properties: {
            id: { type: 'string' }, dateStart: { type: ['number', 'string'] }, dateEnd: { type: ['number', 'string'] },
            location: { type: 'object', properties: { latitude: { type: 'number' }, longitude: { type: 'number' } } },
            country: { type: 'string' }, sideA: { type: 'string' }, sideB: { type: 'string' },
            deathsBest: { type: 'number' }, deathsLow: { type: 'number' }, deathsHigh: { type: 'number' },
            violenceType: { type: 'string' }, sourceOriginal: { type: 'string' },
          } } },
          fetchedAt: { type: ['number', 'string'] },
          version: { type: ['string', 'number'] },
          totalRaw: { type: 'number' },
          filteredCount: { type: 'number' },
        },
      },
      'iran-events': {
        type: ['object', 'null'],
        properties: {
          events: { type: 'array', items: { type: 'object', properties: {
            id: { type: 'string' }, country: { type: 'string' },
            location: { type: 'object', properties: { latitude: { type: 'number' }, longitude: { type: 'number' } } },
          } } },
          scrapedAt: { type: ['number', 'string'] },
        },
      },
      events: {
        type: ['object', 'null'],
        properties: {
          events: { type: 'array', items: { type: 'object', properties: {
            country: { type: 'string' }, fatalities: { type: 'number' },
            location: { type: 'object', properties: { latitude: { type: 'number' }, longitude: { type: 'number' } } },
          } } },
          clusters: { type: ['array', 'object', 'null'] },
        },
      },
      scores: {
        type: ['object', 'null'],
        properties: {
          ciiScores: { type: 'array', items: { type: 'object', properties: { region: { type: 'string' }, score: { type: 'number' } } } },
          strategicRisks: { type: ['array', 'object', 'null'] },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const country = argStr(params.country);
      const minFatal = argNum(params.min_fatalities);
      const limit = (argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      if (country) {
        narrowNested(data, 'ucdp-events', 'events', (e) => ciIncludes(e.country, country));
        narrowNested(data, 'events', 'events', (e) => ciIncludes(e.country, country));
        narrowNested(data, 'scores', 'ciiScores', (s) => matchesCode(s.region, [country]));
      }
      if (minFatal != null) {
        narrowNested(data, 'ucdp-events', 'events', (e) => (argNum(e.deathsBest) ?? 0) >= minFatal);
        narrowNested(data, 'events', 'events', (e) => (argNum(e.fatalities) ?? 0) >= minFatal);
      }
      for (const label of ['ucdp-events', 'iran-events', 'events']) capNested(data, label, 'events', limit);
      return data;
    },
    _cacheKeys: [
      'conflict:ucdp-events:v1',
      'conflict:iran-events:v1',
      'unrest:events:v1',
      'risk:scores:sebuf:stale:v2',
    ],
    _seedMetaKey: 'seed-meta:conflict:ucdp-events',
    _maxStaleMin: 30,
    // NOTE: `GET /api/intelligence/v1/get-risk-scores` is NOT covered here.
    // The audit-time hint matched on 3 keys (conflict:ucdp-events:v1,
    // conflict:iran-events:v1, risk:scores:sebuf:stale:v2) but the handler at
    // server/worldmonitor/intelligence/v1/get-risk-scores.ts:242-256 reads 12
    // cross-domain keys (infra outages, climate anomalies, cyber threats,
    // wildfires, GPS jamming, OREF history, security advisories, displacement,
    // news insights, news threats). Excluded as `deferred-to-future-tool` —
    // belongs in a future expanded_risk_scores composite tool, not here.
    _apiPaths: [
      "GET /api/conflict/v1/list-iran-events",
      "GET /api/conflict/v1/list-ucdp-events",
      "GET /api/unrest/v1/list-unrest-events",
    ],
  },
  {
    name: 'get_aviation_status',
    _outputBudgetBytes: 131072,
    description: 'Airport delays, NOTAM airspace closures, and tracked military aircraft. Covers FAA delay data and active airspace restrictions.',
    inputSchema: {
      type: 'object',
      properties: {
        disrupted_only: {
          type: 'boolean',
          description: 'Drop airports with severity "normal" — keep only airports actually experiencing delays/closures. The bootstrap lists every monitored airport, so most rows are non-events without this.',
        },
        country: { type: 'string', description: 'Filter to one country by name (case-insensitive substring, e.g. "united states").' },
        iata: { type: 'string', description: 'Filter to a single airport by IATA code (e.g. "JFK").' },
        limit: { type: 'number', description: 'Cap the alert list to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      'delays-bootstrap': {
        type: ['object', 'null'],
        properties: {
          alerts: { type: 'array', items: { type: 'object', properties: {
            iata: { type: 'string' }, country: { type: 'string' },
            severity: { type: 'string' }, name: { type: 'string' },
          } } },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const country = argStr(params.country);
      const iata = argStr(params.iata);
      if (argBool(params.disrupted_only)) {
        narrowNested(data, 'delays-bootstrap', 'alerts', (a) => argStr(a.severity) !== 'normal');
      }
      if (country) narrowNested(data, 'delays-bootstrap', 'alerts', (a) => ciIncludes(a.country, country));
      if (iata) narrowNested(data, 'delays-bootstrap', 'alerts', (a) => argStr(a.iata) === iata);
      capNested(data, 'delays-bootstrap', 'alerts', (argNum(params.limit) ?? DEFAULT_LIST_LIMIT));
      return data;
    },
    _cacheKeys: ['aviation:delays-bootstrap:v2'],
    _seedMetaKey: 'seed-meta:aviation:faa',
    _maxStaleMin: 90,
    _apiPaths: [],
  },
  {
    name: 'get_news_intelligence',
    _outputBudgetBytes: 131072,
    description: 'AI-classified geopolitical threat news summaries, GDELT intelligence signals, cross-source signals, and security advisories from WorldMonitor\'s intelligence layer.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          enum: ['conflict', 'economy', 'cyber', 'nuclear', 'intelligence', 'maritime'],
          description: 'Filter GDELT intelligence to a single topic.',
        },
        category: { type: 'string', description: 'Filter top news stories to one category (e.g. "conflict", "economy"; fallback is "general").' },
        country: { type: 'string', description: 'Filter top stories and travel advisories to one ISO 3166-1 alpha-2 country code (case-insensitive).' },
        alerts_only: { type: 'boolean', description: 'Keep only top stories flagged as alerts.' },
        limit: { type: 'number', description: 'Cap each list (top stories, signals, advisories) to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      insights: {
        type: ['object', 'null'],
        properties: {
          topStories: { type: 'array', items: { type: 'object', properties: {
            title: { type: 'string' }, category: { type: 'string' }, countryCode: { type: 'string' },
            isAlert: { type: 'boolean' }, summary: { type: 'string' },
          } } },
        },
      },
      'gdelt-intel': {
        type: ['object', 'null'],
        properties: {
          topics: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, signals: { type: ['array', 'object'] } } } },
        },
      },
      'cross-source-signals': {
        type: ['object', 'null'],
        properties: { signals: { type: 'array', items: { type: 'object' } } },
      },
      'advisories-bootstrap': {
        type: ['object', 'null'],
        properties: {
          advisories: { type: 'array', items: { type: 'object', properties: { country: { type: 'string' }, level: { type: ['string', 'number'] } } } },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const topic = argStr(params.topic);
      const category = argStr(params.category);
      const countries = argStrList(params.country);
      const limit = (argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      if (topic) narrowNested(data, 'gdelt-intel', 'topics', (t) => argStr(t.id) === topic);
      if (category) narrowNested(data, 'insights', 'topStories', (s) => argStr(s.category) === category);
      if (countries.length > 0) {
        narrowNested(data, 'insights', 'topStories', (s) => matchesCode(s.countryCode, countries));
        narrowNested(data, 'advisories-bootstrap', 'advisories', (a) => matchesCode(a.country, countries));
      }
      if (argBool(params.alerts_only)) narrowNested(data, 'insights', 'topStories', (s) => s.isAlert === true);
      capNested(data, 'insights', 'topStories', limit);
      capNested(data, 'cross-source-signals', 'signals', limit);
      capNested(data, 'advisories-bootstrap', 'advisories', limit);
      return data;
    },
    _cacheKeys: [
      'news:insights:v1',
      'intelligence:gdelt-intel:v1',
      'intelligence:cross-source-signals:v1',
      'intelligence:advisories-bootstrap:v1',
    ],
    _seedMetaKey: 'seed-meta:news:insights',
    _maxStaleMin: 30,
    _apiPaths: [
      "GET /api/intelligence/v1/list-cross-source-signals",
      "GET /api/intelligence/v1/search-gdelt-documents",
    ],
  },
  {
    name: 'get_natural_disasters',
    _outputBudgetBytes: 131072,
    description: 'Recent earthquakes (USGS), active wildfires (NASA FIRMS), and natural hazard events. Includes magnitude, location, and threat severity.',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: {
          type: 'array',
          items: { type: 'string', enum: ['earthquakes', 'wildfires', 'other'] },
          description: 'Restrict to one or more hazard datasets (earthquakes / wildfires / other natural events). Omit for all.',
        },
        min_magnitude: { type: 'number', description: 'Drop earthquakes and natural events below this magnitude.' },
        active_only: { type: 'boolean', description: 'Keep only natural events that are still active (not closed).' },
        limit: { type: 'number', description: 'Cap each hazard list to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      earthquakes: {
        type: ['object', 'null'],
        properties: {
          earthquakes: { type: 'array', items: { type: 'object', properties: {
            magnitude: { type: 'number' }, place: { type: 'string' }, time: { type: ['number', 'string'] },
            latitude: { type: 'number' }, longitude: { type: 'number' }, depth: { type: 'number' },
          } } },
        },
      },
      fires: {
        type: ['object', 'null'],
        properties: {
          fireDetections: { type: 'array', items: { type: 'object', properties: {
            latitude: { type: 'number' }, longitude: { type: 'number' },
            brightness: { type: 'number' }, confidence: { type: ['number', 'string'] },
          } } },
        },
      },
      events: {
        type: ['object', 'null'],
        properties: {
          events: { type: 'array', items: { type: 'object', properties: {
            magnitude: { type: ['number', 'null'] }, closed: { type: 'boolean' },
            country: { type: 'string' }, type: { type: 'string' }, title: { type: 'string' },
          } } },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const minMag = argNum(params.min_magnitude);
      const limit = (argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      if (minMag != null) {
        narrowNested(data, 'earthquakes', 'earthquakes', (q) => (argNum(q.magnitude) ?? 0) >= minMag);
        narrowNested(data, 'events', 'events', (e) => (argNum(e.magnitude) ?? 0) >= minMag);
      }
      if (argBool(params.active_only)) narrowNested(data, 'events', 'events', (e) => e.closed === false);
      capNested(data, 'earthquakes', 'earthquakes', limit);
      capNested(data, 'fires', 'fireDetections', limit);
      capNested(data, 'events', 'events', limit);
      const ds = argStrList(params.dataset);
      if (ds.length > 0) {
        const map: Record<string, string> = { earthquakes: 'earthquakes', wildfires: 'fires', other: 'events' };
        return selectDatasets(data, compact(ds.map((d) => map[d])));
      }
      return data;
    },
    _cacheKeys: [
      'seismology:earthquakes:v1',
      'wildfire:fires:v1',
      'natural:events:v1',
    ],
    _seedMetaKey: 'seed-meta:seismology:earthquakes',
    _maxStaleMin: 30,
    _apiPaths: [
      "GET /api/natural/v1/list-natural-events",
      "GET /api/seismology/v1/list-earthquakes",
      "GET /api/wildfire/v1/list-fire-detections",
    ],
  },
  {
    name: 'get_military_posture',
    _outputBudgetBytes: 131072,
    description: 'Theater posture assessment and military risk scores. Reflects aggregated military positioning and escalation signals across global theaters.',
    inputSchema: {
      type: 'object',
      properties: {
        theater: { type: 'string', description: 'Filter to one theater by id (case-insensitive substring, e.g. "iran", "taiwan", "baltic", "korea").' },
        posture_level: { type: 'string', description: 'Filter to a single posture level.' },
        limit: { type: 'number', description: 'Cap the theaters list to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      theater_posture: {
        type: ['object', 'null'],
        properties: {
          theaters: { type: 'array', items: { type: 'object', properties: {
            theater: { type: 'string' }, postureLevel: { type: 'string' },
            summary: { type: 'string' }, signals: { type: ['array', 'object', 'null'] },
          } } },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const theater = argStr(params.theater);
      const level = argStr(params.posture_level);
      if (theater) narrowNested(data, 'theater_posture', 'theaters', (t) => ciIncludes(t.theater, theater));
      if (level) narrowNested(data, 'theater_posture', 'theaters', (t) => argStr(t.postureLevel) === level);
      capNested(data, 'theater_posture', 'theaters', argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      return data;
    },
    _cacheKeys: ['theater_posture:sebuf:stale:v1'],
    _seedMetaKey: 'seed-meta:intelligence:risk-scores',
    _maxStaleMin: 120,
    // CASCADE-MIRROR EQUIVALENCE: the API handler at
    // server/worldmonitor/military/v1/get-theater-posture.ts:23 reads 3 cascade
    // variants (live + stale + backup) and returns the freshest available.
    // This MCP tool reads only the stale variant; PR #3658's U7 already
    // documents `theater-posture:sebuf:v1` and `theater-posture:sebuf:backup:v1`
    // as `cascade-mirror: covered by get_military_posture` exclusions in the
    // bootstrap-parity test — they share the same payload shape, only freshness
    // differs. Coverage is intentional. The audit script's partial-overlap
    // warning for this op is suppressed via CASCADE_MIRROR_EXEMPT in
    // scripts/audit-mcp-api-coverage.mjs.
    _apiPaths: [
      "GET /api/military/v1/get-theater-posture",
    ],
  },
  {
    name: 'get_cyber_threats',
    _outputBudgetBytes: 131072,
    description: 'Active cyber threat intelligence: malware IOCs (URLhaus, Feodotracker), CISA known exploited vulnerabilities, and active command-and-control infrastructure.',
    inputSchema: {
      type: 'object',
      properties: {
        threat_type: { type: 'string', description: 'Filter to one threat type (case-insensitive substring, e.g. "malware", "vulnerability", "c2").' },
        min_severity: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'critical'],
          description: 'Drop threats below this severity level.',
        },
        country: { type: 'string', description: 'Filter to one ISO 3166-1 alpha-2 country code (many threats have no country and are dropped by this filter).' },
        limit: { type: 'number', description: 'Cap the threat list to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      'threats-bootstrap': {
        type: ['object', 'null'],
        properties: {
          threats: { type: 'array', items: { type: 'object', properties: {
            type: { type: 'string' }, severity: { type: 'string' }, country: { type: 'string' },
            indicator: { type: 'string' }, description: { type: 'string' },
          } } },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const type = argStr(params.threat_type);
      const countries = argStrList(params.country);
      const minSev = argStr(params.min_severity).replace('criticality_level_', '');
      const ranks: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };
      const minRank = ranks[minSev];
      if (type) narrowNested(data, 'threats-bootstrap', 'threats', (t) => ciIncludes(t.type, type));
      if (countries.length > 0) {
        narrowNested(data, 'threats-bootstrap', 'threats', (t) => matchesCode(t.country, countries));
      }
      if (minRank != null) {
        narrowNested(data, 'threats-bootstrap', 'threats', (t) => {
          const tok = argStr(t.severity).replace('criticality_level_', '');
          const r = ranks[tok];
          return r == null || r >= minRank;
        });
      }
      capNested(data, 'threats-bootstrap', 'threats', (argNum(params.limit) ?? DEFAULT_LIST_LIMIT));
      return data;
    },
    _cacheKeys: ['cyber:threats-bootstrap:v2'],
    _seedMetaKey: 'seed-meta:cyber:threats',
    _maxStaleMin: 240,
    _apiPaths: [],
  },
  {
    name: 'get_economic_data',
    _outputBudgetBytes: 131072,
    description: 'Macro economic indicators: Fed Funds rate (FRED), economic calendar events, fuel prices, ECB FX rates, EU yield curve, earnings calendar, COT positioning, energy storage data, BIS household debt service ratio (DSR, quarterly, leading indicator of household financial stress across ~40 advanced economies), and BIS residential + commercial property price indices (real, quarterly).',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['fedfunds', 'econ-calendar', 'fuel-prices', 'ecb-fx-rates', 'yield-curve-eu', 'spending', 'earnings-calendar', 'cot', 'dsr', 'property-residential', 'property-commercial'],
          },
          description: 'Restrict the response to one or more sub-datasets. Omit for the full economic bundle.',
        },
        country: {
          type: 'string',
          description: 'Filter the country-keyed datasets (fuel-prices, BIS DSR/property, economic calendar) to one ISO 3166-1 alpha-2 code.',
        },
        limit: { type: 'number', description: 'Cap each list dataset (calendar, spending, earnings) to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    // FRED key is `economic:fred:v1:FEDFUNDS:0` — the label-walk skips the
    // `0` suffix (NON_LABEL regex matches bare digits) and the `v1` segment,
    // landing on `FEDFUNDS`.
    outputSchema: cacheEnvelope({
      FEDFUNDS: { type: ['object', 'array', 'null'] },
      'econ-calendar': {
        type: ['object', 'null'],
        properties: { events: { type: 'array', items: { type: 'object', properties: {
          country: { type: 'string' }, event: { type: 'string' }, time: { type: ['string', 'number'] },
        } } } },
      },
      'fuel-prices': {
        type: ['object', 'null'],
        properties: { countries: { type: 'array', items: { type: 'object', properties: { code: { type: 'string' }, price: { type: 'number' }, currency: { type: 'string' } } } } },
      },
      'ecb-fx-rates': { type: ['object', 'null'] },
      'yield-curve-eu': { type: ['object', 'null'] },
      spending: {
        type: ['object', 'null'],
        properties: { awards: { type: 'array', items: { type: 'object' } } },
      },
      'earnings-calendar': {
        type: ['object', 'null'],
        properties: { earnings: { type: 'array', items: { type: 'object', properties: { symbol: { type: 'string' }, date: { type: 'string' } } } } },
      },
      cot: { type: ['object', 'null'] },
      dsr: {
        type: ['object', 'null'],
        properties: { entries: { type: 'array', items: { type: 'object', properties: { countryCode: { type: 'string' }, value: { type: 'number' } } } } },
      },
      'property-residential': {
        type: ['object', 'null'],
        properties: { entries: { type: 'array', items: { type: 'object', properties: { countryCode: { type: 'string' }, value: { type: 'number' } } } } },
      },
      'property-commercial': {
        type: ['object', 'null'],
        properties: { entries: { type: 'array', items: { type: 'object', properties: { countryCode: { type: 'string' }, value: { type: 'number' } } } } },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const countries = argStrList(params.country);
      const limit = (argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      if (countries.length > 0) {
        narrowNested(data, 'fuel-prices', 'countries', (c) => matchesCode(c.code, countries));
        narrowNested(data, 'econ-calendar', 'events', (e) => matchesCode(e.country, countries));
        for (const label of ['dsr', 'property-residential', 'property-commercial']) {
          narrowNested(data, label, 'entries', (e) => matchesCode(e.countryCode, countries));
        }
      }
      capNested(data, 'econ-calendar', 'events', limit);
      capNested(data, 'spending', 'awards', limit);
      capNested(data, 'earnings-calendar', 'earnings', limit);
      return selectDatasets(data, argStrList(params.dataset));
    },
    _cacheKeys: [
      'economic:fred:v1:FEDFUNDS:0',
      'economic:econ-calendar:v1',
      'economic:fuel-prices:v1',
      'economic:ecb-fx-rates:v1',
      'economic:yield-curve-eu:v1',
      'economic:spending:v1',
      'market:earnings-calendar:v1',
      'market:cot:v1',
      'economic:bis:dsr:v1',
      'economic:bis:property-residential:v1',
      'economic:bis:property-commercial:v1',
    ],
    _seedMetaKey: 'seed-meta:economic:econ-calendar',
    _maxStaleMin: 1440,
    _freshnessChecks: [
      { key: 'seed-meta:economic:econ-calendar', maxStaleMin: 1440 },
      // Per-dataset BIS seed-meta keys — the aggregate
      // `seed-meta:economic:bis-extended` would report "fresh" even if only
      // one of the three datasets (DSR / SPP / CPP) is current, matching the
      // false-freshness bug already fixed for /api/health and resilience.
      { key: 'seed-meta:economic:bis-dsr', maxStaleMin: 1440 }, // 12h cron × 2
      { key: 'seed-meta:economic:bis-property-residential', maxStaleMin: 1440 },
      { key: 'seed-meta:economic:bis-property-commercial', maxStaleMin: 1440 },
    ],
    _apiPaths: [
      "GET /api/economic/v1/get-ecb-fx-rates",
      "GET /api/economic/v1/get-economic-calendar",
      "GET /api/economic/v1/get-eu-yield-curve",
      "GET /api/economic/v1/list-fuel-prices",
      "GET /api/market/v1/get-cot-positioning",
      "GET /api/market/v1/list-earnings-calendar",
    ],
  },
  {
    name: 'get_country_macro',
    _outputBudgetBytes: 131072,
    description: 'Per-country macroeconomic indicators from IMF WEO (~210 countries, monthly cadence). Bundles fiscal/external balance (inflation, current account, gov revenue/expenditure/primary balance, CPI), growth & per-capita (real GDP growth, GDP/capita USD & PPP, savings & investment rates, savings-investment gap), labor & demographics (unemployment, population), and external trade (current account USD, import/export volume % changes). Latest available year per series. Use for country-level economic screening, peer benchmarking, and stagflation/imbalance flags. NOTE: export/import LEVELS in USD (exportsUsd, importsUsd, tradeBalanceUsd) are returned as null — WEO retracted broad coverage for BX/BM indicators in 2026-04; use currentAccountUsd or volume changes (import/exportVolumePctChg) instead.',
    inputSchema: {
      type: 'object',
      properties: {
        countries: {
          type: 'array',
          items: { type: 'string' },
          description: 'ISO 3166-1 alpha-2 country codes to keep across all four IMF datasets (e.g. ["US","DE","CN"]). Omit for all ~210 countries.',
        },
        limit: { type: 'integer', minimum: 0, description: 'Cap each IMF dataset country map to at most this many entries when no countries filter is supplied (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    // Each IMF label maps to `{ countries: { [iso2]: { ... per-series metrics ... } } }`.
    outputSchema: cacheEnvelope({
      macro: { type: ['object', 'null'], properties: { countries: { type: 'object', additionalProperties: { type: 'object' } } } },
      growth: { type: ['object', 'null'], properties: { countries: { type: 'object', additionalProperties: { type: 'object' } } } },
      labor: { type: ['object', 'null'], properties: { countries: { type: 'object', additionalProperties: { type: 'object' } } } },
      external: { type: ['object', 'null'], properties: { countries: { type: 'object', additionalProperties: { type: 'object' } } } },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const codes = argStrList(params.countries);
      if (codes.length > 0) {
        for (const label of ['macro', 'growth', 'labor', 'external']) pickNestedMap(data, label, 'countries', codes);
        return data;
      }
      const defaultLimit = process.env.MCP_LIMIT_DEFAULT_30 === 'on' ? DEFAULT_LIST_LIMIT : 0;
      const limit = argNum(params.limit) ?? defaultLimit;
      for (const label of ['macro', 'growth', 'labor', 'external']) capNestedMap(data, label, 'countries', limit);
      return data;
    },
    _cacheKeys: [
      'economic:imf:macro:v2',
      'economic:imf:growth:v1',
      'economic:imf:labor:v1',
      'economic:imf:external:v1',
    ],
    _seedMetaKey: 'seed-meta:economic:imf-macro',
    _maxStaleMin: 100800, // monthly WEO release; 70d = 2× interval (absorbs one missed run)
    _freshnessChecks: [
      { key: 'seed-meta:economic:imf-macro', maxStaleMin: 100800 },
      { key: 'seed-meta:economic:imf-growth', maxStaleMin: 100800 },
      { key: 'seed-meta:economic:imf-labor', maxStaleMin: 100800 },
      { key: 'seed-meta:economic:imf-external', maxStaleMin: 100800 },
    ],
    _apiPaths: [],
  },
  {
    name: 'get_eu_housing_cycle',
    _outputBudgetBytes: 131072,
    description: 'Eurostat annual house price index (prc_hpi_a, base 2015=100) for all 27 EU members plus EA20 and EU27_2020 aggregates. Each country entry includes the latest value, prior value, date, unit, and a 10-year sparkline series. Complements BIS WS_SPP with broader EU coverage for the Housing cycle tile.',
    inputSchema: {
      type: 'object',
      properties: {
        countries: {
          type: 'array',
          items: { type: 'string' },
          description: 'Eurostat geo codes to keep — ISO 3166-1 alpha-2, but "EL" for Greece, plus aggregates "EA20" and "EU27_2020". Omit for all.',
        },
        limit: { type: 'integer', minimum: 0, description: 'Cap the country map to at most this many entries when no countries filter is supplied (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      'house-prices': {
        type: ['object', 'null'],
        properties: { countries: { type: 'object', additionalProperties: { type: 'object', properties: {
          latest: { type: ['number', 'null'] }, prior: { type: ['number', 'null'] },
          date: { type: 'string' }, unit: { type: 'string' }, series: { type: 'array', items: { type: 'object' } },
        } } } },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const codes = argStrList(params.countries);
      if (codes.length > 0) {
        pickNestedMap(data, 'house-prices', 'countries', codes);
        return data;
      }
      const defaultLimit = process.env.MCP_LIMIT_DEFAULT_30 === 'on' ? DEFAULT_LIST_LIMIT : 0;
      capNestedMap(data, 'house-prices', 'countries', argNum(params.limit) ?? defaultLimit);
      return data;
    },
    _cacheKeys: ['economic:eurostat:house-prices:v1'],
    _seedMetaKey: 'seed-meta:economic:eurostat-house-prices',
    _maxStaleMin: 60 * 24 * 50, // weekly cron, annual data
    _apiPaths: [],
  },
  {
    name: 'get_eu_quarterly_gov_debt',
    _outputBudgetBytes: 131072,
    description: 'Eurostat quarterly general government gross debt (gov_10q_ggdebt, %GDP) for all 27 EU members plus EA20 and EU27_2020 aggregates. Each country entry includes latest value, prior value, quarter label, and an 8-quarter sparkline series. Provides fresher debt-trajectory signal than annual IMF GGXWDG_NGDP for EU panels.',
    inputSchema: {
      type: 'object',
      properties: {
        countries: {
          type: 'array',
          items: { type: 'string' },
          description: 'Eurostat geo codes to keep — ISO 3166-1 alpha-2, but "EL" for Greece, plus aggregates "EA20" and "EU27_2020". Omit for all.',
        },
        limit: { type: 'integer', minimum: 0, description: 'Cap the country map to at most this many entries when no countries filter is supplied (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      'gov-debt-q': {
        type: ['object', 'null'],
        properties: { countries: { type: 'object', additionalProperties: { type: 'object', properties: {
          latest: { type: ['number', 'null'] }, prior: { type: ['number', 'null'] },
          quarter: { type: 'string' }, series: { type: 'array', items: { type: 'object' } },
        } } } },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const codes = argStrList(params.countries);
      if (codes.length > 0) {
        pickNestedMap(data, 'gov-debt-q', 'countries', codes);
        return data;
      }
      const defaultLimit = process.env.MCP_LIMIT_DEFAULT_30 === 'on' ? DEFAULT_LIST_LIMIT : 0;
      capNestedMap(data, 'gov-debt-q', 'countries', argNum(params.limit) ?? defaultLimit);
      return data;
    },
    _cacheKeys: ['economic:eurostat:gov-debt-q:v1'],
    _seedMetaKey: 'seed-meta:economic:eurostat-gov-debt-q',
    _maxStaleMin: 60 * 24 * 14, // quarterly data, 2-day cron
    _apiPaths: [],
  },
  {
    name: 'get_eu_industrial_production',
    _outputBudgetBytes: 131072,
    description: 'Eurostat monthly industrial production index (sts_inpr_m, NACE B-D industry excl. construction, SCA, base 2021=100) for all 27 EU members plus EA20 and EU27_2020 aggregates. Each country entry includes latest value, prior value, month label, and a 12-month sparkline series. Leading indicator of real-economy activity used by the "Real economy pulse" sparkline.',
    inputSchema: {
      type: 'object',
      properties: {
        countries: {
          type: 'array',
          items: { type: 'string' },
          description: 'Eurostat geo codes to keep — ISO 3166-1 alpha-2, but "EL" for Greece, plus aggregates "EA20" and "EU27_2020". Omit for all.',
        },
        limit: { type: 'integer', minimum: 0, description: 'Cap the country map to at most this many entries when no countries filter is supplied (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      'industrial-production': {
        type: ['object', 'null'],
        properties: { countries: { type: 'object', additionalProperties: { type: 'object', properties: {
          latest: { type: ['number', 'null'] }, prior: { type: ['number', 'null'] },
          month: { type: 'string' }, series: { type: 'array', items: { type: 'object' } },
        } } } },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const codes = argStrList(params.countries);
      if (codes.length > 0) {
        pickNestedMap(data, 'industrial-production', 'countries', codes);
        return data;
      }
      const defaultLimit = process.env.MCP_LIMIT_DEFAULT_30 === 'on' ? DEFAULT_LIST_LIMIT : 0;
      capNestedMap(data, 'industrial-production', 'countries', argNum(params.limit) ?? defaultLimit);
      return data;
    },
    _cacheKeys: ['economic:eurostat:industrial-production:v1'],
    _seedMetaKey: 'seed-meta:economic:eurostat-industrial-production',
    _maxStaleMin: 60 * 24 * 5, // monthly data, daily cron
    _apiPaths: [],
  },
  {
    name: 'get_prediction_markets',
    _outputBudgetBytes: 131072,
    description: 'Active Polymarket event contracts with current probabilities. Covers geopolitical, economic, and election prediction markets.',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['geopolitical', 'tech', 'finance'],
          description: 'Restrict to one market category bucket. Omit for all three.',
        },
        query: { type: 'string', description: 'Keep only markets whose title contains this text (case-insensitive).' },
        source: { type: 'string', enum: ['kalshi', 'polymarket'], description: 'Filter to one prediction-market source.' },
        limit: { type: 'number', description: 'Cap each category bucket to at most this many markets (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      'markets-bootstrap': {
        type: ['object', 'null'],
        properties: {
          geopolitical: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, source: { type: 'string' }, probability: { type: 'number' } } } },
          tech:         { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, source: { type: 'string' }, probability: { type: 'number' } } } },
          finance:      { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, source: { type: 'string' }, probability: { type: 'number' } } } },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const category = argStr(params.category);
      const query = argStr(params.query);
      const source = argStr(params.source);
      const limit = (argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      const buckets = ['geopolitical', 'tech', 'finance'];
      for (const b of buckets) {
        if (query) narrowNested(data, 'markets-bootstrap', b, (m) => ciIncludes(m.title, query));
        if (source) narrowNested(data, 'markets-bootstrap', b, (m) => argStr(m.source) === source);
        capNested(data, 'markets-bootstrap', b, limit);
      }
      if (category && buckets.includes(category)) {
        const node = data['markets-bootstrap'];
        if (node && typeof node === 'object' && !Array.isArray(node)) {
          const n = node as Record<string, unknown>;
          for (const b of buckets) if (b !== category) n[b] = [];
        }
      }
      return data;
    },
    _cacheKeys: ['prediction:markets-bootstrap:v1'],
    _seedMetaKey: 'seed-meta:prediction:markets',
    _maxStaleMin: 90,
    _apiPaths: [
      "GET /api/prediction/v1/list-prediction-markets",
    ],
  },
  {
    name: 'get_sanctions_data',
    _outputBudgetBytes: 131072,
    description: 'OFAC SDN sanctioned entities list and sanctions pressure scores by country. Useful for compliance screening and geopolitical pressure analysis.',
    inputSchema: {
      type: 'object',
      properties: {
        country: { type: 'string', description: 'Filter sanctioned entities and pressure scores to one ISO 3166-1 alpha-2 country code.' },
        entity_type: { type: 'string', description: 'Filter to one entity type (case-insensitive substring, e.g. "vessel", "aircraft", "person", "entity").' },
        query: { type: 'string', description: 'Keep only sanctioned entities whose name contains this text (case-insensitive).' },
        limit: { type: 'number', description: 'Cap the entity list and recent pressure entries to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    // `_postFilter` calls `narrowArray(data, 'entities', ...)` on the
    // entities slot, so that label's value is itself an array (not an object
    // with a child array). The pressure label is the usual `{entries, countries}` shape.
    outputSchema: cacheEnvelope({
      entities: {
        type: ['array', 'object', 'null'],
        items: { type: 'object', properties: {
          name: { type: 'string' }, cc: { type: 'string' }, et: { type: 'string' },
          addr: { type: 'string' },
        } },
      },
      pressure: {
        type: ['object', 'null'],
        properties: {
          entries: { type: 'array', items: { type: 'object', properties: {
            countryCodes: { type: ['array', 'string'] }, entityType: { type: 'string' },
          } } },
          countries: { type: 'array', items: { type: 'object', properties: {
            countryCode: { type: 'string' }, pressureScore: { type: 'number' },
          } } },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const countries = argStrList(params.country);
      const etype = argStr(params.entity_type);
      const query = argStr(params.query);
      const limit = (argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      if (countries.length > 0) {
        narrowArray(data, 'entities', (e) => matchesCode(e.cc, countries));
        narrowNested(data, 'pressure', 'entries', (e) => matchesCode(e.countryCodes, countries));
        narrowNested(data, 'pressure', 'countries', (c) => matchesCode(c.countryCode, countries));
      }
      if (etype) {
        narrowArray(data, 'entities', (e) => ciIncludes(e.et, etype));
        narrowNested(data, 'pressure', 'entries', (e) => ciIncludes(e.entityType, etype));
      }
      if (query) narrowArray(data, 'entities', (e) => ciIncludes(e.name, query));
      capArrays(data, limit);
      capNested(data, 'pressure', 'entries', limit);
      return data;
    },
    _cacheKeys: ['sanctions:entities:v1', 'sanctions:pressure:v1'],
    _seedMetaKey: 'seed-meta:sanctions:entities',
    _maxStaleMin: 1440,
    _apiPaths: [
      "GET /api/sanctions/v1/list-sanctions-pressure",
      "GET /api/sanctions/v1/lookup-sanction-entity",
    ],
  },
  {
    name: 'get_displacement_data',
    _outputBudgetBytes: 131072,
    description: 'Refugee and IDP counts by country (UNHCR annual data).',
    inputSchema: {
      type: 'object',
      properties: {
        countries: {
          type: 'array',
          items: { type: 'string' },
          description: 'ISO 3166-1 alpha-3 country codes to keep (e.g. ["SYR","UKR","AFG"]). Matches both per-country totals and origin/asylum flows. Omit for all.',
        },
        limit: { type: 'number', description: 'Cap the per-country and top-flow lists to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      summary: {
        type: ['object', 'null'],
        properties: {
          countries: { type: 'array', items: { type: 'object', properties: {
            code: { type: 'string' }, total: { type: ['number', 'null'] }, year: { type: ['number', 'string'] },
          } } },
          topFlows: { type: 'array', items: { type: 'object', properties: {
            originCode: { type: 'string' }, asylumCode: { type: 'string' }, value: { type: ['number', 'null'] },
          } } },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const codes = argStrList(params.countries);
      const limit = (argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      if (codes.length > 0) {
        narrowNested(data, 'summary', 'countries', (c) => matchesCode(c.code, codes));
        narrowNested(data, 'summary', 'topFlows', (f) => matchesCode(f.originCode, codes) || matchesCode(f.asylumCode, codes));
      }
      capNested(data, 'summary', 'countries', limit);
      capNested(data, 'summary', 'topFlows', limit);
      return data;
    },
    // Dynamic-year key resolved once at module evaluation — mirrors the
    // STANDALONE_KEYS pattern in api/health.js:147. The UNHCR seeder publishes
    // a single current-year key; the prior year exists at the same prefix but
    // is intentionally excluded — the executeTool label-walk would strip the
    // year segment from both keys and collide on the same `summary` label,
    // causing the second result to overwrite the first.
    _cacheKeys: [`displacement:summary:v1:${new Date().getUTCFullYear()}`],
    _seedMetaKey: 'seed-meta:displacement:summary',
    _maxStaleMin: 3600,
    // Audit miss: handler uses cachedFetchJson with a year-suffixed key the
    // audit's regex couldn't statically resolve. The op IS covered by this
    // tool — same underlying displacement:summary:v1:<year> cache.
    _apiPaths: [
      'GET /api/displacement/v1/get-displacement-summary',
    ],
  },
  {
    name: 'get_health_signals',
    _outputBudgetBytes: 131072,
    description: 'Active disease outbreaks (WHO/ECDC etc.) and global air-quality station readings (OpenAQ/WAQI PM2.5). For health-risk screening.',
    inputSchema: {
      type: 'object',
      properties: {
        signal_type: {
          type: 'array',
          items: { type: 'string', enum: ['outbreaks', 'air-quality'] },
          description: 'Restrict to disease outbreaks, air-quality stations, or both. Omit for both.',
        },
        country: { type: 'string', description: 'Filter outbreaks and air-quality stations to one ISO 3166-1 alpha-2 country code.' },
        disease: { type: 'string', description: 'Keep only outbreaks whose disease name contains this text (case-insensitive).' },
        min_aqi: { type: 'number', description: 'Drop air-quality stations below this AQI value.' },
        limit: { type: 'number', description: 'Cap the outbreak and station lists to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      'disease-outbreaks': {
        type: ['object', 'null'],
        properties: {
          outbreaks: { type: 'array', items: { type: 'object', properties: {
            disease: { type: 'string' }, country: { type: 'string' }, countryCode: { type: 'string' },
            cases: { type: ['number', 'null'] }, deaths: { type: ['number', 'null'] }, date: { type: 'string' },
          } } },
        },
      },
      'air-quality': {
        type: ['object', 'null'],
        properties: {
          stations: { type: 'array', items: { type: 'object', properties: {
            country_code: { type: 'string' }, city: { type: 'string' }, aqi: { type: ['number', 'null'] },
            pm25: { type: ['number', 'null'] }, latitude: { type: 'number' }, longitude: { type: 'number' },
          } } },
        },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const countries = argStrList(params.country);
      const disease = argStr(params.disease);
      const minAqi = argNum(params.min_aqi);
      const limit = (argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      if (countries.length > 0) {
        narrowNested(data, 'disease-outbreaks', 'outbreaks', (o) => matchesCode(o.countryCode, countries));
        narrowNested(data, 'air-quality', 'stations', (s) => matchesCode(s.country_code, countries));
      }
      if (disease) narrowNested(data, 'disease-outbreaks', 'outbreaks', (o) => ciIncludes(o.disease, disease));
      if (minAqi != null) narrowNested(data, 'air-quality', 'stations', (s) => (argNum(s.aqi) ?? 0) >= minAqi);
      capNested(data, 'disease-outbreaks', 'outbreaks', limit);
      capNested(data, 'air-quality', 'stations', limit);
      const st = argStrList(params.signal_type);
      if (st.length > 0) {
        const map: Record<string, string> = { outbreaks: 'disease-outbreaks', 'air-quality': 'air-quality' };
        return selectDatasets(data, compact(st.map((s) => map[s])));
      }
      return data;
    },
    // Uses the health-domain canonical key health:air-quality:v1 (NOT the
    // climate-domain mirror climate:air-quality:v1, which stays exclusively
    // in get_climate_data). Both are written by the same seeder
    // (scripts/seed-health-air-quality.mjs exports HEALTH_AIR_QUALITY_KEY +
    // CLIMATE_AIR_QUALITY_KEY) so no duplicate seed work.
    _cacheKeys: ['health:disease-outbreaks:v1', 'health:air-quality:v1'],
    _seedMetaKey: 'seed-meta:health:disease-outbreaks',
    _maxStaleMin: 2880,
    _freshnessChecks: [
      { key: 'seed-meta:health:disease-outbreaks', maxStaleMin: 2880 }, // daily cron; 48h budget
      { key: 'seed-meta:health:air-quality', maxStaleMin: 180 },        // hourly cron; 3h budget
    ],
    _apiPaths: [
      "GET /api/health/v1/list-air-quality-alerts",
      "GET /api/health/v1/list-disease-outbreaks",
    ],
  },
  {
    name: 'get_energy_intelligence',
    _outputBudgetBytes: 131072,
    description: 'Energy supply, prices, storage, disruptions, and policy: EIA petroleum stocks, electricity prices (Ember), gas storage (GIE), fuel shortages, fossil & renewable shares, active energy disruptions, government crisis policies.',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['eia-petroleum', 'electricity', 'ember', 'gas-storage', 'fuel-shortages', 'disruptions', 'crisis-policies', 'fossil-share', 'renewable'],
          },
          description: 'Restrict the response to one or more energy sub-datasets. Omit for the full bundle.',
        },
        country: {
          type: 'string',
          description: 'Filter the country-keyed datasets (Ember electricity mix, gas storage, fuel shortages, energy disruptions, fossil-share) to one ISO 3166-1 alpha-2 code.',
        },
        limit: { type: 'number', description: 'Cap each list-bearing energy slice (crisis-policies, electricity regions, gas-storage countries, World Bank renewable history/regions) to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    // Labels derived from each cache key's last informative segment:
    //   energy:eia-petroleum:v1                  -> eia-petroleum
    //   energy:electricity:v1:index              -> index
    //   energy:ember:v1:_all                     -> _all
    //   energy:gas-storage:v1:_countries         -> _countries
    //   energy:fuel-shortages:v1                 -> fuel-shortages
    //   energy:disruptions:v1                    -> disruptions
    //   energy:crisis-policies:v1                -> crisis-policies
    //   resilience:fossil-electricity-share:v1   -> fossil-electricity-share
    //   economic:worldbank-renewable:v1          -> worldbank-renewable
    outputSchema: cacheEnvelope({
      'eia-petroleum': { type: ['object', 'null'] },
      index: { type: ['object', 'null'], properties: { regions: { type: 'array', items: { type: 'object' } } } },
      _all: { type: ['object', 'null'] },
      _countries: { type: ['array', 'object', 'null'] },
      'fuel-shortages': { type: ['object', 'null'], properties: { shortages: { type: ['object', 'array', 'null'] } } },
      disruptions: { type: ['object', 'null'], properties: { events: { type: ['object', 'array', 'null'] } } },
      'crisis-policies': { type: ['object', 'null'], properties: { policies: { type: 'array', items: { type: 'object' } } } },
      'fossil-electricity-share': { type: ['object', 'null'], properties: { countries: { type: 'object', additionalProperties: { type: 'object' } } } },
      'worldbank-renewable': { type: ['object', 'null'], properties: {
        historicalData: { type: 'array', items: { type: 'object' } },
        regions: { type: 'array', items: { type: 'object' } },
      } },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const countries = argStrList(params.country);
      if (countries.length > 0) {
        data._all = pickMapKeys(data._all, countries);
        pickNestedMap(data, 'fossil-electricity-share', 'countries', countries);
        // energy:gas-storage:v1:_countries is a string[] of ISO2 codes — match
        // the entry directly; the `?.iso2` fallback tolerates an object shape.
        narrowArray(data, '_countries', (c) => matchesCode(c, countries) || matchesCode(c?.iso2, countries));
        mapNested(data, 'fuel-shortages', 'shortages', (m) => filterMapValues(m, (s) => matchesCode(s.country, countries)));
        mapNested(data, 'disruptions', 'events', (m) => filterMapValues(m, (e) => matchesCode(e.countries, countries)));
      }
      const limit = argNum(params.limit) ?? DEFAULT_LIST_LIMIT;
      capNested(data, 'crisis-policies', 'policies', limit);
      capNested(data, 'index', 'regions', limit);
      capNested(data, 'worldbank-renewable', 'historicalData', limit);
      capNested(data, 'worldbank-renewable', 'regions', limit);
      // _countries is a top-level string[] — capArrays handles top-level arrays;
      // in the energy bundle it's the only such array, so no collateral damage.
      capArrays(data, limit);
      const ds = argStrList(params.dataset);
      if (ds.length > 0) {
        const map: Record<string, string> = {
          'eia-petroleum': 'eia-petroleum', electricity: 'index', ember: '_all', 'gas-storage': '_countries',
          'fuel-shortages': 'fuel-shortages', disruptions: 'disruptions', 'crisis-policies': 'crisis-policies',
          'fossil-share': 'fossil-electricity-share', renewable: 'worldbank-renewable',
        };
        return selectDatasets(data, compact(ds.map((d) => map[d])));
      }
      return data;
    },
    // Broad 9-key energy bundle mirroring get_economic_data. Cadences span
    // hourly (electricity prices) to annual (World Bank renewable share); use
    // _freshnessChecks with per-key maxStaleMin pulled from
    // api/health.js::SEED_META so a slow-cadence key doesn't drag the
    // aggregate stale flag unnecessarily.
    _cacheKeys: [
      'energy:eia-petroleum:v1',                  // STANDALONE_KEYS::eiaPetroleum
      'energy:electricity:v1:index',              // BOOTSTRAP_KEYS::electricityPrices
      'energy:ember:v1:_all',                     // STANDALONE_KEYS::emberElectricity
      'energy:gas-storage:v1:_countries',         // BOOTSTRAP_KEYS::gasStorageCountries
      'energy:fuel-shortages:v1',                 // STANDALONE_KEYS::fuelShortages
      'energy:disruptions:v1',                    // STANDALONE_KEYS::energyDisruptions
      'energy:crisis-policies:v1',                // STANDALONE_KEYS::energyCrisisPolicies
      'resilience:fossil-electricity-share:v1',   // STANDALONE_KEYS::fossilElectricityShare
      'economic:worldbank-renewable:v1',          // BOOTSTRAP_KEYS::renewableEnergy
    ],
    _seedMetaKey: 'seed-meta:energy:eia-petroleum',
    _maxStaleMin: 4320, // EIA petroleum daily-bundle baseline; per-key budgets via _freshnessChecks below
    _freshnessChecks: [
      { key: 'seed-meta:energy:eia-petroleum',                  maxStaleMin: 4320 },   // daily bundle; 72h = 3× interval
      { key: 'seed-meta:energy:electricity-prices',             maxStaleMin: 2880 },   // daily cron (14:00 UTC); 48h = 2× interval
      { key: 'seed-meta:energy:ember',                          maxStaleMin: 2880 },   // daily cron (08:00 UTC); 48h = 2× interval
      { key: 'seed-meta:energy:gas-storage-countries',          maxStaleMin: 2880 },   // daily cron at 10:30 UTC; 48h = 2× interval
      { key: 'seed-meta:energy:fuel-shortages',                 maxStaleMin: 2880 },   // 2d — daily cron × 2 headroom
      { key: 'seed-meta:energy:disruptions',                    maxStaleMin: 20160 },  // 14d — weekly cron × 2 headroom
      { key: 'seed-meta:energy:crisis-policies',                maxStaleMin: 60 * 24 * 400 }, // ~400d static registry
      { key: 'seed-meta:resilience:fossil-electricity-share',   maxStaleMin: 11520 },  // ~8d (annual WB-style cadence)
      { key: 'seed-meta:economic:worldbank-renewable:v1',       maxStaleMin: 10080 },  // 7d WB weekly-cron annual data
    ],
    _apiPaths: [
      "GET /api/economic/v1/get-energy-crisis-policies",
      "GET /api/supply-chain/v1/get-fuel-shortage-detail",
      "GET /api/supply-chain/v1/list-energy-disruptions",
      "GET /api/supply-chain/v1/list-fuel-shortages",
    ],
  },
  {
    name: 'get_climate_data',
    _outputBudgetBytes: 131072,
    description: 'Climate intelligence: temperature/precipitation anomalies (vs 30-year WMO normals), climate-relevant disaster alerts (ReliefWeb/GDACS/FIRMS), atmospheric CO2 trend (NOAA Mauna Loa), air quality (OpenAQ/WAQI PM2.5 stations), Arctic sea ice extent and ocean heat indicators (NSIDC/NOAA), weather alerts, and climate news.',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['anomalies', 'disasters', 'co2-monitoring', 'air-quality', 'ocean-ice', 'news-intelligence', 'alerts'],
          },
          description: 'Restrict the response to one or more climate sub-datasets. Omit for the full bundle.',
        },
        country: {
          type: 'string',
          description: 'Filter the country-tagged datasets (climate disasters, air-quality stations) to one ISO 3166-1 alpha-2 code.',
        },
        limit: { type: 'number', description: 'Cap each list dataset (anomalies, disasters, stations, news, alerts) to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      anomalies: { type: ['object', 'null'], properties: { anomalies: { type: 'array', items: { type: 'object' } } } },
      disasters: { type: ['object', 'null'], properties: { disasters: { type: 'array', items: { type: 'object', properties: {
        countryCode: { type: 'string' }, type: { type: 'string' }, severity: { type: 'string' },
      } } } } },
      'co2-monitoring': { type: ['object', 'null'] },
      'air-quality': { type: ['object', 'null'], properties: { stations: { type: 'array', items: { type: 'object', properties: {
        country_code: { type: 'string' }, city: { type: 'string' }, aqi: { type: ['number', 'null'] },
      } } } } },
      'ocean-ice': { type: ['object', 'null'] },
      'news-intelligence': { type: ['object', 'null'], properties: { items: { type: 'array', items: { type: 'object' } } } },
      alerts: { type: ['object', 'null'], properties: { alerts: { type: 'array', items: { type: 'object' } } } },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const countries = argStrList(params.country);
      const limit = (argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      if (countries.length > 0) {
        narrowNested(data, 'disasters', 'disasters', (d) => matchesCode(d.countryCode, countries));
        narrowNested(data, 'air-quality', 'stations', (s) => matchesCode(s.country_code, countries));
      }
      capNested(data, 'anomalies', 'anomalies', limit);
      capNested(data, 'disasters', 'disasters', limit);
      capNested(data, 'air-quality', 'stations', limit);
      capNested(data, 'news-intelligence', 'items', limit);
      capNested(data, 'alerts', 'alerts', limit);
      return selectDatasets(data, argStrList(params.dataset));
    },
    _cacheKeys: ['climate:anomalies:v2', 'climate:disasters:v1', 'climate:co2-monitoring:v1', 'climate:air-quality:v1', 'climate:ocean-ice:v1', 'climate:news-intelligence:v1', 'weather:alerts:v1'],
    _seedMetaKey: 'seed-meta:climate:co2-monitoring',
    _maxStaleMin: 2880,
    _freshnessChecks: [
      { key: 'seed-meta:climate:anomalies', maxStaleMin: 120 },
      { key: 'seed-meta:climate:disasters', maxStaleMin: 720 },
      { key: 'seed-meta:climate:co2-monitoring', maxStaleMin: 2880 },
      { key: 'seed-meta:health:air-quality', maxStaleMin: 180 },
      { key: 'seed-meta:climate:ocean-ice', maxStaleMin: 1440 },
      { key: 'seed-meta:climate:news-intelligence', maxStaleMin: 90 },
      { key: 'seed-meta:weather:alerts', maxStaleMin: 45 },
    ],
    _apiPaths: [
      "GET /api/climate/v1/get-co2-monitoring",
      "GET /api/climate/v1/get-ocean-ice-data",
      "GET /api/climate/v1/list-air-quality-data",
      "GET /api/climate/v1/list-climate-anomalies",
      "GET /api/climate/v1/list-climate-disasters",
      "GET /api/climate/v1/list-climate-news",
    ],
  },
  {
    name: 'get_infrastructure_status',
    _outputBudgetBytes: 131072,
    description: 'Internet infrastructure health: Cloudflare Radar outages and service status for major cloud providers and internet services.',
    inputSchema: {
      type: 'object',
      properties: {
        country: { type: 'string', description: 'Filter to one country by name (case-insensitive substring).' },
        severity: { type: 'string', description: 'Filter to one outage severity (case-insensitive substring).' },
        limit: { type: 'number', description: 'Cap the outage list to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      outages: {
        type: ['object', 'null'],
        properties: { outages: { type: 'array', items: { type: 'object', properties: {
          country: { type: 'string' }, severity: { type: 'string' }, asn: { type: ['number', 'string'] },
          startTime: { type: 'string' }, description: { type: 'string' },
        } } } },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const country = argStr(params.country);
      const severity = argStr(params.severity);
      if (country) narrowNested(data, 'outages', 'outages', (o) => ciIncludes(o.country, country));
      if (severity) narrowNested(data, 'outages', 'outages', (o) => ciIncludes(o.severity, severity));
      capNested(data, 'outages', 'outages', (argNum(params.limit) ?? DEFAULT_LIST_LIMIT));
      return data;
    },
    _cacheKeys: ['infra:outages:v1'],
    _seedMetaKey: 'seed-meta:infra:outages',
    _maxStaleMin: 30,
    _apiPaths: [
      "GET /api/infrastructure/v1/list-internet-outages",
    ],
  },
  {
    name: 'get_supply_chain_data',
    _outputBudgetBytes: 131072,
    description: 'Dry bulk shipping stress index, customs revenue flows, and COMTRADE bilateral trade data. Tracks global supply chain pressure and trade disruptions.',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: {
          type: 'array',
          items: { type: 'string', enum: ['shipping_stress', 'customs-revenue', 'flows'] },
          description: 'Restrict the response to one or more sub-datasets (dry-bulk shipping stress / customs revenue / COMTRADE flows). Omit for all.',
        },
        commodity: {
          type: 'string',
          description: 'Filter COMTRADE flows to one commodity — matches the HS code exactly or the commodity description by substring (e.g. "2709" or "crude").',
        },
        limit: { type: 'number', description: 'Cap each list dataset (carriers, months, flows) to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      shipping_stress: {
        type: ['object', 'null'],
        properties: { carriers: { type: 'array', items: { type: 'object', properties: {
          name: { type: 'string' }, stressScore: { type: ['number', 'null'] },
        } } } },
      },
      'customs-revenue': {
        type: ['object', 'null'],
        properties: { months: { type: 'array', items: { type: 'object', properties: {
          month: { type: 'string' }, revenueUsd: { type: ['number', 'null'] },
        } } } },
      },
      flows: {
        type: ['object', 'null'],
        properties: { flows: { type: 'array', items: { type: 'object', properties: {
          cmdCode: { type: 'string' }, cmdDesc: { type: 'string' }, reporter: { type: 'string' },
          partner: { type: 'string' }, value: { type: ['number', 'null'] },
        } } } },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const commodity = argStr(params.commodity);
      const limit = (argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      if (commodity) {
        narrowNested(data, 'flows', 'flows', (f) => argStr(f.cmdCode) === commodity || ciIncludes(f.cmdDesc, commodity));
      }
      capNested(data, 'shipping_stress', 'carriers', limit);
      capNested(data, 'customs-revenue', 'months', limit);
      capNested(data, 'flows', 'flows', limit);
      return selectDatasets(data, argStrList(params.dataset));
    },
    _cacheKeys: [
      'supply_chain:shipping_stress:v1',
      'trade:customs-revenue:v1',
      'comtrade:flows:v1',
    ],
    _seedMetaKey: 'seed-meta:trade:customs-revenue',
    _maxStaleMin: 2880,
    _apiPaths: [
      "GET /api/supply-chain/v1/get-shipping-stress",
      "GET /api/trade/v1/get-customs-revenue",
    ],
  },
  {
    name: 'get_tariff_trends',
    _outputBudgetBytes: 131072,
    description: 'Global trade and pricing indicators: US tariff trends (HTS-coded), BigMac index, FAO Food Price Index, and per-country national debt levels.',
    inputSchema: {
      type: 'object',
      properties: {
        dataset: {
          type: 'array',
          items: { type: 'string', enum: ['tariffs', 'bigmac', 'fao-ffpi', 'national-debt'] },
          description: 'Restrict the response to one or more sub-datasets. Omit for the full bundle.',
        },
        country: {
          type: 'string',
          description: 'Filter the per-country datasets to one ISO 3166-1 alpha-2 country code (e.g. "US"). It is translated to alpha-3 internally for the national-debt dataset; passing an alpha-3 code directly also works.',
        },
        limit: { type: 'number', description: 'Cap each list dataset (tariff datapoints, BigMac countries, debt entries) to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    // First cache key `trade:tariffs:v1:840:all:10` — NON_LABEL drops bare digits
    // (840, 10) and `v1`, lands on `all`.
    outputSchema: cacheEnvelope({
      all: {
        type: ['object', 'null'],
        properties: { datapoints: { type: 'array', items: { type: 'object', properties: {
          hsCode: { type: 'string' }, rate: { type: ['number', 'null'] }, country: { type: 'string' },
        } } } },
      },
      bigmac: {
        type: ['object', 'null'],
        properties: { countries: { type: 'array', items: { type: 'object', properties: {
          code: { type: 'string' }, priceLocal: { type: ['number', 'null'] }, priceUsd: { type: ['number', 'null'] },
        } } } },
      },
      'fao-ffpi': { type: ['object', 'null'] },
      'national-debt': {
        type: ['object', 'null'],
        properties: { entries: { type: 'array', items: { type: 'object', properties: {
          iso3: { type: 'string' }, value: { type: ['number', 'null'] }, year: { type: ['number', 'string'] },
        } } } },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const countries = argStrList(params.country);
      const limit = (argNum(params.limit) ?? DEFAULT_LIST_LIMIT);
      if (countries.length > 0) {
        narrowNested(data, 'bigmac', 'countries', (c) => matchesCode(c.code, countries));
        // national-debt entries are keyed by ISO alpha-3 (iso3:"USA"); the
        // country param is alpha-2 like the rest of the tool, so expand it.
        const debtCodes = [
          ...countries,
          ...compact(countries.map((c) => ISO2_TO_ISO3[c.toUpperCase()]?.toLowerCase())),
        ];
        narrowNested(data, 'national-debt', 'entries', (e) => matchesCode(e.iso3, debtCodes));
      }
      capNested(data, 'all', 'datapoints', limit);
      capNested(data, 'bigmac', 'countries', limit);
      capNested(data, 'national-debt', 'entries', limit);
      const ds = argStrList(params.dataset);
      if (ds.length > 0) {
        const map: Record<string, string> = { tariffs: 'all', bigmac: 'bigmac', 'fao-ffpi': 'fao-ffpi', 'national-debt': 'national-debt' };
        return selectDatasets(data, compact(ds.map((d) => map[d])));
      }
      return data;
    },
    // 4-key bundle spanning trade + economic domains. Cadences span hourly-ish
    // (tariffs co-pinned to 8h TARIFF_TTL) to monthly (FAO / national debt).
    // Per-key _freshnessChecks pulled from api/health.js::SEED_META so a slow
    // monthly key doesn't drag the aggregate stale flag and a fast tariff
    // outage isn't masked by a long FAO budget.
    _cacheKeys: [
      'trade:tariffs:v1:840:all:10',   // STANDALONE_KEYS::tariffTrendsUs
      'economic:bigmac:v1',            // BOOTSTRAP_KEYS::bigmac
      'economic:fao-ffpi:v1',          // BOOTSTRAP_KEYS::faoFoodPriceIndex
      'economic:national-debt:v1',     // BOOTSTRAP_KEYS::nationalDebt
    ],
    _seedMetaKey: 'seed-meta:trade:tariffs:v1:840:all:10',
    _maxStaleMin: 540, // tariff cron baseline; per-key budgets via _freshnessChecks below
    _freshnessChecks: [
      { key: 'seed-meta:trade:tariffs:v1:840:all:10', maxStaleMin: 540 },   // TARIFF_TTL 8h + 60min grace
      { key: 'seed-meta:economic:bigmac',             maxStaleMin: 10080 }, // weekly seed; 7d
      { key: 'seed-meta:economic:fao-ffpi',           maxStaleMin: 86400 }, // monthly seed; 60d (2× interval)
      { key: 'seed-meta:economic:national-debt',      maxStaleMin: 86400 }, // monthly seed; 60d (2× interval)
    ],
    _apiPaths: [
      "GET /api/economic/v1/get-fao-food-price-index",
      "GET /api/economic/v1/get-national-debt",
      "GET /api/economic/v1/list-bigmac-prices",
    ],
  },
  {
    name: 'get_chokepoint_status',
    _outputBudgetBytes: 131072,
    description: 'Live maritime chokepoint status: per-chokepoint vessel transit counts (10-min cadence), rolling transit summaries, per-port activity, plus static reference data (chokepoint geometry, canonical 13-chokepoint registry) and flow aggregates. Covers Suez, Hormuz, Malacca, Bab-el-Mandeb, Panama, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        chokepoint: {
          type: 'string',
          description: 'Filter to one chokepoint — matches by case-insensitive substring across the differing identifiers used by each dataset (e.g. "hormuz" matches "hormuz_strait", "Strait of Hormuz").',
        },
        dataset: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['transit-summaries', 'chokepoint_transits', '_countries', 'chokepoint-baselines', 'ref', 'chokepoint-flows'],
          },
          description: 'Restrict the response to one or more sub-datasets. Omit for the full bundle.',
        },
        limit: { type: 'number', description: 'Cap the chokepoint-baselines list and the _countries ISO2 index to at most this many items (default 30, pass 0 for no cap). Keyed-object maps (transit-summaries, chokepoint_transits, ref, chokepoint-flows) are intentionally not capped — use the `chokepoint` filter instead.' },
      },
      required: [],
    },
    // Schema validated against tests/fixtures/jmespath-samples/thin-get-chokepoint-status.response.json.
    outputSchema: cacheEnvelope({
      'transit-summaries': {
        type: ['object', 'null'],
        properties: {
          summaries: { type: 'object', additionalProperties: { type: 'object', properties: {
            todayTotal: { type: ['number', 'null'] }, todayTanker: { type: ['number', 'null'] },
            todayCargo: { type: ['number', 'null'] }, todayOther: { type: ['number', 'null'] },
            wowChangePct: { type: ['number', 'null'] }, riskLevel: { type: 'string' },
            incidentCount7d: { type: ['number', 'null'] }, disruptionPct: { type: ['number', 'null'] },
            riskSummary: { type: 'string' }, riskReportAction: { type: 'string' },
            anomaly: { type: 'object' }, dataAvailable: { type: 'boolean' },
          } } },
          fetchedAt: { type: ['number', 'string'] },
        },
      },
      chokepoint_transits: {
        type: ['object', 'null'],
        properties: {
          transits: { type: 'object', additionalProperties: { type: 'object' } },
          fetchedAt: { type: ['number', 'string'] },
        },
      },
      _countries: {
        type: ['array', 'object', 'null'],
        items: { type: 'string' },
      },
      'chokepoint-baselines': {
        type: ['object', 'null'],
        properties: {
          source: { type: 'string' }, referenceYear: { type: ['number', 'string'] },
          updatedAt: { type: 'string' },
          chokepoints: { type: 'array', items: { type: 'object', properties: {
            id: { type: 'string' }, relayId: { type: 'string' }, name: { type: 'string' },
          } } },
        },
      },
      ref: {
        type: ['object', 'null'],
        additionalProperties: { type: 'object' },
      },
      'chokepoint-flows': {
        type: ['object', 'null'],
        additionalProperties: { type: 'object' },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const cp = argStr(params.chokepoint);
      if (cp) {
        mapNested(data, 'transit-summaries', 'summaries', (m) => pickMapKeysLike(m, cp));
        mapNested(data, 'chokepoint_transits', 'transits', (m) => pickMapKeysLike(m, cp));
        data['chokepoint-flows'] = pickMapKeysLike(data['chokepoint-flows'], cp);
        narrowNested(data, 'chokepoint-baselines', 'chokepoints', (c) => ciIncludes(c.id, cp) || ciIncludes(c.relayId, cp) || ciIncludes(c.name, cp));
      }
      const limit = argNum(params.limit) ?? DEFAULT_LIST_LIMIT;
      capNested(data, 'chokepoint-baselines', 'chokepoints', limit);
      // _countries is the only top-level array in this bundle (string[] of ISO2 codes).
      capArrays(data, limit);
      return selectDatasets(data, argStrList(params.dataset));
    },
    // Maritime chokepoint bundle distinct from get_supply_chain_data (which keeps
    // shipping-stress + customs + comtrade). Cadences span 10-minute relay
    // (transit-summaries, chokepoint_transits) to ~400-day static registries
    // (chokepoint-baselines), so per-key _freshnessChecks pulled from
    // api/health.js::SEED_META — a fast transit outage isn't masked by the
    // slow chokepoint-baselines budget, and the long-cadence portwatch keys
    // don't drag aggregate stale flagging.
    //
    // Payload measurement (PR pre-merge, fun-toad-55127.upstash.io 2026-05-11):
    //   transit-summaries:v1                        — 6.8 KB
    //   chokepoint_transits:v1                      — 1.1 KB
    //   portwatch-ports:v1:_countries               — 0.9 KB
    //   energy:chokepoint-baselines:v1              — 0.6 KB
    //   portwatch:chokepoints:ref:v1                — 7.9 KB
    //   energy:chokepoint-flows:v1                  — 1.2 KB
    //   ────────────────────────────────────────────────────
    //   Total: 18.5 KB (well under the 200KB/single-key and 500KB/aggregate
    //   thresholds that historically tripped handler timeouts —
    //   see tests/transit-summaries.test.mjs:539-545).
    //
    // EXCLUDED on purpose: supply_chain:corridorrisk:v1 is an intermediate
    // key whose data flows through supply_chain:transit-summaries:v1
    // (api/health.js:461). U7 will add corridorrisk to EXCLUDED_FROM_MCP.
    _cacheKeys: [
      'supply_chain:transit-summaries:v1',          // STANDALONE_KEYS::transitSummaries
      'supply_chain:chokepoint_transits:v1',        // STANDALONE_KEYS::chokepointTransits
      'supply_chain:portwatch-ports:v1:_countries', // STANDALONE_KEYS::portwatchPortActivity
      'energy:chokepoint-baselines:v1',             // STANDALONE_KEYS::chokepointBaselines
      'portwatch:chokepoints:ref:v1',               // STANDALONE_KEYS::portwatchChokepointsRef
      'energy:chokepoint-flows:v1',                 // STANDALONE_KEYS::chokepointFlows
    ],
    _seedMetaKey: 'seed-meta:supply_chain:transit-summaries',
    _maxStaleMin: 30, // transit-summaries 10-min relay baseline; per-key budgets via _freshnessChecks below
    _freshnessChecks: [
      { key: 'seed-meta:supply_chain:transit-summaries',   maxStaleMin: 30 },             // 10-min relay; 30min = 3× interval
      { key: 'seed-meta:supply_chain:chokepoint_transits', maxStaleMin: 30 },             // 10-min relay; 30min = 3× interval
      { key: 'seed-meta:supply_chain:portwatch-ports',     maxStaleMin: 2160 },           // 12h cron; 36h = 3× interval
      { key: 'seed-meta:energy:chokepoint-baselines',      maxStaleMin: 60 * 24 * 400 },  // ~400d static registry
      { key: 'seed-meta:portwatch:chokepoints-ref',        maxStaleMin: 60 * 24 * 14 },   // weekly cron; 14d = 2× interval
      { key: 'seed-meta:energy:chokepoint-flows',          maxStaleMin: 720 },            // 6h cron; 12h = 2× interval
    ],
    _apiPaths: [
      "GET /api/intelligence/v1/get-country-port-activity",
      "GET /api/supply-chain/v1/get-chokepoint-status",
    ],
  },
  {
    name: 'get_positive_events',
    _outputBudgetBytes: 131072,
    description: 'Positive geopolitical events: diplomatic agreements, humanitarian aid, development milestones, and peace initiatives worldwide.',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['science-health', 'nature-wildlife', 'climate-wins', 'innovation-tech', 'humanity-kindness', 'culture-community'],
          description: 'Filter to one positive-event category.',
        },
        limit: { type: 'number', description: 'Cap the event list to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      'geo-bootstrap': {
        type: ['object', 'null'],
        properties: { events: { type: 'array', items: { type: 'object', properties: {
          category: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string' },
          date: { type: 'string' },
        } } } },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const category = argStr(params.category);
      if (category) narrowNested(data, 'geo-bootstrap', 'events', (e) => argStr(e.category) === category);
      capNested(data, 'geo-bootstrap', 'events', (argNum(params.limit) ?? DEFAULT_LIST_LIMIT));
      return data;
    },
    _cacheKeys: ['positive_events:geo-bootstrap:v1'],
    _seedMetaKey: 'seed-meta:positive-events:geo',
    _maxStaleMin: 60,
    _apiPaths: [
      'GET /api/positive-events/v1/list-positive-geo-events',
    ],
  },
  {
    name: 'get_radiation_data',
    _outputBudgetBytes: 131072,
    description: 'Radiation observation levels from global monitoring stations. Flags anomalous readings that may indicate nuclear incidents.',
    inputSchema: {
      type: 'object',
      properties: {
        country: { type: 'string', description: 'Filter to one country by name (case-insensitive substring).' },
        anomalous_only: {
          type: 'boolean',
          description: 'Drop observations with severity "normal" — keep only elevated/spike readings.',
        },
        limit: { type: 'number', description: 'Cap the observation list to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      observations: {
        type: ['object', 'null'],
        properties: { observations: { type: 'array', items: { type: 'object', properties: {
          country: { type: 'string' }, severity: { type: 'string' },
          stationName: { type: 'string' }, value: { type: ['number', 'null'] }, unit: { type: 'string' },
        } } } },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const country = argStr(params.country);
      if (country) narrowNested(data, 'observations', 'observations', (o) => ciIncludes(o.country, country));
      if (argBool(params.anomalous_only)) {
        narrowNested(data, 'observations', 'observations', (o) => !argStr(o.severity).endsWith('normal'));
      }
      capNested(data, 'observations', 'observations', (argNum(params.limit) ?? DEFAULT_LIST_LIMIT));
      return data;
    },
    _cacheKeys: ['radiation:observations:v1'],
    _seedMetaKey: 'seed-meta:radiation:observations',
    _maxStaleMin: 30,
    _apiPaths: [
      "GET /api/radiation/v1/list-radiation-observations",
    ],
  },
  {
    name: 'get_research_signals',
    _outputBudgetBytes: 131072,
    description: 'Tech and research event signals: emerging technology events bootstrap data from curated research feeds.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['conference', 'earnings', 'ipo', 'other'],
          description: 'Filter to one tech-event type.',
        },
        source: { type: 'string', description: 'Filter to one source feed (e.g. "techmeme", "dev.events", "curated").' },
        limit: { type: 'number', description: 'Cap the event list to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      'tech-events-bootstrap': {
        type: ['object', 'null'],
        properties: { events: { type: 'array', items: { type: 'object', properties: {
          type: { type: 'string' }, source: { type: 'string' },
          title: { type: 'string' }, date: { type: 'string' },
        } } } },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const type = argStr(params.type);
      const source = argStr(params.source);
      if (type) narrowNested(data, 'tech-events-bootstrap', 'events', (e) => argStr(e.type) === type);
      if (source) narrowNested(data, 'tech-events-bootstrap', 'events', (e) => argStr(e.source) === source);
      capNested(data, 'tech-events-bootstrap', 'events', (argNum(params.limit) ?? DEFAULT_LIST_LIMIT));
      return data;
    },
    _cacheKeys: ['research:tech-events-bootstrap:v1'],
    _seedMetaKey: 'seed-meta:research:tech-events',
    _maxStaleMin: 480,
    _apiPaths: [
      'GET /api/research/v1/list-tech-events',
    ],
  },
  {
    name: 'get_forecast_predictions',
    _outputBudgetBytes: 131072,
    description: 'AI-generated geopolitical and economic forecasts from WorldMonitor\'s predictive models. Covers upcoming risk events and probability assessments.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Filter to one forecast domain (exact, case-insensitive — e.g. "shipping", "energy", "macro").' },
        region: { type: 'string', description: 'Filter to one region/theater (case-insensitive substring).' },
        limit: { type: 'number', description: 'Cap the forecast list to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      predictions: {
        type: ['object', 'null'],
        properties: { predictions: { type: 'array', items: { type: 'object', properties: {
          domain: { type: 'string' }, region: { type: 'string' },
          probability: { type: ['number', 'null'] }, title: { type: 'string' },
        } } } },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const domain = argStr(params.domain);
      const region = argStr(params.region);
      if (domain) narrowNested(data, 'predictions', 'predictions', (p) => argStr(p.domain) === domain);
      if (region) narrowNested(data, 'predictions', 'predictions', (p) => ciIncludes(p.region, region));
      capNested(data, 'predictions', 'predictions', (argNum(params.limit) ?? DEFAULT_LIST_LIMIT));
      return data;
    },
    _cacheKeys: ['forecast:predictions:v2'],
    _seedMetaKey: 'seed-meta:forecast:predictions',
    _maxStaleMin: 90,
    _apiPaths: [
      "GET /api/forecast/v1/get-forecasts",
    ],
  },

  // -------------------------------------------------------------------------
  // Social velocity — cache read (Reddit signals, seeded by relay)
  // -------------------------------------------------------------------------
  {
    name: 'get_social_velocity',
    _outputBudgetBytes: 131072,
    description: 'Reddit geopolitical social velocity: top posts from worldnews, geopolitics, and related subreddits with engagement scores and trend signals.',
    inputSchema: {
      type: 'object',
      properties: {
        subreddit: { type: 'string', description: 'Filter to one subreddit (e.g. "worldnews", "geopolitics").' },
        limit: { type: 'number', description: 'Cap the post list to at most this many items (default 30, pass 0 for no cap).' },
      },
      required: [],
    },
    outputSchema: cacheEnvelope({
      reddit: {
        type: ['object', 'null'],
        properties: { posts: { type: 'array', items: { type: 'object', properties: {
          subreddit: { type: 'string' }, title: { type: 'string' },
          score: { type: ['number', 'null'] }, url: { type: 'string' }, createdAt: { type: ['string', 'number'] },
        } } } },
      },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _postFilter: (data, params) => {
      const sub = argStr(params.subreddit);
      if (sub) narrowNested(data, 'reddit', 'posts', (p) => argStr(p.subreddit) === sub);
      capNested(data, 'reddit', 'posts', (argNum(params.limit) ?? DEFAULT_LIST_LIMIT));
      return data;
    },
    _cacheKeys: ['intelligence:social:reddit:v1'],
    _seedMetaKey: 'seed-meta:intelligence:social-reddit',
    _maxStaleMin: 30,
    _apiPaths: [
      "GET /api/intelligence/v1/get-social-velocity",
    ],
  },

  // -------------------------------------------------------------------------
  // AI inference tools — call LLM endpoints, not cached Redis reads
  // -------------------------------------------------------------------------
  {
    name: 'get_world_brief',
    _outputBudgetBytes: 65536,
    description: 'AI-generated world intelligence brief. Fetches the latest geopolitical headlines along with their RSS article bodies and produces a grounded LLM-summarized brief. Supply an optional geo_context to focus on a region or topic.',
    inputSchema: {
      type: 'object',
      properties: {
        geo_context: { type: 'string', description: 'Optional focus context (e.g. "Middle East tensions", "US-China trade war")' },
      },
      required: [],
    },
    // RPC tool: returns the raw body of /api/news/v1/summarize-article (LLM brief).
    outputSchema: {
      type: 'object',
      properties: {
        brief: { type: 'string', description: 'LLM-summarized geopolitical brief.' },
        summary: { type: 'string', description: 'Alternate naming used by some upstream variants.' },
        headlines: { type: 'array', items: { type: 'string' } },
        provider: { type: 'string' },
        model: { type: 'string' },
        generatedAt: { type: ['string', 'number', 'null'] },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _execute: async (params, base, context) => {
      const UA = 'worldmonitor-mcp-edge/1.0';
      // Step 1: fetch current geopolitical headlines (budget: 6 s, leaves ~24 s for LLM)
      const digestUrl = `${base}/api/news/v1/list-feed-digest?variant=geo&lang=en`;
      const digestAuth = await buildAuthHeaders(context, 'GET', digestUrl, null);
      const digestRes = await fetch(digestUrl, {
        headers: { ...digestAuth, 'User-Agent': UA },
        signal: AbortSignal.timeout(6_000),
      });
      if (!digestRes.ok) throw new Error(`feed-digest HTTP ${digestRes.status}`);
      type DigestPayload = { categories?: Record<string, { items?: { title?: string; snippet?: string }[] }> };
      const digest = await digestRes.json() as DigestPayload;
      // Pair headlines with their RSS snippets so the LLM grounds per-story
      // on article bodies instead of hallucinating across unrelated titles.
      const pairs = Object.values(digest.categories ?? {})
        .flatMap(cat => cat.items ?? [])
        .map(item => ({ title: item.title ?? '', snippet: item.snippet ?? '' }))
        .filter(p => p.title.length > 0)
        .slice(0, 10);
      const headlines = pairs.map(p => p.title);
      const bodies = pairs.map(p => p.snippet);
      // Step 2: summarize with LLM (budget: 18 s — combined 24 s, well under 30 s edge ceiling)
      const briefUrl = `${base}/api/news/v1/summarize-article`;
      const briefBody = JSON.stringify({
        provider: 'openrouter',
        headlines,
        bodies,
        mode: 'brief',
        geoContext: String(params.geo_context ?? ''),
        variant: 'geo',
        lang: 'en',
      });
      const briefAuth = await buildAuthHeaders(context, 'POST', briefUrl, briefBody);
      const briefRes = await fetch(briefUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...briefAuth, 'User-Agent': UA },
        body: briefBody,
        signal: AbortSignal.timeout(18_000),
      });
      if (!briefRes.ok) throw new Error(`summarize-article HTTP ${briefRes.status}`);
      return briefRes.json();
    },
    _apiPaths: [
      "GET /api/news/v1/list-feed-digest",
      "POST /api/news/v1/summarize-article",
    ],
  },
  {
    name: 'get_country_brief',
    _outputBudgetBytes: 65536,
    description: 'AI-generated per-country intelligence brief. Produces an LLM-analyzed geopolitical and economic assessment for the given country. Supports analytical frameworks for structured lenses.',
    inputSchema: {
      type: 'object',
      properties: {
        country_code: { type: 'string', description: 'ISO 3166-1 alpha-2 country code, e.g. "US", "DE", "CN", "IR"' },
        framework: { type: 'string', description: 'Optional analytical framework instructions to shape the analysis lens (e.g. Ray Dalio debt cycle, PMESII-PT)' },
      },
      required: ['country_code'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        country_code: { type: 'string' },
        brief: { type: 'string', description: 'LLM-synthesized country intelligence brief.' },
        framework: { type: 'string' },
        generatedAt: { type: ['string', 'number', 'null'] },
        provider: { type: 'string' },
        model: { type: 'string' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _execute: async (params, base, context) => {
      const UA = 'worldmonitor-mcp-edge/1.0';
      const countryCode = String(params.country_code ?? '').toUpperCase().slice(0, 2);

      // Fetch current geopolitical headlines to ground the LLM (budget: 2 s — cached endpoint).
      // Without context the model hallucinates events — real headlines anchor it.
      // 2 s + 22 s brief = 24 s worst-case; 6 s margin before the 30 s Edge kill.
      let contextParam = '';
      try {
        const digestUrl = `${base}/api/news/v1/list-feed-digest?variant=geo&lang=en`;
        const digestAuth = await buildAuthHeaders(context, 'GET', digestUrl, null);
        const digestRes = await fetch(digestUrl, {
          headers: { ...digestAuth, 'User-Agent': UA },
          signal: AbortSignal.timeout(2_000),
        });
        if (digestRes.ok) {
          type DigestPayload = { categories?: Record<string, { items?: { title?: string }[] }> };
          const digest = await digestRes.json() as DigestPayload;
          const headlines = Object.values(digest.categories ?? {})
            .flatMap(cat => cat.items ?? [])
            .map(item => item.title ?? '')
            .filter(Boolean)
            .slice(0, 15)
            .join('\n');
          if (headlines) contextParam = encodeURIComponent(headlines.slice(0, 4000));
        }
      } catch { /* proceed without context — better than failing */ }

      const briefUrl = contextParam
        ? `${base}/api/intelligence/v1/get-country-intel-brief?context=${contextParam}`
        : `${base}/api/intelligence/v1/get-country-intel-brief`;

      const briefBody = JSON.stringify({ country_code: countryCode, framework: String(params.framework ?? '') });
      const briefAuth = await buildAuthHeaders(context, 'POST', briefUrl, briefBody);
      const res = await fetch(briefUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...briefAuth, 'User-Agent': UA },
        body: briefBody,
        signal: AbortSignal.timeout(22_000),
      });
      if (!res.ok) throw new Error(`get-country-intel-brief HTTP ${res.status}`);
      return res.json();
    },
    // METHOD DRIFT: _execute POSTs above but OpenAPI declares only GET on this
    // path (verified against docs/api/IntelligenceService.openapi.json). The
    // gateway routes by path, not method, so POST works at runtime. We declare
    // GET here because OpenAPI is the parity test's source-of-truth — fixing
    // the spec to add POST (or migrating the handler to GET) is out of scope.
    _apiPaths: [
      "GET /api/intelligence/v1/get-country-intel-brief",
    ],
  },
  {
    name: 'get_country_risk',
    _outputBudgetBytes: 262144,
    description: 'Structured risk intelligence for a specific country: Composite Instability Index (CII) score 0-100, component breakdown (unrest/conflict/security/news), travel advisory level, and OFAC sanctions exposure. Fast Redis read — no LLM. Use for quantitative risk screening or to answer "how risky is X right now?"',
    inputSchema: {
      type: 'object',
      properties: {
        country_code: { type: 'string', description: 'ISO 3166-1 alpha-2 country code, e.g. "RU", "IR", "CN", "UA"' },
      },
      required: ['country_code'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        country_code: { type: 'string' },
        cii: { type: ['number', 'null'], description: 'Composite Instability Index 0-100.' },
        components: {
          type: 'object',
          properties: {
            unrest: { type: ['number', 'null'] },
            conflict: { type: ['number', 'null'] },
            security: { type: ['number', 'null'] },
            news: { type: ['number', 'null'] },
          },
        },
        travelAdvisory: { type: ['object', 'string', 'null'] },
        sanctionsExposure: { type: ['object', 'array', 'null'] },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _execute: async (params, base, context) => {
      const code = String(params.country_code ?? '').toUpperCase().slice(0, 2);
      const url = `${base}/api/intelligence/v1/get-country-risk?country_code=${encodeURIComponent(code)}`;
      const auth = await buildAuthHeaders(context, 'GET', url, null);
      const res = await fetch(url, {
        headers: { ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) throw new Error(`get-country-risk HTTP ${res.status}`);
      return res.json();
    },
    _apiPaths: [
      "GET /api/intelligence/v1/get-country-risk",
    ],
  },
  {
    name: 'get_consumer_prices',
    _outputBudgetBytes: 262144,
    description: "Per-country consumer-prices intelligence: 30-day overview, category-level inflation, retailer spread (essentials basket), top movers, and source freshness. Requires country_code (currently only 'ae' is seeded).",
    inputSchema: {
      type: 'object',
      properties: {
        country_code: {
          type: 'string',
          description: 'ISO 3166-1 alpha-2 country code. Currently supported: AE (case-insensitive).',
        },
      },
      required: ['country_code'],
    },
    // Hybrid _execute — success path returns the envelope below; missing/unknown
    // country_code returns `{error: "..."}` instead (result-level user-input error).
    outputSchema: {
      type: 'object',
      properties: {
        cached_at: { type: ['string', 'null'] },
        stale: { type: 'boolean' },
        country_code: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            overview: { type: ['object', 'null'] },
            categories: { type: ['object', 'array', 'null'] },
            movers: { type: ['object', 'array', 'null'] },
            retailerSpread: { type: ['object', 'array', 'null'] },
            freshness: { type: ['object', 'null'] },
          },
        },
        error: { type: 'string', description: 'Present only on user-input failure (missing/unknown country_code).' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    // Hybrid _execute (not a pure cache tool) because the cache keys are
    // parameterised by country. Mirrors api/health.js::BOOTSTRAP_KEYS:55-59
    // exactly so the U7 Tier-3 parity test treats every key as covered.
    _coverageKeys: [
      'consumer-prices:overview:ae',
      'consumer-prices:categories:ae:30d',
      'consumer-prices:movers:ae:30d',
      'consumer-prices:retailer-spread:ae:essentials-ae',
      'consumer-prices:freshness:ae',
    ],
    _execute: async (params) => {
      // Result-level errors (NOT throws) for user-input issues — the dispatcher
      // maps thrown errors to JSON-RPC -32603 "Internal error", which is
      // misleading for a clearly-user-side fault like a missing/unknown
      // country_code. Returning {error: ...} surfaces a usable message via
      // the normal tools/call result envelope.
      if (!params.country_code || typeof params.country_code !== 'string') {
        return { error: 'country_code is required' };
      }
      const code = params.country_code.toLowerCase();
      // Strict ISO 3166-1 alpha-2 shape: exactly two lowercase letters.
      // Without this, .slice(0,2) would silently truncate inputs like
      // "aexxx" or "AE-DXB" to "ae" and serve AE data — masking client bugs.
      if (!/^[a-z]{2}$/.test(code)) {
        return { error: 'country_code must be a two-letter ISO code (e.g. "ae")' };
      }
      if (!SUPPORTED_CONSUMER_PRICES_COUNTRIES.has(code)) {
        return { error: 'Country not yet supported. Available: ae' };
      }

      const dataKeys = [
        `consumer-prices:overview:${code}`,
        `consumer-prices:categories:${code}:30d`,
        `consumer-prices:movers:${code}:30d`,
        `consumer-prices:retailer-spread:${code}:essentials-${code}`,
        `consumer-prices:freshness:${code}`,
      ];

      // Freshness checks use the producer's actual meta keys. Note the spread
      // entry: scripts/seed-consumer-prices.mjs:151 writes
      // `seed-meta:consumer-prices:spread:<code>` (NO `retailer-` prefix,
      // NO `:essentials-<code>` suffix). api/health.js:337 has the documented
      // drift bug (expects `retailer-spread:<code>:essentials-<code>` which
      // never exists) and so would always report stale; we deliberately
      // diverge from health.js here to match the actual producer.
      const freshnessChecks: FreshnessCheck[] = [
        { key: `seed-meta:consumer-prices:overview:${code}`,      maxStaleMin: 1500 }, // 25h = 24h cron + 1h grace
        { key: `seed-meta:consumer-prices:categories:${code}:30d`, maxStaleMin: 1500 },
        { key: `seed-meta:consumer-prices:movers:${code}:30d`,     maxStaleMin: 1500 },
        { key: `seed-meta:consumer-prices:spread:${code}`,         maxStaleMin: 1500 }, // producer's actual key shape
        { key: `seed-meta:consumer-prices:freshness:${code}`,      maxStaleMin: 1500 },
      ];

      const [dataResults, metaResults] = await Promise.all([
        Promise.all(dataKeys.map((k) => readJsonFromUpstash(k))),
        Promise.all(freshnessChecks.map((c) => readJsonFromUpstash(c.key))),
      ]);

      // F6 contract parity with the cache-tool path (executeTool, ~line 1139):
      // if every data read is null/undefined, this is a degenerate-empty
      // response (Redis transient / stampede / pre-seed). Throw so
      // dispatchToolsCall's catch fires proRollback — without this, the Pro
      // user's daily MCP counter increments by 1 for a useless result while
      // every other cache-tool refunds via the same code path.
      if (dataResults.every((v: unknown) => v === null || v === undefined)) {
        throw new Error('cache_all_null');
      }

      const { cached_at, stale } = evaluateFreshness(freshnessChecks, metaResults);

      return {
        cached_at,
        stale,
        country_code: code,
        data: {
          overview: dataResults[0],
          categories: dataResults[1],
          movers: dataResults[2],
          retailerSpread: dataResults[3],
          freshness: dataResults[4],
        },
      };
    },
    // Hybrid tool covers the consumer-prices domain via direct Redis reads
    // of the same keys the per-method handlers expose via the API. The
    // OpenAPI ops listed here read parameterized keys (the audit's
    // manual-mapping case); this MCP tool wraps the 'ae'-instance equivalent.
    //
    // NOTE: `get-consumer-price-basket-series` is NOT covered here — that
    // handler reads `consumer-prices:basket-series:${market}:${basket}:${range}`
    // which is a separate parameterized time-series key, NOT in this tool's
    // `_coverageKeys`. Excluded as `deferred-to-future-tool` in
    // tests/mcp-api-parity.test.mjs until a future expanded_consumer_prices
    // tool exposes the basket-series time series.
    _apiPaths: [
      'GET /api/consumer-prices/v1/get-consumer-price-freshness',
      'GET /api/consumer-prices/v1/get-consumer-price-overview',
      'GET /api/consumer-prices/v1/list-consumer-price-categories',
      'GET /api/consumer-prices/v1/list-consumer-price-movers',
      'GET /api/consumer-prices/v1/list-retailer-price-spreads',
    ],
  },
  {
    name: 'get_airspace',
    _outputBudgetBytes: 262144,
    description: 'Live ADS-B aircraft over a country. Returns civilian flights (OpenSky) and identified military aircraft with callsigns, positions, altitudes, and headings. Answers questions like "how many planes are over the UAE right now?" or "are there military aircraft over Taiwan?"',
    inputSchema: {
      type: 'object',
      properties: {
        country_code: {
          type: 'string',
          description: 'ISO 3166-1 alpha-2 country code (e.g. "AE", "US", "GB", "JP")',
        },
        type: {
          type: 'string',
          enum: ['all', 'civilian', 'military'],
          description: 'Filter: all flights (default), civilian only, or military only',
        },
      },
      required: ['country_code'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        country_code: { type: 'string' },
        bounding_box: { type: 'object', properties: {
          sw_lat: { type: 'number' }, sw_lon: { type: 'number' },
          ne_lat: { type: 'number' }, ne_lon: { type: 'number' },
        } },
        civilian_count: { type: 'number' },
        military_count: { type: 'number' },
        civilian_flights: { type: 'array', items: { type: 'object', properties: {
          callsign: { type: 'string' }, icao24: { type: 'string' },
          lat: { type: 'number' }, lon: { type: 'number' },
          altitude_m: { type: ['number', 'null'] }, speed_kts: { type: ['number', 'null'] },
          heading_deg: { type: ['number', 'null'] }, on_ground: { type: 'boolean' },
        } } },
        military_flights: { type: 'array', items: { type: 'object', properties: {
          callsign: { type: 'string' }, hex_code: { type: 'string' },
          aircraft_type: { type: 'string' }, aircraft_model: { type: 'string' },
          operator: { type: 'string' }, operator_country: { type: 'string' },
          lat: { type: ['number', 'null'] }, lon: { type: ['number', 'null'] },
          altitude: { type: ['number', 'null'] }, heading: { type: ['number', 'null'] },
          speed: { type: ['number', 'null'] }, is_interesting: { type: 'boolean' }, note: { type: 'string' },
        } } },
        partial: { type: 'boolean', description: 'True if one of the two upstream sources failed.' },
        warnings: { type: 'array', items: { type: 'string' } },
        source: { type: 'string' },
        updated_at: { type: 'string' },
        error: { type: 'string', description: 'Present only on unknown country_code.' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _execute: async (params, base, context) => {
      const code = String(params.country_code ?? '').toUpperCase().slice(0, 2);
      const bbox = COUNTRY_BBOXES[code];
      if (!bbox) return { error: `Unknown country code: ${code}. Use ISO 3166-1 alpha-2 (e.g. "AE", "US", "GB").` };
      const [sw_lat, sw_lon, ne_lat, ne_lon] = bbox;
      const type = String(params.type ?? 'all');
      const UA = 'worldmonitor-mcp-edge/1.0';
      const bboxQ = `sw_lat=${sw_lat}&sw_lon=${sw_lon}&ne_lat=${ne_lat}&ne_lon=${ne_lon}`;

      type CivilianResp = {
        positions?: { callsign: string; icao24: string; lat: number; lon: number; altitude_m: number; ground_speed_kts: number; track_deg: number; on_ground: boolean }[];
        source?: string;
        updated_at?: number;
      };
      type MilResp = {
        flights?: { callsign: string; hex_code: string; aircraft_type: string; aircraft_model: string; operator: string; operator_country: string; location?: { latitude: number; longitude: number }; altitude: number; heading: number; speed: number; is_interesting: boolean; note: string }[];
      };

      const civUrl = `${base}/api/aviation/v1/track-aircraft?${bboxQ}`;
      const milUrl = `${base}/api/military/v1/list-military-flights?${bboxQ}&page_size=100`;
      const civAuth = type === 'military' ? null : await buildAuthHeaders(context, 'GET', civUrl, null);
      const milAuth = type === 'civilian' ? null : await buildAuthHeaders(context, 'GET', milUrl, null);

      const [civResult, milResult] = await Promise.allSettled([
        type === 'military' || !civAuth
          ? Promise.resolve(null)
          : fetch(civUrl, { headers: { ...civAuth, 'User-Agent': UA }, signal: AbortSignal.timeout(8_000) })
              .then(r => r.ok ? r.json() as Promise<CivilianResp> : Promise.reject(new Error(`HTTP ${r.status}`))),
        type === 'civilian' || !milAuth
          ? Promise.resolve(null)
          : fetch(milUrl, { headers: { ...milAuth, 'User-Agent': UA }, signal: AbortSignal.timeout(8_000) })
              .then(r => r.ok ? r.json() as Promise<MilResp> : Promise.reject(new Error(`HTTP ${r.status}`))),
      ]);

      const civOk = type === 'military' || civResult.status === 'fulfilled';
      const milOk = type === 'civilian' || milResult.status === 'fulfilled';

      // Both sources down — total outage, don't return misleading empty data
      if (!civOk && !milOk) throw new Error('Airspace data unavailable: both civilian and military sources failed');

      const civ = civResult.status === 'fulfilled' ? civResult.value : null;
      const mil = milResult.status === 'fulfilled' ? milResult.value : null;
      const warnings: string[] = [];
      if (!civOk) warnings.push('civilian ADS-B data unavailable');
      if (!milOk) warnings.push('military flight data unavailable');

      const civilianFlights = (civ?.positions ?? []).slice(0, 100).map(p => ({
        callsign: p.callsign, icao24: p.icao24,
        lat: p.lat, lon: p.lon,
        altitude_m: p.altitude_m, speed_kts: p.ground_speed_kts,
        heading_deg: p.track_deg, on_ground: p.on_ground,
      }));
      const militaryFlights = (mil?.flights ?? []).slice(0, 100).map(f => ({
        callsign: f.callsign, hex_code: f.hex_code,
        aircraft_type: f.aircraft_type, aircraft_model: f.aircraft_model,
        operator: f.operator, operator_country: f.operator_country,
        lat: f.location?.latitude, lon: f.location?.longitude,
        altitude: f.altitude, heading: f.heading, speed: f.speed,
        is_interesting: f.is_interesting, ...(f.note ? { note: f.note } : {}),
      }));

      return {
        country_code: code,
        bounding_box: { sw_lat, sw_lon, ne_lat, ne_lon },
        civilian_count: civilianFlights.length,
        military_count: militaryFlights.length,
        ...(type !== 'military' && { civilian_flights: civilianFlights }),
        ...(type !== 'civilian' && { military_flights: militaryFlights }),
        ...(warnings.length > 0 && { partial: true, warnings }),
        source: civ?.source ?? 'opensky',
        updated_at: civ?.updated_at ? new Date(civ.updated_at).toISOString() : new Date().toISOString(),
      };
    },
    _apiPaths: [
      "GET /api/aviation/v1/track-aircraft",
      "GET /api/military/v1/list-military-flights",
    ],
  },
  {
    name: 'get_maritime_activity',
    _outputBudgetBytes: 262144,
    description: "Live vessel traffic and maritime disruptions for a country's waters. Returns AIS density zones (ships-per-day, intensity score), dark ship events, and chokepoint congestion from AIS tracking.",
    inputSchema: {
      type: 'object',
      properties: {
        country_code: {
          type: 'string',
          description: 'ISO 3166-1 alpha-2 country code (e.g. "AE", "SA", "JP", "EG")',
        },
      },
      required: ['country_code'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        country_code: { type: 'string' },
        bounding_box: { type: 'object', properties: {
          sw_lat: { type: 'number' }, sw_lon: { type: 'number' },
          ne_lat: { type: 'number' }, ne_lon: { type: 'number' },
        } },
        snapshot_at: { type: 'string' },
        total_zones: { type: 'number' },
        total_disruptions: { type: 'number' },
        density_zones: { type: 'array', items: { type: 'object', properties: {
          name: { type: 'string' }, intensity: { type: ['number', 'null'] },
          ships_per_day: { type: ['number', 'null'] }, delta_pct: { type: ['number', 'null'] }, note: { type: 'string' },
        } } },
        disruptions: { type: 'array', items: { type: 'object', properties: {
          name: { type: 'string' }, type: { type: 'string' }, severity: { type: 'string' },
          dark_ships: { type: ['number', 'null'] }, vessel_count: { type: ['number', 'null'] },
          region: { type: 'string' }, description: { type: 'string' },
        } } },
        error: { type: 'string', description: 'Present only on unknown country_code.' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _execute: async (params, base, context) => {
      const code = String(params.country_code ?? '').toUpperCase().slice(0, 2);
      const bbox = COUNTRY_BBOXES[code];
      if (!bbox) return { error: `Unknown country code: ${code}. Use ISO 3166-1 alpha-2 (e.g. "AE", "SA", "JP").` };
      const [sw_lat, sw_lon, ne_lat, ne_lon] = bbox;
      const bboxQ = `sw_lat=${sw_lat}&sw_lon=${sw_lon}&ne_lat=${ne_lat}&ne_lon=${ne_lon}`;
      const url = `${base}/api/maritime/v1/get-vessel-snapshot?${bboxQ}`;
      const auth = await buildAuthHeaders(context, 'GET', url, null);

      type VesselResp = {
        snapshot?: {
          snapshot_at?: number;
          density_zones?: { name: string; intensity: number; ships_per_day: number; delta_pct: number; note: string }[];
          disruptions?: { name: string; type: string; severity: string; dark_ships: number; vessel_count: number; region: string; description: string }[];
        };
      };

      const res = await fetch(url, {
        headers: { ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) throw new Error(`get-vessel-snapshot HTTP ${res.status}`);
      const data = await res.json() as VesselResp;
      const snap = data.snapshot ?? {};

      return {
        country_code: code,
        bounding_box: { sw_lat, sw_lon, ne_lat, ne_lon },
        snapshot_at: snap.snapshot_at ? new Date(snap.snapshot_at).toISOString() : new Date().toISOString(),
        total_zones: (snap.density_zones ?? []).length,
        total_disruptions: (snap.disruptions ?? []).length,
        density_zones: (snap.density_zones ?? []).map(z => ({
          name: z.name, intensity: z.intensity, ships_per_day: z.ships_per_day,
          delta_pct: z.delta_pct, ...(z.note ? { note: z.note } : {}),
        })),
        disruptions: (snap.disruptions ?? []).map(d => ({
          name: d.name, type: d.type, severity: d.severity,
          dark_ships: d.dark_ships, vessel_count: d.vessel_count,
          region: d.region, description: d.description,
        })),
      };
    },
    _apiPaths: [
      "GET /api/maritime/v1/get-vessel-snapshot",
    ],
  },
  {
    name: 'analyze_situation',
    _outputBudgetBytes: 65536,
    description: 'AI geopolitical situation analysis (DeductionPanel). Provide a query and optional geo-political context; returns an LLM-powered analytical deduction with confidence and supporting signals.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The question or situation to analyze, e.g. "What are the implications of the Taiwan strait escalation for semiconductor supply chains?"' },
        context: { type: 'string', description: 'Optional additional geo-political context to include in the analysis' },
        framework: { type: 'string', description: 'Optional analytical framework instructions to shape the analysis lens (e.g. Ray Dalio debt cycle, PMESII-PT, Porter\'s Five Forces)' },
      },
      required: ['query'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        deduction: { type: 'string', description: 'LLM-generated analytical deduction.' },
        analysis: { type: 'string', description: 'Alternate naming for the body.' },
        confidence: { type: ['number', 'string', 'null'] },
        signals: { type: ['array', 'object', 'null'] },
        framework: { type: 'string' },
        generatedAt: { type: ['string', 'number', 'null'] },
        provider: { type: 'string' },
        model: { type: 'string' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _execute: async (params, base, context) => {
      const url = `${base}/api/intelligence/v1/deduct-situation`;
      const body = JSON.stringify({ query: String(params.query ?? ''), geoContext: String(params.context ?? ''), framework: String(params.framework ?? '') });
      const auth = await buildAuthHeaders(context, 'POST', url, body);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        body,
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) throw new Error(`deduct-situation HTTP ${res.status}`);
      return res.json();
    },
    _apiPaths: [
      "POST /api/intelligence/v1/deduct-situation",
    ],
  },
  {
    name: 'generate_forecasts',
    _outputBudgetBytes: 65536,
    description: 'Generate live AI geopolitical and economic forecasts. Unlike get_forecast_predictions (pre-computed cache), this calls the forecasting model directly for fresh probability estimates. Note: slower than cache tools.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Forecast domain: "geopolitical", "economic", "military", "climate", or empty for all domains' },
        region: { type: 'string', description: 'Geographic region filter, e.g. "Middle East", "Europe", "Asia Pacific", or empty for global' },
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      properties: {
        forecasts: { type: 'array', items: { type: 'object', properties: {
          domain: { type: 'string' }, region: { type: 'string' },
          probability: { type: ['number', 'null'] }, title: { type: 'string' }, rationale: { type: 'string' },
        } } },
        generatedAt: { type: ['string', 'number', 'null'] },
        provider: { type: 'string' },
        model: { type: 'string' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _execute: async (params, base, context) => {
      // 25 s — stays within Vercel Edge's ~30 s hard ceiling (was 60 s, which exceeded the limit)
      const url = `${base}/api/forecast/v1/get-forecasts`;
      const body = JSON.stringify({ domain: String(params.domain ?? ''), region: String(params.region ?? '') });
      const auth = await buildAuthHeaders(context, 'POST', url, body);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        body,
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) throw new Error(`get-forecasts HTTP ${res.status}`);
      return res.json();
    },
    _apiPaths: [],
  },
  {
    name: 'search_flights',
    _outputBudgetBytes: 262144,
    description: 'Search Google Flights for real-time flight options between two airports on a specific date. Returns available flights with prices, stops, airline, and segment details. Use IATA airport codes (e.g. "JFK", "LHR", "DXB").',
    inputSchema: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: 'IATA code for the departure airport, e.g. "JFK"' },
        destination: { type: 'string', description: 'IATA code for the arrival airport, e.g. "LHR"' },
        departure_date: { type: 'string', description: 'Departure date in YYYY-MM-DD format' },
        return_date: { type: 'string', description: 'Return date in YYYY-MM-DD format for round trips (optional)' },
        cabin_class: { type: 'string', description: 'Cabin class: "economy", "premium_economy", "business", or "first" (optional, default economy)' },
        max_stops: { type: 'string', description: 'Max stops: "0" or "non_stop" for nonstop, "1" or "one_stop" for max one stop, or omit for any (optional)' },
        passengers: { type: 'number', description: 'Number of passengers (1-9, default 1)' },
        sort_by: { type: 'string', description: 'Sort order: "price" (cheapest), "duration", "departure", or "arrival" (optional)' },
      },
      required: ['origin', 'destination', 'departure_date'],
    },
    // Proxies SerpAPI Google Flights. Shape mirrors that upstream's JSON
    // envelope — keep schema permissive on field types since SerpAPI rotates.
    outputSchema: {
      type: 'object',
      properties: {
        flights: { type: 'array', items: { type: 'object', properties: {
          price: { type: ['number', 'string', 'null'] }, currency: { type: 'string' },
          stops: { type: ['number', 'null'] }, airline: { type: 'string' },
          total_duration: { type: ['number', 'string', 'null'] },
          segments: { type: 'array', items: { type: 'object' } },
        } } },
        search_metadata: { type: ['object', 'null'] },
        error: { type: 'string', description: 'Present when upstream returned a usable error message.' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _execute: async (params, base, context) => {
      const qs = new URLSearchParams({
        origin: String(params.origin ?? ''),
        destination: String(params.destination ?? ''),
        departure_date: String(params.departure_date ?? ''),
        ...(params.return_date ? { return_date: String(params.return_date) } : {}),
        // Default to economy when the LLM omits cabin_class. The relay /
        // upstream SerpAPI returns ZERO flights for some popular routes
        // (e.g. JFK→LHR) when cabin_class is unset, even though the tool
        // description advertises "default economy". Diagnosis: live probe
        // showed empty `flights` with no error AND no degraded flag; adding
        // `cabin_class=economy` to the same call returned 10+ real flights.
        // This restores the advertised contract.
        cabin_class: String(params.cabin_class ?? 'economy'),
        ...(params.max_stops ? { max_stops: String(params.max_stops) } : {}),
        ...(params.sort_by ? { sort_by: String(params.sort_by) } : {}),
        passengers: String(Math.max(1, Math.min(Number(params.passengers ?? 1), 9))),
      });
      const url = `${base}/api/aviation/v1/search-google-flights?${qs}`;
      const auth = await buildAuthHeaders(context, 'GET', url, null);
      const res = await fetch(url, {
        headers: { ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) throw new Error(`search-google-flights HTTP ${res.status}`);
      return res.json();
    },
    _apiPaths: [
      "GET /api/aviation/v1/search-google-flights",
    ],
  },
  {
    name: 'search_flight_prices_by_date',
    _outputBudgetBytes: 262144,
    description: 'Search Google Flights date-grid pricing across a date range. Returns cheapest prices for each departure date between two airports. Useful for finding the cheapest day to fly. Use IATA airport codes.',
    inputSchema: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: 'IATA code for the departure airport, e.g. "JFK"' },
        destination: { type: 'string', description: 'IATA code for the arrival airport, e.g. "LHR"' },
        start_date: { type: 'string', description: 'Start of the date range in YYYY-MM-DD format' },
        end_date: { type: 'string', description: 'End of the date range in YYYY-MM-DD format' },
        is_round_trip: { type: 'boolean', description: 'Whether to search round-trip prices (default false). Requires trip_duration when true.' },
        trip_duration: { type: 'number', description: 'Trip duration in days — required when is_round_trip is true (e.g. 7 for a one-week trip)' },
        cabin_class: { type: 'string', description: 'Cabin class: "economy", "premium_economy", "business", or "first" (optional, default economy)' },
        passengers: { type: 'number', description: 'Number of passengers (1-9, default 1)' },
        sort_by_price: { type: 'boolean', description: 'Sort results by price ascending (default false, sorts by date)' },
      },
      required: ['origin', 'destination', 'start_date', 'end_date'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        prices: { type: 'array', items: { type: 'object', properties: {
          date: { type: 'string' }, price: { type: ['number', 'string', 'null'] },
          currency: { type: 'string' },
        } } },
        search_metadata: { type: ['object', 'null'] },
        error: { type: 'string' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _execute: async (params, base, context) => {
      const qs = new URLSearchParams({
        origin: String(params.origin ?? ''),
        destination: String(params.destination ?? ''),
        start_date: String(params.start_date ?? ''),
        end_date: String(params.end_date ?? ''),
        is_round_trip: String(params.is_round_trip ?? false),
        ...(params.trip_duration ? { trip_duration: String(params.trip_duration) } : {}),
        // Mirror search_flights: default to economy when omitted. Same
        // upstream-empty-on-missing-cabin-class issue.
        cabin_class: String(params.cabin_class ?? 'economy'),
        sort_by_price: String(params.sort_by_price ?? false),
        passengers: String(Math.max(1, Math.min(Number(params.passengers ?? 1), 9))),
      });
      const url = `${base}/api/aviation/v1/search-google-dates?${qs}`;
      const auth = await buildAuthHeaders(context, 'GET', url, null);
      const res = await fetch(url, {
        headers: { ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' },
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) throw new Error(`search-google-dates HTTP ${res.status}`);
      return res.json();
    },
    _apiPaths: [
      "GET /api/aviation/v1/search-google-dates",
    ],
  },
  {
    name: 'get_commodity_geo',
    _outputBudgetBytes: 262144,
    description: 'Global mining sites with coordinates, operator, mineral type, and production status. Covers 71 major mines spanning gold, silver, copper, lithium, uranium, coal, and other minerals worldwide.',
    inputSchema: {
      type: 'object',
      properties: {
        mineral: { type: 'string', description: 'Filter by mineral type (e.g. "Gold", "Copper", "Lithium")' },
        country: { type: 'string', description: 'Filter by country name (e.g. "Australia", "Chile")' },
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      required: ['sites', 'total'],
      properties: {
        sites: { type: 'array', items: { type: 'object', properties: {
          id: { type: 'string' }, name: { type: 'string' },
          lat: { type: 'number' }, lon: { type: 'number' },
          mineral: { type: 'string' }, country: { type: 'string' },
          operator: { type: 'string' }, status: { type: 'string' }, significance: { type: 'string' },
          annualOutput: { type: 'string' }, productionRank: { type: 'number' },
          openPitOrUnderground: { type: 'string' },
        } } },
        total: { type: 'number' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _execute: async (params: Record<string, unknown>) => {
      type MineSite = { id: string; name: string; lat: number; lon: number; mineral: string; country: string; operator: string; status: string; significance: string; annualOutput?: string; productionRank?: number; openPitOrUnderground?: string };
      let sites = MINING_SITES_RAW as MineSite[];
      if (params.mineral) sites = sites.filter((s) => s.mineral === String(params.mineral));
      if (params.country) sites = sites.filter((s) => s.country.toLowerCase().includes(String(params.country).toLowerCase()));
      return { sites, total: sites.length };
    },
    _apiPaths: [],
  },
  {
    // describe_tool (v1.5.0) — on-demand escape hatch for the full
    // uncompressed tool definition. tools/list (default) emits each tool's
    // description compressed to ≤TOOL_DESCRIPTION_MAX_BYTES (first sentence
    // or byte-truncated); the LLM calls describe_tool with a tool_name to
    // get the full v1.4.0-shape tool object — same public shape, just with
    // long-form text in `description`. Uses the SAME buildPublicTool helper
    // as tools/list so the two surfaces can never drift.
    name: 'describe_tool',
    _outputBudgetBytes: 8192,
    description: 'Return the full uncompressed definition of one tool by name. Use when the compressed tools/list entry is ambiguous about behaviour or argument semantics.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string', description: 'Exact tool name from tools/list.' },
      },
      required: ['tool_name'],
    },
    // Returns either the public Tool shape (see PublicToolShape) or one of the
    // two structured error envelopes — both are tools/call results, not JSON-RPC errors.
    outputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        annotations: { type: 'object' },
        error: { type: 'string', enum: ['missing_tool_name', 'unknown_tool'], description: 'Present only on user-input failure.' },
        hint: { type: 'string' },
        requested: { type: 'string' },
        available: { type: 'array', items: { type: 'string' } },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _execute: async (params: Record<string, unknown>) => {
      const name = params.tool_name;
      if (typeof name !== 'string' || name.length === 0) {
        return { error: 'missing_tool_name', hint: 'Pass tool_name as a non-empty string matching a tool from tools/list.' };
      }
      const tool = TOOL_REGISTRY.find((t) => t.name === name);
      if (!tool) {
        return {
          error: 'unknown_tool',
          requested: name,
          available: TOOL_REGISTRY.map((t) => t.name).sort(),
        };
      }
      return buildPublicTool(tool, { compressDescriptions: false });
    },
    _apiPaths: [],
  },
];

// Public shape for tools/list — strips internal _-prefixed fields, adds MCP
// annotations, and injects the universal `summary` flag (issue #3678) into
// every cache tool's advertised schema. Cache tools are uniformly summarisable;
// RPC/_execute tools have bespoke response shapes and aren't covered.
const SUMMARY_SCHEMA = {
  type: 'boolean',
  description: 'Return counts + 3-item samples instead of full lists. Useful when you only need shape/size or want to budget context before drilling in.',
} as const;

// Universal JMESPath projection (v1.4.0) — advertised on every tool (cache
// AND RPC). Description is intentionally terse (~110 bytes) to avoid ×38
// bloat across `tools/list`; the grammar URL + worked examples + limits +
// quota note live in `initialize.result.instructions` (one ~600B emit per
// session, amortised across N tool calls).
export const JMESPATH_SCHEMA = {
  type: 'string',
  description: 'Optional JMESPath projection applied to the response. See initialize.instructions for grammar and examples.',
} as const;

// Collision guard — fail fast at module load if a future PR hand-declares
// `jmespath` (or `summary` on a cache tool) on a tool's inputSchema. The
// universal injection below would silently overwrite the hand-declared
// version; failing loud forces the author to resolve the duplication.
for (const tool of TOOL_REGISTRY) {
  const props = tool.inputSchema.properties;
  if (props && 'jmespath' in props) {
    throw new Error(`api/mcp.ts: tool "${tool.name}" declares its own 'jmespath' property — collides with universal JMESPATH_SCHEMA injection. Remove the per-tool declaration.`);
  }
  if (tool._execute === undefined && props && 'summary' in props) {
    throw new Error(`api/mcp.ts: cache tool "${tool.name}" declares its own 'summary' property — collides with universal SUMMARY_SCHEMA injection. Remove the per-tool declaration.`);
  }
}

// Shared public-shape builder (v1.5.0). SINGLE source of truth for what
// `tools/list` and `describe_tool` emit. Both surfaces go through this
// helper so they can never drift.
//
// Always recursively deep-clones property schemas AND the injected
// SUMMARY_SCHEMA / JMESPATH_SCHEMA consts via `structuredClone`. Without
// this, mutating any returned property (including nested `enum` / `items.enum`
// arrays, e.g. `get_market_data.asset_classes.items.enum`) would corrupt
// the registry or the module-level schema consts. Codex Round 2 explicitly
// flagged shallow `{ ...prop }` as insufficient for these shapes.
//
// `_*`-prefixed internal fields (_apiPaths, _cacheKeys, _seedMetaKey,
// _maxStaleMin, _freshnessChecks, _coverageKeys, _postFilter, _execute)
// are NEVER enumerated — the function only constructs a fresh object with
// the public-shape fields (name, description, inputSchema, annotations).
//
// `opts.compressDescriptions` — when true (the tools/list call path),
// the tool's top-level `description` is run through compressDescription.
// When false (the describe_tool call path), full text is preserved.
export interface PublicToolShape {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown>; required: string[] };
  outputSchema: object;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

export function buildPublicTool(
  tool: ToolDef,
  opts: { compressDescriptions: boolean },
): PublicToolShape {
  const isCacheTool = tool._execute === undefined;

  // Recursively clone each property schema. Handles direct `enum: [...]`
  // arrays (e.g. api/mcp.ts:810) and nested `items.enum: [...]` arrays
  // (e.g. api/mcp.ts:655) — both present in TOOL_REGISTRY. `structuredClone`
  // is a Web Platform global on Vercel edge + Node 18+ (no polyfill needed).
  const clonedProperties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(tool.inputSchema.properties)) {
    clonedProperties[key] = structuredClone(value);
  }

  // Inject the universal schemas as CLONES, not bare references, so that
  // mutating `result.inputSchema.properties.jmespath.description` doesn't
  // corrupt the module-level JMESPATH_SCHEMA const.
  if (isCacheTool) {
    clonedProperties.summary = structuredClone(SUMMARY_SCHEMA);
  }
  clonedProperties.jmespath = structuredClone(JMESPATH_SCHEMA);

  const description = opts.compressDescriptions
    ? compressDescription(tool.description, TOOL_DESCRIPTION_MAX_BYTES)
    : tool.description;

  return {
    name: tool.name,
    description,
    inputSchema: {
      type: tool.inputSchema.type,
      properties: clonedProperties,
      required: [...tool.inputSchema.required],
    },
    // Deep-clone for the same reason as inputSchema.properties — mutating the
    // returned object must not corrupt the module-level outputSchema literal.
    outputSchema: structuredClone(tool.outputSchema),
    // Per-tool annotations declared on each registry entry (v1.7.0).
    // Deep-cloned so a mutating client can't poison the registry literal —
    // matches the inputSchema.properties + outputSchema treatment above.
    annotations: structuredClone(tool.annotations),
  };
}

const TOOL_LIST_RESPONSE = TOOL_REGISTRY.map((tool) => buildPublicTool(tool, { compressDescriptions: true }));
// Tools-list payload is static at module load — precompute its wire size so
// the per-session `mcp.tools_list_emitted` telemetry line doesn't re-stringify
// ~5 KB on every initialize.
const TOOL_LIST_BYTES = utf8ByteLength(JSON.stringify(TOOL_LIST_RESPONSE));

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------
function rpcOk(id: unknown, result: unknown, extraHeaders: Record<string, string> = {}): Response {
  return jsonResponse({ jsonrpc: '2.0', id: id ?? null, result }, 200, extraHeaders);
}

function rpcError(id: unknown, code: number, message: string): Response {
  return jsonResponse({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, 200);
}

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
function telemetryEnabled(): boolean {
  const v = process.env.MCP_TELEMETRY;
  return v !== 'false' && v !== '0';
}
function emitTelemetry(event: string, payload: Record<string, unknown>): void {
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

// Log-safe principal id derived from the resolved auth context:
//   - Pro:     raw Clerk `userId` (internal ID, not a secret; matches the
//              REST gateway's `customer_id` convention).
//   - env_key: FNV-64 hash of the API key (secret — never log raw key
//              material; mirrors `principal_id` in
//              server/_shared/usage-identity.ts).
function principalIdForLog(context: McpAuthContext): string {
  return context.kind === 'pro' ? context.userId : hashKeySync(context.apiKey);
}

export function evaluateFreshness(checks: FreshnessCheck[], metas: unknown[], now = Date.now()): { cached_at: string | null; stale: boolean } {
  let stale = false;
  let oldestFetchedAt = Number.POSITIVE_INFINITY;
  let hasAnyValidMeta = false;
  let hasAllValidMeta = true;

  for (const [i, check] of checks.entries()) {
    const meta = metas[i];
    const fetchedAt = meta && typeof meta === 'object' && 'fetchedAt' in meta
      ? Number((meta as { fetchedAt: unknown }).fetchedAt)
      : Number.NaN;

    if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) {
      hasAllValidMeta = false;
      stale = true;
      continue;
    }

    hasAnyValidMeta = true;
    oldestFetchedAt = Math.min(oldestFetchedAt, fetchedAt);
    stale ||= (now - fetchedAt) / 60_000 > check.maxStaleMin;
  }

  return {
    cached_at: hasAnyValidMeta && hasAllValidMeta ? new Date(oldestFetchedAt).toISOString() : null,
    stale,
  };
}

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
  // / stampede). Throw so dispatchToolsCall's catch fires the DECR rollback
  // — without this, the user's quota burns silently on a useless response.
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
      captureSilentError(err, { tags: { route: 'api/mcp', step: 'post-filter', tool: tool.name } });
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

// ---------------------------------------------------------------------------
// Daily quota helpers (Pro-only). INCR-first reservation runs synchronously
// on the critical path BEFORE tool dispatch — never inside `waitUntil`.
// On any post-INCR rejection (cap exceeded OR tool dispatch failure) we
// best-effort DECR. A failed DECR overshoots the counter by 1, but never
// undershoots — cost-protection > user-fairness.
// ---------------------------------------------------------------------------

type PipelineFn = (commands: Array<Array<string | number>>, timeoutMs?: number) => Promise<Array<{ result: unknown }> | null>;

interface QuotaReserved {
  ok: true;
  newCount: number;
  /** Roll back the INCR (best-effort). Idempotent — safe to call multiple times. */
  rollback: () => Promise<void>;
}
interface QuotaRejected {
  ok: false;
  reason: 'cap-exceeded' | 'redis-unavailable';
  /** When cap-exceeded: count after the rejected reservation was rolled back (i.e. the floor). */
  floor?: number;
}

async function reserveQuota(
  userId: string,
  pipeline: PipelineFn,
): Promise<QuotaReserved | QuotaRejected> {
  const key = dailyCounterKey(userId);
  if (!key) return { ok: false, reason: 'redis-unavailable' };

  let pipeResult: Array<{ result: unknown }> | null;
  try {
    pipeResult = await pipeline([
      ['INCR', key],
      ['EXPIRE', key, PRO_DAILY_QUOTA_TTL_SECONDS],
    ]);
  } catch {
    pipeResult = null;
  }

  if (!pipeResult || !Array.isArray(pipeResult) || pipeResult.length === 0) {
    // Hard cap correctness: NEVER dispatch on reservation failure.
    return { ok: false, reason: 'redis-unavailable' };
  }

  const incrRaw = pipeResult[0]?.result;
  const newCount = typeof incrRaw === 'number' ? incrRaw : Number(incrRaw);
  if (!Number.isFinite(newCount) || newCount < 1) {
    return { ok: false, reason: 'redis-unavailable' };
  }

  // Build idempotent rollback. `await rollback()` runs DECR once; subsequent
  // calls are no-ops.
  let rolledBack = false;
  const rollback = async (): Promise<void> => {
    if (rolledBack) return;
    rolledBack = true;
    try {
      await pipeline([['DECR', key]]);
    } catch {
      // Best-effort: a transient Redis failure means the counter overshoots
      // by 1, which is the cost-protection-correct direction.
    }
  };

  if (newCount > PRO_DAILY_QUOTA_LIMIT) {
    // Reject and roll back immediately so the floor stays at the limit
    // (or wherever concurrent rollbacks land it).
    await rollback();

    // Counter-clamp (F4): if multiple DECR rollbacks have failed during
    // a Redis hiccup, the counter can overshoot indefinitely (e.g. land
    // at 100 instead of 50). Without clamping, every subsequent INCR for
    // the rest of the UTC day yields >50 → the user is locked out until
    // the 48h key TTL expires.
    //
    // After the rollback, peek at the post-DECR count via a single
    // best-effort INCR-then-DECR pair — if it's STILL above the limit,
    // we know the rollback didn't land. Force a defensive
    // `SET key <limit> KEEPTTL` so the next legitimate INCR (next UTC
    // day OR next request after the hiccup) starts at limit+1 → 429,
    // not limit+N → 429-forever.
    //
    // Why use INCR-then-DECR instead of GET? Keeps the helper to the
    // same pipeline contract (the tests' makePipelineMock supports
    // INCR/DECR/EXPIRE only) and avoids adding a new verb. The probe
    // costs one round-trip but only on the rejection path.
    if (newCount > PRO_DAILY_QUOTA_LIMIT + 1) {
      try {
        const probe = await pipeline([['INCR', key], ['DECR', key]]);
        const probeIncrRaw = probe?.[0]?.result;
        const postRollbackCount = typeof probeIncrRaw === 'number' ? probeIncrRaw - 1 : Number.NaN;
        if (Number.isFinite(postRollbackCount) && postRollbackCount > PRO_DAILY_QUOTA_LIMIT) {
          // Rollback chain has overshot — force the counter back to the
          // limit via SET KEEPTTL. This is fail-soft: a concurrent INCR
          // immediately after this SET will land at limit+1 and 429
          // normally, which is the desired behavior.
          //
          // Use DECR repeatedly as the pipeline-supported clamp (avoids
          // adding a new verb to test mocks). DECR N times where N is
          // the overshoot delta. Cap at 100 DECRs to bound the worst-
          // case round-trip cost.
          const overshoot = postRollbackCount - PRO_DAILY_QUOTA_LIMIT;
          const decrs = Math.min(overshoot, 100);
          const clamp = Array.from({ length: decrs }, () => ['DECR', key] as Array<string | number>);
          // Best-effort: failure here is the cost-protection-correct
          // direction (counter stays high → users 429, no DoS exposure).
          await pipeline(clamp).catch(() => {});
        }
      } catch {
        // Probe failed — leave counter as-is. Worst case the user 429s
        // until UTC midnight; never under-cap, never DoS exposure.
      }
    }

    return { ok: false, reason: 'cap-exceeded', floor: PRO_DAILY_QUOTA_LIMIT };
  }

  return { ok: true, newCount, rollback };
}

// ---------------------------------------------------------------------------
// Auth resolution — exported types so deps-injecting callers (tests) can
// supply alternates without re-deriving the shape.
// ---------------------------------------------------------------------------

export interface McpHandlerDeps {
  resolveBearerToContext: (token: string) => Promise<McpAuthContext | null>;
  validateProMcpToken: (tokenId: string) => Promise<{ userId: string } | null>;
  getEntitlements: (userId: string) => Promise<{ planKey?: string; features: { tier: number; mcpAccess?: boolean }; validUntil: number } | null>;
  redisPipeline: PipelineFn;
}

const PRODUCTION_DEPS: McpHandlerDeps = {
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

function wwwAuthHeader(resourceMetadataUrl: string, errorParam = ''): string {
  const errSegment = errorParam ? `, error="${errorParam}"` : '';
  return `Bearer realm="worldmonitor"${errSegment}, resource_metadata="${resourceMetadataUrl}"`;
}

interface AuthResolution {
  ok: true;
  context: McpAuthContext;
}
interface AuthResolutionRejected {
  ok: false;
  response: Response;
}

async function resolveAuthContext(
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
async function runProPreChecks(
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
async function applyPerMinuteLimit(context: McpAuthContext): Promise<Response | null> {
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

async function dispatchToolsCall(
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
    return rpcError(id, -32602, 'Invalid params: missing tool name');
  }
  const tool = TOOL_REGISTRY.find((t) => t.name === p.name);
  if (!tool) {
    return rpcError(id, -32602, `Unknown tool: ${p.name}`);
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
  let proRollback: (() => Promise<void>) | null = null;
  if (context.kind === 'pro' && !isMetadataTool) {
    const reservation = await reserveQuota(context.userId, deps.redisPipeline);
    if (!reservation.ok) {
      if (reservation.reason === 'cap-exceeded') {
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32029, message: `Daily MCP quota exceeded (${PRO_DAILY_QUOTA_LIMIT}/day). Resets at next UTC midnight.` } }),
          { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(secondsUntilUtcMidnight()), ...corsHeaders } },
        );
      }
      // Hard-cap correctness: NEVER dispatch on reservation failure.
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Service temporarily unavailable, retry in a moment.' } }),
        { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '5', ...corsHeaders } },
      );
    }
    proRollback = reservation.rollback;
  }

  const jmespathArg = p.arguments?.jmespath;
  const jmespathUsed = typeof jmespathArg === 'string' && jmespathArg.length > 0;
  // tStart is captured AFTER the Pro reservation round-trip — `latency_ms`
  // reports time-in-tool, not time-in-tool-plus-time-in-quota-reservation.
  // Mirrors the error-path rollback exclusion below.
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
    // inside the normal response. So this stays INSIDE the try/catch but
    // does NOT participate in the quota DECR path: a bad expression is a
    // *user* error after a successful tool dispatch, not a system error.
    // Genuine tool-execution throws (e.g. `cache_all_null`) still hit the
    // catch below and rollback. Single JSON.stringify per request when
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
        // turn a successful request into a 5xx + Pro-quota rollback. On
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
      // Rollback Pro quota — the user received no usable data, so the
      // daily slot should not be consumed (mirrors the catch-block rollback).
      if (proRollback) await proRollback();
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
    // Capture tool-execution latency BEFORE the rollback round-trip — the
    // P95 dashboard reads `latency_ms` as time-in-tool, not time-in-tool-
    // plus-time-in-Convex-rollback. Rollback can add hundreds of ms on a
    // slow upstream and would otherwise silently inflate the error-path
    // percentile.
    const latencyMs = Date.now() - tStart;
    if (proRollback) await proRollback();
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
    return rpcError(id, -32603, 'Internal error: data fetch failed');
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export async function mcpHandler(
  req: Request,
  deps: McpHandlerDeps,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response> {
  // MCP is a public API endpoint secured by API key — allow all origins (claude.ai, Claude Desktop, custom agents)
  const corsHeaders = getPublicCorsHeaders('POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method === 'HEAD') {
    return new Response(null, { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  }
  if (req.method !== 'POST') {
    return new Response(null, { status: 405, headers: { Allow: 'POST, HEAD, OPTIONS', ...corsHeaders } });
  }

  // Origin validation: allow claude.ai/claude.com web clients; allow absent origin (desktop/CLI)
  const origin = req.headers.get('Origin');
  if (origin && origin !== 'https://claude.ai' && origin !== 'https://claude.com') {
    return new Response('Forbidden', { status: 403, headers: corsHeaders });
  }
  // Host-derived resource_metadata pointer matches api/oauth-protected-resource.ts.
  const requestHost = req.headers.get('host') ?? new URL(req.url).host;
  const resourceMetadataUrl = `https://${requestHost}/.well-known/oauth-protected-resource`;

  const auth = await resolveAuthContext(req, deps, resourceMetadataUrl, corsHeaders);
  if (!auth.ok) return auth.response;
  const context = auth.context;

  if (context.kind === 'pro') {
    const proCheck = await runProPreChecks(context, deps, resourceMetadataUrl, corsHeaders, ctx);
    if (proCheck) return proCheck;
  }

  const limited = await applyPerMinuteLimit(context);
  if (limited) return limited;

  // Parse body
  let body: { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };
  try {
    body = await req.json();
  } catch {
    return rpcError(null, -32600, 'Invalid request: malformed JSON');
  }

  if (!body || typeof body.method !== 'string') {
    return rpcError(body?.id ?? null, -32600, 'Invalid request: missing method');
  }

  const { id, method } = body;

  // Dispatch
  switch (method) {
    case 'initialize': {
      const sessionId = crypto.randomUUID();
      const clientRequestedVersion = (body.params as { protocolVersion?: unknown } | null | undefined)?.protocolVersion;
      const negotiatedVersion = negotiateProtocolVersion(clientRequestedVersion);
      // `tools_array_bytes` is the bare TOOL_LIST_RESPONSE stringify, not the
      // full JSON-RPC envelope (jsonrpc/id/protocolVersion/capabilities add
      // fixed overhead). UA is sliced to 256 chars: a pathological 32 KB
      // custom UA would otherwise inflate every emitted line for that session.
      emitTelemetry('mcp.tools_list_emitted', {
        auth_kind: context.kind,
        user_id: principalIdForLog(context),
        tools_array_bytes: TOOL_LIST_BYTES,
        tool_count: TOOL_LIST_RESPONSE.length,
        client_user_agent: (req.headers.get('User-Agent') ?? '').slice(0, 256),
      });
      return rpcOk(id, {
        protocolVersion: negotiatedVersion,
        capabilities: { tools: {}, logging: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: SERVER_INSTRUCTIONS,
      }, { 'Mcp-Session-Id': sessionId, ...corsHeaders });
    }
    case 'notifications/initialized':
      return new Response(null, { status: 202, headers: corsHeaders });
    case 'ping':
      return rpcOk(id, {}, corsHeaders);
    case 'tools/list':
      return rpcOk(id, { tools: TOOL_LIST_RESPONSE }, corsHeaders);
    case 'tools/call':
      return dispatchToolsCall(req, context, deps, body, corsHeaders, ctx);
    case 'logging/setLevel': {
      const level = (body.params as { level?: string } | null)?.level;
      if (typeof level !== 'string' || !MCP_LOG_LEVELS.has(level)) {
        return rpcError(id, -32602,
          `Invalid params: level must be one of ${[...MCP_LOG_LEVELS].join(', ')}`,
        );
      }
      return rpcOk(id, {}, corsHeaders);
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// Default Vercel-edge entry — wires production deps. Tests call mcpHandler
// directly with mock deps.
// ---------------------------------------------------------------------------
export default async function handler(
  req: Request,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response> {
  return mcpHandler(req, PRODUCTION_DEPS, ctx);
}

// ---------------------------------------------------------------------------
// Test-only escape hatch. Exposes the TOOL_REGISTRY for the U7 Tier 3 parity
// test (tests/mcp-bootstrap-parity.test.mjs), which asserts that every
// canonical seeded cache key from api/health.js (BOOTSTRAP_KEYS ∪
// STANDALONE_KEYS) is either covered by some tool's `_cacheKeys` (cache-tool)
// or `_coverageKeys` (RpcToolDef hybrid), or explicitly excluded via the
// test's EXCLUDED_FROM_MCP map with a documented reason.
// ---------------------------------------------------------------------------
export const __testing__ = {
  TOOL_REGISTRY,
};
