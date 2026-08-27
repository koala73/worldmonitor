import { describe, expect, it, vi } from 'vitest';
import type { AppContext } from '@/app/app-context';
import type { XFeedResponse } from '@/services/x-intel';

const mocks = vi.hoisted(() => ({
  fetchXFeed: vi.fn(),
  getHydratedData: vi.fn(),
}));

vi.mock('@/services/x-intel', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/x-intel')>(),
  fetchXFeed: mocks.fetchXFeed,
}));

vi.mock('@/services/bootstrap', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/bootstrap')>(),
  getHydratedData: mocks.getHydratedData,
}));

vi.mock('@/services/panel-gating', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/panel-gating')>(),
  hasPremiumAccess: () => true,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

const feed = (count: number): XFeedResponse => ({
  source: 'x', earlySignal: true, enabled: true, count, updatedAt: new Date().toISOString(), items: [],
});

describe('X feed DataLoader lifecycle', () => {
  it('hydrates immediately and ignores a late live result after teardown', async () => {
    const panel = { setData: vi.fn() };
    const ctx = { panels: { 'x-intel': panel }, isDestroyed: false } as unknown as AppContext;
    const live = deferred<XFeedResponse>();
    mocks.getHydratedData.mockReset();
    mocks.getHydratedData.mockReturnValue(feed(1));
    mocks.fetchXFeed.mockReset();
    mocks.fetchXFeed.mockImplementationOnce((_limit, signal: AbortSignal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      live.promise.then(resolve, reject);
    }));
    const { DataLoaderManager } = await import('@/app/data-loader');
    const loader = new DataLoaderManager(ctx, {
      renderCriticalBanner: () => undefined,
      refreshOpenCountryBrief: () => undefined,
    });

    const load = loader.loadXIntel();
    expect(panel.setData).toHaveBeenCalledTimes(1);
    expect(panel.setData).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }));
    ctx.isDestroyed = true;
    loader.destroy();
    live.resolve(feed(2));
    await load;

    expect(panel.setData).toHaveBeenCalledTimes(1);
  });

  it('keeps hydrated X panel data when the live fetch fails', async () => {
    const panel = { setData: vi.fn() };
    const ctx = { panels: { 'x-intel': panel }, isDestroyed: false } as unknown as AppContext;
    mocks.getHydratedData.mockReset();
    mocks.getHydratedData.mockReturnValue(feed(3));
    mocks.fetchXFeed.mockReset();
    mocks.fetchXFeed.mockRejectedValueOnce(new Error('network down'));
    const { DataLoaderManager } = await import('@/app/data-loader');
    const loader = new DataLoaderManager(ctx, {
      renderCriticalBanner: () => undefined,
      refreshOpenCountryBrief: () => undefined,
    });

    await loader.loadXIntel();

    expect(panel.setData).toHaveBeenCalledTimes(1);
    expect(panel.setData).toHaveBeenCalledWith(expect.objectContaining({ count: 3, enabled: true }));
  });

  it('does not render expired hydrated post bodies after a live failure', async () => {
    const panel = { setData: vi.fn(), showError: vi.fn() };
    const ctx = { panels: { 'x-intel': panel }, isDestroyed: false } as unknown as AppContext;
    mocks.getHydratedData.mockReset();
    mocks.getHydratedData.mockReturnValue({
      ...feed(1),
      updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      items: [{ id: 'old', text: 'possibly deleted body' }],
    });
    mocks.fetchXFeed.mockReset();
    mocks.fetchXFeed.mockRejectedValueOnce(new Error('network down'));
    const { DataLoaderManager } = await import('@/app/data-loader');
    const loader = new DataLoaderManager(ctx, {
      renderCriticalBanner: () => undefined,
      refreshOpenCountryBrief: () => undefined,
    });

    await loader.loadXIntel();

    // The load-bearing assertion: an expired hydrated body must never reach the
    // panel. Asserted directly now, rather than inferred from the shape of a
    // blanking setData call.
    expect(panel.setData).not.toHaveBeenCalled();
    expect(JSON.stringify(panel.setData.mock.calls)).not.toContain('possibly deleted body');
    // Nothing good was ever rendered, so the failure must surface rather than
    // leave the panel stuck on its loading state.
    expect(panel.showError).toHaveBeenCalledTimes(1);
  });

  it('keeps a good live render when a later fetch fails, instead of blanking it', async () => {
    const panel = { setData: vi.fn(), showError: vi.fn() };
    const ctx = { panels: { 'x-intel': panel }, isDestroyed: false } as unknown as AppContext;
    mocks.getHydratedData.mockReset();
    mocks.getHydratedData.mockReturnValue(undefined);
    mocks.fetchXFeed.mockReset();
    mocks.fetchXFeed.mockResolvedValueOnce(feed(4));
    const { DataLoaderManager } = await import('@/app/data-loader');
    const loader = new DataLoaderManager(ctx, {
      renderCriticalBanner: () => undefined,
      refreshOpenCountryBrief: () => undefined,
    });

    await loader.loadXIntel();
    expect(panel.setData).toHaveBeenCalledWith(expect.objectContaining({ count: 4 }));

    // A transient failure on the NEXT poll must not wipe the good posts. The old
    // code called setData({ enabled: false, items: [] }) here, which rendered the
    // permanent "relay disabled" copy over live data after a single 502.
    mocks.fetchXFeed.mockRejectedValueOnce(new Error('network down'));
    await loader.loadXIntel();

    expect(panel.setData).toHaveBeenCalledTimes(1);
    expect(panel.showError).not.toHaveBeenCalled();
  });
});
