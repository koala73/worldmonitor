import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCountryIntelBrief } from '../../server/worldmonitor/intelligence/v1/get-country-intel-brief';

const harness = vi.hoisted(() => ({
  entries: new Map<string, unknown>(),
  premium: true,
  writeAvailable: true,
  context: vi.fn(),
  llm: vi.fn(),
}));

vi.mock('../../server/_shared/redis', () => ({
  getCachedJson: async (key: string) => structuredClone(harness.entries.get(key) ?? null),
  setCachedJsonIfAbsent: async (key: string, value: unknown) => {
    if (!harness.writeAvailable || harness.entries.has(key)) return false;
    harness.entries.set(key, structuredClone(value));
    return true;
  },
  cachedFetchJsonWithMeta: async (key: string, _ttl: number, fetcher: () => Promise<unknown>) => ({
    data: harness.entries.has(key) ? structuredClone(harness.entries.get(key)) : await fetcher(),
  }),
  cachedFetchJson: async (key: string, _ttl: number, fetcher: () => Promise<unknown>) => {
    if (harness.entries.has(key)) return structuredClone(harness.entries.get(key));
    const value = await fetcher();
    if (value) harness.entries.set(key, structuredClone(value));
    return value;
  },
}));
vi.mock('../../server/_shared/premium-check', () => ({ isCallerPremium: async () => harness.premium }));
vi.mock('../../server/_shared/llm', () => ({ callLlm: (...args: unknown[]) => harness.llm(...args) }));
vi.mock('../../server/worldmonitor/intelligence/v1/_country-brief-evidence', () => ({ buildCountryBriefEvidence: async () => [], readCountryAirportNotams: async () => [] }));
vi.mock('../../server/worldmonitor/intelligence/v1/_country-brief-context', async importOriginal => ({
  ...await importOriginal<object>(),
  fetchSharedCountryContext: (...args: unknown[]) => harness.context(...args),
}));

const source = {
  title: 'France announces new energy policy', source: 'Server wire',
  url: 'https://example.com/accepted', publishedAt: '2026-10-19T10:00:00Z',
};
const completion = JSON.stringify({
  situation: [{ text: source.title, sources: [1], evidence: [] }],
  implications: [], risks: [], outlook: [], watch: [],
});

function request(lang = 'en', context = '', framework = '') {
  const params = new URLSearchParams({ lang, context });
  return getCountryIntelBrief({ request: new Request(`https://example.test/brief?${params}`) } as never,
    { countryCode: 'FR', framework });
}

describe('shared default accepted country assessment', () => {
  beforeEach(() => {
    harness.entries.clear();
    harness.premium = true;
    harness.writeAvailable = true;
    harness.context.mockReset().mockResolvedValue({ contextSnapshot: 'Shared server context', sources: [source] });
    harness.llm.mockReset().mockResolvedValue({ content: completion, model: 'test-model' });
  });

  it.each(['en', 'fr'])('returns the same accepted text, citations and original time to default %s callers', async lang => {
    if (lang !== 'en') harness.llm.mockResolvedValue({ content: 'France announces new energy policy [1].', model: 'test-model' });
    const first = await request(lang);
    expect(first.brief).toContain(source.title);
    expect(first.sources).toEqual([source]);
    expect(first.generatedAt).toBeGreaterThan(0);
    harness.context.mockResolvedValue({ contextSnapshot: 'Later snapshot', sources: [] });
    const second = await request(lang);
    expect(second).toEqual(first);
    expect(harness.llm).toHaveBeenCalledTimes(1);
    expect(harness.context).toHaveBeenCalledTimes(1);
  });

  it('does not generate an ungrounded non-English default when shared context is unavailable', async () => {
    harness.context.mockResolvedValue({ contextSnapshot: '', sources: [] });
    const result = await request('fr');
    expect(result.brief).toBe('');
    expect(result.sources).toEqual([]);
    expect(harness.llm).not.toHaveBeenCalled();
  });

  it('separates explicit framework assessments without overwriting the default', async () => {
    const accepted = await request();
    await request('en', 'Personalized infrastructure context', 'Focus on energy.');
    expect(harness.llm).toHaveBeenCalledTimes(2);
    expect(harness.llm.mock.calls[1]![0].systemAppend).toBe('Focus on energy.');
    expect(await request()).toEqual(accepted);
    expect(harness.llm).toHaveBeenCalledTimes(2);
  });

  it('converges independent cold-cache generators on the first accepted artifact', async () => {
    const pending: Array<(value: { content: string; model: string }) => void> = [];
    harness.llm.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
    const first = request();
    const second = request();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1]!({ content: completion, model: 'winning-model' });
    const accepted = await second;
    pending[0]!({ content: completion, model: 'losing-model' });
    expect(await first).toEqual(accepted);
    expect(accepted.model).toBe('winning-model');
    expect(await request()).toEqual(accepted);
  });

  it('withholds an unaccepted default when shared storage cannot confirm a write', async () => {
    harness.writeAvailable = false;
    const result = await request();
    expect(result.brief).toBe('');
    expect(result.sources).toEqual([]);
    expect(harness.entries.size).toBe(0);
  });
});
