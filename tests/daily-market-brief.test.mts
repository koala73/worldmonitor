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

  it('REGRESSION: refreshes during the same day when the cached brief is older than the intraday ceiling', () => {
    // Repro the reported "CACHED · 8h ago" symptom: a brief built at 09:20
    // local stays cached until the next day's schedule hour because the
    // same-day branch unconditionally returned `false`. With the intraday
    // ceiling in place the 60-min scheduler in App.ts can actually rebuild
    // — same dateKey, but generatedAt is older than the ceiling.
    const shouldRefresh = shouldRefreshDailyBrief({
      available: true,
      title: 'Brief',
      dateKey: '2026-03-08',
      timezone: 'UTC',
      summary: '',
      actionPlan: '',
      riskWatch: '',
      items: [],
      provider: 'rules',
      model: '',
      fallback: true,
      generatedAt: '2026-03-08T09:20:00.000Z',
      headlineCount: 0,
    }, 'UTC', new Date('2026-03-08T17:00:00.000Z'));

    assert.equal(shouldRefresh, true);
  });

  it('does NOT refresh during the same day when the cached brief is fresher than the intraday ceiling', () => {
    // Guard against the opposite over-correction: every scheduler tick must
    // not trigger an LLM rebuild. 20 minutes after the build should still
    // serve cached under the default 55-min ceiling.
    const shouldRefresh = shouldRefreshDailyBrief({
      available: true,
      title: 'Brief',
      dateKey: '2026-03-08',
      timezone: 'UTC',
      summary: '',
      actionPlan: '',
      riskWatch: '',
      items: [],
      provider: 'rules',
      model: '',
      fallback: true,
      generatedAt: '2026-03-08T09:20:00.000Z',
      headlineCount: 0,
    }, 'UTC', new Date('2026-03-08T09:40:00.000Z'));

    assert.equal(shouldRefresh, false);
  });

  it('REGRESSION: default ceiling is below the scheduler interval so an early tick still rebuilds', () => {
    // Greptile review on PR #3822: if the default ceiling equals the
    // scheduler interval (both 60 min) and the browser fires the scheduler
    // tick a hair early — wake-from-throttled-tab, accumulated drift —
    // age=58m < ceiling=60m skips the rebuild and the next eligible fire
    // is at t+118m, doubling the effective cadence. Default ceiling MUST
    // stay below 60 min so a 58-min-old brief refreshes on the early tick.
    // If you change this, also update DEFAULT_MAX_INTRADAY_AGE_MS comment.
    const shouldRefresh = shouldRefreshDailyBrief({
      available: true,
      title: 'Brief',
      dateKey: '2026-03-08',
      timezone: 'UTC',
      summary: '',
      actionPlan: '',
      riskWatch: '',
      items: [],
      provider: 'rules',
      model: '',
      fallback: true,
      generatedAt: '2026-03-08T09:20:00.000Z',
      headlineCount: 0,
    }, 'UTC', new Date('2026-03-08T10:18:00.000Z'));

    assert.equal(shouldRefresh, true);
  });

  it('honours an explicit maxIntradayAgeMs override (cost-tuning hook)', () => {
    // Callers that want a coarser/finer cadence than the default 55 min
    // can pass it through. 30-min-old brief with a 2h ceiling → no refresh.
    const shouldRefresh = shouldRefreshDailyBrief(
      {
        available: true,
        title: 'Brief',
        dateKey: '2026-03-08',
        timezone: 'UTC',
        summary: '',
        actionPlan: '',
        riskWatch: '',
        items: [],
        provider: 'rules',
        model: '',
        fallback: true,
        generatedAt: '2026-03-08T09:20:00.000Z',
        headlineCount: 0,
      },
      'UTC',
      new Date('2026-03-08T09:50:00.000Z'),
      undefined,
      2 * 60 * 60 * 1000,
    );

    assert.equal(shouldRefresh, false);
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

describe('summarizer geoContext cache identity (#4914)', () => {
  // The geoContext string becomes the summary cache key's :g segment
  // (summary-cache-key.ts), shared across every user reading the same
  // seeded quotes/regime. Raw 5-min-tick floats (VIX 18.24 → 18.31,
  // AAPL +1.84% → +1.87%) minted a fresh key per tick and per user,
  // defeating the 24h TTL. Values interpolated into the prompt must be
  // quantized so trivially-drifted inputs produce a byte-identical
  // context — and therefore one shared paid generation.
  const news = {
    markets: [makeNewsItem('Apple extends gains after stronger iPhone cycle outlook')],
    economic: [makeNewsItem('Treasury yields steady ahead of inflation data', 'WSJ', '2026-03-08T03:00:00.000Z')],
  };

  function contexts(drift: number): {
    markets: MarketData[];
    regimeContext: import('../src/services/daily-market-brief.ts').RegimeMacroContext;
    yieldCurveContext: import('../src/services/daily-market-brief.ts').YieldCurveContext;
    sectorContext: import('../src/services/daily-market-brief.ts').SectorBriefContext;
  } {
    return {
      markets: [
        { symbol: 'AAPL', name: 'Apple', display: 'AAPL', price: 212.45 + drift, change: 1.84 + drift },
        { symbol: 'MSFT', name: 'Microsoft', display: 'MSFT', price: 468.12 - drift, change: -1.26 + drift },
      ],
      regimeContext: {
        compositeScore: 55.3 + drift, compositeLabel: 'Neutral',
        fsiValue: 1.21 + drift, fsiLabel: 'Calm',
        vix: 18.24 + drift, hySpread: 341 + 100 * drift,
        cnnFearGreed: 61.2 + drift, cnnLabel: 'Greed',
        momentum: { score: 63.2 + drift }, sentiment: { score: 47.1 + drift },
      } as import('../src/services/daily-market-brief.ts').RegimeMacroContext,
      yieldCurveContext: {
        rate2y: 4.31 + drift, rate10y: 4.41 + drift, rate30y: 4.61 + drift,
        spread2s10s: -14.2 + 10 * drift, inverted: true,
      } as import('../src/services/daily-market-brief.ts').YieldCurveContext,
      sectorContext: {
        total: 11, countPositive: 7,
        topName: 'Energy', topChange: 2.13 + drift,
        worstName: 'Utilities', worstChange: -1.41 + drift,
      } as import('../src/services/daily-market-brief.ts').SectorBriefContext,
    };
  }

  async function captureGeoContext(drift: number): Promise<string> {
    let captured = '';
    await buildDailyMarketBrief({
      ...contexts(drift),
      newsByCategory: news,
      timezone: 'UTC',
      now: new Date('2026-03-08T10:30:00.000Z'),
      targets: [{ symbol: 'AAPL', name: 'Apple', display: 'AAPL' }],
      summarize: async (_headlines, _onProgress, geoContext) => {
        captured = geoContext ?? '';
        return { summary: 'Stable enough summary for the capture test.', provider: 'test', model: 'test', cached: false };
      },
    });
    return captured;
  }

  it('trivially-drifted quote/regime floats produce a byte-identical geoContext', async () => {
    const a = await captureGeoContext(0);
    const b = await captureGeoContext(0.03);
    assert.ok(a.length > 0, 'stub must have captured a geoContext');
    assert.equal(b, a, 'sub-bucket drift must not shift the summary cache identity');
  });

  it('a material regime move still shifts the geoContext', async () => {
    const a = await captureGeoContext(0);
    const c = await captureGeoContext(3);
    assert.notEqual(c, a, 'a real move (VIX +3, HY +300bps) must produce a fresh prompt and key');
  });
});
