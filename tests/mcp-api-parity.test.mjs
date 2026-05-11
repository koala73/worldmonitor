// Tier-4 — MCP↔API parity test. Asserts that every public OpenAPI operation in
// `docs/api/*.openapi.json` is either:
//   (a) declared in some `TOOL_REGISTRY[i]._apiPaths` array, OR
//   (b) listed in `EXCLUDED_FROM_MCP_PARITY` below with a category-prefixed reason.
//
// Fail-hard: a new OpenAPI operation that isn't covered by an MCP tool AND isn't
// excluded with a documented reason fails CI. This is the structural fix
// preventing future drift between the public API surface and the MCP tool registry.
//
// Companion to `tests/mcp-bootstrap-parity.test.mjs` (U7, PR #3658) which covers
// the cache-key inventory (BOOTSTRAP_KEYS ∪ STANDALONE_KEYS). The two tests
// guard different inventories and coexist:
//   - U7 (bootstrap parity): "every cached key has an MCP path"
//   - Tier-4 (API parity, this file): "every public API op has an MCP path"

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { __testing__ as mcpTesting } from '../api/mcp.ts';

const { TOOL_REGISTRY } = mcpTesting;

// Valid category prefixes — every EXCLUDED_FROM_MCP_PARITY reason must start
// with one of these followed by a colon. Enforced by findEmptyOrUnprefixedReasons.
const VALID_PREFIXES = [
  'mutating',
  'llm-passthrough',
  'fetch-on-miss',
  'admin',
  'manual-mapping',
  'deferred-to-future-tool',
];

// Closed allowlist of valid secondary signals for `fetch-on-miss:` reasons.
// `already-covered-by-rpc-tool` is structurally FORBIDDEN — covered ops belong
// in a tool's _apiPaths, not in this exclusion map (Codex round 2).
const VALID_FETCH_ON_MISS_SECONDARIES = [
  'high-cardinality-input',
  'paid-upstream',
  'llm-cost',
];
const FORBIDDEN_FETCH_ON_MISS_SECONDARIES = [
  'already-covered-by-rpc-tool',
];

// -----------------------------------------------------------------------------
// HTTP-method allowlist — used by the OpenAPI walker to skip path-level siblings
// (`parameters`, `summary`, `description`, etc.) that share the methods object.
// -----------------------------------------------------------------------------
const HTTP_METHODS = new Set([
  'get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace',
]);


// -----------------------------------------------------------------------------
// EXCLUDED_FROM_MCP_PARITY — documented intentional omissions.
//
// Each entry: canonical "METHOD path" -> category-prefixed reason.
// Six valid category prefixes (enforced by findEmptyOrUnprefixedReasons):
//   - mutating:                writes state via setCachedJson/deleteRedisKey/etc.
//   - llm-passthrough:         invokes callLlm — per-call LLM cost
//   - fetch-on-miss:           uses cachedFetchJson — REQUIRES secondary signal
//                              from closed allowlist: high-cardinality-input
//                              / paid-upstream / llm-cost. The secondary
//                              "already-covered-by-rpc-tool" is FORBIDDEN —
//                              if covered by a tool, it belongs in that tool's
//                              _apiPaths.
//   - admin:                   internal-only — reason must name an explicit
//                              admin auth boundary (admin-key, internal-only
//                              middleware, cron-only path). Pro/Premium gating
//                              does NOT qualify. Likely zero entries today.
//   - manual-mapping:          parameterized cache key not statically resolvable;
//                              equivalent data covered by sibling tool at the
//                              prefix level.
//   - deferred-to-future-tool: pure-read with literal key, no covering tool yet
//                              — hint names the receiving future tool.
// -----------------------------------------------------------------------------

const EXCLUDED_FROM_MCP_PARITY = new Map([

  // === mutating (13) ===
  ["GET /api/aviation/v1/list-airport-delays",
    "mutating: writes state via setCachedJson / runRedisPipeline / persistent DB"],
  ["GET /api/infrastructure/v1/list-temporal-anomalies",
    "mutating: writes state via setCachedJson / runRedisPipeline / persistent DB"],
  ["GET /api/infrastructure/v1/reverse-geocode",
    "mutating: writes state via setCachedJson / runRedisPipeline / persistent DB"],
  ["GET /api/intelligence/v1/compute-energy-shock",
    "mutating: writes classification/derivation result to cache"],
  ["GET /api/resilience/v1/get-resilience-ranking",
    "mutating: writes state via setCachedJson / runRedisPipeline / persistent DB"],
  ["GET /api/supply-chain/v1/get-country-chokepoint-index",
    "mutating: writes state via setCachedJson / runRedisPipeline / persistent DB"],
  ["GET /api/v2/shipping/webhooks",
    "mutating: writes state via setCachedJson / runRedisPipeline / persistent DB"],
  ["GET /api/webcam/v1/list-webcams",
    "mutating: writes state via setCachedJson / runRedisPipeline / persistent DB"],
  ["POST /api/infrastructure/v1/record-baseline-snapshot",
    "mutating: writes state via setCachedJson / runRedisPipeline / persistent DB"],
  ["POST /api/scenario/v1/run-scenario",
    "mutating: writes state via setCachedJson / runRedisPipeline / persistent DB"],
  ["POST /api/leads/v1/register-interest",
    "mutating: writes to Convex (not server/_shared/redis) — lead registration write"],
  ["POST /api/leads/v1/submit-contact",
    "mutating: writes to Convex (not server/_shared/redis) — contact form write"],
  ["POST /api/v2/shipping/webhooks",
    "mutating: webhook/registration write — POSTs persistent record"],

  // === llm-passthrough (2) ===
  ["GET /api/intelligence/v1/classify-event",
    "llm-passthrough: invokes callLlm — per-call LLM cost prohibits open MCP exposure"],
  ["GET /api/market/v1/analyze-stock",
    "llm-passthrough: invokes callLlm — per-call LLM cost prohibits open MCP exposure"],

  // === fetch-on-miss (31) ===
  ["GET /api/intelligence/v1/get-risk-scores",
    "fetch-on-miss: paid-upstream — cachedFetchJsonWithMeta + ACLED API on cache miss. Cross-domain composite (12 keys: conflict + infra + climate + cyber + wildfires + GPS-jam + OREF + advisories + displacement + news) intended for a future expanded_risk_scores composite tool; current shape doesn't fit any single existing tool."],
  ["GET /api/aviation/v1/get-carrier-ops",
    "fetch-on-miss: paid-upstream — external upstream fetch per cache miss"],
  ["GET /api/aviation/v1/get-flight-status",
    "fetch-on-miss: high-cardinality-input — arbitrary query/symbol/identifier params, not enumerable"],
  ["GET /api/aviation/v1/get-youtube-live-stream-info",
    "fetch-on-miss: paid-upstream — external API call per request"],
  ["GET /api/aviation/v1/list-airport-flights",
    "fetch-on-miss: paid-upstream — external upstream fetch per cache miss"],
  ["GET /api/aviation/v1/list-aviation-news",
    "fetch-on-miss: paid-upstream — external feed fetch per request"],
  ["GET /api/conflict/v1/get-humanitarian-summary",
    "fetch-on-miss: paid-upstream — external upstream fetch per cache miss"],
  ["GET /api/conflict/v1/list-acled-events",
    "fetch-on-miss: paid-upstream — external upstream fetch per cache miss"],
  ["GET /api/economic/v1/list-world-bank-indicators",
    "fetch-on-miss: paid-upstream — external upstream fetch per cache miss"],
  ["GET /api/giving/v1/get-giving-summary",
    "fetch-on-miss: paid-upstream — external upstream fetch per cache miss"],
  ["GET /api/imagery/v1/search-imagery",
    "fetch-on-miss: high-cardinality-input — arbitrary query/symbol/identifier params, not enumerable"],
  ["GET /api/infrastructure/v1/get-cable-health",
    "fetch-on-miss: paid-upstream — external upstream fetch per cache miss"],
  ["GET /api/infrastructure/v1/list-service-statuses",
    "fetch-on-miss: paid-upstream — external feed fetch per request"],
  ["GET /api/intelligence/v1/get-company-enrichment",
    "fetch-on-miss: paid-upstream — external upstream fetch per cache miss"],
  ["GET /api/intelligence/v1/get-country-facts",
    "fetch-on-miss: paid-upstream — external upstream fetch per cache miss"],
  ["GET /api/intelligence/v1/list-company-signals",
    "fetch-on-miss: paid-upstream — external upstream fetch per cache miss"],
  ["GET /api/maritime/v1/list-navigational-warnings",
    "fetch-on-miss: paid-upstream — external feed fetch per request"],
  ["GET /api/market/v1/backtest-stock",
    "fetch-on-miss: high-cardinality-input — arbitrary query/symbol/identifier params, not enumerable"],
  ["GET /api/market/v1/get-country-stock-index",
    "fetch-on-miss: paid-upstream — external upstream fetch per cache miss"],
  ["GET /api/market/v1/get-insider-transactions",
    "fetch-on-miss: paid-upstream — external upstream fetch per cache miss"],
  ["GET /api/military/v1/get-aircraft-details",
    "fetch-on-miss: high-cardinality-input — arbitrary query/symbol/identifier params, not enumerable"],
  ["GET /api/military/v1/get-wingbits-live-flight",
    "fetch-on-miss: paid-upstream — external API call per request"],
  ["GET /api/military/v1/list-military-bases",
    "fetch-on-miss: paid-upstream — external upstream fetch per cache miss"],
  ["GET /api/supply-chain/v1/get-country-cost-shock",
    "fetch-on-miss: paid-upstream — external upstream fetch per cache miss"],
  ["GET /api/supply-chain/v1/get-critical-minerals",
    "fetch-on-miss: paid-upstream — external upstream fetch per cache miss"],
  ["GET /api/supply-chain/v1/get-route-explorer-lane",
    "fetch-on-miss: paid-upstream — external upstream fetch per cache miss"],
  ["GET /api/supply-chain/v1/get-route-impact",
    "fetch-on-miss: paid-upstream — external upstream fetch per cache miss"],
  ["GET /api/supply-chain/v1/get-sector-dependency",
    "fetch-on-miss: paid-upstream — external upstream fetch per cache miss"],
  ["GET /api/webcam/v1/get-webcam-image",
    "fetch-on-miss: paid-upstream — external upstream fetch per cache miss"],
  ["POST /api/conflict/v1/get-humanitarian-summary-batch",
    "fetch-on-miss: paid-upstream — external upstream fetch per cache miss"],
  ["POST /api/military/v1/get-aircraft-details-batch",
    "fetch-on-miss: high-cardinality-input — arbitrary query/symbol/identifier params, not enumerable"],

  // === manual-mapping (27) ===
  ["GET /api/aviation/v1/search-flight-prices",
    "manual-mapping: handler uses inline Redis or Convex (not server/_shared/redis) — manual triage"],
  ["GET /api/displacement/v1/get-population-exposure",
    "manual-mapping: handler uses inline Redis or Convex (not server/_shared/redis) — manual triage"],
  ["GET /api/economic/v1/get-bls-series",
    "manual-mapping: parameterized cache key not statically resolvable — equivalent data covered by sibling cache tool at the prefix level"],
  ["GET /api/economic/v1/get-fred-series",
    "manual-mapping: parameterized cache key not statically resolvable — equivalent data covered by sibling cache tool at the prefix level"],
  ["GET /api/infrastructure/v1/get-bootstrap-data",
    "manual-mapping: parameterized cache key not statically resolvable — equivalent data covered by sibling cache tool at the prefix level"],
  ["GET /api/infrastructure/v1/get-ip-geo",
    "manual-mapping: handler uses inline Redis or Convex (not server/_shared/redis) — manual triage"],
  ["GET /api/infrastructure/v1/get-temporal-baseline",
    "manual-mapping: parameterized cache key not statically resolvable — equivalent data covered by sibling cache tool at the prefix level"],
  ["GET /api/intelligence/v1/get-regime-history",
    "manual-mapping: handler uses inline Redis or Convex (not server/_shared/redis) — manual triage"],
  ["GET /api/intelligence/v1/get-regional-brief",
    "manual-mapping: parameterized cache key not statically resolvable — equivalent data covered by sibling cache tool at the prefix level"],
  ["GET /api/intelligence/v1/get-regional-snapshot",
    "manual-mapping: parameterized cache key not statically resolvable — equivalent data covered by sibling cache tool at the prefix level"],
  ["GET /api/intelligence/v1/list-market-implications",
    "manual-mapping: parameterized cache key not statically resolvable — equivalent data covered by sibling cache tool at the prefix level"],
  ["GET /api/intelligence/v1/list-telegram-feed",
    "manual-mapping: handler uses inline Redis or Convex (not server/_shared/redis) — manual triage"],
  ["GET /api/market/v1/get-stock-analysis-history",
    "manual-mapping: handler uses inline Redis or Convex (not server/_shared/redis) — manual triage"],
  ["GET /api/market/v1/list-stored-stock-backtests",
    "manual-mapping: handler uses inline Redis or Convex (not server/_shared/redis) — manual triage"],
  ["GET /api/military/v1/get-wingbits-status",
    "manual-mapping: handler uses inline Redis or Convex (not server/_shared/redis) — manual triage"],
  ["GET /api/news/v1/summarize-article-cache",
    "manual-mapping: parameterized cache key not statically resolvable — equivalent data covered by sibling cache tool at the prefix level"],
  ["GET /api/research/v1/list-arxiv-papers",
    "manual-mapping: parameterized cache key not statically resolvable — equivalent data covered by sibling cache tool at the prefix level"],
  ["GET /api/research/v1/list-hackernews-items",
    "manual-mapping: parameterized cache key not statically resolvable — equivalent data covered by sibling cache tool at the prefix level"],
  ["GET /api/research/v1/list-trending-repos",
    "manual-mapping: parameterized cache key not statically resolvable — equivalent data covered by sibling cache tool at the prefix level"],
  ["GET /api/resilience/v1/get-resilience-score",
    "manual-mapping: handler uses inline Redis or Convex (not server/_shared/redis) — manual triage"],
  ["GET /api/scenario/v1/list-scenario-templates",
    "manual-mapping: handler uses inline Redis or Convex (not server/_shared/redis) — manual triage"],
  ["GET /api/supply-chain/v1/get-country-products",
    "manual-mapping: parameterized cache key not statically resolvable — equivalent data covered by sibling cache tool at the prefix level"],
  ["GET /api/supply-chain/v1/get-multi-sector-cost-shock",
    "manual-mapping: parameterized cache key not statically resolvable — equivalent data covered by sibling cache tool at the prefix level"],
  ["GET /api/trade/v1/get-tariff-trends",
    "manual-mapping: parameterized cache key not statically resolvable — equivalent data covered by sibling cache tool at the prefix level"],
  ["GET /api/trade/v1/get-trade-flows",
    "manual-mapping: parameterized cache key not statically resolvable — equivalent data covered by sibling cache tool at the prefix level"],
  ["GET /api/trade/v1/list-comtrade-flows",
    "manual-mapping: parameterized cache key not statically resolvable — equivalent data covered by sibling cache tool at the prefix level"],
  ["POST /api/economic/v1/get-fred-series-batch",
    "manual-mapping: parameterized cache key not statically resolvable — equivalent data covered by sibling cache tool at the prefix level"],

  // === deferred-to-future-tool (51) ===
  ["GET /api/consumer-prices/v1/get-consumer-price-basket-series",
    "deferred-to-future-tool: handler reads parameterized consumer-prices:basket-series:<market>:<basket>:<range> key NOT in get_consumer_prices._coverageKeys — bundle into a future expanded_consumer_prices tool that exposes the basket-series time series"],
  // NOTE: risk-scores was previously mis-classified as deferred-to-future-tool.
  // The handler uses cachedFetchJsonWithMeta (server/.../get-risk-scores.ts:600)
  // with ACLED + auxiliary cross-domain fetches on cache miss — that's the
  // fetch-on-miss shape, NOT pure-read. Recategorized to fetch-on-miss with
  // paid-upstream secondary (ACLED is rate-limited external API). The cross-
  // domain composite shape (12 keys aggregated) is the implementer-hint for
  // a future expanded_risk_scores composite tool, but the structural
  // category is fetch-on-miss.
  ["GET /api/market/v1/get-gold-intelligence",
    "deferred-to-future-tool: handler reads 5 keys (commodities-bootstrap + COT + gold-extended + gold-ETF-flows + gold-CB-reserves); only commodities-bootstrap overlaps with get_market_data._cacheKeys — bundle into a future expanded_commodities tool that exposes COT, gold-extended, ETF flows, and CB reserves"],
  ["GET /api/aviation/v1/get-airport-ops-summary",
    "deferred-to-future-tool: pure-read but no MCP tool exposes aviation:delays:intl:v3 yet — bundle into a future expanded-domain tool"],
  ["GET /api/cyber/v1/list-cyber-threats",
    "deferred-to-future-tool: pure-read but no MCP tool exposes cyber:threats:v2 yet — bundle into a future expanded-domain tool"],
  ["GET /api/economic/v1/get-bis-credit",
    "deferred-to-future-tool: pure-read but no MCP tool exposes economic:bis:credit:v1 yet — bundle into a future expanded-domain tool"],
  ["GET /api/economic/v1/get-bis-exchange-rates",
    "deferred-to-future-tool: pure-read but no MCP tool exposes economic:bis:eer:v1 yet — bundle into a future expanded-domain tool"],
  ["GET /api/economic/v1/get-bis-policy-rates",
    "deferred-to-future-tool: pure-read but no MCP tool exposes economic:bis:policy:v1 yet — bundle into a future expanded-domain tool"],
  ["GET /api/economic/v1/get-crude-inventories",
    "deferred-to-future-tool: pure-read but no MCP tool exposes economic:crude-inventories:v1 yet — bundle into a future expanded-domain tool"],
  ["GET /api/economic/v1/get-economic-stress",
    "deferred-to-future-tool: pure-read but no MCP tool exposes economic:stress-index:v1 yet — bundle into a future expanded-domain tool"],
  ["GET /api/economic/v1/get-energy-capacity",
    "deferred-to-future-tool: pure-read but no MCP tool exposes economic:capacity:v1:COL yet — bundle into a future expanded-domain tool"],
  ["GET /api/economic/v1/get-energy-prices",
    "deferred-to-future-tool: pure-read but no MCP tool exposes economic:energy:v1:all yet — bundle into a future expanded-domain tool"],
  ["GET /api/economic/v1/get-eu-fsi",
    "deferred-to-future-tool: pure-read but no MCP tool exposes economic:fsi-eu:v1 yet — bundle into a future expanded-domain tool"],
  ["GET /api/economic/v1/get-eu-gas-storage",
    "deferred-to-future-tool: pure-read but no MCP tool exposes economic:eu-gas-storage:v1 yet — bundle into a future expanded-domain tool"],
  ["GET /api/economic/v1/get-eurostat-country-data",
    "deferred-to-future-tool: pure-read but no MCP tool exposes economic:eurostat-country-data:v1 yet — bundle into a future expanded-domain tool"],
  ["GET /api/economic/v1/get-macro-signals",
    "deferred-to-future-tool: pure-read but no MCP tool exposes economic:macro-signals:v1 yet — bundle into a future expanded-domain tool"],
  ["GET /api/economic/v1/get-nat-gas-storage",
    "deferred-to-future-tool: pure-read but no MCP tool exposes economic:nat-gas-storage:v1 yet — bundle into a future expanded-domain tool"],
  ["GET /api/economic/v1/get-oil-inventories",
    "deferred-to-future-tool: pure-read but no MCP tool exposes economic:crude-inventories:v1 yet — bundle into a future expanded-domain tool"],
  ["GET /api/economic/v1/get-oil-stocks-analysis",
    "deferred-to-future-tool: pure-read but no MCP tool exposes energy:oil-stocks-analysis:v1 yet — bundle into a future expanded-domain tool"],
  ["GET /api/economic/v1/list-grocery-basket-prices",
    "deferred-to-future-tool: pure-read but no MCP tool exposes economic:grocery-basket:v1 yet — bundle into a future expanded-domain tool"],
  ["GET /api/forecast/v1/get-simulation-outcome",
    "deferred-to-future-tool: pure-read but no MCP tool exposes forecast:simulation-outcome:latest yet — bundle into a future expanded-domain tool"],
  ["GET /api/forecast/v1/get-simulation-package",
    "deferred-to-future-tool: pure-read but no MCP tool exposes forecast:simulation-package:latest yet — bundle into a future expanded-domain tool"],
  ["GET /api/infrastructure/v1/list-internet-ddos-attacks",
    "deferred-to-future-tool: pure-read but no MCP tool exposes cf:radar:ddos:v1 yet — bundle into a future expanded-domain tool"],
  ["GET /api/infrastructure/v1/list-internet-traffic-anomalies",
    "deferred-to-future-tool: pure-read but no MCP tool exposes cf:radar:traffic-anomalies:v1 yet — bundle into a future expanded-domain tool"],
  ["GET /api/intelligence/v1/get-country-energy-profile",
    "deferred-to-future-tool: pure-read but no MCP tool exposes energy:spr-policies:v1 yet — bundle into a future expanded-domain tool"],
  ["GET /api/intelligence/v1/get-gdelt-topic-timeline",
    "deferred-to-future-tool: pure-read but no MCP tool exposes - yet — bundle into a future expanded-domain tool"],
  ["GET /api/intelligence/v1/get-pizzint-status",
    "deferred-to-future-tool: pure-read but no MCP tool exposes intelligence:pizzint:seed:v1 yet — bundle into a future expanded-domain tool"],
  ["GET /api/intelligence/v1/list-gps-interference",
    "deferred-to-future-tool: pure-read but no MCP tool exposes intelligence:gpsjam:v2 yet — bundle into a future expanded-domain tool"],
  ["GET /api/intelligence/v1/list-oref-alerts",
    "deferred-to-future-tool: pure-read but no MCP tool exposes relay:oref:history:v1 yet — bundle into a future expanded-domain tool"],
  ["GET /api/intelligence/v1/list-satellites",
    "deferred-to-future-tool: pure-read but no MCP tool exposes intelligence:satellites:tle:v1 yet — bundle into a future expanded-domain tool"],
  ["GET /api/intelligence/v1/list-security-advisories",
    "deferred-to-future-tool: pure-read but no MCP tool exposes intelligence:advisories:v1 yet — bundle into a future expanded-domain tool"],
  ["GET /api/market/v1/get-hyperliquid-flow",
    "deferred-to-future-tool: pure-read but no MCP tool exposes market:hyperliquid:flow:v1 yet — bundle into a future expanded-domain tool"],
  ["GET /api/market/v1/get-market-breadth-history",
    "deferred-to-future-tool: pure-read but no MCP tool exposes market:breadth-history:v1 yet — bundle into a future expanded-domain tool"],
  ["GET /api/market/v1/list-ai-tokens",
    "deferred-to-future-tool: pure-read but no MCP tool exposes market:ai-tokens:v1 yet — bundle into a future expanded-domain tool"],
  ["GET /api/market/v1/list-crypto-sectors",
    "deferred-to-future-tool: pure-read but no MCP tool exposes market:crypto-sectors:v1 yet — bundle into a future expanded-domain tool"],
  ["GET /api/market/v1/list-defi-tokens",
    "deferred-to-future-tool: pure-read but no MCP tool exposes market:defi-tokens:v1 yet — bundle into a future expanded-domain tool"],
  ["GET /api/market/v1/list-other-tokens",
    "deferred-to-future-tool: pure-read but no MCP tool exposes market:other-tokens:v1 yet — bundle into a future expanded-domain tool"],
  ["GET /api/market/v1/list-stablecoin-markets",
    "deferred-to-future-tool: pure-read but no MCP tool exposes market:stablecoins:v1 yet — bundle into a future expanded-domain tool"],
  ["GET /api/military/v1/get-usni-fleet-report",
    "deferred-to-future-tool: pure-read but no MCP tool exposes usni-fleet:sebuf:v1 yet — bundle into a future expanded-domain tool"],
  ["GET /api/military/v1/list-defense-patents",
    "deferred-to-future-tool: pure-read but no MCP tool exposes patents:defense:latest yet — bundle into a future expanded-domain tool"],
  ["GET /api/scenario/v1/get-scenario-status",
    "deferred-to-future-tool: pure-read but no MCP tool exposes - yet — bundle into a future expanded-domain tool"],
  ["GET /api/supply-chain/v1/get-bypass-options",
    "deferred-to-future-tool: pure-read but no MCP tool exposes supply_chain:chokepoints:v4 yet — bundle into a future expanded-domain tool"],
  ["GET /api/supply-chain/v1/get-chokepoint-history",
    "deferred-to-future-tool: pure-read but no MCP tool exposes - yet — bundle into a future expanded-domain tool"],
  ["GET /api/supply-chain/v1/get-pipeline-detail",
    "deferred-to-future-tool: pure-read but no MCP tool exposes energy:pipelines:gas:v1 yet — bundle into a future expanded-domain tool"],
  ["GET /api/supply-chain/v1/get-shipping-rates",
    "deferred-to-future-tool: pure-read but no MCP tool exposes supply_chain:shipping:v2 yet — bundle into a future expanded-domain tool"],
  ["GET /api/supply-chain/v1/get-storage-facility-detail",
    "deferred-to-future-tool: pure-read but no MCP tool exposes energy:storage-facilities:v1 yet — bundle into a future expanded-domain tool"],
  ["GET /api/supply-chain/v1/list-pipelines",
    "deferred-to-future-tool: pure-read but no MCP tool exposes energy:pipelines:gas:v1 yet — bundle into a future expanded-domain tool"],
  ["GET /api/supply-chain/v1/list-storage-facilities",
    "deferred-to-future-tool: pure-read but no MCP tool exposes energy:storage-facilities:v1 yet — bundle into a future expanded-domain tool"],
  ["GET /api/thermal/v1/list-thermal-escalations",
    "deferred-to-future-tool: pure-read but no MCP tool exposes thermal:escalation:v1 yet — bundle into a future expanded-domain tool"],
  ["GET /api/trade/v1/get-trade-barriers",
    "deferred-to-future-tool: pure-read but no MCP tool exposes trade:barriers:v1:tariff-gap:50 yet — bundle into a future expanded-domain tool"],
  ["GET /api/trade/v1/get-trade-restrictions",
    "deferred-to-future-tool: pure-read but no MCP tool exposes trade:restrictions:v1:tariff-overview:50 yet — bundle into a future expanded-domain tool"],
  ["GET /api/v2/shipping/route-intelligence",
    "deferred-to-future-tool: pure-read but no MCP tool exposes supply_chain:chokepoints:v4 yet — bundle into a future expanded-domain tool"],
]);


// -----------------------------------------------------------------------------
// Pure predicate helpers (no module-state coupling) — used by both the live
// assertions and the fixture-based meta-tests that prove each predicate
// actually fires on synthetic invalid inputs.
//
// Module-local declarations (NOT exported) per biome `noExportsInTest`. The
// describe blocks below call them directly.
// -----------------------------------------------------------------------------

/**
 * Walk every `*.openapi.json` under `specsDir` and collect operations as
 * canonical `"METHOD path"` strings. Path is the literal OpenAPI path key
 * (treated opaquely — works for `/api/<svc>/v1/<op>`, `/api/v2/<svc>/<op>`,
 * or any future shape). Method is uppercased.
 *
 * Defensive: skips malformed specs (missing/non-object `.paths`) silently
 * with a `console.warn`. Filters path-object keys through HTTP_METHODS so
 * OpenAPI siblings like `parameters` don't inflate the count.
 */
function collectApiOperations(specsDir) {
  const ops = new Set();
  let files;
  try {
    files = readdirSync(specsDir).filter((f) => f.endsWith('.openapi.json'));
  } catch {
    return ops;
  }
  for (const f of files) {
    let spec;
    try {
      spec = JSON.parse(readFileSync(join(specsDir, f), 'utf8'));
    } catch (err) {
      console.warn(`[mcp-api-parity] skipping malformed spec ${f}: ${err.message}`);
      continue;
    }
    const paths = spec?.paths;
    if (!paths || typeof paths !== 'object') continue;
    for (const path of Object.keys(paths)) {
      const pathObj = paths[path];
      if (!pathObj || typeof pathObj !== 'object') continue;
      for (const key of Object.keys(pathObj)) {
        if (HTTP_METHODS.has(key.toLowerCase())) {
          ops.add(`${key.toUpperCase()} ${path}`);
        }
      }
    }
  }
  return ops;
}

/** Aggregate every tool's `_apiPaths` into one Set<string>. */
function collectDeclaredApiPaths(toolRegistry) {
  const declared = new Set();
  for (const tool of toolRegistry) {
    if (Array.isArray(tool._apiPaths)) {
      for (const p of tool._apiPaths) declared.add(p);
    }
  }
  return declared;
}

/** API ops that are neither covered by a tool nor in the exclusion map. */
function findUncoveredApiOps({ apiOps, declaredPaths, excludedMap }) {
  const uncovered = [];
  for (const op of apiOps) {
    if (declaredPaths.has(op)) continue;
    if (excludedMap.has(op)) continue;
    uncovered.push(op);
  }
  return uncovered;
}

/** Excluded entries whose reason is empty/whitespace OR doesn't start with one of validPrefixes. */
function findEmptyOrUnprefixedReasons(excludedMap, validPrefixes) {
  const offenders = [];
  for (const [op, reason] of excludedMap) {
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      offenders.push(op);
      continue;
    }
    const hasValid = validPrefixes.some((p) => reason.startsWith(`${p}:`));
    if (!hasValid) offenders.push(op);
  }
  return offenders;
}

/** Excluded ops not present in the live OpenAPI inventory (stale exclusions). */
function findDeadExclusions({ excludedMap, apiOps }) {
  const dead = [];
  for (const op of excludedMap.keys()) {
    if (!apiOps.has(op)) dead.push(op);
  }
  return dead;
}

/** Declared `_apiPaths` entries not present in the live OpenAPI inventory (stale tool metadata). */
function findDeadApiPaths({ declaredPaths, apiOps }) {
  const dead = [];
  for (const p of declaredPaths) {
    if (!apiOps.has(p)) dead.push(p);
  }
  return dead;
}

/** `fetch-on-miss:` entries without a valid secondary signal (bare or unknown secondary). */
function findBareFetchOnMissReasons(excludedMap) {
  const offenders = [];
  for (const [op, reason] of excludedMap) {
    if (!reason.startsWith('fetch-on-miss:')) continue;
    const secondary = reason.slice('fetch-on-miss:'.length).trim();
    if (secondary.length === 0) { offenders.push(op); continue; }
    const hasValid = VALID_FETCH_ON_MISS_SECONDARIES.some(
      (sig) => secondary === sig || secondary.startsWith(`${sig} `) || secondary.startsWith(`${sig}—`),
    );
    if (!hasValid) offenders.push(op);
  }
  return offenders;
}

/** Ops declared in some tool's `_apiPaths` AND listed in the exclusion map (forbidden double-coverage).
 *  An op should be EITHER covered (in _apiPaths) OR excluded (in the map), never both. */
function findDoubleCoveredOps({ declaredPaths, excludedMap }) {
  const doubles = [];
  for (const op of declaredPaths) {
    if (excludedMap.has(op)) doubles.push(op);
  }
  return doubles;
}

/** `fetch-on-miss:` entries naming a FORBIDDEN secondary (the loophole-blocker). */
function findForbiddenFetchOnMissSecondaries(excludedMap) {
  const offenders = [];
  for (const [op, reason] of excludedMap) {
    if (!reason.startsWith('fetch-on-miss:')) continue;
    for (const forbidden of FORBIDDEN_FETCH_ON_MISS_SECONDARIES) {
      if (reason.includes(forbidden)) { offenders.push(op); break; }
    }
  }
  return offenders;
}

// -----------------------------------------------------------------------------
// Live structural assertions — run against the real OpenAPI + TOOL_REGISTRY
// -----------------------------------------------------------------------------

describe('Tier-4 — MCP↔API parity assertions', () => {
  const apiOps = collectApiOperations(join(import.meta.dirname, '..', 'docs', 'api'));
  const declaredPaths = collectDeclaredApiPaths(TOOL_REGISTRY);

  it('every OpenAPI operation is covered by a tool _apiPaths OR explicitly excluded', () => {
    const uncovered = findUncoveredApiOps({ apiOps, declaredPaths, excludedMap: EXCLUDED_FROM_MCP_PARITY });
    if (uncovered.length > 0) {
      const list = uncovered.slice(0, 10).map((op) => `  - ${op}`).join('\n');
      const more = uncovered.length > 10 ? `\n  ... and ${uncovered.length - 10} more` : '';
      throw new Error(
        `${uncovered.length} OpenAPI operation(s) are not covered by any MCP tool and not in EXCLUDED_FROM_MCP_PARITY:\n` +
        `${list}${more}\n\n` +
        `Two fix paths:\n` +
        `  (a) Add to a tool's _apiPaths (e.g., 'GET /api/economic/v1/get-bls-series' to get_economic_data._apiPaths)\n` +
        `  (b) Add to EXCLUDED_FROM_MCP_PARITY with a categorized reason (e.g., 'deferred-to-future-tool: future expanded_economic_data — BLS labor series')`
      );
    }
  });

  it('every EXCLUDED_FROM_MCP_PARITY entry has a non-empty reason with a valid category prefix', () => {
    const offenders = findEmptyOrUnprefixedReasons(EXCLUDED_FROM_MCP_PARITY, VALID_PREFIXES);
    assert.deepEqual(offenders, [], `Entries with empty/unprefixed reasons: ${offenders.slice(0, 5).join(', ')}${offenders.length > 5 ? ` (+${offenders.length - 5} more)` : ''}`);
  });

  it('every EXCLUDED_FROM_MCP_PARITY op exists in the live OpenAPI inventory (no dead exclusions)', () => {
    const dead = findDeadExclusions({ excludedMap: EXCLUDED_FROM_MCP_PARITY, apiOps });
    assert.deepEqual(dead, [], `Dead exclusions: ${dead.slice(0, 5).join(', ')}${dead.length > 5 ? ` (+${dead.length - 5} more)` : ''}`);
  });

  it('every tool _apiPaths entry exists in the live OpenAPI inventory (no dead _apiPaths)', () => {
    const dead = findDeadApiPaths({ declaredPaths, apiOps });
    assert.deepEqual(dead, [], `Dead _apiPaths (tool metadata names ops not in any OpenAPI spec): ${dead.slice(0, 5).join(', ')}${dead.length > 5 ? ` (+${dead.length - 5} more)` : ''}`);
  });

  it('no fetch-on-miss: reason is bare — every entry requires a valid secondary signal', () => {
    const offenders = findBareFetchOnMissReasons(EXCLUDED_FROM_MCP_PARITY);
    assert.deepEqual(offenders, [], `Bare/unknown fetch-on-miss secondaries (must use ${VALID_FETCH_ON_MISS_SECONDARIES.join(' | ')}): ${offenders.slice(0, 5).join(', ')}`);
  });

  it('no fetch-on-miss: reason uses the FORBIDDEN already-covered-by-rpc-tool secondary', () => {
    const offenders = findForbiddenFetchOnMissSecondaries(EXCLUDED_FROM_MCP_PARITY);
    assert.deepEqual(offenders, [], `Forbidden fetch-on-miss secondary (move to tool's _apiPaths instead): ${offenders.join(', ')}`);
  });

  it('no op is double-covered (declared in _apiPaths AND listed in EXCLUDED_FROM_MCP_PARITY)', () => {
    const doubles = findDoubleCoveredOps({ declaredPaths, excludedMap: EXCLUDED_FROM_MCP_PARITY });
    assert.deepEqual(doubles, [],
      `Op(s) declared in some tool's _apiPaths AND listed in EXCLUDED_FROM_MCP_PARITY (pick one): ${doubles.join(', ')}. ` +
      `Coverage is exclusive — remove the exclusion entry for any op that's now covered by a tool.`);
  });

  it('covered + excluded ops must equal total OpenAPI op count (no gaps, no double-counts)', () => {
    // Hard structural invariant — separate from the reporting test below so a
    // future failure isn't misread as "CI logging format problem." Fires on:
    //   - double-coverage (op in both _apiPaths and exclusion map) → LHS overshoots
    //   - silent drop (op missing from both)                       → LHS undershoots
    // The findUncoveredApiOps + findDoubleCoveredOps assertions above pinpoint
    // the offending op when this fires.
    assert.equal(declaredPaths.size + EXCLUDED_FROM_MCP_PARITY.size, apiOps.size,
      `Coverage math broken: declared=${declaredPaths.size} + excluded=${EXCLUDED_FROM_MCP_PARITY.size} ≠ total=${apiOps.size}`);
  });

  it('emits a categorized count report for downstream coverage planning', () => {
    const counts = new Map();
    for (const prefix of VALID_PREFIXES) counts.set(prefix, 0);
    for (const reason of EXCLUDED_FROM_MCP_PARITY.values()) {
      for (const prefix of VALID_PREFIXES) {
        if (reason.startsWith(`${prefix}:`)) { counts.set(prefix, counts.get(prefix) + 1); break; }
      }
    }
    const breakdown = VALID_PREFIXES.map((p) => `${p}:${counts.get(p)}`).join(' ');
    // Side-effect-only: emit summary so CI logs surface the actionable inventory.
    console.log(`[mcp-api-parity] ${declaredPaths.size} covered / ${EXCLUDED_FROM_MCP_PARITY.size} excluded (${breakdown}) / ${apiOps.size} total ops`);
  });
});

// -----------------------------------------------------------------------------
// Meta-tests — verify the predicate helpers fire on synthetic invalid fixtures.
// Without these, a regression that makes a predicate a no-op (early return,
// off-by-one filter, predicate inversion) would ship undetected because the
// live assertions above only fail when real codebase state is broken.
// -----------------------------------------------------------------------------

describe('Tier-4 meta-tests — predicates fire on synthetic invalid inputs', () => {
  // --- collectApiOperations ---
  it('collectApiOperations: empty Set for a non-existent directory', () => {
    const ops = collectApiOperations('/tmp/definitely-not-a-real-dir-mcp-parity');
    assert.equal(ops.size, 0);
  });

  it('collectApiOperations: filters non-HTTP-method path siblings (parameters, summary, description)', (t) => {
    const tmpDir = mkSpecFixture({
      paths: {
        '/api/fixture/v1/get-foo': {
          get: { operationId: 'getFoo' },
          parameters: [{ name: 'q', in: 'query' }],
          summary: 'Fixture path-level summary',
        },
        '/api/fixture/v1/multi': {
          get: { operationId: 'getMulti' },
          post: { operationId: 'postMulti' },
        },
      },
    }, t);
    const ops = collectApiOperations(tmpDir);
    assert.deepEqual([...ops].sort(), [
      'GET /api/fixture/v1/get-foo',
      'GET /api/fixture/v1/multi',
      'POST /api/fixture/v1/multi',
    ]);
  });

  it('collectApiOperations: skips malformed specs without throwing', (t) => {
    const tmpDir = mkSpecFixture('not-valid-json{{{', t);
    const ops = collectApiOperations(tmpDir);
    assert.equal(ops.size, 0);
  });

  it('collectApiOperations: skips specs with missing/null/non-object paths', (t) => {
    // Three malformed shapes that all hit the line ~70 guard. Each fixture
    // is a separate spec file so we exercise all three branches in one run.
    const cases = [
      { openapi: '3.1.0' },              // missing paths entirely
      { openapi: '3.1.0', paths: null }, // paths: null
      { openapi: '3.1.0', paths: 'oh no' }, // paths: primitive
    ];
    for (const spec of cases) {
      const tmpDir = mkSpecFixture(spec, t);
      assert.equal(collectApiOperations(tmpDir).size, 0,
        `expected empty Set for malformed paths shape ${JSON.stringify(spec.paths)}`);
    }
  });

  // --- collectDeclaredApiPaths ---
  it('collectDeclaredApiPaths: aggregates _apiPaths across cache-tool + RPC-tool registry entries', () => {
    const fakeRegistry = [
      { name: 'cache_tool', _cacheKeys: ['a:v1'], _apiPaths: ['GET /api/a/v1/x', 'GET /api/a/v1/y'] },
      { name: 'rpc_tool', _execute: () => {}, _apiPaths: ['POST /api/b/v1/z'] },
      { name: 'no_paths', _cacheKeys: ['c:v1'], _apiPaths: [] },
    ];
    const declared = collectDeclaredApiPaths(fakeRegistry);
    assert.deepEqual([...declared].sort(), ['GET /api/a/v1/x', 'GET /api/a/v1/y', 'POST /api/b/v1/z']);
  });

  // --- findUncoveredApiOps ---
  it('findUncoveredApiOps: returns the synthetic uncovered op', () => {
    const apiOps = new Set(['GET /covered', 'GET /excluded', 'GET /ghost']);
    const declaredPaths = new Set(['GET /covered']);
    const excludedMap = new Map([['GET /excluded', 'mutating: state write']]);
    const result = findUncoveredApiOps({ apiOps, declaredPaths, excludedMap });
    assert.deepEqual(result, ['GET /ghost']);
  });

  it('findUncoveredApiOps: returns empty when every op is covered or excluded', () => {
    const apiOps = new Set(['GET /covered', 'GET /excluded']);
    const declaredPaths = new Set(['GET /covered']);
    const excludedMap = new Map([['GET /excluded', 'mutating: state write']]);
    assert.deepEqual(findUncoveredApiOps({ apiOps, declaredPaths, excludedMap }), []);
  });

  // --- findEmptyOrUnprefixedReasons ---
  it('findEmptyOrUnprefixedReasons: catches empty, whitespace, and unprefixed reasons', () => {
    const excludedMap = new Map([
      ['GET /valid', 'mutating: writes state'],
      ['GET /empty', ''],
      ['GET /whitespace', '   '],
      ['GET /unprefixed', 'some bare reason without prefix'],
    ]);
    const offenders = findEmptyOrUnprefixedReasons(excludedMap, VALID_PREFIXES);
    assert.deepEqual(offenders.sort(), ['GET /empty', 'GET /unprefixed', 'GET /whitespace']);
  });

  // --- findDeadExclusions ---
  it('findDeadExclusions: catches excluded ops absent from the OpenAPI inventory', () => {
    const apiOps = new Set(['GET /live']);
    const excludedMap = new Map([
      ['GET /live', 'mutating: write'],
      ['GET /ghost', 'mutating: write'],
    ]);
    assert.deepEqual(findDeadExclusions({ excludedMap, apiOps }), ['GET /ghost']);
  });

  // --- findDeadApiPaths ---
  it('findDeadApiPaths: catches declared _apiPaths entries pointing at non-existent OpenAPI ops', () => {
    const apiOps = new Set(['GET /live']);
    const declaredPaths = new Set(['GET /live', 'GET /vanished']);
    assert.deepEqual(findDeadApiPaths({ declaredPaths, apiOps }), ['GET /vanished']);
  });

  // --- findBareFetchOnMissReasons ---
  it('findBareFetchOnMissReasons: catches bare AND unknown-secondary entries, accepts valid ones', () => {
    const excludedMap = new Map([
      ['GET /good',     'fetch-on-miss: paid-upstream — external feed'],
      ['GET /good2',    'fetch-on-miss: high-cardinality-input — arbitrary query param'],
      ['GET /bare',     'fetch-on-miss:'],
      ['GET /unknown',  'fetch-on-miss: invented-secondary — not in allowlist'],
      ['GET /other',    'mutating: write'], // not fetch-on-miss, should not be flagged
    ]);
    const offenders = findBareFetchOnMissReasons(excludedMap);
    assert.deepEqual(offenders.sort(), ['GET /bare', 'GET /unknown']);
  });

  // --- findForbiddenFetchOnMissSecondaries ---
  it('findForbiddenFetchOnMissSecondaries: catches the already-covered-by-rpc-tool loophole', () => {
    const excludedMap = new Map([
      ['GET /loophole', 'fetch-on-miss: already-covered-by-rpc-tool — by get_country_risk'],
      ['GET /ok',       'fetch-on-miss: paid-upstream'],
    ]);
    assert.deepEqual(findForbiddenFetchOnMissSecondaries(excludedMap), ['GET /loophole']);
  });

  it('findDoubleCoveredOps: catches ops in both _apiPaths and the exclusion map', () => {
    const declaredPaths = new Set(['GET /covered', 'GET /double']);
    const excludedMap = new Map([
      ['GET /excluded-only', 'mutating: writes state'],
      ['GET /double', 'mutating: should not coexist with _apiPaths'],
    ]);
    assert.deepEqual(findDoubleCoveredOps({ declaredPaths, excludedMap }), ['GET /double']);
  });
});

// -----------------------------------------------------------------------------
// Fixture helpers (test-local; do not export)
// -----------------------------------------------------------------------------

function mkSpecFixture(content, t) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-parity-fixture-'));
  const body = typeof content === 'string' ? content : JSON.stringify(content);
  writeFileSync(join(dir, 'Fixture.openapi.json'), body);
  // Best-effort cleanup. node:test's TestContext.after fires post-test;
  // failure is non-fatal (CI runners typically clean /tmp anyway).
  if (t && typeof t.after === 'function') {
    t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
  }
  return dir;
}
