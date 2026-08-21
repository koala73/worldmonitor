/**
 * #6679 — GdeltIntelPanel must not reset the retry backoff on renders that are
 * not proven recoveries.
 *
 * #6587 routed the panel's success writes through the full error-state clear,
 * and #6678's setContent* migration entrenched it: every content write resets
 * `retryAttempt` to 0. Two of the panel's renders prove no recovery:
 *
 *   A. Switching to a CACHED topic. The topic tabs are siblings of
 *      `this.content`, so they stay clickable while a topic is erroring;
 *      replaying another topic's cache says nothing about the failing fetch.
 *   B. The empty-articles render. `fetchGdeltArticles` reports RPC failure as
 *      a resolved `[]` (circuit breaker + empty fallback), so an outage
 *      arrives looking like a successful empty list.
 *
 * Both must clear the chip/countdown (the visible error UI) while leaving the
 * exponential-backoff rung alone; a real recovery (fresh fetch, non-empty
 * articles) must still reset it. LATENT today — the panel's own error path is
 * currently unreachable (see the issue) — pinned now so making it reachable
 * cannot silently ship a 15s-floor retry hammer.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

const { mockFetchTopicIntelligence, mockFetchTopicTimeline } = vi.hoisted(() => ({
  mockFetchTopicIntelligence: vi.fn(),
  mockFetchTopicTimeline: vi.fn(),
}));

vi.mock('@/services/gdelt-intel', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/gdelt-intel')>(),
  fetchTopicIntelligence: mockFetchTopicIntelligence,
  fetchTopicTimeline: mockFetchTopicTimeline,
}));

import { GdeltIntelPanel } from '@/components/GdeltIntelPanel';
import { getIntelTopics } from '@/services/gdelt-intel';

interface PanelInternals {
  element: HTMLElement;
  content: HTMLElement;
  retryAttempt: number;
  topicData: Map<string, { articles: unknown[]; fetchedAt: Date }>;
  timelineData: Map<string, unknown>;
  renderArticles(articles: unknown[]): void;
  selectTopic(topic: unknown): void;
}

function internals(panel: GdeltIntelPanel): PanelInternals {
  return panel as unknown as PanelInternals;
}

function article(url: string) {
  return { url, title: 'Story', source: 'example.com', date: new Date().toISOString(), tone: 0 };
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  vi.useFakeTimers();
  mockFetchTopicIntelligence.mockResolvedValue({ articles: [], fetchedAt: new Date() });
  mockFetchTopicTimeline.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

async function newPanel(): Promise<GdeltIntelPanel> {
  const panel = new GdeltIntelPanel();
  document.body.appendChild(internals(panel).element);
  await vi.advanceTimersByTimeAsync(0);
  return panel;
}

describe('GdeltIntelPanel retry backoff (#6679)', () => {
  it('instance B: the swallowed-failure empty render keeps the rung and still clears the error chip', async () => {
    const panel = await newPanel();
    const state = internals(panel);
    state.retryAttempt = 3;

    state.renderArticles([]);

    expect(state.content.querySelector('.empty-state'), 'non-vacuity: the empty state painted').not.toBeNull();
    expect(state.retryAttempt, 'an empty payload proves no recovery; the rung must survive').toBe(3);
    panel.destroy();
  });

  it('a non-empty render is a proven recovery and resets the rung', async () => {
    const panel = await newPanel();
    const state = internals(panel);
    state.retryAttempt = 3;

    state.renderArticles([article('https://example.com/a')]);

    expect(state.content.querySelector('.gdelt-intel-articles')).not.toBeNull();
    expect(state.retryAttempt, 'fresh articles ARE a recovery; the reset must not regress').toBe(0);
    panel.destroy();
  });

  it('instance A: switching to a cached topic replays the cache without resetting the rung', async () => {
    const panel = await newPanel();
    const state = internals(panel);
    const otherTopic = getIntelTopics()[1]!;
    state.topicData.set(otherTopic.id, {
      articles: [article('https://example.com/cached')],
      fetchedAt: new Date(),
    });
    state.retryAttempt = 3;

    state.selectTopic(otherTopic);

    expect(state.content.querySelector('.gdelt-intel-articles'), 'non-vacuity: the cached articles painted').not.toBeNull();
    expect(state.retryAttempt, 'a cache replay proves nothing about the failing fetch').toBe(3);
    panel.destroy();
  });

  it('a cache MISS on topic switch goes through the live fetch, which stays a real recovery path', async () => {
    mockFetchTopicIntelligence.mockResolvedValue({
      articles: [article('https://example.com/fresh')],
      fetchedAt: new Date(),
    });
    const panel = await newPanel();
    const state = internals(panel);
    const otherTopic = getIntelTopics()[1]!;
    state.retryAttempt = 3;

    state.selectTopic(otherTopic);
    await vi.advanceTimersByTimeAsync(0);

    expect(state.content.querySelector('.gdelt-intel-articles')).not.toBeNull();
    expect(state.retryAttempt, 'a fresh successful fetch resets the ladder').toBe(0);
    panel.destroy();
  });
});
