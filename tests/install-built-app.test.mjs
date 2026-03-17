import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSwapPaths,
} from '../scripts/install-built-app.mjs';

test('install-built-app derives deterministic staged and backup paths', () => {
  assert.deepEqual(
    buildSwapPaths('/Users/bradleybond/Applications/World Monitor.app'),
    {
      parent: '/Users/bradleybond/Applications',
      staged: '/Users/bradleybond/Applications/World Monitor.app.main-sync-staged',
      backup: '/Users/bradleybond/Applications/World Monitor.app.main-sync-backup',
    },
  );
});
