/**
 * Guards the CMD+K "Add a disabled panel" discoverability wiring (feature A).
 *
 * Before this, SearchModal indexed only ENABLED panels, so search could only
 * jump to panels already on screen — every disabled-but-available panel (and
 * every panel on a variant where it's off by default) was unreachable via
 * search. The fix introduces an `availablePanelIds` superset and an "Add"
 * affordance that enables the panel on selection.
 *
 * These assertions pin the load-bearing pieces of that wiring so a future
 * refactor can't silently revert to active-only gating (which would re-bury
 * the panels) without turning this test red.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const searchModalSrc = readFileSync(resolve(__dirname, '../src/components/SearchModal.ts'), 'utf-8');
const searchManagerSrc = readFileSync(resolve(__dirname, '../src/app/search-manager.ts'), 'utf-8');
const appSrc = readFileSync(resolve(__dirname, '../src/App.ts'), 'utf-8');

describe('CMD+K add-disabled-panel discoverability wiring', () => {
  it('SearchModal exposes setAvailablePanels (the disabled-but-addable superset)', () => {
    assert.match(searchModalSrc, /setAvailablePanels\s*\(/, 'SearchModal must accept the available-panels superset');
  });

  it('panel-command gating goes through isPanelCommandVisible, not raw activePanelIds', () => {
    // Both filter sites (live matchCommands + the full command list) must
    // route through the helper so available-but-disabled panels survive.
    const visibleGates = searchModalSrc.match(/isPanelCommandVisible\(/g) || [];
    assert.ok(visibleGates.length >= 2, `expected >=2 isPanelCommandVisible gates, found ${visibleGates.length}`);
    // The old "skip unless enabled" form must not survive in the matcher.
    assert.doesNotMatch(
      searchModalSrc,
      /if \(!this\.activePanelIds\.has\(panelId\)\) continue;/,
      'matchCommands still skips panels that are not enabled — disabled panels stay unreachable',
    );
  });

  it('SearchModal renders an Add affordance for addable panels', () => {
    assert.match(searchModalSrc, /isAddablePanel\(/, 'missing isAddablePanel decision');
    assert.match(searchModalSrc, /command-addable/, 'missing the Add-affordance CSS hook');
  });

  it('SearchManager feeds the available set and enables-then-scrolls on select', () => {
    assert.match(searchManagerSrc, /setAvailablePanels\(/, 'SearchManager must publish the available-panels superset');
    // The panel command handler must enable a disabled panel before scrolling.
    assert.match(searchManagerSrc, /enablePanel\(action\)/, 'panel command handler must enable a disabled panel');
    assert.match(searchManagerSrc, /scrollToPanel\(action\)/, 'panel command handler must still scroll to the panel');
  });

  it('App wires the enablePanel callback into SearchManager', () => {
    assert.match(appSrc, /enablePanel:\s*\(panelId\)\s*=>\s*this\.eventHandlers\.enablePanelById\(panelId\)/);
  });

  it('EventHandler exposes a single enablePanelById used by both undo and search-add', () => {
    const ehSrc = readFileSync(resolve(__dirname, '../src/app/event-handlers.ts'), 'utf-8');
    assert.match(ehSrc, /enablePanelById\(panelId: string\): boolean/, 'enablePanelById must be the shared enable path');
    // performUndo must delegate to it (no duplicated enable logic).
    assert.match(ehSrc, /performUndo\(\): void \{[\s\S]*?this\.enablePanelById\(panelId\);/);
  });
});
