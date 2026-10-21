// Temp directories that clean themselves up.
//
// Tests and scripts across this repo call `mkdtempSync(join(tmpdir(), '...'))`
// and then delete the directory at the end of the test body. That shape leaks
// in three ways, all of which were found accumulating in a developer's
// `$TMPDIR` (~40,000 directories, oldest from May):
//
//   1. No delete at all — `mkdtempSync` imported, `rmSync` never was.
//   2. A cleanup list that only some call sites register with. The worst case
//      had 17 `makeTempDir()` calls and one `fixtures.push()`, so 16 leaked
//      while `rmSync` sat in the file looking like cleanup existed.
//   3. Delete placed after the assertions, so a FAILING test leaks. Shared
//      harnesses with this shape leak once per failing consumer.
//
// `createTempDir` removes all three by construction: the directory is
// registered for deletion at the moment it is created, so there is no second
// call site to forget and no code path that skips it.
//
// Pass the `node:test` context `t` whenever one is in scope — cleanup then
// runs at the end of that test, keeping runs isolated from each other. Without
// `t` (module scope, shared harnesses, plain scripts) it falls back to a
// process-exit sweep, which still covers thrown assertions and early returns.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Directories awaiting the process-exit sweep. */
const pending = new Set();
let sweepInstalled = false;

function installSweep() {
  if (sweepInstalled) return;
  sweepInstalled = true;
  // 'exit' only permits synchronous work, which is why this uses rmSync.
  process.on('exit', () => {
    for (const dir of pending) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best effort: a temp dir we cannot remove must not mask the real
        // exit code or the assertion failure that got us here.
      }
    }
    pending.clear();
  });
}

/**
 * Create a temp directory under the OS temp dir that deletes itself.
 *
 * @param {string} prefix `mkdtemp` prefix, e.g. `'wm-seed-env-'`. Keep the
 *   trailing dash so the random suffix stays readable.
 * @param {{ after?: (fn: () => void) => void }} [t] `node:test` context. When
 *   given, cleanup runs via `t.after()` at the end of that test instead of at
 *   process exit.
 * @returns {string} Absolute path to the new directory.
 */
export function createTempDir(prefix, t) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  if (t && typeof t.after === 'function') {
    t.after(() => {
      pending.delete(dir);
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // See above — cleanup must never change a test's verdict.
      }
    });
    return dir;
  }
  installSweep();
  pending.add(dir);
  return dir;
}

/**
 * Delete a directory from `createTempDir` early, before its scheduled sweep.
 * Only needed by tests that assert on the directory being gone.
 *
 * @param {string} dir Path previously returned by `createTempDir`.
 */
export function removeTempDir(dir) {
  pending.delete(dir);
  rmSync(dir, { recursive: true, force: true });
}

/** Directories still awaiting cleanup. Exposed for this helper's own tests. */
export function pendingTempDirCount() {
  return pending.size;
}
