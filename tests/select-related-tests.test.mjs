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
    assert.deepEqual(changedFiles(root, 'base'), ['a.txt', 'b.txt', 'new.txt']);
  });
});

describe('parseCli', () => {
  it('keeps --base and --list and passes every other argument to the runner', () => {
    assert.deepEqual(parseCli(['--base', 'origin/release', '--concurrency=2', '--list']), { base: 'origin/release', list: true, runnerArgs: ['--concurrency=2'] });
    assert.deepEqual(parseCli(['--base=HEAD~1', '--test-name-pattern', 'x']), { base: 'HEAD~1', list: false, runnerArgs: ['--test-name-pattern', 'x'] });
  });
});
