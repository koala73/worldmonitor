// #6203 — the reconciler must be able to say "the fleet has not been
// reconciled in N hours", independent of WHY.
//
// The failure this pins is not a wrong number, it is a green badge. The
// reconciler's own run history is the only record of whether it did anything,
// because a run that declines to deploy and a run that reconciled the whole
// fleet both conclude `success`. Every case where that record is missing,
// unreadable or ambiguous must therefore resolve AWAY from "healthy" — the
// unmatched case meaning HEALTHY is the exact shape of the defect.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

import {
  DEFAULT_MAX_RECONCILE_AGE_MS,
  RECONCILE_STEP_NAME,
  readRunReconciled,
  summarizeReconcileHistory,
} from '../scripts/check-railway-reconcile-age.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// A fixed clock. Seeding from Date.now() makes every boundary assertion below
// depend on how long the suite took to get here.
const NOW = Date.parse('2026-08-05T12:00:00Z');
const HOUR = 60 * 60 * 1000;

function run(hoursAgo, reconciled, id = `run-${hoursAgo}`) {
  return {
    id,
    completedAt: new Date(NOW - hoursAgo * HOUR).toISOString(),
    reconciled,
  };
}

describe('reconcile-age history summary', () => {
  it('reports the age of the newest run that actually reconciled', () => {
    const summary = summarizeReconcileHistory(
      [run(0.5, false), run(1, true, 'reconciled-run'), run(2, true)],
      { now: NOW },
    );
    assert.equal(summary.state, 'RECENT');
    assert.equal(summary.runId, 'reconciled-run');
    assert.equal(summary.ageMs, HOUR);
  });

  it('ignores runs that declined, so a wall of no-ops cannot read as healthy', () => {
    // The #6203 shape exactly: the workflow ran, concluded success, and skipped
    // every step that does work.
    const declined = Array.from({ length: 12 }, (_, index) => run(index * 0.5, false));
    const summary = summarizeReconcileHistory(
      [...declined, run(9, true, 'the-last-real-one')],
      { now: NOW, maxAgeMs: 3 * HOUR },
    );
    assert.equal(summary.state, 'STALE');
    assert.equal(summary.runId, 'the-last-real-one');
    assert.equal(summary.ageMs, 9 * HOUR);
  });

  it('is stale, not unknown, when the window reaches past the threshold with nothing reconciled', () => {
    // We looked back far enough to conclude. Answering "cannot tell" here is
    // how the alarm never fires for the fleet that is most stranded.
    const summary = summarizeReconcileHistory(
      [run(0.5, false), run(4, false), run(7, false)],
      { now: NOW, maxAgeMs: 3 * HOUR },
    );
    assert.equal(summary.state, 'STALE');
    assert.equal(summary.lastReconciledAt, null);
    assert.equal(summary.runId, null);
  });

  it('measures the window from the genuinely oldest run, not from list order', () => {
    // The runs come from a paginated API. Assuming newest-first and reading the
    // last element would make an out-of-order page report a window shorter than
    // the one actually inspected, which downgrades STALE to UNKNOWN — the alarm
    // silently becoming a shrug.
    // The 7h run is FIRST and the 0.5h run last on purpose: reading the tail
    // instead of the minimum would measure a 0.5h window and report UNKNOWN.
    const summary = summarizeReconcileHistory(
      [run(7, false), run(0.5, false)],
      { now: NOW, maxAgeMs: 3 * HOUR },
    );
    assert.equal(summary.state, 'STALE');
  });

  it('does not let an unparseable timestamp shrink the inspected window', () => {
    // Placed on both sides of the readable record, because a record that
    // discarded what came before it and one that discarded what came after
    // are different bugs with the same symptom: the alarm downgraded to a
    // shrug by one malformed row.
    for (const history of [
      [{ id: 'bad', completedAt: null, reconciled: false }, run(7, false)],
      [run(7, false), { id: 'bad', completedAt: null, reconciled: false }],
    ]) {
      const summary = summarizeReconcileHistory(history, { now: NOW, maxAgeMs: 3 * HOUR });
      assert.equal(summary.state, 'STALE', 'one unreadable record must not suppress the alarm');
    }
  });

  it('is unknown — never healthy — when the inspected window is too short to conclude', () => {
    const summary = summarizeReconcileHistory(
      [run(0.25, false), run(0.5, false)],
      { now: NOW, maxAgeMs: 3 * HOUR },
    );
    assert.equal(summary.state, 'UNKNOWN');
  });

  it('is unknown, not healthy, for an empty or unparseable history', () => {
    assert.equal(summarizeReconcileHistory([], { now: NOW }).state, 'UNKNOWN');
    assert.equal(
      summarizeReconcileHistory(
        [{ id: 'a', completedAt: null, reconciled: true }],
        { now: NOW },
      ).state,
      'UNKNOWN',
    );
    assert.equal(
      summarizeReconcileHistory(
        [{ id: 'a', completedAt: 'not a date', reconciled: true }],
        { now: NOW },
      ).state,
      'UNKNOWN',
    );
  });

  it('treats the threshold as exclusive at the boundary and stale one ms past it', () => {
    const at = summarizeReconcileHistory(
      [{ id: 'a', completedAt: new Date(NOW - 3 * HOUR).toISOString(), reconciled: true }],
      { now: NOW, maxAgeMs: 3 * HOUR },
    );
    assert.equal(at.state, 'RECENT', 'exactly at the threshold is not yet stale');
    const past = summarizeReconcileHistory(
      [{ id: 'a', completedAt: new Date(NOW - 3 * HOUR - 1).toISOString(), reconciled: true }],
      { now: NOW, maxAgeMs: 3 * HOUR },
    );
    assert.equal(past.state, 'STALE');
  });

  it('does not let a future-dated run report a negative age', () => {
    // Runner clock skew against GitHub's timestamps is real and small; a
    // negative age would print as "-0h" and compare healthy for the wrong
    // reason.
    const summary = summarizeReconcileHistory(
      [{ id: 'a', completedAt: new Date(NOW + 5 * 60 * 1000).toISOString(), reconciled: true }],
      { now: NOW },
    );
    assert.equal(summary.state, 'RECENT');
    assert.equal(summary.ageMs, 0);
  });

  it('defaults the threshold to three times the workflow backstop interval', () => {
    // Sized against the hourly cron the workflow keeps as its backstop, not
    // against a fixture: one missed tick is ordinary, three consecutive misses
    // plus a missed event mean nothing is reconciling.
    assert.equal(DEFAULT_MAX_RECONCILE_AGE_MS, 3 * HOUR);
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

describe('the step name this scanner matches on', () => {
  it('is a step the reconciler workflow actually defines', () => {
    // The scanner's whole signal is this string. If the workflow renames the
    // step, every run reads as "did not reconcile" — which alarms rather than
    // going quiet, but alarms for the wrong reason forever. Pin them together.
    const workflow = YAML.parse(readFileSync(
      resolve(repoRoot, '.github/workflows/railway-deploy-trigger.yml'),
      'utf8',
    ));
    const names = workflow.jobs.trigger.steps.map((step) => step.name);
    assert.ok(
      names.includes(RECONCILE_STEP_NAME),
      `RECONCILE_STEP_NAME ${JSON.stringify(RECONCILE_STEP_NAME)} names no step in the workflow; it has ${JSON.stringify(names)}`,
    );
  });
});
