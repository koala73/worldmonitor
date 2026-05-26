/**
 * Regression tests for initial URL-sync suppression and DeckGLMap.pendingCenter.
 *
 * These cover the bugs fixed in the fix/url-params-overwrite series:
 *  - urlHasAsyncFlyTo guard (event-handlers.ts setupUrlStateSync)
 *  - DeckGLMap.pendingCenter eager cache (prevents stale center during flyTo)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Inline the pure urlHasAsyncFlyTo logic so these tests are zero-dependency
// (no DOM, no maplibre). This mirrors the exact condition in setupUrlStateSync.
// ---------------------------------------------------------------------------
function urlHasAsyncFlyTo(
  initialUrlState: { view?: string; lat?: number; lon?: number; zoom?: number } | undefined,
): boolean {
  const { view, lat, lon, zoom } = initialUrlState ?? {};
  return (
    (lat !== undefined && lon !== undefined) || // setCenter → flyTo (both required)
    (!view && zoom !== undefined)               // zoom-only → setZoom animated
  );
}

describe('urlHasAsyncFlyTo — suppression guard', () => {
  it('returns false when initialUrlState is undefined (cold load)', () => {
    assert.equal(urlHasAsyncFlyTo(undefined), false);
  });

  it('returns false for bare ?view=mena (no lat/lon, no zoom)', () => {
    assert.equal(urlHasAsyncFlyTo({ view: 'mena' }), false);
  });

  it('returns false for lone ?lat=41 without lon', () => {
    // Partial params must NOT suppress the immediate sync — only a full lat+lon
    // pair triggers an async flyTo via setCenter().
    assert.equal(urlHasAsyncFlyTo({ lat: 41 }), false);
  });

  it('returns false for lone ?lon=29 without lat', () => {
    assert.equal(urlHasAsyncFlyTo({ lon: 29 }), false);
  });

  it('returns true for full ?lat=41&lon=29 pair', () => {
    // setCenter() is only called when both coords are present → async flyTo.
    assert.equal(urlHasAsyncFlyTo({ lat: 41, lon: 29 }), true);
  });

  it('returns true for full lat+lon+zoom triplet', () => {
    assert.equal(urlHasAsyncFlyTo({ lat: 41, lon: 29, zoom: 6 }), true);
  });

  it('returns true for bare ?zoom without view (animated setZoom)', () => {
    // No view preset means setZoom() is called, which animates the transition.
    assert.equal(urlHasAsyncFlyTo({ zoom: 5 }), true);
  });

  it('returns false for ?view=mena&zoom=4 (view+zoom uses setView, synchronous)', () => {
    // When a view is present, setView() is used (not bare setZoom), so DeckGLMap
    // writes state.zoom eagerly — no suppression needed.
    assert.equal(urlHasAsyncFlyTo({ view: 'mena', zoom: 4 }), false);
  });

  it('returns false for ?view=eu with lat+lon absent', () => {
    assert.equal(urlHasAsyncFlyTo({ view: 'eu' }), false);
  });

  it('returns true for ?view=eu&lat=50&lon=15 (setCenter overrides view)', () => {
    // When lat+lon are present applyInitialUrlState calls setCenter regardless
    // of view — async flyTo path.
    assert.equal(urlHasAsyncFlyTo({ view: 'eu', lat: 50, lon: 15 }), true);
  });
});

// ---------------------------------------------------------------------------
// DeckGLMap.pendingCenter behaviour — tested via a minimal in-process stub
// that replicates the exact field logic without requiring maplibre or a DOM.
// ---------------------------------------------------------------------------

/** Minimal stub that mirrors only the pendingCenter + getCenter + setView logic. */
class DeckGLMapStub {
  public state = { view: 'global', zoom: 1.5 };
  private pendingCenter: { lat: number; lon: number } | null = null;

  private readonly VIEW_PRESETS: Record<string, { longitude: number; latitude: number; zoom: number }> = {
    global: { longitude: 0, latitude: 20, zoom: 1.5 },
    mena:   { longitude: 45, latitude: 28, zoom: 3.5 },
    eu:     { longitude: 15, latitude: 50, zoom: 3.5 },
    america:{ longitude: -95, latitude: 38, zoom: 3 },
  };

  setView(view: string, zoom?: number): void {
    const preset = this.VIEW_PRESETS[view];
    if (!preset) return;
    this.state.view = view;
    this.state.zoom = zoom ?? preset.zoom;
    this.pendingCenter = { lat: preset.latitude, lon: preset.longitude };
    // (maplibreMap.flyTo would be called here in the real impl)
  }

  /** Called by the real moveend listener. */
  simulateMoveEnd(finalLat: number, finalLon: number, finalZoom: number): void {
    this.pendingCenter = null;
    this.state.zoom = finalZoom;
    // (onStateChange?.(this.getState()) would fire here)
  }

  getCenter(): { lat: number; lon: number } | null {
    if (this.pendingCenter) return this.pendingCenter;
    return null; // maplibreMap absent in stub
  }

  getState() {
    return { view: this.state.view, zoom: this.state.zoom };
  }
}

describe('DeckGLMap.pendingCenter — eager center cache', () => {
  it('setView sets pendingCenter to preset coords', () => {
    const m = new DeckGLMapStub();
    m.setView('mena');
    const c = m.getCenter();
    assert.ok(c, 'getCenter() must return non-null after setView');
    assert.equal(c.lat, 28);
    assert.equal(c.lon, 45);
  });

  it('setView eagerly updates state.zoom to preset default', () => {
    const m = new DeckGLMapStub();
    m.setView('mena');
    assert.equal(m.getState().zoom, 3.5);
  });

  it('setView with explicit zoom overrides preset zoom', () => {
    const m = new DeckGLMapStub();
    m.setView('mena', 4);
    assert.equal(m.getState().zoom, 4);
    // center must still be the preset's lat/lon
    const c = m.getCenter();
    assert.ok(c);
    assert.equal(c.lat, 28);
    assert.equal(c.lon, 45);
  });

  it('getCenter returns pendingCenter before moveend fires', () => {
    const m = new DeckGLMapStub();
    m.setView('eu');
    const c = m.getCenter();
    assert.ok(c, 'must return pending center during flyTo animation');
    assert.equal(c.lat, 50);
    assert.equal(c.lon, 15);
  });

  it('moveend clears pendingCenter', () => {
    const m = new DeckGLMapStub();
    m.setView('mena');
    m.simulateMoveEnd(28, 45, 3.5);
    // After moveend, pendingCenter is null — getCenter() falls through to
    // maplibreMap (absent in stub → null). Real impl would use maplibreMap.getCenter().
    assert.equal(m.getCenter(), null);
  });

  it('moveend updates state.zoom to actual final zoom', () => {
    const m = new DeckGLMapStub();
    m.setView('mena', 4);
    // flyTo might settle at a slightly different zoom
    m.simulateMoveEnd(28, 45, 4.02);
    assert.equal(m.getState().zoom, 4.02);
  });

  it('consecutive setView calls reset pendingCenter to new preset', () => {
    const m = new DeckGLMapStub();
    m.setView('mena');
    m.setView('eu');
    const c = m.getCenter();
    assert.ok(c);
    assert.equal(c.lat, 50);
    assert.equal(c.lon, 15);
  });

  it('setView updates state.view synchronously', () => {
    const m = new DeckGLMapStub();
    m.setView('america');
    assert.equal(m.getState().view, 'america');
  });
});

// ---------------------------------------------------------------------------
// Integration: urlHasAsyncFlyTo + pendingCenter interaction
// Regression for: "?view=mena URL gained wrong lat/lon after initial sync"
// ---------------------------------------------------------------------------

describe('regression: ?view=mena initial sync writes correct coords', () => {
  it('view-only URL does NOT suppress sync (urlHasAsyncFlyTo=false)', () => {
    // The listener must fire the immediate debounce so the URL is updated.
    assert.equal(urlHasAsyncFlyTo({ view: 'mena' }), false);
  });

  it('pendingCenter holds preset coords during flyTo so buildMapUrl gets correct lat/lon', () => {
    const m = new DeckGLMapStub();
    // applyInitialUrlState calls setView('mena') → pendingCenter is set
    m.setView('mena');
    // When debouncedUrlSync fires (250ms) it calls map.getCenter()
    const center = m.getCenter();
    assert.ok(center, 'center must be available for URL builder');
    assert.equal(center.lat, 28,  'lat must be mena preset, not 0/20 global default');
    assert.equal(center.lon, 45, 'lon must be mena preset');
    assert.equal(m.getState().zoom, 3.5, 'zoom must be mena preset');
  });
});
