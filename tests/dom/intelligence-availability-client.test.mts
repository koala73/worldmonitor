import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { rpc, hydration } = vi.hoisted(() => ({
  rpc: { listSatellites: vi.fn(), listSecurityAdvisories: vi.fn(), searchGdeltDocuments: vi.fn() },
  hydration: new Map<string, unknown>(),
}));
vi.mock('@/services/generated-rpc-clients', () => ({
  IntelligenceServiceClient: class {
    listSatellites = rpc.listSatellites;
    listSecurityAdvisories = rpc.listSecurityAdvisories;
    searchGdeltDocuments = rpc.searchGdeltDocuments;
  },
}));
vi.mock('@/services/rpc-client', () => ({
  getRpcBaseUrl: () => '',
  createLazyClient: (factory: () => unknown) => { let client: unknown; return () => client ??= factory(); },
}));
vi.mock('@/services/i18n', () => ({ t: (key: string) => key }));
vi.mock('@/services/bootstrap', () => ({
  getHydratedData: (key: string) => { const value = hydration.get(key); hydration.delete(key); return value; },
}));
vi.mock('@/services/data-freshness', () => ({ dataFreshness: { recordUpdate() {}, recordError() {} } }));
vi.mock('@/services/persistent-cache', () => ({
  getPersistentCache: async () => null, setPersistentCache: async () => {},
  deletePersistentCache: async () => {}, deletePersistentCacheByPrefix: async () => {},
}));
vi.mock('@/utils', async () => await import('@/utils/circuit-breaker'));

const INTEL_TOPIC_IDS = ['military', 'cyber', 'nuclear', 'sanctions', 'intelligence', 'maritime'];
const satellite = { id: '25544', name: 'ISS', country: 'US', type: 'station', alt: 0, velocity: 0, inclination: 0, line1: '1 25544U 98067A   19156.50900463  .00003075  00000-0  59442-4 0  9992', line2: '2 25544  51.6433  59.2583 0008217  16.4489 347.6017 15.51174618173442' };
const advisory = { title: 'Travel update', link: 'https://example.com/advice', pubDate: '2026-09-15T00:00:00Z', source: 'FCDO', sourceCountry: 'UK', level: 'caution', country: 'UA' };
const coveredByCountry = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`C${String(i).padStart(3, '0')}`, 'normal']));
const article = (title: string) => ({ title, url: `https://example.com/${title || 'untitled'}`, source: 'example.com', date: '20260915T000000Z', image: '', language: 'English', tone: 0 });
const gdeltTopics = (articlesById: Record<string, unknown[]> = {}) => ({
  topics: INTEL_TOPIC_IDS.map(id => ({ id, articles: articlesById[id] ?? [] })),
});
const MINUTE = 60_000;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-15T00:00:00Z'));
  hydration.clear();
  for (const fn of Object.values(rpc)) fn.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('satellite TLE availability', () => {
  it('retains last-good through failures for at most an hour, then recovers to a cached confirmed empty', async () => {
    const { fetchSatelliteTLEs, getSatelliteStatus } = await import('@/services/satellites');
    rpc.listSatellites.mockResolvedValue({ satellites: [satellite] });
    expect(await fetchSatelliteTLEs()).toHaveLength(1);

    vi.setSystemTime(Date.now() + 11 * MINUTE);
    rpc.listSatellites.mockRejectedValue(new Error('503'));
    expect(await fetchSatelliteTLEs()).toHaveLength(1);
    expect(getSatelliteStatus()).toBe('degraded');
    // A malformed body is a failure too, not a confirmed-empty sky.
    rpc.listSatellites.mockResolvedValue({ satellites: [null] });
    await fetchSatelliteTLEs();
    await fetchSatelliteTLEs();
    expect(getSatelliteStatus()).toBe('cooldown');

    vi.setSystemTime(Date.now() + 60 * MINUTE);
    expect(await fetchSatelliteTLEs()).toBeNull();

    vi.setSystemTime(Date.now() + 11 * MINUTE);
    rpc.listSatellites.mockResolvedValue({ satellites: [] });
    expect(await fetchSatelliteTLEs()).toEqual([]);
    expect(getSatelliteStatus()).toBe('ok');
    const calls = rpc.listSatellites.mock.calls.length;
    expect(await fetchSatelliteTLEs()).toEqual([]);
    expect(rpc.listSatellites).toHaveBeenCalledTimes(calls);
  });

  it('drops an invalid TLE record and keeps the valid ones', async () => {
    const { fetchSatelliteTLEs } = await import('@/services/satellites');
    rpc.listSatellites.mockResolvedValue({ satellites: [satellite, { ...satellite, line1: 'broken' }] });
    const tles = await fetchSatelliteTLEs();
    expect(tles?.map(tle => tle.noradId)).toEqual(['25544']);
  });
});

describe('security advisory availability', () => {
  it('reports unavailable as ok:false, retains last-good for an hour, and recovers to confirmed empty', async () => {
    const { loadAdvisoriesFromServer } = await import('@/services/security-advisories');
    rpc.listSecurityAdvisories.mockRejectedValue(new Error('503'));
    expect(await loadAdvisoriesFromServer()).toEqual({ ok: false, advisories: [] });

    hydration.set('securityAdvisories', { advisories: [{ ...advisory, pubDate: 'bad' }], byCountry: {} });
    rpc.listSecurityAdvisories.mockResolvedValue({ advisories: [advisory], byCountry: coveredByCountry });
    const good = await loadAdvisoriesFromServer();
    expect(good.ok).toBe(true);
    expect(good.advisories[0]?.pubDate.toISOString()).toBe('2026-09-15T00:00:00.000Z');

    vi.setSystemTime(Date.now() + 16 * MINUTE);
    rpc.listSecurityAdvisories.mockResolvedValue({ advisories: [null], byCountry: coveredByCountry });
    expect(await loadAdvisoriesFromServer()).toEqual({ ok: false, advisories: good.advisories });

    vi.setSystemTime(Date.now() + 60 * MINUTE);
    expect(await loadAdvisoriesFromServer()).toEqual({ ok: false, advisories: [] });

    rpc.listSecurityAdvisories.mockResolvedValue({ advisories: [], byCountry: {} });
    expect(await loadAdvisoriesFromServer()).toEqual({ ok: true, advisories: [] });
    const calls = rpc.listSecurityAdvisories.mock.calls.length;
    await loadAdvisoriesFromServer();
    expect(rpc.listSecurityAdvisories).toHaveBeenCalledTimes(calls);
  });

  it('accepts confirmed-empty hydration without an RPC', async () => {
    const { loadAdvisoriesFromServer } = await import('@/services/security-advisories');
    hydration.set('securityAdvisories', { advisories: [], byCountry: {} });
    rpc.listSecurityAdvisories.mockRejectedValue(new Error('offline'));
    expect(await loadAdvisoriesFromServer()).toEqual({ ok: true, advisories: [] });
    expect(rpc.listSecurityAdvisories).not.toHaveBeenCalled();
  });

  it('drops an invalid advisory and keeps the valid ones', async () => {
    const { loadAdvisoriesFromServer } = await import('@/services/security-advisories');
    rpc.listSecurityAdvisories.mockResolvedValue({ advisories: [advisory, { ...advisory, link: '' }], byCountry: coveredByCountry });
    const result = await loadAdvisoriesFromServer();
    expect(result.ok).toBe(true);
    expect(result.advisories.map(a => a.title)).toEqual(['Travel update']);
  });
});

describe('GDELT availability', () => {
  it('error bodies reach the breaker: two failures open cooldown for uncached queries', async () => {
    const { fetchGdeltArticles } = await import('@/services/gdelt-intel');
    rpc.searchGdeltDocuments.mockResolvedValue({ articles: [], query: 'military', error: 'seed-unavailable' });
    await expect(fetchGdeltArticles('military')).rejects.toThrow(/unavailable/);
    await expect(fetchGdeltArticles('cyber')).rejects.toThrow(/unavailable/);
    const calls = rpc.searchGdeltDocuments.mock.calls.length;
    await expect(fetchGdeltArticles('nuclear')).rejects.toThrow(/unavailable/);
    expect(rpc.searchGdeltDocuments).toHaveBeenCalledTimes(calls);
  });

  it('keeps last-good articles within the hour when the seed becomes unavailable', async () => {
    const { fetchGdeltArticles } = await import('@/services/gdelt-intel');
    rpc.searchGdeltDocuments.mockResolvedValue({ articles: [article('first')], query: 'military', error: '' });
    const first = await fetchGdeltArticles('military');
    vi.setSystemTime(Date.now() + 11 * MINUTE);
    rpc.searchGdeltDocuments.mockResolvedValue({ articles: [], query: 'military', error: 'seed-unavailable' });
    expect(await fetchGdeltArticles('military')).toEqual(first);
  });

  it('drops an untitled article from the response and keeps the valid ones', async () => {
    const { fetchGdeltArticles } = await import('@/services/gdelt-intel');
    rpc.searchGdeltDocuments.mockResolvedValue({ articles: [article(''), article('kept')], query: 'military', error: '' });
    expect((await fetchGdeltArticles('military')).map(a => a.title)).toEqual(['kept']);
  });

  it('hydration with one untitled article still serves the topic without an RPC', async () => {
    const { fetchTopicIntelligence, INTEL_TOPICS } = await import('@/services/gdelt-intel');
    hydration.set('gdeltIntel', gdeltTopics({ military: [article(''), article('bootstrap')] }));
    const military = INTEL_TOPICS.find(topic => topic.id === 'military')!;
    expect((await fetchTopicIntelligence(military)).articles.map(a => a.title)).toEqual(['bootstrap']);
    const cyber = INTEL_TOPICS.find(topic => topic.id === 'cyber')!;
    expect((await fetchTopicIntelligence(cyber)).articles).toEqual([]);
    expect(rpc.searchGdeltDocuments).not.toHaveBeenCalled();
  });

  it('unused hydration expires after an hour and an unavailable RPC then throws', async () => {
    const { fetchTopicIntelligence, INTEL_TOPICS } = await import('@/services/gdelt-intel');
    hydration.set('gdeltIntel', gdeltTopics({ cyber: [article('bootstrap')] }));
    await fetchTopicIntelligence(INTEL_TOPICS[0]!);
    vi.setSystemTime(Date.now() + 61 * MINUTE);
    rpc.searchGdeltDocuments.mockRejectedValue(new Error('offline'));
    await expect(fetchTopicIntelligence(INTEL_TOPICS.find(topic => topic.id === 'cyber')!)).rejects.toThrow(/unavailable/);
  });

  it('malformed hydration falls through to a recoverable RPC', async () => {
    const { fetchTopicIntelligence, INTEL_TOPICS } = await import('@/services/gdelt-intel');
    hydration.set('gdeltIntel', { topics: [null] });
    rpc.searchGdeltDocuments.mockResolvedValue({ articles: [article('repaired')], query: 'military', error: '' });
    expect((await fetchTopicIntelligence(INTEL_TOPICS[0]!)).articles[0]?.title).toBe('repaired');
    expect(rpc.searchGdeltDocuments).toHaveBeenCalledTimes(1);
  });
});
