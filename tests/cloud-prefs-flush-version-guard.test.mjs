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
      /if \(!res\.ok\) return;/,
      'flushOnUnload must leave local state untouched on 409/5xx so conflict-merge recovers',
    );
    assert.match(
      flushBody,
      /setSyncVersion\(body\.syncVersion\)/,
      'flushOnUnload must persist the new syncVersion on a 200',
    );
    assert.match(
      flushBody,
      /clearSettledDirtyKeys\(blob\)/,
      'flushOnUnload must settle the dirty keys it durably uploaded',
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
      /if \(_authGeneration !== myGeneration\) return;/,
      'flushOnUnload must not resurrect sync state after sign-out/user switch',
    );
    assert.match(
      flushBody,
      /if \(body\.syncVersion <= getSyncVersion\(\)\) return;/,
      'flushOnUnload must never regress the version past a newer upload',
    );
  });
});
