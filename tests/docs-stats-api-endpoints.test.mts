/**
 * docs-stats `apiEndpointEntries` must match git-tracked top-level `api/`
 * names. Empty leftover directories (macOS dirty-worktree residue such as
 * `api/[domain]/v1`) are not endpoints and must not inflate stats.json — CI
 * checkouts never have them, so a readdir-only count fails the always-on
 * docs-stats job (#6439 / PR #6527).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { computeStats, withStatsRoot } from '../scripts/docs-stats.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function realProbePath(name: string): string {
  return resolve(REPO_ROOT, 'api', name);
}

function assertRealTreeUntouched(name: string): void {
  assert.equal(
    existsSync(realProbePath(name)),
    false,
    `${name} must never appear in the real checkout`,
  );
}

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
  it('ignores an empty leftover api/ directory that a readdir-only count would include', async () => {
    // #6702: stage the probe only inside the throwaway copy. Relative mkdir/rm
    // would still hit process.cwd() (the real checkout) and race
    // docs-stats-plan-layer-entitlement, which scans that tree end to end.
    const probeName = '[__docs_stats_probe__]';
    await withStatsRoot(async (sandbox) => {
      const leftover = resolve(sandbox, 'api', probeName);
      const baseline = computeStats().apiEndpointEntries;
      mkdirSync(resolve(leftover, 'v1'), { recursive: true });
      try {
        assertRealTreeUntouched(probeName);
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
    assertRealTreeUntouched(probeName);
  });

  // Parallel test:data can run this file next to
  // tests/docs-stats-plan-layer-entitlement.test.mts, which spawns
  // `docs-stats --check` and walks api/ via source-attribution. Stage the
  // leftover only in the sandbox (#6702) so that sibling scan never sees it.
  it('leaves source-attribution able to walk api/ while the leftover exists', async () => {
    const probeName = '[__docs_stats_probe__]';
    await withStatsRoot(async (sandbox) => {
      const leftover = resolve(sandbox, 'api', probeName);
      mkdirSync(resolve(leftover, 'v1'), { recursive: true });
      try {
        assertRealTreeUntouched(probeName);
        assert.doesNotThrow(() => computeStats());
      } finally {
        rmSync(leftover, { recursive: true, force: true });
      }
    });
    assertRealTreeUntouched(probeName);
  });

  it('still counts a leftover directory once it contains a real file', async () => {
    // #6702: same sandbox-absolute staging as the empty-probe test above.
    const probeName = '[__docs_stats_probe2__]';
    await withStatsRoot(async (sandbox) => {
      const populated = resolve(sandbox, 'api', probeName);
      const baseline = computeStats().apiEndpointEntries;
      mkdirSync(resolve(populated, 'v1'), { recursive: true });
      try {
        writeFileSync(resolve(populated, 'v1', 'handler.js'), '');
        assertRealTreeUntouched(probeName);
        assert.equal(
          computeStats().apiEndpointEntries,
          baseline + 1,
          'a directory with a real file nested inside is a genuine endpoint entry',
        );
      } finally {
        rmSync(populated, { recursive: true, force: true });
      }
    });
    assertRealTreeUntouched(probeName);
  });

  it('restores the real root when the sandbox callback throws', async () => {
    const before = computeStats().apiEndpointEntries;
    await assert.rejects(
      () => withStatsRoot(async () => {
        throw new Error('probe isolation boom');
      }),
      { message: 'probe isolation boom' },
    );
    assert.equal(computeStats().apiEndpointEntries, before);
  });
});
