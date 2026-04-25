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

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  scoreFinancialSystemExposure,
  ResilienceConfigurationError,
  type ResilienceSeedReader,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';

const TEST_ISO2 = 'XX';

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
    'seed-meta:economic:wb-external-debt:v1',
    'seed-meta:economic:bis-lbs:v1',
    'seed-meta:economic:fatf-listing:v1',
  ]);
  return async (key) => {
    if (presentSeedMetaKeys.has(key)) return { fetchedAt: Date.now() };
    return null;
  };
}

describe('scoreFinancialSystemExposure — fail-closed preflight', () => {
  it('throws ResilienceConfigurationError when economic:wb-external-debt:v1 seed-meta is missing', async () => {
    const reader: ResilienceSeedReader = async (key) => {
      // Two of three published; WB IDS missing.
      if (key === 'seed-meta:economic:bis-lbs:v1') return { fetchedAt: Date.now() };
      if (key === 'seed-meta:economic:fatf-listing:v1') return { fetchedAt: Date.now() };
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
      if (key === 'seed-meta:economic:wb-external-debt:v1') return { fetchedAt: Date.now() };
      if (key === 'seed-meta:economic:fatf-listing:v1') return { fetchedAt: Date.now() };
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
      if (key === 'seed-meta:economic:wb-external-debt:v1') return { fetchedAt: Date.now() };
      if (key === 'seed-meta:economic:bis-lbs:v1') return { fetchedAt: Date.now() };
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
      if (key === 'seed-meta:economic:wb-external-debt:v1') return { fetchedAt: Date.now() };
      if (key === 'seed-meta:economic:bis-lbs:v1') return { fetchedAt: Date.now() };
      if (key === 'seed-meta:economic:fatf-listing:v1') return { fetchedAt: Date.now() };
      if (key === 'economic:wb-external-debt:v1') return { countries: { [TEST_ISO2]: { value: 0, year: 2024 } } };
      if (key === 'economic:bis-lbs:v1') return { countries: { [TEST_ISO2]: { totalXborderPctGdp: 25, parentCount: 10 } } };
      if (key === 'economic:fatf-listing:v1') return { listings: { [TEST_ISO2]: 'compliant' }, publicationDate: '2026-02-13' };
      return null;
    };
    const result = await scoreFinancialSystemExposure(TEST_ISO2, reader);
    assert.equal(result.score, 100, `best-case must yield 100, got ${result.score}`);
    assert.equal(result.coverage, 1.0, `best-case coverage must be 1.0, got ${result.coverage}`);
  });

  it('FATF black list + 15% short-term debt + 100% BIS LBS exposure + 1 parent → score floors low', async () => {
    // Component values driving each to its worst anchor:
    //   short-term debt = 15% GNI      → lowerBetter(15, 0, 15) = 0
    //   BIS LBS         = 100% GDP     → U-shape Iceland-2008 territory: 30 - (100-60)*0.5 = 10
    //   FATF            = black        → 0 (discrete)
    //   redundancy      = 1 parent     → higherBetter(1, 1, 10) = 0
    // Total: (0*0.35 + 10*0.30 + 0*0.20 + 0*0.15) / 1.0 = 3.
    const reader: ResilienceSeedReader = async (key) => {
      if (key === 'seed-meta:economic:wb-external-debt:v1') return { fetchedAt: Date.now() };
      if (key === 'seed-meta:economic:bis-lbs:v1') return { fetchedAt: Date.now() };
      if (key === 'seed-meta:economic:fatf-listing:v1') return { fetchedAt: Date.now() };
      if (key === 'economic:wb-external-debt:v1') return { countries: { [TEST_ISO2]: { value: 15, year: 2024 } } };
      if (key === 'economic:bis-lbs:v1') return { countries: { [TEST_ISO2]: { totalXborderPctGdp: 100, parentCount: 1 } } };
      if (key === 'economic:fatf-listing:v1') return { listings: { [TEST_ISO2]: 'black' }, publicationDate: '2026-02-13' };
      return null;
    };
    const result = await scoreFinancialSystemExposure(TEST_ISO2, reader);
    assert.ok(result.score < 10, `worst-case must score < 10, got ${result.score}`);
  });

  it('U-shape sanity: BIS LBS at 0% (financial isolation) scores LOWER than at 15% (sweet spot)', async () => {
    // Component 2 standalone test: hold all others null, vary the
    // BIS LBS exposure. The U-shape design penalizes both extremes.
    const buildReader = (xborderPct: number, parentCount: number): ResilienceSeedReader => async (key) => {
      if (key === 'seed-meta:economic:wb-external-debt:v1') return { fetchedAt: Date.now() };
      if (key === 'seed-meta:economic:bis-lbs:v1') return { fetchedAt: Date.now() };
      if (key === 'seed-meta:economic:fatf-listing:v1') return { fetchedAt: Date.now() };
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

  it('FATF discrete mapping: black=0, gray=30, compliant=100', async () => {
    const buildReader = (status: 'black' | 'gray' | 'compliant'): ResilienceSeedReader => async (key) => {
      if (key === 'seed-meta:economic:wb-external-debt:v1') return { fetchedAt: Date.now() };
      if (key === 'seed-meta:economic:bis-lbs:v1') return { fetchedAt: Date.now() };
      if (key === 'seed-meta:economic:fatf-listing:v1') return { fetchedAt: Date.now() };
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
    assert.equal(gray.score, 30, 'FATF gray list anchors at 30');
    assert.equal(compliant.score, 100, 'FATF compliant anchors at 100');
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
      if (key === 'seed-meta:economic:wb-external-debt:v1') return { fetchedAt: Date.now() };
      if (key === 'seed-meta:economic:bis-lbs:v1') return { fetchedAt: Date.now() };
      if (key === 'seed-meta:economic:fatf-listing:v1') return { fetchedAt: Date.now() };
      return null;
    };
    await scoreFinancialSystemExposure(TEST_ISO2, reader);
    assert.ok(observed.has('seed-meta:economic:wb-external-debt:v1'), 'must preflight wb-external-debt seed-meta');
    assert.ok(observed.has('seed-meta:economic:bis-lbs:v1'), 'must preflight bis-lbs seed-meta');
    assert.ok(observed.has('seed-meta:economic:fatf-listing:v1'), 'must preflight fatf-listing seed-meta');
    assert.ok(observed.has('economic:wb-external-debt:v1'), 'must read wb-external-debt data key');
    assert.ok(observed.has('economic:bis-lbs:v1'), 'must read bis-lbs data key');
    assert.ok(observed.has('economic:fatf-listing:v1'), 'must read fatf-listing data key');
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
      if (key === 'seed-meta:economic:wb-external-debt:v1') return { fetchedAt: Date.now() };
      if (key === 'seed-meta:economic:bis-lbs:v1') return { fetchedAt: Date.now() };
      if (key === 'seed-meta:economic:fatf-listing:v1') return { fetchedAt: Date.now() };
      return null;
    };
    await scoreFinancialSystemExposure(TEST_ISO2, reader);
    assert.equal(sanctionsReads, 0, 'scoreFinancialSystemExposure must not read sanctions:country-counts:v1');
  });
});
