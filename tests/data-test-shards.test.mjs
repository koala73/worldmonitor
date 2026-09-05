import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { partitionTests } from '../scripts/run-data-tests.mjs';

const root = resolve(import.meta.dirname, '..');
const runner = join(root, 'scripts/run-data-tests.mjs');
const durations = JSON.parse(readFileSync(join(root, 'scripts/shared/data-test-durations.json'), 'utf8'));
const patterns = ['tests/*.test.mjs', 'tests/*.test.mts', 'cli/test/*.test.mjs', 'api/security/report.test.mjs'];
const inventory = globSync(patterns, { cwd: root });
const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;
const run = (args) => spawnSync(process.execPath, [runner, ...args], { cwd: root, encoding: 'utf8', timeout: 30_000, env: childEnv });

test('both shards execute the complete data inventory exactly once, including new files', () => {
  const shards = [1, 2].map((index) => {
    const result = run([...patterns, `--shard=${index}/2`, '--list']);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  });
  assert.deepEqual(shards.flat().sort(), [...inventory].sort());
  assert.equal(new Set(shards.flat()).size, inventory.length);
  assert.ok(shards.flat().includes('api/security/report.test.mjs'));
  assert.ok(shards.flat().some((file) => file.startsWith('cli/test/')));
  const withNewFile = partitionTests([...inventory, 'tests/new-unmeasured.test.mts'], durations, 2).flat();
  assert.equal(withNewFile.filter((file) => file === 'tests/new-unmeasured.test.mts').length, 1);
  const full = run([...patterns, '--list']);
  assert.equal(full.status, 0, full.stderr);
  assert.deepEqual(JSON.parse(full.stdout).sort(), [...inventory].sort());
});

test('duration balancing is deterministic and separates expensive files', () => {
  const costs = { slow: 100, medium: 80, small: 20, tiny: 10 };
  const expected = [['slow', 'tiny'], ['medium', 'small']];
  assert.deepEqual(partitionTests(Object.keys(costs), costs, 2), expected);
  assert.deepEqual(partitionTests(Object.keys(costs).reverse(), costs, 2), expected);
  const shards = partitionTests(inventory, durations, 2);
  const weights = shards.map((files) => files.reduce((sum, file) => sum + (durations[file] ?? 1000), 0));
  assert.ok(Math.abs(weights[0] - weights[1]) <= 1000, `unbalanced estimates: ${weights}`);
});

test('invalid selection fails instead of succeeding with no tests', () => {
  for (const args of [[], ['missing.test.mjs'], [...patterns, '--shard=0/2'], [...patterns, '--shard=3/2'], [...patterns, '--concurrency=0']]) {
    const result = run([...args, '--list']);
    assert.notEqual(result.status, 0, JSON.stringify(args));
    assert.equal(result.stdout, '');
  }
  assert.throws(() => partitionTests(['a'], { a: -1 }, 2), /positive/);
});

test('real runner retains failures, built-output environment and timing evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wm-data-shard-'));
  try {
    const passing = join(dir, 'space café[case].test.mjs');
    const failing = join(dir, 'failure.test.mjs');
    const timings = join(dir, 'timings.jsonl');
    writeFileSync(passing, "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('built marker', () => assert.equal(process.env.WM_EXPECT_BUILT_OUTPUT, '1'));\n");
    writeFileSync(failing, "import { test } from 'node:test'; test('failure', () => { throw new Error('fixture failure'); });\n");
    const success = spawnSync(process.execPath, [runner, passing, '--timings', timings], {
      cwd: root, encoding: 'utf8', timeout: 30_000, env: { ...childEnv, WM_EXPECT_BUILT_OUTPUT: '1' },
    });
    assert.equal(success.status, 0, success.stdout + success.stderr);
    const rows = readFileSync(timings, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(rows.filter((row) => row.file).length, 1);
    assert.equal(rows.at(-1).success, true);
    assert.equal(rows.at(-1).counts.tests, 1);
    const failure = run([failing]);
    assert.equal(failure.status, 1, failure.stdout + failure.stderr);
    assert.match(failure.stdout, /fixture failure/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
