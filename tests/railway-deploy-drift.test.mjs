// #6141 — the alarm for "a merge never reached production".
//
// Every fixture below is the shape of a real record pulled from
// `railway deployment list --json` on 2026-08-04. The three that matter:
//
//   SKIPPED  + meta.commitHash   a push Railway refused to build
//   REMOVED  + meta.commitHash   a cron tick, carrying the SHA of the image it ran
//   SUCCESS  + no commitHash     a `railway up` upload, which has no commit at all
//
// The last one is why "newest built deployment" cannot be assumed to identify a
// commit, and the first is why "the service has deployments" cannot be assumed
// to mean it received the merge.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  DEEP_PASS_MAX_CANDIDATES,
  DEEP_PASS_RUN_BUDGET_MS,
  UNDETERMINABLE_VERDICTS,
  classifyServiceDeploy,
  classifyFleetWithinDeadline,
  deepenNoBuildWindows,
  formatComparisonHead,
  resolveDeepPassDeadlineAt,
  isProblemVerdict,
  readRepeatedArguments,
  resolveComparisonHead,
  resolveOriginMainRelation,
  summarizeDeployDrift,
  summarizeStrictDeployDrift,
} from '../scripts/check-railway-deploy-drift.mjs';
import { resolveServiceClosure } from '../scripts/railway-deploy-closure.mjs';

const HEAD = '1d9dcd0ef0d282961e6af75bbe469478ef57c22f';
const PREVIOUS = 'f1a85003e99cd762e67ad561f5155b53a359e4e6';
const NEWER = '4e89f7ea400000000000000000000000000000aa';

function deployment(status, { at, sha, ...meta } = {}) {
  return {
    id: `dep-${status}-${at}`,
    status,
    createdAt: at,
    meta: { ...(sha === undefined ? {} : { commitHash: sha }), ...meta },
  };
}

// By default graceSha is head, which is the strict reading: every commit has
// been available long enough. A case that wants the grace to matter passes an
// explicit graceSha plus the ancestry it implies.
//
// changedPathsSince defaults to "a file this service watches changed", because
// that is the situation every fixture here models: a service that is genuinely
// missing work meant for it. The cases where nothing reaching the service
// changed — the normal steady state under a watch-path filter — get their own
// suite below, and a case that wants the checkout to be unable to answer passes
// `changedPathsSince: () => null` explicitly.
function classify(deployments, overrides = {}) {
  return classifyServiceDeploy({
    service: 'seed-example',
    deployments,
    headSha: HEAD,
    changedPathsSince: () => ['scripts/seed-example.mjs'],
    ...overrides,
  });
}

describe('the healthy set is closed, so an unrecognised verdict reports', () => {
  // The problem set is derived from the healthy verdicts by negation rather
  // than enumerated. That is the only reason a verdict added in future is a
  // problem until someone decides otherwise — and it is exactly the kind of
  // decision that flips silently: switch to an explicit problem list and every
  // new verdict starts life as "healthy", which is a green report over a stale
  // fleet with nothing to notice it.
  it('treats any verdict outside the healthy set as a problem', () => {
    for (const healthy of ['CURRENT', 'CURRENT_FOR_CLOSURE', 'AHEAD', 'PENDING_BUILD']) {
      assert.equal(isProblemVerdict(healthy), false, healthy);
    }
    for (const unknown of ['A_VERDICT_ADDED_IN_2027', 'CURRENT_ISH', '', undefined, null]) {
      assert.equal(isProblemVerdict(unknown), true, String(unknown));
    }
  });

  it('reports every verdict this file can actually return', () => {
    // Belt and braces on the same property: no verdict the classifier emits may
    // fall outside {healthy} ∪ {problem}, and every undeterminable one must
    // land in the problem half.
    for (const verdict of UNDETERMINABLE_VERDICTS) {
      assert.equal(isProblemVerdict(verdict), true, verdict);
    }
  });
});

describe('Railway deploy drift classification', () => {
  it('reports a service running the head commit as current', () => {
    const result = classify([
      deployment('SUCCESS', { at: '2026-08-04T05:06:46Z', sha: HEAD }),
      deployment('REMOVED', { at: '2026-08-04T04:59:00Z', sha: PREVIOUS }),
    ]);
    assert.equal(result.verdict, 'CURRENT');
    assert.equal(result.runningSha, HEAD);
    assert.equal(isProblemVerdict(result.verdict), false);
  });

  // The failure the whole check exists for: Railway created a record for the
  // merge and refused to build it, so the container keeps running the previous
  // image while every repository gate is green.
  it('reports a push Railway refused with nothing built since', () => {
    const result = classify([
      deployment('SKIPPED', { at: '2026-08-04T05:06:28Z', sha: HEAD }),
      deployment('SKIPPED', { at: '2026-08-04T04:59:16Z', sha: 'b7f2054df000000000000000000000000000000a' }),
      deployment('REMOVED', { at: '2026-08-04T04:55:21Z', sha: PREVIOUS }),
    ]);
    assert.equal(result.verdict, 'REJECTED_PUSH');
    assert.equal(result.runningSha, PREVIOUS);
    assert.deepEqual(result.rejectedShas, [
      HEAD,
      'b7f2054df000000000000000000000000000000a',
    ]);
    assert.equal(isProblemVerdict(result.verdict), true);
  });

  // An unfiltered service still shows SKIPPED records — Railway coalesces
  // bursts of pushes — but a later build supersedes them. Those must not alarm,
  // or the check reds permanently on a fleet that is behaving correctly.
  it('ignores rejections a later build superseded', () => {
    const result = classify([
      deployment('SUCCESS', { at: '2026-08-04T05:06:46Z', sha: HEAD }),
      deployment('SKIPPED', { at: '2026-08-04T04:59:26Z', sha: 'b7f2054df000000000000000000000000000000a' }),
      deployment('REMOVED', { at: '2026-08-03T19:16:17Z', sha: PREVIOUS }),
    ]);
    assert.equal(result.verdict, 'CURRENT');
    assert.deepEqual(result.rejectedShas, []);
  });

  // Railway returns newest-first, but nothing documents that. Taking the first
  // running record in array order instead of the newest one picks whichever
  // deployment happens to lead the response — here an older tick, which reads
  // as BEHIND on a service that is perfectly current.
  it('does not trust the order Railway returns records in', () => {
    const outOfOrder = classify([
      deployment('REMOVED', { at: '2026-08-04T04:00:00Z', sha: PREVIOUS }),
      deployment('SUCCESS', { at: '2026-08-04T05:06:46Z', sha: HEAD }),
    ]);
    assert.equal(outOfOrder.verdict, 'CURRENT');
    assert.equal(outOfOrder.runningSha, HEAD);

    const rejectionLast = classify([
      deployment('REMOVED', { at: '2026-08-04T04:55:21Z', sha: PREVIOUS }),
      deployment('SKIPPED', { at: '2026-08-04T05:06:28Z', sha: HEAD }),
    ]);
    assert.equal(rejectionLast.verdict, 'REJECTED_PUSH');
    assert.equal(rejectionLast.runningSha, PREVIOUS);
  });

  // A `railway up` upload has no commit at all, so the newest build proves an
  // image is running but proves nothing about which source it came from. That
  // is a gap in the evidence, not a clean bill of health.
  it('refuses to vouch for a build with no commit SHA', () => {
    const result = classify([
      deployment('SUCCESS', { at: '2026-08-04T05:10:37Z', cliCaller: 'claude_code' }),
      deployment('REMOVED', { at: '2026-08-04T05:10:28Z', sha: PREVIOUS }),
    ]);
    assert.equal(result.verdict, 'UNKNOWN_SOURCE');
    assert.equal(result.runningSha, null);
    assert.equal(isProblemVerdict(result.verdict), true);
  });

  // The sibling failure in #6064: no rejection was recorded because Railway
  // never received the push at all. The check must catch it without knowing why.
  it('reports a service behind head with no rejection recorded', () => {
    const result = classify([
      deployment('REMOVED', { at: '2026-08-03T07:27:24Z', sha: PREVIOUS }),
    ]);
    assert.equal(result.verdict, 'BEHIND');
    assert.equal(result.runningSha, PREVIOUS);
    assert.equal(isProblemVerdict(result.verdict), true);
  });

  // Observed on the first live run against production: two services had already
  // built a commit the checkout did not contain, because main moved between
  // reading head and querying Railway. Calling those BEHIND would red the
  // monitor every time a merge lands mid-run.
  it('accepts a service running a descendant of head', () => {
    const deployments = [deployment('SUCCESS', { at: '2026-08-04T05:44:55Z', sha: NEWER })];
    const ahead = classify(deployments, {
      isAncestor: (ancestor, descendant) => ancestor === HEAD && descendant === NEWER,
    });
    assert.equal(ahead.verdict, 'AHEAD');
    assert.equal(isProblemVerdict(ahead.verdict), false);

    // A caller that cannot answer the ancestry question — a shallow checkout
    // that never fetched the newer commit — must keep the service reported.
    const undecidable = classify(deployments);
    assert.equal(undecidable.verdict, 'BEHIND');
  });

  it('reports AHEAD before a stale comparison-head build failure', () => {
    const result = classify([
      deployment('SUCCESS', { at: '2026-08-04T05:09:00Z', sha: NEWER }),
      deployment('FAILED', { at: '2026-08-04T05:08:00Z', sha: HEAD }),
      deployment('SUCCESS', { at: '2026-08-04T05:00:00Z', sha: PREVIOUS }),
    ], {
      isAncestor: (ancestor, descendant) => ancestor === HEAD && descendant === NEWER,
    });
    assert.equal(result.verdict, 'AHEAD');
    assert.equal(result.runningSha, NEWER);
  });

  // Ancestry must not excuse a rejection: the service can be running a
  // descendant of the head we read and still have had a later push refused.
  it('reports a rejected push even when the running build is ahead of head', () => {
    const refused = 'aaaaaaaaa00000000000000000000000000000aa';
    const result = classify([
      deployment('SKIPPED', { at: '2026-08-04T05:50:00Z', sha: refused }),
      deployment('SUCCESS', { at: '2026-08-04T05:44:55Z', sha: NEWER }),
    ], {
      // The running build descends from head, but it predates the refused push
      // and therefore cannot contain it.
      isAncestor: (ancestor, descendant) => ancestor === HEAD && descendant === NEWER,
    });
    assert.equal(result.verdict, 'REJECTED_PUSH');
    assert.deepEqual(result.rejectedShas, [refused]);
  });

  // The grace is spent on a commit, not on a service. A service running the
  // newest commit older than the grace is building; a service running something
  // that predates it has missed merges that have been available for longer than
  // any build takes.
  it('excuses only the commits newer than the grace, never a stale service', () => {
    const graceSha = 'ggggggggg00000000000000000000000000000aa';
    const isAncestor = (ancestor, descendant) => ancestor === graceSha && descendant === graceSha;

    const building = classify(
      [deployment('REMOVED', { at: '2026-08-04T05:50:00Z', sha: graceSha })],
      { graceSha, isAncestor },
    );
    assert.equal(building.verdict, 'PENDING_BUILD');
    assert.equal(isProblemVerdict(building.verdict), false);

    // umami's shape: running a commit from a day ago while head is minutes old.
    // Keying the grace off head's age would have excused this on any run that
    // followed a merge.
    const stale = classify(
      [deployment('REMOVED', { at: '2026-08-03T07:27:24Z', sha: PREVIOUS })],
      { graceSha, isAncestor },
    );
    assert.equal(stale.verdict, 'BEHIND');
    assert.match(stale.detail, /predates ggggggggg/);
  });

  // `now` is pinned: this fixture asserts an age relative to the build grace,
  // and a live Date.now() would make the same records read PENDING_BUILD today
  // and BUILD_STALLED tomorrow.
  it('accepts a build in flight for head even when the service lags the grace commit', () => {
    const result = classify([
      deployment('BUILDING', { at: '2026-08-04T05:59:00Z', sha: HEAD }),
      deployment('REMOVED', { at: '2026-08-04T05:00:00Z', sha: PREVIOUS }),
    ], { now: Date.parse('2026-08-04T06:00:00Z') });
    assert.equal(result.verdict, 'PENDING_BUILD');
  });

  // A failed build for head must never read as "head is deployed". The newest
  // record carries the head SHA, so a naive newest-SHA comparison calls this
  // current while the container runs the previous image.
  it('reports a failed build for head instead of calling it current', () => {
    const result = classify([
      deployment('FAILED', { at: '2026-08-04T05:07:00Z', sha: HEAD }),
      deployment('REMOVED', { at: '2026-08-04T05:00:00Z', sha: PREVIOUS }),
    ]);
    assert.equal(result.verdict, 'BUILD_FAILED');
    assert.equal(result.runningSha, PREVIOUS);
    assert.equal(isProblemVerdict(result.verdict), true);
  });

  // A crashed run did build and did deploy; the seeder's own health checks own
  // that failure. This check is only about which source is live.
  it('treats a crashed run as deployed source', () => {
    const result = classify([
      deployment('CRASHED', { at: '2026-08-04T05:07:00Z', sha: HEAD }),
    ]);
    assert.equal(result.verdict, 'CURRENT');
  });

  // A cron tick is a REDEPLOY of the same image, so it proves nothing about the
  // source. Superseding rejections by deployment TIMESTAMP let the 05:10 tick
  // bury the 05:06 rejection: the verdict decayed from REJECTED_PUSH to BEHIND,
  // the rejection evidence vanished and the report lost the more specific
  // refusal diagnosis.
  it('does not let a cron tick of the same image bury a rejection', () => {
    const result = classify([
      deployment('REMOVED', { at: '2026-08-04T05:10:28Z', sha: PREVIOUS }),
      deployment('SKIPPED', { at: '2026-08-04T05:06:28Z', sha: HEAD }),
      deployment('REMOVED', { at: '2026-08-04T04:55:21Z', sha: PREVIOUS }),
    ]);
    assert.equal(result.verdict, 'REJECTED_PUSH');
    assert.deepEqual(result.rejectedShas, [HEAD]);
  });

  // The other side of the same rule: a real build DID change the source, so the
  // rejection it superseded must stop being reported.
  it('drops a rejection once a later build changed the source', () => {
    const result = classify([
      deployment('SUCCESS', { at: '2026-08-04T05:30:00Z', sha: HEAD }),
      deployment('SKIPPED', { at: '2026-08-04T05:06:28Z', sha: 'ccc1111100000000000000000000000000000011' }),
      deployment('REMOVED', { at: '2026-08-04T04:55:00Z', sha: PREVIOUS }),
    ]);
    assert.equal(result.verdict, 'CURRENT');
    assert.deepEqual(result.rejectedShas, []);
  });

  // A build that started and never finished is not "under way" forever. Without
  // an age bound this reported PENDING_BUILD — a HEALTHY verdict — for as long
  // as head did not move, which is green-while-stale.
  it('stops calling a wedged build pending once it outlives the grace', () => {
    const wedged = [
      deployment('BUILDING', { at: '2026-08-01T05:00:00Z', sha: HEAD }),
      deployment('REMOVED', { at: '2026-08-01T04:00:00Z', sha: PREVIOUS }),
    ];
    const stalled = classify(wedged, { now: Date.parse('2026-08-04T06:00:00Z') });
    assert.equal(stalled.verdict, 'BUILD_STALLED');
    assert.equal(isProblemVerdict(stalled.verdict), true);

    const fresh = classify(
      [deployment('BUILDING', { at: '2026-08-04T05:55:00Z', sha: HEAD }),
        deployment('REMOVED', { at: '2026-08-04T05:00:00Z', sha: PREVIOUS })],
      { now: Date.parse('2026-08-04T06:00:00Z') },
    );
    assert.equal(fresh.verdict, 'PENDING_BUILD');
  });

  // #6142's recovery path: the trigger is fixed, the build finally fires, and
  // it breaks. Naming the rejection there would blame a cause already resolved.
  it('prefers a failed build over a rejection that predates it', () => {
    const result = classify([
      deployment('FAILED', { at: '2026-08-04T05:30:00Z', sha: HEAD }),
      deployment('SKIPPED', { at: '2026-08-04T05:06:00Z', sha: HEAD }),
      deployment('REMOVED', { at: '2026-08-04T04:55:00Z', sha: PREVIOUS }),
    ]);
    assert.equal(result.verdict, 'BUILD_FAILED');
  });

  it('reports a window whose only running record never built anything', () => {
    const result = classify([
      deployment('FAILED', { at: '2026-08-04T05:30:00Z', sha: PREVIOUS }),
    ]);
    assert.equal(result.verdict, 'NO_BUILD_IN_WINDOW');
    assert.equal(isProblemVerdict(result.verdict), true);
  });

  // An unparseable timestamp sorts as oldest, which would silently demote a
  // record out of the running/rejection split rather than fail.
  it('does not let an unreadable timestamp reorder the split', () => {
    const malformed = { id: 'x', status: 'REMOVED', createdAt: 'not-a-date', meta: { commitHash: HEAD } };
    const result = classify([
      malformed,
      deployment('REMOVED', { at: '2026-08-04T05:00:00Z', sha: PREVIOUS }),
    ]);
    // The dated record wins as newest; the malformed one cannot claim it.
    assert.equal(result.runningSha, PREVIOUS);
    assert.equal(result.verdict, 'BEHIND');
  });

  it('reports an empty window rather than assuming health', () => {
    const result = classify([]);
    assert.equal(result.verdict, 'NO_DEPLOYMENTS');
    assert.equal(isProblemVerdict(result.verdict), true);
  });

  it('reports a window that holds only rejections as an unidentified source', () => {
    // No running record anywhere in the window: the check knows a push was
    // refused but not what the container is serving. That is an undeterminable
    // answer wearing a determinate-looking name, so it gets its own verdict —
    // as plain REJECTED_PUSH it looked more determinate than the evidence
    // supported (#6483 review).
    const result = classify([
      deployment('SKIPPED', { at: '2026-08-04T05:06:28Z', sha: HEAD }),
    ]);
    assert.equal(result.verdict, 'REJECTED_PUSH_UNKNOWN_SOURCE');
    assert.equal(result.runningSha, null);
    assert.equal(isProblemVerdict(result.verdict), true);
  });

  // Railway can add a status at any time. An unmatched status must not fall
  // through to the healthy branch, which is how a marker-based scanner ends up
  // vouching for deployments it never classified.
  it('reports a status it cannot classify rather than skipping the record', () => {
    const result = classify([
      deployment('NEEDS_APPROVAL', { at: '2026-08-04T05:07:00Z', sha: HEAD }),
      deployment('REMOVED', { at: '2026-08-04T05:00:00Z', sha: PREVIOUS }),
    ]);
    assert.equal(result.verdict, 'UNKNOWN_STATUS');
    assert.deepEqual(result.unknownStatuses, ['NEEDS_APPROVAL']);
    assert.equal(isProblemVerdict(result.verdict), true);

    // Older than the running build, so it cannot change which source is live.
    const superseded = classify([
      deployment('SUCCESS', { at: '2026-08-04T05:07:00Z', sha: HEAD }),
      deployment('NEEDS_APPROVAL', { at: '2026-08-04T05:00:00Z', sha: PREVIOUS }),
    ]);
    assert.equal(superseded.verdict, 'CURRENT');
  });

  it('reports a service whose deployment history could not be read', () => {
    const result = classifyServiceDeploy({
      service: 'seed-example',
      deployments: null,
      error: 'railway deployment list failed (1): service not found',
      headSha: HEAD,
    });
    assert.equal(result.verdict, 'QUERY_FAILED');
    assert.equal(isProblemVerdict(result.verdict), true);
  });
});

// #6142 — what a watch-path filter makes normal.
//
// Before this, "not running head" was the whole definition of drift, so the 62
// services that carry a filter reported REJECTED_PUSH on every merge that was
// none of their business. That is how the removed suppression baseline came to
// acknowledge most of the fleet. Re-measured, 7,331 of 7,391 path-reason skips
// across 600 commits were the filter working correctly.
describe('Railway deploy drift against the service closure', () => {
  const SCRIPTS_SEEDER = resolveServiceClosure({
    liveService: {
      source: { rootDirectory: 'scripts' },
      build: { watchPatterns: ['scripts/**', 'shared/**'] },
    },
  });

  function classifyWithClosure(deployments, { changedPaths, ...overrides } = {}) {
    return classify(deployments, {
      closure: SCRIPTS_SEEDER,
      changedPathsSince: () => changedPaths,
      // Default to "this refusal was for a commit that reaches the service",
      // so a case that does not care about per-refusal judgement keeps the
      // refusal — the reporting direction.
      changedPathsIn: () => ['scripts/seed-example.mjs'],
      ...overrides,
    });
  }

  it('accepts a service running everything that reaches it, head or not', () => {
    const result = classifyWithClosure(
      [deployment('REMOVED', { at: '2026-08-03T07:27:24Z', sha: PREVIOUS })],
      { changedPaths: ['src/App.ts', 'docs/a.md'] },
    );
    assert.equal(result.verdict, 'CURRENT_FOR_CLOSURE');
    assert.equal(isProblemVerdict(result.verdict), false);
    assert.equal(result.runningSha, PREVIOUS);
  });

  it('still reports a service missing a change that does reach it', () => {
    const result = classifyWithClosure(
      [deployment('REMOVED', { at: '2026-08-03T07:27:24Z', sha: PREVIOUS })],
      { changedPaths: ['src/App.ts', 'scripts/seed-example.mjs'] },
    );
    assert.equal(result.verdict, 'BEHIND');
    assert.equal(isProblemVerdict(result.verdict), true);
    assert.match(result.detail, /missing 1 path/);
  });

  it('applies the build context, so a repository-root shared/ change excuses a scripts-rooted service', () => {
    // The 57 apparent refusals that turned out to be correct: a
    // rootDirectory: scripts container cannot see repository-root shared/, so
    // the shared/** pattern such services carry is unreachable by construction.
    const result = classifyWithClosure(
      [deployment('REMOVED', { at: '2026-08-03T07:27:24Z', sha: PREVIOUS })],
      { changedPaths: ['shared/china-decision-signals.ts'] },
    );
    assert.equal(result.verdict, 'CURRENT_FOR_CLOSURE');
  });

  it('stops reporting a refusal of a push that could not have reached the service', () => {
    // The old 62-entry false-positive cohort in one assertion: a SKIPPED record
    // for a commit this container cannot be affected by is the filter working.
    const result = classifyWithClosure([
      deployment('SKIPPED', { at: '2026-08-04T05:06:00Z', sha: HEAD }),
      deployment('REMOVED', { at: '2026-08-03T07:27:24Z', sha: PREVIOUS }),
    ], { changedPaths: ['src/App.ts'] });
    assert.equal(result.verdict, 'CURRENT_FOR_CLOSURE');
    assert.deepEqual(result.rejectedShas, []);
  });

  it('keeps reporting a refusal of a push that did reach the service', () => {
    const result = classifyWithClosure([
      deployment('SKIPPED', { at: '2026-08-04T05:06:00Z', sha: HEAD, skippedReason: 'CI check suite failed' }),
      deployment('REMOVED', { at: '2026-08-03T07:27:24Z', sha: PREVIOUS }),
    ], { changedPaths: ['scripts/seed-example.mjs'] });
    assert.equal(result.verdict, 'REJECTED_PUSH');
    assert.deepEqual(result.rejectedShas, [HEAD]);
  });

  it('names the reason Railway refused, so the two causes stay distinguishable', () => {
    // A path refusal and a check-suite deferral are different failures with
    // different owners; collapsing them to "refused" is what hid the second one
    // for the whole life of #6141.
    const result = classifyWithClosure([
      deployment('SKIPPED', { at: '2026-08-04T05:06:00Z', sha: HEAD, skippedReason: 'CI check suite failed' }),
      deployment('REMOVED', { at: '2026-08-03T07:27:24Z', sha: PREVIOUS }),
    ], { changedPaths: ['scripts/seed-example.mjs'] });
    assert.match(result.detail, /CI check suite failed/);
  });

  it('does not blame a refusal when every recorded refusal was a correct path skip', () => {
    // The service IS behind, but not because Railway refused anything that
    // mattered: the refusals it recorded were for commits it cannot see, and
    // the commit that does reach it was never recorded at all. That is #6064's
    // failure, and calling it REJECTED_PUSH routes it to the wrong owner.
    const unrelated = 'dddddddd000000000000000000000000000000aa';
    const result = classifyWithClosure([
      deployment('SKIPPED', { at: '2026-08-04T05:06:00Z', sha: unrelated, skippedReason: 'No changes to watched files' }),
      deployment('REMOVED', { at: '2026-08-03T07:27:24Z', sha: PREVIOUS }),
    ], {
      changedPaths: ['scripts/seed-example.mjs'],
      changedPathsIn: () => ['src/App.ts'],
    });
    assert.equal(result.verdict, 'BEHIND');
    assert.deepEqual(result.rejectedShas, []);
  });

  it('still blames the refusal when that commit did reach the service', () => {
    const result = classifyWithClosure([
      deployment('SKIPPED', { at: '2026-08-04T05:06:00Z', sha: HEAD, skippedReason: 'No changes to watched files' }),
      deployment('REMOVED', { at: '2026-08-03T07:27:24Z', sha: PREVIOUS }),
    ], {
      changedPaths: ['scripts/seed-example.mjs'],
      changedPathsIn: () => ['scripts/seed-example.mjs'],
    });
    assert.equal(result.verdict, 'REJECTED_PUSH');
    assert.deepEqual(result.rejectedShas, [HEAD]);
  });

  it('keeps a refusal it cannot judge rather than excusing it', () => {
    const result = classifyWithClosure([
      deployment('SKIPPED', { at: '2026-08-04T05:06:00Z', sha: HEAD, skippedReason: 'No changes to watched files' }),
      deployment('REMOVED', { at: '2026-08-03T07:27:24Z', sha: PREVIOUS }),
    ], {
      changedPaths: ['scripts/seed-example.mjs'],
      changedPathsIn: () => null,
    });
    assert.equal(result.verdict, 'REJECTED_PUSH');
  });

  it('reports rather than excuses a service whose running commit the checkout cannot reach', () => {
    // "We could not compute the delta" is not "nothing changed", and the
    // service furthest behind is exactly the one a shallow fetch cannot reach.
    const result = classifyWithClosure(
      [deployment('REMOVED', { at: '2026-08-03T07:27:24Z', sha: PREVIOUS })],
      { changedPaths: null },
    );
    assert.equal(result.verdict, 'CLOSURE_UNKNOWN');
    assert.equal(isProblemVerdict(result.verdict), true);
  });

  it('does not excuse a service that watches everything', () => {
    // The bootstrap publisher declares an empty filter deliberately; for an
    // unfiltered service every merge is closure-relevant.
    const everything = resolveServiceClosure({ liveService: { source: {}, build: { watchPatterns: [] } } });
    const result = classify(
      [deployment('REMOVED', { at: '2026-08-03T07:27:24Z', sha: PREVIOUS })],
      { closure: everything, changedPathsSince: () => ['src/App.ts'] },
    );
    assert.equal(result.verdict, 'BEHIND');
  });

  it('never lets the closure excuse a failed build for head', () => {
    // Railway ran it and it broke. That is a real failure with its own owner,
    // and it must outrank "nothing reaching this service changed".
    const result = classifyWithClosure([
      deployment('FAILED', { at: '2026-08-04T05:07:00Z', sha: HEAD }),
      deployment('REMOVED', { at: '2026-08-04T05:00:00Z', sha: PREVIOUS }),
    ], { changedPaths: ['src/App.ts'] });
    assert.equal(result.verdict, 'BUILD_FAILED');
  });

  it('never lets the closure excuse a service with no identifiable source', () => {
    const result = classifyWithClosure(
      [deployment('SUCCESS', { at: '2026-08-04T05:00:00Z' })],
      { changedPaths: ['src/App.ts'] },
    );
    assert.equal(result.verdict, 'UNKNOWN_SOURCE');
  });
});

describe('Railway deploy drift summary', () => {
  const results = [
    { service: 'a', verdict: 'CURRENT' },
    { service: 'b', verdict: 'PENDING_BUILD' },
    { service: 'c', verdict: 'REJECTED_PUSH' },
    { service: 'd', verdict: 'BEHIND' },
  ];

  it('counts every verdict and makes every problem directly blocking', () => {
    const summary = summarizeDeployDrift(results);
    assert.deepEqual(summary.counts, {
      CURRENT: 1,
      PENDING_BUILD: 1,
      REJECTED_PUSH: 1,
      BEHIND: 1,
    });
    assert.deepEqual(summary.blocking.map((entry) => entry.service), ['c', 'd']);
    assert.equal(Object.hasOwn(summary, 'problems'), false);
    assert.equal(Object.hasOwn(summary, 'acknowledged'), false);
    assert.equal(summary.ok, false);
  });

  // An empty fleet means the service query returned nothing, not that every
  // service is healthy.
  it('does not report an empty fleet as healthy', () => {
    const summary = summarizeDeployDrift([]);
    assert.equal(summary.ok, false);
    assert.match(summary.detail, /no services/i);
  });

  it('is ok only when every service is current or building', () => {
    const summary = summarizeDeployDrift(results.slice(0, 2));
    assert.equal(summary.ok, true);
    assert.deepEqual(summary.blocking, []);
  });

  it('ships no acceptance file or summary field that can suppress deploy drift', () => {
    assert.equal(
      existsSync(new URL('../scripts/railway-deploy-drift-baseline.json', import.meta.url)),
      false,
    );
    const summary = summarizeDeployDrift([
      { service: 'known-old-failure', verdict: 'BUILD_FAILED', detail: 'still failed' },
    ]);
    assert.equal(summary.ok, false);
    assert.deepEqual(summary.blocking.map((entry) => entry.service), ['known-old-failure']);
    for (const field of ['acknowledged', 'cleared', 'escalated', 'missing', 'expired', 'expiresAt']) {
      assert.equal(Object.hasOwn(summary, field), false, `${field} must not survive baseline removal`);
    }
  });
});

describe('strict terminal reconciliation drift', () => {
  const result = (service, verdict) => ({ service, verdict, detail: verdict });

  it('accepts only positive terminal current states with complete fleet coverage', () => {
    const summary = summarizeStrictDeployDrift([
      result('a', 'CURRENT'),
      result('b', 'CURRENT_FOR_CLOSURE'),
      { ...result('c', 'AHEAD'), runningSha: NEWER },
    ], ['a', 'b', 'c'], {
      isOnAuthorizedMainLineage: (sha) => sha === NEWER,
    });
    assert.equal(summary.ok, true);
    assert.deepEqual(summary.missing, []);
    assert.deepEqual(summary.blocking, []);
  });

  it('rejects an AHEAD descendant unless the summary proves it is on authorized main', () => {
    const arbitraryDescendant = { ...result('a', 'AHEAD'), runningSha: NEWER };
    const unproven = summarizeStrictDeployDrift([arbitraryDescendant], ['a']);
    assert.equal(unproven.ok, false);
    assert.equal(unproven.blocking[0].verdict, 'AHEAD_LINEAGE_UNPROVEN');

    const offMain = summarizeStrictDeployDrift([arbitraryDescendant], ['a'], {
      isOnAuthorizedMainLineage: () => false,
    });
    assert.equal(offMain.ok, false);
    assert.equal(offMain.blocking[0].verdict, 'AHEAD_LINEAGE_UNPROVEN');

    const ordinaryUnproven = summarizeDeployDrift([arbitraryDescendant]);
    assert.equal(ordinaryUnproven.ok, false);
    assert.equal(ordinaryUnproven.blocking[0].verdict, 'AHEAD_LINEAGE_UNPROVEN');

    const ordinaryProven = summarizeDeployDrift([arbitraryDescendant], {
      isOnAuthorizedMainLineage: (sha) => sha === NEWER,
    });
    assert.equal(ordinaryProven.ok, true);
    assert.deepEqual(ordinaryProven.blocking, []);
  });

  it('rejects pending builds, directly blocking problems, duplicates, and omitted services', () => {
    const pending = summarizeStrictDeployDrift([result('a', 'PENDING_BUILD')], ['a']);
    assert.equal(pending.ok, false);
    assert.equal(pending.blocking[0].verdict, 'PENDING_BUILD');

    const omitted = summarizeStrictDeployDrift([result('a', 'CURRENT')], ['a', 'b']);
    assert.equal(omitted.ok, false);
    assert.deepEqual(omitted.missing, ['b']);

    const duplicate = summarizeStrictDeployDrift([
      result('a', 'CURRENT'),
      result('a', 'CURRENT'),
    ], ['a']);
    assert.equal(duplicate.ok, false);
    assert.deepEqual(duplicate.duplicates, ['a']);

    const failedBuild = summarizeStrictDeployDrift([
      result('a', 'BUILD_FAILED'),
    ], ['a']);
    assert.equal(failedBuild.ok, false);
    assert.equal(failedBuild.blocking[0].verdict, 'BUILD_FAILED');
  });

  it('compares live results with the immutable expected fleet', () => {
    const summary = summarizeStrictDeployDrift([
      result('a', 'CURRENT'),
      result('new-live-service', 'CURRENT'),
    ], ['a', 'missing-planned-service']);
    assert.equal(summary.ok, false);
    assert.deepEqual(summary.missing, ['missing-planned-service']);
    assert.deepEqual(summary.unexpected, ['new-live-service']);
  });

  it('parses every repeated immutable expected-service argument', () => {
    assert.deepEqual(readRepeatedArguments([
      'node', 'script', '--expected-service', 'seed-a', '--expected-service=seed-b',
    ], '--expected-service'), ['seed-a', 'seed-b']);
    assert.throws(
      () => readRepeatedArguments(['node', 'script', '--expected-service', '--json'], '--expected-service'),
      /requires a value/,
    );
  });

  it('refreshes origin/main before a manual comparison and reports an exact relation', () => {
    const calls = [];
    let refreshed = false;
    const git = (args) => {
      calls.push(args);
      if (args[0] === 'fetch') {
        refreshed = true;
        return '';
      }
      assert.equal(args.at(-1), 'origin/main^{commit}');
      return refreshed ? HEAD : PREVIOUS;
    };
    const result = resolveComparisonHead(['node', 'script'], { git });
    assert.deepEqual(result, {
      headSha: HEAD,
      headSource: 'origin/main',
      originMainSha: HEAD,
      originMainRelation: 'exact',
    });
    assert.equal(formatComparisonHead(result), 'source=origin/main vs-origin-main=exact');
    assert.deepEqual(calls, [
      [
        'fetch',
        '--quiet',
        'origin',
        '+refs/heads/main:refs/remotes/origin/main',
      ],
      ['rev-parse', '--verify', '--end-of-options', 'origin/main^{commit}'],
    ]);
  });

  it('reports an explicit stale head as behind origin/main', () => {
    const result = resolveComparisonHead(['node', 'script', '--head', PREVIOUS], {
      git: (args) => {
        if (args.at(-1) === 'origin/main^{commit}') return HEAD;
        if (args.at(-1) === `${PREVIOUS}^{commit}`) return PREVIOUS;
        throw new Error(`unexpected git call: ${args.join(' ')}`);
      },
      ancestry: (ancestor, descendant) => (
        ancestor === PREVIOUS && descendant === HEAD ? 'yes' : 'no'
      ),
    });
    assert.equal(result.headSha, PREVIOUS);
    assert.equal(result.headSource, '--head');
    assert.equal(result.originMainRelation, 'behind');
    assert.equal(formatComparisonHead(result), 'source=--head vs-origin-main=behind');
  });

  it('fails a manual comparison when main cannot be refreshed', () => {
    const calls = [];
    assert.throws(
      () => resolveComparisonHead(['node', 'script'], {
        git: (args) => {
          calls.push(args);
          throw new Error('fetch failed');
        },
      }),
      /fetch failed/,
    );
    assert.deepEqual(calls, [[
      'fetch',
      '--quiet',
      'origin',
      '+refs/heads/main:refs/remotes/origin/main',
    ]]);
  });

  it('treats an explicit comparison ref as data, never as a git option', () => {
    const calls = [];
    resolveComparisonHead(['node', 'script', '--head=--upload-pack=evil'], {
      git: (args) => {
        calls.push(args);
        return HEAD;
      },
    });
    assert.deepEqual(calls.at(-1), [
      'rev-parse',
      '--verify',
      '--end-of-options',
      '--upload-pack=evil^{commit}',
    ]);
  });

  it('keeps an explicit head usable when origin/main is unavailable', () => {
    const result = resolveComparisonHead(['node', 'script', '--head', HEAD], {
      git: (args) => {
        if (args.at(-1) === 'origin/main^{commit}') throw new Error('missing ref');
        if (args.at(-1) === `${HEAD}^{commit}`) return HEAD;
        throw new Error(`unexpected git call: ${args.join(' ')}`);
      },
    });
    assert.deepEqual(result, {
      headSha: HEAD,
      headSource: '--head',
      originMainSha: null,
      originMainRelation: 'unavailable',
    });
  });

  it('distinguishes ahead, diverged, and unresolved head relationships', () => {
    const lookup = (answers) => (
      ancestor,
      descendant,
    ) => answers[`${ancestor}..${descendant}`] ?? 'unknown';
    assert.equal(resolveOriginMainRelation(
      NEWER,
      HEAD,
      lookup({ [`${HEAD}..${NEWER}`]: 'yes' }),
    ), 'ahead');
    assert.equal(resolveOriginMainRelation(PREVIOUS, HEAD, () => 'no'), 'diverged');
    assert.equal(resolveOriginMainRelation(PREVIOUS, HEAD, () => 'unknown'), 'unknown');
  });

  it('fails closed on an empty or malformed expected fleet', () => {
    for (const expected of [[], null, ['a', 'a'], ['']]) {
      assert.throws(
        () => summarizeStrictDeployDrift([], expected),
        /expected service|unique|non-empty/i,
      );
    }
  });
});

// #6141/#6483 — NO_BUILD_IN_WINDOW is usually a WINDOW artifact, not a fleet
// state: under a long refusal storm every push adds a SKIPPED record to every
// service and a chatty cron adds one per tick, so days of storm displace the
// newest RUNNING deployment past the 50-record horizon. 29 of 80 services read
// NO_BUILD_IN_WINDOW this way on 2026-08-12 while every one of them was
// serving. The deep pass re-reads exactly those services once with a deeper
// window and reclassifies from the superset — and must stay fail-closed when
// the deeper read cannot answer either.
describe('deep-window fallback for unidentified-source windows', () => {
  // A fixed clock: the healthy-age guard is a boundary condition, and seeding
  // it from the live clock would make the boundary untestable.
  const NOW = Date.parse('2026-08-12T12:00:00.000Z');
  const svc = (name) => ({ id: `id-${name}`, name });
  // A shallow window holding nothing classifiable as running: SKIPPED records
  // without a commitHash are not rejections, so classify() reaches !running.
  const shallowNoBuild = (name) => classifyServiceDeploy({
    service: name,
    deployments: [
      deployment('SKIPPED', { at: '2026-08-12T10:00:00.000Z' }),
      deployment('SKIPPED', { at: '2026-08-12T09:00:00.000Z' }),
    ],
    headSha: HEAD,
  });
  const reclassify = (service, { deployments, error }) => classifyServiceDeploy({
    service: service.name,
    deployments,
    error,
    headSha: HEAD,
  });

  it('reclassifies a service whose running build sits past the shallow window', async () => {
    const reads = [];
    const shallow = shallowNoBuild('seed-a');
    assert.equal(shallow.verdict, 'NO_BUILD_IN_WINDOW');
    const { results, deepened, reclassified, failed } = await deepenNoBuildWindows(
      [shallow, { service: 'seed-b', verdict: 'CURRENT', detail: null }],
      {
        services: [svc('seed-a'), svc('seed-b')],
        readDeep: async (service) => {
          reads.push(service.name);
          return [
            deployment('SKIPPED', { at: '2026-08-12T10:00:00.000Z' }),
            deployment('SUCCESS', { at: '2026-08-11T00:00:00.000Z', sha: HEAD }),
          ];
        },
        reclassify,
        now: NOW,
      },
    );
    assert.deepEqual(reads, ['seed-a'], 'only the undeterminable service is re-read');
    assert.equal(deepened, 1);
    assert.equal(reclassified, 1);
    assert.equal(failed, 0);
    assert.equal(results[0].service, 'seed-a');
    assert.equal(results[0].verdict, 'CURRENT');
    assert.equal(results[1].verdict, 'CURRENT', 'other services pass through untouched');
  });

  // #6483 review (adversarial, verified by execution): a cron seeder records a
  // running-status record per tick, so "no running record anywhere deep" is
  // itself evidence the container stopped ticking. A deep read surfacing a
  // months-old build must NOT upgrade the service to a healthy verdict — the
  // fleet's oldest healthy runningAt measured 51.7h on 2026-08-12, so the
  // 7-day bound is far above any live cadence and far below the dead case.
  it('refuses a healthy upgrade when the deep-found build is stale', async () => {
    const shallow = shallowNoBuild('seed-a');
    const { results, reclassified } = await deepenNoBuildWindows([shallow], {
      services: [svc('seed-a')],
      readDeep: async () => [
        deployment('SKIPPED', { at: '2026-08-12T10:00:00.000Z' }),
        deployment('SUCCESS', { at: '2026-02-01T00:00:00.000Z', sha: HEAD }),
      ],
      reclassify,
      now: NOW,
    });
    assert.equal(results[0].verdict, 'NO_BUILD_IN_WINDOW', 'a months-dead service must stay reported');
    assert.ok(isProblemVerdict(results[0].verdict));
    assert.equal(reclassified, 0, 'a refused upgrade is not a reclassification');
  });

  it('accepts a PROBLEM reclassification even from a stale deep history', async () => {
    // The age guard bounds healthy upgrades only: a deep read that resolves to
    // a different PROBLEM verdict is strictly more information, whatever its age.
    const shallow = shallowNoBuild('seed-a');
    const { results } = await deepenNoBuildWindows([shallow], {
      services: [svc('seed-a')],
      readDeep: async () => [
        deployment('SKIPPED', { at: '2026-08-12T10:00:00.000Z', sha: NEWER, skippedReason: 'CI check suite failed' }),
        deployment('SUCCESS', { at: '2026-02-01T00:00:00.000Z', sha: PREVIOUS }),
      ],
      reclassify,
      now: NOW,
    });
    assert.equal(results[0].verdict, 'REJECTED_PUSH');
    assert.ok(isProblemVerdict(results[0].verdict));
  });

  it('keeps the shallow verdict when the deep read fails — an unread answer must stay reported', async () => {
    const shallow = shallowNoBuild('seed-a');
    const { results, deepened, reclassified, failed } = await deepenNoBuildWindows([shallow], {
      services: [svc('seed-a')],
      readDeep: async () => { throw new Error('railway timed out'); },
      reclassify,
      now: NOW,
    });
    assert.equal(deepened, 1);
    assert.equal(reclassified, 0, 'a failed read is not a reclassification');
    assert.equal(failed, 1, 'the failure must be countable, not silent');
    assert.equal(results[0], shallow, 'a failed deep read must not replace the verdict in either direction');
    assert.ok(isProblemVerdict(results[0].verdict));
  });

  it('stays NO_BUILD_IN_WINDOW when even the deep window holds no running build', async () => {
    const { results, reclassified, unchanged } = await deepenNoBuildWindows([shallowNoBuild('seed-a')], {
      services: [svc('seed-a')],
      readDeep: async () => [
        deployment('SKIPPED', { at: '2026-08-12T10:00:00.000Z' }),
        deployment('SKIPPED', { at: '2026-08-05T10:00:00.000Z' }),
      ],
      reclassify,
      now: NOW,
    });
    assert.equal(results[0].verdict, 'NO_BUILD_IN_WINDOW');
    assert.equal(reclassified, 0, 'an inconclusive deep read is not a reclassification');
    assert.equal(unchanged, 1, 'an inconclusive deep read is observable as unchanged');
    assert.ok(isProblemVerdict(results[0].verdict), 'a truly buildless history must stay reported');
  });

  it('keeps the stronger shallow verdict when the deep read is empty', async () => {
    const shallow = shallowNoBuild('seed-a');
    const { results, reclassified, unchanged } = await deepenNoBuildWindows([shallowNoBuild('seed-a')], {
      services: [svc('seed-a')],
      readDeep: async () => [],
      reclassify,
      now: NOW,
    });
    assert.equal(results[0].verdict, shallow.verdict);
    assert.equal(reclassified, 0, 'a different inconclusive verdict is not a resolved source');
    assert.equal(unchanged, 1);
    assert.ok(isProblemVerdict(results[0].verdict), 'an inconclusive deep read must stay reported');
  });

  it('keeps the shallow verdict when deep records are malformed', async () => {
    const shallow = shallowNoBuild('seed-a');
    const result = await deepenNoBuildWindows([shallow], {
      services: [svc('seed-a')],
      readDeep: async () => [{}],
      reclassify,
      now: NOW,
    });

    assert.equal(result.results[0], shallow);
    assert.equal(result.reclassified, 0);
    assert.equal(result.unchanged, 1);
  });

  it('deepens an unidentified-source rejection and resolves it from the superset', async () => {
    const shallow = classifyServiceDeploy({
      service: 'seed-a',
      deployments: [
        deployment('SKIPPED', { at: '2026-08-12T10:00:00.000Z', sha: PREVIOUS, skippedReason: 'CI check suite failed' }),
        deployment('SKIPPED', { at: '2026-08-12T09:00:00.000Z' }),
      ],
      headSha: HEAD,
    });
    assert.equal(shallow.verdict, 'REJECTED_PUSH_UNKNOWN_SOURCE');
    const { results, deepened } = await deepenNoBuildWindows([shallow], {
      services: [svc('seed-a')],
      // The deeper history shows a build that fired AFTER the refusal — the
      // rejection is superseded by the source change, and the service is
      // simply current.
      readDeep: async () => [
        deployment('SUCCESS', { at: '2026-08-12T11:00:00.000Z', sha: HEAD }),
        deployment('SKIPPED', { at: '2026-08-12T10:00:00.000Z', sha: PREVIOUS, skippedReason: 'CI check suite failed' }),
        deployment('SUCCESS', { at: '2026-08-11T00:00:00.000Z', sha: NEWER }),
      ],
      reclassify,
      now: NOW,
    });
    assert.equal(deepened, 1, 'an unidentified-source rejection is a deep-read candidate');
    assert.equal(results[0].verdict, 'CURRENT');
  });

  it('caps the deep pass and leaves the overflow at its shallow verdict', async () => {
    const count = DEEP_PASS_MAX_CANDIDATES + 2;
    const input = Array.from({ length: count }, (_, index) => shallowNoBuild(`seed-${String(index).padStart(2, '0')}`));
    const reads = [];
    const { results, deepened, capped } = await deepenNoBuildWindows(input, {
      services: input.map((result) => svc(result.service)),
      readDeep: async (service) => {
        reads.push(service.name);
        return [deployment('SUCCESS', { at: '2026-08-11T00:00:00.000Z', sha: HEAD })];
      },
      reclassify,
      now: NOW,
    });
    assert.equal(reads.length, DEEP_PASS_MAX_CANDIDATES, 'the deep pass must stay budget-bounded');
    assert.equal(deepened, DEEP_PASS_MAX_CANDIDATES);
    assert.equal(capped, 2);
    const kept = results.filter((result) => result.verdict === 'NO_BUILD_IN_WINDOW');
    assert.equal(kept.length, 2, 'overflow candidates keep their reported shallow verdict');
  });

  it('rotates the capped cohort so persistent overflow is attempted next tick', async () => {
    const count = DEEP_PASS_MAX_CANDIDATES + 2;
    const input = Array.from({ length: count }, (_, index) => shallowNoBuild(`seed-${String(index).padStart(2, '0')}`));
    const services = input.map((result) => svc(result.service));
    const attempted = [];
    const runAt = async (now) => {
      const reads = [];
      await deepenNoBuildWindows(input, {
        services,
        readDeep: async (service) => {
          reads.push(service.name);
          return [];
        },
        reclassify,
        now,
      });
      attempted.push(reads);
    };

    await runAt(0);
    await runAt(60 * 60 * 1000);

    assert.equal(attempted[0].length, DEEP_PASS_MAX_CANDIDATES);
    assert.equal(attempted[1].length, DEEP_PASS_MAX_CANDIDATES);
    assert.deepEqual(
      [...new Set(attempted.flat())].sort(),
      input.map((result) => result.service).sort(),
      'the next hourly schedule slot must reach every service omitted by the prior cap',
    );
  });

  it('stops starting deep reads at the run deadline and keeps shallow verdicts', async () => {
    const input = [shallowNoBuild('seed-a'), shallowNoBuild('seed-b')];
    const reads = [];
    let elapsed = 0;
    const result = await deepenNoBuildWindows(input, {
      services: input.map((entry) => svc(entry.service)),
      readDeep: async (service) => {
        reads.push(service.name);
        elapsed = 101;
        return [deployment('SUCCESS', { at: '2026-08-11T00:00:00.000Z', sha: HEAD })];
      },
      reclassify,
      concurrency: 1,
      deadlineAt: 100,
      monotonicNow: () => elapsed,
      now: 0,
    });

    assert.deepEqual(reads, ['seed-a']);
    assert.equal(result.deepened, 1);
    assert.equal(result.deadlineDeferred, 1);
    assert.equal(result.results[0].verdict, 'CURRENT');
    assert.equal(result.results[1].verdict, 'NO_BUILD_IN_WINDOW');
  });

  it('keeps malformed deep responses failed and preserves the shallow verdict', async () => {
    const shallow = shallowNoBuild('seed-a');
    const result = await deepenNoBuildWindows([shallow], {
      services: [svc('seed-a')],
      readDeep: async () => ({ deployments: [] }),
      reclassify,
      now: NOW,
    });

    assert.equal(result.failed, 1);
    assert.equal(result.reclassified, 0);
    assert.equal(result.results[0], shallow);
  });

  it('reserves time to report before the next scheduled run can supersede it', () => {
    assert.ok(DEEP_PASS_RUN_BUDGET_MS < 14 * 60 * 1000);
  });

  it('charges prerequisite time to the same scheduled-run budget', () => {
    const deadlineAt = resolveDeepPassDeadlineAt({
      jobStartedAtMs: 1_000,
      epochNow: 11 * 60 * 1000 + 1_000,
      monotonicNow: 50,
    });
    assert.equal(deadlineAt, 2 * 60 * 1000 + 50);
  });

  it('leaves a service it cannot resolve in the fleet untouched', async () => {
    const shallow = shallowNoBuild('seed-gone');
    const reads = [];
    const { results, deepened } = await deepenNoBuildWindows([shallow], {
      services: [svc('seed-other')],
      readDeep: async (service) => { reads.push(service.name); return []; },
      reclassify,
      now: NOW,
    });
    assert.deepEqual(reads, [], 'no deep read for a service the fleet map cannot resolve');
    assert.equal(deepened, 0);
    assert.equal(results[0], shallow);
  });

  it('preserves fleet order across mixed verdicts', async () => {
    const input = [
      { service: 'a', verdict: 'CURRENT', detail: null },
      shallowNoBuild('b'),
      { service: 'c', verdict: 'REJECTED_PUSH', detail: 'x', runningSha: PREVIOUS },
      shallowNoBuild('d'),
    ];
    const { results } = await deepenNoBuildWindows(input, {
      services: [svc('b'), svc('d')],
      readDeep: async () => [deployment('SUCCESS', { at: '2026-08-11T00:00:00.000Z', sha: HEAD })],
      reclassify,
      now: NOW,
    });
    assert.deepEqual(results.map((result) => result.service), ['a', 'b', 'c', 'd']);
    assert.deepEqual(results.map((result) => result.verdict), ['CURRENT', 'CURRENT', 'REJECTED_PUSH', 'CURRENT']);
  });
});

describe('scheduled-run classification deadline', () => {
  it('fails remaining histories closed after classification consumes the deadline', () => {
    const services = [
      { id: 'seed-a-id', name: 'seed-a' },
      { id: 'seed-b-id', name: 'seed-b' },
    ];
    const histories = new Map(services.map((service) => [service.id, { deployments: [], error: null }]));
    let elapsed = 0;
    const classified = classifyFleetWithinDeadline(services, histories, {
      classify: (service, history) => {
        if (service.name === 'seed-a') elapsed = 101;
        return classifyServiceDeploy({
          service: service.name,
          deployments: history.deployments,
          error: history.error,
          headSha: HEAD,
        });
      },
      deadlineAt: 100,
      monotonicNow: () => elapsed,
    });

    assert.equal(classified[0].verdict, 'NO_DEPLOYMENTS');
    assert.equal(classified[1].verdict, 'QUERY_FAILED');
    assert.match(classified[1].detail, /deadline/);
  });
});

// A saturated window plus one outstanding rejection can leave the running
// source unidentified. Keep that distinct from an ordinary rejected push so
// the monitor cannot report a determinate-looking answer from missing evidence.
describe('unknown-source rejections', () => {
  it('splits an unidentified-source rejection from ordinary REJECTED_PUSH', () => {
    const result = classifyServiceDeploy({
      service: 'svc',
      deployments: [
        deployment('SKIPPED', { at: '2026-08-12T10:00:00.000Z', sha: PREVIOUS, skippedReason: 'CI check suite failed' }),
        deployment('SKIPPED', { at: '2026-08-12T09:00:00.000Z' }),
      ],
      headSha: HEAD,
    });
    assert.equal(result.verdict, 'REJECTED_PUSH_UNKNOWN_SOURCE');
    assert.equal(result.runningSha, null);
    assert.deepEqual(result.rejectedShas, [PREVIOUS]);
    assert.ok(
      UNDETERMINABLE_VERDICTS.includes('REJECTED_PUSH_UNKNOWN_SOURCE'),
      'an unidentified source is an undeterminable answer and must stay directly blocking',
    );
  });

  it('keeps ordinary REJECTED_PUSH when the running source is identified', () => {
    const result = classifyServiceDeploy({
      service: 'svc',
      deployments: [
        deployment('SKIPPED', { at: '2026-08-12T10:00:00.000Z', sha: NEWER, skippedReason: 'CI check suite failed' }),
        deployment('SUCCESS', { at: '2026-08-11T00:00:00.000Z', sha: PREVIOUS }),
      ],
      headSha: HEAD,
    });
    assert.equal(result.verdict, 'REJECTED_PUSH');
    assert.equal(result.runningSha, PREVIOUS);
  });
});
