import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  CALIBRATION_CODE_VERSION,
  CALIBRATION_MAX_HOLD_DAYS,
  CALIBRATION_MIN_FAMILIES,
  CALIBRATION_MIN_OUTCOME_FAMILIES,
  CALIBRATION_REFIT_FAMILY_GROWTH,
  CalibrationCohortOverlapError,
  applyCalibration,
  applyPublishedCalibration,
  decideCalibrationPublication,
  evaluateCalibrationCohort,
  evaluateCalibrationShadow,
  evaluateFitEligibility,
  fitCalibrationMap,
  isotonicKnots,
  knotsAreMonotone,
  parseCalibrationMap,
  recordCalibrationPublication,
  resolveCalibrationMapForRun,
  selectFitCohort,
} from '../scripts/_forecast-calibration.mjs';
import {
  ACTIVATION_MIN_FORWARD_DOMAIN,
  ACTIVATION_MIN_FORWARD_TOTAL,
  pairedBootstrap,
  wilsonInterval,
} from '../scripts/_forecast-scorecard.mjs';
import {
  CALIBRATION_MAP_KEY,
  CALIBRATION_MAP_META_KEY,
  buildScorecard,
  declareCalibrationMapRecords,
  resolveCalibrationMap,
} from '../scripts/seed-forecast-resolutions.mjs';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/forecast-calibration-ledger-2026-10-06.json', import.meta.url), 'utf8'));
const FIT_AT = FIXTURE.capturedAt;
const DAY_MS = 24 * 60 * 60 * 1000;
// Fixed epoch for synthetic ledgers: 2026-08-01T00:00:00Z.
const T0 = Date.UTC(2026, 7, 1);

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let serial = 0;
function entry({ domain = 'cyber', origin = 'legacy_detector', probability = 0.3, outcome = 'NO', generatedAt = T0, resolvedAt = generatedAt + 7 * DAY_MS, status = 'resolved' } = {}) {
  serial += 1;
  const deadline = generatedAt + 5 * DAY_MS;
  return {
    id: `f-${serial}`,
    key: `f-${serial}@${deadline}`,
    domain,
    generationOrigin: origin,
    probability,
    status,
    outcome: status === 'resolved' ? outcome : undefined,
    generatedAt,
    firstSeenAt: generatedAt,
    deadline,
    resolvedAt: status === 'resolved' ? resolvedAt : undefined,
  };
}

function ledgerOf(entries) {
  return Object.fromEntries(entries.map((row) => [row.key, row]));
}

function repeat(count, make) {
  return Array.from({ length: count }, (_, index) => make(index));
}

// `families` one-row families, the first `yes` of them resolved YES.
function twoSided(families, yes, options = {}) {
  return repeat(families, (index) => entry({ ...options, outcome: index < yes ? 'YES' : 'NO' }));
}

describe('golden fit on the frozen published-origin ledger', () => {
  // The map persisted on 2026-10-06 fitted cyber to a constant 0.01 from 197
  // all-NO rows. They come from 19 families and no family resolved YES, so
  // under family minimums every domain is identity.
  it('fits the frozen 2026-10-06 ledger exactly', () => {
    const map = fitCalibrationMap(FIXTURE.data, FIT_AT);
    assert.deepEqual(map, {
      schemaVersion: 1,
      version: `forecast-calibration-pav-v3@${FIT_AT}`,
      codeVersion: 'forecast-calibration-pav-v3',
      dataVersion: 1,
      refitReason: 'absent',
      fittedAt: FIT_AT,
      fitWindow: { from: 1783494135407, to: FIT_AT },
      cohortFilter: {
        excludedOrigins: ['state_derived', 'bet_engine', 'unknown'],
        outcomes: ['YES', 'NO'],
        rollingWindowDays: 180,
        emissionField: 'generatedAt',
      },
      sourceStage: 'marketBlendedProbability',
      minFamilies: 30,
      minOutcomeFamilies: 12,
      probabilityBounds: { floor: 0.01, ceiling: 0.99 },
      totalSample: 232,
      domains: {
        conflict: { n: 11, positives: 8, families: 9, yesFamilies: 7, noFamilies: 3, eligible: false, ineligibleReason: 'insufficient_families', mode: 'identity', knots: [] },
        cyber: { n: 197, positives: 0, families: 19, yesFamilies: 0, noFamilies: 19, eligible: false, ineligibleReason: 'insufficient_families', mode: 'identity', knots: [] },
        infrastructure: { n: 11, positives: 0, families: 4, yesFamilies: 0, noFamilies: 4, eligible: false, ineligibleReason: 'insufficient_families', mode: 'identity', knots: [] },
        market: { n: 7, positives: 5, families: 4, yesFamilies: 4, noFamilies: 2, eligible: false, ineligibleReason: 'insufficient_families', mode: 'identity', knots: [] },
        military: { n: 6, positives: 4, families: 4, yesFamilies: 2, noFamilies: 2, eligible: false, ineligibleReason: 'insufficient_families', mode: 'identity', knots: [] },
      },
    });
  });

  it('pools adjacent violators on real mixed outcomes when the family minimums are lowered', () => {
    const map = fitCalibrationMap(FIXTURE.data, FIT_AT, { minFamilies: 5, minOutcomeFamilies: 2 });
    const { inputs, ...conflict } = map.domains.conflict;
    assert.equal(Object.keys(inputs).length, 11, 'a fitted domain keeps its input rows');
    assert.deepEqual(conflict, {
      n: 11,
      positives: 8,
      families: 9,
      yesFamilies: 7,
      noFamilies: 3,
      eligible: true,
      mode: 'isotonic',
      knots: [{ x: 0.332, y: 0.01 }, { x: 0.34, y: 0.777778 }, { x: 0.85, y: 0.777778 }, { x: 0.93, y: 0.99 }],
    });
    assert.equal(map.domains.market.mode, 'identity', '4 families stay below the lowered minimum');
    assert.equal(map.domains.cyber.ineligibleReason, 'insufficient_yes_families', 'all-NO cyber cannot fit at any minimum');
  });

  it('is deterministic across repeated fits', () => {
    assert.deepEqual(fitCalibrationMap(FIXTURE.data, FIT_AT), fitCalibrationMap(FIXTURE.data, FIT_AT));
  });
});

describe('monotonicity property', () => {
  it('produces monotone knots and a non-decreasing apply curve for random inputs', () => {
    const random = mulberry32(7070);
    for (let trial = 0; trial < 300; trial += 1) {
      const size = 1 + Math.floor(random() * 120);
      const points = repeat(size, () => {
        const x = Math.round(random() * 1000) / 1000;
        return { x, y: random() < (trial % 3 === 0 ? 0.5 : x) ? 1 : 0 };
      });
      const knots = isotonicKnots(points);
      assert.ok(knotsAreMonotone(knots), `trial ${trial}: knots not monotone ${JSON.stringify(knots)}`);
      const map = { domains: { d: { mode: 'isotonic', knots } } };
      let previous = -Infinity;
      for (let p = 0; p <= 1.0000001; p += 0.005) {
        const value = applyCalibration(map, 'd', p);
        assert.ok(value >= previous - 1e-12, `trial ${trial}: apply decreased at p=${p}`);
        assert.ok(value >= 0.01 && value <= 0.99, `trial ${trial}: ${value} escaped the probability bounds`);
        previous = value;
      }
    }
  });

  it('interpolates linearly between knots and holds flat outside them', () => {
    const map = { domains: { d: { mode: 'isotonic', knots: [{ x: 0.2, y: 0.1 }, { x: 0.6, y: 0.5 }] } } };
    assert.equal(applyCalibration(map, 'd', 0), 0.1);
    assert.ok(Math.abs(applyCalibration(map, 'd', 0.4) - 0.3) < 1e-12);
    assert.equal(applyCalibration(map, 'd', 0.95), 0.5);
    assert.equal(applyCalibration(map, 'other', 0.4), 0.4, 'unknown domain is identity');
    assert.equal(applyCalibration(null, 'd', 0.4), 0.4, 'missing map is identity');
    assert.ok(Number.isNaN(applyCalibration(map, 'd', 'x')));
  });
});

describe('fit eligibility counts families, not rows', () => {
  const fitAt = T0 + 30 * DAY_MS;
  const fitRows = (rows, options) => fitCalibrationMap(ledgerOf(rows), fitAt, options);
  const verdict = (domain) => {
    const { mode, families, yesFamilies, noFamilies, ineligibleReason } = domain;
    return { mode, families, yesFamilies, noFamilies, ineligibleReason };
  };
  // Rows of one forecast id, the shape the resolver writes when a detector
  // re-emits the same family into window after window.
  const family = (id, rows, outcome, options = {}) => repeat(rows, () => ({ ...entry({ ...options, outcome }), id }));

  it('keeps the minimums at 30 families with 12 YES and 12 NO', () => {
    assert.deepEqual([CALIBRATION_MIN_FAMILIES, CALIBRATION_MIN_OUTCOME_FAMILIES], [30, 12]);
  });

  it('fits at the minimums and stays identity one family under each', () => {
    assert.deepEqual(verdict(fitRows(twoSided(30, 12)).domains.cyber),
      { mode: 'isotonic', families: 30, yesFamilies: 12, noFamilies: 18, ineligibleReason: undefined });
    assert.deepEqual(verdict(fitRows(twoSided(29, 12)).domains.cyber),
      { mode: 'identity', families: 29, yesFamilies: 12, noFamilies: 17, ineligibleReason: 'insufficient_families' });
    assert.deepEqual(verdict(fitRows(twoSided(30, 11)).domains.cyber),
      { mode: 'identity', families: 30, yesFamilies: 11, noFamilies: 19, ineligibleReason: 'insufficient_yes_families' });
    assert.deepEqual(verdict(fitRows(twoSided(30, 19)).domains.cyber),
      { mode: 'identity', families: 30, yesFamilies: 19, noFamilies: 11, ineligibleReason: 'insufficient_no_families' });
    assert.deepEqual(fitRows(twoSided(29, 12)).domains.cyber.knots, []);
    assert.equal(applyCalibration(fitRows(twoSided(29, 12)), 'cyber', 0.37), 0.37);
  });

  it('never fits a one-sided domain, however many rows or families it has (the pav-v1 cyber fit)', () => {
    const pavV1Shape = repeat(17, (index) => family(`fc-cyber-${index}`, index < 12 ? 9 : 8, 'NO', { probability: 0.05 + index / 40 })).flat();
    assert.equal(pavV1Shape.length, 148);
    const v1 = fitRows(pavV1Shape).domains.cyber;
    assert.deepEqual(verdict(v1), { mode: 'identity', families: 17, yesFamilies: 0, noFamilies: 17, ineligibleReason: 'insufficient_families' });
    assert.equal(v1.n, 148);
    const allNo = fitRows(repeat(200, () => entry({ outcome: 'NO' }))).domains.cyber;
    assert.deepEqual(verdict(allNo), { mode: 'identity', families: 200, yesFamilies: 0, noFamilies: 200, ineligibleReason: 'insufficient_yes_families' });
    const allYes = fitRows(repeat(200, () => entry({ outcome: 'YES' }))).domains.cyber;
    assert.equal(allYes.ineligibleReason, 'insufficient_no_families');
  });

  it('does not let repeated windows of one family stand in for independent families', () => {
    const rows = [
      ...repeat(10, (index) => family(`yes-${index}`, 5, 'YES')).flat(),
      ...repeat(19, (index) => family(`no-${index}`, 5, 'NO')).flat(),
    ];
    const domain = fitRows(rows).domains.cyber;
    assert.equal(domain.n, 145, 'the row count the old 30-row minimum passed');
    assert.deepEqual(verdict(domain), { mode: 'identity', families: 29, yesFamilies: 10, noFamilies: 19, ineligibleReason: 'insufficient_families' });
  });

  it('counts a family that resolved both ways on both sides', () => {
    const mixed = repeat(12, (index) => [...family(`mixed-${index}`, 1, 'YES'), ...family(`mixed-${index}`, 1, 'NO')]).flat();
    const domain = fitRows([...mixed, ...twoSided(18, 0)]).domains.cyber;
    assert.deepEqual(verdict(domain), { mode: 'isotonic', families: 30, yesFamilies: 12, noFamilies: 30, ineligibleReason: undefined });
  });

  it('judges each domain on its own families', () => {
    const map = fitRows([...twoSided(30, 12, { domain: 'conflict' }), ...twoSided(12, 4, { domain: 'military' })]);
    assert.equal(map.domains.conflict.mode, 'isotonic');
    assert.equal(map.domains.military.ineligibleReason, 'insufficient_families');
    assert.deepEqual(evaluateFitEligibility(ledgerOf([...twoSided(30, 12, { domain: 'conflict' })]), fitAt), {
      conflict: { families: 30, yesFamilies: 12, noFamilies: 18, eligible: true },
    });
  });

  it('counts no row the scorecard excludes', () => {
    const excluded = [
      { ...entry({ outcome: 'YES' }), duplicateOf: 'f-1@1' },
      { ...entry({ outcome: 'YES' }), stateBucketId: 'fx_stress' },
      { ...entry({ outcome: 'VOID' }), evidence: { reason: 'late_read', supersededOutcome: 'YES' } },
      { ...entry({ outcome: 'VOID' }), evidence: { reason: 'judged_old_selection', supersededOutcome: 'YES' } },
      { ...entry({ outcome: 'VOID' }), evidence: { reason: 'resolver_envelope_bug' } },
      { ...entry({ outcome: 'YES' }), calibration: { marketPrice: 0.12, drift: 0.3, source: 'polymarket' } },
      entry({ outcome: 'YES', origin: 'bet_engine' }),
      entry({ outcome: 'YES', origin: 'state_derived' }),
      entry({ outcome: 'YES', origin: 'unknown' }),
      { ...entry({ outcome: 'YES' }), rescore: { reason: 'last_seen_probability', supersededProbability: 0.5 } },
    ];
    const ledger = ledgerOf([...twoSided(30, 9), ...excluded]);
    assert.deepEqual(selectFitCohort(ledger, fitAt).filter((row) => excluded.includes(row)), []);
    assert.deepEqual(evaluateFitEligibility(ledger, fitAt).cyber,
      { families: 30, yesFamilies: 9, noFamilies: 21, eligible: false, ineligibleReason: 'insufficient_yes_families' });
  });
});

describe('population filter', () => {
  it('excludes bet_engine and state_derived from the fit', () => {
    const real = repeat(60, () => entry({ domain: 'cyber', probability: 0.4, outcome: 'NO' }));
    const shadow = repeat(80, () => entry({ domain: 'cyber', origin: 'bet_engine', probability: 0.4, outcome: 'YES' }));
    const synthetic = repeat(80, () => entry({ domain: 'cyber', origin: 'state_derived', probability: 0.4, outcome: 'YES' }));
    const map = fitCalibrationMap(ledgerOf([...real, ...shadow, ...synthetic]), T0 + 30 * DAY_MS);
    assert.equal(map.totalSample, 60);
    assert.equal(map.domains.cyber.n, 60);
    assert.equal(map.domains.cyber.positives, 0, 'any shadow/synthetic YES would have raised this');
    assert.deepEqual(map.cohortFilter.excludedOrigins, ['state_derived', 'bet_engine', 'unknown']);
  });

  it('excludes entries with no recorded origin from the fit', () => {
    const real = repeat(60, () => entry({ domain: 'cyber', probability: 0.4, outcome: 'NO' }));
    const unattributed = repeat(40, () => entry({ domain: 'cyber', origin: 'unknown', probability: 0.4, outcome: 'YES' }));
    const absent = repeat(40, () => entry({ domain: 'cyber', origin: '', probability: 0.4, outcome: 'YES' }));
    const map = fitCalibrationMap(ledgerOf([...real, ...unattributed, ...absent]), T0 + 30 * DAY_MS);
    assert.equal(map.totalSample, 60);
    assert.equal(map.domains.cyber.positives, 0, 'any unattributed YES would have raised this');
    assert.ok(map.cohortFilter.excludedOrigins.includes('unknown'));
  });

  it('counts only published-origin scored entries in the production fixture', () => {
    const rows = Object.values(FIXTURE.data);
    assert.ok(rows.some((row) => row.generationOrigin === 'bet_engine' && row.outcome === 'YES'));
    assert.ok(rows.some((row) => row.generationOrigin === 'state_derived'));
    const expected = rows.filter((row) => !['bet_engine', 'state_derived', 'unknown'].includes(row.generationOrigin || 'unknown') && (row.outcome === 'YES' || row.outcome === 'NO')).length;
    assert.equal(fitCalibrationMap(FIXTURE.data, FIT_AT).totalSample, expected);
  });

  it('excludes VOID, pending, and entries resolved outside the rolling window', () => {
    const fitAt = T0 + 200 * DAY_MS;
    const map = fitCalibrationMap(ledgerOf([
      ...repeat(60, (i) => entry({ generatedAt: T0 + 30 * DAY_MS + i })),
      entry({ outcome: 'VOID' }),
      entry({ status: 'pending' }),
      entry({ generatedAt: T0, resolvedAt: T0 + DAY_MS }),
    ]), fitAt);
    assert.equal(map.totalSample, 60);
  });

  it('excludes market anchors recorded without lineage, which predate the #7071 matcher', () => {
    const clean = twoSided(60, 12, { domain: 'cyber', probability: 0.4 });
    const stale = repeat(20, () => ({
      ...entry({ domain: 'cyber', probability: 0.2, outcome: 'YES' }),
      calibration: { marketTitle: 'Will China invade Taiwan by December 31, 2027?', marketPrice: 0.12, drift: 0.3, source: 'polymarket' },
    }));
    const lineage = repeat(5, () => ({
      ...entry({ domain: 'cyber', probability: 0.5, outcome: 'NO' }),
      calibration: { marketPrice: 0.6, drift: -0.1, source: 'polymarket', internalProbability: 0.5, marketBlendedProbability: 0.54 },
    }));
    const map = fitCalibrationMap(ledgerOf([...clean, ...stale, ...lineage]), T0 + 30 * DAY_MS);
    assert.equal(map.totalSample, 65);
    assert.equal(map.domains.cyber.positives, 12, 'a stale-anchor YES would have raised this');
    assert.equal(map.domains.cyber.knots.at(-1).x, 0.54, 'the fit reads calibration.marketBlendedProbability');
  });
});

describe('fit and evaluation separation', () => {
  const fitAt = T0 + 30 * DAY_MS;
  const map = fitCalibrationMap(ledgerOf(repeat(60, () => entry({ probability: 0.3, outcome: 'NO' }))), fitAt);

  it('refuses any evaluation entry emitted at or before the fit window end', () => {
    assert.equal(map.fitWindow.to, fitAt);
    assert.throws(
      () => evaluateCalibrationCohort([entry({ generatedAt: fitAt + DAY_MS }), entry({ generatedAt: fitAt })], map),
      (err) => err instanceof CalibrationCohortOverlapError && err.overlapping === 1,
    );
    assert.throws(() => evaluateCalibrationCohort([entry({ generatedAt: T0 })], map), CalibrationCohortOverlapError);
    assert.doesNotThrow(() => evaluateCalibrationCohort([entry({ generatedAt: fitAt + 1 })], map));
  });

  it('evaluates nothing on the ledger the map was fitted on', () => {
    const shadow = evaluateCalibrationShadow(FIXTURE.data, fitCalibrationMap(FIXTURE.data, FIT_AT), FIT_AT);
    assert.equal(shadow.status, 'shadow');
    assert.equal(shadow.forward.count, 0);
    assert.equal(shadow.activationGate.eligible, false);
    assert.ok(shadow.activationGate.reasons.includes('insufficient_forward_total'));
  });

  it('builds the forward cohort only from entries emitted after fittedAt', () => {
    const before = repeat(5, () => entry({ generatedAt: fitAt - DAY_MS, resolvedAt: fitAt + 10 * DAY_MS }));
    const after = repeat(4, () => entry({ generatedAt: fitAt + DAY_MS }));
    const shadow = evaluateCalibrationShadow(ledgerOf([...before, ...after]), map, fitAt + 20 * DAY_MS);
    assert.equal(shadow.forward.count, 4);
    assert.equal(shadow.activationGate.context.registered, 4);
  });

  it('ignores projection horizon rows in both the fit and the forward cohort (#7075)', () => {
    const horizonRow = (overrides) => {
      const base = entry(overrides);
      return { ...base, key: `${base.key}@d7`, parentKey: base.key, spec: { kind: 'hard', horizon: 'd7', semantics: 'point_in_time' } };
    };
    const forward = repeat(4, () => entry({ generatedAt: fitAt + DAY_MS }));
    const shadow = evaluateCalibrationShadow(ledgerOf([...forward, horizonRow({ generatedAt: fitAt + DAY_MS, outcome: 'YES' })]), map, fitAt + 20 * DAY_MS);
    assert.equal(shadow.forward.count, 4);
    assert.equal(shadow.activationGate.context.registered, 4);

    const fitRows = repeat(60, () => entry({ probability: 0.3, outcome: 'NO' }));
    const refit = fitCalibrationMap(ledgerOf([...fitRows, horizonRow({ probability: 0.9, outcome: 'YES' })]), fitAt);
    assert.equal(refit.totalSample, 60);
  });
});

describe('activation gate', () => {
  const fitAt = T0 + 30 * DAY_MS;
  const map = fitCalibrationMap(ledgerOf([
    ...twoSided(110, 12, { domain: 'cyber', probability: 0.35 }),
    ...repeat(10, () => entry({ domain: 'conflict', probability: 0.5, outcome: 'YES' })),
  ]), fitAt);
  const forward = (count, options) => repeat(count, (i) => entry({ generatedAt: fitAt + DAY_MS + i, ...options }));
  const gateFor = (entries) => evaluateCalibrationShadow(ledgerOf(entries), map, fitAt + 60 * DAY_MS).activationGate;

  it('passes with enough forward outcomes and a non-inferior calibrated Brier', () => {
    assert.equal(map.domains.cyber.mode, 'isotonic');
    assert.equal(map.domains.conflict.mode, 'identity');
    const gate = gateFor([...forward(ACTIVATION_MIN_FORWARD_DOMAIN + 10, { domain: 'cyber', probability: 0.3 }), ...forward(25, { domain: 'conflict', probability: 0.5, outcome: 'YES' })]);
    assert.deepEqual(gate.reasons, []);
    assert.equal(gate.eligible, true);
    assert.equal(gate.forwardCount, 65);
    assert.deepEqual(gate.domains.map((row) => [row.domain, row.count, row.sufficient, row.nonInferior]), [['cyber', 40, true, true]]);
    assert.equal(gate.context.originMix.legacy_detector, 65);
  });

  it('fails on too few forward outcomes overall', () => {
    const gate = gateFor(forward(ACTIVATION_MIN_FORWARD_TOTAL - 1, { domain: 'cyber', probability: 0.3 }));
    assert.equal(gate.eligible, false);
    assert.deepEqual(gate.reasons, ['insufficient_forward_total']);
  });

  it('fails when an activated domain has too few forward outcomes', () => {
    const gate = gateFor([...forward(ACTIVATION_MIN_FORWARD_DOMAIN - 1, { domain: 'cyber', probability: 0.3 }), ...forward(40, { domain: 'conflict', probability: 0.5, outcome: 'YES' })]);
    assert.equal(gate.eligible, false);
    assert.deepEqual(gate.reasons, ['insufficient_forward_domain:cyber']);
  });

  it('fails when calibration makes Brier worse overall and in the activated domain', () => {
    const gate = gateFor(forward(70, { domain: 'cyber', probability: 0.3, outcome: 'YES' }));
    assert.equal(gate.eligible, false);
    assert.deepEqual(gate.reasons, ['overall_not_non_inferior', 'domain_not_non_inferior:cyber']);
  });

  it('is never eligible for an all-identity map', () => {
    const identity = fitCalibrationMap({}, fitAt);
    const shadow = evaluateCalibrationShadow(ledgerOf(forward(70, { probability: 0.3 })), identity, fitAt + 60 * DAY_MS);
    assert.ok(shadow.activationGate.reasons.includes('no_non_identity_domain'));
    assert.equal(shadow.forward.brierDelta.mean, 0, 'identity changes nothing');
  });

  it('reports VOID and coverage beside the verdict', () => {
    const entries = [...forward(3, { probability: 0.3 }), ...forward(2, { outcome: 'VOID' }), ...forward(1, { status: 'pending' }), ...forward(4, { origin: 'bet_engine' })];
    const gate = gateFor(entries);
    assert.deepEqual(
      { registered: gate.context.registered, scored: gate.context.scored, void: gate.context.void, pending: gate.context.pending },
      { registered: 6, scored: 3, void: 2, pending: 1 },
    );
    assert.deepEqual(gate.context.originMix, { legacy_detector: 6, bet_engine: 4 });
  });
});

describe('shadow metrics', () => {
  it('computes Wilson intervals and always shows n', () => {
    const [lo, hi] = wilsonInterval(0, 10);
    assert.equal(lo, 0);
    assert.ok(Math.abs(hi - 0.277532) < 1e-6);
    assert.equal(wilsonInterval(0, 0), null);
    const fitAt = T0 + 30 * DAY_MS;
    const map = fitCalibrationMap(ledgerOf(twoSided(140, 12, { probability: 0.35 })), fitAt);
    const shadow = evaluateCalibrationShadow(ledgerOf(repeat(12, (i) => entry({ generatedAt: fitAt + 1 + i, probability: 0.32, outcome: i < 3 ? 'YES' : 'NO' }))), map, fitAt + 60 * DAY_MS);
    assert.deepEqual(shadow.forward.raw.reliability, [{ bucket: '30-40', count: 12, predictedMean: 0.32, realizedRate: 0.25, realizedWilson95: wilsonInterval(3, 12) }]);
    assert.equal(shadow.forward.calibrated.reliability[0].bucket, '0-10');
    assert.equal(shadow.forward.byDomain[0].count, 12);
  });

  it('seeds the bootstrap so intervals are reproducible', () => {
    const rows = repeat(40, (i) => ({ domain: 'd', y: i % 4 === 0 ? 1 : 0, raw: 0.3, calibrated: 0.1 + (i % 3) / 10 }));
    const stat = { mean: (sample) => sample.reduce((sum, row) => sum + row.calibrated, 0) / sample.length };
    assert.deepEqual(pairedBootstrap(rows, stat), pairedBootstrap(rows, stat));
    assert.deepEqual(pairedBootstrap(rows, stat), { mean: [0.1725, 0.2225] }, 'pinned to the seeded PRNG');
  });
});

describe('map lifecycle', () => {
  const fitAt = T0 + 30 * DAY_MS;
  const ledger = ledgerOf(repeat(60, () => entry({ probability: 0.35 })));

  it('keeps a persisted map so the forward cohort accumulates', () => {
    const existing = fitCalibrationMap(ledger, fitAt);
    const run = resolveCalibrationMapForRun(existing, ledger, fitAt + 5 * DAY_MS);
    assert.equal(run.action, 'kept');
    assert.equal(run.map.fittedAt, fitAt);
  });

  it('refits when absent, invalid, or from another code version', () => {
    const later = fitAt + 5 * DAY_MS;
    assert.equal(resolveCalibrationMapForRun(null, ledger, later).reason, 'absent');
    const nonMonotone = { ...fitCalibrationMap(ledger, fitAt), domains: { cyber: { n: 60, positives: 0, mode: 'isotonic', knots: [{ x: 0.1, y: 0.5 }, { x: 0.2, y: 0.4 }] } } };
    assert.equal(parseCalibrationMap(nonMonotone), null);
    assert.equal(resolveCalibrationMapForRun(nonMonotone, ledger, later).reason, 'invalid');
    const old = fitCalibrationMap(ledger, fitAt, { codeVersion: 'forecast-calibration-pav-v0' });
    const run = resolveCalibrationMapForRun(old, ledger, later);
    assert.equal(run.reason, 'code_version_changed');
    assert.equal(run.map.codeVersion, CALIBRATION_CODE_VERSION);
    assert.equal(run.map.fittedAt, later);
  });

  it('does not refit after a failed Redis read', async () => {
    const run = await resolveCalibrationMap(ledger, fitAt, async () => { throw new Error('HTTP 503'); });
    assert.deepEqual(run, { map: null, action: 'read_failed' });
    assert.equal(declareCalibrationMapRecords(run.map), 0, 'a null map is skipped and the last map preserved');
  });

  it('treats an Upstash error body as a failed read, not an absent map', async () => {
    const saved = { url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN, fetch: globalThis.fetch };
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'ERR max requests limit exceeded' }), { status: 200 });
    try {
      const run = await resolveCalibrationMap(ledger, fitAt);
      assert.deepEqual(run, { map: null, action: 'read_failed' });
    } finally {
      globalThis.fetch = saved.fetch;
      for (const [key, value] of [['UPSTASH_REDIS_REST_URL', saved.url], ['UPSTASH_REDIS_REST_TOKEN', saved.token]]) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('unwraps the seed envelope of a persisted map', async () => {
    const existing = fitCalibrationMap(ledger, fitAt);
    const run = await resolveCalibrationMap(ledger, fitAt + DAY_MS, async (key) => {
      assert.equal(key, CALIBRATION_MAP_KEY);
      return { _seed: { fetchedAt: fitAt }, data: existing };
    });
    assert.equal(run.action, 'kept');
    assert.equal(CALIBRATION_MAP_META_KEY, 'seed-meta:forecast:calibration-map');
  });

  it('rolls back to identity: an identity map reproduces every raw probability', () => {
    const identity = fitCalibrationMap({}, fitAt);
    for (const p of [0, 0.05, 0.35, 0.5, 0.99, 1]) assert.equal(applyCalibration(identity, 'cyber', p), p);
  });

  it('attaches the shadow block to the scorecard without touching canonical skill', () => {
    const plain = buildScorecard(ledger, fitAt);
    assert.deepEqual(plain.calibrationShadow, { status: 'no_map' });
    const withMap = buildScorecard(ledger, fitAt, fitCalibrationMap(ledger, fitAt));
    assert.deepEqual(withMap.skill, plain.skill);
    assert.deepEqual(withMap.calibration, plain.calibration);
    assert.equal(withMap.calibrationShadow.status, 'shadow');
  });
});

describe('published calibration (#7070 activation)', () => {
  const fitAt = T0 + 30 * DAY_MS;
  const map = fitCalibrationMap(ledgerOf([
    ...repeat(48, () => entry({ domain: 'cyber', probability: 0.4, outcome: 'NO' })),
    ...repeat(12, () => entry({ domain: 'cyber', probability: 0.4, outcome: 'YES' })),
    ...repeat(10, () => entry({ domain: 'conflict', probability: 0.5, outcome: 'YES' })),
  ]), fitAt);
  const eligibleShadow = {
    status: 'shadow',
    mapVersion: map.version,
    activationGate: {
      eligible: true,
      reasons: [],
      forwardCount: 72,
      overall: { brierDeltaUpper: -0.011, nonInferior: true },
      domains: [{ domain: 'cyber', count: 41, sufficient: true, brierDeltaUpper: -0.02, nonInferior: true }],
    },
  };
  const failingShadow = {
    ...eligibleShadow,
    activationGate: {
      ...eligibleShadow.activationGate,
      eligible: false,
      reasons: ['overall_not_non_inferior'],
      overall: { brierDeltaUpper: 0.012, nonInferior: false },
    },
  };
  const fresh = { nowMs: fitAt + DAY_MS, gateGeneratedAt: fitAt + DAY_MS - 3_600_000 };
  const decide = (m, shadow, options) => decideCalibrationPublication(m, shadow, { ...fresh, ...options });
  const preds = () => [
    { id: 'a', domain: 'cyber', generationOrigin: 'legacy_detector', probability: 0.4 },
    { id: 'b', domain: 'conflict', generationOrigin: 'legacy_detector', probability: 0.5 },
    { id: 'c', domain: 'cyber', generationOrigin: 'state_derived', probability: 0.4 },
  ];

  it('publishes the calibrated probability when the gate is eligible, keeping the raw value', () => {
    assert.equal(map.domains.cyber.mode, 'isotonic');
    const decision = decide(map, eligibleShadow);
    assert.deepEqual(
      { mode: decision.mode, reason: decision.reason, mapVersion: decision.mapVersion },
      { mode: 'calibrated', reason: 'gate_eligible', mapVersion: map.version },
    );
    assert.deepEqual(decision.gate, {
      eligible: true,
      reasons: [],
      forwardCount: 72,
      brierDeltaUpper: -0.011,
      domains: [{ domain: 'cyber', count: 41, brierDeltaUpper: -0.02 }],
    });
    const batch = preds();
    assert.equal(applyPublishedCalibration(batch, map, decision), 1);
    assert.deepEqual(batch[0], { id: 'a', domain: 'cyber', generationOrigin: 'legacy_detector', probability: 0.2, uncalibratedProbability: 0.4 });
    assert.deepEqual(batch[1], preds()[1], 'an identity domain publishes its raw value');
    assert.deepEqual(batch[2], preds()[2], 'state_derived is outside the fitted population');
  });

  it('reverts to raw when the gate fails, under the same rule', () => {
    const decision = decide(map, failingShadow);
    assert.deepEqual({ mode: decision.mode, reason: decision.reason }, { mode: 'raw', reason: 'gate_ineligible' });
    assert.deepEqual(decision.gate.reasons, ['overall_not_non_inferior']);
    const batch = preds();
    assert.equal(applyPublishedCalibration(batch, map, decision), 0);
    assert.deepEqual(batch, preds());
  });

  it('forces raw under the kill switch even when the gate is eligible', () => {
    const decision = decide(map, eligibleShadow, { forceRaw: true });
    assert.deepEqual({ mode: decision.mode, reason: decision.reason }, { mode: 'raw', reason: 'force_raw' });
    const batch = preds();
    applyPublishedCalibration(batch, map, decision);
    assert.deepEqual(batch, preds());
  });

  it('stays raw without a map, without a gate, on a read failure, or when the gate scored another map', () => {
    assert.equal(decide(null, eligibleShadow).reason, 'no_map');
    assert.equal(decide(map, { status: 'no_map' }).reason, 'no_gate');
    assert.equal(decide(map, null).reason, 'no_gate');
    assert.equal(decide(map, eligibleShadow, { readFailed: true }).reason, 'read_failed');
    const other = decide(map, { ...eligibleShadow, mapVersion: 'forecast-calibration-pav-v1@1' });
    assert.deepEqual({ mode: other.mode, reason: other.reason }, { mode: 'raw', reason: 'gate_map_mismatch' });
  });

  it('publishes raw for a map written by another code version', () => {
    const stale = { ...map, codeVersion: 'forecast-calibration-pav-v0' };
    const decision = decide(stale, { ...eligibleShadow, mapVersion: stale.version });
    assert.deepEqual({ mode: decision.mode, reason: decision.reason }, { mode: 'raw', reason: 'map_code_version' });
  });

  it('publishes raw when the gate verdict is older than 48 hours or undated', () => {
    const at = (ageMs) => decideCalibrationPublication(map, eligibleShadow, { nowMs: fitAt + 10 * DAY_MS, gateGeneratedAt: fitAt + 10 * DAY_MS - ageMs });
    assert.equal(at(48 * 3_600_000).reason, 'gate_eligible');
    assert.deepEqual({ mode: at(48 * 3_600_000 + 1).mode, reason: at(48 * 3_600_000 + 1).reason }, { mode: 'raw', reason: 'gate_stale' });
    assert.equal(decideCalibrationPublication(map, eligibleShadow, { nowMs: fitAt }).reason, 'gate_stale');
  });

  it('records each flip with its gate numbers and keeps the last flip across steady runs', () => {
    const on = recordCalibrationPublication(null, decide(map, eligibleShadow), fitAt + DAY_MS);
    assert.equal(on.flipped, true, 'every publication before activation was raw');
    assert.deepEqual(on.record.lastFlip, {
      at: fitAt + DAY_MS,
      from: 'raw',
      to: 'calibrated',
      reason: 'gate_eligible',
      gate: on.record.gate,
    });
    assert.equal(on.record.mode, 'calibrated');
    assert.equal(on.record.decidedAt, fitAt + DAY_MS);

    const off = recordCalibrationPublication(on.record, decide(map, failingShadow), fitAt + 2 * DAY_MS);
    assert.equal(off.flipped, true);
    assert.deepEqual(
      { at: off.record.lastFlip.at, from: off.record.lastFlip.from, to: off.record.lastFlip.to, reason: off.record.lastFlip.reason },
      { at: fitAt + 2 * DAY_MS, from: 'calibrated', to: 'raw', reason: 'gate_ineligible' },
    );
    assert.equal(off.record.lastFlip.gate.brierDeltaUpper, 0.012);

    const firstRaw = recordCalibrationPublication(null, decide(map, failingShadow), fitAt);
    assert.equal(firstRaw.flipped, false);
    assert.equal(firstRaw.record.lastFlip, null);
  });

  it('is idempotent: a rerun on the same inputs decides, publishes and records the same thing', () => {
    const first = recordCalibrationPublication(null, decide(map, eligibleShadow), fitAt + DAY_MS);
    const rerun = recordCalibrationPublication(first.record, decide(map, eligibleShadow), fitAt + DAY_MS + 3_600_000);
    assert.equal(rerun.flipped, false);
    assert.deepEqual(rerun.record.lastFlip, first.record.lastFlip);
    assert.deepEqual({ ...rerun.record, decidedAt: 0 }, { ...first.record, decidedAt: 0 });
    const a = preds();
    const b = preds();
    applyPublishedCalibration(a, map, first.record);
    applyPublishedCalibration(b, map, rerun.record);
    assert.deepEqual(a, b);
  });

  it('scores the uncalibrated value as raw after a flip, so the gate cannot latch on its own output', () => {
    // Calibrated 0.2 is worse than raw 0.4 on an all-YES forward cohort. If
    // the shadow read the published probability as raw, both sides would be
    // 0.2, the delta 0, and the gate would stay eligible forever.
    const forward = repeat(70, (i) => ({
      ...entry({ domain: 'cyber', probability: 0.2, outcome: 'YES', generatedAt: fitAt + DAY_MS + i }),
      uncalibratedProbability: 0.4,
    }));
    const shadow = evaluateCalibrationShadow(ledgerOf(forward), map, fitAt + 60 * DAY_MS);
    assert.equal(shadow.forward.raw.brier, 0.36);
    assert.equal(shadow.forward.calibrated.brier, 0.64);
    assert.equal(shadow.activationGate.eligible, false);
    assert.ok(shadow.activationGate.reasons.includes('overall_not_non_inferior'));
  });

  it('fits on the uncalibrated value of a calibrated publication', () => {
    const rows = twoSided(60, 12, { domain: 'cyber', probability: 0.2 }).map((row) => ({ ...row, uncalibratedProbability: 0.4 }));
    const refit = fitCalibrationMap(ledgerOf(rows), fitAt);
    assert.deepEqual(refit.domains.cyber.knots.map((knot) => knot.x), [0.4]);
  });
});

describe('data-version refit', () => {
  const fitAt = T0 + 30 * DAY_MS;
  const later = fitAt + 40 * DAY_MS;
  // Forward rows, emitted after fitAt and resolved before `later`.
  const forward = (count, options) => repeat(count, (i) => entry({ generatedAt: fitAt + DAY_MS + i, probability: 0.35, ...options }));
  const voidRows = (rows) => rows.map((row) => ({ ...row, outcome: 'VOID', evidence: { reason: 'late_read', supersededOutcome: row.outcome, voidedAt: later } }));

  it('keeps the map while the cohort gives no trigger', () => {
    const base = twoSided(30, 12, { probability: 0.35 });
    const existing = fitCalibrationMap(ledgerOf(base), fitAt);
    const run = resolveCalibrationMapForRun(existing, ledgerOf([...base, ...forward(29, { outcome: 'NO' })]), later);
    assert.deepEqual({ action: run.action, held: run.held, fittedAt: run.map.fittedAt, dataVersion: run.map.dataVersion },
      { action: 'kept', held: undefined, fittedAt: fitAt, dataVersion: 1 });
  });

  it('refits when an identity domain becomes eligible, bumping the data version and not the code version', () => {
    const base = twoSided(25, 10);
    const existing = fitCalibrationMap(ledgerOf(base), fitAt);
    assert.equal(existing.domains.cyber.mode, 'identity');
    assert.equal(resolveCalibrationMapForRun(existing, ledgerOf([...base, ...forward(4, { outcome: 'YES' })]), later).action, 'kept');

    const grown = ledgerOf([...base, ...forward(2, { outcome: 'YES' }), ...forward(3, { outcome: 'NO' })]);
    const run = resolveCalibrationMapForRun(existing, grown, later);
    assert.deepEqual({ action: run.action, reason: run.reason, domain: run.domain }, { action: 'fitted', reason: 'domain_became_eligible', domain: 'cyber' });
    assert.deepEqual({ codeVersion: run.map.codeVersion, dataVersion: run.map.dataVersion, refitReason: run.map.refitReason, fittedAt: run.map.fittedAt },
      { codeVersion: CALIBRATION_CODE_VERSION, dataVersion: 2, refitReason: 'domain_became_eligible', fittedAt: later });
    assert.equal(run.map.domains.cyber.mode, 'isotonic');
    assert.notEqual(run.map.version, existing.version);
    assert.deepEqual(resolveCalibrationMapForRun(run.map, grown, later + DAY_MS).action, 'kept', 'the refit converges: the next run keeps it');
  });

  it('refits a fitted domain only once its families double', () => {
    assert.equal(CALIBRATION_REFIT_FAMILY_GROWTH, 2);
    const base = twoSided(30, 12, { probability: 0.35 });
    const existing = fitCalibrationMap(ledgerOf(base), fitAt);
    assert.equal(existing.domains.cyber.families, 30);
    // Thirty forward rows are under the gate's minimum of 60, so the gate fails and nothing holds the refit.
    const under = resolveCalibrationMapForRun(existing, ledgerOf([...base, ...forward(29, { outcome: 'YES', probability: 0.1 })]), later);
    assert.equal(under.action, 'kept');
    const at = resolveCalibrationMapForRun(existing, ledgerOf([...base, ...forward(30, { outcome: 'YES', probability: 0.1 })]), later);
    assert.deepEqual({ action: at.action, reason: at.reason, dataVersion: at.map.dataVersion, families: at.map.domains.cyber.families },
      { action: 'fitted', reason: 'family_growth', dataVersion: 2, families: 60 });
  });

  it('does not count rows the scorecard excludes toward a trigger', () => {
    const base = twoSided(25, 8);
    const existing = fitCalibrationMap(ledgerOf(base), fitAt);
    const excludedOnly = [
      ...repeat(5, () => ({ ...entry({ generatedAt: fitAt + DAY_MS, outcome: 'YES' }), duplicateOf: 'x' })),
      ...voidRows(forward(5, { outcome: 'YES' })),
      ...forward(5, { outcome: 'YES', origin: 'bet_engine' }),
    ];
    assert.equal(resolveCalibrationMapForRun(existing, ledgerOf([...base, ...excludedOnly]), later).action, 'kept');
  });

  it('refits to identity when rows a fit used are later excluded', () => {
    const yes = twoSided(12, 12, { probability: 0.35 });
    const no = twoSided(18, 0, { probability: 0.35 });
    const existing = fitCalibrationMap(ledgerOf([...yes, ...no]), fitAt);
    assert.equal(existing.domains.cyber.mode, 'isotonic');
    const run = resolveCalibrationMapForRun(existing, ledgerOf([...voidRows(yes.slice(0, 1)), ...yes.slice(1), ...no]), later);
    assert.deepEqual({ action: run.action, reason: run.reason, dataVersion: run.map.dataVersion }, { action: 'fitted', reason: 'fit_input_withdrawn', dataVersion: 2 });
    assert.deepEqual({ mode: run.map.domains.cyber.mode, reason: run.map.domains.cyber.ineligibleReason }, { mode: 'identity', reason: 'insufficient_families' });
  });

  it('refits to identity when a fitted domain ages out of the window with no correction', () => {
    const existing = fitCalibrationMap(ledgerOf(twoSided(30, 12, { probability: 0.35 })), fitAt);
    const run = resolveCalibrationMapForRun(existing, ledgerOf(twoSided(30, 12, { probability: 0.35 })), fitAt + 200 * DAY_MS);
    assert.deepEqual({ action: run.action, reason: run.reason, mode: run.map.domains.cyber?.mode ?? 'absent' }, { action: 'fitted', reason: 'fit_invalidated', mode: 'absent' });
  });

  it('refits when rows a fit used are withdrawn, even when replacement families keep the domain eligible', () => {
    const yes = twoSided(12, 12, { probability: 0.35 });
    const no = twoSided(18, 0, { probability: 0.35 });
    const existing = fitCalibrationMap(ledgerOf([...yes, ...no]), fitAt);
    const replacements = forward(12, { outcome: 'YES', probability: 0.9 });
    const run = resolveCalibrationMapForRun(existing, ledgerOf([...voidRows(yes), ...no, ...replacements]), later);
    assert.deepEqual({ action: run.action, reason: run.reason }, { action: 'fitted', reason: 'fit_input_withdrawn' });
    assert.equal(run.map.domains.cyber.mode, 'isotonic', 'the refit reads the replacement families');

    const regraded = yes.map((row, index) => (index === 0 ? { ...row, outcome: 'NO', evidence: { regradedAt: later, supersededOutcome: 'YES' } } : row));
    const flipped = resolveCalibrationMapForRun(existing, ledgerOf([...regraded, ...no, ...replacements]), later);
    assert.equal(flipped.reason, 'fit_input_withdrawn', 'a re-graded outcome is a withdrawn input');
  });

  it('does not treat inputs pruned from the ledger or aged past the window as withdrawn', () => {
    const yes = twoSided(12, 12, { probability: 0.35 });
    const no = twoSided(25, 0, { probability: 0.35 });
    const existing = fitCalibrationMap(ledgerOf([...yes, ...no]), fitAt);
    assert.equal(resolveCalibrationMapForRun(existing, ledgerOf([...yes, ...no.slice(1)]), later).action, 'kept', 'a pruned row is absent, not withdrawn');
    const replacements = twoSided(35, 10, { generatedAt: fitAt + 100 * DAY_MS, probability: 0.35 });
    const aged = resolveCalibrationMapForRun(existing, ledgerOf([...yes, ...no, ...replacements]), fitAt + 200 * DAY_MS);
    assert.equal(aged.held ?? aged.action, 'kept', 'rows that left the rolling window are not corrections');
  });

  it('holds growth and new eligibility while the gate passes, but never holds an invalidated fit', () => {
    const yes = twoSided(12, 12, { probability: 0.35 });
    const no = twoSided(18, 0, { probability: 0.35 });
    const existing = fitCalibrationMap(ledgerOf([...yes, ...no]), fitAt);
    // 70 forward cyber NO at p=0.7: the map's 0.333 beats raw, so the gate passes, and families reach 100.
    const passing = forward(70, { outcome: 'NO', probability: 0.7 });
    const newDomain = twoSided(30, 12, { domain: 'conflict' });
    const ledger = ledgerOf([...yes, ...no, ...passing, ...newDomain]);
    assert.equal(evaluateCalibrationShadow(ledger, existing, later).activationGate.eligible, true);
    const held = resolveCalibrationMapForRun(existing, ledger, later);
    assert.deepEqual({ action: held.action, held: held.held, version: held.map.version },
      { action: 'kept', held: { reason: 'domain_became_eligible', domain: 'conflict' }, version: existing.version });

    const invalidated = resolveCalibrationMapForRun(existing, ledgerOf([...voidRows(yes), ...no, ...passing]), later);
    assert.deepEqual({ action: invalidated.action, reason: invalidated.reason }, { action: 'fitted', reason: 'fit_input_withdrawn' });
  });

  it('refits an old code version as data version 1, and rejects a current-version map without one', () => {
    const ledger = ledgerOf(twoSided(30, 12));
    const old = { ...fitCalibrationMap(ledger, fitAt, { codeVersion: 'forecast-calibration-pav-v2' }), dataVersion: undefined };
    const run = resolveCalibrationMapForRun(old, ledger, later);
    assert.deepEqual({ reason: run.reason, dataVersion: run.map.dataVersion, refitReason: run.map.refitReason },
      { reason: 'code_version_changed', dataVersion: 1, refitReason: 'code_version_changed' });
    assert.equal(parseCalibrationMap({ ...fitCalibrationMap(ledger, fitAt), dataVersion: undefined }), null);
  });
});

describe('refit triggers in a rolling-window steady state (review of #9027)', () => {
  // Distinct families, each resolving 7 days after emission.
  const family = (generatedAt, outcome, options = {}) => entry({ generatedAt, outcome, probability: 0.35, ...options });

  it('A1: keeps a gate-passing map whose inputs only aged out, and publication stays calibrated', () => {
    const fitAt = T0 + 30 * DAY_MS;
    const base = twoSided(30, 12, { probability: 0.35 });
    const map = fitCalibrationMap(ledgerOf(base), fitAt);
    assert.equal(map.domains.cyber.mode, 'isotonic');
    const forward = repeat(70, (i) => ({ ...entry({ outcome: 'NO', probability: 0.7, generatedAt: fitAt + DAY_MS + i * DAY_MS }), id: `fam-${i % 3}` }));
    const now = T0 + 188 * DAY_MS;
    const ledger = ledgerOf([...base, ...forward]);
    assert.equal(evaluateCalibrationShadow(ledger, map, now).activationGate.eligible, true);
    const run = resolveCalibrationMapForRun(map, ledger, now);
    assert.deepEqual({ action: run.action, held: run.held?.reason, version: run.map.version }, { action: 'kept', held: 'fit_invalidated', version: map.version });
    const scorecard = buildScorecard(ledger, now, run.map);
    const decision = decideCalibrationPublication(run.map, scorecard.calibrationShadow, { nowMs: now + 3_600_000, gateGeneratedAt: scorecard.generatedAt });
    assert.equal(decision.mode, 'calibrated');
  });

  it('A2: a domain hovering at the family floor refits once, not on every crossing', () => {
    const base = repeat(30, (i) => family(T0 + i * DAY_MS, i % 5 < 2 ? 'YES' : 'NO'));
    const map0 = fitCalibrationMap(ledgerOf(base), T0 + 37 * DAY_MS);
    assert.equal(map0.domains.cyber.mode, 'isotonic');
    let map = map0;
    const rows = [...base];
    for (let day = 0; day < 6; day += 1) {
      const nowOut = T0 + (187 + day) * DAY_MS + DAY_MS / 2;
      map = resolveCalibrationMapForRun(map, ledgerOf(rows), nowOut).map;
      rows.push(family(nowOut - 7 * DAY_MS, day % 3 === 0 ? 'YES' : 'NO', { resolvedAt: nowOut + DAY_MS / 4 }));
      map = resolveCalibrationMapForRun(map, ledgerOf(rows), nowOut + DAY_MS / 3).map;
    }
    assert.equal(map.dataVersion, 1, 'one family short of the floor is not evidence against the fit');
  });

  it('A6: a failing map refits once the families resolved since the fit match its own, though the window count plateaus', () => {
    const fitAt = T0 + 30 * DAY_MS;
    const base = [...repeat(12, () => entry({ outcome: 'YES', probability: 0.8 })), ...repeat(18, () => entry({ outcome: 'NO', probability: 0.2 }))];
    const map = fitCalibrationMap(ledgerOf(base), fitAt);
    const forward = repeat(150, (i) => entry({ outcome: i % 3 === 0 ? 'NO' : 'YES', probability: i % 3 === 0 ? 0.8 : 0.2, generatedAt: T0 + 31 * DAY_MS + i * 4 * DAY_MS }));
    const at = (day) => {
      const now = T0 + day * DAY_MS;
      return resolveCalibrationMapForRun(map, ledgerOf([...base, ...forward.filter((row) => row.resolvedAt <= now)]), now);
    };
    assert.equal(at(120).action, 'kept', '23 families since the fit');
    for (const day of [250, 400, 600]) {
      const run = at(day);
      assert.deepEqual({ day, action: run.action, reason: run.reason }, { day, action: 'fitted', reason: 'family_growth' }, 'the window holds about 45 families, under twice the fitted 30');
    }
  });

  it('refits a map whose inputs all aged out when new families plateau below its own count', () => {
    const fitAt = T0 + 30 * DAY_MS;
    const base = twoSided(60, 20, { probability: 0.35 });
    const map = fitCalibrationMap(ledgerOf(base), fitAt);
    const forward = repeat(60, (i) => entry({ outcome: i % 3 === 0 ? 'YES' : 'NO', probability: 0.35, generatedAt: fitAt + i * 4 * DAY_MS }));
    const now = T0 + 230 * DAY_MS;
    const ledger = ledgerOf([...base, ...forward.filter((row) => row.resolvedAt <= now)]);
    const run = resolveCalibrationMapForRun(map, ledger, now);
    assert.deepEqual({ action: run.action, reason: run.reason }, { action: 'fitted', reason: 'fit_aged_out' });
  });

  it('invalidates a fitted domain only below half the minimums', () => {
    const fitAt = T0 + 30 * DAY_MS;
    const yes = twoSided(12, 12, { probability: 0.35 });
    const no = twoSided(18, 0, { probability: 0.35 });
    const map = fitCalibrationMap(ledgerOf([...yes, ...no]), fitAt);
    const later = fitAt + 10 * DAY_MS;
    assert.equal(resolveCalibrationMapForRun(map, ledgerOf([...yes.slice(6), ...no]), later).action, 'kept', '6 YES families is half the minimum');
    const stillPruned = resolveCalibrationMapForRun(map, ledgerOf([...yes.slice(7), ...no]), later);
    assert.deepEqual({ action: stillPruned.action, reason: stillPruned.reason }, { action: 'fitted', reason: 'fit_invalidated' });
  });

  it('bounds the hold: a held trigger refits once the map is older than the rolling window', () => {
    const fitAt = T0 + 30 * DAY_MS;
    const base = twoSided(30, 12, { probability: 0.35 });
    const map = fitCalibrationMap(ledgerOf(base), fitAt);
    const passing = repeat(200, (i) => entry({ outcome: 'NO', probability: 0.7, generatedAt: fitAt + DAY_MS + i * DAY_MS }));
    const at = (day) => {
      const now = fitAt + day * DAY_MS;
      return resolveCalibrationMapForRun(map, ledgerOf([...base, ...passing.filter((row) => row.resolvedAt <= now)]), now);
    };
    const held = at(CALIBRATION_MAX_HOLD_DAYS);
    assert.deepEqual({ action: held.action, version: held.map.version }, { action: 'kept', version: map.version });
    assert.ok(held.held, 'a trigger is pending and the gate passes');
    const released = at(CALIBRATION_MAX_HOLD_DAYS + 1);
    assert.deepEqual({ action: released.action, reason: released.reason }, { action: 'fitted', reason: held.held.reason });
  });

  it('catches an input withdrawn by rescore or a withheld bucket while it still reads YES or NO', () => {
    const fitAt = T0 + 30 * DAY_MS;
    const base = twoSided(30, 12, { probability: 0.35 });
    const map = fitCalibrationMap(ledgerOf(base), fitAt);
    const swap = (row) => ledgerOf(base.map((original, index) => (index === 0 ? row(original) : original)));
    const rescored = swap((row) => ({ ...row, rescore: { reason: 'last_seen_probability', supersededProbability: 0.6 } }));
    assert.equal(resolveCalibrationMapForRun(map, rescored, fitAt + DAY_MS).reason, 'fit_input_withdrawn');
    const withheld = swap((row) => ({ ...row, stateBucketId: 'fx_stress' }));
    assert.equal(resolveCalibrationMapForRun(map, withheld, fitAt + DAY_MS).reason, 'fit_input_withdrawn');
    const moved = swap((row) => ({ ...row, probability: 0.9 }));
    assert.equal(resolveCalibrationMapForRun(map, moved, fitAt + DAY_MS).reason, 'fit_input_withdrawn', 'the fingerprint covers the fitted probability');
    const recast = swap((row) => ({ ...row, domain: 'conflict' }));
    assert.equal(resolveCalibrationMapForRun(map, recast, fitAt + DAY_MS).reason, 'fit_input_withdrawn', 'the fingerprint covers the domain');
  });

  it('rejects a current-version fitted domain that carries no inputs', () => {
    const map = fitCalibrationMap(ledgerOf(twoSided(30, 12)), T0 + 30 * DAY_MS);
    assert.ok(parseCalibrationMap(map));
    const { inputs: _dropped, ...bare } = map.domains.cyber;
    assert.equal(parseCalibrationMap({ ...map, domains: { cyber: bare } }), null);
  });
});

describe('publication across a data refit (#8973 gate)', () => {
  const fitAt = T0 + 30 * DAY_MS;
  const yes = twoSided(12, 12, { probability: 0.35 });
  const no = twoSided(18, 0, { probability: 0.35 });
  const passing = repeat(70, (i) => entry({ generatedAt: fitAt + DAY_MS + i, outcome: 'NO', probability: 0.7 }));
  const decideAt = (map, scorecard, nowMs) => decideCalibrationPublication(map, scorecard.calibrationShadow, { nowMs, gateGeneratedAt: scorecard.generatedAt });
  // One resolver run, then one seeder run that reads what the resolver wrote.
  const cycle = (persisted, ledger, nowMs, previousRecord) => {
    const { map } = resolveCalibrationMapForRun(persisted, ledger, nowMs);
    const scorecard = buildScorecard(ledger, nowMs, map);
    const decision = decideAt(map, scorecard, nowMs + 3_600_000);
    return { map, scorecard, decision, ...recordCalibrationPublication(previousRecord, decision, nowMs + 3_600_000) };
  };

  it('a refit from raw cannot flip to calibrated, on its own verdict or on the old map\'s', () => {
    const identity = fitCalibrationMap(ledgerOf(twoSided(25, 8)), fitAt);
    const ledger = ledgerOf([...yes, ...no]);
    const now = fitAt + 40 * DAY_MS;
    const run = cycle(identity, ledger, now, null);
    assert.equal(run.map.dataVersion, 2, 'the domain became eligible and the map refitted');
    assert.deepEqual({ mode: run.decision.mode, reason: run.decision.reason }, { mode: 'raw', reason: 'gate_ineligible' });
    assert.equal(run.scorecard.calibrationShadow.forward.count, 0, 'a refit starts an empty forward cohort');
    const staleEligible = { generatedAt: now, calibrationShadow: { mapVersion: identity.version, activationGate: { eligible: true, reasons: [] } } };
    assert.equal(decideAt(run.map, staleEligible, now + 3_600_000).reason, 'gate_map_mismatch');
    assert.deepEqual({ flipped: run.flipped, lastFlip: run.record.lastFlip }, { flipped: false, lastFlip: null });
  });

  it('growth while calibrated neither refits nor reverts, and the flip history keeps one entry', () => {
    const fitted = fitCalibrationMap(ledgerOf([...yes, ...no]), fitAt);
    const firstAt = fitAt + 80 * DAY_MS;
    const ledger = ledgerOf([...yes, ...no, ...passing]);
    const on = cycle(fitted, ledger, firstAt, null);
    assert.deepEqual({ mode: on.decision.mode, flipped: on.flipped, mapVersion: on.map.version }, { mode: 'calibrated', flipped: true, mapVersion: fitted.version });

    const moreNo = repeat(40, (i) => entry({ generatedAt: firstAt + i, outcome: 'NO', probability: 0.7 }));
    const next = cycle(on.map, ledgerOf([...yes, ...no, ...passing, ...moreNo]), firstAt + 20 * DAY_MS, on.record);
    assert.equal(next.map.version, fitted.version, 'families tripled, yet the validated map is held');
    assert.deepEqual({ mode: next.decision.mode, flipped: next.flipped }, { mode: 'calibrated', flipped: false });
    assert.deepEqual(next.record.lastFlip, on.record.lastFlip);
  });

  it('an invalidated fit reverts once, with the reason recorded, and the next run keeps that flip', () => {
    const fitted = fitCalibrationMap(ledgerOf([...yes, ...no]), fitAt);
    const firstAt = fitAt + 80 * DAY_MS;
    const on = cycle(fitted, ledgerOf([...yes, ...no, ...passing]), firstAt, null);
    assert.equal(on.decision.mode, 'calibrated');

    const voided = yes.map((row) => ({ ...row, outcome: 'VOID', evidence: { reason: 'late_read', supersededOutcome: 'YES', voidedAt: firstAt + DAY_MS } }));
    const corrected = ledgerOf([...voided, ...no, ...passing]);
    const off = cycle(on.map, corrected, firstAt + DAY_MS, on.record);
    assert.deepEqual({ dataVersion: off.map.dataVersion, refitReason: off.map.refitReason }, { dataVersion: 2, refitReason: 'fit_input_withdrawn' });
    assert.deepEqual({ mode: off.decision.mode, reason: off.decision.reason, flipped: off.flipped }, { mode: 'raw', reason: 'gate_ineligible', flipped: true });
    assert.deepEqual({ from: off.record.lastFlip.from, to: off.record.lastFlip.to, at: off.record.lastFlip.at }, { from: 'calibrated', to: 'raw', at: firstAt + DAY_MS + 3_600_000 });
    // The seeder can read the new map before the resolver's scorecard lands; the old verdict does not carry over.
    assert.equal(decideAt(off.map, on.scorecard, firstAt + DAY_MS).reason, 'gate_map_mismatch');

    const after = cycle(off.map, corrected, firstAt + 2 * DAY_MS, off.record);
    assert.equal(after.map.version, off.map.version);
    assert.deepEqual({ mode: after.decision.mode, flipped: after.flipped }, { mode: 'raw', flipped: false });
    assert.deepEqual(after.record.lastFlip, off.record.lastFlip);
  });
});

describe('no live clock', () => {
  it('requires an injected time and never reads the wall clock', () => {
    assert.throws(() => fitCalibrationMap({}, undefined), TypeError);
    const source = readFileSync(new URL('../scripts/_forecast-calibration.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /Date\.now\(|new Date\(|performance\.now\(/);
  });
});
