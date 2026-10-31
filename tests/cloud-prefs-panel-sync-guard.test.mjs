// Text checks on the App-side cloud-preference wiring in src/App.ts and
// src/app/panel-layout.ts (#8690, section 2).
//
// Why the text is the contract here: every check below pins WHERE a call
// sits inside App's cloud-apply handler, the free-tier clamp block, the
// source-cap helper and the auth subscription (reconcile only after the
// account handoff, re-run the cap before reloading disabled feeds, heal
// stored tabs once the tier is known). Those are ordering constraints
// inside private methods of a class that no DOM harness can drive end to
// end yet; tests/dom/app-destroy-lifecycle.test.mts constructs App without
// init, but the cloud-apply path needs a mounted dashboard and a signed-in
// entitlement state. When PanelLayoutManager and the cloud-apply handler
// get a harness (#5892), move each check there and delete it here.
//
// What this file no longer holds: the dirty-key persistence checks, which
// run for real in tests/cloud-prefs-sync-concurrency.test.mts (reload
// recovery at "restores a persisted dirty marker", two-tab
// union and settle at "two-tab dirty-key persistence", sign-out cleanup at
// "cloud prefs sign-out cleanup", partial-import markers at "settings
// import cloud transaction"); and the panel-order sync-key checks, which
// run in tests/dom/cloud-prefs-panel-order-keys.test.mts.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');

function readSrc(path) {
  return readFileSync(resolve(root, path), 'utf-8');
}

describe('cloud prefs panel sync guardrails', () => {
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
      /const reconciledPanelSettings = tierReconciliationDeferred\s*\? false\s*: this\.enforceFreeTierLimits\(cloudSyncVersion\);/,
      'cloud panel snapshots must reconcile only after account preference handoff',
    );
    assert.match(
      cloudApplyBlock,
      /if \(!reconciledPanelSettings\) \{/,
      'a cloud snapshot that skipped reconciliation must still be applied to the mounted dashboard',
    );
    const cloudApplyHandler = appSrc.slice(
      cloudApplyStart,
      appSrc.indexOf('private isPanelNearViewport', cloudApplyStart),
    );
    assert.match(
      cloudApplyHandler,
      /if \(!tierReconciliationDeferred && !freeTierLimitsInvoked\) \{\s*this\.enforceFreeTierLimits\(cloudSyncVersion\);\s*\}[\s\S]*?this\.state\.disabledSources = new Set\(loadFromStorage<string\[\]>\(STORAGE_KEYS\.disabledFeeds, \[\]\)\);/,
      'a disabled-feeds-only cloud generation must defer during handoff or re-run the cap before reloading state',
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
      cloudApplyHandler,
      /void applyVisibleMapDimension\(this\.state, mode === 'globe' \? '3d' : '2d'\)/,
      'cloud map-mode changes must reconcile renderer, application layer state, and persistence through the visible control path',
    );
    assert.doesNotMatch(
      cloudApplyHandler,
      /this\.state\.map\?\.switchTo(?:Globe|Flat)\(\)/,
      'cloud map-mode changes must not bypass application layer-state reconciliation',
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
    const clampEnd = appSrc.indexOf('this.reconcileSourceLimitForTier(false);', clampStart);
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

  it('updates the live disabled-source set when a delayed cap persists changes', () => {
    const appSrc = readSrc('src/App.ts');
    const capStart = appSrc.indexOf('private reconcileSourceLimitForTier(');
    const capEnd = appSrc.indexOf('/**\n   * Enforce free-tier panel', capStart);
    assert.ok(capStart >= 0 && capEnd > capStart, 'owned free-tier source-cap helper must exist');
    const capBlock = appSrc.slice(capStart, capEnd);

    assert.match(
      capBlock,
      /persistJsonStorageValue\(STORAGE_KEYS\.disabledFeeds, \[\.\.\.nextDisabled\]\)[\s\S]*?if \(disabledChanged\) \{[\s\S]*?this\.state\.disabledSources = new Set\(nextDisabled\);/,
      'a cap reached from delayed auth or entitlement settlement must update the running app state',
    );
    assert.match(
      capBlock,
      /persistJsonStorageValue\(\s*STORAGE_KEYS\.sourceGateOwnership,\s*\[\.\.\.nextGateOwned\],\s*\)/,
      'the source cap must explicitly confirm persisted ownership',
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
      /const userId = session\.user\?\.id \?\? null;[\s\S]*?this\.freeTierGate\.resetForAuthTransition\(\);[\s\S]*?firePremiumLoaders\(accountTransition\);/,
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
});
