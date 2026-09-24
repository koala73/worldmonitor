import { beforeAll, describe, expect, it } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import { InsightsPanel } from '@/components/InsightsPanel';
import type { ServerInsightStory } from '@/services/insights-loader';

beforeAll(async () => {
  await initTestI18n();
});

type StoryRenderer = { renderServerStories(stories: ServerInsightStory[], sentiments: null): string };

function story(overrides: Partial<ServerInsightStory>): ServerInsightStory {
  return {
    primaryTitle: 'Headline',
    primarySource: 'Reuters World',
    primaryLink: 'https://example.com/story',
    pubDate: '2026-09-24T00:00:00.000Z',
    sourceCount: 1,
    uniqueSourceCount: 1,
    importanceScore: 50,
    velocity: { level: 'normal', sourcesPerHour: 0 },
    isAlert: false,
    category: 'general',
    threatLevel: 'low',
    ...overrides,
  } as ServerInsightStory;
}

function flags(stories: ServerInsightStory[]): Array<string | null> {
  const renderer = Object.create(InsightsPanel.prototype) as StoryRenderer;
  const host = document.createElement('div');
  host.innerHTML = renderer.renderServerStories(stories, null);
  return [...host.children].map((row) => row.querySelector('.corroboration-flag')?.textContent ?? null);
}

describe('InsightsPanel server stories carry the corroboration pill (#6419)', () => {
  it('flags one publisher and low-tier-only coverage, and trusts the digest count', () => {
    expect(flags([
      story({ primaryTitle: 'one newsroom', sources: ['Reuters World', 'Reuters US'] }),
      story({ primaryTitle: 'aggregators', sources: ['The Verge', 'Hacker News'] }),
      story({ primaryTitle: 'mixed', sources: ['The Verge', 'BBC World'] }),
      story({ primaryTitle: 'capped', sources: ['Reuters World'], corroborationCount: 3 }),
    ])).toEqual(['Single publisher', 'Low-tier sources only', null, null]);
  });
});
