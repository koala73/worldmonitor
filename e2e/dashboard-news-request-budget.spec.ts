import { expect, test, type Page } from '@playwright/test';

// Request budget for the news load on a default anonymous dashboard load (#5376).
//
// What went wrong in production, measured on a live anonymous
// www.worldmonitor.app/dashboard session via Resource Timing:
//
//   rss-proxy         20   window 1,347 → 2,319 ms
//   list-feed-digest   2   at 994 ms and 2,162 ms          ← news loaded twice
//
// Two independent defects produced that:
//
//  1. `commodities`, `supply-chain` and `live-news` are CANONICAL_FEEDS category
//     keys whose panel key is owned by a NON-news panel (CommoditiesPanel prices,
//     SupplyChainPanel, LiveNewsPanel 24/7 video). The data panel's
//     `enabled: true` promoted them into the news work-list as *custom*
//     categories, and custom categories were exempt from BOTH the digest and the
//     per-feed feed cap — 4+8+7 = 19 uncapped /api/rss-proxy fetches, rendered
//     into nothing because those keys have no NewsPanel.
//  2. `loadAllData()`'s task list always contained an unconditional `news` task,
//     and its drain loop re-runs the whole list when a second `loadAllData()`
//     arrives while the first is in flight (panel-layout's hydration trigger +
//     App.ts's bootstrap fan-out). Every trigger re-fetched the digest even
//     though nothing about the news load is viewport-gated.
//
// This spec is the budget guard for both: one digest request, zero rss-proxy
// requests, and none of the `Custom category …` warnings.
//
// Note on the "zero rss-proxy" assertion: preset categories missing from the
// digest do NOT fall back to per-feed fetching on web — that path is gated off
// by the `newsPerFeedFallback` runtime flag (default false). Custom categories
// bypassed that gate entirely, which is why the trio showed up as raw proxy
// traffic. So a non-zero count here means a category is being resolved that has
// no business being fetched client-side.

const DIGEST_GLOB = '**/api/news/v1/list-feed-digest*';
const RSS_PROXY_GLOB = '**/api/rss-proxy*';

// Time to let a SECOND news load land if one is coming. Production saw the two
// digest requests 1.2 s apart; the local dev server is faster, so this is a wide
// margin over the interval being guarded.
const SECOND_LOAD_SETTLE_MS = 8_000;

type NewsRequestLog = {
  digestUrls: string[];
  rssProxyUrls: string[];
};

async function seedFreshAnonymousFullVariant(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('__news_request_budget_e2e_init__')) return;
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('worldmonitor-variant', 'full');
    // Overlays that would otherwise steal focus/paint during the load window.
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('wm-pro-banner-launched-dismissed', String(Date.now()));
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
    sessionStorage.setItem('__news_request_budget_e2e_init__', '1');
  });
}

async function installNewsRequestAccounting(page: Page): Promise<NewsRequestLog> {
  const log: NewsRequestLog = { digestUrls: [], rssProxyUrls: [] };

  // Catch-all FIRST: later-registered routes win in Playwright, so the two
  // specific handlers below still see their traffic.
  await page.route(/^https?:\/\/(?!(127\.0\.0\.1:4173|localhost:4173)(?:\/|$)).*/i, (route) => {
    return route.abort('blockedbyclient');
  });

  // Serve a digest so the load takes the real digest-backed path. Only the
  // request ACCOUNTING matters here, so empty buckets are enough — an item-
  // bearing bucket would exercise rendering, not the request budget.
  await page.route(DIGEST_GLOB, async (route) => {
    log.digestUrls.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        categories: { politics: { items: [] }, intel: { items: [] } },
        feedStatuses: {},
        generatedAt: new Date(0).toISOString(),
      }),
    });
  });

  // Abort rather than serve: a request reaching this handler is already a
  // request the client should not have made.
  await page.route(RSS_PROXY_GLOB, async (route) => {
    log.rssProxyUrls.push(route.request().url());
    await route.abort('blockedbyclient');
  });

  return log;
}

test.describe('dashboard news request budget (#5376)', () => {
  test('a default anonymous load issues one digest and zero rss-proxy requests', async ({ page }) => {
    const customCategoryWarnings: string[] = [];
    page.on('console', (message) => {
      const text = message.text();
      if (text.includes('[News] Custom category')) customCategoryWarnings.push(text);
    });

    await seedFreshAnonymousFullVariant(page);
    const log = await installNewsRequestAccounting(page);

    const firstDigest = page.waitForRequest(DIGEST_GLOB);
    await page.goto('/');
    await page.waitForFunction(
      () => document.documentElement.dataset.wmEventHandlersReady === 'true',
    );
    await firstDigest;

    // The news load is not viewport-gated, so nothing needs scrolling to
    // provoke the second load — the bootstrap fan-out and the hydration
    // trigger both fire on their own during this window.
    await page.waitForTimeout(SECOND_LOAD_SETTLE_MS);

    expect(
      log.rssProxyUrls,
      'no category should reach /api/rss-proxy on a default load — the digest covers the preset, ' +
        'and a key owned by a non-news panel must never resolve as a news category (#5376)',
    ).toEqual([]);

    expect(
      customCategoryWarnings,
      'no default-visible category may be treated as a custom (digest-exempt) category',
    ).toEqual([]);

    expect(
      log.digestUrls.length,
      `one page load must issue exactly one list-feed-digest request, got ${log.digestUrls.length}: ` +
        `${log.digestUrls.join(', ')}. More than one means loadAllData() re-ran the whole news load.`,
    ).toBe(1);
  });
});
