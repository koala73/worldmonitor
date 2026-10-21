import assert from 'node:assert/strict';
import { existsSync, globSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

// `node --test` ignores a path argument that names no file and exits 0
// (Node 24.20.0: `node --test ok.test.mjs missing.test.mjs` runs one test
// and passes), so a listed suite that is deleted or renamed leaves CI with no
// signal. A new api/ or src-tauri/ suite that nobody lists never runs at all.
// Both drifts were live on main (#7772 B, C); this file is what keeps them
// closed. It runs inside test:data on every PR that sets `code`, so every
// SUITE_ROOTS path must classify as code in test.yml (its src-tauri
// exclusion carves node suites back in for exactly this reason).

const root = resolve(import.meta.dirname, '..');
const scripts = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts;
const testWorkflow = readFileSync(resolve(root, '.github/workflows/test.yml'), 'utf8');

const TEST_SCRIPT = /^(?:pre|post)?test(?::|$)/;
const EXTENSIONS = ['mjs', 'mts', 'cjs', 'js', 'ts', 'tsx'];
// A shell word that names a repo file or glob: no expansion and a
// JavaScript/TypeScript extension. Flags never match, and a quoted string
// with spaces splits into words that carry no extension, so
// `-g "matches golden…"` is not mistaken for a path.
const FILE_TOKEN = new RegExp(`^[\\w@./*[\\]{},-]+\\.(?:${EXTENSIONS.join('|')})$`);
const GLOB = /[*[\]{}]/;
const SUITE_ROOTS = ['api', 'src-tauri', 'scripts'];
// The scripts test.yml runs on every code PR (unit-shards, unit-built-output and sidecar). A
// suite owned only by a script no workflow invokes still runs nowhere.
const CI_OWNERS = ['test:data', 'test:sidecar'];

function testScripts() {
  return Object.entries(scripts).filter(([name]) => TEST_SCRIPT.test(name));
}

// npm runs scripts under `sh -c`: the shell strips a word's quotes before
// node sees it, and a word-initial `#` comments out the rest of the line
// (the same rule tests/ci-workflow-coverage.test.mts applies to ci-smoke).
function fileTokens(script) {
  const tokens = [];
  for (const word of script.trim().split(/\s+/)) {
    if (word.startsWith('#')) break;
    const token = word.replace(/^["']|["']$/g, '');
    if (!token.startsWith('-') && FILE_TOKEN.test(token)) tokens.push(token);
  }
  return tokens;
}

// The files a script runs: explicit tokens plus each glob's matches, resolved
// the way scripts/run-data-tests.mjs and `node --test` resolve them.
function coveredFiles(script) {
  const covered = new Set();
  for (const token of fileTokens(script)) {
    for (const file of GLOB.test(token) ? globSync(token, { cwd: root }) : [token]) {
      covered.add(file.split('\\').join('/'));
    }
  }
  return covered;
}

test('the tokenizer sees quoted paths and stops at a shell comment', () => {
  // npm runs scripts under `sh -c`: the shell strips a word's quotes before
  // node sees it, and a word-initial `#` comments out the rest of the line.
  assert.deepEqual(
    fileTokens(`node --test "api/a.test.mjs" 'api/b.test.mjs' --grep "no path here" # api/c.test.mjs`),
    ['api/a.test.mjs', 'api/b.test.mjs'],
  );
});

test('every file a test script names exists on disk', () => {
  const missing = [];
  let tokens = 0;
  for (const [name, script] of testScripts()) {
    for (const token of fileTokens(script)) {
      tokens += 1;
      const path = resolve(root, token);
      const found = GLOB.test(token)
        ? globSync(token, { cwd: root }).length > 0
        : existsSync(path) && statSync(path).isFile();
      if (!found) missing.push(`${name}: ${token}`);
    }
  }
  assert.ok(tokens >= 30, `expected the test scripts to name dozens of files, parsed ${tokens}`);
  assert.deepEqual(
    missing,
    [],
    'node --test exits 0 for a path that names no file, so a deleted or renamed suite silently leaves CI',
  );
});

test('test.yml classifies every guarded src-tauri suite extension as code', () => {
  // This guard runs inside unit and src-tauri suites run in sidecar; both are
  // gated on `code`, and test.yml drops src-tauri/ paths from `code` except
  // for the carve-out below. An extension discovered here but missing there
  // is a suite whose own PR runs neither job.
  const carveOut = testWorkflow.match(/\/\^src-tauri\\\/\.\*\\\.test\\\.\(([a-z|]+)\)\$\/ \{ count\+\+; next \}/);
  assert.ok(carveOut, 'test.yml must carve src-tauri test suites back into code');
  assert.deepEqual(carveOut[1].split('|').sort(), [...EXTENSIONS].sort());
});

test('every api/, src-tauri/ and scripts/ suite is run by a script CI invokes', () => {
  for (const owner of CI_OWNERS) {
    assert.match(
      testWorkflow,
      new RegExp(`npm run ${owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`),
      `test.yml must invoke ${owner}; otherwise it cannot own a suite`,
    );
  }
  const suites = globSync(
    SUITE_ROOTS.map((dir) => `${dir}/**/*.test.{${EXTENSIONS.join(',')}}`),
    { cwd: root, exclude: ['**/node_modules/**', '**/target/**'] },
  ).map((file) => file.split('\\').join('/'));
  assert.ok(suites.length >= 20, `expected the suite discovery glob to find real files, found ${suites.length}`);

  const covered = new Set();
  for (const owner of CI_OWNERS) {
    for (const file of coveredFiles(scripts[owner])) covered.add(file);
  }
  const orphans = suites.filter((suite) => !covered.has(suite)).sort();
  assert.deepEqual(
    orphans,
    [],
    `a suite outside ${CI_OWNERS.join(' and ')} runs nowhere in CI; add it to test:sidecar (plain node --test) or test:data (tsx loader, sharded)`,
  );
});

test('test:sidecar and test:data never run the same file', () => {
  const data = coveredFiles(scripts['test:data']);
  const sidecar = [...coveredFiles(scripts['test:sidecar'])];
  assert.ok(sidecar.length >= 10, `expected test:sidecar to list its suites, parsed ${sidecar.length}`);
  assert.deepEqual(
    sidecar.filter((file) => data.has(file)),
    [],
    'both jobs run on every code PR, so a file in both runs twice (#7772 D)',
  );
});

test('test:data owns every resilience-validation-smoke suite', () => {
  const data = coveredFiles(scripts['test:data']);
  const smoke = [...coveredFiles(scripts['test:resilience-validation-smoke'])];
  assert.ok(smoke.length >= 5, `expected the smoke script to list its suites, parsed ${smoke.length}`);
  assert.deepEqual(
    smoke.filter((file) => !data.has(file)),
    [],
    'resilience-validation-smoke is skipped on code PRs (#7772 A), so test:data must run every file it lists',
  );
});
