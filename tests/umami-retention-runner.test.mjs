import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

import {
  RETENTION_HISTORY_WINDOW,
  RETENTION_RUNNER_SERVICE,
  evaluateRetentionRunner,
  normalizeDeploymentRows,
} from '../scripts/check-umami-retention-runner.mjs';

const checkScript = fileURLToPath(
  new URL('../scripts/check-umami-retention-runner.mjs', import.meta.url),
);
const workflowSource = readFileSync(
  new URL('../.github/workflows/umami-storage-monitor.yml', import.meta.url),
  'utf8',
);
const workflow = YAML.parse(workflowSource);
const steps = workflow.jobs.monitor.steps;

function record(overrides = {}) {
  return {
    id: 'deployment-1',
    status: 'SUCCESS',
    createdAt: '2026-08-10T12:38:21.680Z',
    ...overrides,
  };
}

// The shape production actually had on 2026-08-10: every push to main writes a
// SKIPPED refusal for this service, so the newest record is almost never the
// tick. A check that reads `deployments[0].status` reports SKIPPED and misses
// the crash underneath it.
const CRASHED_UNDER_REFUSALS = [
  record({ id: 'skip-2', status: 'SKIPPED', createdAt: '2026-08-10T12:39:43.722Z' }),
  record({ id: 'skip-1', status: 'SKIPPED', createdAt: '2026-08-10T12:31:35.998Z' }),
  record({ id: 'tick', status: 'CRASHED', createdAt: '2026-08-10T12:07:43.033Z' }),
];

function runCli(payload) {
  const directory = mkdtempSync(join(tmpdir(), 'wm-umami-retention-runner-'));
  const inputPath = join(directory, 'deployments.json');
  try {
    writeFileSync(inputPath, JSON.stringify(payload));
    return spawnSync(process.execPath, [checkScript, '--input', inputPath], { encoding: 'utf8' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('Umami retention runner check (#6375)', () => {
  it('reports the newest deployment that RAN, not the newest refusal', () => {
    const result = evaluateRetentionRunner(CRASHED_UNDER_REFUSALS);

    assert.equal(result.verdict, 'CRASHED');
    assert.equal(result.alarming, true);
    assert.equal(result.deploymentId, 'tick');
  });

  it('accepts a completed or superseded tick', () => {
    // Railway rewrites a finished cron deployment to REMOVED, and rewrites
    // CRASHED to REMOVED once a later tick succeeds. Both mean "it ran and did
    // not exit non-zero as of this read".
    for (const status of ['SUCCESS', 'REMOVED', 'SLEEPING']) {
      const result = evaluateRetentionRunner([record({ status })]);
      assert.equal(result.verdict, 'HEALTHY', `${status} must not alarm`);
      assert.equal(result.alarming, false);
    }
  });

  it('orders by createdAt rather than trusting the array order', () => {
    const shuffled = [CRASHED_UNDER_REFUSALS[2], CRASHED_UNDER_REFUSALS[0], CRASHED_UNDER_REFUSALS[1]];
    const newerSuccess = [
      record({ id: 'tick-old', status: 'CRASHED', createdAt: '2026-08-10T12:07:43.033Z' }),
      record({ id: 'tick-new', status: 'SUCCESS', createdAt: '2026-08-10T12:38:21.680Z' }),
    ];

    assert.equal(evaluateRetentionRunner(shuffled).deploymentId, 'tick');
    assert.equal(evaluateRetentionRunner(newerSuccess).verdict, 'HEALTHY');
    assert.equal(evaluateRetentionRunner(newerSuccess).deploymentId, 'tick-new');
  });

  it('fails closed on every history it cannot draw a conclusion from', () => {
    const cases = [
      [null, 'UNREADABLE'],
      ['not json', 'UNREADABLE'],
      [[], 'NO_DEPLOYMENTS'],
      [[record({ status: 'SKIPPED' }), record({ id: 'b', status: 'SKIPPED' })], 'NO_RUNNING_DEPLOYMENT'],
      [[record({ status: 'BRAND_NEW_RAILWAY_STATUS' })], 'UNKNOWN_STATUS'],
      // A truncated read is not evidence of a healthy tick. Before this guard,
      // [{"status":"SUCCESS"}] exited 0 and printed HEALTHY.
      [[{ status: 'SUCCESS' }], 'INCOMPLETE_RECORD'],
      [[{ status: 'SUCCESS', id: 'deployment-1' }], 'INCOMPLETE_RECORD'],
      [[{ status: 'SUCCESS', createdAt: '2026-08-10T12:38:21.680Z' }], 'INCOMPLETE_RECORD'],
      [[record({ createdAt: 'not-a-timestamp' })], 'INCOMPLETE_RECORD'],
      [[record({ id: '' })], 'INCOMPLETE_RECORD'],
    ];

    for (const [payload, verdict] of cases) {
      const result = evaluateRetentionRunner(payload);
      assert.equal(result.verdict, verdict, `${JSON.stringify(payload)} must be ${verdict}`);
      assert.equal(result.alarming, true, `${verdict} must alarm`);
    }
  });

  it('ignores an unmodelled status older than the record that decides health', () => {
    // REMOVING is the transition every superseded deployment passes through.
    // Alarming on one sitting behind the deciding record would hold the
    // 15-minute workflow red forever over a record with no bearing on health.
    const result = evaluateRetentionRunner([
      record({ id: 'new', status: 'SUCCESS', createdAt: '2026-08-10T13:00:00.000Z' }),
      record({ id: 'stale', status: 'REMOVING', createdAt: '2026-08-09T12:00:00.000Z' }),
    ]);

    assert.equal(result.verdict, 'HEALTHY');
    assert.equal(result.alarming, false);
    assert.equal(result.deploymentId, 'new');
  });

  it('still alarms on an unmodelled status that hides the deciding record', () => {
    // newestRunning() ignores any status it does not know, so without the
    // explicit guard a new Railway state would silently select an older
    // SUCCESS and report HEALTHY.
    const result = evaluateRetentionRunner([
      record({ id: 'new', status: 'BRAND_NEW_RAILWAY_STATUS', createdAt: '2026-08-10T13:00:00.000Z' }),
      record({ id: 'old', status: 'SUCCESS', createdAt: '2026-08-10T12:00:00.000Z' }),
    ]);

    assert.equal(result.verdict, 'UNKNOWN_STATUS');
    assert.equal(result.alarming, true);
  });

  it('normalizes the array and object shapes Railway returns', () => {
    assert.deepEqual(normalizeDeploymentRows([record()]), [record()]);
    assert.deepEqual(normalizeDeploymentRows({ deployments: [record()] }), [record()]);
    assert.equal(normalizeDeploymentRows({ unexpected: true }), null);
  });

  it('fails the scheduled workflow when the runner is crashing', () => {
    const crashed = runCli(CRASHED_UNDER_REFUSALS);

    assert.equal(crashed.status, 1);
    assert.match(crashed.stdout, /Umami retention runner CRASHED/);
    assert.match(crashed.stderr, /::error::CRASHED/);
    assert.match(crashed.stderr, new RegExp(RETENTION_RUNNER_SERVICE));
    // The tick commits per statement now, so a crash is partial, not void.
    // Telling an operator nothing was retired sends them hunting the wrong bug.
    assert.doesNotMatch(crashed.stdout, /rolled back|no rows were retired/);

    // A read we could not make is not a statement about the database.
    const unreadable = runCli([{ status: 'SKIPPED', id: 'a', createdAt: '2026-08-10T12:00:00.000Z' }]);
    assert.equal(unreadable.status, 1);
    assert.doesNotMatch(
      unreadable.stderr,
      /Umami Postgres will fill/,
      'only CRASHED may claim the database is filling',
    );
    assert.match(unreadable.stderr, /unobserved/);

    const healthy = runCli([record()]);
    assert.equal(healthy.status, 0);
    assert.match(healthy.stdout, /Umami retention runner HEALTHY/);
    assert.doesNotMatch(healthy.stderr, /::error::/);
  });

  it('names the failing step when the Railway read left an empty or torn file', () => {
    // `railway ... > file` creates the file before the CLI runs, so a
    // Railway-side failure leaves an empty or half-written file, not no file.
    // Both must fail, and both must point at the step that actually broke.
    const directory = mkdtempSync(join(tmpdir(), 'wm-umami-retention-torn-'));
    try {
      for (const [name, contents] of [['empty', ''], ['torn', '[{"status":"SUCC']]) {
        const inputPath = join(directory, `${name}.json`);
        writeFileSync(inputPath, contents);
        const run = spawnSync(process.execPath, [checkScript, '--input', inputPath], {
          encoding: 'utf8',
        });

        assert.equal(run.status, 1, `${name} input must fail closed`);
        assert.match(run.stderr, /Read retention runner deployments/, `${name} must name the real step`);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails closed when the input is missing rather than passing silently', () => {
    const missing = spawnSync(
      process.execPath,
      [checkScript, '--input', join(tmpdir(), 'wm-umami-retention-absent.json')],
      { encoding: 'utf8' },
    );

    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /not found/);
  });


  // 2026-08-22 production incident: the alarm fired NO_RUNNING_DEPLOYMENT
  // reading "none of the newest 200 records reached a running state (200 were
  // SKIPPED refusals)" while `umami-retention` was perfectly healthy — 71 of 71
  // scheduled ticks fired that day, zero errors, the newest at 06:52:59Z
  // retiring rows normally.
  //
  // The runner was invisible, not dead. Its active deployment sat at index 206
  // of the recency-ordered history; the window read 200. Refusals accrue at
  // ~29.5/day (one per push to main), so ANY fixed window N is exhausted after
  // N/29.5 days — 200 lasted 6.8 — while a healthy deployment routinely lives
  // longer than that. The old comment here called depth "the only defence";
  // depth alone guarantees a false alarm on a schedule.
  //
  // Both states must keep alarming: neither one observes the runner. But they
  // demand opposite responses — one says "the retention runner is dead, Postgres
  // will fill", the other says "widen the window" — so they must not share a
  // verdict.
  it('separates a saturated window from a runner that genuinely never ran', () => {
    const refusals = (count) => Array.from({ length: count }, (_, index) => record({
      id: `skip-${index}`,
      status: 'SKIPPED',
      // Newest first; one per ~49 minutes, the observed push cadence.
      createdAt: new Date(Date.parse('2026-08-22T06:00:00.000Z') - index * 2_940_000).toISOString(),
    }));

    // Window filled to the requested depth: the deciding record may sit just
    // past the edge, exactly as it did in production.
    const saturated = evaluateRetentionRunner(refusals(RETENTION_HISTORY_WINDOW));
    assert.equal(saturated.verdict, 'HISTORY_WINDOW_SATURATED');
    assert.equal(saturated.alarming, true, 'a window we cannot see past is still unobserved');
    assert.match(
      saturated.detail,
      /window/i,
      'the operator must be told the window is the problem, not the database',
    );

    // Short of the requested depth: this IS the service's entire history, so
    // "nothing ever ran" is a fact about the runner rather than the window.
    const complete = evaluateRetentionRunner(refusals(RETENTION_HISTORY_WINDOW - 1));
    assert.equal(complete.verdict, 'NO_RUNNING_DEPLOYMENT');
    assert.equal(complete.alarming, true);

    // A saturated window that DOES contain a running record is not saturated in
    // any way that matters — the record it needed is present.
    const saturatedButAnswered = [
      ...refusals(RETENTION_HISTORY_WINDOW - 1),
      record({ id: 'tick', status: 'SUCCESS', createdAt: '2026-01-01T00:00:00.000Z' }),
    ];
    assert.equal(evaluateRetentionRunner(saturatedButAnswered).verdict, 'HEALTHY');
    assert.equal(evaluateRetentionRunner(saturatedButAnswered).deploymentId, 'tick');
  });

  it('names the window in the saturated alarm so the remedy is unambiguous', () => {
    const refusals = Array.from({ length: RETENTION_HISTORY_WINDOW }, (_, index) => record({
      id: `skip-${index}`,
      status: 'SKIPPED',
      createdAt: new Date(Date.parse('2026-08-22T06:00:00.000Z') - index * 2_940_000).toISOString(),
    }));
    const cli = runCli(refusals);

    assert.equal(cli.status, 1, 'saturation must still fail the run — the runner is unobserved');
    assert.match(cli.stdout, /HISTORY_WINDOW_SATURATED/);
    // The operator consequence must not claim the database is filling: that was
    // the misdiagnosis this verdict exists to prevent.
    assert.doesNotMatch(cli.stderr, /will fill/);
    assert.match(cli.stderr, /unobserved/);
  });

  // The saturation branch triggers on "no record REACHED a running state", which
  // a window of FAILED builds satisfies just as well as a window of refusals.
  // An earlier draft of the detail asserted "all N records read were SKIPPED
  // refusals" — false in exactly that case, in the one sentence an operator
  // reads at 03:00. The count must be counted, never assumed.
  it('counts refusals rather than asserting every saturating record is one', () => {
    const failedBuilds = Array.from({ length: RETENTION_HISTORY_WINDOW }, (_, index) => record({
      id: `failed-${index}`,
      status: 'FAILED',
      createdAt: new Date(Date.parse('2026-08-22T06:00:00.000Z') - index * 2_940_000).toISOString(),
    }));

    const result = evaluateRetentionRunner(failedBuilds);
    assert.equal(result.verdict, 'HISTORY_WINDOW_SATURATED');
    assert.equal(result.alarming, true);
    assert.match(result.detail, /\(0 were SKIPPED refusals\)/, 'zero refusals must report as zero');
    assert.doesNotMatch(result.detail, /all \d+ records read were SKIPPED/);
  });
  it('reads the runner history deeply enough to see past push refusals', () => {
    const readStep = steps.find((step) => /railway deployment list/.test(step.run ?? ''));

    assert.ok(readStep, 'the workflow must read the retention runner deployment history');
    assert.match(readStep.run, new RegExp(`--service ${RETENTION_RUNNER_SERVICE}`));
    const [, limit] = readStep.run.match(/--limit (\d+)/) ?? [];
    assert.equal(Number(limit), RETENTION_HISTORY_WINDOW);
    // Without these the Railway CLI call is unauthenticated and the step fails
    // closed on every run — noisy, and it buries the signal it exists to carry.
    assert.deepEqual(Object.keys(readStep.env ?? {}).sort(), ['RAILWAY_PROJECT_ID', 'RAILWAY_TOKEN']);
    assert.equal(readStep.env.RAILWAY_TOKEN, '${{ secrets.RAILWAY_PRODUCTION_TOKEN }}');
    assert.equal(readStep.env.RAILWAY_PROJECT_ID, '${{ vars.RAILWAY_PROJECT_ID }}');

    // The runbook hands the operator the same command to run by hand. A shallower
    // window there returns push refusals and hides the tick they came to look at.
    const runbook = readFileSync(
      new URL('../docs/analytics-collector-operations.md', import.meta.url),
      'utf8',
    );
    const [, documentedLimit] = runbook.match(/--service umami-retention --limit (\d+)/u) ?? [];
    assert.equal(Number(documentedLimit), RETENTION_HISTORY_WINDOW);
  });

  it('runs the runner alarm even when the capacity step already failed', () => {
    const readStep = steps.find((step) => /railway deployment list/.test(step.run ?? ''));
    const checkStep = steps.find((step) => /check-umami-retention-runner\.mjs/.test(step.run ?? ''));
    const capacityStep = steps.find((step) => /check-umami-storage\.mjs/.test(step.run ?? ''));

    assert.ok(checkStep, 'the workflow must run the retention runner check');
    for (const step of [readStep, checkStep]) {
      // Capacity is the lagging symptom of this failure. If a critical volume
      // short-circuits the job, the one actionable alarm never prints.
      assert.equal(step.if, '${{ !cancelled() }}', `${step.name} must not be skipped by an earlier failure`);
      // And neither runner step may run before the capacity check, or a
      // Railway hiccup here costs the growth-baseline sample.
      assert.ok(
        steps.indexOf(step) > steps.indexOf(capacityStep),
        `${step.name} must not block the capacity step's growth-baseline write`,
      );
    }
  });
});
