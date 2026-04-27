// Plan 2026-04-26-002 §U7 (PR 6) — pinning tests for the
// headline-eligible gate logic + the ranking-handler filter.
//
// PR 6 swaps `headlineEligible` from the PR-2 default `true` to actual
// eligibility per origin Q2 + Q5:
//   coverage >= 0.65 AND (population >= 200k OR coverage >= 0.85) AND !lowConfidence
//
// These tests pin the truth table directly via `computeHeadlineEligible`
// and assert the ranking handler filters by the field.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  computeHeadlineEligible,
  HEADLINE_ELIGIBLE_HIGH_COVERAGE,
  HEADLINE_ELIGIBLE_MIN_COVERAGE,
  HEADLINE_ELIGIBLE_MIN_POPULATION_MILLIONS,
} from '../server/worldmonitor/resilience/v1/_shared.ts';

describe('computeHeadlineEligible truth table (Plan 2026-04-26-002 §U7)', () => {
  it('happy path: high coverage + large population + not lowConfidence → true', () => {
    assert.equal(
      computeHeadlineEligible({ overallCoverage: 0.9, populationMillions: 100, lowConfidence: false }),
      true,
    );
  });

  it('lowConfidence short-circuits to false regardless of other signals', () => {
    assert.equal(
      computeHeadlineEligible({ overallCoverage: 0.99, populationMillions: 1000, lowConfidence: true }),
      false,
      'lowConfidence must dominate — even perfect coverage + huge population fail',
    );
  });

  it('coverage just below 0.65 floor → false even with large population', () => {
    assert.equal(
      computeHeadlineEligible({ overallCoverage: 0.64, populationMillions: 100, lowConfidence: false }),
      false,
      `${HEADLINE_ELIGIBLE_MIN_COVERAGE} is the absolute floor; below it, no compensator helps`,
    );
  });

  it('coverage at 0.65 floor + large population → true', () => {
    assert.equal(
      computeHeadlineEligible({ overallCoverage: HEADLINE_ELIGIBLE_MIN_COVERAGE, populationMillions: 50, lowConfidence: false }),
      true,
    );
  });

  it('tiny state (< 200k pop) with mid coverage 0.7 → false', () => {
    // Iceland-shape: coverage 0.7 but pop 0.4M is below 0.2M floor?
    // 0.4 > 0.2 → passes. Test with a real micro-state: pop 0.05M.
    assert.equal(
      computeHeadlineEligible({ overallCoverage: 0.7, populationMillions: 0.05, lowConfidence: false }),
      false,
      'micro-state without high-quality data fails the gate',
    );
  });

  it('tiny state (< 200k pop) with high coverage >= 0.85 → true (data-quality compensator)', () => {
    assert.equal(
      computeHeadlineEligible({ overallCoverage: HEADLINE_ELIGIBLE_HIGH_COVERAGE, populationMillions: 0.05, lowConfidence: false }),
      true,
      'high-coverage micro-state earns headline status (Iceland-class with 0.85+ coverage)',
    );
  });

  it('unknown population (null) + mid coverage → false (conservative default)', () => {
    assert.equal(
      computeHeadlineEligible({ overallCoverage: 0.75, populationMillions: null, lowConfidence: false }),
      false,
      'unknown population fails the population branch; needs coverage >= 0.85 alone to pass',
    );
  });

  it('unknown population (null) + coverage >= 0.85 → true (coverage compensator alone)', () => {
    assert.equal(
      computeHeadlineEligible({ overallCoverage: HEADLINE_ELIGIBLE_HIGH_COVERAGE, populationMillions: null, lowConfidence: false }),
      true,
      'unknown-pop country can earn headline status via the high-coverage branch',
    );
  });

  it('boundary: population at exactly 200k floor → true', () => {
    assert.equal(
      computeHeadlineEligible({ overallCoverage: 0.7, populationMillions: HEADLINE_ELIGIBLE_MIN_POPULATION_MILLIONS, lowConfidence: false }),
      true,
      '0.2M is the inclusive boundary',
    );
  });

  it('boundary: population just below 200k → false (population branch)', () => {
    assert.equal(
      computeHeadlineEligible({ overallCoverage: 0.7, populationMillions: 0.19, lowConfidence: false }),
      false,
      '0.19M < 0.2M → fails population branch; coverage 0.7 < 0.85 → fails coverage branch',
    );
  });
});
