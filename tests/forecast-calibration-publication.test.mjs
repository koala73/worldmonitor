import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import { alignPriorToPublication, applyPublishedCalibration, fitCalibrationMap } from '../scripts/_forecast-calibration.mjs';
import {
  CALIBRATION_PUBLICATION_KEY,
  __setRedisStoreForTests,
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
    calibrationShadow: {
      status: 'shadow',
      mapVersion: MAP.version,
      activationGate: {
        eligible,
        reasons: eligible ? [] : ['overall_not_non_inferior'],
        forwardCount: 72,
        overall: { brierDeltaUpper: eligible ? -0.011 : 0.012, nonInferior: eligible },
        domains: [{ domain: 'cyber', count: 41, sufficient: true, brierDeltaUpper: -0.02, nonInferior: true }],
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
    assert.match(flipLine, /forward=72/);
    assert.match(flipLine, /brierDeltaUpper=-0\.011/);
    assert.match(flipLine, /cyber:41:-0\.02/);

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
    let ledger = ingestHistory({}, [{ generatedAt, predictions: [entry] }], generatedAt);
    const row = ledger[`fc-1@${deadline}`];
    assert.equal(row.probability, 0.2, 'the scorecard scores what was published');
    assert.equal(row.firstSeenProbability, 0.2);
    assert.equal(row.uncalibratedProbability, 0.4);

    const rawAgain = buildHistoryForecastEntry({ ...pred, probability: 0.4, uncalibratedProbability: undefined });
    ledger = ingestHistory(ledger, [{ generatedAt: generatedAt + 3_600_000, predictions: [rawAgain] }], generatedAt + 3_600_000);
    assert.equal(ledger[`fc-1@${deadline}`].probability, 0.4);
    assert.equal('uncalibratedProbability' in ledger[`fc-1@${deadline}`], false, 'a raw republication clears the lineage');
  });

  it('shows the publication record on the internal scorecard', () => {
    assert.equal(RESOLVER_PUBLICATION_KEY, CALIBRATION_PUBLICATION_KEY, 'the resolver reads the key the seeder writes');
    const record = { mode: 'raw', reason: 'gate_ineligible', mapVersion: MAP.version, gate: null, decidedAt: FIT_AT, lastFlip: null };
    assert.deepEqual(buildScorecard({}, FIT_AT, MAP, record).calibrationShadow.publication, record);
    assert.equal('publication' in buildScorecard({}, FIT_AT, MAP).calibrationShadow, false);
  });
});
