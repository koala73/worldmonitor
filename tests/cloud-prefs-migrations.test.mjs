import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Exercises the applyMigrations() plumbing from cloud-prefs-sync.ts.
 *
 * The function is not exported (internal), so we replicate the algorithm here
 * with a real migration map to prove the loop + fallthrough logic works before
 * it's needed in production.  (Issue #2906 item 3)
 */

function applyMigrations(data, fromVersion, currentVersion, migrations) {
  let result = data;
  for (let v = fromVersion + 1; v <= currentVersion; v++) {
    result = migrations[v]?.(result) ?? result;
  }
  return result;
}

describe('applyMigrations (cloud-prefs-sync plumbing)', () => {
  const MIGRATIONS = {
    2: (data) => {
      // Simulate renaming a preference key
      const out = { ...data };
      if ('oldKey' in out) {
        out.newKey = out.oldKey;
        delete out.oldKey;
      }
      return out;
    },
    3: (data) => {
      // Simulate adding a default for a new preference
      const out = { ...data };
      if (!('addedInV3' in out)) out.addedInV3 = 'default-value';
      return out;
    },
  };

  it('no-op when already at current version', () => {
    const data = { foo: 'bar' };
    const result = applyMigrations(data, 1, 1, MIGRATIONS);
    assert.deepEqual(result, { foo: 'bar' });
  });

  it('applies a single v1 -> v2 migration', () => {
    const data = { oldKey: 'hello', keep: 42 };
    const result = applyMigrations(data, 1, 2, MIGRATIONS);
    assert.deepEqual(result, { newKey: 'hello', keep: 42 });
  });

  it('chains v1 -> v2 -> v3 migrations', () => {
    const data = { oldKey: 'hello' };
    const result = applyMigrations(data, 1, 3, MIGRATIONS);
    assert.deepEqual(result, { newKey: 'hello', addedInV3: 'default-value' });
  });

  it('skips missing migration versions gracefully', () => {
    const data = { oldKey: 'x' };
    const result = applyMigrations(data, 1, 4, MIGRATIONS);
    assert.deepEqual(result, { newKey: 'x', addedInV3: 'default-value' });
  });

  it('handles empty migrations map', () => {
    const data = { a: 1 };
    const result = applyMigrations(data, 1, 5, {});
    assert.deepEqual(result, { a: 1 });
  });
});
