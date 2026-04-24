// Regression guard for scoreTradeSanctions's normalizeSanctionCount
// piecewise anchors and field-mapping contract.
//
// Context. PR 5.1 of plan 2026-04-24-002 (see
// `docs/methodology/known-limitations.md#tradesanctions-designated-party-domicile-construct-question`)
// documents the construct-ambiguity of counting OFAC-designated-party
// domicile locations as a resilience signal. The audit proposes three
// options for handling the transit-hub-shell-entity case but
// intentionally does NOT implement a scoring change. This test file
// pins the CURRENT scorer behavior so that a future methodology
// decision (Option 2 = program-weighted count; Option 3 = transit-hub
// exclusion; or status quo) updates these tests explicitly.
//
// Pinning protects against silent scorer refactors: if someone swaps
// the piecewise scale, flips the imputation path, or changes how the
// seed-outage null branch interacts with weightedBlend, this file
// fails before the scoring change propagates to a live publication.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  scoreTradeSanctions,
  type ResilienceSeedReader,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';

const TEST_ISO2 = 'XX';

// Minimal synthetic reader: only the sanctions key is populated, so the
// scorer's other slots (restrictions, barriers, tariff) drop to null
// and contribute zero weight. Isolates the sanctions slot math.
function sanctionsOnlyReader(sanctionsCount: number | null): ResilienceSeedReader {
  return async (key: string) => {
    if (key === 'sanctions:country-counts:v1') {
      return sanctionsCount == null ? null : { [TEST_ISO2]: sanctionsCount };
    }
    return null;
  };
}

describe('normalizeSanctionCount — piecewise anchors pinned', () => {
  // The scorer's piecewise scale (see _dimension-scorers.ts line 535):
  //   count=0      → 100
  //   count=1-10   → 90..75 (linear)
  //   count=11-50  → 75..50 (linear)
  //   count=51-200 → 50..25 (linear)
  //   count=201+   → 25..0  (linear at 0.1/step, clamped 0)
  //
  // The tests drive scoreTradeSanctions end-to-end with an otherwise-
  // empty reader so the sanctions slot score surfaces as the overall
  // weightedBlend output.

  it('count=0 anchors at score 100 (no designated parties)', async () => {
    const result = await scoreTradeSanctions(TEST_ISO2, sanctionsOnlyReader(0));
    assert.equal(result.score, 100, `expected 100 at count=0, got ${result.score}`);
  });

  it('count=1 anchors at score 90 (first listing drops 10 points)', async () => {
    const result = await scoreTradeSanctions(TEST_ISO2, sanctionsOnlyReader(1));
    assert.equal(result.score, 90, `expected 90 at count=1, got ${result.score}`);
  });

  it('count=10 anchors at score 75 (end of the 1-10 ramp)', async () => {
    const result = await scoreTradeSanctions(TEST_ISO2, sanctionsOnlyReader(10));
    assert.equal(result.score, 75, `expected 75 at count=10, got ${result.score}`);
  });

  it('count=50 anchors at score 50 (end of the 11-50 ramp)', async () => {
    const result = await scoreTradeSanctions(TEST_ISO2, sanctionsOnlyReader(50));
    assert.equal(result.score, 50, `expected 50 at count=50, got ${result.score}`);
  });

  it('count=200 anchors at score 25 (end of the 51-200 ramp)', async () => {
    const result = await scoreTradeSanctions(TEST_ISO2, sanctionsOnlyReader(200));
    assert.equal(result.score, 25, `expected 25 at count=200, got ${result.score}`);
  });

  it('count=500 scores near 0 (high-count tail, 0.1/step decay past 200)', async () => {
    const result = await scoreTradeSanctions(TEST_ISO2, sanctionsOnlyReader(500));
    // At count=500: 25 - (500-200)*0.1 = 25 - 30 = -5 → clamped to 0.
    assert.ok(result.score <= 1,
      `expected near-0 at count=500 (heavily-sanctioned state); got ${result.score}`);
  });

  it('monotonic: more designated parties → strictly lower score', async () => {
    const scores = await Promise.all([0, 1, 10, 50, 200, 500].map(
      (n) => scoreTradeSanctions(TEST_ISO2, sanctionsOnlyReader(n)),
    ));
    for (let i = 1; i < scores.length; i++) {
      assert.ok(scores[i].score < scores[i - 1].score,
        `score must strictly decrease with count; got [${scores.map((s) => s.score).join(', ')}]`);
    }
  });
});

describe('scoreTradeSanctions — field-mapping + outage semantics', () => {
  it('country absent from sanctions map defaults to count=0 (score 100)', async () => {
    // The map is ISO2 → count. A country NOT in the map is semantically
    // "no designated parties located here" — NOT "data missing". The
    // scorer reads `sanctionsCounts[countryCode] ?? 0` (line 1070).
    const reader: ResilienceSeedReader = async (key) => {
      if (key === 'sanctions:country-counts:v1') {
        return { US: 100, RU: 800 }; // our test country XX is NOT in this map
      }
      return null;
    };
    const result = await scoreTradeSanctions(TEST_ISO2, reader);
    assert.equal(result.score, 100,
      `absent-from-map must score 100 (count=0 semantics); got ${result.score}`);
  });

  it('sanctions seed outage (raw=null) contributes null score slot — NOT imputed', async () => {
    // When the seed key is entirely absent (not just the country key),
    // `sanctionsRaw == null` and the slot goes to { score: null, weight: 0.45 }
    // (line 1082-1083 of _dimension-scorers.ts). This is an intentional
    // fail-null behavior: we must NOT impute a score on seed outage,
    // because imputing would mask the outage. The other slots also drop
    // to null (nothing in our synthetic reader), so weightedBlend returns
    // coverage=0 — a clean zero-signal state that propagates as low
    // confidence at the dim level.
    const reader: ResilienceSeedReader = async () => null;
    const result = await scoreTradeSanctions(TEST_ISO2, reader);
    assert.equal(result.coverage, 0,
      `full-outage must produce coverage=0 (no impute-as-if-clean); got ${result.coverage}`);
  });

  it('construct-document anchor: count=1 differs from count=0 by exactly 10 points', async () => {
    // Pins the "first designated party drops the score by 10" design
    // choice. A future methodology PR that decides Option 2 (program-
    // weighted) or Option 3 (transit-hub exclusion) will necessarily
    // update this anchor if the weight-1 semantics change.
    const [zero, one] = await Promise.all([
      scoreTradeSanctions(TEST_ISO2, sanctionsOnlyReader(0)),
      scoreTradeSanctions(TEST_ISO2, sanctionsOnlyReader(1)),
    ]);
    assert.equal(zero.score - one.score, 10,
      `count=1 must be exactly 10 points below count=0; got ${zero.score - one.score}`);
  });
});
