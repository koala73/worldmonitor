// #6142 — the CI-side deploy trigger.
//
// The decision under test is "does this merge have to build this service", and
// every way of getting it wrong has a different cost: a missed deploy strands a
// service on old code silently, a spurious one burns a build, and a retry of a
// build Railway already failed buries the alarm that owns it. Each of those is
// pinned below.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveServiceClosure } from '../scripts/railway-deploy-closure.mjs';
import { ControlPlaneError } from '../scripts/railway-reconcile-control-client.mjs';
import { validateResultManifest } from '../scripts/railway-reconcile-manifest.mjs';
import {
  FAILING_ACQUIRE_DEFERRALS,
  HANDLED_BY_RAILWAY,
  PINNED_RAILWAY_CLI,
  ReconcileAuthorizationError,
  ReconcileDeferral,
  assertWorkflowMutationAuthority,
  buildDeployArgs,
  createRailwayCliInstallEnv,
  createPlannedManifestEntries,
  installPinnedRailwayCli,
  planServiceDeploy,
  readCurrentMainLineageAuthorization,
  readExactCurrentMainAuthorization,
  readDeploymentId,
  runGitHubApi,
  runLeasedReconcile,
  selectServices,
  summarizeDeployPlan,
} from '../scripts/trigger-railway-deploys.mjs';

const HEAD = 'cf3ac8777fdd2de42b3740a4b9a18c7159ad5b4e';
const RUNNING = '045094590aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const SCRIPTS_SEEDER = resolveServiceClosure({
  liveService: {
    source: { rootDirectory: 'scripts' },
    build: { watchPatterns: ['scripts/**', 'shared/**'] },
  },
});

function deployment(status, commitHash, { id, createdAt = '2026-08-04T09:00:00.000Z', skippedReason } = {}) {
  return { ...(id ? { id } : {}), status, createdAt, meta: { commitHash, ...(skippedReason ? { skippedReason } : {}) } };
}

function plan(overrides = {}) {
  return planServiceDeploy({
    service: 'seed-aviation',
    serviceId: 'svc-1',
    closure: SCRIPTS_SEEDER,
    headSha: HEAD,
    changedPathsSince: () => ['scripts/seed-aviation.mjs'],
    deployments: [deployment('SUCCESS', RUNNING)],
    // Proven forward by default: these cases are about the arms AFTER the
    // rollback guard. The guard's own cases pass ancestry explicitly.
    ancestry: (ancestor, descendant) => (ancestor === RUNNING && descendant === HEAD ? 'yes' : 'no'),
    ...overrides,
  });
}

describe('deploy planning', () => {
  it('deploys when a change reaching the service landed since the running commit', () => {
    const result = plan();
    assert.equal(result.action, 'deploy');
    assert.equal(result.reason, 'CLOSURE_CHANGED');
    assert.deepEqual(result.matchedPaths, ['scripts/seed-aviation.mjs']);
    assert.equal(result.runningSha, RUNNING);
  });

  it('does not deploy when nothing reaching the service changed', () => {
    const result = plan({ changedPathsSince: () => ['src/App.ts', 'docs/a.md'] });
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, 'CLOSURE_UNCHANGED');
  });

  it('does not deploy a change that matches the filter but is outside the build context', () => {
    // The 57-case finding: a scripts-rooted container cannot see repository-root
    // shared/, so a shared/**-listing service must not be rebuilt for it.
    const result = plan({ changedPathsSince: () => ['shared/china-decision-signals.ts'] });
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, 'CLOSURE_UNCHANGED');
  });

  it('stands down once Railway has already built the head commit', () => {
    const result = plan({ deployments: [deployment('SUCCESS', HEAD, { id: 'dep-head', createdAt: '2026-08-04T12:00:00.000Z' }), deployment('SUCCESS', RUNNING)] });
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, HANDLED_BY_RAILWAY);
    assert.equal(result.observedDeploymentId, 'dep-head');
  });

  it('stands down while Railway is still building the head commit', () => {
    // Without this the trigger races Railway's own webhook on every merge and
    // doubles the build cost it exists to keep down.
    for (const status of ['QUEUED', 'BUILDING', 'DEPLOYING', 'INITIALIZING']) {
      const result = plan({ deployments: [deployment(status, HEAD, { createdAt: '2026-08-04T12:00:00.000Z' }), deployment('SUCCESS', RUNNING)] });
      assert.equal(result.action, 'skip', status);
      assert.equal(result.reason, HANDLED_BY_RAILWAY, status);
    }
  });

  it('does not retry a build Railway already ran and failed', () => {
    // check-railway-deploy-drift.mjs reports BUILD_FAILED for this. Retrying it
    // here would turn one visible failure into a silent retry loop.
    const result = plan({ deployments: [deployment('FAILED', HEAD, { createdAt: '2026-08-04T12:00:00.000Z' }), deployment('SUCCESS', RUNNING)] });
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, HANDLED_BY_RAILWAY);
  });

  it('retries a failed head only when protected recovery explicitly authorizes it', () => {
    const failed = deployment('FAILED', HEAD, {
      id: 'dep-failed',
      createdAt: '2026-08-04T12:00:00.000Z',
    });
    const result = plan({
      deployments: [failed, deployment('SUCCESS', RUNNING)],
      retryFailedHead: true,
    });
    assert.equal(result.action, 'deploy');
    assert.equal(result.reason, 'FAILED_HEAD_RETRY');
    assert.equal(result.observedDeploymentId, null);
  });

  it('retries the newest failed head even when an older same-head build succeeded', () => {
    const result = plan({
      deployments: [
        deployment('FAILED', HEAD, { id: 'dep-failed', createdAt: '2026-08-04T12:00:00.000Z' }),
        deployment('SUCCESS', HEAD, { id: 'dep-old-success', createdAt: '2026-08-04T11:58:00.000Z' }),
        deployment('SUCCESS', RUNNING, { createdAt: '2026-08-04T11:00:00.000Z' }),
      ],
      changedPathsSince: () => [],
      retryFailedHead: true,
      ancestry: (ancestor, descendant) => (ancestor === HEAD && descendant === HEAD ? 'yes' : 'no'),
    });
    assert.equal(result.action, 'deploy');
    assert.equal(result.reason, 'FAILED_HEAD_RETRY');
    assert.equal(result.observedDeploymentId, null);
  });

  it('retries an authorized failed first build instead of calling it never deployed', () => {
    const result = plan({
      deployments: [deployment('FAILED', HEAD, {
        id: 'dep-failed',
        createdAt: '2026-08-04T12:00:00.000Z',
      })],
      retryFailedHead: true,
    });
    assert.equal(result.action, 'deploy');
    assert.equal(result.reason, 'FAILED_HEAD_RETRY');
  });

  it('adopts a running same-head replacement newer than the failed build', () => {
    const result = plan({
      deployments: [
        deployment('SUCCESS', HEAD, { id: 'dep-replacement', createdAt: '2026-08-04T12:01:00.000Z' }),
        deployment('FAILED', HEAD, { id: 'dep-failed', createdAt: '2026-08-04T12:00:00.000Z' }),
        deployment('SUCCESS', RUNNING),
      ],
      retryFailedHead: true,
    });
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, HANDLED_BY_RAILWAY);
    assert.equal(result.observedDeploymentId, 'dep-replacement');
  });

  it('does not duplicate active head work during protected recovery', () => {
    const result = plan({
      deployments: [
        deployment('FAILED', HEAD, { id: 'dep-failed', createdAt: '2026-08-04T12:00:00.000Z' }),
        deployment('BUILDING', HEAD, { id: 'dep-building', createdAt: '2026-08-04T11:59:00.000Z' }),
        deployment('SUCCESS', RUNNING),
      ],
      retryFailedHead: true,
    });
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, HANDLED_BY_RAILWAY);
    assert.equal(result.observedDeploymentId, 'dep-building');
  });

  it('still deploys when the only record for head is Railway refusing it', () => {
    // This is the whole point: a SKIPPED record means Railway declined, so it
    // must never count as "already taken".
    const result = plan({
      deployments: [
        deployment('SKIPPED', HEAD, { createdAt: '2026-08-04T12:00:00.000Z', skippedReason: 'CI check suite failed' }),
        deployment('SUCCESS', RUNNING),
      ],
    });
    assert.equal(result.action, 'deploy');
    assert.equal(result.reason, 'CLOSURE_CHANGED');
  });

  it('deploys when the running deployment carries no commit', () => {
    // A `railway up` recovery leaves the service on an unidentifiable source;
    // seed-military-flights has been in that state since its manual repair.
    const result = plan({ deployments: [deployment('SUCCESS', undefined)] });
    assert.equal(result.action, 'deploy');
    assert.equal(result.reason, 'UNKNOWN_SOURCE');
  });

  it('deploys when the checkout cannot reach the running commit', () => {
    const result = plan({ changedPathsSince: () => null });
    assert.equal(result.action, 'deploy');
    assert.equal(result.reason, 'HISTORY_UNAVAILABLE');
  });

  it('stands down when the service is already running head', () => {
    // Subsumed by the already-taken arm: a running deployment for head is one
    // of the records that proves Railway took the commit.
    const result = plan({ deployments: [deployment('SUCCESS', HEAD)] });
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, HANDLED_BY_RAILWAY);
  });

  it('does not call an unrecognised status "already taken"', () => {
    // Railway's live DeploymentStatus enum carries NEEDS_APPROVAL and REMOVING,
    // neither of which this script classifies. Under a bare
    // `status !== 'SKIPPED'` test, a service whose head deployment sits in
    // NEEDS_APPROVAL reads as handled on EVERY run forever and is never
    // retried — the unmatched case silently meaning healthy.
    for (const status of ['NEEDS_APPROVAL', 'REMOVING', 'A_STATUS_FROM_2027']) {
      const result = plan({
        deployments: [
          deployment(status, HEAD, { createdAt: '2026-08-04T12:00:00.000Z' }),
          deployment('SUCCESS', RUNNING),
        ],
      });
      assert.notEqual(result.reason, HANDLED_BY_RAILWAY, `${status} must not read as handled`);
      assert.equal(result.action, 'report', status);
      assert.equal(result.reason, 'UNKNOWN_STATUS', status);
    }
  });

  it('still recognises every status it does classify as taken', () => {
    // The other half: narrowing the test must not make known statuses stop
    // counting, which would re-deploy commits Railway already has.
    for (const status of ['SUCCESS', 'REMOVED', 'CRASHED', 'SLEEPING', 'QUEUED', 'WAITING', 'INITIALIZING', 'BUILDING', 'DEPLOYING', 'FAILED']) {
      const result = plan({
        deployments: [
          deployment(status, HEAD, { createdAt: '2026-08-04T12:00:00.000Z' }),
          deployment('SUCCESS', RUNNING),
        ],
      });
      assert.equal(result.reason, HANDLED_BY_RAILWAY, status);
    }
  });

  it('errors rather than guessing when the deployment history cannot be read', () => {
    for (const deployments of [null, undefined, 'nope', {}]) {
      const result = plan({ deployments });
      assert.equal(result.action, 'error', JSON.stringify(deployments));
    }
  });

  it('keeps the reason the deployment history could not be read', () => {
    // The run reds either way; without the reason the operator cannot tell a
    // rate limit from an auth failure from a renamed service.
    const result = plan({ deployments: null, readError: 'railway deployment list failed (1): 429 Too Many Requests' });
    assert.equal(result.action, 'error');
    assert.match(result.detail, /429/);
  });

  it('never deploys a service backwards onto an older commit', () => {
    // `git diff A..B` is non-empty in BOTH directions, so "this service is
    // missing paths" is not evidence that head is newer than what it runs.
    const newer = 'eeeeeeeee11111111111111111111111111111aa';
    const result = plan({
      deployments: [deployment('SUCCESS', newer)],
      changedPathsSince: () => ['scripts/seed-aviation.mjs'],
      ancestry: (a, d) => (a === HEAD && d === newer ? 'yes' : 'no'),
    });
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, 'AHEAD');
  });

  it('REFUSES to deploy when ancestry cannot be established', () => {
    // The rollback this whole guard exists for. Railway builds a merge in
    // seconds, so a service running a commit that landed after this checkout is
    // ordinary — and if we cannot reach that commit, we cannot prove head is
    // not OLDER than it. Deploying anyway rolls production backwards.
    //
    // The unreachable commit also makes changedPathsSince return null, so
    // before this guard the plan fell through to HISTORY_UNAVAILABLE -> deploy.
    const result = plan({
      deployments: [deployment('SUCCESS', 'eeeeeeeee11111111111111111111111111111aa')],
      changedPathsSince: () => null,
      ancestry: () => 'unknown',
    });
    assert.equal(result.action, 'skip', 'must not deploy over a commit it cannot evaluate');
    assert.equal(result.reason, 'ANCESTRY_UNKNOWN');
  });

  it('defaults to refusing rather than deploying', () => {
    // The parameter default is the last line of defence: a caller that forgets
    // to pass an ancestry resolver must not silently get the rollback.
    const result = planServiceDeploy({
      service: 'seed-aviation',
      closure: SCRIPTS_SEEDER,
      headSha: HEAD,
      deployments: [deployment('SUCCESS', RUNNING)],
      changedPathsSince: () => ['scripts/seed-aviation.mjs'],
    });
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, 'ANCESTRY_UNKNOWN');
  });

  it('refuses a diverged branch rather than picking a direction', () => {
    const result = plan({
      deployments: [deployment('SUCCESS', 'eeeeeeeee11111111111111111111111111111aa')],
      changedPathsSince: () => ['scripts/seed-aviation.mjs'],
      ancestry: () => 'no',
    });
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, 'DIVERGED');
  });

  it('deploys only once forward motion is proven', () => {
    const result = plan({ ancestry: (a, d) => (a === RUNNING && d === HEAD ? 'yes' : 'no') });
    assert.equal(result.action, 'deploy');
    assert.equal(result.reason, 'CLOSURE_CHANGED');
  });

  it('does not start a service that has never run', () => {
    // No running deployment at all is not a service lagging a merge — it is one
    // never started, stopped, or idle. Starting it is a decision nobody made
    // here, and UNKNOWN_SOURCE would have deployed it.
    const result = plan({ deployments: [deployment('SKIPPED', HEAD, { skippedReason: 'CI check suite failed' })] });
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, 'NEVER_DEPLOYED');
  });

  it('reads the newest running deployment, not whatever Railway listed first', () => {
    const newer = 'bbbbbbbbbcccccccccddddddddd0000000011111';
    const result = plan({
      deployments: [
        deployment('SUCCESS', RUNNING, { createdAt: '2026-08-01T00:00:00.000Z' }),
        deployment('SUCCESS', newer, { createdAt: '2026-08-04T00:00:00.000Z' }),
      ],
      changedPathsSince: (sha) => (sha === newer ? [] : ['scripts/seed-aviation.mjs']),
    });
    assert.equal(result.runningSha, newer);
    assert.equal(result.action, 'skip');
  });

  it('sorts an unreadable timestamp oldest instead of leaving the order undefined', () => {
    // The drift check pins this for itself; without the same case here, a
    // revert to an inline `Date.parse(x ?? 0)` sort passes the whole trigger
    // suite. NaN comparisons make the sort order undefined, so the record
    // chosen as "running" would depend on the input order — and runningSha is
    // what decides whether a production deploy fires.
    const result = plan({
      deployments: [
        deployment('SUCCESS', 'ffffffff000000000000000000000000000000aa', { createdAt: 'not-a-date' }),
        deployment('SUCCESS', RUNNING, { createdAt: '2026-08-01T00:00:00.000Z' }),
      ],
      changedPathsSince: () => ['scripts/seed-aviation.mjs'],
    });
    assert.equal(result.runningSha, RUNNING, 'the record with a readable timestamp must win');
  });

  it('treats a missing timestamp the same way', () => {
    const result = plan({
      deployments: [
        { status: 'SUCCESS', meta: { commitHash: 'ffffffff000000000000000000000000000000aa' } },
        deployment('SUCCESS', RUNNING, { createdAt: '2026-08-01T00:00:00.000Z' }),
      ],
      changedPathsSince: () => ['scripts/seed-aviation.mjs'],
    });
    assert.equal(result.runningSha, RUNNING);
  });

  it('ignores a SKIPPED record when deciding what the service is running', () => {
    // A refusal never produced an image, so it can never be the running source.
    const result = plan({
      deployments: [
        deployment('SKIPPED', HEAD, { createdAt: '2026-08-04T12:00:00.000Z', skippedReason: 'CI check suite failed' }),
        deployment('SUCCESS', RUNNING, { createdAt: '2026-08-01T00:00:00.000Z' }),
      ],
    });
    assert.equal(result.runningSha, RUNNING);
  });
});

describe('plan summary', () => {
  it('reports one unreadable service without reddening the run', () => {
    // A transient 429 on one service is ordinary third-party rot: the other
    // services were planned correctly, and check-railway-deploy-drift.mjs
    // alarms independently if that one really is behind. Failing the whole
    // scheduled run for it is how a red workflow stops being read.
    const plans = [
      plan(),
      plan({ changedPathsSince: () => [] }),
      plan({ deployments: null }),
    ];
    const summary = summarizeDeployPlan(plans);
    assert.equal(summary.deploys.length, 1);
    assert.equal(summary.unreadable.length, 1);
    assert.equal(summary.errors.length, 0);
    assert.equal(summary.ok, true);
    assert.equal(summary.counts.CLOSURE_CHANGED, 1);
  });

  it('fails the run when EVERY service is unreadable', () => {
    // Not per-service rot: an auth or connectivity failure wearing per-service
    // clothing. Planning nothing while reporting success is the silent no-op
    // this script exists to remove.
    const summary = summarizeDeployPlan([plan({ deployments: null }), plan({ deployments: null })]);
    assert.equal(summary.unreadable.length, 2);
    assert.equal(summary.errors.length, 2);
    assert.equal(summary.ok, false);
  });

  it('does not call an empty run failed', () => {
    const summary = summarizeDeployPlan([]);
    assert.equal(summary.ok, true);
  });

  it('is ok when nothing needs deploying', () => {
    const summary = summarizeDeployPlan([plan({ changedPathsSince: () => [] })]);
    assert.equal(summary.ok, true);
    assert.equal(summary.deploys.length, 0);
  });
});

describe('service selection', () => {
  const fleet = [{ name: 'seed-earthquakes' }, { name: 'seed-aviation' }, { name: 'ais-relay' }];

  it('runs the whole fleet when no filter is given', () => {
    assert.equal(selectServices(fleet, null).length, 3);
    assert.equal(selectServices(fleet, undefined).length, 3);
  });

  it('restricts to the named services', () => {
    assert.deepEqual(
      selectServices(fleet, 'seed-aviation, ais-relay').map((service) => service.name),
      ['seed-aviation', 'ais-relay'],
    );
  });

  it('throws on a name the fleet does not have rather than selecting nothing', () => {
    // A typo'd --only that selected nothing would report "no service needs a
    // build", which reads exactly like a healthy fleet.
    assert.throws(() => selectServices(fleet, 'seed-earthquake'), /does not deploy/);
    assert.throws(() => selectServices(fleet, 'seed-aviation,nope'), /nope/);
  });
});

describe('deploy call', () => {
  it('pins the exact commit as a string variable', () => {
    const args = buildDeployArgs({ serviceId: 'svc-1', environmentId: 'env-1', commitSha: HEAD });
    assert.equal(args[0], 'api');
    assert.match(args[1], /serviceInstanceDeployV2/);
    // --raw-var, not --var: --var parses the value as JSON when it can, and a
    // commit SHA of all digits would arrive as a number.
    assert.ok(args.includes('--raw-var'));
    assert.ok(args.includes(`commitSha=${HEAD}`));
    assert.ok(args.includes('serviceId=svc-1'));
    assert.ok(args.includes('environmentId=env-1'));
    assert.ok(!args.includes('--var'));
  });

  it('returns the deployment id Railway assigned', () => {
    assert.equal(readDeploymentId('{"data":{"serviceInstanceDeployV2":"dep-1"}}'), 'dep-1');
  });

  it('throws on a GraphQL error instead of reporting a deploy', () => {
    assert.throws(
      () => readDeploymentId('{"errors":[{"message":"Not authorized"}]}'),
      /Not authorized/,
    );
  });

  it('throws on a null payload instead of reporting a deploy', () => {
    for (const response of ['{"data":{"serviceInstanceDeployV2":null}}', '{"data":{}}', '{}']) {
      assert.throws(() => readDeploymentId(response), /no deployment id/, response);
    }
  });
});

const PRODUCER = {
  repository: 'koala73/worldmonitor',
  workflow: 'railway-deploy-trigger.yml',
  runId: '31210000001',
  runAttempt: 1,
};

function deployPlan(name) {
  return {
    service: name,
    serviceId: `svc-${name}`,
    action: 'deploy',
    reason: 'CLOSURE_CHANGED',
    observedDeploymentId: null,
  };
}

function fakeControl(events, { acquire } = {}) {
  return {
    acquire: acquire ?? (async () => {
      events.push('acquire');
      return {
        data: {
          attempt: { attemptId: 'attempt-1' },
          leaseCapability: 'lease-capability-abcdefghijklmnopqrstuvwxyz',
          dispatchHold: null,
        },
      };
    }),
    prepare: async () => { events.push('prepare'); },
    assertLease: async () => { events.push('assert'); },
    startMutation: async () => { events.push('start'); },
    bindResult: async (body) => { events.push(`bind:${body.resultKind}`); },
    release: async () => { events.push('release'); },
  };
}

function leasedOptions(events, overrides = {}) {
  let clock = Date.parse('2026-08-07T20:00:00.000Z');
  return {
    control: fakeControl(events),
    ownerId: `github-run:${PRODUCER.runId}:${PRODUCER.runAttempt}`,
    headSha: HEAD,
    producer: PRODUCER,
    authorizeCurrent: async () => {
      events.push('authorize');
      return {
        gateContext: 'gate', gateState: 'success',
        gateObservedAt: '2026-08-07T20:00:00.000Z',
        mainObservedAt: '2026-08-07T20:00:00.000Z',
      };
    },
    buildPlan: async () => {
      events.push('build');
      return { projectId: 'project-1', environmentId: 'environment-1', plans: [] };
    },
    refreshService: async (plan) => { events.push(`refresh:${plan.service}`); return plan; },
    deployService: async (plan) => { events.push(`deploy:${plan.service}`); return `dep-${plan.service}`; },
    writeResult: async (result) => { events.push('write'); validateResultManifest(result); },
    now: () => clock++,
    ...overrides,
  };
}

describe('protected leased mutation orchestration', () => {
  it('alarms only on an unresolved mutation barrier, not ordinary contention or verification overlap', () => {
    assert.deepEqual([...FAILING_ACQUIRE_DEFERRALS].sort(), [
      'MUTATION_BARRIER_ACTIVE',
    ]);
    assert.equal(FAILING_ACQUIRE_DEFERRALS.has('LEASE_HELD'), false);
    assert.equal(FAILING_ACQUIRE_DEFERRALS.has('DISPATCH_HOLD_ACTIVE'), false);
    assert.equal(FAILING_ACQUIRE_DEFERRALS.has('VERIFICATION_PENDING'), false);
  });

  it('installs only the reviewed Railway CLI version for the acquired production path', () => {
    const calls = [];
    const env = {
      HOME: '/runner/home',
      PATH: '/runner/bin',
      RAILWAY_TOKEN: 'deploy-secret',
      RAILWAY_RECONCILE_MUTATION_HMAC: 'mutation-secret',
      GH_TOKEN: 'github-secret',
      UNRELATED_SECRET: 'other-secret',
    };
    installPinnedRailwayCli({
      env,
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0, signal: null, error: null };
      },
    });
    assert.equal(PINNED_RAILWAY_CLI, '@railway/cli@5.30.1');
    assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
      ['npm', ['install', '--global', '@railway/cli@5.30.1']],
    ]);
    assert.equal(calls[0].options.timeout, 2 * 60 * 1_000);
    assert.deepEqual(calls[0].options.env, { HOME: '/runner/home', PATH: '/runner/bin' });
    assert.deepEqual(createRailwayCliInstallEnv(env), calls[0].options.env);
  });

  it('retries GitHub state reads without exposing Railway capabilities', () => {
    const calls = [];
    const parsed = runGitHubApi('repos/o/r/git/ref/heads/main', {
      HOME: '/runner/home',
      PATH: '/runner/bin',
      GH_TOKEN: 'github-secret',
      RAILWAY_TOKEN: 'deploy-secret',
      RAILWAY_RECONCILE_MUTATION_HMAC: 'mutation-secret',
    }, {
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return calls.length === 1
          ? { status: 1, signal: null, error: null, stdout: '' }
          : { status: 0, signal: null, error: null, stdout: '{"ok":true}' };
      },
    });
    assert.deepEqual(parsed, { ok: true });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].options.env, {
      GH_TOKEN: 'github-secret',
      HOME: '/runner/home',
      PATH: '/runner/bin',
    });

    let failures = 0;
    assert.throws(() => runGitHubApi('repos/o/r', { GH_TOKEN: 'github-secret' }, {
      spawn: () => {
        failures += 1;
        return { status: 0, signal: null, error: null, stdout: 'not-json' };
      },
    }), (error) => error instanceof ReconcileAuthorizationError
      && error.code === 'GITHUB_STATE_UNREADABLE');
    assert.equal(failures, 3);
  });

  it('rejects direct non-dry-run execution before any control or Railway access', () => {
    assert.doesNotThrow(() => assertWorkflowMutationAuthority({ dryRun: true, argv: [], env: {} }));
    assert.throws(
      () => assertWorkflowMutationAuthority({ dryRun: false, argv: [], env: {} }),
      /direct Railway mutation is forbidden/i,
    );
    assert.doesNotThrow(() => assertWorkflowMutationAuthority({
      dryRun: false,
      argv: ['node', 'script', '--workflow-authorized'],
      env: {
        GITHUB_ACTIONS: 'true',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_WORKFLOW_REF: 'koala73/worldmonitor/.github/workflows/railway-deploy-trigger.yml@refs/heads/main',
        GITHUB_REPOSITORY: PRODUCER.repository,
        GITHUB_RUN_ID: PRODUCER.runId,
        GITHUB_RUN_ATTEMPT: '1',
        RAILWAY_RECONCILE_CUTOVER_ACTIVE: 'true',
      },
    }));
  });

  it('revalidates exact current main and the newest green gate as closed evidence', () => {
    const paths = [];
    const authorization = readExactCurrentMainAuthorization({
      repository: PRODUCER.repository,
      headSha: HEAD,
      now: () => Date.parse('2026-08-07T20:00:00.000Z'),
      api: (path) => {
        paths.push(path);
        return path.includes('/git/ref/')
          ? { object: { sha: HEAD } }
          : [{ context: 'gate', state: 'success' }];
      },
    });
    assert.deepEqual(paths, [
      `repos/${PRODUCER.repository}/git/ref/heads/main`,
      `repos/${PRODUCER.repository}/commits/${HEAD}/statuses?per_page=100`,
    ]);
    assert.equal(authorization.gateState, 'success');
    assert.throws(() => readExactCurrentMainAuthorization({
      repository: PRODUCER.repository,
      headSha: HEAD,
      api: () => ({ object: { sha: 'b'.repeat(40) } }),
    }), (error) => error instanceof ReconcileAuthorizationError && error.code === 'MAIN_MOVED');
  });

  it('authorizes final acceptance when current green main descends from the reconciled head', () => {
    const descendant = 'b'.repeat(40);
    const paths = [];
    const authorization = readCurrentMainLineageAuthorization({
      repository: PRODUCER.repository,
      headSha: HEAD,
      now: () => Date.parse('2026-08-07T20:00:00.000Z'),
      api: (path) => {
        paths.push(path);
        if (path.includes('/git/ref/')) return { object: { sha: descendant } };
        if (path.includes('/statuses')) return [{ context: 'gate', state: 'success' }];
        return { status: 'ahead', merge_base_commit: { sha: HEAD } };
      },
    });
    assert.equal(authorization.lineage, 'DESCENDANT');
    assert.equal(authorization.attemptedHeadSha, HEAD);
    assert.equal(authorization.currentMainHeadSha, descendant);
    assert.deepEqual(paths, [
      `repos/${PRODUCER.repository}/git/ref/heads/main`,
      `repos/${PRODUCER.repository}/commits/${descendant}/statuses?per_page=100`,
      `repos/${PRODUCER.repository}/compare/${HEAD}...${descendant}`,
      `repos/${PRODUCER.repository}/git/ref/heads/main`,
    ]);
  });

  it('rejects a diverged or moving current main instead of accepting unrelated lineage', () => {
    const descendant = 'b'.repeat(40);
    assert.throws(() => readCurrentMainLineageAuthorization({
      repository: PRODUCER.repository,
      headSha: HEAD,
      api: (path) => {
        if (path.includes('/git/ref/')) return { object: { sha: descendant } };
        if (path.includes('/statuses')) return [{ context: 'gate', state: 'success' }];
        return { status: 'diverged', merge_base_commit: { sha: 'c'.repeat(40) } };
      },
    }), (error) => error instanceof ReconcileAuthorizationError && error.code === 'MAIN_DIVERGED');

    let refReads = 0;
    assert.throws(() => readCurrentMainLineageAuthorization({
      repository: PRODUCER.repository,
      headSha: HEAD,
      api: (path) => {
        if (path.includes('/git/ref/')) {
          refReads += 1;
          return { object: { sha: refReads === 1 ? descendant : 'd'.repeat(40) } };
        }
        if (path.includes('/statuses')) return [{ context: 'gate', state: 'success' }];
        return { status: 'ahead', merge_base_commit: { sha: HEAD } };
      },
    }), (error) => error instanceof ReconcileAuthorizationError && error.code === 'MAIN_MOVED');
  });

  it('acquires before fleet planning and fences every serial provider call', async () => {
    const events = [];
    const plans = [deployPlan('a'), deployPlan('b')];
    const result = await runLeasedReconcile(leasedOptions(events, {
      buildPlan: async () => {
        events.push('build');
        return { projectId: 'project-1', environmentId: 'environment-1', plans };
      },
    }));
    assert.deepEqual(events, [
      'authorize', 'acquire', 'build', 'prepare',
      'assert', 'authorize', 'refresh:a', 'start', 'deploy:a',
      'assert', 'authorize', 'refresh:b', 'deploy:b',
      'write', 'bind:MUTATED', 'release',
    ]);
    assert.equal(result.result.outcome, 'MUTATION_COMPLETED');
    assert.deepEqual(result.result.entries.map((entry) => entry.deploymentId), ['dep-a', 'dep-b']);
  });

  it('adopts a fresh native deployment instead of triggering a duplicate', async () => {
    const events = [];
    const original = deployPlan('a');
    const result = await runLeasedReconcile(leasedOptions(events, {
      buildPlan: async () => ({ projectId: 'project-1', environmentId: 'environment-1', plans: [original] }),
      refreshService: async () => ({
        ...original,
        action: 'skip',
        reason: 'ALREADY_TAKEN',
        observedDeploymentId: 'dep-native',
      }),
    }));
    assert.equal(events.includes('start'), false);
    assert.equal(events.includes('deploy:a'), false);
    assert.equal(result.result.outcome, 'NO_MUTATION');
    assert.equal(result.result.entries[0].outcome, 'ALREADY_ACTIVE');
    assert.equal(result.result.entries[0].observedDeploymentId, 'dep-native');
  });

  it('stops after an ambiguous provider call and binds the exact partial evidence', async () => {
    const events = [];
    const plans = [deployPlan('a'), deployPlan('b'), deployPlan('c')];
    const result = await runLeasedReconcile(leasedOptions(events, {
      buildPlan: async () => ({ projectId: 'project-1', environmentId: 'environment-1', plans }),
      deployService: async (plan) => {
        events.push(`deploy:${plan.service}`);
        if (plan.service === 'b') throw new Error('provider response lost');
        return `dep-${plan.service}`;
      },
    }));
    assert.equal(result.result.outcome, 'MUTATION_AMBIGUOUS');
    assert.deepEqual(result.result.entries.map((entry) => entry.outcome), ['TRIGGERED', 'AMBIGUOUS', 'SKIPPED']);
    assert.deepEqual(events.filter((event) => event.startsWith('deploy:')), ['deploy:a', 'deploy:b']);
    assert.ok(events.includes('bind:MUTATED'));
  });

  it('stops later calls when main moves without inventing a failed provider mutation', async () => {
    const events = [];
    const plans = [deployPlan('a'), deployPlan('b')];
    let authorizations = 0;
    const result = await runLeasedReconcile(leasedOptions(events, {
      buildPlan: async () => ({ projectId: 'project-1', environmentId: 'environment-1', plans }),
      authorizeCurrent: async () => {
        authorizations += 1;
        events.push('authorize');
        if (authorizations === 3) throw new ReconcileAuthorizationError('MAIN_MOVED', 'moved');
        return {
          gateContext: 'gate', gateState: 'success',
          gateObservedAt: '2026-08-07T20:00:00.000Z',
          mainObservedAt: '2026-08-07T20:00:00.000Z',
        };
      },
    }));
    assert.equal(result.result.outcome, 'MUTATION_COMPLETED');
    assert.deepEqual(result.result.entries.map((entry) => entry.outcome), ['TRIGGERED', 'SKIPPED']);
    assert.equal(result.result.entries[1].reason, 'MAIN_MOVED');
    assert.deepEqual(events.filter((event) => event.startsWith('deploy:')), ['deploy:a']);
  });

  it('waits boundedly for an exact recovery hold to become RUN_BOUND', async () => {
    const events = [];
    let attempts = 0;
    let clock = 0;
    const control = fakeControl(events, {
      acquire: async () => {
        attempts += 1;
        events.push(`acquire:${attempts}`);
        if (attempts === 1) {
          throw new ControlPlaneError('DISPATCH_HOLD_ACTIVE', 'not bound', { definitive: true });
        }
        return {
          data: {
            attempt: { attemptId: 'attempt-1' },
            leaseCapability: 'lease-capability-abcdefghijklmnopqrstuvwxyz',
            dispatchHold: {
              recoveryAttemptId: 'recovery-1',
              headSha: HEAD,
              state: 'LEASE_ACQUIRED',
              linkedAttemptId: 'attempt-1',
              failedHeadRetryAuthorized: false,
            },
          },
        };
      },
    });
    await runLeasedReconcile(leasedOptions(events, {
      control,
      recoveryAttemptId: 'recovery-1',
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      recoveryHoldWaitMs: 10_000,
      recoveryHoldPollMs: 1_000,
    }));
    assert.deepEqual(events.slice(0, 5), ['authorize', 'acquire:1', 'authorize', 'acquire:2', 'build']);
  });

  it('takes failed-head retry authority from the admitted hold, not the recovery ID', async () => {
    for (const failedHeadRetryAuthorized of [false, true]) {
      const events = [];
      let planningAuthority = null;
      const control = fakeControl(events, {
        acquire: async () => ({
          data: {
            attempt: { attemptId: 'attempt-1' },
            leaseCapability: 'lease-capability-abcdefghijklmnopqrstuvwxyz',
            dispatchHold: {
              recoveryAttemptId: 'recovery-1',
              headSha: HEAD,
              state: 'LEASE_ACQUIRED',
              linkedAttemptId: 'attempt-1',
              failedHeadRetryAuthorized,
            },
          },
        }),
      });
      await runLeasedReconcile(leasedOptions(events, {
        control,
        recoveryAttemptId: 'recovery-1',
        buildPlan: async ({ retryFailedHead }) => {
          planningAuthority = retryFailedHead;
          return { projectId: 'project-1', environmentId: 'environment-1', plans: [] };
        },
      }));
      assert.equal(planningAuthority, failedHeadRetryAuthorized);
    }
  });

  it('rejects failed-head retry authority from a mismatched admitted hold', async () => {
    const mismatches = [
      { recoveryAttemptId: 'different-recovery' },
      { headSha: 'f'.repeat(40) },
      { state: 'RUN_BOUND' },
      { linkedAttemptId: 'different-attempt' },
    ];
    for (const mismatch of mismatches) {
      const events = [];
      let planningAuthority = null;
      const control = fakeControl(events, {
        acquire: async () => ({
          data: {
            attempt: { attemptId: 'attempt-1' },
            leaseCapability: 'lease-capability-abcdefghijklmnopqrstuvwxyz',
            dispatchHold: {
              recoveryAttemptId: 'recovery-1',
              headSha: HEAD,
              state: 'LEASE_ACQUIRED',
              linkedAttemptId: 'attempt-1',
              failedHeadRetryAuthorized: true,
              ...mismatch,
            },
          },
        }),
      });
      await runLeasedReconcile(leasedOptions(events, {
        control,
        recoveryAttemptId: 'recovery-1',
        buildPlan: async ({ retryFailedHead }) => {
          planningAuthority = retryFailedHead;
          return { projectId: 'project-1', environmentId: 'environment-1', plans: [] };
        },
      }));
      assert.equal(planningAuthority, false);
    }
  });

  it('defers definitive lease contention without planning or provider access', async () => {
    const events = [];
    const control = fakeControl(events, {
      acquire: async () => {
        events.push('acquire');
        throw new ControlPlaneError('LEASE_HELD', 'held', { definitive: true });
      },
    });
    await assert.rejects(
      runLeasedReconcile(leasedOptions(events, { control })),
      (error) => error instanceof ReconcileDeferral && error.code === 'LEASE_HELD',
    );
    assert.deepEqual(events, ['authorize', 'acquire']);
  });

  it('maps only allowlisted plan fields into the immutable intent', () => {
    assert.deepEqual(createPlannedManifestEntries([
      { ...deployPlan('a'), detail: 'raw provider text must not persist' },
      { service: 'b', serviceId: 'svc-b', action: 'error', reason: 'raw error', observedDeploymentId: null },
    ]), [
      { service: 'a', serviceId: 'svc-a', action: 'DEPLOY', reason: 'CLOSURE_CHANGED' },
      { service: 'b', serviceId: 'svc-b', action: 'SKIP', reason: 'HISTORY_UNAVAILABLE' },
    ]);
  });
});
