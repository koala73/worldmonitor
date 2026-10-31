import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  CLOUD_ONLY_ROUTES,
  checkShippedRoutes,
  shippedResourcePath,
} from '../scripts/check-sidecar-shipped-routes.mjs';

const handler = 'export default function handler() { return new Response("ok"); }\n';

/** A repo with the files given, plus a tauri.conf.json shipping ../api and ../shared/ok.js. */
function makeRepo(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wm-shipped-routes-test-'));
  const all = {
    'src-tauri/tauri.conf.json': JSON.stringify({ bundle: { resources: ['../api', '../shared/ok.js'] } }),
    'shared/ok.js': 'export const ok = true;\n',
    'shared/unshipped.js': 'export const unshipped = true;\n',
    // Installed in the repo, as on a CI runner, but never shipped.
    'node_modules/installed-pkg/package.json': JSON.stringify({ name: 'installed-pkg', type: 'module', main: 'index.js' }),
    'node_modules/installed-pkg/index.js': 'export const value = 1;\n',
    ...files,
  };
  for (const [file, content] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  return root;
}

async function check(files, options = {}) {
  const root = makeRepo(files);
  try {
    return await checkShippedRoutes(root, { isCloudPreferred: () => false, cloudOnlyRoutes: new Map(), ...options });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('shippedResourcePath', () => {
  it('lifts leading ../ segments under _up_ like Tauri', () => {
    assert.equal(shippedResourcePath('../api'), '_up_/api');
    assert.equal(shippedResourcePath('../../x/y.js'), '_up_/_up_/x/y.js');
    assert.equal(shippedResourcePath('sidecar/local-api-server.mjs'), 'sidecar/local-api-server.mjs');
  });
});

describe('checkShippedRoutes', () => {
  it('passes routes that load from the shipped files alone', async () => {
    const result = await check({
      'api/ok.js': `import { ok } from '../shared/ok.js';\nimport { helper } from './_helper.js';\n${handler}`,
      'api/_helper.js': 'export const helper = 1;\n',
      'api/nested/route.js': handler,
    });
    assert.deepEqual(result, { routes: 2, missingBundles: [], failures: [] });
  });

  it('fails a route importing a package the repo has installed but the app does not ship', async () => {
    const result = await check({ 'api/uses-pkg.js': `import { value } from 'installed-pkg';\n${handler}` });
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].route, 'uses-pkg.js');
    assert.match(result.failures[0].reason, /Cannot find (module|package) 'installed-pkg'/);
  });

  it('fails a route reaching a repo file outside the shipped resources, through a helper', async () => {
    const result = await check({
      'api/feed.js': `import { x } from './_reader.js';\n${handler}`,
      'api/_reader.js': "export { unshipped as x } from '../shared/unshipped.js';\n",
    });
    assert.deepEqual(result.failures.map((f) => f.route), ['feed.js']);
    assert.match(result.failures[0].reason, /shared\/unshipped\.js/);
    assert.doesNotMatch(result.failures[0].reason, /wm-sidecar-shipped-/, 'the temp stage path is masked');
  });

  it('fails a route without a default-export handler', async () => {
    const result = await check({ 'api/no-default.js': 'export const x = 1;\n' });
    assert.deepEqual(result.failures, [{ route: 'no-default.js', reason: 'default export is undefined' }]);
  });

  it('reports a domain whose handler bundle was not built', async () => {
    const result = await check({
      'api/built/v1/[rpc].ts': '',
      'api/built/v1/[rpc].js': handler,
      'api/unbuilt/v1/[rpc].ts': '',
    });
    assert.deepEqual(result.missingBundles, ['unbuilt']);
  });

  it('skips a cloud-only route only while the sidecar keeps it cloud-preferred', async () => {
    const files = { 'api/cloud.js': `import 'installed-pkg';\n${handler}` };
    const cloudOnlyRoutes = new Map([['cloud.js', '/api/cloud']]);

    const kept = await check(files, { cloudOnlyRoutes, isCloudPreferred: (p) => p === '/api/cloud' });
    assert.deepEqual(kept.failures, []);

    const dropped = await check(files, { cloudOnlyRoutes, isCloudPreferred: () => false });
    assert.deepEqual(dropped.failures.map((f) => f.route), ['cloud.js']);
    assert.match(dropped.failures[0].reason, /not treat \/api\/cloud as cloud-preferred/);
  });

  it('rejects a config without bundle resources', async () => {
    await assert.rejects(
      check({ 'src-tauri/tauri.conf.json': JSON.stringify({ bundle: {} }) }),
      /no bundle\.resources list/,
    );
  });
});

describe('repository wiring', () => {
  const root = path.resolve(import.meta.dirname, '..');

  it('exempts only routes that exist', () => {
    for (const route of CLOUD_ONLY_ROUTES.keys()) {
      assert.doesNotThrow(() => readFileSync(path.join(root, 'api', route)), `api/${route}`);
    }
  });

  it('runs on the shipped runtime in the sidecar job, after the handler bundles are built', () => {
    const workflow = readFileSync(path.join(root, '.github/workflows/test.yml'), 'utf8');
    const job = workflow.slice(workflow.indexOf('\n  sidecar:'), workflow.indexOf('\n  desktop-config:'));
    const build = job.indexOf('node scripts/build-sidecar-handlers.mjs');
    const shippedPath = job.indexOf('export PATH="$PWD/src-tauri/sidecar/node:$PATH"');
    const check = job.indexOf('node scripts/check-sidecar-shipped-routes.mjs');
    assert.ok(build > -1 && shippedPath > -1 && check > -1, 'sidecar job builds bundles and runs the check');
    assert.ok(build < check && shippedPath < check, 'the check runs after the build, on the shipped Node');
  });
});
