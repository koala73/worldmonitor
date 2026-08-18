import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePersistedDirtyKeys,
  unionPersistedDirtyKeys,
  withoutPersistedDirtyKeys,
} from '../src/utils/cloud-prefs-migrations';

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


describe('persisted dirty-key read-modify-write projections (#4746)', () => {
  const ALLOWED = ['worldmonitor-theme', 'worldmonitor-monitors', 'wm-market-watchlist-v1'];
  const entry = (userId, keys) => JSON.stringify({ userId, keys });

  it('unions additions with the persisted set instead of overwriting it', () => {
    const raw = entry('user-1', ['worldmonitor-theme']);
    const result = unionPersistedDirtyKeys(raw, ALLOWED, 'user-1', ['wm-market-watchlist-v1']);
    assert.deepEqual(result.keys.sort(), ['wm-market-watchlist-v1', 'worldmonitor-theme']);
    assert.equal(result.userId, 'user-1');
  });

  it('unions onto an absent or malformed entry as a fresh set', () => {
    for (const raw of [null, 'not json', entry('user-2', ['worldmonitor-theme'])]) {
      const result = unionPersistedDirtyKeys(raw, ALLOWED, 'user-1', ['worldmonitor-monitors']);
      assert.deepEqual(result.keys, ['worldmonitor-monitors'], `raw=${raw}`);
      assert.equal(result.userId, 'user-1');
    }
  });

  it('drops disallowed keys from additions but keeps valid persisted ones', () => {
    const raw = entry('user-1', ['worldmonitor-theme']);
    const result = unionPersistedDirtyKeys(raw, ALLOWED, 'user-1', ['not-a-pref-key', 'worldmonitor-monitors']);
    assert.deepEqual(result.keys.sort(), ['worldmonitor-monitors', 'worldmonitor-theme']);
  });

  it('removes only the settled keys, keeping another tab pending marker', () => {
    const raw = entry('user-1', ['worldmonitor-theme', 'wm-market-watchlist-v1']);
    const result = withoutPersistedDirtyKeys(raw, ALLOWED, 'user-1', ['worldmonitor-theme']);
    assert.deepEqual(result.keys, ['wm-market-watchlist-v1']);
  });

  it('removal on a foreign-user or malformed entry clears it for the new owner', () => {
    for (const raw of [null, 'not json', entry('user-2', ['worldmonitor-theme'])]) {
      const result = withoutPersistedDirtyKeys(raw, ALLOWED, 'user-1', ['worldmonitor-theme']);
      assert.deepEqual(result.keys, [], `raw=${raw}`);
    }
  });

  it('round-trips through parsePersistedDirtyKeys for the owning user', () => {
    const unioned = unionPersistedDirtyKeys(entry('user-1', ['worldmonitor-theme']), ALLOWED, 'user-1', ['worldmonitor-monitors']);
    const serialized = JSON.stringify(unioned);
    assert.deepEqual(
      parsePersistedDirtyKeys(serialized, ALLOWED, 'user-1').sort(),
      ['worldmonitor-monitors', 'worldmonitor-theme'],
    );
  });
});
