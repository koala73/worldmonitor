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
      /localStorage\.setItem\(this\.ctx\.PANEL_ORDER_KEY,\s*JSON\.stringify\(allOrder\)\)/,
      'panel layout must persist unified order at PANEL_ORDER_KEY',
    );
    assert.match(
      panelLayoutSrc,
      /localStorage\.setItem\(this\.ctx\.PANEL_ORDER_KEY \+ '-bottom-set',\s*JSON\.stringify\(Array\.from\(this\.bottomSetMemory\)\)\)/,
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
      /dispatchCloudPrefsApplied\(changedKeys\)/,
      'cloud-applied localStorage writes must dispatch changed keys',
    );
    assert.match(
      appSrc,
      /window\.addEventListener\(CLOUD_PREFS_APPLIED_EVENT,\s*this\.handleCloudPrefsApplied\)/,
      'App must subscribe to same-tab cloud preference application',
    );
    assert.match(
      appSrc,
      /this\.panelLayout\.applySavedPanelOrder\(\)/,
      'App must reapply synced panel order without waiting for a reload',
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
});
