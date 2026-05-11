// U7 (Tier 3) — MCP parity test. Asserts that every canonical seeded cache key
// in `api/health.js::BOOTSTRAP_KEYS` ∪ `STANDALONE_KEYS` is either:
//   (a) covered by some `TOOL_REGISTRY[i]._cacheKeys` array (CacheToolDef), OR
//   (b) covered by some `TOOL_REGISTRY[i]._coverageKeys` array (RpcToolDef hybrid), OR
//   (c) listed in `EXCLUDED_FROM_MCP` below with a non-empty documented reason.
//
// Fail-hard: a new seed shipping its cache key into BOOTSTRAP_KEYS/STANDALONE_KEYS
// without a corresponding MCP tool will fail CI until the contributor adds a tool
// or adds an EXCLUDED_FROM_MCP entry with a reason. This is the structural fix
// preventing future drift between the canonical seeded-data inventory and the
// MCP tool registry.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { __testing__ as healthTesting } from '../api/health.js';
import { __testing__ as mcpTesting } from '../api/mcp.ts';

const { BOOTSTRAP_KEYS, STANDALONE_KEYS } = healthTesting;
const { TOOL_REGISTRY } = mcpTesting;

// -----------------------------------------------------------------------------
// EXCLUDED_FROM_MCP — documented intentional omissions.
//
// Each entry: cache-key (verbatim from BOOTSTRAP_KEYS/STANDALONE_KEYS) → reason.
// - Empty reasons are rejected.
// - Dead exclusions (keys not in either inventory) are rejected.
// - Redundant exclusions (keys ALSO covered by a tool) are rejected.
//
// Categories represented below (annotated inline):
//   - intermediate:        low-level pipeline key whose data surfaces via a sibling tool.
//   - on-demand:           populated lazily by RPC handlers; not seeded by cron.
//   - cascade-mirror:      live/stale/backup fallback variant — covered by the canonical sibling.
//   - shared-token-panel:  written by the shared token-panels seed run; covered by other panels.
//   - deferred:            recognised gap; named follow-up tool/expansion not in this plan's scope.
//   - dashboard-internal:  feeds a UI panel, not a queryable MCP slice.
//   - operational:         relay heartbeats and similar — visible via /api/health, not MCP.
// -----------------------------------------------------------------------------
const EXCLUDED_FROM_MCP = new Map([

  // ===========================================================================
  // Intermediate / pipeline keys (data surfaces through a sibling tool)
  // ===========================================================================
  ['supply_chain:corridorrisk:v1',
    'intermediate: data flows through transit-summaries:v1 (matches api/health.js:461 ON_DEMAND_KEYS rationale; explicitly NOT bundled into get_chokepoint_status to avoid duplicate exposure).'],
  ['military:forecast-inputs:stale:v1',
    'intermediate: seed-to-seed pipeline key, only populated after seed-military-flights runs (matches api/health.js:463 ON_DEMAND_KEYS rationale).'],

  // ===========================================================================
  // Cascade-mirror fallbacks (live/stale/backup of a sibling already exposed)
  // ===========================================================================
  ['theater-posture:sebuf:v1',
    'cascade-mirror: live counterpart of theater_posture:sebuf:stale:v1 (covered by get_military_posture). CASCADE_GROUPS theaterPosture entry.'],
  ['theater-posture:sebuf:backup:v1',
    'cascade-mirror: backup counterpart of theater_posture:sebuf:stale:v1 (covered by get_military_posture). CASCADE_GROUPS theaterPosture entry.'],
  ['risk:scores:sebuf:v1',
    'cascade-mirror: live counterpart of risk:scores:sebuf:stale:v1 (covered by get_conflict_events).'],
  ['military:flights:v1',
    'cascade-mirror: live counterpart of military:flights:stale:v1 — deferred to a future expanded military tool (no current tool exposes either variant).'],
  ['military:flights:stale:v1',
    'cascade-mirror: stale fallback of military:flights:v1 — deferred to a future expanded military tool. CASCADE_GROUPS militaryFlights entry.'],
  ['usni-fleet:sebuf:v1',
    'cascade-mirror: live USNI fleet — deferred to a future military-fleet tool (no current tool exposes either variant).'],
  ['usni-fleet:sebuf:stale:v1',
    'cascade-mirror: stale USNI fleet — deferred to a future military-fleet tool.'],
  ['displacement:summary:v1:' + (new Date().getUTCFullYear() - 1),
    'cascade-mirror: previous-year displacement snapshot used by the dashboard year-over-year diff. Current-year key is exposed via get_displacement_data; the executeTool label-walk would collide on both years (matches api/health.js:482 + api/mcp.ts:346-350 rationale).'],
  ['positive-events:geo:v1',
    'cascade-mirror: live counterpart of positive_events:geo-bootstrap:v1 (covered by get_positive_events).'],
  ['aviation:delays:faa:v1',
    'cascade-mirror: RPC variant of aviation:delays-bootstrap:v1 (covered by get_aviation_status). Same seed-meta key (seed-meta:aviation:faa).'],
  ['cyber:threats:v2',
    'cascade-mirror: RPC variant of cyber:threats-bootstrap:v2 (covered by get_cyber_threats). Same seed-meta key (seed-meta:cyber:threats).'],
  ['aviation:delays:intl:v3',
    'cascade-mirror: international delays sibling of aviation:delays-bootstrap:v1 (covered by get_aviation_status) — deferred to a future expanded aviation tool that exposes the intl variant directly.'],
  ['aviation:notam:closures:v2',
    'cascade-mirror: NOTAM closures sibling of aviation:delays-bootstrap:v1 (covered by get_aviation_status) — deferred to a future expanded aviation tool that exposes NOTAMs directly.'],
  ['supply_chain:portwatch:v1',
    'cascade-mirror: PortWatch aggregate; per-port detail (supply_chain:portwatch-ports:v1:_countries) is the canonical key already exposed via get_chokepoint_status.'],

  // ===========================================================================
  // On-demand / RPC-populated keys (no dedicated seed cron)
  // ===========================================================================
  ['infra:service-statuses:v1',
    'on-demand: RPC-populated, seed-meta written on fresh fetch only, goes stale between visits (matches api/health.js:462 ON_DEMAND_KEYS rationale).'],
  ['economic:macro-signals:v1',
    'on-demand: RPC cache for derived macro-signals panel; underlying inputs already exposed via get_economic_data.'],
  ['economic:bis:policy:v1',
    'on-demand: RPC cache for BIS policy-rates extras (matches api/health.js:456 ON_DEMAND_KEYS rationale).'],
  ['economic:bis:eer:v1',
    'on-demand: RPC cache for BIS effective exchange rates (matches api/health.js:456 ON_DEMAND_KEYS rationale).'],
  ['economic:bis:credit:v1',
    'on-demand: RPC cache for BIS credit-to-GDP (matches api/health.js:456 ON_DEMAND_KEYS rationale).'],
  ['supply_chain:shipping:v2',
    'on-demand: cache populated on first user query; shipping-stress index (supply_chain:shipping_stress:v1) is the canonical seeded key already exposed via get_supply_chain_data.'],
  ['supply_chain:chokepoints:v4',
    'on-demand: superseded by the transit-summaries + chokepoint-flows + portwatch-ports bundle exposed via get_chokepoint_status.'],
  ['supply_chain:minerals:v2',
    'on-demand: RPC cache populated only after first user query — deferred to a future minerals/strategic-materials tool.'],
  ['giving:summary:v1',
    'on-demand: RPC cache for philanthropy summary; not in v1 brainstorm inventory. Deferred to a future humanitarian/aid tool.'],
  ['military:bases:active',
    'on-demand: RPC cache for military bases — deferred to a future expanded military tool.'],
  ['temporal:anomalies:v1',
    'on-demand: RPC cache populated only after first user query — deferred to a future temporal-analysis tool.'],
  ['news:threat:summary:v1',
    'on-demand: relay-classify-only, written only when classify produces country matches (matches api/health.js:468 ON_DEMAND_KEYS rationale). Underlying news inputs already exposed via get_news_intelligence.'],
  ['resilience:ranking:v18',
    'on-demand: RPC cache populated after Pro ranking requests (matches api/health.js:469 ON_DEMAND_KEYS rationale). Deferred to a future resilience tool.'],
  ['forecast:simulation-package:latest',
    'on-demand: written by writeSimulationPackage after deep forecast runs (matches api/health.js:466 ON_DEMAND_KEYS rationale). Internal pipeline artifact, not a queryable slice.'],
  ['forecast:simulation-outcome:latest',
    'on-demand: written by writeSimulationOutcome after simulation runs (matches api/health.js:467 ON_DEMAND_KEYS rationale). Internal pipeline artifact, not a queryable slice.'],

  // ===========================================================================
  // Recovery pillar (stub seeders, not yet deployed) — per api/health.js:470-471
  // ===========================================================================
  ['resilience:recovery:fiscal-space:v1',
    'deferred: recovery pillar stub seeder, not yet deployed (api/health.js:470-471 ON_DEMAND_KEYS). Future resilience tool will expose recovery dimensions.'],
  ['resilience:recovery:reserve-adequacy:v1',
    'deferred: recovery pillar stub seeder, not yet deployed (api/health.js:470-471).'],
  ['resilience:recovery:external-debt:v1',
    'deferred: recovery pillar stub seeder, not yet deployed (api/health.js:470-471).'],
  ['resilience:recovery:import-hhi:v1',
    'deferred: recovery pillar stub seeder, not yet deployed (api/health.js:470-471).'],
  ['resilience:recovery:fuel-stocks:v1',
    'deferred: recovery pillar stub seeder, not yet deployed (api/health.js:470-471).'],
  ['resilience:recovery:reexport-share:v1',
    'deferred: recovery pillar stub seeder, not yet deployed.'],
  ['resilience:recovery:sovereign-wealth:v1',
    'deferred: recovery pillar stub seeder, not yet deployed.'],

  // ===========================================================================
  // Deferred follow-up tools (explicit gaps named in the plan or related domain)
  // ===========================================================================
  ['intelligence:gpsjam:v2',
    'deferred to a future intelligence tool (per plan U7 expected exclusions).'],
  ['bls:series:v1',
    'deferred to a future labor-statistics tool (per plan U7 expected exclusions). BLS economic series already partially surfaced via FRED bundles in get_economic_data.'],
  ['economic:fx:yoy:v1',
    'deferred: derived FX year-over-year cache; underlying ECB FX rates already exposed via get_economic_data (economic:ecb-fx-rates:v1).'],
  ['intelligence:satellites:tle:v1',
    'deferred to a future space-domain tool. Not in v1 brainstorm inventory.'],
  ['intelligence:pizzint:seed:v1',
    'deferred to a future expanded intelligence tool. Not in v1 brainstorm inventory.'],
  ['intelligence:wsb-tickers:v1',
    'deferred: companion to get_social_velocity (Reddit r/wallstreetbets sentiment). Future expanded social-sentiment tool would bundle this with reddit feed.'],
  ['intelligence:telegram-feed:v1',
    'deferred to a future OSINT tool. Not in v1 brainstorm inventory.'],
  ['intelligence:regional-snapshots:summary:v1',
    'deferred to a future region-aware intelligence tool.'],
  ['intelligence:regional-briefs:summary:v1',
    'deferred to a future region-aware intelligence tool.'],
  ['intelligence:market-implications:v1',
    'deferred: LLM-generated narrative composite; underlying inputs already exposed via existing data tools. A future LLM-narrative tool would bundle this.'],
  ['supply_chain:hormuz_tracker:v1',
    'deferred: specialized Strait-of-Hormuz tracker; broader chokepoint coverage via get_chokepoint_status. Hormuz-specific tool deferred.'],
  ['thermal:escalation:v1',
    'deferred to a future conflict-escalation tool.'],
  ['resilience:static:index:v1',
    'deferred to a future resilience tool (paired with resilience:ranking:v18).'],
  ['resilience:static:fao',
    'deferred to a future resilience tool (FAO Phase 3+ aggregate, paired with resilience:static:index:v1).'],
  ['resilience:intervals:v2:US',
    'deferred to a future resilience tool (uncertainty intervals on top of resilience:ranking:v18).'],
  ['resilience:low-carbon-generation:v1',
    'deferred to a future resilience tool. Companion data to fossil-electricity-share (already exposed via get_energy_intelligence).'],
  ['resilience:power-losses:v1',
    'deferred to a future resilience tool. Companion data to the resilience v2 energy bundle.'],
  ['product-catalog:v2',
    'deferred to a future product-catalog tool. Used by the dashboard to render product metadata, not a queryable data slice.'],
  ['climate:zone-normals:v1',
    'deferred to a future climate-baseline tool. Reference data (30-year WMO normals) used as a denominator for climate:anomalies:v2 (already exposed via get_climate_data).'],
  ['regulatory:actions:v1',
    'deferred to a future regulatory/compliance tool. Not in v1 brainstorm inventory.'],
  ['economic:grocery-basket:v1',
    'deferred: per-country grocery basket index; complements consumer-prices (already exposed via get_consumer_prices). Future expanded consumer-prices tool would include this.'],
  ['economic:bis-lbs:v1',
    'deferred to a future expanded BIS tool. BIS DSR + property prices already exposed via get_economic_data; LBS (locational banking statistics) is a more specialised series.'],
  ['economic:fatf-listing:v1',
    'deferred to a future compliance/AML tool. FATF grey/black-listing is policy data, complement to sanctions (already exposed via get_sanctions_data).'],
  ['economic:wb-external-debt:v1',
    'deferred to a future World-Bank-detail tool. Annual external debt (WB IDS) companion to current account already in get_country_macro.'],
  ['economic:worldbank-techreadiness:v1',
    'deferred to a future World-Bank-detail tool. Tech-readiness composite — not in v1 brainstorm inventory.'],
  ['economic:worldbank-progress:v1',
    'deferred to a future World-Bank-detail tool. Development-progress composite — not in v1 brainstorm inventory.'],
  ['economic:eurostat-country-data:v1',
    'deferred: Eurostat aggregate panel; the three discrete Eurostat series (house prices, gov-debt-q, industrial production) are already individually exposed via dedicated tools. The aggregate is redundant for MCP consumers.'],
  ['economic:fsi-eu:v1',
    'deferred: EU Financial Stress Index composite — not in v1 brainstorm inventory.'],
  ['economic:eu-gas-storage:v1',
    'deferred: per-country EU gas storage aggregate; energy:gas-storage:v1:_countries (canonical per-country breakdown) is already exposed via get_energy_intelligence.'],
  ['economic:crude-inventories:v1',
    'deferred to a future expanded energy tool. EIA weekly crude inventories sibling of energy:eia-petroleum:v1 (already exposed via get_energy_intelligence as the petroleum-stocks aggregate).'],
  ['economic:nat-gas-storage:v1',
    'deferred to a future expanded energy tool. EIA weekly natural-gas storage; complement to energy:gas-storage:v1:_countries (GIE) already exposed via get_energy_intelligence.'],
  ['economic:refinery-inputs:v1',
    'deferred to a future expanded energy tool. EIA weekly refinery inputs — petroleum domain, complement to energy:eia-petroleum:v1.'],
  ['economic:spr:v1',
    'deferred to a future expanded energy tool. EIA SPR weekly volumes — companion to energy:spr-policies:v1 (also deferred).'],
  ['economic:stress-index:v1',
    'deferred: derived economic stress composite; underlying inputs already exposed via get_economic_data. A future composite-narrative tool would bundle this.'],
  ['economic:fred:v1:GSCPI:0',
    'deferred: NY Fed Global Supply Chain Pressure Index (single FRED series); supply-chain pressure already broadly covered via get_supply_chain_data + get_chokepoint_status. Future composite supply-chain tool could expose this.'],
  ['economic:fred:v1:ESTR:0',
    'deferred: ECB €STR short-rate (single FRED series). Future expanded rates tool. Fed Funds (economic:fred:v1:FEDFUNDS:0) already exposed via get_economic_data.'],
  ['economic:fred:v1:EURIBOR3M:0',
    'deferred: EURIBOR 3-month rate (single FRED series). Future expanded rates tool.'],
  ['economic:fred:v1:EURIBOR6M:0',
    'deferred: EURIBOR 6-month rate (single FRED series). Future expanded rates tool.'],
  ['economic:fred:v1:EURIBOR1Y:0',
    'deferred: EURIBOR 1-year rate (single FRED series). Future expanded rates tool.'],
  ['health:vpd-tracker:realtime:v1',
    'deferred: vaccine-preventable disease tracker (realtime); covered partially by disease-outbreaks already in get_health_signals. Future expanded health tool would bundle the VPD-specific series.'],
  ['health:vpd-tracker:historical:v1',
    'deferred: vaccine-preventable disease tracker (historical); pair with health:vpd-tracker:realtime:v1.'],
  ['market:hyperliquid:flow:v1',
    'deferred to a future expanded crypto/DEX tool. Hyperliquid flow is a single-venue signal; broader crypto coverage via market:crypto:v1 (in get_market_data).'],
  ['market:stablecoins:v1',
    'deferred to a future expanded crypto tool. Stablecoin issuance is a specialised slice on top of market:crypto:v1 (already exposed via get_market_data).'],
  ['market:defi-tokens:v1',
    'deferred to a future expanded crypto tool. Shared seed-meta (seed-meta:market:token-panels) with ai-tokens + other-tokens.'],
  ['market:ai-tokens:v1',
    'deferred to a future expanded crypto tool. Shared seed-meta (seed-meta:market:token-panels) with defi-tokens + other-tokens.'],
  ['market:other-tokens:v1',
    'deferred to a future expanded crypto tool. Shared seed-meta (seed-meta:market:token-panels) with defi-tokens + ai-tokens.'],
  ['market:gold-extended:v1',
    'deferred to a future expanded commodities tool. Headline gold futures (GC=F) already exposed via get_market_data (market:commodities-bootstrap:v1).'],
  ['market:gold-etf-flows:v1',
    'deferred to a future expanded commodities tool. SPDR GLD flows; complement to market:gold-extended:v1.'],
  ['market:gold-cb-reserves:v1',
    'deferred to a future expanded commodities tool. IMF IFS monthly central-bank gold reserves.'],
  ['market:breadth-history:v1',
    'deferred to a future expanded markets tool. Equity breadth history is a specialised slice on top of market:sectors:v2 (already exposed via get_market_data).'],
  ['market:aaii-sentiment:v1',
    'deferred to a future expanded markets tool. AAII sentiment survey is a specialised weekly signal.'],
  ['market:crypto-sectors:v1',
    'deferred to a future expanded crypto tool. Sector-level crypto signal on top of market:crypto:v1.'],
  ['cf:radar:ddos:v1',
    'deferred to a future internet-health/cyber tool. Cloudflare Radar DDoS data — complement to infra:outages:v1 (already exposed via get_infrastructure_status).'],
  ['cf:radar:traffic-anomalies:v1',
    'deferred to a future internet-health/cyber tool. Cloudflare Radar traffic-anomaly data — complement to infra:outages:v1.'],
  ['correlation:cards-bootstrap:v1',
    'deferred: derived market-correlation card deck used by the dashboard; underlying inputs (market:sectors:v2 etc.) already exposed via get_market_data. A future correlation-analysis tool would expose this.'],
  ['energy:iea-oil-stocks:v1:index',
    'deferred to a future expanded energy tool. IEA OECD oil-stocks index — companion to energy:eia-petroleum:v1 (US weekly petroleum stocks already exposed via get_energy_intelligence). Monthly IEA cadence vs weekly EIA — distinct release.'],
  ['energy:intelligence:feed:v1',
    'deferred: derived energy-intelligence narrative feed (LLM-generated); underlying energy inputs already exposed via get_energy_intelligence. A future LLM-narrative tool would expose this.'],
  ['cable-health-v1',
    'deferred to a future maritime-infrastructure tool. Subsea cable disruption tracker — not in v1 brainstorm inventory.'],

  // ---- Energy supplementary keys not bundled into get_energy_intelligence ----
  // get_energy_intelligence covers the 9 headline keys (EIA petroleum,
  // electricity prices, Ember, gas storage, fuel shortages, disruptions,
  // crisis policies, fossil/renewable shares). The keys below are
  // specialised/per-country/infrastructure-registry slices on top of those —
  // deferred to a future expanded energy tool, not legitimate exclusions
  // (could be a follow-up tool).
  ['energy:spine:v1:_countries',
    'deferred: per-country energy spine index; covered indirectly via get_energy_intelligence headline aggregates. Future expanded per-country energy tool would expose this.'],
  ['energy:exposure:v1:index',
    'deferred: OWID energy-mix exposure index; get_energy_intelligence covers the headline energy bundle. Future detailed energy-mix tool would expose this.'],
  ['energy:mix:v1:_all',
    'deferred: OWID energy-mix full panel; future detailed energy-mix tool would expose this.'],
  ['energy:oil-stocks-analysis:v1',
    'deferred: LLM-generated narrative on top of energy:iea-oil-stocks:v1:index; future LLM-narrative tool would expose this.'],
  ['energy:jodi-gas:v1:_countries',
    'deferred: JODI per-country gas breakdown; future per-country energy tool.'],
  ['energy:lng-vulnerability:v1',
    'deferred: LNG vulnerability composite; future LNG-specific tool.'],
  ['energy:jodi-oil:v1:_countries',
    'deferred: JODI per-country oil breakdown; future per-country energy tool.'],
  ['energy:spr-policies:v1',
    'deferred: SPR policy registry; future SPR/policy tool. Distinct from energy volumes in get_energy_intelligence.'],
  ['energy:pipelines:gas:v1',
    'deferred: gas pipeline registry; future infrastructure-focused energy tool.'],
  ['energy:pipelines:oil:v1',
    'deferred: oil pipeline registry; future infrastructure-focused energy tool.'],
  ['energy:storage-facilities:v1',
    'deferred: energy storage-facility registry; future infrastructure-focused energy tool.'],

  // ===========================================================================
  // Operational (visible via /api/health, not user-facing data)
  // ===========================================================================
  ['relay:heartbeat:chokepoint-flows',
    'operational: relay loop heartbeat — covered by /api/health, not a user-facing data slice for MCP.'],
  ['relay:heartbeat:climate-news',
    'operational: relay loop heartbeat — covered by /api/health, not a user-facing data slice for MCP.'],
]);

// -----------------------------------------------------------------------------
// Pure predicate helpers (no module-state coupling) — used by both the
// live-state assertions below and the meta-tests at the bottom of the file
// that verify these predicates actually fire on synthetic invalid inputs.
//
// Each helper takes inputs explicitly and returns the array of offending keys.
// An empty array means "nothing wrong"; a non-empty array means "fail the test
// and list these keys".
// -----------------------------------------------------------------------------

function collectSeededKeys(bootstrapKeys, standaloneKeys) {
  return new Set([
    ...Object.values(bootstrapKeys),
    ...Object.values(standaloneKeys),
  ]);
}

function collectCoveredKeys(toolRegistry) {
  const covered = new Set();
  for (const tool of toolRegistry) {
    if (Array.isArray(tool._cacheKeys)) {
      for (const k of tool._cacheKeys) covered.add(k);
    }
    if (Array.isArray(tool._coverageKeys)) {
      for (const k of tool._coverageKeys) covered.add(k);
    }
  }
  return covered;
}

/** Seeded keys that are neither covered nor excluded. */
function findUncoveredKeys({ seededKeys, coveredKeys, excludedMap }) {
  const uncovered = [];
  for (const key of seededKeys) {
    if (coveredKeys.has(key)) continue;
    if (excludedMap.has(key)) continue;
    uncovered.push(key);
  }
  return uncovered;
}

/** Excluded entries whose reason is missing / empty / non-string. */
function findEmptyReasonExclusions(excludedMap) {
  const offenders = [];
  for (const [key, reason] of excludedMap) {
    if (typeof reason !== 'string' || reason.trim().length === 0) offenders.push(key);
  }
  return offenders;
}

/** Excluded keys that are not actually in the seeded-key inventory. */
function findDeadExclusions({ excludedMap, seededKeys }) {
  const dead = [];
  for (const key of excludedMap.keys()) {
    if (!seededKeys.has(key)) dead.push(key);
  }
  return dead;
}

/** Excluded keys that ARE covered by a tool (mutually-exclusive contract). */
function findRedundantExclusions({ excludedMap, coveredKeys }) {
  const redundant = [];
  for (const key of excludedMap.keys()) {
    if (coveredKeys.has(key)) redundant.push(key);
  }
  return redundant;
}

describe('U7 — TOOL_REGISTRY ↔ BOOTSTRAP_KEYS+STANDALONE_KEYS parity', () => {
  it('every seeded cache key is covered by a tool or explicitly excluded', () => {
    const seededKeys = collectSeededKeys(BOOTSTRAP_KEYS, STANDALONE_KEYS);
    const coveredKeys = collectCoveredKeys(TOOL_REGISTRY);
    const uncovered = findUncoveredKeys({ seededKeys, coveredKeys, excludedMap: EXCLUDED_FROM_MCP });

    if (uncovered.length > 0) {
      const list = uncovered.map((k) => `  - ${k}`).join('\n');
      throw new Error(
        `${uncovered.length} seeded cache key(s) are not covered by any MCP tool and not in EXCLUDED_FROM_MCP:\n` +
        `${list}\n\n` +
        `Add the key(s) to a TOOL_REGISTRY entry (\`_cacheKeys\` for cache-tools, \`_coverageKeys\` ` +
        `for \`_execute\` hybrids) OR add to EXCLUDED_FROM_MCP in tests/mcp-bootstrap-parity.test.mjs ` +
        `with a documented reason.`
      );
    }
  });

  it('every EXCLUDED_FROM_MCP entry has a non-empty reason', () => {
    const offenders = findEmptyReasonExclusions(EXCLUDED_FROM_MCP);
    assert.deepEqual(offenders, [], `EXCLUDED_FROM_MCP entries with empty/missing reason: ${offenders.join(', ')}`);
  });

  it('every EXCLUDED_FROM_MCP entry is present in BOOTSTRAP_KEYS or STANDALONE_KEYS (no dead exclusions)', () => {
    const seededKeys = collectSeededKeys(BOOTSTRAP_KEYS, STANDALONE_KEYS);
    const dead = findDeadExclusions({ excludedMap: EXCLUDED_FROM_MCP, seededKeys });
    assert.deepEqual(dead, [], `Dead EXCLUDED_FROM_MCP entries (not in BOOTSTRAP_KEYS/STANDALONE_KEYS): ${dead.join(', ')}`);
  });

  it('EXCLUDED_FROM_MCP keys are not also covered by a tool (no redundant exclusions)', () => {
    const coveredKeys = collectCoveredKeys(TOOL_REGISTRY);
    const redundant = findRedundantExclusions({ excludedMap: EXCLUDED_FROM_MCP, coveredKeys });
    assert.deepEqual(redundant, [], `Redundant EXCLUDED_FROM_MCP entries (also covered by a tool): ${redundant.join(', ')}`);
  });
});

// -----------------------------------------------------------------------------
// Meta-tests — verify the predicate helpers above actually fire on synthetic
// invalid fixtures. Without these, a regression that makes a predicate a no-op
// (e.g. early return, predicate inversion, off-by-one filter) would ship
// undetected because the live-state assertions only fail when the real
// codebase is broken.
// -----------------------------------------------------------------------------

describe('U7 meta-tests — parity predicates fire on synthetic invalid inputs', () => {
  it('findUncoveredKeys returns the synthetic seeded key that is neither covered nor excluded', () => {
    const seededKeys = new Set(['ghost:key:v1', 'covered:key:v1', 'excluded:key:v1']);
    const coveredKeys = new Set(['covered:key:v1']);
    const excludedMap = new Map([['excluded:key:v1', 'documented reason']]);
    const uncovered = findUncoveredKeys({ seededKeys, coveredKeys, excludedMap });
    assert.deepEqual(uncovered, ['ghost:key:v1'], 'ghost:key:v1 must surface as uncovered');
  });

  it('findUncoveredKeys returns empty when every seeded key is covered or excluded', () => {
    const seededKeys = new Set(['a:v1', 'b:v1']);
    const coveredKeys = new Set(['a:v1']);
    const excludedMap = new Map([['b:v1', 'because']]);
    assert.deepEqual(findUncoveredKeys({ seededKeys, coveredKeys, excludedMap }), []);
  });

  it('findEmptyReasonExclusions catches empty-string and whitespace-only reasons', () => {
    const excludedMap = new Map([
      ['good:v1', 'documented reason'],
      ['empty:v1', ''],
      ['whitespace:v1', '   '],
      ['nullish:v1', null],
    ]);
    const offenders = findEmptyReasonExclusions(excludedMap);
    assert.deepEqual(offenders.sort(), ['empty:v1', 'nullish:v1', 'whitespace:v1']);
  });

  it('findDeadExclusions catches excluded keys absent from the seeded-key set', () => {
    const excludedMap = new Map([
      ['live:v1', 'reason'],
      ['ghost:v1', 'reason'],
    ]);
    const seededKeys = new Set(['live:v1']);
    assert.deepEqual(findDeadExclusions({ excludedMap, seededKeys }), ['ghost:v1']);
  });

  it('findRedundantExclusions catches keys that are both excluded AND covered by a tool', () => {
    const excludedMap = new Map([
      ['both:v1', 'reason'],
      ['only-excluded:v1', 'reason'],
    ]);
    const coveredKeys = new Set(['both:v1']);
    assert.deepEqual(findRedundantExclusions({ excludedMap, coveredKeys }), ['both:v1']);
  });

  it('collectCoveredKeys aggregates _cacheKeys + _coverageKeys across the registry', () => {
    const registry = [
      { name: 'cache_tool_a', _cacheKeys: ['a:v1', 'b:v1'] },
      { name: 'cache_tool_b', _cacheKeys: ['c:v1'] },
      { name: 'hybrid_tool', _coverageKeys: ['d:v1'], _execute: () => {} },
      { name: 'rpc_tool_no_cache', _execute: () => {} }, // no _cacheKeys, no _coverageKeys
    ];
    const covered = collectCoveredKeys(registry);
    assert.deepEqual([...covered].sort(), ['a:v1', 'b:v1', 'c:v1', 'd:v1']);
  });

  it('collectSeededKeys merges BOOTSTRAP and STANDALONE without duplicates', () => {
    const bootstrap = { alpha: 'a:v1', beta: 'b:v1' };
    const standalone = { gamma: 'c:v1', alphaAgain: 'a:v1' };
    const seeded = collectSeededKeys(bootstrap, standalone);
    assert.deepEqual([...seeded].sort(), ['a:v1', 'b:v1', 'c:v1']);
  });
});
