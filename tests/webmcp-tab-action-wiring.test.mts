/**
 * WebMCP dashboard-tab tools reuse PanelLayoutManager persistence.
 *
 * A live PanelLayoutManager still cannot be mounted in this suite (#5892:
 * constructor pulls dozens of imports plus checkout-return handling). These
 * greps pin the apply path to the same switch/create/rename/delete helpers
 * that write worldmonitor-tabs-v1, until a DOM harness can drive
 * applyWebMcpTabAction directly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const panelLayout = readFileSync(resolve(process.cwd(), 'src/app/panel-layout.ts'), 'utf8');
const appSrc = readFileSync(resolve(process.cwd(), 'src/App.ts'), 'utf8');

const applyBody = panelLayout.slice(
  panelLayout.indexOf('public applyWebMcpTabAction'),
  panelLayout.indexOf('private tabMutationResult('),
);
const createBody = panelLayout.slice(
  panelLayout.indexOf('private createAndActivateTab('),
  panelLayout.indexOf('public healStoredTabSnapshots('),
);
const switchBody = panelLayout.slice(
  panelLayout.indexOf('private switchToTab('),
  panelLayout.indexOf('private updateTabCapLock('),
);
const renameBody = panelLayout.slice(
  panelLayout.indexOf('private renameTab('),
  panelLayout.indexOf('private deleteTab('),
);
const deleteBody = panelLayout.slice(
  panelLayout.indexOf('private deleteTab('),
  panelLayout.indexOf('private applyTabPanelState('),
);
const mutationResultBody = panelLayout.slice(
  panelLayout.indexOf('private tabMutationResult('),
  panelLayout.indexOf('private createAndActivateTab('),
);

describe('WebMCP tab-action wiring', () => {
  it('extracts the applyWebMcpTabAction body', () => {
    assert.ok(applyBody.length > 800, 'guard needs the real applyWebMcpTabAction body');
    assert.ok(createBody.includes('saveTabsState'), 'createAndActivateTab must persist');
    assert.ok(switchBody.includes('saveTabsState'), 'switchToTab must persist');
    assert.ok(renameBody.includes('saveTabsState'), 'renameTab must persist');
    assert.ok(deleteBody.includes('saveTabsState'), 'deleteTab must persist');
  });

  it('routes App WebMCP tab actions through PanelLayoutManager', () => {
    assert.match(
      appSrc,
      /applyDashboardTabAction:\s*async\s*\(action,\s*execution\)\s*=>\s*\{[\s\S]*?return this\.panelLayout\.applyWebMcpTabAction\(action\);/,
    );
  });

  it('reuses tab-bar persistence helpers for select/create/rename/delete', () => {
    assert.match(applyBody, /this\.switchToTab\(resolved\.tab\.id\)/);
    assert.match(applyBody, /this\.createAndActivateTab\(/);
    assert.match(applyBody, /this\.renameTab\(resolved\.tab\.id, resolved\.name\)/);
    assert.match(applyBody, /this\.deleteTab\(resolved\.tab\.id\)/);
    assert.match(applyBody, /canCreate:\s*cap\.allowed/);
    assert.match(applyBody, /alreadyExisted/);
    assert.match(applyBody, /trackGateHit\('dashboard-tab'\)/);
    assert.match(applyBody, /DASHBOARD_TAB_UNAVAILABLE_RESULT/);
    assert.match(applyBody, /applyPersistReceipt\(/);
    assert.match(mutationResultBody, /applyPersistReceipt\(/);
    assert.equal(
      applyBody.includes('saveTabsState('),
      false,
      'applyWebMcpTabAction must persist only through tab-bar helpers',
    );
  });
});
