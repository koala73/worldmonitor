import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  countryMetaDescription,
  describeAvailableEvidence,
  describeCoverageGaps,
  describeHeadlineIneligibility,
  HEADLINE_RANKING_HIGH_COVERAGE,
  HEADLINE_RANKING_MIN_COVERAGE,
  HEADLINE_RANKING_MIN_POPULATION,
  LOW_CONFIDENCE_MAX_IMPUTATION,
  LOW_CONFIDENCE_MIN_COVERAGE,
  RANKING_ELIGIBILITY_CLAUSE,
} from '../scripts/build-crawlable-corpus.mjs';

const sharedSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../server/worldmonitor/resilience/v1/_shared.ts'),
  'utf8',
);

function dimension(id, coverage, imputationClass = '') {
  return { id, coverage, imputationClass };
}

function countryFixture(overrides, dimensions) {
  return {
    name: 'Testland',
    code: 'ZZ',
    dimensionCoverage: 0.5,
    imputationShare: 0.2,
    lowConfidence: true,
    headlineEligible: false,
    domains: [
      {
        id: 'economic',
        dimensions,
      },
    ],
    ...overrides,
  };
}

describe('unranked country copy', () => {
  it('states the published ranking and confidence thresholds', () => {
    assert.match(RANKING_ELIGIBILITY_CLAUSE, /at least 65%/);
    assert.match(RANKING_ELIGIBILITY_CLAUSE, /200,000/);
    assert.match(RANKING_ELIGIBILITY_CLAUSE, /at least 85%/);
    assert.match(RANKING_ELIGIBILITY_CLAUSE, /below 55%/);
    assert.match(RANKING_ELIGIBILITY_CLAUSE, /exceeds 40%/);
  });

  it('keeps ranking copy gates aligned with the server eligibility constants', () => {
    assert.match(
      sharedSource,
      new RegExp(`export const HEADLINE_ELIGIBLE_MIN_COVERAGE = ${HEADLINE_RANKING_MIN_COVERAGE};`),
    );
    assert.match(
      sharedSource,
      new RegExp(`export const HEADLINE_ELIGIBLE_MIN_POPULATION_MILLIONS = ${HEADLINE_RANKING_MIN_POPULATION / 1_000_000};`),
    );
    assert.match(
      sharedSource,
      new RegExp(`export const HEADLINE_ELIGIBLE_HIGH_COVERAGE = ${HEADLINE_RANKING_HIGH_COVERAGE};`),
    );
    assert.match(
      sharedSource,
      new RegExp(`const LOW_CONFIDENCE_COVERAGE_THRESHOLD = ${LOW_CONFIDENCE_MIN_COVERAGE};`),
    );
    assert.match(
      sharedSource,
      /const LOW_CONFIDENCE_IMPUTATION_SHARE_THRESHOLD = 0\.40;/,
    );
    assert.equal(LOW_CONFIDENCE_MAX_IMPUTATION, 0.40);
    assert.match(
      RANKING_ELIGIBILITY_CLAUSE,
      new RegExp(`at least ${Math.round(HEADLINE_RANKING_MIN_COVERAGE * 100)}%`),
    );
    assert.match(
      RANKING_ELIGIBILITY_CLAUSE,
      new RegExp(HEADLINE_RANKING_MIN_POPULATION.toLocaleString('en-US')),
    );
    assert.match(
      RANKING_ELIGIBILITY_CLAUSE,
      new RegExp(`at least ${Math.round(HEADLINE_RANKING_HIGH_COVERAGE * 100)}%`),
    );
    assert.match(
      RANKING_ELIGIBILITY_CLAUSE,
      new RegExp(`below ${Math.round(LOW_CONFIDENCE_MIN_COVERAGE * 100)}%`),
    );
    assert.match(
      RANKING_ELIGIBILITY_CLAUSE,
      new RegExp(`exceeds ${Math.round(LOW_CONFIDENCE_MAX_IMPUTATION * 100)}%`),
    );
  });

  it('explains an imputation-only low-confidence snapshot without blaming coverage', () => {
    const country = countryFixture({
      name: 'Imputia',
      dimensionCoverage: 0.60,
      imputationShare: 0.45,
      lowConfidence: true,
    }, [
      dimension('macroFiscal', 0.8),
    ]);
    const eligibility = describeHeadlineIneligibility(country);
    assert.match(eligibility, /imputation share is 45%, above the 40% confidence limit/);
    assert.doesNotMatch(eligibility, /below the 55% confidence gate/);
    assert.doesNotMatch(eligibility, /below the 65% ranking floor/);
  });

  it('describes snapshots with no usable observed dimensions', () => {
    const country = countryFixture({
      name: 'Sparseville',
      dimensionCoverage: 0.12,
      imputationShare: 0.61,
      lowConfidence: true,
    }, [
      dimension('macroFiscal', 0),
      dimension('governanceInstitutional', 0.2, 'unmonitored'),
      dimension('reserveAdequacy', 0),
    ]);
    assert.match(
      describeAvailableEvidence(country),
      /no dimension clears a usable observed threshold/,
    );
    assert.match(describeAvailableEvidence(country), /Input coverage is 12%/);
    assert.match(describeAvailableEvidence(country), /imputation share is 61%/);
  });

  it('labels low-confidence unpublished meta descriptions distinctly', () => {
    assert.match(
      countryMetaDescription({
        name: 'Taiwan',
        rank: null,
        rankedCount: 196,
        lowConfidence: true,
      }),
      /a low-confidence listing/,
    );
    assert.doesNotMatch(
      countryMetaDescription({
        name: 'Andorra',
        rank: null,
        rankedCount: 196,
        lowConfidence: false,
      }),
      /a low-confidence listing/,
    );
  });

  it('explains Taiwan-style source-universe gaps without ISO scaffolding', () => {
    const taiwan = countryFixture({
      name: 'Taiwan',
      code: 'TW',
      dimensionCoverage: 0.38,
      imputationShare: 0.417,
      lowConfidence: true,
    }, [
      dimension('macroFiscal', 0.95),
      dimension('financialSystemExposure', 0),
      dimension('logisticsSupply', 0),
      dimension('governanceInstitutional', 0),
      dimension('healthPublicService', 0),
      dimension('education', 0.3, 'unmonitored'),
      dimension('stateContinuity', 0.3, 'source-failure'),
      dimension('reserveAdequacy', 0),
      dimension('fuelStockDays', 0),
      dimension('sovereignFiscalBuffer', 0, 'not-applicable'),
      dimension('borderSecurity', 0.86),
      dimension('cyberDigital', 1),
    ]);

    const eligibility = describeHeadlineIneligibility(taiwan);
    assert.match(eligibility, /does not meet the published ranking eligibility criteria/);
    assert.match(eligibility, /38%/);
    assert.match(eligibility, /42%/);
    assert.doesNotMatch(eligibility, /\bTW · /);

    const gaps = describeCoverageGaps(taiwan);
    assert.match(gaps, /Governance and institutions/);
    assert.match(gaps, /Health and public services/);
    assert.match(gaps, /Financial-system exposure/);
    assert.match(gaps, /Logistics and supply chains/);
    assert.match(gaps, /World Bank/);
    assert.match(gaps, /WHO/);
    assert.match(gaps, /does not cover Taiwan|do not contribute observed series for Taiwan/);
    assert.match(gaps, /source unavailable/);
    assert.doesNotMatch(gaps, /Fuel-stock buffer/);
    assert.doesNotMatch(gaps, /Reserve adequacy/);
    assert.doesNotMatch(gaps, /\bTW · /);

    const available = describeAvailableEvidence(taiwan);
    assert.match(available, /Cyber and digital capacity/);
    assert.match(available, /Border security/);
    assert.doesNotMatch(available, /\bTW · /);
  });

  it('names the missing IMF series for a Syria-style coverage miss', () => {
    const syria = countryFixture({
      name: 'Syria',
      code: 'SY',
      dimensionCoverage: 0.54,
      imputationShare: 0.261,
      lowConfidence: true,
    }, [
      dimension('macroFiscal', 0),
      dimension('tradePolicy', 1),
      dimension('cyberDigital', 1),
      dimension('healthPublicService', 0.7),
      dimension('reserveAdequacy', 0),
      dimension('fuelStockDays', 0),
    ]);

    const eligibility = describeHeadlineIneligibility(syria);
    assert.match(eligibility, /54%/);
    assert.match(eligibility, /55%/);
    assert.match(eligibility, /65%/);
    assert.doesNotMatch(eligibility, /imputation share is/);

    const gaps = describeCoverageGaps(syria);
    assert.match(gaps, /Macro-fiscal position/);
    assert.match(gaps, /IMF/);
    assert.doesNotMatch(gaps, /Reserve adequacy/);
  });

  it('does not blame coverage when the 65% floor is already met', () => {
    const andorra = countryFixture({
      name: 'Andorra',
      code: 'AD',
      dimensionCoverage: 0.69,
      imputationShare: 0.139,
      lowConfidence: false,
    }, [
      dimension('macroFiscal', 0.9),
      dimension('governanceInstitutional', 0.8),
      dimension('healthPublicService', 0.85),
      dimension('sovereignFiscalBuffer', 0, 'not-applicable'),
      dimension('reserveAdequacy', 0),
    ]);

    const eligibility = describeHeadlineIneligibility(andorra);
    assert.match(eligibility, /69%/);
    assert.match(eligibility, /200,000/);
    assert.match(eligibility, /85%/);
    assert.doesNotMatch(eligibility, /below the 65%/);
    assert.doesNotMatch(eligibility, /below the 55%/);

    const gaps = describeCoverageGaps(andorra);
    assert.match(gaps, /eligibility-rule|population|mostly observed/i);
    assert.doesNotMatch(gaps, /Governance and institutions have no/);
  });

  it('uses a singular verb when one named source is missing', () => {
    const country = countryFixture({
      name: 'Andorra',
      code: 'AD',
      dimensionCoverage: 0.69,
      imputationShare: 0.139,
      lowConfidence: false,
    }, [
      dimension('externalDebtCoverage', 0, 'unmonitored'),
    ]);
    assert.match(
      describeCoverageGaps(country),
      /World Bank, which does not contribute observed series for Andorra/,
    );
  });
});
