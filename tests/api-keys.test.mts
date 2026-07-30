import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKey } from '../src/services/api-keys.ts';

test('generateKey produces distinct, high-entropy keys', () => {
  const keys = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const key = generateKey();
    assert.match(key, /^wm_[0-9a-f]{40}$/);
    keys.add(key);
  }
  // If getRandomValues is replaced with fill(0), every key becomes identical.
  assert.equal(keys.size, 100, 'expected 100 unique keys');
});
