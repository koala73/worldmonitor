import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePersistedDirtyKeys,
  unionPersistedDirtyKeys,
  withoutPersistedDirtyKeys,
} from '../src/utils/cloud-prefs-migrations';

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
