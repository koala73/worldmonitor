import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { partitionTests, readsBuiltOutput, selectByBuiltOutput } from '../scripts/run-data-tests.mjs';
import { blendDurations, refreshDurations } from '../scripts/refresh-data-test-durations.mjs';

const root = resolve(import.meta.dirname, '..');
const runner = join(root, 'scripts/run-data-tests.mjs');
const durations = JSON.parse(readFileSync(join(root, 'scripts/shared/data-test-durations.json'), 'utf8'));
// The shard count comes from the workflow, not a literal here: the proof below
// is that the shards CI actually runs cover the inventory exactly once, and a
// count pinned in this file would keep passing after the matrix changed.
const workflow = parse(readFileSync(join(root, '.github/workflows/test.yml'), 'utf8'));
const ciShards = workflow.jobs['unit-shards'].strategy.matrix.shard;
const ciShardCount = ciShards.length;
const [, , ...patterns] = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  .scripts['test:data'].trim().split(/\s+/);
const inventory = globSync(patterns, { cwd: root });
const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;
const run = (args) => spawnSync(process.execPath, [runner, ...args], { cwd: root, encoding: 'utf8', timeout: 30_000, env: childEnv });

test('refresh uses hosted medians, adds measured files and retains unmeasured estimates', () => {
  const row = (file, duration_ms, passed = 1) => ({ file, duration_ms, success: true, counts: { passed } });
  const previous = { slow: 1, unmeasured: 42, skipped: 100 };
  const complete = (...rows) => [...rows, row(null, 500)];
  const artifacts = [
    complete(row('slow', 200), row('new', 10), row('deleted', 1), row('skipped', 2, 0)),
    complete(row('slow', 100), row('new', 21)),
    complete(row('slow', 900)),
  ];
  assert.deepEqual(refreshDurations(previous, new Set(['slow', 'new', 'unmeasured', 'skipped']), artifacts),
    { new: 16, skipped: 100, slow: 200, unmeasured: 42 });
  assert.deepEqual(previous, { slow: 1, unmeasured: 42, skipped: 100 });
});

test('refresh rejects failed, empty, duplicate and invalid timing input', () => {
  const row = { file: 'suite', duration_ms: 10, success: true, counts: { passed: 1 } };
  const inventory = new Set(['suite']);
  const complete = (...rows) => [[...rows, { file: null, success: true }]];
  for (const artifacts of [[], [[]], complete({ ...row, success: false }), [[row, { file: null, success: false }]],
    complete(row, row), complete({ ...row, duration_ms: 0 }), complete({ ...row, duration_ms: NaN }),
    complete({ ...row, counts: { passed: 0 } }), complete({ ...row, file: 'deleted' })]) {
    assert.throws(() => refreshDurations({}, inventory, artifacts));
  }
});

test('refresh rejects a truncated artifact even when every written file passed', () => {
  const row = { file: 'suite', duration_ms: 10, success: true, counts: { passed: 1 } };
  const inventory = new Set(['suite']);
  assert.throws(() => refreshDurations({}, inventory, [[row]]), /successful aggregate summary/);
  assert.throws(() => refreshDurations({}, inventory, [[{ file: null, success: true }, row]]), /successful aggregate summary/);
  assert.deepEqual(refreshDurations({}, inventory, [[row, { file: null, success: true }]]), { suite: 10 });
});

test('refresh rejects invalid existing state instead of discarding unmeasured estimates', () => {
  const artifacts = [[{ file: 'suite', duration_ms: 10, success: true, counts: { passed: 1 } }, { file: null, success: true }]];
  for (const previous of [null, [], 1, 'invalid', { unmeasured: 0 }, { unmeasured: '10' }, { unmeasured: -1 }]) {
    assert.throws(() => refreshDurations(previous, new Set(['suite']), artifacts), /object of positive numbers/);
  }
});

test('CI blend moves estimates halfway, adds new files, drops deleted ones and skips incomplete shards', () => {
  const row = (file, duration_ms, success = true) => ({ file, duration_ms, success, counts: { passed: 1 } });
  const done = (...rows) => [...rows, { file: null, success: true }];
  const previous = { slow: 100, unmeasured: 42, deleted: 7, flaky: 10 };
  const inventory = new Set(['slow', 'new', 'unmeasured', 'flaky']);
  const artifacts = [
    done(row('slow', 301), row('new', 20)),
    // A failed shard: its passing files are not trusted either.
    [row('flaky', 9000), row('slow', 1), row('other', 1, false), { file: null, success: false }],
    // A shard killed before its aggregate summary, and one whose JSONL did not parse.
    [row('flaky', 9000)],
    null,
  ];
  assert.deepEqual(blendDurations(previous, inventory, artifacts), {
    estimates: { flaky: 10, new: 20, slow: 201, unmeasured: 42 },
    shards: 1,
    measured: 2,
  });
  assert.deepEqual(previous, { slow: 100, unmeasured: 42, deleted: 7, flaky: 10 });
  assert.equal(blendDurations(previous, inventory, []), null);
  assert.equal(blendDurations(previous, inventory, artifacts.slice(1)), null);
  assert.throws(() => blendDurations({ slow: 0 }, inventory, artifacts), /object of positive numbers/);
  assert.throws(() => blendDurations(previous, inventory, [done(row('slow', 1), row('slow', 2))]), /Duplicate/);
});

test('--durations places files by the given estimates, and every shard still covers the inventory once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wm-durations-'));
  try {
    const sharded = JSON.parse(run([...patterns, '--built-output=exclude', '--list']).stdout);
    const heavy = sharded.at(-1);
    const estimates = join(dir, 'durations.json');
    writeFileSync(estimates, JSON.stringify({ ...durations, [heavy]: 1e12 }));
    const shards = ciShards.map((index) => {
      const result = run([...patterns, '--built-output=exclude', `--shard=${index}/${ciShardCount}`, `--durations=${estimates}`, '--list']);
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    });
    // The heaviest file is placed first, alone on shard 1.
    assert.deepEqual(shards[0], [heavy]);
    assert.deepEqual(shards.flat().sort(), [...sharded].sort());
    for (const content of ['[]', 'null', '{"a": 0}']) {
      writeFileSync(estimates, content);
      const result = run([...patterns, '--built-output=exclude', '--shard=1/2', `--durations=${estimates}`, '--list']);
      assert.notEqual(result.status, 0, content);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every unit shard reads the one durations entry the run looked up, and one shard in turn saves after every run, red or green', () => {
  const changes = workflow.jobs.changes;
  const lookup = changes.steps.find((step) => step.id === 'durations');
  assert.equal(lookup.with['lookup-only'], true);
  assert.equal(lookup['continue-on-error'], true);
  assert.equal(changes.outputs.durations_key, '${{ steps.durations.outputs.cache-matched-key }}');
  const prefix = lookup.with['restore-keys'];
  const path = lookup.with.path;
  assert.equal(path, '~/data-test-durations/durations.json');

  const steps = workflow.jobs['unit-shards'].steps;
  const index = (name) => steps.findIndex((step) => step.name === name);
  const restore = steps[index('Restore the newest measured durations')];
  // Exact key, no fallback: a shard on other estimates would partition differently.
  assert.equal(restore.with.key, '${{ needs.changes.outputs.durations_key }}');
  assert.equal(restore.with['restore-keys'], undefined);
  assert.equal(restore.with['fail-on-cache-miss'], true);
  assert.equal(restore.with.path, path);
  const testStep = steps[index('Data tests without built output')];
  assert.equal(testStep.env.DURATIONS_KEY, restore.with.key);
  assert.match(testStep.run, /\$\{DURATIONS_KEY:\+--durations="\$HOME\/data-test-durations\/durations\.json"\}/);

  const blend = steps[index("Blend this shard's timings into the estimates")];
  const save = steps[index('Save the estimates for the next run')];
  assert.ok(index('Data tests without built output') < steps.indexOf(blend) && steps.indexOf(blend) < steps.indexOf(save));
  for (const step of [blend, save]) {
    // Saved after failing runs too, and never the reason a shard is red.
    assert.match(step.if, /!cancelled\(\)/);
    assert.equal(step['continue-on-error'], true);
  }
  assert.match(blend.run, /refresh-data-test-durations\.mjs --blend/);
  // One shard saves per run: the one after the shard whose entry was restored,
  // so the turn rotates within the cache scope; a red saver passes it on.
  assert.equal(blend.env.SHARD, '${{ matrix.shard }}');
  assert.equal(blend.env.SHARD_TOTAL, '${{ strategy.job-total }}');
  assert.match(blend.run, /saver=\$\(\( last % SHARD_TOTAL \+ 1 \)\)/);
  assert.match(blend.run, /\[ -f "\$next" \] \|\| cp "\$previous" "\$next"/);
  // The lookup key must not prefix-match any saved entry, or a re-run of an
  // old run would restore its own stale entry ahead of the newest.
  assert.ok(!lookup.with.key.includes('github.run_id') && !/^data-test-durations-v1-\d/.test(lookup.with.key), lookup.with.key);
  assert.ok(save.uses.startsWith('actions/cache/save@'));
  assert.ok(save.with.key.startsWith(prefix), `${save.with.key} must match restore-keys ${prefix}`);
  assert.match(save.with.key, /matrix\.shard/);
  assert.equal(save.with.path, path);
});

test('the shards and the built-output job together execute the complete data inventory exactly once, including new files', () => {
  assert.ok(ciShardCount >= 2, `unit-shards matrix must list at least two shards, got ${JSON.stringify(ciShards)}`);
  assert.deepEqual(ciShards, Array.from({ length: ciShardCount }, (_, i) => i + 1), 'shard indices must be 1..N');
  const shards = ciShards.map((index) => {
    const result = run([...patterns, '--built-output=exclude', `--shard=${index}/${ciShardCount}`, '--list']);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  });
  const builtRun = run([...patterns, '--built-output=only', '--list']);
  assert.equal(builtRun.status, 0, builtRun.stderr);
  const built = JSON.parse(builtRun.stdout);
  const all = [...shards.flat(), ...built];
  assert.deepEqual(all.sort(), [...inventory].sort());
  assert.equal(new Set(all).size, inventory.length);
  assert.ok(shards.every((files) => files.length > 0), 'no CI shard may be empty');
  assert.ok(all.includes('api/security/report.test.mjs'));
  assert.ok(all.some((file) => file.startsWith('cli/test/')));
  const withNewFile = partitionTests([...inventory, 'tests/new-unmeasured.test.mts'], durations, ciShardCount).flat();
  assert.equal(withNewFile.filter((file) => file === 'tests/new-unmeasured.test.mts').length, 1);
  const full = run([...patterns, '--list']);
  assert.equal(full.status, 0, full.stderr);
  assert.deepEqual(JSON.parse(full.stdout).sort(), [...inventory].sort());
});

test('suites that read built output run in the job that builds it', () => {
  const builtRun = run([...patterns, '--built-output=only', '--list']);
  assert.equal(builtRun.status, 0, builtRun.stderr);
  const built = new Set(JSON.parse(builtRun.stdout));
  // Every suite wired to the shared guards must land in the build job: in a
  // shard it would fail on the missing tree rather than prove anything.
  for (const file of inventory) {
    const source = readFileSync(join(root, file), 'utf8');
    if (/built-output-guard|pro-built-output/.test(source)) assert.ok(built.has(file), `${file} imports a built-output guard`);
  }
  for (const file of ['tests/dashboard-eager-chunks.test.mjs', 'tests/pro-welcome-prerender.test.mjs', 'tests/deploy-config.test.mjs']) {
    assert.ok(built.has(file), `${file} reads dist/ or public/pro/`);
  }
  // Loads pro-test/vite.config.ts, whose plugins resolve from pro-test/node_modules;
  // only build:pro installs that tree in CI (ERR_MODULE_NOT_FOUND in a shard, #8752).
  for (const file of ['tests/sentry-release-build.test.mts']) {
    assert.ok(built.has(file), `${file} needs pro-test's install`);
  }
  assert.ok(built.size < inventory.length / 4, `the built-output job should hold a small slice, got ${built.size}`);
});

test('built-output classification matches the paths and guards suites use', () => {
  for (const source of [
    "readFileSync('dist/index.html')",
    'resolve(root, "public/pro/welcome.html")',
    'const page = `${root}/dist/pro.html`',
    "import { guardBuiltOutput } from './_lib/built-output-guard.mjs'",
    "import { shouldSkipProBuiltOutput } from './_lib/pro-built-output.mjs'",
    "process.env.WM_EXPECT_BUILT_OUTPUT === '1'",
    "resolve('pro-test/node_modules/.cache')",
    "['marketing', 'pro-test/vite.config.ts']",
  ]) assert.equal(readsBuiltOutput(source), true, source);
  for (const source of ["readFileSync('src/main.ts')", 'const distance = 3;', "readFileSync('public/favicon.ico')", 'const redistribute = 1;', "readFileSync('pro-test/src/main.ts')"]) {
    assert.equal(readsBuiltOutput(source), false, source);
  }
  const sources = { a: "readFileSync('dist/x')", b: 'plain' };
  assert.deepEqual(selectByBuiltOutput(['a', 'b'], 'only', (f) => sources[f]), ['a']);
  assert.deepEqual(selectByBuiltOutput(['a', 'b'], 'exclude', (f) => sources[f]), ['b']);
  assert.deepEqual(selectByBuiltOutput(['a', 'b'], 'all', (f) => sources[f]), ['a', 'b']);
  assert.throws(() => selectByBuiltOutput(['a'], 'some', (f) => sources[f]), /all, only or exclude/);
});

test('duration balancing is deterministic and separates expensive files', () => {
  const costs = { slow: 100, medium: 80, small: 20, tiny: 10 };
  const expected = [['slow', 'tiny'], ['medium', 'small']];
  assert.deepEqual(partitionTests(Object.keys(costs), costs, 2), expected);
  assert.deepEqual(partitionTests(Object.keys(costs).reverse(), costs, 2), expected);
  const sharded = selectByBuiltOutput(inventory, 'exclude', (file) => readFileSync(join(root, file), 'utf8'));
  const shards = partitionTests(sharded, durations, ciShardCount);
  const weights = shards.map((files) => files.reduce((sum, file) => sum + (durations[file] ?? 1000), 0));
  assert.ok(Math.max(...weights) - Math.min(...weights) <= 1000, `unbalanced estimates: ${weights}`);
});

test('invalid selection fails instead of succeeding with no tests', () => {
  for (const args of [[], ['missing.test.mjs'], [...patterns, '--shard=0/2'], [...patterns, '--shard=3/2'], [...patterns, '--concurrency=0'], [...patterns, '--built-output=some'], [...patterns, '--file-timeout=0'], [...patterns, '--file-timeout=5s'], ['tests/data-test-shards.test.mjs', '--built-output=exclude']]) {
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

// A file whose tests all pass but which leaves a handle open never exits, and
// node:test's per-test timeout cannot see it. unit-shard (5) sat silent for 14
// minutes that way on 2098d920ae until the job timeout, naming no file.
test('real runner names and fails a file that outlives the per-file budget', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wm-data-shard-'));
  try {
    const leaking = join(dir, 'leaks-handle.test.mjs');
    const healthy = join(dir, 'healthy.test.mjs');
    writeFileSync(leaking, "import { test } from 'node:test'; test('passes but leaves an interval', () => { setInterval(() => {}, 1000); });\n");
    writeFileSync(healthy, "import { test } from 'node:test'; test('healthy', () => {});\n");
    const started = Date.now();
    const result = run([healthy, leaking, '--file-timeout=2000']);
    assert.equal(result.error, undefined, 'the runner must stop itself before the 30s spawn cap');
    assert.ok(Date.now() - started < 20_000);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /leaks-handle\.test\.mjs/);
    assert.doesNotMatch(result.stderr, /healthy\.test\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
