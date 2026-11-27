import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { changedFiles, listInventory, parseCli, selectRelatedTests, testDataPatterns } from '../scripts/select-related-tests.mjs';

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'wm-related-'));
  dirs.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

const FILES = {
  'package.json': JSON.stringify({ scripts: { 'test:data': 'node scripts/run-data-tests.mjs tests/*.test.mjs tests/*.test.mts' } }),
  'src/feature.ts': 'export const feature = 1;\n',
  'api/mcp.ts': "import { registry } from './mcp/registry/index.ts';\nexport default registry;\n",
  'api/mcp/registry/index.ts': "export { tools as registry } from './nlp-tools.ts';\n",
  'api/mcp/registry/nlp-tools.ts': 'export const tools = [];\n',
  'server/helper.js': 'module.exports = 1;\n',
  'scripts/railway-services.json': '{}\n',
  'tests/helpers/deps.mjs': "export { feature } from '../../src/feature.ts';\n",
  'tests/static.test.mjs': "import { feature } from '../src/feature.ts';\n",
  'tests/via-helper.test.mjs': "import { feature } from './helpers/deps.mjs';\n",
  // The import that a name-only selector missed in the 2026-11-09 audit.
  'tests/template.test.mjs': 'const mod = await import(`../api/mcp.ts?verify=${Date.now()}`);\n',
  'tests/require.test.mts': "const helper = require('../server/helper.js');\n",
  'tests/reads-config.test.mjs': "readFileSync('scripts/railway-services.json');\n",
  'tests/unrelated.test.mjs': "import assert from 'node:assert';\n",
};

describe('selectRelatedTests', () => {
  const root = fixture(FILES);
  const inventory = listInventory(root);

  it('draws its inventory from the test:data patterns', () => {
    assert.deepEqual(testDataPatterns(root), ['tests/*.test.mjs', 'tests/*.test.mts']);
    assert.ok(!inventory.includes('tests/helpers/deps.mjs'));
    assert.equal(inventory.length, 6);
  });

  it('follows static imports, including through test helpers', () => {
    assert.deepEqual(selectRelatedTests({ root, inventory, changed: ['src/feature.ts'] }), ['tests/static.test.mjs', 'tests/via-helper.test.mjs']);
  });

  it('follows a template-literal dynamic import with a query string, transitively', () => {
    assert.deepEqual(selectRelatedTests({ root, inventory, changed: ['api/mcp/registry/nlp-tools.ts'] }), ['tests/template.test.mjs']);
  });

  it('follows require()', () => {
    assert.deepEqual(selectRelatedTests({ root, inventory, changed: ['server/helper.js'] }), ['tests/require.test.mts']);
  });

  it('selects a test that names a changed non-code path', () => {
    assert.deepEqual(selectRelatedTests({ root, inventory, changed: ['scripts/railway-services.json'] }), ['tests/reads-config.test.mjs']);
  });

  it('selects a changed test file itself', () => {
    assert.deepEqual(selectRelatedTests({ root, inventory, changed: ['tests/unrelated.test.mjs'] }), ['tests/unrelated.test.mjs']);
  });

  it('selects every file when the install, TypeScript config or runner changes', () => {
    for (const file of ['package.json', 'package-lock.json', 'tsconfig.api.json', 'scripts/run-data-tests.mjs']) {
      assert.deepEqual(selectRelatedTests({ root, inventory, changed: [file] }), inventory, file);
    }
  });

  it('selects nothing for a change no test reaches', () => {
    assert.deepEqual(selectRelatedTests({ root, inventory, changed: ['docs/notes.md'] }), []);
  });

  it('selects every entry point into a cycle that reaches a change, whichever test is checked first', () => {
    const cyclic = fixture({
      'package.json': FILES['package.json'],
      'src/a.ts': "import './b.ts';\n",
      'src/b.ts': "import './a.ts';\nimport './changed.ts';\n",
      'src/changed.ts': 'export {};\n',
      'tests/1-enters-at-b.test.mjs': "import '../src/b.ts';\n",
      'tests/2-enters-at-a.test.mjs': "import '../src/a.ts';\n",
    });
    assert.deepEqual(
      selectRelatedTests({ root: cyclic, inventory: listInventory(cyclic), changed: ['src/changed.ts'] }),
      ['tests/1-enters-at-b.test.mjs', 'tests/2-enters-at-a.test.mjs'],
    );
  });

  it('selects tests that import a deleted file, directly or through a helper', () => {
    const deleted = fixture(Object.fromEntries(Object.entries(FILES).filter(([file]) => file !== 'src/feature.ts')));
    assert.deepEqual(
      selectRelatedTests({ root: deleted, inventory: listInventory(deleted), changed: ['src/feature.ts'] }),
      ['tests/static.test.mjs', 'tests/via-helper.test.mjs'],
    );
  });

  it('matches a changed path only at a name boundary', () => {
    const near = fixture({
      'package.json': FILES['package.json'],
      'src/feature.ts': 'export {};\n',
      'tests/longer-name.test.mjs': "readFileSync('src/feature-flags.json');\n",
      'tests/exact-name.test.mjs': "readFileSync('src/feature.ts');\n",
    });
    assert.deepEqual(selectRelatedTests({ root: near, inventory: listInventory(near), changed: ['src/feature.ts'] }), ['tests/exact-name.test.mjs']);
  });

  it('follows tsconfig path aliases, through an aliased module into a relative import', () => {
    const aliased = fixture({
      'package.json': FILES['package.json'],
      // tsconfig allows comments, as the repository's own root config does.
      'tsconfig.json': '{\n  // aliases\n  "compilerOptions": { "paths": { "@/*": ["./src/*"] } }\n}\n',
      'src/services/auth-state.ts': "import { initClerk } from './clerk';\n",
      'src/services/clerk.ts': 'export const initClerk = () => {};\n',
      'tests/auth-state.test.mts': "import { getAuthState } from '@/services/auth-state';\n",
      'tests/unrelated.test.mjs': "import assert from 'node:assert';\n",
    });
    assert.deepEqual(
      selectRelatedTests({ root: aliased, inventory: listInventory(aliased), changed: ['src/services/clerk.ts'] }),
      ['tests/auth-state.test.mts'],
    );
  });

  it('selects every file when tsconfig aliases cannot be read with certainty', () => {
    const configs = {
      'an unparseable config': '{ "compilerOptions": { /* block comment */ "paths": { "@/*": ["./src/*"] } } }\n',
      'paths that may come from an extended config': '{ "extends": "./tsconfig.base.json" }\n',
    };
    for (const [label, config] of Object.entries(configs)) {
      const root = fixture({ ...FILES, 'tsconfig.json': config });
      const inventory = listInventory(root);
      assert.deepEqual(selectRelatedTests({ root, inventory, changed: ['docs/notes.md'] }), inventory, label);
    }
    // A config that exists but cannot be read (here a directory: EISDIR).
    const unreadable = fixture(FILES);
    mkdirSync(join(unreadable, 'tsconfig.json'));
    const inventory = listInventory(unreadable);
    assert.deepEqual(selectRelatedTests({ root: unreadable, inventory, changed: ['docs/notes.md'] }), inventory, 'an unreadable config');
    // No config at all still means no aliases, not select-all.
    assert.deepEqual(selectRelatedTests({ root: fixture(FILES), inventory, changed: ['docs/notes.md'] }), []);
  });

  it('terminates on import cycles', () => {
    const cyclic = fixture({
      'package.json': FILES['package.json'],
      'src/a.ts': "import './b.ts';\n",
      'src/b.ts': "import './a.ts';\n",
      'src/c.ts': 'export {};\n',
      'tests/cycle.test.mjs': "import '../src/a.ts';\n",
    });
    assert.deepEqual(selectRelatedTests({ root: cyclic, inventory: listInventory(cyclic), changed: ['src/c.ts'] }), []);
  });
});

describe('changedFiles', () => {
  it('reports committed, unstaged and untracked changes since the merge base', () => {
    const root = fixture({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, env, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-qm', 'base');
    git('branch', 'base');
    writeFileSync(join(root, 'a.txt'), 'changed\n');
    git('commit', '-qam', 'change a');
    writeFileSync(join(root, 'b.txt'), 'unstaged\n');
    writeFileSync(join(root, 'new.txt'), 'untracked\n');
    writeFileSync(join(root, 'staged.txt'), 'staged\n');
    git('add', 'staged.txt');
    assert.deepEqual(changedFiles(root, 'base'), ['a.txt', 'b.txt', 'new.txt', 'staged.txt']);
  });

  it('reports both paths of a committed rename, so importers of the old path are selected', () => {
    const root = fixture({
      'package.json': FILES['package.json'],
      'src/old-name.ts': 'export const value = 1;\n',
      'tests/helpers/old-dep.mjs': "export { value } from '../../src/old-name.ts';\n",
      'tests/old-name.test.mjs': "import { value } from './helpers/old-dep.mjs';\n",
      'tests/unrelated.test.mjs': "import assert from 'node:assert';\n",
    });
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, env, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-qm', 'base');
    git('branch', 'base');
    git('mv', 'src/old-name.ts', 'src/new-name.ts');
    git('commit', '-qm', 'rename');
    const changed = changedFiles(root, 'base');
    assert.deepEqual(changed, ['src/new-name.ts', 'src/old-name.ts']);
    assert.deepEqual(selectRelatedTests({ root, changed, inventory: listInventory(root) }), ['tests/old-name.test.mjs']);
  });

  it('names the base and the --base flag when there is no merge base', () => {
    const root = fixture({ 'a.txt': 'a\n' });
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'init', '-q', '-b', 'main'], { cwd: root, env });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'only'], { cwd: root, env });
    assert.throws(() => changedFiles(root, 'origin/missing'), /merge base with "origin\/missing".*--base <ref>/);
  });
});

describe('the repository inventory', () => {
  it('includes every pattern test:data runs, not only tests/', () => {
    assert.deepEqual(testDataPatterns(), ['tests/*.test.mjs', 'tests/*.test.mts', 'cli/test/*.test.mjs', 'api/security/report.test.mjs', 'workers/api-cors-preflight/*.test.mjs']);
    const inventory = listInventory();
    for (const prefix of ['tests/', 'cli/test/', 'api/security/', 'workers/api-cors-preflight/']) {
      assert.ok(inventory.some((file) => file.startsWith(prefix)), prefix);
    }
  });
});

describe('parseCli', () => {
  it('rejects --base without a value', () => {
    assert.throws(() => parseCli(['--base']), /--base requires a ref/);
    assert.throws(() => parseCli(['--base=']), /--base requires a ref/);
  });

  it('keeps --base and --list and passes every other argument to the runner', () => {
    assert.deepEqual(parseCli(['--base', 'origin/release', '--concurrency=2', '--list']), { base: 'origin/release', list: true, runnerArgs: ['--concurrency=2'] });
    assert.deepEqual(parseCli(['--base=HEAD~1', '--test-name-pattern', 'x']), { base: 'HEAD~1', list: false, runnerArgs: ['--test-name-pattern', 'x'] });
  });
});
