import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { INDICATOR_REGISTRY } from '../server/worldmonitor/resilience/v1/_indicator-registry.ts';
import {
  RESILIENCE_DIMENSION_DOMAINS,
  getResilienceDomainWeight,
  type ResilienceDimensionId,
  type ResilienceDomainId,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';

// PR 3 §3.6 — Coverage-and-influence cap on indicator weight.
//
// Rule (plan §3.6, verbatim):
//   No indicator with observed coverage below 70% may exceed 5% nominal
//   weight OR 5% effective influence in the post-change sensitivity run.
//
// This file enforces the NOMINAL-WEIGHT half (static, runs every build).
// The effective-influence half is checked by the variable-importance
// output of scripts/validate-resilience-sensitivity.mjs and committed as
// an artifact; see plan §5 acceptance-criteria item 9.
//
// Why the gate exists (plan §3.6):
//   "A dimension at 30% observed coverage carries the same effective
//   weight as one at 95%. This contradicts the OECD/JRC handbook on
//   uncertainty analysis."
//
// Assumption: the global universe is ~195 countries (UN members + a few
// territories commonly ranked). "70% coverage" → 137+ countries.

const GLOBAL_COUNTRY_UNIVERSE = 195;
const COVERAGE_FLOOR = Math.ceil(GLOBAL_COUNTRY_UNIVERSE * 0.7); // 137
const NOMINAL_WEIGHT_CAP = 0.05; // 5%

// Nominal overall weight of an indicator = weight in dimension
//   × dimension share of domain
//   × domain weight in overall score.
//
// The scorer aggregates dimensions by coverage-weighted mean, so each
// dimension contributes roughly 1/N of its domain when all are observed.
// This is the worst-case (highest) bound on nominal influence — a
// dimension that loses coverage contributes less, not more, than this.
//
// Indicator weights within a dimension are normalized to sum to 1 for
// non-experimental tiers (enforced by the indicator-registry test).

function dimensionsInDomain(domainId: ResilienceDomainId): ResilienceDimensionId[] {
  return (Object.keys(RESILIENCE_DIMENSION_DOMAINS) as ResilienceDimensionId[])
    .filter((dimId) => RESILIENCE_DIMENSION_DOMAINS[dimId] === domainId);
}

function nominalOverallWeight(indicator: typeof INDICATOR_REGISTRY[number]): number {
  const domainId = RESILIENCE_DIMENSION_DOMAINS[indicator.dimension];
  if (domainId == null) return 0;
  const domainWeight = getResilienceDomainWeight(domainId);
  const dimensionsCount = dimensionsInDomain(domainId).length;
  // Equal-share-per-dimension upper bound (actual runtime weight is
  // ≤ this when some dimensions drop out on coverage).
  const dimensionShare = dimensionsCount > 0 ? 1 / dimensionsCount : 0;
  return indicator.weight * dimensionShare * domainWeight;
}

describe('resilience coverage-and-influence gate (PR 3 §3.6)', () => {
  it('no indicator with <70% country coverage carries >5% nominal weight in the overall score', () => {
    const violations = INDICATOR_REGISTRY
      // Only core indicators contribute to the overall (public) score.
      // Enrichment and experimental are drill-down-only, so their
      // nominal-weight-in-overall is 0 regardless of registry weight.
      .filter((e) => e.tier === 'core')
      .filter((e) => e.coverage < COVERAGE_FLOOR)
      .map((e) => ({
        id: e.id,
        dimension: e.dimension,
        coverage: e.coverage,
        weight: e.weight,
        nominalOverall: Number(nominalOverallWeight(e).toFixed(4)),
      }))
      .filter((v) => v.nominalOverall > NOMINAL_WEIGHT_CAP);

    assert.deepEqual(
      violations,
      [],
      `Indicators below ${COVERAGE_FLOOR}-country coverage floor with nominal overall weight > ${NOMINAL_WEIGHT_CAP * 100}%:\n${
        violations.map((v) => `  - ${v.id} (dim=${v.dimension}, coverage=${v.coverage}, nominal=${(v.nominalOverall * 100).toFixed(2)}%)`).join('\n')
      }\n\nFix options:\n  1. Demote to enrichment or experimental tier.\n  2. Lower the indicator's weight within its dimension.\n  3. Improve coverage to ≥${COVERAGE_FLOOR} countries.`,
    );
  });

  it('effective-influence artifact reference exists (sensitivity-script contract)', () => {
    // The plan (§3.6, §5 item 9) requires post-change variable-importance
    // to confirm the nominal-weight gate is not violated in the dynamic
    // (variance-explained) dimension either. That artifact is produced
    // by scripts/validate-resilience-sensitivity.mjs and not re-computed
    // here (it requires seeded Redis). This test only asserts the gate
    // script exists, so removing it via refactor breaks the build.
    const here = dirname(fileURLToPath(import.meta.url));
    const sensScript = join(here, '..', 'scripts', 'validate-resilience-sensitivity.mjs');
    assert.ok(existsSync(sensScript),
      `plan §3.6 effective-influence half is enforced by ${sensScript} — file is missing`);
  });

  it('reports the current nominal-weight distribution for audit', () => {
    // Visibility-only (no assertion beyond "ran cleanly"). The output
    // lets reviewers eyeball the distribution and spot outliers that
    // technically pass (coverage ≥ floor) but still carry unusually
    // high weight for a narrow construct.
    const ranked = INDICATOR_REGISTRY
      .filter((e) => e.tier === 'core')
      .map((e) => ({
        id: e.id,
        nominalOverall: Number((nominalOverallWeight(e) * 100).toFixed(2)),
        coverage: e.coverage,
      }))
      .sort((a, b) => b.nominalOverall - a.nominalOverall)
      .slice(0, 10);
    if (ranked.length > 0) {
      console.warn('[PR 3 §3.6] top 10 core indicators by nominal overall weight:');
      for (const r of ranked) {
        console.warn(`  ${r.id}: nominal=${r.nominalOverall}%  coverage=${r.coverage}`);
      }
    }
    assert.ok(ranked.length > 0, 'expected at least one core indicator');
  });
});
