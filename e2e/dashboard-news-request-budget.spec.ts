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

// src/app/data-loader.ts `perFeedFallbackCategoryFeedLimit`. Every per-feed
// fallback is capped at this many feeds per category, custom categories included.
const PER_FEED_FALLBACK_CATEGORY_FEED_LIMIT = 3;

// A Tech news panel customized into a `full` session: absent from FULL_FEEDS, so
// it resolves as a CUSTOM category and direct fetch is its only path. Priority 1
// keeps it inside the 40-panel free-tier cap (FULL_PANELS enables 39 priority-1
// panels), and its 10 TECH_FEEDS entries are well past the per-category cap.
const CUSTOM_CATEGORY_KEY = 'startups';
const CUSTOM_CATEGORY_FEED_COUNT = 10;

type NewsRequestLog = {
  digestUrls: string[];
  rssProxyUrls: string[];
};

/**
 * Distinct feed URLs behind a set of /api/rss-proxy requests.
 *
 * The cap bounds how many FEEDS a category fetches, not how many HTTP attempts
 * they cost — this spec aborts the proxy requests, so the RSS client's own retry
 * of a failed feed would otherwise inflate a raw request count.
 */
function distinctProxiedFeeds(rssProxyUrls: string[]): string[] {
  const feeds = new Set<string>();
  for (const url of rssProxyUrls) {
    const target = new URL(url).searchParams.get('url');
    if (target) feeds.add(target);
  }
  return [...feeds];
}

async function seedFreshAnonymousFullVariant(
  page: Page,
  extraPanels: Record<string, { name: string; enabled: boolean; priority: number }> = {},
): Promise<void> {
  await page.addInitScript((panels: Record<string, unknown>) => {
    if (sessionStorage.getItem('__news_request_budget_e2e_init__')) return;
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('worldmonitor-variant', 'full');
    // Overlays that would otherwise steal focus/paint during the load window.
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('wm-pro-banner-launched-dismissed', String(Date.now()));
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
    // Partial panel settings: App.ts merges every other ALL_PANELS key in at its
    // variant default, so this only overrides the panels named here.
    if (Object.keys(panels).length > 0) {
      localStorage.setItem('worldmonitor-panels', JSON.stringify(panels));
    }
    sessionStorage.setItem('__news_request_budget_e2e_init__', '1');
  }, extraPanels as Record<string, unknown>);
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

  // The other half of the fix: a category that legitimately STAYS custom — a
  // cross-variant panel the user enabled on purpose — must still load (that is
  // #3687, the bug panel-driven resolution was introduced to fix) and must be
  // capped like every other per-feed fallback. Custom categories used to be
  // exempt from the cap on the theory that there were only ever a handful.
  test('a deliberately customized category still loads, capped at the per-category feed limit', async ({ page }) => {
    await seedFreshAnonymousFullVariant(page, {
      [CUSTOM_CATEGORY_KEY]: { name: 'Startups & VC', enabled: true, priority: 1 },
    });
    const log = await installNewsRequestAccounting(page);

    const firstDigest = page.waitForRequest(DIGEST_GLOB);
    await page.goto('/');
    await page.waitForFunction(
      () => document.documentElement.dataset.wmEventHandlersReady === 'true',
    );
    await firstDigest;
    await page.waitForTimeout(SECOND_LOAD_SETTLE_MS);

    const feeds = distinctProxiedFeeds(log.rssProxyUrls);

    expect(
      feeds.length,
      `an enabled cross-variant news panel must still have its feeds fetched — a custom ` +
        `category is never in the per-variant digest, so direct fetch is its only path (#3687)`,
    ).toBeGreaterThan(0);

    expect(
      feeds.length,
      `a custom category must not exceed perFeedFallbackCategoryFeedLimit ` +
        `(${PER_FEED_FALLBACK_CATEGORY_FEED_LIMIT}); "${CUSTOM_CATEGORY_KEY}" has ` +
        `${CUSTOM_CATEGORY_FEED_COUNT} feeds and fetched ${feeds.length}: ${feeds.join(', ')}`,
    ).toBeLessThanOrEqual(PER_FEED_FALLBACK_CATEGORY_FEED_LIMIT);

    expect(
      log.digestUrls.length,
      'customizing a category must not add a second news load either',
    ).toBe(1);
  });
});
