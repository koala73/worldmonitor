import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const root = join(import.meta.dirname, '..');

const deckGLMapSrc = readFileSync(join(root, 'src', 'components', 'DeckGLMap.ts'), 'utf-8');
const mapContainerSrc = readFileSync(join(root, 'src', 'components', 'MapContainer.ts'), 'utf-8');
const deepDiveSrc = readFileSync(join(root, 'src', 'components', 'CountryDeepDivePanel.ts'), 'utf-8');

describe('DeckGLMap route highlight methods', () => {
  it('highlightRoute method exists and accepts string array', () => {
    assert.ok(
      deckGLMapSrc.includes('highlightRoute(routeIds'),
      'DeckGLMap must have highlightRoute method accepting routeIds',
    );
  });

  it('clearHighlightedRoute method exists', () => {
    assert.ok(
      deckGLMapSrc.includes('clearHighlightedRoute'),
      'DeckGLMap must have clearHighlightedRoute method',
    );
  });

  it('zoomToRoutes method exists', () => {
    assert.ok(
      deckGLMapSrc.includes('zoomToRoutes(routeIds'),
      'DeckGLMap must have zoomToRoutes method accepting routeIds',
    );
  });

  it('highlightedRouteIds field is a Set', () => {
    assert.ok(
      deckGLMapSrc.includes('highlightedRouteIds: Set<string>') ||
      deckGLMapSrc.includes('highlightedRouteIds = new Set'),
      'DeckGLMap must declare highlightedRouteIds as a Set<string>',
    );
  });

  it('createTradeRoutesLayer checks highlightedRouteIds.size for dimming', () => {
    const defIdx = deckGLMapSrc.indexOf('private createTradeRoutesLayer');
    assert.ok(defIdx !== -1, 'createTradeRoutesLayer method definition must exist');
    const layerMethod = deckGLMapSrc.slice(defIdx, defIdx + 3000);
    assert.ok(
      layerMethod.includes('highlightedRouteIds.size'),
      'createTradeRoutesLayer must check highlightedRouteIds.size to determine dimming',
    );
    assert.ok(
      layerMethod.includes('dimColor'),
      'createTradeRoutesLayer must use dimColor for non-highlighted routes',
    );
  });

  it('buildTradeTrips handles highlighting', () => {
    const tripsMethod = deckGLMapSrc.slice(
      deckGLMapSrc.indexOf('buildTradeTrips'),
      deckGLMapSrc.indexOf('buildTradeTrips') + 3000,
    );
    assert.ok(
      tripsMethod.includes('highlightedRouteIds.size'),
      'buildTradeTrips must check highlightedRouteIds.size for route highlighting',
    );
    assert.ok(
      tripsMethod.includes('hlIds.has(routeId)'),
      'buildTradeTrips must check hlIds.has(routeId) for per-route dimming',
    );
  });
});

describe('MapContainer route highlight dispatch', () => {
  it('highlightRoute method exists', () => {
    assert.ok(
      mapContainerSrc.includes('highlightRoute(routeIds'),
      'MapContainer must have highlightRoute method',
    );
  });

  it('clearHighlightedRoute method exists', () => {
    assert.ok(
      mapContainerSrc.includes('clearHighlightedRoute'),
      'MapContainer must have clearHighlightedRoute method',
    );
  });

  it('zoomToRoutes method exists', () => {
    assert.ok(
      mapContainerSrc.includes('zoomToRoutes(routeIds'),
      'MapContainer must have zoomToRoutes method',
    );
  });

  it('highlightRoute dispatches to deckGLMap', () => {
    assert.ok(
      mapContainerSrc.includes('deckGLMap?.highlightRoute'),
      'MapContainer.highlightRoute must dispatch to deckGLMap.highlightRoute',
    );
  });

  it('clearHighlightedRoute dispatches to deckGLMap', () => {
    assert.ok(
      mapContainerSrc.includes('deckGLMap?.clearHighlightedRoute'),
      'MapContainer.clearHighlightedRoute must dispatch to deckGLMap.clearHighlightedRoute',
    );
  });

  it('zoomToRoutes dispatches to deckGLMap', () => {
    assert.ok(
      mapContainerSrc.includes('deckGLMap?.zoomToRoutes'),
      'MapContainer.zoomToRoutes must dispatch to deckGLMap.zoomToRoutes',
    );
  });
});

describe('CountryDeepDivePanel sector route interaction', () => {
  it('selectedSectorHs2 field exists', () => {
    assert.ok(
      deepDiveSrc.includes('selectedSectorHs2'),
      'CountryDeepDivePanel must have selectedSectorHs2 field',
    );
  });

  it('handleSectorRowClick method exists', () => {
    assert.ok(
      deepDiveSrc.includes('handleSectorRowClick'),
      'CountryDeepDivePanel must have handleSectorRowClick method',
    );
  });

  it('clearHighlightedRoute is called unconditionally at top of handleSectorRowClick', () => {
    const methodStart = deepDiveSrc.indexOf('handleSectorRowClick(hs2');
    assert.ok(methodStart !== -1, 'handleSectorRowClick must exist');
    const firstIf = deepDiveSrc.indexOf('if (this.selectedSectorHs2', methodStart);
    const clearCall = deepDiveSrc.indexOf('clearHighlightedRoute()', methodStart);
    assert.ok(clearCall !== -1, 'handleSectorRowClick must call clearHighlightedRoute');
    assert.ok(
      clearCall < firstIf,
      'clearHighlightedRoute must be called before the selectedSectorHs2 toggle check (unconditional cleanup)',
    );
  });

  it('buildRouteDetail method exists', () => {
    assert.ok(
      deepDiveSrc.includes('buildRouteDetail'),
      'CountryDeepDivePanel must have buildRouteDetail method',
    );
  });

  it('trackGateHit is NOT called during render (should be in click handler)', () => {
    const importLine = deepDiveSrc.indexOf("import { trackGateHit }");
    const importEnd = deepDiveSrc.indexOf('\n', importLine);
    const matches = [...deepDiveSrc.matchAll(/trackGateHit/g)];
    assert.ok(matches.length >= 2, 'trackGateHit must be imported and used at least once');
    for (const m of matches) {
      if (m.index >= importLine && m.index <= importEnd) continue;
      const contextBefore = deepDiveSrc.slice(Math.max(0, m.index - 200), m.index);
      assert.ok(
        contextBefore.includes('addEventListener') || contextBefore.includes("'click'"),
        'trackGateHit must only be called inside an event listener, never during render',
      );
    }
  });

  it('resetPanelContent clears selectedSectorHs2', () => {
    const resetStart = deepDiveSrc.indexOf('resetPanelContent(): void');
    assert.ok(resetStart !== -1, 'resetPanelContent must exist');
    const resetBody = deepDiveSrc.slice(resetStart, resetStart + 500);
    assert.ok(
      resetBody.includes('this.selectedSectorHs2 = null'),
      'resetPanelContent must set selectedSectorHs2 to null',
    );
  });

  it('sectorBypassAbort is aborted in reset', () => {
    const resetStart = deepDiveSrc.indexOf('resetPanelContent(): void');
    const resetBody = deepDiveSrc.slice(resetStart, resetStart + 500);
    assert.ok(
      resetBody.includes('sectorBypassAbort?.abort()'),
      'resetPanelContent must abort sectorBypassAbort',
    );
    assert.ok(
      resetBody.includes('sectorBypassAbort = null'),
      'resetPanelContent must set sectorBypassAbort to null after aborting',
    );
  });

  it('escapeHtml is used in route path rendering', () => {
    const defIdx = deepDiveSrc.indexOf('private buildRouteDetail');
    assert.ok(defIdx !== -1, 'buildRouteDetail method definition must exist');
    const buildDetail = deepDiveSrc.slice(defIdx, defIdx + 3000);
    assert.ok(
      buildDetail.includes('escapeHtml'),
      'buildRouteDetail must use escapeHtml to sanitize route path rendering',
    );
  });
});

describe('Sector route data consistency', () => {
  it('getChokepointRoutes is imported from trade-routes', () => {
    assert.ok(
      deepDiveSrc.includes("getChokepointRoutes") &&
      deepDiveSrc.includes("trade-routes"),
      'CountryDeepDivePanel must import getChokepointRoutes from trade-routes',
    );
  });

  it('STRATEGIC_WATERWAYS is imported from geo', () => {
    assert.ok(
      deepDiveSrc.includes("STRATEGIC_WATERWAYS") &&
      deepDiveSrc.includes("from '@/config/geo'"),
      'CountryDeepDivePanel must import STRATEGIC_WATERWAYS from @/config/geo',
    );
  });

  it('bypass options use fetchBypassOptions (not inline data)', () => {
    assert.ok(
      deepDiveSrc.includes('fetchBypassOptions'),
      'CountryDeepDivePanel must use fetchBypassOptions for bypass corridor data',
    );
    const defIdx = deepDiveSrc.indexOf('private buildRouteDetail');
    assert.ok(defIdx !== -1, 'buildRouteDetail method definition must exist');
    const buildDetail = deepDiveSrc.slice(defIdx, defIdx + 4000);
    assert.ok(
      buildDetail.includes('fetchBypassOptions'),
      'buildRouteDetail must call fetchBypassOptions rather than using inline bypass data',
    );
  });

  it('escapeHtml is imported from sanitize', () => {
    assert.ok(
      deepDiveSrc.includes("escapeHtml") &&
      deepDiveSrc.includes("from '@/utils/sanitize'"),
      'CountryDeepDivePanel must import escapeHtml from @/utils/sanitize',
    );
  });
});
