import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const actionlintWorkflow = readFileSync(
  path.join(repoRoot, '.github', 'workflows', 'actionlint.yml'),
  'utf8',
);
const typecheckWorkflow = readFileSync(
  path.join(repoRoot, '.github', 'workflows', 'typecheck.yml'),
  'utf8',
);
const desktopWorkflow = readFileSync(
  path.join(repoRoot, '.github', 'workflows', 'build-desktop.yml'),
  'utf8',
);
const codeowners = readFileSync(
  path.join(repoRoot, '.github', 'CODEOWNERS'),
  'utf8',
);
const claude = readFileSync(
  path.join(repoRoot, 'CLAUDE.md'),
  'utf8',
);
const agents = readFileSync(
  path.join(repoRoot, 'AGENTS.md'),
  'utf8',
);
const copilot = readFileSync(
  path.join(repoRoot, '.github', 'copilot-instructions.md'),
  'utf8',
);

test('github automation hardening adds actionlint and always-on typecheck coverage', () => {
  assert.match(
    actionlintWorkflow,
    /name: Actionlint[\s\S]*docker run --rm -v "\$PWD:\/repo" -w \/repo rhysd\/actionlint:1\.7\.8/,
    'actionlint workflow should lint GitHub Actions definitions on pull requests and main pushes',
  );
  assert.match(
    typecheckWorkflow,
    /on:\s+pull_request:[\s\S]*push:[\s\S]*main/,
    'typecheck workflow should run on both pull requests and main pushes so it can be required safely',
  );
});

test('desktop publishing is gated behind the release environment', () => {
  assert.match(
    desktopWorkflow,
    /publish-release:[\s\S]*environment:[\s\S]*name: release/,
    'desktop publish job should require the protected release environment',
  );
});

test('release ownership and Claude guidance exist for the hardened release path', () => {
  assert.match(
    codeowners,
    /^\/\.github\/workflows\/ @bradleybond512/m,
    'workflow files should have an explicit owner',
  );
  assert.match(
    claude,
    /## Release Management/,
    'CLAUDE.md should include a dedicated release management section',
  );
  assert.match(
    claude,
    /tag-driven/,
    'CLAUDE.md should document that desktop publishing is tag-driven',
  );
  assert.match(
    claude,
    /npm run release:prepare -- --bump patch --push/,
    'CLAUDE.md should document the supported release command',
  );
  assert.match(
    agents,
    /\.worldmonitor-main-sync\/repo/,
    'AGENTS.md should document the dedicated clean clone used for main sync',
  );
  assert.match(
    copilot,
    /GitHub auto-merge[\s\S]*main-sync:setup/,
    'Copilot instructions should describe the same auto-merge and local main-to-Mac delivery path',
  );
});
