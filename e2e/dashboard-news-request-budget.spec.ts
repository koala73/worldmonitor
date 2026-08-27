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
//
// The cap bounds a SINGLE LOAD, and since #5873 that is the whole of what it
// bounds: a custom category now rotates its window by the cap on each refresh
// cycle (fixed prefixes made feeds 4..N unreachable forever), so N loads reach
// up to N × cap distinct feeds over time. This spec seeds a fresh anonymous
// profile, so the persisted rotation cycle starts at 0 and the window is the
// leading prefix — exactly the pre-rotation feed set.
//
// That makes the assertion below transitively a single-load guard too: a second
// news load in one page load would advance the rotation and fetch 6 distinct
// feeds instead of 3. It fails alongside the explicit `digestUrls.length === 1`
// assertion rather than instead of it.
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

async function mountDeferredPanel(page: Page, panelKey: string) {
  const panel = page.locator(`[data-panel="${panelKey}"]`);
  await panel.scrollIntoViewIfNeeded();
  await expect(panel).toBeVisible();
  await expect(panel).not.toHaveAttribute('data-deferred-panel', 'true');
  return panel;
}

/**
 * Snapshot stored under one exact `digest:last-good:<variant>:<lang>` key.
 *
 * Reads the same IndexedDB envelope `src/services/persistent-cache.ts` writes,
 * because this is the thing being protected: the entry `loadPersistedDigest`
 * serves for up to 6 hours whenever the live digest is unreachable. Asserting on
 * rendered panels instead would only prove what the CURRENT page load did, and
 * the defect is that the poisoned entry outlives the page load that stored it.
 *
 * Returns `null` when nothing has been stored yet, so a caller can tell "no
 * entry" from "an entry with no categories" — collapsing the two would let the
 * poisoning assertion pass against a cache that was never written at all.
 */
type PersistedDigestSnapshot = {
  categories: string[];
  headlines: string[];
};

async function readPersistedDigest(
  page: Page,
  key = 'digest:last-good:full:en',
): Promise<PersistedDigestSnapshot | null> {
  return page.evaluate(async (exactKey) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      // Deliberately versionless: opening at a pinned version throws VersionError
      // the day persistent-cache.ts bumps CACHE_DB_VERSION, which would red this
      // spec for a reason that has nothing to do with what it asserts.
      const request = indexedDB.open('worldmonitor_persistent_cache');
      request.onupgradeneeded = () => {
        // Only fires when the app has not created the database yet. Mirror
        // persistent-cache.ts so this read leaves a usable database behind
        // rather than one with no object store.
        const upgraded = request.result;
        if (!upgraded.objectStoreNames.contains('entries')) {
          upgraded.createObjectStore('entries', { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (!db.objectStoreNames.contains('entries')) return null;
    const entry = await new Promise<{
      key: string;
      data?: { categories?: Record<string, { items?: Array<{ title?: string }> }> };
    } | undefined>(
      (resolve, reject) => {
        const tx = db.transaction('entries', 'readonly');
        const request = tx.objectStore('entries').get(exactKey);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      },
    );
    if (!entry) return null;
    const categories = entry.data?.categories ?? {};
    return {
      categories: Object.keys(categories),
      headlines: Object.values(categories)
        .flatMap((category) => category.items ?? [])
        .map((item) => item.title ?? ''),
    };
  }, key);
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

/** Categories the healthy stub digest covers. */
const HEALTHY_DIGEST_CATEGORIES = ['politics', 'intel'];
const HEALTHY_POLITICS_HEADLINE = 'Healthy last-good politics headline';
const PARTIAL_POLITICS_HEADLINE = 'Fresh partial politics headline';

function digestBody(categoryKeys: readonly string[], politicsHeadline?: string): string {
  return JSON.stringify({
    categories: Object.fromEntries(categoryKeys.map((key) => [
      key,
      {
        items: key === 'politics' && politicsHeadline
          ? [{
              source: 'BBC World',
              title: politicsHeadline,
              link: `https://example.com/${encodeURIComponent(politicsHeadline)}`,
              publishedAt: Date.now(),
              isAlert: false,
            }]
          : [],
      },
    ])),
    feedStatuses: {},
    generatedAt: new Date(0).toISOString(),
  });
}

async function installNewsRequestAccounting(
  page: Page,
  options: {
    failDigestTimes?: number;
    emptyDigestTimes?: number;
    /**
     * From request `after` + 1 onward, serve a digest covering only `categories`.
     *
     * The prefix options above can only produce degradation-then-recovery, which
     * never exercises what a degraded response does to a cache that ALREADY holds
     * a healthy digest. `categories: []` is the empty-200 outage; a shorter list
     * than HEALTHY_DIGEST_CATEGORIES is the partial one.
     */
    degradeDigestAfter?: { after: number; categories: readonly string[] };
    healthyPoliticsHeadline?: string;
    degradedPoliticsHeadline?: string;
    failDigestLanguages?: readonly string[];
  } = {},
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
    const requestLanguage = new URL(route.request().url()).searchParams.get('lang') ?? 'en';
    if (options.failDigestLanguages?.includes(requestLanguage)) {
      await route.fulfill({ status: 503, contentType: 'text/plain', body: 'digest unavailable' });
      return;
    }
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
      await route.fulfill({ status: 200, contentType: 'application/json', body: digestBody([]) });
      return;
    }
    const degrade = options.degradeDigestAfter;
    if (degrade && log.digestUrls.length > degrade.after) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: digestBody(degrade.categories, options.degradedPoliticsHeadline),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: digestBody(HEALTHY_DIGEST_CATEGORIES, options.healthyPoliticsHeadline),
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

    // The window is ROTATING, not a fixed prefix (#5873) — and on a freshly
    // seeded profile it must start at cycle 0, which is what makes the exact
    // feed-set assertion above deterministic. A missing cycle in the warning
    // means the rotation was never wired; a non-zero one means the persisted
    // cycle leaked in from another test's profile and this spec is no longer
    // measuring a first load.
    const cycle = capWarnings.join(' ').match(/rotation cycle (\d+)/);
    expect(
      cycle,
      `expected the "[News] Custom category" warning to name its rotation cycle, got: ${capWarnings.join(' | ')}`,
    ).not.toBeNull();
    expect(
      Number(cycle?.[1]),
      'a freshly seeded anonymous profile has no persisted rotation state, so the first load is cycle 0',
    ).toBe(0);

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
    await expect
      .poll(
        () => log.digestUrls.length,
        {
          message:
            'a 200 digest carrying no categories leaves every panel empty, so it must stay ' +
            'retryable exactly like a failed request',
          timeout: 30_000,
        },
      )
      .toBeGreaterThanOrEqual(2);
  });

  // The same degraded 200, one layer down: what it does to the fallback rather
  // than to the page load in front of it. `tryFetchDigest` counted the categories,
  // logged the count, and then ignored it — writing the empty body to BOTH
  // `lastGoodDigest` and the `digest:last-good` persistent entry, where
  // `loadPersistedDigest` kept serving it for `persistedDigestMaxAgeMs` (6 hours).
  // One degraded response therefore poisoned the fallback that exists to survive
  // degradation, and unlike the in-page symptom (bounded by #5376's `landed`
  // check) the poisoned entry survives reloads. It also reset the circuit breaker,
  // so a server emitting empty-but-200 digests never tripped it (#5877).
  test('a degraded 200 digest does not overwrite the persisted last-good digest', async ({ page }) => {
    // The two halves of the rejection, watched separately. Only the accept path
    // logs "Digest fetched", and only the reject path reaches the catch — so the
    // pair distinguishes "rejected" from "accepted but happened not to be written",
    // which the cache assertion alone cannot: with the throw removed, the persist
    // guard would decline the write anyway (0 categories is fewer than 2) and the
    // cache would survive for the wrong reason.
    const acceptedDigestLogs: string[] = [];
    const fallbackWarnings: string[] = [];
    page.on('console', (message) => {
      const text = message.text();
      if (text.includes('[News] Digest fetched:')) acceptedDigestLogs.push(text);
      if (text.includes('[News] Digest fetch failed, using fallback')) fallbackWarnings.push(text);
    });

    await seedFreshAnonymousFullVariant(page);
    // Healthy on the first request, degraded on every one after it: the shape
    // that overwrites, which a degraded-then-recovering stub can never produce.
    const log = await installNewsRequestAccounting(page, {
      degradeDigestAfter: { after: 1, categories: [] },
      healthyPoliticsHeadline: HEALTHY_POLITICS_HEADLINE,
    });

    const firstDigest = page.waitForRequest(DIGEST_GLOB);
    await page.goto('/');
    await page.waitForFunction(
      () => document.documentElement.dataset.wmEventHandlersReady === 'true',
    );
    await firstDigest;

    // Positive control: the healthy digest must actually reach the cache, or the
    // "still intact" assertion below would pass against an entry that was never
    // written. persistDigest is fire-and-forget, so poll rather than assume.
    await expect
      .poll(
        async () => (await readPersistedDigest(page))?.categories.length ?? 0,
        { message: 'the healthy digest must land in digest:last-good before it can be poisoned' },
      )
      .toBe(2);

    // A reload is what makes this different from the in-page symptom: a fresh
    // DataLoader with an empty `lastGoodDigest` re-fetches, gets the degraded
    // body, and is exactly where the overwrite happened in production.
    const secondDigest = page.waitForRequest(DIGEST_GLOB);
    const degradedFallbackWarning = page.waitForEvent('console', {
      predicate: (message) =>
        message.text().includes('[News] Digest fetch failed, using fallback') &&
        message.text().includes('digest returned 0 categories'),
    });
    await page.reload();
    await page.waitForFunction(
      () => document.documentElement.dataset.wmEventHandlersReady === 'true',
    );
    await secondDigest;
    await degradedFallbackWarning;

    // The degraded response and its rejection must both have landed before the
    // persistent entry is read, or the assertion below can race the code path it
    // is meant to protect.
    expect(
      log.digestUrls.length,
      `the reload must issue its own digest request for the degraded body to be delivered ` +
        `(attempts: ${log.digestUrls.length})`,
    ).toBeGreaterThanOrEqual(2);

    expect(
      (await readPersistedDigest(page))?.categories.sort(),
      `a 200 carrying no categories must not replace digest:last-good — it is the fallback ` +
        `every later page load reads when the digest is unreachable, and overwriting it with ` +
        `an empty body renders every preset category empty for up to 6 hours (#5877)`,
    ).toEqual(['intel', 'politics']);

    const politicsPanel = await mountDeferredPanel(page, 'politics');
    await expect(
      politicsPanel,
      'the reload must consume the cached fallback, not merely leave it intact in IndexedDB',
    ).toContainText(HEALTHY_POLITICS_HEADLINE);

    // The empty body must never have been treated as a fetched digest. Only the
    // healthy first response may log an acceptance, and only with real coverage —
    // "Digest fetched: 0 categories" is precisely the line the bug used to emit.
    expect(
      acceptedDigestLogs,
      `a 200 with no categories must not be accepted as a digest; accepted: ${acceptedDigestLogs.join(' | ')}`,
    ).toEqual(['[News] Digest fetched: 2 categories']);

    // ...and it has to have been routed into the failure path, so the breaker
    // counts it. Without this the assertion above would also pass if the degraded
    // response had simply never been delivered.
    expect(
      fallbackWarnings.join(' | '),
      'the degraded digest must fall through to the fallback path that counts against the breaker',
    ).toContain('digest returned 0 categories');
  });

  // The second degraded shape, and the judgment call: a 200 that covers SOME
  // categories, but fewer than the entry already cached. It is real data for the
  // categories it names, so the load uses it — but writing it over a richer
  // `digest:last-good` trades the fallback down for every later page load, which
  // is the one that reads this entry when the digest is unreachable (#5877).
  test('a partial digest is used for the load but does not shrink the persisted last-good digest', async ({ page }) => {
    const acceptedDigestLogs: string[] = [];
    page.on('console', (message) => {
      const text = message.text();
      if (text.includes('[News] Digest fetched:')) acceptedDigestLogs.push(text);
    });

    await seedFreshAnonymousFullVariant(page);
    // Healthy (2 categories) first, then 1 of the 2 — shrunken, not empty.
    const log = await installNewsRequestAccounting(page, {
      degradeDigestAfter: { after: 1, categories: ['politics'] },
      healthyPoliticsHeadline: HEALTHY_POLITICS_HEADLINE,
      degradedPoliticsHeadline: PARTIAL_POLITICS_HEADLINE,
    });

    const firstDigest = page.waitForRequest(DIGEST_GLOB);
    await page.goto('/');
    await page.waitForFunction(
      () => document.documentElement.dataset.wmEventHandlersReady === 'true',
    );
    await firstDigest;

    await expect
      .poll(
        async () => (await readPersistedDigest(page))?.categories.length ?? 0,
        { message: 'the healthy digest must land in digest:last-good before it can be shrunk' },
      )
      .toBe(2);

    await page.reload();
    await page.waitForFunction(
      () => document.documentElement.dataset.wmEventHandlersReady === 'true',
    );
    await page.waitForTimeout(SECOND_LOAD_SETTLE_MS);

    expect(
      log.digestUrls.length,
      `the reload must issue its own digest request for the partial body to be delivered ` +
        `(attempts: ${log.digestUrls.length})`,
    ).toBeGreaterThanOrEqual(2);

    // The partial digest must be ACCEPTED — this is what separates it from the
    // empty-200 case. Without this the test would pass if the partial digest were
    // rejected outright, which would be a different (and wrong) behaviour.
    expect(
      acceptedDigestLogs,
      `a partial digest is real data for the categories it covers and must still be used; ` +
        `accepted: ${acceptedDigestLogs.join(' | ')}`,
    ).toEqual(['[News] Digest fetched: 2 categories', '[News] Digest fetched: 1 categories']);

    expect(
      (await readPersistedDigest(page))?.categories.sort(),
      `the cached last-good digest must keep its wider coverage — a 1-category digest ` +
        `written over a 2-category entry is a strict loss for the next page load (#5877)`,
    ).toEqual(['intel', 'politics']);

    const politicsPanel = await mountDeferredPanel(page, 'politics');
    await expect(
      politicsPanel,
      'the current load must render the accepted partial digest even while retaining the richer fallback',
    ).toContainText(PARTIAL_POLITICS_HEADLINE);
  });

  test('a failing language scope never falls back to another language digest', async ({ page }) => {
    await seedFreshAnonymousFullVariant(page);
    const log = await installNewsRequestAccounting(page, {
      healthyPoliticsHeadline: HEALTHY_POLITICS_HEADLINE,
      failDigestLanguages: ['fr'],
    });

    await page.goto('/?lang=en');
    await expect
      .poll(
        async () => (await readPersistedDigest(page, 'digest:last-good:full:en'))?.headlines ?? [],
        { message: 'the English digest must be persisted under its exact scope' },
      )
      .toContain(HEALTHY_POLITICS_HEADLINE);

    await page.goto('/?lang=fr');
    await page.waitForFunction(
      () => document.documentElement.dataset.wmEventHandlersReady === 'true',
    );
    await page.waitForTimeout(SECOND_LOAD_SETTLE_MS);

    expect(
      log.digestUrls.some((url) => new URL(url).searchParams.get('lang') === 'fr'),
      'the French scope must actually request its own digest before fallback isolation is asserted',
    ).toBe(true);
    const politicsPanel = await mountDeferredPanel(page, 'politics');
    await expect(
      politicsPanel,
      'French digest failure must not render the English last-good entry',
    ).not.toContainText(HEALTHY_POLITICS_HEADLINE);
    expect(await readPersistedDigest(page, 'digest:last-good:full:fr')).toBeNull();
    expect(
      (await readPersistedDigest(page, 'digest:last-good:full:en'))?.headlines,
      'the English entry remains isolated under its own exact key',
    ).toContain(HEALTHY_POLITICS_HEADLINE);
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

const STABLECOIN_GLOB = '**/api/market/v1/list-stablecoin-markets*';
const SCROLL_HYDRATION_PANEL_ORDER = [
  'live-news',
  'intel',
  'gdelt-intel',
  'cii',
  'cascade',
  'strategic-risk',
  'politics',
  'us',
  'europe',
  'stablecoins',
  'middleeast',
  'africa',
  'latam',
  'asia',
  'energy',
  'gov',
  'thinktanks',
  'polymarket',
  'commodities',
  'markets',
  'stock-analysis',
  'stock-backtest',
  'daily-market-brief',
  'economic',
  'finance',
  'tech',
  'crypto',
  'heatmap',
  'ai',
  'macro-signals',
  'etf-flows',
  'monitors',
];

type ScrollMetrics = {
  clientHeight: number;
  owner: 'main-content' | 'panels-grid';
  scrollHeight: number;
  scrollTop: number;
  targetTop: number;
  viewportHeight: number;
};

type DashboardScrollResult = {
  after: ScrollMetrics;
  before: ScrollMetrics;
  hydrationMarksBefore: number;
  scrollCount: number;
};

const VIEWPORT_HYDRATION_MARK = 'wm:hydration:viewport-trigger';
const INITIAL_FANOUT_COMPLETE_MARK = 'wm:data:initial-fanout-complete';

async function seedScrollableDashboard(page: Page): Promise<void> {
  await seedFreshAnonymousFullVariant(page, {
    stablecoins: { name: 'Stablecoins', enabled: true, priority: 1 },
  });
  await page.addInitScript((panelOrder: string[]) => {
    localStorage.setItem('wm_lcp_debug', '1');
    localStorage.setItem('worldmonitor-panel-order-v1.9', 'done');
    localStorage.setItem('worldmonitor-panel-prune-v1', 'done');
    localStorage.setItem('worldmonitor-layout-reset-v2.5', 'done');
    localStorage.setItem('panel-order', JSON.stringify(panelOrder));
  }, SCROLL_HYDRATION_PANEL_ORDER);
}

async function installStablecoinContract(page: Page): Promise<string[]> {
  const requests: string[] = [];

  await page.route(/^https?:\/\/(?!(127\.0\.0\.1:4173|localhost:4173)(?:\/|$)).*/i, (route) => {
    return route.abort('blockedbyclient');
  });
  await page.route(STABLECOIN_GLOB, async (route) => {
    requests.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        stablecoins: [{
          symbol: 'TEST',
          name: 'Test Dollar',
          price: 1,
          marketCap: 1_000_000,
          volume24h: 100_000,
          change24h: 0,
          pegStatus: 'ON PEG',
          deviation: 0,
        }],
        summary: {
          totalMarketCap: 1_000_000,
          totalVolume24h: 100_000,
          coinCount: 1,
          depeggedCount: 0,
          healthStatus: 'HEALTHY',
        },
      }),
    });
  });
  return requests;
}

async function readScrollMetrics(page: Page): Promise<ScrollMetrics> {
  return page.evaluate(() => {
    const main = document.querySelector('.main-content');
    const grid = document.querySelector('.panels-grid');
    const target = document.querySelector('[data-panel="stablecoins"]');
    if (
      !(main instanceof HTMLElement) ||
      !(grid instanceof HTMLElement) ||
      !(target instanceof HTMLElement)
    ) {
      throw new Error('missing dashboard scroll test elements');
    }
    const gridOverflow = getComputedStyle(grid).overflowY;
    const scroller =
      (gridOverflow === 'auto' || gridOverflow === 'scroll') &&
      grid.scrollHeight > grid.clientHeight
        ? grid
        : main;
    return {
      clientHeight: scroller.clientHeight,
      owner: scroller === grid ? 'panels-grid' : 'main-content',
      scrollHeight: scroller.scrollHeight,
      scrollTop: scroller.scrollTop,
      targetTop: target.getBoundingClientRect().top,
      viewportHeight: window.innerHeight,
    };
  });
}

async function scrollDashboardAndCollect(page: Page): Promise<DashboardScrollResult> {
  return page.evaluate((hydrationMark) => {
    const main = document.querySelector('.main-content');
    const grid = document.querySelector('.panels-grid');
    const target = document.querySelector('[data-panel="stablecoins"]');
    if (
      !(main instanceof HTMLElement) ||
      !(grid instanceof HTMLElement) ||
      !(target instanceof HTMLElement)
    ) {
      throw new Error('missing dashboard scroll test elements');
    }
    const gridOverflow = getComputedStyle(grid).overflowY;
    const scroller =
      (gridOverflow === 'auto' || gridOverflow === 'scroll') &&
      grid.scrollHeight > grid.clientHeight
        ? grid
        : main;
    const metrics = (): ScrollMetrics => ({
      clientHeight: scroller.clientHeight,
      owner: scroller === grid ? 'panels-grid' : 'main-content',
      scrollHeight: scroller.scrollHeight,
      scrollTop: scroller.scrollTop,
      targetTop: target.getBoundingClientRect().top,
      viewportHeight: window.innerHeight,
    });
    const debug = (window as typeof window & {
      __wmLcpDebug?: { getSnapshot?: () => { marks: Array<{ name: string }> } };
    }).__wmLcpDebug;
    const hydrationMarksBefore =
      debug?.getSnapshot?.().marks.filter((mark) => mark.name === hydrationMark).length ?? 0;
    const before = metrics();

    return new Promise<DashboardScrollResult>((resolve) => {
      let scrollCount = 0;
      const onScroll = (event: Event) => {
        if (event.target !== scroller) return;
        scrollCount += 1;
        window.removeEventListener('scroll', onScroll, true);
        resolve({ after: metrics(), before, hydrationMarksBefore, scrollCount });
      };
      window.addEventListener('scroll', onScroll, { capture: true });
      const targetTopInScroller =
        target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      scroller.scrollTop = Math.max(1, targetTopInScroller - scroller.clientHeight + 200);
    });
  }, VIEWPORT_HYDRATION_MARK);
}

async function lcpMarkCount(page: Page, name: string): Promise<number> {
  return page.evaluate((markName) => {
    const debug = (window as typeof window & {
      __wmLcpDebug?: { getSnapshot?: () => { marks: Array<{ name: string }> } };
    }).__wmLcpDebug;
    return debug?.getSnapshot?.().marks.filter((mark) => mark.name === markName).length ?? 0;
  }, name);
}

async function waitForLcpMark(page: Page, name: string): Promise<void> {
  await page.waitForFunction((markName) => {
    const debug = (window as typeof window & {
      __wmLcpDebug?: { getSnapshot?: () => { marks: Array<{ name: string }> } };
    }).__wmLcpDebug;
    return debug?.getSnapshot?.().marks.some((mark) => mark.name === markName) === true;
  }, name);
}

async function scrollNestedProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.dataset.scrollProbe = 'true';
    Object.assign(probe.style, {
      height: '12px',
      left: '-100px',
      overflowY: 'auto',
      position: 'fixed',
      top: '0',
      width: '12px',
    });
    const content = document.createElement('div');
    content.style.height = '96px';
    probe.append(content);
    document.body.append(probe);

    const state = window as typeof window & { __wmNestedScrollCount?: number };
    state.__wmNestedScrollCount = 0;
    window.addEventListener('scroll', (event) => {
      if (event.target === probe) {
        state.__wmNestedScrollCount = (state.__wmNestedScrollCount ?? 0) + 1;
      }
    }, { capture: true });
    probe.scrollTop = 48;
  });
  await page.waitForFunction(
    () => ((window as typeof window & { __wmNestedScrollCount?: number })
      .__wmNestedScrollCount ?? 0) >= 1,
  );
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

async function installDelayedSlowBootstrap(page: Page): Promise<{
  release: () => void;
  waitUntilRequested: () => Promise<void>;
}> {
  let release!: () => void;
  let markRequested!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    markRequested = resolve;
  });
  await page.route(/\/api\/bootstrap\?tier=slow(?:&|$)/, async (route) => {
    markRequested();
    await released;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: {}, missing: [] }),
    });
  });
  return {
    release,
    waitUntilRequested: () => requested,
  };
}

test.describe('dashboard container scroll hydration (#5876)', () => {
  for (const viewport of [
    // From SPLIT_LAYOUT_MIN_WIDTH (900, src/app/split-layout.ts — #6417) the
    // split layout makes .panels-grid the scroll owner; below it the stacked
    // layout scrolls .main-content.
    { label: 'desktop', width: 1280, height: 720, scrollOwner: 'panels-grid' },
    { label: 'narrow-desktop', width: 850, height: 720, scrollOwner: 'main-content' },
    { label: 'mobile', width: 390, height: 844, scrollOwner: 'main-content' },
    { label: 'ultra-wide', width: 1720, height: 720, scrollOwner: 'panels-grid' },
  ]) {
    test(`${viewport.label} container scroll hydrates a panel-specific data path`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await seedScrollableDashboard(page);
      const stablecoinRequests = await installStablecoinContract(page);

      await page.goto('/');
      await page.waitForFunction(
        () => document.documentElement.dataset.wmEventHandlersReady === 'true',
      );
      await waitForLcpMark(page, INITIAL_FANOUT_COMPLETE_MARK);

      const main = page.locator('.main-content');
      const stablecoins = page.locator('[data-panel="stablecoins"]');
      await expect(main).toBeAttached();
      await expect(stablecoins).toBeAttached();

      const initial = await readScrollMetrics(page);
      expect(initial.owner, 'the layout must use the expected dashboard scroll owner').toBe(
        viewport.scrollOwner,
      );
      expect(initial.scrollHeight, 'the dashboard scroll owner must genuinely overflow').toBeGreaterThan(
        initial.clientHeight,
      );
      expect(initial.scrollTop, 'the test must start before any dashboard scroll').toBe(0);
      expect(
        initial.targetTop,
        'stablecoins must start outside the 400px viewport hydration margin',
      ).toBeGreaterThan(initial.viewportHeight + 400);
      expect(
        stablecoinRequests,
        'the panel-specific request must be absent before scrolling',
      ).toEqual([]);

      const hydrationMarksBeforeNestedScroll = await lcpMarkCount(page, VIEWPORT_HYDRATION_MARK);
      await scrollNestedProbe(page);
      expect(
        await lcpMarkCount(page, VIEWPORT_HYDRATION_MARK),
        'an independently scrollable descendant must not schedule dashboard hydration',
      ).toBe(hydrationMarksBeforeNestedScroll);
      expect(stablecoinRequests, 'a nested scroll must not fetch the deferred panel').toEqual([]);

      const dashboardScroll = await scrollDashboardAndCollect(page);
      expect(dashboardScroll.scrollCount, 'the real dashboard scroll event must fire').toBe(1);

      const afterFirstScroll = dashboardScroll.after;
      expect(afterFirstScroll.scrollTop, 'the dashboard scrollTop must change').toBeGreaterThan(0);
      expect(
        afterFirstScroll.targetTop,
        'the target panel must enter the viewport after the real container scroll',
      ).toBeLessThan(afterFirstScroll.viewportHeight);

      await page.waitForFunction(() => {
        const target = document.querySelector('[data-panel="stablecoins"]');
        return target instanceof HTMLElement && target.dataset.deferredPanel !== 'true';
      });

      await expect.poll(
        () => stablecoinRequests.length,
        { message: 'one dashboard scroll must invoke primeVisiblePanelData for stablecoins' },
      ).toBe(1);
      await expect(stablecoins.locator('.stable-health')).toContainText('HEALTHY');
      expect(stablecoinRequests).toHaveLength(1);
    });
  }

  test('an early scroll waits for slow-tier readiness and hydrates without a second gesture', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await seedScrollableDashboard(page);
    const stablecoinRequests = await installStablecoinContract(page);
    // Register this route last so it takes precedence over the external-network
    // blocker installed by the stablecoin contract when VITE_API_BASE_URL is set.
    const slowBootstrap = await installDelayedSlowBootstrap(page);
    let released = false;

    try {
      // Start navigation without awaiting it: under parallel CI load even
      // DOMContentLoaded can outlive the bounded slow-tier wait. The slow request
      // is the causal signal that the gate is active, so scroll as soon as it is
      // observed and only await navigation after releasing it.
      const navigation = page.goto('/', { waitUntil: 'domcontentloaded' });
      await slowBootstrap.waitUntilRequested();
      await page.waitForFunction(() => (
        document.querySelector('.main-content') instanceof HTMLElement &&
        document.querySelector('.panels-grid') instanceof HTMLElement &&
        document.querySelector('[data-panel="stablecoins"]') instanceof HTMLElement
      ));

      const stablecoins = page.locator('[data-panel="stablecoins"]');
      const dashboardScroll = await scrollDashboardAndCollect(page);
      expect(
        dashboardScroll.before.scrollTop,
        'the test must start before any dashboard scroll',
      ).toBe(0);
      expect(
        dashboardScroll.before.targetTop,
        'stablecoins must start outside the 400px viewport hydration margin',
      ).toBeGreaterThan(dashboardScroll.before.viewportHeight + 400);
      expect(dashboardScroll.scrollCount, 'the real dashboard scroll event must fire').toBe(1);
      await page.waitForFunction(() => {
        const target = document.querySelector('[data-panel="stablecoins"]');
        return target instanceof HTMLElement && target.dataset.deferredPanel !== 'true';
      });
      expect(
        stablecoinRequests,
        'the mounted panel callback must remain gated while slow-tier readiness is pending',
      ).toEqual([]);
      slowBootstrap.release();
      released = true;
      await navigation;

      expect(
        dashboardScroll.after.scrollTop,
        'the dashboard scrollTop must change',
      ).toBeGreaterThan(0);
      expect(
        dashboardScroll.after.targetTop,
        'the target panel must enter the viewport after the real container scroll',
      ).toBeLessThan(dashboardScroll.after.viewportHeight);
      await waitForLcpMark(page, INITIAL_FANOUT_COMPLETE_MARK);
      expect(
        await lcpMarkCount(page, VIEWPORT_HYDRATION_MARK),
        'the early scroll must not schedule or replay a viewport trigger across readiness',
      ).toBe(dashboardScroll.hydrationMarksBefore);
      await expect.poll(
        () => stablecoinRequests.length,
        { message: 'the readiness fan-out must hydrate the already-scrolled panel exactly once' },
      ).toBe(1);
      await expect(stablecoins.locator('.stable-health')).toContainText('HEALTHY');
      expect(stablecoinRequests).toHaveLength(1);
    } finally {
      if (!released) slowBootstrap.release();
    }
  });
});
