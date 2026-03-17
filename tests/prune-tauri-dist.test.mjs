import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  findPrunableAssetPaths,
  getCanonicalAssetPath,
} from '../scripts/prune-tauri-dist.mjs';

test('getCanonicalAssetPath normalizes iCloud-style duplicate asset names', () => {
  assert.equal(
    getCanonicalAssetPath('/tmp/dist/index 3.html'),
    '/tmp/dist/index.html',
  );
  assert.equal(
    getCanonicalAssetPath('/tmp/dist/assets/main-BRsK0jEv 2.css'),
    '/tmp/dist/assets/main-BRsK0jEv.css',
  );
  assert.equal(
    getCanonicalAssetPath('/tmp/dist/assets/locale-es.js 3.br'),
    '/tmp/dist/assets/locale-es.js.br',
  );
  assert.equal(getCanonicalAssetPath('/tmp/dist/assets/release 2026.txt'), null);
});

test(
  'findPrunableAssetPaths returns only duplicate assets with live canonical counterparts',
  async (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'wm-prune-dist-'));
    t.after(async () => {
      await rm(root, { recursive: true, force: true });
    });

    mkdirSync(path.join(root, 'assets'), { recursive: true });
    writeFileSync(path.join(root, 'index.html'), '<html></html>');
    writeFileSync(path.join(root, 'index 3.html'), '<html></html>');
    writeFileSync(path.join(root, 'assets', 'main.css'), 'body {}');
    writeFileSync(path.join(root, 'assets', 'main 2.css'), 'body {}');
    writeFileSync(path.join(root, 'assets', 'release 2026.txt'), 'keep');
    writeFileSync(path.join(root, 'assets', 'orphan 2.css'), 'keep');

    const matches = (await findPrunableAssetPaths(root))
      .map((filePath) => path.relative(root, filePath))
      .sort();

    assert.deepEqual(matches, [
      'assets/main 2.css',
      'index 3.html',
    ]);
  },
);
