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
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  FIN_SYS_BAND_PREMIUM_FLOOR,
  FIN_SYS_EXPOSURE_COMPREHENSIVE_EMBARGO,
  scoreFinancialSystemExposure,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';
import { RESILIENCE_COHORTS, type ResilienceCohort } from './helpers/resilience-cohorts.mts';
import { FIN_SYS_EXPOSURE_MATCHED_PAIRS } from './helpers/resilience-matched-pairs.mts';
import { FINSYS_FIXTURE_CAPTURED_AT, createFinSysFixtureReader } from './helpers/resilience-finsys-fixtures.mts';

// The threshold is the methodology doc's, verbatim. Raising it here without
// raising it there re-opens the doc/code gap this file closes.
const SANCTIONS_ANCHOR_CEILING = 20;
const METHODOLOGY = readFileSync(
  new URL('../docs/methodology/financial-system-exposure.md', import.meta.url),
  'utf8',
);

function methodologyEmbargoCountryCodes(): string[] {
  const marker = METHODOLOGY.indexOf('FIN_SYS_EXPOSURE_COMPREHENSIVE_EMBARGO');
  assert.ok(marker >= 0, 'methodology must include the embargo policy code block');
  const fenceEnd = METHODOLOGY.indexOf('```', marker);
  assert.ok(fenceEnd >= 0, 'methodology embargo policy code block must be closed');
  return [...METHODOLOGY.slice(marker, fenceEnd).matchAll(/^\s{2}([A-Z]{2})\s/gm)]
    .map((match) => match[1]);
}

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
  it('cohort, runtime cap, and methodology membership match exactly', () => {
    const cohort = sanctionsCohort();
    assert.deepEqual(
      [...cohort.countryCodes].sort(),
      [...FIN_SYS_EXPOSURE_COMPREHENSIVE_EMBARGO].sort(),
      'the activation cohort and runtime embargo cap must enumerate the same jurisdictions',
    );
    assert.deepEqual(
      methodologyEmbargoCountryCodes().sort(),
      [...FIN_SYS_EXPOSURE_COMPREHENSIVE_EMBARGO].sort(),
      'the methodology embargo block and runtime embargo cap must enumerate the same jurisdictions',
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

describe('financialSystemExposure — absence must not resolve as strength (#6461)', () => {
  it('drops FATF compliant-by-absence when it is the only resolving component', async () => {
    const reader = createFinSysFixtureReader();

    for (const cc of ['ER', 'TW']) {
      const result = await scoreFinancialSystemExposure(cc, reader);
      assert.equal(
        result.coverage,
        0,
        `${cc} is absent from WB IDS, BIS CBS, and both FATF lists; compliant-by-absence must not create coverage`,
      );
      assert.equal(
        result.score,
        0,
        `${cc} must not publish a perfect financial-system score from absence alone`,
      );
    }
  });

  it('attenuates Chad\'s near-perfect debt leg when the banking signals show no market access', async () => {
    const result = await scoreFinancialSystemExposure('TD', createFinSysFixtureReader());

    assert.equal(
      result.score,
      56,
      '0.14% short-term debt must not dominate when BIS claims are 1.11% of GDP with zero reporting parents',
    );
    assert.equal(
      result.coverage,
      0.76,
      'the debt reading is observed but not a full-confidence market-access signal',
    );
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

  it('a thin anchor is only thin if its OBSERVED gap is, not just its declared minGap', async () => {
    // The other half of the thin-anchor gate. `resilience-cohort-config`
    // checks the DECLARATION (sanctioned id, minGap 1-5, thinness rationale);
    // only here are scores actually computed, so only here can the claim be
    // checked against reality. Without this, a decisive pair could be
    // relabelled `thinAnchor` to escape the >= 10 rule and both gates would
    // pass — the declaration would be internally consistent and the wide gap
    // would sail through a bound that no longer applied to it.
    const reader = createFinSysFixtureReader();
    const failures: string[] = [];

    for (const pair of FIN_SYS_EXPOSURE_MATCHED_PAIRS) {
      if (!pair.thinAnchor) continue;
      const higher = await scoreFinancialSystemExposure(pair.higherExpected, reader);
      const lower = await scoreFinancialSystemExposure(pair.lowerExpected, reader);
      const gap = higher.score - lower.score;
      if (gap >= 10) {
        failures.push(
          `${pair.id}: observed gap ${gap} (${pair.higherExpected}=${higher.score} - `
            + `${pair.lowerExpected}=${lower.score}) is decisive, not thin — either drop thinAnchor `
            + 'and give it the >= 10 bound it now earns, or re-examine why the gap widened',
        );
      }
    }

    assert.deepEqual(failures, [], failures.join(' | '));
  });

  it('the methodology renders the same premium boundary the scorer uses', () => {
    // Doc/code parity for the conditioning, mirroring what
    // `methodologyEmbargoCountryCodes` does for the embargo list. The doc
    // carries the formula as prose, and the boundary is the number in it most
    // likely to drift silently: change it in the code and the doc keeps
    // telling readers the old story, with no test between them. The embargo
    // block already proved that a cross-checked doc is the only kind that
    // stays true.
    const marker = METHODOLOGY.indexOf('conditioned = min(band,');
    assert.ok(marker >= 0, 'methodology must render the diversity-conditioning formula');
    const formula = METHODOLOGY.slice(marker, METHODOLOGY.indexOf('\n', marker));

    // Extract the boundary from the two slots that carry it, rather than
    // scanning every integer and denylisting the rest — the formula also
    // contains 0, 1, 10 and 100, and a denylist silently stops matching the
    // moment the prose is reworded. `−` is U+2212 in the rendered doc, so
    // accept either dash.
    const slots = [
      /min\(band,\s*(\d+)\)/, // min(band, 75)
      /band\s*[-−]\s*(\d+)/, // band − 75
    ].map((re) => {
      const match = formula.match(re);
      assert.ok(match, `rendered formula does not contain the expected slot ${re}: ${formula}`);
      return Number(match[1]);
    });

    for (const value of slots) {
      assert.equal(
        value,
        FIN_SYS_BAND_PREMIUM_FLOOR,
        `methodology renders boundary ${value} but the scorer uses ${FIN_SYS_BAND_PREMIUM_FLOOR} — `
          + `doc and code have drifted (formula: ${formula})`,
      );
    }
  });

  it('the thin-anchor class is not a silent majority of the panel', async () => {
    // A per-pair bound says nothing about how many pairs use the exception.
    // If most of the panel became thin, the dimension's directional gates
    // would collectively lose their teeth without any single check failing.
    // Strict `<`: `thin * 2 <= length` admits a TIE (3 of 6), where decisive
    // pairs are exactly half and so not a majority — the thing the message
    // claims. A strict comparison makes the predicate match the promise.
    const thin = FIN_SYS_EXPOSURE_MATCHED_PAIRS.filter((p) => p.thinAnchor).length;
    assert.ok(
      thin * 2 < FIN_SYS_EXPOSURE_MATCHED_PAIRS.length,
      `${thin} of ${FIN_SYS_EXPOSURE_MATCHED_PAIRS.length} financialSystemExposure pairs are thin anchors — `
        + 'the decisive contrasts must stay a strict majority of the panel',
    );
  });
});
