import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { search, persisted } = vi.hoisted(() => ({ search: vi.fn(), persisted: new Map<string, unknown>() }));
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
  getPersistentCache: async (key: string) => persisted.get(key) ?? null,
  setPersistentCache: async (key: string, data: unknown, updatedAt = Date.now()) => { persisted.set(key, { key, data, updatedAt }); },
  deletePersistentCache: async (key: string) => { persisted.delete(key); },
  deletePersistentCacheByPrefix: async () => {},
}));
vi.mock('@/utils', async () => await import('@/utils/circuit-breaker'));

beforeEach(() => {
  vi.resetModules();
  search.mockReset();
  persisted.clear();
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
    // Unavailable with no last-good articles is an error, not a confirmed empty result.
    await expect(fetch('military')).rejects.toThrow(/unavailable/);
    expect(await fetch('military')).toHaveLength(1);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it.each(['normal', 'positive'])('does not retain rejected requests or cooldown fallbacks for %s queries', async (kind) => {
    vi.useFakeTimers();
    const service = await import('@/services/gdelt-intel');
    const fetch = kind === 'normal' ? service.fetchGdeltArticles : service.fetchPositiveGdeltArticles;
    search.mockRejectedValueOnce(new Error('offline'));
    await expect(fetch('retry')).rejects.toThrow(/unavailable/);
    expect(await fetch('retry')).toHaveLength(1);
    search.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'));
    await expect(fetch('failure-one')).rejects.toThrow(/unavailable/);
    await expect(fetch('failure-two')).rejects.toThrow(/unavailable/);
    vi.setSystemTime(Date.now() + 4 * 60 * 1000);
    await expect(fetch('cooldown-query')).rejects.toThrow(/unavailable/);
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

describe('GDELT breaker entries honor the one-hour serve limit', () => {
  const HOUR = 60 * 60 * 1000;
  const article = { title: 'retained', url: 'https://example.com/a', source: 'Example', date: '', image: '', language: '', tone: 0 };
  const persistKey = `breaker:GDELT Intelligence:${JSON.stringify(['military', 10, '24h', '', ''])}`;

  it('serves a breaker entry younger than one hour while the upstream fails', async () => {
    vi.useFakeTimers();
    const { fetchGdeltArticles } = await import('@/services/gdelt-intel');
    expect(await fetchGdeltArticles('military')).toHaveLength(1);
    vi.setSystemTime(Date.now() + 30 * 60 * 1000);
    search.mockRejectedValue(new Error('offline'));
    expect(await fetchGdeltArticles('military')).toHaveLength(1);
  });

  it('does not serve an in-memory breaker entry older than one hour; the unavailable path runs', async () => {
    vi.useFakeTimers();
    const { fetchGdeltArticles } = await import('@/services/gdelt-intel');
    expect(await fetchGdeltArticles('military')).toHaveLength(1);
    vi.setSystemTime(Date.now() + HOUR + 60 * 1000);
    search.mockRejectedValue(new Error('offline'));
    await expect(fetchGdeltArticles('military')).rejects.toThrow(/unavailable/);
  });

  it('does not serve an in-memory entry older than one hour while the breaker is on cooldown', async () => {
    vi.useFakeTimers();
    const { fetchGdeltArticles } = await import('@/services/gdelt-intel');
    expect(await fetchGdeltArticles('military')).toHaveLength(1);
    vi.setSystemTime(Date.now() + HOUR + 60 * 1000);
    search.mockRejectedValue(new Error('offline'));
    await expect(fetchGdeltArticles('cyber')).rejects.toThrow(/unavailable/);
    await expect(fetchGdeltArticles('nuclear')).rejects.toThrow(/unavailable/);
    const callsBefore = search.mock.calls.length;
    await expect(fetchGdeltArticles('military')).rejects.toThrow(/unavailable/);
    expect(search).toHaveBeenCalledTimes(callsBefore);
  });

  it('serves a persisted entry younger than one hour', async () => {
    persisted.set(persistKey, { key: persistKey, data: { articles: [article], query: 'military', error: '' }, updatedAt: Date.now() - 30 * 60 * 1000 });
    search.mockRejectedValue(new Error('offline'));
    const { fetchGdeltArticles } = await import('@/services/gdelt-intel');
    expect((await fetchGdeltArticles('military'))[0]?.title).toBe('retained');
  });

  it.each([
    ['older than one hour', { updatedAt: Date.now() - 2 * HOUR }],
    ['written without a fetch time', {}],
  ])('does not serve a persisted entry %s', async (_label, stamp) => {
    persisted.set(persistKey, { key: persistKey, data: { articles: [article], query: 'military', error: '' }, ...stamp });
    search.mockRejectedValue(new Error('offline'));
    const { fetchGdeltArticles } = await import('@/services/gdelt-intel');
    await expect(fetchGdeltArticles('military')).rejects.toThrow(/unavailable/);
  });
});
