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
  setTeamsChannel: vi.fn(),
  sendChannelTest: vi.fn(),
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
  setTeamsChannel: channelMocks.setTeamsChannel,
  sendChannelTest: channelMocks.sendChannelTest,
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

const TEAMS_URL = 'https://abc.12.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/x/triggers/manual/paths/invoke?sig=y';
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

const teamsRow = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-channel-type="teams"]')!;

const connected: ChannelsData = {
  channels: [{ channelType: 'teams', verified: true, linkedAt: 1 }],
  alertRules: [{ variant: 'full', enabled: true, eventTypes: [], sensitivity: 'critical', channels: ['teams'] }],
};

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  document.body.replaceChildren();
  channelMocks.getChannelsData.mockReset();
  channelMocks.saveAlertRules.mockReset().mockResolvedValue(undefined);
  channelMocks.setTeamsChannel.mockReset().mockResolvedValue(undefined);
  channelMocks.sendChannelTest.mockReset().mockResolvedValue(undefined);
});

afterAll(() => {
  while (cleanups.length) cleanups.pop()?.();
  document.body.replaceChildren();
});

describe('notification settings Microsoft Teams channel', () => {
  it('lists Teams between Discord and Webhook', async () => {
    const container = await mount({ channels: [], alertRules: [] });
    const order = [...container.querySelectorAll<HTMLElement>('[data-channel-type]')].map(row => row.dataset.channelType);
    expect(order.indexOf('teams')).toBe(order.indexOf('discord') + 1);
    expect(order.indexOf('webhook')).toBe(order.indexOf('teams') + 1);
    expect(teamsRow(container).querySelector('.us-notif-ch-name')?.textContent).toBe('Microsoft Teams');
  });

  it('saves a Workflows URL and adds Teams to the alert rule', async () => {
    const container = await mount({ channels: [], alertRules: [] });
    container.querySelector<HTMLButtonElement>('#usConnectTeams')!.click();
    container.querySelector<HTMLInputElement>('#usTeamsUrl')!.value = TEAMS_URL;
    channelMocks.getChannelsData.mockResolvedValue(connected);
    container.querySelector<HTMLButtonElement>('#usTeamsSave')!.click();

    await vi.waitFor(() => {
      expect(channelMocks.saveAlertRules).toHaveBeenCalled();
    });
    expect(channelMocks.setTeamsChannel).toHaveBeenCalledWith(TEAMS_URL, expect.anything());
    expect(channelMocks.saveAlertRules.mock.calls[channelMocks.saveAlertRules.mock.calls.length - 1]?.[0].channels).toContain('teams');
    await vi.waitFor(() => {
      expect(teamsRow(container).classList.contains('us-notif-ch-on')).toBe(true);
    });
  });

  it('shows the gateway reason when the URL is refused', async () => {
    channelMocks.setTeamsChannel.mockRejectedValue(new Error('Teams webhook URL must be a Microsoft Workflows webhook (environment.api.powerplatform.com or logic.azure.com)'));
    const container = await mount({ channels: [], alertRules: [] });
    container.querySelector<HTMLButtonElement>('#usConnectTeams')!.click();
    container.querySelector<HTMLInputElement>('#usTeamsUrl')!.value = 'https://hooks.example.com/in';
    container.querySelector<HTMLButtonElement>('#usTeamsSave')!.click();

    await vi.waitFor(() => {
      expect(teamsRow(container).querySelector('.us-notif-error')?.textContent).toMatch(/Microsoft Workflows webhook/);
    });
    expect(channelMocks.saveAlertRules).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLButtonElement>('#usTeamsSave')?.disabled).toBe(false);
  });

  it('rejects a non-https URL before calling the server', async () => {
    const container = await mount({ channels: [], alertRules: [] });
    container.querySelector<HTMLButtonElement>('#usConnectTeams')!.click();
    const input = container.querySelector<HTMLInputElement>('#usTeamsUrl')!;
    input.value = 'http://abc.environment.api.powerplatform.com/powerautomate/x';
    container.querySelector<HTMLButtonElement>('#usTeamsSave')!.click();
    expect(input.classList.contains('us-notif-input-error')).toBe(true);
    expect(channelMocks.setTeamsChannel).not.toHaveBeenCalled();
  });

  it('sends a test card from a connected Teams channel', async () => {
    const container = await mount(connected);
    const button = container.querySelector<HTMLButtonElement>('#usTeamsTest')!;
    expect(button.textContent).toBe('Send test');
    button.click();
    await vi.waitFor(() => {
      expect(button.textContent).toBe('Test sent');
    });
    expect(channelMocks.sendChannelTest).toHaveBeenCalledWith('teams', expect.anything());
  });

  it('reports a failed test send and lets the user retry', async () => {
    channelMocks.sendChannelTest.mockRejectedValue(new Error('Could not send a test message. Please try again.'));
    const container = await mount(connected);
    const button = container.querySelector<HTMLButtonElement>('#usTeamsTest')!;
    button.click();
    await vi.waitFor(() => {
      expect(teamsRow(container).querySelector('.us-notif-error')?.textContent).toMatch(/Could not send/);
    });
    expect(button.disabled).toBe(false);
  });
});
