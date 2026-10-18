import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initTestI18n } from './helpers/i18n.mts';
const state = vi.hoisted(() => ({
  desktop: false,
  premium: false,
  feed: vi.fn(),
  preview: vi.fn(),
}));
vi.mock('@/services/runtime', async () => ({
  ...(await vi.importActual<typeof import('@/services/runtime')>(
    '@/services/runtime',
  )),
  isDesktopRuntime: () => state.desktop,
}));
vi.mock('@/services/panel-gating', async () => ({
  ...(await vi.importActual<typeof import('@/services/panel-gating')>(
    '@/services/panel-gating',
  )),
  hasPremiumAccess: () => state.premium,
}));
vi.mock('@/services/telegram-intel', async () => ({
  ...(await vi.importActual<typeof import('@/services/telegram-intel')>(
    '@/services/telegram-intel',
  )),
  fetchTelegramChannelFeed: state.feed,
  fetchTelegramChannelPreview: state.preview,
}));
import { TelegramIntelPanel } from '@/components/TelegramIntelPanel';
import { PanelGateReason } from '@/services/panel-gating';
import { TELEGRAM_WATCHLIST_EVENT } from '@/services/telegram-watchlist';
const empty = {
  source: 'telegram',
  earlySignal: true,
  enabled: true,
  count: 0,
  updatedAt: null,
  items: [],
};
const item = {
  id: 'test_channel:1',
  source: 'telegram' as const,
  channel: 'test_channel',
  channelTitle: 'Test',
  url: 'https://t.me/test_channel/1',
  ts: '2026-09-16T00:00:00Z',
  text: 'Protected fixture',
  topic: 'osint',
  tags: [],
  earlySignal: true,
};
const panels: TelegramIntelPanel[] = [];
function panel() {
  const p = new TelegramIntelPanel();
  panels.push(p);
  document.body.append(p.getElement());
  return p;
}
function watchlist() {
  window.dispatchEvent(
    new CustomEvent(TELEGRAM_WATCHLIST_EVENT, {
      detail: { entries: [{ username: 'test_channel' }] },
    }),
  );
}
function type(p: TelegramIntelPanel) {
  const input = p.getElement().querySelector<HTMLInputElement>('input')!;
  input.value = 'test_channel';
  input.dispatchEvent(new Event('input'));
}
beforeAll(initTestI18n);
afterEach(() => {
  panels.splice(0).forEach((p) => p.destroy());
  vi.useRealTimers();
  state.desktop = false;
  state.premium = false;
  state.feed.mockReset();
  state.preview.mockReset();
  localStorage.clear();
  document.body.innerHTML = '';
});
describe('Telegram access lifecycle', () => {
  it('does not start watchlist work before an enabled base feed', async () => {
    state.feed.mockResolvedValue(empty);
    panel();
    watchlist();
    await Promise.resolve();
    expect(state.feed).not.toHaveBeenCalled();
  });
  it('does not fetch or render on free desktop even before layout has locked it', async () => {
    vi.useFakeTimers();
    state.desktop = true;
    state.feed.mockResolvedValue(empty);
    const p = panel();
    p.setData({ ...empty, items: [item] });
    watchlist();
    type(p);
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.feed).not.toHaveBeenCalled();
    expect(state.preview).not.toHaveBeenCalled();
    expect(p.getElement().textContent).not.toContain(item.text);
  });
  it.each(['legacy', 'gated'] as const)(
    'preserves %s lock through every data render and topic click',
    (mode) => {
      const p = panel();
      if (mode === 'legacy') p.showLocked();
      else p.showGatedCta(PanelGateReason.FREE_TIER, () => {});
      const locked = p.getElement().querySelector('.panel-content')!.innerHTML;
      for (const response of [
        empty,
        { ...empty, items: [item] },
        { ...empty, enabled: false, error: 'Late failure' },
      ]) {
        p.setData(response);
        p.getElement()
          .querySelector<HTMLButtonElement>('[data-topic-id="osint"]')!
          .click();
        expect(p.getElement().querySelector('.panel-content')!.innerHTML).toBe(
          locked,
        );
      }
    },
  );
  it('cancels queued preview and blocks watchlist events while locked', async () => {
    vi.useFakeTimers();
    const p = panel();
    p.setData(empty);
    type(p);
    p.showLocked();
    watchlist();
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.preview).not.toHaveBeenCalled();
    expect(state.feed).not.toHaveBeenCalled();
  });
  it('discards in-flight preview and watchlist results across lock/unlock, then recovers', async () => {
    vi.useFakeTimers();
    let preview!: (value: unknown) => void;
    let feed!: (value: unknown) => void;
    state.preview.mockReturnValue(
      new Promise((resolve) => {
        preview = resolve;
      }),
    );
    state.feed.mockReturnValue(
      new Promise((resolve) => {
        feed = resolve;
      }),
    );
    const p = panel();
    p.setData(empty);
    watchlist();
    type(p);
    await vi.advanceTimersByTimeAsync(800);
    expect(state.feed).toHaveBeenCalledOnce();
    expect(state.preview).toHaveBeenCalledOnce();
    p.showLocked();
    p.unlockPanel();
    preview({
      username: 'test_channel',
      title: 'Late preview',
      memberCount: null,
      url: 'https://t.me/test_channel',
    });
    feed({ ...empty, items: [item] });
    await vi.advanceTimersByTimeAsync(1);
    expect(p.getElement().textContent).not.toContain(item.text);
    expect(p.getElement().textContent).not.toContain('Late preview');
    state.feed.mockResolvedValue(empty);
    p.setData({ ...empty, items: [{ ...item, text: 'Fresh recovery' }] });
    await vi.advanceTimersByTimeAsync(1);
    expect(p.getElement().textContent).toContain('Fresh recovery');
  });
  it('does not restore pre-lock payloads and keeps free web usable', () => {
    const p = panel();
    p.setData({ ...empty, items: [item] });
    expect(p.getElement().textContent).toContain(item.text);
    p.showGatedCta(PanelGateReason.ANONYMOUS, () => {});
    p.unlockPanel();
    expect(p.getElement().textContent).not.toContain(item.text);
    p.setData({ ...empty, items: [item] });
    expect(p.getElement().textContent).toContain(item.text);
  });
  it.each(['lock', 'destroy'] as const)(
    'stops remaining watchlist batches after %s',
    async (action) => {
      let release!: (value: unknown) => void;
      const pending = new Promise((resolve) => {
        release = resolve;
      });
      state.feed.mockReturnValue(pending);
      const p = panel();
      p.setData(empty);
      window.dispatchEvent(
        new CustomEvent(TELEGRAM_WATCHLIST_EVENT, {
          detail: {
            entries: [
              'alpha_channel',
              'bravo_channel',
              'charlie_channel',
              'delta_channel',
            ].map((username) => ({ username })),
          },
        }),
      );
      expect(state.feed).toHaveBeenCalledTimes(3);
      if (action === 'lock') p.showLocked();
      else p.destroy();
      release({ ...empty, items: [item] });
      await Promise.resolve();
      await Promise.resolve();
      expect(state.feed).toHaveBeenCalledTimes(3);
      expect(p.getElement().textContent).not.toContain(item.text);
    },
  );
});
