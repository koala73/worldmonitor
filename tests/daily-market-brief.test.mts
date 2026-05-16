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

const widerMarkets: MarketData[] = [
  ...markets,
  { symbol: 'GOOGL', name: 'Alphabet', display: 'GOOGL', price: 178.3, change: 0.91 },
  { symbol: 'AMZN', name: 'Amazon', display: 'AMZN', price: 201.6, change: -0.55 },
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
    // Targets are additive: the 2 explicit picks lead, then the brief tops up
    // from `markets` (NVDA) toward DEFAULT_TARGET_COUNT.
    assert.equal(brief.items.length, 3);
    assert.deepEqual(brief.items.map((i) => i.display), ['AAPL', 'MSFT', 'NVDA']);
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

  it('REGRESSION: a single watchlist target never collapses the brief to one item', async () => {
    // Mirrors the additive watchlist fix — one pick must lead, then the brief
    // tops up from the wider market list toward DEFAULT_TARGET_COUNT (4).
    const brief = await buildDailyMarketBrief({
      markets: widerMarkets,
      newsByCategory: {
        markets: [makeNewsItem('NVIDIA holds gains as chip demand remains firm')],
      },
      timezone: 'UTC',
      now: new Date('2026-03-08T10:30:00.000Z'),
      targets: [{ symbol: 'NVDA', name: 'NVIDIA', display: 'NVDA' }],
      summarize: async () => null,
    });

    assert.equal(brief.available, true);
    assert.equal(brief.items.length, 4, 'should top up to DEFAULT_TARGET_COUNT, not collapse to 1');
    assert.equal(brief.items[0]?.display, 'NVDA', 'the user pick leads');
  });

  it('REGRESSION: a hanging summarizer must not stall the brief — falls back to rules within the timeout', async () => {
    // Repro the actual prod symptom: the LLM provider call (newsClient
    // .summarizeArticle → Vercel function → OpenRouter/Groq) hangs without
    // ever rejecting, and the panel sits on "Building daily market brief..."
    // forever because the try/catch around summarizeProvider only handles
    // rejections — not pending-forever promises. The fix (PR
    // fix/daily-market-brief-timeouts) wraps the summarizer call in
    // withTimeout; on timeout the catch fires and falls back to the
    // pre-computed rules-based summary. Use a tight summarizerTimeoutMs so
    // the test runs in ~30ms instead of waiting the prod 45s budget.
    const start = Date.now();
    const brief = await buildDailyMarketBrief({
      markets,
      newsByCategory: {
        markets: [makeNewsItem('NVIDIA holds gains as chip demand remains firm')],
      },
      timezone: 'UTC',
      now: new Date('2026-03-08T10:30:00.000Z'),
      targets: [{ symbol: 'NVDA', name: 'NVIDIA', display: 'NVDA' }],
      // Pending-forever — what a hung LLM upstream looks like from the
      // client side.
      summarize: () => new Promise(() => {}),
      summarizerTimeoutMs: 30,
    });
    const elapsed = Date.now() - start;

    assert.equal(brief.available, true, 'must return a usable brief, not throw or hang');
    assert.equal(brief.provider, 'rules', 'must mark the fallback provider so UI can show it');
    assert.equal(brief.fallback, true);
    assert.match(brief.summary, /watchlist|breadth|headline flow/i);
    // Budget is 30ms; tolerate generous CI variance but assert we didn't
    // wait the prod 45s (proving the timeout actually fired).
    assert.ok(elapsed < 5_000, `elapsed ${elapsed}ms — withTimeout did not fire`);
  });
});
