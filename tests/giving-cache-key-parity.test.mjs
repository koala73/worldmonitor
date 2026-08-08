import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { __testing__ as healthTesting } from '../api/health.js';
import { BOOTSTRAP_CACHE_KEYS as edgeBootstrapKeys } from '../api/_bootstrap-tier-keys.js';
import { BOOTSTRAP_CACHE_KEYS as sharedBootstrapKeys } from '../shared/bootstrap-tier-keys.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('Giving uses v2 across server, bootstrap, and health without a v1 migration path', () => {
  assert.equal(sharedBootstrapKeys.giving, 'giving:summary:v2');
  assert.equal(edgeBootstrapKeys.giving, 'giving:summary:v2');
  assert.equal(healthTesting.STANDALONE_KEYS.giving, 'giving:summary:v2');

  const correctedFiles = [
    'server/worldmonitor/giving/v1/get-giving-summary.ts',
    'shared/bootstrap-tier-keys.js',
    'api/_bootstrap-tier-keys.js',
    'api/health.js',
  ];
  for (const relPath of correctedFiles) {
    const source = readFileSync(resolve(root, relPath), 'utf8');
    assert.doesNotMatch(source, /giving:summary:v1/, `${relPath} must neither read nor copy the rollback-only v1 key`);
  }
});
