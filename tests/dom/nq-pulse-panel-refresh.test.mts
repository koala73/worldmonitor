/**
 * NQ Pulse overlapping refreshes: an older success or error must not commit
 * after a newer result. The shared scheduler can release a wedged lane while
 * the first request is still alive; prime and retry paths overlap the same way.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import type { MarketFetchResult } from '@/services/market';

const { mockFetchMultipleStocks } = vi.hoisted(() => ({
  mockFetchMultipleStocks: vi.fn(),
}));

vi.mock('@/services/market', () => ({
  fetchMultipleStocks: mockFetchMultipleStocks,
}));

import { NQ_PULSE_REQUEST_TIMEOUT_MS, NqPulsePanel } from '@/components/NqPulsePanel';

const CONTENT_DEBOUNCE_MS = 150;
const NOW = '2026-08-31T18:05:00.000Z';

function quoteResult(price: number, asOf: string): MarketFetchResult {
  return {
    data: [
      { symbol: 'NQ=F', name: 'E-mini Nasdaq-100', display: 'NQ', price, change: -0.2 },
      { symbol: 'QQQ', name: 'Invesco QQQ Trust', display: 'QQQ', price: 500, change: 0.4 },
      { symbol: '^VXN', name: 'CBOE Nasdaq Volatility', display: 'VXN', price: 18, change: 1.1 },
      { symbol: '^TNX', name: 'US 10-Year Yield', display: 'US 10Y', price: 4.2, change: 0.01 },
    ],
    asOf,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function mount(panel: NqPulsePanel): void {
  document.body.appendChild(panel.getElement());
}

async function settle(pending: Promise<unknown>): Promise<void> {
  await pending;
  vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  mockFetchMultipleStocks.mockReset();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('NqPulsePanel overlapping refreshes', () => {
  it('forwards a bounded lifecycle signal on each request', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const panel = new NqPulsePanel();
    mount(panel);
    mockFetchMultipleStocks.mockResolvedValueOnce(quoteResult(22_222, '2026-08-31T18:00:00.000Z'));

    await settle(panel.fetchData());

    expect(timeoutSpy).toHaveBeenCalledWith(NQ_PULSE_REQUEST_TIMEOUT_MS);
    expect(mockFetchMultipleStocks).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    panel.destroy();
  });

  it('does not let an older success replace the current quotes', async () => {
    const panel = new NqPulsePanel();
    mount(panel);

    const older = deferred<MarketFetchResult>();
    const current = deferred<MarketFetchResult>();
    mockFetchMultipleStocks.mockReturnValueOnce(older.promise).mockReturnValueOnce(current.promise);

    const olderFetch = panel.fetchData();
    const currentFetch = panel.fetchData();

    current.resolve(quoteResult(22_222, '2026-08-31T18:00:00.000Z'));
    await settle(currentFetch);
    expect(panel.getElement().textContent).toContain('As of 2026-08-31T18:00:00.000Z');

    older.resolve(quoteResult(11_111, '2026-08-31T17:00:00.000Z'));
    expect(await olderFetch).toBe(false);
    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);

    expect(panel.getElement().textContent).toContain('As of 2026-08-31T18:00:00.000Z');
    expect(panel.getElement().textContent).not.toContain('As of 2026-08-31T17:00:00.000Z');
    expect(panel.getElement().querySelector('.panel-error-state')).toBeNull();
    panel.destroy();
  });

  it('does not let an older error replace the current quotes', async () => {
    const panel = new NqPulsePanel();
    mount(panel);

    const older = deferred<MarketFetchResult>();
    const current = deferred<MarketFetchResult>();
    mockFetchMultipleStocks.mockReturnValueOnce(older.promise).mockReturnValueOnce(current.promise);

    const olderFetch = panel.fetchData();
    const currentFetch = panel.fetchData();

    current.resolve(quoteResult(22_222, '2026-08-31T18:00:00.000Z'));
    await settle(currentFetch);
    expect(panel.getElement().textContent).toContain('As of 2026-08-31T18:00:00.000Z');

    older.reject(new Error('older NQ refresh failed'));
    expect(await olderFetch).toBe(false);
    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);

    expect(panel.getElement().textContent).toContain('As of 2026-08-31T18:00:00.000Z');
    expect(panel.getElement().querySelector('.panel-error-state')).toBeNull();
    expect(panel.getElement().querySelector('.panel-error-msg')).toBeNull();
    panel.destroy();
  });
});
