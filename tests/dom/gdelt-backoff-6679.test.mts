/**
 * #6679 — GdeltIntelPanel must distinguish authoritative renders from cached
 * topic replays when it clears retry state.
 *
 * #6587 routed the panel's success writes through the full error-state clear,
 * and #6678's setContent* migration entrenched it: every content write resets
 * `retryAttempt` to 0. A cached topic replay does not prove recovery:
 *
 *   Switching to a CACHED topic. The topic tabs are siblings of
 *      `this.content`, so they stay clickable while a topic is erroring;
 *      replaying another topic's cache says nothing about the failing fetch.
 *
 * An empty-articles render, however, is authoritative content. It must clear
 * the chip, countdown, and backoff just as a non-empty recovery does.
 *
 * The cached replay still clears the chip/countdown but leaves the exponential
 * backoff rung alone. Authoritative renders reset it and cancel any stale
 * retry callback.
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
  header: HTMLElement;
  content: HTMLElement;
  retryAttempt: number;
  retryCountdownTimer: ReturnType<typeof setInterval> | null;
  topicData: Map<string, { articles: unknown[]; fetchedAt: Date }>;
  timelineData: Map<string, unknown>;
  showError(message?: string, onRetry?: () => void, autoRetrySeconds?: number): void;
  renderArticles(articles: unknown[]): void;
  selectTopic(topic: unknown): void;
}

function internals(panel: GdeltIntelPanel): PanelInternals {
  return panel as unknown as PanelInternals;
}

function article(url: string) {
  return { url, title: 'Story', source: 'example.com', date: new Date().toISOString(), tone: 0 };
}

function hasErrorChip(state: PanelInternals): boolean {
  return state.header.classList.contains('panel-header-error');
}

function establishErrorState(state: PanelInternals) {
  const retry = vi.fn();
  state.retryAttempt = 3;
  state.showError('boom', retry, 2);

  expect(hasErrorChip(state), 'non-vacuity: the error chip is visible').toBe(true);
  expect(state.content.querySelector('.panel-error-countdown')?.textContent).toMatch(/\(2s\)/);
  expect(state.retryCountdownTimer, 'non-vacuity: the error retry timer is armed').not.toBeNull();

  return { retry, retryRung: state.retryAttempt };
}

async function expectErrorUiCleared(state: PanelInternals, retry: ReturnType<typeof vi.fn>): Promise<void> {
  expect(hasErrorChip(state)).toBe(false);
  expect(state.content.querySelector('.panel-error-countdown')).toBeNull();
  expect(state.retryCountdownTimer).toBeNull();

  await vi.advanceTimersByTimeAsync(30_000);
  expect(retry, 'the cleared countdown must not fire its stale callback').not.toHaveBeenCalled();
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
  it('an authoritative empty render clears the error state and resets the rung', async () => {
    const panel = await newPanel();
    const state = internals(panel);
    const { retry } = establishErrorState(state);

    state.renderArticles([]);

    expect(state.content.querySelector('.empty-state'), 'non-vacuity: the empty state painted').not.toBeNull();
    await expectErrorUiCleared(state, retry);
    expect(state.retryAttempt, 'an authoritative empty result resets the rung').toBe(0);
    panel.destroy();
  });

  it('a non-empty render is a proven recovery and resets the rung', async () => {
    const panel = await newPanel();
    const state = internals(panel);
    const { retry } = establishErrorState(state);

    state.renderArticles([article('https://example.com/a')]);

    expect(state.content.querySelector('.gdelt-intel-articles')).not.toBeNull();
    await expectErrorUiCleared(state, retry);
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
    const { retry, retryRung } = establishErrorState(state);

    state.selectTopic(otherTopic);

    expect(state.content.querySelector('.gdelt-intel-articles'), 'non-vacuity: the cached articles painted').not.toBeNull();
    await expectErrorUiCleared(state, retry);
    expect(state.retryAttempt, 'a cache replay preserves the prior rung').toBe(retryRung);
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
    const { retry } = establishErrorState(state);

    state.selectTopic(otherTopic);
    await vi.advanceTimersByTimeAsync(0);

    expect(state.content.querySelector('.gdelt-intel-articles')).not.toBeNull();
    await expectErrorUiCleared(state, retry);
    expect(state.retryAttempt, 'a fresh successful fetch resets the ladder').toBe(0);
    panel.destroy();
  });
});
