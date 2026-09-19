import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { search } = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock('@/services/generated-rpc-clients', () => ({
  IntelligenceServiceClient: class { searchGdeltDocuments = search; },
}));
vi.mock('@/services/rpc-client', () => ({
  getRpcBaseUrl: () => '',
  createLazyClient: (factory: () => unknown) => { let client: unknown; return () => client ??= factory(); },
}));
vi.mock('@/services/i18n', () => ({ t: (key: string) => key }));
vi.mock('@/services/bootstrap', () => ({ getHydratedData: () => null }));
vi.mock('@/services/persistent-cache', () => ({
  getPersistentCache: async () => null, setPersistentCache: async () => {},
  deletePersistentCache: async () => {}, deletePersistentCacheByPrefix: async () => {},
}));
vi.mock('@/utils', async () => await import('@/utils/circuit-breaker'));

beforeEach(() => {
  vi.resetModules();
  search.mockReset();
  search.mockImplementation(async (request) => ({
    articles: [{ title: JSON.stringify(request), url: 'https://example.com', source: 'Example', date: '', image: '', language: '', tone: 0 }],
    query: request.query, error: '',
  }));
});

afterEach(() => vi.useRealTimers());

describe('GDELT request cache identity through the real breaker', () => {
  it('separates query, limit and timespan and reuses identical requests', async () => {
    const { fetchGdeltArticles } = await import('@/services/gdelt-intel');
    const first = await fetchGdeltArticles('military', 10, '24h');
    for (const [query, limit, timespan] of [['cyber', 10, '24h'], ['military', 20, '24h'], ['military', 10, '48h']] as const) {
      expect(await fetchGdeltArticles(query, limit, timespan)).not.toEqual(first);
    }
    expect(await fetchGdeltArticles('military', 10, '24h')).toEqual(first);
    expect(search).toHaveBeenCalledTimes(4);
  });

  it('separates positive query dimensions and delimiter-bearing tuples', async () => {
    const { fetchPositiveGdeltArticles: fetch } = await import('@/services/gdelt-intel');
    const tuples = [
      ['a:b', 'c', 'ToneDesc', 15, '72h'], ['a', 'b:c', 'ToneDesc', 15, '72h'],
      ['a:b', 'c', 'DateDesc', 15, '72h'], ['a:b', 'c', 'ToneDesc', 20, '72h'],
      ['a:b', 'c', 'ToneDesc', 15, '24h'],
    ] as const;
    const titles = [];
    for (const [query, tone, sort, limit, timespan] of tuples) titles.push((await fetch(query, tone, sort, limit, timespan))[0]?.title);
    expect(new Set(titles).size).toBe(tuples.length);
    expect((await fetch(...tuples[0]))[0]?.title).toBe(titles[0]);
    expect(search).toHaveBeenCalledTimes(tuples.length);
  });

  it.each(['normal', 'positive'])('does not retain error bodies for %s queries', async (kind) => {
    const service = await import('@/services/gdelt-intel');
    const fetch = kind === 'normal' ? service.fetchGdeltArticles : service.fetchPositiveGdeltArticles;
    search.mockResolvedValueOnce({ articles: [], query: 'military', error: 'seed-unavailable' });
    expect(await fetch('military')).toEqual([]);
    expect(await fetch('military')).toHaveLength(1);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it.each(['normal', 'positive'])('does not retain rejected requests or cooldown fallbacks for %s queries', async (kind) => {
    vi.useFakeTimers();
    const service = await import('@/services/gdelt-intel');
    const fetch = kind === 'normal' ? service.fetchGdeltArticles : service.fetchPositiveGdeltArticles;
    search.mockRejectedValueOnce(new Error('offline'));
    expect(await fetch('retry')).toEqual([]);
    expect(await fetch('retry')).toHaveLength(1);
    search.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'));
    await fetch('failure-one');
    await fetch('failure-two');
    vi.setSystemTime(Date.now() + 4 * 60 * 1000);
    expect(await fetch('cooldown-query')).toEqual([]);
    vi.setSystemTime(Date.now() + 61 * 1000);
    expect(await fetch('cooldown-query')).toHaveLength(1);
    expect(search).toHaveBeenCalledTimes(5);
  });

  it('preserves valid empty results as cacheable domain values', async () => {
    const { fetchGdeltArticles } = await import('@/services/gdelt-intel');
    search.mockResolvedValue({ articles: [], query: 'military', error: '' });
    expect(await fetchGdeltArticles('military')).toEqual([]);
    expect(await fetchGdeltArticles('military')).toEqual([]);
    expect(search).toHaveBeenCalledTimes(1);
  });
});
