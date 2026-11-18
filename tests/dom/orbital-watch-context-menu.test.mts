import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

const openOrbitalWatch = vi.hoisted(() => vi.fn());
vi.mock('@/app/orbital-watch', () => ({ openOrbitalWatch }));
// Orbital Watch ships dark; these tests cover the entry it adds once the build turns it on.
vi.mock('@/config/orbital-watch-flag', () => ({ ORBITAL_WATCH_ENABLED: true }));

import type { AppContext } from '@/app/app-context';
import { CountryIntelManager } from '@/app/country-intel';
import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import { dismissMapContextMenu } from '@/components/MapContextMenu';
import { installLongPressContextMenu } from '@/utils/long-press';

type ContextMenuPayload = { lat: number; lon: number; screenX: number; screenY: number; countryCode?: string; countryName?: string };

const dashboardMap = { onCountryClicked: () => {}, onMapContextMenu: (cb: (payload: ContextMenuPayload) => void) => { menuHandler = cb; }, addMapControl: () => {} };
let menuHandler!: (payload: ContextMenuPayload) => void;

async function mapWithMenu(): Promise<(payload: ContextMenuPayload) => void> {
  const manager = new CountryIntelManager({ map: dashboardMap, isDestroyed: false } as unknown as AppContext);
  await Reflect.get(manager, 'setupCountryIntel').call(manager);
  return menuHandler;
}

const menuItem = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent === label);

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  dismissMapContextMenu();
  document.body.replaceChildren();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('map context menu satellite pass entry', () => {
  it.each([
    ['a point in a country', { lat: 25.2048, lon: 55.2708, screenX: 10, screenY: 10, countryCode: 'AE', countryName: 'United Arab Emirates' }],
    ['open ocean, where the globe gives no country', { lat: -40.5, lon: -120.25, screenX: 10, screenY: 10 }],
  ])('opens the lookup for the exact point on %s', async (_where, payload) => {
    const map = document.createElement('div');
    map.id = 'mapContainer';
    document.body.append(map);
    const show = await mapWithMenu();
    show(payload);
    const item = menuItem('Satellite passes here');
    expect(item).toBeDefined();
    item!.click();
    await vi.waitFor(() => expect(openOrbitalWatch).toHaveBeenCalledTimes(1));
    expect(openOrbitalWatch).toHaveBeenCalledWith({ lat: payload.lat, lon: payload.lon }, map, dashboardMap);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});

// The brief returns focus to whatever was focused when it opened. A map click
// leaves focus on an earlier control (a layer toggle), so closing the brief
// with Escape sent the user there instead of back to the map.
describe('a country brief opened from the map', () => {
  type CountryClick = { lat: number; lon: number; code?: string; name?: string };
  async function managerWithMap() {
    let clickHandler!: (payload: CountryClick) => void;
    const map = { ...dashboardMap, onCountryClicked: (cb: (payload: CountryClick) => void) => { clickHandler = cb; } };
    const returnFocusTo = vi.fn();
    const manager = new CountryIntelManager({ map, isDestroyed: false, countryBriefPage: { returnFocusTo } } as unknown as AppContext);
    const focusedAtOpen: Array<Element | null> = [];
    Reflect.set(manager, 'openCountryBriefByCode', async () => { focusedAtOpen.push(document.activeElement); });
    await Reflect.get(manager, 'setupCountryIntel').call(manager);
    return { click: clickHandler, menu: menuHandler, focusedAtOpen, returnFocusTo };
  }
  function domWithLayerToggle() {
    const container = document.createElement('div');
    container.id = 'mapContainer';
    const toggle = document.createElement('button');
    toggle.textContent = 'Conflict zones';
    document.body.append(toggle, container);
    toggle.focus();
    return container;
  }

  it('moves focus to the map before a map click opens the brief', async () => {
    const container = domWithLayerToggle();
    const { click, focusedAtOpen, returnFocusTo } = await managerWithMap();
    click({ lat: 61, lon: 99, code: 'RU', name: 'Russia' });
    expect(focusedAtOpen).toEqual([container]);
    // A brief that is already open is told directly, since it reloads in place.
    expect(returnFocusTo).toHaveBeenCalledWith(container);
  });

  it('moves focus to the map before the context menu opens the brief', async () => {
    const container = domWithLayerToggle();
    const { menu, focusedAtOpen, returnFocusTo } = await managerWithMap();
    menu({ lat: 61, lon: 99, screenX: 10, screenY: 10, countryCode: 'RU', countryName: 'Russia' });
    menuItem('Open Country Brief')!.click();
    expect(focusedAtOpen).toEqual([container]);
    expect(returnFocusTo).toHaveBeenCalledWith(container);
  });
});

// The real brief: it captures its return target when it opens, and a map click
// on the visible brief's country reloads it in place rather than reopening it.
describe('closing a country brief with Escape', () => {
  let current: CountryDeepDivePanel | null = null;
  // A failed assertion before Escape must not leave a visible brief whose
  // document keydown listener answers Escape in a later test.
  afterEach(() => {
    if (current?.isVisible()) current.hide();
    current = null;
    document.getElementById('country-deep-dive-panel')?.remove();
  });
  const pressEscape = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  function setup() {
    const search = document.createElement('button');
    search.textContent = 'Search';
    const map = document.createElement('div');
    map.tabIndex = -1;
    document.body.append(search, map);
    current = new CountryDeepDivePanel();
    return { search, map, panel: current };
  }

  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const closeButton = () => document.getElementById('deep-dive-close');

  it('returns focus to the control that opened it', async () => {
    const { map, panel } = setup();
    map.focus();
    panel.show('Russia', 'RU', null, null);
    await nextFrame();
    expect(document.activeElement).toBe(closeButton());
    pressEscape();
    expect(panel.isVisible()).toBe(false);
    expect(document.activeElement).toBe(map);
  });

  it('returns focus to the map after a map click reloads the open brief', async () => {
    const { search, map, panel } = setup();
    search.focus();
    panel.show('Russia', 'RU', null, null);
    await nextFrame();
    expect(document.activeElement).toBe(closeButton());
    // The map click: the map takes focus and claims the visible brief, which
    // moves focus back into the brief before the reload lands.
    map.focus();
    panel.returnFocusTo(map);
    await nextFrame();
    expect(document.activeElement).toBe(closeButton());
    panel.show('Russia', 'RU', null, null);
    pressEscape();
    expect(panel.isVisible()).toBe(false);
    expect(document.activeElement).toBe(map);
  });

  it('keeps focus in the brief when a reload removes the focused control', async () => {
    const { map, panel } = setup();
    map.focus();
    panel.show('Russia', 'RU', null, null);
    await nextFrame();
    const control = document.createElement('button');
    document.getElementById('deep-dive-content')!.append(control);
    control.focus();
    panel.show('Russia', 'RU', null, null);
    expect(control.isConnected).toBe(false);
    expect(document.activeElement).toBe(closeButton());
    pressEscape();
    expect(document.activeElement).toBe(map);
  });

  it('leaves the return target alone on a refresh that does not come from the map', async () => {
    const { search, map, panel } = setup();
    search.focus();
    panel.show('Russia', 'RU', null, null);
    await nextFrame();
    map.focus();
    panel.show('Russia', 'RU', null, null);
    await nextFrame();
    expect(document.activeElement).toBe(map);
    pressEscape();
    expect(document.activeElement).toBe(search);
  });
});

describe('touch long-press', () => {
  const touch = (type: string, x: number, y: number, pointerId = 1) =>
    new PointerEvent(type, { pointerType: 'touch', pointerId, clientX: x, clientY: y, bubbles: true });

  function target() {
    const el = document.createElement('div');
    document.body.append(el);
    const menus: MouseEvent[] = [];
    el.addEventListener('contextmenu', (e) => menus.push(e));
    return { el, menus, dispose: installLongPressContextMenu(el) };
  }

  it('turns a stationary hold into a context menu at the touch point', () => {
    vi.useFakeTimers();
    const { el, menus } = target();
    el.dispatchEvent(touch('pointerdown', 120, 80));
    el.dispatchEvent(touch('pointermove', 123, 82));
    vi.advanceTimersByTime(700);
    expect(menus).toHaveLength(1);
    expect([menus[0]!.clientX, menus[0]!.clientY]).toEqual([120, 80]);
  });

  it('swallows the click from lifting the held finger, and only that one', () => {
    vi.useFakeTimers();
    const { el } = target();
    const clicks: MouseEvent[] = [];
    const onClick = (e: MouseEvent) => clicks.push(e);
    document.addEventListener('click', onClick);
    el.dispatchEvent(touch('pointerdown', 120, 80));
    vi.advanceTimersByTime(700);
    el.dispatchEvent(touch('pointerup', 120, 80));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(clicks).toHaveLength(0);
    el.dispatchEvent(touch('pointerdown', 120, 80));
    el.dispatchEvent(touch('pointerup', 120, 80));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(clicks).toHaveLength(1);
    document.removeEventListener('click', onClick);
  });

  it('leaves drags, quick taps, pinches and mouse presses alone', () => {
    vi.useFakeTimers();
    const { el, menus } = target();
    el.dispatchEvent(touch('pointerdown', 100, 100));
    el.dispatchEvent(touch('pointermove', 140, 100));
    vi.advanceTimersByTime(700);
    el.dispatchEvent(touch('pointerup', 140, 100));
    el.dispatchEvent(touch('pointerdown', 100, 100));
    el.dispatchEvent(touch('pointerup', 100, 100));
    vi.advanceTimersByTime(700);
    el.dispatchEvent(touch('pointerdown', 100, 100, 1));
    el.dispatchEvent(touch('pointerdown', 160, 100, 2));
    vi.advanceTimersByTime(700);
    el.dispatchEvent(touch('pointerup', 100, 100, 1));
    el.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'mouse', clientX: 100, clientY: 100, bubbles: true }));
    vi.advanceTimersByTime(700);
    expect(menus).toHaveLength(0);
  });

  it('stops listening once removed', () => {
    vi.useFakeTimers();
    const { el, menus, dispose } = target();
    dispose();
    el.dispatchEvent(touch('pointerdown', 100, 100));
    vi.advanceTimersByTime(700);
    expect(menus).toHaveLength(0);
  });
});
