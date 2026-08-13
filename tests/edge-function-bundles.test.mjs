import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';
import {
  checkEdgeFunctionBundles,
  isolatedGitEnv,
  listEdgeFunctionEntries,
} from '../scripts/check-edge-function-bundles.mjs';

// Reuse the checker's own env isolation rather than reimplementing it — the
// previous local copy had already drifted from it. Fixtures additionally null
// the host git config so a developer's ~/.gitconfig cannot reach them.
const FIXTURE_GIT_ENV = isolatedGitEnv({
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
});

const CHECKER_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'check-edge-function-bundles.mjs',
);

const fixtures = [];
after(() => {
  for (const root of fixtures) rmSync(root, { recursive: true, force: true });
});

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    env: FIXTURE_GIT_ENV,
    encoding: 'utf8',
  });
}

function write(root, relativePath, contents) {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function makeRepo({ withEntries = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wm-edge-function-bundles-'));
  fixtures.push(root);
  git(root, ['init', '--quiet', '--initial-branch=main', '.']);

  if (!withEntries) {
    write(root, 'README.md', 'no API entries\n');
    git(root, ['add', 'README.md']);
    return root;
  }

  const validHandler = 'export default async function handler() { return new Response("ok"); }\n';
  write(root, '.gitignore', 'api/*/v1/\\[rpc\\].js\n');
  write(root, 'api/health.js', validHandler);
  write(root, 'api/normal.js', validHandler);
  write(root, 'api/paired.js', validHandler);
  write(root, 'api/paired.ts', validHandler);
  write(root, 'api/space route.js', validHandler);
  write(root, 'api/mcp.ts', validHandler);
  write(root, 'api/_helper.js', 'export const helper = true;\n');
  write(root, 'api/domain/v1/[rpc].ts', validHandler);
  write(root, 'api/domain/v1/[rpc].js', 'import "node:crypto";\n');
  write(root, 'api/stale/v1/[rpc].js', 'import "node:crypto";\n');
  write(root, 'api/v2/shipping/[rpc].js', validHandler);
  git(root, ['add', '-A']);

  assert.doesNotThrow(() => git(root, ['check-ignore', '--quiet', 'api/domain/v1/[rpc].js']));
  assert.doesNotThrow(() => git(root, ['check-ignore', '--quiet', 'api/stale/v1/[rpc].js']));
  return root;
}

describe('edge function candidate discovery', () => {
  test('selects tracked edge entries without local generated sidecar residue', () => {
    const root = makeRepo();
    assert.deepEqual(listEdgeFunctionEntries(root), [
      'api/health.js',
      'api/mcp.ts',
      'api/normal.js',
      'api/paired.js',
      'api/paired.ts',
      'api/space route.js',
      'api/v2/shipping/[rpc].js',
    ]);
  });

  test('pre-push discovery skips tracked edge entries missing only from the worktree', () => {
    const root = makeRepo();
    rmSync(join(root, 'api/health.js'));

    assert.deepEqual(listEdgeFunctionEntries(root, { caller: 'prepush' }), [
      'api/mcp.ts',
      'api/normal.js',
      'api/paired.js',
      'api/paired.ts',
      'api/space route.js',
      'api/v2/shipping/[rpc].js',
    ]);
  });

  test('CI keeps the legacy top-level TypeScript allowlist', () => {
    const root = makeRepo();
    assert.deepEqual(listEdgeFunctionEntries(root, { caller: 'ci' }), [
      'api/health.js',
      'api/mcp.ts',
      'api/normal.js',
      'api/paired.js',
      'api/space route.js',
      'api/v2/shipping/[rpc].js',
    ]);
  });

  test('the real checker ignores sidecar residue but still bundles tracked entries', async () => {
    const root = makeRepo();
    const entries = await checkEdgeFunctionBundles({ root });
    assert.ok(entries.includes('api/health.js'));
    assert.ok(!entries.includes('api/domain/v1/[rpc].js'));
  });

  test('the pre-push checker ignores a tracked entry deleted only locally', async () => {
    const root = makeRepo();
    rmSync(join(root, 'api/health.js'));

    const entries = await checkEdgeFunctionBundles({ root, caller: 'prepush' });
    assert.ok(!entries.includes('api/health.js'));
    assert.ok(entries.includes('api/normal.js'));
  });

  test('fails closed when no tracked edge entries exist', async () => {
    const root = makeRepo({ withEntries: false });
    await assert.rejects(
      checkEdgeFunctionBundles({ root }),
      /found zero tracked entrypoints/,
    );
  });

  test('still fails on a browser-incompatible tracked edge entry', async () => {
    const root = makeRepo();
    write(root, 'api/broken.js', 'import "node:crypto";\n');
    git(root, ['add', 'api/broken.js']);
    await assert.rejects(
      checkEdgeFunctionBundles({ root }),
      /Could not resolve "node:crypto"/,
    );
  });
});

/**
 * The tests above call the exported functions directly, which bypasses main(),
 * the entry guard, and the exit code — i.e. everything CI and .husky/pre-push
 * actually depend on. A checker whose main() never runs exits 0 having bundled
 * nothing, and that is indistinguishable from a clean gate. The wiring tests in
 * ci-workflow-coverage / prepush-attest only prove the command line is present
 * in the workflow and hook text, not that running it does any work.
 */
describe('edge function checker CLI contract', () => {
  function runChecker(root, args = []) {
    const result = spawnSync(process.execPath, [CHECKER_PATH, ...args], {
      cwd: root,
      env: FIXTURE_GIT_ENV,
      encoding: 'utf8',
    });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  test('exits 0 and reports the entry count on a clean tree', () => {
    const { status, stdout } = runChecker(makeRepo());
    assert.equal(status, 0, 'a clean fixture must pass');
    assert.match(stdout, /edge function bundles ok: \d+ tracked entrypoints/);
  });

  test('exits non-zero on a browser-incompatible tracked entry', () => {
    const root = makeRepo();
    write(root, 'api/broken.js', 'import "node:crypto";\n');
    git(root, ['add', 'api/broken.js']);

    const { status, stderr } = runChecker(root);
    assert.equal(status, 1, 'a failing bundle must fail the gate, not just log');
    assert.match(stderr, /edge function bundle check failed/);
  });

  test('exits non-zero when discovery finds nothing', () => {
    const { status, stderr } = runChecker(makeRepo({ withEntries: false }));
    assert.equal(status, 1, 'zero entrypoints must fail closed through the CLI too');
    assert.match(stderr, /zero tracked entrypoints/);
  });

  test('--list prints the discovered entries as JSON', () => {
    const { status, stdout } = runChecker(makeRepo(), ['--list']);
    assert.equal(status, 0);
    assert.ok(JSON.parse(stdout).includes('api/health.js'));
  });

  test('--caller=ci preserves the legacy TypeScript entry scope', () => {
    const { status, stdout } = runChecker(makeRepo(), ['--list', '--caller=ci']);
    assert.equal(status, 0);
    assert.deepEqual(JSON.parse(stdout), [
      'api/health.js',
      'api/mcp.ts',
      'api/normal.js',
      'api/paired.js',
      'api/space route.js',
      'api/v2/shipping/[rpc].js',
    ]);
  });

  test('--caller=prepush still passes when an unrelated tracked entry is deleted locally', () => {
    const root = makeRepo();
    rmSync(join(root, 'api/health.js'));

    const { status, stdout, stderr } = runChecker(root, ['--caller=prepush']);
    assert.equal(status, 0, stderr);
    assert.match(stdout, /edge function bundles ok/);
  });

  test('runs when reached through a symlinked absolute path', () => {
    const root = makeRepo();
    // path.resolve() does NOT resolve symlinks while Node sets import.meta.url
    // to the realpath, so a naive entry guard returns false here and the gate
    // exits 0 having checked nothing (#4246). Invoke through a symlinked copy
    // of the scripts dir to pin the realpath-safe guard.
    const linkDir = mkdtempSync(join(tmpdir(), 'wm-edge-checker-link-'));
    fixtures.push(linkDir);
    const linkedChecker = join(linkDir, 'check-edge-function-bundles.mjs');
    symlinkSync(CHECKER_PATH, linkedChecker);

    const result = spawnSync(process.execPath, [linkedChecker], {
      cwd: root,
      env: FIXTURE_GIT_ENV,
      encoding: 'utf8',
    });
    assert.equal(
      result.status,
      0,
      `symlinked invocation must still run the gate, got ${result.status}: ${result.stderr}`,
    );
    assert.match(
      result.stdout ?? '',
      /edge function bundles ok/,
      'a silent exit 0 with no output means main() never ran — the fail-open this guards',
    );
  });
});
