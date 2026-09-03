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
  declaresNodeRuntime,
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

  test('bundles a route that declares runtime nodejs with the node platform, where node: built-ins resolve', async () => {
    // api/mcp-proxy.ts (GHSA-887j socket pin) imports node:https on purpose.
    // The browser bundle would reject it; the node-platform bundle must still
    // run so an unresolvable import in its graph fails the gate.
    const root = makeRepo();
    write(
      root,
      'api/pinned.ts',
      "import https from 'node:https';\n" +
        "export const config = { runtime: 'nodejs' };\n" +
        'export default function handler(req, res) { res.end(String(typeof https.request)); }\n',
    );
    write(root, 'api/pinned-broken.ts', "export const config = { runtime: 'nodejs' };\nimport './does-not-exist.js';\n");
    git(root, ['add', 'api/pinned.ts']);

    const entries = await checkEdgeFunctionBundles({ root });
    assert.ok(entries.includes('api/pinned.ts'));

    git(root, ['add', 'api/pinned-broken.ts']);
    await assert.rejects(
      checkEdgeFunctionBundles({ root }),
      /Could not resolve "\.\/does-not-exist\.js"/,
    );
  });

  test('declaresNodeRuntime keys on the static runtime declaration only', () => {
    assert.equal(declaresNodeRuntime("export const config = { runtime: 'nodejs' };"), true);
    assert.equal(declaresNodeRuntime('export const config = { runtime: "nodejs" };'), true);
    assert.equal(declaresNodeRuntime("export const config = { runtime: 'edge' };"), false);
    assert.equal(declaresNodeRuntime('export default function handler(req, res) {}'), false);

    // The four cases above also pass for a plain /runtime\s*:\s*['"]nodejs['"]/
    // match over the raw text, so on their own they do not pin the "static
    // declaration only" claim in this test's name. These do: an Edge route
    // that merely MENTIONS the Node runtime must stay Edge, or the bundle gate
    // puts it on esbuild's node platform and its node: imports resolve against
    // a runtime that rejects them at load. api/mcp-proxy.ts carries exactly
    // such a comment alongside its real declaration.
    assert.equal(
      declaresNodeRuntime("// #4749 shipped this under runtime: 'nodejs' and 500'd\nexport const config = { runtime: 'edge' };"),
      false,
      'a comment mentioning the Node runtime must not reclassify an Edge route',
    );
    assert.equal(
      declaresNodeRuntime("export const config = { runtime: 'edge' };\nconst REMEDY = \"write runtime: 'nodejs' as a literal\";"),
      false,
      'an unrelated string literal must not reclassify an Edge route',
    );
    assert.equal(
      declaresNodeRuntime("const config = { runtime: 'nodejs' };"),
      false,
      'Vercel reads the EXPORTED config; an unexported local of the same name is not a declaration',
    );
  });

  test('CI bundles a Node-runtime route even though it is not on the legacy TS allowlist', async () => {
    // The legacy allowlist predates the platform:'node' branch and names only
    // api/mcp.ts, so without this exception the branch a Node-runtime route
    // takes is exercised on the pushing developer's machine and never in CI —
    // the merge gate would be blind to an unresolvable import in its graph.
    const root = makeRepo();
    write(
      root,
      'api/pinned-ci.ts',
      "export const config = { runtime: 'nodejs' };\n" +
        "import './missing-in-ci.js';\n" +
        'export default function handler(req, res) { res.end(); }\n',
    );
    write(root, 'api/edge-only.ts', "export const config = { runtime: 'edge' };\nexport default function handler() { return new Response('ok'); }\n");
    git(root, ['add', 'api/pinned-ci.ts', 'api/edge-only.ts']);

    const ciEntries = listEdgeFunctionEntries(root, { caller: 'ci' });
    assert.ok(ciEntries.includes('api/pinned-ci.ts'), 'a Node-runtime route must be bundled in CI');
    assert.ok(
      !ciEntries.includes('api/edge-only.ts'),
      'the exception is scoped to Node-runtime routes; other top-level TS still follows the legacy allowlist',
    );

    await assert.rejects(
      checkEdgeFunctionBundles({ root, caller: 'ci' }),
      /Could not resolve "\.\/missing-in-ci\.js"/,
    );
  });

  test('a comment mentioning the Node runtime leaves an Edge route on the browser bundle', async () => {
    // End-to-end counterpart to the unit assertions above: the platform choice
    // is what actually disarms the node:-import guard, so prove it at the gate
    // and not only at the classifier.
    const root = makeRepo();
    write(
      root,
      'api/edge-mentions-node.js',
      "// The GHSA-887j pin needs runtime: 'nodejs'; this route does not.\n" +
        "import crypto from 'node:crypto';\n" +
        "export const config = { runtime: 'edge' };\n" +
        'export default function handler() { return new Response(String(typeof crypto)); }\n',
    );
    git(root, ['add', 'api/edge-mentions-node.js']);

    await assert.rejects(
      checkEdgeFunctionBundles({ root }),
      /Could not resolve "node:crypto"/,
      'the route must still be bundled for the browser platform, where node: built-ins do not resolve',
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
