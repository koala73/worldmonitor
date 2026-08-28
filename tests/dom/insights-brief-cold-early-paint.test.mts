/**
 * #7118: cold visitors must get the World Brief from the bootstrap payload.
 *
 * The World Brief is the field LCP element on ~38% of /dashboard desktop views
 * and paints at p75 ~3.5s, against ~0.8s for the bootstrap skeleton copy it
 * displaces — two thirds of the field LCP regression diagnosed in #7113
 * (docs/perf/field-lcp-dashboard-2026-08-24.md).
 *
 * #4890 added an early paint, but it reads ONLY the IndexedDB persistent
 * cache, so it helps repeat visitors and does nothing for cold ones — even
 * though `insights` rides the FAST bootstrap tier
 * (api/_bootstrap-tier-keys.js:61,180) and `getServerInsights()` already has
 * `worldBrief` in hand.
 *
 * These are behavioural tests, not source greps: they construct the panel and
 * assert on rendered DOM. Lives under tests/dom/ because `Panel` needs a DOM
 * and `@/services/i18n`'s `import.meta.glob` graph, both unreachable from the
 * `tsx --test` profile.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

const {
  mockGetPersistentCache,
  mockSetPersistentCache,
  mockDeletePersistentCache,
  mockGetServerInsights,
  mockFetchServerInsights,
  mockClassifySentiment,
  mlWorkerStub,
} = vi.hoisted(() => {
  const mockClassifySentiment = vi.fn();
  return {
    mockGetPersistentCache: vi.fn(),
    mockSetPersistentCache: vi.fn(),
    mockDeletePersistentCache: vi.fn(),
    mockGetServerInsights: vi.fn(),
    mockFetchServerInsights: vi.fn(),
    mockClassifySentiment,
    mlWorkerStub: { isAvailable: true, classifySentiment: mockClassifySentiment },
  };
});

vi.mock('@/services/persistent-cache', () => ({
  getPersistentCache: mockGetPersistentCache,
  setPersistentCache: mockSetPersistentCache,
  deletePersistentCache: mockDeletePersistentCache,
  deletePersistentCacheByPrefix: vi.fn(),
}));

vi.mock('@/services/insights-loader', () => ({
  getServerInsights: mockGetServerInsights,
  fetchServerInsights: mockFetchServerInsights,
  MAX_AGE_MS: 3_600_000,
}));

vi.mock('@/services/ml-worker', () => ({ mlWorker: mlWorkerStub }));

import { InsightsPanel } from '@/components/InsightsPanel';
import type { ServerInsights } from '@/services/insights-loader';

const CONTENT_DEBOUNCE_MS = 150;

const BRIEF = 'SITUATION NOW\nRussian strikes on Kyiv continued for a third night [1].';
const BRIEF_WITH_SOURCE_GAP = 'SITUATION NOW\nReuters reported the second source event [2].';

function serverInsights(overrides: Partial<ServerInsights> = {}): ServerInsights {
  return {
    worldBrief: BRIEF,
    worldBriefSources: [{ title: 'Reuters report', source: 'Reuters', url: 'https://example.com/a' }],
    briefProvider: 'test',
    status: 'ok',
    topStories: [],
    generatedAt: new Date().toISOString(),
    clusterCount: 3,
    multiSourceCount: 2,
    fastMovingCount: 1,
    ...overrides,
  } as ServerInsights;
}

function contentOf(panel: object): HTMLElement {
  return (panel as unknown as { content: HTMLElement }).content;
}

/** Let the constructor's floating early-paint promise settle, then commit the debounce. */
async function flushEarlyPaint(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  vi.useFakeTimers();
  mockGetPersistentCache.mockReset();
  mockSetPersistentCache.mockReset().mockResolvedValue(undefined);
  mockDeletePersistentCache.mockReset().mockResolvedValue(undefined);
  mockGetServerInsights.mockReset();
  mockFetchServerInsights.mockReset();
  mockClassifySentiment.mockReset();
  mlWorkerStub.isAvailable = true;
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('cold-visitor early brief paint (#7118)', () => {
  it('paints the bootstrap world brief when the persistent cache is empty', async () => {
    // A cold visitor: nothing in IndexedDB, but the FAST bootstrap tier landed.
    mockGetPersistentCache.mockResolvedValue(null);
    mockGetServerInsights.mockReturnValue(serverInsights());

    const panel = new InsightsPanel();
    await flushEarlyPaint();

    const brief = contentOf(panel).querySelector('.insights-brief-text');
    expect(brief, 'the cold visitor must get the bootstrap brief at construction time').not.toBeNull();
    expect(brief?.textContent).toContain('Russian strikes on Kyiv');
    panel.destroy();
  });

  it('preserves source positions for citations when an earlier source has no URL', async () => {
    mockGetPersistentCache.mockResolvedValue(null);
    mockGetServerInsights.mockReturnValue(serverInsights({
      worldBrief: BRIEF_WITH_SOURCE_GAP,
      worldBriefSources: [
        { title: 'Missing-link source', source: 'Unknown', url: '' },
        { title: 'Reuters report', source: 'Reuters', url: 'https://example.com/second' },
      ],
    }));
    mockClassifySentiment.mockResolvedValue(null);

    const panel = new InsightsPanel();
    await flushEarlyPaint();

    const earlyCitation = contentOf(panel).querySelector<HTMLAnchorElement>('.cb-citation');
    expect(earlyCitation?.textContent).toBe('[2]');
    expect(earlyCitation?.href).toBe('https://example.com/second');

    await panel.updateInsights([]);
    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);

    const fullCitation = contentOf(panel).querySelector<HTMLAnchorElement>('.cb-citation');
    expect(fullCitation?.textContent).toBe('[2]');
    expect(fullCitation?.href).toBe('https://example.com/second');
    panel.destroy();
  });

  it('still prefers the persistent cache when one exists', async () => {
    mockGetPersistentCache.mockResolvedValue({
      data: { summary: 'CACHED BRIEF from the previous visit.', sources: [] },
      updatedAt: Date.now(),
    });
    mockGetServerInsights.mockReturnValue(serverInsights());

    const panel = new InsightsPanel();
    await flushEarlyPaint();

    const text = contentOf(panel).querySelector('.insights-brief-text')?.textContent ?? '';
    expect(text, 'the cache read must win — it is the cheaper path and #4890 owns it').toContain('CACHED BRIEF');
    expect(mockGetServerInsights, 'no bootstrap read is needed once the cache hits').not.toHaveBeenCalled();
    panel.destroy();
  });

  it('paints nothing when the cache misses and the bootstrap payload has not landed', async () => {
    mockGetPersistentCache.mockResolvedValue(null);
    mockGetServerInsights.mockReturnValue(null);

    const panel = new InsightsPanel();
    await flushEarlyPaint();

    expect(contentOf(panel).querySelector('.insights-brief-text')).toBeNull();
    panel.destroy();
  });

  it('does not clobber a real update that started during the async cache read', async () => {
    let releaseCache!: (value: null) => void;
    mockGetPersistentCache.mockReturnValue(new Promise<null>((res) => { releaseCache = res; }));
    mockGetServerInsights.mockReturnValue(serverInsights());

    const panel = new InsightsPanel();
    // A real update pass starts while the early paint is awaiting the cache.
    void panel.updateInsights([]);
    releaseCache(null);
    await flushEarlyPaint();

    // The early paint must have bailed on the post-await generation re-check
    // rather than landing stale brief-only content over the real pass.
    const badge = (panel as unknown as { element: HTMLElement }).element
      .querySelector('.panel-data-badge')?.textContent ?? '';
    expect(badge.toLowerCase()).not.toContain('cached');
    panel.destroy();
  });
});

describe('server render does not hold the brief behind sentiment (#7118)', () => {
  it('paints the brief before ML sentiment classification resolves', async () => {
    mockGetPersistentCache.mockResolvedValue(null);
    // The bootstrap payload lands BETWEEN panel construction and the first
    // update — a real cold sequence, and the only one that isolates this
    // paint from the constructor's early paint (#7118 U1). Without the
    // `Once`, the early paint would satisfy the assertion and the test would
    // pass no matter what updateFromServer does.
    mockGetServerInsights.mockReturnValueOnce(null).mockReturnValue(serverInsights());

    let releaseSentiment!: (value: null) => void;
    mockClassifySentiment.mockReturnValue(new Promise<null>((res) => { releaseSentiment = res; }));

    const panel = new InsightsPanel();
    await flushEarlyPaint();
    expect(
      contentOf(panel).querySelector('.insights-brief-text'),
      'guard: the constructor must NOT have painted, or this test proves nothing',
    ).toBeNull();

    // updateInsights → updateFromServer, which awaits classifySentiment.
    const pending = panel.updateInsights([]);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);

    const brief = contentOf(panel).querySelector('.insights-brief-text');
    expect(brief, 'the brief is already in hand — it must not wait on the sentiment worker').not.toBeNull();
    expect(brief?.textContent).toContain('Russian strikes on Kyiv');

    releaseSentiment(null);
    await pending;
    panel.destroy();
  });

  it('shows the brief, not a progress bar, while a REFRESH waits on sentiment', async () => {
    // updateFromServer already calls setProgress() twice before the sentiment
    // await, so a refresh replaces live content with a progress bar no matter
    // what this test does. The pre-sentiment paint therefore never costs the
    // user rendered content — it upgrades that window from a progress bar to
    // the brief. Pin that, so a future change cannot turn this into the
    // content-clobbering refetch bug tests/dom/china-panel-refetch.test.mts
    // guards the China panels against.
    mockGetPersistentCache.mockResolvedValue(null);
    mockGetServerInsights.mockReturnValue(serverInsights());
    mockClassifySentiment.mockResolvedValue(null);

    const panel = new InsightsPanel();
    await flushEarlyPaint();

    // First pass renders fully.
    await panel.updateInsights([]);
    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);
    expect(contentOf(panel).querySelector('.insights-stats')).not.toBeNull();

    // Refresh, with sentiment now hanging.
    let releaseSentiment!: (value: null) => void;
    mockClassifySentiment.mockReturnValue(new Promise<null>((res) => { releaseSentiment = res; }));
    const pending = panel.updateInsights([]);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);

    expect(
      contentOf(panel).querySelector('.insights-brief-text'),
      'the refresh window must show the brief',
    ).not.toBeNull();
    expect(
      contentOf(panel).querySelector('.insights-progress'),
      'the brief must have superseded the progress bar, not landed beside it',
    ).toBeNull();

    releaseSentiment(null);
    await pending;
    panel.destroy();
  });
});
