/**
 * Contract for the main-only Railway registry reconciler.
 *
 * A registry change is incomplete until the live production configuration
 * matches it. This workflow owns that transition. It applies the current main
 * revision, whichever push triggered it, then proves the result through the
 * separate Viewer identity.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

import { DEPLOYMENT_CONFIG_RUN_BUDGET_MS } from '../scripts/audit-railway-watch-paths.mjs';
import {
  DEFAULT_RETRY_DELAYS_MS,
  MODE_ATTEMPT_TIMEOUT_MS,
} from '../scripts/run-railway-registry-sync.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = resolve(repoRoot, '.github/workflows/railway-registry-sync.yml');
const source = readFileSync(workflowPath, 'utf8');
const workflow = YAML.parse(source);

function steps(job) {
  assert.ok(Array.isArray(job?.steps), 'job must define steps');
  return job.steps;
}

function stepNamed(job, name) {
  const step = steps(job).find((candidate) => candidate.name === name);
  assert.ok(step, `job must define ${JSON.stringify(name)}`);
  return step;
}

// Executes one step's shell the way the runner does, with fake `date` and
// `git` executables on PATH, so the assertions are about what a step writes
// and exits with rather than about the text it happens to contain.
function createStepFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'railway-registry-sync-'));
  const startedAtMs = Date.now();
  const fakeDate = join(directory, 'date');
  writeFileSync(fakeDate, `#!/bin/sh\nprintf '%s\\n' '${startedAtMs}'\n`);
  chmodSync(fakeDate, 0o755);
  // `git ls-remote` answers with FAKE_MAIN_SHA, or fails when FAKE_GIT_FAIL=1.
  const fakeGit = join(directory, 'git');
  writeFileSync(fakeGit, [
    '#!/bin/sh',
    'if [ "${FAKE_GIT_FAIL:-}" = "1" ]; then exit 2; fi',
    `printf '%s\\trefs/heads/main\\n' "$FAKE_MAIN_SHA"`,
    '',
  ].join('\n'));
  chmodSync(fakeGit, 0o755);
  return {
    directory,
    startedAtMs,
    githubEnv: join(directory, 'github-env'),
    githubOutput: join(directory, 'github-output'),
  };
}

function executeStepShell(run, fixture, env = {}) {
  return spawnSync('bash', [
    '--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', run,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      PATH: `${fixture.directory}:${process.env.PATH}`,
      HOME: process.env.HOME ?? fixture.directory,
      GITHUB_ENV: fixture.githubEnv,
      ...env,
    },
  });
}

describe('Railway Registry Sync workflow', () => {
  it('runs for desired-state and reconciler changes on main', () => {
    assert.equal(workflow.name, 'Railway Registry Sync');
    assert.deepEqual(Object.keys(workflow.on), ['push', 'workflow_dispatch']);
    assert.deepEqual(workflow.on.push, {
      branches: ['main'],
      paths: [
        '.github/workflows/railway-registry-sync.yml',
        'scripts/audit-railway-watch-paths.mjs',
        'scripts/railway-native-autodeploy-fleet.json',
        'scripts/railway-*.mjs',
        'scripts/railway-services.json',
        'scripts/run-railway-registry-sync.mjs',
      ],
    });
    assert.deepEqual(workflow.permissions, { contents: 'read' });
  });

  it('serializes production writes and never cancels an in-flight apply', () => {
    assert.deepEqual(workflow.concurrency, {
      group: 'railway-registry-sync-production',
      'cancel-in-progress': false,
    });
  });

  it('uses one protected main-only job with read-only workflow permissions', () => {
    assert.deepEqual(Object.keys(workflow.jobs), ['reconcile']);
    const job = workflow.jobs.reconcile;
    assert.equal(job.needs, undefined);
    assert.equal(job['continue-on-error'], undefined);
    assert.equal(job.permissions, undefined, 'the job must not widen the workflow permissions');
    assert.doesNotMatch(source, /actions:\s*write|contents:\s*write|deployments:\s*write|statuses:\s*write/);
    assert.deepEqual(job.environment, {
      name: 'ingestion-acceptance-production',
      deployment: false,
    });
    const checkout = steps(job).find((step) => step.id === 'checkout');
    assert.equal(checkout?.with?.['persist-credentials'], false);
  });

  it('bounds apply retries and the Viewer budget inside the job cap', () => {
    const job = workflow.jobs.reconcile;
    const attempts = DEFAULT_RETRY_DELAYS_MS.length + 1;
    const backoffMs = DEFAULT_RETRY_DELAYS_MS.reduce((sum, delayMs) => sum + delayMs, 0);
    // Apply mode has no deadline of its own, so its worst case is every attempt
    // reaching the runner's per-attempt bound.
    const applyWorstCaseMs = MODE_ATTEMPT_TIMEOUT_MS.apply * attempts + backoffMs;
    // Verify's deadline is charged from the fresh stamp the budget step writes,
    // so once the first attempt spends it the later attempts fail immediately.
    // The runner's bound only backstops that deadline, so it must not undercut it.
    assert.ok(MODE_ATTEMPT_TIMEOUT_MS.verify >= DEPLOYMENT_CONFIG_RUN_BUDGET_MS);
    const verifyWorstCaseMs = DEPLOYMENT_CONFIG_RUN_BUDGET_MS + backoffMs;
    const setupAllowanceMs = 3 * 60_000;
    assert.equal(job['timeout-minutes'], 35);
    assert.ok(
      job['timeout-minutes'] * 60_000 >= applyWorstCaseMs + verifyWorstCaseMs + setupAllowanceMs,
      'timeout-minutes must cover the apply retry budget, the Viewer budget, and setup',
    );
  });

  it('keeps mutation and Viewer credentials in separate steps', () => {
    const job = workflow.jobs.reconcile;
    assert.equal(job.env, undefined);

    const apply = stepNamed(job, 'Reconcile registry-managed Railway configuration');
    assert.deepEqual(apply.env, {
      RAILWAY_TOKEN: '${{ secrets.RAILWAY_RECONCILE_DEPLOY_TOKEN_V2 }}',
      RAILWAY_PROJECT_ID: '${{ vars.RAILWAY_PROJECT_ID }}',
    });
    assert.equal(apply.run, 'node scripts/run-railway-registry-sync.mjs --mode apply');

    const verify = stepNamed(job, 'Verify live configuration with the Viewer identity');
    assert.match(verify.if, /^always\(\)/);
    assert.match(verify.if, /steps\.checkout\.outcome == 'success'/);
    assert.match(verify.if, /steps\.resolve-current-main\.outcome == 'success'/);
    assert.match(verify.if, /steps\.setup-node\.outcome == 'success'/);
    assert.match(verify.if, /steps\.install-railway\.outcome == 'success'/);
    assert.match(verify.if, /steps\.start-viewer-budget\.outcome == 'success'/);
    assert.deepEqual(verify.env, {
      RAILWAY_API_TOKEN: '${{ secrets.RAILWAY_PRODUCTION_VIEWER_API_TOKEN }}',
      RAILWAY_PROJECT_ID: '${{ vars.RAILWAY_PROJECT_ID }}',
    });
    assert.equal(verify.run, 'node scripts/run-railway-registry-sync.mjs --mode verify');

    // Each credential may appear in exactly one step, anywhere in that step
    // (env, run, with): a token leaking into another step's env or shell is
    // the regression this guards, not just a missing env block.
    for (const step of steps(job)) {
      const label = step.name ?? step.uses;
      const stepSource = JSON.stringify(step);
      if (step !== apply && step !== verify) {
        assert.equal(step.env, undefined, `${label} must not inherit a Railway credential`);
      }
      if (step !== apply) {
        assert.doesNotMatch(stepSource, /RAILWAY_TOKEN\b|RECONCILE_DEPLOY/, `${label} must not reference the mutation token`);
      }
      if (step !== verify) {
        assert.doesNotMatch(stepSource, /RAILWAY_API_TOKEN|PRODUCTION_VIEWER/, `${label} must not reference the Viewer token`);
      }
    }
  });

  it('checks out the resolved current main before setup or production credentials', () => {
    const jobSteps = steps(workflow.jobs.reconcile);
    const resolution = jobSteps.find((step) => step.id === 'resolve-current-main');
    const resolutionIndex = jobSteps.indexOf(resolution);
    const checkout = jobSteps.find((step) => step.id === 'checkout');
    const checkoutIndex = jobSteps.indexOf(checkout);
    const setupIndex = jobSteps.findIndex((step) => step.id === 'setup-node');
    const apply = stepNamed(workflow.jobs.reconcile, 'Reconcile registry-managed Railway configuration');

    assert.equal(resolutionIndex, 0, 'main must be resolved before anything is checked out');
    assert.ok(resolutionIndex < checkoutIndex);
    assert.ok(checkoutIndex < setupIndex);
    assert.ok(checkoutIndex < jobSteps.indexOf(apply));
    assert.match(
      resolution.run,
      /git ls-remote --exit-code "\$GITHUB_SERVER_URL\/\$GITHUB_REPOSITORY" refs\/heads\/main/,
    );
    assert.equal(resolution.env, undefined);
    // The pushed SHA is only the trigger. A stale run that applied its own
    // checkout would restore an older registry; one that refused would drop
    // the change when the next main commit does not touch registry paths.
    assert.equal(checkout.with?.ref, '${{ steps.resolve-current-main.outputs.sha }}');
  });

  it('resolves the current main revision whether or not the trigger is stale', () => {
    const fixture = createStepFixture();
    try {
      const resolution = stepNamed(workflow.jobs.reconcile, 'Resolve the current main revision');
      const mainSha = 'a'.repeat(40);
      const staleSha = 'b'.repeat(40);
      const run = (env) => {
        rmSync(fixture.githubOutput, { force: true });
        return executeStepShell(resolution.run, fixture, {
          GITHUB_SERVER_URL: 'https://github.com',
          GITHUB_REPOSITORY: 'owner/repo',
          GITHUB_OUTPUT: fixture.githubOutput,
          ...env,
        });
      };

      const current = run({ GITHUB_SHA: mainSha, FAKE_MAIN_SHA: mainSha });
      assert.equal(current.status, 0, `${current.stdout}\n${current.stderr}`);
      assert.equal(readFileSync(fixture.githubOutput, 'utf8'), `sha=${mainSha}\n`);
      assert.doesNotMatch(current.stdout, /::notice::/);

      const stale = run({ GITHUB_SHA: staleSha, FAKE_MAIN_SHA: mainSha });
      assert.equal(stale.status, 0, `a stale trigger must sync current main\n${stale.stdout}\n${stale.stderr}`);
      assert.equal(readFileSync(fixture.githubOutput, 'utf8'), `sha=${mainSha}\n`);
      assert.match(stale.stdout, new RegExp(`::notice::.*${mainSha}.*${staleSha}`));

      const unresolved = run({ GITHUB_SHA: mainSha, FAKE_MAIN_SHA: mainSha, FAKE_GIT_FAIL: '1' });
      assert.notEqual(unresolved.status, 0, 'an unreadable main must be refused');
      assert.match(unresolved.stdout, /::error::Could not resolve the current main revision/);
      assert.throws(() => readFileSync(fixture.githubOutput, 'utf8'), { code: 'ENOENT' });

      const malformed = run({ GITHUB_SHA: mainSha, FAKE_MAIN_SHA: 'not-a-sha' });
      assert.notEqual(malformed.status, 0, 'a malformed main revision must be refused');
      assert.throws(() => readFileSync(fixture.githubOutput, 'utf8'), { code: 'ENOENT' });
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it('starts a fresh read budget after apply and before Viewer verification', () => {
    const jobSteps = steps(workflow.jobs.reconcile);
    const apply = stepNamed(workflow.jobs.reconcile, 'Reconcile registry-managed Railway configuration');
    const budget = stepNamed(workflow.jobs.reconcile, 'Start Viewer verification budget');
    const verify = stepNamed(workflow.jobs.reconcile, 'Verify live configuration with the Viewer identity');
    assert.ok(jobSteps.indexOf(apply) < jobSteps.indexOf(budget));
    assert.ok(jobSteps.indexOf(budget) < jobSteps.indexOf(verify));
    assert.match(budget.if, /^always\(\)/);
    assert.match(budget.if, /steps\.resolve-current-main\.outcome == 'success'/);

    const fixture = createStepFixture();
    try {
      const result = executeStepShell(budget.run, fixture);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        readFileSync(fixture.githubEnv, 'utf8'),
        `RAILWAY_CONFIG_AUDIT_JOB_STARTED_AT_MS=${fixture.startedAtMs}\n`,
      );
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it('calls the guarded runner and never mutates Railway directly', () => {
    for (const step of steps(workflow.jobs.reconcile)) {
      const run = step.run ?? '';
      const label = step.name ?? step.uses;
      assert.doesNotMatch(
        run,
        /node\s+scripts\/audit-railway-watch-paths\.mjs[^\n]*--apply/,
        `${label} must not run the audit apply entrypoint directly`,
      );
      assert.doesNotMatch(
        run,
        /railway\s+(?:redeploy|up)\b|environment\s+edit/,
        `${label} must not mutate Railway outside the guarded runner`,
      );
    }
    assert.equal(
      steps(workflow.jobs.reconcile).some((step) => step.name === 'Name the operator sync command'),
      false,
    );
  });

  it('gives repair guidance after any failed reconciliation', () => {
    const summary = stepNamed(workflow.jobs.reconcile, 'Explain a failed reconciliation');
    assert.equal(summary.if, 'failure()');
    assert.doesNotMatch(summary.run, /Stale revision|never re-run an older workflow attempt/);
    assert.match(summary.run, /Source branch or check-suite drift/);
    assert.match(summary.run, /missing source credentials are listed separately and do not fail registry sync/);
    assert.match(summary.run, /GITHUB_STEP_SUMMARY/);
    assert.equal(summary.env, undefined);
  });
});
