// Contract test for the baseline-snapshot selection logic used by
// scripts/compare-resilience-current-vs-proposed.mjs. The selector is
// what drives acceptance gates 2 / 6 / 7 (matched-pair, cohort, max
// country drift) for every scorer PR in the resilience repair plan.
// A plain filename sort breaks on two axes:
//   1. `pre-repair` sorts after `post-*` lexically (`pr...` → 'r' > 'o'),
//      so the pre-repair freeze would keep winning forever.
//   2. `post-pr9` sorts after `post-pr10` lexically, so PR-10 would
//      lose to PR-9.
// These tests pin the parsed ordering so neither failure mode silently
// regresses.

import test from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../scripts/compare-resilience-current-vs-proposed.mjs');
const { parseBaselineSnapshotMeta } = mod;

function orderedFilenames(filenames) {
  return filenames
    .map(parseBaselineSnapshotMeta)
    .filter((m) => m != null)
    .sort((a, b) => {
      if (a.kindRank !== b.kindRank) return b.kindRank - a.kindRank;
      if (a.prNumber !== b.prNumber) return b.prNumber - a.prNumber;
      return b.date.localeCompare(a.date);
    })
    .map((m) => m.filename);
}

test('parseBaselineSnapshotMeta: pre-repair filename is recognised', () => {
  const meta = parseBaselineSnapshotMeta('resilience-ranking-live-pre-repair-2026-04-22.json');
  assert.ok(meta);
  assert.equal(meta.kind, 'pre-repair');
  assert.equal(meta.kindRank, 0);
  assert.equal(meta.prNumber, -1);
  assert.equal(meta.date, '2026-04-22');
});

test('parseBaselineSnapshotMeta: post-pr<N> filename parses prNumber numerically', () => {
  const meta = parseBaselineSnapshotMeta('resilience-ranking-live-post-pr10-2026-05-01.json');
  assert.ok(meta);
  assert.equal(meta.kind, 'post');
  assert.equal(meta.kindRank, 1);
  assert.equal(meta.prNumber, 10);
  assert.equal(meta.date, '2026-05-01');
  assert.equal(meta.tag, 'pr10');
});

test('parseBaselineSnapshotMeta: post-<freeform-tag> falls back to prNumber 0', () => {
  const meta = parseBaselineSnapshotMeta('resilience-ranking-live-post-handcal-2026-06-01.json');
  assert.ok(meta);
  assert.equal(meta.kind, 'post');
  assert.equal(meta.prNumber, 0);
  assert.equal(meta.tag, 'handcal');
});

test('parseBaselineSnapshotMeta: unrelated filenames return null', () => {
  assert.equal(parseBaselineSnapshotMeta('resilience-ranking-2026-04-21.json'), null);
  assert.equal(parseBaselineSnapshotMeta('resilience-ranking-pillar-combined-projected-2026-04-21.json'), null);
  assert.equal(parseBaselineSnapshotMeta('README.md'), null);
});

test('selection ordering: post always beats pre-repair regardless of date', () => {
  const ordered = orderedFilenames([
    'resilience-ranking-live-pre-repair-2026-06-01.json',
    'resilience-ranking-live-post-pr1-2026-05-01.json',
  ]);
  assert.deepEqual(ordered, [
    'resilience-ranking-live-post-pr1-2026-05-01.json',
    'resilience-ranking-live-pre-repair-2026-06-01.json',
  ]);
});

test('selection ordering: pr10 beats pr9 (numeric, not lexical)', () => {
  const ordered = orderedFilenames([
    'resilience-ranking-live-post-pr9-2026-05-15.json',
    'resilience-ranking-live-post-pr10-2026-06-01.json',
    'resilience-ranking-live-post-pr2-2026-05-01.json',
  ]);
  assert.deepEqual(ordered, [
    'resilience-ranking-live-post-pr10-2026-06-01.json',
    'resilience-ranking-live-post-pr9-2026-05-15.json',
    'resilience-ranking-live-post-pr2-2026-05-01.json',
  ]);
});

test('selection ordering: realistic PR-0..PR-4 ladder picks the latest PR', () => {
  const ordered = orderedFilenames([
    'resilience-ranking-live-pre-repair-2026-04-22.json',
    'resilience-ranking-live-post-pr1-2026-05-10.json',
    'resilience-ranking-live-post-pr3-2026-06-02.json',
    'resilience-ranking-live-post-pr2-2026-05-25.json',
    'resilience-ranking-live-post-pr4-2026-06-18.json',
  ]);
  assert.equal(ordered[0], 'resilience-ranking-live-post-pr4-2026-06-18.json');
  assert.equal(ordered.at(-1), 'resilience-ranking-live-pre-repair-2026-04-22.json');
});

test('selection ordering: same pr number, later date wins', () => {
  // Edge case: a PR re-snapshotted after a hotfix. The later capture
  // should win so "immediate prior" remains the most recent observation
  // of that PR's landed state.
  const ordered = orderedFilenames([
    'resilience-ranking-live-post-pr2-2026-05-25.json',
    'resilience-ranking-live-post-pr2-2026-05-27.json',
  ]);
  assert.equal(ordered[0], 'resilience-ranking-live-post-pr2-2026-05-27.json');
});

test('selection ordering: unlabeled post tag sorts between pre-repair and pr1', () => {
  // Guards against a future misnamed snapshot sneaking in and either
  // beating a numbered PR or losing to the original pre-repair.
  const ordered = orderedFilenames([
    'resilience-ranking-live-pre-repair-2026-04-22.json',
    'resilience-ranking-live-post-handcal-2026-05-02.json',
    'resilience-ranking-live-post-pr1-2026-05-10.json',
  ]);
  assert.deepEqual(ordered, [
    'resilience-ranking-live-post-pr1-2026-05-10.json',
    'resilience-ranking-live-post-handcal-2026-05-02.json',
    'resilience-ranking-live-pre-repair-2026-04-22.json',
  ]);
});
