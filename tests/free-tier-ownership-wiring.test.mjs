import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const app = readFileSync(new URL('../src/App.ts', import.meta.url), 'utf8');
const handlers = readFileSync(new URL('../src/app/event-handlers.ts', import.meta.url), 'utf8');
const settingsWindow = readFileSync(new URL('../src/settings-window.ts', import.meta.url), 'utf8');
const syncKeys = readFileSync(new URL('../src/utils/sync-keys.ts', import.meta.url), 'utf8');

describe('free-tier ownership production wiring', () => {
  it('routes every persistent human panel toggle through the ownership helper', () => {
    assert.match(handlers, /enablePanelById\(panelId: string\): boolean[\s\S]*?userSetPanelEnabled\(config, true\)/);
    assert.match(handlers, /boundPanelCloseHandler[\s\S]*?userSetPanelEnabled\(config, false\)/);
    assert.match(handlers, /savePanelSettings:[\s\S]*?userSetPanelEnabled\(current, nextConfig\.enabled\)/);
    assert.match(settingsWindow, /userSetPanelEnabled\(config, !config\.enabled\)/);
  });

  it('stages desktop variant selection and applies the durable panel transition', () => {
    assert.match(handlers, /stageVariantSelection\(SITE_VARIANT, variant, writeStorageValue\)/);
    assert.match(app, /applyVariantPanelLayoutTransition\(\{/);
  });

  it('restores source and map ownership on Pro and syncs ownership metadata', () => {
    assert.match(app, /reconcileSourceLimitForTier\(true\)/);
    assert.match(app, /restoreGateOwnedLockedLayers\(/);
    assert.match(app, /if \(!ownershipMetadataExists\) \{/);
    assert.match(app, /const ownershipChanged = !ownershipMetadataExists\s*\|\|/);
    assert.match(app, /if \(!mapLayerStatesEqual\(this\.state\.mapLayers, nextLayers\)\) \{/);
    assert.match(app, /persistGateOwnershipTransition\(\s*'pro'/);
    assert.match(app, /persistGateOwnershipTransition\(\s*'free'/);
    assert.match(app, /persistJsonStorageValue\(\s*STORAGE_KEYS\.disabledFeeds/);
    assert.match(app, /persistJsonStorageValue\(\s*STORAGE_KEYS\.sourceGateOwnership/);
    assert.match(syncKeys, /worldmonitor-free-tier-source-ownership/);
    assert.match(syncKeys, /worldmonitor-free-tier-layer-ownership/);
  });

  it('transfers single and bulk source toggles out of gate ownership', () => {
    assert.match(handlers, /toggleSource:[\s\S]*?if \(this\.transferSourceGateOwnershipToUser\(\[name\]\)\) \{\s*saveToStorage\(STORAGE_KEYS\.disabledFeeds/);
    assert.match(handlers, /setSourcesEnabled:[\s\S]*?if \(this\.transferSourceGateOwnershipToUser\(names\)\) \{\s*saveToStorage\(STORAGE_KEYS\.disabledFeeds/);
    assert.match(handlers, /transferSourceGateOwnershipToUser\(names: Iterable<string>\): boolean[\s\S]*?return writeStorageValue\([\s\S]*?STORAGE_KEYS\.sourceGateOwnership/);
  });

  it('defers ownership reconciliation until cloud prefs completes for the current account', () => {
    assert.match(app, /this\.tierPreferenceHandoff\.begin\(\s*userId,/);
    assert.match(app, /const tierReconciliationDeferred = this\.shouldDeferTierPreferenceReconciliation\(\)/);
    assert.match(app, /onEntitlementChange\(\(\) => firePremiumLoaders\(\)\)/);

    // Bounded to the function body. An unbounded `[\s\S]*?` here matched the
    // NEXT `reconcileTierOwnedPreferences()` call 81 lines below, so deleting
    // the call this assertion names left the test green (verified by mutation).
    // Same slice technique as tests/cloud-prefs-panel-sync-guard.test.mjs.
    const firePremiumStart = app.indexOf('const firePremiumLoaders = (): void => {');
    const firePremiumEnd = app.indexOf('this.unsubEntitlementPremiumLoaders', firePremiumStart);
    assert.ok(
      firePremiumStart >= 0 && firePremiumEnd > firePremiumStart,
      'firePremiumLoaders body must exist',
    );
    assert.match(
      app.slice(firePremiumStart, firePremiumEnd),
      /this\.reconcileTierOwnedPreferences\(\)/,
      'entitlement changes must reconcile tier-owned preferences',
    );

    const handoffStart = app.indexOf('cloudPrefsSignIn: (nextUserId) => {');
    const handoffEnd = app.indexOf('},\n          },', handoffStart);
    assert.ok(handoffStart >= 0 && handoffEnd > handoffStart, 'cloudPrefsSignIn wrapper must exist');
    const handoffBody = app.slice(handoffStart, handoffEnd);
    assert.match(
      handoffBody,
      /cloudPrefsSignIn\(nextUserId, SITE_VARIANT, \{\s*handoffGeneration: preferenceHandoffGeneration,/,
      'the sign-in attempt must carry its caller-owned handoff generation',
    );
    assert.doesNotMatch(handoffBody, /\.then\(/, 'promise settlement is not a terminal cloud signal');
  });

  it('never advances the legacy variant key outside the durable transition', () => {
    // Advancing it unconditionally after applyVariantPanelLayoutTransition
    // erased the retry for a failed reset: the next boot saw a null applied
    // marker beside a matching legacy key and seeded it as already-applied.
    const transitionStart = app.indexOf('panelSettings = applyVariantPanelLayoutTransition({');
    const transitionEnd = app.indexOf('} else {', transitionStart);
    assert.ok(
      transitionStart >= 0 && transitionEnd > transitionStart,
      'variant transition block must exist',
    );
    const block = app.slice(transitionStart, transitionEnd);
    const legacyWrites = block.match(/localStorage\.setItem\(STORAGE_KEYS\.variant,/g) ?? [];
    assert.equal(
      legacyWrites.length,
      1,
      'the legacy variant key must be written exactly once, inside persistAppliedVariant',
    );
    const persistStart = block.indexOf('persistAppliedVariant: (variant) => {');
    assert.ok(persistStart >= 0, 'persistAppliedVariant must be a block body');
    assert.ok(
      block.indexOf('localStorage.setItem(STORAGE_KEYS.variant,') > persistStart,
      'the legacy variant write must live inside persistAppliedVariant, not after the transition',
    );
  });

  it('treats a ?layers= deep link as an ephemeral view, not a saved preference', () => {
    // Both URL-derived call sites must opt out of persistence AND of
    // ownership: a shared link overwrote the cloud-synced layer preference and
    // seeded gate ownership the user never chose.
    const urlCallSites = app.match(
      /sanitizeMapLayersForTier\([\s\S]{0,220}?ephemeralSnapshot: true/g,
    ) ?? [];
    assert.equal(urlCallSites.length, 3, 'every URL-derived layer path must pass ephemeralSnapshot');
    assert.doesNotMatch(app, /consumeProOwnership/, 'the superseded option must be gone');

    // state.mapLayers IS the URL snapshot when the session booted from a deep
    // link, and the boot-time ephemeral pass no-ops while the tier is
    // unresolved — so THIS heal is the one that actually acts. Running it
    // non-ephemerally seeded ownership from the link and persisted it.
    const healStart = app.indexOf('private healLockedMapLayers(');
    const healEnd = app.indexOf('syncDataFreshnessWithLayers();', healStart);
    assert.ok(healStart >= 0 && healEnd > healStart, 'healLockedMapLayers must exist');
    const healBody = app.slice(healStart, healEnd);
    assert.match(
      healBody,
      /this\.sanitizeMapLayersForTier\(\s*this\.state\.mapLayers,\s*fallbackActive,\s*initialUrlLayers \? \{ ephemeralSnapshot: true \} : \{\},?\s*\)/,
      'the live-layer heal must stay ephemeral for a deep-linked session',
    );
  });

  it('releases the handoff only from a matching scoped sign-in terminal event', () => {
    const applyStart = app.indexOf('private applyCloudSyncedPrefsToRuntime(');
    const applyEnd = app.indexOf('invalidatePanelStorageCacheForKeys(keys);', applyStart);
    assert.ok(applyStart >= 0 && applyEnd > applyStart, 'cloud apply handler must exist');
    const applyHead = app.slice(applyStart, applyEnd);
    assert.doesNotMatch(applyHead, /tierPreferenceHandoff\.complete/,
      'generic apply events, including local migrations, must not release the handoff');

    const terminalStart = app.indexOf('private readonly handleCloudPrefsSignInTerminal');
    const terminalEnd = app.indexOf('private applyCloudSyncedPrefsToRuntime', terminalStart);
    assert.ok(terminalStart >= 0 && terminalEnd > terminalStart, 'terminal handler must exist');
    const terminalBody = app.slice(terminalStart, terminalEnd);
    assert.match(terminalBody, /detail\?\.origin !== 'sign-in'/);
    assert.match(terminalBody, /detail\.handoffGeneration !== pendingGeneration/);
    assert.match(terminalBody, /detail\.accountId,\s*currentUserId/);
    assert.equal(
      (terminalBody.match(/this\.reconcileTierOwnedPreferences\(\)/g) ?? []).length,
      1,
      'a matching terminal event must run one full reconciliation pass',
    );
    assert.match(app, /\(\) => hasPendingCloudPrefsRetry\(\),/, 'expiry must postpone on a pending retry');
  });

  it('disarms an armed preference handoff before App module teardown', () => {
    const destroyStart = app.indexOf('public destroy(): void {');
    const destroyEnd = app.indexOf('private async initFindingsBadge', destroyStart);
    assert.ok(destroyStart >= 0 && destroyEnd > destroyStart, 'App.destroy must exist');
    const destroyBody = app.slice(destroyStart, destroyEnd);
    const clearIndex = destroyBody.indexOf('this.tierPreferenceHandoff.clear();');
    const generationIndex = destroyBody.indexOf('this.pendingPreferenceHandoffGeneration = undefined;');
    const moduleTeardownIndex = destroyBody.indexOf('// Destroy all modules in reverse order');

    assert.ok(clearIndex >= 0, 'destroy must cancel the armed handoff expiry');
    assert.ok(generationIndex > clearIndex, 'destroy must invalidate the pending generation');
    assert.ok(
      moduleTeardownIndex > generationIndex,
      'handoff teardown must finish before module teardown can trigger late effects',
    );
  });
});
