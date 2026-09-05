import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  evaluateRecovery, projectSource, projectRuns, captureObservation, main, validateRecord,
} from '../scripts/capture-seed-recovery.mjs';

const START = '2026-09-05T07:00:00.000Z';
const BASELINE = '2026-09-05T06:53:00.000Z';
const COMMIT = 'a'.repeat(40);
const PROJECT = '29419572-0b0d-437f-8e71-4fa68daf514f';
const DEPLOYMENT = '8b1d7d2b-8a36-473b-9fa8-1eeb7a911b2d';
const at = (minutes) => new Date(Date.parse(START) + minutes * 60_000).toISOString();
const env = { WM_API_KEY: 'private-health-key', UPSTASH_REDIS_REST_URL: 'https://redis.example', UPSTASH_REDIS_REST_TOKEN: 'private-redis-key' };
const config = {
  wildfires: ['seed-fire-detections', '*/10 * * * *', 'wildfire', ''],
  physicalDivergence: ['seed-bundle-macro', '0 8,9 * * *', 'market', 'Physical-Premiums'],
  crossStraitActivityTaiwanMnd: ['seed-bundle-derived-signals', '*/5 * * * *', 'military', 'Cross-Strait-Activity'],
};

function record(source = 'wildfires') {
  return { version: 1, source, requiredCommit: COMMIT, pr: 7701, owner: 'operator', project: PROJECT,
    createdAt: START, deadline: at(source === 'wildfires' ? 60 : 390), baselineSuccessAt: BASELINE, observations: [] };
}

function observation(minutes, source = 'wildfires', changes = {}) {
  const success = minutes === 0 ? BASELINE : at(minutes - 1);
  return {
    observedAt: at(minutes),
    deployment: { id: DEPLOYMENT, commit: COMMIT, ancestry: 'yes', createdAt: at(-20), cronSchedule: config[source][1] },
    source: { healthStatus: 'OK', healthCheckedAt: at(minutes), recordCount: source === 'physicalDivergence' ? 2 : 100,
      sourceState: 'ok', lastSuccessAt: success, consecutiveSourceFailures: 0,
      transportStatus: 'fresh', failureCode: null, inputFreshUntil: at(400) },
    runs: minutes === 0 ? [] : [{ startedAt: at(minutes - 3), completedAt: at(minutes - 0.5),
      containerStartedAt: at(minutes - 3), scheduled: true, state: 'OK', completeCoverage: true, recoveryPath: true }],
    ...changes,
  };
}

function recovering(source = 'wildfires', times = [14, 24, 34]) {
  const history = [];
  return { ...record(source), observations: [observation(0, source), ...times.map((minutes) => {
    const row = observation(minutes, source);
    history.push(...row.runs);
    row.runs = structuredClone(history);
    return row;
  })] };
}

test('counts three distinct complete wildfire runs and requires the recovery path', () => {
  const input = recovering();
  assert.equal(evaluateRecovery(input).status, 'passed');
  input.observations.flatMap((item) => item.runs).forEach((run) => { run.recoveryPath = false; });
  assert.deepEqual(evaluateRecovery(input), { status: 'observing', reason: 'RECOVERY_PATH_NOT_OBSERVED', successfulRuns: 3, requiredRuns: 3 });
});

test('repeated polls and repeated completion cannot become multiple successful runs', () => {
  const input = recovering('wildfires', [14]);
  input.observations.push({ ...structuredClone(input.observations[1]), observedAt: at(15) });
  assert.equal(evaluateRecovery(input).successfulRuns, 1);
  input.observations.at(-1).source.lastSuccessAt = at(13.1);
  assert.equal(evaluateRecovery(input).status, 'unverified');
  assert.equal(evaluateRecovery(input).successfulRuns, 0);
});

test('a source failure resets the sequence while retained success remains unchanged', () => {
  const input = recovering('wildfires', [14, 24]);
  const failed = observation(25);
  failed.source = { ...input.observations.at(-1).source, healthCheckedAt: at(25), sourceState: 'degraded', healthStatus: 'SEED_ERROR', consecutiveSourceFailures: 1 };
  input.observations.push(failed, observation(34));
  assert.equal(evaluateRecovery(input).successfulRuns, 1);
  assert.equal(evaluateRecovery(input).status, 'observing');
});

test('an unsampled member completion breaks consecutive proof', () => {
  const input = recovering('wildfires', [14, 34]);
  input.observations.at(-1).runs.unshift(...observation(24).runs);
  assert.equal(evaluateRecovery(input).successfulRuns, 1);
});

test('an intervening attempt without completion breaks consecutive proof', () => {
  const input = recovering('wildfires', [14, 34]);
  input.observations.at(-1).runs.push({ startedAt: at(21), completedAt: null, state: 'INCOMPLETE' });
  assert.equal(evaluateRecovery(input).successfulRuns, 1);
});

test('a cached unhealthy verdict can catch up without discarding the new source success', () => {
  const input = recovering('physicalDivergence', [64]);
  input.observations[1].source.healthStatus = 'SEED_ERROR';
  const fresh = structuredClone(input.observations[1]);
  fresh.observedAt = at(65);
  fresh.source.healthStatus = 'OK';
  fresh.source.healthCheckedAt = at(65);
  input.observations.push(fresh);
  assert.equal(evaluateRecovery(input).status, 'passed');
});

test('wrong, unknown, and replaced deployments cannot inherit acceptance', () => {
  for (const ancestry of ['no', 'unknown']) {
    const input = recovering();
    input.observations.forEach((row) => { row.deployment.ancestry = ancestry; });
    assert.equal(evaluateRecovery(input).status, ancestry === 'no' ? 'waiting_for_deployment' : 'unverified');
  }
  const input = recovering();
  input.observations[3].deployment.id = 'new-deployment';
  assert.equal(evaluateRecovery(input).successfulRuns, 0);
  assert.equal(evaluateRecovery(input).status, 'unverified');
});

test('a deadline failure stays failed across resume and late successful evidence', () => {
  const input = recovering('wildfires', [14, 24]);
  input.observations.push(observation(61), observation(74));
  const verdict = evaluateRecovery(input);
  assert.equal(verdict.status, 'failed');
  assert.match(verdict.reason, /^DEADLINE:/);
  assert.equal(evaluateRecovery({ ...input, observations: [...input.observations, observation(84)] }).status, 'failed');
});

test('Taiwan requires two separate three-hour source successes, not bundle OK or attempts', () => {
  const source = 'crossStraitActivityTaiwanMnd';
  const input = recovering(source, [14, 194]);
  assert.equal(evaluateRecovery(input).status, 'passed');
  input.observations[2].source.lastSuccessAt = input.observations[1].source.lastSuccessAt;
  input.observations[2].source.lastAttemptAt = at(193);
  assert.notEqual(evaluateRecovery(input).status, 'passed');
  assert.notEqual(evaluateRecovery(recovering(source, [14, 24])).status, 'passed');
});

test('physical divergence initial recovery requires two records and fresh inputs', () => {
  const input = recovering('physicalDivergence', [64]);
  assert.equal(evaluateRecovery(input).status, 'passed');
  for (const changes of [{ recordCount: 1 }, { inputFreshUntil: at(60) }, { inputFreshUntil: 'invalid' }]) {
    const changed = structuredClone(input);
    Object.assign(changed.observations[1].source, changes);
    assert.notEqual(evaluateRecovery(changed).status, 'passed');
  }
});

test('missing health registration, stale health, and malformed metadata fail closed', () => {
  const health = { checkedAt: at(14), checks: { wildfires: { status: 'OK' } } };
  const meta = { fetchedAt: Date.parse(at(13)), recordCount: 100, sourceState: 'ok', consecutiveSourceFailures: 0 };
  assert.equal(projectSource('wildfires', health, meta, null, at(14)).lastSuccessAt, at(13));
  const published = { ...meta };
  delete published.consecutiveSourceFailures;
  assert.equal(projectSource('wildfires', health, published, null, at(14)).consecutiveSourceFailures, 0);
  assert.throws(() => projectSource('wildfires', health, { ...published, sourceState: 'degraded' }, null, at(14)), /SOURCE_METADATA/);
  for (const changed of [{ ...health, checks: {} }, { ...health, checkedAt: at(1) }, { ...health, checkedAt: '2026-02-30T00:00:00Z' }]) {
    assert.throws(() => projectSource('wildfires', changed, meta, null, at(14)), /HEALTH_UNVERIFIED/);
  }
  assert.throws(() => projectSource('wildfires', health, { ...meta, fetchedAt: at(20) }, null, at(14)), /SOURCE_METADATA/);
  assert.throws(() => validateRecord({ ...record(), deadline: '2026-02-30T00:00:00Z' }), /INVALID_CHECKPOINT/);
  const input = recovering();
  input.observations[2] = { observedAt: at(24), error: 'READ_FAILED' };
  assert.equal(evaluateRecovery(input).successfulRuns, 1);
});

function logs(source = 'wildfires', minutes = 14) {
  const event = { event: 'seed_complete', domain: config[source][2], timestamp: at(minutes - 0.5), durationMs: 150_000, state: 'OK' };
  return [
    { timestamp: at(minutes - 3.5), message: 'Starting Container' },
    { timestamp: at(minutes - 3), message: `${config[source][3] ? `[${config[source][3]}] ` : ''}  Run ID:  ${Date.parse(at(minutes - 3))}-abc123` },
    { timestamp: at(minutes - 2), message: '  [FIRMS] VIIRS_SNPP_NRT/Taiwan: secondary HTTP 400; trying primary retry' },
    { timestamp: at(minutes - 0.5), message: '  VIIRS_NOAA21_NRT: 100 total (27 ok, 0 failed)' },
    config[source][3] ? { timestamp: event.timestamp, message: `  [${config[source][3]}] ${JSON.stringify(event)}` } : { ...event, message: '' },
  ];
}

test('reads standalone structured and bundle-prefixed completions with cron starts', () => {
  for (const [source, minutes] of [['wildfires', 14], ['physicalDivergence', 64], ['crossStraitActivityTaiwanMnd', 14]]) {
    const runs = projectRuns(source, logs(source, minutes), { cronSchedule: config[source][1] }, at(minutes));
    assert.equal(runs.length, 1);
    assert.equal(runs[0].scheduled, true);
    assert.equal(runs[0].completeCoverage, true);
    assert.equal(runs[0].recoveryPath, source === 'wildfires');
  }
  const noStart = logs().slice(1);
  assert.equal(projectRuns('wildfires', noStart, { cronSchedule: config.wildfires[1] }, at(14))[0].scheduled, false);
  const offSchedule = logs();
  offSchedule[0].timestamp = at(9);
  assert.equal(projectRuns('wildfires', offSchedule, { cronSchedule: config.wildfires[1] }, at(14))[0].scheduled, false);
  assert.throws(() => projectRuns('wildfires', Array(1000).fill({}), {}, at(14)), /INCOMPLETE/);
  const crashed = [...logs(), { timestamp: at(21), message: `  Run ID:  ${Date.parse(at(21))}-def456` }];
  assert.equal(projectRuns('wildfires', crashed, { cronSchedule: config.wildfires[1] }, at(24))[1].state, 'INCOMPLETE');
});

test('accepts a delayed macro cron start within five minutes and rejects later starts', () => {
  const source = 'physicalDivergence';
  const event = { event: 'seed_complete', domain: 'market', timestamp: '2026-09-05T08:04:53.871Z', durationMs: 2549, state: 'OK' };
  const delayed = [
    { timestamp: '2026-09-05T08:04:50.045Z', message: 'Starting Container' },
    { timestamp: event.timestamp, message: `  [Physical-Premiums] ${JSON.stringify(event)}` },
  ];
  const deployment = { cronSchedule: config[source][1] };
  assert.equal(projectRuns(source, delayed, deployment, at(70))[0].scheduled, true);
  delayed[0].timestamp = '2026-09-05T08:05:00.000Z';
  assert.equal(projectRuns(source, delayed, deployment, at(70))[0].scheduled, false);
});

function fixture(source = 'wildfires', minutes = 0) {
  const [serviceName, cronSchedule] = config[source];
  const successAt = minutes === 0 ? BASELINE : at(minutes - 1);
  return {
    now: Date.parse(at(minutes)),
    status: { id: PROJECT, environments: { edges: [{ node: {
      id: 'production-id', name: 'production', serviceInstances: { edges: [{ node: {
        serviceName, source: { repo: 'koala73/worldmonitor' }, cronSchedule,
        activeDeployments: [{ id: DEPLOYMENT, status: 'SUCCESS', createdAt: at(-20), meta: {
          commitHash: COMMIT, repo: 'koala73/worldmonitor', branch: 'main', serviceManifest: { deploy: { cronSchedule } },
        } }],
      } }] },
    } }] } },
    health: { checkedAt: at(minutes), checks: { [source]: { status: 'OK' } } },
    meta: { fetchedAt: Date.parse(successAt), recordCount: source === 'physicalDivergence' ? 2 : 100,
      sourceState: 'ok', consecutiveSourceFailures: 0, inputFreshUntil: at(400) },
    detail: { lastSuccessAt: successAt, lastAttemptAt: successAt, transportStatus: 'fresh', errorCodes: [] },
    logs: minutes ? (source === 'wildfires' ? [14, 24, 34].filter((minute) => minute <= minutes).flatMap((minute) => logs(source, minute)) : logs(source, minutes)) : [],
  };
}

function dependencies(data, calls = []) {
  return { now: data.now, env,
    railway(args, options) {
      calls.push(['railway', args]);
      assert.equal(options.timeout, 20_000);
      if (args[0] === 'status') return JSON.stringify(data.status);
      assert.equal(args[0], 'logs');
      assert.equal(args[1], DEPLOYMENT);
      assert.ok(args.includes('--until'));
      return data.logs.map((line) => JSON.stringify(line)).join('\n');
    },
    git(args) { calls.push(['git', args]); assert.deepEqual(args, ['merge-base', '--is-ancestor', COMMIT, COMMIT]); return ''; },
    async fetchFn(url, options) {
      calls.push(['fetch', String(url), options]);
      assert.equal(options.redirect, 'error');
      if (String(url).endsWith('/api/health')) return new Response(JSON.stringify(data.health));
      assert.equal(String(url), 'https://redis.example/pipeline');
      const keys = JSON.parse(options.body);
      assert.ok(keys.every(([command]) => command === 'GET'));
      assert.ok(keys.length <= 2);
      return new Response(JSON.stringify(keys.map((_, index) => ({ result: JSON.stringify(index ? data.detail : data.meta) }))));
    },
  };
}

test('capture uses only registered metadata reads, explicit production identity, and bounded logs', async () => {
  const calls = [];
  const result = await captureObservation(record(), dependencies(fixture('wildfires', 14), calls));
  assert.equal(result.error, undefined);
  assert.equal(result.runs[0].scheduled, true);
  const redis = calls.find((call) => call[0] === 'fetch' && call[1].endsWith('/pipeline'));
  assert.deepEqual(JSON.parse(redis[2].body), [['GET', 'seed-meta:wildfire:fires']]);
  const serialized = JSON.stringify(result);
  for (const secret of Object.values(env)) assert.ok(!serialized.includes(secret));
});

test('failed reads, wrong project, and ambiguous images produce sanitized unverified observations', async () => {
  const data = fixture();
  for (const overrides of [
    { fetchFn: async () => { throw new Error('https://private.example?key=secret'); } },
    { fetchFn: async () => new Response('secret', { status: 401 }) },
    { railway: () => JSON.stringify({ ...data.status, id: 'wrong-project' }) },
  ]) {
    const result = await captureObservation(record(), { ...dependencies(data), ...overrides });
    assert.ok(result.error);
    assert.ok(!JSON.stringify(result).includes('secret'));
  }
  data.status.environments.edges[0].node.serviceInstances.edges[0].node.activeDeployments.push({ id: 'another-image' });
  assert.equal((await captureObservation(record(), dependencies(data))).error, 'DEPLOYMENT_UNVERIFIED');
});

test('checkpoint baseline and deadline survive resume; mismatched identity cannot overwrite it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'seed-recovery-'));
  const output = join(directory, 'recovery.json');
  try {
    const args = ['--source', 'wildfires', '--required-commit', COMMIT, '--pr', '7701', '--owner', 'operator', '--project', PROJECT, '--deadline', at(60), '--output', output];
    await main(args, dependencies(fixture()));
    for (const minutes of [14, 24, 34]) await main(['--resume', output], dependencies(fixture('wildfires', minutes)));
    const saved = JSON.parse(readFileSync(output));
    assert.equal(saved.verdict.status, 'passed');
    assert.equal(saved.baselineSuccessAt, BASELINE);
    assert.equal(saved.deadline, at(60));
    const before = readFileSync(output, 'utf8');
    for (const flags of [['--source', 'physicalDivergence'], ['--required-commit', 'b'.repeat(40)], ['--deadline', at(120)]]) {
      await assert.rejects(main(['--resume', output, ...flags], dependencies(fixture('wildfires', 40))), /IDENTITY_MISMATCH/);
    }
    assert.equal(readFileSync(output, 'utf8'), before);
    assert.match(readFileSync(output.replace('.json', '.md'), 'utf8'), /Verdict: \*\*passed\*\*/);
    await assert.rejects(main(args, dependencies(fixture())), /EXISTS_USE_RESUME/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('actual CLI captures and resumes with correct exit codes and without credential output', () => {
  const directory = mkdtempSync(join(tmpdir(), 'seed-recovery-cli-'));
  const output = join(directory, 'recovery.json');
  const fixturePath = join(directory, 'fixture.json');
  const preload = join(directory, 'preload.mjs');
  const script = resolve('scripts/capture-seed-recovery.mjs');
  writeFileSync(preload, `
import { readFileSync } from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const fixture = JSON.parse(readFileSync(process.env.RECOVERY_TEST_FIXTURE));
const OriginalDate = Date;
globalThis.Date = class extends OriginalDate {
  constructor(...args) { super(...(args.length ? args : [fixture.now])); }
  static now() { return fixture.now; }
};
childProcess.spawnSync = (command, args) => {
  if (command === 'git' && args[0] === 'merge-base') return {status: 0, stdout: '', stderr: ''};
  if (command !== 'railway' || !['status', 'logs'].includes(args[0])) throw new Error('Unexpected mutation');
  return {status: 0, stderr: '', stdout: args[0] === 'status' ? JSON.stringify(fixture.status) : fixture.logs.map(JSON.stringify).join('\\n')};
};
syncBuiltinESMExports();
globalThis.fetch = async (url, options) => {
  if (String(url) === 'https://api.worldmonitor.app/api/health') return new Response(JSON.stringify(fixture.health));
  if (String(url) !== 'https://redis.example/pipeline' || JSON.stringify(JSON.parse(options.body)) !== JSON.stringify([['GET', 'seed-meta:wildfire:fires']])) throw new Error('Unexpected read');
  return new Response(JSON.stringify([{result: JSON.stringify(fixture.meta)}]));
};
`);
  try {
    const run = (minutes, args) => {
      writeFileSync(fixturePath, JSON.stringify(fixture('wildfires', minutes)));
      return spawnSync(process.execPath, ['--import', preload, script, ...args], {
        encoding: 'utf8', timeout: 15_000, env: { ...process.env, ...env, NODE_ENV: 'test', RECOVERY_TEST_FIXTURE: fixturePath, WM_SEED_ENV_FILE: '' },
      });
    };
    const initial = run(0, ['--source', 'wildfires', '--required-commit', COMMIT, '--pr', '7701', '--owner', 'operator', '--project', PROJECT, '--deadline', at(60), '--output', output]);
    assert.equal(initial.status, 2, initial.stderr);
    assert.equal(run(14, ['--resume', output]).status, 2);
    assert.equal(run(24, ['--resume', output]).status, 2);
    const passed = run(34, ['--resume', output]);
    assert.equal(passed.status, 0, passed.stderr);
    assert.match(passed.stdout, /passed/);
    assert.ok(!`${passed.stdout}${passed.stderr}${readFileSync(output)}`.includes('private-'));
    assert.ok(existsSync(output.replace('.json', '.md')));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
