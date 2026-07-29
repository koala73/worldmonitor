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
import { describe, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'prepush-changed-tests.sh');

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

/** Changed-file list handed to the script — a superset of what exists. */
const CHANGED = [...EXISTING, 'tests/removed.test.mjs', 'tests/dom/removed.test.mts'];

/** Every changed path that is a test file the repo expects to run somewhere. */
const RUNNABLE_TESTS = EXISTING.filter((f) => /\.test\.(mjs|mts)$/.test(f));

function makeFixtureWorktree(files = EXISTING) {
  const root = mkdtempSync(join(tmpdir(), 'wm-prepush-partition-'));
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

function partition(mode, { cwd, changed = CHANGED } = {}) {
  const out = execFileSync('bash', [SCRIPT, mode], {
    cwd,
    input: `${changed.join('\n')}\n`,
    encoding: 'utf8',
  });
  return out.split('\n').filter(Boolean);
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

  test('drops non-test files and files deleted by the push', () => {
    for (const mode of ['node', 'dom']) {
      const picked = partition(mode, { cwd });
      assert.deepEqual(
        picked.filter((f) => !/\.test\.(mjs|mts)$/.test(f)),
        [],
        `${mode} mode must not run helpers or fixtures`,
      );
      assert.deepEqual(
        picked.filter((f) => f.endsWith('removed.test.mjs') || f.endsWith('removed.test.mts')),
        [],
        `${mode} mode must skip paths the push deleted`,
      );
    }
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
  const include = (() => {
    const probe = join(mkdtempSync(join(tmpdir(), 'wm-dom-config-probe-')), 'probe.mts');
    writeFileSync(
      probe,
      `const m = await import(${JSON.stringify(join(REPO_ROOT, 'vitest.dom.config.mts'))});\n` +
        'console.log(JSON.stringify(m.default?.test?.include ?? null));\n',
    );
    const out = execFileSync(join(REPO_ROOT, 'node_modules', '.bin', 'tsx'), [probe], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    return JSON.parse(out.trim().split('\n').at(-1));
  })();

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
});

describe('runner dispatch', () => {
  // The hook used to hold "is this list empty, and which runner do I invoke"
  // inline, where only a source grep could guard it — and a source grep stays
  // green when `-n` becomes `-z` or `|| exit 1` is dropped, silently skipping
  // the suite. The decision now lives in the script, so these run it for real
  // against stubbed runners and assert what was invoked.
  function runDispatch(mode, list, { stubExit = 0 } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'wm-prepush-dispatch-'));
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
        input: `${list.join('\n')}\n`,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
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
    assert.match(invocations, /^npx tsx --test tests\/handlers\.test\.mts tests\/a b\.test\.mjs$/);
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
    // Command substitution discards the exit status: a missing or broken
    // helper would yield an empty list, which the hook reads as "no test files
    // changed" and skips everything. The gate must fail loudly instead.
    assert.match(hook, /if ! TESTS_CHANGED=\$\(/);
    assert.match(hook, /if ! DOM_TESTS_CHANGED=\$\(/);
  });

  test('runs the partition test when any file in the routing contract changes', () => {
    // The contract spans four files. Guarding only the partition script left
    // the assertions absent exactly when the hook, the vitest project, or the
    // npm script they pin was the thing being rewritten.
    for (const path of [
      '\\.husky/pre-push',
      'scripts/prepush-changed-tests\\.sh',
      'vitest\\.dom\\.config\\.mts',
      'package\\.json',
    ]) {
      assert.ok(
        hook.includes(path),
        `pre-push must re-run the partition test when ${path} changes`,
      );
    }
  });
});
