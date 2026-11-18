// The brief-language override in notification settings (#10883): it loads
// the stored override, saves a code or null, and restores the previous value
// when the save fails.

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
  getEntitlementState: () => (gate.tier ? { features: { tier: 1 } } : null),
  onEntitlementChange: () => () => {},
  getEntitlementVerificationStatus: () => 'ready',
  onEntitlementVerificationChange: (cb: (status: string) => void) => {
    cb('ready');
    return () => {};
  },
}));

vi.mock('@/services/market-watchlist', () => ({
  getMarketWatchlistEntries: () => [{ symbol: 'AAPL' }, { symbol: 'MSFT' }],
}));

vi.mock('@/utils/country-chip-picker', () => ({
  loadFollowedCountriesSafe: () => [],
  mountCountryChipPicker: () => ({ getValue: () => [], setValue: () => {}, destroy: () => {} }),
}));

vi.mock('uqr', () => ({ renderSVG: () => '<svg></svg>' }));

const briefMocks = vi.hoisted(() => ({
  loadBriefLanguage: vi.fn(),
  saveBriefLanguage: vi.fn(),
}));

vi.mock('@/services/brief-language', () => briefMocks);

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
  briefMocks.loadBriefLanguage.mockReset().mockResolvedValue({ uiLanguage: 'fr', briefLanguage: null, effective: 'fr', deliverableLanguages: LIVE });
  briefMocks.saveBriefLanguage.mockReset().mockResolvedValue({ ok: true });
});

afterAll(() => {
  while (cleanups.length) cleanups.pop()?.();
  document.body.replaceChildren();
  vi.useRealTimers();
});

const LIVE = ['fr', 'de', 'es', 'ja'];

async function mountBriefLanguage(): Promise<{ container: HTMLElement; select: HTMLSelectElement }> {
  const container = await mount(rule());
  const select = q<HTMLSelectElement>(container, '#usBriefLanguage');
  await vi.waitFor(() => expect(select.disabled).toBe(false));
  return { container, select };
}

describe('notification settings brief language', () => {
  it('renders Same as app language selected when no override is stored', async () => {
    const { container, select } = await mountBriefLanguage();
    expect(briefMocks.loadBriefLanguage).toHaveBeenCalledWith('user_mode');
    expect(select.value).toBe('');
    expect(select.selectedOptions[0]?.textContent).toBe('Same as app language');
    expect(select.options.length).toBeGreaterThan(28);
    expect(q(container, '#usDigestDetails').contains(select)).toBe(false);
    expect(q(container, '#usBriefLanguageHint').textContent).toBe('Your daily brief will be written in Français.');
  });

  it('shows no promise while localization is off', async () => {
    briefMocks.loadBriefLanguage.mockResolvedValue({ uiLanguage: 'fr', briefLanguage: null, effective: 'fr', deliverableLanguages: [] });
    const { container } = await mountBriefLanguage();
    const hint = q(container, '#usBriefLanguageHint');
    expect(hint.hidden).toBe(true);
    expect(hint.textContent).toBe('');
  });

  it('still confirms English while localization is off', async () => {
    briefMocks.loadBriefLanguage.mockResolvedValue({ uiLanguage: null, briefLanguage: null, effective: 'en', deliverableLanguages: [] });
    const { container } = await mountBriefLanguage();
    const hint = q(container, '#usBriefLanguageHint');
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe('Your daily brief will be written in English.');
  });

  it('shows no promise for a language the brief is not delivered in yet', async () => {
    briefMocks.loadBriefLanguage.mockResolvedValue({ uiLanguage: 'fa', briefLanguage: null, effective: 'fa', deliverableLanguages: ['fr'] });
    const { container } = await mountBriefLanguage();
    expect(q(container, '#usBriefLanguageHint').hidden).toBe(true);
  });

  it('saving a language that is not live hides the promise, and saving a live one shows it', async () => {
    briefMocks.loadBriefLanguage.mockResolvedValue({ uiLanguage: 'fr', briefLanguage: null, effective: 'fr', deliverableLanguages: ['fr'] });
    const { container, select } = await mountBriefLanguage();
    const hint = q(container, '#usBriefLanguageHint');
    expect(hint.hidden).toBe(false);
    select.value = 'ko';
    change(select);
    await vi.waitFor(() => expect(hint.hidden).toBe(true));
    select.value = '';
    change(select);
    await vi.waitFor(() => expect(hint.textContent).toBe('Your daily brief will be written in Français.'));
    expect(hint.hidden).toBe(false);
  });

  it('selects the stored override', async () => {
    briefMocks.loadBriefLanguage.mockResolvedValue({ uiLanguage: 'fr', briefLanguage: 'ja', effective: 'ja', deliverableLanguages: LIVE });
    const { select } = await mountBriefLanguage();
    expect(select.value).toBe('ja');
  });

  it('saving a language calls saveBriefLanguage with the code', async () => {
    const { container, select } = await mountBriefLanguage();
    select.value = 'de';
    change(select);
    await vi.waitFor(() => expect(select.disabled).toBe(false));
    expect(briefMocks.saveBriefLanguage).toHaveBeenCalledWith('user_mode', 'de');
    expect(q(container, '#usBriefLanguageHint').textContent).toBe('Your daily brief will be written in Deutsch.');
    expect(channelMocks.saveAlertRules).not.toHaveBeenCalled();
  });

  it('choosing Same as app language saves null', async () => {
    briefMocks.loadBriefLanguage.mockResolvedValue({ uiLanguage: 'fr', briefLanguage: 'ja', effective: 'ja', deliverableLanguages: LIVE });
    const { container, select } = await mountBriefLanguage();
    select.value = '';
    change(select);
    await vi.waitFor(() => expect(briefMocks.saveBriefLanguage).toHaveBeenCalledWith('user_mode', null));
    await vi.waitFor(() => expect(q(container, '#usBriefLanguageHint').textContent).toBe('Your daily brief will be written in Français.'));
  });

  it('a failed save restores the previous selection', async () => {
    briefMocks.loadBriefLanguage.mockResolvedValue({ uiLanguage: null, briefLanguage: 'es', effective: 'es', deliverableLanguages: LIVE });
    briefMocks.saveBriefLanguage.mockResolvedValue({ ok: false, reason: 'error' });
    const { container, select } = await mountBriefLanguage();
    select.value = 'it';
    change(select);
    await vi.waitFor(() => expect(select.value).toBe('es'));
    expect(select.disabled).toBe(false);
    expect(q(container, '#usBriefLanguageRow .us-notif-error').getAttribute('role')).toBe('alert');
    expect(q(container, '#usBriefLanguageRow .us-notif-error').textContent).toBe("Couldn't save that. Try again.");
  });

  it('a failed load shows a retry that loads the saved value', async () => {
    briefMocks.loadBriefLanguage.mockResolvedValueOnce(null);
    const container = await mount(rule());
    const select = q<HTMLSelectElement>(container, '#usBriefLanguage');
    const error = await vi.waitFor(() => q(container, '#usBriefLanguageRow .us-notif-error'));
    expect(error.textContent).toContain('Failed to load');
    expect(select.disabled).toBe(true);
    briefMocks.loadBriefLanguage.mockResolvedValueOnce({ uiLanguage: 'fr', briefLanguage: 'ja', effective: 'ja', deliverableLanguages: LIVE });
    q<HTMLButtonElement>(error, 'button').click();
    await vi.waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe('ja');
    expect(container.querySelector('#usBriefLanguageRow .us-notif-error')).toBeNull();
  });
});
