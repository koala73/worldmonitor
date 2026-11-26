// Water level alerts: the toggle opts the rule in; the reservoirs, the level threshold and the
// seasonal-drop choice are the user's own.
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
  getEntitlementState: () => ({ features: { tier: 1 } }),
  onEntitlementChange: (cb: (state: unknown) => void) => {
    cb({ features: { tier: 1 } });
    return () => {};
  },
  // Settled Pro verification: the panel holds a loading state while this is
  // 'pending' (free alert ladder, #4273), which would blank every assertion
  // in this suite.
  getEntitlementVerificationStatus: () => 'ready',
  onEntitlementVerificationChange: (cb: (status: string) => void) => {
    cb('ready');
    return () => {};
  },
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

vi.mock('@/services/generated-rpc-clients', () => ({
  ClimateServiceClient: class {
    async listReservoirLevels() {
      return {
        dataAvailable: true,
        reservoirs: [
          { id: 'nasser', name: 'Lake Nasser', country: 'EG' },
          { id: 'tana', name: 'Lake Tana', country: 'ET' },
          { id: 'gerd', name: 'GERD reservoir', country: 'ET' },
        ],
      };
    }
  },
}));

vi.mock('@/services/rpc-client', () => ({ getRpcBaseUrl: () => '' }));

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

async function pick(container: HTMLElement, label: string) {
  await vi.waitFor(() => {
    expect(container.querySelectorAll('#usReservoirOptions option').length).toBe(3);
  });
  const search = container.querySelector<HTMLInputElement>('#usReservoirSearch')!;
  channelMocks.saveAlertRules.mockClear();
  search.value = label;
  search.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('notification settings water level alerts', () => {
  it('starts off with the scope hidden and every control labelled', async () => {
    const container = await mount(rule());
    expect(container.querySelector<HTMLInputElement>('#usReservoirAlerts')?.checked).toBe(false);
    expect(container.querySelector<HTMLElement>('#usReservoirScope')?.hidden).toBe(true);
    expect(container.textContent).toContain('Water level alerts');
    expect(container.querySelector('#usReservoirBelowPercent')?.getAttribute('aria-label')).toContain('percent of measured range');
    expect(container.querySelector('#usReservoirSearch')?.getAttribute('aria-label')).toBe('Add a reservoir');
    expect(container.querySelector('#usReservoirAlerts')?.getAttribute('aria-label')).toBe('Water level alerts');
    expect(container.querySelector('#usReservoirSeasonal')?.getAttribute('aria-label')).toBe('Drop beyond the seasonal baseline');
  });

  it('says the level is a dated satellite measurement', async () => {
    const container = await mount(rule());
    expect(container.textContent).toMatch(/two months after it is measured/);
    expect(container.textContent).toMatch(/measurement date/);
  });

  it('says quiet hours still silence or hold the alert', async () => {
    const container = await mount(rule());
    expect(container.querySelector('#usReservoirQuietNote')?.textContent).toBe(
      'These alerts arrive even when real-time alerts are set to critical only. Quiet hours silence them, or hold them until quiet hours end if you choose Batch.',
    );
  });

  it('adds a reservoir picked by name and saves it with the opted-in event type', async () => {
    const container = await mount(rule());
    toggle(container, 'usReservoirAlerts', true);
    expect(container.querySelector<HTMLElement>('#usReservoirScope')?.hidden).toBe(false);
    await pick(container, 'Lake Nasser (EG)');
    await vi.waitFor(() => {
      expect(container.querySelector('[data-reservoir-id="nasser"]')).not.toBeNull();
    });
    const saved = await lastSave();
    expect(saved.eventTypes).toEqual(['reservoir_level_alert']);
    expect(saved.reservoirAlert).toEqual({ reservoirs: ['nasser'], seasonalDrop: false });
  });

  it('saves the level threshold the user types, clamped to the allowed range', async () => {
    const container = await mount(rule({ eventTypes: ['reservoir_level_alert'], reservoirAlert: { reservoirs: ['tana'] } }));
    const input = container.querySelector<HTMLInputElement>('#usReservoirBelowPercent')!;
    input.value = '20';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect((await lastSave()).reservoirAlert).toEqual({ reservoirs: ['tana'], belowPercent: 20, seasonalDrop: false });
    channelMocks.saveAlertRules.mockClear();
    input.value = '90';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect((await lastSave()).reservoirAlert.belowPercent).toBe(50);
    expect(input.value).toBe('50');
    channelMocks.saveAlertRules.mockClear();
    input.value = '';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect('belowPercent' in (await lastSave()).reservoirAlert).toBe(false);
  });

  it('saves the seasonal drop choice', async () => {
    const container = await mount(rule({ eventTypes: ['reservoir_level_alert'], reservoirAlert: { reservoirs: ['tana'] } }));
    toggle(container, 'usReservoirSeasonal', true);
    expect((await lastSave()).reservoirAlert).toEqual({ reservoirs: ['tana'], seasonalDrop: true });
  });

  it('restores stored settings with reservoir names and removes one on click', async () => {
    const container = await mount(rule({ eventTypes: ['reservoir_level_alert'], reservoirAlert: { reservoirs: ['nasser', 'tana'], belowPercent: 15, seasonalDrop: true } }));
    expect(container.querySelector<HTMLElement>('#usReservoirScope')?.hidden).toBe(false);
    expect(container.querySelector<HTMLInputElement>('#usReservoirBelowPercent')?.value).toBe('15');
    expect(container.querySelector<HTMLInputElement>('#usReservoirSeasonal')?.checked).toBe(true);
    await vi.waitFor(() => {
      expect(container.querySelector('[data-reservoir-id="nasser"]')?.textContent).toContain('Lake Nasser');
    });
    container.querySelector<HTMLButtonElement>('[data-reservoir-id="nasser"]')!.click();
    const saved = await lastSave();
    expect(saved.reservoirAlert).toEqual({ reservoirs: ['tana'], belowPercent: 15, seasonalDrop: true });
  });

  it('turning it off drops the opt-in and clears the reservoirs', async () => {
    const container = await mount(rule({ eventTypes: ['reservoir_level_alert'], reservoirAlert: { reservoirs: ['tana'], belowPercent: 10 } }));
    toggle(container, 'usReservoirAlerts', false);
    expect(container.querySelector<HTMLElement>('#usReservoirScope')?.hidden).toBe(true);
    const saved = await lastSave();
    expect(saved.eventTypes).toEqual([]);
    expect(saved.reservoirAlert).toEqual({ reservoirs: [] });
  });
});
