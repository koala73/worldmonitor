// #6376 — a failing post-merge deploy must produce an alarm that does not
// depend on someone opening the Actions tab. The deploy gate cannot require
// push-only workflows, so the alarm is a scheduled monitor reading each
// workflow's run history on main. Like check-railway-reconcile-age.mjs, every
// case where the record is missing or unreadable resolves AWAY from healthy —
// an unmatched case meaning HEALTHY is the exact shape of the defect.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_NO_RUN_WINDOW_MS,
  MONITORED_WORKFLOWS,
  diffTouchesPath,
  judgeWorkflow,
  readNewestRun,
  readRunJobs,
} from '../scripts/check-postmerge-deploys.mjs';

const NOW = Date.parse('2026-08-10T12:00:00Z');
const HOUR = 60 * 60 * 1000;

function run(overrides = {}) {
  return {
    found: true,
    verdict: 'RUN_FOUND',
    runId: 12345,
    createdAt: new Date(NOW - HOUR).toISOString(),
    conclusion: 'success',
    runAttempt: 1,
    headSha: 'a'.repeat(40),
    event: 'push',
    displayTitle: 'push',
    ...overrides,
  };
}

function ghRuns(workflowFile, runs) {
  return (args) => {
    const joined = args.join(' ');
    assert.match(joined, new RegExp(`workflows/${workflowFile}/runs`));
    return JSON.stringify({ workflow_runs: runs });
  };
}

function jobsPayload(jobs) {
  return JSON.stringify({ jobs });
}

const CONVEX = MONITORED_WORKFLOWS.find((workflow) => workflow.file === 'convex-deploy.yml');
const RECONCILE = MONITORED_WORKFLOWS.find((workflow) => workflow.file === 'deploy-railway-reconcile-control.yml');
const WORKER = MONITORED_WORKFLOWS.find((workflow) => workflow.file === 'deploy-worker.yml');

describe('post-merge deploy monitor', () => {
  it('monitors every push-to-main deployer that the deploy gate cannot see', () => {
    assert.deepEqual(
      MONITORED_WORKFLOWS.map((workflow) => workflow.file),
      [
        'convex-deploy.yml',
        'deploy-railway-reconcile-control.yml',
        'deploy-worker.yml',
      ],
    );
    // The gate's aggregated workflows are the four PR workflows; these three
    // must not be among them (they are push-only and cannot gate a PR). The
    // convex-deploy changes job deliberately shares no name with test.yml's
    // (see convex-deploy.yml:37-42), so none of the names collide either.
    for (const workflow of MONITORED_WORKFLOWS) {
      assert.notEqual(workflow.displayName, 'Test');
      assert.notEqual(workflow.displayName, 'Typecheck');
      assert.notEqual(workflow.displayName, 'Lint Code');
      assert.notEqual(workflow.displayName, 'Security Audit');
    }
  });

  it('flags a failed run loudly (the #6232 and #6325/#6326 shapes)', () => {
    // Convex Deploy failing on 5605edcbd (#6232): the run concluded failure.
    const failedRun = run({ conclusion: 'failure', runId: 111 });
    const verdict = judgeWorkflow({
      workflow: CONVEX,
      run: failedRun,
      jobs: null,
      now: NOW,
    });
    assert.equal(verdict.state, 'ALARM');
    assert.equal(verdict.verdict, 'RUN_FAILED');
    assert.match(verdict.detail, /111/);
    assert.match(verdict.detail, /failure/);

    // Reconcile Worker failing on d130a957f / eb4bb09c1 (#6325/#6326): the
    // run concluded failure even though the deploy job failed mid-run.
    const reconcileFailed = judgeWorkflow({
      workflow: RECONCILE,
      run: run({ conclusion: 'failure', runId: 222 }),
      jobs: null,
      now: NOW,
    });
    assert.equal(reconcileFailed.state, 'ALARM');
    assert.equal(reconcileFailed.verdict, 'RUN_FAILED');
  });

  it('accepts a successful run whose deploy job succeeded', () => {
    for (const workflow of MONITORED_WORKFLOWS) {
      const verdict = judgeWorkflow({
        workflow,
        run: run({ runId: 333 }),
        jobs: new Map([[workflow.deployJobName, { name: workflow.deployJobName, conclusion: 'success', status: 'completed' }]]),
        now: NOW,
      });
      assert.equal(verdict.state, 'OK', workflow.file);
      assert.equal(verdict.verdict, 'DEPLOYED', workflow.file);
    }
  });

  it('accepts a convex=false skip only when the head diff proves it', () => {
    // The healthy convex-deploy shape: the run succeeded and the deploy job
    // was skipped because nothing under convex/ changed. The skipProof must
    // return true (nothing touched) for the skip to be legitimate.
    const verdict = judgeWorkflow({
      workflow: CONVEX,
      run: run({ runId: 444 }),
      jobs: new Map([['deploy', { name: 'deploy', conclusion: 'skipped', status: 'completed' }]]),
      skipProof: () => true,
      now: NOW,
    });
    assert.equal(verdict.state, 'OK');
    assert.equal(verdict.verdict, 'DEPLOY_SKIPPED_LEGIT');
  });

  it('alarms on a convex deploy skipped without proof that the diff is empty', () => {
    // Two failure directions: the skipProof throws (unreadable parent) and it
    // returns false (the head DID touch convex/ but the deploy job skipped —
    // the workflow filter drifted from reality).
    for (const skipProof of [() => { throw new Error('unreadable'); }, () => false]) {
      const verdict = judgeWorkflow({
        workflow: CONVEX,
        run: run({ runId: 555 }),
        jobs: new Map([['deploy', { name: 'deploy', conclusion: 'skipped', status: 'completed' }]]),
        skipProof,
        now: NOW,
      });
      assert.equal(verdict.state, 'ALARM');
      assert.match(verdict.verdict, /DEPLOY_SKIPPED_UNPROVEN/);
    }
  });

  it('alarms on any skipped deploy job in a workflow with no legitimate skip', () => {
    // The reconcile Worker and the CORS Worker deploy jobs must never be
    // skipped: their path filters only fire when a deploy is wanted.
    for (const workflow of [RECONCILE, WORKER]) {
      const verdict = judgeWorkflow({
        workflow,
        run: run({ runId: 666 }),
        jobs: new Map([[workflow.deployJobName, { name: workflow.deployJobName, conclusion: 'skipped', status: 'completed' }]]),
        now: NOW,
      });
      assert.equal(verdict.state, 'ALARM', workflow.file);
      assert.equal(verdict.verdict, 'DEPLOY_SKIPPED_UNEXPECTED', workflow.file);
    }
  });

  it('alarms when a successful run has no deploy job at all', () => {
    const verdict = judgeWorkflow({
      workflow: CONVEX,
      run: run({ runId: 777 }),
      jobs: new Map([['convex-changes', { name: 'convex-changes', conclusion: 'success', status: 'completed' }]]),
      now: NOW,
    });
    assert.equal(verdict.state, 'ALARM');
    assert.equal(verdict.verdict, 'DEPLOY_JOB_MISSING');
  });

  it('alarms when a run succeeds but its deploy job failed', () => {
    const verdict = judgeWorkflow({
      workflow: RECONCILE,
      run: run({ runId: 888 }),
      jobs: new Map([['Wrangler deploy', { name: 'Wrangler deploy', conclusion: 'failure', status: 'completed' }]]),
      now: NOW,
    });
    assert.equal(verdict.state, 'ALARM');
    assert.equal(verdict.verdict, 'DEPLOY_JOB_FAILED');
  });

  it('treats a run still in progress as not-yet-judged, not healthy or failed', () => {
    const verdict = judgeWorkflow({
      workflow: CONVEX,
      run: run({ conclusion: 'in_progress', runId: 999 }),
      jobs: null,
      now: NOW,
    });
    assert.equal(verdict.state, 'OK');
    assert.equal(verdict.verdict, 'IN_PROGRESS');
  });

  it('alarms on a run that concluded skipped — a deploy workflow that never deploys', () => {
    for (const conclusion of ['skipped', 'cancelled', 'timed_out', 'startup_failure', 'neutral']) {
      const verdict = judgeWorkflow({
        workflow: RECONCILE,
        run: run({ conclusion, runId: 1000 }),
        jobs: null,
        now: NOW,
      });
      assert.equal(verdict.state, 'ALARM', conclusion);
      assert.notEqual(verdict.verdict, 'OK');
    }
  });

  it('alarms when no completed run exists in the window', () => {
    // The workflow stopped running entirely (deleted, broken trigger) — the
    // case a workflow_run event can never see.
    const noRun = judgeWorkflow({
      workflow: CONVEX,
      run: { found: false, verdict: 'NO_RUN', detail: 'no completed run at all' },
      jobs: null,
      now: NOW,
    });
    assert.equal(noRun.state, 'ALARM');
    assert.equal(noRun.verdict, 'NO_RUN');

    const staleRun = judgeWorkflow({
      workflow: CONVEX,
      run: {
        found: true,
        verdict: 'NO_RUN_IN_WINDOW',
        runId: 42,
        createdAt: new Date(NOW - 30 * HOUR).toISOString(),
        conclusion: 'success',
        detail: 'predates the window',
      },
      jobs: null,
      now: NOW,
    });
    assert.equal(staleRun.state, 'ALARM');
    assert.equal(staleRun.verdict, 'NO_RUN_IN_WINDOW');
  });

  it('reads the newest run and the attempts-scoped jobs', () => {
    const newest = readNewestRun({
      gh: ghRuns('convex-deploy.yml', [
        { id: 1, created_at: new Date(NOW - 2 * HOUR).toISOString(), conclusion: 'success', run_attempt: 1, head_sha: 'b'.repeat(40), event: 'push', display_title: 'push' },
        { id: 2, created_at: new Date(NOW - HOUR).toISOString(), conclusion: 'failure', run_attempt: 2, head_sha: 'c'.repeat(40), event: 'push', display_title: 'push' },
      ]),
      repository: 'koala73/worldmonitor',
      workflowFile: 'convex-deploy.yml',
      now: NOW,
    });
    assert.equal(newest.runId, 2, 'must pick the newest completed run, not the first page entry');
    assert.equal(newest.conclusion, 'failure');
    assert.equal(newest.runAttempt, 2);

    const jobs = readRunJobs({
      gh: (args) => {
        assert.match(args.join(' '), /actions\/runs\/2\/attempts\/2\/jobs/);
        return jobsPayload([
          { name: 'convex-changes', conclusion: 'success', status: 'completed' },
          { name: 'deploy', conclusion: 'skipped', status: 'completed' },
        ]);
      },
      repository: 'koala73/worldmonitor',
      runId: 2,
      runAttempt: 2,
    });
    assert.equal(jobs.get('deploy').conclusion, 'skipped');
  });

  it('throws on an unreadable run listing instead of resolving to healthy', () => {
    assert.throws(
      () => readNewestRun({
        gh: () => JSON.stringify({ not_workflow_runs: true }),
        repository: 'koala73/worldmonitor',
        workflowFile: 'convex-deploy.yml',
        now: NOW,
      }),
      /workflow_runs/,
    );
    assert.throws(
      () => readRunJobs({
        gh: () => JSON.stringify({ jobs: 'nope' }),
        repository: 'koala73/worldmonitor',
        runId: 2,
        runAttempt: 1,
      }),
      /jobs/,
    );
  });

  it('judges the diff by trees only, with an empty diff meaning nothing touched', () => {
    assert.equal(
      diffTouchesPath({
        git: () => '',
        parentSha: 'p'.repeat(40),
        headSha: 'h'.repeat(40),
        pathPrefix: 'convex/',
      }),
      false,
    );
    assert.equal(
      diffTouchesPath({
        git: () => 'convex/schema.ts\n',
        parentSha: 'p'.repeat(40),
        headSha: 'h'.repeat(40),
        pathPrefix: 'convex/',
      }),
      true,
    );
  });

  it('honours the no-run window as a boundary, not a race', () => {
    const inside = readNewestRun({
      gh: ghRuns('convex-deploy.yml', [
        { id: 5, created_at: new Date(NOW - DEFAULT_NO_RUN_WINDOW_MS + 1000).toISOString(), conclusion: 'success', run_attempt: 1, head_sha: 'd'.repeat(40) },
      ]),
      repository: 'koala73/worldmonitor',
      workflowFile: 'convex-deploy.yml',
      now: NOW,
    });
    assert.equal(inside.verdict, 'RUN_FOUND');

    const outside = readNewestRun({
      gh: ghRuns('convex-deploy.yml', [
        { id: 6, created_at: new Date(NOW - DEFAULT_NO_RUN_WINDOW_MS - 1000).toISOString(), conclusion: 'success', run_attempt: 1, head_sha: 'e'.repeat(40) },
      ]),
      repository: 'koala73/worldmonitor',
      workflowFile: 'convex-deploy.yml',
      now: NOW,
    });
    assert.equal(outside.verdict, 'NO_RUN_IN_WINDOW');
  });
});