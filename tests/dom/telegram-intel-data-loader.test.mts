import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '@/app/app-context';
const state = vi.hoisted(() => ({
  desktop: false,
  premium: false,
  fetch: vi.fn(),
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
  fetchTelegramFeed: state.fetch,
}));
import { DataLoaderManager } from '@/app/data-loader';
import {
  clearTelegramIntelCache,
  getTelegramIntelGeneration,
} from '@/services/telegram-intel';
const feed = { source: 'telegram', enabled: true, items: [] };
afterEach(() => {
  state.desktop = false;
  state.premium = false;
  state.fetch.mockReset();
});
function create() {
  const panel = { setData: vi.fn() };
  const ctx = {
    panels: { 'telegram-intel': panel },
    isDestroyed: false,
  } as unknown as AppContext;
  return {
    panel,
    ctx,
    loader: new DataLoaderManager(ctx, {
      renderCriticalBanner() {},
      refreshOpenCountryBrief() {},
    }),
  };
}
describe('Telegram loader access', () => {
  it('skips free desktop requests and allows intentional free web feed', async () => {
    state.desktop = true;
    state.fetch.mockResolvedValue(feed);
    const { loader, panel } = create();
    await loader.loadTelegramIntel();
    expect(state.fetch).not.toHaveBeenCalled();
    state.desktop = false;
    await loader.loadTelegramIntel();
    expect(panel.setData).toHaveBeenCalledWith(
      feed,
      getTelegramIntelGeneration(),
    );
  });
  it.each(['success', 'error'] as const)(
    'drops late %s across revoke and recovery',
    async (outcome) => {
      state.desktop = true;
      state.premium = true;
      let resolve!: (value: unknown) => void;
      let reject!: (error: Error) => void;
      state.fetch.mockReturnValue(
        new Promise((ok, fail) => {
          resolve = ok;
          reject = fail;
        }),
      );
      const { loader, panel } = create();
      const load = loader.loadTelegramIntel();
      state.premium = false;
      clearTelegramIntelCache();
      state.premium = true;
      if (outcome === 'success') resolve(feed);
      else reject(new Error('old failure'));
      await load;
      expect(panel.setData).not.toHaveBeenCalled();
      state.fetch.mockResolvedValue(feed);
      await loader.loadTelegramIntel();
      expect(panel.setData).toHaveBeenCalledOnce();
    },
  );
  it('drops completion after teardown', async () => {
    let resolve!: (value: unknown) => void;
    state.fetch.mockReturnValue(
      new Promise((ok) => {
        resolve = ok;
      }),
    );
    const { loader, panel, ctx } = create();
    const load = loader.loadTelegramIntel();
    ctx.isDestroyed = true;
    resolve(feed);
    await load;
    expect(panel.setData).not.toHaveBeenCalled();
  });
});
