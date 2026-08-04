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
import { describe, it } from 'node:test';

import {
  classifyServiceDeploy,
  isProblemVerdict,
  summarizeDeployDrift,
} from '../scripts/check-railway-deploy-drift.mjs';

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
function classify(deployments, overrides = {}) {
  return classifyServiceDeploy({
    service: 'seed-example',
    deployments,
    headSha: HEAD,
    ...overrides,
  });
}

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

  // Ancestry must not excuse a rejection: the service can be running a
  // descendant of the head we read and still have had a later push refused.
  it('reports a rejected push even when the running build is ahead of head', () => {
    const result = classify([
      deployment('SKIPPED', { at: '2026-08-04T05:50:00Z', sha: 'aaaaaaaaa00000000000000000000000000000aa' }),
      deployment('SUCCESS', { at: '2026-08-04T05:44:55Z', sha: NEWER }),
    ], { isAncestor: () => true });
    assert.equal(result.verdict, 'REJECTED_PUSH');
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

  it('reports a build in flight for head regardless of the grace', () => {
    const result = classify([
      deployment('BUILDING', { at: '2026-08-04T05:59:00Z', sha: HEAD }),
      deployment('REMOVED', { at: '2026-08-04T05:00:00Z', sha: PREVIOUS }),
    ]);
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

  it('reports an empty window rather than assuming health', () => {
    const result = classify([]);
    assert.equal(result.verdict, 'NO_DEPLOYMENTS');
    assert.equal(isProblemVerdict(result.verdict), true);
  });

  it('reports a window that holds only rejections', () => {
    const result = classify([
      deployment('SKIPPED', { at: '2026-08-04T05:06:28Z', sha: HEAD }),
    ]);
    assert.equal(result.verdict, 'REJECTED_PUSH');
    assert.equal(result.runningSha, null);
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

describe('Railway deploy drift summary', () => {
  const results = [
    { service: 'a', verdict: 'CURRENT' },
    { service: 'b', verdict: 'PENDING_BUILD' },
    { service: 'c', verdict: 'REJECTED_PUSH' },
    { service: 'd', verdict: 'BEHIND' },
  ];

  it('counts every verdict and names only the problems', () => {
    const summary = summarizeDeployDrift(results);
    assert.deepEqual(summary.counts, {
      CURRENT: 1,
      PENDING_BUILD: 1,
      REJECTED_PUSH: 1,
      BEHIND: 1,
    });
    assert.deepEqual(summary.problems.map((entry) => entry.service), ['c', 'd']);
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
    assert.deepEqual(summary.problems, []);
  });
});
