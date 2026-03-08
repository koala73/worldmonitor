import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { MarketData, NewsItem } from '../src/types/index.ts';
import {
  buildDailyMarketBrief,
  shouldRefreshDailyBrief,
} from '../src/services/daily-market-brief.ts';

function makeNewsItem(title: string, source = 'Reuters', publishedAt = '2026-03-08T05:00:00.000Z'): NewsItem {
  return {
    source,
    title,
    link: 'https://example.com/story',
    pubDate: new Date(publishedAt),
    isAlert: false,
  };
}

const markets: MarketData[] = [
  { symbol: 'AAPL', name: 'Apple', display: 'AAPL', price: 212.45, change: 1.84 },
  { symbol: 'MSFT', name: 'Microsoft', display: 'MSFT', price: 468.12, change: -1.26 },
  { symbol: 'NVDA', name: 'NVIDIA', display: 'NVDA', price: 913.77, change: 0.42 },
];

describe('daily market brief schedule logic', () => {
  it('does not refresh before the local schedule if a prior brief exists', () => {
    const shouldRefresh = shouldRefreshDailyBrief({
      available: true,
      title: 'Brief',
      dateKey: '2026-03-07',
      timezone: 'UTC',
      summary: '',
      actionPlan: '',
      riskWatch: '',
      items: [],
      provider: 'rules',
      model: '',
      fallback: true,
      generatedAt: '2026-03-07T23:00:00.000Z',
      headlineCount: 0,
    }, 'UTC', new Date('2026-03-08T07:00:00.000Z'));

    assert.equal(shouldRefresh, false);
  });

  it('refreshes after the local schedule when the brief is from a prior day', () => {
    const shouldRefresh = shouldRefreshDailyBrief({
      available: true,
      title: 'Brief',
      dateKey: '2026-03-07',
      timezone: 'UTC',
      summary: '',
      actionPlan: '',
      riskWatch: '',
      items: [],
      provider: 'rules',
      model: '',
      fallback: true,
      generatedAt: '2026-03-07T23:00:00.000Z',
      headlineCount: 0,
    }, 'UTC', new Date('2026-03-08T09:00:00.000Z'));

    assert.equal(shouldRefresh, true);
  });
});

describe('buildDailyMarketBrief', () => {
  it('builds a brief from tracked markets and finance headlines', async () => {
    const brief = await buildDailyMarketBrief({
      markets,
      newsByCategory: {
        markets: [
          makeNewsItem('Apple extends gains after stronger iPhone cycle outlook'),
          makeNewsItem('Microsoft slides as cloud guidance softens', 'Bloomberg', '2026-03-08T04:00:00.000Z'),
        ],
        economic: [
          makeNewsItem('Treasury yields steady ahead of inflation data', 'WSJ', '2026-03-08T03:00:00.000Z'),
        ],
      },
      timezone: 'UTC',
      now: new Date('2026-03-08T10:30:00.000Z'),
      targets: [
        { symbol: 'AAPL', name: 'Apple', display: 'AAPL' },
        { symbol: 'MSFT', name: 'Microsoft', display: 'MSFT' },
      ],
      summarize: async () => ({
        summary: 'Risk appetite is mixed, with Apple leading while Microsoft weakens into macro headlines.',
        provider: 'openrouter',
        model: 'test-model',
        cached: false,
      }),
    });

    assert.equal(brief.available, true);
    assert.equal(brief.items.length, 2);
    assert.equal(brief.provider, 'openrouter');
    assert.equal(brief.fallback, false);
    assert.match(brief.title, /Daily Market Brief/);
    assert.match(brief.summary, /Apple leading/i);
    assert.match(brief.actionPlan, /selective|Lean|Keep/i);
    assert.match(brief.riskWatch, /headline|Microsoft|Apple/i);
    assert.match(brief.items[0]?.note || '', /Headline driver/i);
  });

  it('falls back to deterministic copy when summarization is unavailable', async () => {
    const brief = await buildDailyMarketBrief({
      markets,
      newsByCategory: {
        markets: [makeNewsItem('NVIDIA holds gains as chip demand remains firm')],
      },
      timezone: 'UTC',
      now: new Date('2026-03-08T10:30:00.000Z'),
      targets: [{ symbol: 'NVDA', name: 'NVIDIA', display: 'NVDA' }],
      summarize: async () => null,
    });

    assert.equal(brief.available, true);
    assert.equal(brief.provider, 'rules');
    assert.equal(brief.fallback, true);
    assert.match(brief.summary, /watchlist|breadth|headline flow/i);
  });
});
