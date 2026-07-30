import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelsData } from '@/services/notification-channels';

import { initTestI18n, tt } from './helpers/i18n.mts';

const pushState = vi.hoisted(() => ({
  supported: true,
  permission: 'default' as 'default' | 'granted' | 'denied' | 'unsupported',
  subscribeToPush: vi.fn<() => Promise<unknown>>(),
}));

const channelMocks = vi.hoisted(() => ({
  getChannelsData: vi.fn(),
  saveAlertRules: vi.fn(),
  deleteChannel: vi.fn(),
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
  createPairingToken: vi.fn(),
  setEmailChannel: vi.fn(),
  setWebhookChannel: vi.fn(),
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

const EMPTY_DATA: ChannelsData = { channels: [], alertRules: [] };
const CONNECTED_WEB_PUSH: ChannelsData = {
  channels: [
    {
      channelType: 'web_push',
      verified: true,
      linkedAt: 1,
      userAgent: 'Chrome/140.0',
    },
  ],
  alertRules: [],
};
const cleanups: Array<() => void> = [];

async function mount(data: ChannelsData = EMPTY_DATA): Promise<HTMLElement> {
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

function webPushRow(container: HTMLElement): HTMLElement {
  const row = container.querySelector<HTMLElement>('[data-channel-type="web_push"]');
  expect(row).not.toBeNull();
  return row!;
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  document.body.replaceChildren();
  pushState.supported = true;
  pushState.permission = 'default';
  pushState.subscribeToPush.mockReset();
  pushState.subscribeToPush.mockResolvedValue({
    endpoint: 'https://push.test/subscription',
    p256dh: 'key',
    auth: 'auth',
    userAgent: 'test',
  });
  channelMocks.getChannelsData.mockReset();
  channelMocks.saveAlertRules.mockReset();
  channelMocks.saveAlertRules.mockResolvedValue(undefined);
  channelMocks.deleteChannel.mockReset();
  channelMocks.deleteChannel.mockResolvedValue(undefined);
});

afterAll(() => {
  while (cleanups.length) cleanups.pop()?.();
  document.body.replaceChildren();
});

describe('notification Settings browser push', () => {
  it('renders denied permission as browser site-settings guidance without Enable', async () => {
    pushState.permission = 'denied';
    const container = await mount();
    const row = webPushRow(container);

    expect(row.dataset.webPushState).toBe('denied');
    expect(row.querySelector('.us-notif-ch-sub')?.textContent).toBe(
      tt('components.proActivation.steps.alerts.blockedNote'),
    );
    expect(row.querySelector('#usConnectWebPush')).toBeNull();
    expect(row.querySelector('.us-notif-ch-badge')?.textContent).toBe('Blocked');

    expect(container.querySelector('#usConnectTelegram')).not.toBeNull();
    expect(container.querySelector('#usConnectEmail')).not.toBeNull();
    expect(container.querySelector('#usConnectSlack')).not.toBeNull();
    expect(container.querySelector('#usConnectDiscord')).not.toBeNull();
    expect(container.querySelector('#usConnectWebhook')).not.toBeNull();
  });

  it('re-checks live permission before subscribing', async () => {
    const container = await mount();
    const button = container.querySelector<HTMLButtonElement>('#usConnectWebPush');
    expect(button).not.toBeNull();

    pushState.permission = 'denied';
    button!.click();

    await vi.waitFor(() => {
      expect(webPushRow(container).dataset.webPushState).toBe('denied');
    });
    expect(pushState.subscribeToPush).not.toHaveBeenCalled();
    expect(channelMocks.saveAlertRules).not.toHaveBeenCalled();
    expect(webPushRow(container).textContent).not.toContain('Requesting');
  });

  it('shows blocked guidance when denial is discovered through rejection', async () => {
    const container = await mount();
    pushState.subscribeToPush.mockImplementation(async () => {
      pushState.permission = 'denied';
      throw new Error('permission rejected');
    });

    container.querySelector<HTMLButtonElement>('#usConnectWebPush')!.click();

    await vi.waitFor(() => {
      expect(webPushRow(container).dataset.webPushState).toBe('denied');
    });
    const row = webPushRow(container);
    expect(pushState.subscribeToPush).toHaveBeenCalledTimes(1);
    expect(row.querySelector('#usConnectWebPush')).toBeNull();
    expect(row.querySelector('.us-notif-ch-sub')?.textContent).toBe(
      tt('components.proActivation.steps.alerts.blockedNote'),
    );
    expect(channelMocks.saveAlertRules).not.toHaveBeenCalled();
  });

  it('surfaces a safe retryable error when subscription fails without denial', async () => {
    const container = await mount();
    pushState.subscribeToPush.mockRejectedValue(
      new Error('secret endpoint https://internal.example/token/123 failed'),
    );

    container.querySelector<HTMLButtonElement>('#usConnectWebPush')!.click();

    await vi.waitFor(() => {
      expect(webPushRow(container).querySelector('.us-notif-error')).not.toBeNull();
    });
    const row = webPushRow(container);
    const button = row.querySelector<HTMLButtonElement>('#usConnectWebPush');
    const error = row.querySelector<HTMLElement>('.us-notif-error');
    expect(error?.textContent).toBe('Could not enable browser notifications. Try again.');
    expect(error?.getAttribute('role')).toBe('alert');
    expect(row.textContent).not.toContain('internal.example');
    expect(button?.disabled).toBe(false);
    expect(button?.textContent).toBe('Enable');
    expect(channelMocks.saveAlertRules).not.toHaveBeenCalled();
  });

  it('preserves the successful subscription and rule-update path', async () => {
    const container = await mount();

    container.querySelector<HTMLButtonElement>('#usConnectWebPush')!.click();

    await vi.waitFor(() => {
      expect(channelMocks.getChannelsData).toHaveBeenCalledTimes(2);
    });
    expect(pushState.subscribeToPush).toHaveBeenCalledTimes(1);
    expect(channelMocks.saveAlertRules).toHaveBeenCalledTimes(1);
    expect(channelMocks.saveAlertRules.mock.calls[0]?.[0]).toMatchObject({
      channels: ['web_push'],
    });
    const row = webPushRow(container);
    expect(row.dataset.webPushState).toBe('available');
    expect(row.querySelector('.us-notif-error')).toBeNull();
    expect(row.querySelector('.us-notif-ch-badge-blocked')).toBeNull();
  });

  it('keeps unsupported browsers non-actionable', async () => {
    pushState.supported = false;
    pushState.permission = 'unsupported';
    const container = await mount();
    const row = webPushRow(container);

    expect(row.dataset.webPushState).toBe('unsupported');
    expect(row.querySelector('#usConnectWebPush')).toBeNull();
    expect(row.textContent).toContain('Not supported');
    expect(pushState.subscribeToPush).not.toHaveBeenCalled();
    expect(channelMocks.saveAlertRules).not.toHaveBeenCalled();
  });

  it('becomes non-actionable if support disappears before the click', async () => {
    const container = await mount();
    pushState.supported = false;
    pushState.permission = 'unsupported';

    container.querySelector<HTMLButtonElement>('#usConnectWebPush')!.click();

    await vi.waitFor(() => {
      expect(webPushRow(container).dataset.webPushState).toBe('unsupported');
    });
    expect(webPushRow(container).querySelector('#usConnectWebPush')).toBeNull();
    expect(pushState.subscribeToPush).not.toHaveBeenCalled();
    expect(channelMocks.saveAlertRules).not.toHaveBeenCalled();
  });

  it('preserves the connected browser display while permission is usable', async () => {
    pushState.permission = 'granted';
    const container = await mount(CONNECTED_WEB_PUSH);
    const row = webPushRow(container);

    expect(row.classList.contains('us-notif-ch-on')).toBe(true);
    expect(row.textContent).toContain('Connected');
    expect(row.querySelector('.us-notif-disconnect')).not.toBeNull();
    expect(row.querySelector('#usConnectWebPush')).toBeNull();
  });

  it('keeps a connected account connected while warning that this browser is denied', async () => {
    pushState.permission = 'denied';
    const container = await mount(CONNECTED_WEB_PUSH);
    const row = webPushRow(container);

    expect(row.dataset.webPushState).toBe('denied');
    // Permission is per-browser; the channel record is per-account. A denial
    // here must not present the account as disconnected.
    expect(row.classList.contains('us-notif-ch-on')).toBe(true);
    expect(row.querySelector('.us-notif-ch-badge')?.textContent).toBe('Connected');
    expect(row.querySelector('.us-notif-disconnect')).not.toBeNull();
    expect(row.querySelector('#usConnectWebPush')).toBeNull();

    const subs = Array.from(row.querySelectorAll('.us-notif-ch-sub')).map(el => el.textContent);
    expect(subs[0]).toBe('Chrome');
    expect(subs[1]).toBe(tt('components.proActivation.steps.alerts.blockedNote'));
  });

  it('keeps web_push in the saved alert rule when this browser is denied', async () => {
    // Regression: the denied row used to drop `us-notif-ch-on`, and
    // getCurrentAlertRuleFormState derives the persisted `channels` array from
    // that class -- so any incidental autosave silently deleted browser push
    // from the rule, account-wide, with no way to re-add it while denied.
    pushState.permission = 'denied';
    const container = await mount(CONNECTED_WEB_PUSH);
    expect(webPushRow(container).classList.contains('us-notif-ch-on')).toBe(true);

    const sensitivity = container.querySelector<HTMLSelectElement>('#usNotifSensitivity');
    expect(sensitivity).not.toBeNull();
    sensitivity!.value = 'high';
    sensitivity!.dispatchEvent(new Event('change', { bubbles: true }));

    await vi.waitFor(
      () => {
        expect(channelMocks.saveAlertRules).toHaveBeenCalledTimes(1);
      },
      { timeout: 4000 },
    );
    expect(channelMocks.saveAlertRules.mock.calls[0]?.[0]?.channels).toContain('web_push');
  });

  it('restores the Enable action when permission is re-granted in browser settings', async () => {
    // The blocked copy sends the user to BROWSER site settings, which never
    // remounts this panel. Without a permission re-sync the row would stay on
    // "Blocked" after the user did exactly what we asked.
    pushState.permission = 'denied';
    const container = await mount();
    expect(webPushRow(container).querySelector('#usConnectWebPush')).toBeNull();

    pushState.permission = 'granted';
    window.dispatchEvent(new Event('focus'));

    await vi.waitFor(() => {
      expect(webPushRow(container).dataset.webPushState).toBe('available');
    });
    expect(webPushRow(container).querySelector('#usConnectWebPush')).not.toBeNull();
  });

  it('ignores an older reload that resolves after a newer channel state', async () => {
    pushState.permission = 'granted';
    const initialData: ChannelsData = {
      channels: [
        ...CONNECTED_WEB_PUSH.channels,
        { channelType: 'email', verified: true, linkedAt: 1, email: 'a@b.test' },
      ],
      alertRules: [],
    };
    const container = await mount(initialData);

    let resolveOlderReload: ((data: ChannelsData) => void) | undefined;
    channelMocks.getChannelsData
      .mockImplementationOnce(
        () => new Promise<ChannelsData>((resolve) => { resolveOlderReload = resolve; }),
      )
      .mockResolvedValueOnce(EMPTY_DATA);

    pushState.permission = 'denied';
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => {
      expect(resolveOlderReload).toBeDefined();
    });

    container
      .querySelector<HTMLElement>('.us-notif-disconnect[data-channel="email"]')!
      .click();
    await vi.waitFor(() => {
      expect(channelMocks.getChannelsData).toHaveBeenCalledTimes(3);
      expect(webPushRow(container).classList.contains('us-notif-ch-on')).toBe(false);
    });

    resolveOlderReload!(CONNECTED_WEB_PUSH);
    await Promise.resolve();
    await Promise.resolve();

    expect(webPushRow(container).classList.contains('us-notif-ch-on')).toBe(false);
    expect(webPushRow(container).dataset.webPushState).toBe('denied');
  });

  it('retries permission recovery after a reload failure', async () => {
    pushState.permission = 'denied';
    const container = await mount();
    channelMocks.getChannelsData
      .mockRejectedValueOnce(new Error('temporary channels failure'))
      .mockResolvedValueOnce(EMPTY_DATA);

    pushState.permission = 'granted';
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => {
      expect(channelMocks.getChannelsData).toHaveBeenCalledTimes(2);
      expect(container.querySelector('#usNotifLoading')?.textContent).toBe(
        'Failed to load notification settings.',
      );
    });

    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => {
      expect(channelMocks.getChannelsData).toHaveBeenCalledTimes(3);
      expect(webPushRow(container).dataset.webPushState).toBe('available');
    });
    expect(webPushRow(container).querySelector('#usConnectWebPush')).not.toBeNull();
  });

  it('shows unsupported guidance when support disappears during the subscribe', async () => {
    const container = await mount();
    pushState.subscribeToPush.mockImplementation(async () => {
      pushState.supported = false;
      pushState.permission = 'unsupported';
      throw new Error('push manager went away');
    });

    container.querySelector<HTMLButtonElement>('#usConnectWebPush')!.click();

    await vi.waitFor(() => {
      expect(webPushRow(container).dataset.webPushState).toBe('unsupported');
    });
    const row = webPushRow(container);
    expect(row.textContent).toContain('Not supported');
    expect(row.querySelector('.us-notif-error')).toBeNull();
    expect(channelMocks.saveAlertRules).not.toHaveBeenCalled();
  });

  it('writes the failure result into the live row after a concurrent reload', async () => {
    // reloadNotifSection() replaces the whole content subtree. A row captured
    // before the (untimed) permission prompt would be detached by the time the
    // result lands, so the guidance would be written where nobody can see it.
    pushState.permission = 'default';
    const container = await mount({
      channels: [
        { channelType: 'email', verified: true, linkedAt: 1, email: 'a@b.test' },
      ],
      alertRules: [],
    });

    let rejectSubscribe: ((err: Error) => void) | undefined;
    pushState.subscribeToPush.mockImplementation(
      () => new Promise((_resolve, reject) => { rejectSubscribe = reject; }),
    );

    const originalRow = webPushRow(container);
    container.querySelector<HTMLButtonElement>('#usConnectWebPush')!.click();
    await vi.waitFor(() => {
      expect(rejectSubscribe).toBeDefined();
    });

    // Sibling action re-renders the section while the subscribe is in flight.
    container.querySelector<HTMLElement>('.us-notif-disconnect[data-channel="email"]')!.click();
    await vi.waitFor(() => {
      expect(webPushRow(container)).not.toBe(originalRow);
    });

    pushState.permission = 'denied';
    rejectSubscribe!(new Error('permission rejected'));

    await vi.waitFor(() => {
      expect(webPushRow(container).dataset.webPushState).toBe('denied');
    });
    expect(webPushRow(container).isConnected).toBe(true);
  });

  it('leaves the row untouched when the panel is torn down mid-subscribe', async () => {
    const container = await mount();

    let rejectSubscribe: ((err: Error) => void) | undefined;
    pushState.subscribeToPush.mockImplementation(
      () => new Promise((_resolve, reject) => { rejectSubscribe = reject; }),
    );

    container.querySelector<HTMLButtonElement>('#usConnectWebPush')!.click();
    await vi.waitFor(() => {
      expect(rejectSubscribe).toBeDefined();
    });

    // Abort the section (what UnifiedSettings does on teardown).
    cleanups.pop()?.();

    pushState.permission = 'denied';
    rejectSubscribe!(new Error('permission rejected'));
    await Promise.resolve();
    await Promise.resolve();

    const row = webPushRow(container);
    expect(row.dataset.webPushState).toBe('available');
    expect(row.querySelector('.us-notif-error')).toBeNull();
    expect(channelMocks.saveAlertRules).not.toHaveBeenCalled();
  });
});
