// #6376 — a failing post-merge deploy must produce an alarm that does not
// depend on someone opening the Actions tab. The deploy gate cannot require
// push-only workflows, so the alarm is a scheduled monitor reading each
// workflow's run history on main. GitHub transport unreadability is a
// warning, not a healthy pass; git/4xx/ENOENT still fail the job.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_NO_RUN_WINDOW_MS,
  MONITORED_WORKFLOWS,
  checkPostmergeDeploys,
  createRetryingGh,
  diffTouchesPath,
  diffTouchesPaths,
  formatResultMark,
  githubWarningAnnotations,
  isGithubRecordUnreadability,
  isRetryableGhFailure,
  judgeWorkflow,
  readNewestRun,
  readRunJobs,
  summarizeResults,
  writeUnknownVisibility,
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
        deploymentRequired: workflow.triggerPaths ? false : null,
        now: NOW,
      });
      assert.equal(verdict.state, 'OK', workflow.file);
      assert.equal(verdict.verdict, 'DEPLOYED', workflow.file);
    }
  });

  it('alarms immediately when current main changed a path-filtered deploy trigger', () => {
    const verdict = judgeWorkflow({
      workflow: WORKER,
      run: run({ runId: 334 }),
      jobs: new Map([['Wrangler deploy', { name: 'Wrangler deploy', conclusion: 'success', status: 'completed' }]]),
      deploymentRequired: true,
      now: NOW,
    });

    assert.equal(verdict.state, 'ALARM');
    assert.equal(verdict.verdict, 'DEPLOY_MISSING_AFTER_CHANGE');
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
        deploymentRequired: false,
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
      deploymentRequired: false,
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

  it('alarms when no run exists in the window', () => {
    // The workflow stopped running entirely (deleted, broken trigger) — the
    // case a workflow_run event can never see.
    const noRun = judgeWorkflow({
      workflow: CONVEX,
      run: { found: false, verdict: 'NO_RUN', detail: 'no run at all' },
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

  it('does not age out a path-filtered deploy when its trigger paths are unchanged', () => {
    const staleRun = {
      found: true,
      verdict: 'NO_RUN_IN_WINDOW',
      runId: 42,
      createdAt: new Date(NOW - 15 * 24 * HOUR).toISOString(),
      conclusion: 'success',
      headSha: 'a'.repeat(40),
      detail: 'predates the window',
    };

    const verdict = judgeWorkflow({
      workflow: WORKER,
      run: staleRun,
      jobs: new Map([['Wrangler deploy', { name: 'Wrangler deploy', conclusion: 'success', status: 'completed' }]]),
      deploymentRequired: false,
      now: NOW,
    });

    assert.equal(verdict.state, 'OK');
    assert.equal(verdict.verdict, 'DEPLOY_NOT_DUE');
    assert.match(verdict.detail, /trigger path/i);

    const failedBaseline = judgeWorkflow({
      workflow: WORKER,
      run: { ...staleRun, conclusion: 'failure' },
      jobs: null,
      deploymentRequired: false,
      now: NOW,
    });
    assert.equal(failedBaseline.state, 'ALARM', 'an unchanged tree cannot turn a failed baseline green');
    assert.equal(failedBaseline.verdict, 'RUN_FAILED');
  });

  it('still alarms when a path-filtered deploy is old and a trigger path changed', () => {
    const staleRun = {
      found: true,
      verdict: 'NO_RUN_IN_WINDOW',
      runId: 43,
      createdAt: new Date(NOW - 15 * 24 * HOUR).toISOString(),
      conclusion: 'success',
      headSha: 'b'.repeat(40),
      detail: 'predates the window',
    };

    const verdict = judgeWorkflow({
      workflow: WORKER,
      run: staleRun,
      jobs: null,
      deploymentRequired: true,
      now: NOW,
    });

    assert.equal(verdict.state, 'ALARM');
    assert.equal(verdict.verdict, 'DEPLOY_MISSING_AFTER_CHANGE');
    assert.match(verdict.detail, /trigger path/i);
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
    assert.equal(newest.runId, 2, 'must pick the newest run, not the first page entry');
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

  it('reads active runs so an in-flight path deploy is not a false alarm', () => {
    const active = readNewestRun({
      gh: (args) => {
        assert.doesNotMatch(args.join(' '), /status=completed/, 'the newest run may still be queued or running');
        return JSON.stringify({
          workflow_runs: [{
            id: 3,
            created_at: new Date(NOW - 1000).toISOString(),
            status: 'in_progress',
            conclusion: null,
            run_attempt: 1,
            head_sha: 'f'.repeat(40),
            event: 'push',
          }],
        });
      },
      repository: 'koala73/worldmonitor',
      workflowFile: 'deploy-worker.yml',
      now: NOW,
    });

    assert.equal(active.verdict, 'RUN_FOUND');
    assert.equal(active.conclusion, 'in_progress');
    const verdict = judgeWorkflow({
      workflow: WORKER,
      run: active,
      jobs: null,
      deploymentRequired: true,
    });
    assert.equal(verdict.state, 'OK');
    assert.equal(verdict.verdict, 'IN_PROGRESS');
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
      () => readNewestRun({
        gh: ghRuns('deploy-worker.yml', [{
          id: 7,
          created_at: 'not-a-timestamp',
          conclusion: 'success',
          run_attempt: 1,
          head_sha: '7'.repeat(40),
        }]),
        repository: 'koala73/worldmonitor',
        workflowFile: 'deploy-worker.yml',
        now: NOW,
      }),
      /created_at/,
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
    const calls = [];
    assert.equal(
      diffTouchesPaths({
        git: (args) => { calls.push(args); return ''; },
        baseSha: 'd'.repeat(40),
        headSha: 'origin/main',
        paths: ['workers/api-cors-preflight/**', 'api/_bootstrap-public-tier.js'],
      }),
      false,
    );
    assert.deepEqual(calls[0], [
      'diff',
      '--name-only',
      'd'.repeat(40),
      'origin/main',
      '--',
      'workers/api-cors-preflight/**',
      'api/_bootstrap-public-tier.js',
    ]);
  });

  it('proves a stale path-filtered deploy against current main before reporting healthy', () => {
    const deployedHead = '9'.repeat(40);
    const gitCalls = [];
    const gh = (args) => {
      const joined = args.join(' ');
      const runsMatch = joined.match(/workflows\/([^/]+)\/runs/);
      if (runsMatch) {
        const stale = runsMatch[1] === 'deploy-worker.yml';
        return JSON.stringify({
          workflow_runs: [{
            id: stale ? 700 : 701,
            created_at: new Date(NOW - (stale ? 15 * 24 * HOUR : HOUR)).toISOString(),
            conclusion: 'success',
            run_attempt: 1,
            head_sha: stale ? deployedHead : '8'.repeat(40),
            event: 'push',
            display_title: 'push',
          }],
        });
      }
      return jobsPayload([
        { name: 'deploy', conclusion: 'success', status: 'completed' },
        { name: 'Wrangler deploy', conclusion: 'success', status: 'completed' },
      ]);
    };

    const results = checkPostmergeDeploys({
      repository: 'koala73/worldmonitor',
      gh,
      git: (args) => { gitCalls.push(args); return ''; },
      now: NOW,
    });

    const worker = results.find((entry) => entry.workflow === 'deploy-worker.yml');
    assert.equal(worker.state, 'OK');
    assert.equal(worker.verdict, 'DEPLOY_NOT_DUE');
    assert.equal(gitCalls.length, 2, 'both path-filtered workflows require current-tree proof');
    const workerDiff = gitCalls.find((args) => args.includes('workers/api-cors-preflight/**'));
    assert.deepEqual(workerDiff, [
      'diff',
      '--name-only',
      deployedHead,
      'origin/main',
      '--',
      ...WORKER.triggerPaths,
    ]);
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
    assert.equal(outside.headSha, 'e'.repeat(40), 'a stale run must retain the deployed head for path proof');
    assert.equal(outside.runAttempt, 1);
  });
});

// #6479 — on 2026-08-12 this monitor emailed "All jobs have failed" while the
// genuine alarm (Convex Deploy red on main after #6470) went unnamed. A single
// transient TLS error from api.github.com threw out of the first read and
// aborted the whole walk. Three separate defects, one symptom.
describe('post-merge deploy monitor — read-path resilience (#6479)', () => {
  // The verbatim stderr from run 31560494370. A transport error never reached
  // GitHub, so there is no HTTP status in it — that absence is the signal.
  const TLS_STDERR = 'gh api repos/koala73/worldmonitor/actions/runs/30741257511/attempts/1/jobs failed (1): '
    + 'Get "https://api.github.com/repos/koala73/worldmonitor/actions/runs/30741257511/attempts/1/jobs": '
    + 'tls: failed to verify certificate: x509: certificate is not valid for any names, but wanted to match api.github.com';

  function githubReadFailure(message, properties = {}) {
    const error = new Error(message);
    error.githubReadSource = 'github-api';
    Object.assign(error, properties);
    return error;
  }

  describe('classifies which gh failures are worth retrying', () => {
    it('retries a transport error that never got an HTTP answer', () => {
      assert.equal(isRetryableGhFailure(new Error(TLS_STDERR)), true);
      for (const transport of [
        'dial tcp: lookup api.github.com: no such host',
        'read: connection reset by peer',
        'EOF',
      ]) {
        assert.equal(isRetryableGhFailure(new Error(transport)), true, transport);
      }
    });

    it('retries a transient HTTP status', () => {
      for (const status of [408, 429, 500, 502, 503, 504]) {
        assert.equal(
          isRetryableGhFailure(new Error(`gh: Server Error (HTTP ${status})`)),
          true,
          `HTTP ${status} is transient and must be retried`,
        );
      }
    });

    // The whole point of the classifier. A 404 or 422 IS GitHub's answer, and
    // re-asking cannot change it — retrying only burns the job's 10-minute
    // budget and delays the alarm the monitor exists to raise.
    it('never retries a status that is a real answer', () => {
      for (const status of [400, 401, 403, 404, 410, 422]) {
        assert.equal(
          isRetryableGhFailure(new Error(`gh: Not Found (HTTP ${status})`)),
          false,
          `HTTP ${status} is an answer, not a transport failure`,
        );
      }
    });

    // Every timeout attempt burns the full 30s call budget. Three workflows x
    // two reads x three attempts would be 9 minutes against `timeout-minutes:
    // 10`, so the retry would cause the outage it is meant to survive. Same
    // decision, same reason, as the sibling watchdog in #6478.
    it('never retries a timeout', () => {
      const timedOut = new Error('gh api repos/x/actions/runs timed out');
      timedOut.timedOut = true;
      assert.equal(isRetryableGhFailure(timedOut), false);
    });
  });

  describe('classifies which throws are GitHub unreadability', () => {
    it('treats transport, timeout, and 5xx as unreadability', () => {
      assert.equal(isGithubRecordUnreadability(githubReadFailure(TLS_STDERR)), true);
      const timedOut = githubReadFailure('gh api repos/x/actions/runs timed out', { timedOut: true });
      assert.equal(isGithubRecordUnreadability(timedOut), true);
      assert.equal(isGithubRecordUnreadability(githubReadFailure('gh: Server Error (HTTP 503)')), true);
    });

    it('treats git, missing gh, and HTTP 4xx as proof failures', () => {
      assert.equal(isGithubRecordUnreadability(new Error('git diff --name-only abc origin/main failed (128): not a tree')), false);
      assert.equal(isGithubRecordUnreadability(new Error('the deployed baseline SHA is missing')), false);
      const missing = new Error('spawn gh ENOENT');
      missing.code = 'ENOENT';
      assert.equal(isGithubRecordUnreadability(missing), false);
      for (const status of [400, 401, 403, 404, 408, 410, 422, 429]) {
        assert.equal(
          isGithubRecordUnreadability(githubReadFailure(`gh: Not Found (HTTP ${status})`)),
          false,
          `HTTP ${status} is an answer`,
        );
      }
    });
  });

  describe('retries the read before giving up', () => {
    it('recovers from a transient failure without surfacing it', async () => {
      const calls = [];
      const flaky = (args) => {
        calls.push(args);
        if (calls.length < 3) throw new Error(TLS_STDERR);
        return '{"ok":true}';
      };
      const slept = [];
      const gh = createRetryingGh({ gh: flaky, sleep: (ms) => { slept.push(ms); } });

      assert.equal(gh(['api', 'anything']), '{"ok":true}');
      assert.equal(calls.length, 3, 'two retries after the first failure');
      assert.equal(slept.length, 2, 'each retry backs off');
      assert.ok(slept[1] > slept[0], 'the backoff grows');
    });

    it('gives up after the budget and rethrows the original failure', () => {
      let calls = 0;
      const gh = createRetryingGh({
        gh: () => { calls += 1; throw new Error(TLS_STDERR); },
        sleep: () => {},
      });
      assert.throws(() => gh(['api', 'anything']), /tls: failed to verify certificate/);
      assert.ok(calls > 1, 'it did retry');
      assert.ok(calls <= 4, `the budget is bounded, got ${calls} attempts`);
    });

    it('does not retry a real answer — one call, immediate throw', () => {
      let calls = 0;
      const gh = createRetryingGh({
        gh: () => { calls += 1; throw new Error('gh: Not Found (HTTP 404)'); },
        sleep: () => { throw new Error('must not sleep on a 404'); },
      });
      assert.throws(() => gh(['api', 'anything']), /HTTP 404/);
      assert.equal(calls, 1);
    });
  });

  describe('one unreadable workflow does not silence the others', () => {
    // A gh stub for the whole fleet: healthy deploys everywhere, except the
    // workflow named in `unreadable`, whose run listing throws.
    function ghFleet({ unreadable }) {
      return (args) => {
        const joined = args.join(' ');
        if (unreadable && joined.includes(`workflows/${unreadable}/runs`)) {
          throw new Error(TLS_STDERR);
        }
        const runsMatch = joined.match(/workflows\/([^/]+)\/runs/);
        if (runsMatch) {
          return JSON.stringify({
            workflow_runs: [{
              id: 900,
              created_at: new Date(NOW - HOUR).toISOString(),
              conclusion: 'success',
              run_attempt: 1,
              head_sha: 'f'.repeat(40),
              event: 'push',
              display_title: 'push',
            }],
          });
        }
        // The jobs listing: every monitored deploy job name, all successful.
        return jobsPayload([
          { name: 'deploy', conclusion: 'success', status: 'completed' },
          { name: 'Wrangler deploy', conclusion: 'success', status: 'completed' },
        ]);
      };
    }

    it('reports the remaining workflows when the first read fails', () => {
      const results = checkPostmergeDeploys({
        repository: 'koala73/worldmonitor',
        gh: ghFleet({ unreadable: 'convex-deploy.yml' }),
        git: () => '',
        now: NOW,
      });

      assert.equal(
        results.length,
        MONITORED_WORKFLOWS.length,
        'every monitored workflow gets a verdict, even when an earlier read threw',
      );
      const convex = results.find((entry) => entry.workflow === 'convex-deploy.yml');
      assert.equal(convex.state, 'UNKNOWN');
      assert.equal(convex.verdict, 'READ_FAILED');
      assert.match(convex.detail, /tls: failed to verify certificate/);

      // This is the #6479 regression itself: the two workflows behind the
      // broken read were never judged at all.
      for (const other of results.filter((entry) => entry.workflow !== 'convex-deploy.yml')) {
        assert.equal(other.state, 'OK', `${other.workflow} must still be judged`);
        assert.equal(other.verdict, 'DEPLOYED');
      }
    });

    it('still judges a genuinely failed deploy behind an unreadable one', () => {
      const gh = (args) => {
        const joined = args.join(' ');
        if (joined.includes('workflows/convex-deploy.yml/runs')) throw new Error(TLS_STDERR);
        if (joined.includes('/runs?')) {
          return JSON.stringify({
            workflow_runs: [{
              id: 901,
              created_at: new Date(NOW - HOUR).toISOString(),
              conclusion: 'failure',
              run_attempt: 1,
              head_sha: 'f'.repeat(40),
              event: 'push',
              display_title: 'push',
            }],
          });
        }
        return jobsPayload([]);
      };

      const results = checkPostmergeDeploys({
        repository: 'koala73/worldmonitor',
        gh,
        git: () => '',
        now: NOW,
      });
      const failed = results.filter((entry) => entry.verdict === 'RUN_FAILED');
      assert.equal(failed.length, MONITORED_WORKFLOWS.length - 1);
      for (const entry of failed) assert.equal(entry.state, 'ALARM');
    });

    // UNKNOWN is not a deploy verdict. Keep the warning visible, but do not
    // fail the monitor when GitHub itself cannot serve the record.
    it('reports UNKNOWN without failing the monitor', () => {
      const summary = summarizeResults([
        { workflow: 'convex-deploy.yml', displayName: 'Convex Deploy', state: 'UNKNOWN', verdict: 'READ_FAILED', detail: TLS_STDERR },
        { workflow: 'deploy-worker.yml', displayName: 'Deploy Worker', state: 'OK', verdict: 'DEPLOYED', detail: 'run 900 deployed' },
      ]);
      assert.equal(summary.exitCode, 0, 'an unreadable GitHub record must not panic the monitor');
      assert.equal(summary.alarms.length, 0, 'an unread record is not a failed deploy');
      assert.equal(summary.unknowns.length, 1);
      assert.match(summary.lines.join('\n'), /could not be read|READ_FAILED/);
    });

    it('fails the monitor for git and GitHub 4xx throws, not only for deploy ALARMs', () => {
      const gitThrow = checkPostmergeDeploys({
        repository: 'koala73/worldmonitor',
        gh: ghFleet({}),
        git: (args) => {
          throw new Error(`git ${args.join(' ')} failed (128): not a tree`);
        },
        now: NOW,
      });
      const proofFailed = gitThrow.filter((entry) => entry.verdict === 'READ_UNPROVEN');
      assert.ok(proofFailed.length >= 1, 'path-filtered workflows must ALARM when git cannot prove the trigger tree');
      for (const entry of proofFailed) {
        assert.equal(entry.state, 'ALARM');
        assert.match(entry.detail, /not a tree/);
      }
      const gitSummary = summarizeResults(gitThrow);
      assert.equal(gitSummary.exitCode, 1);
      assert.match(gitSummary.lines.join('\n'), /could not prove|READ_UNPROVEN/);

      const gh = ghFleet({ unreadable: 'convex-deploy.yml' });
      const answered = checkPostmergeDeploys({
        repository: 'koala73/worldmonitor',
        gh: (args) => {
          const joined = args.join(' ');
          if (joined.includes('workflows/convex-deploy.yml/runs')) {
            throw new Error('gh: Not Found (HTTP 404)');
          }
          return gh(args);
        },
        git: () => '',
        now: NOW,
      });
      const convex = answered.find((entry) => entry.workflow === 'convex-deploy.yml');
      assert.equal(convex.state, 'ALARM');
      assert.equal(convex.verdict, 'READ_UNPROVEN');
      assert.equal(summarizeResults(answered).exitCode, 1);
    });

    it('fails the monitor when gh itself is missing', () => {
      const missing = new Error('spawn gh ENOENT');
      missing.code = 'ENOENT';
      const results = checkPostmergeDeploys({
        repository: 'koala73/worldmonitor',
        gh: () => { throw missing; },
        git: () => '',
        now: NOW,
      });
      assert.equal(results.length, MONITORED_WORKFLOWS.length);
      for (const entry of results) {
        assert.equal(entry.state, 'ALARM');
        assert.equal(entry.verdict, 'READ_UNPROVEN');
      }
      assert.equal(summarizeResults(results).exitCode, 1);
    });

    it('fails closed for exhausted 4xx, parser, auth, and local proof errors', () => {
      for (const status of [408, 429]) {
        let calls = 0;
        const results = checkPostmergeDeploys({
          repository: 'koala73/worldmonitor',
          gh: createRetryingGh({
            gh: () => {
              calls += 1;
              throw new Error(`gh: transient response (HTTP ${status})`);
            },
            attempts: 1,
            sleep: () => {},
          }),
          git: () => '',
          now: NOW,
        });
        assert.equal(
          calls,
          MONITORED_WORKFLOWS.length * 2,
          `HTTP ${status} must exhaust its retry budget before each workflow alarms`,
        );
        assert.ok(results.every((entry) => entry.state === 'ALARM' && entry.verdict === 'READ_UNPROVEN'));
        assert.equal(summarizeResults(results).exitCode, 1);
      }

      for (const gh of [
        () => '{not json',
        () => JSON.stringify({ workflow_runs: {} }),
        () => { throw new Error('gh auth login required'); },
      ]) {
        const results = checkPostmergeDeploys({
          repository: 'koala73/worldmonitor',
          gh,
          git: () => '',
          now: NOW,
        });
        assert.ok(results.every((entry) => entry.state === 'ALARM' && entry.verdict === 'READ_UNPROVEN'));
        assert.equal(summarizeResults(results).exitCode, 1);
      }

      const gitProcessError = new Error('spawn git EACCES');
      gitProcessError.code = 'EACCES';
      const results = checkPostmergeDeploys({
        repository: 'koala73/worldmonitor',
        gh: ghFleet({}),
        git: () => { throw gitProcessError; },
        now: NOW,
      });
      const proofFailures = results.filter((entry) => entry.verdict === 'READ_UNPROVEN');
      assert.ok(proofFailures.length > 0, 'a non-ENOENT git process failure must not become UNKNOWN');
      assert.ok(proofFailures.every((entry) => entry.state === 'ALARM'));
      assert.equal(summarizeResults(results).exitCode, 1);
    });

    it('emits Actions warning annotations for UNKNOWN without failing the job', () => {
      const results = [
        { workflow: 'convex-deploy.yml', displayName: 'Convex Deploy', state: 'UNKNOWN', verdict: 'READ_FAILED', detail: TLS_STDERR },
        { workflow: 'deploy-worker.yml', displayName: 'Deploy Worker', state: 'OK', verdict: 'DEPLOYED', detail: 'run 900 deployed' },
      ];
      assert.equal(formatResultMark('UNKNOWN'), 'warn');
      assert.equal(formatResultMark('ALARM'), 'ERROR');
      const annotations = githubWarningAnnotations(results);
      assert.equal(annotations.length, 1);
      assert.match(annotations[0], /^::warning title=Post-merge deploy record unread::Convex Deploy/);
      const stderr = [];
      const files = new Map();
      writeUnknownVisibility({
        results,
        summary: summarizeResults(results),
        stderr: (line) => { stderr.push(line); },
        env: { GITHUB_STEP_SUMMARY: '/tmp/postmerge-step-summary' },
        appendFile: (path, text) => { files.set(path, `${files.get(path) ?? ''}${text}`); },
      });
      assert.equal(stderr.length, 1);
      assert.match(stderr[0], /^::warning title=Post-merge deploy record unread::/);
      assert.match(files.get('/tmp/postmerge-step-summary'), /could not be read|READ_FAILED/);
    });

    it('reports a fleet of UNKNOWN records without failing the monitor', () => {
      const summary = summarizeResults(MONITORED_WORKFLOWS.map((workflow) => ({
        workflow: workflow.file,
        displayName: workflow.displayName,
        state: 'UNKNOWN',
        verdict: 'READ_FAILED',
        detail: TLS_STDERR,
      })));
      assert.equal(summary.exitCode, 0, 'a GitHub outage must not look like a failed deploy');
      assert.equal(summary.unknowns.length, MONITORED_WORKFLOWS.length);
      assert.equal(githubWarningAnnotations(summary.unknowns).length, MONITORED_WORKFLOWS.length);
    });

    // The reporting half of the incident: the notification must name the
    // Convex failure, not only the TLS error that interrupted a different read.
    it('reports a real alarm separately from an unreadable record', () => {
      const summary = summarizeResults([
        { workflow: 'convex-deploy.yml', displayName: 'Convex Deploy', state: 'ALARM', verdict: 'RUN_FAILED', detail: 'run 31560369482 concluded failure' },
        { workflow: 'deploy-worker.yml', displayName: 'Deploy Worker', state: 'UNKNOWN', verdict: 'READ_FAILED', detail: TLS_STDERR },
      ]);
      assert.equal(summary.exitCode, 1);
      assert.equal(summary.alarms.length, 1);
      assert.equal(summary.unknowns.length, 1);
      const report = summary.lines.join('\n');
      assert.match(report, /Convex Deploy/);
      assert.match(report, /did not deploy|RUN_FAILED/);
      assert.match(report, /could not be read|UNKNOWN|READ_FAILED/);
    });

    it('exits clean when everything deployed', () => {
      const summary = summarizeResults([
        { workflow: 'convex-deploy.yml', displayName: 'Convex Deploy', state: 'OK', verdict: 'DEPLOYED', detail: 'run 900 deployed' },
      ]);
      assert.equal(summary.exitCode, 0);
    });
  });
});
