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
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

function makeFixtureWorktree() {
  const root = mkdtempSync(join(tmpdir(), 'wm-prepush-partition-'));
  for (const file of EXISTING) {
    mkdirSync(join(root, dirname(file)), { recursive: true });
    writeFileSync(join(root, file), '// fixture\n');
  }
  return root;
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

  test('the partition claims both extensions the DOM config includes', () => {
    const declared = new Set(
      include.flatMap((glob) => [...glob.matchAll(/\b(mts|mjs)\b/g)].map((m) => m[1])),
    );

    // Mirrors the `\.test\.(mjs|mts)$` alternation in the partition script.
    assert.deepEqual([...declared].sort(), ['mjs', 'mts']);
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

  test('runs the DOM suite under vitest, not the node:test runner', () => {
    assert.match(hook, /npm run test:dom/);
  });

  test('treats a partition failure as a blocked push, not an empty test list', () => {
    // Command substitution discards the exit status: a missing or broken
    // helper would yield an empty list, which the hook reads as "no test files
    // changed" and skips everything. The gate must fail loudly instead.
    assert.match(hook, /if ! TESTS_CHANGED=\$\(/);
    assert.match(hook, /if ! DOM_TESTS_CHANGED=\$\(/);
  });

  test('runs the partition test when the partition script itself changes', () => {
    // Every other guardrail in this hook fires on its own implementation file;
    // the script deciding WHICH tests run must not be the exception.
    assert.match(hook, /\^scripts\/prepush-changed-tests\\\.sh\$/);
  });
});
