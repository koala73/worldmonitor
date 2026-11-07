// Runtime proof of the free alert ladder UI (#4273) in
// src/services/notifications-settings.ts.
//
// The backend ladder (capability gates + delivery clamp) shipped first; this
// suite pins the panel's side of the contract: a signed-in free account gets
// the panel clamped to the free rungs (critical-only, up to 3 countries,
// web push + email) with every paid rung rendered locked behind an upgrade
// CTA, autosaves never carry out-of-ladder values the server would 402, and
// the panel re-renders in place when the entitlement snapshot flips.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelsData } from '@/services/notification-channels';

import { initTestI18n } from './helpers/i18n.mts';

const gate = vi.hoisted(() => ({
  tier: false,
  listeners: [] as Array<(state: unknown) => void>,
}));

const channelMocks = vi.hoisted(() => ({
  getChannelsData: vi.fn(),
  saveAlertRules: vi.fn(),
  setNotificationConfig: vi.fn(),
  setDigestSettings: vi.fn(),
}));

const upgradeMocks = vi.hoisted(() => ({ openUpgradePlans: vi.fn() }));

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
  setTeamsChannel: vi.fn(),
  sendChannelTest: vi.fn(),
  startSlackOAuth: vi.fn(),
  startDiscordOAuth: vi.fn(),
  deleteChannel: vi.fn(),
  setQuietHours: vi.fn(),
  setDigestSettings: channelMocks.setDigestSettings,
  setNotificationConfig: channelMocks.setNotificationConfig,
  IncompatibleDeliveryError,
}));

vi.mock('@/services/clerk', () => ({
  getCurrentClerkUser: () => ({ id: 'user_ladder', email: 'ladder@worldmonitor.test' }),
}));

vi.mock('@/services/entitlements', () => ({
  hasTier: () => gate.tier,
  getEntitlementState: () => (gate.tier ? { features: { tier: 1 } } : null),
  onEntitlementChange: (cb: (state: unknown) => void) => {
    gate.listeners.push(cb);
    return () => {
      gate.listeners = gate.listeners.filter(l => l !== cb);
    };
  },
}));

vi.mock('@/services/upgrade-flow', () => ({
  openUpgradePlans: upgradeMocks.openUpgradePlans,
}));

vi.mock('@/services/market-watchlist', () => ({
  getMarketWatchlistEntries: () => [{ symbol: 'AAPL' }],
}));

vi.mock('uqr', () => ({ renderSVG: () => '<svg></svg>' }));

// The REAL country-chip-picker mounts here — the cap and scope-warning tests
// exercise its max/maxMessage contract end to end.
import { renderNotificationsSettings } from '@/services/notifications-settings';

const cleanups: Array<() => void> = [];

function data(over: Partial<ChannelsData> = {}): ChannelsData {
  return {
    channels: [],
    alertRules: [{
      variant: 'full', enabled: true, eventTypes: [], sensitivity: 'critical',
      channels: [], digestMode: 'realtime', countries: ['UA'],
    }],
    ...over,
  } as ChannelsData;
}

async function mount(channelsData: ChannelsData): Promise<HTMLElement> {
  channelMocks.getChannelsData.mockResolvedValue(channelsData);
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
  gate.tier = false;
  gate.listeners = [];
  channelMocks.getChannelsData.mockReset();
  channelMocks.saveAlertRules.mockReset().mockResolvedValue(undefined);
  channelMocks.setNotificationConfig.mockReset().mockResolvedValue(undefined);
  channelMocks.setDigestSettings.mockReset().mockResolvedValue(undefined);
  upgradeMocks.openUpgradePlans.mockReset();
});

afterAll(() => {
  while (cleanups.length) cleanups.pop()?.();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('free alert ladder UI (#4273)', () => {
  it('locks the paid channels behind upgrade CTAs and keeps the free ones connectable', async () => {
    const container = await mount(data());
    for (const type of ['slack', 'discord', 'telegram', 'teams', 'webhook']) {
      const row = q(container, `[data-channel-type="${type}"]`);
      expect(row.classList.contains('us-notif-ch-locked'), type).toBe(true);
      expect(row.querySelector('[data-ladder-upgrade]'), type).not.toBeNull();
      expect(row.textContent, type).toContain('Available on Pro');
    }
    // Email keeps its Link button; web push renders its (unsupported, in this
    // harness) row rather than a lock.
    expect(q(container, '[data-channel-type="email"]').querySelector('#usConnectEmail')).not.toBeNull();
    expect(q(container, '[data-channel-type="web_push"]').classList.contains('us-notif-ch-locked')).toBe(false);
    expect(container.querySelector('.us-notif-ladder-banner')).not.toBeNull();
  });

  it('marks digest cadences and non-critical sensitivities as Pro rungs', async () => {
    const container = await mount(data());
    for (const value of ['daily', 'twice_daily', 'weekly']) {
      const opt = q<HTMLOptionElement>(container, `#usDigestMode option[value="${value}"]`);
      expect(opt.disabled, value).toBe(true);
      expect(opt.textContent, value).toContain('(Pro)');
    }
    for (const value of ['all', 'high']) {
      const opt = q<HTMLOptionElement>(container, `#usNotifSensitivity option[value="${value}"]`);
      expect(opt.disabled, value).toBe(true);
      expect(opt.textContent, value).toContain('(Pro)');
    }
    expect(q(container, '#usSensitivityHint').textContent).toContain('Upgrade to Pro');
  });

  it('presents a legacy digest-mode row as realtime instead of unlocking the cadence', async () => {
    const container = await mount(data({
      alertRules: [{
        variant: 'full', enabled: true, eventTypes: [], sensitivity: 'critical',
        channels: [], digestMode: 'daily', countries: ['UA'],
      }],
    } as Partial<ChannelsData>));
    expect(q<HTMLSelectElement>(container, '#usDigestMode').value).toBe('realtime');
    expect(q(container, '#usRealtimeSection').style.display).toBe('');
  });

  it('caps the country picker at the free rung and names the upgrade', async () => {
    const container = await mount(data());
    const chips = Array.from(container.querySelectorAll<HTMLButtonElement>(
      '#usNotifCountryPicker [data-country-chip-row] .us-notif-country-chip:not(.us-notif-country-chip-on)',
    ));
    expect(chips.length).toBeGreaterThan(3);
    // Stored UA + two more fills the free cap of 3; the fourth is refused
    // where the user clicks, with the upgrade named.
    chips[0]!.click();
    container.querySelector<HTMLButtonElement>(
      '#usNotifCountryPicker .us-notif-country-chip:not(.us-notif-country-chip-on)',
    )!.click();
    const fourth = container.querySelector<HTMLButtonElement>(
      '#usNotifCountryPicker .us-notif-country-chip:not(.us-notif-country-chip-on)',
    )!;
    fourth.click();
    expect(container.querySelectorAll('#usNotifCountryPicker .us-notif-country-chip-on')).toHaveLength(3);
    const err = q(container, '#usNotifCountryPicker [data-country-error]');
    expect(err.hidden).toBe(false);
    expect(err.textContent).toContain('upgrade to Pro');
  });

  it('warns that alerts are paused while the free scope is empty', async () => {
    const container = await mount(data({
      alertRules: [{
        variant: 'full', enabled: true, eventTypes: [], sensitivity: 'critical',
        channels: [], digestMode: 'realtime', countries: [],
      }],
    } as Partial<ChannelsData>));
    const warn = q(container, '#usCountryScopeWarn');
    expect(warn.hidden).toBe(false);
    container.querySelector<HTMLButtonElement>(
      '#usNotifCountryPicker .us-notif-country-chip:not(.us-notif-country-chip-on)',
    )!.click();
    expect(warn.hidden).toBe(true);
  });

  it('keeps a legacy paid channel connected but out of the autosave payload', async () => {
    vi.useFakeTimers();
    const container = await mount(data({
      channels: [{ channelType: 'slack', verified: true, slackChannelName: 'alerts' }] as ChannelsData['channels'],
    } as Partial<ChannelsData>));
    const slackRow = q(container, '[data-channel-type="slack"]');
    expect(slackRow.classList.contains('us-notif-ch-on')).toBe(true);
    expect(slackRow.textContent).toContain('Delivery paused on your plan');
    expect(slackRow.querySelector('.us-notif-disconnect')).not.toBeNull();

    const toggle = q<HTMLInputElement>(container, '#usWatchlistAlerts');
    toggle.checked = true;
    change(toggle);
    await vi.advanceTimersByTimeAsync(1000);
    const payload = channelMocks.saveAlertRules.mock.calls.at(-1)?.[0] as { channels: string[] };
    expect(payload.channels).not.toContain('slack');
    vi.useRealTimers();
  });

  it('routes every ladder CTA to the plan picker', async () => {
    const container = await mount(data());
    container.querySelector<HTMLButtonElement>('.us-notif-ladder-banner [data-ladder-upgrade]')!.click();
    await vi.waitFor(() => {
      expect(upgradeMocks.openUpgradePlans).toHaveBeenCalledTimes(1);
    });
    container.querySelector<HTMLButtonElement>('[data-channel-type="slack"] [data-ladder-upgrade]')!.click();
    await vi.waitFor(() => {
      expect(upgradeMocks.openUpgradePlans).toHaveBeenCalledTimes(2);
    });
  });

  it('unlocks in place when the entitlement snapshot flips to paid', async () => {
    const container = await mount(data());
    expect(container.querySelector('.us-notif-ladder-banner')).not.toBeNull();
    gate.tier = true;
    for (const cb of [...gate.listeners]) cb({ features: { tier: 1 } });
    await vi.waitFor(() => {
      expect(container.querySelector('.us-notif-ladder-banner')).toBeNull();
      expect(container.querySelector('#usNotifContent')?.getAttribute('style')).toContain('block');
    });
    // The rebuilt panel is the paid surface: Slack offers Connect, digest
    // cadences are selectable.
    expect(container.querySelector('#usConnectSlack')).not.toBeNull();
    expect(container.querySelector<HTMLOptionElement>('#usDigestMode option[value="daily"]')?.disabled).toBe(false);
  });

  it('keeps the paid surface unchanged for a pro account', async () => {
    gate.tier = true;
    const container = await mount(data());
    expect(container.querySelector('.us-notif-ladder-banner')).toBeNull();
    expect(container.querySelector('.us-notif-ch-locked')).toBeNull();
    expect(container.querySelector('#usConnectSlack')).not.toBeNull();
    expect(container.querySelector('#usCountryScopeWarn')).toBeNull();
    expect(q<HTMLOptionElement>(container, '#usDigestMode option[value="daily"]').disabled).toBe(false);
  });
});
