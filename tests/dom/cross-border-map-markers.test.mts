import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { GlobeMap } from '@/components/GlobeMap';
import { MapContainer } from '@/components/MapContainer';
import { MapPopup } from '@/components/MapPopup';
import { createCrossBorderMarker, crossBorderMarkerOffsets, renderCrossBorderDetails } from '@/components/cross-border-marker';
import type { CrossBorderData, CrossBorderPoint } from '@/services/displacement';
import { initTestI18n } from './helpers/i18n.mts';

beforeAll(initTestI18n);

const arrival: CrossBorderPoint = {
  situation: 'test-route', label: 'Controlled arrivals', kind: 'arrival', country: 'ES',
  individuals: 2500, date: '2026-10-19', change: null, changeSince: '', lastMonth: null,
  accelerating: true, lat: 40, lon: -4, source: 'Controlled publisher', sourceUrl: 'https://example.com/report',
  measure: 'daily', last30Days: 2500, changePct: 100,
};
const death: CrossBorderPoint = { ...arrival, kind: 'death', label: 'Controlled deaths', individuals: 17, accelerating: false, last30Days: undefined };
const data: CrossBorderData = { situations: [], points: [arrival], deaths: [death] };

afterEach(() => { document.body.replaceChildren(); });

describe('cross-border map markers', () => {
  it('separates coincident hit areas while leaving other report positions unchanged', () => {
    const third = { ...arrival, label: 'Another coincident report' };
    const separate = { ...arrival, lat: 35 };
    const points = [arrival, death, third];
    const offsets = crossBorderMarkerOffsets([...points, separate]);
    expect(offsets.get(separate)).toEqual([0, 0]);
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const a = offsets.get(points[i]!)!;
        const b = offsets.get(points[j]!)!;
        expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeGreaterThanOrEqual(51.99);
      }
    }
  });

  it('gives arrivals and deaths distinct accessible markers with count-dependent size', () => {
    const arrivals = createCrossBorderMarker(arrival);
    const deaths = createCrossBorderMarker(death);
    expect(arrivals.type).toBe('button');
    expect(arrivals.getAttribute('aria-label')).toContain('2,500');
    expect(arrivals.getAttribute('aria-label')).toContain('2026-10-19');
    expect(deaths.classList.contains('cross-border-death')).toBe(true);
    expect(deaths.textContent).toBe('×');
    const arrivalDot = arrivals.querySelector<HTMLElement>('.cross-border-dot')!;
    const deathDot = deaths.querySelector<HTMLElement>('.cross-border-dot')!;
    expect(deathDot.style.background).not.toBe(arrivalDot.style.background);
    expect(parseFloat(arrivalDot.style.width)).toBeGreaterThan(parseFloat(deathDot.style.width));
    expect(arrivalDot.style.borderWidth).toBe('3px');
    expect(deathDot.style.borderWidth).toBe('1px');
    expect(parseFloat(deaths.style.width)).toBeGreaterThanOrEqual(24);
    expect(parseFloat(deathDot.style.width)).toBe(10);
  });

  it('keeps external labels as text and drops unsafe source links', () => {
    const point = { ...arrival, label: '<img src=x onerror=alert(1)>', source: '<script>bad()</script>', sourceUrl: 'javascript:alert(1)' };
    const element = document.createElement('div');
    element.innerHTML = renderCrossBorderDetails(point);
    expect(element.querySelector('img, script, a')).toBeNull();
    expect(element.textContent).toContain(point.label);
    expect(element.textContent).toContain(point.source);
    expect(element.textContent).toContain('30d · +100%');
  });

  it('opens the shared popup with the source, observation date and measure', () => {
    const popup = Object.create(MapPopup.prototype) as { renderContent: (data: unknown) => string };
    const element = document.createElement('div');
    element.innerHTML = popup.renderContent({ type: 'crossBorder', data: arrival });
    expect(element.textContent).toContain('Controlled publisher');
    expect(element.textContent).toContain('2026-10-19');
    expect(element.textContent).toContain('daily');
    expect(element.querySelector('a')?.href).toBe('https://example.com/report');
    expect(element.querySelector('.popup-close')).not.toBeNull();
  });

  it('keeps an explicit zero and its observation period visible', () => {
    const element = document.createElement('div');
    element.innerHTML = renderCrossBorderDetails({ ...arrival, individuals: 0, last30Days: 0, changePct: 0, accelerating: false });
    expect(element.textContent).toContain('0 · arrival · daily');
    expect(element.textContent).toContain('30d · 0%');
    expect(element.textContent).not.toContain('Accelerating');
  });

  it.each([1250, -1250, 0])('shows a stock change of %s with its starting date', (change) => {
    const element = document.createElement('div');
    element.innerHTML = renderCrossBorderDetails({ ...arrival, kind: 'outflow', measure: 'population-stock',
      last30Days: undefined, changePct: undefined, change, changeSince: '2026-09-01' });
    expect(element.textContent).toContain(`${change > 0 ? '+' : ''}${change.toLocaleString()} since 2026-09-01`);
  });

  it('escapes the stock change date and omits an absent change', () => {
    const point = { ...arrival, change: 100, changeSince: '<img src=x onerror=alert(1)>' };
    const element = document.createElement('div');
    element.innerHTML = renderCrossBorderDetails(point);
    expect(element.querySelector('img')).toBeNull();
    expect(element.textContent).toContain(`+100 since ${point.changeSince}`);
    element.innerHTML = renderCrossBorderDetails({ ...point, change: null });
    expect(element.textContent).not.toContain('since');
  });

  for (const renderer of ['svg', 'globe', 'deck'] as const) {
    it(`forwards current data and empty updates to ${renderer} while retaining renderer-switch data`, () => {
      const setCrossBorderArrivals = vi.fn();
      const map = Object.create(MapContainer.prototype);
      Object.assign(map, { useGlobe: renderer === 'globe', useDeckGL: renderer === 'deck',
        svgMap: { setCrossBorderArrivals }, globeMap: { setCrossBorderArrivals }, deckGLMap: { setCrossBorderArrivals } });
      map.setCrossBorderArrivals(data);
      expect(setCrossBorderArrivals).toHaveBeenLastCalledWith(data);
      expect(map.cachedCrossBorderArrivals).toBe(data);
      const empty = { situations: [], points: [], deaths: [] };
      map.setCrossBorderArrivals(empty);
      expect(setCrossBorderArrivals).toHaveBeenLastCalledWith(empty);
      expect(map.cachedCrossBorderArrivals).toBe(empty);
    });
  }

  it('replaces globe markers on recovery and clears them on an empty update', () => {
    const globe = Object.create(GlobeMap.prototype);
    globe.flushMarkers = vi.fn();
    globe.handleMarkerClick = vi.fn();
    globe.setCrossBorderArrivals(data);
    expect(globe.crossBorderMarkers).toMatchObject([
      { _kind: 'crossBorder', _lat: 40, _lng: -4, point: arrival },
      { _kind: 'crossBorder', _lat: 40, _lng: -4, point: death },
    ]);
    const elements: HTMLElement[] = globe.crossBorderMarkers.map((marker: unknown) => globe.buildMarkerElement(marker));
    expect(elements[0]!.style.translate).not.toBe(elements[1]!.style.translate);
    elements.forEach(element => element.querySelector('button')!.click());
    expect(globe.handleMarkerClick).toHaveBeenNthCalledWith(1, globe.crossBorderMarkers[0], elements[0]);
    expect(globe.handleMarkerClick).toHaveBeenNthCalledWith(2, globe.crossBorderMarkers[1], elements[1]);
    globe.setCrossBorderArrivals({ ...data, points: [], deaths: [] });
    expect(globe.crossBorderMarkers).toEqual([]);
    expect(globe.flushMarkers).toHaveBeenCalledTimes(2);
  });
});
