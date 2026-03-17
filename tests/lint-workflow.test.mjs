import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const workflow = readFileSync(
  path.join(repoRoot, '.github', 'workflows', 'lint.yml'),
  'utf8',
);

test('markdown lint workflow only lints markdown files changed in the pull request', () => {
  assert.match(
    workflow,
    /actions\/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd[\s\S]*fetch-depth: 0/,
    'lint workflow should fetch enough history to diff against the base branch',
  );
  assert.match(
    workflow,
    /git fetch origin "\$\{\{ github\.base_ref \}\}" --depth=1[\s\S]*git diff --name-only "origin\/\$\{\{ github\.base_ref \}\}\.\.\.HEAD" -- '\*\.md'/,
    'lint workflow should resolve the changed markdown file set from the pull request diff',
  );
  assert.match(
    workflow,
    /xargs -0 npx markdownlint-cli2 < "\$RUNNER_TEMP\/markdown-files\.txt"/,
    'lint workflow should lint only the changed markdown files',
  );
  assert.doesNotMatch(
    workflow,
    /run: npm run lint:md/,
    'lint workflow should not lint the entire repository on every markdown-touching pull request',
  );
});
