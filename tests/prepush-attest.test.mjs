// Green-tree attestation primitives for the pre-push gate (#5800).
//
// `.husky/pre-push` caches `HEAD^{tree}` after a green run and skips every
// tree-dependent gate on a later push of that tree. Three ways it could stamp a
// tree the gates never actually exercised, all reproduced here first:
//
//   1. The gates run the WORKTREE, the cache claims HEAD. An unstaged delete
//      dropped a changed test from the run; an unstaged fix made the suite pass
//      over broken committed bytes. Either way HEAD went in the cache.
//   2. `git diff --name-only` C-quotes unicode/backslash/newline paths under
//      git's default `core.quotePath`, so those paths matched nothing on disk
//      and were silently dropped — file changed, nothing ran, gate green.
//   3. The unresolvable-origin/main fallback sets RUN_ALL, RUN_ALL *skips* the
//      local unit suite, and the cache was written anyway.
//
// Every assertion below executes the real scripts/prepush-attest.sh against a
// real git fixture. A source grep over the hook could not carry these: it stays
// green when `true` is flipped to `false` or a `|| exit` is dropped.
//
// Exit codes are asserted, not just output: 0 (clean/hit/written) and 3
// (drift/dirty/miss/refused) must never collapse, because "the gate could not
// answer" reading as "the gate said yes" is exactly the failure being closed.

import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'prepush-attest.sh');

// git exports GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE... to hook children, and
// those OVERRIDE cwd — a fixture built without stripping them writes its
// commits and its `git config user.email` into the REAL repo. Strip the list
// git itself publishes rather than guessing at it.
const GIT_LOCAL_ENV_VARS = execFileSync('git', ['rev-parse', '--local-env-vars'], {
  encoding: 'utf8',
})
  .trim()
  .split('\n');

function isolatedGitEnv(overrides = {}) {
  const env = { ...process.env, ...overrides, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  for (const name of GIT_LOCAL_ENV_VARS) delete env[name];
  return env;
}

const fixtures = [];
process.on('exit', () => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

function git(cwd, args) {
  return execFileSync('git', args, { cwd, env: isolatedGitEnv(), encoding: 'utf8' });
}

function write(root, relativePath, contents = 'fixture\n') {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

/**
 * A repo with `base` standing in for origin/main and one branch commit on top.
 * `branchFiles` are added by that commit — they are the "pushed bytes".
 */
function makeRepo({ baseFiles = { 'README.md': 'base\n' }, branchFiles = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wm-prepush-attest-'));
  fixtures.push(root);
  git(root, ['init', '--quiet', '--initial-branch=main', '.']);
  git(root, ['config', 'user.email', 'prepush-attest@example.invalid']);
  git(root, ['config', 'user.name', 'Prepush Attest Fixture']);
  for (const [path, contents] of Object.entries(baseFiles)) write(root, path, contents);
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', 'base']);
  git(root, ['branch', '--quiet', 'base']);
  if (Object.keys(branchFiles).length > 0) {
    for (const [path, contents] of Object.entries(branchFiles)) write(root, path, contents);
    git(root, ['add', '-A']);
    git(root, ['commit', '--quiet', '-m', 'branch work']);
  }
  return root;
}

/** Runs a mode and returns its exit status plus the NUL-delimited stdout, split. */
function attest(cwd, args) {
  let status = 0;
  let stdout = '';
  try {
    stdout = execFileSync('bash', [SCRIPT, ...args], {
      cwd,
      env: isolatedGitEnv(),
      encoding: 'utf8',
    });
  } catch (err) {
    status = err.status;
    stdout = err.stdout ?? '';
  }
  return { status, paths: stdout.split('\0').filter(Boolean), stdout };
}

describe('changed-path enumeration survives every legal git path', () => {
  // core.quotePath=true is git's DEFAULT. `--name-only` then emits
  // `"tests/caf\303\251.test.mjs"` — quotes, escapes and all — which matches no
  // file on disk, so the hook's existence filter dropped it and the gate went
  // green having run nothing. Backslash and newline paths are C-quoted even
  // with core.quotePath=false, so -z is the only complete fix.
  const HOSTILE = {
    'tests/plain.test.mjs': 'x\n',
    'tests/café.test.mjs': 'x\n',
    'tests/back\\slash.test.mjs': 'x\n',
    'tests/with space.test.mjs': 'x\n',
  };

  test('the unicode/backslash/space paths a plain --name-only read loses', () => {
    const root = makeRepo({ branchFiles: HOSTILE });

    // The old plumbing, reproduced: line-read `git diff --name-only`, then
    // infer existence from the filesystem.
    const quoted = git(root, ['diff', '--name-only', 'base...HEAD']).split('\n').filter(Boolean);
    const dropped = quoted.filter((path) => path.startsWith('"'));
    assert.deepEqual(
      dropped.sort(),
      ['"tests/back\\\\slash.test.mjs"', '"tests/caf\\303\\251.test.mjs"'],
      'baseline: git C-quotes these, so they no longer name a file that exists',
    );

    const { status, paths } = attest(root, ['changed', 'base']);
    assert.equal(status, 0);
    assert.deepEqual(paths.sort(), Object.keys(HOSTILE).sort(), 'every legal path must survive');
  });

  test('a path containing a newline stays one path', () => {
    // The reason this is NUL-delimited rather than `core.quotePath=false`: a
    // line-oriented reader splits this path into two nonexistent ones.
    const root = makeRepo({ branchFiles: { 'tests/two\nlines.test.mjs': 'x\n' } });
    const { status, paths } = attest(root, ['changed', 'base']);
    assert.equal(status, 0);
    assert.deepEqual(paths, ['tests/two\nlines.test.mjs']);
  });
});

describe('deletions come from git, never from the filesystem', () => {
  test('changed-live excludes paths the push deletes', () => {
    const root = makeRepo({
      baseFiles: { 'README.md': 'base\n', 'tests/gone.test.mjs': 'x\n' },
      branchFiles: { 'tests/kept.test.mjs': 'x\n' },
    });
    git(root, ['rm', '--quiet', 'tests/gone.test.mjs']);
    git(root, ['commit', '--quiet', '-m', 'drop a test']);

    assert.deepEqual(attest(root, ['changed', 'base']).paths.sort(), [
      'tests/gone.test.mjs',
      'tests/kept.test.mjs',
    ]);
    assert.deepEqual(
      attest(root, ['changed-live', 'base']).paths,
      ['tests/kept.test.mjs'],
      'changed-live is "exists in the pushed commit", so a deleted path is gone',
    );
  });

  test('a rename lists BOTH paths, not just the destination', () => {
    // Rename detection reports only the destination, so a
    // `scripts/seed-x.mjs` -> `tests/x-seed.test.mjs` move left NOTHING under
    // scripts/ in the list and the seed category never fired for a push that
    // plainly touched it. Every gate here scopes by path prefix, so the
    // vacated path matters as much as the new one.
    const root = makeRepo({
      baseFiles: { 'scripts/seed-x.mjs': 'same bytes\n', 'tests/other.test.mjs': 'x\n' },
    });
    git(root, ['mv', 'scripts/seed-x.mjs', 'tests/x-seed.test.mjs']);
    git(root, ['commit', '--quiet', '-m', 'move it']);

    assert.deepEqual(attest(root, ['changed', 'base']).paths.sort(), [
      'scripts/seed-x.mjs',
      'tests/x-seed.test.mjs',
    ]);
    assert.deepEqual(
      attest(root, ['changed-live', 'base']).paths,
      ['tests/x-seed.test.mjs'],
      'only the destination survives into the pushed commit',
    );
  });

  test('changed-live still lists a file the worktree deleted but the push keeps', () => {
    // The exact #5800 case. `[ -f ]` called this "deleted by the push" and
    // dropped it; git knows the pushed commit still contains it.
    const root = makeRepo({ branchFiles: { 'tests/beta.test.mjs': 'x\n' } });
    rmSync(join(root, 'tests/beta.test.mjs'));

    assert.deepEqual(
      attest(root, ['changed-live', 'base']).paths,
      ['tests/beta.test.mjs'],
      'the pushed commit contains it, so the gate owes it a run',
    );
  });

  test('an unresolvable base is exit 3, not an empty changed list', () => {
    // An empty list reads as "nothing changed, skip everything" — the loudest
    // possible thing to get wrong quietly.
    const root = makeRepo({ branchFiles: { 'src/a.ts': 'x\n' } });
    for (const mode of ['changed', 'changed-live', 'drift']) {
      const { status, paths } = attest(root, [mode, 'origin/nope']);
      assert.equal(status, 3, `${mode} must report "cannot resolve", not "nothing"`);
      assert.deepEqual(paths, []);
    }
  });
});

describe('drift: the gates test the worktree, the cache claims HEAD', () => {
  test('a clean worktree reports no drift', () => {
    const root = makeRepo({ branchFiles: { 'tests/beta.test.mjs': 'x\n' } });
    const { status, paths } = attest(root, ['drift', 'base']);
    assert.equal(status, 0);
    assert.deepEqual(paths, []);
  });

  test('an unstaged delete of a pushed test is drift', () => {
    const root = makeRepo({ branchFiles: { 'tests/beta.test.mjs': 'x\n' } });
    rmSync(join(root, 'tests/beta.test.mjs'));
    const { status, paths } = attest(root, ['drift', 'base']);
    assert.equal(status, 3);
    assert.deepEqual(paths, ['tests/beta.test.mjs']);
  });

  test('an unstaged FIX over broken committed bytes is drift', () => {
    // The worse variant: the suite passes on the worktree copy while the
    // broken committed copy is what git pushes — and gets cached green.
    const root = makeRepo({ branchFiles: { 'src/broken.ts': 'export const x = BROKEN\n' } });
    write(root, 'src/broken.ts', 'export const x = 1;\n');
    const { status, paths } = attest(root, ['drift', 'base']);
    assert.equal(status, 3);
    assert.deepEqual(paths, ['src/broken.ts']);
  });

  test('a STAGED but uncommitted fix is drift too', () => {
    // `git push` delivers HEAD, not the index.
    const root = makeRepo({ branchFiles: { 'src/broken.ts': 'export const x = BROKEN\n' } });
    write(root, 'src/broken.ts', 'export const x = 1;\n');
    git(root, ['add', 'src/broken.ts']);
    assert.equal(attest(root, ['drift', 'base']).status, 3);
  });

  test('a path containing glob metacharacters is matched literally', () => {
    // The intersection hands the branch paths to git as pathspecs, and `*`,
    // `?` and `[` are legal in a filename but magic in a pathspec. The push
    // changes `tests/b[1].test.mjs`; the dirty file is `tests/b1.test.mjs`,
    // which the push does NOT touch. Read as a character class, the pathspec
    // matches the dirty file and blocks the push over an unrelated edit.
    const root = makeRepo({
      baseFiles: { 'README.md': 'base\n', 'tests/b1.test.mjs': 'x\n' },
      branchFiles: { 'tests/b[1].test.mjs': 'x\n' },
    });
    write(root, 'tests/b1.test.mjs', 'unrelated edit\n');

    const { status, paths } = attest(root, ['drift', 'base']);
    assert.equal(status, 0, 'an edit outside the push must not be drift');
    assert.deepEqual(paths, []);
  });

  test('drift in a glob-metacharacter path is still caught', () => {
    // The other half: matching literally must not mean matching nothing.
    const root = makeRepo({ branchFiles: { 'tests/b[1].test.mjs': 'broken\n' } });
    write(root, 'tests/b[1].test.mjs', 'fixed\n');
    const { status, paths } = attest(root, ['drift', 'base']);
    assert.equal(status, 3);
    assert.deepEqual(paths, ['tests/b[1].test.mjs']);
  });

  test('an empty branch diff reports no drift, however dirty the worktree', () => {
    // `git diff HEAD -- ` with an empty pathspec list means ALL paths, so an
    // unguarded intersection would report every unrelated edit as drift and
    // block a push that changes nothing.
    const root = makeRepo({ baseFiles: { 'README.md': 'base\n', 'notes.md': 'base\n' } });
    write(root, 'notes.md', 'scratch\n');
    write(root, 'README.md', 'scratch\n');
    const { status, paths } = attest(root, ['drift', 'base']);
    assert.equal(status, 0);
    assert.deepEqual(paths, []);
  });

  test('drift ignores edits to files this push does not change', () => {
    // Scoped on purpose: blocking every push that has an unrelated scratch
    // edit would be a gate nobody can pass. Out-of-scope dirt is handled by
    // withholding the cache instead — see the `dirty` suite.
    const root = makeRepo({
      baseFiles: { 'README.md': 'base\n', 'notes.md': 'base\n' },
      branchFiles: { 'src/a.ts': 'x\n' },
    });
    write(root, 'notes.md', 'scratch\n');
    const { status, paths } = attest(root, ['drift', 'base']);
    assert.equal(status, 0);
    assert.deepEqual(paths, []);
  });
});

describe('dirty: what may be stamped as an attestation of HEAD', () => {
  test('a pristine worktree is attestable', () => {
    const root = makeRepo({ branchFiles: { 'src/a.ts': 'x\n' } });
    const { status, paths } = attest(root, ['dirty']);
    assert.equal(status, 0);
    assert.deepEqual(paths, []);
  });

  test('an out-of-scope tracked edit blocks attestation', () => {
    const root = makeRepo({
      baseFiles: { 'README.md': 'base\n', 'notes.md': 'base\n' },
      branchFiles: { 'src/a.ts': 'x\n' },
    });
    write(root, 'notes.md', 'scratch\n');
    const { status, paths } = attest(root, ['dirty']);
    assert.equal(status, 3, 'the gates ran against bytes that are not HEAD');
    assert.deepEqual(paths, ['notes.md']);
  });

  test('a forgotten git add blocks attestation', () => {
    // The gates can import an untracked module; the push cannot deliver it.
    const root = makeRepo({ branchFiles: { 'src/a.ts': 'x\n' } });
    write(root, 'src/uncommitted.ts', 'export const y = 1;\n');
    const { status, paths } = attest(root, ['dirty']);
    assert.equal(status, 3);
    assert.deepEqual(paths, ['src/uncommitted.ts']);
  });

  test('an ignored file does not block attestation', () => {
    const root = makeRepo({ baseFiles: { 'README.md': 'base\n', '.gitignore': 'build/\n' } });
    write(root, 'build/output.js', 'x\n');
    assert.equal(attest(root, ['dirty']).status, 0);
  });
});

describe('cache reads', () => {
  function cacheFile(root, contents) {
    const path = join(root, 'gate-cache');
    writeFileSync(path, contents);
    return path;
  }

  test('hits on an exact tree recorded by an earlier green run', () => {
    const root = makeRepo({ branchFiles: { 'src/a.ts': 'x\n' } });
    const tree = git(root, ['rev-parse', 'HEAD^{tree}']).trim();
    const path = cacheFile(root, `${tree}\n`);
    assert.equal(attest(root, ['cache-read', path, tree, 'true']).status, 0);
  });

  test('misses on a different tree, an absent file, and an empty tree hash', () => {
    const root = makeRepo({ branchFiles: { 'src/a.ts': 'x\n' } });
    const tree = git(root, ['rev-parse', 'HEAD^{tree}']).trim();
    const path = cacheFile(root, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n');
    assert.equal(attest(root, ['cache-read', path, tree, 'true']).status, 3);
    assert.equal(attest(root, ['cache-read', join(root, 'absent'), tree, 'true']).status, 3);
    assert.equal(attest(root, ['cache-read', path, '', 'true']).status, 3);
  });

  test('refuses to read when the branch diff could not be resolved', () => {
    // The tree hash captures content-derived plan inputs but not state-derived
    // ones, so a blind run must not trust an attestation minted under a scoped
    // plan it can no longer verify.
    const root = makeRepo({ branchFiles: { 'src/a.ts': 'x\n' } });
    const tree = git(root, ['rev-parse', 'HEAD^{tree}']).trim();
    const path = cacheFile(root, `${tree}\n`);
    assert.equal(attest(root, ['cache-read', path, tree, 'false']).status, 3);
  });
});

describe('cache writes only attest what actually ran', () => {
  function setup() {
    const root = makeRepo({ branchFiles: { 'src/a.ts': 'x\n' } });
    return { root, tree: git(root, ['rev-parse', 'HEAD^{tree}']).trim(), path: join(root, 'gate-cache') };
  }

  test('writes after a resolved, clean run', () => {
    const { root, tree, path } = setup();
    assert.equal(attest(root, ['cache-write', path, tree, 'true', 'true']).status, 0);
    assert.equal(readFileSync(path, 'utf8').trim(), tree);
  });

  test('refuses when the branch diff was unresolvable', () => {
    // RUN_ALL fires in that fallback and RUN_ALL explicitly SKIPS the local
    // unit suite, so "a fallback run executes everything" was never true.
    const { root, tree, path } = setup();
    const { status, stdout } = attest(root, ['cache-write', path, tree, 'false', 'true']);
    assert.equal(status, 3);
    assert.match(stdout, /not caching/);
    assert.throws(() => readFileSync(path, 'utf8'));
  });

  test('refuses when the worktree is not byte-identical to HEAD', () => {
    const { root, tree, path } = setup();
    const { status, stdout } = attest(root, ['cache-write', path, tree, 'true', 'false']);
    assert.equal(status, 3);
    assert.match(stdout, /not caching/);
    assert.throws(() => readFileSync(path, 'utf8'));
  });

  test('refuses when HEAD has no resolvable tree hash', () => {
    const { root, path } = setup();
    assert.equal(attest(root, ['cache-write', path, '', 'true', 'true']).status, 3);
    assert.throws(() => readFileSync(path, 'utf8'));
  });

  test('a refused write leaves an earlier honest attestation intact', () => {
    // Refusing is "I cannot vouch for this run", not "the previous run lied".
    const { root, tree, path } = setup();
    writeFileSync(path, `${tree}\n`);
    assert.equal(attest(root, ['cache-write', path, tree, 'true', 'false']).status, 3);
    assert.equal(readFileSync(path, 'utf8').trim(), tree);
  });
});

describe('mode and argument handling fails loudly', () => {
  test('an unknown mode exits 2 rather than emitting an empty list', () => {
    const root = makeRepo();
    const { status, paths } = attest(root, ['drfit', 'base']);
    assert.equal(status, 2);
    assert.deepEqual(paths, []);
  });

  test('every mode that needs a base ref rejects a missing one', () => {
    const root = makeRepo();
    for (const mode of ['changed', 'changed-live', 'drift']) {
      assert.equal(attest(root, [mode]).status, 2, `${mode} needs a base ref`);
    }
  });

  test('the cache modes reject missing arguments', () => {
    const root = makeRepo();
    assert.equal(attest(root, ['cache-read', join(root, 'c'), 'tree']).status, 2);
    assert.equal(attest(root, ['cache-write', join(root, 'c'), 'tree', 'true']).status, 2);
  });
});

describe('pre-push wiring: the hook must consume these decisions', () => {
  // Weaker than the executable cases above — it can only prove the calls are
  // present, not that they behave. It exists because the hook is the one place
  // that cannot be executed cheaply in a test (it runs tsc, esbuild and vite),
  // so a silently unwired script would otherwise be invisible.
  const hook = readFileSync(join(REPO_ROOT, '.husky', 'pre-push'), 'utf8');

  // assert.ok over a boolean rather than assert.match over the file: a failure
  // here otherwise prints all 500 lines of the hook as the "actual" value.
  const has = (pattern, message) => assert.ok(pattern.test(hook), message);
  const lacks = (pattern, message) => assert.ok(!pattern.test(hook), message);

  test('binds $ATTEST to this script', () => {
    // The calls below are spelled `"$ATTEST" <mode>`, so the binding is what
    // makes them mean anything.
    has(/^ATTEST="scripts\/prepush-attest\.sh"$/m);
  });

  test('routes the changed-path enumeration through prepush-attest.sh', () => {
    has(/"\$ATTEST" changed origin\/main/, 'scoping list must come from the NUL-safe enumeration');
    has(/"\$ATTEST" changed-live /, 'the runner list must exclude pushed deletions');
  });

  test('checks drift and dirt, and blocks the push on drift', () => {
    has(/"\$ATTEST" drift /, 'drift is the P1 — pushing bytes the gates never ran');
    has(/"\$ATTEST" dirty/, 'dirt decides whether the run may be cached');
  });

  test('delegates both cache decisions instead of writing the file inline', () => {
    has(/"\$ATTEST" cache-read /);
    has(/"\$ATTEST" cache-write /);
    lacks(
      /^\s*echo "\$TREE_HASH" > "\$GATE_CACHE"/m,
      'an inline write bypasses every refusal rule tested above',
    );
  });

  test('no changed-path consumer reads the quote-prone plain --name-only diff', () => {
    // `git diff --name-only origin/main...HEAD` without -z is the read that
    // loses unicode and backslash paths. Scoping diffs at fixed ASCII paths
    // (`-- scripts/package.json`) only ask "did anything change", so they are
    // unaffected; a bare three-dot branch diff is not.
    lacks(
      /git diff --name-only [^|\n]*\.\.\.HEAD/,
      'a plain three-dot --name-only read silently drops C-quoted paths',
    );
  });

  test('delegates edge entry discovery to the tracked-file checker', () => {
    has(
      /^\s*node scripts\/check-edge-function-bundles\.mjs --caller=prepush \|\| exit 1$/m,
      'pre-push must use the shared checker with its worktree-aware caller profile',
    );
    lacks(/find api\/ -name "\*\.js"/, 'working-tree globs rediscover ignored sidecar bundles');
  });
});

describe('base-guard fetches lazily and only to disprove a violation (#6764)', () => {
  // The old hook fetched origin on EVERY push (2s warm, 72s cold) to protect
  // a guard that almost never fires. base-guard keeps the zero-fetch shortcut
  // for protected main, but refreshes mutable stacked bases before accepting a
  // cached pass. A suspected violation (or missing ref) is fetched and
  // recounted as well.
  //
  // Every case runs the real script with a stub `git` first on PATH that logs
  // fetch invocations before delegating to the real binary, so "no fetch
  // happened" is an executed fact, not a source grep.
  const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const REAL_NODE = process.execPath;

  function makeCloneWithOrigin({ aheadCommits = 1 } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'wm-base-guard-'));
    fixtures.push(root);
    const origin = join(root, 'origin.git');
    const clone = join(root, 'clone');
    execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', origin], { env: isolatedGitEnv(), encoding: 'utf8' });
    execFileSync('git', ['clone', '--quiet', origin, clone], { env: isolatedGitEnv(), encoding: 'utf8' });
    git(clone, ['config', 'user.email', 'base-guard@example.invalid']);
    git(clone, ['config', 'user.name', 'Base Guard Fixture']);
    write(clone, 'README.md', 'base\n');
    git(clone, ['add', '-A']);
    git(clone, ['commit', '--quiet', '-m', 'base']);
    git(clone, ['push', '--quiet', 'origin', 'main']);
    git(clone, ['checkout', '--quiet', '-b', 'feature']);
    for (let i = 0; i < aheadCommits; i += 1) {
      write(clone, 'work.txt', `work ${i}\n`);
      git(clone, ['add', '-A']);
      git(clone, ['commit', '--quiet', '-m', `work ${i}`]);
    }
    // A fetch-logging git shim, first on PATH for the script under test only.
    const stubDir = join(root, 'stub-bin');
    const fetchLog = join(root, 'fetch.log');
    mkdirSync(stubDir, { recursive: true });
    writeFileSync(
      join(stubDir, 'git'),
      `#!/bin/sh\nif [ "$1" = fetch ]; then echo fetch >> "${fetchLog}"; fi\nexec "${REAL_GIT}" "$@"\n`,
      { mode: 0o755 },
    );
    return { root, clone, stubDir, fetchLog };
  }

  function baseGuard({ clone, stubDir }, args, { path = `${stubDir}:${process.env.PATH}`, ...extraEnv } = {}) {
    let status = 0;
    let stdout = '';
    try {
      stdout = execFileSync('/bin/bash', [SCRIPT, 'base-guard', ...args], {
        cwd: clone,
        env: isolatedGitEnv({ PATH: path, ...extraEnv }),
        encoding: 'utf8',
      });
    } catch (err) {
      status = err.status;
      stdout = err.stdout ?? '';
    }
    const [base, count] = stdout.trim().split('\t');
    return { status, base, count: Number(count) };
  }

  function fetchCount(fixture) {
    try {
      return readFileSync(fixture.fetchLog, 'utf8').split('\n').filter(Boolean).length;
    } catch {
      return 0;
    }
  }

  function makeTimeoutlessPath({ root, fetchLog }) {
    const stubDir = join(root, 'timeoutless-bin');
    mkdirSync(stubDir, { recursive: true });
    writeFileSync(
      join(stubDir, 'git'),
      `#!/bin/sh\n` +
        `if [ "$1" = fetch ]; then echo fetch >> "${fetchLog}"; exec /bin/sleep 1000; fi\n` +
        `exec "${REAL_GIT}" "$@"\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(stubDir, 'node'),
      `#!/bin/sh\nexec "${REAL_NODE}" "$@"\n`,
      { mode: 0o755 },
    );
    return stubDir;
  }

  test('a cached ahead-count within the limit performs NO fetch', () => {
    const fixture = makeCloneWithOrigin({ aheadCommits: 1 });
    const result = baseGuard(fixture, ['main', '20']);
    assert.equal(result.status, 0);
    assert.equal(result.base, 'main');
    assert.equal(result.count, 1);
    assert.equal(fetchCount(fixture), 0, 'the common path must pay no network');
  });

  test('a force-rewritten stacked base refreshes a cached pass before accepting it', () => {
    const fixture = makeCloneWithOrigin({ aheadCommits: 25 });
    const { clone } = fixture;
    git(clone, ['push', '--quiet', 'origin', 'feature:stacked']);
    const cachedBase = git(clone, ['rev-parse', 'feature~1']).trim();
    git(clone, ['update-ref', 'refs/remotes/origin/stacked', cachedBase]);

    const rewrittenBase = git(clone, ['rev-parse', 'feature~25']).trim();
    git(clone, ['push', '--quiet', '--force', 'origin', `${rewrittenBase}:stacked`]);

    const result = baseGuard(fixture, ['stacked', '20']);
    assert.equal(result.status, 3, 'a mutable base must be checked against its live ref');
    assert.equal(result.count, 25);
    assert.ok(fetchCount(fixture) >= 1, 'stacked bases must refresh even when the cached count passes');
  });

  test('a genuine violation still fails, after a corrective fetch confirmed it', () => {
    const fixture = makeCloneWithOrigin({ aheadCommits: 25 });
    const result = baseGuard(fixture, ['main', '20']);
    assert.equal(result.status, 3, 'exit 3 = violation, distinct from pass and from usage error');
    assert.equal(result.count, 25);
    assert.ok(fetchCount(fixture) >= 1, 'a suspected violation must be re-checked against a fresh ref');
  });

  test('a stale-ref false positive passes after the corrective fetch (the case the old unconditional fetch existed for)', () => {
    const fixture = makeCloneWithOrigin({ aheadCommits: 25 });
    const { clone } = fixture;
    // Land the 25 commits on origin/main (they ARE main now), then branch one
    // commit past them — but rewind the local remote-tracking ref so the
    // cached count reads 26 while the true count is 1.
    git(clone, ['push', '--quiet', 'origin', 'feature:main']);
    write(clone, 'tip.txt', 'tip\n');
    git(clone, ['add', '-A']);
    git(clone, ['commit', '--quiet', '-m', 'tip']);
    const staleBase = git(clone, ['rev-list', '--max-parents=0', 'HEAD']).trim();
    git(clone, ['update-ref', 'refs/remotes/origin/main', staleBase]);

    const result = baseGuard(fixture, ['main', '20']);
    assert.equal(result.status, 0, 'must not false-positive against the stale ref');
    assert.equal(result.count, 1);
    assert.ok(fetchCount(fixture) >= 1);
  });

  test('a base with no local remote-tracking ref fetches and resolves', () => {
    const fixture = makeCloneWithOrigin({ aheadCommits: 1 });
    git(fixture.clone, ['update-ref', '-d', 'refs/remotes/origin/main']);
    const result = baseGuard(fixture, ['main', '20']);
    assert.equal(result.status, 0);
    assert.equal(result.count, 1);
    assert.ok(fetchCount(fixture) >= 1);
  });

  test('fetches stay bounded when neither timeout nor gtimeout is on PATH', () => {
    for (const [label, aheadCommits, removeRef] of [
      ['cached violation', 25, false],
      ['missing remote-tracking ref', 1, true],
    ]) {
      const fixture = makeCloneWithOrigin({ aheadCommits });
      if (removeRef) git(fixture.clone, ['update-ref', '-d', 'refs/remotes/origin/main']);
      const path = makeTimeoutlessPath(fixture);
      const started = Date.now();
      const result = baseGuard(fixture, ['main', '20'], {
        path,
        WM_PREPUSH_FETCH_TIMEOUT_MS: '200',
      });

      const elapsed = Date.now() - started;
      assert.ok(elapsed < 3000, `${label} must return after the portable deadline`);
      assert.ok(fetchCount(fixture) >= 1, `${label} must exercise the corrective fetch (result=${JSON.stringify(result)})`);
      if (removeRef) {
        assert.equal(result.status, 0);
        assert.equal(result.base, 'main');
      } else {
        assert.equal(result.status, 3);
        assert.equal(result.count, 25);
      }
    }
  });

  test('an unresolvable base falls back to origin/main, like the hook always did', () => {
    const fixture = makeCloneWithOrigin({ aheadCommits: 1 });
    const result = baseGuard(fixture, ['no-such-base', '20']);
    assert.equal(result.status, 0);
    assert.equal(result.base, 'main', 'the resolved base is reported so the hook can use it');
    assert.equal(result.count, 1);
  });
});

describe('per-gate cache keys one gate on its own worktree inputs (#6765)', () => {
  // The whole-tree cache never hits in a merge/amend loop — any byte anywhere
  // invalidates every gate. gate-read/gate-write key ONE gate on the worktree
  // bytes of its declared inputs. Every case executes the real script against
  // a real repo; the refusal rules mirror cache-read/cache-write.
  function makeGateRepo() {
    const root = makeRepo({
      baseFiles: {
        'docs/readme.md': 'docs\n',
        'docs/café notes.md': 'unicode path\n',
        'src/app.ts': 'code\n',
      },
    });
    return { root, cache: join(root, '.git', 'wm-prepush-gate-cache') };
  }

  const gateRead = (fx, gate, diffResolved, specs) =>
    attest(fx.root, ['gate-read', fx.cache, gate, diffResolved, '--', ...specs]).status;
  const gateWrite = (fx, gate, diffResolved, attestable, specs) =>
    attest(fx.root, ['gate-write', fx.cache, gate, diffResolved, attestable, '--', ...specs]).status;

  test('hit: an unchanged input set read back after a green write', () => {
    const fx = makeGateRepo();
    assert.equal(gateRead(fx, 'lint-md', 'true', ['docs']), 3, 'no entry yet -> miss');
    assert.equal(gateWrite(fx, 'lint-md', 'true', 'true', ['docs']), 0);
    assert.equal(gateRead(fx, 'lint-md', 'true', ['docs']), 0, 'identical inputs -> hit');
  });

  test('miss: changing a declared input (including a unicode-named one) invalidates the gate', () => {
    const fx = makeGateRepo();
    gateWrite(fx, 'lint-md', 'true', 'true', ['docs']);
    write(fx.root, 'docs/café notes.md', 'edited\n');
    assert.equal(gateRead(fx, 'lint-md', 'true', ['docs']), 3, 'a C-quotable path must still be part of the key');
  });

  test('no cross-gate invalidation: changing gate B inputs leaves gate A green', () => {
    const fx = makeGateRepo();
    gateWrite(fx, 'typecheck', 'true', 'true', ['src']);
    write(fx.root, 'docs/readme.md', 'changed\n');
    assert.equal(gateRead(fx, 'typecheck', 'true', ['src']), 0, 'docs edits must not re-pay the typecheck');
    assert.equal(gateRead(fx, 'typecheck', 'true', ['docs']), 3, 'same gate, different input set -> different key');
  });

  test('untracked-but-unignored files are inputs; gitignored output is not', () => {
    const fx = makeGateRepo();
    gateWrite(fx, 'lint-md', 'true', 'true', ['docs']);
    write(fx.root, 'docs/new-page.md', 'brand new\n');
    assert.equal(gateRead(fx, 'lint-md', 'true', ['docs']), 3, 'a NEW file is an input change');
    rmSync(join(fx.root, 'docs/new-page.md'));
    assert.equal(gateRead(fx, 'lint-md', 'true', ['docs']), 0, 'removing it restores the key');
    write(fx.root, '.gitignore', 'docs/generated/\n');
    git(fx.root, ['add', '.gitignore']);
    git(fx.root, ['commit', '--quiet', '-m', 'ignore output']);
    gateWrite(fx, 'lint-md', 'true', 'true', ['docs']);
    write(fx.root, 'docs/generated/out.md', 'build output\n');
    assert.equal(gateRead(fx, 'lint-md', 'true', ['docs']), 0, 'ignored build output must not churn the key');
  });

  test('refusals mirror the whole-tree cache: dirty worktree cannot write, unresolved diff can neither write nor read', () => {
    const fx = makeGateRepo();
    const refused = attest(fx.root, ['gate-write', fx.cache, 'lint-md', 'true', 'false', '--', 'docs']);
    assert.equal(refused.status, 3);
    assert.match(refused.stdout, /not byte-identical/);
    assert.equal(existsSync(join(fx.cache, 'lint-md')), false, 'a refused write must leave no entry');

    assert.equal(gateWrite(fx, 'lint-md', 'false', 'true', ['docs']), 3, 'RUN_ALL runs must not mint entries');
    gateWrite(fx, 'lint-md', 'true', 'true', ['docs']);
    assert.equal(gateRead(fx, 'lint-md', 'false', ['docs']), 3, 'a blind run must not trust entries either');
  });

  test('a second worktree with identical bytes shares the hit through the common cache dir', () => {
    const fx = makeGateRepo();
    gateWrite(fx, 'typecheck', 'true', 'true', ['src']);
    const second = join(fx.root, '..', `${fx.root.split('/').pop()}-wt2`);
    git(fx.root, ['worktree', 'add', '--detach', '--quiet', second, 'main']);
    fixtures.push(second);
    // The hook derives the cache dir from --git-common-dir, which resolves to
    // the SAME location from both worktrees; here that dir is passed
    // explicitly, so assert the resolution too.
    const commonFromSecond = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: second, env: isolatedGitEnv(), encoding: 'utf8',
    }).trim();
    // realpath both sides: macOS reports /var as /private/var.
    assert.equal(realpathSync(commonFromSecond), realpathSync(join(fx.root, '.git')));
    const status = attest(second, ['gate-read', fx.cache, 'typecheck', 'true', '--', 'src']).status;
    assert.equal(status, 0, 'identical input bytes in a sibling worktree must hit');
  });

  test('a gate name that could escape the cache dir is a usage error', () => {
    const fx = makeGateRepo();
    assert.equal(gateWrite(fx, '../evil', 'true', 'true', ['docs']), 2);
    assert.equal(existsSync(join(fx.root, '.git', 'evil')), false);
  });
});
