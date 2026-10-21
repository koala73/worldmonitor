import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AlternativesTab } from '../src/components/RouteExplorer/tabs/AlternativesTab.ts';
import { LandTab } from '../src/components/RouteExplorer/tabs/LandTab.ts';
import { renderRouteCard } from '../src/components/RouteExplorer/components/RouteCard.ts';
import type {
  BypassCorridorOption,
  GetRouteExplorerLaneResponse,
} from '../src/generated/server/worldmonitor/supply_chain/v1/service_server.ts';
import { createBrowserEnvironment } from './helpers/mini-dom.mts';
import { movePanelToKeyboardZone } from '../src/app/panel-keyboard-reorder.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts: string[]) => readFileSync(resolve(root, ...parts), 'utf8');

function snapshotGlobal(name: string) {
  return {
    exists: Object.prototype.hasOwnProperty.call(globalThis, name),
    value: (globalThis as Record<string, unknown>)[name],
  };
}

function restoreGlobal(name: string, snapshot: { exists: boolean; value: unknown }) {
  if (snapshot.exists) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: snapshot.value,
    });
    return;
  }
  delete (globalThis as Record<string, unknown>)[name];
}

function defineGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
}

const originalGlobals = {
  document: snapshotGlobal('document'),
  window: snapshotGlobal('window'),
  HTMLElement: snapshotGlobal('HTMLElement'),
  Node: snapshotGlobal('Node'),
};

const browser = createBrowserEnvironment();
const MiniNode = Object.getPrototypeOf(browser.HTMLElement.prototype).constructor;

defineGlobal('document', browser.document);
defineGlobal('window', browser.window);
defineGlobal('HTMLElement', browser.HTMLElement);
defineGlobal('Node', MiniNode);

after(() => {
  restoreGlobal('document', originalGlobals.document);
  restoreGlobal('window', originalGlobals.window);
  restoreGlobal('HTMLElement', originalGlobals.HTMLElement);
  restoreGlobal('Node', originalGlobals.Node);
});

function corridor(overrides: Partial<BypassCorridorOption> = {}): BypassCorridorOption {
  return {
    id: 'suez-cape',
    name: 'Cape of Good Hope',
    type: 'sea',
    addedTransitDays: 12,
    addedCostMultiplier: 1.18,
    warRiskTier: 'WAR_RISK_TIER_NORMAL',
    status: 'CORRIDOR_STATUS_ACTIVE',
    ...overrides,
  };
}

function lane(bypassOptions: BypassCorridorOption[]): GetRouteExplorerLaneResponse {
  return {
    fromIso2: 'CN',
    toIso2: 'NL',
    hs2: '85',
    cargoType: 'EXPLORER_CARGO_CONTAINER',
    primaryRouteId: 'suez',
    primaryRouteGeometry: [],
    chokepointExposures: [],
    bypassOptions,
    warRiskTier: 'WAR_RISK_TIER_NORMAL',
    disruptionScore: 40,
    noModeledLane: false,
    fetchedAt: '2024-01-15T00:00:00.000Z',
  };
}

describe('RouteCard roving tabindex', () => {
  it('keeps every option in the tab order unless roving is opted in', () => {
    const inactive = renderRouteCard({
      option: corridor(),
      index: 1,
      isActive: false,
      onSelect() {},
    });
    assert.equal(inactive.getAttribute('tabindex'), '0');
  });

  it('uses tabindex=-1 for inactive roving options', () => {
    const inactive = renderRouteCard({
      option: corridor(),
      index: 1,
      isActive: false,
      roving: true,
      onSelect() {},
    });
    assert.equal(inactive.getAttribute('tabindex'), '-1');
  });

  it('keeps a fallback tab stop tabbable before any option is selected', () => {
    const first = renderRouteCard({
      option: corridor({ id: 'first' }),
      index: 0,
      isActive: false,
      roving: true,
      tabStop: true,
      onSelect() {},
    });
    const second = renderRouteCard({
      option: corridor({ id: 'second' }),
      index: 1,
      isActive: false,
      roving: true,
      tabStop: false,
      onSelect() {},
    });
    assert.equal(first.getAttribute('tabindex'), '0');
    assert.equal(second.getAttribute('tabindex'), '-1');
    assert.equal(first.getAttribute('aria-selected'), 'false');
  });
});

describe('AlternativesTab listbox tab stops', () => {
  it('leaves exactly one tab stop when nothing is selected yet', () => {
    const tab = new AlternativesTab({ onSelectBypass() {} });
    tab.update(lane([
      corridor({ id: 'cape', name: 'Cape' }),
      corridor({ id: 'panama', name: 'Panama' }),
    ]));

    const cards = tab.element.querySelectorAll('.re-route-card');
    assert.equal(cards.length, 2);
    assert.deepEqual(
      cards.map((card) => card.getAttribute('tabindex')),
      ['0', '-1'],
    );
  });

  it('moves the tab stop onto the first enabled option when the first cards are disabled', () => {
    const tab = new AlternativesTab({ onSelectBypass() {} });
    tab.update(lane([
      corridor({ id: 'proposed', status: 'CORRIDOR_STATUS_PROPOSED' }),
      corridor({ id: 'active', status: 'CORRIDOR_STATUS_ACTIVE' }),
    ]));

    const cards = tab.element.querySelectorAll('.re-route-card');
    assert.deepEqual(
      cards.map((card) => card.getAttribute('tabindex')),
      ['-1', '0'],
    );
  });

  it('moves to the next option on the first ArrowDown press', () => {
    const tab = new AlternativesTab({ onSelectBypass() {} });
    tab.update(lane([
      corridor({ id: 'cape', name: 'Cape' }),
      corridor({ id: 'panama', name: 'Panama' }),
    ]));

    const event = Object.assign(new Event('keydown', { cancelable: true }), { key: 'ArrowDown' });
    tab.element.dispatchEvent(event);

    const cards = tab.element.querySelectorAll('.re-route-card');
    assert.equal(event.defaultPrevented, true);
    assert.equal(cards[0]?.getAttribute('aria-selected'), 'false');
    assert.equal(cards[1]?.getAttribute('aria-selected'), 'true');
  });
});

describe('panel keyboard zone moves', () => {
  it('moves a panel between both grids and keeps bottom-set persistence aligned', () => {
    const sidebarGrid = document.createElement('div');
    sidebarGrid.className = 'panels-grid';
    const bottomGrid = document.createElement('div');
    bottomGrid.className = 'map-bottom-grid';
    const panel = document.createElement('section');
    panel.className = 'panel';
    const addPanelBlock = document.createElement('button');
    addPanelBlock.className = 'add-panel-block';
    sidebarGrid.append(panel, addPanelBlock);
    const bottomSet = new Set<string>();

    assert.equal(movePanelToKeyboardZone({
      panel,
      panelKey: 'live-news',
      targetZone: 'bottom',
      sidebarGrid,
      bottomGrid,
      bottomSet,
    }), true);
    assert.equal(panel.parentElement, bottomGrid);
    assert.equal(bottomSet.has('live-news'), true);

    assert.equal(movePanelToKeyboardZone({
      panel,
      panelKey: 'live-news',
      targetZone: 'sidebar',
      sidebarGrid,
      bottomGrid,
      bottomSet,
    }), true);
    assert.equal(panel.parentElement, sidebarGrid);
    assert.equal(panel.nextElementSibling, addPanelBlock);
    assert.equal(bottomSet.has('live-news'), false);
  });
});

describe('LandTab listbox tab stops', () => {
  it('keeps land corridor cards tabbable even though none are marked active', () => {
    const tab = new LandTab({ onSelectBypass() {} });
    tab.update(lane([
      corridor({ id: 'aqaba', name: 'Aqaba', type: 'land_bridge' }),
      corridor({ id: 'djibouti', name: 'Djibouti-Addis', type: 'land_bridge' }),
    ]));

    const cards = tab.element.querySelectorAll('.re-route-card');
    assert.equal(cards.length, 2);
    assert.deepEqual(
      cards.map((card) => card.getAttribute('tabindex')),
      ['0', '0'],
    );
  });
});

describe('stacked overlay keyboard contracts', () => {
  it('RouteExplorer capture listener yields when focus is inside a stacked aria-modal', () => {
    const source = read('src/components/RouteExplorer/RouteExplorer.ts');
    assert.match(source, /private isStackedModalFocused\(\): boolean/);
    assert.match(source, /el\.closest\('\[aria-modal="true"\]'\)/);
    assert.match(
      source,
      /if \(this\.isStackedModalFocused\(\)\) return;/,
      'handleGlobalKeydown must return before Escape closes the Explorer',
    );
  });

  it('AviationCommandBar focuses the command input when the trap activates', () => {
    const source = read('src/components/AviationCommandBar.ts');
    assert.match(
      source,
      /initialFocus:\s*\(\)\s*=>\s*this\.overlay\?\.querySelector<HTMLInputElement>\('#aviation-cmd-input'\)/,
    );
  });

  it('findings modal trap dismisses on Escape', () => {
    const source = read('src/components/IntelligenceGapBadge.ts');
    assert.match(
      source,
      /createFocusTrap\(overlay,\s*\{\s*onEscape:\s*\(\)\s*=>\s*this\.dismissFindingsModal\(\)/,
    );
  });
});
