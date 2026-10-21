import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// #5908 retired per-variant desktop packaging. The packager's job is now to
// REFUSE a stale `--variant tech` invocation rather than quietly produce an
// unbranded full build the caller did not ask for — a guard that is worthless
// if it is never exercised.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = resolve(root, 'scripts/desktop-package.mjs');

function runPackager(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: root,
    encoding: 'utf8',
    // Keep the run hermetic: --help and the arg guards must resolve before the
    // script shells out to version sync or the Tauri CLI.
    env: { ...process.env, CI: '1' },
  });
}

test('rejects a retired --variant flag with a non-zero exit', () => {
  const result = runPackager(['--os', 'macos', '--variant', 'tech']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--variant flag was removed/);
  assert.match(result.stderr, /#5908/);
});

test('rejects a bare trailing --variant with no value', () => {
  // `getArg` returns undefined here, so a value-based check would let this
  // through and silently build the full variant.
  const result = runPackager(['--os', 'macos', '--variant']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--variant flag was removed/);
});

test('rejects --variant full too, rather than silently accepting it', () => {
  // Accepting `full` would keep the retired flag alive as a no-op and invite
  // per-variant invocations back.
  const result = runPackager(['--os', 'macos', '--variant', 'full']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--variant flag was removed/);
});

test('rejects an unknown or missing --os with usage', () => {
  for (const args of [[], ['--os', 'solaris']]) {
    const result = runPackager(args);
    assert.equal(result.status, 1, `args=${JSON.stringify(args)}`);
    assert.match(result.stderr, /Usage: npm run desktop:package/);
  }
});

test('--help documents the one-binary model and exits 0', () => {
  const result = runPackager(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: npm run desktop:package -- --os <macos\|windows\|linux>/);
  assert.doesNotMatch(result.stdout, /--variant/);
  assert.match(result.stdout, /selected in-app/);
});
