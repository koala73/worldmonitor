// Connecting the first channel in notification settings switches alerts on
// (#10976, follow-up to #11412). The server decides: a save the user did not
// set the toggle for carries `enabledIntent`, "connect" while a channel is
// being connected and "keep" otherwise. "connect" on a rule with no stored
// channel switches alerts on; "keep" keeps the stored value. The panel
// renders what the server stored and says why when the plan kept alerts off.
//
// The channel mocks share one in-memory store that resolves `enabled` with
// the same shared rule the Convex writers use, so what the panel re-renders
// is what the save stored.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AlertRule, AlertRuleSave, ChannelsData, NotificationChannel } from '@/services/notification-channels';
import { resolveRuleEnabled, type RuleSaveResult } from '../../shared/alert-rule-shape';

import { initTestI18n } from './helpers/i18n.mts';

const gate = vi.hoisted(() => ({ tier: false }));

const pushState = vi.hoisted(() => ({
  supported: false,
  permission: 'unsupported' as 'default' | 'granted' | 'denied' | 'unsupported',
}));

const store = vi.hoisted(() => ({
  channels: [] as NotificationChannel[],
  rule: null as AlertRule | null,
  // Each pending entry makes one call wait or fail.
  saveGates: [] as Array<'reject' | Promise<void>>,
  readGates: [] as Array<Promise<void>>,
  webhookGates: [] as Array<Promise<void>>,
}));

const channelMocks = vi.hoisted(() => ({
  getChannelsData: vi.fn(),
  saveAlertRules: vi.fn(),
  setEmailChannel: vi.fn(),
  setWebhookChannel: vi.fn(),
}));

const { IncompatibleDeliveryError } = vi.hoisted(() => ({ IncompatibleDeliveryError: class IncompatibleDeliveryError extends Error {} }));

vi.mock('@/services/push-notifications', () => ({
  isWebPushSupported: () => pushState.supported,
  getPushPermission: () => pushState.permission,
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
  setNotificationConfig: vi.fn().mockResolvedValue({}),
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

const SCOPE_MESSAGE = 'Choose 1–3 countries to follow for alerts, or upgrade to Pro for worldwide alerts.';

function rule(over: Partial<AlertRule> = {}): AlertRule {
  return {
    variant: 'full', enabled: false, eventTypes: [], sensitivity: 'critical',
    channels: [], digestMode: 'realtime', ...over,
  };
}

function connected(channelType: NotificationChannel['channelType']): NotificationChannel {
  return { channelType, verified: true, linkedAt: 1, ...(channelType === 'email' ? { email: 'first@worldmonitor.test' } : { chatId: '42' }) };
}

// The server side of set-alert-rules: the shared enabled rule, and the free
// plan's empty-scope refusal turned into a held switch-on.
function storeRuleSave(payload: AlertRuleSave): RuleSaveResult {
  const resolved = resolveRuleEnabled(payload.enabled, payload.enabledIntent, store.rule, payload.channels);
  const countries = payload.countries ?? store.rule?.countries ?? [];
  const held = resolved.firstChannel && !gate.tier && countries.length === 0;
  const enabled = held ? false : resolved.enabled;
  store.rule = { ...(store.rule ?? rule()), ...payload, enabled, channels: [...payload.channels] };
  if (held) return { enabled, firstChannel: 'held', reason: { code: 'ALERT_COUNTRY_SCOPE_REQUIRED', message: SCOPE_MESSAGE } };
  return resolved.firstChannel ? { enabled, firstChannel: 'on' } : { enabled };
}

function savedRules(): AlertRuleSave[] {
  return channelMocks.saveAlertRules.mock.calls.map((call) => call[0] as AlertRuleSave);
}

function lastSaved(): AlertRuleSave | undefined {
  const rules = savedRules();
  return rules[rules.length - 1];
}

function hold(gates: Array<Promise<void> | 'reject'>): () => void {
  let release!: () => void;
  gates.push(new Promise<void>((resolve) => { release = resolve; }));
  return release;
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

async function mount(): Promise<{ container: HTMLElement; close: () => void }> {
  const container = document.createElement('div');
  const rendered = renderNotificationsSettings({ isSignedIn: true });
  container.innerHTML = rendered.html;
  document.body.appendChild(container);
  const close = rendered.attach(container);
  cleanups.push(close);
  await shown(container);
  return { container, close };
}

async function shown(container: HTMLElement): Promise<void> {
  await vi.waitFor(() => {
    expect(container.querySelector<HTMLElement>('#usNotifContent')?.style.display).toBe('block');
  }, { timeout: 3000 });
}

const toggle = (root: HTMLElement): HTMLInputElement => {
  const el = root.querySelector<HTMLInputElement>('#usNotifEnabled');
  expect(el, '#usNotifEnabled').not.toBeNull();
  return el!;
};

function flip(input: HTMLInputElement, checked: boolean): void {
  input.checked = checked;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

// A connect reloads the section once its rule save settles.
async function connectEmail(container: HTMLElement): Promise<void> {
  const reads = channelMocks.getChannelsData.mock.calls.length;
  container.querySelector<HTMLButtonElement>('#usConnectEmail')!.click();
  await vi.waitFor(() => {
    expect(channelMocks.getChannelsData.mock.calls.length, 'panel reloaded after connect').toBeGreaterThan(reads);
  }, { timeout: 3000 });
  await shown(container);
  await tick();
}

function connectWebhook(container: HTMLElement): void {
  container.querySelector<HTMLButtonElement>('#usConnectWebhook')!.click();
  container.querySelector<HTMLInputElement>('#usWebhookUrl')!.value = 'https://hooks.example.test/wm';
  container.querySelector<HTMLButtonElement>('#usWebhookSave')!.click();
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  document.body.replaceChildren();
  gate.tier = false;
  pushState.supported = false;
  pushState.permission = 'unsupported';
  store.channels = [];
  store.rule = null;
  store.saveGates = [];
  store.readGates = [];
  store.webhookGates = [];
  channelMocks.getChannelsData.mockReset().mockImplementation(async () => {
    const gateEntry = store.readGates.shift();
    // The read is taken before the hold, as a slow response would be.
    const data = {
      channels: store.channels.map((c) => ({ ...c })),
      alertRules: store.rule ? [{ ...store.rule, channels: [...store.rule.channels] }] : [],
    } satisfies ChannelsData;
    if (gateEntry) await gateEntry;
    return data;
  });
  channelMocks.saveAlertRules.mockReset().mockImplementation(async (payload: AlertRuleSave) => {
    const gateEntry = store.saveGates.shift();
    if (gateEntry === 'reject') throw new Error('save alert rules: 500');
    if (gateEntry) await gateEntry;
    return storeRuleSave(payload);
  });
  channelMocks.setEmailChannel.mockReset().mockImplementation(async () => {
    store.channels = [...store.channels.filter((c) => c.channelType !== 'email'), connected('email')];
  });
  channelMocks.setWebhookChannel.mockReset().mockImplementation(async () => {
    const gateEntry = store.webhookGates.shift();
    if (gateEntry) await gateEntry;
    store.channels = [...store.channels.filter((c) => c.channelType !== 'webhook'), { channelType: 'webhook', verified: true, linkedAt: 1, webhookSigned: true }];
    return { signingSecret: 'whsec_test_secret' };
  });
});

afterAll(() => {
  while (cleanups.length) cleanups.pop()?.();
  document.body.replaceChildren();
});

describe('connecting the first channel switches alerts on (#10976)', () => {
  it('leaves the decision to the server and renders the rule it stored', async () => {
    gate.tier = true;
    store.rule = rule({ enabled: false, channels: [], quietHoursEnabled: true });
    const { container } = await mount();
    expect(toggle(container).checked).toBe(false);

    await connectEmail(container);

    expect(lastSaved()).toMatchObject({ enabled: false, enabledIntent: 'connect', channels: ['email'] });
    expect(store.rule).toMatchObject({ enabled: true, channels: ['email'] });
    expect(toggle(container).checked).toBe(true);
  });

  it('switches a brand-new account on with its first channel', async () => {
    gate.tier = true;
    const { container } = await mount();

    await connectEmail(container);

    expect(store.rule).toMatchObject({ enabled: true, channels: ['email'] });
    expect(toggle(container).checked).toBe(true);
  });

  it('keeps alerts off when a second channel joins a rule that is off', async () => {
    gate.tier = true;
    store.channels = [connected('telegram')];
    store.rule = rule({ enabled: false, channels: ['telegram'] });
    const { container } = await mount();

    await connectEmail(container);

    expect(store.rule).toMatchObject({ enabled: false, channels: ['telegram', 'email'] });
    expect(toggle(container).checked).toBe(false);
  });

  it('keeps an opt-out the user made in this render when the first channel connects', async () => {
    gate.tier = true;
    store.rule = rule({ enabled: false, channels: [] });
    const { container } = await mount();
    flip(toggle(container), true);
    flip(toggle(container), false);

    await connectEmail(container);

    expect(lastSaved()).toMatchObject({ enabled: false, channels: ['email'] });
    expect('enabledIntent' in lastSaved()!, 'an opt-out set in this render is sent as is').toBe(false);
    expect(store.rule).toMatchObject({ enabled: false });
    expect(toggle(container).checked).toBe(false);
  });

  it('stores an opt-out made after an earlier switch-on in the same render', async () => {
    gate.tier = true;
    store.channels = [connected('email')];
    store.rule = rule({ enabled: false, channels: ['email'] });
    const { container } = await mount();

    flip(toggle(container), true);
    await vi.waitFor(() => expect(store.rule?.enabled).toBe(true), { timeout: 3000 });
    flip(toggle(container), false);
    await vi.waitFor(() => expect(store.rule?.enabled).toBe(false), { timeout: 3000 });
    expect(lastSaved()?.enabled).toBe(false);
  });

  it('a debounced save sent while the connect save is pending is a connect save and keeps the channel', async () => {
    gate.tier = true;
    store.rule = rule({ enabled: false, channels: [] });
    const release = hold(store.saveGates);
    const { container } = await mount();

    container.querySelector<HTMLButtonElement>('#usConnectEmail')!.click();
    await vi.waitFor(() => expect(channelMocks.saveAlertRules).toHaveBeenCalledTimes(1));
    flip(container.querySelector<HTMLInputElement>('#usWatchlistAlerts')!, true);
    await vi.waitFor(() => expect(channelMocks.saveAlertRules).toHaveBeenCalledTimes(2), { timeout: 3000 });
    const watchlistSave = lastSaved()!;
    expect(watchlistSave.enabledIntent, 'watchlist save').toBe('connect');
    expect(watchlistSave.channels, 'watchlist save keeps the connecting channel').toContain('email');
    release();
    await vi.waitFor(() => expect(toggle(container).checked).toBe(true), { timeout: 3000 });

    expect(store.rule).toMatchObject({ enabled: true, channels: ['email'] });
  });

  it('a debounced save that fires after the switch-on, before the reload shows it, keeps alerts on', async () => {
    gate.tier = true;
    store.rule = rule({ enabled: false, channels: [] });
    const { container } = await mount();
    const releaseRead = hold(store.readGates);

    flip(container.querySelector<HTMLInputElement>('#usWatchlistAlerts')!, true);
    container.querySelector<HTMLButtonElement>('#usConnectEmail')!.click();
    await vi.waitFor(() => expect(store.rule?.enabled, 'switched on').toBe(true));
    expect(toggle(container).checked, 'toggle still shows the old render').toBe(false);
    await vi.waitFor(() => expect(channelMocks.saveAlertRules).toHaveBeenCalledTimes(2), { timeout: 3000 });

    expect(lastSaved()?.eventTypes).toContain('watchlist_story_alert');
    expect(lastSaved()?.enabledIntent, 'the late save keeps the stored value').toBe('keep');
    expect(store.rule).toMatchObject({ enabled: true, channels: ['email'] });
    releaseRead();
    await vi.waitFor(() => expect(toggle(container).checked).toBe(true), { timeout: 3000 });
  });

  it('the close-time flush keeps the stored value after a switch-on', async () => {
    gate.tier = true;
    store.rule = rule({ enabled: false, channels: [] });
    const { container, close } = await mount();
    hold(store.readGates);

    container.querySelector<HTMLButtonElement>('#usConnectEmail')!.click();
    flip(container.querySelector<HTMLInputElement>('#usWatchlistAlerts')!, true);
    await vi.waitFor(() => expect(store.rule?.enabled).toBe(true));
    expect(toggle(container).checked, 'toggle still shows the old render').toBe(false);
    close();
    await vi.waitFor(() => expect(channelMocks.saveAlertRules).toHaveBeenCalledTimes(2));

    expect(lastSaved()?.enabledIntent, 'the flush keeps the stored value').toBe('keep');
    expect(store.rule).toMatchObject({ enabled: true, channels: ['email'] });
  });

  it('the load-time channel re-sync stores the channel and leaves alerts off', async () => {
    gate.tier = true;
    store.channels = [connected('email')];
    store.rule = rule({ enabled: false, channels: [] });
    const { container } = await mount();

    await vi.waitFor(() => expect(store.rule?.channels).toEqual(['email']), { timeout: 3000 });
    expect(lastSaved()?.enabledIntent, 'the re-sync keeps the stored value').toBe('keep');
    expect(store.rule?.enabled).toBe(false);
    expect(toggle(container).checked).toBe(false);
  });

  it('a plain edit on a rule with no stored channel leaves alerts off', async () => {
    store.channels = [connected('email')];
    store.rule = rule({ enabled: false, channels: [], countries: ['UA'] });
    const { container } = await mount();

    flip(container.querySelector<HTMLInputElement>('#usWatchlistAlerts')!, true);
    await vi.waitFor(() => expect(lastSaved()?.eventTypes).toContain('watchlist_story_alert'), { timeout: 3000 });

    expect(lastSaved()).toMatchObject({ enabled: false, enabledIntent: 'keep', channels: ['email'] });
    expect(store.rule).toMatchObject({ enabled: false, channels: ['email'] });
  });

  it('on the free plan with no country, keeps alerts off and says why', async () => {
    const { container } = await mount();

    await connectEmail(container);

    expect(store.rule).toMatchObject({ enabled: false, channels: ['email'], countries: [] });
    expect(savedRules().some((saved) => saved.enabled === true), 'no save asked for alerts on').toBe(false);
    expect(toggle(container).checked).toBe(false);
    const note = container.querySelector<HTMLElement>('#usNotifEnabledNote')!;
    expect(note.hidden).toBe(false);
    expect(note.getAttribute('role')).toBe('status');
    expect(note.textContent).toBe('Alerts are off. Pick a country under Country scope, then switch on Enable notifications.');
    expect(container.querySelector<HTMLElement>('#usCountryScopeWarn')?.hidden).toBe(false);
  });

  it('pauses and resumes a free rule as its country scope empties and fills', async () => {
    store.channels = [connected('email')];
    store.rule = rule({ enabled: true, channels: ['email'], countries: ['UA'] });
    const { container } = await mount();

    container.querySelector<HTMLButtonElement>('#usNotifCountryPicker .us-notif-country-chip-on')!.click();
    await vi.waitFor(() => expect(lastSaved()).toMatchObject({ enabled: false, countries: [] }), { timeout: 3000 });
    container.querySelector<HTMLButtonElement>('#usNotifCountryPicker .us-notif-country-chip:not(.us-notif-country-chip-on)')!.click();
    await vi.waitFor(() => expect(lastSaved()?.countries?.length).toBe(1), { timeout: 3000 });

    expect(lastSaved()?.enabled).toBe(true);
    expect(store.rule).toMatchObject({ enabled: true, channels: ['email'] });
  });

  it('tells the user when the save fails and retries from the message', async () => {
    store.rule = rule({ enabled: false, channels: [], countries: ['UA'] });
    store.saveGates.push('reject');
    const { container } = await mount();

    await connectEmail(container);

    const error = container.querySelector<HTMLElement>('[data-channel-type="email"] [role="alert"]');
    expect(error, 'failure message on the email row').not.toBeNull();
    expect(error!.textContent).toContain('This channel was not added to your alerts.');
    expect(store.rule).toMatchObject({ enabled: false, channels: [] });

    const retry = error!.querySelector<HTMLButtonElement>('button');
    expect(retry?.textContent).toBe('Try again');
    retry!.click();
    await vi.waitFor(() => {
      expect(store.rule).toMatchObject({ enabled: true, channels: ['email'] });
      expect(container.querySelector('[data-channel-type="email"] [role="alert"]')).toBeNull();
      expect(toggle(container).checked).toBe(true);
    }, { timeout: 3000 });
  });

  it('an edit saved after a failed connect save still switches alerts on', async () => {
    store.rule = rule({ enabled: false, channels: [], countries: ['UA'] });
    store.saveGates.push('reject');
    const { container } = await mount();

    await connectEmail(container);
    expect(container.querySelector('[data-channel-type="email"] [role="alert"]'), 'failure shown').not.toBeNull();
    flip(container.querySelector<HTMLInputElement>('#usWatchlistAlerts')!, true);

    await vi.waitFor(() => expect(store.rule).toMatchObject({ enabled: true, channels: ['email'] }), { timeout: 3000 });
    expect(lastSaved()?.enabledIntent).toBe('connect');
  });

  it('keeps the webhook signing secret on screen when the failed rule save is retried', async () => {
    gate.tier = true;
    store.rule = rule({ enabled: false, channels: [] });
    store.saveGates.push('reject');
    const { container } = await mount();

    connectWebhook(container);
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
    await tick();
    expect(container.querySelector('#usWebhookSecret')?.textContent, 'secret still shown').toBe('whsec_test_secret');
  });

  it('keeps a webhook signing secret that arrives while another connect reload is pending', async () => {
    gate.tier = true;
    store.rule = rule({ enabled: false, channels: [] });
    const { container } = await mount();
    const releaseWebhook = hold(store.webhookGates);
    connectWebhook(container);
    const releaseRead = hold(store.readGates);

    container.querySelector<HTMLButtonElement>('#usConnectEmail')!.click();
    await vi.waitFor(() => expect(store.rule?.channels).toEqual(['email']));
    releaseWebhook();
    await vi.waitFor(() => expect(container.querySelector('#usWebhookSecret')).not.toBeNull());
    releaseRead();
    await tick(50);

    expect(container.querySelector('#usWebhookSecret')?.textContent, 'secret still shown').toBe('whsec_test_secret');
    expect(container.querySelector<HTMLElement>('#usNotifContent')?.style.display, 'section visible').toBe('block');
    expect(container.querySelector('#usWebhookSecretDone'), 'Done reachable').not.toBeNull();
  });

  it('reports a failed connect save while a webhook signing secret is on screen', async () => {
    gate.tier = true;
    store.rule = rule({ enabled: false, channels: [] });
    const { container } = await mount();
    connectWebhook(container);
    await vi.waitFor(() => expect(store.rule?.channels).toEqual(['webhook']));
    await vi.waitFor(() => expect(container.querySelector('#usWebhookSecret')).not.toBeNull());
    store.saveGates.push('reject');

    container.querySelector<HTMLButtonElement>('#usConnectEmail')!.click();

    await vi.waitFor(() => {
      expect(container.querySelector('[data-channel-type="email"] [role="alert"] button')?.textContent).toBe('Try again');
    }, { timeout: 3000 });
    expect(container.querySelector('#usWebhookSecret')?.textContent, 'secret still shown').toBe('whsec_test_secret');
  });

  it('keeps the webhook signing secret when notification permission changes, and Done still reloads', async () => {
    gate.tier = true;
    pushState.supported = true;
    pushState.permission = 'default';
    const status = new EventTarget();
    const query = vi.fn(async () => status);
    const originalPermissions = navigator.permissions;
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: { query },
    });
    cleanups.push(() => {
      Object.defineProperty(navigator, 'permissions', { configurable: true, value: originalPermissions });
    });
    store.rule = rule({ enabled: false, channels: [] });
    const { container } = await mount();
    await vi.waitFor(() => expect(query).toHaveBeenCalled());
    await Promise.resolve();

    connectWebhook(container);
    await vi.waitFor(() => {
      expect(container.querySelector('#usWebhookSecret')?.textContent).toBe('whsec_test_secret');
    });

    pushState.permission = 'denied';
    status.dispatchEvent(new Event('change'));
    await tick(50);

    expect(container.querySelector('#usWebhookSecret')?.textContent, 'secret still shown').toBe('whsec_test_secret');
    expect(container.querySelector('#usWebhookSecretDone'), 'Done reachable').not.toBeNull();
    expect(container.querySelector<HTMLElement>('#usNotifContent')?.style.display, 'section visible').toBe('block');

    const reads = channelMocks.getChannelsData.mock.calls.length;
    container.querySelector<HTMLButtonElement>('#usWebhookSecretDone')!.click();
    await vi.waitFor(() => {
      expect(channelMocks.getChannelsData.mock.calls.length, 'section reloaded').toBeGreaterThan(reads);
      expect(container.querySelector('#usWebhookSecret')).toBeNull();
    });
    await shown(container);
    expect(container.querySelector('[data-channel-type="webhook"] .us-notif-ch-sub')?.textContent).toContain('Signed');
    expect(container.querySelector<HTMLElement>('[data-channel-type="web_push"]')?.dataset.webPushState).toBe('denied');
  });
});
