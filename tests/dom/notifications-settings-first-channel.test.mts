// Connecting the first channel in notification settings switches alerts on
// (#10976, follow-up to #11412). A rule that already has a channel keeps the
// user's Enable notifications choice. The free plan with no country keeps its
// paused state and says so, and a failed save says so.
//
// The channel mocks are backed by one in-memory store, so what the panel
// re-renders after a connect is what the save actually stored.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AlertRule, ChannelsData, NotificationChannel } from '@/services/notification-channels';

import { initTestI18n } from './helpers/i18n.mts';

const gate = vi.hoisted(() => ({ tier: false }));

const store = vi.hoisted(() => ({
  channels: [] as NotificationChannel[],
  rule: null as AlertRule | null,
  // Each pending entry makes one saveAlertRules call wait or fail.
  saveGates: [] as Array<'reject' | Promise<void>>,
}));

const channelMocks = vi.hoisted(() => ({
  getChannelsData: vi.fn(),
  saveAlertRules: vi.fn(),
  setEmailChannel: vi.fn(),
  setWebhookChannel: vi.fn(),
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
  setEmailChannel: channelMocks.setEmailChannel,
  setWebhookChannel: channelMocks.setWebhookChannel,
  setTeamsChannel: vi.fn(),
  sendChannelTest: vi.fn(),
  startSlackOAuth: vi.fn(),
  startDiscordOAuth: vi.fn(),
  deleteChannel: vi.fn(),
  setQuietHours: vi.fn().mockResolvedValue(undefined),
  setDigestSettings: vi.fn().mockResolvedValue(undefined),
  setNotificationConfig: vi.fn().mockResolvedValue(undefined),
  IncompatibleDeliveryError,
}));

vi.mock('@/services/clerk', () => ({
  getCurrentClerkUser: () => ({ id: 'user_first_channel', email: 'first@worldmonitor.test' }),
}));

vi.mock('@/services/entitlements', () => ({
  hasTier: () => gate.tier,
  getEntitlementState: () => (gate.tier ? { features: { tier: 1 } } : null),
  onEntitlementChange: () => () => {},
  getEntitlementVerificationStatus: () => 'ready',
  onEntitlementVerificationChange: (cb: (status: string) => void) => {
    cb('ready');
    return () => {};
  },
}));

vi.mock('@/services/upgrade-flow', () => ({ openUpgradePlans: vi.fn() }));
vi.mock('@/services/market-watchlist', () => ({ getMarketWatchlistEntries: () => [] }));
vi.mock('uqr', () => ({ renderSVG: () => '<svg></svg>' }));

import { renderNotificationsSettings } from '@/services/notifications-settings';

const cleanups: Array<() => void> = [];

type SavedRule = AlertRule & { countries?: string[] };

function rule(over: Partial<AlertRule> = {}): AlertRule {
  return {
    variant: 'full', enabled: false, eventTypes: [], sensitivity: 'critical',
    channels: [], digestMode: 'realtime', ...over,
  };
}

function connected(channelType: NotificationChannel['channelType']): NotificationChannel {
  return { channelType, verified: true, linkedAt: 1, ...(channelType === 'email' ? { email: 'first@worldmonitor.test' } : { chatId: '42' }) };
}

function savedRules(): SavedRule[] {
  return channelMocks.saveAlertRules.mock.calls.map((call) => call[0] as SavedRule);
}

function lastSaved(): SavedRule | undefined {
  const rules = savedRules();
  return rules[rules.length - 1];
}

async function mount(): Promise<HTMLElement> {
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

const toggle = (root: HTMLElement): HTMLInputElement => {
  const el = root.querySelector<HTMLInputElement>('#usNotifEnabled');
  expect(el, '#usNotifEnabled').not.toBeNull();
  return el!;
};

async function connectEmail(container: HTMLElement): Promise<void> {
  const reads = channelMocks.getChannelsData.mock.calls.length;
  container.querySelector<HTMLButtonElement>('#usConnectEmail')!.click();
  await vi.waitFor(() => {
    expect(channelMocks.getChannelsData.mock.calls.length, 'panel reloaded after connect').toBeGreaterThan(reads);
    expect(container.querySelector('[data-channel-type="email"]')?.classList.contains('us-notif-ch-on'), 'email row connected').toBe(true);
  });
  // Let any save the reload triggers land.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  document.body.replaceChildren();
  gate.tier = false;
  store.channels = [];
  store.rule = null;
  store.saveGates = [];
  channelMocks.getChannelsData.mockReset().mockImplementation(async () => ({
    channels: store.channels.map((c) => ({ ...c })),
    alertRules: store.rule ? [{ ...store.rule, channels: [...store.rule.channels] }] : [],
  }) satisfies ChannelsData);
  channelMocks.saveAlertRules.mockReset().mockImplementation(async (payload: SavedRule) => {
    const gateEntry = store.saveGates.shift();
    if (gateEntry === 'reject') throw new Error('save alert rules: 500');
    if (gateEntry) await gateEntry;
    store.rule = { ...(store.rule ?? rule()), ...payload, channels: [...payload.channels] };
  });
  channelMocks.setEmailChannel.mockReset().mockImplementation(async () => {
    store.channels = [...store.channels.filter((c) => c.channelType !== 'email'), connected('email')];
  });
  channelMocks.setWebhookChannel.mockReset().mockImplementation(async () => {
    store.channels = [...store.channels.filter((c) => c.channelType !== 'webhook'), { channelType: 'webhook', verified: true, linkedAt: 1, webhookSigned: true }];
    return { signingSecret: 'whsec_test_secret' };
  });
});

afterAll(() => {
  while (cleanups.length) cleanups.pop()?.();
  document.body.replaceChildren();
});

describe('connecting the first channel switches alerts on (#10976)', () => {
  it('enables a disabled rule that has no channel yet, and the toggle shows it', async () => {
    gate.tier = true;
    store.rule = rule({ enabled: false, channels: [], quietHoursEnabled: true });
    const container = await mount();
    expect(toggle(container).checked).toBe(false);

    await connectEmail(container);

    expect(savedRules().some((saved) => saved.enabled === false), 'no save stored alerts as off').toBe(false);
    expect(store.rule).toMatchObject({ enabled: true, channels: ['email'] });
    expect(toggle(container).checked).toBe(true);
  });

  it('enables a brand-new account on its first channel', async () => {
    gate.tier = true;
    const container = await mount();
    expect(toggle(container).checked).toBe(false);

    await connectEmail(container);

    expect(store.rule).toMatchObject({ enabled: true, channels: ['email'] });
    expect(toggle(container).checked).toBe(true);
  });

  it('keeps alerts off when a second channel joins a rule the user switched off', async () => {
    gate.tier = true;
    store.channels = [connected('telegram')];
    store.rule = rule({ enabled: false, channels: ['telegram'] });
    const container = await mount();

    await connectEmail(container);

    expect(lastSaved()).toMatchObject({ enabled: false, channels: ['telegram', 'email'] });
    expect(store.rule).toMatchObject({ enabled: false });
    expect(toggle(container).checked).toBe(false);
  });

  it('does not let a reload that reads before the save lands store alerts as off', async () => {
    gate.tier = true;
    store.rule = rule({ enabled: false, channels: [] });
    let release!: () => void;
    store.saveGates.push(new Promise<void>((resolve) => { release = resolve; }));
    const container = await mount();

    container.querySelector<HTMLButtonElement>('#usConnectEmail')!.click();
    await vi.waitFor(() => expect(channelMocks.saveAlertRules).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await vi.waitFor(() => {
      expect(container.querySelector('[data-channel-type="email"]')?.classList.contains('us-notif-ch-on')).toBe(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(savedRules().some((saved) => saved.enabled === false), 'no save stored alerts as off').toBe(false);
    expect(store.rule).toMatchObject({ enabled: true, channels: ['email'] });
    expect(toggle(container).checked).toBe(true);
  });

  it('on the free plan with no country, stores the pause, keeps the toggle on with the paused notice, and enables once a country is picked', async () => {
    const container = await mount();

    await connectEmail(container);

    expect(lastSaved()).toMatchObject({ enabled: false, countries: [], channels: ['email'] });
    expect(savedRules().some((saved) => saved.enabled === true && saved.countries?.length === 0), 'no enabled save with an empty scope').toBe(false);
    expect(toggle(container).checked).toBe(true);
    const warn = container.querySelector<HTMLElement>('#usCountryScopeWarn')!;
    expect(warn.hidden).toBe(false);
    expect(warn.textContent).toContain('Alerts are paused until you pick at least one country');
    const note = container.querySelector<HTMLElement>('[data-channel-type="email"] [role="status"]');
    expect(note, 'paused note on the connected row').not.toBeNull();
    expect(note!.hidden).toBe(false);
    expect(note!.textContent).toMatch(/^Pick a country/);

    container.querySelector<HTMLButtonElement>(
      '#usNotifCountryPicker .us-notif-country-chip:not(.us-notif-country-chip-on)',
    )!.click();
    expect(note!.hidden, 'note hides once a country is picked').toBe(true);
    await vi.waitFor(() => {
      expect(lastSaved()?.countries?.length).toBe(1);
    }, { timeout: 3000 });
    expect(lastSaved()).toMatchObject({ enabled: true, channels: ['email'] });
    expect(store.rule).toMatchObject({ enabled: true });
  });

  it('tells the user when the save fails, keeps the toggle on, and retries from the message', async () => {
    store.rule = rule({ enabled: false, channels: [], countries: ['UA'] });
    store.saveGates.push('reject');
    const container = await mount();

    await connectEmail(container);

    const error = await vi.waitFor(() => {
      const el = container.querySelector<HTMLElement>('[data-channel-type="email"] [role="alert"]');
      expect(el, 'failure message on the email row').not.toBeNull();
      return el!;
    });
    expect(error.textContent).toContain('This channel was not added to your alerts.');
    expect(store.rule).toMatchObject({ enabled: false, channels: [] });
    expect(toggle(container).checked).toBe(true);

    const retry = error.querySelector<HTMLButtonElement>('button');
    expect(retry?.textContent).toBe('Try again');
    retry!.click();
    await vi.waitFor(() => {
      expect(store.rule).toMatchObject({ enabled: true, channels: ['email'] });
      expect(container.querySelector('[data-channel-type="email"] [role="alert"]')).toBeNull();
    }, { timeout: 3000 });
    expect(toggle(container).checked).toBe(true);
  });

  it('keeps an opt-out the user makes while the first-channel save is pending', async () => {
    gate.tier = true;
    store.rule = rule({ enabled: false, channels: [] });
    let release!: () => void;
    store.saveGates.push(new Promise<void>((resolve) => { release = resolve; }));
    const container = await mount();

    container.querySelector<HTMLButtonElement>('#usConnectEmail')!.click();
    await vi.waitFor(() => expect(channelMocks.saveAlertRules).toHaveBeenCalledTimes(1));
    expect(toggle(container).checked).toBe(true);
    toggle(container).checked = false;
    toggle(container).dispatchEvent(new Event('change', { bubbles: true }));
    release();
    await vi.waitFor(() => {
      expect(container.querySelector('[data-channel-type="email"]')?.classList.contains('us-notif-ch-on')).toBe(true);
    });
    expect(toggle(container).checked, 'reload keeps the opt-out').toBe(false);
    await vi.waitFor(() => expect(channelMocks.saveAlertRules).toHaveBeenCalledTimes(2), { timeout: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(lastSaved()).toMatchObject({ enabled: false, channels: ['email'] });
    expect(store.rule).toMatchObject({ enabled: false, channels: ['email'] });
    expect(toggle(container).checked).toBe(false);
  });

  it('keeps the connecting channel in a rule save made while the connect save is pending', async () => {
    gate.tier = true;
    store.rule = rule({ enabled: false, channels: [] });
    let release!: () => void;
    store.saveGates.push(new Promise<void>((resolve) => { release = resolve; }));
    const container = await mount();

    container.querySelector<HTMLButtonElement>('#usConnectEmail')!.click();
    await vi.waitFor(() => expect(channelMocks.saveAlertRules).toHaveBeenCalledTimes(1));
    const watchlist = container.querySelector<HTMLInputElement>('#usWatchlistAlerts')!;
    watchlist.checked = true;
    watchlist.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(channelMocks.saveAlertRules).toHaveBeenCalledTimes(2), { timeout: 3000 });

    expect(lastSaved()?.channels).toContain('email');
    release();
    await vi.waitFor(() => {
      expect(container.querySelector('[data-channel-type="email"]')?.classList.contains('us-notif-ch-on')).toBe(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.rule?.channels).toContain('email');
  });
  it('stores a later opt-out even when the earlier connect save lands after it', async () => {
    gate.tier = true;
    store.rule = rule({ enabled: false, channels: [] });
    let release!: () => void;
    store.saveGates.push(new Promise<void>((resolve) => { release = resolve; }));
    const container = await mount();

    container.querySelector<HTMLButtonElement>('#usConnectEmail')!.click();
    await vi.waitFor(() => expect(channelMocks.saveAlertRules).toHaveBeenCalledTimes(1));
    toggle(container).checked = false;
    toggle(container).dispatchEvent(new Event('change', { bubbles: true }));
    // The opt-out's debounced save fires while the connect save is still held.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    release();
    await vi.waitFor(() => {
      expect(container.querySelector('[data-channel-type="email"]')?.classList.contains('us-notif-ch-on')).toBe(true);
      expect(lastSaved()?.enabled).toBe(false);
    }, { timeout: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(store.rule).toMatchObject({ enabled: false, channels: ['email'] });
  });

  it('keeps the webhook signing secret on screen when the failed rule save is retried', async () => {
    gate.tier = true;
    store.rule = rule({ enabled: false, channels: [] });
    store.saveGates.push('reject');
    const container = await mount();

    container.querySelector<HTMLButtonElement>('#usConnectWebhook')!.click();
    container.querySelector<HTMLInputElement>('#usWebhookUrl')!.value = 'https://hooks.example.test/wm';
    container.querySelector<HTMLButtonElement>('#usWebhookSave')!.click();
    const retry = await vi.waitFor(() => {
      const el = container.querySelector<HTMLButtonElement>('[data-channel-type="webhook"] [role="alert"] button');
      expect(el, 'retry on the webhook row').not.toBeNull();
      return el!;
    });
    expect(container.querySelector('#usWebhookSecret')?.textContent).toBe('whsec_test_secret');

    retry.click();
    await vi.waitFor(() => {
      expect(store.rule).toMatchObject({ enabled: true, channels: ['webhook'] });
      expect(container.querySelector('[data-channel-type="webhook"] [role="alert"]')).toBeNull();
    }, { timeout: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container.querySelector('#usWebhookSecret')?.textContent, 'secret still shown').toBe('whsec_test_secret');
  });
});
