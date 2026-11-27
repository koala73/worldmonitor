import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { SocialVelocityPanel } from '@/components/SocialVelocityPanel';

import { initTestI18n } from './helpers/i18n.mts';

let panel: SocialVelocityPanel | undefined;

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  vi.useRealTimers();
  panel?.destroy();
  panel = undefined;
  document.body.innerHTML = '';
});

describe('Social Velocity footer', () => {
  it('describes the score the relay computes: log-scaled net votes × % upvoted × recency', () => {
    vi.useFakeTimers();
    panel = new SocialVelocityPanel();
    document.body.appendChild(panel.getElement());
    panel.updateData([{
      id: 'p1',
      title: 'Ceasefire talks resume',
      subreddit: 'worldnews',
      url: 'https://reddit.com/r/worldnews/comments/p1/x/',
      score: 1200,
      upvoteRatio: 0.9,
      numComments: 300,
      velocityScore: 63.8,
      createdAt: Date.now() - 3_600_000,
    }]);
    vi.runAllTimers();

    expect(panel.getElement().textContent).toContain('Reddit · velocity = net votes (log scale) × % upvoted × recency');
  });
});
