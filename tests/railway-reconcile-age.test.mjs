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
// the negative answer decidable. A count-bounded window was the first design
// and it was unusable: this workflow is woken by every Deploy Gate evaluation
// in the repository (~33/hour, measured), so the newest 30 runs span under an
// hour and could never reach back past a three-hour threshold. The alarm could
// not fire. With a time window, "no run in the window reconciled" is a proof —
// including the window being EMPTY, which is the #6203 failure itself.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

import {
  DEFAULT_MAX_RECONCILE_AGE_MS,
  RECONCILE_STEP_NAME,
  describeReconcileSummary,
  readRunReconciled,
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

  it('defaults the threshold to three times the workflow backstop interval', () => {
    // Sized against the workflow's hourly cron backstop, not against a fixture:
    // one missed hour is ordinary, three consecutive hours with nothing
    // reconciling means neither the event nor the backstop is working.
    assert.equal(DEFAULT_MAX_RECONCILE_AGE_MS, 3 * HOUR);
  });
});

describe('the API window the CLI asks for', () => {
  it('formats a second-granularity UTC instant, which is what `created` takes', () => {
    assert.equal(toCreatedFilter(Date.parse('2026-08-05T09:00:00.123Z')), '2026-08-05T09:00:00Z');
    assert.doesNotMatch(toCreatedFilter(NOW), /\.\d+Z$/);
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
    const names = workflow.jobs.trigger.steps.map((step) => step.name);
    assert.ok(
      names.includes(RECONCILE_STEP_NAME),
      `RECONCILE_STEP_NAME ${JSON.stringify(RECONCILE_STEP_NAME)} names no step in the workflow; it has ${JSON.stringify(names)}`,
    );
  });

  it('names a workflow that actually exists, so the primary trigger cannot silently die', () => {
    // `workflow_run.workflows` is a cross-file reference by DISPLAY NAME.
    // Renaming Deploy Gate's `name:` would delete the reconciler's primary
    // cadence and leave the hourly cron holding a green badge — the same
    // silent-degradation shape #6203 is about, one indirection further out.
    const upstream = workflow.on?.workflow_run?.workflows ?? [];
    assert.ok(upstream.length > 0, 'the reconciler must declare an upstream workflow');
    for (const name of upstream) {
      const target = YAML.parse(readFileSync(
        resolve(repoRoot, '.github/workflows/deploy-gate.yml'),
        'utf8',
      ));
      assert.equal(
        target.name,
        name,
        `railway-deploy-trigger waits on a workflow named ${JSON.stringify(name)}, but deploy-gate.yml is named ${JSON.stringify(target.name)}`,
      );
    }
  });
});
