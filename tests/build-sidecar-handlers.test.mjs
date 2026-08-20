import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { discoverSidecarHandlerEntries } from '../scripts/build-sidecar-handlers.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = join(root, 'api');

test('handler discovery includes both legacy and version-major RPC layouts', async () => {
  const entries = await discoverSidecarHandlerEntries(apiDir);
  const relativeEntries = entries.map(({ relativePath }) => relativePath);

  assert.ok(
    relativeEntries.includes('market/v1/[rpc].ts'),
    'legacy api/{domain}/v1/[rpc].ts handlers must continue to be bundled'
  );
  assert.ok(
    relativeEntries.includes('v2/shipping/[rpc].ts'),
    'version-major api/v{major}/{domain}/[rpc].ts handlers must be bundled; shipping is currently omitted on desktop'
  );
});

test('handler discovery excludes non-RPC routes in version-major families', async () => {
  const tempRoot = await mkdtemp(join(root, '.tmp-sidecar-discovery-'));
  const fixtureApiDir = join(tempRoot, 'api');
  const files = [
    'market/v1/[rpc].ts',
    'v2/shipping/[rpc].ts',
    'v2/shipping/webhooks/[subscriberId].ts',
    'v3/not-a-domain/[rpc].js',
  ];

  try {
    for (const file of files) {
      const target = join(fixtureApiDir, ...file.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, '', 'utf8');
    }

    const entries = await discoverSidecarHandlerEntries(fixtureApiDir);

    assert.deepEqual(
      entries.map(({ relativePath }) => relativePath),
      ['market/v1/[rpc].ts', 'v2/shipping/[rpc].ts']
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
