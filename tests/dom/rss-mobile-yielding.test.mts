// Runtime proof of the mobile feed-parse yielding and the no-store cache rule
// in src/services/rss.ts (#8690, replacing the source-text checks in
// rss-mobile-yielding.test.mts).
//
// On mobile, several completed feed requests must not parse XML back to back
// in one post-hydration task (#5165): parses are queued behind a yield, a
// yield follows the parse, and a yield separates the per-item mapping. Desktop
// keeps its concurrent path with no yields. Separately, a relay response that
// says `cache-control: no-store` must not be kept in either feed cache.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  mobile: false,
  events: [] as string[],
  fetchWithProxy: vi.fn(),
  setPersistentCache: vi.fn<(key: string, data: unknown) => Promise<void>>(async () => undefined),
}));

vi.mock('@/utils', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/utils')>(),
  fetchWithProxy: (...args: unknown[]) => state.fetchWithProxy(...args),
  isMobileDevice: () => state.mobile,
}));
vi.mock('@/utils/after-paint', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/utils/after-paint')>(),
  yieldToMain: async () => {
    state.events.push('yield');
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  },
}));
vi.mock('@/services/persistent-cache', () => ({
  getPersistentCache: async () => null,
  setPersistentCache: (key: string, data: unknown) => state.setPersistentCache(key, data),
}));
vi.mock('@/services/trending-keywords', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/trending-keywords')>(),
  ingestHeadlines: () => undefined,
}));
vi.mock('@/services/threat-classifier', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/threat-classifier')>(),
  classifyWithAI: async () => null,
}));
vi.mock('@/services/ai-flow-settings', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/ai-flow-settings')>(),
  isHeadlineMemoryEnabled: () => false,
}));
vi.mock('@/services/ai-classify-queue', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/ai-classify-queue')>(),
  canQueueAiClassification: () => false,
}));

import { fetchFeed } from '@/services/rss';

const ITEMS = 3;
function rss(prefix: string): string {
  const items = Array.from({ length: ITEMS }, (_, i) => `
    <item><title>${prefix} story ${i + 1}</title><link>https://news.example/${prefix}/${i + 1}</link><pubDate>Mon, 19 Oct 2026 10:00:00 GMT</pubDate></item>`).join('');
  return `<?xml version="1.0"?><rss version="2.0"><channel>${items}</channel></rss>`;
}
const respond = (body: string, headers: Record<string, string> = {}) => async () => new Response(body, { status: 200, headers: { 'content-type': 'application/xml', ...headers } });

let unique = 0;
const feed = (name: string) => ({ name: `${name}-${unique}`, url: `https://feeds.example/${name}-${unique}.xml` });

beforeEach(() => {
  unique += 1;
  state.mobile = false;
  state.events.length = 0;
  state.fetchWithProxy.mockReset();
  state.setPersistentCache.mockClear();
  // Record each XML parse in the same event stream as the yields, so the
  // order of parses and yields is observable; the real parser still runs.
  vi.spyOn(DOMParser.prototype, 'parseFromString').mockImplementation((text: string, type: DOMParserSupportedType) => {
    state.events.push('parse');
    return realParse.call(new DOMParser(), text, type);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

// Captured before any spy is installed.
const realParse: DOMParser['parseFromString'] = DOMParser.prototype.parseFromString;

describe('feed parsing on desktop and mobile', () => {
  it('parses concurrently completed desktop feeds without yielding', async () => {
    state.fetchWithProxy.mockImplementationOnce(respond(rss('a'))).mockImplementationOnce(respond(rss('b')));
    const [a, b] = await Promise.all([fetchFeed(feed('desk-a')), fetchFeed(feed('desk-b'))]);
    expect(a.map((i) => i.title)).toEqual(['a story 1', 'a story 2', 'a story 3']);
    expect(b).toHaveLength(ITEMS);
    expect(state.events.filter((e) => e === 'parse')).toHaveLength(2);
    expect(state.events).not.toContain('yield');
  });

  it('serializes mobile parses behind yields and yields between items', async () => {
    state.mobile = true;
    state.fetchWithProxy.mockImplementationOnce(respond(rss('a'))).mockImplementationOnce(respond(rss('b')));
    const [a, b] = await Promise.all([fetchFeed(feed('mob-a')), fetchFeed(feed('mob-b'))]);
    expect(a).toHaveLength(ITEMS);
    expect(b).toHaveLength(ITEMS);
    const parses = state.events.map((e, i) => (e === 'parse' ? i : -1)).filter((i) => i >= 0);
    expect(parses).toHaveLength(2);
    expect(state.events[0]).toBe('yield');
    expect(state.events.slice(parses[0]! + 1, parses[1]!)).toContain('yield');
    // Per feed: one yield before the parse (queue), one after it, and one
    // between each pair of items.
    expect(state.events.filter((e) => e === 'yield')).toHaveLength(2 * (2 + (ITEMS - 1)));
  });
});

describe('no-store relay responses', () => {
  it('keeps a cacheable feed in memory and persists it', async () => {
    const f = feed('cacheable');
    state.fetchWithProxy.mockImplementation(respond(rss('c')));
    await fetchFeed(f);
    await fetchFeed(f);
    expect(state.fetchWithProxy).toHaveBeenCalledTimes(1);
    expect(state.setPersistentCache).toHaveBeenCalledTimes(1);
    expect(state.setPersistentCache.mock.calls[0]?.[0]).toMatch(/^feed:v2:/);
  });

  it('never caches a no-store response in memory or in persistent storage', async () => {
    const f = feed('no-store');
    state.fetchWithProxy.mockImplementation(respond(rss('n'), { 'cache-control': 'private, no-store' }));
    const first = await fetchFeed(f);
    const second = await fetchFeed(f);
    expect(first).toHaveLength(ITEMS);
    expect(second).toHaveLength(ITEMS);
    expect(state.fetchWithProxy).toHaveBeenCalledTimes(2);
    expect(state.setPersistentCache).not.toHaveBeenCalled();
  });
});
