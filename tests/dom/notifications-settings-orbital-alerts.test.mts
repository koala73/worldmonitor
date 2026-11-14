// Watched-site alerts: either toggle opts the rule in, and the site list is
// the user's own, picked from the watched-site registry.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelsData } from '@/services/notification-channels';

import { initTestI18n } from './helpers/i18n.mts';

const pushState = vi.hoisted(() => ({
  supported: true,
  permission: 'default' as 'default' | 'granted' | 'denied' | 'unsupported',
  subscribeToPush: vi.fn<() => Promise<unknown>>(),
}));

const channelMocks = vi.hoisted(() => ({
  setWebhookChannel: vi.fn(),
  createPairingToken: vi.fn(),
  getChannelsData: vi.fn(),
  saveAlertRules: vi.fn(),
  deleteChannel: vi.fn(),
  setEmailChannel: vi.fn(),
}));

vi.mock('@/services/push-notifications', () => ({
  isWebPushSupported: () => pushState.supported,
  getPushPermission: () => pushState.permission,
  subscribeToPush: pushState.subscribeToPush,
  unsubscribeFromPush: vi.fn(),
}));

vi.mock('@/services/notification-channels', () => ({
  getChannelsData: channelMocks.getChannelsData,
  saveAlertRules: channelMocks.saveAlertRules,
  createPairingToken: channelMocks.createPairingToken,
  setEmailChannel: channelMocks.setEmailChannel,
  setWebhookChannel: channelMocks.setWebhookChannel,
  startSlackOAuth: vi.fn(),
  startDiscordOAuth: vi.fn(),
  deleteChannel: channelMocks.deleteChannel,
  setQuietHours: vi.fn(),
  setDigestSettings: vi.fn(),
  setNotificationConfig: vi.fn(),
  IncompatibleDeliveryError: class IncompatibleDeliveryError extends Error {},
}));

vi.mock('@/services/clerk', () => ({
  getCurrentClerkUser: () => ({ id: 'user_push', email: 'push@worldmonitor.test' }),
}));

vi.mock('@/services/entitlements', () => ({
  hasTier: () => true,
}));

vi.mock('@/services/market-watchlist', () => ({
  getMarketWatchlistEntries: () => [],
}));

vi.mock('@/utils/country-chip-picker', () => ({
  loadFollowedCountriesSafe: () => [],
  mountCountryChipPicker: () => ({
    getValue: () => [],
    setValue: () => {},
    destroy: () => {},
  }),
}));

vi.mock('uqr', () => ({
  renderSVG: () => '<svg></svg>',
}));

import { renderNotificationsSettings } from '@/services/notifications-settings';


const cleanups: Array<() => void> = [];

async function mount(data: ChannelsData): Promise<HTMLElement> {
  channelMocks.getChannelsData.mockResolvedValue(data);
  const container = document.createElement('div');
  const rendered = renderNotificationsSettings({ isSignedIn: true });
  container.innerHTML = rendered.html;
  document.body.appendChild(container);
  cleanups.push(rendered.attach(container));
  await vi.waitFor(() => {
    expect(container.querySelector<HTMLElement>('#usNotifContent')?.style.display).toBe('block');
  });
  return container;
}

const rule = (overrides: Record<string, unknown> = {}): ChannelsData => ({
  channels: [],
  alertRules: [{ variant: 'full', enabled: true, eventTypes: [], sensitivity: 'critical', channels: [], ...overrides }],
});

const SUDAN = 'conflict-zone:sudan';

async function lastSave() {
  await vi.waitFor(() => {
    expect(channelMocks.saveAlertRules).toHaveBeenCalled();
  }, { timeout: 3000 });
  return channelMocks.saveAlertRules.mock.lastCall?.[0];
}

const toggle = (container: HTMLElement, id: string, on: boolean) => {
  const el = container.querySelector<HTMLInputElement>(`#${id}`)!;
  el.checked = on;
  el.dispatchEvent(new Event('change', { bubbles: true }));
};

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  document.body.replaceChildren();
  channelMocks.getChannelsData.mockReset();
  channelMocks.saveAlertRules.mockReset().mockResolvedValue(undefined);
});

afterAll(() => {
  while (cleanups.length) cleanups.pop()?.();
  document.body.replaceChildren();
});

describe('notification settings watched-site alerts', () => {
  it('starts off with the site list hidden', async () => {
    const container = await mount(rule());
    expect(container.querySelector<HTMLInputElement>('#usOrbitalWindowAlerts')?.checked).toBe(false);
    expect(container.querySelector<HTMLInputElement>('#usOrbitalChangeAlerts')?.checked).toBe(false);
    expect(container.querySelector<HTMLElement>('#usOrbitalScope')?.hidden).toBe(true);
  });

  it('adds a site picked by name and saves it with the opted-in event type', async () => {
    const container = await mount(rule());
    toggle(container, 'usOrbitalWindowAlerts', true);
    expect(container.querySelector<HTMLElement>('#usOrbitalScope')?.hidden).toBe(false);
    expect(container.querySelector('#usOrbitalCriticalNote')?.textContent).toContain('arrive even when realtime alerts are critical-only');
    await vi.waitFor(() => {
      expect(container.querySelectorAll('#usOrbitalSiteOptions option').length).toBeGreaterThan(100);
    });
    const option = Array.from(container.querySelectorAll<HTMLOptionElement>('#usOrbitalSiteOptions option'))
      .find((el) => el.value === 'Sudan Civil War (SD)')!;
    const search = container.querySelector<HTMLInputElement>('#usOrbitalSiteSearch')!;
    channelMocks.saveAlertRules.mockClear();
    search.value = option.value;
    search.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => {
      expect(container.querySelector(`[data-orbital-site-id="${SUDAN}"]`)).not.toBeNull();
    });
    const saved = await lastSave();
    expect(saved.eventTypes).toEqual(['orbital_imaging_window']);
    expect(saved.orbitalSites).toEqual([SUDAN]);
  });

  it('gives sites that share a name and country distinct options', async () => {
    const container = await mount(rule({ eventTypes: ['orbital_imaging_window'], orbitalSites: [] }));
    await vi.waitFor(() => {
      expect(container.querySelectorAll('#usOrbitalSiteOptions option').length).toBeGreaterThan(100);
    });
    const values = Array.from(container.querySelectorAll<HTMLOptionElement>('#usOrbitalSiteOptions option')).map((el) => el.value);
    expect(new Set(values).size).toBe(values.length);
    const second = values.find((value) => value.endsWith('military-base:naval_support_activity_2'))!;
    const search = container.querySelector<HTMLInputElement>('#usOrbitalSiteSearch')!;
    search.value = second;
    search.dispatchEvent(new Event('change', { bubbles: true }));
    const saved = await lastSave();
    expect(saved.orbitalSites).toEqual(['military-base:naval_support_activity_2']);
  });

  it('restores stored sites with their names and removes one on click', async () => {
    const container = await mount(rule({ eventTypes: ['orbital_site_change'], orbitalSites: [SUDAN, 'chokepoint:suez'] }));
    expect(container.querySelector<HTMLElement>('#usOrbitalScope')?.hidden).toBe(false);
    await vi.waitFor(() => {
      expect(container.querySelector(`[data-orbital-site-id="${SUDAN}"]`)?.textContent).toContain('Sudan');
    });
    container.querySelector<HTMLButtonElement>(`[data-orbital-site-id="${SUDAN}"]`)!.click();
    const saved = await lastSave();
    expect(saved.eventTypes).toEqual(['orbital_site_change']);
    expect(saved.orbitalSites).toEqual(['chokepoint:suez']);
  });

  it('turning both off drops the opt-ins and clears the sites', async () => {
    const container = await mount(rule({ eventTypes: ['orbital_site_change'], orbitalSites: [SUDAN] }));
    toggle(container, 'usOrbitalChangeAlerts', false);
    expect(container.querySelector<HTMLElement>('#usOrbitalScope')?.hidden).toBe(true);
    const saved = await lastSave();
    expect(saved.eventTypes).toEqual([]);
    expect(saved.orbitalSites).toEqual([]);
  });
});
