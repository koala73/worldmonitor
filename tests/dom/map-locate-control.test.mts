import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import i18next from 'i18next';

import { initTestI18n } from './helpers/i18n.mts';

const flag = vi.hoisted(() => ({ ORBITAL_WATCH_ENABLED: false }));
vi.mock('@/config/orbital-watch-flag', () => flag);
const requestDevicePosition = vi.hoisted(() => vi.fn());
vi.mock('@/utils/user-location', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/utils/user-location')>(),
  requestDevicePosition,
}));
const geometry = vi.hoisted(() => ({ getCountryNearCoordinates: vi.fn(), preloadCountryGeometry: vi.fn(async () => {}) }));
vi.mock('@/services/country-geometry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/country-geometry')>(),
  ...geometry,
}));
const openOrbitalWatch = vi.hoisted(() => vi.fn());
vi.mock('@/app/orbital-watch', () => ({ openOrbitalWatch }));

import type { AppContext } from '@/app/app-context';
import { CountryIntelManager } from '@/app/country-intel';
import { isMapUrlCentreClaimed, releaseMapUrlCentreOnUserMove } from '@/app/orbital-map-focus';
import { MapContainer } from '@/components/MapContainer';
import { dismissMapContextMenu, type MapContextMenuItem } from '@/components/MapContextMenu';
import { MapLocateControl, type LocatedPoint } from '@/components/MapLocateControl';

const EXACT = { ok: true, lat: 25.204849, lon: 55.270783 } as const;
const ROUNDED = { lat: 25.2, lon: 55.27 };

const menuLabels = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((el) => el.textContent);
const status = (control: MapLocateControl) => control.element.querySelector<HTMLElement>('[role="status"]')!;

function mountControl(actions: (point: LocatedPoint) => MapContextMenuItem[] = () => [{ label: 'Open Country Brief', action: () => {} }]) {
  const centre = vi.fn();
  const actionsFor = vi.fn(actions);
  const control = new MapLocateControl({ centre, actions: actionsFor });
  document.body.append(control.element);
  return { control, centre, actions: actionsFor };
}

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  dismissMapContextMenu();
  document.body.replaceChildren();
  flag.ORBITAL_WATCH_ENABLED = false;
  releaseMapUrlCentreOnUserMove(null);
  vi.clearAllMocks();
});

describe('map locate control', () => {
  it('asks for location only when pressed', async () => {
    requestDevicePosition.mockResolvedValue(EXACT);
    const { control } = mountControl();
    expect(requestDevicePosition).not.toHaveBeenCalled();
    expect(control.state).toBe('idle');
    expect(status(control).hidden).toBe(true);

    control.element.querySelector('button')!.click();
    await vi.waitFor(() => expect(control.state).toBe('located'));
    expect(requestDevicePosition).toHaveBeenCalledTimes(1);
  });

  it('shows the locating state and blocks a second press while the fix is pending', async () => {
    let resolve!: (value: typeof EXACT) => void;
    requestDevicePosition.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { control } = mountControl();
    const button = control.element.querySelector('button')!;
    button.click();
    expect(control.state).toBe('locating');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(status(control).textContent).toBe('Locating…');
    resolve(EXACT);
    await vi.waitFor(() => expect(control.state).toBe('located'));
    expect(button.disabled).toBe(false);
  });

  it('centres on the point cut to the 0.01° share grid and opens the menu there', async () => {
    requestDevicePosition.mockResolvedValue(EXACT);
    const { control, centre, actions } = mountControl();
    await control.locate();
    expect(centre).toHaveBeenCalledExactlyOnceWith(ROUNDED);
    expect(actions).toHaveBeenCalledExactlyOnceWith(ROUNDED);
    expect(menuLabels()).toEqual(['Open Country Brief']);
    expect(status(control).hidden).toBe(true);
  });

  it.each([
    ['denied', 'Location access denied. Use Search to find a place.'],
    ['unavailable', 'Location not found. Use Search to find a place.'],
  ] as const)('leaves the map where it is when location is %s', async (reason, line) => {
    requestDevicePosition.mockResolvedValue({ ok: false, reason });
    const { control, centre, actions } = mountControl();
    await control.locate();
    expect(control.state).toBe(reason);
    expect(centre).not.toHaveBeenCalled();
    expect(actions).not.toHaveBeenCalled();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(status(control).hidden).toBe(false);
    expect(status(control).textContent).toBe(line);
  });

  it('reads the recovery line before the lazy dictionary has loaded', async () => {
    const components = i18next.store.data.en!.translation as { components: Record<string, unknown> };
    const lazy = components.components.mapLocate;
    delete components.components.mapLocate;
    try {
      requestDevicePosition.mockResolvedValue({ ok: false, reason: 'denied' });
      const { control } = mountControl();
      await control.locate();
      expect(status(control).textContent).toBe('Location access denied. Use Search to find a place.');
    } finally {
      components.components.mapLocate = lazy;
    }
  });

  it('points to Search when nothing applies at the located point', async () => {
    requestDevicePosition.mockResolvedValue(EXACT);
    const { control, centre } = mountControl(() => []);
    await control.locate();
    expect(centre).not.toHaveBeenCalled();
    expect(control.state).toBe('empty');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(status(control).textContent).toBe('No country at your location. Use Search to find a place.');
  });

  it('ignores a fix that arrives after the control is destroyed', async () => {
    let resolve!: (value: typeof EXACT) => void;
    requestDevicePosition.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { control, centre } = mountControl();
    const pending = control.locate();
    control.destroy();
    resolve(EXACT);
    await pending;
    expect(centre).not.toHaveBeenCalled();
    expect(control.element.isConnected).toBe(false);
  });
});

describe('locate menu entries', () => {
  async function setUp() {
    let control!: HTMLElement;
    let viewportAction = 0;
    const map = {
      onCountryClicked: () => {},
      onMapContextMenu: () => {},
      setCenter: vi.fn(() => ++viewportAction),
      isViewportActionCurrent: (token: number) => token === viewportAction,
      addMapControl: (el: HTMLElement) => { control = el; document.body.append(el); },
    };
    const manager = new CountryIntelManager({ map, isDestroyed: false } as unknown as AppContext);
    await Reflect.get(manager, 'setupCountryIntel').call(manager);
    const openBrief = vi.spyOn(manager, 'openCountryBriefByCode').mockResolvedValue(undefined);
    requestDevicePosition.mockResolvedValue(EXACT);
    control.querySelector('button')!.click();
    await vi.waitFor(() => expect(control.dataset.state).not.toBe('locating'));
    return { control, openBrief, map, manager };
  }
  const menuItem = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent === label);

  it('centres the dashboard map on the rounded point', async () => {
    geometry.getCountryNearCoordinates.mockReturnValue({ code: 'AE', name: 'United Arab Emirates' });
    const { map } = await setUp();
    expect(map.setCenter).toHaveBeenCalledExactlyOnceWith(ROUNDED.lat, ROUNDED.lon, expect.any(Number));
  });

  it('keeps the located point out of the page URL until the user moves the map', async () => {
    geometry.getCountryNearCoordinates.mockReturnValue({ code: 'AE', name: 'United Arab Emirates' });
    const mapEl = document.createElement('div');
    mapEl.id = 'mapContainer';
    document.body.append(mapEl);
    await setUp();
    // The URL sync writes the map centre into the address bar, which analytics and
    // shared links read; the user's own position must not land there.
    expect(isMapUrlCentreClaimed()).toBe(true);
    mapEl.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(isMapUrlCentreClaimed()).toBe(false);
  });

  it('hands the URL centre back when Search or a panel link moves the map after locating', async () => {
    geometry.getCountryNearCoordinates.mockReturnValue({ code: 'AE', name: 'United Arab Emirates' });
    const mapEl = document.createElement('div');
    mapEl.id = 'mapContainer';
    document.body.append(mapEl);
    const { map } = await setUp();
    expect(isMapUrlCentreClaimed()).toBe(true);
    map.setCenter(48.86, 2.35, 6);
    expect(isMapUrlCentreClaimed()).toBe(false);
  });

  it('reports a failed outline load as unavailable, not as no country', async () => {
    geometry.preloadCountryGeometry.mockRejectedValueOnce(new Error('network'));
    geometry.getCountryNearCoordinates.mockReturnValue(null);
    const { control, map } = await setUp();
    expect(control.dataset.state).toBe('unavailable');
    expect(map.setCenter).not.toHaveBeenCalled();
    expect(isMapUrlCentreClaimed()).toBe(false);
  });

  it('offers only Country Brief while Orbital Watch is off', async () => {
    geometry.getCountryNearCoordinates.mockReturnValue({ code: 'AE', name: 'United Arab Emirates' });
    const { openBrief } = await setUp();
    expect(menuLabels()).toEqual(['Open Country Brief']);
    expect(geometry.getCountryNearCoordinates).toHaveBeenCalledWith(ROUNDED.lat, ROUNDED.lon, 0.05);
    menuItem('Open Country Brief')!.click();
    expect(openBrief).toHaveBeenCalledWith('AE', 'United Arab Emirates');
  });

  it('adds imagery evidence for the rounded point when Orbital Watch is on', async () => {
    flag.ORBITAL_WATCH_ENABLED = true;
    geometry.getCountryNearCoordinates.mockReturnValue({ code: 'AE', name: 'United Arab Emirates' });
    const mapEl = document.createElement('div');
    mapEl.id = 'mapContainer';
    document.body.append(mapEl);
    const { map } = await setUp();
    expect(menuLabels()).toEqual(['Open Country Brief', 'Imagery evidence here']);
    menuItem('Imagery evidence here')!.click();
    await vi.waitFor(() => expect(openOrbitalWatch).toHaveBeenCalledExactlyOnceWith(ROUNDED, mapEl, map));
  });

  it('points to Search outside any country while Orbital Watch is off', async () => {
    geometry.getCountryNearCoordinates.mockReturnValue(null);
    const { control, map } = await setUp();
    expect(control.dataset.state).toBe('empty');
    expect(map.setCenter).not.toHaveBeenCalled();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('removes the control when the manager is destroyed', async () => {
    geometry.getCountryNearCoordinates.mockReturnValue(null);
    const { control, manager } = await setUp();
    manager.destroy();
    expect(control.isConnected).toBe(false);
  });
});

describe('locate control placement', () => {
  function container(renderer: 'svg' | 'deck' | 'globe', chrome = true) {
    const mounts = { svgMap: { mountMapControl: vi.fn() }, deckGLMap: { mountMapControl: vi.fn() }, globeMap: { mountMapControl: vi.fn() } };
    const map = Object.assign(Object.create(MapContainer.prototype), {
      chrome,
      useDeckGL: renderer === 'deck',
      useGlobe: renderer === 'globe',
      mapControl: null,
      ...mounts,
    }) as MapContainer;
    return { map, mounts };
  }

  it.each([
    ['svg', 'svgMap'],
    ['deck', 'deckGLMap'],
    ['globe', 'globeMap'],
  ] as const)('puts the control on the %s renderer only', (renderer, key) => {
    const { map, mounts } = container(renderer);
    const el = document.createElement('div');
    map.addMapControl(el);
    for (const [name, target] of Object.entries(mounts)) {
      if (name === key) expect(target.mountMapControl).toHaveBeenCalledExactlyOnceWith(el);
      else expect(target.mountMapControl).not.toHaveBeenCalled();
    }
  });

  it('moves the same control to the new renderer after a switch', () => {
    const { map, mounts } = container('deck');
    const el = document.createElement('div');
    map.addMapControl(el);
    Object.assign(map, { useDeckGL: false, useGlobe: true });
    Reflect.get(map, 'mountMapControl').call(map);
    expect(mounts.globeMap.mountMapControl).toHaveBeenCalledExactlyOnceWith(el);
  });

  it('leaves chromeless maps without the control', () => {
    const { map, mounts } = container('deck', false);
    map.addMapControl(document.createElement('div'));
    expect(mounts.deckGLMap.mountMapControl).not.toHaveBeenCalled();
  });
});
