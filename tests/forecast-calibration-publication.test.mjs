import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';

import { alignPriorToPublication, applyPublishedCalibration, fitCalibrationMap } from '../scripts/_forecast-calibration.mjs';
import {
  CALIBRATION_PUBLICATION_KEY,
  PRIOR_KEY,
  __setRedisStoreForTests,
  resolveCalibrationRun,
  runForecastAfterPublish,
  scoreDetectedPredictions,
  buildHistoryForecastEntry,
  buildPriorForecastSnapshot,
  buildPublishedSeedPayload,
  computeTrends,
  resolveCalibrationPublication,
  writeCalibrationPublication,
} from '../scripts/seed-forecasts.mjs';
import {
  CALIBRATION_MAP_KEY,
  CALIBRATION_PUBLICATION_KEY as RESOLVER_PUBLICATION_KEY,
  SCORECARD_KEY,
  buildScorecard,
  ingestHistory,
} from '../scripts/seed-forecast-resolutions.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const FIT_AT = Date.UTC(2026, 8, 1);

function fitRow(i, outcome) {
  const generatedAt = FIT_AT - 20 * DAY_MS + i;
  return {
    id: `fit-${outcome}-${i}`,
    key: `fit-${outcome}-${i}@${generatedAt + 5 * DAY_MS}`,
    domain: 'cyber',
    generationOrigin: 'legacy_detector',
    probability: 0.4,
    status: 'resolved',
    outcome,
    generatedAt,
    deadline: generatedAt + 5 * DAY_MS,
    resolvedAt: generatedAt + 7 * DAY_MS,
  };
}

const MAP = fitCalibrationMap(Object.fromEntries([
  ...Array.from({ length: 48 }, (_, i) => fitRow(i, 'NO')),
  ...Array.from({ length: 12 }, (_, i) => fitRow(i, 'YES')),
].map((row) => [row.key, row])), FIT_AT);

function scorecardWithGate(eligible) {
  return {
    generatedAt: FIT_AT + DAY_MS,
    calibrationShadow: {
      status: 'shadow',
      mapVersion: MAP.version,
      activationGate: {
        eligible,
        reasons: eligible ? [] : ['overall_not_non_inferior'],
        forwardCount: 72,
        forwardFamilies: 64,
        overall: { brierDeltaUpper: eligible ? -0.011 : 0.012, nonInferior: eligible },
        domains: [{ domain: 'cyber', count: 41, families: 33, sufficient: true, brierDeltaUpper: -0.02, nonInferior: true }],
      },
    },
  };
}

function captureLogger() {
  const lines = [];
  return { lines, log: (line) => lines.push(line), warn: (line) => lines.push(line) };
}

afterEach(() => __setRedisStoreForTests(null));

describe('seeder calibration publication (#7070)', () => {
  it('runs the publish stages: an eligible forecast moves on every surface and the record is written', async () => {
    const store = {
      [CALIBRATION_MAP_KEY]: MAP,
      [SCORECARD_KEY]: scorecardWithGate(true),
      [PRIOR_KEY]: { predictions: [buildPriorForecastSnapshot({ id: 'fc-wire', domain: 'cyber', generationOrigin: 'legacy_detector', probability: 0.4 })] },
    };
    __setRedisStoreForTests(store);
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('network disabled in test'); };
    const quiet = { log: console.log, warn: console.warn };
    console.log = () => {};
    console.warn = () => {};
    try {
      const { calibrationPublication, prior } = await resolveCalibrationRun(FIT_AT + DAY_MS);
      const pred = { id: 'fc-wire', domain: 'cyber', region: 'Global', title: 'Cyber wiring', generationOrigin: 'legacy_detector', probability: 0.4, confidence: 0.5, timeHorizon: '7d', signals: [], cascades: [] };
      scoreDetectedPredictions([pred], { inputs: {}, prior, calibrationPublication, cascadeRules: [] });
      assert.equal(pred.probability, 0.2, 'the map moved the published probability');
      assert.equal(pred.uncalibratedProbability, 0.4);
      assert.equal(pred.projections.d7, 0.2, 'projections anchor on the calibrated value');
      assert.deepEqual({ trend: pred.trend, prior: pred.priorProbability }, { trend: 'stable', prior: 0.2 }, 'the raw prior is re-expressed, not read as a fall');

      await runForecastAfterPublish({ predictions: [pred], calibrationPublication: calibrationPublication.record }, { runId: 'test' }, {});
      assert.equal(store[CALIBRATION_PUBLICATION_KEY]?.mode, 'calibrated');
      assert.equal(store[CALIBRATION_PUBLICATION_KEY].lastFlip.to, 'calibrated');
    } finally {
      globalThis.fetch = savedFetch;
      console.log = quiet.log;
      console.warn = quiet.warn;
    }
  });

  it('wires the calibration stages into fetchForecasts', () => {
    // fetchForecasts needs live inputs, so its three calibration hand-offs are
    // pinned in source; the stages themselves are exercised in the test above.
    const source = readFileSync(new URL('../scripts/seed-forecasts.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('async function fetchForecasts() {');
    assert.notEqual(start, -1, 'missing source marker: fetchForecasts');
    const end = source.indexOf('\n}\n', start);
    const body = source.slice(start, end);
    const resolveAt = body.indexOf('const { calibrationPublication, prior } = await resolveCalibrationRun(runGeneratedAt);');
    const scoreAt = body.indexOf('scoreDetectedPredictions(predictions, { inputs, prior, calibrationPublication, cascadeRules });');
    assert.notEqual(resolveAt, -1, 'fetchForecasts must resolve the calibration decision and the aligned prior');
    assert.notEqual(scoreAt, -1, 'fetchForecasts must score detector output through scoreDetectedPredictions');
    assert.ok(resolveAt < scoreAt, 'the decision must exist before scoring');
    assert.match(body, /\n    calibrationPublication: calibrationPublication\.record,\n/, 'the run must hand its record to afterPublish');
  });

  it('publishes calibrated on an eligible gate and logs the flip with the gate numbers', async () => {
    const store = { [CALIBRATION_MAP_KEY]: MAP, [SCORECARD_KEY]: scorecardWithGate(true) };
    __setRedisStoreForTests(store);
    const logger = captureLogger();
    const run = await resolveCalibrationPublication(FIT_AT + DAY_MS, { env: {}, logger });
    assert.equal(run.decision.mode, 'calibrated');
    assert.equal(run.map.version, MAP.version);
    assert.equal(run.flipped, true);
    const flipLine = logger.lines.find((line) => line.includes('FLIP'));
    assert.match(flipLine, /raw -> calibrated/);
    assert.match(flipLine, /reason=gate_eligible/);
    assert.match(flipLine, /forward=72 forwardFamilies=64/);
    assert.match(flipLine, /brierDeltaUpper=-0\.011/);
    assert.match(flipLine, /cyber:41:33:-0\.02/);

    await writeCalibrationPublication(run.record);
    assert.equal(store[CALIBRATION_PUBLICATION_KEY].mode, 'calibrated');
    assert.equal(store[CALIBRATION_PUBLICATION_KEY].lastFlip.at, FIT_AT + DAY_MS);
  });

  it('reverts on a failing gate, and a rerun on the same state is not a flip', async () => {
    const store = { [CALIBRATION_MAP_KEY]: MAP, [SCORECARD_KEY]: scorecardWithGate(true) };
    __setRedisStoreForTests(store);
    const on = await resolveCalibrationPublication(FIT_AT + DAY_MS, { env: {}, logger: captureLogger() });
    await writeCalibrationPublication(on.record);

    const rerun = await resolveCalibrationPublication(FIT_AT + DAY_MS + 3_600_000, { env: {}, logger: captureLogger() });
    assert.equal(rerun.flipped, false);
    assert.equal(rerun.decision.mode, 'calibrated');
    assert.deepEqual(rerun.record.lastFlip, on.record.lastFlip);
    await writeCalibrationPublication(rerun.record);

    store[SCORECARD_KEY] = scorecardWithGate(false);
    const logger = captureLogger();
    const off = await resolveCalibrationPublication(FIT_AT + 2 * DAY_MS, { env: {}, logger });
    assert.equal(off.decision.mode, 'raw');
    assert.equal(off.decision.reason, 'gate_ineligible');
    assert.equal(off.flipped, true);
    assert.match(logger.lines.find((line) => line.includes('FLIP')), /calibrated -> raw .*reason=gate_ineligible .*gateReasons=overall_not_non_inferior/);
  });

  it('forces raw when FORECAST_CALIBRATION_FORCE_RAW=1', async () => {
    __setRedisStoreForTests({ [CALIBRATION_MAP_KEY]: MAP, [SCORECARD_KEY]: scorecardWithGate(true) });
    const run = await resolveCalibrationPublication(FIT_AT + DAY_MS, { env: { FORECAST_CALIBRATION_FORCE_RAW: '1' }, logger: captureLogger() });
    assert.deepEqual({ mode: run.decision.mode, reason: run.decision.reason }, { mode: 'raw', reason: 'force_raw' });
    assert.equal(run.flipped, false);
  });

  it('logs a revert on a failed gate read and keeps the stored flip history', async () => {
    const store = { [CALIBRATION_MAP_KEY]: MAP, [SCORECARD_KEY]: scorecardWithGate(true) };
    __setRedisStoreForTests(store);
    const on = await resolveCalibrationPublication(FIT_AT + DAY_MS, { env: {}, logger: captureLogger() });
    await writeCalibrationPublication(on.record);

    __setRedisStoreForTests(new Proxy(store, {
      get(target, key) {
        if (key === SCORECARD_KEY) throw new Error('upstash 503');
        return target[key];
      },
    }));
    const logger = captureLogger();
    const failed = await resolveCalibrationPublication(FIT_AT + 2 * DAY_MS, { env: {}, logger });
    assert.deepEqual({ mode: failed.decision.mode, reason: failed.decision.reason, flipped: failed.flipped }, { mode: 'raw', reason: 'read_failed', flipped: true });
    assert.match(logger.lines.find((line) => line.includes('FLIP')), /calibrated -> raw .*reason=read_failed/);
    assert.equal(failed.record.lastFlip.from, 'calibrated');
  });

  it('never overwrites the stored record when the previous record cannot be read', async () => {
    const store = { [CALIBRATION_MAP_KEY]: MAP, [SCORECARD_KEY]: scorecardWithGate(true) };
    __setRedisStoreForTests(store);
    const on = await resolveCalibrationPublication(FIT_AT + DAY_MS, { env: {}, logger: captureLogger() });
    await writeCalibrationPublication(on.record);
    const stored = structuredClone(store[CALIBRATION_PUBLICATION_KEY]);

    __setRedisStoreForTests(new Proxy(store, {
      get(target, key) {
        if (key === CALIBRATION_PUBLICATION_KEY) throw new Error('upstash 503');
        return target[key];
      },
    }));
    const run = await resolveCalibrationPublication(FIT_AT + 2 * DAY_MS, { env: {}, logger: captureLogger() });
    assert.equal(run.decision.mode, 'calibrated', 'the decision never depends on the previous record');
    assert.equal(run.record, null);
    await writeCalibrationPublication(run.record);
    assert.deepEqual(store[CALIBRATION_PUBLICATION_KEY], stored);
  });

  it('compares trends on one scale across a flip, so a method change is not a move', () => {
    const decision = { mode: 'calibrated', reason: 'gate_eligible', mapVersion: MAP.version, gate: null };
    const rawPrior = { predictions: [buildPriorForecastSnapshot({ id: 'a', domain: 'cyber', generationOrigin: 'legacy_detector', probability: 0.4 })] };
    const current = [{ id: 'a', domain: 'cyber', generationOrigin: 'legacy_detector', probability: 0.4 }];
    applyPublishedCalibration(current, MAP, decision);
    assert.equal(current[0].probability, 0.2);
    computeTrends(current, alignPriorToPublication(rawPrior, MAP, decision));
    assert.deepEqual({ trend: current[0].trend, prior: current[0].priorProbability }, { trend: 'stable', prior: 0.2 });

    const calibratedPrior = { predictions: [buildPriorForecastSnapshot(current[0])] };
    const reverted = [{ id: 'a', domain: 'cyber', generationOrigin: 'legacy_detector', probability: 0.4 }];
    const rawDecision = { ...decision, mode: 'raw', reason: 'gate_ineligible' };
    computeTrends(reverted, alignPriorToPublication(calibratedPrior, MAP, rawDecision));
    assert.deepEqual({ trend: reverted[0].trend, prior: reverted[0].priorProbability }, { trend: 'stable', prior: 0.4 });
  });

  it('keeps uncalibratedProbability out of the public payload', () => {
    const payload = buildPublishedSeedPayload({
      generatedAt: FIT_AT,
      predictions: [{ id: 'a', domain: 'cyber', region: 'Global', title: 't', probability: 0.2, uncalibratedProbability: 0.4, confidence: 0.5, timeHorizon: '7d', signals: [] }],
    });
    assert.doesNotMatch(JSON.stringify(payload), /uncalibratedProbability/);
  });

  it('fails loudly when Redis rejects the publication record write', async () => {
    const saved = { fetch: globalThis.fetch, url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN };
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    const sent = [];
    try {
      globalThis.fetch = async (_url, init) => {
        sent.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ error: 'OOM command not allowed' }), { status: 200 });
      };
      await assert.rejects(writeCalibrationPublication({ mode: 'raw' }), /OOM command not allowed/);
      globalThis.fetch = async () => new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
      await writeCalibrationPublication({ mode: 'raw' });
      assert.deepEqual(sent[0].slice(0, 3), ['SET', CALIBRATION_PUBLICATION_KEY, JSON.stringify({ mode: 'raw' })]);
    } finally {
      globalThis.fetch = saved.fetch;
      for (const [name, value] of [['UPSTASH_REDIS_REST_URL', saved.url], ['UPSTASH_REDIS_REST_TOKEN', saved.token]]) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('records the published probability in the ledger and keeps the uncalibrated value beside it', () => {
    const deadline = FIT_AT + 10 * DAY_MS;
    const pred = {
      id: 'fc-1',
      domain: 'cyber',
      region: 'Global',
      title: 'Cyber forecast',
      generationOrigin: 'legacy_detector',
      probability: 0.2,
      uncalibratedProbability: 0.4,
      resolution: { kind: 'hard', deadline, sourceFeed: 'cyber:threats:v2', metricKey: 'count', operator: 'gte', threshold: 1 },
    };
    const entry = buildHistoryForecastEntry(pred);
    assert.equal(entry.probability, 0.2);
    assert.equal(entry.uncalibratedProbability, 0.4);

    const generatedAt = FIT_AT + DAY_MS;
    const withHorizon = {
      ...entry,
      projections: { h24: 0.15, d7: 0.2, d30: 0.25 },
      horizonResolutions: { d30: { kind: 'hard', deadline: deadline + 20 * DAY_MS, timeHorizon: '30d', sourceFeed: 'cyber:threats:v2' } },
    };
    let ledger = ingestHistory({}, [{ generatedAt, predictions: [withHorizon] }], generatedAt);
    const horizonRow = ledger[`fc-1@${deadline}@d30`];
    assert.equal(horizonRow.probability, 0.25);
    assert.equal('uncalibratedProbability' in horizonRow, false, 'a projection row has no post-blend lineage of its own');
    const row = ledger[`fc-1@${deadline}`];
    assert.equal(row.probability, 0.2, 'the scorecard scores what was published');
    assert.equal(row.firstSeenProbability, 0.2);
    assert.equal(row.uncalibratedProbability, 0.4);

    const rawAgain = buildHistoryForecastEntry({ ...pred, probability: 0.4, uncalibratedProbability: undefined });
    ledger = ingestHistory(ledger, [{ generatedAt: generatedAt + 3_600_000, predictions: [rawAgain] }], generatedAt + 3_600_000);
    assert.equal(ledger[`fc-1@${deadline}`].probability, 0.2, 'a republication of the same question is not scored (#8990)');
    assert.equal(ledger[`fc-1@${deadline}`].uncalibratedProbability, 0.4, 'the lineage stays paired with the scored probability');
    assert.equal(ledger[`fc-1@${deadline}`].lastSeenProbability, 0.4);
  });

  it('shows the publication record on the internal scorecard', () => {
    assert.equal(RESOLVER_PUBLICATION_KEY, CALIBRATION_PUBLICATION_KEY, 'the resolver reads the key the seeder writes');
    const record = { mode: 'raw', reason: 'gate_ineligible', mapVersion: MAP.version, gate: null, decidedAt: FIT_AT, lastFlip: null };
    assert.deepEqual(buildScorecard({}, FIT_AT, MAP, record).calibrationShadow.publication, record);
    assert.equal('publication' in buildScorecard({}, FIT_AT, MAP).calibrationShadow, false);
  });
});
