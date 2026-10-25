// Runtime proof of the delivery-mode and sensitivity invariants in
// src/services/notifications-settings.ts (#8690, replacing the source-text
// checks in notifications-settings-ui-invariants.test.mjs).
//
// The server forbids (realtime, all) and (realtime, high). The panel keeps the
// user out of that pair: in realtime mode the two options are disabled and a
// switch into realtime snaps the selection to Critical only before the atomic
// save, which goes through setNotificationConfig so the pair is written in
// one request. The panel is gated on the entitlement snapshot (hasTier), so a
// Clerk role alone never unlocks writes the server would answer with 403.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelsData } from '@/services/notification-channels';

import { initTestI18n } from './helpers/i18n.mts';

const gate = vi.hoisted(() => ({ tier: true }));

const channelMocks = vi.hoisted(() => ({
  getChannelsData: vi.fn(),
  saveAlertRules: vi.fn(),
  setNotificationConfig: vi.fn(),
  setDigestSettings: vi.fn(),
}));

const { IncompatibleDeliveryError } = vi.hoisted(() => ({ IncompatibleDeliveryError: class IncompatibleDeliveryError extends Error {} }));

vi.mock('@/services/push-notifications', () => ({
  isWebPushSupported: () => false,
  getPushPermission: () => 'unsupported',
  subscribeToPush: vi.fn(),
  unsubscribeFromPush: vi.fn(),
}));

vi.mock('@/services/notification-channels', () => ({
  getChannelsData: channelMocks.getChannelsData,
  saveAlertRules: channelMocks.saveAlertRules,
  createPairingToken: vi.fn(),
  setEmailChannel: vi.fn(),
  setWebhookChannel: vi.fn(),
  startSlackOAuth: vi.fn(),
  startDiscordOAuth: vi.fn(),
  deleteChannel: vi.fn(),
  setQuietHours: vi.fn(),
  setDigestSettings: channelMocks.setDigestSettings,
  setNotificationConfig: channelMocks.setNotificationConfig,
  IncompatibleDeliveryError,
}));

vi.mock('@/services/clerk', () => ({
  getCurrentClerkUser: () => ({ id: 'user_mode', email: 'mode@worldmonitor.test' }),
}));

vi.mock('@/services/entitlements', () => ({
  hasTier: () => gate.tier,
}));

vi.mock('@/services/market-watchlist', () => ({
  getMarketWatchlistEntries: () => [{ symbol: 'AAPL' }, { symbol: 'MSFT' }],
}));

vi.mock('@/utils/country-chip-picker', () => ({
  loadFollowedCountriesSafe: () => [],
  mountCountryChipPicker: () => ({ getValue: () => [], setValue: () => {}, destroy: () => {} }),
}));

vi.mock('uqr', () => ({ renderSVG: () => '<svg></svg>' }));

import { renderNotificationsSettings } from '@/services/notifications-settings';

const cleanups: Array<() => void> = [];

function rule(over: Partial<ChannelsData['alertRules'][number]> = {}): ChannelsData {
  return {
    channels: [],
    alertRules: [{ variant: 'full', enabled: true, eventTypes: [], sensitivity: 'all', channels: [], digestMode: 'daily', ...over }],
  };
}

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

const q = <T extends HTMLElement>(root: HTMLElement, selector: string): T => {
  const el = root.querySelector<T>(selector);
  expect(el, selector).not.toBeNull();
  return el!;
};

function change(el: HTMLElement): void {
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  document.body.replaceChildren();
  gate.tier = true;
  channelMocks.getChannelsData.mockReset();
  channelMocks.saveAlertRules.mockReset().mockResolvedValue(undefined);
  channelMocks.setNotificationConfig.mockReset().mockResolvedValue(undefined);
  channelMocks.setDigestSettings.mockReset().mockResolvedValue(undefined);
});

afterAll(() => {
  while (cleanups.length) cleanups.pop()?.();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('notification settings delivery mode and sensitivity', () => {
  it('renders sensitivity outside the realtime section and the watchlist toggle inside it', async () => {
    const container = await mount(rule({ digestMode: 'daily', sensitivity: 'all' }));
    const sensitivity = q<HTMLSelectElement>(container, '#usNotifSensitivity');
    const realtime = q(container, '#usRealtimeSection');
    const watchlist = q<HTMLInputElement>(container, '#usWatchlistAlerts');
    expect(realtime.contains(sensitivity)).toBe(false);
    expect(sensitivity.compareDocumentPosition(realtime) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(realtime.contains(watchlist)).toBe(true);
    expect(realtime.style.display).toBe('none');
    expect(sensitivity.value).toBe('all');
    expect(q<HTMLOptionElement>(container, '#usNotifSensitivity option[value="all"]').disabled).toBe(false);
    expect(q<HTMLOptionElement>(container, '#usNotifSensitivity option[value="high"]').disabled).toBe(false);
    expect(q(container, '#usSensitivityHint').style.display).toBe('none');
  });

  it('disables all and high and shows the hint when the stored rule is realtime', async () => {
    const container = await mount(rule({ digestMode: 'realtime', sensitivity: 'high' }));
    expect(q<HTMLOptionElement>(container, '#usNotifSensitivity option[value="all"]').disabled).toBe(true);
    expect(q<HTMLOptionElement>(container, '#usNotifSensitivity option[value="high"]').disabled).toBe(true);
    expect(q<HTMLSelectElement>(container, '#usNotifSensitivity').value).toBe('critical');
    const hint = q(container, '#usSensitivityHint');
    expect(hint.style.display).toBe('');
    expect(hint.textContent).toContain('Real-time delivery is for Critical events only');
    expect(q(container, '#usRealtimeSection').style.display).toBe('');
  });

  it.each(['all', 'high'] as const)('snaps %s to critical when switching into realtime and saves the pair atomically', async (initialSensitivity) => {
    const container = await mount(rule({ digestMode: 'daily', sensitivity: initialSensitivity }));
    vi.useFakeTimers();
    const mode = q<HTMLSelectElement>(container, '#usDigestMode');
    const sensitivity = q<HTMLSelectElement>(container, '#usNotifSensitivity');
    mode.value = 'realtime';
    change(mode);

    expect(sensitivity.value).toBe('critical');
    expect(q<HTMLOptionElement>(container, '#usNotifSensitivity option[value="all"]').disabled).toBe(true);
    expect(q<HTMLOptionElement>(container, '#usNotifSensitivity option[value="high"]').disabled).toBe(true);
    expect(q(container, '#usRealtimeSection').style.display).toBe('');
    const hint = q(container, '#usSensitivityHint');
    expect(hint.style.display).toBe('');
    const previousLabel = initialSensitivity === 'all' ? 'All events' : 'High & critical';
    expect(hint.textContent).toContain(`doesn't support ${previousLabel}`);

    await vi.advanceTimersByTimeAsync(800);
    expect(channelMocks.setNotificationConfig).toHaveBeenCalledTimes(1);
    expect(channelMocks.setNotificationConfig.mock.calls[0]?.[0]).toMatchObject({ digestMode: 'realtime', sensitivity: 'critical' });
    expect(channelMocks.setDigestSettings).not.toHaveBeenCalled();
    expect(channelMocks.saveAlertRules).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('re-enables all and high and hides the hint when switching back to a digest cadence', async () => {
    const container = await mount(rule({ digestMode: 'realtime', sensitivity: 'critical', enabled: true }));
    vi.useFakeTimers();
    const mode = q<HTMLSelectElement>(container, '#usDigestMode');
    mode.value = 'daily';
    change(mode);
    expect(q<HTMLOptionElement>(container, '#usNotifSensitivity option[value="all"]').disabled).toBe(false);
    expect(q<HTMLOptionElement>(container, '#usNotifSensitivity option[value="high"]').disabled).toBe(false);
    expect(q(container, '#usSensitivityHint').style.display).toBe('none');
    expect(q(container, '#usRealtimeSection').style.display).toBe('none');
    await vi.advanceTimersByTimeAsync(800);
    expect(channelMocks.setNotificationConfig.mock.calls[0]?.[0]).toMatchObject({ digestMode: 'daily', sensitivity: 'critical' });
    vi.useRealTimers();
  });

  it('surfaces an IncompatibleDeliveryError from the atomic save in the hint', async () => {
    channelMocks.setNotificationConfig.mockRejectedValue(new IncompatibleDeliveryError('Real-time delivery is for Critical events only.'));
    const container = await mount(rule({ digestMode: 'daily', sensitivity: 'critical' }));
    vi.useFakeTimers();
    const mode = q<HTMLSelectElement>(container, '#usDigestMode');
    mode.value = 'realtime';
    change(mode);
    await vi.advanceTimersByTimeAsync(800);
    expect(q(container, '#usSensitivityHint').textContent).toBe('Real-time delivery is for Critical events only.');
    vi.useRealTimers();
  });

  it('saves the watchlist opt-in as the event type plus the current watchlist tickers', async () => {
    const container = await mount(rule({ digestMode: 'realtime', sensitivity: 'critical' }));
    vi.useFakeTimers();
    const toggle = q<HTMLInputElement>(container, '#usWatchlistAlerts');
    expect(toggle.checked).toBe(false);
    toggle.checked = true;
    change(toggle);
    await vi.advanceTimersByTimeAsync(1000);
    expect(channelMocks.saveAlertRules).toHaveBeenCalledTimes(1);
    expect(channelMocks.saveAlertRules.mock.calls[0]?.[0]).toMatchObject({ eventTypes: ['watchlist_story_alert'], tickers: ['AAPL', 'MSFT'] });

    toggle.checked = false;
    change(toggle);
    await vi.advanceTimersByTimeAsync(1000);
    expect(channelMocks.saveAlertRules.mock.calls[1]?.[0]).toMatchObject({ eventTypes: [], tickers: [] });
    vi.useRealTimers();
  });

  it('reflects a stored watchlist opt-in in the toggle', async () => {
    const container = await mount(rule({ digestMode: 'realtime', sensitivity: 'critical', eventTypes: ['watchlist_story_alert'] }));
    expect(q<HTMLInputElement>(container, '#usWatchlistAlerts').checked).toBe(true);
  });

  it('gates the panel on the entitlement snapshot, not on being signed in', async () => {
    gate.tier = false;
    const container = document.createElement('div');
    const rendered = renderNotificationsSettings({ isSignedIn: true });
    container.innerHTML = rendered.html;
    document.body.appendChild(container);
    cleanups.push(rendered.attach(container));
    expect(container.querySelector('#usNotifSensitivity')).toBeNull();
    expect(container.querySelector('#usNotifContent')).toBeNull();
    expect(container.querySelector('#usNotifUpgradeBtn')).not.toBeNull();
    expect(channelMocks.getChannelsData).not.toHaveBeenCalled();
  });
});
