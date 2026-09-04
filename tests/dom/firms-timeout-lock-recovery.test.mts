/**
 * #6770 / PR #6788 review — the shared `fires` one-flight key must not stay
 * latched forever when the wildfire RPC never answers. The request deadline
 * must settle the load, release the key, and let a later layer load retry.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AppContext } from '@/app/app-context';

// #6984 / #6677: this file's single test used to pay for the data-loader
// module graph's transform (data-loader.ts plus the i18n locale glob and
// generated clients) inside its testTimeout. Under load that lands just
// over the 5000ms vitest default — a false red on a green tree. Importing
// the graph at module scope moves the transform cost into the file's
// import phase, which vitest does not bill to any testTimeout. The
// AbortSignal.timeout spy below still wraps the RPC deadline that fires
// during the test, not during this import.
await import('@/app/data-loader');

describe('FIRMS timeout lock recovery (#6770)', () => {
  it('releases the fires key after the RPC deadline and permits a retry', async () => {
    const timeoutControllers: AbortController[] = [];
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((delay) => {
      expect(delay).toBe(20_000);
      const controller = new AbortController();
      timeoutControllers.push(controller);
      return controller.signal;
    });

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          expect(signal).toBe(timeoutControllers[0]?.signal);
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          queueMicrotask(() => timeoutControllers[0]?.abort(new DOMException('deadline', 'TimeoutError')));
        });
      }

      return new Response(JSON.stringify({
        fireDetections: [],
        fetchedAt: Date.now(),
        dataAvailable: false,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { DataLoaderManager } = await import('@/app/data-loader');
    const layerLoading = vi.fn();
    const ctx = {
      isDestroyed: false,
      inFlight: new Set<string>(),
      map: { setLayerLoading: layerLoading },
      panels: {},
      intelligenceCache: {},
    } as unknown as AppContext;
    const loader = new DataLoaderManager(ctx, {
      renderCriticalBanner: () => {},
      refreshOpenCountryBrief: () => {},
    });

    await loader.loadDataForLayer('fires');
    expect(ctx.inFlight.has('fires')).toBe(false);

    await loader.loadDataForLayer('fires');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(timeoutSpy).toHaveBeenCalledTimes(2);
    expect(layerLoading.mock.calls).toEqual([
      ['fires', true],
      ['fires', false],
      ['fires', true],
      ['fires', false],
    ]);
  });
});
