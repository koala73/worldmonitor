// Emission manifest (#9058): each run's archived inputs, its digest, and the
// link from history and the ledger back to them, plus the offline replay.
// Fixtures under tests/fixtures/forecast-replay/ are synthetic; real
// snapshots hold licensed data and must never be committed.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  __setRedisStoreForTests,
  buildDeepForecastSnapshotPayload,
  prepareDeepForecastSnapshot,
  runForecastAfterPublish,
  scoreDetectedPredictions,
} from '../scripts/seed-forecasts.mjs';
import * as seedForecasts from '../scripts/seed-forecasts.mjs';
import * as emaEngine from '../scripts/_ema-threat-engine.mjs';
import { __setS3ClientForTests, serializeR2JsonBody } from '../scripts/_r2-storage.mjs';
import { archiveCalibrationPublication } from '../scripts/_forecast-calibration.mjs';
import { buildBetsInputSnapshot, buildBetsSnapshot, writeBetsInputSnapshot } from '../scripts/seed-forecast-bets.mjs';
import { receiptPrefixInsideTracePrefix } from '../scripts/seed-forecast-resolutions.mjs';
import { buildBetsInputSnapshotKey, buildBetsRunId } from '../scripts/_forecast-bets-keys.mjs';
import {
  assertAllowlistedEnv,
  assertRevisionOnMain,
  compareEntry,
  compareReplay,
  LEGACY_RUN_MATCH_WINDOW_MS,
  legacyRunCandidates,
  passSucceeded,
  publicationFromArchive,
  replayDetectorStage,
  runReplayPass,
  snapshotDigest,
} from '../scripts/replay-forecast-detectors.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/forecast-replay/${name}`, import.meta.url), 'utf8'));
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

const R2_ENV = {
  CLOUDFLARE_R2_ACCOUNT_ID: 'acct-test',
  CLOUDFLARE_R2_TRACE_BUCKET: 'trace-test',
  CLOUDFLARE_R2_ACCESS_KEY_ID: 'key-test',
  CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'secret-test',
  CLOUDFLARE_R2_TRACE_PREFIX: 'traces-test',
};

// A calibration map that halves every conflict probability, so a replay that
// ignores the archived publication cannot match.
const HALVING_MAP = {
  schemaVersion: 1,
  version: 'map-test',
  codeVersion: 'test',
  fittedAt: 0,
  fitWindow: { from: 0, to: 0 },
  domains: {
    conflict: { mode: 'isotonic', knots: [{ x: 0, y: 0 }, { x: 1, y: 0.5 }], inputs: { 'fc-a@1': 'YES|0.6|conflict' } },
    cyber: { mode: 'identity' },
  },
};

/** What the seeder does at emission: detectors, scoring, the snapshot. */
function emitDetectorSnapshot({ calibrationPublication = null } = {}) {
  const { generatedAt, inputs } = fixture('detector-inputs.json');
  const RealNow = Date.now;
  Date.now = () => generatedAt;
  try {
    const predictions = seedForecasts.detectAllScenarios(structuredClone(inputs), emaEngine.computeRisk24h(emaEngine.computeEmaWindows(new Map(), [], [], generatedAt)));
    scoreDetectedPredictions(predictions, {
      inputs,
      prior: null,
      calibrationPublication: publicationFromArchive(calibrationPublication),
      cascadeRules: seedForecasts.loadCascadeRules(),
    });
    // The snapshot is a JSON object in R2; a replay reads it back parsed.
    return JSON.parse(serializeR2JsonBody(buildDeepForecastSnapshotPayload({
      generatedAt,
      inputs,
      predictions,
      fullRunPredictions: predictions,
      triggerContext: { deployRevision: 'test-revision' },
      calibrationPublicationArchive: calibrationPublication,
    }, { runId: `${generatedAt - 2000}-test` })));
  } finally {
    Date.now = RealNow;
  }
}

describe('deep snapshot payload (#9058)', () => {
  it('pins the top-level fields, calibrationPublication included', () => {
    const snapshot = buildDeepForecastSnapshotPayload({ generatedAt: 1 }, { runId: 'r' });
    assert.deepEqual(Object.keys(snapshot), [
      'version', 'runId', 'generatedAt', 'generatedAtIso', 'inputs', 'predictions', 'fullRunPredictions',
      'fullRunSituationClusters', 'fullRunSituationFamilies', 'fullRunStateUnits', 'selectionWorldSignals',
      'selectionMarketTransmission', 'selectionMarketState', 'selectionMarketInputCoverage', 'marketSelectionIndex',
      'triggerContext', 'enrichmentMeta', 'publishTelemetry', 'forecastDepth', 'deepForecast',
      'impactExpansionCandidates', 'priorWorldStateKey', 'calibrationPublication',
    ]);
    assert.equal(snapshot.calibrationPublication, null, 'a run without a decision archives null');
  });

  it('archives the decision and the map knots, not the per-row fit inputs', () => {
    const archived = archiveCalibrationPublication({
      map: HALVING_MAP,
      decision: { mode: 'calibrated', reason: 'gate_eligible', mapVersion: 'map-test', gate: { eligible: true } },
    }, 1234);
    assert.deepEqual(archived, {
      mode: 'calibrated',
      reason: 'gate_eligible',
      mapVersion: 'map-test',
      decidedAt: 1234,
      map: { ...HALVING_MAP, domains: { conflict: { mode: 'isotonic', knots: HALVING_MAP.domains.conflict.knots }, cyber: { mode: 'identity' } } },
    });
    assert.equal(archiveCalibrationPublication({ map: null, decision: { mode: 'raw', reason: 'no_map', mapVersion: null } }, 5).map, null);
    assert.equal(archiveCalibrationPublication({}, 5), null);
    const snapshot = buildDeepForecastSnapshotPayload({ generatedAt: 1, calibrationPublicationArchive: archived }, { runId: 'r' });
    assert.deepEqual(snapshot.calibrationPublication, archived);
  });

  it('wires the archive into fetchForecasts', () => {
    const source = readFileSync(new URL('../scripts/seed-forecasts.mjs', import.meta.url), 'utf8');
    assert.ok(source.includes('\n    calibrationPublicationArchive: archiveCalibrationPublication(calibrationPublication, runGeneratedAt),\n'));
    assert.ok(source.includes('\n  const predictions = detectAllScenarios(inputs, emaRiskScores);\n'), 'the seeder and the replay share one detector list');
  });
});

describe('snapshot digest at emission (#9058)', () => {
  const savedEnv = {};
  let puts;
  let redisCommands;
  let savedFetch;

  beforeEach(() => {
    for (const [key, value] of Object.entries(R2_ENV)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
    puts = new Map();
    redisCommands = [];
    __setS3ClientForTests({
      send: async (command) => {
        if (command.constructor.name === 'PutObjectCommand') {
          puts.set(command.input.Key, command.input.Body);
          return {};
        }
        return { Body: null };
      },
    });
    __setRedisStoreForTests({});
    savedFetch = globalThis.fetch;
    // redisCommand posts to the test URL; anything else (LLM providers) fails.
    globalThis.fetch = async (url, init = {}) => {
      if (String(url) !== 'http://test') throw new Error('network disabled in test');
      const command = JSON.parse(init.body);
      redisCommands.push(command);
      const result = command[0] === 'LRANGE' ? [] : 'OK';
      return new Response(JSON.stringify({ result }), { status: 200 });
    };
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    __setS3ClientForTests(null);
    __setRedisStoreForTests(null);
    globalThis.fetch = savedFetch;
  });

  it('the digest on history, manifest and pointer is the sha256 of the bytes written', async () => {
    const snapshot = emitDetectorSnapshot();
    const data = { ...snapshot, predictions: snapshot.fullRunPredictions, calibrationPublication: null };
    const quiet = { log: console.log, warn: console.warn };
    console.log = () => {};
    console.warn = () => {};
    try {
      await runForecastAfterPublish(data, { runId: snapshot.runId }, { deployRevision: 'test-revision' });
    } finally {
      console.log = quiet.log;
      console.warn = quiet.warn;
    }
    const snapshotKey = [...puts.keys()].find((key) => key.endsWith('/deep-snapshot.json'));
    assert.ok(snapshotKey, 'the snapshot was written');
    const written = puts.get(snapshotKey);
    const digest = sha256(written);

    const history = redisCommands.find((command) => command[0] === 'LPUSH' && command[1] === 'forecast:predictions:history:v1');
    assert.ok(history, 'history was appended');
    const entry = JSON.parse(history[2]);
    assert.equal(entry.runId, snapshot.runId);
    assert.equal(entry.snapshotSha256, digest);

    const manifest = JSON.parse(puts.get([...puts.keys()].find((key) => key.endsWith('/manifest.json'))));
    assert.equal(manifest.snapshotSha256, digest);
    const pointer = JSON.parse(redisCommands.find((command) => command[0] === 'LPUSH' && command[1] === 'forecast:trace:runs:v1')[2]);
    assert.equal(pointer.snapshotSha256, digest);
    assert.equal(snapshotDigest(JSON.parse(written)), digest, 'a reader recomputes the digest from the parsed object');
  });

  it('records no digest when R2 is not configured', () => {
    assert.deepEqual(prepareDeepForecastSnapshot({ runId: 'r' }, { storageConfigured: false }), { body: null, snapshotSha256: null });
    const prepared = prepareDeepForecastSnapshot({ runId: 'r' }, { storageConfigured: true });
    assert.equal(prepared.snapshotSha256, sha256(prepared.body));
  });
});

describe('bet-engine input snapshot (#9058)', () => {
  const input = fixture('bets-inputs.json');

  it('archives the fresh feeds, so buildBetsSnapshot on the archive reproduces every base rate', () => {
    const emitted = buildBetsSnapshot(input.feedsByKey, input.generatedAt, input.priorSeries);
    assert.ok(emitted.predictions.length >= 4);
    const archived = JSON.parse(serializeR2JsonBody(buildBetsInputSnapshot({
      runId: buildBetsRunId(input.generatedAt),
      generatedAt: input.generatedAt,
      feedsByKey: input.feedsByKey,
      priorSeries: input.priorSeries,
      predictions: emitted.predictions,
      deployRevision: 'test-revision',
    })));
    assert.deepEqual(Object.keys(archived.feedsByKey), ['energy:eia-petroleum:v1'], 'the stale commodities feed is filtered out, as the run did');
    assert.equal(archived.runId, `${input.generatedAt}-bets`);
    const replayed = buildBetsSnapshot(archived.feedsByKey, archived.generatedAt, archived.priorSeries);
    assert.deepEqual(
      replayed.predictions.map((bet) => [bet.id, bet.baselineProbability]),
      emitted.predictions.map((bet) => [bet.id, bet.baselineProbability]),
    );
    assert.deepEqual(archived.predictions.map((bet) => bet.baselineProbability), emitted.predictions.map((bet) => bet.baselineProbability));
    assert.deepEqual(archived.ensemble, { enabled: false });
  });

  it('writes under the dated trace run layout and returns the digest of the bytes written', async () => {
    const payload = buildBetsInputSnapshot({ runId: buildBetsRunId(input.generatedAt), generatedAt: input.generatedAt, feedsByKey: input.feedsByKey, priorSeries: input.priorSeries });
    let captured;
    const written = await writeBetsInputSnapshot(payload, {
      storageConfig: { basePrefix: 'traces-test' },
      putBody: async (_config, key, body) => {
        captured = { key, body };
        return { sha256: sha256(body) };
      },
    });
    assert.equal(captured.key, `traces-test/2026/09/15/${input.generatedAt}-bets/bets-input-snapshot.json`);
    assert.equal(captured.key, buildBetsInputSnapshotKey(payload.runId, payload.generatedAt, 'traces-test'));
    assert.equal(written.snapshotSha256, sha256(captured.body));
    assert.equal(await writeBetsInputSnapshot(payload, { storageConfig: null }), null);
  });

  it('bounds the whole write, so a slow R2 cannot hold the history append', { timeout: 5000 }, async () => {
    const payload = buildBetsInputSnapshot({ runId: buildBetsRunId(input.generatedAt), generatedAt: input.generatedAt, feedsByKey: {}, priorSeries: {} });
    const started = Date.now();
    await assert.rejects(
      writeBetsInputSnapshot(payload, { storageConfig: { basePrefix: 'p' }, putBody: () => new Promise(() => {}), budgetMs: 50 }),
      /timed out after 50ms/,
    );
    assert.ok(Date.now() - started < 2000);
  });
});

describe('replay comparison (#9058)', () => {
  it('compares a ledger window against firstSeenProbability, and a horizon window against its projection', () => {
    const replayed = [{ id: 'fc-a', probability: 0.4, projections: { h24: 0.3, d7: 0.4, d30: 0.2 } }];
    assert.equal(compareEntry({ key: 'fc-a@9', id: 'fc-a', probability: 0.5, firstSeenProbability: 0.4 }, replayed, 'detector').match, true);
    assert.equal(compareEntry({ key: 'fc-a@9', id: 'fc-a', probability: 0.4, firstSeenProbability: 0.5 }, replayed, 'detector').match, false);
    const horizon = compareEntry({ key: 'fc-a@9@h24', parentKey: 'fc-a@9', id: 'fc-a', firstSeenProbability: 0.3 }, replayed, 'detector');
    assert.deepEqual([horizon.field, horizon.match], ['projections.h24', true]);
    assert.equal(compareEntry({ key: 'fc-b@9', id: 'fc-b', firstSeenProbability: 0.3 }, replayed, 'detector').match, false, 'not replayed is not a match');
    assert.equal(compareEntry({ key: 'b@9', id: 'b', baselineProbability: 0.6 }, [{ id: 'b', baselineProbability: 0.6 }], 'bets').match, true);
  });

  it('documents the legacy match window in both languages', () => {
    const minutes = LEGACY_RUN_MATCH_WINDOW_MS / 60_000;
    assert.ok(readFileSync(new URL('../docs/panels/forecast.mdx', import.meta.url), 'utf8').includes(`minted up to ${minutes} minutes before`));
    assert.ok(readFileSync(new URL('../docs/zh/panels/forecast.mdx', import.meta.url), 'utf8').includes(`不超过 ${minutes} 分钟`));
  });

  it('runs only revisions on origin/main, and never fetches the revision itself', () => {
    const calls = [];
    const fakeGit = (onMain) => (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'merge-base' && !onMain()) throw new Error('not an ancestor');
      return '';
    };
    let fetched = false;
    assert.doesNotThrow(() => assertRevisionOnMain('abc1234', fakeGit(() => true)));
    assert.deepEqual(calls, ['merge-base --is-ancestor abc1234 refs/remotes/origin/main']);
    calls.length = 0;
    assert.throws(() => assertRevisionOnMain('def5678', (args) => {
      if (args[0] === 'fetch') fetched = true;
      return fakeGit(() => false)(args);
    }), /not on origin\/main/);
    assert.ok(fetched);
    assert.ok(calls.includes('fetch --quiet origin main'));
    assert.ok(!calls.some((call) => call.startsWith('fetch') && call.includes('def5678')), 'a fork-only commit is never fetched by sha');
    assert.throws(() => assertRevisionOnMain('main; rm -rf /', fakeGit(() => true)), /not a commit sha/);
  });

  it('accepts only the allowlisted child environment', () => {
    assert.doesNotThrow(() => assertAllowlistedEnv('t', { PATH: '/bin', TZ: 'UTC', HOME: '/tmp/h' }));
    for (const name of ['DATABASE_URL', 'CONVEX_DEPLOY_KEY', 'SMTP_PASSWORD', 'UPSTASH_REDIS_REST_TOKEN', 'NODE_OPTIONS']) {
      assert.throws(() => assertAllowlistedEnv('t', { PATH: '/bin', [name]: 'x' }), new RegExp(name));
    }
  });

  it('treats a receipt prefix at or under the trace prefix as inside it', () => {
    const at = (bucket, basePrefix) => ({ bucket, basePrefix });
    assert.equal(receiptPrefixInsideTracePrefix(at('b', 't'), at('b', 't')), true);
    assert.equal(receiptPrefixInsideTracePrefix(at('b', 't/r'), at('b', 't')), true);
    assert.equal(receiptPrefixInsideTracePrefix(at('b', 'tr'), at('b', 't')), false);
    assert.equal(receiptPrefixInsideTracePrefix(at('other', 't'), at('b', 't')), false);
  });

  it('locates a legacy run by the latest run id minted shortly before the entry', () => {
    const at = 1_000_000_000_000;
    assert.deepEqual(
      legacyRunCandidates([`${at - 20 * 60_000}-x`, `${at - 3000}-a`, `${at - 9000}-b`, `${at + 1000}-c`, `${at - 1000}-bets`, 'junk'], at),
      [`${at - 3000}-a`, `${at - 9000}-b`],
    );
  });

  it('replays the detector stage exactly, and a perturbed input produces differences', () => {
    const snapshot = emitDetectorSnapshot();
    const replayed = replayDetectorStage(seedForecasts, emaEngine, snapshot);
    const exact = compareReplay(snapshot, replayed);
    assert.ok(exact.recorded >= 6, `fixture fires several detectors (${exact.recorded})`);
    assert.deepEqual({ ...exact, diffs: undefined }, { recorded: exact.recorded, replayed: exact.recorded, exact: exact.recorded, differing: 0, missing: 0, extra: 0, diffs: undefined, projections: { exact: exact.recorded, differing: 0 } });

    const noMarkets = structuredClone(snapshot);
    noMarkets.inputs.predictionMarkets = null;
    const missing = compareReplay(snapshot, replayDetectorStage(seedForecasts, emaEngine, noMarkets));
    assert.ok(missing.missing > 0, 'removing the market feed drops its forecasts');

    const calmer = structuredClone(snapshot);
    for (const chokepoint of calmer.inputs.chokepoints.chokepoints) chokepoint.riskScore -= 4;
    const moved = compareReplay(snapshot, replayDetectorStage(seedForecasts, emaEngine, calmer));
    assert.ok(moved.differing > 0, 'a lower chokepoint risk moves probabilities');
    assert.equal(passSucceeded({ comparison: moved, entry: null }), false);
  });

  it('applies the archived calibration, so dropping it is detected', () => {
    const calibrationPublication = archiveCalibrationPublication({ map: HALVING_MAP, decision: { mode: 'calibrated', reason: 'gate_eligible', mapVersion: 'map-test' } }, 1);
    const snapshot = emitDetectorSnapshot({ calibrationPublication });
    assert.equal(compareReplay(snapshot, replayDetectorStage(seedForecasts, emaEngine, snapshot)).differing, 0);
    const unarchived = { ...snapshot, calibrationPublication: null };
    assert.ok(compareReplay(snapshot, replayDetectorStage(seedForecasts, emaEngine, unarchived)).differing > 0);
  });

  it('runs each lane in a child process with no credentials', async () => {
    const scratchDir = mkdtempSync(join(tmpdir(), 'wm-replay-test-'));
    try {
      const snapshotPath = join(scratchDir, 'snapshot.json');
      const snapshot = emitDetectorSnapshot();
      writeFileSync(snapshotPath, JSON.stringify(snapshot));
      // A credential in the parent must not reach the pass.
      const savedToken = process.env.UPSTASH_REDIS_REST_TOKEN;
      process.env.UPSTASH_REDIS_REST_TOKEN = 'test-not-a-secret';
      let replayed;
      try {
        replayed = await runReplayPass({ codeRoot: REPO_ROOT, snapshotPath, scratchDir });
      } finally {
        if (savedToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
        else process.env.UPSTASH_REDIS_REST_TOKEN = savedToken;
      }
      const comparison = compareReplay(snapshot, replayed);
      assert.equal(passSucceeded({ comparison, entry: null }), true, JSON.stringify(comparison));

      const bets = fixture('bets-inputs.json');
      const emitted = buildBetsSnapshot(bets.feedsByKey, bets.generatedAt, bets.priorSeries);
      const betsSnapshot = buildBetsInputSnapshot({ ...bets, runId: buildBetsRunId(bets.generatedAt), predictions: emitted.predictions });
      writeFileSync(snapshotPath, JSON.stringify(betsSnapshot));
      const betsComparison = compareReplay(betsSnapshot, await runReplayPass({ codeRoot: REPO_ROOT, snapshotPath, scratchDir }));
      assert.deepEqual([betsComparison.exact, betsComparison.differing, betsComparison.missing, betsComparison.extra], [emitted.predictions.length, 0, 0, 0]);
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it('runs the code under replay outside the repository, and aborts if it loads variables', async () => {
    const scratchDir = mkdtempSync(join(tmpdir(), 'wm-replay-stub-'));
    try {
      // A stand-in code root: its detector reports the pass's cwd and HOME.
      const codeRoot = join(scratchDir, 'code');
      mkdirSync(join(codeRoot, 'scripts'), { recursive: true });
      writeFileSync(join(codeRoot, 'scripts/_ema-threat-engine.mjs'), 'export const computeEmaWindows = () => new Map();\nexport const computeRisk24h = () => new Map();\n');
      const detector = (setsEnv) => `${setsEnv ? "process.env.LEAKED_SECRET = 'x';\n" : ''}export const detectAllScenarios = () => [{ id: process.cwd(), probability: 0.5, projections: null, generationOrigin: process.env.HOME }];\nexport const scoreDetectedPredictions = () => {};\n`;
      writeFileSync(join(codeRoot, 'scripts/seed-forecasts.mjs'), detector(false));
      const snapshotPath = join(scratchDir, 'snapshot.json');
      writeFileSync(snapshotPath, JSON.stringify({ generatedAt: 1, inputs: {}, fullRunPredictions: [] }));
      const passDir = join(scratchDir, 'pass');
      mkdirSync(passDir);
      const [row] = await runReplayPass({ codeRoot, snapshotPath, scratchDir: passDir });
      assert.ok(!row.id.startsWith(realpathSync(REPO_ROOT)) && !row.id.startsWith(realpathSync(codeRoot)), `cwd ${row.id} is outside the repository and the code root`);
      assert.ok(row.generationOrigin.startsWith(passDir), 'HOME is a scratch directory');

      writeFileSync(join(codeRoot, 'scripts/seed-forecasts.mjs'), detector(true));
      await assert.rejects(runReplayPass({ codeRoot: codeRoot, snapshotPath, scratchDir: passDir }), /replay pass failed/);
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it('an interrupted replay leaves no snapshot file or scratch worktree behind', async () => {
    const scratchDir = mkdtempSync(join(tmpdir(), 'wm-replay-signal-'));
    const tmp = join(scratchDir, 'tmp');
    mkdirSync(tmp);
    try {
      const file = join(scratchDir, 'snapshot.json');
      writeFileSync(file, JSON.stringify(emitDetectorSnapshot()));
      const child = spawn(process.execPath, ['scripts/replay-forecast-detectors.mjs', `--snapshot=${file}`, '--code=current', '--trust-unverified'], {
        cwd: REPO_ROOT,
        env: { ...process.env, TMPDIR: tmp },
      });
      child.stderr.on('data', (chunk) => {
        if (String(chunk).includes('[replay] current pass')) child.kill('SIGTERM');
      });
      const [code, signal] = await new Promise((resolveExit) => child.on('exit', (...args) => resolveExit(args)));
      assert.ok(code === 143 || signal === 'SIGTERM', `stopped by the signal (code ${code}, signal ${signal})`);
      assert.deepEqual(readdirSync(tmp), [], 'the scratch directory with the snapshot copy is gone');
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it('the CLI replays a local snapshot and exits non-zero on a difference', () => {
    const scratchDir = mkdtempSync(join(tmpdir(), 'wm-replay-cli-'));
    const cli = (file, ...flags) => spawnSync(process.execPath, ['scripts/replay-forecast-detectors.mjs', `--snapshot=${file}`, '--code=current', ...flags], { cwd: REPO_ROOT, encoding: 'utf8' });
    try {
      const snapshot = emitDetectorSnapshot();
      const exactPath = join(scratchDir, 'exact.json');
      writeFileSync(exactPath, JSON.stringify(snapshot));
      const unverified = cli(exactPath);
      assert.equal(unverified.status, 1);
      assert.equal(JSON.parse(unverified.stdout).status, 'snapshot_unverified', 'a snapshot with no recorded digest needs --sha256 or --trust-unverified');
      const mismatch = cli(exactPath, `--sha256=${'0'.repeat(64)}`);
      assert.equal(JSON.parse(mismatch.stdout).status, 'snapshot_digest_mismatch');
      const exact = cli(exactPath, `--sha256=${snapshotDigest(snapshot)}`);
      assert.equal(exact.status, 0, exact.stderr);
      const report = JSON.parse(exact.stdout);
      assert.equal(report.lane, 'detector');
      assert.equal(report.snapshot.sha256, snapshotDigest(snapshot));
      assert.deepEqual(report.passes.map((pass) => [pass.label, pass.exact]), [['current', true]]);

      const perturbed = structuredClone(snapshot);
      perturbed.inputs.predictionMarkets = null;
      const perturbedPath = join(scratchDir, 'perturbed.json');
      writeFileSync(perturbedPath, JSON.stringify(perturbed));
      const failed = cli(perturbedPath, '--trust-unverified');
      assert.equal(failed.status, 1);
      assert.ok(JSON.parse(failed.stdout).passes[0].comparison.missing > 0);
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});
