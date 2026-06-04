// Plan 2026-04-26-002 §U8 — methodology-doc parity test.
//
// Asserts that the load-bearing prose claims in
// docs/methodology/country-resilience-index.mdx match the actual
// constants the code ships with. Catches accidental doc drift when
// someone bumps a cache prefix, adds/removes a dimension, or changes
// a domain weight without updating the doc in lockstep — the
// alternative is finding out from a Pro user that the doc says v17
// when production runs v20.
//
// Coverage is intentionally surgical: we don't try to parse every
// table in the doc (markdownlint already handles structural drift,
// and the existing docs/methodology lint pass catches most of it).
// We assert the few facts that are most likely to silently rot:
//
// 1. Cache prefixes named in the changelog match `_shared.ts`.
// 2. The "6 domains × 20 active dimensions" claim matches
//    `RESILIENCE_DOMAIN_ORDER` and `RESILIENCE_DIMENSION_ORDER − retired`.
// 3. Each domain's weight in the Domains table matches
//    `getResilienceDomainWeight(...)`.
// 4. Macro-Fiscal sub-indicator rows/weights match `INDICATOR_REGISTRY`.
// 5. Generated Resilience OpenAPI prose still matches pillar weights
//    and score formula semantics.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  RESILIENCE_SCORE_CACHE_PREFIX,
  RESILIENCE_RANKING_CACHE_KEY,
  RESILIENCE_HISTORY_KEY_PREFIX,
  RESILIENCE_INTERVAL_KEY_PREFIX,
} from '../server/worldmonitor/resilience/v1/_shared.ts';
import {
  RESILIENCE_DIMENSION_ORDER,
  RESILIENCE_DIMENSION_DOMAINS,
  RESILIENCE_DOMAIN_ORDER,
  RESILIENCE_RETIRED_DIMENSIONS,
  type ResilienceDomainId,
  type ResilienceDimensionId,
  getResilienceDomainWeight,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';
import {
  PILLAR_ORDER,
  PILLAR_WEIGHTS,
} from '../server/worldmonitor/resilience/v1/_pillar-membership.ts';
import {
  INDICATOR_REGISTRY,
} from '../server/worldmonitor/resilience/v1/_indicator-registry.ts';
import {
  MACRO_FISCAL_INDICATOR_WEIGHTS,
} from '../server/worldmonitor/resilience/v1/_macro-fiscal-weights.ts';
import {
  RANKABLE_UNIVERSE_SIZE,
} from '../server/worldmonitor/resilience/v1/_rankable-universe.ts';
import {
  SCORER_DOC_PARITY_NON_LINEAR_IDS,
  SCORER_DOC_PARITY_SPECS,
  SCORER_DOC_PARITY_UNSUPPORTED_DIMENSIONS,
  STATIC_SCORER_CATALOG_PARITY_IDS,
  extractLinearNormalizerForTest,
  scorerDocParitySpecsBySection,
} from './helpers/resilience-scorer-doc-parity-specs.mts';

const here = dirname(fileURLToPath(import.meta.url));
const DOC_PATH = resolve(here, '../docs/methodology/country-resilience-index.mdx');
const INDICATOR_SOURCE_CATALOG_PATH = resolve(here, '../docs/methodology/indicator-sources.yaml');
const DOCUMENTATION_PATH = resolve(here, '../docs/documentation.mdx');
const FEATURES_PATH = resolve(here, '../docs/features.mdx');
const STATIC_SEED_SCRIPT_PATH = resolve(here, '../scripts/seed-resilience-static.mjs');
const HEALTH_API_PATH = resolve(here, '../api/health.js');
const RESILIENCE_OPENAPI_YAML_PATH = resolve(here, '../docs/api/ResilienceService.openapi.yaml');
const RESILIENCE_OPENAPI_JSON_PATH = resolve(here, '../docs/api/ResilienceService.openapi.json');
const BUNDLED_OPENAPI_YAML_PATH = resolve(here, '../docs/api/worldmonitor.openapi.yaml');
const docText = readFileSync(DOC_PATH, 'utf8');
const indicatorSourceCatalogText = readFileSync(INDICATOR_SOURCE_CATALOG_PATH, 'utf8');
const staticSeedScriptText = readFileSync(STATIC_SEED_SCRIPT_PATH, 'utf8');
const healthApiText = readFileSync(HEALTH_API_PATH, 'utf8');
const CURRENT_DIMENSION_COUNT_SURFACES = [
  { label: 'methodology doc', path: DOC_PATH, text: docText },
  {
    label: 'documentation intro',
    path: DOCUMENTATION_PATH,
    text: readFileSync(DOCUMENTATION_PATH, 'utf8'),
  },
  {
    label: 'features page',
    path: FEATURES_PATH,
    text: readFileSync(FEATURES_PATH, 'utf8'),
  },
];
const GENERATED_OPENAPI_SURFACES = [
  {
    label: 'ResilienceService OpenAPI YAML',
    path: RESILIENCE_OPENAPI_YAML_PATH,
    text: readFileSync(RESILIENCE_OPENAPI_YAML_PATH, 'utf8'),
  },
  {
    label: 'ResilienceService OpenAPI JSON',
    path: RESILIENCE_OPENAPI_JSON_PATH,
    text: readFileSync(RESILIENCE_OPENAPI_JSON_PATH, 'utf8'),
  },
  {
    label: 'bundled OpenAPI YAML',
    path: BUNDLED_OPENAPI_YAML_PATH,
    text: readFileSync(BUNDLED_OPENAPI_YAML_PATH, 'utf8'),
  },
];
const ACTIVE_ENERGY_V2_INDICATOR_WEIGHTS = new Map([
  ['importedFossilDependence', 0.35],
  ['lowCarbonGenerationShare', 0.20],
  ['powerLossesPct', 0.20],
  ['euGasStorageStress', 0.10],
  ['energyPriceStress', 0.15],
]);
const SCORER_TABLE_PARITY_SPECS = scorerDocParitySpecsBySection();
const LEGACY_ONLY_ENERGY_INDICATORS = new Set([
  'energyImportDependency',
  'gasShare',
  'coalShare',
  'renewShare',
  'electricityConsumption',
]);
const DIMENSION_LABELS: Readonly<Record<ResilienceDimensionId, string>> = {
  macroFiscal: 'Macro-Fiscal',
  currencyExternal: 'Currency & External',
  tradePolicy: 'Trade Policy',
  financialSystemExposure: 'Financial System Exposure',
  cyberDigital: 'Cyber & Digital',
  logisticsSupply: 'Logistics & Supply',
  infrastructure: 'Infrastructure',
  energy: 'Energy',
  governanceInstitutional: 'Governance',
  socialCohesion: 'Social Cohesion',
  borderSecurity: 'Conflict & Displacement',
  informationCognitive: 'Information',
  healthPublicService: 'Health & Public Service',
  foodWater: 'Food & Water',
  fiscalSpace: 'Fiscal Space',
  reserveAdequacy: 'Reserve Adequacy',
  externalDebtCoverage: 'External Debt Coverage',
  importConcentration: 'Import Concentration',
  stateContinuity: 'State Continuity',
  fuelStockDays: 'Fuel Stock Days',
  liquidReserveAdequacy: 'Liquid Reserve Adequacy',
  sovereignFiscalBuffer: 'Sovereign Fiscal Buffer',
};

interface MethodologyIndicatorSpec {
  id: string;
  direction: string;
  goalposts: string;
  weight: number;
}

interface MethodologyIndicatorRow extends MethodologyIndicatorSpec {
  description: string;
  source: string;
  cadence: string;
}

describe('methodology doc parity (Plan 2026-04-26-002 §U8)', () => {
  it('cache prefixes named in the changelog match the live constants', () => {
    // The v17 changelog narrates the bumps. We don't require every
    // historical version to appear in the doc, only that the CURRENT
    // value in `_shared.ts` is somewhere in the doc text.
    const scoreVersion = RESILIENCE_SCORE_CACHE_PREFIX;       // e.g. 'resilience:score:v17:'
    const rankingKey = RESILIENCE_RANKING_CACHE_KEY;          // e.g. 'resilience:ranking:v17'
    const historyPrefix = RESILIENCE_HISTORY_KEY_PREFIX;      // e.g. 'resilience:history:v12:'
    const intervalPrefix = RESILIENCE_INTERVAL_KEY_PREFIX;    // e.g. 'resilience:intervals:v4:'

    assert.ok(
      docText.includes(scoreVersion.replace(/:$/, '')) || docText.includes(scoreVersion),
      `methodology doc must reference current score cache prefix "${scoreVersion}". ` +
      'Bump the doc when bumping the cache.',
    );
    assert.ok(
      docText.includes(rankingKey),
      `methodology doc must reference current ranking cache key "${rankingKey}". ` +
      'Bump the doc when bumping the cache.',
    );
    assert.ok(
      docText.includes(historyPrefix.replace(/:$/, '')) || docText.includes(historyPrefix),
      `methodology doc must reference current history key prefix "${historyPrefix}". ` +
      'Bump the doc when bumping the cache.',
    );
    assert.ok(
      docText.includes(intervalPrefix.replace(/:$/, '')) || docText.includes(intervalPrefix),
      `methodology doc must reference current interval key prefix "${intervalPrefix}". ` +
      'Bump the doc when bumping the interval cache.',
    );
  });

  it('domain count claimed in prose matches RESILIENCE_DOMAIN_ORDER', () => {
    const expectedCount = RESILIENCE_DOMAIN_ORDER.length;
    // The doc says "6 domains" in multiple places. We require at least
    // one mention of the current count to stop a future "we now have 7
    // domains" code change from leaving the doc claiming 6.
    const re = new RegExp(`${expectedCount}\\s+domains?`);
    assert.ok(
      re.test(docText),
      `methodology doc must mention "${expectedCount} domains" (current RESILIENCE_DOMAIN_ORDER length). ` +
      'If you added/removed a domain, update the prose.',
    );
  });

  it('active dimension count claimed in prose matches (ORDER − RETIRED) AND no stale counts persist', () => {
    // The doc says "20 active dimensions" — i.e. ACTIVE dimensions,
    // excluding structurally-retired ones (fuelStockDays,
    // reserveAdequacy) that remain in RESILIENCE_DIMENSION_ORDER for
    // schema continuity but pin at coverage=0 / imputationClass=null.
    // The right denominator for the doc's headline claim is
    // (total − retired).
    const activeCount = RESILIENCE_DIMENSION_ORDER.length - RESILIENCE_RETIRED_DIMENSIONS.size;
    // Allow "20 dimensions" or "20 active dimensions" — both mean the same thing.
    const re = new RegExp(`${activeCount}\\s+(?:active\\s+)?dimensions?`);
    assert.ok(
      re.test(docText),
      `methodology doc must mention "${activeCount} dimensions" or "${activeCount} active dimensions" (RESILIENCE_DIMENSION_ORDER ${RESILIENCE_DIMENSION_ORDER.length} minus RESILIENCE_RETIRED_DIMENSIONS ${RESILIENCE_RETIRED_DIMENSIONS.size}). ` +
      'If you added/removed/retired a dimension, update the prose.',
    );

    // Tighten: stale CURRENT-total claims in older changelog narrative
    // contradict the live count and confuse readers. The previous
    // version of this test allowed any mention of "20 dimensions" to
    // pass even if a contradictory stale dimension count still appeared in
    // older prose. Now reject any mention in the plausible-current-
    // total band [15, 25] that doesn't equal activeCount or totalCount.
    // Numbers outside that band (5, 6, 13) are legitimate sub-pillar /
    // historical-version mentions and stay untouched.
    const totalCount = RESILIENCE_DIMENSION_ORDER.length;
    const PLAUSIBLE_CURRENT_TOTAL_MIN = 15;
    const PLAUSIBLE_CURRENT_TOTAL_MAX = 25;
    const dimensionMentions = [...docText.matchAll(/(\d+)\s+(?:active\s+)?dimensions?/g)];
    const stale = dimensionMentions
      .map((m) => Number(m[1]))
      .filter((n) =>
        n !== activeCount &&
        n !== totalCount &&
        n >= PLAUSIBLE_CURRENT_TOTAL_MIN &&
        n <= PLAUSIBLE_CURRENT_TOTAL_MAX,
      );
    assert.deepEqual(stale, [],
      `methodology doc contains plausible-current-total dimension counts that contradict the live count: ${stale.join(', ')}. ` +
      `Current active count is ${activeCount} (or total ${totalCount} if including retired). ` +
      'Update stale claims, or move to historical-state phrasing if they describe a past version.',
    );
  });

  it('current public CRI surfaces claim the live active dimension count', () => {
    const activeCount = RESILIENCE_DIMENSION_ORDER.length - RESILIENCE_RETIRED_DIMENSIONS.size;
    const totalCount = RESILIENCE_DIMENSION_ORDER.length;
    const activeRe = new RegExp(`${activeCount}\\s+(?:active\\s+)?dimensions?`);

    for (const surface of CURRENT_DIMENSION_COUNT_SURFACES) {
      assert.ok(
        activeRe.test(surface.text),
        `${surface.label} (${surface.path}) must mention "${activeCount} dimensions" or ` +
          `"${activeCount} active dimensions" for the current Country Resilience Index.`,
      );

      const stale = findPlausibleCurrentTotalDimensionCounts(surface.text, activeCount, totalCount);
      assert.deepEqual(
        stale,
        [],
        `${surface.label} (${surface.path}) contains plausible-current-total dimension counts that ` +
          `contradict the live count: ${stale.join(', ')}. Current active count is ${activeCount} ` +
          `(or total ${totalCount} if explicitly including retired dimensions).`,
      );
    }
  });

  it('current public CRI surfaces distinguish the rankable universe from stale broad country-count copy', () => {
    const expectedUniverseRe = new RegExp(
      `${RANKABLE_UNIVERSE_SIZE}(?:-country public rankable universe|\\s+countries?\\s+in\\s+the\\s+public\\s+rankable\\s+universe)`,
      'i',
    );
    const stalePublicCountryCountPatterns = [
      /~\s*220[-\s]countries?/i,
      /scores\s+every\s+country\s+in\s+the\s+world/i,
      /\b\d+\s+countries?\s+with\s+\d+\s+in\s+`?greyedOut\[\]`?/i,
      /\b\d+\s+countries?\s+are\s+currently\s+in\s+`?greyedOut\[\]`?/i,
    ];

    for (const surface of CURRENT_DIMENSION_COUNT_SURFACES) {
      assert.ok(
        expectedUniverseRe.test(surface.text),
        `${surface.label} (${surface.path}) must mention the current ${RANKABLE_UNIVERSE_SIZE}-country public rankable universe.`,
      );

      for (const pattern of stalePublicCountryCountPatterns) {
        assert.equal(
          pattern.test(surface.text),
          false,
          `${surface.label} (${surface.path}) contains stale public CRI country-count copy matching ${pattern}.`,
        );
      }
    }
  });

  it('Domains table weights match getResilienceDomainWeight()', () => {
    // The Domains and Weights table has rows like:
    //   | Economic | `economic` | 0.17 | …
    // Parse each domain's row and assert the weight column matches code.
    for (const domainId of RESILIENCE_DOMAIN_ORDER) {
      const expectedWeight = getResilienceDomainWeight(domainId);
      // Find the row containing the domain id in backticks. The numeric
      // weight is the third pipe-separated cell after the id.
      const rowRe = new RegExp(`\\|[^\\n]*\\\`${escapeRegex(domainId)}\\\`[^\\n]*\\|\\s*([0-9.]+)\\s*\\|`);
      const match = docText.match(rowRe);
      assert.ok(
        match,
        `Domains table row for "${domainId}" not found. Expected a row with \`${domainId}\` and weight ${expectedWeight}.`,
      );
      const docWeight = Number(match![1]);
      assert.ok(
        Math.abs(docWeight - expectedWeight) < 0.001,
        `Domains table claims weight ${docWeight} for "${domainId}", code has ${expectedWeight}. ` +
        'Update the doc when changing RESILIENCE_DOMAIN_WEIGHTS.',
      );
    }
  });

  it('Recovery domain row lists active recovery dimensions and excludes retired dimensions', () => {
    const expectedActiveLabels = RESILIENCE_DIMENSION_ORDER
      .filter((id) => RESILIENCE_DIMENSION_DOMAINS[id] === 'recovery')
      .filter((id) => !RESILIENCE_RETIRED_DIMENSIONS.has(id))
      .map((id) => DIMENSION_LABELS[id]);
    const retiredLabels = RESILIENCE_DIMENSION_ORDER
      .filter((id) => RESILIENCE_DIMENSION_DOMAINS[id] === 'recovery')
      .filter((id) => RESILIENCE_RETIRED_DIMENSIONS.has(id))
      .map((id) => DIMENSION_LABELS[id]);
    const actualLabels = extractDomainRowDimensionLabels(docText, 'recovery');

    assert.deepEqual(
      actualLabels,
      expectedActiveLabels,
      'Recovery row in the active Domains table must list exactly the active recovery dimensions in scorer order.',
    );
    for (const label of retiredLabels) {
      assert.ok(
        !actualLabels.includes(label),
        `Recovery row in the active Domains table must not list retired dimension "${label}".`,
      );
    }
  });

  it('Domains table weights sum to 1.00 (sanity check on the parity test itself)', () => {
    // If the parity assertion above ever silently passes 0 / 0, this
    // catches it: the live weights MUST sum to 1.00 by construction.
    const sum = RESILIENCE_DOMAIN_ORDER
      .map((id: ResilienceDomainId) => getResilienceDomainWeight(id))
      .reduce((a, b) => a + b, 0);
    assert.ok(
      Math.abs(sum - 1.0) < 0.001,
      `Domain weights must sum to 1.00, got ${sum.toFixed(4)}. The parity test above is built on this invariant.`,
    );
  });

  it('Macro-Fiscal sub-indicator table matches live indicator weights', () => {
    const expected = new Map(
      Object.entries(MACRO_FISCAL_INDICATOR_WEIGHTS),
    );
    const registryWeights = new Map(
      INDICATOR_REGISTRY
        .filter((indicator) => indicator.dimension === 'macroFiscal')
        .map((indicator) => [indicator.id, indicator.weight]),
    );
    const actual = extractIndicatorWeightsForSection(docText, 'Macro-Fiscal');

    assert.deepEqual(
      registryWeights,
      expected,
      'Macro-Fiscal INDICATOR_REGISTRY weights must match MACRO_FISCAL_INDICATOR_WEIGHTS used by the scorer.',
    );

    const weightSum = [...expected.values()].reduce((sum, weight) => sum + weight, 0);
    assert.ok(
      Math.abs(weightSum - 1.0) < 0.001,
      `Macro-Fiscal indicator weights must sum to 1.00, got ${weightSum.toFixed(4)}.`,
    );

    assert.deepEqual(
      [...actual.keys()],
      [...registryWeights.keys()],
      'Macro-Fiscal methodology table must list exactly the live macroFiscal indicators in registry order.',
    );

    for (const [indicatorId, expectedWeight] of expected) {
      const actualWeight = actual.get(indicatorId);
      assert.equal(
        actualWeight,
        expectedWeight,
        `Macro-Fiscal methodology table claims weight ${actualWeight} for ${indicatorId}; ` +
          `INDICATOR_REGISTRY has ${expectedWeight}.`,
      );
    }
  });

  it('Currency & External inflationStability row documents target-band scoring, not lower-is-better scoring', () => {
    const row = extractIndicatorRowForSection(docText, 'Currency & External', 'inflationStability');

    assert.equal(
      row.direction,
      '1-3% target band is best',
      'inflationStability direction must document the scoreInflationStability target band.',
    );
    assert.equal(
      row.goalposts,
      '<= -5 or >= 50 -> 0; 1-3 -> 100',
      'inflationStability goalposts must document the deflation floor, target band, and high-inflation cap.',
    );
    assert.notEqual(
      row.direction,
      'Lower is better',
      'inflationStability must not regress to stale lower-is-better wording.',
    );
    assert.notEqual(
      row.goalposts,
      '50 - 0',
      'inflationStability must not regress to stale linear 50-to-0 goalposts.',
    );
  });

  it('Financial System Exposure bisLbsXborderPctGdp row matches registry U-shape goalpost anchors', () => {
    const row = extractIndicatorRowForSection(docText, 'Financial System Exposure', 'bisLbsXborderPctGdp');
    const spec = INDICATOR_REGISTRY.find((indicator) => indicator.id === 'bisLbsXborderPctGdp');
    assert.ok(spec, 'bisLbsXborderPctGdp must exist in INDICATOR_REGISTRY.');

    assert.equal(
      row.goalposts,
      `${spec.goalposts.worst} - ${spec.goalposts.best}`,
      'bisLbsXborderPctGdp methodology goalposts must mirror INDICATOR_REGISTRY U-shape documentation anchors.',
    );
    assert.equal(
      row.direction,
      'Lower is better (U-shape)',
      'bisLbsXborderPctGdp direction must keep the U-shape caveat visible in the methodology table.',
    );
  });

  it('Energy v2 methodology table matches active production registry weights', () => {
    const tableWeights = extractIndicatorWeightsForMarkedTable(
      docText,
      'Energy',
      '**v2 construct (active; framing decision: Option B, power-system security).**',
    );
    const registryWeights = new Map(
      INDICATOR_REGISTRY
        .filter((indicator) => ACTIVE_ENERGY_V2_INDICATOR_WEIGHTS.has(indicator.id))
        .map((indicator) => [indicator.id, indicator.weight]),
    );

    assert.deepEqual(
      [...tableWeights.keys()],
      [...ACTIVE_ENERGY_V2_INDICATOR_WEIGHTS.keys()],
      'Energy v2 methodology table must list exactly the active production energy-v2 indicators.',
    );
    assert.deepEqual(
      registryWeights,
      ACTIVE_ENERGY_V2_INDICATOR_WEIGHTS,
      'Energy v2 INDICATOR_REGISTRY weights must mirror scoreEnergyV2 active production weights.',
    );
    assert.deepEqual(
      tableWeights,
      ACTIVE_ENERGY_V2_INDICATOR_WEIGHTS,
      'Energy v2 methodology table weights must match the active production registry/scorer weights.',
    );
    for (const id of LEGACY_ONLY_ENERGY_INDICATORS) {
      assert.equal(
        tableWeights.has(id),
        false,
        `${id} is legacy-only under production energy v2 and must not appear in the active v2 table.`,
      );
    }
  });

  it('affected methodology indicator tables match live scorer specs', () => {
    for (const [section, expectedRows] of SCORER_TABLE_PARITY_SPECS) {
      const actualRows = extractIndicatorRowsForSection(docText, section);
      const expectedIds = expectedRows.map((row) => row.id);
      const actualIds = actualRows.map((row) => row.id);
      assert.deepEqual(
        actualIds,
        expectedIds,
        `${section} methodology table must list exactly the indicators used by the current scorer, in scorer order.`,
      );

      for (const expected of expectedRows) {
        const actual = actualRows.find((row) => row.id === expected.id);
        assert.ok(actual, `${section} methodology table row for ${expected.id} not found.`);
        assert.equal(
          actual.direction,
          expected.methodologyDirection,
          `${section}.${expected.id} direction must match scorer semantics.`,
        );
        assert.equal(
          actual.goalposts,
          expected.methodologyGoalposts,
          `${section}.${expected.id} goalposts must match scorer normalizeHigherBetter/normalizeLowerBetter anchors.`,
        );
        assert.equal(
          actual.weight,
          expected.weight,
          `${section}.${expected.id} weight must match the current weightedBlend input.`,
        );
      }
    }
  });

  it('scorer doc parity coverage is source-derived or explicitly allowlisted', () => {
    const coveredDimensions = [...new Set(SCORER_DOC_PARITY_SPECS.map((spec) => spec.dimension))].sort();
    assert.deepEqual(
      coveredDimensions,
      [
        'borderSecurity',
        'currencyExternal',
        'cyberDigital',
        'externalDebtCoverage',
        'financialSystemExposure',
        'fiscalSpace',
        'healthPublicService',
        'importConcentration',
        'informationCognitive',
        'infrastructure',
        'liquidReserveAdequacy',
        'macroFiscal',
        'sovereignFiscalBuffer',
        'stateContinuity',
        'tradePolicy',
      ].sort(),
      'Parity coverage changed. Add source extraction for new dimensions where practical, or update the unsupported allowlist with a rationale.',
    );
    assert.deepEqual(
      [...SCORER_DOC_PARITY_UNSUPPORTED_DIMENSIONS].sort(),
      [
        'energy',
        'foodWater',
        'fuelStockDays',
        'governanceInstitutional',
        'logisticsSupply',
        'reserveAdequacy',
        'socialCohesion',
      ].sort(),
      'Unsupported scorer dimensions must be explicit so skipped parity coverage cannot drift silently.',
    );
    assert.equal(
      SCORER_DOC_PARITY_SPECS.filter((spec) => spec.extraction === 'scorer-source' || spec.extraction === 'custom-source').length,
      39,
      'Expected 39 scorer/doc parity rows to derive weights from scorer source or a custom scorer-source extractor.',
    );
    assert.deepEqual(
      SCORER_DOC_PARITY_SPECS
        .filter((spec) => spec.extraction === 'non-linear-allowlist')
        .map((spec) => spec.id),
      [...SCORER_DOC_PARITY_NON_LINEAR_IDS].filter((id) => id !== 'inflationStability'),
      'Non-linear scorer rows in weightedBlend tables must be explicitly allowlisted.',
    );
  });

  it('source-derived scorer specs pin representative anchor and weight drift', () => {
    const broadband = SCORER_DOC_PARITY_SPECS.find((spec) => spec.id === 'broadband');
    assert.ok(broadband, 'broadband must be covered by scorer/doc parity specs.');
    assert.equal(
      broadband.extraction,
      'scorer-source',
      'broadband parity must be extracted from scoreInfrastructure, not copied into helper constants.',
    );
    assert.equal(
      broadband.weight,
      0.15,
      'Changing scoreInfrastructure broadband weight now changes the generated spec and breaks doc/registry parity unless those surfaces move too.',
    );
    assert.deepEqual(
      broadband.registryGoalposts,
      { worst: 0, best: 40 },
      'Changing scoreInfrastructure broadband anchors now changes the generated spec and breaks doc/registry parity unless those surfaces move too.',
    );
  });

  it('source extraction rejects mixed linear normalizers instead of guessing direction', () => {
    assert.throws(
      () => extractLinearNormalizerForTest(
        'flag ? normalizeHigherBetter(value, 0, 100) : normalizeLowerBetter(value, 80, 20)',
        'syntheticConditionalNormalizer',
      ),
      /mixes normalizeHigherBetter and normalizeLowerBetter/,
      'A scorer entry with both linear normalizers must fail loudly so helper extraction cannot silently choose higher-better.',
    );
  });

  it('trend enum prose matches the response enum', () => {
    assert.match(
      docText,
      /Direction of score movement over the last 30 days \(`rising`, `stable`, or `falling`\)/,
      'Methodology trend prose must document the live rising/stable/falling enum.',
    );
    assert.doesNotMatch(
      docText,
      /`improving`, `stable`, or `declining`/,
      'Methodology trend prose must not preserve the stale improving/stable/declining enum.',
    );
  });

  it('Social Cohesion GPI-only unrest prose documents the non-comprehensive source fallback', () => {
    const sectionText = extractSectionText(docText, 'Social Cohesion');
    assert.match(
      sectionText,
      /zero unrest events\s+fall back to `curated_list_absent` at 50\/coverage 0\.3 \(`unmonitored`\)/,
      'Social Cohesion prose must document the live curated_list_absent fallback for GPI-only zero-unrest rows.',
    );
    assert.doesNotMatch(
      sectionText,
      /zero unrest events\s+(?:are\s+)?imputed at 70\/coverage 0\.5/,
      'Social Cohesion prose must not preserve the stale stable-absence 70/0.5 unrest fallback.',
    );
  });

  it('indicator source catalog labels energy-v2 rows as active and legacy-only rows as replaced', () => {
    for (const id of ACTIVE_ENERGY_V2_INDICATOR_WEIGHTS.keys()) {
      const block = extractIndicatorSourceBlock(indicatorSourceCatalogText, id);
      assert.match(
        block,
        /reviewNotes: Active energy-v2 (?:Core|Enrichment) scorer input\./,
        `${id} source-catalog row must identify it as an active energy-v2 scorer input.`,
      );
      const registrySpec = INDICATOR_REGISTRY.find((indicator) => indicator.id === id);
      assert.ok(registrySpec, `${id} must exist in INDICATOR_REGISTRY.`);
      if (registrySpec.tier === 'core') {
        const coveragePct = Number(extractIndicatorSourceScalar(block, 'coveragePct'));
        const license = extractIndicatorSourceScalar(block, 'license').toLowerCase();
        assert.ok(
          coveragePct >= 0.90,
          `${id} is active Core in the registry, so indicator-sources.yaml coveragePct must be >= 0.90; got ${coveragePct}.`,
        );
        assert.notEqual(
          license,
          'internal',
          `${id} is active Core in the registry, so indicator-sources.yaml must not leave license=Internal.`,
        );
      }
    }

    for (const id of LEGACY_ONLY_ENERGY_INDICATORS) {
      const catalogId = id === 'energyImportDependency' ? 'dependency' : id;
      const block = extractIndicatorSourceBlock(indicatorSourceCatalogText, catalogId);
      assert.match(
        block,
        /reviewNotes: PR 1 §3\.[123] (?:removes|replaces|collapses)/,
        `${id} source-catalog row must remain explicit that the standalone legacy input is replaced under energy v2.`,
      );
    }
    assert.doesNotMatch(
      indicatorSourceCatalogText,
      /PR 1 additions \(not yet in the scorer\)/,
      'indicator source catalog must not describe active energy-v2 inputs as pending/not yet in the scorer.',
    );
  });

  it('indicator source catalog covers newly registered static scorer inputs', () => {
    for (const id of STATIC_SCORER_CATALOG_PARITY_IDS) {
      const block = extractIndicatorSourceBlock(indicatorSourceCatalogText, id);
      const registrySpec = INDICATOR_REGISTRY.find((indicator) => indicator.id === id);
      assert.ok(registrySpec, `${id} must exist in INDICATOR_REGISTRY.`);

      assert.equal(
        extractIndicatorSourceScalar(block, 'dimension'),
        registrySpec.dimension,
        `${id} source-catalog dimension must match INDICATOR_REGISTRY.`,
      );
      assert.equal(
        Number(extractIndicatorSourceScalar(block, 'weight')),
        registrySpec.weight,
        `${id} source-catalog weight must match INDICATOR_REGISTRY.`,
      );
      assert.ok(
        Number(extractIndicatorSourceScalar(block, 'coveragePct')) >= 0.90,
        `${id} is active Core in the registry, so indicator-sources.yaml coveragePct must be >= 0.90.`,
      );
      assert.notEqual(
        extractIndicatorSourceScalar(block, 'license'),
        'internal',
        `${id} is active Core in the registry, so indicator-sources.yaml license must not be internal.`,
      );
      assert.match(
        block,
        /reviewNotes: Active (?:infrastructure|healthPublicService) Core scorer input\./,
        `${id} source-catalog row must identify it as an active Core scorer input.`,
      );
    }

    assert.doesNotMatch(
      indicatorSourceCatalogText,
      /- indicator: whoHealthExpenditure\n/,
      'stale whoHealthExpenditure catalog alias must not obscure the active healthExpPerCapitaUsd scorer id.',
    );
  });

  it('generated OpenAPI pillar weight prose matches PILLAR_WEIGHTS and formula semantics', () => {
    const expectedWeightList = PILLAR_ORDER
      .map((id) => PILLAR_WEIGHTS[id].toFixed(2))
      .join(' / ');
    const expectedWeightDescription =
      `Pillar weight in the pillar-combined score. Per the plan: ${expectedWeightList}.`;
    const expectedScoreDescription =
      'Pillar score in [0, 100], mean of member domains weighted by ' +
      'domain.weight * average_dimension_coverage.';
    const expectedPillarIdDescription = PILLAR_ORDER.map((id) => `"${id}"`).join(' | ') + '.';

    for (const surface of GENERATED_OPENAPI_SURFACES) {
      const normalized = normalizeWhitespace(surface.text);
      assert.ok(
        normalized.includes(expectedWeightDescription),
        `${surface.label} (${surface.path}) must include current pillar weights ` +
          `"${expectedWeightList}" from PILLAR_WEIGHTS.`,
      );
      assert.ok(
        normalized.includes(expectedScoreDescription),
        `${surface.label} (${surface.path}) must describe pillar score aggregation as ` +
          '`domain.weight * average_dimension_coverage` so generated API docs stay in sync ' +
          'with buildPillarList().',
      );
      assert.ok(
        normalized.includes(expectedPillarIdDescription),
        `${surface.label} (${surface.path}) must list pillar ids in PILLAR_ORDER.`,
      );
    }
  });

  it('static resilience seed-meta TTL in Redis key table matches seed script and health threshold', () => {
    const ttlDays = extractStaticSeedTtlDays(staticSeedScriptText);
    const ttlMinutes = ttlDays * 24 * 60;
    const healthMaxStaleMinutes = extractStaticSeedHealthMaxStaleMinutes(healthApiText);
    const docTtl = extractRedisKeyTableTtl(docText, 'seed-meta:resilience:static');

    assert.equal(
      healthMaxStaleMinutes,
      ttlMinutes,
      `api/health.js maxStaleMin for seed-meta:resilience:static should match RESILIENCE_STATIC_TTL_SECONDS (${ttlMinutes} minutes / ${ttlDays} days).`,
    );
    assert.equal(
      docTtl,
      `${ttlDays} days`,
      `Redis key table must document seed-meta:resilience:static TTL as "${ttlDays} days"; got "${docTtl}".`,
    );
  });
});

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractIndicatorWeightsForSection(text: string, sectionHeading: string): Map<string, number> {
  const sectionText = extractSectionText(text, sectionHeading);

  const rows = [...sectionText.matchAll(/^\|\s*([^|\s][^|]*?)\s*\|(?:[^|]*\|){3}\s*([0-9.]+)\s*\|/gm)];
  const weights = new Map<string, number>();
  for (const row of rows) {
    const indicatorId = row[1].trim();
    if (indicatorId === 'Indicator' || indicatorId.startsWith('---')) continue;
    weights.set(indicatorId, Number(row[2]));
  }
  return weights;
}

function extractIndicatorRowsForSection(text: string, sectionHeading: string): MethodologyIndicatorRow[] {
  const sectionText = extractSectionText(text, sectionHeading);
  const rows: MethodologyIndicatorRow[] = [];

  for (const row of sectionText.split('\n')) {
    if (!row.startsWith('|')) continue;
    const cells = row
      .split('|')
      .map((cell) => decodeMarkdownEntityText(cell.trim()))
      .filter(Boolean);
    if (cells.length !== 7 || cells[0] === 'Indicator' || cells[0].startsWith('---')) continue;
    const weight = Number(cells[4]);
    assert.ok(Number.isFinite(weight), `Indicator row "${cells[0]}" in "${sectionHeading}" must have a numeric weight.`);
    rows.push({
      id: cells[0],
      description: cells[1],
      direction: cells[2],
      goalposts: cells[3],
      weight,
      source: cells[5],
      cadence: cells[6],
    });
  }

  return rows;
}

function extractSectionText(text: string, sectionHeading: string): string {
  const headingRe = new RegExp(`^#### ${escapeRegex(sectionHeading)}\\s*$`, 'm');
  const headingMatch = headingRe.exec(text);
  assert.ok(headingMatch, `Methodology section "${sectionHeading}" not found.`);

  const sectionStart = headingMatch.index + headingMatch[0].length;
  const rest = text.slice(sectionStart);
  const nextHeadingMatch = /^#{3,4}\s.+$/m.exec(rest);
  return nextHeadingMatch == null ? rest : rest.slice(0, nextHeadingMatch.index);
}

function extractIndicatorWeightsForMarkedTable(
  text: string,
  sectionHeading: string,
  marker: string,
): Map<string, number> {
  const headingRe = new RegExp(`^#### ${escapeRegex(sectionHeading)}\\s*$`, 'm');
  const headingMatch = headingRe.exec(text);
  assert.ok(headingMatch, `Methodology section "${sectionHeading}" not found.`);

  const sectionStart = headingMatch.index + headingMatch[0].length;
  const rest = text.slice(sectionStart);
  const nextHeadingMatch = /^#{3,4}\s.+$/m.exec(rest);
  const sectionText = nextHeadingMatch == null ? rest : rest.slice(0, nextHeadingMatch.index);
  const markerIndex = sectionText.indexOf(marker);
  assert.notEqual(markerIndex, -1, `Marker "${marker}" not found in section "${sectionHeading}".`);

  const afterMarker = sectionText.slice(markerIndex + marker.length);
  const rows = [...afterMarker.matchAll(/^\|\s*([^|\s][^|]*?)\s*\|(?:[^|]*\|){3}\s*([0-9.]+)\s*\|/gm)];
  const weights = new Map<string, number>();
  for (const row of rows) {
    const indicatorId = row[1].trim();
    if (indicatorId === 'Indicator' || indicatorId.startsWith('---')) continue;
    weights.set(indicatorId, Number(row[2]));
  }
  return weights;
}

function extractIndicatorSourceBlock(text: string, indicatorId: string): string {
  const blockRe = new RegExp(`^- indicator: ${escapeRegex(indicatorId)}\\n[\\s\\S]*?(?=\\n- indicator: |\\n# [A-Z]|\\n$)`, 'm');
  const match = blockRe.exec(text);
  assert.ok(match, `indicator-sources.yaml row for "${indicatorId}" not found.`);
  return match[0];
}

function extractIndicatorSourceScalar(block: string, field: string): string {
  const match = new RegExp(`^\\s*${escapeRegex(field)}:\\s*(.+)$`, 'm').exec(block);
  assert.ok(match, `indicator-sources.yaml field "${field}" not found in block:\n${block}`);
  return match[1].trim();
}

function extractIndicatorRowForSection(
  text: string,
  sectionHeading: string,
  indicatorId: string,
): { direction: string; goalposts: string } {
  const headingRe = new RegExp(`^#### ${escapeRegex(sectionHeading)}\\s*$`, 'm');
  const headingMatch = headingRe.exec(text);
  assert.ok(headingMatch, `Methodology section "${sectionHeading}" not found.`);

  const sectionStart = headingMatch.index + headingMatch[0].length;
  const rest = text.slice(sectionStart);
  const nextHeadingMatch = /^#{3,4}\s.+$/m.exec(rest);
  const sectionText = nextHeadingMatch == null ? rest : rest.slice(0, nextHeadingMatch.index);
  const rowRe = new RegExp(`^\\|\\s*${escapeRegex(indicatorId)}\\s*\\|([^\\n]+)\\|$`, 'm');
  const rowMatch = rowRe.exec(sectionText);
  assert.ok(rowMatch, `Indicator row "${indicatorId}" not found in section "${sectionHeading}".`);

  const cells = rowMatch[0]
    .split('|')
    .map((cell) => cell.trim())
    .filter(Boolean);
  assert.equal(cells.length, 7, `Indicator row "${indicatorId}" should have seven cells.`);
  return {
    direction: decodeMarkdownEntityText(cells[2]),
    goalposts: decodeMarkdownEntityText(cells[3]),
  };
}

function decodeMarkdownEntityText(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function extractDomainRowDimensionLabels(text: string, domainId: ResilienceDomainId): string[] {
  const rowRe = new RegExp(`^\\|[^\\n]*\\\`${escapeRegex(domainId)}\\\`[^\\n]*\\|$`, 'm');
  const match = rowRe.exec(text);
  assert.ok(match, `Domains table row for "${domainId}" not found.`);

  const cells = match[0]
    .split('|')
    .map((cell) => cell.trim())
    .filter(Boolean);
  assert.equal(cells.length, 4, `Domains table row for "${domainId}" should have four cells.`);
  return cells[3]
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean);
}

function extractRedisKeyTableTtl(text: string, key: string): string {
  const rowRe = new RegExp(`^\\|\\s*\\\`${escapeRegex(key)}\\\`\\s*\\|\\s*JSON\\s*\\|\\s*([^|]+?)\\s*\\|`, 'm');
  const match = rowRe.exec(text);
  assert.ok(match, `Redis key table row for "${key}" not found.`);
  return match[1].trim();
}

function extractStaticSeedTtlDays(text: string): number {
  const match = /RESILIENCE_STATIC_TTL_SECONDS\s*=\s*(\d+)\s*\*\s*24\s*\*\s*60\s*\*\s*60/.exec(text);
  assert.ok(match, 'RESILIENCE_STATIC_TTL_SECONDS formula not found in seed-resilience-static.mjs.');
  return Number(match[1]);
}

function extractStaticSeedHealthMaxStaleMinutes(text: string): number {
  const match = /resilienceStaticIndex:\s*\{\s*key:\s*'seed-meta:resilience:static',\s*maxStaleMin:\s*(\d+)/.exec(text);
  assert.ok(match, 'resilienceStaticIndex maxStaleMin not found in api/health.js.');
  return Number(match[1]);
}

function findPlausibleCurrentTotalDimensionCounts(text: string, activeCount: number, totalCount: number): number[] {
  const PLAUSIBLE_CURRENT_TOTAL_MIN = 15;
  const PLAUSIBLE_CURRENT_TOTAL_MAX = 25;
  return [...text.matchAll(/(\d+)\s+(?:active\s+)?dimensions?/g)]
    .map((m) => Number(m[1]))
    .filter((n) =>
      n !== activeCount &&
      n !== totalCount &&
      n >= PLAUSIBLE_CURRENT_TOTAL_MIN &&
      n <= PLAUSIBLE_CURRENT_TOTAL_MAX,
    );
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\s+/g, ' ');
}
