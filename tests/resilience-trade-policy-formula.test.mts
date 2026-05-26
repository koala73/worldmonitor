// Pin the post-rename `tradePolicy` 3-component weighted-blend formula.
//
// Context. Plan 2026-04-25-004 Phase 1 (Ship 1) renamed the
// `tradeSanctions` dim to `tradePolicy` and DROPPED the OFAC-domicile-
// count component (was weight 0.45). The remaining 3 components were
// reweighted to total 1.0:
//   WTO restrictions count → 0.30 (was 0.15)
//   WTO barriers count     → 0.30 (was 0.15)
//   applied tariff rate    → 0.40 (was 0.25)
//
// The earlier `tests/resilience-sanctions-field-mapping.test.mts`
// (deleted in this PR) pinned `normalizeSanctionCount`'s piecewise
// anchors against scoreTradeSanctions end-to-end. Those assertions
// are obsolete: `normalizeSanctionCount` is retained-but-unused (see
// `_dimension-scorers.ts`), and scoreTradePolicy no longer reads
// `sanctions:country-counts:v1`. This file replaces that pin with a
// formula-shape contract that names each remaining component and the
// weight it MUST carry, so a future numeric drift surfaces here.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  scoreTradePolicy,
  type ResilienceSeedReader,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';

const TEST_ISO2 = 'XX';

// Helper: a reader that returns the WTO restrictions/barriers payloads
// with an explicit reporter set and no per-country entries (so the
// scorer sees count=0 for any country in the reporter set). Lets us
// drive the WTO components into the "real-data zero" path rather than
// the imputation path, which is what the formula contract needs to
// pin.
function emptyReporterReader(reporterSet: readonly string[]): ResilienceSeedReader {
  return async (key) => {
    if (key === 'trade:restrictions:v1:tariff-overview:50') {
      return { restrictions: [], _reporterCountries: [...reporterSet] };
    }
    if (key === 'trade:barriers:v1:tariff-gap:50') {
      return { barriers: [], _reporterCountries: [...reporterSet] };
    }
    return null;
  };
}

describe('scoreTradePolicy — 3-component weighted-blend formula (Ship 1 contract)', () => {
  it('does NOT read sanctions:country-counts:v1 (OFAC component dropped)', async () => {
    let sanctionsReadCount = 0;
    const reader: ResilienceSeedReader = async (key) => {
      if (key === 'sanctions:country-counts:v1') {
        sanctionsReadCount += 1;
        return { [TEST_ISO2]: 999 }; // would have driven score to 0 under old formula
      }
      return null;
    };
    await scoreTradePolicy(TEST_ISO2, reader);
    assert.equal(
      sanctionsReadCount,
      0,
      'scoreTradePolicy must not call reader(sanctions:country-counts:v1) — OFAC component is dropped',
    );
  });

  it('DOES read every expected component seed key (defends against accidental drops)', async () => {
    // Symmetric counter-positive: if a future refactor accidentally
    // drops one of the 3 remaining components, this test names the
    // missing reader call directly. The static-record key is templated
    // by `readStaticCountry` (resilience:static:{ISO2}); we accept any
    // read that includes that prefix.
    const observed = new Set<string>();
    const reader: ResilienceSeedReader = async (key) => {
      observed.add(key);
      return null;
    };
    await scoreTradePolicy(TEST_ISO2, reader);
    assert.ok(
      observed.has('trade:restrictions:v1:tariff-overview:50'),
      'scoreTradePolicy must call reader(trade:restrictions:v1:tariff-overview:50) — WTO restrictions component (weight 0.30)',
    );
    assert.ok(
      observed.has('trade:barriers:v1:tariff-gap:50'),
      'scoreTradePolicy must call reader(trade:barriers:v1:tariff-gap:50) — WTO barriers component (weight 0.30)',
    );
    assert.ok(
      [...observed].some((k) => k.startsWith('resilience:static:')),
      'scoreTradePolicy must read a resilience:static:{ISO2} key for the applied tariff rate component (weight 0.40)',
    );
  });

  it('reporter-set country with zero restrictions/barriers and no tariff scores 100', async () => {
    // Restrictions = 0 → 100 (lowerBetter at the best anchor).
    // Barriers     = 0 → 100.
    // Tariff       = null (no static record) → contributes null score, drops weight from blend.
    // Blend availableWeight = 0.30 + 0.30 = 0.60. Score = (100*0.30 + 100*0.30) / 0.60 = 100.
    const reader = emptyReporterReader([TEST_ISO2]);
    const result = await scoreTradePolicy(TEST_ISO2, reader);
    assert.equal(result.score, 100, `expected 100 with both WTO components clean and no tariff, got ${result.score}`);
    // Coverage = (1.0*0.30 + 1.0*0.30 + 0*0.40) / 1.0 = 0.60.
    assert.equal(result.coverage, 0.60, `coverage must reflect 0.30+0.30 observed weights / 1.0 total, got ${result.coverage}`);
  });

  it('weights total exactly 1.0 across the 3 components (full-data path)', async () => {
    // Drive every component into the real-data path via a reader that
    // populates the static-record tariff value AND the WTO arrays
    // anchored at their best values.
    const reader: ResilienceSeedReader = async (key) => {
      if (key === 'trade:restrictions:v1:tariff-overview:50') {
        return { restrictions: [], _reporterCountries: [TEST_ISO2] };
      }
      if (key === 'trade:barriers:v1:tariff-gap:50') {
        return { barriers: [], _reporterCountries: [TEST_ISO2] };
      }
      if (key === `resilience:static:${TEST_ISO2}`) {
        return { appliedTariffRate: { value: 0 } };
      }
      return null;
    };
    const result = await scoreTradePolicy(TEST_ISO2, reader);
    // All 3 components observed at the best anchor → score 100, coverage 1.0.
    assert.equal(result.score, 100, `full-data best-case must yield 100, got ${result.score}`);
    assert.equal(result.coverage, 1.0, `full-data coverage must be exactly 1.0 (0.30+0.30+0.40), got ${result.coverage}`);
  });

  it('full-data worst-case at every anchor scores 0 (formula sanity)', async () => {
    // Restrictions = 30 (counted at IN_FORCE weight 3 each → 30 entries
    //   would exceed the 30-best→0-worst goalpost; 10 IN_FORCE entries
    //   suffice to hit 30 effective points).
    // Barriers     = 40 plain notifications.
    // Tariff       = 20 → 0 (lowerBetter, worst goalpost).
    // Score = (0*0.30 + 0*0.30 + 0*0.40) / 1.0 = 0.
    const reader: ResilienceSeedReader = async (key) => {
      if (key === 'trade:restrictions:v1:tariff-overview:50') {
        return {
          restrictions: Array.from({ length: 10 }, () => ({
            reportingCountry: TEST_ISO2,
            status: 'IN_FORCE',
          })),
          _reporterCountries: [TEST_ISO2],
        };
      }
      if (key === 'trade:barriers:v1:tariff-gap:50') {
        return {
          barriers: Array.from({ length: 40 }, () => ({
            notifyingCountry: TEST_ISO2,
          })),
          _reporterCountries: [TEST_ISO2],
        };
      }
      if (key === `resilience:static:${TEST_ISO2}`) {
        return { appliedTariffRate: { value: 20 } };
      }
      return null;
    };
    const result = await scoreTradePolicy(TEST_ISO2, reader);
    assert.equal(result.score, 0, `full-data worst-case must yield 0, got ${result.score}`);
    assert.equal(result.coverage, 1.0, `full-data coverage must be exactly 1.0, got ${result.coverage}`);
  });

  it('total seed outage (null reader) produces score=0, coverage=0 (no impute)', async () => {
    const reader: ResilienceSeedReader = async () => null;
    const result = await scoreTradePolicy(TEST_ISO2, reader);
    assert.equal(result.coverage, 0, `total outage must yield coverage=0, got ${result.coverage}`);
    assert.equal(result.score, 0, `total outage must yield score=0 (weightedBlend empty-data shape), got ${result.score}`);
  });
});
