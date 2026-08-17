import assert from 'node:assert/strict';
import { test } from 'node:test';

import { __testing__ as healthTesting } from '../api/health.js';
import { BOOTSTRAP_CACHE_KEYS as edgeBootstrapKeys } from '../api/_bootstrap-tier-keys.js';
import { BOOTSTRAP_CACHE_KEYS as sharedBootstrapKeys } from '../shared/bootstrap-tier-keys.js';

test('Giving uses the same cache key across bootstrap and health', () => {
  assert.equal(sharedBootstrapKeys.giving, 'giving:summary:v2');
  assert.equal(edgeBootstrapKeys.giving, 'giving:summary:v2');
  assert.equal(healthTesting.STANDALONE_KEYS.giving, 'giving:summary:v2');
});
