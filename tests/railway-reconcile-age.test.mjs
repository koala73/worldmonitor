// #6203 — the reconciler must be able to say "the fleet has not been
// reconciled in N hours", independent of WHY.
//
// The failure this pins is not a wrong number, it is a green badge. The
// reconciler's own run history is the only record of whether it did anything,
// because a run that declines to deploy and a run that reconciled the whole
// fleet both conclude `success`. Every case where that record is missing or
// unreadable must therefore resolve AWAY from "healthy" — the unmatched case
// meaning HEALTHY is the exact shape of the defect.
//
// The window is bounded by TIME, never by a run count, and that is what makes
// the negative answer decidable. A count-bounded window was unusable when every
// Deploy Gate evaluation woke this workflow (~33/hour, measured): the newest 30
// runs could not reach back past a three-hour threshold. Keep the time contract
// while the bounded manual rollback surface still exists. "No run in the
// window reconciled" is a proof, including an EMPTY window, which is the #6203
// failure itself.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

import {
  DEFAULT_MAX_RECONCILE_AGE_MS,
  RECONCILE_STEP_NAME,
  RECONCILE_STEP_NAMES,
  collectReconcileWindow,
  describeReconcileSummary,
  readRunReconciled,
  readRunsSince,
  summarizeReconcileHistory,
  toCreatedFilter,
} from '../scripts/check-railway-reconcile-age.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// A fixed clock. Seeding from Date.now() makes every assertion below depend on
// how long the suite took to get here.
const NOW = Date.parse('2026-08-05T12:00:00Z');
const HOUR = 60 * 60 * 1000;

function run(hoursAgo, reconciled, id = `run-${hoursAgo}`) {
  return {
    id,
    completedAt: new Date(NOW - hoursAgo * HOUR).toISOString(),
    reconciled,
  };
}

describe('reconcile-age window summary', () => {
  it('reports the age of the newest run that actually reconciled', () => {
    const summary = summarizeReconcileHistory(
      [run(0.5, false), run(1, true, 'reconciled-run'), run(2, true)],
      { now: NOW },
    );
    assert.equal(summary.state, 'RECENT');
    assert.equal(summary.runId, 'reconciled-run');
    assert.equal(summary.ageMs, HOUR);
  });

  it('finds a reconcile anywhere in the window, not only in the newest run', () => {
    const summary = summarizeReconcileHistory(
      [run(0.2, false), run(0.4, false), run(2.9, true, 'deep-in-window')],
      { now: NOW, maxAgeMs: 3 * HOUR },
    );
    assert.equal(summary.state, 'RECENT');
    assert.equal(summary.runId, 'deep-in-window');
  });

  it('ignores runs that declined, so a wall of no-ops cannot read as healthy', () => {
    // The #6203 shape exactly: the workflow ran, concluded success, and skipped
    // every step that does work. All of these are inside the window, so
    // "none reconciled" is a proof rather than a shortfall of evidence.
    const declined = Array.from({ length: 12 }, (_, index) => run(index * 0.2, false));
    const summary = summarizeReconcileHistory(declined, { now: NOW, maxAgeMs: 3 * HOUR });
    assert.equal(summary.state, 'STALE');
    assert.equal(summary.runId, null);
    assert.equal(summary.inspected, 12);
  });

  it('is STALE — never a shrug — when the workflow produced no run at all', () => {
    // This is the #6203 failure itself: the schedule was throttled so the
    // reconciler simply did not run. A count-bounded window called that
    // "cannot tell" and exited 0. An empty TIME window is proof, and the
    // message has to say which of the two it is so an operator knows whether
    // to look at the trigger or at the deploys.
    const summary = summarizeReconcileHistory([], { now: NOW, maxAgeMs: 3 * HOUR });
    assert.equal(summary.state, 'STALE');
    assert.equal(summary.inspected, 0);
    assert.match(describeReconcileSummary(summary), /NO completed run/);
    assert.doesNotMatch(
      describeReconcileSummary(
        summarizeReconcileHistory([run(1, false)], { now: NOW, maxAgeMs: 3 * HOUR }),
      ),
      /NO completed run/,
      'a window that held runs must not claim the workflow never fired',
    );
  });

  it('still proves a reconcile when the winning run has an unreadable timestamp', () => {
    // The window is the caller's guarantee, not this field's. Throwing the
    // proof away over a malformed date would alarm on a fleet that is fine.
    for (const completedAt of [null, 'not a date']) {
      const summary = summarizeReconcileHistory(
        [{ id: 'a', completedAt, reconciled: true }],
        { now: NOW, maxAgeMs: 3 * HOUR },
      );
      assert.equal(summary.state, 'RECENT');
      assert.equal(summary.ageMs, null);
      assert.equal(summary.runId, 'a');
    }
  });

  it('does not let a future-dated run report a negative age', () => {
    // Runner clock skew against GitHub's timestamps is real and small; a
    // negative age would print as "-0h".
    const summary = summarizeReconcileHistory(
      [{ id: 'a', completedAt: new Date(NOW + 5 * 60 * 1000).toISOString(), reconciled: true }],
      { now: NOW },
    );
    assert.equal(summary.state, 'RECENT');
    assert.equal(summary.ageMs, 0);
  });

  it('refuses to summarise without a clock rather than defaulting to one', () => {
    assert.throws(() => summarizeReconcileHistory([]), /numeric now/);
  });

  it('keeps a bounded three-hour manual rollback evidence window', () => {
    // The temporary rollback surface retains a finite lookback; it does not
    // infer health from an unbounded history of old controller successes.
    assert.equal(DEFAULT_MAX_RECONCILE_AGE_MS, 3 * HOUR);
  });
});

describe('the API window the CLI asks for', () => {
  it('formats a second-granularity UTC instant, which is what `created` takes', () => {
    assert.equal(toCreatedFilter(Date.parse('2026-08-05T09:00:00.123Z')), '2026-08-05T09:00:00Z');
    assert.doesNotMatch(toCreatedFilter(NOW), /\.\d+Z$/);
  });
});

describe('the I/O path that builds the window', () => {
  const jobsFor = (conclusion) => JSON.stringify({
    jobs: [{ steps: [{ name: RECONCILE_STEP_NAME, conclusion }] }],
  });

  // A fake `gh` that answers from a fixture and records what was asked.
  function fakeGh({ pages, jobsByRunId }) {
    const calls = [];
    return {
      calls,
      gh(args) {
        const url = args[args.length - 1];
        calls.push(url);
        if (url.includes('/runs?')) return JSON.stringify(pages);
        const runId = /\/actions\/runs\/([^/]+)\/jobs/.exec(url)?.[1];
        return jobsByRunId[runId] ?? jobsFor('skipped');
      },
    };
  }

  const listing = (...runs) => [{ workflow_runs: runs }];

  it('asks for completed runs created inside the window only', () => {
    const { gh, calls } = fakeGh({ pages: listing(), jobsByRunId: {} });
    readRunsSince({
      gh, repository: 'o/r', workflowFile: 'w.yml', sinceMs: Date.parse('2026-08-05T09:00:00Z'), excludeRunId: null,
    });
    assert.match(calls[0], /status=completed/);
    assert.match(calls[0], /created=%3E%3D2026-08-05T09%3A00%3A00Z/);
  });

  it('drops the current run from the window', () => {
    // Belt and braces with `status=completed`, and the reason the workflow must
    // not ask this question on a run whose own deploy just succeeded.
    const { gh } = fakeGh({
      pages: listing(
        { id: 111, updated_at: '2026-08-05T11:00:00Z' },
        { id: 222, updated_at: '2026-08-05T10:00:00Z' },
      ),
      jobsByRunId: {},
    });
    const runs = readRunsSince({
      gh, repository: 'o/r', workflowFile: 'w.yml', sinceMs: NOW - 3 * HOUR, excludeRunId: '111',
    });
    assert.deepEqual(runs.map((run) => run.id), [222]);
  });

  it('reads every page of a paginated listing', () => {
    const { gh } = fakeGh({
      pages: [
        { workflow_runs: [{ id: 1, updated_at: '2026-08-05T11:00:00Z' }] },
        { workflow_runs: [{ id: 2, updated_at: '2026-08-05T10:00:00Z' }] },
      ],
      jobsByRunId: {},
    });
    const runs = readRunsSince({
      gh, repository: 'o/r', workflowFile: 'w.yml', sinceMs: NOW - 3 * HOUR, excludeRunId: null,
    });
    assert.deepEqual(runs.map((run) => run.id), [1, 2]);
  });

  it('throws on an unreadable listing rather than reporting an empty window', () => {
    // Empty now means STALE, which is loud — but it would be loud for a false
    // reason, and an operator would go looking at triggers instead of the API.
    const { gh } = fakeGh({ pages: [{ message: 'Not Found' }], jobsByRunId: {} });
    assert.throws(
      () => readRunsSince({
        gh, repository: 'o/r', workflowFile: 'w.yml', sinceMs: NOW - 3 * HOUR, excludeRunId: null,
      }),
      /not an array of workflow runs/,
    );
  });

  it('stops fetching jobs at the first run that reconciled', () => {
    const { gh, calls } = fakeGh({
      pages: listing(
        { id: 'newest', updated_at: '2026-08-05T11:50:00Z' },
        { id: 'reconciled', updated_at: '2026-08-05T11:40:00Z' },
        { id: 'older', updated_at: '2026-08-05T11:30:00Z' },
      ),
      jobsByRunId: { newest: jobsFor('skipped'), reconciled: jobsFor('success') },
    });
    const window = collectReconcileWindow({
      gh, repository: 'o/r', workflowFile: 'w.yml', sinceMs: NOW - 3 * HOUR, excludeRunId: null,
    });
    assert.deepEqual(window.map((run) => run.reconciled), [false, true]);
    assert.ok(
      !calls.some((url) => url.includes('/runs/older/jobs')),
      'must not keep paying for job reads past the answer',
    );
  });

  it('yields a window that summarises STALE when nothing in it reconciled', () => {
    const { gh } = fakeGh({
      pages: listing(
        { id: 'a', updated_at: new Date(NOW - 0.5 * HOUR).toISOString() },
        { id: 'b', updated_at: new Date(NOW - 1.5 * HOUR).toISOString() },
      ),
      jobsByRunId: {},
    });
    const window = collectReconcileWindow({
      gh, repository: 'o/r', workflowFile: 'w.yml', sinceMs: NOW - 3 * HOUR, excludeRunId: null,
    });
    assert.equal(
      summarizeReconcileHistory(window, { now: NOW, maxAgeMs: 3 * HOUR }).state,
      'STALE',
    );
  });
});

describe('reading whether one run reconciled', () => {
  it('counts only a deploy step that ran and succeeded', () => {
    const jobs = (conclusion) => ({
      jobs: [{
        steps: [
          { name: 'Resolve main\'s head and require it to be green', conclusion: 'success' },
          { name: RECONCILE_STEP_NAME, conclusion },
        ],
      }],
    });
    assert.equal(readRunReconciled(jobs('success')), true);
    // The #6203 transcript: the step is present and skipped.
    assert.equal(readRunReconciled(jobs('skipped')), false);
    // A deploy that errored did not reconcile the fleet. It reds its own run,
    // so counting it would double-hide a fleet that is genuinely behind.
    assert.equal(readRunReconciled(jobs('failure')), false);
    assert.equal(readRunReconciled(jobs(null)), false);
  });

  it('keeps successful pre-cutover reconciliation visible inside the age window', () => {
    const legacyName = RECONCILE_STEP_NAMES.find((name) => name !== RECONCILE_STEP_NAME);
    assert.ok(legacyName);
    assert.equal(readRunReconciled({
      jobs: [{ steps: [{ name: legacyName, conclusion: 'success' }] }],
    }), true);
  });

  it('reads false — never true — for a payload it does not recognise', () => {
    assert.equal(readRunReconciled({}), false);
    assert.equal(readRunReconciled(null), false);
    assert.equal(readRunReconciled({ jobs: [] }), false);
    assert.equal(readRunReconciled({ jobs: [{ steps: [] }] }), false);
    assert.equal(
      readRunReconciled({ jobs: [{ steps: [{ name: 'renamed step', conclusion: 'success' }] }] }),
      false,
    );
  });

  it('reads false for a run cancelled while pending, which reports no jobs', () => {
    // The workflow's concurrency group deliberately manufactures these: a new
    // arrival cancels the pending member. They must never fake a reconcile.
    assert.equal(readRunReconciled({ jobs: [] }), false);
  });

  it('finds the step across every job of a run', () => {
    assert.equal(
      readRunReconciled({
        jobs: [
          { steps: [{ name: 'something else', conclusion: 'success' }] },
          { steps: [{ name: RECONCILE_STEP_NAME, conclusion: 'success' }] },
        ],
      }),
      true,
    );
  });
});

describe('the cross-file names this scanner depends on', () => {
  const workflow = YAML.parse(readFileSync(
    resolve(repoRoot, '.github/workflows/railway-deploy-trigger.yml'),
    'utf8',
  ));

  it('matches a step the reconciler workflow actually defines', () => {
    // The scanner's whole signal is this string. If the workflow renames the
    // step, every run reads as "did not reconcile" — which alarms rather than
    // going quiet, but alarms forever for the wrong reason.
    const names = Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .map((step) => step.name)
      .filter(Boolean);
    assert.ok(
      names.includes(RECONCILE_STEP_NAME),
      `RECONCILE_STEP_NAME ${JSON.stringify(RECONCILE_STEP_NAME)} names no step in the workflow; it has ${JSON.stringify(names)}`,
    );
  });

  it('is retained only behind an explicit manual rollback invocation', () => {
    assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
    assert.equal(Object.hasOwn(workflow.on, 'workflow_run'), false);
    assert.equal(Object.hasOwn(workflow.on, 'schedule'), false);
    const liveness = workflow.jobs.liveness;
    assert.match(String(liveness.if), /needs\.verifier\.result != 'success'/);
    const enforcement = liveness.steps.find((step) => step.name === 'Enforce reconciliation liveness');
    assert.match(enforcement.run, /CUTOVER_ACTIVE/);
    assert.match(enforcement.run, /check-railway-reconcile-age\.mjs/);
  });
});
