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
  RESILIENCE_DOMAIN_ORDER,
  RESILIENCE_RETIRED_DIMENSIONS,
  type ResilienceDomainId,
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

const here = dirname(fileURLToPath(import.meta.url));
const DOC_PATH = resolve(here, '../docs/methodology/country-resilience-index.mdx');
const DOCUMENTATION_PATH = resolve(here, '../docs/documentation.mdx');
const FEATURES_PATH = resolve(here, '../docs/features.mdx');
const RESILIENCE_OPENAPI_YAML_PATH = resolve(here, '../docs/api/ResilienceService.openapi.yaml');
const RESILIENCE_OPENAPI_JSON_PATH = resolve(here, '../docs/api/ResilienceService.openapi.json');
const BUNDLED_OPENAPI_YAML_PATH = resolve(here, '../docs/api/worldmonitor.openapi.yaml');
const docText = readFileSync(DOC_PATH, 'utf8');
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
});

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractIndicatorWeightsForSection(text: string, sectionHeading: string): Map<string, number> {
  const headingRe = new RegExp(`^#### ${escapeRegex(sectionHeading)}\\s*$`, 'm');
  const headingMatch = headingRe.exec(text);
  assert.ok(headingMatch, `Methodology section "${sectionHeading}" not found.`);

  const sectionStart = headingMatch.index + headingMatch[0].length;
  const rest = text.slice(sectionStart);
  const nextHeadingMatch = /^#{3,4}\s.+$/m.exec(rest);
  const sectionText = nextHeadingMatch == null ? rest : rest.slice(0, nextHeadingMatch.index);

  const rows = [...sectionText.matchAll(/^\|\s*([^|\s][^|]*?)\s*\|(?:[^|]*\|){3}\s*([0-9.]+)\s*\|/gm)];
  const weights = new Map<string, number>();
  for (const row of rows) {
    const indicatorId = row[1].trim();
    if (indicatorId === 'Indicator' || indicatorId.startsWith('---')) continue;
    weights.set(indicatorId, Number(row[2]));
  }
  return weights;
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
