import test from 'node:test';
import assert from 'node:assert/strict';

import {
  commitIsOnRemoteMain,
  resolveReleaseContext,
  validateVersionSync,
} from '../scripts/release-context.mjs';

test('release context derives publish metadata from tag pushes', () => {
  assert.deepEqual(
    resolveReleaseContext({
      event: 'push',
      refName: 'refs/tags/v2.7.2-tech',
      packageVersion: '2.7.2',
      sha: 'abcdef1234567890',
    }),
    {
      publish: true,
      variant: 'tech',
      version: '2.7.2',
      tag: 'v2.7.2-tech',
      releaseName: 'Tech Monitor v2.7.2',
      productName: 'Tech Monitor',
      commitSha: 'abcdef1234567890',
      shortSha: 'abcdef123456',
    },
  );
});

test('release context uses build-only mode for workflow dispatch', () => {
  assert.equal(
    resolveReleaseContext({
      event: 'workflow_dispatch',
      inputVariant: 'finance',
      packageVersion: '2.7.2',
      sha: 'abcdef1234567890',
    }).publish,
    false,
  );
});

test('release context validates synchronized versions and origin/main ancestry', () => {
  assert.deepEqual(
    validateVersionSync({
      packageVersion: '2.7.2',
      tauriVersion: '2.7.2',
      cargoVersion: '2.7.2',
      cargoLockVersion: '2.7.2',
      infoPlistVersion: '2.7.2',
    }),
    [],
  );
  assert.equal(commitIsOnRemoteMain('  origin/main\n  origin/feature\n'), true);
  assert.equal(commitIsOnRemoteMain('  origin/release\n'), false);
});
