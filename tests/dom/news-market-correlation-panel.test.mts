import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

const { mockEnsureHydrated, mockFetchTopicTimeline } = vi.hoisted(() => ({
  mockEnsureHydrated: vi.fn(),
  mockFetchTopicTimeline: vi.fn(),
}));

vi.mock('@/services/bootstrap', () => ({
  ensureHydrated: mockEnsureHydrated,
}));

vi.mock('@/services/gdelt-intel', () => ({
  INTEL_TOPICS: [
    { id: 'sanctions', name: 'Sanctions' },
    { id: 'conflict', name: 'Conflict' },
  ],
  fetchTopicTimeline: mockFetchTopicTimeline,
}));

import { NewsMarketCorrelationPanel } from '@/components/NewsMarketCorrelationPanel';

const HOUR_MS = 60 * 60 * 1000;
const START_MS = Date.parse('2026-08-01T00:00:00.000Z');
const CONTENT_DEBOUNCE_MS = 150;

function timestamp(hour: number): string {
  return new Date(START_MS + hour * HOUR_MS).toISOString();
}

const marketPayload = {
  updatedAt: timestamp(10),
  range: '14d',
  interval: '1h',
  series: [{
    symbol: '^GSPC',
    label: 'S&P 500',
    points: Array.from({ length: 10 }, (_, hour) => ({ timestamp: timestamp(hour), value: 100 + hour })),
  }],
};

function topicTimeline() {
  return {
    vol: Array.from({ length: 10 }, (_, hour) => ({ date: timestamp(hour), value: hour + 1 })),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function mount(panel: NewsMarketCorrelationPanel): void {
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
  mockEnsureHydrated.mockReset();
  mockFetchTopicTimeline.mockReset();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('NewsMarketCorrelationPanel selector failures', () => {
  it('restores the last rendered topic when the requested topic is unavailable', async () => {
    const panel = new NewsMarketCorrelationPanel();
    mount(panel);
    mockEnsureHydrated.mockResolvedValue(marketPayload);
    mockFetchTopicTimeline.mockResolvedValueOnce(topicTimeline());

    await settle(panel.fetchData());
    const topic = panel.getElement().querySelector<HTMLSelectElement>('[data-role="news-topic"]');
    expect(topic?.value).toBe('sanctions');

    mockFetchTopicTimeline.mockResolvedValueOnce({ vol: [] });
    if (!topic) throw new Error('topic selector missing');
    topic.value = 'conflict';
    topic.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(mockFetchTopicTimeline).toHaveBeenCalledTimes(2));
    await Promise.resolve();

    expect(topic.value).toBe('sanctions');
    expect(panel.getElement().querySelector('.news-market-correlation')).not.toBeNull();
    panel.destroy();
  });

  it('does not let an older selector response replace the current analysis', async () => {
    const panel = new NewsMarketCorrelationPanel();
    mount(panel);
    mockEnsureHydrated.mockResolvedValue(marketPayload);
    mockFetchTopicTimeline.mockResolvedValueOnce(topicTimeline());
    await settle(panel.fetchData());

    const older = deferred<ReturnType<typeof topicTimeline>>();
    const current = deferred<ReturnType<typeof topicTimeline>>();
    mockFetchTopicTimeline.mockReturnValueOnce(older.promise).mockReturnValueOnce(current.promise);
    const topic = panel.getElement().querySelector<HTMLSelectElement>('[data-role="news-topic"]');
    if (!topic) throw new Error('topic selector missing');

    topic.value = 'conflict';
    topic.dispatchEvent(new Event('change', { bubbles: true }));
    topic.value = 'sanctions';
    topic.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(mockFetchTopicTimeline).toHaveBeenCalledTimes(3));

    current.resolve({
      vol: Array.from({ length: 10 }, (_, hour) => ({ date: timestamp(hour), value: 10 - hour })),
    });
    await vi.waitFor(() => {
      expect(panel.getElement().querySelector('.news-market-correlation__stats strong')?.textContent).toBe('1.00');
    });
    const currentCoefficient = panel.getElement().querySelector('.news-market-correlation__stats strong')?.textContent;

    older.resolve(topicTimeline());
    await vi.waitFor(() => expect(mockFetchTopicTimeline).toHaveBeenCalledTimes(3));
    await Promise.resolve();

    expect(panel.getElement().querySelector<HTMLSelectElement>('[data-role="news-topic"]')?.value).toBe('sanctions');
    expect(panel.getElement().querySelector('.news-market-correlation__stats strong')?.textContent).toBe(currentCoefficient);
    panel.destroy();
  });
});
