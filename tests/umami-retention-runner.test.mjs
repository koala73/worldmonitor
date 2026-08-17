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
