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

// A full-variant preset news panel that sits below the fold, so it mounts after the
// news load rather than during it. The digest stub carries no bucket for it.
const EMPTY_CATEGORY_PANEL = 'africa';

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

/**
 * Fire a real post-load hydration trigger and prove it fired.
 *
 * It has to be `resize`, not a scroll: the dashboard sets `overflow: hidden` on
 * both html and body, so the document never scrolls and window-level scroll events
 * never fire — a wheel-based trigger silently does nothing, which makes any
 * "nothing was re-fetched" assertion after it vacuous. App.ts binds
 * handleViewportPrime to BOTH events, and resize genuinely fires.
 *
 * The counter is the positive control: it proves the very event handleViewportPrime
 * listens for was delivered, so a later "no new request" assertion means the gate
 * suppressed the load rather than nothing having asked for one.
 */
async function fireHydrationTrigger(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __wmResizeCount?: number }).__wmResizeCount = 0;
    window.addEventListener('resize', () => {
      const w = window as unknown as { __wmResizeCount?: number };
      w.__wmResizeCount = (w.__wmResizeCount ?? 0) + 1;
    });
  });
  await page.setViewportSize({ width: 1180, height: 800 });
  await page.waitForFunction(
    () => ((window as unknown as { __wmResizeCount?: number }).__wmResizeCount ?? 0) > 0,
  );
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

async function installNewsRequestAccounting(
  page: Page,
  options: { failDigestTimes?: number; emptyDigestTimes?: number } = {},
): Promise<NewsRequestLog> {
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
    // Fail only the first N attempts. The data loader's own circuit breaker opens
    // after 2 consecutive failures and then serves from cache WITHOUT a network
    // request, so an always-failing stub would stop producing observable attempts
    // and mask whether a retry happened at all.
    if (log.digestUrls.length <= (options.failDigestTimes ?? 0)) {
      await route.fulfill({ status: 503, contentType: 'text/plain', body: 'digest unavailable' });
      return;
    }
    // A DEGRADED digest: HTTP 200, well-formed, but carrying no categories. This is
    // the outage shape the server actually emits, and the one a plain non-null
    // check would mistake for a successful load.
    if (log.digestUrls.length <= (options.failDigestTimes ?? 0) + (options.emptyDigestTimes ?? 0)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ categories: {}, feedStatuses: {}, generatedAt: new Date(0).toISOString() }),
      });
      return;
    }
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
    const capWarnings: string[] = [];
    page.on('console', (message) => {
      const text = message.text();
      if (text.includes('[News] Custom category')) capWarnings.push(text);
    });

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

    // Exactly the cap, not merely under it. `toBeLessThanOrEqual` alone would pass
    // with the uncapped code restored the moment the category's feed list shrank to
    // the cap — the assertion has to have a floor as well as a ceiling.
    expect(
      feeds.length,
      `a custom category must fetch exactly perFeedFallbackCategoryFeedLimit ` +
        `(${PER_FEED_FALLBACK_CATEGORY_FEED_LIMIT}) feeds; "${CUSTOM_CATEGORY_KEY}" fetched ` +
        `${feeds.length}: ${feeds.join(', ')}`,
    ).toBe(PER_FEED_FALLBACK_CATEGORY_FEED_LIMIT);

    // ...and the category must actually HAVE more sources than the cap, or the
    // assertion above proves nothing. The warning carries the real ratio.
    const ratio = capWarnings.join(' ').match(/fetching (\d+)\/(\d+) feeds directly/);
    expect(ratio, `expected a "[News] Custom category" warning naming the N/M feed ratio, got: ${capWarnings.join(' | ')}`).not.toBeNull();
    expect(
      Number(ratio?.[2]),
      `"${CUSTOM_CATEGORY_KEY}" must declare more than ${PER_FEED_FALLBACK_CATEGORY_FEED_LIMIT} sources ` +
        `for the cap assertion to mean anything (expected ~${CUSTOM_CATEGORY_FEED_COUNT})`,
    ).toBeGreaterThan(PER_FEED_FALLBACK_CATEGORY_FEED_LIMIT);

    expect(
      log.digestUrls.length,
      'customizing a category must not add a second news load either',
    ).toBe(1);
  });

  // The other outage shape, and the one that actually happens: the digest answers
  // HTTP 200 with a well-formed body carrying no categories. It is non-null, so a
  // plain null check calls it a successful load — while every preset category
  // rendered empty. Coverage, not nullness, is what makes a load "landed".
  test('a degraded 200 digest with no categories is not mistaken for a landed load', async ({ page }) => {
    await seedFreshAnonymousFullVariant(page);
    const log = await installNewsRequestAccounting(page, { emptyDigestTimes: 1 });

    const firstDigest = page.waitForRequest(DIGEST_GLOB);
    await page.goto('/');
    await page.waitForFunction(
      () => document.documentElement.dataset.wmEventHandlersReady === 'true',
    );
    await firstDigest;
    await page.waitForTimeout(SECOND_LOAD_SETTLE_MS);

    expect(
      log.digestUrls.length,
      `a 200 digest carrying no categories leaves every panel empty, so it must stay ` +
        `retryable exactly like a failed request (attempts: ${log.digestUrls.length})`,
    ).toBeGreaterThanOrEqual(2);
  });

  // A news panel that mounts AFTER the load (below the fold, deferred) is backfilled
  // from ctx.newsByCategory. An empty category is a real, routine outcome — the digest
  // simply carries no bucket for it — and the panel must land on its empty state, not
  // sit on the skeleton the Panel constructor installs. Before the gate, the second
  // news load re-rendered every category and cleared the spinner as a side effect;
  // with one load per work-list that second chance is gone, so the backfill itself has
  // to handle it (#5376 review).
  test('a late-mounting panel for an empty category shows its empty state, not a spinner', async ({ page }) => {
    await seedFreshAnonymousFullVariant(page);
    // Digest carries politics + intel only, so every other preset category resolves
    // to [] — exactly the shape a partial digest produces in production.
    await installNewsRequestAccounting(page);

    const firstDigest = page.waitForRequest(DIGEST_GLOB);
    await page.goto('/');
    await page.waitForFunction(
      () => document.documentElement.dataset.wmEventHandlersReady === 'true',
    );
    await firstDigest;
    await page.waitForTimeout(SECOND_LOAD_SETTLE_MS);

    const panel = page.locator(`[data-panel="${EMPTY_CATEGORY_PANEL}"]`);
    await panel.scrollIntoViewIfNeeded();
    await expect(panel).toBeVisible();
    // Give the deferred mount + backfill a moment after it enters the viewport.
    await page.waitForTimeout(3_000);

    await expect(
      panel.locator('.panel-loading'),
      `"${EMPTY_CATEGORY_PANEL}" resolved to an empty category, so its panel must show ` +
        `the empty state rather than spin — the backfill skips a cached [] and nothing ` +
        `re-renders it now that the news load runs once per work-list`,
    ).toHaveCount(0);
  });

  // The gate must not turn a transient digest outage into a stuck-empty dashboard.
  // When the digest is down, `newsPerFeedFallback` is off on web, so every preset
  // category renders empty and the load lands NOTHING. Recording the work-list for
  // that run would make the gate treat an empty dashboard as "already loaded" and
  // suppress every retry until RefreshScheduler's 20-minute tick — losing the
  // recovery the pre-gate double-load provided by accident.
  test('a news load that landed nothing recovers on the next trigger', async ({ page }) => {
    await seedFreshAnonymousFullVariant(page);
    const log = await installNewsRequestAccounting(page, { failDigestTimes: 1 });

    const firstDigest = page.waitForRequest(DIGEST_GLOB);
    await page.goto('/');
    await page.waitForFunction(
      () => document.documentElement.dataset.wmEventHandlersReady === 'true',
    );
    await firstDigest;
    await page.waitForTimeout(SECOND_LOAD_SETTLE_MS);

    // Attempt 1 was served 503, so that load rendered every category empty. A
    // second attempt is the whole point: it is served 200 and the dashboard
    // recovers within the page load instead of waiting out the refresh interval.
    expect(
      log.digestUrls.length,
      `a news load that landed nothing must stay retryable — the first digest was 503, ` +
        `so a later trigger has to try again rather than be skipped as already-loaded ` +
        `(attempts: ${log.digestUrls.length})`,
    ).toBeGreaterThanOrEqual(2);

    // ...and having recovered, it must settle: the successful load records the
    // work-list, so the gate stops the retries rather than looping every trigger.
    const afterRecovery = log.digestUrls.length;
    await fireHydrationTrigger(page);
    await page.waitForTimeout(3_000);
    expect(
      log.digestUrls.length,
      `once a load has landed, further triggers must not re-fetch the digest ` +
        `(after recovery: ${afterRecovery}, after trigger: ${log.digestUrls.length})`,
    ).toBe(afterRecovery);
  });
});
