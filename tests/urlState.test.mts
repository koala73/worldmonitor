import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMapUrlState, buildMapUrl } from '../src/utils/urlState.ts';

const EMPTY_LAYERS = {
  conflicts: false, bases: false, cables: false, pipelines: false,
  hotspots: false, ais: false, nuclear: false, irradiators: false,
  sanctions: false, weather: false, economic: false, waterways: false,
  outages: false, cyberThreats: false, datacenters: false, protests: false,
  flights: false, military: false, natural: false, spaceports: false,
  minerals: false, fires: false, ucdpEvents: false, displacement: false,
  climate: false, startupHubs: false, cloudRegions: false,
  accelerators: false, techHQs: false, techEvents: false,
  tradeRoutes: false, iranAttacks: false, gpsJamming: false,
};

describe('parseMapUrlState expanded param', () => {
  it('parses expanded=1 as true', () => {
    const state = parseMapUrlState('?country=IR&expanded=1', EMPTY_LAYERS);
    assert.equal(state.country, 'IR');
    assert.equal(state.expanded, true);
  });

  it('parses missing expanded as undefined', () => {
    const state = parseMapUrlState('?country=IR', EMPTY_LAYERS);
    assert.equal(state.country, 'IR');
    assert.equal(state.expanded, undefined);
  });

  it('ignores expanded=0', () => {
    const state = parseMapUrlState('?country=IR&expanded=0', EMPTY_LAYERS);
    assert.equal(state.expanded, undefined);
  });
});

describe('buildMapUrl expanded param', () => {
  const base = 'https://worldmonitor.app/';
  const baseState = {
    view: 'global' as const,
    zoom: 2,
    center: { lat: 0, lon: 0 },
    timeRange: '24h' as const,
    layers: EMPTY_LAYERS,
  };

  it('includes expanded=1 when true', () => {
    const url = buildMapUrl(base, { ...baseState, country: 'IR', expanded: true });
    const params = new URL(url).searchParams;
    assert.equal(params.get('country'), 'IR');
    assert.equal(params.get('expanded'), '1');
  });

  it('omits expanded when falsy', () => {
    const url = buildMapUrl(base, { ...baseState, country: 'IR' });
    const params = new URL(url).searchParams;
    assert.equal(params.get('country'), 'IR');
    assert.equal(params.has('expanded'), false);
  });

  it('omits expanded when undefined', () => {
    const url = buildMapUrl(base, { ...baseState, country: 'IR', expanded: undefined });
    const params = new URL(url).searchParams;
    assert.equal(params.has('expanded'), false);
  });
});

describe('expanded param round-trip', () => {
  const base = 'https://worldmonitor.app/';
  const baseState = {
    view: 'global' as const,
    zoom: 2,
    center: { lat: 0, lon: 0 },
    timeRange: '24h' as const,
    layers: EMPTY_LAYERS,
  };

  it('round-trips country=IR&expanded=1', () => {
    const url = buildMapUrl(base, { ...baseState, country: 'IR', expanded: true });
    const parsed = parseMapUrlState(new URL(url).search, EMPTY_LAYERS);
    assert.equal(parsed.country, 'IR');
    assert.equal(parsed.expanded, true);
  });

  it('round-trips country=IR without expanded', () => {
    const url = buildMapUrl(base, { ...baseState, country: 'IR' });
    const parsed = parseMapUrlState(new URL(url).search, EMPTY_LAYERS);
    assert.equal(parsed.country, 'IR');
    assert.equal(parsed.expanded, undefined);
  });
});

// ---------------------------------------------------------------------------
// parseMapUrlState edge cases
// ---------------------------------------------------------------------------

describe('parseMapUrlState — empty and missing input', () => {
  it('returns all defaults for empty string', () => {
    const state = parseMapUrlState('', EMPTY_LAYERS);
    assert.equal(state.view, undefined);
    assert.equal(state.zoom, undefined);
    assert.equal(state.lat, undefined);
    assert.equal(state.lon, undefined);
    assert.equal(state.timeRange, undefined);
    assert.equal(state.layers, undefined);
    assert.equal(state.country, undefined);
    assert.equal(state.expanded, undefined);
  });

  it('returns all defaults for bare "?"', () => {
    const state = parseMapUrlState('?', EMPTY_LAYERS);
    assert.equal(state.view, undefined);
    assert.equal(state.zoom, undefined);
    assert.equal(state.country, undefined);
  });
});

describe('parseMapUrlState — country validation', () => {
  it('rejects country code longer than 2 characters', () => {
    const state = parseMapUrlState('?country=XX123', EMPTY_LAYERS);
    assert.equal(state.country, undefined);
  });

  it('uppercases lowercase country code', () => {
    const state = parseMapUrlState('?country=us', EMPTY_LAYERS);
    assert.equal(state.country, 'US');
  });

  it('returns undefined for empty country value', () => {
    const state = parseMapUrlState('?country=', EMPTY_LAYERS);
    assert.equal(state.country, undefined);
  });

  it('rejects single-letter country code', () => {
    const state = parseMapUrlState('?country=A', EMPTY_LAYERS);
    assert.equal(state.country, undefined);
  });

  it('rejects country code with digits', () => {
    const state = parseMapUrlState('?country=U1', EMPTY_LAYERS);
    assert.equal(state.country, undefined);
  });

  it('accepts URL-encoded country code (%49%52 = IR)', () => {
    const state = parseMapUrlState('?country=%49%52', EMPTY_LAYERS);
    assert.equal(state.country, 'IR');
  });

  it('trims whitespace around country code', () => {
    const state = parseMapUrlState('?country=%20US%20', EMPTY_LAYERS);
    assert.equal(state.country, 'US');
  });
});

describe('parseMapUrlState — zoom boundary values', () => {
  it('clamps zoom=0 to minimum 1', () => {
    const state = parseMapUrlState('?zoom=0', EMPTY_LAYERS);
    assert.equal(state.zoom, 1);
  });

  it('clamps zoom=-1 to minimum 1', () => {
    const state = parseMapUrlState('?zoom=-1', EMPTY_LAYERS);
    assert.equal(state.zoom, 1);
  });

  it('clamps zoom=25 to maximum 10', () => {
    const state = parseMapUrlState('?zoom=25', EMPTY_LAYERS);
    assert.equal(state.zoom, 10);
  });

  it('returns undefined for zoom=NaN', () => {
    const state = parseMapUrlState('?zoom=NaN', EMPTY_LAYERS);
    assert.equal(state.zoom, undefined);
  });

  it('returns undefined for zoom=Infinity', () => {
    const state = parseMapUrlState('?zoom=Infinity', EMPTY_LAYERS);
    assert.equal(state.zoom, undefined);
  });

  it('returns undefined for zoom=-Infinity', () => {
    const state = parseMapUrlState('?zoom=-Infinity', EMPTY_LAYERS);
    assert.equal(state.zoom, undefined);
  });

  it('parses fractional zoom within range', () => {
    const state = parseMapUrlState('?zoom=5.5', EMPTY_LAYERS);
    assert.equal(state.zoom, 5.5);
  });

  it('returns undefined for non-numeric zoom', () => {
    const state = parseMapUrlState('?zoom=abc', EMPTY_LAYERS);
    assert.equal(state.zoom, undefined);
  });
});

describe('parseMapUrlState — lat/lon boundary values', () => {
  it('accepts lat=90 and lon=180 (valid extremes)', () => {
    const state = parseMapUrlState('?lat=90&lon=180', EMPTY_LAYERS);
    assert.equal(state.lat, 90);
    assert.equal(state.lon, 180);
  });

  it('accepts lat=-90 and lon=-180 (valid extremes)', () => {
    const state = parseMapUrlState('?lat=-90&lon=-180', EMPTY_LAYERS);
    assert.equal(state.lat, -90);
    assert.equal(state.lon, -180);
  });

  it('clamps lat=91 to 90', () => {
    const state = parseMapUrlState('?lat=91', EMPTY_LAYERS);
    assert.equal(state.lat, 90);
  });

  it('clamps lon=181 to 180', () => {
    const state = parseMapUrlState('?lon=181', EMPTY_LAYERS);
    assert.equal(state.lon, 180);
  });

  it('clamps lat=-91 to -90', () => {
    const state = parseMapUrlState('?lat=-91', EMPTY_LAYERS);
    assert.equal(state.lat, -90);
  });

  it('clamps lon=-181 to -180', () => {
    const state = parseMapUrlState('?lon=-181', EMPTY_LAYERS);
    assert.equal(state.lon, -180);
  });

  it('returns undefined for lat=NaN', () => {
    const state = parseMapUrlState('?lat=NaN', EMPTY_LAYERS);
    assert.equal(state.lat, undefined);
  });

  it('returns undefined for lon=NaN', () => {
    const state = parseMapUrlState('?lon=NaN', EMPTY_LAYERS);
    assert.equal(state.lon, undefined);
  });

  it('parses lat without lon independently', () => {
    const state = parseMapUrlState('?lat=45', EMPTY_LAYERS);
    assert.equal(state.lat, 45);
    assert.equal(state.lon, undefined);
  });

  it('parses lon without lat independently', () => {
    const state = parseMapUrlState('?lon=90', EMPTY_LAYERS);
    assert.equal(state.lat, undefined);
    assert.equal(state.lon, 90);
  });
});

describe('parseMapUrlState — timeRange validation', () => {
  it('accepts valid timeRange "1h"', () => {
    const state = parseMapUrlState('?timeRange=1h', EMPTY_LAYERS);
    assert.equal(state.timeRange, '1h');
  });

  it('accepts valid timeRange "all"', () => {
    const state = parseMapUrlState('?timeRange=all', EMPTY_LAYERS);
    assert.equal(state.timeRange, 'all');
  });

  it('rejects invalid timeRange "99h"', () => {
    const state = parseMapUrlState('?timeRange=99h', EMPTY_LAYERS);
    assert.equal(state.timeRange, undefined);
  });

  it('rejects empty timeRange', () => {
    const state = parseMapUrlState('?timeRange=', EMPTY_LAYERS);
    assert.equal(state.timeRange, undefined);
  });

  it('rejects arbitrary string timeRange', () => {
    const state = parseMapUrlState('?timeRange=invalid', EMPTY_LAYERS);
    assert.equal(state.timeRange, undefined);
  });

  it('rejects case-mismatched timeRange "24H"', () => {
    const state = parseMapUrlState('?timeRange=24H', EMPTY_LAYERS);
    assert.equal(state.timeRange, undefined);
  });
});

describe('parseMapUrlState — view validation', () => {
  it('accepts valid view "mena"', () => {
    const state = parseMapUrlState('?view=mena', EMPTY_LAYERS);
    assert.equal(state.view, 'mena');
  });

  it('rejects invalid view value', () => {
    const state = parseMapUrlState('?view=antarctic', EMPTY_LAYERS);
    assert.equal(state.view, undefined);
  });

  it('rejects empty view', () => {
    const state = parseMapUrlState('?view=', EMPTY_LAYERS);
    assert.equal(state.view, undefined);
  });
});

describe('parseMapUrlState — layer parsing', () => {
  it('enables only specified layers', () => {
    const state = parseMapUrlState('?layers=conflicts,bases', EMPTY_LAYERS);
    assert.notEqual(state.layers, undefined);
    assert.equal(state.layers!.conflicts, true);
    assert.equal(state.layers!.bases, true);
    assert.equal(state.layers!.cables, false);
    assert.equal(state.layers!.nuclear, false);
  });

  it('ignores unknown layer names', () => {
    const state = parseMapUrlState('?layers=conflicts,nonexistent', EMPTY_LAYERS);
    assert.notEqual(state.layers, undefined);
    assert.equal(state.layers!.conflicts, true);
    assert.equal(state.layers!.bases, false);
  });

  it('disables all layers for "none"', () => {
    const state = parseMapUrlState('?layers=none', EMPTY_LAYERS);
    assert.notEqual(state.layers, undefined);
    for (const key of Object.keys(state.layers!)) {
      assert.equal(state.layers![key as keyof typeof EMPTY_LAYERS], false, `expected ${key} to be false`);
    }
  });

  it('disables all layers for empty layers param', () => {
    const state = parseMapUrlState('?layers=', EMPTY_LAYERS);
    assert.notEqual(state.layers, undefined);
    for (const key of Object.keys(state.layers!)) {
      assert.equal(state.layers![key as keyof typeof EMPTY_LAYERS], false, `expected ${key} to be false`);
    }
  });

  it('returns undefined layers when layers param is absent', () => {
    const state = parseMapUrlState('?zoom=5', EMPTY_LAYERS);
    assert.equal(state.layers, undefined);
  });

  it('handles layers with extra commas gracefully', () => {
    const state = parseMapUrlState('?layers=conflicts,,bases,', EMPTY_LAYERS);
    assert.notEqual(state.layers, undefined);
    assert.equal(state.layers!.conflicts, true);
    assert.equal(state.layers!.bases, true);
    assert.equal(state.layers!.cables, false);
  });

  it('handles layers with whitespace around names', () => {
    const state = parseMapUrlState('?layers=%20conflicts%20,%20bases%20', EMPTY_LAYERS);
    assert.notEqual(state.layers, undefined);
    assert.equal(state.layers!.conflicts, true);
    assert.equal(state.layers!.bases, true);
  });
});

describe('parseMapUrlState — duplicate params', () => {
  it('takes first value when country is duplicated', () => {
    const state = parseMapUrlState('?country=IR&country=US', EMPTY_LAYERS);
    assert.equal(state.country, 'IR');
  });

  it('takes first value when zoom is duplicated', () => {
    const state = parseMapUrlState('?zoom=3&zoom=8', EMPTY_LAYERS);
    assert.equal(state.zoom, 3);
  });
});

describe('parseMapUrlState — search string without leading ?', () => {
  it('parses params even without leading ?', () => {
    const state = parseMapUrlState('country=IR&zoom=5', EMPTY_LAYERS);
    assert.equal(state.country, 'IR');
    assert.equal(state.zoom, 5);
  });
});

// ---------------------------------------------------------------------------
// buildMapUrl edge cases
// ---------------------------------------------------------------------------

describe('buildMapUrl — defaults produce minimal URL', () => {
  const base = 'https://worldmonitor.app/';
  const defaultState = {
    view: 'global' as const,
    zoom: 2,
    center: null,
    timeRange: '24h' as const,
    layers: EMPTY_LAYERS,
  };

  it('omits lat/lon when center is null', () => {
    const url = buildMapUrl(base, defaultState);
    const params = new URL(url).searchParams;
    assert.equal(params.has('lat'), false);
    assert.equal(params.has('lon'), false);
  });

  it('omits country when not provided', () => {
    const url = buildMapUrl(base, defaultState);
    const params = new URL(url).searchParams;
    assert.equal(params.has('country'), false);
  });

  it('sets layers to "none" when all layers are off', () => {
    const url = buildMapUrl(base, defaultState);
    const params = new URL(url).searchParams;
    assert.equal(params.get('layers'), 'none');
  });

  it('always includes zoom, view, and timeRange', () => {
    const url = buildMapUrl(base, defaultState);
    const params = new URL(url).searchParams;
    assert.equal(params.get('zoom'), '2.00');
    assert.equal(params.get('view'), 'global');
    assert.equal(params.get('timeRange'), '24h');
  });
});

describe('buildMapUrl — all parameters set', () => {
  const base = 'https://worldmonitor.app/';
  const fullLayers = { ...EMPTY_LAYERS, conflicts: true, bases: true, nuclear: true };

  it('includes every parameter in the URL', () => {
    const url = buildMapUrl(base, {
      view: 'mena',
      zoom: 6,
      center: { lat: 32.5, lon: 53.25 },
      timeRange: '7d',
      layers: fullLayers,
      country: 'IR',
      expanded: true,
    });
    const params = new URL(url).searchParams;
    assert.equal(params.get('lat'), '32.5000');
    assert.equal(params.get('lon'), '53.2500');
    assert.equal(params.get('zoom'), '6.00');
    assert.equal(params.get('view'), 'mena');
    assert.equal(params.get('timeRange'), '7d');
    assert.equal(params.get('country'), 'IR');
    assert.equal(params.get('expanded'), '1');
    const layers = params.get('layers')!.split(',');
    assert.ok(layers.includes('conflicts'));
    assert.ok(layers.includes('bases'));
    assert.ok(layers.includes('nuclear'));
    assert.equal(layers.length, 3);
  });
});

describe('buildMapUrl — center edge cases', () => {
  const base = 'https://worldmonitor.app/';
  const baseState = {
    view: 'global' as const,
    zoom: 2,
    timeRange: '24h' as const,
    layers: EMPTY_LAYERS,
  };

  it('omits lat/lon when center is undefined', () => {
    const url = buildMapUrl(base, { ...baseState });
    const params = new URL(url).searchParams;
    assert.equal(params.has('lat'), false);
    assert.equal(params.has('lon'), false);
  });

  it('formats lat/lon to 4 decimal places', () => {
    const url = buildMapUrl(base, { ...baseState, center: { lat: 1.23456789, lon: -9.87654321 } });
    const params = new URL(url).searchParams;
    assert.equal(params.get('lat'), '1.2346');
    assert.equal(params.get('lon'), '-9.8765');
  });
});

// ---------------------------------------------------------------------------
// Round-trip tests
// ---------------------------------------------------------------------------

describe('round-trip — every parameter survives build then parse', () => {
  const base = 'https://worldmonitor.app/';

  it('round-trips view', () => {
    const views = ['global', 'america', 'mena', 'eu', 'asia', 'latam', 'africa', 'oceania'] as const;
    for (const view of views) {
      const url = buildMapUrl(base, {
        view,
        zoom: 3,
        center: { lat: 10, lon: 20 },
        timeRange: '24h',
        layers: EMPTY_LAYERS,
      });
      const parsed = parseMapUrlState(new URL(url).search, EMPTY_LAYERS);
      assert.equal(parsed.view, view, `view "${view}" did not round-trip`);
    }
  });

  it('round-trips zoom (clamped to 4 dp by toFixed(2))', () => {
    const url = buildMapUrl(base, {
      view: 'global',
      zoom: 7.89,
      center: { lat: 0, lon: 0 },
      timeRange: '24h',
      layers: EMPTY_LAYERS,
    });
    const parsed = parseMapUrlState(new URL(url).search, EMPTY_LAYERS);
    assert.equal(parsed.zoom, 7.89);
  });

  it('round-trips lat/lon with 4 decimal precision', () => {
    const url = buildMapUrl(base, {
      view: 'global',
      zoom: 3,
      center: { lat: -45.6789, lon: 123.4567 },
      timeRange: '6h',
      layers: EMPTY_LAYERS,
    });
    const parsed = parseMapUrlState(new URL(url).search, EMPTY_LAYERS);
    assert.equal(parsed.lat, -45.6789);
    assert.equal(parsed.lon, 123.4567);
  });

  it('round-trips all timeRange values', () => {
    const ranges = ['1h', '6h', '24h', '48h', '7d', 'all'] as const;
    for (const tr of ranges) {
      const url = buildMapUrl(base, {
        view: 'global',
        zoom: 3,
        center: { lat: 0, lon: 0 },
        timeRange: tr,
        layers: EMPTY_LAYERS,
      });
      const parsed = parseMapUrlState(new URL(url).search, EMPTY_LAYERS);
      assert.equal(parsed.timeRange, tr, `timeRange "${tr}" did not round-trip`);
    }
  });

  it('round-trips country', () => {
    const url = buildMapUrl(base, {
      view: 'global',
      zoom: 3,
      center: { lat: 0, lon: 0 },
      timeRange: '24h',
      layers: EMPTY_LAYERS,
      country: 'US',
    });
    const parsed = parseMapUrlState(new URL(url).search, EMPTY_LAYERS);
    assert.equal(parsed.country, 'US');
  });

  it('round-trips expanded', () => {
    const url = buildMapUrl(base, {
      view: 'global',
      zoom: 3,
      center: { lat: 0, lon: 0 },
      timeRange: '24h',
      layers: EMPTY_LAYERS,
      expanded: true,
    });
    const parsed = parseMapUrlState(new URL(url).search, EMPTY_LAYERS);
    assert.equal(parsed.expanded, true);
  });

  it('round-trips layers with multiple enabled', () => {
    const layersOn = { ...EMPTY_LAYERS, conflicts: true, nuclear: true, fires: true, climate: true };
    const url = buildMapUrl(base, {
      view: 'global',
      zoom: 3,
      center: { lat: 0, lon: 0 },
      timeRange: '24h',
      layers: layersOn,
    });
    const parsed = parseMapUrlState(new URL(url).search, EMPTY_LAYERS);
    assert.notEqual(parsed.layers, undefined);
    assert.equal(parsed.layers!.conflicts, true);
    assert.equal(parsed.layers!.nuclear, true);
    assert.equal(parsed.layers!.fires, true);
    assert.equal(parsed.layers!.climate, true);
    assert.equal(parsed.layers!.bases, false);
    assert.equal(parsed.layers!.cables, false);
  });

  it('round-trips layers=none', () => {
    const url = buildMapUrl(base, {
      view: 'global',
      zoom: 3,
      center: { lat: 0, lon: 0 },
      timeRange: '24h',
      layers: EMPTY_LAYERS,
    });
    const parsed = parseMapUrlState(new URL(url).search, EMPTY_LAYERS);
    assert.notEqual(parsed.layers, undefined);
    for (const key of Object.keys(parsed.layers!)) {
      assert.equal(parsed.layers![key as keyof typeof EMPTY_LAYERS], false, `expected ${key} to be false after round-trip`);
    }
  });

  it('round-trips complex state with all params', () => {
    const complexLayers = { ...EMPTY_LAYERS, conflicts: true, bases: true, ais: true, weather: true, flights: true };
    const url = buildMapUrl(base, {
      view: 'asia',
      zoom: 5.5,
      center: { lat: 35.6895, lon: 139.6917 },
      timeRange: '48h',
      layers: complexLayers,
      country: 'JP',
      expanded: true,
    });
    const parsed = parseMapUrlState(new URL(url).search, EMPTY_LAYERS);
    assert.equal(parsed.view, 'asia');
    assert.equal(parsed.zoom, 5.5);
    assert.equal(parsed.lat, 35.6895);
    assert.equal(parsed.lon, 139.6917);
    assert.equal(parsed.timeRange, '48h');
    assert.equal(parsed.country, 'JP');
    assert.equal(parsed.expanded, true);
    assert.equal(parsed.layers!.conflicts, true);
    assert.equal(parsed.layers!.bases, true);
    assert.equal(parsed.layers!.ais, true);
    assert.equal(parsed.layers!.weather, true);
    assert.equal(parsed.layers!.flights, true);
    assert.equal(parsed.layers!.nuclear, false);
  });
});
