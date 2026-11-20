import assert from 'node:assert/strict';
import { test, beforeAll, expect, vi } from 'vitest';
import { MapContainer } from '@/components/MapContainer';
import { displacementFlowMarkers, displacementEventMarkers, internalDisplacementMarkers, renderDisplacementPopup } from '@/components/displacement-marker';
import { MapPopup } from '@/components/MapPopup';
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
  assert.match(renderDisplacementPopup(markers[0]!), /&lt;img/);
  assert.doesNotMatch(renderDisplacementPopup(markers[0]!), /<img/);
});

const popupElement = (html: string): HTMLElement => {
  const element = document.createElement('div');
  element.innerHTML = html;
  return element;
};
const stats = (element: HTMLElement): Record<string, string> => Object.fromEntries(
  [...element.querySelectorAll('.popup-stats .popup-stat')].map(stat => [
    stat.querySelector('.stat-label')!.textContent!.trim(), stat.querySelector('.stat-value')!.textContent!.trim(),
  ]));

test('an IDMC popup uses the shared popup layout: header badge, location, labelled stats and source', () => {
  const point = { id: '1', countryCode: 'ESP', countryName: 'Spain', conflict: false, figure: 900,
    displacementDate: '2026-10-15', eventName: 'Controlled flood', hazardType: 'Flood', locationName: 'Madrid', lat: 40, lon: -4 };
  const [marker] = displacementEventMarkers({ countries: [], missingCountries: [], asOf: '', points: [point] });
  const popup = Object.create(MapPopup.prototype) as { renderContent: (data: unknown) => string };
  const element = popupElement(popup.renderContent({ type: 'displacement', data: marker }));
  expect(element.innerHTML).not.toContain('<br>');
  expect(element.querySelector('.popup-header.displacement .popup-title')?.textContent).toBe('REFUGEES AND DISPLACEMENT');
  expect(element.querySelector('.popup-header .popup-badge.displacement-disaster')?.textContent?.trim()).toBe('DISASTER');
  expect(element.querySelector('.popup-header .popup-close')).not.toBeNull();
  expect(element.querySelector('.popup-body .popup-location')?.textContent).toBe('Madrid');
  expect(stats(element)).toEqual({ Displaced: '900', Event: 'Controlled flood', Cause: 'Flood', Date: '2026-10-15' });
  expect(element.querySelector('.popup-attribution')?.textContent).toBe('Source: IDMC');

  const [conflict] = displacementEventMarkers({ countries: [], missingCountries: [], asOf: '', points: [{ ...point, conflict: true, eventName: '' }] });
  const conflictElement = popupElement(renderDisplacementPopup(conflict!));
  expect(conflictElement.querySelector('.popup-badge.displacement-conflict')?.textContent?.trim()).toBe('CONFLICT');
  expect(stats(conflictElement)).toEqual({ Displaced: '900', Cause: 'Conflict', Date: '2026-10-15' });
});

test('route and survey popups name the route and label each DTM field', () => {
  const [route, region] = internalDisplacementMarkers({ operations: [],
    regions: [{ countryName: 'Sudan', operation: 'Round 1', reportingDate: '2026-10-01', idps: 300, pcode: 'SD01', name: 'Khartoum', lat: 15, lon: 32 }],
    routes: [{ countryName: 'Sudan', operation: 'Round 1', reportingDate: '2026-10-01', idps: 300, originName: 'Khartoum', destinationName: 'Darfur', originLat: 15, originLon: 32, destinationLat: 12, destinationLon: 24 }] });
  const routeElement = popupElement(renderDisplacementPopup(route!));
  expect(routeElement.querySelector('.popup-location')?.textContent).toBe('Khartoum → Darfur');
  expect(routeElement.querySelector('.popup-badge.displacement-idps')?.textContent?.trim()).toBe('IDPS');
  expect(stats(routeElement)).toEqual({ 'Internally displaced': '300', Country: 'Sudan', Operation: 'Round 1', 'Report date': '2026-10-01' });
  expect(stats(popupElement(renderDisplacementPopup(region!)))).toEqual({ 'Internally displaced': '300', Operation: 'Round 1', 'Report date': '2026-10-01' });
  const [refugees] = displacementFlowMarkers([{ originCode: 'A', originName: 'Syria', asylumCode: 'B', asylumName: 'Türkiye', refugees: 1200,
    originLat: 35, originLon: 38, asylumLat: 39, asylumLon: 35 }]);
  const refugeeElement = popupElement(renderDisplacementPopup(refugees!));
  expect(refugeeElement.querySelector('.popup-badge.displacement-refugees')?.textContent?.trim()).toBe('REFUGEES');
  expect(stats(refugeeElement)).toEqual({ Refugees: '1,200' });
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
