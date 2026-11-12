/**
 * The AI Insights brief heading names where the brief came from.
 *
 * `scripts/seed-insights.mjs` seeds the server `insights` snapshot from the
 * variant=full digest only, so its `worldBrief` is the global geopolitics
 * brief on every host. The tech, commodity and energy hosts rendered it under
 * "TECH BRIEF", "COMMODITY BRIEF" and "ENERGY BRIEF" because the heading was
 * chosen from SITE_VARIANT alone. Only the client pipeline runs the
 * variant-specific prompt, so only a brief it generated earns a variant
 * heading. The persistent cache key is shared by both paths, so the source
 * must survive a cache round trip in both directions.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

const {
  variant,
  cacheStore,
  mockGetServerInsights,
  mockFetchServerInsights,
  mockGenerateSummary,
} = vi.hoisted(() => ({
  variant: { value: 'tech' },
  cacheStore: new Map<string, { data: unknown; updatedAt: number }>(),
  mockGetServerInsights: vi.fn(),
  mockFetchServerInsights: vi.fn(),
  mockGenerateSummary: vi.fn(),
}));

vi.mock('@/config', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/config')>(),
  get SITE_VARIANT() { return variant.value; },
}));

vi.mock('@/services/persistent-cache', () => ({
  getPersistentCache: vi.fn(async (key: string) => cacheStore.get(key) ?? null),
  setPersistentCache: vi.fn(async (key: string, data: unknown, updatedAt = Date.now()) => {
    cacheStore.set(key, { data, updatedAt });
  }),
  deletePersistentCache: vi.fn(async (key: string) => { cacheStore.delete(key); }),
  deletePersistentCacheByPrefix: vi.fn(),
}));

vi.mock('@/services/insights-loader', () => ({
  getServerInsights: mockGetServerInsights,
  fetchServerInsights: mockFetchServerInsights,
  MAX_AGE_MS: 3_600_000,
}));

vi.mock('@/services/ml-worker', () => ({
  mlWorker: { isAvailable: false, classifySentiment: vi.fn(async () => null) },
}));

vi.mock('@/services/summarization', () => ({ generateSummary: mockGenerateSummary }));

vi.mock('@/services/parallel-analysis', () => ({
  parallelAnalysis: {
    analyzeHeadlines: vi.fn(async () => ({
      timestamp: Date.now(),
      totalHeadlines: 0,
      analyzed: [],
      topByConsensus: [],
      topByDisagreement: [],
      missedByKeywords: [],
      perspectiveCorrelations: {},
    })),
  },
}));

import { InsightsPanel } from '@/components/InsightsPanel';
import type { ClusteredEvent } from '@/types';
import type { ServerInsights } from '@/services/insights-loader';

const CONTENT_DEBOUNCE_MS = 150;
const CACHE_KEY = 'summary:world-brief';
const SERVER_BRIEF = 'Russia and Ukraine traded blame for cyber attacks as a ceasefire ended [1].';
const CLIENT_BRIEF = 'Nvidia and TSMC lifted AI accelerator guidance as cloud capex rose [1].';

const VARIANT_HEADINGS = [
  { variant: 'tech', heading: 'TECH BRIEF' },
  { variant: 'commodity', heading: 'COMMODITY BRIEF' },
  { variant: 'energy', heading: 'ENERGY BRIEF' },
] as const;

function serverInsights(): ServerInsights {
  return {
    worldBrief: SERVER_BRIEF,
    worldBriefSources: [{ title: 'Reuters report', source: 'Reuters', url: 'https://example.com/a' }],
    briefProvider: 'test',
    status: 'ok',
    topStories: [],
    generatedAt: new Date().toISOString(),
    clusterCount: 3,
    multiSourceCount: 2,
    fastMovingCount: 1,
  } as ServerInsights;
}

function clusters(): ClusteredEvent[] {
  const lastUpdated = new Date();
  const base = {
    primarySource: 'Reuters',
    primaryLink: 'https://example.com/chips',
    sourceCount: 4,
    uniquePublisherCount: 3,
    topSources: [],
    allItems: [],
    firstSeen: lastUpdated,
    lastUpdated,
    isAlert: true,
  };
  return [
    { ...base, id: 'c1', primaryTitle: 'Nvidia raises AI accelerator guidance on cloud demand' },
    { ...base, id: 'c2', primaryTitle: 'TSMC lifts capex plan as AI chip orders climb' },
  ] as unknown as ClusteredEvent[];
}

function contentOf(panel: object): HTMLElement {
  return (panel as unknown as { content: HTMLElement }).content;
}

function headingOf(panel: object): string {
  return contentOf(panel).querySelector('.insights-brief .insights-section-title')?.textContent?.trim() ?? '';
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
  vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  vi.useFakeTimers();
  variant.value = 'tech';
  cacheStore.clear();
  mockGetServerInsights.mockReset().mockReturnValue(null);
  mockFetchServerInsights.mockReset().mockResolvedValue(null);
  mockGenerateSummary.mockReset().mockResolvedValue({
    summary: CLIENT_BRIEF,
    provider: 'test',
    model: 'test',
    cached: false,
  });
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('AI Insights brief heading follows the brief source', () => {
  for (const { variant: v, heading } of VARIANT_HEADINGS) {
    describe(`${v} variant`, () => {
      beforeEach(() => { variant.value = v; });

      it('labels the server snapshot WORLD BRIEF', async () => {
        mockGetServerInsights.mockReturnValue(serverInsights());
        const panel = new InsightsPanel();
        await settle();
        await panel.updateInsights(clusters());
        await settle();

        expect(contentOf(panel).querySelector('.insights-brief-text')?.textContent).toContain('Russia and Ukraine');
        expect(headingOf(panel)).toContain('WORLD BRIEF');
        expect(headingOf(panel)).not.toContain(heading);
        panel.destroy();
      });

      it('labels the early bootstrap paint WORLD BRIEF', async () => {
        mockGetServerInsights.mockReturnValue(serverInsights());
        const panel = new InsightsPanel();
        await settle();

        expect(contentOf(panel).querySelector('.insights-brief-text')?.textContent).toContain('Russia and Ukraine');
        expect(headingOf(panel)).toContain('WORLD BRIEF');
        panel.destroy();
      });

      it(`labels a brief the client pipeline generated ${heading}`, async () => {
        const panel = new InsightsPanel();
        await settle();
        await panel.updateInsights(clusters());
        await settle();

        expect(mockGenerateSummary).toHaveBeenCalledTimes(1);
        expect(contentOf(panel).querySelector('.insights-brief-text')?.textContent).toContain('Nvidia and TSMC');
        expect(headingOf(panel)).toContain(heading);
        panel.destroy();
      });
    });
  }

  it('keeps WORLD BRIEF on a cached server brief painted on the next visit', async () => {
    mockGetServerInsights.mockReturnValue(serverInsights());
    const first = new InsightsPanel();
    await settle();
    await first.updateInsights(clusters());
    await settle();
    first.destroy();
    expect(cacheStore.has(CACHE_KEY)).toBe(true);

    mockGetServerInsights.mockReturnValue(null);
    const next = new InsightsPanel();
    await settle();

    expect(contentOf(next).querySelector('.insights-brief-text')?.textContent).toContain('Russia and Ukraine');
    expect(headingOf(next)).toContain('WORLD BRIEF');
    next.destroy();
  });

  it('keeps WORLD BRIEF when the client pipeline reuses a cached server brief inside the cooldown', async () => {
    mockGetServerInsights.mockReturnValue(serverInsights());
    const panel = new InsightsPanel();
    await settle();
    await panel.updateInsights(clusters());
    await settle();

    mockGetServerInsights.mockReturnValue(null);
    await panel.updateInsights(clusters());
    await settle();

    expect(mockGenerateSummary, 'the cooldown must reuse the cached server brief').not.toHaveBeenCalled();
    expect(contentOf(panel).querySelector('.insights-brief-text')?.textContent).toContain('Russia and Ukraine');
    expect(headingOf(panel)).toContain('WORLD BRIEF');
    panel.destroy();
  });

  it('keeps the variant heading on a cached client brief painted on the next visit', async () => {
    const first = new InsightsPanel();
    await settle();
    await first.updateInsights(clusters());
    await settle();
    first.destroy();

    const next = new InsightsPanel();
    await settle();

    expect(contentOf(next).querySelector('.insights-brief-text')?.textContent).toContain('Nvidia and TSMC');
    expect(headingOf(next)).toContain('TECH BRIEF');
    next.destroy();
  });

  it('labels a cached brief with no recorded source WORLD BRIEF', async () => {
    cacheStore.set(CACHE_KEY, { data: { summary: SERVER_BRIEF, sources: [] }, updatedAt: Date.now() });
    const panel = new InsightsPanel();
    await settle();

    expect(contentOf(panel).querySelector('.insights-brief-text')?.textContent).toContain('Russia and Ukraine');
    expect(headingOf(panel)).toContain('WORLD BRIEF');
    panel.destroy();
  });

  it('keeps WORLD BRIEF on the full variant for both sources', async () => {
    variant.value = 'full';
    mockGetServerInsights.mockReturnValue(serverInsights());
    const server = new InsightsPanel();
    await settle();
    await server.updateInsights(clusters());
    await settle();
    expect(headingOf(server)).toContain('WORLD BRIEF');
    server.destroy();

    cacheStore.clear();
    mockGetServerInsights.mockReturnValue(null);
    const client = new InsightsPanel();
    await settle();
    await client.updateInsights(clusters());
    await settle();
    expect(mockGenerateSummary).toHaveBeenCalledTimes(1);
    expect(headingOf(client)).toContain('WORLD BRIEF');
    client.destroy();
  });
});
