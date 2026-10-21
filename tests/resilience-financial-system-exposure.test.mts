// Pin the `financialSystemExposure` 4-component weighted-blend formula
// + fail-closed preflight contract introduced in plan 2026-04-25-004
// Phase 2 (Ship 2).
//
// Components (weights total 1.0):
//   short_term_external_debt_pct_gni     0.35 (WB IDS — lowerBetter, goalpost worst=15% best=0%)
//   bis_lbs_xborder_us_eu_uk_pct_gdp     0.30 (BIS LBS by-parent — U-shape band)
//   fatf_listing_status                   0.20 (FATF — discrete black=0, gray=30, compliant=100)
//   financial_center_redundancy           0.15 (BIS LBS by-parent count — higherBetter, worst=1 best=10)
//
// The fail-closed preflight requires all 3 seed envelopes
// (`economic:wb-external-debt:v1`, `economic:bis-lbs:v1`,
// `economic:fatf-listing:v1`) to be reachable; missing seed-meta
// throws `ResilienceConfigurationError(message, missingKeys)` two-arg
// form. Per-country data gaps are NOT preflight failures — they
// produce per-component nulls.
//
// IMPORTANT — seed-meta key shape: `runSeed` (scripts/_seed-utils.mjs)
// strips the trailing `:v\d+` from the data key when it writes the
// freshness record. So `economic:wb-external-debt:v1` becomes
// `seed-meta:economic:wb-external-debt` (NO `:v1`). The scorer's
// preflight uses `resolveSeedMetaKey` to apply the same strip — these
// tests mock the unversioned form to match. A regression-guard test
// below pins the exact key shape so a future refactor that breaks
// the writer/reader contract fails loudly instead of silently routing
// every country to source-failure.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  FIN_SYS_BAND_ISOLATION_FLOOR,
  FIN_SYS_BAND_OVEREXPOSED_FLOOR,
  FIN_SYS_EXPOSURE_COMPREHENSIVE_EMBARGO,
  FIN_SYS_EXPOSURE_EMBARGO_POLICY_MAX_AGE_DAYS,
  FIN_SYS_EXPOSURE_EMBARGO_POLICY_REVIEWED_ON,
  FIN_SYS_MARKET_ACCESS_LOW_CLAIMS_PCT_GDP_MAX,
  FIN_SYS_MARKET_ACCESS_LOW_DEBT_PCT_GNI_MAX,
  FIN_SYS_BAND_WEIGHT,
  FIN_SYS_DEBT_BEST_PCT_GNI,
  FIN_SYS_DEBT_WORST_PCT_GNI,
  FIN_SYS_FATF_WEIGHT,
  FIN_SYS_REDUNDANCY_BEST_PARENTS,
  FIN_SYS_REDUNDANCY_WEIGHT,
  FIN_SYS_REDUNDANCY_WORST_PARENTS,
  FIN_SYS_SHORT_TERM_DEBT_WEIGHT,
  fatfStatusToScore,
  normalizeBandLowerBetter,
  normalizeDiversityConditionedBand,
  normalizeHigherBetter,
  normalizeLowerBetter,
  roundScore,
  scoreFinancialSystemExposure,
  ResilienceConfigurationError,
  type ResilienceSeedReader,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';
import {
  FINSYS_BIS_FIXTURE,
  FINSYS_DEBT_FIXTURE,
  FINSYS_FIXTURE_CAPTURED_AT,
  FINSYS_NON_DRS_COUNTRY_CODES,
  createFinSysFixtureReader,
} from './helpers/resilience-finsys-fixtures.mts';

const TEST_ISO2 = 'XX';

/**
 * Albania's blend on a given band score, mirroring the production blend. The
 * optional preFixRenormalization mode preserves the old drop-and-renormalise
 * arithmetic for the inherited-baseline counterfactual only.
 */
function blendFinSys(
  band: number | null,
  parentCount: number | null,
  options: { preFixRenormalization?: boolean } = {},
): number {
  // Every leg goes through the PRODUCTION transform at the PRODUCTION weight,
  // imported rather than restated. The earlier version hand-rolled the debt
  // normalization as `100 - value / 15 * 100` and the redundancy leg as
  // `(parentCount - 1) / 9 * 100`, both unrounded — but production rounds each
  // leg via `roundScore` before dividing by the surviving weight. Albania's debt
  // leg is 73, not 72.8667, and that single point put the honest raw-band blend
  // at 74.47 -> 74 where production lands on exactly 74.50 -> 75, which is how
  // the inherited inflation came to be published as +12 when it is +11.
  //
  // Calling the real transforms is what makes that class of drift
  // unrepresentable, rather than merely asserted against: there is no longer a
  // second copy of the arithmetic to diverge. A guard proved insufficient here —
  // reverting the rounding alone left the suite green, because Albania's
  // CONDITIONED figures do not straddle a rounding boundary even though its
  // raw-band figures do.
  const debtNorm = normalizeLowerBetter(
    FINSYS_DEBT_FIXTURE.AL.value,
    FIN_SYS_DEBT_BEST_PCT_GNI,
    FIN_SYS_DEBT_WORST_PCT_GNI,
  );
  const slots: Array<[number | null, number]> = [
    [debtNorm, FIN_SYS_SHORT_TERM_DEBT_WEIGHT],
    [band, FIN_SYS_BAND_WEIGHT],
    [fatfStatusToScore('compliant'), FIN_SYS_FATF_WEIGHT],
    [
      parentCount == null
        ? null
        : normalizeHigherBetter(parentCount, FIN_SYS_REDUNDANCY_WORST_PARENTS, FIN_SYS_REDUNDANCY_BEST_PARENTS),
      FIN_SYS_REDUNDANCY_WEIGHT,
    ],
  ];
  let num = 0;
  let den = 0;
  const totalWeight = slots.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [score, weight] of slots) {
    if (score == null) continue;
    num += score * weight;
    den += weight;
  }
  return Math.round(num / (options.preFixRenormalization ? den : totalWeight));
}
const VALID_DEBT_CONTROL_COUNTRY = 'ZZ';
const VALID_DEBT_SCHEMA_VERSION = 2;

function reachableDebtEnvelope(additionalNonDrsCountryCodes: ReadonlyArray<string> = []): unknown {
  return {
    _seed: {
      fetchedAt: Date.now(),
      recordCount: 1,
      sourceVersion: 'wb-ids-test',
      schemaVersion: VALID_DEBT_SCHEMA_VERSION,
      state: 'OK',
    },
    data: {
      countries: { [VALID_DEBT_CONTROL_COUNTRY]: { value: 1, year: 2024 } },
      nonDrsCountryCodes: [...new Set([...FINSYS_NON_DRS_COUNTRY_CODES, ...additionalNonDrsCountryCodes])],
    },
  };
}

function readerWithDebtPayload(debtPayload: unknown): ResilienceSeedReader {
  const fixtureReader = createFinSysFixtureReader();
  return async (key) => (
    key === 'economic:wb-external-debt:v1' ? debtPayload : fixtureReader(key)
  );
}

// The dim is flag-gated for staged rollout (matches energy v2 pattern).
// All formula + preflight tests in this file exercise the ON path.
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

describe('scoreFinancialSystemExposure — flag-off rollout posture', () => {
  it('flag off (default) → returns empty-data shape, no preflight, no throw', async () => {
    delete process.env.RESILIENCE_FIN_SYS_EXPOSURE_ENABLED;
    const reader: ResilienceSeedReader = async () => null;
    const result = await scoreFinancialSystemExposure(TEST_ISO2, reader);
    assert.equal(result.score, 0, 'flag off must yield score=0');
    assert.equal(result.coverage, 0, 'flag off must yield coverage=0');
    assert.equal(result.imputationClass, null, 'flag off must NOT carry imputationClass (no fail-closed)');
  });

  it('flag explicitly false → returns empty-data shape', async () => {
    process.env.RESILIENCE_FIN_SYS_EXPOSURE_ENABLED = 'false';
    const reader: ResilienceSeedReader = async () => null;
    const result = await scoreFinancialSystemExposure(TEST_ISO2, reader);
    assert.equal(result.score, 0);
    assert.equal(result.coverage, 0);
  });
});

// Default reader: ALL 3 required seed-meta envelopes present (so
// preflight passes), but NO per-country data (so component reads
// return null). Useful as a baseline; individual tests override
// specific keys to exercise component math.
function emptyButReachableReader(): ResilienceSeedReader {
  const presentSeedMetaKeys = new Set([
    'seed-meta:economic:wb-external-debt',
    'seed-meta:economic:bis-lbs',
    'seed-meta:economic:fatf-listing',
  ]);
  return async (key) => {
    if (presentSeedMetaKeys.has(key)) return { fetchedAt: Date.now() };
    if (key === 'economic:wb-external-debt:v1') return reachableDebtEnvelope();
    return null;
  };
}

describe('scoreFinancialSystemExposure — fail-closed preflight', () => {
  it('throws ResilienceConfigurationError when economic:wb-external-debt:v1 seed-meta is missing', async () => {
    const reader: ResilienceSeedReader = async (key) => {
      // Two of three published; WB IDS missing.
      if (key === 'seed-meta:economic:bis-lbs') return { fetchedAt: Date.now() };
      if (key === 'seed-meta:economic:fatf-listing') return { fetchedAt: Date.now() };
      return null;
    };
    await assert.rejects(
      () => scoreFinancialSystemExposure(TEST_ISO2, reader),
      (err: unknown) => {
        if (!(err instanceof ResilienceConfigurationError)) return false;
        return err.missingKeys.includes('economic:wb-external-debt:v1');
      },
      'must throw ResilienceConfigurationError naming the missing seed key',
    );
  });

  it('throws ResilienceConfigurationError when economic:bis-lbs:v1 seed-meta is missing', async () => {
    const reader: ResilienceSeedReader = async (key) => {
      if (key === 'seed-meta:economic:wb-external-debt') return { fetchedAt: Date.now() };
      if (key === 'seed-meta:economic:fatf-listing') return { fetchedAt: Date.now() };
      return null;
    };
    await assert.rejects(
      () => scoreFinancialSystemExposure(TEST_ISO2, reader),
      (err: unknown) => {
        if (!(err instanceof ResilienceConfigurationError)) return false;
        return err.missingKeys.includes('economic:bis-lbs:v1');
      },
    );
  });

  it('throws ResilienceConfigurationError when economic:fatf-listing:v1 seed-meta is missing', async () => {
    const reader: ResilienceSeedReader = async (key) => {
      if (key === 'seed-meta:economic:wb-external-debt') return { fetchedAt: Date.now() };
      if (key === 'seed-meta:economic:bis-lbs') return { fetchedAt: Date.now() };
      return null;
    };
    await assert.rejects(
      () => scoreFinancialSystemExposure(TEST_ISO2, reader),
      (err: unknown) => {
        if (!(err instanceof ResilienceConfigurationError)) return false;
        return err.missingKeys.includes('economic:fatf-listing:v1');
      },
    );
  });

  it('throws ResilienceConfigurationError when required seed-meta status is non-ok', async () => {
    const reader: ResilienceSeedReader = async (key) => {
      if (key === 'seed-meta:economic:wb-external-debt') return { fetchedAt: Date.now(), status: 'ok' };
      if (key === 'seed-meta:economic:bis-lbs') return { fetchedAt: Date.now(), status: 'error' };
      if (key === 'seed-meta:economic:fatf-listing') return { fetchedAt: Date.now(), status: 'ok' };
      return null;
    };
    await assert.rejects(
      () => scoreFinancialSystemExposure(TEST_ISO2, reader),
      (err: unknown) => {
        if (!(err instanceof ResilienceConfigurationError)) return false;
        return err.missingKeys.includes('economic:bis-lbs:v1');
      },
      'must throw ResilienceConfigurationError naming the non-ok seed key',
    );
  });

  it('throws ResilienceConfigurationError when required seed-meta status is explicitly null', async () => {
    const reader: ResilienceSeedReader = async (key) => {
      if (key === 'seed-meta:economic:wb-external-debt') return { fetchedAt: Date.now(), status: 'ok' };
      if (key === 'seed-meta:economic:bis-lbs') return { fetchedAt: Date.now(), status: null };
      if (key === 'seed-meta:economic:fatf-listing') return { fetchedAt: Date.now(), status: 'ok' };
      return null;
    };
    await assert.rejects(
      () => scoreFinancialSystemExposure(TEST_ISO2, reader),
      (err: unknown) => {
        if (!(err instanceof ResilienceConfigurationError)) return false;
        return err.missingKeys.includes('economic:bis-lbs:v1');
      },
      'must reject explicitly present non-ok falsy seed-meta status',
    );
  });

  it('throws ResilienceConfigurationError when required seed-meta is stale', async () => {
    const staleFetchedAt = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const reader: ResilienceSeedReader = async (key) => {
      if (key === 'seed-meta:economic:wb-external-debt') return { fetchedAt: Date.now(), status: 'ok' };
      if (key === 'seed-meta:economic:bis-lbs') return { fetchedAt: Date.now(), status: 'ok' };
      if (key === 'seed-meta:economic:fatf-listing') return { fetchedAt: staleFetchedAt, status: 'ok' };
      return null;
    };
    await assert.rejects(
      () => scoreFinancialSystemExposure(TEST_ISO2, reader),
      (err: unknown) => {
        if (!(err instanceof ResilienceConfigurationError)) return false;
        return err.missingKeys.includes('economic:fatf-listing:v1');
      },
      'must throw ResilienceConfigurationError naming the stale seed key',
    );
  });

  it('ResilienceConfigurationError carries missingKeys array (not undefined) — two-arg constructor', async () => {
    const reader: ResilienceSeedReader = async () => null;
    try {
      await scoreFinancialSystemExposure(TEST_ISO2, reader);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof ResilienceConfigurationError);
      // Codex R3 P1 #2: the downstream scoreAllDimensions catch path calls
      // `err.missingKeys.join(',')` directly. A single-arg throw would set
      // missingKeys=undefined and the source-failure handler would itself
      // throw on `undefined.join`. Pin the array shape.
      assert.ok(Array.isArray(err.missingKeys), 'missingKeys must be an array, not undefined');
      assert.equal(err.missingKeys.length, 3, 'all 3 required keys must be reported when none reachable');
      // Direct call must NOT throw (the error message above proves it works in production).
      assert.doesNotThrow(() => err.missingKeys.join(','));
    }
  });

  it('throws when healthy seed-meta is followed by an absent or malformed WB data envelope', async () => {
    const validNonDrsCountryCodes = [...FINSYS_NON_DRS_COUNTRY_CODES];
    const malformedNonDrsCountryCodes = [...validNonDrsCountryCodes];
    malformedNonDrsCountryCodes[0] = 'bad';
    const duplicateNonDrsCountryCodes = [...validNonDrsCountryCodes];
    duplicateNonDrsCountryCodes[0] = duplicateNonDrsCountryCodes[1];
    for (const debtPayload of [
      null,
      {},
      { schemaVersion: VALID_DEBT_SCHEMA_VERSION, countries: {} },
      { schemaVersion: VALID_DEBT_SCHEMA_VERSION, countries: [], nonDrsCountryCodes: [] },
      {
        schemaVersion: VALID_DEBT_SCHEMA_VERSION,
        countries: { [VALID_DEBT_CONTROL_COUNTRY]: { value: 1, year: 2024 } },
        nonDrsCountryCodes: FINSYS_NON_DRS_COUNTRY_CODES.slice(0, 39),
      },
      {
        schemaVersion: VALID_DEBT_SCHEMA_VERSION,
        countries: { ZZ: { value: 1 } },
        nonDrsCountryCodes: malformedNonDrsCountryCodes,
      },
      {
        schemaVersion: VALID_DEBT_SCHEMA_VERSION,
        countries: { ZZ: { value: 1 } },
        nonDrsCountryCodes: duplicateNonDrsCountryCodes,
      },
    ]) {
      await assert.rejects(
        () => scoreFinancialSystemExposure(TEST_ISO2, readerWithDebtPayload(debtPayload)),
        (err: unknown) => (
          err instanceof ResilienceConfigurationError
          && err.missingKeys.includes('economic:wb-external-debt:v1')
        ),
        'source-level WB data failure must not become a positive per-country imputation',
      );
    }
  });

  it('throws when the WB payload regresses to schema v1 without non-DRS metadata', async () => {
    const reader = readerWithDebtPayload({
      countries: { [VALID_DEBT_CONTROL_COUNTRY]: { value: 1, year: 2024 } },
    });

    await assert.rejects(
      () => scoreFinancialSystemExposure(TEST_ISO2, reader),
      (err: unknown) => (
        err instanceof ResilienceConfigurationError
        && err.missingKeys.includes('economic:wb-external-debt:v1')
        && /schema v2.*nonDrsCountryCodes/.test(err.message)
      ),
      'the active non-DRS path must fail closed when production falls back to schema v1',
    );
  });

  it('throws when an otherwise valid-looking WB payload declares schema v1', async () => {
    const reader = readerWithDebtPayload({
      _seed: {
        fetchedAt: Date.now(),
        recordCount: 1,
        sourceVersion: 'wb-ids-test',
        schemaVersion: 1,
        state: 'OK',
      },
      data: {
        countries: { [VALID_DEBT_CONTROL_COUNTRY]: { value: 1, year: 2024 } },
        nonDrsCountryCodes: FINSYS_NON_DRS_COUNTRY_CODES,
      },
    });

    await assert.rejects(
      () => scoreFinancialSystemExposure(TEST_ISO2, reader),
      (err: unknown) => (
        err instanceof ResilienceConfigurationError
        && err.missingKeys.includes('economic:wb-external-debt:v1')
      ),
      'the scorer must enforce the numeric schema boundary before using the unwrapped payload',
    );
  });
});

describe('scoreFinancialSystemExposure — per-country no-data path (positive control)', () => {
  it('all seed envelopes published but country has no data → score=0, coverage=0 (NOT a config error)', async () => {
    // This is the critical distinction: a country whose BIS LBS / WB IDS
    // data is absent (but envelopes ARE published) gets a per-component
    // null score, NOT a fail-closed throw. weightedBlend collapses all-
    // null inputs to score=0 coverage=0; the dim returns the empty-data
    // shape rather than throwing.
    const reader = emptyButReachableReader();
    const result = await scoreFinancialSystemExposure(TEST_ISO2, reader);
    assert.equal(result.score, 0, 'all-null components must produce score=0 (no impute)');
    assert.equal(result.coverage, 0, 'all-null components must produce coverage=0 (no impute)');
  });
});

describe('scoreFinancialSystemExposure — formula math', () => {
  it('FATF compliant + 0% short-term debt + 25% BIS LBS exposure + 10 redundant parents → score 100', async () => {
    // All 4 components at their best anchors:
    //   short-term debt = 0% GNI       → lowerBetter(0, worst=15, best=0) = 100
    //   BIS LBS         = 25% GDP      → U-shape sweet-spot peak = 100 (75 + (20/20)*25 = 100)
    //   FATF            = compliant    → 100 (discrete)
    //   redundancy      = 10 parents   → higherBetter(10, worst=1, best=10) = 100
    // Total: (100*0.35 + 100*0.30 + 100*0.20 + 100*0.15) / 1.0 = 100.
    const reader: ResilienceSeedReader = async (key) => {
      if (key === 'seed-meta:economic:wb-external-debt') return { fetchedAt: Date.now() };
      if (key === 'seed-meta:economic:bis-lbs') return { fetchedAt: Date.now() };
      if (key === 'seed-meta:economic:fatf-listing') return { fetchedAt: Date.now() };
      if (key === 'economic:wb-external-debt:v1') {
        return { schemaVersion: VALID_DEBT_SCHEMA_VERSION, countries: { [TEST_ISO2]: { value: 0, year: 2024 } }, nonDrsCountryCodes: FINSYS_NON_DRS_COUNTRY_CODES };
      }
      if (key === 'economic:bis-lbs:v1') return { countries: { [TEST_ISO2]: { totalXborderPctGdp: 25, parentCount: 10 } } };
      if (key === 'economic:fatf-listing:v1') return { listings: { [TEST_ISO2]: 'compliant' }, publicationDate: '2026-02-13' };
      return null;
    };
    const result = await scoreFinancialSystemExposure(TEST_ISO2, reader);
    assert.equal(result.score, 100, `best-case must yield 100, got ${result.score}`);
    assert.equal(result.coverage, 1.0, `best-case coverage must be 1.0, got ${result.coverage}`);
  });

  const buildWorstCaseReader = (xborderPct: number): ResilienceSeedReader => async (key) => {
    if (key === 'seed-meta:economic:wb-external-debt') return { fetchedAt: Date.now() };
    if (key === 'seed-meta:economic:bis-lbs') return { fetchedAt: Date.now() };
    if (key === 'seed-meta:economic:fatf-listing') return { fetchedAt: Date.now() };
    if (key === 'economic:wb-external-debt:v1') {
      return { schemaVersion: VALID_DEBT_SCHEMA_VERSION, countries: { [TEST_ISO2]: { value: 15, year: 2024 } }, nonDrsCountryCodes: FINSYS_NON_DRS_COUNTRY_CODES };
    }
    if (key === 'economic:bis-lbs:v1') return { countries: { [TEST_ISO2]: { totalXborderPctGdp: xborderPct, parentCount: 1 } } };
    if (key === 'economic:fatf-listing:v1') return { listings: { [TEST_ISO2]: 'black' }, publicationDate: '2026-02-13' };
    return null;
  };

  it('FATF black list + 15% short-term debt + 0% BIS LBS exposure + 1 parent → true worst case', async () => {
    // #6459 re-anchoring moved the worst case. Component 2's worst reading is
    // now financial ISOLATION (0% cross-border claims), not over-exposure:
    //   short-term debt = 15% GNI      → lowerBetter(15, 0, 15) = 0
    //   BIS LBS         = 0% GDP       → U-shape isolation floor      = 30
    //   FATF            = black        → 0 (discrete)
    //   redundancy      = 1 parent     → higherBetter(1, 1, 10)       = 0
    // Total: (0*0.35 + 30*0.30 + 0*0.20 + 0*0.15) / 1.0 = 9.
    const result = await scoreFinancialSystemExposure(TEST_ISO2, buildWorstCaseReader(0));
    assert.ok(result.score < 10, `worst-case must score < 10, got ${result.score}`);
  });

  it('FATF black list + 15% short-term debt + 100% BIS LBS exposure + 1 parent → floors just above the true worst', async () => {
    // Same country with an over-banked balance sheet instead of a severed
    // one. Pre-#6459 the band decayed to 10 here and this scenario was the
    // "worst case"; the band now floors at 35 because an over-exposed
    // entrepôt still has working correspondent access that a severed state
    // does not: (0*0.35 + 35*0.30 + 0*0.20 + 0*0.15) = 10.5 → 11.
    const overExposed = await scoreFinancialSystemExposure(TEST_ISO2, buildWorstCaseReader(100));
    const isolated = await scoreFinancialSystemExposure(TEST_ISO2, buildWorstCaseReader(0));
    assert.equal(overExposed.score, 11, `over-exposed worst case must score 11, got ${overExposed.score}`);
    assert.ok(
      overExposed.score > isolated.score,
      `over-exposure (${overExposed.score}) must stay above isolation (${isolated.score}) — the inverted ordering is the #6459 defect`,
    );
  });

  it('U-shape is piecewise-CONTINUOUS at 5% and 25% boundaries (Greptile P1 regression guard)', async () => {
    // Greptile flagged a 30-point cliff at the 25% boundary (sweet-spot
    // ended at 100, over-exposed started at 70) in the original draft,
    // plus a 5-point jump at 5%. Cliffs in piecewise-linear scorers
    // cause ranking instability for countries near band edges. Pin
    // continuity at every boundary by sampling values immediately above
    // and below each transition and asserting the score delta is small.
    const buildReader = (xborderPct: number): ResilienceSeedReader => async (key) => {
      if (key === 'seed-meta:economic:wb-external-debt') return { fetchedAt: Date.now() };
      if (key === 'seed-meta:economic:bis-lbs') return { fetchedAt: Date.now() };
      if (key === 'seed-meta:economic:fatf-listing') return { fetchedAt: Date.now() };
      if (key === 'economic:wb-external-debt:v1') return reachableDebtEnvelope();
      if (key === 'economic:bis-lbs:v1') {
        return { countries: { [TEST_ISO2]: { totalXborderPctGdp: xborderPct, parentCount: 5 } } };
      }
      return null;
    };
    const samplePoints = [
      { name: 'just-below 5%', a: 4.99, b: 5.00 },
      { name: 'just-above 5%', a: 5.00, b: 5.01 },
      { name: 'just-below 25%', a: 24.99, b: 25.00 },
      { name: 'just-above 25%', a: 25.00, b: 25.01 },
      { name: 'just-below 60%', a: 59.99, b: 60.00 },
      { name: 'just-above 60%', a: 60.00, b: 60.01 },
      // #6459 added the over-exposure floor at 80%; it is a boundary too.
      { name: 'just-below 80%', a: 79.99, b: 80.00 },
      { name: 'just-above 80%', a: 80.00, b: 80.01 },
    ];
    for (const { name, a, b } of samplePoints) {
      const sa = await scoreFinancialSystemExposure(TEST_ISO2, buildReader(a));
      const sb = await scoreFinancialSystemExposure(TEST_ISO2, buildReader(b));
      const delta = Math.abs(sa.score - sb.score);
      // Tolerance of 1pt allows for rounding (roundScore uses Math.round
      // on each branch independently). Original cliff was 30pts at 25%.
      assert.ok(
        delta <= 1,
        `${name}: score must be continuous across boundary. Got delta=${delta} (a=${a}→${sa.score}, b=${b}→${sb.score})`,
      );
    }
  });

  it('U-shape sanity: BIS LBS at 0% (financial isolation) scores LOWER than at 15% (sweet spot)', async () => {
    // Component 2 standalone test: hold all others null, vary the
    // BIS LBS exposure. The U-shape design penalizes both extremes.
    const buildReader = (xborderPct: number, parentCount: number): ResilienceSeedReader => async (key) => {
      if (key === 'seed-meta:economic:wb-external-debt') return { fetchedAt: Date.now() };
      if (key === 'seed-meta:economic:bis-lbs') return { fetchedAt: Date.now() };
      if (key === 'seed-meta:economic:fatf-listing') return { fetchedAt: Date.now() };
      if (key === 'economic:wb-external-debt:v1') return reachableDebtEnvelope();
      if (key === 'economic:bis-lbs:v1') {
        return {
          countries: {
            [TEST_ISO2]: { totalXborderPctGdp: xborderPct, parentCount },
          },
        };
      }
      return null;
    };
    const isolated = await scoreFinancialSystemExposure(TEST_ISO2, buildReader(0, 1));
    const sweetSpot = await scoreFinancialSystemExposure(TEST_ISO2, buildReader(15, 5));
    const overExposed = await scoreFinancialSystemExposure(TEST_ISO2, buildReader(80, 5));
    assert.ok(
      sweetSpot.score > isolated.score,
      `sweet-spot (${sweetSpot.score}) must beat financial-isolation (${isolated.score})`,
    );
    assert.ok(
      sweetSpot.score > overExposed.score,
      `sweet-spot (${sweetSpot.score}) must beat over-exposed (${overExposed.score})`,
    );
  });

  it('U-shape ASYMMETRY: isolation is the worse extreme, at every over-exposure level (#6459)', () => {
    // The defect this construct shipped with. The band floored 0% claims at
    // 60 while decaying over-integration to 0 at 120% of GDP, so a
    // sanctions-severed balance sheet out-scored a deep one by construction:
    // Russia's 1.45%-of-GDP claims took 64, Luxembourg's 1041% took 0.
    //
    // Tested against `normalizeBandLowerBetter` directly. Driving this
    // through the blended dimension would not isolate the band: any fixture
    // that varies cross-border claims also decides whether the debt slot
    // imputes, so the blend moves for two reasons at once.
    const isolation = normalizeBandLowerBetter(0);

    // Invariant 1: the isolation floor is low in absolute terms.
    assert.equal(isolation, FIN_SYS_BAND_ISOLATION_FLOOR, 'value 0 must sit exactly on the isolation floor');
    assert.ok(isolation <= 40, `isolation floor must be ≤ 40, got ${isolation}`);

    // Invariant 2: isolation is strictly below every other reading of the
    // band, including the deepest over-exposure the data can produce
    // (Luxembourg reported 1041.64% of GDP on 2026-08-11). Densely sampled
    // rather than checked at the endpoints, because a retune that fixes both
    // ends while leaving a dip in the middle is still inverted for whichever
    // countries sit there.
    const samples = [
      0.5, 1, 1.45, 2, 4.9, 5, 10, 15, 25, 26, 40, 43.67, 60, 61, 79.9, 80,
      80.1, 100, 122, 300, 800, 1041.64, 5000,
    ];
    for (const pct of samples) {
      const observed = normalizeBandLowerBetter(pct);
      assert.ok(
        observed > isolation,
        `${pct}% cross-border claims scored ${observed}, at or below the isolation floor ${isolation} — the band is inverted again`,
      );
    }

    // Invariant 3: the over-exposure leg never falls below the isolation
    // floor no matter how extreme the reading. Unbounded decay is exactly
    // what made Luxembourg score 0 and Russia 64.
    assert.ok(
      FIN_SYS_BAND_OVEREXPOSED_FLOOR > FIN_SYS_BAND_ISOLATION_FLOOR,
      'the over-exposure floor must sit above the isolation floor',
    );
    assert.equal(normalizeBandLowerBetter(1e9), FIN_SYS_BAND_OVEREXPOSED_FLOOR, 'over-exposure must asymptote to its floor');

    // Invariant 4: every sweet-spot value beats both extremes.
    for (const pct of [5, 10, 15, 20, 25]) {
      const sweet = normalizeBandLowerBetter(pct);
      assert.ok(sweet > isolation, `sweet-spot ${pct}% (${sweet}) must beat isolation (${isolation})`);
      assert.ok(
        sweet > FIN_SYS_BAND_OVEREXPOSED_FLOOR,
        `sweet-spot ${pct}% (${sweet}) must beat the over-exposure floor (${FIN_SYS_BAND_OVEREXPOSED_FLOOR})`,
      );
    }
  });

  it('U-shape rejects malformed and negative readings without inventing a floor', () => {
    // A negative or non-finite claims ratio is upstream corruption, not
    // isolation. It must NOT resolve to the isolation floor, which would
    // make a parser regression look like a sanctions verdict.
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(normalizeBandLowerBetter(bad), 50, `malformed reading ${bad} must fall back to the neutral 50`);
    }
  });

  it('diversity conditioning: the premium above 75 is earned in proportion to parent breadth', () => {
    // The Albania defect: 17.6% of GDP through TWO parents took the raw
    // band's 91 — a "healthy diversified" premium with no diversity
    // evidence — while the construct's own redundancy component scored the
    // same fact 11/100. Tested against the exported function directly, for
    // the same reason as the U-shape invariants above: through the blend a
    // fixture that varies the band also moves the debt slot.

    // Invariant 1: everything at or below the 75 boundary is untouched at
    // EVERY parent count — both floors and the deep over-exposure legs are
    // not this conditioning's business.
    let belowBoundarySamples = 0;
    for (const pct of [0, 1.45, 4.9, 43.67, 60, 80, 122, 1041.64]) {
      const raw = normalizeBandLowerBetter(pct);
      if (raw > 75) continue;
      belowBoundarySamples++;
      for (const parents of [null, 0, 1, 2, 5, 10, 14]) {
        assert.equal(
          normalizeDiversityConditionedBand(pct, parents),
          raw,
          `${pct}% (raw ${raw} ≤ 75) must be unchanged at parents=${parents}`,
        );
      }
    }
    // The `continue` above skips samples the band moved above 75. If a future
    // retune lifted ALL of them, this invariant would pass while asserting
    // nothing — the exact vacuity the #6459 lesson was about.
    assert.ok(
      belowBoundarySamples >= 4,
      `only ${belowBoundarySamples} sampled readings landed at or below the boundary — `
        + 're-anchor the sample set, this invariant is going vacuous',
    );

    // Invariant 2: full breadth (parents ≥ 10, the redundancy transform's
    // best goalpost) earns the full raw premium everywhere.
    for (const pct of [5, 10, 17.6, 25, 31.62, 40]) {
      assert.equal(
        normalizeDiversityConditionedBand(pct, 10),
        normalizeBandLowerBetter(pct),
        `${pct}% at 10 parents must equal the raw band`,
      );
    }

    // Invariant 3: one parent or none — or a BIS row whose count failed to
    // parse (null) — earns NO premium: the band caps at the 75 boundary.
    // Absence of diversity evidence is not diversity.
    for (const parents of [null, 0, 1]) {
      for (const pct of [10, 17.6, 25, 31.62]) {
        assert.equal(
          normalizeDiversityConditionedBand(pct, parents),
          75,
          `${pct}% at parents=${parents} must cap at the 75 boundary`,
        );
      }
    }

    // Invariant 4: monotone in parents — more breadth never lowers the band.
    for (const pct of [10, 17.6, 25]) {
      let prev = -1;
      for (let parents = 0; parents <= 14; parents++) {
        const observed = normalizeDiversityConditionedBand(pct, parents);
        assert.ok(
          observed >= prev,
          `${pct}% must be monotone in parents (parents=${parents}: ${observed} < ${prev})`,
        );
        prev = observed;
      }
    }

    // Invariant 5: continuity in claims survives the conditioning — the #6459
    // P1 cliff must not be reintroduced by the premium scaling.
    //
    // The named anchors sit at the ROUNDED band's real 75-crossings, 5.4%
    // rising and 40.59% falling. The unrounded 5%/40.9% figures are the wrong
    // probe points: the rounded band takes the SAME value on both sides of each
    // of them, so a ±0.05 probe there compares a value to itself and cannot
    // fail whatever the transform does. The parent count matters for the same
    // reason — at parents ≤ 5 the premium is compressed hard enough that both
    // samples still round together, so the probe only becomes discriminating
    // once the premium term is live. `assert.notEqual` pins that: if a future
    // retune flattens the crossing, this anchor fails loudly instead of
    // quietly reverting to a self-comparison.
    for (const boundary of [5.4, 40.59]) {
      const below = normalizeDiversityConditionedBand(boundary - 0.05, 10);
      const above = normalizeDiversityConditionedBand(boundary + 0.05, 10);
      assert.ok(
        Math.abs(above - below) <= 1,
        `discontinuity at the ${boundary}% crossing (${below} → ${above})`,
      );
      assert.notEqual(
        below,
        above,
        `the ${boundary}% anchor went flat (${below} on both sides) — it can no longer `
          + 'detect a cliff; re-derive the crossing from the rounded band',
      );
    }
    // The 25% peak is genuinely flat on both sides at every parent count (it is
    // a maximum, not a crossing), so it is asserted as flat rather than as a
    // discriminating probe.
    for (const parents of [2, 5, 10]) {
      assert.equal(
        normalizeDiversityConditionedBand(25 - 0.05, parents),
        normalizeDiversityConditionedBand(25 + 0.05, parents),
        `parents=${parents}: the 25% peak must be flat, not a step`,
      );
    }

    // Dense sweep, with a bound per region instead of one loose bound for all
    // of them. The isolation leg legitimately climbs 9 points per 1% of GDP, so
    // at 0.25% sampling it steps up to 3 — a uniform `<= 3` therefore constrains
    // nothing in the premium region, where the true maximum is 1. Sweeping past
    // 80% also carries it over the over-exposure floor knee, which the previous
    // 70% ceiling never reached.
    for (const parents of [null, 0, 1, 2, 5, 9, 10, 16]) {
      let prev = normalizeDiversityConditionedBand(0, parents);
      let maxStep = 0;
      for (let pct = 0.25; pct <= 130; pct += 0.25) {
        const observed = normalizeDiversityConditionedBand(pct, parents);
        const step = Math.abs(observed - prev);
        maxStep = Math.max(maxStep, step);
        const bound = pct <= 5 ? 3 : 1;
        assert.ok(
          step <= bound,
          `parents=${parents}: ${(observed - prev > 0 ? '+' : '')}${observed - prev}-point cliff `
            + `between ${(pct - 0.25).toFixed(2)}% and ${pct.toFixed(2)}% (${prev} → ${observed}), `
            + `bound ${bound}`,
        );
        prev = observed;
      }
      // Non-vacuity: a transform that returned a constant would sail through
      // the step bound above.
      assert.ok(maxStep > 0, `parents=${parents}: the band never moved across the sweep`);
    }

    // The concrete production anchor: Albania's exact reading. Raw band 91;
    // at 2 parents the premium scales by 11% → 77.
    assert.equal(normalizeBandLowerBetter(17.6), 91);
    assert.equal(normalizeDiversityConditionedBand(17.6, 2), 77);
  });

  it('a non-finite parent count neutralises the premium instead of falling through NaN', () => {
    // `normalizeHigherBetter` returns NaN for a non-finite count and
    // `roundScore(NaN)` is 0 — which would drop a premium-region country
    // BELOW the isolation floor (30) and re-invert the exact ranking this
    // function exists to fix. The sibling band neutralises malformed input
    // the same way rather than inventing a floor.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const observed = normalizeDiversityConditionedBand(17.6, bad);
      assert.equal(
        observed,
        75,
        `parentCount ${String(bad)} must cap at the premium floor, not fall through to ${observed}`,
      );
      assert.ok(
        observed > FIN_SYS_BAND_ISOLATION_FLOOR,
        `parentCount ${String(bad)} must never score below the isolation floor`,
      );
    }
  });
});

describe('scoreFinancialSystemExposure — the blend consumes the CONDITIONED band', () => {
  it('pins a country where conditioning moves the published score', async () => {
    // Wiring guard. The unit invariants above test the transform in
    // isolation, and the matched pairs catch a revert to the raw band — but
    // only via Albania, whose two readings round to the same 70 under some
    // mutations. Pin a country whose rounded dimension score DIFFERS between
    // the raw and conditioned bands, so the call site is pinned in both
    // directions rather than only against full reversion.
    //
    // US: claims 31.62% of GDP through 8 parents. Raw band 90; conditioned
    // 75 + 15 x 0.78 = 87. That 3-point band difference survives the blend.
    const reader = createFinSysFixtureReader();
    const us = await scoreFinancialSystemExposure('US', reader);

    assert.equal(normalizeBandLowerBetter(31.62), 90, 'raw band anchor');
    assert.equal(normalizeDiversityConditionedBand(31.62, 8), 87, 'conditioned band anchor');
    assert.equal(
      us.score,
      84,
      'the US dimension score must reflect the conditioned band (87), not the raw band (90)',
    );
  });
});

describe('scoreFinancialSystemExposure — the band slot reports its own certainty', () => {
  // Every other invariant in this file asserts on `.score`. These assert on
  // `.coverage`, which is the field that says whether the published band was a
  // redundancy-scaled READING or a floor substituted for absent evidence.
  const AL_CLAIMS = FINSYS_BIS_FIXTURE.AL.totalXborderPctGdp;

  it('withholding the premium for an absent parentCount reduces coverage, not just the score', async () => {
    const honest = await scoreFinancialSystemExposure('AL', createFinSysFixtureReader());
    const breadthAbsent = await scoreFinancialSystemExposure(
      'AL',
      createFinSysFixtureReader({
        bis: { AL: { totalXborderPctGdp: AL_CLAIMS, parentCount: null as unknown as number } },
      }),
    );

    // The band leg is still scored (the level resolved), so this is NOT the
    // slot dropping out — it is the slot resolving half-observed.
    assert.ok(
      breadthAbsent.coverage < honest.coverage,
      `absent breadth must lower coverage (honest ${honest.coverage}, absent ${breadthAbsent.coverage})`,
    );
    // Non-vacuity: the drop must exceed what Component 4 alone (0.15) explains,
    // otherwise this passes on the pre-existing sibling drop and says nothing
    // about the band slot's own certainty.
    const componentFourOnly = honest.coverage - 0.15;
    assert.ok(
      breadthAbsent.coverage < componentFourOnly,
      `coverage ${breadthAbsent.coverage} must fall below ${componentFourOnly.toFixed(2)} — the `
        + 'band slot has to report its own reduced certainty, not merely inherit Component 4 dropping',
    );
  });

  it('an OBSERVED parentCount of 0 is distinguished from a malformed one', async () => {
    // 0 means "no parent clears the 1%-of-GDP threshold" — an observation, not
    // an absence. Both withhold the whole premium, so the BAND leg is identical:
    assert.equal(normalizeDiversityConditionedBand(AL_CLAIMS, 0), 75);
    assert.equal(normalizeDiversityConditionedBand(AL_CLAIMS, null), 75);

    const observedZero = await scoreFinancialSystemExposure(
      'AL',
      createFinSysFixtureReader({ bis: { AL: { totalXborderPctGdp: AL_CLAIMS, parentCount: 0 } } }),
    );
    const malformedBreadth = await scoreFinancialSystemExposure(
      'AL',
      createFinSysFixtureReader({
        bis: { AL: { totalXborderPctGdp: AL_CLAIMS, parentCount: String(FINSYS_BIS_FIXTURE.AL.parentCount) as unknown as number } },
      }),
    );

    assert.ok(
      observedZero.coverage > malformedBreadth.coverage,
      `an observed 0 must report higher coverage than a malformed count `
        + `(observed ${observedZero.coverage}, malformed ${malformedBreadth.coverage})`,
    );

    // A malformed count must not score higher than an observed zero. The failed
    // slot retains its design weight in the fixed blend and contributes no
    // score, while the observed zero contributes an explicit zero at that same
    // weight. This is the #6528 contract at the real scorer seam.
    assert.ok(
      malformedBreadth.score <= observedZero.score,
      'a malformed count must not outrank an observed zero '
        + `(malformed ${malformedBreadth.score}, observed-zero ${observedZero.score})`,
    );
  });

  it('an implausible parentCount reads as absent instead of as demonstrated breadth', async () => {
    // A payload carrying an out-of-range or fractional count used to clamp to
    // redundancy 100 and earn BOTH the full premium (0.30) and a perfect
    // Component 4 (0.15) — 0.45 of the dimension bought by a corrupt field.
    const honest = await scoreFinancialSystemExposure('AL', createFinSysFixtureReader());
    const malformedBreadth = await scoreFinancialSystemExposure(
      'AL',
      createFinSysFixtureReader({
        bis: { AL: { totalXborderPctGdp: AL_CLAIMS, parentCount: String(FINSYS_BIS_FIXTURE.AL.parentCount) as unknown as number } },
      }),
    );
    // What a TRUSTED implausible count would have scored: an out-of-range count
    // clamps the redundancy scale to its best goalpost, so the band takes its
    // full raw premium AND Component 4 reads 100. This is the pre-fix behaviour,
    // kept as the thing the fix has to beat.
    const trustedBogus = blendFinSys(
      normalizeBandLowerBetter(AL_CLAIMS),
      FIN_SYS_REDUNDANCY_BEST_PARENTS,
    );

    for (const bogus of [500, -3, 2.5]) {
      const corrupt = await scoreFinancialSystemExposure(
        'AL',
        createFinSysFixtureReader({
          bis: { AL: { totalXborderPctGdp: AL_CLAIMS, parentCount: bogus } },
        }),
      );
      assert.equal(
        corrupt.score,
        malformedBreadth.score,
        `parentCount=${bogus} must score exactly like an absent count`,
      );
      assert.ok(
        corrupt.score < trustedBogus,
        `parentCount=${bogus} must score below the ${trustedBogus} a trusted bogus count would `
          + `have earned (got ${corrupt.score})`,
      );
      assert.ok(
        corrupt.coverage < honest.coverage,
        `parentCount=${bogus} must lower coverage (${corrupt.coverage} vs ${honest.coverage})`,
      );
    }

    // A corrupt count must not raise the honest dimension score. The fixed
    // blend keeps the missing slot in the denominator with a zero contribution,
    // so the data-quality regression cannot buy resilience.
    assert.ok(
      malformedBreadth.score <= honest.score,
      `corrupt parentCount must not raise the honest score (honest ${honest.score}, corrupt ${malformedBreadth.score})`,
    );
  });

  it('an incomplete BIS reporting-parent set lowers certainty on both BIS slots', async () => {
    // seed-bis-lbs tolerates 12 of 16 parent fetches; a missing feed silently
    // undercounts parentCount for every country. That now moves the 0.30 band
    // slot as well as the 0.15 redundancy slot, so it must surface as reduced
    // certainty rather than passing as an observation.
    const complete = await scoreFinancialSystemExposure('AL', createFinSysFixtureReader());
    const degraded = await scoreFinancialSystemExposure(
      'AL',
      createFinSysFixtureReader({ bisEnvelope: { successfulParents: 12, parentCountries: 16 } }),
    );
    assert.equal(degraded.score, complete.score, 'certainty is a coverage signal, not a score change');
    assert.ok(
      degraded.coverage < complete.coverage,
      `a degraded parent set must lower coverage (complete ${complete.coverage}, degraded ${degraded.coverage})`,
    );
  });
});

describe('scoreFinancialSystemExposure — half-parsed BIS row', () => {
  it('does not let a malformed claims field raise the published score', async () => {
    const real = FINSYS_BIS_FIXTURE.AL;
    const honest = await scoreFinancialSystemExposure('AL', createFinSysFixtureReader());
    const malformedClaims = [
      ['string', String(real.totalXborderPctGdp) as unknown as number],
      ['negative', -1],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
    ] as const;

    for (const [label, totalXborderPctGdp] of malformedClaims) {
      const result = await scoreFinancialSystemExposure(
        'AL',
        createFinSysFixtureReader({ bis: { AL: { ...real, totalXborderPctGdp } } }),
      );

      // A present-but-invalid claims field is a retained zero at the 0.30
      // band weight. The mirror uses a null band to model the parser result
      // and keeps the fixed denominator, so this checks reader-to-blend wiring
      // rather than only checking that the score moves in the safe direction.
      assert.equal(
        blendFinSys(null, real.parentCount),
        result.score,
        `${label} claims must retain the band weight as a zero fallback`,
      );
      assert.ok(
        result.score <= honest.score,
        `${label} claims must not raise the honest score (honest ${honest.score}, corrupt ${result.score})`,
      );
      assert.ok(
        result.coverage < honest.coverage,
        `${label} claims must lower coverage (honest ${honest.coverage}, corrupt ${result.coverage})`,
      );
    }
  });

  it('does not let a malformed parentCount raise the published score', async () => {
    // A `parentCount` that fails to parse nulls the Component 4 slot. Before
    // #6528, `weightedBlend` renormalised the freed 0.15 onto the survivors and
    // Albania rose from 70 to 80. `readBisLbsCountry` requires a raw number, so
    // a seeder publishing the count as a string is exactly this corruption.
    //
    // This is a property of the blend and PREDATES the diversity conditioning
    // — against the raw band the same measurement is 74 -> 86. The reader now
    // distinguishes this malformed field from a genuinely absent one, and the
    // blend retains its weight with a conservative fallback. The conditioning
    // arithmetic and coverage signal must remain unchanged.
    const real = FINSYS_BIS_FIXTURE.AL;
    const honest = await scoreFinancialSystemExposure('AL', createFinSysFixtureReader());
    const halfParsed = await scoreFinancialSystemExposure(
      'AL',
      createFinSysFixtureReader({
        bis: { AL: { ...real, parentCount: String(real.parentCount) as unknown as number } },
      }),
    );

    const conditionedInflation = halfParsed.score - honest.score;

    // MIRROR FIDELITY. Feed the mirror the CONDITIONED band (the leg the live
    // scorer actually consumes) and it must land on the real scorer's number,
    // in both the honest and malformed states. If the weights, the debt
    // transform, or the missing-slot policy drift apart, this fails instead of
    // the baseline quietly going wrong.
    assert.equal(
      blendFinSys(normalizeDiversityConditionedBand(real.totalXborderPctGdp, real.parentCount), real.parentCount),
      honest.score,
      'blendFinSys no longer reproduces the real scorer on the honest payload',
    );
    assert.equal(
      blendFinSys(normalizeDiversityConditionedBand(real.totalXborderPctGdp, null), null),
      halfParsed.score,
      'blendFinSys no longer reproduces the real scorer on the half-parsed payload',
    );

    // The same country, same corruption, scored on the UNCONDITIONED band with
    // the pre-fix arithmetic — the inflation this construct inherited rather
    // than introduced.
    const rawHonest = blendFinSys(
      normalizeBandLowerBetter(real.totalXborderPctGdp),
      real.parentCount,
      { preFixRenormalization: true },
    );
    const rawHalfParsed = blendFinSys(
      normalizeBandLowerBetter(real.totalXborderPctGdp),
      null,
      { preFixRenormalization: true },
    );
    const inheritedInflation = rawHalfParsed - rawHonest;

    assert.ok(
      conditionedInflation <= 0,
      `the real blend must not inflate on a half-parsed row (honest ${honest.score}, half-parsed ${halfParsed.score})`,
    );
    // Guard integrity: the old counterfactual must still demonstrate the
    // defect this regression test protects against. If this turns non-positive
    // the fixture or its pre-fix mirror was neutered.
    assert.ok(
      inheritedInflation > 0,
      'pre-fix mirror integrity: the unconditioned baseline stopped inflating, '
        + 'so the fixture or counterfactual no longer models the old path',
    );
  });

  it('FATF empty listings dict (parser regression) does NOT default every country to compliant', async () => {
    // Greptile P2 regression guard (PR #3407 review). A malformed seed
    // with `listings: {}` that bypassed validate would otherwise score
    // every country at 100 (compliant default) — silently masking a
    // parser bug. Defense-in-depth: empty listings → null component
    // score → slot drops out of the blend. Visible coverage shrink
    // rather than invisible all-pass.
    const reader: ResilienceSeedReader = async (key) => {
      if (key === 'seed-meta:economic:wb-external-debt') return { fetchedAt: Date.now() };
      if (key === 'seed-meta:economic:bis-lbs') return { fetchedAt: Date.now() };
      if (key === 'seed-meta:economic:fatf-listing') return { fetchedAt: Date.now() };
      if (key === 'economic:wb-external-debt:v1') return reachableDebtEnvelope();
      if (key === 'economic:fatf-listing:v1') {
        return { listings: {}, publicationDate: '2026-02-13' };
      }
      return null;
    };
    const result = await scoreFinancialSystemExposure(TEST_ISO2, reader);
    // All 4 components null → coverage 0. Critically, the test asserts
    // we do NOT get score=100 (which is what an all-compliant default
    // would produce against weight 0.20 if the other slots null out).
    assert.equal(result.coverage, 0, 'empty FATF listings + null other components must yield coverage=0');
    assert.notEqual(result.score, 100, 'empty FATF listings must NOT score 100 via the compliant-default fall-through');
  });

  it('FATF discrete mapping: black=0, gray=55, compliant=100', async () => {
    const buildReader = (status: 'black' | 'gray' | 'compliant'): ResilienceSeedReader => async (key) => {
      if (key === 'seed-meta:economic:wb-external-debt') return { fetchedAt: Date.now() };
      if (key === 'seed-meta:economic:bis-lbs') return { fetchedAt: Date.now() };
      if (key === 'seed-meta:economic:fatf-listing') return { fetchedAt: Date.now() };
      if (key === 'economic:wb-external-debt:v1') return reachableDebtEnvelope();
      if (key === 'economic:fatf-listing:v1') {
        return { listings: { [TEST_ISO2]: status }, publicationDate: '2026-02-13' };
      }
      return null;
    };
    // Only FATF observed; weight 0.20 → score equals the FATF anchor.
    const black = await scoreFinancialSystemExposure(TEST_ISO2, buildReader('black'));
    const gray = await scoreFinancialSystemExposure(TEST_ISO2, buildReader('gray'));
    const compliant = await scoreFinancialSystemExposure(TEST_ISO2, buildReader('compliant'));
    assert.equal(black.score, 0, 'FATF black list anchors at 0');
    // #6459: rescaled 30 → 55. Grey-listing is "increased monitoring under an
    // agreed action plan", not a step below the call-for-action black list.
    // At 30 an ordinary remediating economy scored closer to Iran than to its
    // peers, which is what pushed Monaco (grey, FATF-only coverage) down.
    assert.equal(gray.score, 55, 'FATF gray list anchors at 55');
    assert.equal(compliant.score, 100, 'FATF compliant anchors at 100');
  });
});

describe('scoreFinancialSystemExposure — comprehensive-embargo cap (#6459)', () => {
  const bestCaseReader = (iso2: string): ResilienceSeedReader => async (key) => {
    if (key.startsWith('seed-meta:')) return { status: 'ok', fetchedAt: Date.now() };
    if (key === 'economic:wb-external-debt:v1') {
      return { schemaVersion: VALID_DEBT_SCHEMA_VERSION, countries: { [iso2]: { value: 0, year: 2024 } }, nonDrsCountryCodes: FINSYS_NON_DRS_COUNTRY_CODES };
    }
    if (key === 'economic:bis-lbs:v1') return { countries: { [iso2]: { totalXborderPctGdp: 25, parentCount: 10 } } };
    if (key === 'economic:fatf-listing:v1') {
      return { listings: { IR: 'black', KP: 'black' }, publicationDate: '2026-06-01' };
    }
    return null;
  };

  it('caps an embargoed jurisdiction even when every component reads perfect', async () => {
    // The construct's failure mode was reading severance as strength, so the
    // cap is tested at the point where the graded components are maximally
    // wrong: an embargoed country whose four slots all anchor at 100.
    for (const iso2 of FIN_SYS_EXPOSURE_COMPREHENSIVE_EMBARGO) {
      const result = await scoreFinancialSystemExposure(iso2, bestCaseReader(iso2));
      assert.equal(result.score, 15, `${iso2} must stay pinned to the audited embargo cap`);
    }
  });

  it('leaves non-embargoed jurisdictions untouched', async () => {
    // Negative control. Without it the cap could be applied to everyone and
    // the anchor gate would still pass.
    assert.ok(!FIN_SYS_EXPOSURE_COMPREHENSIVE_EMBARGO.has(TEST_ISO2), 'test ISO2 must not be on the list');
    const result = await scoreFinancialSystemExposure(TEST_ISO2, bestCaseReader(TEST_ISO2));
    assert.equal(result.score, 100, `non-embargoed best case must be untouched, got ${result.score}`);
  });

  it('does not cap Syria after the comprehensive program was revoked', async () => {
    assert.equal(FIN_SYS_EXPOSURE_COMPREHENSIVE_EMBARGO.has('SY'), false);
    const result = await scoreFinancialSystemExposure('SY', bestCaseReader('SY'));
    assert.equal(result.score, 100, 'SY must follow the observed components, not the revoked static cap');
  });

  it('forces the static embargo policy through a bounded review window', () => {
    const reviewedAt = Date.parse(`${FIN_SYS_EXPOSURE_EMBARGO_POLICY_REVIEWED_ON}T00:00:00Z`);
    assert.ok(Number.isFinite(reviewedAt), 'policy review date must be a valid ISO date');
    const ageDays = (Date.now() - reviewedAt) / (24 * 60 * 60 * 1000);
    assert.ok(ageDays >= 0, 'policy review date must not be in the future');
    assert.ok(
      ageDays <= FIN_SYS_EXPOSURE_EMBARGO_POLICY_MAX_AGE_DAYS,
      `embargo policy was last reviewed ${Math.floor(ageDays)} days ago; re-check every entry against primary sources`,
    );
  });

  it('is a cap, not an assignment — a worse embargoed country keeps its lower score', async () => {
    // DPRK is FATF black-listed with no other resolving slot, so it must stay
    // at 0 rather than being raised to the cap.
    const reader: ResilienceSeedReader = async (key) => {
      if (key.startsWith('seed-meta:')) return { status: 'ok', fetchedAt: Date.now() };
      if (key === 'economic:wb-external-debt:v1') return reachableDebtEnvelope(['KP']);
      if (key === 'economic:fatf-listing:v1') {
        return { listings: { KP: 'black', IR: 'black', MM: 'black' }, publicationDate: '2026-06-01' };
      }
      return null;
    };
    const kp = await scoreFinancialSystemExposure('KP', reader);
    assert.equal(kp.score, 0, `KP must keep its 0, not be lifted to the cap; got ${kp.score}`);
  });

  it('does not alter coverage or imputation provenance', async () => {
    // The cap is post-blend by design: an operator inspecting a capped
    // country must still see which components actually resolved. If the cap
    // zeroed coverage the dimension would look like a data outage instead of
    // a construct verdict.
    const capped = await scoreFinancialSystemExposure('RU', bestCaseReader('RU'));
    const uncapped = await scoreFinancialSystemExposure(TEST_ISO2, bestCaseReader(TEST_ISO2));
    assert.equal(capped.coverage, uncapped.coverage, 'cap must not change coverage');
    assert.equal(capped.observedWeight, uncapped.observedWeight, 'cap must not change observedWeight');
    assert.equal(capped.imputationClass, uncapped.imputationClass, 'cap must not change imputationClass');
  });

  it('is case-insensitive on the country code', async () => {
    const lower = await scoreFinancialSystemExposure('ru', bestCaseReader('ru'));
    assert.equal(lower.score, 15, `lowercase iso2 must still hit the audited cap, got ${lower.score}`);
  });
});

describe('scoreFinancialSystemExposure — non-DRS short-term-debt slot (#6459)', () => {
  const reader = (opts: { debtRow: boolean; bisRow: boolean; confirmedNonDrs?: boolean }): ResilienceSeedReader => async (key) => {
    if (key.startsWith('seed-meta:')) return { status: 'ok', fetchedAt: Date.now() };
    if (key === 'economic:wb-external-debt:v1') {
      return opts.debtRow
        ? { schemaVersion: VALID_DEBT_SCHEMA_VERSION, countries: { [TEST_ISO2]: { value: 0, year: 2024 } }, nonDrsCountryCodes: FINSYS_NON_DRS_COUNTRY_CODES }
        : reachableDebtEnvelope(opts.confirmedNonDrs ? [TEST_ISO2] : []);
    }
    if (key === 'economic:bis-lbs:v1') {
      return { countries: opts.bisRow ? { [TEST_ISO2]: { totalXborderPctGdp: 300, parentCount: 10 } } : {} };
    }
    if (key === 'economic:fatf-listing:v1') {
      return { listings: { IR: 'black', KP: 'black' }, publicationDate: '2026-06-01' };
    }
    return null;
  };

  it('no DRS row + BIS row → imputes the slot instead of renormalizing onto the band leg', async () => {
    // The Luxembourg shape. Dropping the 0.35 slot pushed the punitive band
    // leg from 30% to 46% of the score, so a deep financial centre was scored
    // almost entirely on "your banks are too integrated".
    //   imputed debt 75 x0.35 + band(300%)=35 x0.30 + compliant 100 x0.20
    //   + parents 10 → 100 x0.15 = 71.75 → 72
    const result = await scoreFinancialSystemExposure(
      TEST_ISO2,
      reader({ debtRow: false, bisRow: true, confirmedNonDrs: true }),
    );
    assert.equal(result.score, 72, `expected the imputed-slot blend, got ${result.score}`);
    assert.ok(result.imputedWeight > 0, 'the imputed slot must be reported as imputed weight');
    assert.ok(result.coverage < 1, 'coverage must stay below 1 — the reading is inferred, not observed');
    assert.ok(result.coverage > 0.7, `coverage must still reflect three observed slots, got ${result.coverage}`);
  });

  it('no DRS row + no BIS row → slot stays null (genuine data desert)', async () => {
    // Cuba / DPRK shape. Absence from BOTH sources is not evidence that
    // short-term external debt is not applicable, so the slot must drop.
    const result = await scoreFinancialSystemExposure(
      TEST_ISO2,
      reader({ debtRow: false, bisRow: false, confirmedNonDrs: true }),
    );
    assert.equal(result.coverage, 0, `compliant-by-absence must also drop for a genuine data desert, got coverage ${result.coverage}`);
    assert.equal(result.score, 0, 'absence from all three sources must not publish a resilience score');
    assert.equal(result.imputedWeight, 0, 'no BIS row means no imputation');
  });

  it('DRS row present → real value wins over the imputation', async () => {
    const result = await scoreFinancialSystemExposure(TEST_ISO2, reader({ debtRow: true, bisRow: true }));
    assert.equal(result.imputedWeight, 0, 'a real DRS reading must not be replaced by the imputation');
    assert.equal(result.coverage, 1, 'all four slots observed');
  });

  it('missing borrower row + BIS row stays null instead of receiving a positive imputation', async () => {
    const result = await scoreFinancialSystemExposure(
      TEST_ISO2,
      reader({ debtRow: false, bisRow: true, confirmedNonDrs: false }),
    );
    assert.equal(result.imputedWeight, 0, 'row absence alone must not imply that debt is not applicable');
    assert.equal(result.observedWeight, 0.65, 'only the two BIS slots and FATF slot may resolve');
  });

  it('a BIS row with no parseable field does not trigger the imputation', async () => {
    const corrupt: ResilienceSeedReader = async (key) => {
      if (key.startsWith('seed-meta:')) return { status: 'ok', fetchedAt: Date.now() };
      if (key === 'economic:wb-external-debt:v1') return reachableDebtEnvelope([TEST_ISO2]);
      if (key === 'economic:bis-lbs:v1') return { countries: { [TEST_ISO2]: { note: 'corrupt' } } };
      if (key === 'economic:fatf-listing:v1') {
        return { listings: { IR: 'black', KP: 'black' }, publicationDate: '2026-06-01' };
      }
      return null;
    };
    const result = await scoreFinancialSystemExposure(TEST_ISO2, corrupt);
    assert.equal(result.imputedWeight, 0, 'a corrupt BIS row is not evidence of cross-border participation');
    assert.equal(result.coverage, 0, `a corrupt BIS row must not make compliant-by-absence resolve, got coverage ${result.coverage}`);
  });
});

describe('scoreFinancialSystemExposure — market-access-constrained debt certainty (#6461)', () => {
  const reader = (values: { debtPct: number; claimsPctGdp: unknown; parentCount: unknown }): ResilienceSeedReader =>
    async (key) => {
      if (key.startsWith('seed-meta:')) return { status: 'ok', fetchedAt: Date.now() };
      if (key === 'economic:wb-external-debt:v1') {
        return {
          schemaVersion: VALID_DEBT_SCHEMA_VERSION,
          countries: { [TEST_ISO2]: { value: values.debtPct, year: 2024 } },
          nonDrsCountryCodes: FINSYS_NON_DRS_COUNTRY_CODES,
        };
      }
      if (key === 'economic:bis-lbs:v1') {
        return { countries: { [TEST_ISO2]: { totalXborderPctGdp: values.claimsPctGdp, parentCount: values.parentCount } } };
      }
      if (key === 'economic:fatf-listing:v1') {
        return { listings: { IR: 'black', KP: 'black' }, publicationDate: '2026-06-01' };
      }
      return null;
    };

  it('reduces score weight and coverage only when all three constraint signals hold', async () => {
    const result = await scoreFinancialSystemExposure(
      TEST_ISO2,
      reader({
        debtPct: FIN_SYS_MARKET_ACCESS_LOW_DEBT_PCT_GNI_MAX,
        claimsPctGdp: FIN_SYS_MARKET_ACCESS_LOW_CLAIMS_PCT_GDP_MAX - 0.01,
        parentCount: 0,
      }),
    );

    assert.equal(result.coverage, 0.76, 'the debt slot must report its attenuated certainty against nominal weight');
    assert.equal(result.observedWeight, 0.755, 'the observed runtime weight must match the pinned attenuation applied to scoring');
  });

  it('treats a missing or malformed parent count as unknown rather than observed zero', async () => {
    for (const parentCount of [null, '']) {
      const result = await scoreFinancialSystemExposure(
        TEST_ISO2,
        reader({ debtPct: 0.1, claimsPctGdp: 1, parentCount }),
      );

      assert.equal(result.coverage, 0.85, 'a corrupt parent count must drop its own slot without attenuating the debt observation');
      assert.equal(result.observedWeight, 0.85, 'unknown parent count must not masquerade as the observed zero-parent signal');
    }
  });

  it('treats missing or malformed claims as unknown rather than observed zero', async () => {
    for (const claimsPctGdp of [null, '']) {
      const result = await scoreFinancialSystemExposure(
        TEST_ISO2,
        reader({ debtPct: 0.1, claimsPctGdp, parentCount: 0 }),
      );

      assert.equal(result.coverage, 0.7, 'corrupt claims must drop their own slot without attenuating the debt observation');
      assert.equal(result.observedWeight, 0.7, 'unknown claims must not masquerade as the observed low-claims signal');
    }
  });

  it('keeps full debt confidence when any market-access signal clears its boundary', async () => {
    const controls = [
      reader({ debtPct: FIN_SYS_MARKET_ACCESS_LOW_DEBT_PCT_GNI_MAX + 0.01, claimsPctGdp: 1, parentCount: 0 }),
      reader({ debtPct: 0.1, claimsPctGdp: FIN_SYS_MARKET_ACCESS_LOW_CLAIMS_PCT_GDP_MAX, parentCount: 0 }),
      reader({ debtPct: 0.1, claimsPctGdp: 1, parentCount: 1 }),
    ];

    for (const control of controls) {
      const result = await scoreFinancialSystemExposure(TEST_ISO2, control);
      assert.equal(result.coverage, 1, 'a country outside the three-signal intersection must retain full observed coverage');
      assert.equal(result.observedWeight, 1, 'a country outside the three-signal intersection must retain all nominal score weight');
    }
  });
});

describe('scoreFinancialSystemExposure — component-read contract', () => {
  it('DOES read every expected seed key (defends against accidental drops)', async () => {
    // Symmetric counter-positive: if a future refactor accidentally
    // drops one of the 4 component reads, this test names the missing
    // key directly.
    const observed = new Set<string>();
    const reader: ResilienceSeedReader = async (key) => {
      observed.add(key);
      if (key === 'seed-meta:economic:wb-external-debt') return { fetchedAt: Date.now() };
      if (key === 'seed-meta:economic:bis-lbs') return { fetchedAt: Date.now() };
      if (key === 'seed-meta:economic:fatf-listing') return { fetchedAt: Date.now() };
      if (key === 'economic:wb-external-debt:v1') return reachableDebtEnvelope();
      return null;
    };
    await scoreFinancialSystemExposure(TEST_ISO2, reader);
    assert.ok(observed.has('seed-meta:economic:wb-external-debt'), 'must preflight wb-external-debt seed-meta');
    assert.ok(observed.has('seed-meta:economic:bis-lbs'), 'must preflight bis-lbs seed-meta');
    assert.ok(observed.has('seed-meta:economic:fatf-listing'), 'must preflight fatf-listing seed-meta');
    assert.ok(observed.has('economic:wb-external-debt:v1'), 'must read wb-external-debt data key');
    assert.ok(observed.has('economic:bis-lbs:v1'), 'must read bis-lbs data key');
    assert.ok(observed.has('economic:fatf-listing:v1'), 'must read fatf-listing data key');
  });

  it('preflight reads UNVERSIONED seed-meta keys (matches runSeed write-key shape)', async () => {
    // Regression guard: previously the scorer preflighted
    // `seed-meta:economic:<key>:v1` while runSeed writes
    // `seed-meta:economic:<key>` (with the trailing :v\d+ stripped).
    // That mismatch would have caused EVERY request to throw
    // ResilienceConfigurationError once the flag flipped on, even with
    // healthy seeders. Pin the exact key shape so the bug can't recur.
    //
    // Reference: scripts/_seed-utils.mjs runSeed → seed-meta is written
    // at `seed-meta:${dataKey.replace(/:v\d+$/, '')}`. Same as
    // api/health.js + api/seed-health.js entries.
    const seedMetaReads = new Set<string>();
    const reader: ResilienceSeedReader = async (key) => {
      if (key.startsWith('seed-meta:')) seedMetaReads.add(key);
      // Return null so we observe the read attempts then trip the
      // preflight throw — we only care about the keys the scorer probed.
      return null;
    };
    try {
      await scoreFinancialSystemExposure(TEST_ISO2, reader);
    } catch (err) {
      // Expected — all seeds null → throws.
      assert.ok(err instanceof ResilienceConfigurationError);
    }
    assert.ok(seedMetaReads.has('seed-meta:economic:wb-external-debt'), 'preflight must probe unversioned seed-meta:economic:wb-external-debt (NOT :v1 suffix)');
    assert.ok(seedMetaReads.has('seed-meta:economic:bis-lbs'), 'preflight must probe unversioned seed-meta:economic:bis-lbs (NOT :v1 suffix)');
    assert.ok(seedMetaReads.has('seed-meta:economic:fatf-listing'), 'preflight must probe unversioned seed-meta:economic:fatf-listing (NOT :v1 suffix)');
    // Negative: the versioned form must NOT be probed (would never match
    // anything runSeed writes).
    assert.ok(!seedMetaReads.has('seed-meta:economic:wb-external-debt:v1'), 'preflight must NOT probe versioned seed-meta key (writer/reader drift bug guard)');
    assert.ok(!seedMetaReads.has('seed-meta:economic:bis-lbs:v1'));
    assert.ok(!seedMetaReads.has('seed-meta:economic:fatf-listing:v1'));
  });

  it('does NOT read sanctions:country-counts:v1 (Phase 1 OFAC component remains dropped)', async () => {
    // Verifies the methodology invariant from plan §"No double-counting":
    // financialSystemExposure must NOT read the OFAC seed key. The OFAC-
    // domicile signal does not feed either tradePolicy or
    // financialSystemExposure post-Phase-2.
    let sanctionsReads = 0;
    const reader: ResilienceSeedReader = async (key) => {
      if (key === 'sanctions:country-counts:v1') {
        sanctionsReads += 1;
        return { [TEST_ISO2]: 999 };
      }
      if (key === 'seed-meta:economic:wb-external-debt') return { fetchedAt: Date.now() };
      if (key === 'seed-meta:economic:bis-lbs') return { fetchedAt: Date.now() };
      if (key === 'seed-meta:economic:fatf-listing') return { fetchedAt: Date.now() };
      if (key === 'economic:wb-external-debt:v1') return reachableDebtEnvelope();
      return null;
    };
    await scoreFinancialSystemExposure(TEST_ISO2, reader);
    assert.equal(sanctionsReads, 0, 'scoreFinancialSystemExposure must not read sanctions:country-counts:v1');
  });
});

// ---------------------------------------------------------------------------
// #6459 inversion probe, committed as a regression test.
//
// The issue's appendix ran five hand-built countries through the real scorer
// and got, at b83ecbe35:
//
//   MC 22/0.65   LU 54/0.65   RU 70/1.0   TD 72/1.0   IR 0/0.2
//
// Monaco and Luxembourg — the two deepest financial systems in the sample —
// scored BELOW Russia and Chad. Russia's 70 decomposed as 0.35x80 (thin
// short-term debt) + 0.30x72 (low cross-border claims) + 0.20x100 (on neither
// FATF list) + 0.15x0: three of four components read severance from the
// Western financial system as strength.
//
// Keeping the probe as a test rather than a script is the whole point. The
// prose activation anchor in the methodology doc said the same thing and
// nothing evaluated it for three and a half months.
// ---------------------------------------------------------------------------
describe('scoreFinancialSystemExposure — #6459 inversion probe (pinned)', () => {
  // Verbatim from the issue appendix.
  const probeReader: ResilienceSeedReader = async (key) => {
    if (key.startsWith('seed-meta:')) return { status: 'ok', fetchedAt: Date.now() };
    if (key === 'economic:wb-external-debt:v1') {
      // MC/LU absent: neither is a World Bank Debtor Reporting System filer.
      return {
        schemaVersion: VALID_DEBT_SCHEMA_VERSION,
        countries: { RU: { value: 3, year: 2024 }, TD: { value: 1, year: 2024 } },
        nonDrsCountryCodes: FINSYS_NON_DRS_COUNTRY_CODES,
      };
    }
    if (key === 'economic:bis-lbs:v1') {
      return {
        countries: {
          RU: { totalXborderPctGdp: 4, parentCount: 0 },
          TD: { totalXborderPctGdp: 1.5, parentCount: 0 },
          MC: { totalXborderPctGdp: 630, parentCount: 6 },
          LU: { totalXborderPctGdp: 800, parentCount: 10 },
        },
      };
    }
    if (key === 'economic:fatf-listing:v1') {
      return {
        listings: { IR: 'black', KP: 'black', MM: 'black', MC: 'gray', VE: 'gray' },
        publicationDate: '2026-02-20',
      };
    }
    return null;
  };

  // Expected values were derived from the component arithmetic BEFORE the
  // retune was written, not read back off the implementation:
  //   MC 0.35x75(imputed) + 0.30x35(band floor) + 0.20x55(gray) + 0.15x56 = 56
  //   LU 0.35x75          + 0.30x35            + 0.20x100      + 0.15x100 = 72
  //   RU capped at 15 by the comprehensive-embargo cap (blend was 68)
  //   TD (0.35x0.3)x93 + 0.30x44 + 0.20x100 + 0.15x0, /0.755             = 57
  //   IR FATF black is the only resolving slot                            = 0
  const EXPECTED: ReadonlyArray<{ cc: string; score: number; coverage: number; wasBeforeFix: number }> = [
    { cc: 'MC', score: 56, coverage: 0.76, wasBeforeFix: 22 },
    { cc: 'LU', score: 72, coverage: 0.76, wasBeforeFix: 54 },
    { cc: 'RU', score: 15, coverage: 1, wasBeforeFix: 70 },
    { cc: 'TD', score: 57, coverage: 0.76, wasBeforeFix: 72 },
    { cc: 'IR', score: 0, coverage: 0.2, wasBeforeFix: 0 },
  ];

  it('pins the probe scores and coverages', async () => {
    for (const { cc, score, coverage, wasBeforeFix } of EXPECTED) {
      const result = await scoreFinancialSystemExposure(cc, probeReader);
      assert.equal(
        result.score,
        score,
        `${cc}: expected ${score}, got ${result.score} (was ${wasBeforeFix} at b83ecbe35, pre-#6459)`,
      );
      assert.equal(result.coverage, coverage, `${cc}: expected coverage ${coverage}, got ${result.coverage}`);
    }
  });

  it('financially deep jurisdictions out-score financially severed ones', async () => {
    // The invariant behind the pinned numbers. If a future retune moves the
    // exact values, this assertion still holds the construct's direction —
    // the pinned table alone would just be updated to whatever ran.
    const [mc, lu, ru, td] = await Promise.all(
      ['MC', 'LU', 'RU', 'TD'].map((cc) => scoreFinancialSystemExposure(cc, probeReader)),
    );
    assert.ok(lu.score > ru.score, `LU (${lu.score}) must out-score RU (${ru.score})`);
    assert.ok(lu.score > td.score, `LU (${lu.score}) must out-score TD (${td.score})`);
    assert.ok(mc.score > ru.score, `MC (${mc.score}) must out-score RU (${ru.score})`);
  });
});

describe('scoreFinancialSystemExposure — production-shaped no-BIS-row jurisdictions', () => {
  // Landmine from #6459: the appendix probe gave Monaco a BIS row, but
  // production has none — Monaco resolves its FATF slot only, at coverage
  // 0.2. Both shapes produced an inverted outcome, so both are pinned.
  it('Monaco resolves FATF-only at coverage 0.2 in the production payload', async () => {
    const reader = createFinSysFixtureReader();
    const mc = await scoreFinancialSystemExposure('MC', reader);
    assert.equal(mc.coverage, 0.2, `MC coverage must reflect the FATF-only slot (${FINSYS_FIXTURE_CAPTURED_AT} payload)`);
    assert.equal(mc.score, 55, 'MC must score the FATF gray anchor exactly — it is the only resolving component');
  });

  it('Cuba and DPRK resolve FATF-only and stay under the sanctions anchor', async () => {
    // Neither has a Debtor Reporting System row nor a BIS CBS counterparty
    // row. Cuba is absent from both FATF lists, so before #6459 its single
    // resolving slot scored compliant-by-absence at 100 — a comprehensively
    // embargoed economy topping the dimension outright.
    const reader = createFinSysFixtureReader();
    const cu = await scoreFinancialSystemExposure('CU', reader);
    const kp = await scoreFinancialSystemExposure('KP', reader);
    assert.equal(cu.coverage, 0.2, 'CU must resolve the FATF slot only');
    assert.ok(cu.score < 20, `CU scored ${cu.score}; compliant-by-absence must not survive the embargo cap`);
    assert.equal(kp.coverage, 0.2, 'KP must resolve the FATF slot only');
    assert.equal(kp.score, 0, 'KP is FATF black-listed; its only slot anchors at 0');
  });
});
