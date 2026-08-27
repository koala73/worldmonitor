import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils', () => ({ proxyUrl: (path: string) => path }));
vi.mock('@/services/runtime', () => ({
  isDesktopRuntime: () => false,
  toApiUrl: (path: string) => path,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

describe('X feed request lifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('coalesces concurrent requests for the same limit', async () => {
    const response = deferred<Response>();
    const fetchMock = vi.fn(() => response.promise);
    vi.stubGlobal('fetch', fetchMock);
    const { fetchXFeed } = await import('@/services/x-intel');

    const first = fetchXFeed(50);
    const second = fetchXFeed(50);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    response.resolve(new Response(JSON.stringify({
      source: 'x', earlySignal: true, enabled: true, count: 0, updatedAt: null, items: [],
    }), { status: 200 }));

    await expect(first).resolves.toMatchObject({ source: 'x' });
    await expect(second).resolves.toMatchObject({ source: 'x' });
  });

  it('lets one caller abort without canceling the shared request', async () => {
    const response = deferred<Response>();
    const fetchMock = vi.fn(() => response.promise);
    vi.stubGlobal('fetch', fetchMock);
    const { fetchXFeed } = await import('@/services/x-intel');
    const controller = new AbortController();

    const aborted = fetchXFeed(50, controller.signal);
    const survivor = fetchXFeed(50);
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    response.resolve(new Response(JSON.stringify({
      source: 'x', earlySignal: true, enabled: true, count: 1, updatedAt: null, items: [],
    }), { status: 200 }));

    await expect(survivor).resolves.toMatchObject({ count: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts an orphaned request and lets the next caller start fresh', async () => {
    const responses = [deferred<Response>(), deferred<Response>()];
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((_url: string, options?: RequestInit) => {
      signals.push(options?.signal as AbortSignal);
      const response = responses[signals.length - 1];
      expect(response).toBeDefined();
      return response!.promise;
    });
    vi.stubGlobal('fetch', fetchMock);
    const { fetchXFeed } = await import('@/services/x-intel');
    const controller = new AbortController();

    const orphaned = fetchXFeed(50, controller.signal);
    controller.abort();
    await expect(orphaned).rejects.toMatchObject({ name: 'AbortError' });
    expect(signals[0]).toBeDefined();
    expect(signals[0]!.aborted).toBe(true);

    const fresh = fetchXFeed(50);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(responses[1]).toBeDefined();
    responses[1]!.resolve(new Response(JSON.stringify({
      source: 'x', earlySignal: true, enabled: true, count: 2, updatedAt: null, items: [],
    }), { status: 200 }));
    await expect(fresh).resolves.toMatchObject({ count: 2 });
  });
});
