import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');

const cloudSyncSrc = readFileSync(resolve(root, 'src/utils/cloud-prefs-sync.ts'), 'utf-8');

// The visibilitychange→hidden flush fires on every tab switch with a pending
// debounce. Its POST advances the server row's syncVersion; if the client
// drops the response, local KEY_SYNC_VERSION stays one behind and the next
// pref save is guaranteed a 409 CONFLICT. These guards pin the response
// handling that keeps the common alive-tab flush version-coherent.
describe('cloud prefs flush version guardrails', () => {
  const flushBody = (() => {
    const start = cloudSyncSrc.indexOf('const flushOnUnload');
    assert.notEqual(start, -1, 'flushOnUnload must exist in cloud-prefs-sync.ts');
    const end = cloudSyncSrc.indexOf('document.addEventListener', start);
    assert.notEqual(end, -1, 'flushOnUnload must be wired before the visibilitychange listener');
    return cloudSyncSrc.slice(start, end);
  })();

  it('adopts the syncVersion echoed by a successful keepalive flush', () => {
    assert.match(
      flushBody,
      /\.then\(async \(res\) => \{/,
      'flushOnUnload must read the keepalive response instead of fire-and-forget',
    );
    assert.match(
      flushBody,
      /rearmTemporaryCloudPrefsRetry\([\s\S]*status: res.status,[\s\S]*setRetryTimer:[\s\S]*uploadNow:[\s\S]*return;/,
      'flushOnUnload must requeue observable 429/503 keepalive failures instead of stranding the final save',
    );
    assert.match(
      flushBody,
      /applyObservableCloudPrefsFlushSuccess\([\s\S]*syncVersion: body\?\.syncVersion,[\s\S]*setSyncVersion,[\s\S]*clearSettledDirtyKeys: \(\) => clearSettledDirtyKeys\(blob\)/,
      'flushOnUnload must route successful observable responses through the behavior-tested flush helper',
    );
  });

  it('guards version adoption against auth changes and stale responses', () => {
    assert.match(
      flushBody,
      /const myGeneration = _authGeneration;/,
      'flushOnUnload must capture the auth generation before posting',
    );
    assert.match(
      flushBody,
      /getAuthGeneration: \(\) => _authGeneration/,
      'flushOnUnload must not resurrect sync state after sign-out/user switch',
    );
    assert.match(
      flushBody,
      /getSyncVersion,/,
      'flushOnUnload must never regress the version past a newer upload',
    );
  });

  it('only claims synced when nothing newer is pending or in flight', () => {
    // The debounce callback nulls _debounceTimer synchronously BEFORE
    // uploadNow starts awaiting, so the timer alone cannot distinguish
    // "idle" from "upload mid-flight" — a late flush response would flash
    // 'synced' during an active upload (Greptile P2 on PR #4267).
    assert.match(
      flushBody,
      /isIdle: \(\) => _debounceTimer === null && _uploadsInFlight === 0,[\s\S]*setSynced: \(\) => setState\('synced'\)/,
      'flushOnUnload must not claim synced while a debounce is armed or an upload is in flight',
    );
    const uploadNowBody = (() => {
      const start = cloudSyncSrc.indexOf('async function uploadNow');
      assert.notEqual(start, -1, 'uploadNow must exist in cloud-prefs-sync.ts');
      const end = cloudSyncSrc.indexOf('function schedulePrefUpload', start);
      assert.notEqual(end, -1, 'uploadNow must precede schedulePrefUpload');
      return cloudSyncSrc.slice(start, end);
    })();
    assert.match(
      uploadNowBody,
      /_uploadsInFlight \+= 1;/,
      'uploadNow must mark itself in flight before any async work',
    );
    assert.match(
      uploadNowBody,
      /\} finally \{\s*_uploadsInFlight -= 1;\s*\}/,
      'uploadNow must balance the in-flight counter on every exit path',
    );
  });
});
