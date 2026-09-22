import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyObservableCloudPrefsFlushSuccess } from '../src/utils/cloud-prefs-flush.ts';

describe('applyObservableCloudPrefsFlushSuccess', () => {
  it('adopts a newer syncVersion, settles posted dirty keys, records last sync, and marks idle state synced', () => {
    const calls: string[] = [];

    const applied = applyObservableCloudPrefsFlushSuccess({
      syncVersion: 8,
      myGeneration: 3,
      getAuthGeneration: () => 3,
      getSyncVersion: () => 7,
      setSyncVersion: (syncVersion) => { calls.push(`version:${syncVersion}`); return true; },
      clearSettledDirtyKeys: () => { calls.push('clear-dirty'); },
      setLastSyncAt: (timestampMs) => { calls.push(`last-sync:${timestampMs}`); },
      isIdle: () => true,
      setSynced: () => { calls.push('synced'); },
      now: () => 1_700_000_000_000,
    });

    assert.equal(applied, true);
    assert.deepEqual(calls, [
      'version:8',
      'clear-dirty',
      'last-sync:1700000000000',
      'synced',
    ]);
  });

  it('does not resurrect sync state after the auth generation changes', () => {
    let touched = false;

    const applied = applyObservableCloudPrefsFlushSuccess({
      syncVersion: 8,
      myGeneration: 3,
      getAuthGeneration: () => 4,
      getSyncVersion: () => 7,
      setSyncVersion: () => { touched = true; return true; },
      clearSettledDirtyKeys: () => { touched = true; },
      setLastSyncAt: () => { touched = true; },
      isIdle: () => true,
      setSynced: () => { touched = true; },
    });

    assert.equal(applied, false);
    assert.equal(touched, false);
  });

  it('does not regress local syncVersion when a newer upload completed first', () => {
    let touched = false;

    const applied = applyObservableCloudPrefsFlushSuccess({
      syncVersion: 8,
      myGeneration: 3,
      getAuthGeneration: () => 3,
      getSyncVersion: () => 9,
      setSyncVersion: () => { touched = true; return true; },
      clearSettledDirtyKeys: () => { touched = true; },
      setLastSyncAt: () => { touched = true; },
      isIdle: () => true,
      setSynced: () => { touched = true; },
    });

    assert.equal(applied, false);
    assert.equal(touched, false);
  });

  it('does not claim synced while another upload is active', () => {
    const calls: string[] = [];

    const applied = applyObservableCloudPrefsFlushSuccess({
      syncVersion: 8,
      myGeneration: 3,
      getAuthGeneration: () => 3,
      getSyncVersion: () => 7,
      setSyncVersion: (syncVersion) => { calls.push(`version:${syncVersion}`); return true; },
      clearSettledDirtyKeys: () => { calls.push('clear-dirty'); },
      setLastSyncAt: (timestampMs) => { calls.push(`last-sync:${timestampMs}`); },
      isIdle: () => false,
      setSynced: () => { calls.push('synced'); },
      now: () => 1_700_000_000_000,
    });

    assert.equal(applied, true);
    assert.deepEqual(calls, [
      'version:8',
      'clear-dirty',
      'last-sync:1700000000000',
    ]);
  });

  it('ignores malformed response bodies', () => {
    let touched = false;

    const applied = applyObservableCloudPrefsFlushSuccess({
      syncVersion: '8',
      myGeneration: 3,
      getAuthGeneration: () => 3,
      getSyncVersion: () => 7,
      setSyncVersion: () => { touched = true; return true; },
      clearSettledDirtyKeys: () => { touched = true; },
      setLastSyncAt: () => { touched = true; },
      isIdle: () => true,
      setSynced: () => { touched = true; },
    });

    assert.equal(applied, false);
    assert.equal(touched, false);
  });
});

describe('applyObservableCloudPrefsFlushSuccess storage rejection (#7833)', () => {
  it('does not settle dirty keys or report synced when the version write is rejected', () => {
    // A nearly-full store can reject even this small marker. Settling the
    // posted dirty keys against a version that never persisted is what makes
    // every later upload conflict and every reload re-reconcile.
    const calls: string[] = [];

    const applied = applyObservableCloudPrefsFlushSuccess({
      syncVersion: 8,
      myGeneration: 3,
      getAuthGeneration: () => 3,
      getSyncVersion: () => 7,
      setSyncVersion: () => false,
      clearSettledDirtyKeys: () => { calls.push('clear-dirty'); },
      setLastSyncAt: () => { calls.push('last-sync'); },
      isIdle: () => true,
      setSynced: () => { calls.push('synced'); },
    });

    assert.equal(applied, false);
    assert.deepEqual(calls, []);
  });
});
