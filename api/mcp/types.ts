// Shared type declarations for the MCP server modules under api/mcp/.
// Pure types only — no runtime exports — so this module is safe to import
// from anywhere without creating evaluation-order surprises or cycles.

import type { BillingVerificationStatus } from '../../server/_shared/entitlement-check';

// ---------------------------------------------------------------------------
// Auth-context shape passed into tool _execute. U7 widened the previous
// `apiKey: string` to a discriminated union so per-tool fetches can branch
// header construction (`X-WorldMonitor-Key` for env_key, internal-HMAC for
// Pro) from a single point.
// ---------------------------------------------------------------------------

export type McpAuthContext =
  | { kind: 'env_key'; apiKey: string }
  | { kind: 'pro'; userId: string; mcpTokenId: string }
  // Customer-issued dashboard key (Convex userApiKeys, #4859). Carries BOTH
  // the raw key (downstream _execute fetches authenticate as the owner via
  // X-WorldMonitor-Key, so REST metering/limits attribute to them) AND the
  // resolved owner userId (per-user rate limit + daily quota + the mcpAccess
  // entitlement pre-check — a user_key context must NEVER skip that gate the
  // way env_key does).
  | { kind: 'user_key'; apiKey: string; userId: string };

export type McpInboundHostClass =
  | 'canonical_api'
  | 'apex'
  | 'www'
  | 'variant'
  | 'worldmonitor_subdomain'
  | 'local'
  | 'vercel_preview'
  | 'other';

export interface McpToolExecutionContext {
  inboundHostClass: McpInboundHostClass;
  downstreamOrigin: string;
  downstreamOriginTag: string;
}

// ---------------------------------------------------------------------------
// Tool registry types
// ---------------------------------------------------------------------------
export interface BaseToolDef {
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
  // practically safe and lets every LLM client benefit even when a caller
  // pins back to the legacy floor via MCP_PROTOCOL_FLOOR_2025_06_18=off.
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
  // MCP Apps (extension `io.modelcontextprotocol/ui`). When set, buildPublicTool
  // derives the wire `_meta.ui.resourceUri` (+ the deprecated flat
  // `ui/resourceUri` alias) from this value, linking the tool to a `ui://`
  // HTML app shell an MCP-Apps host renders inline. SINGLE source of truth —
  // internal-only, never enumerated onto the wire directly (buildPublicTool
  // constructs the public `_meta` object from it). Optional: only tools with
  // an interactive UI surface set it.
  _uiResourceUri?: string;
}

export interface FreshnessCheck {
  key: string;
  maxStaleMin: number;
  minRecordCount?: number;
}

// Cache-read tool: reads one or more Redis keys and returns them with staleness info.
export interface CacheToolDef extends BaseToolDef {
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
export interface RpcToolDef extends BaseToolDef {
  _cacheKeys?: never;
  _seedMetaKey?: never;
  _maxStaleMin?: never;
  _freshnessChecks?: never;
  _execute: (
    params: Record<string, unknown>,
    base: string,
    context: McpAuthContext,
    execution?: McpToolExecutionContext,
  ) => Promise<unknown>;
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

export type ToolDef = CacheToolDef | RpcToolDef;

// ---------------------------------------------------------------------------
// JMESPath result envelope
// ---------------------------------------------------------------------------
export type JmespathFailKind = 'expression_too_long' | 'projection_too_large' | 'invalid_expression';

// Result envelope. `text` is always the wire-ready JSON the dispatcher will
// emit in `content[0].text`. `failed` is set only on a soft-failure path,
// and its value is the same enum string used as the `_jmespath_error`
// envelope prefix (no drift).
export interface ApplyJmespathResult {
  text: string;
  failed?: JmespathFailKind;
}

// ---------------------------------------------------------------------------
// tools/list / describe_tool public-shape
// ---------------------------------------------------------------------------
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
  // MCP Apps (`io.modelcontextprotocol/ui`) tool→UI linkage. Spec-reserved
  // public `_meta` — present ONLY on tools that declare a `_uiResourceUri`.
  // Both the nested `ui.resourceUri` (current form) and the flat
  // `ui/resourceUri` (deprecated legacy alias ext-apps normalizes) are
  // emitted so hosts on either revision resolve the app shell.
  _meta?: { ui: { resourceUri: string }; 'ui/resourceUri': string };
}

// ---------------------------------------------------------------------------
// Daily-quota pipeline types
// ---------------------------------------------------------------------------
export type PipelineFn = (commands: Array<Array<string | number>>, timeoutMs?: number) => Promise<Array<{ result: unknown }> | null>;

export interface QuotaReserved {
  ok: true;
  newCount: number;
  /** Roll back the INCR (best-effort). Idempotent — safe to call multiple times. */
  rollback: () => Promise<void>;
}
export interface QuotaRejected {
  ok: false;
  reason: 'cap-exceeded' | 'redis-unavailable';
  /** When cap-exceeded: count after the rejected reservation was rolled back (i.e. the floor). */
  floor?: number;
}

// ---------------------------------------------------------------------------
// Auth resolution + handler deps
// ---------------------------------------------------------------------------
export interface McpHandlerDeps {
  resolveBearerToContext: (token: string) => Promise<McpAuthContext | null>;
  validateProMcpToken: (tokenId: string) => Promise<{ userId: string } | null>;
  getEntitlements: (userId: string) => Promise<{
    planKey?: string;
    features: { tier: number; mcpAccess?: boolean };
    validUntil: number;
    billingStatus?: BillingVerificationStatus;
    retryAfterSeconds?: number;
    verificationUnavailable?: boolean;
  } | null>;
  // #4859: Convex userApiKeys hash lookup (same shared helper as the REST
  // gateway). Returns the key owner, or null for unknown/revoked keys. The
  // production impl fail-softs to null internally; a THROW from a dep is
  // treated as auth-backend-transient (503), mirroring resolveBearerToContext.
  validateUserApiKey: (key: string) => Promise<{ userId: string } | null>;
  redisPipeline: PipelineFn;
}

export interface AuthResolution {
  ok: true;
  context: McpAuthContext;
}
export interface AuthResolutionRejected {
  ok: false;
  response: Response;
}

// ---------------------------------------------------------------------------
// Prompts registry types (MCP 2025-03-26 prompts capability)
// ---------------------------------------------------------------------------
export interface McpPromptArgument {
  name: string;
  description: string;
  required: boolean;
}

// One tool-call step inside a prompt workflow. `args` is a JSON-shaped value
// where string leaves may carry `${argname}` tokens; the prompt renderer
// substitutes them against the call-time provided arguments. `jmespath` is
// a literal expression (no substitution) validated against the targeted
// tool's outputSchema by tests/mcp-prompts.test.mjs.
export interface McpPromptStep {
  tool: string;
  args: Record<string, unknown>;
  jmespath: string;
  purpose: string;
}

// Optional intro conditional-substitution map. The key is a synthetic token
// name (e.g. `country_suffix`); its presence in the intro string toggles
// between `when_present` (any controlling arg has a non-empty value) and
// `when_absent`. Lets the same prompt express both "filtered" and "global"
// renders without a per-prompt code branch.
export interface McpPromptIntroSubstitution {
  when_present: string;
  when_absent: string;
}

export interface McpPromptDef {
  name: string;
  description: string;
  arguments: McpPromptArgument[];
  steps: McpPromptStep[];
  intro: string;
  intro_substitutions?: Record<string, McpPromptIntroSubstitution>;
}

// ---------------------------------------------------------------------------
// Resources registry types (MCP 2025-03-26 resources capability)
// ---------------------------------------------------------------------------
// Per-resource `paramExtractor` parses a concrete URI back into the
// synthetic tools/call arguments. Discriminated return: null = prefix
// mismatch (try the next registry entry); {ok: false, reason} = prefix
// matched but a component is malformed (terminate with -32602);
// {ok: true, args} = resolved cleanly. Lives in types.ts so both the
// resources module and the test harness can reference the type without
// importing the runtime registry.
export type McpResourceExtractResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; reason: string };

// Concrete, anonymously-readable, quota-exempt resource surfaced via
// `resources/list`. Its `read()` returns ONLY non-sensitive freshness /
// health metadata (never billable data), so an anonymous agent (or an
// agent-readiness scanner) can `resources/read` it cleanly — the same
// public + quota-exempt posture as `prompts/list` and `describe_tool`.
// `read` returns the wire-ready `content[0].text` and MUST be robust:
// it returns a valid envelope even when the upstream cache read fails, so
// the read never surfaces empty content or a 5xx to the caller.
export interface PublicResourceDef {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  read: () => Promise<string>;
}

// Data-bearing URI TEMPLATE surfaced via `resources/templates/list`. A
// concrete instantiation `resources/read` routes through
// `dispatchToolsCall`, inheriting Pro daily-quota symmetry with the
// equivalent `tools/call` — asymmetric auth here is a known MCP data-leak /
// quota-bypass vector (a Pro user at the daily cap could otherwise keep
// reading data through resources for free), so these stay gated. Templates
// live in `resources/templates/list` (NOT `resources/list`) because a
// literal `{iso2}` URI can never resolve to data; only the substituted form
// reads — surfacing a template in `resources/list` breaks an anonymous
// validator's `resources/read` probe.
export interface TemplateResourceDef {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string;
  // Backing tool whose tools/call execution path the resources/read
  // dispatcher routes through. Validated against TOOL_REGISTRY at test
  // time (the resources module itself avoids the import cycle that the
  // prompts module also avoids).
  tool: string;
  paramExtractor: (uri: string) => McpResourceExtractResult | null;
  // Only set for RPC-tool-backed resources whose underlying response
  // doesn't already carry a `{cached_at, stale}` cacheEnvelope. The
  // dispatcher reads the named seed-meta key and prepends the envelope
  // before re-emitting; cache-tool-backed resources omit this field.
  freshnessWrap?: { seedMetaKey: string; maxStaleMin: number };
}
