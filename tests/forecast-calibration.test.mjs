import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  CALIBRATION_CODE_VERSION,
  CALIBRATION_MIN_DOMAIN_SAMPLE,
  CALIBRATION_MIN_TOTAL_SAMPLE,
  CalibrationCohortOverlapError,
  applyCalibration,
  evaluateCalibrationCohort,
  evaluateCalibrationShadow,
  fitCalibrationMap,
  isotonicKnots,
  knotsAreMonotone,
  parseCalibrationMap,
  resolveCalibrationMapForRun,
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

describe('golden fit on the frozen published-origin ledger', () => {
  // The map persisted on 2026-10-06 also fitted 9 unknown-origin rows
  // (7 conflict, 1 market, 1 supply_chain). Excluding them (#5240) changes only
  // identity domains, so the applied curve is the same as that map's.
  it('fits the frozen 2026-10-06 ledger exactly', () => {
    const map = fitCalibrationMap(FIXTURE.data, FIT_AT);
    assert.deepEqual(map, {
      schemaVersion: 1,
      version: `forecast-calibration-pav-v1@${FIT_AT}`,
      codeVersion: 'forecast-calibration-pav-v1',
      fittedAt: FIT_AT,
      fitWindow: { from: 1783494135407, to: FIT_AT },
      cohortFilter: {
        excludedOrigins: ['state_derived', 'bet_engine', 'unknown'],
        outcomes: ['YES', 'NO'],
        rollingWindowDays: 180,
        emissionField: 'generatedAt',
      },
      sourceStage: 'marketBlendedProbability',
      minTotalSample: 60,
      minDomainSample: 30,
      probabilityBounds: { floor: 0.01, ceiling: 0.99 },
      totalSample: 232,
      domains: {
        conflict: { n: 11, positives: 8, mode: 'identity', identityReason: 'insufficient_domain_sample', knots: [] },
        cyber: { n: 197, positives: 0, mode: 'isotonic', knots: [{ x: 0.011, y: 0.01 }, { x: 0.53, y: 0.01 }] },
        infrastructure: { n: 11, positives: 0, mode: 'identity', identityReason: 'insufficient_domain_sample', knots: [] },
        market: { n: 7, positives: 5, mode: 'identity', identityReason: 'insufficient_domain_sample', knots: [] },
        military: { n: 6, positives: 4, mode: 'identity', identityReason: 'insufficient_domain_sample', knots: [] },
      },
    });
  });

  it('pools adjacent violators on real mixed outcomes when the domain minimum is lowered', () => {
    const map = fitCalibrationMap(FIXTURE.data, FIT_AT, { minDomainSample: 10 });
    assert.deepEqual(map.domains.conflict, {
      n: 11,
      positives: 8,
      mode: 'isotonic',
      knots: [{ x: 0.332, y: 0.01 }, { x: 0.34, y: 0.777778 }, { x: 0.85, y: 0.777778 }, { x: 0.93, y: 0.99 }],
    });
    assert.equal(map.domains.market.mode, 'identity', 'n=7 stays below the lowered minimum');
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

describe('identity fallback', () => {
  const published = (count, domain, positives = 0) =>
    repeat(count, (index) => entry({ domain, probability: 0.2 + (index % 5) / 10, outcome: index < positives ? 'YES' : 'NO' }));

  it('keeps every domain identity below the total minimum, and fits at the total minimum', () => {
    assert.equal(CALIBRATION_MIN_TOTAL_SAMPLE, 60);
    const under = fitCalibrationMap(ledgerOf([...published(35, 'cyber'), ...published(24, 'conflict', 6)]), T0 + 30 * DAY_MS);
    assert.equal(under.totalSample, 59);
    assert.deepEqual(Object.values(under.domains).map((fit) => [fit.mode, fit.identityReason]), [
      ['identity', 'insufficient_total_sample'],
      ['identity', 'insufficient_total_sample'],
    ]);

    const at = fitCalibrationMap(ledgerOf([...published(35, 'cyber'), ...published(25, 'conflict', 6)]), T0 + 30 * DAY_MS);
    assert.equal(at.totalSample, 60);
    assert.equal(at.domains.cyber.mode, 'isotonic', 'positive control: total minimum met');
  });

  it('keeps a domain identity below the domain minimum, and fits it at the domain minimum', () => {
    assert.equal(CALIBRATION_MIN_DOMAIN_SAMPLE, 30);
    const map = fitCalibrationMap(ledgerOf([...published(29, 'conflict', 9), ...published(30, 'military', 9), ...published(40, 'cyber')]), T0 + 30 * DAY_MS);
    assert.equal(map.domains.conflict.mode, 'identity');
    assert.equal(map.domains.conflict.identityReason, 'insufficient_domain_sample');
    assert.deepEqual(map.domains.conflict.knots, []);
    assert.equal(map.domains.military.mode, 'isotonic', 'positive control: domain minimum met');
    assert.equal(applyCalibration(map, 'conflict', 0.37), 0.37);
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
    const clean = repeat(60, () => entry({ domain: 'cyber', probability: 0.4, outcome: 'NO' }));
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
    assert.equal(map.domains.cyber.positives, 0, 'a stale-anchor YES would have raised this');
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
});

describe('activation gate', () => {
  const fitAt = T0 + 30 * DAY_MS;
  const map = fitCalibrationMap(ledgerOf([
    ...repeat(60, () => entry({ domain: 'cyber', probability: 0.35, outcome: 'NO' })),
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
    const map = fitCalibrationMap(ledgerOf(repeat(60, () => entry({ probability: 0.35 }))), fitAt);
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

describe('no live clock', () => {
  it('requires an injected time and never reads the wall clock', () => {
    assert.throws(() => fitCalibrationMap({}, undefined), TypeError);
    const source = readFileSync(new URL('../scripts/_forecast-calibration.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /Date\.now\(|new Date\(|performance\.now\(/);
  });
});
