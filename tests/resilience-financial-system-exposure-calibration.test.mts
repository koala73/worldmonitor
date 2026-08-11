// Executable calibration gates for `financialSystemExposure` (#6459).
//
// The construct shipped flag-dark in PR #3407 with its activation anchor
// written as PROSE in `docs/methodology/financial-system-exposure.md`
// § "Sanctions-isolated jurisdiction sanity check": eight sanctions-isolated
// jurisdictions must score < 20 before the flag flips. Nothing evaluated that
// sentence. It was unsatisfiable — Russia scored ~70 — and the construct sat
// merged and inverted for three and a half months.
//
// The two acceptance gates the dimension DID have are magnitude gates:
// Spearman vs baseline and max per-country drift. Both passed on the
// 2026-08-11 full-universe measurement (0.99612 / 8.61) while the ranking was
// completely inverted, because a magnitude gate bounds how far countries move,
// not which direction they move in. Direction needs directional gates.
//
// This file is those gates. It scores through the REAL production scorer
// (`scoreFinancialSystemExposure`) with a stub reader over pinned production
// payloads — no re-implementation of the formula, because a re-implementation
// would be free to disagree with production in exactly the way that hid this
// bug.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { scoreFinancialSystemExposure } from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';
import { RESILIENCE_COHORTS, type ResilienceCohort } from './helpers/resilience-cohorts.mts';
import { FIN_SYS_EXPOSURE_MATCHED_PAIRS } from './helpers/resilience-matched-pairs.mts';
import { FINSYS_FIXTURE_CAPTURED_AT, createFinSysFixtureReader } from './helpers/resilience-finsys-fixtures.mts';

// The threshold is the methodology doc's, verbatim. Raising it here without
// raising it there re-opens the doc/code gap this file closes.
const SANCTIONS_ANCHOR_CEILING = 20;

// The eight jurisdictions the methodology anchor enumerates. Duplicated from
// the cohort deliberately: if someone quietly drops a member from the cohort
// to make the gate pass, the membership assertion below fails instead.
const METHODOLOGY_ANCHOR_MEMBERS = ['RU', 'IR', 'KP', 'CU', 'VE', 'BY', 'LY', 'MM'] as const;

const ORIGINAL_FLAG = process.env.RESILIENCE_FIN_SYS_EXPOSURE_ENABLED;
beforeEach(() => {
  process.env.RESILIENCE_FIN_SYS_EXPOSURE_ENABLED = 'true';
});
afterEach(() => {
  if (ORIGINAL_FLAG === undefined) {
    delete process.env.RESILIENCE_FIN_SYS_EXPOSURE_ENABLED;
  } else {
    process.env.RESILIENCE_FIN_SYS_EXPOSURE_ENABLED = ORIGINAL_FLAG;
  }
});

function sanctionsCohort(): ResilienceCohort {
  const cohort = RESILIENCE_COHORTS.find((c) => c.id === 'sanctions-isolated');
  if (!cohort) {
    // Deleting the cohort would make every gate below vacuously pass, so
    // fail loudly rather than iterating an empty list.
    throw new assert.AssertionError({
      message: 'the `sanctions-isolated` cohort must exist — it is the construct activation anchor',
    });
  }
  return cohort;
}

describe('financialSystemExposure — sanctions-isolated activation anchor', () => {
  it('cohort membership matches the methodology anchor exactly', () => {
    const cohort = sanctionsCohort();
    assert.deepEqual(
      [...cohort.countryCodes].sort(),
      [...METHODOLOGY_ANCHOR_MEMBERS].sort(),
      'the cohort and `docs/methodology/financial-system-exposure.md` § "Sanctions-isolated jurisdiction sanity check" must enumerate the same jurisdictions',
    );
  });

  it(`every sanctions-isolated jurisdiction scores < ${SANCTIONS_ANCHOR_CEILING}`, async () => {
    const reader = createFinSysFixtureReader();
    const failures: string[] = [];
    const observed: string[] = [];

    for (const cc of sanctionsCohort().countryCodes) {
      const result = await scoreFinancialSystemExposure(cc, reader);
      observed.push(`${cc}=${result.score}/cov${result.coverage}`);
      if (!(result.score < SANCTIONS_ANCHOR_CEILING)) {
        failures.push(`${cc} scored ${result.score} at coverage ${result.coverage}`);
      }
    }

    assert.deepEqual(
      failures,
      [],
      `sanctions-isolated jurisdictions must score < ${SANCTIONS_ANCHOR_CEILING} on financialSystemExposure. `
        + `Failing: ${failures.join('; ')}. All observed (${FINSYS_FIXTURE_CAPTURED_AT} production payloads): ${observed.join(', ')}.`,
    );
  });

  it('the anchor is not satisfied by zero coverage — every member carries observed signal', async () => {
    // A trivially-passing variant of this gate would be a scorer that returns
    // the empty-data shape (score 0, coverage 0) for every embargoed country;
    // it would clear `< 20` while proving nothing. Require real observed
    // weight so the gate keeps its teeth.
    const reader = createFinSysFixtureReader();
    for (const cc of sanctionsCohort().countryCodes) {
      const result = await scoreFinancialSystemExposure(cc, reader);
      assert.ok(
        result.coverage > 0,
        `${cc} must resolve at least one component (coverage ${result.coverage}) — a coverage-0 pass makes the anchor vacuous`,
      );
    }
  });
});

describe('financialSystemExposure — dimension-level matched pairs', () => {
  it('every pair holds its documented direction with its minimum gap', async () => {
    const reader = createFinSysFixtureReader();
    const failures: string[] = [];

    for (const pair of FIN_SYS_EXPOSURE_MATCHED_PAIRS) {
      assert.equal(
        pair.dimension,
        'financialSystemExposure',
        `pair ${pair.id} is scoped to ${pair.dimension} and must not be evaluated by this gate`,
      );
      const higher = await scoreFinancialSystemExposure(pair.higherExpected, reader);
      const lower = await scoreFinancialSystemExposure(pair.lowerExpected, reader);
      const gap = higher.score - lower.score;
      const minGap = pair.minGap ?? 3;
      if (gap < minGap) {
        failures.push(
          `${pair.id}: ${pair.higherExpected}=${higher.score} - ${pair.lowerExpected}=${lower.score} `
            + `= ${gap} (needs >= ${minGap}${gap < 0 ? '; DIRECTION INVERTED' : ''})`,
        );
      }
    }

    assert.deepEqual(
      failures,
      [],
      `financialSystemExposure matched pairs failed on ${FINSYS_FIXTURE_CAPTURED_AT} production payloads: ${failures.join(' | ')}`,
    );
  });
});
