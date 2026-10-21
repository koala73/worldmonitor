import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import type { TelegramChannelPreview } from '@/services/telegram-intel';

const telegramMocks = vi.hoisted(() => ({
  fetchChannelFeed: vi.fn(),
  fetchChannelPreview: vi.fn(),
}));

vi.mock('@/services/telegram-intel', async () => {
  const actual = await vi.importActual<typeof import('@/services/telegram-intel')>('@/services/telegram-intel');
  return {
    ...actual,
    fetchTelegramChannelFeed: telegramMocks.fetchChannelFeed,
    fetchTelegramChannelPreview: telegramMocks.fetchChannelPreview,
  };
});

import { TelegramIntelPanel } from '@/components/TelegramIntelPanel';

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  vi.useRealTimers();
  telegramMocks.fetchChannelFeed.mockReset();
  telegramMocks.fetchChannelPreview.mockReset();
  localStorage.clear();
  document.body.innerHTML = '';
});

function enableRelay(panel: TelegramIntelPanel): void {
  panel.setData({
    source: 'telegram',
    earlySignal: true,
    enabled: true,
    count: 0,
    updatedAt: new Date().toISOString(),
    items: [],
  });
}

function disableRelay(panel: TelegramIntelPanel): void {
  panel.setData({
    source: 'telegram',
    earlySignal: true,
    enabled: false,
    count: 0,
    updatedAt: null,
    items: [],
  });
}

function enterChannel(panel: TelegramIntelPanel, username = 'test_channel'): HTMLInputElement {
  const input = panel.getElement().querySelector<HTMLInputElement>('.telegram-intel-input');
  if (!input) throw new Error('Telegram channel input not found');
  input.value = username;
  input.dispatchEvent(new Event('input'));
  return input;
}

describe('TelegramIntelPanel watchlist lifecycle', () => {
  it('adds, renders, and removes a custom channel through the panel', async () => {
    vi.useFakeTimers();
    telegramMocks.fetchChannelPreview.mockResolvedValue({
      username: 'test_channel',
      title: 'Test Channel',
      memberCount: 1200,
      url: 'https://t.me/test_channel',
    });
    telegramMocks.fetchChannelFeed.mockResolvedValue({
      source: 'telegram',
      earlySignal: true,
      enabled: true,
      count: 1,
      updatedAt: '2026-08-30T09:00:00.000Z',
      items: [{
        id: 'test_channel:1',
        source: 'telegram',
        channel: 'test_channel',
        channelTitle: 'Test Channel',
        url: 'https://t.me/test_channel/1',
        ts: '2026-08-30T09:00:00.000Z',
        text: 'Custom update',
        topic: 'osint',
        tags: [],
        earlySignal: true,
        watchlist: true,
      }],
    });

    const panel = new TelegramIntelPanel();
    document.body.appendChild(panel.getElement());
    enableRelay(panel);
    enterChannel(panel);
    await vi.advanceTimersByTimeAsync(800);
    panel.getElement().querySelector<HTMLButtonElement>('.telegram-intel-preview .telegram-follow-btn')?.click();
    await vi.runAllTimersAsync();

    expect(telegramMocks.fetchChannelFeed).toHaveBeenCalledWith('test_channel', 20);
    expect(panel.getElement().querySelector('.telegram-intel-pill')?.textContent).toContain('@test_channel');
    expect(panel.getElement().querySelector('.telegram-intel-custom-tag')).not.toBeNull();
    expect(panel.getElement().querySelector('.telegram-intel-text')?.textContent).toContain('Custom update');

    panel.getElement().querySelector<HTMLButtonElement>('.telegram-intel-pill')?.click();
    await vi.runAllTimersAsync();
    expect(panel.getElement().querySelector('.telegram-intel-pill')).toBeNull();
    expect(panel.getElement().querySelector('.telegram-intel-custom-tag')).toBeNull();
    expect(localStorage.getItem('telegram:watchlist:v1')).toBe('[]');
    panel.destroy();
  });

  it('cancels a queued preview when the relay becomes unavailable', async () => {
    vi.useFakeTimers();
    const panel = new TelegramIntelPanel();
    document.body.appendChild(panel.getElement());
    enableRelay(panel);

    const input = enterChannel(panel);
    disableRelay(panel);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(telegramMocks.fetchChannelPreview).not.toHaveBeenCalled();
    expect(input.disabled).toBe(true);
    expect(panel.getElement().querySelector('.telegram-intel-preview-card')).toBeNull();
    panel.destroy();
  });

  it('ignores an in-flight preview after the relay becomes unavailable', async () => {
    vi.useFakeTimers();
    let resolvePreview!: (value: TelegramChannelPreview) => void;
    telegramMocks.fetchChannelPreview.mockReturnValue(new Promise<TelegramChannelPreview>(resolve => {
      resolvePreview = resolve;
    }));

    const panel = new TelegramIntelPanel();
    document.body.appendChild(panel.getElement());
    enableRelay(panel);
    enterChannel(panel);
    await vi.advanceTimersByTimeAsync(800);
    expect(telegramMocks.fetchChannelPreview).toHaveBeenCalledOnce();

    disableRelay(panel);
    resolvePreview({
      username: 'test_channel',
      title: 'Test Channel',
      memberCount: null,
      url: 'https://t.me/test_channel',
    });
    await Promise.resolve();

    expect(panel.getElement().querySelector('.telegram-intel-preview-card')).toBeNull();
    expect(panel.getElement().querySelector('.telegram-follow-btn')).toBeNull();
    panel.destroy();
  });

  it('keeps the input and reports a failed watchlist write', async () => {
    vi.useFakeTimers();
    telegramMocks.fetchChannelPreview.mockResolvedValue({
      username: 'test_channel',
      title: 'Test Channel',
      memberCount: null,
      url: 'https://t.me/test_channel',
    });

    const panel = new TelegramIntelPanel();
    document.body.appendChild(panel.getElement());
    enableRelay(panel);
    const input = enterChannel(panel);
    await vi.advanceTimersByTimeAsync(800);
    await Promise.resolve();

    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    panel.getElement().querySelector<HTMLButtonElement>('.telegram-intel-preview .telegram-follow-btn')?.click();

    expect(input.value).toBe('test_channel');
    expect(panel.getElement().querySelector('.telegram-intel-preview-card.is-error')?.textContent)
      .toContain('Save failed');
    expect(panel.getElement().querySelector('.telegram-intel-preview-title')?.textContent).toBe('Test Channel');
    expect(panel.getElement().querySelector('.telegram-intel-preview .telegram-follow-btn')).not.toBeNull();
    panel.destroy();
  });
});
