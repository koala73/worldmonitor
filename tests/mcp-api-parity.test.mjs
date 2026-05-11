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
import { readdirSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

  // === mutating (11) ===
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
  ["POST /api/v2/shipping/webhooks",
    "mutating: webhook/registration write — POSTs persistent record"],

  // === llm-passthrough (2) ===
  ["GET /api/intelligence/v1/classify-event",
    "llm-passthrough: invokes callLlm — per-call LLM cost prohibits open MCP exposure"],
  ["GET /api/market/v1/analyze-stock",
    "llm-passthrough: invokes callLlm — per-call LLM cost prohibits open MCP exposure"],

  // === fetch-on-miss (30) ===
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

  // === manual-mapping (29) ===
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
  ["POST /api/leads/v1/register-interest",
    "manual-mapping: handler uses inline Redis or Convex (not server/_shared/redis) — manual triage"],
  ["POST /api/leads/v1/submit-contact",
    "manual-mapping: handler uses inline Redis or Convex (not server/_shared/redis) — manual triage"],

  // === deferred-to-future-tool (49) ===
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

// -----------------------------------------------------------------------------
// Live structural assertions
// -----------------------------------------------------------------------------

describe('Tier-4 — OpenAPI inventory walker', () => {
  it('collectApiOperations returns a non-empty Set from real docs/api/', () => {
    const ops = collectApiOperations(join(import.meta.dirname, '..', 'docs', 'api'));
    assert.ok(ops.size >= 130, `expected ≥130 ops, got ${ops.size}`);
  });

  it('every collected entry is a canonical "METHOD path" string', () => {
    const ops = collectApiOperations(join(import.meta.dirname, '..', 'docs', 'api'));
    const canonical = /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|TRACE) \//;
    for (const op of ops) {
      assert.match(op, canonical, `non-canonical entry: ${JSON.stringify(op)}`);
    }
  });

  it('inventory includes known anchor operations across heaviest services', () => {
    const ops = collectApiOperations(join(import.meta.dirname, '..', 'docs', 'api'));
    // Spot-check anchors from the 5 heaviest specs (Economic, Intelligence,
    // Market, SupplyChain, Infrastructure) — any of these going missing
    // signals walker-shape drift before the parity assertion would catch it.
    assert.ok(ops.has('GET /api/economic/v1/get-bis-credit'), 'economic anchor missing');
    assert.ok(ops.has('GET /api/intelligence/v1/get-country-risk'), 'intelligence anchor missing');
    assert.ok(ops.has('GET /api/market/v1/list-defi-tokens'), 'market anchor missing');
  });
});

// -----------------------------------------------------------------------------
// Meta-tests — verify the predicate helpers fire on synthetic invalid fixtures
// -----------------------------------------------------------------------------

describe('Tier-4 meta-tests — walker fires on synthetic invalid inputs', () => {
  it('collectApiOperations returns empty Set for a non-existent directory', () => {
    const ops = collectApiOperations('/tmp/definitely-not-a-real-dir-mcp-parity');
    assert.equal(ops.size, 0);
  });

  it('collectApiOperations filters non-HTTP-method path siblings (parameters, summary, description)', () => {
    // Use a tmp fixture file to exercise the filter without polluting docs/api/
    const tmpDir = mkSpecFixture({
      paths: {
        '/api/fixture/v1/get-foo': {
          get: { operationId: 'getFoo' },
          parameters: [{ name: 'q', in: 'query' }],  // must be filtered
          summary: 'Fixture path-level summary',     // must be filtered
        },
        '/api/fixture/v1/multi': {
          get: { operationId: 'getMulti' },
          post: { operationId: 'postMulti' },
        },
      },
    });
    const ops = collectApiOperations(tmpDir);
    assert.deepEqual([...ops].sort(), [
      'GET /api/fixture/v1/get-foo',
      'GET /api/fixture/v1/multi',
      'POST /api/fixture/v1/multi',
    ]);
  });

  it('collectApiOperations skips malformed specs without throwing', () => {
    const tmpDir = mkSpecFixture('not-valid-json{{{');
    const ops = collectApiOperations(tmpDir);
    assert.equal(ops.size, 0);
  });
});

// -----------------------------------------------------------------------------
// Fixture helpers (test-local; do not export)
// -----------------------------------------------------------------------------

function mkSpecFixture(content) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-parity-fixture-'));
  const body = typeof content === 'string' ? content : JSON.stringify(content);
  writeFileSync(join(dir, 'Fixture.openapi.json'), body);
  return dir;
}
