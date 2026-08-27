// Guards tests/helpers/temp-dir.mjs.
//
// The point of the helper is that cleanup survives a THROWN test. Asserting
// that from inside a passing test proves nothing, so the exception cases run
// in child processes whose temp-dir paths are printed on stdout and checked
// from here after the child has exited.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTempDir, pendingTempDirCount, removeTempDir } from './helpers/temp-dir.mjs';

const helperUrl = new URL('./helpers/temp-dir.mjs', import.meta.url).href;

/** Run `body` in a child node process; return {stdout, status}. */
function runChild(body) {
  const source = `import { createTempDir } from ${JSON.stringify(helperUrl)};\n${body}`;
  const result = execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', source],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] , env: { ...process.env } },
  );
  return result.trim();
}

/** Same, but the child is expected to exit non-zero. */
function runFailingChild(body) {
  const source = `import { createTempDir } from ${JSON.stringify(helperUrl)};\n${body}`;
  try {
    execFileSync(process.execPath, ['--input-type=module', '--eval', source], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout: '', threw: false };
  } catch (error) {
    return { stdout: String(error.stdout ?? '').trim(), threw: true };
  }
}

describe('createTempDir', () => {
  it('creates a usable directory', (t) => {
    const dir = createTempDir('wm-temp-helper-basic-', t);
    writeFileSync(join(dir, 'probe.txt'), 'ok');
    assert.ok(existsSync(join(dir, 'probe.txt')));
  });

  it('removes the directory when the test context ends', () => {
    // Drive the t.after path with a stand-in context so the registered hook can
    // be fired here and its effect asserted — a real `t` would only run its
    // hooks after this test had already returned.
    const fakeContext = {
      hooks: [],
      after(fn) {
        this.hooks.push(fn);
      },
    };
    const captured = createTempDir('wm-temp-helper-ctx-', fakeContext);
    assert.ok(existsSync(captured), 'directory should exist before cleanup');
    assert.equal(fakeContext.hooks.length, 1, 'cleanup must be registered at creation');
    for (const fn of fakeContext.hooks) fn();
    assert.equal(existsSync(captured), false, 'directory should be gone after t.after ran');
  });

  it('registers for the exit sweep when no test context is given', () => {
    const before = pendingTempDirCount();
    const dir = createTempDir('wm-temp-helper-sweep-');
    assert.equal(pendingTempDirCount(), before + 1);
    removeTempDir(dir);
    assert.equal(pendingTempDirCount(), before, 'removeTempDir must deregister');
    assert.equal(existsSync(dir), false);
  });

  it('cleans up after a child process exits normally', () => {
    const dir = runChild(
      "const d = createTempDir('wm-temp-helper-child-'); console.log(d);",
    );
    assert.ok(dir.length > 0, 'child should print the temp dir path');
    assert.equal(existsSync(dir), false, `child temp dir leaked: ${dir}`);
  });

  it('cleans up even when the child THROWS', () => {
    const { stdout, threw } = runFailingChild(
      "const d = createTempDir('wm-temp-helper-throw-'); console.log(d); throw new Error('boom');",
    );
    assert.equal(threw, true, 'child was supposed to fail');
    assert.ok(stdout.length > 0, 'child should have printed the path before throwing');
    assert.equal(existsSync(stdout), false, `temp dir leaked on throw: ${stdout}`);
  });

  it('cleans up when the child exits non-zero without throwing', () => {
    const { stdout } = runFailingChild(
      "const d = createTempDir('wm-temp-helper-exit1-'); console.log(d); process.exitCode = 1;",
    );
    assert.ok(stdout.length > 0);
    assert.equal(existsSync(stdout), false, `temp dir leaked on exit 1: ${stdout}`);
  });
});

/**
 * Find `rmSync(<v>, …)` where `<v>` came from `createTempDir`. That deletes the
 * directory but leaves its path registered in the exit sweep, so the sweep
 * retries an already-gone path forever. `removeTempDir` deregisters; a bare
 * `rmSync` does not.
 *
 * @param {string} source File contents.
 * @returns {string[]} Names of the offending variables.
 */
function findStaleRegistrations(source) {
  const owned = new Set(
    [...source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*createTempDir\(/g)].map(m => m[1]),
  );
  if (!owned.size) return [];
  return [...source.matchAll(/\brmSync\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g)]
    .map(m => m[1])
    .filter(name => owned.has(name));
}

describe('no stale exit-sweep registrations', () => {
  // Positive controls first: a scan that only ever asserts "nothing found"
  // passes just as happily when the detector is broken as when the repo is clean.
  it('DETECTS a bare rmSync on a createTempDir result', () => {
    const bad = "const dir = createTempDir('x-');\nrmSync(dir, { recursive: true, force: true });";
    assert.deepEqual(findStaleRegistrations(bad), ['dir']);
  });

  it('DETECTS it inside a cleanup callback', () => {
    const bad = "const tempDir = createTempDir('x-');\nreturn { cleanup() { rmSync(tempDir, { force: true }); } };";
    assert.deepEqual(findStaleRegistrations(bad), ['tempDir']);
  });

  it('ACCEPTS removeTempDir, and ignores rmSync on unrelated paths', () => {
    const good = "const dir = createTempDir('x-');\nrmSync(someOtherPath, { force: true });\nremoveTempDir(dir);";
    assert.deepEqual(findStaleRegistrations(good), []);
  });

  it('finds none in the repo', () => {
    const files = execSync(
      "grep -rl 'createTempDir' tests scripts --include='*.mjs' --include='*.mts' --include='*.js' 2>/dev/null || true",
      { encoding: 'utf8', cwd: fileURLToPath(new URL('..', import.meta.url)), maxBuffer: 1 << 24 },
    ).trim().split('\n').filter(Boolean);

    assert.ok(files.length >= 6, `expected the helper to have consumers, found ${files.length}`);

    const offenders = [];
    for (const rel of files) {
      // This file's positive controls are deliberately-bad source held in string
      // literals; the detector cannot tell them from real code, and should not.
      if (rel.endsWith('tests/temp-dir-helper.test.mjs')) continue;
      const abs = fileURLToPath(new URL(`../${rel}`, import.meta.url));
      for (const name of findStaleRegistrations(readFileSync(abs, 'utf8'))) {
        offenders.push(`${rel}: rmSync(${name}) — use removeTempDir(${name})`);
      }
    }
    assert.deepEqual(offenders, [], `stale registrations:\n${offenders.join('\n')}`);
  });
});
