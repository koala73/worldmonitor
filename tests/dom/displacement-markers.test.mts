import assert from 'node:assert/strict';
import { test, beforeAll, expect, vi } from 'vitest';
import { MapContainer } from '@/components/MapContainer';
import { displacementFlowMarkers, displacementEventMarkers, internalDisplacementMarkers, renderDisplacementDetails } from '@/components/displacement-marker';
import { initTestI18n } from './helpers/i18n.mts';

beforeAll(initTestI18n);

test('UNHCR routes require both valid endpoints and a positive count, and keep the top-50 limit', () => {
  const flow = { originCode: 'A', originName: 'Origin', asylumCode: 'B', asylumName: 'Asylum', refugees: 100,
    originLat: 0, originLon: 170, asylumLat: 0, asylumLon: -170 };
  const markers = displacementFlowMarkers([
    { ...flow, asylumLon: undefined }, { ...flow, originLat: NaN }, { ...flow, refugees: -1 },
    ...Array.from({ length: 60 }, () => flow),
  ]);
  assert.equal(markers.length, 50);
  assert.equal(Math.abs(markers[0]!.lon), 180, 'midpoint crosses the dateline, not Greenwich');
  assert.equal(markers[0]!.count, 100);
});

test('IDMC invalid coordinates and figures never consume the SVG marker budget; details escape source text', () => {
  const point = { id: '1', countryCode: 'ESP', countryName: 'Spain', conflict: false, figure: 12,
    displacementDate: '2026-10-01', eventName: '<img src=x onerror=alert(1)>', hazardType: 'Flood', locationName: 'Madrid', lat: 40, lon: -4 };
  const markers = displacementEventMarkers({ countries: [], missingCountries: [], asOf: '', points: [
    point, { ...point, lat: Infinity }, { ...point, lon: 181 }, { ...point, figure: NaN }, { ...point, figure: 0 },
  ] });
  assert.equal(markers.length, 1);
  assert.match(renderDisplacementDetails(markers[0]!), /&lt;img/);
  assert.doesNotMatch(renderDisplacementDetails(markers[0]!), /<img/);
});

test('DTM keeps region and route counts separate and excludes unlocated rows', () => {
  const context = { countryName: 'Sudan', operation: 'Round 1', reportingDate: '2026-10-01', idps: 300 };
  const region = { ...context, pcode: 'SD01', name: 'Khartoum', lat: 15, lon: 32 };
  const route = { ...context, originName: 'Khartoum', destinationName: 'Darfur', originLat: 15, originLon: 32, destinationLat: 12, destinationLon: 24 };
  const markers = internalDisplacementMarkers({ operations: [], regions: [region, { ...region, lon: NaN }], routes: [route, { ...route, destinationLat: 91 }] });
  assert.deepEqual(markers.map(m => [m.kind, m.count]), [['dtm-route', 300], ['dtm-region', 300]]);
  assert.deepEqual(internalDisplacementMarkers({ operations: [], regions: [], routes: [] }), []);
});

for (const renderer of ['svg', 'deck'] as const) {
  test(`MapContainer forwards every displacement feed and empty refresh to ${renderer}`, () => {
    const selected = { setDisplacementFlows: vi.fn(), setInternalDisplacement: vi.fn(), setDisplacementEvents: vi.fn() };
    const other = { setDisplacementFlows: vi.fn(), setInternalDisplacement: vi.fn(), setDisplacementEvents: vi.fn() };
    const map = Object.create(MapContainer.prototype);
    Object.assign(map, { useGlobe: false, useDeckGL: renderer === 'deck',
      svgMap: renderer === 'svg' ? selected : other, deckGLMap: renderer === 'deck' ? selected : other });
    const flow = [{ originCode: 'A', originName: 'Origin', asylumCode: 'B', asylumName: 'Asylum', refugees: 100 }];
    const internal = { operations: [], regions: [], routes: [] };
    const events = { countries: [], points: [], missingCountries: [], asOf: '' };
    map.setDisplacementFlows(flow);
    expect(selected.setDisplacementFlows).toHaveBeenLastCalledWith(flow);
    expect(map.cachedDisplacementFlows).toBe(flow);
    map.setDisplacementFlows([]);
    expect(selected.setDisplacementFlows).toHaveBeenLastCalledWith([]);
    map.setInternalDisplacement(internal);
    expect(selected.setInternalDisplacement).toHaveBeenLastCalledWith(internal);
    expect(map.cachedInternalDisplacement).toBe(internal);
    map.setDisplacementEvents(events);
    expect(selected.setDisplacementEvents).toHaveBeenLastCalledWith(events);
    expect(map.cachedDisplacementEvents).toBe(events);
    for (const setter of Object.values(other)) expect(setter).not.toHaveBeenCalled();
  });
}
