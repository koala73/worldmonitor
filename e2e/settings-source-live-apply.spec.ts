import { expect, test, type Page } from '@playwright/test';

/**
 * Settings → SOURCES must reach the live dashboard when the modal closes (#6380).
 *
 * `toggleSource` / `setSourcesEnabled` (src/app/event-handlers.ts) mutate
 * `ctx.disabledSources` and persist it, and DataLoader does read that set — but
 * only at fetch time. Nothing subscribed to the write, so the new source
 * selection first took effect at RefreshScheduler's `news` tick
 * (`REFRESH_INTERVALS.feeds`, 20 minutes) or on the next reload. To the user
 * that reads as "I changed a setting and nothing happened".
 *
 * The digest request is the observable: `loadNews()` calls `tryFetchDigest()`
 * every run, so one extra `list-feed-digest` after the modal closes means the
 * news load re-ran, and zero means it did not.
 *
 * The second assertion is the other half, and the reason this was not folded
 * into #6379: news request volume is budgeted (#5376,
 * e2e/dashboard-news-request-budget.spec.ts). A refetch per click while the user
 * works through the source grid would trade a 20-minute delay for a request
 * storm. Several toggles in one settings session must still cost exactly one
 * news load.
 */

const DIGEST_GLOB = '**/api/news/v1/list-feed-digest*';

/**
 * Long enough for a second news load to arrive if one is coming.
 *
 * Matches SECOND_LOAD_SETTLE_MS in dashboard-news-request-budget.spec.ts: the
 * two production digest requests that spec was written for landed 1.2 s apart,
 * and this is a wide margin over that on a local dev server.
 */
const SETTLE_MS = 8_000;

/** How many sources to toggle in the storm test. */
const TOGGLE_COUNT = 3;

type DigestLog = { urls: string[] };

/**
 * Serve a healthy two-category digest and count every request for it.
 *
 * Item-bearing buckets are unnecessary — this spec measures request accounting,
 * not rendering — but the digest must carry at least one category: `tryFetchDigest`
 * treats a 200 with zero categories as an outage (#5877), which would leave the
 * load unlanded and `loadedNewsSignature` null, and a null signature re-arms the
 * news gate on every trigger. The "exactly one extra request" assertion would
 * then be measuring a broken gate rather than this fix.
 */
async function installDigestAccounting(page: Page): Promise<DigestLog> {
  const log: DigestLog = { urls: [] };

  // Catch-all first: later-registered routes win in Playwright, so the digest
  // handler below still sees its own traffic.
  await page.route(/^https?:\/\/(?!(127\.0\.0\.1:4173|localhost:4173)(?:\/|$)).*/i, (route) => {
    return route.abort('blockedbyclient');
  });

  await page.route(DIGEST_GLOB, async (route) => {
    log.urls.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        categories: {
          politics: { items: [] },
          intel: { items: [] },
        },
        feedStatuses: {},
        generatedAt: new Date(0).toISOString(),
      }),
    });
  });

  return log;
}

async function seedProFullVariant(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // Seed once per tab: addInitScript re-runs on every navigation, and a
    // re-seed would wipe the source preferences this spec sets from the UI.
    if (sessionStorage.getItem('__settings_source_live_apply_seeded__')) return;
    localStorage.clear();
    sessionStorage.clear();
    sessionStorage.setItem('__settings_source_live_apply_seeded__', '1');
    localStorage.setItem('worldmonitor-variant', 'full');
    // Pro so boot leaves the source selection alone. A free profile runs
    // reconcileSourceLimitForTier (App.ts), which auto-disables sources down to
    // FREE_MAX_SOURCES (80) — the full variant ships well over that — and
    // persists the result to `disabledFeeds`. That is a source-set mutation this
    // spec did not make, arriving on the same clock as the one it measures.
    localStorage.setItem('wm-pro-key', 'e2e-source-live-apply');
    // Overlays that would otherwise steal the click target.
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('wm-pro-banner-launched-dismissed', String(Date.now()));
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
  });
}

/**
 * Boot the dashboard and wait until the news gate has settled.
 *
 * Returns once exactly one digest has been requested and the settle window has
 * passed with no second one. That is the positive control for every later
 * assertion: without it, a dashboard still issuing background news loads would
 * make an extra digest after the modal closes look like this fix working.
 */
async function bootUntilNewsSettles(page: Page): Promise<DigestLog> {
  const log = await installDigestAccounting(page);

  const firstDigest = page.waitForRequest(DIGEST_GLOB);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.documentElement.dataset.wmEventHandlersReady === 'true',
  );
  await firstDigest;
  await page.waitForTimeout(SETTLE_MS);

  expect(
    log.urls.length,
    `the news gate must be quiet before Settings is opened, or an extra digest afterwards ` +
      `proves nothing (requests so far: ${log.urls.length})`,
  ).toBe(1);

  return log;
}

/** Open Settings and switch to the SOURCES tab. */
async function openSourcesTab(page: Page): Promise<void> {
  const settingsBtn = page.locator('#unifiedSettingsBtn');
  await expect(settingsBtn).toBeVisible({ timeout: 60_000 });
  await settingsBtn.click();
  await page.locator('#us-tab-sources').click();
  await expect(page.locator('#usSourceToggles .source-toggle-item').first()).toBeVisible({
    timeout: 15_000,
  });
}

/**
 * Disable the first `count` currently-enabled sources, one click each.
 *
 * Names are read up front and each click re-selects by `data-source`, because
 * every toggle re-renders the whole grid — an index-based locator would go
 * stale between clicks.
 */
async function disableFirstSources(page: Page, count: number): Promise<string[]> {
  const names = await page
    .locator('#usSourceToggles .source-toggle-item.active')
    .evaluateAll((items, wanted) => items
      .slice(0, wanted as number)
      .map((item) => (item as HTMLElement).dataset.source ?? ''), count);

  expect(
    names.filter(Boolean).length,
    `the sources grid must offer at least ${count} enabled sources to turn off`,
  ).toBe(count);

  for (const name of names) {
    const toggle = page.locator(`#usSourceToggles .source-toggle-item[data-source="${name}"]`);
    await expect(toggle).toHaveClass(/\bactive\b/);
    await toggle.click();
    await expect(toggle).not.toHaveClass(/\bactive\b/);
  }

  return names;
}

test.describe('settings source live apply (#6380)', () => {
  test('toggling sources and closing Settings reloads news once, without a reload', async ({ page }) => {
    await seedProFullVariant(page);
    const log = await bootUntilNewsSettles(page);
    // #6724: snapshot the count AFTER the boot check passes, so a late boot
    // digest is never charged to the toggle assertion below.
    const baseline = log.urls.length;

    await openSourcesTab(page);
    const disabled = await disableFirstSources(page, TOGGLE_COUNT);

    // Clicking inside the modal must not refetch — the overlay covers the
    // dashboard, so a per-click load is pure request spend the user cannot see.
    // #6724: a late boot digest that lands after the SETTLE_MS window but
    // before this assertion was charged to the toggle. Snapshot the count
    // after the boot check passes, then assert the delta across the modal
    // interaction — a straggler that predates the modal cannot inflate it.
    expect(
      log.urls.length - baseline,
      `toggling ${TOGGLE_COUNT} sources inside the open modal must not issue a news load ` +
        `(requests since boot settle: ${log.urls.length - baseline}, baseline: ${baseline})`,
    ).toBe(0);

    const secondDigest = page.waitForRequest(DIGEST_GLOB, { timeout: 30_000 });
    await page.locator('.unified-settings-close').click();

    // No reload between the close click and this request.
    await secondDigest;

    // ...and exactly one, not one per toggle. Wait out the same window the boot
    // check used, so a delayed storm cannot slip past after the first arrival.
    // #6724: same baseline-delta pattern as the toggle assertion above.
    await page.waitForTimeout(SETTLE_MS);
    expect(
      log.urls.length - baseline,
      `disabling ${disabled.length} sources (${disabled.join(', ')}) must cost exactly one ` +
        `extra news load, not one per click (requests since baseline: ${log.urls.length - baseline})`,
    ).toBe(1);
  });

  test('closing Settings without touching sources issues no news load', async ({ page }) => {
    await seedProFullVariant(page);
    const log = await bootUntilNewsSettles(page);
    // #6724: same baseline-delta pattern.
    const baseline = log.urls.length;

    await openSourcesTab(page);
    await page.locator('.unified-settings-close').click();
    await page.waitForTimeout(SETTLE_MS);

    expect(
      log.urls.length - baseline,
      `an unchanged source selection has the same news work-list, so closing Settings must ` +
        `not spend a digest request (requests since baseline: ${log.urls.length - baseline})`,
    ).toBe(0);
  });
});
