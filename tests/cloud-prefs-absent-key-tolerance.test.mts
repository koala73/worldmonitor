// A cloud row that OMITS a synced key normally means "the user cleared it",
// and applyCloudBlob deletes the local value. That rule is wrong for the
// free-tier gate's ownership sidecars (#6345 follow-up): every row written
// before they existed lacks them, as does every upload from an older tab.
//
// Deleting them is not cosmetic. Without the sidecar,
// reconcileSourceLimitForTier sees no ownership metadata,
// inferExactSourceGateOwnership declines to guess for any customized profile,
// and the gate's own disables become indistinguishable from deliberate user
// choices — so a later Pro upgrade can never reverse them. That is exactly the
// bug #6345 shipped to fix, reintroduced through the cloud path.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ABSENCE_TOLERANT_SYNC_KEYS,
  CLOUD_SYNC_KEYS,
  resolveCloudBlobKeyAction,
} from '../src/utils/sync-keys.ts';

const SOURCE_OWNERSHIP = 'worldmonitor-free-tier-source-ownership';
const LAYER_OWNERSHIP = 'worldmonitor-free-tier-layer-ownership';

describe('cloud blob absent-key tolerance', () => {
  it('keeps both ownership sidecars when the row predates them', () => {
    // A pre-#6345 row: real preferences, no ownership keys at all.
    const legacyRow = {
      'worldmonitor-disabled-feeds': '["Some Source"]',
      'worldmonitor-layers': '{"conflicts":true}',
    };

    assert.deepEqual(
      resolveCloudBlobKeyAction(SOURCE_OWNERSHIP, legacyRow),
      { kind: 'keep' },
      'a row without the source sidecar must not delete local ownership',
    );
    assert.deepEqual(
      resolveCloudBlobKeyAction(LAYER_OWNERSHIP, legacyRow),
      { kind: 'keep' },
      'a row without the layer sidecar must not delete local ownership',
    );
  });

  it('still deletes an ordinary preference the row omits', () => {
    // The absence rule must stay intact for keys the user can genuinely clear,
    // otherwise a cleared preference would resurrect on every sign-in.
    assert.deepEqual(
      resolveCloudBlobKeyAction('worldmonitor-monitors', {}),
      { kind: 'remove' },
    );
    assert.deepEqual(
      resolveCloudBlobKeyAction('worldmonitor-disabled-feeds', {}),
      { kind: 'remove' },
    );
  });

  it('applies an explicit empty ownership set, so a real clear still propagates', () => {
    // Tolerating ABSENCE only works because an intentional clear is written as
    // an explicit empty array (the Pro restore path and the variant reset both
    // do this). If that stopped being true, ownership could never be cleared
    // cross-device.
    assert.deepEqual(
      resolveCloudBlobKeyAction(SOURCE_OWNERSHIP, { [SOURCE_OWNERSHIP]: '[]' }),
      { kind: 'set', value: '[]' },
    );
    assert.deepEqual(
      resolveCloudBlobKeyAction(LAYER_OWNERSHIP, { [LAYER_OWNERSHIP]: '[]' }),
      { kind: 'set', value: '[]' },
    );
  });

  it('applies a populated ownership set like any other value', () => {
    assert.deepEqual(
      resolveCloudBlobKeyAction(SOURCE_OWNERSHIP, { [SOURCE_OWNERSHIP]: '["A","B"]' }),
      { kind: 'set', value: '["A","B"]' },
    );
  });

  it('tolerates absence for exactly the two ownership sidecars', () => {
    // Pins the blast radius: widening this set silently makes some other
    // preference impossible to clear from another device.
    assert.deepEqual(
      [...ABSENCE_TOLERANT_SYNC_KEYS].sort(),
      [LAYER_OWNERSHIP, SOURCE_OWNERSHIP].sort(),
    );
    for (const key of ABSENCE_TOLERANT_SYNC_KEYS) {
      assert.ok(
        CLOUD_SYNC_KEYS.includes(key),
        `${key} must be a real cloud-sync key`,
      );
    }
  });

  it('leaves every other synced key deletable on absence', () => {
    const notDeletable = CLOUD_SYNC_KEYS.filter(
      (key) => resolveCloudBlobKeyAction(key, {}).kind !== 'remove',
    );
    assert.deepEqual(
      notDeletable.sort(),
      [LAYER_OWNERSHIP, SOURCE_OWNERSHIP].sort(),
    );
  });
});
