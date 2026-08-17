// Which runner owns a changed test file (#5795).
//
// `tests/dom/` is a vitest + happy-dom project (vitest.dom.config.mts), every
// other `tests/*.test.{mjs,mts}` file belongs to the node:test runner. The
// pre-push hook used to sweep BOTH into `tsx --test`, so any push touching a
// DOM test failed on unresolvable `vitest` imports and read as "your DOM test
// is broken" — a gate nobody could pass without `--no-verify`.
//
// The partition now lives in scripts/prepush-changed-tests.sh, and this suite
// executes that real script against real files on disk. Two failure modes are
// equally bad and both are asserted below:
//
//   - a DOM file leaking into the node list  -> the loud false failure (#5795)
//   - a test file in NEITHER list            -> a silent coverage gap
//
// The tail of the file adds a (weaker) source-level check that .husky/pre-push
// actually calls the script in both modes. That guard can only prove the
// wiring exists, not that it behaves — the executable cases above carry that.

import { strict as assert } from 'node:assert';
import { after, describe, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'prepush-changed-tests.sh');

// Every mkdtemp below funnels through here so the run leaves nothing behind.
// These fixtures used to accumulate one directory per call in $TMPDIR forever.
const FIXTURE_DIRS = [];
function fixtureDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  FIXTURE_DIRS.push(dir);
  return dir;
}
after(() => {
  for (const dir of FIXTURE_DIRS) rmSync(dir, { recursive: true, force: true });
});

/** Files that exist on disk in the fixture worktree. */
const EXISTING = [
  'tests/handlers.test.mts',
  'tests/resilience-fetch.test.mjs',
  'tests/dom/gate-action.test.mts',
  'tests/dom/legacy-panel.test.mjs',
  'tests/dom/nested/deep-panel.test.mts',
  'tests/dom/helpers/render.mts',
  'tests/fixtures/sample.json',
  'src/services/thing.ts',
];

/**
 * Changed-file list handed to the script. Every entry exists on disk: the hook
 * now passes the paths that exist in the pushed commit
 * (`prepush-attest.sh changed-live`), so a missing one is a broken invariant
 * rather than "the push deleted it" — see the loud-failure case below.
 */
const CHANGED = [...EXISTING];

/** Every changed path that is a test file the repo expects to run somewhere. */
const RUNNABLE_TESTS = EXISTING.filter((f) => /\.test\.(mjs|mts)$/.test(f));

function makeFixtureWorktree(files = EXISTING) {
  const root = fixtureDir('wm-prepush-partition-');
  for (const file of files) {
    mkdirSync(join(root, dirname(file)), { recursive: true });
    writeFileSync(join(root, file), '// fixture\n');
  }
  return root;
}

/** `a.{mts,mjs}` -> [`a.mts`, `a.mjs`]; recurses so multiple groups expand. */
function expandBraces(glob) {
  const match = glob.match(/\{([^{}]*)\}/);
  if (!match) return [glob];
  return match[1]
    .split(',')
    .flatMap((option) => expandBraces(glob.replace(match[0], option.trim())));
}

/** NUL-delimited both ways — a C-quoted or newline-bearing path must survive. */
function nulList(paths) {
  return paths.map((path) => `${path}\0`).join('');
}

function partition(mode, { cwd, changed = CHANGED } = {}) {
  const out = execFileSync('bash', [SCRIPT, mode], {
    cwd,
    input: nulList(changed),
    encoding: 'utf8',
    // execFileSync echoes child stderr to the parent unless stdio is explicit.
    // The cases below deliberately trigger the script's error paths, and this
    // suite runs INSIDE the pre-push gate — so without piping, a successful
    // push prints "ERROR: ... missing from the worktree" twice and reads as a
    // gate that failed. `err.stderr` is still populated, which is what the
    // loud-failure assertions match on.
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return out.split('\0').filter(Boolean);
}

function loadDomTestConfig(env = {}) {
  const probe = join(fixtureDir('wm-dom-config-probe-'), 'probe.mts');
  writeFileSync(
    probe,
    `const m = await import(${JSON.stringify(join(REPO_ROOT, 'vitest.dom.config.mts'))});\n` +
      'console.log(JSON.stringify(m.default?.test ?? null));\n',
  );
  const childEnv = { ...process.env };
  delete childEnv.VITEST_MAX_THREADS;
  Object.assign(childEnv, env);
  const out = execFileSync(join(REPO_ROOT, 'node_modules', '.bin', 'tsx'), [probe], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out.trim().split('\n').at(-1));
}

describe('pre-push changed-test partition', () => {
  const cwd = makeFixtureWorktree();

  test('node mode never hands a tests/dom/ file to the node:test runner', () => {
    const nodeTests = partition('node', { cwd });
    assert.deepEqual(
      nodeTests.filter((f) => f.startsWith('tests/dom/')),
      [],
      'tests/dom/ is a vitest project — `tsx --test` cannot resolve its `vitest` imports',
    );
  });

  test('node mode still sweeps the ordinary node:test files', () => {
    assert.deepEqual(partition('node', { cwd }), [
      'tests/handlers.test.mts',
      'tests/resilience-fetch.test.mjs',
    ]);
  });

  test('dom mode claims every tests/dom/ test file, .mts and .mjs alike', () => {
    // vitest.dom.config.mts includes `tests/dom/**/*.test.{mts,mjs}` — an
    // .mts-only carve-out would strand a file named after the repo's more
    // common .mjs convention in neither runner.
    assert.deepEqual(partition('dom', { cwd }), [
      'tests/dom/gate-action.test.mts',
      'tests/dom/legacy-panel.test.mjs',
      'tests/dom/nested/deep-panel.test.mts',
    ]);
  });

  test('the two modes partition the runnable tests — no overlap, no gap', () => {
    const nodeTests = partition('node', { cwd });
    const domTests = partition('dom', { cwd });

    assert.deepEqual(
      nodeTests.filter((f) => domTests.includes(f)),
      [],
      'a file claimed by both runners would run twice per push',
    );
    assert.deepEqual(
      [...nodeTests, ...domTests].sort(),
      [...RUNNABLE_TESTS].sort(),
      'every changed test file must be claimed by exactly one runner',
    );
  });

  test('drops helpers and fixtures that are not test files', () => {
    for (const mode of ['node', 'dom']) {
      assert.deepEqual(
        partition(mode, { cwd }).filter((f) => !/\.test\.(mjs|mts)$/.test(f)),
        [],
        `${mode} mode must not run helpers or fixtures`,
      );
    }
  });

  test('a test file missing from the worktree fails loudly instead of vanishing', () => {
    // #5800: the old `[ -f "$file" ] || continue` read "absent from disk" as
    // "the push deleted it". It could just as easily mean the worktree drifted
    // from the commit being pushed — an unstaged `rm` of a changed test made
    // the gate skip it and report green. Deletion is now filtered upstream by
    // git, so absence here has exactly one meaning and must stop the push.
    for (const [mode, missing] of [
      ['node', 'tests/never-written.test.mjs'],
      ['dom', 'tests/dom/never-written.test.mts'],
    ]) {
      assert.throws(
        () => partition(mode, { cwd, changed: [...EXISTING, missing] }),
        (err) => err.status === 1 && /missing from the worktree/.test(String(err.stderr)),
        `${mode} mode must refuse a path it cannot run`,
      );
    }
  });

  test('a path containing a newline stays one path', () => {
    // The reason the list is NUL-delimited: a line reader would split this
    // into two entries, neither of which exists, and the old code would have
    // silently dropped both.
    const weird = 'tests/two\nlines.test.mjs';
    const root = makeFixtureWorktree([weird]);
    assert.deepEqual(partition('node', { cwd: root, changed: [weird] }), [weird]);
  });

  test('an unknown mode fails loudly instead of silently emitting nothing', () => {
    // A typo'd mode that exits 0 with empty output reads exactly like "no test
    // files changed", which is how a coverage gap hides.
    assert.throws(
      () => partition('dmo', { cwd }),
      (err) => err.status === 2,
      'unknown mode must exit non-zero',
    );
  });

  test('exits 0 when nothing in the push is a test file', () => {
    for (const mode of ['node', 'dom']) {
      assert.deepEqual(partition(mode, { cwd, changed: ['src/services/thing.ts'] }), []);
    }
  });
});

describe('partition stays in step with the vitest DOM project', () => {
  // The partition hard-codes `tests/dom/` as the vitest-owned prefix. The
  // config is what actually decides ownership, so widening the DOM project to
  // another directory without teaching the partition about it would send those
  // files back to `tsx --test` — #5795 again, in a new directory. Assert
  // against the real resolved config, not its source text.
  //
  // Resolved in a CHILD process on purpose: importing it here would pull
  // vitest/config (~220MB RSS) into the shared `npm run test:data` runner,
  // which already OOMs at the tail of its ~390-file single-process run.
  const defaultConfig = loadDomTestConfig();
  const include = defaultConfig.include;

  test('every DOM include glob lives under the prefix the partition claims', () => {
    assert.ok(Array.isArray(include) && include.length > 0, 'DOM config must declare test.include');
    assert.deepEqual(
      include.filter((glob) => !glob.startsWith('tests/dom/')),
      [],
      'a DOM include outside tests/dom/ needs a matching case in scripts/prepush-changed-tests.sh',
    );
  });

  test('the partition claims a sample file from every DOM include glob', () => {
    // Semantic, not token-matching: an earlier version of this test scanned the
    // globs for the `mts`/`mjs` tokens it already expected, so adding
    // `tests/dom/**/*.test.js` or `tests/dom/**/*.spec.mts` to the config
    // stayed green while those files matched vitest and NEITHER partition.
    // Building a concrete path per glob and asking the real script who owns it
    // catches any include shape, known or not.
    const samples = include.flatMap(expandBraces).flatMap((glob) => [
      glob.replace(/\*\*\//g, '').replace(/\*/g, 'sample'),
      glob.replace(/\*\*\//g, 'nested/').replace(/\*/g, 'sample'),
    ]);

    assert.ok(samples.length > 0, 'DOM config must declare test.include');
    assert.deepEqual(
      samples.filter((path) => path.includes('*') || path.includes('{')),
      [],
      'unhandled glob syntax — this test cannot vouch for an include it cannot sample',
    );

    const cwd = makeFixtureWorktree(samples);
    assert.deepEqual(
      samples.filter((path) => !partition('dom', { cwd, changed: samples }).includes(path)),
      [],
      'a vitest-owned file the partition does not claim runs in NO runner (#5795)',
    );
  });

  test('the DOM half actually invokes vitest with the DOM project config', () => {
    // The hook calls `npm run test:dom`; nothing else pins what that script
    // does. Rewritten to a successful no-op, the hook and CI both stay green
    // with vitest never running.
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    assert.match(pkg.scripts['test:dom'], /vitest run --config vitest\.dom\.config\.mts/);
  });

  test('the local hook can cap vitest workers without slowing CI by default', () => {
    assert.equal(defaultConfig.maxWorkers, undefined);
    assert.equal(loadDomTestConfig({ VITEST_MAX_THREADS: '2' }).maxWorkers, 2);
    assert.throws(
      () => loadDomTestConfig({ VITEST_MAX_THREADS: 'not-a-number' }),
      /VITEST_MAX_THREADS must be a positive integer/,
    );
  });
});

describe('runner dispatch', () => {
  // The hook used to hold "is this list empty, and which runner do I invoke"
  // inline, where only a source grep could guard it — and a source grep stays
  // green when `-n` becomes `-z` or `|| exit 1` is dropped, silently skipping
  // the suite. The decision now lives in the script, so these run it for real
  // against stubbed runners and assert what was invoked.
  function runDispatch(mode, list, { stubExit = 0, concurrency } = {}) {
    const dir = fixtureDir('wm-prepush-dispatch-');
    const log = join(dir, 'invocations.log');
    for (const bin of ['npm', 'npx']) {
      const stub = join(dir, bin);
      writeFileSync(stub, `#!/bin/sh\necho "${bin} $*" >> ${JSON.stringify(log)}\nexit ${stubExit}\n`);
      chmodSync(stub, 0o755);
    }

    let status = 0;
    try {
      execFileSync('bash', [SCRIPT, mode], {
        cwd: REPO_ROOT,
        input: nulList(list),
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          ...(concurrency ? { WM_PREPUSH_TEST_CONCURRENCY: concurrency } : {}),
        },
      });
    } catch (err) {
      status = err.status;
    }

    return { status, invocations: existsSync(log) ? readFileSync(log, 'utf8').trim() : '' };
  }

  test('a changed DOM test runs the vitest project', () => {
    const { status, invocations } = runDispatch('run-dom', ['tests/dom/gate-action.test.mts']);
    assert.equal(status, 0);
    assert.equal(invocations, 'npm run test:dom');
  });

  test('an empty DOM list runs nothing and does not fail the push', () => {
    const { status, invocations } = runDispatch('run-dom', []);
    assert.equal(status, 0);
    assert.equal(invocations, '');
  });

  test('a failing DOM suite fails the push', () => {
    // The whole point of the gate. A dispatch that swallowed the runner's exit
    // status would report green over a red suite.
    const { status } = runDispatch('run-dom', ['tests/dom/gate-action.test.mts'], { stubExit: 1 });
    assert.notEqual(status, 0);
  });

  test('changed node tests go to tsx --test with their exact paths', () => {
    const { status, invocations } = runDispatch('run-node', [
      'tests/handlers.test.mts',
      'tests/a b.test.mjs',
    ]);
    assert.equal(status, 0);
    // Quoted expansion — the path with a space stays one argument.
    assert.match(
      invocations,
      /^npx tsx --test --test-concurrency=2 tests\/handlers\.test\.mts tests\/a b\.test\.mjs$/,
    );
  });

  test('changed node tests honor an explicit local worker cap', () => {
    const { status, invocations } = runDispatch(
      'run-node',
      ['tests/handlers.test.mts'],
      { concurrency: '3' },
    );
    assert.equal(status, 0);
    assert.equal(invocations, 'npx tsx --test --test-concurrency=3 tests/handlers.test.mts');
  });

  test('an empty node list runs nothing and does not fail the push', () => {
    const { status, invocations } = runDispatch('run-node', []);
    assert.equal(status, 0);
    assert.equal(invocations, '');
  });

  test('a failing node suite fails the push', () => {
    const { status } = runDispatch('run-node', ['tests/handlers.test.mts'], { stubExit: 1 });
    assert.notEqual(status, 0);
  });
});

describe('pre-push hook wiring', () => {
  const hook = readFileSync(join(REPO_ROOT, '.husky', 'pre-push'), 'utf8');

  test('routes both partitions through the shared script', () => {
    assert.match(hook, /prepush-changed-tests\.sh node/);
    assert.match(hook, /prepush-changed-tests\.sh dom/);
  });

  test('no longer sweeps tests/ with its own inline glob', () => {
    // The inline sweep is what swallowed tests/dom/; reintroducing one beside
    // the script would resurrect #5795 with the partition still passing.
    // Quote-agnostic — the original used double quotes, but a single-quoted
    // rewrite is the same bug.
    assert.doesNotMatch(hook, /grep -E ['"]\^tests\//);
  });

  test('dispatches both runners unconditionally, failing the push on error', () => {
    // Unconditional on purpose — the empty-list check lives in the script,
    // where `runner dispatch` above executes it. A reintroduced inline
    // `if [ -n ... ]` here would move that decision back out of test reach.
    assert.match(hook, /prepush-changed-tests\.sh run-node \|\| exit 1/);
    assert.match(hook, /prepush-changed-tests\.sh run-dom \|\| exit 1/);
  });

  test('treats a partition failure as a blocked push, not an empty test list', () => {
    // A discarded exit status yields an empty list, which the hook reads as
    // "no test files changed" and skips everything. The gate must fail loudly.
    for (const mode of ['node', 'dom']) {
      const guarded = new RegExp(
        `if ! [^\\n]*prepush-changed-tests\\.sh ${mode} >[^\\n]*\\n\\s*echo "ERROR[^\\n]*\\n\\s*exit 1`,
      );
      assert.ok(guarded.test(hook), `the ${mode} partition must be checked and abort the push`);
    }
  });

  test('hands the partition NUL-delimited paths, not a newline-joined string', () => {
    // `printf '%s\\n' "$LIST"` is what lost C-quoted and space-bearing paths
    // (#5800); command substitution cannot carry NUL, so the lists move
    // through files and `nul_list`.
    assert.ok(
      !/printf '%s\\n'[^\n]*prepush-changed-tests\.sh/.test(hook),
      'a newline-joined round trip re-introduces the quoting loss',
    );
    for (const mode of ['node', 'dom', 'run-node', 'run-dom']) {
      assert.ok(
        new RegExp(`nul_list [^\\n]*prepush-changed-tests\\.sh ${mode}`).test(hook),
        `${mode} must receive a NUL-delimited list`,
      );
    }
  });

  test('runs the contract tests when any file in the routing contract changes', () => {
    // The contract spans the hook, both scripts it delegates to, the vitest
    // project, and the npm script. Guarding only the partition script left the
    // assertions absent exactly when the thing they pin was being rewritten.
    for (const path of [
      '\\.husky/pre-push',
      'scripts/prepush-admission\\.mjs',
      'scripts/prepush-changed-tests\\.sh',
      'scripts/prepush-attest\\.sh',
      'vitest\\.dom\\.config\\.mts',
      'package\\.json',
    ]) {
      assert.ok(
        hook.includes(path),
        `pre-push must re-run the contract tests when ${path} changes`,
      );
    }
    for (const testFile of [
      'tests/prepush-admission.test.mjs',
      'tests/prepush-changed-tests.test.mjs',
      'tests/prepush-attest.test.mjs',
    ]) {
      assert.ok(hook.includes(testFile), `${testFile} must be in the contract-test list`);
    }
  });

  test('caps every direct node:test runner in the hook', () => {
    const directRuns = hook
      .split('\n')
      .filter((line) => line.includes('npx tsx --test'));

    assert.equal(directRuns.length, 3);
    assert.ok(
      directRuns.every((line) =>
        line.includes('--test-concurrency="$WM_PREPUSH_TEST_CONCURRENCY"'),
      ),
      'every direct node:test runner must use the configured worker cap',
    );
  });

  test('exports VITEST_MAX_THREADS from the configured worker cap', () => {
    assert.match(
      hook,
      /export VITEST_MAX_THREADS="\$\{VITEST_MAX_THREADS:-\$WM_PREPUSH_TEST_CONCURRENCY\}"/,
    );
  });
});
