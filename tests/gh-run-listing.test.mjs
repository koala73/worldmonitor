import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { corroborateRunListings, reduceRunListings } from '../scripts/lib/gh-run-listing.mjs';

const old = { id: 1, created_at: '2026-09-20T00:00:00Z', run_attempt: 1, status: 'completed', conclusion: 'success' };
const current = { ...old, id: 2, created_at: '2026-09-24T00:00:00Z', conclusion: 'failure' };
const listing = (runs, totalCount) => ({ runs, totalCount });
function readSequence(sequence, options = {}) {
  return corroborateRunListings({ ...options, read: () => {
    const next = sequence.shift();
    if (next instanceof Error) throw next;
    return next;
  } });
}

test('narrower totals cannot pad a quorum even with a majority of stale samples', () => {
  assert.throws(() => readSequence([listing([old], 1), listing([old], 1), listing([current], 2)]), /corroborated/);
});
test('a failed sibling does not invalidate two successful observations', () => {
  const result = readSequence([listing([old], 2), new Error('timeout'), listing([current], 2)]);
  assert.equal(reduceRunListings(result)[0].id, 2);
});
test('one success and two failed siblings cannot claim health or failure', () => {
  assert.throws(() => readSequence([listing([current], 2), new Error('timeout'), new Error('timeout')]), /corroborated/);
});
test('an all-failed read preserves its original error', () => {
  const error = new Error('forbidden');
  assert.throws(() => readSequence([error, error, error]), actual => actual === error);
});
test('the clock stops slow successful and failed reads before another sample', () => {
  for (const fails of [false, true]) {
    let elapsed = 0;
    let calls = 0;
    assert.throws(() => corroborateRunListings({
      clock: () => elapsed, sampleBudgetMs: 50,
      read: () => { calls += 1; elapsed += 60; if (fails) throw new Error('slow failure'); return listing([current], 2); },
    }), fails ? /slow failure/ : /corroborated/);
    assert.equal(calls, 1);
  }
});
test('missing counts remain observations, and empty siblings cannot pad quorum', () => {
  assert.equal(reduceRunListings(readSequence([listing([old]), listing([current]), listing([])]))[0].id, 2);
  assert.throws(() => readSequence([listing([]), listing([]), listing([current])]), /corroborated/);
});
test('corroborated genuinely empty listings remain empty', () => {
  assert.deepEqual(reduceRunListings(readSequence([listing([], 0), listing([], 0), listing([], 0)])), []);
});
test('nonzero totals paired with empty arrays cannot claim no runs', () => {
  assert.throws(() => readSequence([listing([], 5), listing([], 5), listing([], 5)]), /corroborated/);
});
test('reduction orders tied creation times by id, attempt and settled status', () => {
  const rerun = { ...old, run_attempt: 2, status: 'queued', conclusion: null };
  const settled = { ...rerun, status: 'completed', conclusion: 'failure' };
  const nextId = { ...old, id: 3 };
  const result = reduceRunListings([listing([old, rerun]), listing([settled, nextId])]);
  assert.deepEqual(result, [nextId, settled]);
});

for (const script of ['check-pulse-freshness.mjs', 'check-railway-reconcile-age.mjs']) {
  test(`${script} CLI reports UNKNOWN for contradictory listings`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'run-listing-'));
    try {
      mkdirSync(join(dir, 'docs/snapshots'), { recursive: true });
      const today = new Date().toISOString().slice(0, 10);
      writeFileSync(join(dir, `docs/snapshots/crawlable-live-pulse-${today}.json`), JSON.stringify({ capturedAt: today }));
      writeFileSync(join(dir, 'gh'), `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (!args.some(arg => arg.includes('/workflows/') && arg.includes('/runs?'))) { console.error('unexpected non-listing call'); process.exit(1); }\nconsole.log(JSON.stringify({total_count: 5, workflow_runs: []}));\n`, { mode: 0o755 });
      const result = spawnSync(process.execPath, [resolve(`scripts/${script}`)], {
        cwd: dir, encoding: 'utf8', timeout: 20_000,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: 'o/r', GITHUB_STEP_SUMMARY: '' },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /::warning::UNKNOWN/);
      assert.doesNotMatch(result.stdout + result.stderr, /::error::|unexpected non-listing call/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
