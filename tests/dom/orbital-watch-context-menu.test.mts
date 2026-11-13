import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

const openOrbitalWatch = vi.hoisted(() => vi.fn());
vi.mock('@/app/orbital-watch', () => ({ openOrbitalWatch }));

import type { AppContext } from '@/app/app-context';
import { CountryIntelManager } from '@/app/country-intel';
import { dismissMapContextMenu } from '@/components/MapContextMenu';
import { installLongPressContextMenu } from '@/utils/long-press';

type ContextMenuPayload = { lat: number; lon: number; screenX: number; screenY: number; countryCode?: string; countryName?: string };

const dashboardMap = { onCountryClicked: () => {}, onMapContextMenu: (cb: (payload: ContextMenuPayload) => void) => { menuHandler = cb; } };
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
