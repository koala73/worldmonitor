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
    assert.match(app, /this\.tierPreferenceHandoff\.begin\(userId\)/);
    assert.match(app, /const tierReconciliationDeferred = this\.shouldDeferTierPreferenceReconciliation\(\)/);
    assert.match(app, /onEntitlementChange\(\(\) => firePremiumLoaders\(\)\)/);
    assert.match(app, /const firePremiumLoaders = \(\): void => \{[\s\S]*?this\.reconcileTierOwnedPreferences\(\)/);
    assert.match(app, /const completion = cloudPrefsSignIn\(nextUserId, SITE_VARIANT\)[\s\S]*?tierPreferenceHandoff\.complete\(nextUserId, currentUserId\)[\s\S]*?reconcileTierOwnedPreferences\(\)[\s\S]*?completion\.then\(finishPreferenceHandoff, finishPreferenceHandoff\)/);
  });
});
