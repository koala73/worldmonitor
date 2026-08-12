/**
 * docs-stats `apiEndpointEntries` must match git-tracked top-level `api/`
 * names. Empty leftover directories (macOS dirty-worktree residue such as
 * `api/[domain]/v1`) are not endpoints and must not inflate stats.json — CI
 * checkouts never have them, so a readdir-only count fails the always-on
 * docs-stats job (#6439 / PR #6527).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';

import { computeStats } from '../scripts/docs-stats.mjs';

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
});
