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

  it('queues hidden-tab snapshots behind an active preference writer', () => {
    assert.match(
      flushBody,
      /if \(_syncOperations\.busy\) \{[\s\S]*void uploadNow\(_currentVariant\);[\s\S]*return;[\s\S]*\}/,
      'flushOnUnload must fold its latest snapshot into the serialized upload drain when another writer is active',
    );
    assert.match(
      flushBody,
      /void _syncOperations\.run\(async \(\) => \{[\s\S]*await fetch\('\/api\/user-prefs'/,
      'an idle keepalive flush must own the same serialized write queue as sign-in and normal uploads',
    );
  });

  it('only claims synced when nothing newer is pending or in flight', () => {
    // The debounce callback nulls _debounceTimer synchronously BEFORE
    // uploadNow starts awaiting, and an upload can also be queued behind the
    // flush itself. The shared promise covers both active and queued phases.
    assert.match(
      flushBody,
      /isIdle: \(\) => _debounceTimer === null && _activeUploadPromise === null,[\s\S]*setSynced: \(\) => setState\('synced'\)/,
      'flushOnUnload must not claim synced while a debounce is armed or an upload is active or queued',
    );
    assert.doesNotMatch(
      cloudSyncSrc,
      /_uploadsInFlight/,
      'a perform-only counter cannot represent an upload waiting in the serialized queue',
    );
  });
});
