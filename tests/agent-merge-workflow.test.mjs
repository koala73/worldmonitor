import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const workflow = readFileSync(
  path.join(repoRoot, '.github', 'workflows', 'auto-merge-agent-branches.yml'),
  'utf8',
);

test('agent branches use GitHub auto-merge instead of direct merge API calls', () => {
  assert.match(
    workflow,
    /Enable GitHub auto-merge/,
    'agent workflow should explicitly enable GitHub auto-merge',
  );
  assert.match(
    workflow,
    /enablePullRequestAutoMerge/,
    'agent workflow should rely on GitHub auto-merge after checks pass',
  );
  assert.doesNotMatch(
    workflow,
    /github\.rest\.pulls\.merge/,
    'agent workflow should not merge PRs immediately on branch push',
  );
});
