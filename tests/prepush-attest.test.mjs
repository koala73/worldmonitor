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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
