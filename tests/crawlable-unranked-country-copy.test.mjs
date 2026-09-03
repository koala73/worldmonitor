import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  compareUnpublishedRankedPeers,
  describeMicrostateEvidence,
  describeMicrostateEvidenceSummary,
  countryMetaDescription,
  describeAvailableEvidence,
  describeCoverageGaps,
  describeHeadlineIneligibility,
  describeHeadlineIneligibilityReason,
  dimensionInventoryNote,
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

function dimension(id, coverage, imputationClass = '', score = null) {
  return { id, coverage, imputationClass, score };
}

function countryFixture(overrides, dimensions) {
  return {
    name: 'Testland',
    code: 'ZZ',
    dimensionCoverage: 0.5,
    imputationShare: 0.2,
    lowConfidence: true,
    headlineEligible: false,
    microstateTerritory: false,
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
    assert.match(eligibility, /does not meet the published ranking eligibility criteria/);
    assert.doesNotMatch(eligibility, /imputation share is 45%/);
    const reason = describeHeadlineIneligibilityReason(country);
    assert.match(reason, /imputation share is 45%, above the 40% confidence limit/);
    assert.doesNotMatch(reason, /below the 55% confidence gate/);
    assert.doesNotMatch(reason, /below the 65% ranking floor/);
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

  it('explains what available dimensions show for microstate pages', () => {
    const country = countryFixture({
      name: 'Tuvalu',
      code: 'TV',
      microstateTerritory: true,
      dimensionCoverage: 0.62,
      imputationShare: 0.176,
    }, [
      dimension('borderSecurity', 1, '', 100),
      dimension('cyberDigital', 1, '', 100),
      dimension('education', 0.8, '', 34),
      dimension('healthPublicService', 1, '', 65),
      dimension('externalDebtCoverage', 0.3, 'unmonitored', 50),
    ]);
    const evidence = describeMicrostateEvidence(country);
    assert.match(evidence, /Border security[^.]*100/);
    assert.match(evidence, /Education capacity[^.]*34/);
    assert.match(evidence, /UCDP/);
    assert.match(evidence, /World Bank/);
    assert.match(evidence, /Possible dimension inputs for Tuvalu/);
    assert.doesNotMatch(evidence, /Observed feeds/);
    assert.match(evidence, /not a published overall score|not a country rank/i);
  });

  it('keeps overlapping sources scoped to dimensions instead of declaring them absent', () => {
    const country = countryFixture({
      name: 'Overlap Isles',
      code: 'TV',
      microstateTerritory: true,
    }, [
      dimension('borderSecurity', 1, '', 72),
      dimension('stateContinuity', 0, 'unmonitored'),
      dimension('healthPublicService', 0, 'unmonitored'),
    ]);
    const evidence = describeMicrostateEvidence(country);
    assert.match(evidence, /For Overlap Isles, some feed families span supported and missing dimensions: UCDP/);
    assert.match(evidence, /Inputs tied only to missing or unmonitored dimensions in Overlap Isles: WHO/);
    assert.doesNotMatch(evidence, /Observed feeds/);
    assert.doesNotMatch(evidence, /UCDP does not cover Overlap Isles|UCDP is absent/);
  });

  it('withholds scores when a microstate has no observed dimensions', () => {
    const country = countryFixture({
      name: 'Sparse Atoll',
      code: 'TV',
      microstateTerritory: true,
    }, [
      dimension('borderSecurity', 0, 'unmonitored', 88),
      dimension('education', 0, 'source-failure', 41),
    ]);
    const evidence = describeMicrostateEvidence(country);
    assert.match(evidence, /no observed dimension reading/);
    assert.match(evidence, /No overall resilience score or country rank is published/);
    assert.doesNotMatch(evidence, /88|41/);
  });

  it('does not publish a missing dimension score as an observed zero', () => {
    const country = countryFixture({
      name: 'Scoreless Atoll',
      code: 'TV',
      microstateTerritory: true,
    }, [
      dimension('borderSecurity', 1),
      dimension('education', 0.8, '', 'not-a-score'),
    ]);
    const evidence = describeMicrostateEvidence(country);
    assert.match(evidence, /no observed dimension reading/);
    assert.doesNotMatch(evidence, /Border security|Education capacity/);
  });

  it('does not present stable-absence imputation as an observed reading', () => {
    const country = countryFixture({
      name: 'Stable Atoll',
      code: 'TV',
      microstateTerritory: true,
    }, [
      dimension('foodWater', 0.7, 'stable-absence', 88),
    ]);
    const evidence = describeMicrostateEvidence(country);
    assert.match(evidence, /no observed dimension reading/);
    assert.doesNotMatch(evidence, /Food and water security|88/);
  });

  it('requires usable coverage and observed imputation for a dimension reading', () => {
    const country = countryFixture({
      name: 'Partial Atoll',
      code: 'TV',
      microstateTerritory: true,
    }, [
      dimension('borderSecurity', 0.49, '', 12),
      dimension('education', 0.7, 'not-applicable', 44),
    ]);
    const evidence = describeMicrostateEvidence(country);
    assert.match(evidence, /no observed dimension reading/);
    assert.doesNotMatch(evidence, /Border security|Education capacity|12|44/);
  });

  it('keeps the compact FAQ fallback score-free when no dimensions are observed', () => {
    const country = countryFixture({
      name: 'Empty Atoll',
      code: 'TV',
      microstateTerritory: true,
    }, [dimension('borderSecurity', 0, 'unmonitored', 88)]);
    const evidence = describeMicrostateEvidenceSummary(country);
    assert.match(evidence, /no observed dimension reading/);
    assert.match(evidence, /No overall resilience score or country rank is published/);
    assert.doesNotMatch(evidence, /88/);
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

  it('orders unpublished ranked comparators by score proximity, not best rank', () => {
    const andorra = { overallScore: 62 };
    const switzerland = { code: 'CH', name: 'Switzerland', rank: 1, overallScore: 91 };
    const czechia = { code: 'CZ', name: 'Czechia', rank: 18, overallScore: 64 };
    const japan = { code: 'JP', name: 'Japan', rank: 8, overallScore: 63 };
    const regions = { CH: 'europe', CZ: 'europe', JP: 'east-asia' };
    assert.ok(
      compareUnpublishedRankedPeers(czechia, switzerland, andorra, 'europe', regions) < 0,
      'same-region closer score must beat a higher-ranked distant score',
    );
    assert.ok(
      compareUnpublishedRankedPeers(czechia, japan, andorra, 'europe', regions) < 0,
      'same-region peers still outrank other regions even when the other score is closer',
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
    assert.doesNotMatch(eligibility, /\bTW · /);
    const reason = describeHeadlineIneligibilityReason(taiwan);
    assert.match(reason, /38%/);
    assert.match(reason, /42%/);
    assert.doesNotMatch(reason, /\bTW · /);

    const gaps = describeCoverageGaps(taiwan);
    assert.match(gaps, /Governance and institutions/);
    assert.match(gaps, /Health and public services/);
    assert.match(gaps, /Financial-system exposure/);
    assert.match(gaps, /Logistics and supply chains/);
    assert.match(gaps, /World Bank/);
    assert.match(gaps, /WHO/);
    assert.match(gaps, /does not cover Taiwan|do not contribute observed series for Taiwan/);
    assert.match(gaps, /State continuity is marked source unavailable in this snapshot/);
    assert.doesNotMatch(gaps, /source-universe limit/);
    assert.doesNotMatch(gaps, /Fuel-stock buffer/);
    assert.doesNotMatch(gaps, /Reserve adequacy/);
    assert.doesNotMatch(gaps, /\bTW · /);

    const available = describeAvailableEvidence(taiwan);
    assert.match(available, /Cyber and digital capacity \(100%\)/);
    assert.match(available, /Macro-fiscal position \(95%\)/);
    assert.match(available, /Border security \(86%\)/);
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
    assert.match(eligibility, /does not meet the published ranking eligibility criteria/);
    const reason = describeHeadlineIneligibilityReason(syria);
    assert.match(reason, /54%/);
    assert.match(reason, /55%/);
    assert.match(reason, /65%/);
    assert.doesNotMatch(reason, /imputation share is/);

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
    assert.match(eligibility, /does not meet the published ranking eligibility criteria/);
    const reason = describeHeadlineIneligibilityReason(andorra);
    assert.match(reason, /69%/);
    assert.match(reason, /recorded population of at least 200,000/);
    assert.match(reason, /85%/);
    assert.doesNotMatch(reason, /below the 65%/);
    assert.doesNotMatch(reason, /below the 55%/);

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
      /World Bank, which does not contribute observed series for those dimensions/,
    );
  });

  it('does not claim a named source is absent country-wide when it still feeds observed dimensions', () => {
    const country = countryFixture({
      name: 'Taiwan',
      code: 'TW',
      dimensionCoverage: 0.38,
      imputationShare: 0.417,
      lowConfidence: true,
    }, [
      dimension('education', 0.8),
      dimension('externalDebtCoverage', 0, 'unmonitored'),
      dimension('borderSecurity', 0.86),
    ]);
    const gaps = describeCoverageGaps(country);
    assert.match(gaps, /World Bank, which does not contribute observed series for those dimensions/);
    assert.doesNotMatch(gaps, /contribute observed series for Taiwan/);
    assert.match(gaps, /does not cover Taiwan/);
  });

  it('labels not-applicable inventory slots before missing-source copy', () => {
    const country = countryFixture({ name: 'Andorra', code: 'AD' }, []);
    assert.equal(
      dimensionInventoryNote(country, dimension('sovereignFiscalBuffer', 0, 'not-applicable')),
      'not applicable',
    );
    assert.equal(
      dimensionInventoryNote(country, dimension('macroFiscal', 0, 'stable-absence')),
      'stable absence in the source feed',
    );
  });

  it('lists the strongest observed dimensions, not the weakest usable ones', () => {
    const available = describeAvailableEvidence(countryFixture({
      name: 'Taiwan',
      code: 'TW',
      dimensionCoverage: 0.38,
      imputationShare: 0.417,
      lowConfidence: true,
    }, [
      dimension('currencyExternal', 0.55),
      dimension('energy', 0.75),
      dimension('healthPublicService', 0.8),
      dimension('education', 0.85),
      dimension('borderSecurity', 0.9),
      dimension('cyberDigital', 0.95),
      dimension('macroFiscal', 1),
      dimension('tradePolicy', 0.4),
    ]));
    assert.match(available, /Macro-fiscal position \(100%\)/);
    assert.match(available, /Cyber and digital capacity \(95%\)/);
    assert.doesNotMatch(available, /Currency and external balance/);
  });

  it('does not imply a covered ineligible country has fewer than 200,000 people', () => {
    const iraq = countryFixture({
      name: 'Iraq',
      code: 'IQ',
      dimensionCoverage: 0.69,
      imputationShare: 0.1,
      lowConfidence: false,
    }, [
      dimension('macroFiscal', 0.9),
    ]);
    const reason = describeHeadlineIneligibilityReason(iraq);
    assert.match(reason, /recorded population of at least 200,000/);
    assert.match(reason, /coverage is 69%/);
    assert.doesNotMatch(reason, /below the 65%/);
    assert.doesNotMatch(reason, /fewer than 200,000|microstate/);
  });
});
