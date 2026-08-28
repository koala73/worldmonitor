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
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  `for a in "$@"; do echo ">$a" >> ${JSON.stringify(log)}; done\n` +
  `if [ "${'$'}{WM_PREPUSH_STUB_REQUIRE_SLOT_FOR:-}" = "${name} ${'$'}1" ]; then\n` +
  `  common=$(/usr/bin/git rev-parse --path-format=absolute --git-common-dir) || exit 86\n` +
  `  [ -d "${'$'}common/wm-prepush-admission/slot-1" ] || [ -d "${'$'}common/wm-prepush-admission/slot-2" ] || exit 86\n` +
  `fi\n` +
  `[ "${'$'}{WM_PREPUSH_STUB_FAIL:-}" = "${name} $*" ] && exit 1\n` +
  `exit 0\n`;

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
    const realScriptDispatch = name === 'node'
      ? `case "$1" in\n` +
        `  scripts/prepush-admission.mjs|*/scripts/prepush-admission.mjs) exec ${JSON.stringify(process.execPath)} "$@" ;;\n` +
        `esac\n`
      : '';
    writeFileSync(stub, STUB_BODY(name, log).replace('#!/bin/sh\n', `#!/bin/sh\n${realScriptDispatch}`));
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
 * A repo carrying the real hook and its delegated scripts, with
 * `refs/remotes/origin/main` at the base commit so branch scoping resolves.
 */
function makeFixture({
  branchFiles = {},
  scriptsCjs = true,
  failAttestMode = null,
  baseGuardResponse = null,
  proTestNodeModules = true,
} = {}) {
  const id = fixtureCount++;
  const root = join(WORK, `repo-${id}`);
  const { bin, log } = makeStubs(join(WORK, `aux-${id}`));
  const env = hookEnv(bin);
  const git = (args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' });

  for (const dir of ['.husky', 'scripts', 'scripts/lib', 'tests', 'node_modules']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  // Simulate a COMPLETED install, not merely a present directory. npm writes
  // .package-lock.json only when an install finishes, and the gate keys on that
  // marker — an empty node_modules/ is the half-installed state it must catch.
  // node_modules/ is gitignored above so this stays invisible to `dirty`.
  writeFileSync(join(root, 'node_modules', '.package-lock.json'), '{}\n');
  copyFileSync(HOOK, join(root, '.husky', 'pre-push'));
  for (const script of ['prepush-admission.mjs', 'prepush-attest.sh', 'prepush-changed-tests.sh']) {
    copyFileSync(join(REPO_ROOT, 'scripts', script), join(root, 'scripts', script));
  }
  copyFileSync(
    join(REPO_ROOT, 'scripts', 'lib', 'main-module.mjs'),
    join(root, 'scripts', 'lib', 'main-module.mjs'),
  );
  // Fault injection: make one attest mode fail while its siblings still work,
  // so the hook's handling of a broken enumeration can be executed rather than
  // reasoned about. The base-guard response injection exercises the hook
  // boundary separately: helper status and output are both untrusted inputs.
  if (failAttestMode || baseGuardResponse) {
    const injectedBaseGuard = baseGuardResponse
      ? `if [ "$1" = base-guard ]; then\n` +
        (baseGuardResponse.stdout
          ? `  printf '%b\\n' ${JSON.stringify(baseGuardResponse.stdout)}\n`
          : '') +
        `  exit ${baseGuardResponse.status};\nfi\n`
      : '';
    writeFileSync(
      join(root, 'scripts', 'prepush-attest.sh'),
      `#!/usr/bin/env bash\n` +
        injectedBaseGuard +
        (failAttestMode
          ? `if [ "$1" = ${JSON.stringify(failAttestMode)} ]; then exit 1; fi\n`
          : '') +
        `exec bash ${JSON.stringify(join(REPO_ROOT, 'scripts', 'prepush-attest.sh'))} "$@"\n`,
    );
  }
  writeFileSync(join(root, 'package.json'), '{"name":"fixture"}\n');
  writeFileSync(join(root, 'README.md'), 'base\n');
  writeFileSync(join(root, '.gitignore'), 'public/pro/\nnode_modules/\n');
  // RUN_ALL fires the CJS syntax check, which iterates `scripts/*.cjs`.
  if (scriptsCjs) writeFileSync(join(root, 'scripts', 'noop.cjs'), 'module.exports = {};\n');

  // RUN_ALL also forces the pro-test build + generated-config freshness check.
  // Its `git diff --exit-code` lists these paths explicitly and git exits 128
  // on an unknown one, so they all have to exist and be tracked for the gate to
  // reach its own verdict. public/pro/ is deliberately absent: it is gitignored
  // since #6898 and no longer part of that diff. An empty pro-test/node_modules
  // skips the install branch (git does not track empty directories, so it stays
  // invisible to `dirty`).
  if (proTestNodeModules) {
    mkdirSync(join(root, 'pro-test', 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'pro-test', 'node_modules', '.package-lock.json'), '{}\n');
  }
  for (const [path, contents] of Object.entries({
    'src/config/products.generated.ts': 'export const PRODUCTS = [];\n',
    'src/config/product-ids.generated.ts': 'export const PRODUCT_IDS = [];\n',
    'pro-test/src/generated/tiers.json': '[]\n',
    'pro-test/src/locales/en.json': '{}\n',
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
  if (baseGuardResponse) git(['switch', '--quiet', '-c', 'feature']);

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
 * A real linked worktree whose shared config points at the main checkout's
 * hook. The main hook has a poisoned body after the identity tripwire, so a
 * successful push proves the tripwire handed off to the feature worktree's
 * hook instead of continuing in the foreign copy.
 */
function pushWithPoisonedSharedHooksPath() {
  const id = fixtureCount++;
  const base = join(WORK, `poisoned-hooks-${id}`);
  const main = join(base, 'main');
  const worktree = join(base, 'feature');
  const remote = join(base, 'remote.git');
  const { bin, log } = makeStubs(join(base, 'aux'));
  const env = hookEnv(bin);
  delete env.WM_ALLOW_FOREIGN_HOOKS;

  // Identity repair and admission must run their real helpers. Other node
  // calls in the gate stay stubbed, as in makeFixture().
  const nodeStub = join(bin, 'node');
  writeFileSync(
    nodeStub,
    `#!/bin/sh\n` +
      `case "$1" in\n` +
      `  */scripts/bootstrap-worktree.mjs) exec ${JSON.stringify(process.execPath)} "$@" ;;\n` +
      `  scripts/prepush-admission.mjs|*/scripts/prepush-admission.mjs) exec ${JSON.stringify(process.execPath)} "$@" ;;\n` +
      `esac\n` +
      STUB_BODY('node', log).replace('#!/bin/sh\n', ''),
  );
  chmodSync(nodeStub, 0o755);

  const git = (cwd, args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  mkdirSync(main, { recursive: true });
  execFileSync('git', ['init', '--quiet', '--bare', remote], { env });
  git(main, ['init', '--quiet', '--initial-branch=main', '.']);
  git(main, ['config', 'user.email', 'prepush-hook@example.invalid']);
  git(main, ['config', 'user.name', 'Prepush Hook Fixture']);
  git(main, ['remote', 'add', 'origin', remote]);

  for (const dir of ['.husky', 'scripts', 'scripts/lib', 'node_modules']) {
    mkdirSync(join(main, dir), { recursive: true });
  }
  copyFileSync(HOOK, join(main, '.husky', 'pre-push'));
  for (const script of [
    'bootstrap-worktree.mjs',
    'check-local-secret-dumps.mjs',
    'prepush-admission.mjs',
    'prepush-attest.sh',
    'prepush-changed-tests.sh',
  ]) {
    copyFileSync(join(REPO_ROOT, 'scripts', script), join(main, 'scripts', script));
  }
  copyFileSync(
    join(REPO_ROOT, 'scripts', 'lib', 'main-module.mjs'),
    join(main, 'scripts', 'lib', 'main-module.mjs'),
  );
  writeFileSync(join(main, 'package.json'), '{"name":"fixture"}\n');
  writeFileSync(join(main, 'README.md'), 'base\n');
  git(main, ['add', '-A']);
  git(main, ['commit', '--quiet', '-m', 'base']);
  git(main, ['push', '--quiet', '--set-upstream', 'origin', 'main']);
  git(main, ['worktree', 'add', '--quiet', '-b', 'feature', worktree]);
  mkdirSync(join(worktree, 'node_modules'), { recursive: true });
  writeFileSync(join(worktree, 'node_modules', '.package-lock.json'), '{}\n');
  writeFileSync(join(worktree, 'README.md'), 'feature\n');
  git(worktree, ['add', 'README.md']);
  git(worktree, ['commit', '--quiet', '-m', 'feature']);

  const foreignHook = join(main, '.husky', 'pre-push');
  const originalHook = readFileSync(foreignHook, 'utf8');
  const poisonedHook = originalHook.replace(
    '\necho "Checking for local environment dumps..."',
    '\necho "FOREIGN HOOK BODY RAN"\nexit 97\n\necho "Checking for local environment dumps..."',
  );
  assert.notEqual(poisonedHook, originalHook, 'fixture must poison the foreign hook body');
  writeFileSync(foreignHook, poisonedHook);
  git(main, ['config', 'core.hooksPath', join(main, '.husky')]);

  let status = 0;
  let output = '';
  try {
    output = execFileSync('git', ['push', '--set-upstream', 'origin', 'HEAD:feature'], {
      cwd: worktree,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    status = error.status;
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }

  return {
    status,
    output,
    hooksPath: git(worktree, ['config', '--get', 'core.hooksPath']),
    localHead: git(worktree, ['rev-parse', 'HEAD']),
    remoteHead: git(worktree, ['ls-remote', '--heads', 'origin', 'feature']).split(/\s+/)[0] || '',
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

function admissionSlots(root) {
  const admissionRoot = join(root, '.git', 'wm-prepush-admission');
  try {
    return readdirSync(admissionRoot).filter((entry) => /^slot-[1-9]\d*$/.test(entry));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

describe('a poisoned shared hooksPath self-heals at push time (#6104)', () => {
  test('repairs the shared value and runs this worktree hook in the same push', () => {
    const result = pushWithPoisonedSharedHooksPath();

    assert.equal(result.status, 0, result.output);
    assert.equal(result.hooksPath, '.husky');
    assert.equal(result.remoteHead, result.localHead);
    assert.match(result.output, /repairing shared hooksPath/);
    assert.doesNotMatch(result.output, /FOREIGN HOOK BODY RAN/);
  });
});

describe('a clean push runs the changed tests and attests the tree', () => {
  test('dispatches the changed test and caches HEAD^{tree}', () => {
    const fixture = makeFixture({ branchFiles: { 'tests/alpha.test.mjs': 'x\n' } });
    const { status, stdout, invocations } = fixture.run({
      WM_PREPUSH_STUB_REQUIRE_SLOT_FOR: 'npx tsx',
    });

    assert.equal(status, 0, stdout);
    assert.deepEqual(tsxRuns(invocations), [
      ['tsx', '--test', '--test-concurrency=2', 'tests/alpha.test.mjs'],
    ]);
    assert.equal(fixture.cached(), fixture.tree(), 'a clean, resolved, green run is attestable');
    assert.deepEqual(admissionSlots(fixture.root), [], 'EXIT cleanup releases the heavy-phase slot');
  });

  test('a heavy-phase failure still releases its admission slot', () => {
    const fixture = makeFixture({ branchFiles: { 'scripts/failing-change.mjs': 'x\n' } });
    const { status } = fixture.run({
      WM_PREPUSH_STUB_FAIL: 'npm run typecheck',
      WM_PREPUSH_STUB_REQUIRE_SLOT_FOR: 'npm run',
    });

    assert.equal(status, 1);
    assert.deepEqual(admissionSlots(fixture.root), [], 'an || exit 1 path must not wedge later pushes');
  });

  test('a fresh worktree installs dependencies while holding an admission slot', () => {
    const fixture = makeFixture({ branchFiles: { 'tests/alpha.test.mjs': 'x\n' } });
    rmSync(join(fixture.root, 'node_modules'), { recursive: true });

    const { status, stdout, invocations } = fixture.run({
      WM_PREPUSH_STUB_REQUIRE_SLOT_FOR: 'npm ci',
    });

    assert.equal(status, 0, stdout);
    assert.match(invocations, /== npm\n>ci\n/);
    assert.deepEqual(admissionSlots(fixture.root), [], 'EXIT cleanup releases the install lease');
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
    assert.deepEqual(tsxRuns(invocations), [
      ['tsx', '--test', '--test-concurrency=2', 'tests/gamma.test.mjs'],
    ]);
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
      [[
        'tsx',
        '--test',
        '--test-concurrency=2',
        'tests/back\\slash.test.mjs',
        'tests/café.test.mjs',
        'tests/with space.test.mjs',
      ]],
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

describe('a broken base guard blocks the push, it does not default to zero', () => {
  const cases = [
    ['status 1', { status: 1, stdout: '' }],
    ['status 2', { status: 2, stdout: '' }],
    ['empty output', { status: 0, stdout: '' }],
    ['missing tab field', { status: 0, stdout: 'main' }],
    ['multiple records', { status: 0, stdout: 'main\t0\nmain\t0' }],
    ['non-numeric count', { status: 0, stdout: 'main\tnot-a-count' }],
  ];

  for (const [label, baseGuardResponse] of cases) {
    test(`${label} refuses the push and does not cache`, () => {
      const fixture = makeFixture({
        branchFiles: { 'tests/base-guard.test.mjs': 'x\n' },
        baseGuardResponse,
      });

      const { status, stdout, invocations } = fixture.run();
      assert.equal(status, 1, stdout);
      assert.match(stdout, /branch-contamination guard/);
      assert.deepEqual(tsxRuns(invocations), []);
      assert.equal(fixture.cached(), null, 'a failed guard must not mint an attestation');
    });
  }

  test('status 3 with a valid record preserves the contamination verdict', () => {
    const fixture = makeFixture({
      branchFiles: { 'tests/base-guard.test.mjs': 'x\n' },
      baseGuardResponse: { status: 3, stdout: 'main\t21' },
    });

    const { status, stdout, invocations } = fixture.run();
    assert.equal(status, 1, stdout);
    assert.match(stdout, /21 commits ahead of origin\/main/);
    assert.deepEqual(tsxRuns(invocations), []);
    assert.equal(fixture.cached(), null);
  });
});

function npmRuns(invocations) {
  const lines = invocations.split('\n');
  const runs = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] !== '== npm') continue;
    const args = [];
    for (let j = i + 1; j < lines.length && lines[j].startsWith('>'); j += 1) {
      args.push(lines[j].slice(1));
    }
    runs.push(args);
  }
  return runs;
}

describe('Pro built-output tests rebuild before dispatch', () => {
  test('does not trust a stale ignored artifact for a test-only branch delta', () => {
    const fixture = makeFixture({
      branchFiles: {
        'tests/pro-built-output.test.mjs': "import './_lib/pro-built-output.mjs';\n",
      },
    });
    mkdirSync(join(fixture.root, 'public', 'pro'), { recursive: true });
    writeFileSync(join(fixture.root, 'public', 'pro', 'welcome.html'), 'stale branch output\n');
    assert.equal(fixture.git(['check-ignore', 'public/pro/welcome.html']).trim(), 'public/pro/welcome.html');

    const { status, stdout, invocations } = fixture.run();
    assert.equal(status, 0, stdout);
    const buildIndex = invocations.indexOf('== npm\n>run\n>build\n');
    const testIndex = invocations.indexOf('== npx\n>tsx\n>--test\n');
    assert.notEqual(buildIndex, -1, `expected the Pro build, got:\n${invocations}`);
    assert.notEqual(testIndex, -1, `expected the changed test dispatch, got:\n${invocations}`);
    assert.ok(buildIndex < testIndex, `expected the Pro build before test dispatch, got:\n${invocations}`);
  });
});

describe('pro-test freshness install prefers the shared npm cache (#6766)', () => {
  test('npm ci --prefer-offline when pro-test/node_modules is missing', () => {
    const fixture = makeFixture({
      branchFiles: { 'pro-test/src/stale.ts': 'export const n = 1;\n' },
      proTestNodeModules: false,
    });

    const { status, stdout, invocations } = fixture.run();
    assert.equal(status, 0, stdout);
    const ci = npmRuns(invocations).find((args) => args[0] === 'ci');
    assert.ok(ci, `expected npm ci, got:\n${invocations}`);
    assert.ok(ci.includes('--prefer-offline'), ci.join(' '));
    assert.ok(ci.includes('--cache'), ci.join(' '));
  });

  test('shares Vite cache via .vite link, never a node_modules symlink', () => {
    const fixture = makeFixture({
      branchFiles: {
        'pro-test/src/stale.ts': 'export const n = 1;\n',
        'pro-test/package-lock.json': '{"lockfileVersion":3}\n',
      },
    });

    const { status, stdout } = fixture.run();
    assert.equal(status, 0, stdout);
    const nodeModules = join(fixture.root, 'pro-test', 'node_modules');
    assert.equal(lstatSync(nodeModules).isSymbolicLink(), false);
    const viteCache = join(nodeModules, '.vite');
    assert.equal(lstatSync(viteCache).isSymbolicLink(), true);
    assert.match(readlinkSync(viteCache), /wm-vite-cache\/pro-test-[0-9a-f]{12}$/);
  });

  // public/pro/ left this gate in #6898 (Vercel builds it), but the generated
  // config pro-test compiles AGAINST is still committed and can still go stale.
  // Teeth for the reduced diff list: dirty one of its surviving paths.
  test('still fails when committed generated pro config is stale', () => {
    const fixture = makeFixture({
      branchFiles: { 'pro-test/src/stale.ts': 'export const n = 1;\n' },
    });
    writeFileSync(join(fixture.root, 'pro-test/src/generated/tiers.json'), '[{"stale":true}]\n');

    const { status, stdout } = fixture.run();
    assert.equal(status, 1, stdout);
    assert.match(stdout, /product catalog, generated config, or pro locales is stale/);
  });

  test('refuses a pro-test/node_modules symlink instead of installing through it', (t) => {
    const fixture = makeFixture({
      branchFiles: { 'pro-test/src/stale.ts': 'export const n = 1;\n' },
    });
    const stolen = join(WORK, `stolen-nm-${fixtureCount}`);
    mkdirSync(stolen, { recursive: true });
    rmSync(join(fixture.root, 'pro-test', 'node_modules'), { recursive: true, force: true });
    try {
      symlinkSync(stolen, join(fixture.root, 'pro-test', 'node_modules'));
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip('symlink creation is unavailable in this environment');
        return;
      }
      throw error;
    }

    const { status, stdout, invocations } = fixture.run();
    assert.equal(status, 1, stdout);
    assert.match(stdout, /pro-test\/node_modules is a symlink/);
    assert.equal(
      npmRuns(invocations).filter((args) => args[0] === 'ci').length,
      0,
      'must not npm ci through a symlink',
    );
  });
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
