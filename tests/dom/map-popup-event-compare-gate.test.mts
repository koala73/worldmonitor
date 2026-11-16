/**
 * #10713 unit 2: the popup decides who may open before and after, unlocks it in
 * place when access arrives after the popup opened, and the app opens the viewer
 * when a popup hands it a pair.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initTestI18n } from './helpers/i18n.mts';
import type { EventPair } from '@/services/orbital/event-imagery';

const gate = vi.hoisted(() => ({
  premium: false,
  auth: new Set<(state: unknown) => void>(),
  entitlement: new Set<(state: unknown) => void>(),
  openCompare: vi.fn(),
}));

vi.mock('globe.gl', () => ({ default: vi.fn() }));
vi.mock('@/config/orbital-watch-flag', () => ({ ORBITAL_WATCH_ENABLED: true }));
vi.mock('@/services/orbital/archive-image', () => ({ loadArchiveImage: vi.fn(() => new Promise(() => {})) }));
vi.mock('@/services/orbital/object-imagery', () => ({ loadObjectImagery: vi.fn(async () => ({ latest: null, nextPass: null })) }));
vi.mock('@/services/panel-gating', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/panel-gating')>()),
  hasPremiumAccess: () => gate.premium,
}));
vi.mock('@/services/auth-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/auth-state')>()),
  subscribeAuthState: (listener: (state: unknown) => void) => { gate.auth.add(listener); return () => gate.auth.delete(listener); },
}));
vi.mock('@/services/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/entitlements')>()),
  onEntitlementChange: (listener: (state: unknown) => void) => { gate.entitlement.add(listener); return () => gate.entitlement.delete(listener); },
}));
vi.mock('@/app/orbital-watch', () => ({ openOrbitalEventCompare: gate.openCompare, openOrbitalWatch: vi.fn() }));

import { MapPopup } from '@/components/MapPopup';
import { watchOrbitalEvidence } from '@/app/orbital-route';
import { ORBITAL_EVENT_COMPARE_EVENT } from '@/services/orbital/evidence-event';

const NOW = Date.now();
const DAY = 86_400_000;
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const news = { lat: 50.45, lon: 30.52, title: 'Strike on Kyiv', threatLevel: 'high', timestamp: new Date(NOW - DAY) };

beforeAll(async () => {
  await initTestI18n();
});

describe('who may open before and after from a popup', () => {
  let container: HTMLElement;
  let popup: MapPopup;

  beforeEach(() => {
    gate.premium = false;
    container = document.createElement('div');
    document.body.appendChild(container);
    popup = new MapPopup(container);
  });
  afterEach(() => { popup.hide('replacement'); container.remove(); document.body.replaceChildren(); });

  const show = async () => {
    popup.show({ type: 'news', data: news as never, x: 10, y: 10 });
    await flush();
  };
  const compareButton = () => document.querySelector('[data-orbital-event-compare]');
  const lockedLink = () => document.querySelector('[data-orbital-event-compare-locked]');

  it('gives a free user the Pro link and no search button', async () => {
    await show();
    expect(lockedLink()).not.toBeNull();
    expect(compareButton()).toBeNull();
  });

  it('gives a Pro user the button', async () => {
    gate.premium = true;
    await show();
    expect(compareButton()).not.toBeNull();
    expect(lockedLink()).toBeNull();
  });

  it('unlocks in place when sign-in confirms Pro after the popup opened', async () => {
    await show();
    gate.premium = true;
    for (const listener of [...gate.auth]) listener({});
    await flush();
    expect(compareButton()).not.toBeNull();
    expect(lockedLink()).toBeNull();
  });

  it('unlocks in place when the entitlement arrives after the popup opened', async () => {
    await show();
    gate.premium = true;
    for (const listener of [...gate.entitlement]) listener({});
    await flush();
    expect(compareButton()).not.toBeNull();
    expect(lockedLink()).toBeNull();
  });

  it('stops listening once the popup closes', async () => {
    await show();
    popup.hide('replacement');
    expect(gate.auth.size).toBe(0);
    expect(gate.entitlement.size).toBe(0);
  });
});

describe('the app side of a popup compare', () => {
  it('opens the viewer on the pair a popup sends', async () => {
    const stop = watchOrbitalEvidence();
    const pair = { status: 'ok', profileId: 'sentinel-2', windowEndMs: NOW, scenes: [], before: { key: 'b' }, after: { key: 'a' } } as unknown as Extract<EventPair, { status: 'ok' }>;
    const detail = { point: { lat: 50.45, lon: 30.52 }, eventMs: NOW - DAY, pair };
    window.dispatchEvent(new CustomEvent(ORBITAL_EVENT_COMPARE_EVENT, { detail }));
    await vi.dynamicImportSettled();
    expect(gate.openCompare).toHaveBeenCalledWith(detail);
    stop();
    gate.openCompare.mockClear();
    window.dispatchEvent(new CustomEvent(ORBITAL_EVENT_COMPARE_EVENT, { detail }));
    await vi.dynamicImportSettled();
    expect(gate.openCompare).not.toHaveBeenCalled();
  });
});
