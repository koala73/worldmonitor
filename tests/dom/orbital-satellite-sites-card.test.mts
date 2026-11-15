import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { initTestI18n, restoreEnglish, tt, useCatalogue } from './helpers/i18n.mts';

// Orbital Watch ships dark; these tests cover the satellite card it adds once the build turns it on.
vi.mock('@/config/orbital-watch-flag', () => ({ ORBITAL_WATCH_ENABLED: true }));

import { GlobeMap } from '@/components/GlobeMap';
import { coverageNodes } from '@/components/orbital-satellite-sites-view';
import { I18N_RESOURCES_LOADED_EVENT } from '@/services/i18n';
import type { SatelliteCoverage } from '@/services/orbital/satellite-site-coverage';
import type { SatellitePosition } from '@/services/satellites';

const K = 'orbitalWatch.satelliteSites';
const NOW = Date.UTC(2026, 10, 15, 12, 0);
const sensor = { profileId: 'sentinel-2', family: 'Sentinel-2', category: 'civil' as const };
const site = (id: string, name: string) => ({ id, name, lat: 0, lon: 0, countryCode: 'XX' });
const pass = (minutes: number, extra: Partial<{ edgeOfSwath: boolean }> = {}) => ({
  timeMs: NOW + minutes * 60_000, groundDistanceKm: 41.6, edgeOfSwath: false, direction: 'ascending' as const, tier: 'opportunity' as const, ...extra,
});

const text = (nodes: HTMLElement[]) => nodes.map((n) => n.textContent).join(' | ');

beforeAll(async () => {
  await initTestI18n();
});

afterEach(async () => {
  await restoreEnglish();
  document.body.replaceChildren();
});

describe('coverageNodes', () => {
  it('lists covered sites earliest first with time, countdown, distance, swath edge and pass count', () => {
    const coverage: SatelliteCoverage = {
      status: 'ok', sensor, windowStartMs: NOW, windowEndMs: NOW + 86_400_000, orbitAgeDays: 0.4,
      sites: [
        { site: site('a', 'Alpha Base'), passes: [pass(30, { edgeOfSwath: true })] },
        { site: site('b', 'Bravo Port'), passes: [pass(150), pass(900)] },
      ],
    };
    const [heading, list] = coverageNodes(coverage, NOW);
    expect(heading!.textContent).toBe('2 sites inside the Sentinel-2 footprint');
    const rows = [...list!.querySelectorAll<HTMLElement>('li.osat-site')];
    expect(rows.map((r) => r.dataset.siteId)).toEqual(['a', 'b']);
    expect(rows[0]!.querySelector('.osat-site-name')!.textContent).toBe('Alpha Base');
    expect(rows[0]!.querySelector('.osat-site-time')!.textContent).toBe('12:30 UTC');
    expect(rows[0]!.querySelector('.osat-site-detail')!.textContent).toBe('XX · in 30 min · 42 km off track · at swath edge');
    expect(rows[1]!.querySelector('.osat-site-detail')!.textContent).toBe('XX · in 2 h 30 min · 42 km off track · 2 passes');
  });

  it('says one site in the singular and names an empty window', () => {
    const base = { status: 'ok' as const, sensor, windowStartMs: NOW, windowEndMs: NOW + 86_400_000, orbitAgeDays: 0.4 };
    expect(coverageNodes({ ...base, sites: [{ site: site('a', 'Alpha'), passes: [pass(5)] }] }, NOW)[0]!.textContent)
      .toBe('1 site inside the Sentinel-2 footprint');
    expect(text(coverageNodes({ ...base, sites: [] }, NOW))).toBe('No watched site inside its footprint within 24 h.');
  });

  it('gives each non-listing status its own note, amber only for stale orbit elements', () => {
    const cases: Array<[SatelliteCoverage, string, string | undefined]> = [
      [{ status: 'signals' }, tt(`${K}.signals`), undefined],
      [{ status: 'excluded' }, tt(`${K}.noProfile`), undefined],
      [{ status: 'no-profile' }, tt(`${K}.noProfile`), undefined],
      [{ status: 'geostationary', sensor }, tt(`${K}.geostationary`), undefined],
      [{ status: 'bad-elements' }, tt(`${K}.badElements`), undefined],
      [{ status: 'unavailable' }, tt(`${K}.unavailable`), undefined],
      [{ status: 'too-old', orbitAgeDays: 9.7 }, 'Orbit elements are 9 days old, too old to project passes.', 'stale'],
    ];
    for (const [coverage, expected, tone] of cases) {
      const nodes = coverageNodes(coverage, NOW);
      expect(nodes).toHaveLength(1);
      expect(nodes[0]!.textContent, coverage.status).toBe(expected);
      expect(nodes[0]!.textContent, coverage.status).not.toMatch(/orbitalWatch\./);
      expect(nodes[0]!.dataset.tone, coverage.status).toBe(tone);
    }
  });
});

function satellite(overrides: Partial<SatellitePosition> = {}): SatellitePosition {
  return {
    noradId: '40697', name: 'SENTINEL-2A', country: 'EU', type: 'optical', lat: 10, lng: 20, alt: 786, velocity: 7.5, inclination: 98.6, trail: [],
    ...overrides,
  } as SatellitePosition;
}

function fakeGlobe() {
  const container = document.createElement('div');
  document.body.append(container);
  const map = Object.assign(Object.create(GlobeMap.prototype), {
    container,
    tooltipEl: null,
    tooltipHideTimer: null,
    satelliteSitesAbort: null,
    satelliteSitesView: null,
    openSatelliteCard: null,
    satelliteCardI18nListener: null,
    popup: null,
    satelliteMarkers: [],
    rebuildSatBeams: vi.fn(),
    flushMarkers: vi.fn(),
    flushPaths: vi.fn(),
  });
  return map;
}

function openCard(map: ReturnType<typeof fakeGlobe>): HTMLElement {
  const anchor = document.createElement('div');
  map.container.append(anchor);
  map.showMarkerTooltip(map.satelliteMarkers[0], anchor);
  return map.tooltipEl as HTMLElement;
}

const gridValue = (card: HTMLElement, label: string) => {
  const cells = [...card.querySelectorAll<HTMLElement>('[data-osat-card-body] .osat-meta + span')];
  return cells.find((cell) => cell.previousElementSibling!.textContent === label)?.textContent;
};

describe('Orbital Watch satellite card', () => {
  it('follows a data refresh while open instead of keeping the values it opened with', () => {
    const map = fakeGlobe();
    map.setSatellites([satellite()]);
    const card = openCard(map);
    expect(gridValue(card, 'Alt. band')).toBe('LEO · 786 km');

    map.setSatellites([satellite({ alt: 801, velocity: 7.4 })]);
    expect(map.tooltipEl).toBe(card);
    expect(gridValue(card, 'Alt. band')).toBe('LEO · 801 km');
    expect(gridValue(card, 'Velocity')).toBe('7.4 km/s');
    expect(card.querySelector('[data-osat-sites]')).not.toBeNull();
  });

  it('closes when the satellite leaves the layer', () => {
    const map = fakeGlobe();
    map.setSatellites([satellite()]);
    const card = openCard(map);
    map.setSatellites([satellite({ noradId: '99999', name: 'OTHER' })]);
    expect(map.tooltipEl).toBeNull();
    expect(card.isConnected).toBe(false);
  });

  it('redraws its labels and the sites section when the locale arrives after it opened', async () => {
    const map = fakeGlobe();
    map.setSatellites([satellite()]);
    const card = openCard(map);
    const host = card.querySelector<HTMLElement>('[data-osat-sites]')!;
    // No element set is loaded in this test, so the section settles on its "not loaded" note.
    await vi.waitFor(() => expect(host.textContent).toContain(tt(`${K}.notLoaded`)));

    await useCatalogue('fr', { orbitalWatch: { satelliteSites: {
      heading: 'Sites FR · {{hours}} h',
      notLoaded: 'Pas chargé FR',
      card: { velocity: 'Vitesse FR', types: { optical: 'Optique FR' } },
    } } });
    window.dispatchEvent(new CustomEvent(I18N_RESOURCES_LOADED_EVENT, { detail: { language: 'fr' } }));

    expect(gridValue(card, 'Vitesse FR')).toBe('7.5 km/s');
    expect(gridValue(card, 'Type')).toBe('Optique FR');
    expect(host.querySelector('.osat-sites-label')!.textContent).toBe('Sites FR · 24 h');
    expect(host.textContent).toContain('Pas chargé FR');
  });

  it('stops listening for locale changes once closed', () => {
    const map = fakeGlobe();
    map.setSatellites([satellite()]);
    openCard(map);
    const remove = vi.spyOn(window, 'removeEventListener');
    map.hideTooltip();
    expect(remove).toHaveBeenCalledWith(I18N_RESOURCES_LOADED_EVENT, expect.any(Function));
    expect(map.openSatelliteCard).toBeNull();
    remove.mockRestore();
  });
});
