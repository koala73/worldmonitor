// Validates the cohort and matched-pair configuration used by the PR 0
// diagnostic-freeze harness. These configs are load-bearing for the
// fairness audit in docs/plans/2026-04-22-001-fix-resilience-scorer-
// structural-bias-plan.md §7 — a silent regression in them would
// corrupt the acceptance-gate evidence for every subsequent scorer PR.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RESILIENCE_COHORTS, unionMembership } from './helpers/resilience-cohorts.mts';
import { MATCHED_PAIRS } from './helpers/resilience-matched-pairs.mts';

const ISO2_RE = /^[A-Z]{2}$/;

describe('resilience cohort configuration', () => {
  it('every cohort has at least 3 members', () => {
    for (const cohort of RESILIENCE_COHORTS) {
      assert.ok(
        cohort.countryCodes.length >= 3,
        `cohort ${cohort.id} has ${cohort.countryCodes.length} members; medians are unreliable below 3`,
      );
    }
  });

  it('every cohort country code is a valid ISO-3166 alpha-2', () => {
    for (const cohort of RESILIENCE_COHORTS) {
      for (const cc of cohort.countryCodes) {
        assert.match(cc, ISO2_RE, `cohort ${cohort.id} has non-ISO2 code "${cc}"`);
      }
    }
  });

  it('no cohort has duplicate members within itself', () => {
    for (const cohort of RESILIENCE_COHORTS) {
      const unique = new Set(cohort.countryCodes);
      assert.equal(
        unique.size,
        cohort.countryCodes.length,
        `cohort ${cohort.id} has duplicate members: ${cohort.countryCodes.length - unique.size} duplicates`,
      );
    }
  });

  it('every cohort has a documented definition and source', () => {
    for (const cohort of RESILIENCE_COHORTS) {
      assert.ok(cohort.definition.length > 20, `cohort ${cohort.id} definition too short`);
      assert.ok(cohort.source.length > 10, `cohort ${cohort.id} source citation too short`);
      assert.ok(cohort.label.length > 3, `cohort ${cohort.id} label too short`);
    }
  });

  it('cohort union covers at least 70 unique countries', () => {
    // PR 0 §7: the union of cohort membership must span a meaningful
    // slice of the ranking. 70 countries is roughly a third of the
    // scorable set — sufficient for cohort-median gates to distinguish
    // construct-change effects from noise.
    const union = unionMembership();
    assert.ok(
      union.length >= 70,
      `cohort union has ${union.length} unique countries; expected ≥ 70 for meaningful fairness audit`,
    );
  });

  it('cohort ids are unique', () => {
    const ids = RESILIENCE_COHORTS.map((c) => c.id);
    const unique = new Set(ids);
    assert.equal(unique.size, ids.length, 'cohort ids must be unique');
  });
});

describe('resilience matched-pair configuration', () => {
  it('every matched pair references two distinct valid ISO-2 codes', () => {
    for (const pair of MATCHED_PAIRS) {
      assert.match(pair.higherExpected, ISO2_RE, `pair ${pair.id} higherExpected`);
      assert.match(pair.lowerExpected, ISO2_RE, `pair ${pair.id} lowerExpected`);
      assert.notEqual(
        pair.higherExpected,
        pair.lowerExpected,
        `pair ${pair.id} has higher === lower (${pair.higherExpected})`,
      );
    }
  });

  it('every matched pair has a documented axis + rationale', () => {
    for (const pair of MATCHED_PAIRS) {
      assert.ok(pair.axis.length > 10, `pair ${pair.id} axis too short`);
      // Rationale must be substantive — pins the expected-direction
      // defensibility so a reviewer can challenge the pair on its
      // merits rather than guessing at intent.
      assert.ok(pair.rationale.length > 100, `pair ${pair.id} rationale too short (${pair.rationale.length} chars)`);
    }
  });

  it('every matched pair has a non-negative minimum gap', () => {
    for (const pair of MATCHED_PAIRS) {
      const minGap = pair.minGap ?? 3;
      assert.ok(
        minGap >= 0,
        `pair ${pair.id} minGap=${minGap} must be ≥ 0`,
      );
      // Guard against an accidentally-enormous minGap that would make
      // the gate trivially fail — no pair should need more than a
      // 10-point cushion.
      assert.ok(
        minGap <= 10,
        `pair ${pair.id} minGap=${minGap} suspiciously large; pairs with gaps > 10 are probably not valid sanity-check peers`,
      );
    }
  });

  it('pair ids are unique', () => {
    const ids = MATCHED_PAIRS.map((p) => p.id);
    const unique = new Set(ids);
    assert.equal(unique.size, ids.length, 'matched-pair ids must be unique');
  });

  it('at least 4 pairs are defined to exercise the fairness audit', () => {
    // Acceptance gate #7 in the plan requires the matched-pair sanity
    // panel to be exercised every scorer-changing PR. Too few pairs
    // and the panel provides insufficient coverage across scorer
    // behavior axes.
    assert.ok(MATCHED_PAIRS.length >= 4, `expected ≥ 4 matched pairs, got ${MATCHED_PAIRS.length}`);
  });
});
