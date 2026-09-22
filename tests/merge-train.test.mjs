import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyGate,
  parseArgs,
  runMergeTrain,
  skipReason,
} from '../scripts/merge-train.mjs';

const OPEN = {
  state: 'OPEN', isDraft: false, mergeStateStatus: 'CLEAN', title: 'a pull request',
};
const head = (number) => `${String(number).padStart(4, '0')}`.repeat(10);

/**
 * A fake GitHub whose gate verdicts are a per-PR script, consumed in order.
 *
 * Each `evaluateGate` call takes the next verdict for that PR, so a test can
 * say "stale the first time, green after the update" the way the real thing
 * behaves once a branch has been refreshed.
 */
function fakeGitHub({ prs, verdicts }) {
  const remaining = new Map(Object.entries(verdicts).map(([key, value]) => [Number(key), [...value]]));
  const calls = [];
  return {
    calls,
    async getPullRequest(number) {
      calls.push(`view:${number}`);
      return prs[number] ? { number, headRefOid: head(number), ...prs[number] } : null;
    },
    async evaluateGate(sha) {
      calls.push(`gate:${sha.slice(0, 4)}`);
      const number = Number(sha.slice(0, 4));
      const queue = remaining.get(number) ?? [];
      return queue.length > 1 ? queue.shift() : queue[0] ?? null;
    },
    async updateBranch(number) { calls.push(`update:${number}`); },
    async merge(number) { calls.push(`merge:${number}`); },
  };
}

const green = { state: 'success', description: 'All required PR gates passed [gate-contract:abc]' };
const stale = {
  state: 'failure',
  description: 'Stale base: main changed 1 file(s) here: api/widget-agent.ts [gate-contract:abc]',
};
const broken = {
  state: 'failure',
  description: 'Required PR gates did not pass (1): unit [gate-contract:abc]',
};
const waiting = { state: 'pending', description: 'Waiting for required PR gates (2): unit,biome' };

const run = (github, options) => runMergeTrain({ github, log: () => {}, execute: true, ...options });

describe('merge train gate classification', () => {
  it('separates a stale base from an ordinary red', () => {
    assert.equal(classifyGate(green), 'green');
    assert.equal(classifyGate(stale), 'stale-base');
    assert.equal(classifyGate(broken), 'failed');
    assert.equal(classifyGate(waiting), 'pending');
    assert.equal(classifyGate(null), 'pending');
    assert.equal(classifyGate({}), 'pending');
  });

  it('never treats an unmergeable PR as a candidate', () => {
    assert.equal(skipReason({ ...OPEN }), null);
    assert.equal(skipReason(null), 'not found');
    assert.equal(skipReason({ ...OPEN, state: 'MERGED' }), 'state is MERGED');
    assert.equal(skipReason({ ...OPEN, isDraft: true }), 'draft');
    assert.equal(skipReason({ ...OPEN, mergeStateStatus: 'DIRTY' }), 'conflicts with main');
  });
});

describe('merge train', () => {
  it('re-evaluates the gate for every PR before merging it', async () => {
    // The whole point: PR 8002's verdict from before 8001 landed is worthless,
    // so the train must spend a fresh evaluation on each head.
    const github = fakeGitHub({
      prs: { 8001: OPEN, 8002: OPEN },
      verdicts: { 8001: [green], 8002: [green] },
    });
    const outcomes = await run(github, { queue: [8001, 8002] });
    assert.deepEqual(outcomes.map((outcome) => outcome.outcome), ['merged', 'merged']);
    assert.deepEqual(
      github.calls.filter((call) => call.startsWith('gate:') || call.startsWith('merge:')),
      ['gate:8001', 'merge:8001', 'gate:8002', 'merge:8002'],
    );
  });

  it('updates a stale base and merges it on the next pass', async () => {
    const github = fakeGitHub({
      prs: { 8001: OPEN, 8002: OPEN },
      verdicts: { 8001: [stale, green], 8002: [green] },
    });
    const outcomes = await run(github, { queue: [8001, 8002] });
    assert.deepEqual(outcomes.map((outcome) => outcome.outcome), ['updated', 'merged', 'merged']);
    // 8001 goes to the BACK, so 8002 merges while 8001's checks re-run.
    assert.deepEqual(
      github.calls.filter((call) => call.startsWith('update:') || call.startsWith('merge:')),
      ['update:8001', 'merge:8002', 'merge:8001'],
    );
  });

  it('gives up on a PR that stays stale rather than looping', async () => {
    const github = fakeGitHub({ prs: { 8001: OPEN }, verdicts: { 8001: [stale] } });
    const outcomes = await run(github, { queue: [8001], maxUpdates: 2 });
    assert.deepEqual(outcomes.map((outcome) => outcome.outcome), ['updated', 'updated', 'blocked']);
    assert.equal(github.calls.filter((call) => call === 'update:8001').length, 2);
    assert.equal(github.calls.filter((call) => call.startsWith('merge:')).length, 0);
  });

  it('never merges on a red gate, a pending gate, or an unreadable one', async () => {
    for (const verdict of [broken, waiting, null]) {
      const github = fakeGitHub({ prs: { 8001: OPEN }, verdicts: { 8001: [verdict] } });
      await run(github, { queue: [8001], maxUpdates: 0 });
      assert.deepEqual(github.calls.filter((call) => call.startsWith('merge:')), [], String(verdict));
    }
  });

  it('refuses to merge a head that moved while the gate was evaluating', async () => {
    // The gate's verdict names a SHA. If the branch was pushed meanwhile, that
    // verdict describes a commit that is no longer what would merge.
    // Pass 1 pushes mid-evaluation (the two reads disagree); pass 2 is settled.
    const heads = [head(8001), head(9999), head(9999), head(9999)];
    let gatedSha = null;
    const github = {
      calls: [],
      async getPullRequest(number) {
        return { number, ...OPEN, headRefOid: heads.shift() };
      },
      async evaluateGate(sha) { gatedSha = sha; return green; },
      async updateBranch() { throw new Error('a moved head is not a stale base'); },
      async merge(number) { github.calls.push(`merge:${number}:${gatedSha.slice(0, 4)}`); },
    };
    const outcomes = await runMergeTrain({
      queue: [8001], github, log: () => {}, execute: true, maxUpdates: 0,
    });
    assert.deepEqual(outcomes.map((outcome) => outcome.outcome), ['requeued', 'merged']);
    // The merge happened on the head the gate actually evaluated, not the one
    // the first pass read.
    assert.deepEqual(github.calls, ['merge:8001:9999']);
  });

  it('changes nothing without --execute', async () => {
    const github = fakeGitHub({
      prs: { 8001: OPEN, 8002: OPEN },
      verdicts: { 8001: [green], 8002: [stale] },
    });
    const outcomes = await run(github, { queue: [8001, 8002], execute: false });
    assert.deepEqual(outcomes.map((outcome) => outcome.outcome), ['would merge', 'would update']);
    assert.deepEqual(
      github.calls.filter((call) => call.startsWith('merge:') || call.startsWith('update:')),
      [],
    );
  });

  it('reports a skipped PR instead of stopping the train', async () => {
    const github = fakeGitHub({
      prs: { 8001: { ...OPEN, isDraft: true }, 8002: OPEN },
      verdicts: { 8002: [green] },
    });
    const outcomes = await run(github, { queue: [8001, 8002] });
    assert.deepEqual(outcomes.map((outcome) => outcome.outcome), ['skipped', 'merged']);
  });
});

describe('merge train arguments', () => {
  it('requires an explicit --execute to do anything', () => {
    assert.equal(parseArgs(['8001']).execute, false);
    assert.equal(parseArgs(['8001', '--execute']).execute, true);
  });

  it('deduplicates the queue and rejects anything it does not understand', () => {
    assert.deepEqual(parseArgs(['8001', '8002', '8001']).queue, [8001, 8002]);
    assert.throws(() => parseArgs([]), /No PR numbers/);
    assert.throws(() => parseArgs(['--squash-everything']), /Unrecognised argument/);
  });
});
