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

const SECRET = 'whsec_dom-test-secret-value';
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

const webhookRow = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-channel-type="webhook"]')!;

const webhookChannel = (webhookSigned: boolean): ChannelsData => ({
  channels: [{ channelType: 'webhook', verified: true, linkedAt: 1, webhookLabel: 'Ops', webhookSigned }],
  alertRules: [],
});

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  document.body.replaceChildren();
  channelMocks.getChannelsData.mockReset();
  channelMocks.saveAlertRules.mockReset().mockResolvedValue(undefined);
  channelMocks.setWebhookChannel.mockReset().mockResolvedValue({ signingSecret: SECRET });
  channelMocks.createPairingToken.mockReset().mockResolvedValue({
    token: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
    expiresAt: Date.now() + 15 * 60_000,
  });
});

afterAll(() => {
  while (cleanups.length) cleanups.pop()?.();
  document.body.replaceChildren();
});

describe('notification settings webhook signing', () => {
  it('marks a webhook with a signing secret as signed', async () => {
    const container = await mount(webhookChannel(true));
    expect(webhookRow(container).querySelector('.us-notif-ch-sub')?.textContent).toBe('Ops · Signed');
  });

  it('tells the owner of a legacy unsigned webhook how to get a secret', async () => {
    const container = await mount(webhookChannel(false));
    const warn = webhookRow(container).querySelector<HTMLElement>('.us-notif-ch-sub-warn');
    expect(warn?.textContent).toBe('Unsigned, re-add to sign');
    expect(warn?.title).toMatch(/add it again/);
  });

  it('shows the new signing secret once after saving, then returns to the list', async () => {
    const container = await mount({ channels: [], alertRules: [] });
    container.querySelector<HTMLButtonElement>('#usConnectWebhook')!.click();
    container.querySelector<HTMLInputElement>('#usWebhookUrl')!.value = 'https://hooks.example.com/in';
    container.querySelector<HTMLButtonElement>('#usWebhookSave')!.click();

    await vi.waitFor(() => {
      expect(container.querySelector('#usWebhookSecret')?.textContent).toBe(SECRET);
    });
    expect(channelMocks.setWebhookChannel).toHaveBeenCalledWith('https://hooks.example.com/in', undefined, expect.anything());
    expect(webhookRow(container).querySelector<HTMLButtonElement>('.us-notif-tg-copy-btn')?.dataset.cmd).toBe(SECRET);

    channelMocks.getChannelsData.mockResolvedValue(webhookChannel(true));
    container.querySelector<HTMLButtonElement>('#usWebhookSecretDone')!.click();
    await vi.waitFor(() => {
      expect(container.querySelector('#usWebhookSecret')).toBeNull();
    });
  });

  it('keeps the webhook in the alert rule when settings change while the secret is shown', async () => {
    const container = await mount({ channels: [], alertRules: [] });
    container.querySelector<HTMLButtonElement>('#usConnectWebhook')!.click();
    container.querySelector<HTMLInputElement>('#usWebhookUrl')!.value = 'https://hooks.example.com/in';
    container.querySelector<HTMLButtonElement>('#usWebhookSave')!.click();
    await vi.waitFor(() => {
      expect(container.querySelector('#usWebhookSecret')).not.toBeNull();
    });
    expect(webhookRow(container).classList.contains('us-notif-ch-on')).toBe(true);

    channelMocks.saveAlertRules.mockClear();
    const sensitivity = container.querySelector<HTMLSelectElement>('#usNotifSensitivity')!;
    sensitivity.value = 'critical';
    sensitivity.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => {
      expect(channelMocks.saveAlertRules).toHaveBeenCalled();
    }, { timeout: 3000 });
    expect(channelMocks.saveAlertRules.mock.lastCall?.[0].channels).toContain('webhook');
  });

  it('ignores a second Save click while the first is in flight', async () => {
    let resolveSave!: (v: { signingSecret: string }) => void;
    channelMocks.setWebhookChannel.mockImplementation(() => new Promise((r) => { resolveSave = r; }));
    const container = await mount({ channels: [], alertRules: [] });
    container.querySelector<HTMLButtonElement>('#usConnectWebhook')!.click();
    container.querySelector<HTMLInputElement>('#usWebhookUrl')!.value = 'https://hooks.example.com/in';
    const save = container.querySelector<HTMLButtonElement>('#usWebhookSave')!;
    save.click();
    expect(save.disabled).toBe(true);
    // dispatchEvent reaches listeners even on a disabled button, so this
    // exercises the handler's own in-flight guard.
    save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(channelMocks.setWebhookChannel).toHaveBeenCalledTimes(1);
    resolveSave({ signingSecret: SECRET });
    await vi.waitFor(() => {
      expect(container.querySelector('#usWebhookSecret')?.textContent).toBe(SECRET);
    });
  });

  it('re-enables Save when the request fails', async () => {
    channelMocks.setWebhookChannel.mockRejectedValue(new Error('boom'));
    const container = await mount({ channels: [], alertRules: [] });
    container.querySelector<HTMLButtonElement>('#usConnectWebhook')!.click();
    container.querySelector<HTMLInputElement>('#usWebhookUrl')!.value = 'https://hooks.example.com/in';
    const save = container.querySelector<HTMLButtonElement>('#usWebhookSave')!;
    save.click();
    await vi.waitFor(() => {
      expect(save.disabled).toBe(false);
      expect(save.textContent).toBe('Save');
    });
  });

  it('escapes the secret before rendering it', async () => {
    channelMocks.setWebhookChannel.mockResolvedValue({ signingSecret: '<img src=x onerror=alert(1)>' });
    const container = await mount({ channels: [], alertRules: [] });
    container.querySelector<HTMLButtonElement>('#usConnectWebhook')!.click();
    container.querySelector<HTMLInputElement>('#usWebhookUrl')!.value = 'https://hooks.example.com/in';
    container.querySelector<HTMLButtonElement>('#usWebhookSave')!.click();
    await vi.waitFor(() => {
      expect(container.querySelector('#usWebhookSecret')).not.toBeNull();
    });
    expect(webhookRow(container).querySelector('img')).toBeNull();
  });

  it('tells Telegram users to confirm in the bot', async () => {
    const container = await mount({ channels: [], alertRules: [] });
    container.querySelector<HTMLButtonElement>('#usConnectTelegram')!.click();
    await vi.waitFor(() => {
      expect(container.querySelector('[data-channel-type="telegram"]')?.textContent).toContain('tap Confirm');
    });
  });
});
