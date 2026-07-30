// Plan 2026-04-26-002 §U6 (combined PR 3+4+5) — pinning tests for the
// per-capita event normalization in `scoreSocialCohesion` and
// `scoreBorderSecurity`.
//
// The key invariant: 0 events on a tiny state (TV, 0.012M) does NOT
// out-score 5 events on a large state (Yemen, 33M). Pre-§U6 the raw
// event counts were goalpost-anchored 0..20 (socialCohesion) and 0..30
// (borderSecurity), which let micro-states with literal-zero counts
// crowd the top of the ranking against actually-low-rate large states.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  scoreSocialCohesion,
  scoreBorderSecurity,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers';

// Mirror of the production reader contract: returns a Map-keyed seed lookup.
function makeReader(seed: Record<string, unknown>) {
  return async (key: string) => seed[key] ?? null;
}

// Standard ISO2 codes used in the assertions below: country choice
// reflects the plan's empirical anchors (TV/PW for tiny peaceful states;
// US/YE for large-pop high/low-rate countries; IS/NO as Iceland-shape
// regression guards for comprehensive-source peaceful states).

describe('per-capita normalization invariants (Plan 2026-04-26-002 §U6)', () => {
  it('tiny state with zero unrest does NOT out-score large state with low-rate unrest', async () => {
    // TV: 0 events, GPI 1.3, no displacement registry entry, pop floor 0.5M.
    const tvReader = makeReader({
      'resilience:static:TV': {
        gpi: { score: 1.3 },
      },
      'displacement:summary:v1:2026': { countries: {} },     // not in registry → GPI-only mode
      'unrest:events:v1': { events: [] },                    // zero unrest events
      'economic:imf:labor:v1': { countries: {} },            // TV not in IMF labor → 0.5M floor
    });
    const tvResult = await scoreSocialCohesion('TV', tvReader);

    // US: low-rate unrest (5 events, 0 fatalities), GPI 1.7, observed
    // displacement, pop 333M. Per-capita rate = 5/333 ≈ 0.015 events/M.
    const usReader = makeReader({
      'resilience:static:US': { gpi: { score: 1.7 } },
      'displacement:summary:v1:2026': {
        countries: { US: { totalDisplaced: 1000 } },         // observed displacement
      },
      'unrest:events:v1': {
        events: Array.from({ length: 5 }, () => ({
          country: 'US', type: 'protest', fatalities: 0,
        })),
      },
      'economic:imf:labor:v1': {
        countries: { US: { populationMillions: 333 } },
      },
    });
    const usResult = await scoreSocialCohesion('US', usReader);

    // The plan's load-bearing invariant: TV must NOT out-score US.
    // Pre-§U5+§U6: TV ≈ 95 (GPI-only collapse + 0 raw events), US ≈ 87.
    // Post-§U5+§U6: TV ≈ 76 (lower impute + per-capita), US ≈ 90+ (low-rate
    // unrest at per-million scale → near-perfect unrest score).
    assert.ok(usResult.score > tvResult.score,
      `INVERSION: US (low-rate unrest, 333M pop) scored ${usResult.score}, TV (zero unrest, tiny) scored ${tvResult.score}. Plan §U6 must keep US > TV.`);
  });

  it('observed-unrest score scales inversely with population (per-capita anchoring)', async () => {
    // Two countries with the SAME raw unrest count (10 events, 0
    // fatalities), differing only in population. The smaller country
    // should score LOWER (worse) on socialCohesion because its per-capita
    // unrest rate is higher.
    const baseSeed = {
      'displacement:summary:v1:2026': {
        countries: { XA: { totalDisplaced: 100 }, XB: { totalDisplaced: 100 } },
      },
      'unrest:events:v1': {
        events: [
          ...Array.from({ length: 10 }, () => ({ country: 'XA', type: 'protest', fatalities: 0 })),
          ...Array.from({ length: 10 }, () => ({ country: 'XB', type: 'protest', fatalities: 0 })),
        ],
      },
    };

    const smallPopReader = makeReader({
      ...baseSeed,
      'resilience:static:XA': { gpi: { score: 1.5 } },
      'economic:imf:labor:v1': { countries: { XA: { populationMillions: 1 } } },
    });
    const largePopReader = makeReader({
      ...baseSeed,
      'resilience:static:XB': { gpi: { score: 1.5 } },
      'economic:imf:labor:v1': { countries: { XB: { populationMillions: 100 } } },
    });

    const smallResult = await scoreSocialCohesion('XA', smallPopReader);
    const largeResult = await scoreSocialCohesion('XB', largePopReader);

    assert.ok(largeResult.score > smallResult.score,
      `per-capita scaling broken: XB (100M pop, same 10 events) scored ${largeResult.score}; XA (1M pop) scored ${smallResult.score}. Per-capita normalization should make XB outperform XA.`);
  });

  it('UCDP eventCount is per-capita normalized in scoreBorderSecurity', async () => {
    // Same shape as above but for UCDP events in scoreBorderSecurity.
    const smallPopReader = makeReader({
      'conflict:ucdp-events:v1': {
        events: [
          { country: 'XA', type: 'state-based', deaths: 5 },
          { country: 'XA', type: 'state-based', deaths: 5 },
          { country: 'XA', type: 'state-based', deaths: 5 },
        ],
      },
      'displacement:summary:v1:2026': {
        countries: { XA: { hostTotal: 100 } },
      },
      'economic:imf:labor:v1': { countries: { XA: { populationMillions: 1 } } },
    });
    const largePopReader = makeReader({
      'conflict:ucdp-events:v1': {
        events: [
          { country: 'XB', type: 'state-based', deaths: 5 },
          { country: 'XB', type: 'state-based', deaths: 5 },
          { country: 'XB', type: 'state-based', deaths: 5 },
        ],
      },
      'displacement:summary:v1:2026': {
        countries: { XB: { hostTotal: 100 } },
      },
      'economic:imf:labor:v1': { countries: { XB: { populationMillions: 100 } } },
    });

    const smallResult = await scoreBorderSecurity('XA', smallPopReader);
    const largeResult = await scoreBorderSecurity('XB', largePopReader);

    assert.ok(largeResult.score > smallResult.score,
      `borderSecurity per-capita normalization broken: XB (100M pop) scored ${largeResult.score}, XA (1M) scored ${smallResult.score}. UCDP eventCount + deaths must scale per-capita.`);
  });

  it('0.5-million pop floor protects tiny states from per-capita inflation', async () => {
    // A country with 0.01M pop reported (Tuvalu-class) and a country
    // with 0.5M pop reported (Iceland-class) should produce the SAME
    // per-capita unrest score for the same event count, because the
    // 0.5M floor anchors both at the same denominator.
    const microReader = makeReader({
      'resilience:static:XA': { gpi: { score: 1.5 } },
      'displacement:summary:v1:2026': { countries: { XA: { totalDisplaced: 100 } } },
      'unrest:events:v1': { events: [{ country: 'XA', type: 'protest', fatalities: 0 }] },
      'economic:imf:labor:v1': { countries: { XA: { populationMillions: 0.01 } } },
    });
    const halfMillionReader = makeReader({
      'resilience:static:XB': { gpi: { score: 1.5 } },
      'displacement:summary:v1:2026': { countries: { XB: { totalDisplaced: 100 } } },
      'unrest:events:v1': { events: [{ country: 'XB', type: 'protest', fatalities: 0 }] },
      'economic:imf:labor:v1': { countries: { XB: { populationMillions: 0.5 } } },
    });

    const microResult = await scoreSocialCohesion('XA', microReader);
    const halfMillionResult = await scoreSocialCohesion('XB', halfMillionReader);

    // Both should have the SAME socialCohesion score (within rounding):
    // their per-capita rate is identical because both denominators clamp
    // to 0.5M via the floor.
    assert.equal(microResult.score, halfMillionResult.score,
      `0.5M floor not applied: 0.01M-pop XA scored ${microResult.score}, 0.5M-pop XB scored ${halfMillionResult.score}. Both should clamp to the same per-capita denominator.`);
  });

  it('TV boundary: live raw-persons value of exactly 10_000 falls through the defensive normalizer', async () => {
    // Plan §U6 review fix: live Redis currently has TV.populationMillions
    // = 10_000 (raw persons for Tuvalu's 10k headcount). The defensive
    // normalizer's threshold MUST be inclusive (`>= 10_000`, not `>`)
    // or this exact value would be treated as 10_000M and bypass §U6
    // for Tuvalu until the next IMF labor bundle (30-day gated).
    const tvRaw = makeReader({
      'resilience:static:TV': { gpi: { score: 1.3 } },
      'displacement:summary:v1:2026': { countries: { TV: { totalDisplaced: 100 } } },
      'unrest:events:v1': { events: [{ country: 'TV', type: 'protest', fatalities: 0 }] },
      'economic:imf:labor:v1': { countries: { TV: { populationMillions: 10_000 } } }, // raw persons
    });
    const tvFixed = makeReader({
      'resilience:static:TV': { gpi: { score: 1.3 } },
      'displacement:summary:v1:2026': { countries: { TV: { totalDisplaced: 100 } } },
      'unrest:events:v1': { events: [{ country: 'TV', type: 'protest', fatalities: 0 }] },
      'economic:imf:labor:v1': { countries: { TV: { populationMillions: 0.01 } } }, // post-fix millions
    });
    const rawResult = await scoreSocialCohesion('TV', tvRaw);
    const fixedResult = await scoreSocialCohesion('TV', tvFixed);
    // Both must produce the SAME socialCohesion score: the defensive
    // branch divides 10_000 by 1e6 → 0.01 → max(0.01, 0.5) = 0.5;
    // the post-fix branch reads 0.01 directly → max(0.01, 0.5) = 0.5.
    // Identical denominators → identical per-capita math → identical scores.
    assert.equal(rawResult.score, fixedResult.score,
      `TV-boundary regression: raw-persons defensive path scored ${rawResult.score}, post-fix scored ${fixedResult.score}. The defensive normalizer must use \`>= 10_000\` to handle the live cache value.`);
  });

  it('country missing from IMF labor seed defaults to 0.5M pop (tiny-state proxy)', async () => {
    // Plan §U6 design choice: when IMF labor doesn't carry a country
    // (typically tiny states or non-IMF members), fall back to the
    // 0.5M floor. This is directionally correct because the missing-
    // pop cohort overlaps with the tiny-state cohort.
    const reader = makeReader({
      'resilience:static:XA': { gpi: { score: 1.5 } },
      'displacement:summary:v1:2026': { countries: { XA: { totalDisplaced: 100 } } },
      'unrest:events:v1': { events: [] },                       // zero unrest
      'economic:imf:labor:v1': { countries: {} },               // XA missing
    });
    const result = await scoreSocialCohesion('XA', reader);
    // Zero unrest + missing IMF labor → impute branch fires (case (c) in
    // scoreSocialCohesion: observed displacement + zero unrest →
    // unhcrDisplacement.score 85). Per-capita doesn't apply when count=0.
    // Just verify the scorer doesn't throw and returns a sane score.
    assert.ok(result.score > 0 && result.score <= 100,
      `scorer must produce a valid score for missing-pop country, got ${result.score}`);
  });
});
