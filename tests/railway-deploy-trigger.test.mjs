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
import {
  HANDLED_BY_RAILWAY,
  buildDeployArgs,
  planServiceDeploy,
  readDeploymentId,
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

function deployment(status, commitHash, { createdAt = '2026-08-04T09:00:00.000Z', skippedReason } = {}) {
  return { status, createdAt, meta: { commitHash, ...(skippedReason ? { skippedReason } : {}) } };
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
    const result = plan({ deployments: [deployment('SUCCESS', HEAD, { createdAt: '2026-08-04T12:00:00.000Z' }), deployment('SUCCESS', RUNNING)] });
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, HANDLED_BY_RAILWAY);
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
