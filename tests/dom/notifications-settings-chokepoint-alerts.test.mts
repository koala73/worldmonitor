// #9217 item 6: the chokepoint disruption toggle opts the rule in, and the
// chips narrow it to chosen chokepoints.
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

const chip = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLButtonElement>(`#usChokepointScope [data-chokepoint-id="${id}"]`)!;

async function lastSave() {
  await vi.waitFor(() => {
    expect(channelMocks.saveAlertRules).toHaveBeenCalled();
  }, { timeout: 3000 });
  return channelMocks.saveAlertRules.mock.lastCall?.[0];
}

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

describe('notification settings chokepoint disruption alerts', () => {
  it('starts off with the chokepoint list hidden', async () => {
    const container = await mount(rule());
    expect(container.querySelector<HTMLInputElement>('#usChokepointAlerts')?.checked).toBe(false);
    expect(container.querySelector<HTMLElement>('#usChokepointScope')?.hidden).toBe(true);
    expect(container.querySelectorAll('#usChokepointScope [data-chokepoint-id]')).toHaveLength(13);
  });

  it('turning it on saves the opt-in with every chokepoint', async () => {
    const container = await mount(rule());
    const toggle = container.querySelector<HTMLInputElement>('#usChokepointAlerts')!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    expect(container.querySelector<HTMLElement>('#usChokepointScope')?.hidden).toBe(false);
    const saved = await lastSave();
    expect(saved.eventTypes).toEqual(['chokepoint_disruption']);
    expect(saved.chokepoints).toEqual([]);
  });

  it('restores the stored scope and saves a chip change', async () => {
    const container = await mount(rule({ eventTypes: ['watchlist_story_alert', 'chokepoint_disruption'], chokepoints: ['hormuz_strait'] }));
    expect(chip(container, 'hormuz_strait').getAttribute('aria-pressed')).toBe('true');
    expect(chip(container, 'suez').getAttribute('aria-pressed')).toBe('false');
    chip(container, 'suez').click();
    const saved = await lastSave();
    expect(saved.eventTypes).toEqual(['watchlist_story_alert', 'chokepoint_disruption']);
    expect(saved.chokepoints).toEqual(['suez', 'hormuz_strait']);
  });

  it('turning it off drops the opt-in and clears the scope', async () => {
    const container = await mount(rule({ eventTypes: ['chokepoint_disruption'], chokepoints: ['panama'] }));
    const toggle = container.querySelector<HTMLInputElement>('#usChokepointAlerts')!;
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    const saved = await lastSave();
    expect(saved.eventTypes).toEqual([]);
    expect(saved.chokepoints).toEqual([]);
  });
});
