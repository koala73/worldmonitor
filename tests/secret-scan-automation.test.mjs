import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const packageJson = readFileSync(path.join(repoRoot, 'package.json'), 'utf8');
const preCommitHook = readFileSync(path.join(repoRoot, '.husky', 'pre-commit'), 'utf8');
const prePushHook = readFileSync(path.join(repoRoot, '.husky', 'pre-push'), 'utf8');
const workflow = readFileSync(path.join(repoRoot, '.github', 'workflows', 'secret-scan.yml'), 'utf8');
const claude = readFileSync(path.join(repoRoot, 'CLAUDE.md'), 'utf8');
const agents = readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');
const copilot = readFileSync(path.join(repoRoot, '.github', 'copilot-instructions.md'), 'utf8');

test('secret scanning is enforced locally and in CI', () => {
  assert.match(
    packageJson,
    /"secrets:scan": "node scripts\/secret-scan\.mjs"/,
    'package.json should expose a full-repo secret scan command',
  );
  assert.match(
    packageJson,
    /"secrets:scan:staged": "node scripts\/secret-scan\.mjs --staged"/,
    'package.json should expose a staged secret scan command',
  );
  assert.match(
    preCommitHook,
    /npm run secrets:scan:staged/,
    'pre-commit should block staged secret leaks before commit',
  );
  assert.match(
    prePushHook,
    /npm run secrets:scan/,
    'pre-push should block repo secret leaks before push',
  );
  assert.match(
    workflow,
    /name: Secret Scan[\s\S]*pull_request:[\s\S]*push:[\s\S]*main[\s\S]*node scripts\/secret-scan\.mjs/,
    'GitHub should run the repo secret scan on pull requests and main pushes',
  );
});

test('all agent instruction files document the compensating secret-scan control', () => {
  for (const [name, contents] of [
    ['CLAUDE.md', claude],
    ['AGENTS.md', agents],
    ['copilot-instructions.md', copilot],
  ]) {
    assert.match(
      contents,
      /secret scan/i,
      `${name} should tell agents that repo secret scanning is mandatory`,
    );
    assert.match(
      contents,
      /user-owned repo|personal repo|non-provider patterns/i,
      `${name} should explain why repo-level secret scanning exists`,
    );
  }
});
