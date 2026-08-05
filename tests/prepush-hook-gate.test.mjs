// The pre-push gate, executed end to end (#5800).
//
// tests/prepush-attest.test.mjs proves the attestation primitives; this file
// proves the HOOK — the 500 lines of bash that decide which of those answers
// to act on. That plumbing is where the failure being fixed actually lived:
// a changed-path list that lost quoted paths, a `[ -f ]` that read worktree
// drift as "the push deleted it", and a cache write that fired regardless.
// None of it is reachable from a unit test of the scripts, and a grep over the
// hook's source cannot tell a working gate from one whose `true` became
// `false`.
//
// So: a real git fixture, the real hook, and stubs for every external command
// it shells out to (npm/npx/node/gh/make). Only the hook's own control flow
// runs, and the stub log is the record of what it decided to execute.

import { strict as assert } from 'node:assert';
import { after, describe, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = join(REPO_ROOT, '.husky', 'pre-push');

// git exports GIT_DIR/GIT_WORK_TREE/... to hook children and those override
// cwd, so a fixture built without stripping them commits into the REAL repo.
const GIT_LOCAL_ENV_VARS = execFileSync('git', ['rev-parse', '--local-env-vars'], {
  encoding: 'utf8',
})
  .trim()
  .split('\n');

const WORK = mkdtempSync(join(tmpdir(), 'wm-prepush-hook-'));
after(() => rmSync(WORK, { recursive: true, force: true }));

// One argument per line, `>` prefixed, so an assertion can tell a single
// argument containing a space from two separate arguments.
const STUB_BODY = (name, log) =>
  `#!/bin/sh\necho "== ${name}" >> ${JSON.stringify(log)}\n` +
  `for a in "$@"; do echo ">$a" >> ${JSON.stringify(log)}; done\nexit 0\n`;

/**
 * Stubs live OUTSIDE the fixture repo: an untracked `stub-bin/` inside it would
 * make the worktree dirty, which the hook (correctly) refuses to attest.
 */
function makeStubs(auxDir) {
  const bin = join(auxDir, 'bin');
  const log = join(auxDir, 'invocations.log');
  mkdirSync(bin, { recursive: true });
  for (const name of ['npm', 'npx', 'node', 'gh', 'make']) {
    const stub = join(bin, name);
    writeFileSync(stub, STUB_BODY(name, log));
    chmodSync(stub, 0o755);
  }
  return { bin, log };
}

function hookEnv(bin) {
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    // The fixture's .husky is not the outer worktree's, which is exactly what
    // the self-identity tripwire is for. It is not what this file tests.
    WM_ALLOW_FOREIGN_HOOKS: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  for (const name of GIT_LOCAL_ENV_VARS) delete env[name];
  return env;
}

let fixtureCount = 0;
/**
 * A repo carrying the real hook and the two scripts it delegates to, with
 * `refs/remotes/origin/main` at the base commit so branch scoping resolves.
 */
function makeFixture({ branchFiles = {}, scriptsCjs = true, failAttestMode = null } = {}) {
  const id = fixtureCount++;
  const root = join(WORK, `repo-${id}`);
  const { bin, log } = makeStubs(join(WORK, `aux-${id}`));
  const env = hookEnv(bin);
  const git = (args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' });

  for (const dir of ['.husky', 'scripts', 'tests', 'node_modules']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  copyFileSync(HOOK, join(root, '.husky', 'pre-push'));
  for (const script of ['prepush-attest.sh', 'prepush-changed-tests.sh']) {
    copyFileSync(join(REPO_ROOT, 'scripts', script), join(root, 'scripts', script));
  }
  // Fault injection: make one attest mode fail while its siblings still work,
  // so the hook's handling of a broken enumeration can be executed rather than
  // reasoned about.
  if (failAttestMode) {
    writeFileSync(
      join(root, 'scripts', 'prepush-attest.sh'),
      `#!/usr/bin/env bash\n` +
        `if [ "$1" = ${JSON.stringify(failAttestMode)} ]; then exit 1; fi\n` +
        `exec bash ${JSON.stringify(join(REPO_ROOT, 'scripts', 'prepush-attest.sh'))} "$@"\n`,
    );
  }
  writeFileSync(join(root, 'package.json'), '{"name":"fixture"}\n');
  writeFileSync(join(root, 'README.md'), 'base\n');
  // RUN_ALL fires the CJS syntax check, which iterates `scripts/*.cjs`.
  if (scriptsCjs) writeFileSync(join(root, 'scripts', 'noop.cjs'), 'module.exports = {};\n');

  // RUN_ALL also forces the pro-test bundle freshness check. Its `git diff
  // --exit-code` lists these paths explicitly and git exits 128 on an unknown
  // one, so they all have to exist and be tracked for the gate to reach its
  // own verdict. An empty pro-test/node_modules skips the install branch
  // (git does not track empty directories, so it stays invisible to `dirty`).
  mkdirSync(join(root, 'pro-test', 'node_modules'), { recursive: true });
  for (const [path, contents] of Object.entries({
    'src/config/products.generated.ts': 'export const PRODUCTS = [];\n',
    'src/config/product-ids.generated.ts': 'export const PRODUCT_IDS = [];\n',
    'pro-test/src/generated/tiers.json': '[]\n',
    'pro-test/src/locales/en.json': '{}\n',
    'public/pro/index.html': '<!doctype html>\n',
  })) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }

  git(['init', '--quiet', '--initial-branch=main', '.']);
  git(['config', 'user.email', 'prepush-hook@example.invalid']);
  git(['config', 'user.name', 'Prepush Hook Fixture']);
  git(['add', '-A']);
  git(['commit', '--quiet', '-m', 'base']);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);

  if (Object.keys(branchFiles).length > 0) {
    for (const [path, contents] of Object.entries(branchFiles)) {
      mkdirSync(join(root, dirname(path)), { recursive: true });
      writeFileSync(join(root, path), contents);
    }
    git(['add', '-A']);
    git(['commit', '--quiet', '-m', 'branch work']);
  }

  const run = (extraEnv = {}) => {
    let status = 0;
    let stdout = '';
    try {
      stdout = execFileSync('bash', ['.husky/pre-push', 'origin'], {
        cwd: root,
        env: { ...env, ...extraEnv },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      status = err.status;
      stdout = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
    const invocations = existsSync(log) ? readFileSync(log, 'utf8') : '';
    rmSync(log, { force: true });
    return { status, stdout, invocations };
  };

  const cachePath = join(root, '.git', 'wm-prepush-green');
  return {
    root,
    git,
    run,
    tree: () => git(['rev-parse', 'HEAD^{tree}']).trim(),
    cached: () => (existsSync(cachePath) ? readFileSync(cachePath, 'utf8').trim() : null),
  };
}

/**
 * The argument list of EVERY `npx tsx --test ...` the hook issued, in order.
 * All of them, not just the first: asserting one invocation cannot see a
 * second, duplicate dispatch — which is the failure the TESTS_CHANGED dedup
 * exists to prevent, so it has to be visible here.
 */
function tsxRuns(invocations) {
  const lines = invocations.split('\n');
  const runs = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] !== '== npx' || lines[i + 1] !== '>tsx') continue;
    const args = [];
    for (let j = i + 1; j < lines.length && lines[j].startsWith('>'); j += 1) {
      args.push(lines[j].slice(1));
    }
    runs.push(args);
  }
  return runs;
}

describe('a clean push runs the changed tests and attests the tree', () => {
  test('dispatches the changed test and caches HEAD^{tree}', () => {
    const fixture = makeFixture({ branchFiles: { 'tests/alpha.test.mjs': 'x\n' } });
    const { status, stdout, invocations } = fixture.run();

    assert.equal(status, 0, stdout);
    assert.deepEqual(tsxRuns(invocations), [['tsx', '--test', 'tests/alpha.test.mjs']]);
    assert.equal(fixture.cached(), fixture.tree(), 'a clean, resolved, green run is attestable');
  });

  test('the second push of that tree skips the gates entirely', () => {
    const fixture = makeFixture({ branchFiles: { 'tests/alpha.test.mjs': 'x\n' } });
    assert.equal(fixture.run().status, 0);

    const second = fixture.run();
    assert.equal(second.status, 0);
    assert.match(second.stdout, /this exact tree already passed/);
    assert.deepEqual(tsxRuns(second.invocations), [], 'a cache hit must not re-run anything');
  });
});

describe('worktree drift blocks the push (#5800 item 1)', () => {
  test('an unstaged delete of a changed test stops the push instead of skipping it', () => {
    // Previously: `[ -f ]` dropped the file, the gate reported green, and
    // HEAD^{tree} — which still CONTAINS that test — went into the cache.
    const fixture = makeFixture({ branchFiles: { 'tests/beta.test.mjs': 'x\n' } });
    rmSync(join(fixture.root, 'tests/beta.test.mjs'));

    const { status, stdout, invocations } = fixture.run();
    assert.equal(status, 1);
    assert.match(stdout, /differ between your worktree and the commit being pushed/);
    assert.match(stdout, /tests\/beta\.test\.mjs/);
    assert.deepEqual(tsxRuns(invocations), []);
    assert.equal(fixture.cached(), null, 'nothing may be attested');
  });

  test('an unstaged FIX over the committed bytes stops the push', () => {
    const fixture = makeFixture({ branchFiles: { 'tests/beta.test.mjs': 'broken\n' } });
    writeFileSync(join(fixture.root, 'tests/beta.test.mjs'), 'fixed\n');

    const { status, stdout } = fixture.run();
    assert.equal(status, 1);
    assert.match(stdout, /differ between your worktree and the commit being pushed/);
    assert.equal(fixture.cached(), null);
  });

  test('WM_ALLOW_WORKTREE_DRIFT lets it through but still refuses to attest', () => {
    // A scoped escape hatch is the alternative to people reaching for
    // `--no-verify`, which skips every gate. It must not be able to buy a
    // green-tree entry — the drifted worktree is dirty, so the write refuses.
    const fixture = makeFixture({ branchFiles: { 'tests/beta.test.mjs': 'broken\n' } });
    writeFileSync(join(fixture.root, 'tests/beta.test.mjs'), 'fixed\n');

    const { status, stdout } = fixture.run({ WM_ALLOW_WORKTREE_DRIFT: '1' });
    assert.equal(status, 0, stdout);
    assert.doesNotMatch(stdout, /differ between your worktree/);
    assert.equal(fixture.cached(), null, 'the hatch must not mint an attestation');
  });

  test('the hatch does NOT cover a changed test missing from the worktree', () => {
    // The hatch says "test what is here" — but a file that is not here cannot
    // be run at all, so the partition refuses separately. The failure has to
    // stay loud: silently skipping it is the original bug, hatch or no hatch.
    const fixture = makeFixture({ branchFiles: { 'tests/beta.test.mjs': 'x\n' } });
    rmSync(join(fixture.root, 'tests/beta.test.mjs'));

    const { status, stdout } = fixture.run({ WM_ALLOW_WORKTREE_DRIFT: '1' });
    assert.equal(status, 1);
    assert.match(stdout, /missing from the worktree/);
    assert.equal(fixture.cached(), null);
  });

  test('an unrelated dirty file lets the push through but forfeits the cache', () => {
    // Blocking every push with a scratch edit would be a gate nobody passes;
    // silently attesting a tree the gates did not run is the actual bug.
    const fixture = makeFixture({ branchFiles: { 'tests/gamma.test.mjs': 'x\n' } });
    writeFileSync(join(fixture.root, 'README.md'), 'scratch\n');

    const { status, stdout, invocations } = fixture.run();
    assert.equal(status, 0, stdout);
    assert.deepEqual(tsxRuns(invocations), [['tsx', '--test', 'tests/gamma.test.mjs']]);
    assert.match(stdout, /not byte-identical to HEAD/);
    assert.equal(fixture.cached(), null);
  });

  test('an untracked file also forfeits the cache', () => {
    const fixture = makeFixture({ branchFiles: { 'tests/gamma.test.mjs': 'x\n' } });
    writeFileSync(join(fixture.root, 'src-forgotten.ts'), 'export const x = 1;\n');

    const { status } = fixture.run();
    assert.equal(status, 0);
    assert.equal(fixture.cached(), null, 'the gates can import it, the push cannot deliver it');
  });
});

describe('C-quoted and space-bearing paths still reach the runner (#5800 item 2)', () => {
  test('unicode, backslash and space test paths are run, each as one argument', () => {
    // With git's default core.quotePath, `git diff --name-only` emits
    // `"tests/caf\303\251.test.mjs"` — quotes and escapes included — which
    // matches nothing on disk. All three used to vanish from the run silently.
    const fixture = makeFixture({
      branchFiles: {
        'tests/café.test.mjs': 'x\n',
        'tests/back\\slash.test.mjs': 'x\n',
        'tests/with space.test.mjs': 'x\n',
      },
    });

    const { status, stdout, invocations } = fixture.run();
    assert.equal(status, 0, stdout);
    assert.deepEqual(
      tsxRuns(invocations),
      [['tsx', '--test', 'tests/back\\slash.test.mjs', 'tests/café.test.mjs', 'tests/with space.test.mjs']],
      'every path must arrive intact and as a single argument',
    );
  });
});

describe('the unresolved-diff fallback may not attest (#5800 item 3)', () => {
  test('RUN_ALL skips the unit suite, so the tree is not cached', () => {
    // The comment justifying the old unconditional write reasoned that "a
    // fallback run executes everything, the strongest attestation". It does
    // not: RUN_ALL explicitly skips the local unit suite. A later run, once
    // origin/main resolved again, could then cache-hit straight past it.
    const fixture = makeFixture({ branchFiles: { 'tests/delta.test.mjs': 'x\n' } });
    fixture.git(['update-ref', '-d', 'refs/remotes/origin/main']);

    const { status, stdout } = fixture.run();
    assert.equal(status, 0, stdout);
    assert.match(stdout, /Could not resolve branch diff from origin\/main/);
    assert.match(stdout, /Skipping local full unit test suite/);
    assert.match(stdout, /not caching: the branch diff could not be resolved/);
    assert.equal(fixture.cached(), null);
  });

  test('a tree attested by an earlier honest run is not read back blind', () => {
    // Reads stay disabled in the fallback: the tree hash captures
    // content-derived plan inputs but not state-derived ones.
    const fixture = makeFixture({ branchFiles: { 'tests/delta.test.mjs': 'x\n' } });
    assert.equal(fixture.run().status, 0);
    assert.equal(fixture.cached(), fixture.tree());

    fixture.git(['update-ref', '-d', 'refs/remotes/origin/main']);
    const blind = fixture.run();
    assert.doesNotMatch(blind.stdout, /this exact tree already passed/);
  });
});

describe('a broken enumeration blocks the push, it does not empty the list', () => {
  // Every path that produces the changed-file list writes it through a `>`
  // redirect, which truncates on failure. An unchecked failure therefore hands
  // the partition an EMPTY list — indistinguishable from "no test files
  // changed" — and the gate skips every changed test with exit 0. Both call
  // sites are asserted because only one of them was checked originally.
  for (const [label, breakOrigin] of [
    ['with origin/main resolvable', false],
    ['in the origin/main-unresolvable fallback', true],
  ]) {
    test(`refuses to run when changed-live fails ${label}`, () => {
      const fixture = makeFixture({
        branchFiles: { 'tests/critical.test.mjs': 'x\n' },
        failAttestMode: 'changed-live',
      });
      if (breakOrigin) fixture.git(['update-ref', '-d', 'refs/remotes/origin/main']);

      const { status, stdout, invocations } = fixture.run();
      assert.equal(status, 1, 'a gate that cannot enumerate its input must not report success');
      assert.match(stdout, /refusing to guess which tests to run/);
      assert.deepEqual(tsxRuns(invocations), []);
      assert.equal(fixture.cached(), null);
    });
  }
});

describe('the gate does not fail closed on its own edge cases', () => {
  test('a repo with no scripts/*.cjs does not fail the RUN_ALL push', () => {
    // `for f in scripts/*.cjs; do [ -f "$f" ] && node -c "$f" || exit 1; done`
    // exited 1 on the unmatched glob — "there are no .cjs files" failed the
    // push with no message at all.
    const fixture = makeFixture({
      branchFiles: { 'tests/delta.test.mjs': 'x\n' },
      scriptsCjs: false,
    });
    fixture.git(['update-ref', '-d', 'refs/remotes/origin/main']); // forces RUN_ALL

    const { status, stdout } = fixture.run();
    assert.equal(status, 0, stdout);
  });

  test('a push that changes no test file still passes and attests', () => {
    const fixture = makeFixture({ branchFiles: { 'docs/notes.md': 'hello\n' } });
    const { status, stdout, invocations } = fixture.run();

    assert.equal(status, 0, stdout);
    assert.deepEqual(tsxRuns(invocations), []);
    assert.equal(fixture.cached(), fixture.tree());
  });
});
