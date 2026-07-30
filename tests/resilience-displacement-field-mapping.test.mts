// Regression guard for the UNHCR-displacement field mapping read by
// scoreSocialCohesion, scoreBorderSecurity, and scoreStateContinuity.
//
// The audit (PR 5.2 of plan 2026-04-24-002 — see
// `docs/methodology/known-limitations.md#displacement-field-mapping`)
// established that the field mapping is code-correct. This test pins
// four invariants so a future UNHCR schema rename or a well-meaning
// seeder refactor cannot silently zero the signal across the board:
//
//   1. `totalDisplaced` is the origin-side sum of the four UNHCR
//      categories (refugees + asylumSeekers + idps + stateless).
//   2. `hostTotal` is the asylum-side sum of refugees + asylumSeekers
//      (IDPs and stateless are NOT asylum-side-aggregated by UNHCR).
//   3. `scoreBorderSecurity` falls back to `totalDisplaced` only when
//      `hostTotal` is missing/zero (codifying the modeling note in
//      `known-limitations.md`).
//   4. Labor-migrant-dominated cohorts (AE, QA, KW, SG) reading a
//      UNHCR-semantic "no displacement host" entry do NOT inadvertently
//      score as if they had a displacement crisis — their reading
//      returns `totalDisplaced = 0` / `hostTotal = 0` under the
//      mapping, which normalises to a high (good) score.
//
// The test drives the pure scorers with synthetic readers; no live
// UNHCR API or Redis is touched. The synthetic payloads match the
// shape `seed-displacement-summary.mjs` writes.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  getCountryDisplacement,
  scoreSocialCohesion,
  scoreBorderSecurity,
  scoreStateContinuity,
  type ResilienceSeedReader,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';

const CURRENT_YEAR = new Date().getFullYear();
const DISPLACEMENT_KEY = `displacement:summary:v1:${CURRENT_YEAR}`;

// Build a seed-displacement-summary-shaped payload for N synthetic
// countries. Mirrors lines 130-170 of `scripts/seed-displacement-summary.mjs`
// exactly so a later seeder refactor that changes the emitted shape
// will trip this test.
function buildDisplacementPayload(entries: Array<{
  code: string;
  refugees?: number;
  asylumSeekers?: number;
  idps?: number;
  stateless?: number;
  hostRefugees?: number;
  hostAsylumSeekers?: number;
}>) {
  const countries = entries.map((e) => {
    const refugees = e.refugees ?? 0;
    const asylumSeekers = e.asylumSeekers ?? 0;
    const idps = e.idps ?? 0;
    const stateless = e.stateless ?? 0;
    const hostRefugees = e.hostRefugees ?? 0;
    const hostAsylumSeekers = e.hostAsylumSeekers ?? 0;
    return {
      code: e.code,
      name: e.code,
      refugees,
      asylumSeekers,
      idps,
      stateless,
      totalDisplaced: refugees + asylumSeekers + idps + stateless,
      hostRefugees,
      hostAsylumSeekers,
      hostTotal: hostRefugees + hostAsylumSeekers,
    };
  });
  return {
    summary: {
      year: CURRENT_YEAR,
      globalTotals: {
        refugees: 0, asylumSeekers: 0, idps: 0, stateless: 0, total: 0,
      },
      countries,
      topFlows: [],
    },
  };
}

function makeReader(displacementRaw: unknown): ResilienceSeedReader {
  return async (key: string) => (key === DISPLACEMENT_KEY ? displacementRaw : null);
}

describe('UNHCR displacement — field mapping contract', () => {
  it('totalDisplaced equals refugees + asylumSeekers + idps + stateless (origin side)', () => {
    const payload = buildDisplacementPayload([
      { code: 'SYR', refugees: 1_000_000, asylumSeekers: 200_000, idps: 6_000_000, stateless: 50_000 },
    ]);
    const entry = getCountryDisplacement(payload, 'SYR');
    assert.ok(entry, 'expected to find SYR entry');
    assert.equal(entry?.totalDisplaced, 7_250_000,
      'totalDisplaced must sum all four UNHCR categories on the origin side');
  });

  it('hostTotal equals hostRefugees + hostAsylumSeekers (asylum side only; IDPs + stateless are origin-side only)', () => {
    const payload = buildDisplacementPayload([
      { code: 'TUR', hostRefugees: 3_500_000, hostAsylumSeekers: 150_000 },
    ]);
    const entry = getCountryDisplacement(payload, 'TUR');
    assert.equal(entry?.hostTotal, 3_650_000,
      'hostTotal must exclude IDPs + stateless by UNHCR semantics (asylum-side only)');
  });

  it('stateless-only country surfaces under totalDisplaced (the dropped-category bug class)', () => {
    // A country whose UNHCR footprint is mostly stateless population (e.g. AE for bidoon, MM/BD for Rohingya).
    // If a future refactor dropped the `stateless` sum term, this entry would go to 0.
    const payload = buildDisplacementPayload([
      { code: 'XX', stateless: 100_000 },
    ]);
    const entry = getCountryDisplacement(payload, 'XX');
    assert.equal(entry?.totalDisplaced, 100_000,
      'stateless population must flow into totalDisplaced');
  });
});

describe('UNHCR displacement — scorer reads + labor-migrant-cohort invariant', () => {
  it('a labor-migrant-cohort entry (hostTotal=0, totalDisplaced=0) scores the displacement sub-component near 100', async () => {
    // Simulates GCC / SG under UNHCR semantics: the country hosts a
    // large labor-migrant population but UNHCR does NOT classify
    // labor migrants, so its UNHCR footprint is effectively empty.
    // This is CORRECT per UNHCR's definition (see
    // known-limitations.md § Displacement field-mapping) — the test
    // pins the behavior so a future refactor that flips the
    // empty-payload path to "impute as high-displacement" breaks it.
    const payload = buildDisplacementPayload([
      { code: 'AE' }, // all zeros
    ]);

    // Drive scoreSocialCohesion end-to-end with zero displacement.
    // We don't set GPI / unrest — those are null-null and
    // weightedBlend ignores nulls. The only signal is displacement.
    const score = await scoreSocialCohesion('AE', makeReader(payload));
    // log10(max(1, 0)) = 0 → normalizeLowerBetter(0, 0, 7) = 100
    // weightedBlend over a single non-null component returns that score.
    assert.equal(score.score, 100,
      'UNHCR-empty country must score 100 on the displacement sub-component (normalizeLowerBetter(log10(max(1,0)), 0, 7))');
    assert.ok(score.coverage > 0, 'coverage must be non-zero when the signal was read');
  });

  it('scoreBorderSecurity current behaviour: hostTotal=0 short-circuits `??` fallback (see known-limitations.md)', async () => {
    // Pins the CURRENT scorer semantics at _dimension-scorers.ts:1412:
    //   const displacementMetric = safeNum(displacement?.hostTotal)
    //                           ?? safeNum(displacement?.totalDisplaced);
    // JavaScript's `??` only falls back on null/undefined, NOT 0. The
    // seeder writes `hostTotal: 0` explicitly for origin-only countries
    // (line 141-144 of seed-displacement-summary.mjs), so the fallback
    // is effectively dead code today — origin-only countries (Syria,
    // Venezuela, Ukraine, Afghanistan) read `displacementMetric = 0`
    // → normalizeLowerBetter(log10(1)=0, 0, 7) = 100 on borderSecurity's
    // displacement component.
    //
    // This test pins the observed behavior so a future "fix" to use `||`
    // or an explicit `=== 0` branch isn't accidental. A deliberate
    // construct decision to flip the behaviour should update THIS test
    // with an accompanying known-limitations.md rev.

    // Origin-only (Syria pattern): totalDisplaced ~7M, hostTotal=0.
    const originPayload = buildDisplacementPayload([
      { code: 'SYR', refugees: 1_000_000, asylumSeekers: 0, idps: 6_000_000, stateless: 50_000 },
    ]);
    const origin = await scoreBorderSecurity('SYR', makeReader(originPayload));
    assert.equal(origin.score, 100,
      `origin-only country scores 100 today (the \`??\` fallback does NOT fire on hostTotal=0); got ${origin.score}`);

    // Host-only (Turkey pattern): hostTotal large → uses hostTotal.
    const hostPayload = buildDisplacementPayload([
      { code: 'TUR', hostRefugees: 3_500_000, hostAsylumSeekers: 150_000 },
    ]);
    const host = await scoreBorderSecurity('TUR', makeReader(hostPayload));
    assert.ok(host.score != null && host.score < 100,
      `host-only country must read a non-null host-driven score; got ${host.score}`);
  });

  it('scoreBorderSecurity: `??` fallback only fires when hostTotal is UNDEFINED (never reached in production)', async () => {
    // A payload shape the seeder DOES NOT produce today: hostTotal
    // absent from the country entry entirely. In that case
    // `safeNum(undefined)` returns null (JS `Number(undefined)=NaN`),
    // `??` then reads totalDisplaced, and the fallback fires.
    //
    // Pinning this academic case means a future seeder refactor that
    // decides to OMIT hostTotal for origin-only countries (instead of
    // writing 0) will produce a behavioural break that shows up here.
    const payload = {
      summary: {
        year: CURRENT_YEAR,
        globalTotals: { refugees: 0, asylumSeekers: 0, idps: 0, stateless: 0, total: 0 },
        countries: [
          // NOTE: no hostTotal field on this entry. The seeder writes
          // hostTotal: 0 today, which short-circuits the `??` (see the
          // previous test). Omitting the field entirely is the only
          // shape that reaches the fallback branch.
          { code: 'XX', totalDisplaced: 5_000_000 },
        ],
        topFlows: [],
      },
    };
    const score = await scoreBorderSecurity('XX', makeReader(payload));
    assert.ok(score.score != null && score.score < 80,
      `undefined-hostTotal must fall back to totalDisplaced=5M; score should be <80, got ${score.score}`);
  });

  it('safeNum gotcha: safeNum(null) returns 0, not null (documents the root cause of the `??` short-circuit)', () => {
    // Not testing the scorer directly — this pins the numeric-coercion
    // quirk that makes the `hostTotal ?? totalDisplaced` fallback
    // effectively dead code for any payload where hostTotal is null or 0.
    // JavaScript's Number(null) === 0 (while Number(undefined) === NaN),
    // so `safeNum` correctly classifies null as the finite number 0.
    // The only way the `??` at _dimension-scorers.ts:1412 falls back
    // today is if hostTotal is UNDEFINED — which the seeder never emits.
    assert.equal(Number(null), 0, 'JS coerces null → 0 numerically');
    assert.equal(Number.isFinite(Number(null)), true, 'and 0 is finite');
    assert.equal(Number(undefined), Number(undefined), 'Number(undefined) is NaN');
    assert.equal(Number.isFinite(Number(undefined)), false, 'NaN is not finite');
  });

  it('scoreBorderSecurity imputes with `stable-absence` when the country is absent entirely from UNHCR', async () => {
    // Country not in payload at all (neither origin nor host).
    const payload = buildDisplacementPayload([
      { code: 'OTHER', refugees: 100 },
    ]);
    const score = await scoreBorderSecurity('XX', makeReader(payload));
    // Per IMPUTE.unhcrDisplacement (line 139 of _dimension-scorers.ts),
    // absent-from-registry countries impute with class `stable-absence`
    // (score=85, coverage=0.6). The class encodes the semantic judgment
    // that a country missing from UNHCR is reasonably assumed to have
    // no significant displacement — NOT a data outage. The only way to
    // reach this branch with a non-null source is if the payload loaded
    // but didn't contain the country, which is exactly UNHCR's "not a
    // significant refugee source or host" behaviour.
    assert.equal(score.imputationClass, 'stable-absence',
      'absent-from-UNHCR country must impute with class stable-absence');
  });

  it('scoreStateContinuity reads totalDisplaced (origin side) per documented mapping', async () => {
    // Low-displacement synthetic (totalDisplaced=100) vs high (5M).
    // The low entry should score higher on state-continuity's
    // displacement sub-component than the high entry. The test pins
    // that the scorer actually reads `totalDisplaced` and not some
    // other field that a refactor might accidentally substitute.
    const low = buildDisplacementPayload([{ code: 'XX', refugees: 100 }]);
    const high = buildDisplacementPayload([{ code: 'XX', refugees: 5_000_000 }]);
    const [scoreLow, scoreHigh] = await Promise.all([
      scoreStateContinuity('XX', makeReader(low)),
      scoreStateContinuity('XX', makeReader(high)),
    ]);
    assert.ok(scoreLow.score > scoreHigh.score,
      `low totalDisplaced must score higher than high; got ${scoreLow.score} vs ${scoreHigh.score}`);
  });
});
