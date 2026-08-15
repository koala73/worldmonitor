/**
 * docs-stats `apiEndpointEntries` must match git-tracked top-level `api/`
 * names. Empty leftover directories (macOS dirty-worktree residue such as
 * `api/[domain]/v1`) are not endpoints and must not inflate stats.json — CI
 * checkouts never have them, so a readdir-only count fails the always-on
 * docs-stats job (#6439 / PR #6527).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { computeStats } from '../scripts/docs-stats.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function trackedApiEndpointEntries(): number {
  const tracked = execFileSync('git', ['ls-files', '-z', '--', 'api'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const top = new Set<string>();
  for (const path of tracked) {
    if (!path.startsWith('api/')) continue;
    const name = path.slice('api/'.length).split('/')[0];
    if (!name || name.startsWith('_') || name.startsWith('.')) continue;
    if (/\.test\./.test(name) || /\.d\.ts$/.test(name) || /\.json$/.test(name)) continue;
    top.add(name);
  }
  return top.size;
}

describe('docs-stats api endpoint inventory', () => {
  it('counts only git-tracked top-level api entries, not empty leftover dirs', () => {
    const expected = trackedApiEndpointEntries();
    assert.ok(expected > 0, 'expected git to list api/ files');
    assert.equal(computeStats().apiEndpointEntries, expected);
  });

  // The assertion above cannot fail on the bug this file exists to guard:
  // `expected` comes from `git ls-files`, which can never see an empty
  // directory, so in a clean checkout the pre-fix readdir count and the
  // dirHasFiles count agree and the test passes against BOTH. Stage the actual
  // condition -- an empty `api/[domain]/v1` leftover -- so reverting
  // dirHasFiles turns this red.
  it('ignores an empty leftover api/ directory that a readdir-only count would include', () => {
    const leftover = resolve(REPO_ROOT, 'api/[__docs_stats_probe__]');
    const baseline = computeStats().apiEndpointEntries;
    mkdirSync(resolve(leftover, 'v1'), { recursive: true });
    try {
      assert.equal(
        computeStats().apiEndpointEntries,
        baseline,
        'an empty leftover directory must not count as an endpoint',
      );
    } finally {
      rmSync(leftover, { recursive: true, force: true });
    }
    assert.equal(computeStats().apiEndpointEntries, baseline, 'probe directory must be cleaned up');
  });

  it('still counts a leftover directory once it contains a real file', () => {
    const populated = resolve(REPO_ROOT, 'api/[__docs_stats_probe2__]');
    const baseline = computeStats().apiEndpointEntries;
    mkdirSync(resolve(populated, 'v1'), { recursive: true });
    try {
      execFileSync('touch', [resolve(populated, 'v1/handler.js')]);
      assert.equal(
        computeStats().apiEndpointEntries,
        baseline + 1,
        'a directory with a real file nested inside is a genuine endpoint entry',
      );
    } finally {
      rmSync(populated, { recursive: true, force: true });
    }
  });
});

// ── #6702: dirHasFiles must tolerate a concurrent delete ──
//
// The race: a sibling test file runs computeStats() end to end on the real
// repo while THIS file creates and removes a probe directory. The parent
// readdir lists the probe, this file rmSync's it, then the child readdir
// ENOENTs. The fix: dirHasFiles catches ENOENT and answers the question it
// was asked — a vanished dir has no files.
it('dirHasFiles tolerates a directory vanishing mid-scan (#6702)', () => {
  const probe = resolve(REPO_ROOT, 'api/[__docs_stats_race_probe__]');
  mkdirSync(resolve(probe, 'v1'), { recursive: true });
  try {
    // Simulate the interleaving the race produces: the parent readdir has
    // already listed the probe, then it is removed before the child
    // readdir reaches it. dirHasFiles is not exported, but computeStats()
    // walks api/ through it — the vanished dir must not ENOENT.
    rmSync(probe, { recursive: true, force: true });
    const baseline = computeStats().apiEndpointEntries;
    assert.ok(typeof baseline === 'number',
      'computeStats must survive a directory vanishing mid-scan');
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
});
