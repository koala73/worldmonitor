import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');

function readSrc(path) {
  return readFileSync(resolve(root, path), 'utf-8');
}

describe('cloud prefs panel sync guardrails', () => {
  it('syncs the real panel order storage keys', () => {
    const syncKeysSrc = readSrc('src/utils/sync-keys.ts');
    const panelLayoutSrc = readSrc('src/app/panel-layout.ts');

    assert.match(
      panelLayoutSrc,
      /saveToStorage\(this\.ctx\.PANEL_ORDER_KEY,\s*allOrder\)/,
      'panel layout must persist unified order at PANEL_ORDER_KEY',
    );
    assert.match(
      panelLayoutSrc,
      /saveToStorage\(this\.ctx\.PANEL_ORDER_KEY \+ '-bottom-set',\s*Array\.from\(this\.bottomSetMemory\)\)/,
      'panel layout must persist bottom placement at PANEL_ORDER_KEY + -bottom-set',
    );
    assert.match(
      syncKeysSrc,
      /'panel-order'/,
      'cloud sync key list must include the actual panel-order key',
    );
    assert.match(
      syncKeysSrc,
      /'panel-order-bottom-set'/,
      'cloud sync key list must include the actual panel bottom-set key',
    );
    assert.doesNotMatch(
      syncKeysSrc,
      /'worldmonitor-panel-order'/,
      'cloud sync must not watch stale worldmonitor-panel-order, which the app never writes',
    );
  });

  it('notifies the running tab when cloud prefs are applied', () => {
    const cloudSyncSrc = readSrc('src/utils/cloud-prefs-sync.ts');
    const appSrc = readSrc('src/App.ts');

    assert.match(
      cloudSyncSrc,
      /export const CLOUD_PREFS_APPLIED_EVENT = 'wm:cloud-prefs-applied'/,
      'cloud prefs sync should expose a same-tab applied event',
    );
    assert.match(
      cloudSyncSrc,
      /dispatchCloudPrefsApplied\(changedKeys, syncVersion\)/,
      'cloud-applied localStorage writes must dispatch changed keys and the cloud version',
    );
    assert.match(
      cloudSyncSrc,
      /applyCloudBlob\(toApply, cloud\.syncVersion\)/,
      'cloud reconciliation must attach the incoming sync version to the applied event',
    );
    assert.match(
      appSrc,
      /window\.addEventListener\(CLOUD_PREFS_APPLIED_EVENT,\s*this\.handleCloudPrefsApplied\)/,
      'App must subscribe to same-tab cloud preference application',
    );
    assert.match(
      appSrc,
      /detail\?\.syncVersion/,
      'App must consume the incoming cloud sync version for bounded recovery',
    );
    assert.match(
      appSrc,
      /pendingCloudRecoverySyncVersion/,
      'App must retain a panel-bearing cloud version that arrives before entitlement settles',
    );
    assert.match(
      appSrc,
      /this\.panelLayout\.applySavedPanelOrder\(\)/,
      'App must reapply synced panel order without waiting for a reload',
    );
    // Scope to the cloud-prefs handler body: `this.enforceFreeTierLimits();`
    // also occurs at unrelated later call sites (boot, premium loaders, the
    // fallback timer), so an unanchored [\s\S]*? bridge over the whole file
    // would stay green with the reconciliation call deleted from the handler.
    const cloudApplyStart = appSrc.indexOf('private applyCloudSyncedPrefsToRuntime');
    const cloudApplyEnd = appSrc.indexOf('const panelOrderKey', cloudApplyStart);
    assert.ok(
      cloudApplyStart >= 0 && cloudApplyEnd > cloudApplyStart,
      'cloud prefs apply handler panels block must exist',
    );
    const cloudApplyBlock = appSrc.slice(cloudApplyStart, cloudApplyEnd);
    assert.match(
      cloudApplyBlock,
      /const reconciledPanelSettings = this\.enforceFreeTierLimits\(cloudSyncVersion\);/,
      'cloud panel snapshots must re-run entitlement reconciliation',
    );
    assert.match(
      cloudApplyBlock,
      /if \(!reconciledPanelSettings\) \{/,
      'a cloud snapshot that skipped reconciliation must still be applied to the mounted dashboard',
    );
    // The legacy sweep must stay one-shot per browser: it cannot tell pre-marker
    // gate damage from a deliberate hide, so re-arming it on cloud snapshots
    // (which land on effectively every multi-device sign-in) silently re-enables
    // widgets the user turned off. See free-tier-gate.ts.
    assert.doesNotMatch(
      appSrc,
      /legacyWidgetRecoveryAfterCloudPrefs/,
      'the cloud-prefs re-arm of the one-shot legacy widget sweep must not come back',
    );
    assert.match(
      appSrc,
      /monitorPanel\?\.setMonitors\(this\.state\.monitors\)/,
      'App must update an already-mounted My Monitors panel when cloud prefs change monitors',
    );
    assert.match(
      appSrc,
      /const panelOrderKey = this\.state\.PANEL_ORDER_KEY;/,
      'App must derive the panel order key from PANEL_ORDER_KEY',
    );
    assert.match(
      appSrc,
      /keySet\.has\(panelOrderKey\) \|\| keySet\.has\(`\$\{panelOrderKey\}-bottom-set`\)/,
      'App must derive the bottom-set key from PANEL_ORDER_KEY',
    );
    assert.doesNotMatch(
      appSrc,
      /keySet\.has\('panel-order'\)/,
      'App must not hard-code the panel-order key in the cloud apply path',
    );
  });

  it('reapplies delayed free-tier panel clamps to the mounted dashboard', () => {
    const appSrc = readSrc('src/App.ts');
    const clampStart = appSrc.indexOf('if (panelsChanged) {');
    const clampEnd = appSrc.indexOf('// --- Source limit ---', clampStart);
    assert.ok(clampStart >= 0 && clampEnd > clampStart, 'free-tier panel clamp block must exist');
    const clampBlock = appSrc.slice(clampStart, clampEnd);

    assert.match(
      clampBlock,
      /this\.state\.panelSettings\s*=\s*clampedPanels;[\s\S]*?this\.panelLayout\.applyPanelSettings\(\);/,
      'a clamp reached after layout init must update already-mounted panels',
    );
    assert.match(
      clampBlock,
      /this\.state\.unifiedSettings\?\.refreshPanelToggles\(\);/,
      'a delayed clamp must refresh the visible panel controls',
    );
  });

  it('resets the fallback before enforcing a new auth/account window', () => {
    const appSrc = readSrc('src/App.ts');
    const authStart = appSrc.indexOf('this.unsubFreeTier = subscribeAuthState((session) => {');
    const authEnd = appSrc.indexOf('const geoCoordsPromise', authStart);
    assert.ok(authStart >= 0 && authEnd > authStart, 'auth subscription body must exist');
    const authBody = appSrc.slice(authStart, authEnd);
    assert.match(
      authBody,
      /const userId = session\.user\?\.id \?\? null;[\s\S]*?this\.freeTierGate\.resetForAuthTransition\(\);[\s\S]*?firePremiumLoaders\(\);/,
      'a new account must receive a fresh grace window before auth enforcement runs',
    );
  });

  it('never persists a free-tier clamp to dashboard tabs while the tier is unresolved', () => {
    const panelLayoutSrc = readSrc('src/app/panel-layout.ts');
    const appSrc = readSrc('src/App.ts');

    // Every tab path that WRITES a clamped snapshot must gate on the tier
    // being known — otherwise a Pro user's saved workspaces get their custom
    // widgets stripped during the same pending-auth window App.ts defers for.
    const healBody = panelLayoutSrc.slice(
      panelLayoutSrc.indexOf('public healStoredTabSnapshots(): void'),
      panelLayoutSrc.indexOf('private panelSettingsEnabledStateChanged('),
    );
    assert.match(
      healBody,
      /if \(!state \|\| !this\.isProTierResolvedOrFallback\(\)\) return;/,
      'the stored-tab heal must bail out until the entitlement is known or the bounded free fallback has fired',
    );
    assert.match(
      panelLayoutSrc,
      /const capped = this\.isProTierResolvedOrFallback\(\)\s*\n\s*\?\s*enforceFreePanelLimit\(next, isProUser\(\)\)\s*\n\s*:\s*next;/,
      'applyTabPanelState must not clamp before the entitlement is known unless the fallback has settled free-tier enforcement',
    );

    // ...and the heal must be re-run once it resolves, or an unopened tab keeps
    // the snapshot it was given while the answer was still unknown.
    assert.match(
      appSrc,
      /this\.panelLayout\.healStoredTabSnapshots\(\);/,
      'App must re-heal stored tab snapshots when auth or entitlement resolves',
    );
    assert.match(
      appSrc,
      /this\.enforceFreeTierLimits\(\);\s*this\.panelLayout\.healStoredTabSnapshots\(\);/,
      'the fallback callback must heal stored tab snapshots after clamping global panels',
    );
  });

  it('persists dirty cloud preference keys across reloads until upload settles', () => {
    const cloudSyncSrc = readSrc('src/utils/cloud-prefs-sync.ts');

    assert.match(
      cloudSyncSrc,
      /const KEY_DIRTY_KEYS = 'wm-cloud-prefs-dirty-keys'/,
      'cloud prefs sync must store pending dirty-key metadata outside the uploaded blob',
    );
    assert.match(
      cloudSyncSrc,
      /hydrateDirtyKeysFromStorage\(userId\);/,
      'cloud prefs sync must restore dirty keys for the signed-in user before resolving sign-in conflicts',
    );
    assert.match(
      cloudSyncSrc,
      /userId: _dirtyKeysUserId,[\s\S]*keys: \[\.\.\._dirtyKeys\]/,
      'persisted dirty-key metadata must be scoped to the user that made the edit',
    );
    assert.doesNotMatch(
      cloudSyncSrc,
      /export function install[\s\S]*hydrateDirtyKeysFromStorage\(/,
      'cloud prefs sync must not restore ownerless dirty keys at install time',
    );
    assert.match(
      cloudSyncSrc,
      /markDirtyKey\(key as CloudSyncKey\);/,
      'local pref writes must persist their dirty-key marker before debounce upload',
    );
    assert.match(
      cloudSyncSrc,
      /if \(changed\) persistDirtyKeys\(\);/,
      'successful uploads must clear only the dirty keys that actually settled',
    );
    assert.match(
      cloudSyncSrc,
      /if \(_dirtyKeys\.size === 0\) \{[\s\S]*Storage\.prototype\.removeItem\.call\(localStorage, KEY_DIRTY_KEYS\);[\s\S]*return;[\s\S]*\}[\s\S]*if \(!_dirtyKeysUserId\) return;/,
      'ownerless dirty writes before sign-in must not delete the previous persisted dirty-key marker',
    );
    assert.match(
      cloudSyncSrc,
      /const preservePersistedDirtyKeys = _syncOperations\.busy && _dirtyKeys\.size > 0;[\s\S]*_dirtyKeys\.clear\(\);\s*if \(!preservePersistedDirtyKeys\) persistDirtyKeys\(\);\s*_dirtyKeysUserId = null;/,
      'sign-out must retain user-scoped dirty metadata only when an interrupted writer still needs recovery',
    );
  });

  it('does not clear/persist settled dirty keys after a mid-upload account switch', () => {
    const cloudSyncSrc = readSrc('src/utils/cloud-prefs-sync.ts');

    assert.match(
      cloudSyncSrc,
      /if \(_authGeneration !== myGeneration\) return 'stopped';[\s\S]*clearSettledDirtyKeys\(postedBlob\)/,
      'uploadNow success branch must bail before clearing settled dirty keys when the auth generation advanced (sign-out / account switch mid-upload)',
    );
    assert.match(
      cloudSyncSrc,
      /if \(_authGeneration !== callerGeneration\) return false;[\s\S]*clearSettledDirtyKeys\(merged\)/,
      'resolveConflictWithMerge must bail before clearing settled dirty keys when the caller auth generation advanced',
    );
  });
});
