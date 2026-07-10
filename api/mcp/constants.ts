// MCP protocol versions this server can speak on the initialize handshake.
// Bumping the supported set is a wire-visible default-behavior change, so the
// bumped floor shipped behind an env-var gate (`MCP_PROTOCOL_FLOOR_2025_06_18`)
// and has now completed its rollout (off default → staging `on` → prod `on` →
// this commit flips the default): 2025-06-18 is negotiated by DEFAULT and the
// env var survives only as an explicit `=off` kill-switch that pins the server
// back to the legacy [2025-03-26] floor. The published server-card
// (public/.well-known/mcp/server-card.json) advertises the bumped floor
// unconditionally — the card is a static capability declaration; the live
// initialize handler is what actually negotiates with each client. Keeping the
// default in lock-step with the card is what lets a strict scanner's handshake
// (which validates the negotiated version against the advertised floor) pass.
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
//   - 2025-06-18 (declared 2026-05-23; default-on since 2026-07-04) — unlocks
//     spec-native `outputSchema` per tool. The server supports BOTH
//     2025-03-26 and 2025-06-18 so old and new clients are both served; set
//     `MCP_PROTOCOL_FLOOR_2025_06_18=off` to pin back to the legacy floor.
//
// Env is read at CALL time (not module-init) so dynamic re-imports of the
// thin shim under different `process.env` snapshots — see
// tests/mcp-protocol-version.test.mjs — observe the active value rather
// than the value frozen at first module load. The shim
// (api/mcp.ts) re-declares the snapshot constants locally so its own
// `mod.MCP_SUPPORTED_PROTOCOL_VERSIONS` / `mod.MCP_PROTOCOL_VERSION`
// exports also reflect the per-import env state.
function supportedProtocolVersions(): readonly string[] {
  return process.env.MCP_PROTOCOL_FLOOR_2025_06_18 === 'off'
    ? ['2025-03-26']
    : ['2025-03-26', '2025-06-18'];
}
function latestProtocolVersion(): string {
  return process.env.MCP_PROTOCOL_FLOOR_2025_06_18 === 'off'
    ? '2025-03-26'
    : '2025-06-18';
}

// Negotiate the protocol version returned in the initialize response.
// Lenient on missing/non-string input (some test fixtures + older clients
// omit the field): fall back to the server's latest supported version,
// matching the spec's "respond with what you support" stance.
export function negotiateProtocolVersion(requested: unknown): string {
  const supported = supportedProtocolVersions();
  return typeof requested === 'string' && supported.includes(requested)
    ? requested
    : latestProtocolVersion();
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

export const SERVER_NAME = 'worldmonitor';
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
// Bumped 1.7.0 → 1.8.0 (2026-05-24) reflecting:
//   - MCP `prompts` capability turned on. Six workflow templates exposed via
//     prompts/list + prompts/get (country-briefing, energy-shock-watch,
//     market-open-prep, conflict-pulse, route-risk-check, freshness-audit).
//     Each template pre-bakes a literal JMESPath projection per step so the
//     LLM doesn't have to discover the response shape on first execution.
//   - Wire-visible additive capability — clients that ignore the new methods
//     keep working; capable clients (Claude Desktop slash menu, MCP Inspector)
//     surface the workflows in a discovery affordance.
//   - prompts/list and prompts/get are quota-exempt (per-minute limit only)
//     to mirror the describe_tool metadata posture — counting template
//     fetches against the 50/day Pro cap would discourage exploration.
//   - capabilities.prompts.listChanged = false advertised, because the
//     stateless edge transport can't push notifications/prompts/list_changed
//     today.
//   - Server-card prompts capability flag flipped false → true in the same
//     commit so external scanners see the wire and the card agree.
// Bumped 1.8.0 → 1.9.0 (2026-05-25) reflecting:
//   - MCP `resources` capability turned on. Four read-only addressable URIs
//     exposed via resources/list + resources/read:
//       worldmonitor://countries/{iso2}/risk
//       worldmonitor://chokepoints/{slug}/status
//       worldmonitor://seed-meta/freshness
//       worldmonitor://markets/{symbol}/quote
//     Chokepoint slugs are pinned in a hand-curated kebab-case table
//     (api/mcp/resources/slugs.ts) so a cache refresh / upstream rename
//     never breaks a bookmarked URI.
//   - Auth-symmetric: resources/read routes through dispatchToolsCall and
//     inherits the Pro daily-quota reservation identical to the equivalent
//     tools/call — UNLIKE prompts (metadata-class, quota-exempt). Asymmetric
//     auth between resources and the equivalent tools/call is a known MCP
//     data-leak vector; the symmetry is structural rather than
//     replicated and is proven by tests/mcp-resources.test.mjs.
//   - Freshness envelope on every resources/read response: cache-tool-backed
//     resources inherit cached_at + stale from the cacheEnvelope; RPC-tool-
//     backed resources (country risk) wrap explicitly via evaluateFreshness
//     against the underlying seed-meta key.
//   - capabilities.resources.{subscribe: false, listChanged: false}
//     advertised. subscribe is unimplemented; listChanged is false for the
//     same stateless-edge-transport reason as prompts.
//   - Server-card resources capability flag flipped false → true in the
//     same commit so external scanners see the wire and the card agree.
// Bumped 1.6.0 → 1.7.0 (2026-05-23) reflecting:
//   - De-blanket the `Tool.annotations` object. Previously buildPublicTool
//     hard-coded `{ readOnlyHint: true, openWorldHint: true }` for every
//     tool. Now each tool declares all four spec hints (readOnlyHint,
//     destructiveHint, idempotentHint, openWorldHint) explicitly on its
//     registry entry — same per-tool authorship discipline as
//     _outputBudgetBytes (v1.6.0 PR 4) and outputSchema (v1.6.0 PR 6).
//   - Hint shape extends from 2 booleans → 4 booleans per tool. Wire delta
//     is small (~50 B × 40 tools); hints unchanged for tools that already
//     matched the old blanket. Cache tools + pure-internal RPCs now
//     correctly advertise `openWorldHint: false` (closed-world like a
//     memory tool — they read our seeded Redis cache); LLM-synthesized
//     tools AND live external-API reads (live ADS-B, live maritime, live
//     flight pricing) advertise `idempotentHint: false` so MCP clients
//     don't dedup / cache responses whose content drifts between calls.
//   - Purely additive on the wire — clients that read only the legacy two
//     hints keep working; new four-hint clients get a richer signal.
// Bumped 1.9.0 → 1.10.0 (2026-05-25) reflecting:
//   - SERVER_INSTRUCTIONS trimmed from 1945 B → 1577 B (368 B / 18.9%
//     reduction) emitted once per initialize. The JMESPath stanza
//     previously inlined grammar/envelope/quota detail that is now
//     authoritatively documented in docs/mcp-jmespath.mdx and
//     docs/mcp-error-catalog.mdx; it collapses to one sentence per
//     concern + canonical-docs URL. The describe_tool stanza was tightened
//     in similar fashion but the 60/min rate-limit caveat and the
//     `{error: 'unknown_tool', available: [...]}` self-correction hint
//     are intentionally retained in-band — the block-comment contract
//     above says stanzas must stand alone (LLMs do not reliably fetch
//     URLs mid-session), so "use freely" without the rate-limit qualifier
//     would mislead. The prompts and resources stanzas are unchanged —
//     they have no single authoritative docs anchor today, so
//     duplicating them in-band is still load-bearing.
//   - Pure metadata edit: no behaviour change, no input/output schema
//     change, no envelope-shape change. The constant emitted into
//     initialize.result.instructions is the only wire-visible diff. The
//     bump records it in the audit trail; rollback is git revert.
// Bumped 1.10.0 → 1.11.0 (2026-07-04) reflecting:
//   - MCP Apps support (extension `io.modelcontextprotocol/ui`, spec
//     2026-01-26). Adds a `ui://worldmonitor/country-risk.html` app-shell
//     resource (mimeType `text/html;profile=mcp-app`, served via
//     resources/list + resources/read) and links it from the
//     `get_country_risk` tool via `_meta.ui.resourceUri` (+ the deprecated
//     flat `ui/resourceUri` alias). An MCP-Apps host renders the shell inline
//     and streams the tool result in via postMessage. resources/read of a
//     ui:// URI is public + quota-exempt (static, data-free template); DATA
//     reads (worldmonitor://…) stay gated + Pro-quota-symmetric.
//   - Additive on the wire: `_meta` appears only on the linked tool. Clients
//     that don't speak MCP Apps ignore the extra resource + the reserved
//     `_meta` field. No input/output schema change to any existing tool.
//     (NOTE: 1.11.0 shipped WITHOUT declaring the extension's initialize
//     capability key — an incomplete handshake corrected in 1.13.0 below.
//     Agent-readiness scanners classify an MCP-App surface off the negotiated
//     `capabilities.extensions` key, so ui:// + `_meta` alone did not register
//     as MCP Apps support.)
// Bumped 1.11.0 → 1.12.0 (2026-07-04) reflecting:
//   - Data resources split into two tiers by sensitivity, and a new
//     `resources/templates/list` method:
//       * `resources/list` now surfaces ONLY concrete, metadata-only DATA
//         resources that are anonymously readable + quota-exempt (v1:
//         `worldmonitor://seed-meta/freshness`, a market-bootstrap freshness
//         probe returning only {cached_at, stale}). Alongside the v1.11.0
//         ui:// app-shell resource, every `resources/list` entry now reads
//         cleanly for an anonymous agent (or agent-readiness scanner) — a
//         literal `{iso2}` template URI can never resolve, so the data
//         templates no longer appear here.
//       * `resources/templates/list` (new, in PUBLIC_MCP_METHODS, metadata-
//         class, quota-exempt) surfaces the three data-bearing URI templates
//         (country risk, chokepoint status, market quote). A concrete
//         instantiation `resources/read` STILL routes through
//         dispatchToolsCall and consumes the Pro daily quota symmetrically
//         with the equivalent tools/call — the data-leak / quota-bypass
//         protection is unchanged; only its discovery surface moved from
//         resources/list to resources/templates/list.
//   - `resources/read` of a PUBLIC (metadata-only) DATA resource is promoted
//     to the anonymous + quota-exempt path per-request via
//     `isPublicResourceUri` (parallel to the v1.11.0 `isUiResourceUri`
//     promotion); data-bearing template reads stay fully gated.
//   - No initialize capability key added — resources/templates/list is
//     covered by the existing `resources` capability (the spec has no
//     separate templates capability flag).
// Bumped 1.12.0 → 1.13.0 (2026-07-04) reflecting:
//   - MCP Apps handshake completion: initialize.result.capabilities now
//     declares `extensions: { 'io.modelcontextprotocol/ui': {} }` (spec
//     2026-01-26). 1.11.0 shipped the ui:// app-shell resource + tool
//     `_meta.ui.resourceUri` (the CONTENT of the extension) but never
//     declared the extension in the capability handshake (the SIGNAL). Hosts
//     and agent-readiness scanners negotiate/detect MCP Apps off this
//     `capabilities.extensions` key, so the surface read as a plain MCP server
//     despite carrying every ui:// artifact. Purely additive: clients that
//     don't speak the extension ignore the extra capability key; no schema,
//     envelope, or auth change. Mirrored into
//     public/.well-known/mcp/server-card.json::capabilities.extensions so the
//     static card and the live wire stay in parity.
// Bumped 1.13.0 → 1.14.0 (2026-07-08) reflecting:
//   - MCP Apps interactive-dashboard fleet: four new ui:// app-shell resources
//     joining the v1.11.0 country-risk widget —
//       * ui://worldmonitor/world-brief.html      (get_world_brief)
//       * ui://worldmonitor/country-brief.html    (get_country_brief)
//       * ui://worldmonitor/market-radar.html      (get_market_data)
//       * ui://worldmonitor/chokepoint-monitor.html (get_chokepoint_status)
//     Each is linked from its backing tool via `_meta.ui.resourceUri` (+ the
//     deprecated flat `ui/resourceUri` alias) and registered in
//     api/mcp/ui/registry.ts. A shared shell (api/mcp/ui/shell.ts) factors the
//     DOCTYPE / 4-category CSP / dark-mode tokens / postMessage bridge so the
//     fleet can't drift on the orank quality/CSP signals. resources/read of a
//     ui:// URI stays public + quota-exempt (static, data-free template); DATA
//     reads (worldmonitor://…) stay gated + Pro-quota-symmetric.
//   - Purely additive on the wire: `_meta` appears on the four newly-linked
//     tools; every ui:// read is anonymously servable. No input/output schema
//     change to any tool, no envelope-shape change, no auth change.
// Bumped 1.14.0 → 1.15.0 (2026-07-10) reflecting:
//   - MCP Apps interactive-dashboard fleet expansion 5 → 10: five new ui://
//     app-shell resources joining the existing fleet —
//       * ui://worldmonitor/news-intelligence.html  (get_news_intelligence)
//       * ui://worldmonitor/conflict-events.html     (get_conflict_events)
//       * ui://worldmonitor/natural-disasters.html   (get_natural_disasters)
//       * ui://worldmonitor/prediction-markets.html  (get_prediction_markets)
//       * ui://worldmonitor/forecasts.html           (get_forecast_predictions)
//     Each renders through the shared shell (api/mcp/ui/shell.ts) and links from
//     its backing cache tool via `_meta.ui.resourceUri`. Purely additive: `_meta`
//     appears on five newly-linked tools; every ui:// read stays anonymously
//     servable, quota-exempt, and data-free. No input/output schema, envelope,
//     or auth change.
// Keep aligned with public/.well-known/mcp/server-card.json::serverInfo.version
// — discovery scanners cross-check both values.
export const SERVER_VERSION = '1.15.0';

// MCP logging capability — valid severity levels per the 2025-03-26 spec
// (RFC 5424 subset). Stateless HTTP transport: we ACK the level but do not
// push async `notifications/message` log events.
export const MCP_LOG_LEVELS: ReadonlySet<string> = new Set([
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

// tools/list tool-description compression cap (v1.5.0). Defined here
// rather than near `compressDescription` so SERVER_INSTRUCTIONS can
// quote it without a temporal-dead-zone error. The compressDescription
// helper definition lives later, with the rest of the helpers.
export const TOOL_DESCRIPTION_MAX_BYTES = 120;

// Session-level discovery instructions. Per MCP 2025-03-26 lifecycle spec,
// servers MAY return an `instructions` string in the `initialize` result;
// clients SHOULD surface this to the model. Each stanza names an affordance
// (JMESPath, describe_tool, prompts/list, resources/list), states its one-line
// use case, and points at the authoritative docs URL for full detail — the
// LLM does not reliably fetch URLs mid-session, so the in-band sentences must
// stand alone. Inline guide/envelope detail used to live here; it now lives in
// docs/mcp-jmespath.mdx, docs/mcp-error-catalog.mdx, and
// docs/mcp-tools-reference.mdx, fetched on demand instead of amortising
// ~550 bytes per session.
export const SERVER_INSTRUCTIONS = [
  'Every tool accepts an optional `jmespath` string. Server-side projection applied AFTER per-tool filter/summary; typical 80-95% token reduction. Grammar: https://jmespath.org/specification.html. Guide + 12 worked examples: https://www.worldmonitor.app/docs/mcp-jmespath.',
  '',
  `Limits: expr ≤ ${JMESPATH_MAX_EXPR_BYTES}B, output ≤ ${JMESPATH_MAX_OUTPUT_BYTES}B. Bad expressions soft-fail via {_jmespath_error, original_keys} envelope (consumes one Pro/OAuth daily quota unit on retry when that quota path applies — self-correct from original_keys). Full envelope reference: https://www.worldmonitor.app/docs/mcp-error-catalog.`,
  '',
  `tools/list ships compressed tool descriptions (≤${TOOL_DESCRIPTION_MAX_BYTES}B). Call describe_tool({tool_name}) for the full uncompressed definition — quota-exempt (still counts toward the 60/min rate limit), so use freely while exploring. describe_tool({tool_name: 'nonexistent'}) returns {error: 'unknown_tool', available: [...]} so you can self-correct. Full reference: https://www.worldmonitor.app/docs/mcp-tools-reference.`,
  '',
  'Issue prompts/list to discover pre-built workflow templates (country-briefing, energy-shock-watch, market-open-prep, conflict-pulse, route-risk-check, freshness-audit). Each prompt pre-bakes a JMESPath projection per step so the first execution lands on the right shape. prompts/list + prompts/get are quota-exempt (per-minute limit only).',
  '',
  'Issue resources/list for concrete read-only resources (v1: seed-meta freshness — anonymous + quota-free) and resources/templates/list for parameterised URI templates (country risk, chokepoint status, market quote). Substitute the template placeholder, then resources/read the concrete URI; a template read consumes the Pro daily quota IDENTICALLY to the equivalent tools/call — there is no free path around the cap via those resources.',
].join('\n');

// Country-code whitelist for get_consumer_prices. The consumer-prices seeder
// currently only produces data for AE (UAE); future markets will be added
// here as they're seeded. Kept near COUNTRY_BBOXES (the other ISO-3166 alpha-2
// lookup table used by tools) so adding a market is a single-file change.
export const SUPPORTED_CONSUMER_PRICES_COUNTRIES = new Set(['ae']);

// Default cap applied by every cache tool's `_postFilter` when the call omits
// `limit` — issue #3678 ("MCP tool responses are very large"). Reasonable
// per-list cap that keeps a typical multi-key bundle response under ~5–10 KB.
// Clients that want the full payload pass `limit: 0`; the cap helpers treat
// `n <= 0` as a no-op, so `0` is the explicit opt-out sentinel.
export const DEFAULT_LIST_LIMIT = 30;
