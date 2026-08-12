// Validates the cohort and matched-pair configuration used by the PR 0
// diagnostic-freeze harness. These configs are load-bearing for the
// fairness audit in docs/plans/2026-04-22-001-fix-resilience-scorer-
// structural-bias-plan.md §7 — a silent regression in them would
// corrupt the acceptance-gate evidence for every subsequent scorer PR.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RESILIENCE_COHORTS, unionMembership } from './helpers/resilience-cohorts.mts';
import { FIN_SYS_EXPOSURE_MATCHED_PAIRS, MATCHED_PAIRS } from './helpers/resilience-matched-pairs.mts';

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

  it('pins the India–South Africa rebaseline to the audited pre-flip condition', () => {
    const pair = MATCHED_PAIRS.find((candidate) => candidate.id === 'in-vs-za');
    assert.ok(pair, 'in-vs-za pair must remain configured');
    assert.equal(pair.minGap, 1, 'the rebaseline keeps a positive one-point directional buffer');
    assert.match(pair.rationale, /2026-08-11/);
    assert.match(pair.rationale, /2\.54/);
    assert.match(pair.rationale, /1\.77/);
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

describe('dimension-scoped matched-pair configuration', () => {
  // The dimension panels intentionally live OUTSIDE `MATCHED_PAIRS`: that
  // export feeds acceptance gate #7, which compares whole-index overall
  // scores. Mixing dimension-level anchors into it would silently compare
  // one dimension's expectation against another quantity. #6459.
  const DIMENSION_PANELS = [
    { label: 'FIN_SYS_EXPOSURE_MATCHED_PAIRS', pairs: FIN_SYS_EXPOSURE_MATCHED_PAIRS },
  ];

  it('dimension panels are disjoint from the whole-index panel', () => {
    const wholeIndexIds = new Set(MATCHED_PAIRS.map((p) => p.id));
    for (const { label, pairs } of DIMENSION_PANELS) {
      for (const pair of pairs) {
        assert.ok(
          !wholeIndexIds.has(pair.id),
          `${label} pair ${pair.id} collides with a whole-index pair id`,
        );
      }
    }
  });

  it('every dimension pair names its dimension and two distinct valid ISO-2 codes', () => {
    for (const { label, pairs } of DIMENSION_PANELS) {
      for (const pair of pairs) {
        assert.ok(pair.dimension.length > 0, `${label} pair ${pair.id} must name a dimension`);
        assert.match(pair.higherExpected, ISO2_RE, `${label} pair ${pair.id} higherExpected`);
        assert.match(pair.lowerExpected, ISO2_RE, `${label} pair ${pair.id} lowerExpected`);
        assert.notEqual(
          pair.higherExpected,
          pair.lowerExpected,
          `${label} pair ${pair.id} has higher === lower (${pair.higherExpected})`,
        );
      }
    }
  });

  it('every dimension pair documents its axis, rationale, and flip conditions', () => {
    for (const { label, pairs } of DIMENSION_PANELS) {
      for (const pair of pairs) {
        assert.ok(pair.axis.length > 10, `${label} pair ${pair.id} axis too short`);
        assert.ok(
          pair.rationale.length > 100,
          `${label} pair ${pair.id} rationale too short (${pair.rationale.length} chars)`,
        );
        // The contract in resilience-matched-pairs.mts requires the
        // rationale to state the conditions under which the direction
        // could legitimately flip, so a future reviewer can challenge the
        // pair rather than guess at intent.
        assert.match(
          pair.rationale,
          /flip/i,
          `${label} pair ${pair.id} rationale must state its flip conditions`,
        );
      }
    }
  });

  it('dimension pairs carry a decisive minimum gap', () => {
    // A dimension-level anchor exists to keep one dimension's own signal
    // unambiguous, so it takes a wider buffer than the whole-index panel's
    // 1-5 point cushions. Below 10 the gate stops distinguishing "the
    // construct is directionally right" from "the two happen to be close".
    for (const { label, pairs } of DIMENSION_PANELS) {
      for (const pair of pairs) {
        const minGap = pair.minGap ?? 3;
        assert.ok(minGap >= 10, `${label} pair ${pair.id} minGap=${minGap} must be ≥ 10`);
        assert.ok(minGap <= 40, `${label} pair ${pair.id} minGap=${minGap} suspiciously large`);
      }
    }
  });

  it('dimension pair ids are unique within their panel', () => {
    for (const { label, pairs } of DIMENSION_PANELS) {
      const ids = pairs.map((p) => p.id);
      assert.equal(new Set(ids).size, ids.length, `${label} pair ids must be unique`);
    }
  });

  it('the financialSystemExposure panel covers at least 4 axes', () => {
    assert.ok(
      FIN_SYS_EXPOSURE_MATCHED_PAIRS.length >= 4,
      `expected ≥ 4 financialSystemExposure pairs, got ${FIN_SYS_EXPOSURE_MATCHED_PAIRS.length}`,
    );
  });
});
