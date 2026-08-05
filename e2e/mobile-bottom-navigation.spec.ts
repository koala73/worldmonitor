import { devices, expect, test } from '@playwright/test';

const { defaultBrowserType, ...mobileDevice } = devices['Pixel 7'];
void defaultBrowserType;

test.describe('mobile primary navigation (#5201 P0)', () => {
  test.use({ ...mobileDevice });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.removeItem('mobile-map-collapsed');
      localStorage.setItem('wm-layer-warning-dismissed', 'true');
    });
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('data-wm-event-handlers-ready', 'true', { timeout: 45_000 });
  });

  test('uses Today as home and switches between Map, Search, Alerts, and More', async ({ page }) => {
    const tabs = page.locator('#mobileTabBar');
    await expect(tabs).toBeVisible();
    await expect(page.locator('#mapSection')).toHaveClass(/collapsed/);
    await expect(page.locator('.site-footer')).toBeHidden();
    await expect(page.locator('.hamburger-btn')).toBeHidden();
    await expect(page.locator('#searchMobileFab')).toHaveCount(0);

    const tabBox = await tabs.boundingBox();
    expect(tabBox).not.toBeNull();
    const viewportHeight = await page.evaluate(() => window.innerHeight);
    expect(Math.abs((tabBox?.y ?? 0) + (tabBox?.height ?? 0) - viewportHeight)).toBeLessThanOrEqual(2);

    await page.locator('[data-mobile-tab="map"]').click();
    await expect(page.locator('#mapSection')).toHaveClass(/live-news-fullscreen/);
    const mapBox = await page.locator('#mapSection').boundingBox();
    expect(mapBox).not.toBeNull();
    expect((mapBox?.y ?? 0) + (mapBox?.height ?? 0)).toBeLessThanOrEqual((tabBox?.y ?? 844) + 2);

    await page.locator('[data-mobile-tab="search"]').click();
    await expect(page.locator('#mapSection')).not.toHaveClass(/live-news-fullscreen/);
    await expect(page.locator('.search-overlay.search-mobile')).toHaveClass(/open/);
    await page.evaluate(() => history.back());
    await expect(page.locator('.search-overlay.search-mobile')).toHaveCount(0, { timeout: 2_000 });
    await expect(page.locator('[data-mobile-tab="today"]')).toHaveAttribute('aria-current', 'page');

    await page.locator('[data-mobile-tab="more"]').click();
    await expect(page.locator('#mobileMenu')).toHaveClass(/open/);
    await expect(page.locator('#mobileAuthFallback, #mobileAuthWidgetMount .auth-signin-btn').first()).toBeVisible();
    await page.evaluate(() => history.back());
    await expect(page.locator('#mobileMenu')).not.toHaveClass(/open/);
    await expect(page.locator('[data-mobile-tab="today"]')).toHaveAttribute('aria-current', 'page');

    await page.locator('[data-mobile-tab="alerts"]').click();
    await expect(page.locator('[data-mobile-tab="alerts"]')).toHaveAttribute('aria-current', 'page');
  });

  test('uses one Back press for the More to Region sheet transition', async ({ page }) => {
    await page.locator('[data-mobile-tab="more"]').click();
    await page.locator('#mobileMenuRegion').click();
    await expect(page.locator('#mobileMenu')).not.toHaveClass(/open/);
    await expect(page.locator('#regionBottomSheet')).toHaveClass(/open/);
    await expect.poll(async () => page.evaluate(() => document.body.style.overflow)).toBe('hidden');

    const historyMarker = await page.evaluate(() => history.state?.__wmOverlay?.id ?? null);
    expect(historyMarker).toBe('region');
    await page.evaluate(() => history.back());
    await expect(page.locator('#regionBottomSheet')).not.toHaveClass(/open/);
    await expect(page.locator('#mobileMenu')).not.toHaveClass(/open/);
    await expect.poll(async () => page.evaluate(() => document.body.style.overflow)).toBe('');
  });

  test('atomically replaces More with Search in one history entry', async ({ page }) => {
    const baselineHistoryLength = await page.evaluate(() => history.length);
    await page.locator('[data-mobile-tab="more"]').click();
    await page.locator('[data-mobile-tab="search"]').click();
    const search = page.locator('.search-overlay.search-mobile');
    await expect(search).toHaveClass(/open/);
    await expect.poll(async () => page.evaluate(() => history.state?.__wmOverlay?.id ?? null)).toBe('search');
    expect(await page.evaluate(() => history.length)).toBe(baselineHistoryLength + 1);

    await page.evaluate(() => history.back());
    await expect(search).toHaveCount(0);
    await expect(page.locator('#mobileMenu')).not.toHaveClass(/open/);
  });

  test('reconciles open overlays before primary-tab actions and toggles re-taps closed', async ({ page }) => {
    const searchTab = page.locator('[data-mobile-tab="search"]');
    const search = page.locator('.search-overlay.search-mobile');
    await searchTab.click();
    await expect(search).toHaveClass(/open/);

    await searchTab.click();
    await expect(search).toHaveCount(0);
    await expect(page.locator('[data-mobile-tab="today"]')).toHaveAttribute('aria-current', 'page');

    await page.locator('[data-mobile-tab="more"]').click();
    await expect(page.locator('#mobileMenu')).toHaveClass(/open/);
    await page.locator('[data-mobile-tab="alerts"]').click();
    await expect(page.locator('#mobileMenu')).not.toHaveClass(/open/);
    await expect(page.locator('[data-mobile-tab="alerts"]')).toHaveAttribute('aria-current', 'page');
  });

  test('Back cancels a pending lazy Search transition', async ({ page }) => {
    let releaseSearch!: () => void;
    const searchReleased = new Promise<void>((resolve) => { releaseSearch = resolve; });
    await page.route('**/src/app/search-manager.ts*', async (route) => {
      await searchReleased;
      await route.continue();
    });

    await page.locator('[data-mobile-tab="search"]').click();
    await expect.poll(async () => page.evaluate(() => history.state?.__wmOverlay?.id ?? null)).toBe('search-pending');
    await page.evaluate(() => history.back());
    releaseSearch();

    await expect(page.locator('.search-overlay.search-mobile')).toHaveCount(0);
    await expect(page.locator('[data-mobile-tab="today"]')).toHaveAttribute('aria-current', 'page');
  });

  test('keyboard Search coalesces with a pending mobile tab load', async ({ page }) => {
    let releaseSearch!: () => void;
    const searchReleased = new Promise<void>((resolve) => { releaseSearch = resolve; });
    await page.route('**/src/app/search-manager.ts*', async (route) => {
      await searchReleased;
      await route.continue();
    });

    const baselineHistoryLength = await page.evaluate(() => history.length);
    await page.locator('[data-mobile-tab="search"]').click();
    await expect.poll(async () => page.evaluate(() => history.state?.__wmOverlay?.id ?? null)).toBe('search-pending');
    await page.keyboard.press('Control+k');
    releaseSearch();

    const search = page.locator('.search-overlay.search-mobile');
    await expect(search).toHaveClass(/open/);
    await expect.poll(async () => page.evaluate(() => history.state?.__wmOverlay?.id ?? null)).toBe('search');
    expect(await page.evaluate(() => history.length)).toBe(baselineHistoryLength + 1);
    await page.evaluate(() => history.back());
    await expect(search).toHaveCount(0);
  });

  test('Back cancels a pending lazy Settings transition', async ({ page }) => {
    let releaseSettings!: () => void;
    const settingsReleased = new Promise<void>((resolve) => { releaseSettings = resolve; });
    await page.route('**/src/components/UnifiedSettings.ts*', async (route) => {
      await settingsReleased;
      await route.continue();
    });

    await page.locator('[data-mobile-tab="more"]').click();
    await page.locator('#mobileMenuSettings').click();
    await expect.poll(async () => page.evaluate(() => history.state?.__wmOverlay?.id ?? null)).toBe('settings-pending');
    await page.evaluate(() => history.back());
    releaseSettings();

    await expect(page.locator('#unifiedSettingsModal')).toHaveCount(0);
    await expect(page.locator('[data-mobile-tab="today"]')).toHaveAttribute('aria-current', 'page');
  });

  test('Back-cancelled Settings load failure stays silent', async ({ page }) => {
    let rejectSettings!: () => void;
    const settingsRejected = new Promise<void>((resolve) => { rejectSettings = resolve; });
    await page.route('**/src/components/UnifiedSettings.ts*', async (route) => {
      await settingsRejected;
      await route.abort('failed');
    });

    await page.locator('[data-mobile-tab="more"]').click();
    await page.locator('#mobileMenuSettings').click();
    await expect.poll(async () => page.evaluate(() => history.state?.__wmOverlay?.id ?? null)).toBe('settings-pending');
    await page.evaluate(() => history.back());
    rejectSettings();

    await expect(page.locator('#unifiedSettingsModal')).toHaveCount(0);
    await expect(page.locator('[data-mobile-tab="today"]')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.toast-notification')).toHaveCount(0);
  });

  test('control-dismissed Search removes its synthetic history marker', async ({ page }) => {
    const search = page.locator('.search-overlay.search-mobile');

    await page.locator('[data-mobile-tab="search"]').click();
    await expect(search).toHaveClass(/open/);
    await expect.poll(async () => page.evaluate(() => history.state?.__wmOverlay?.id ?? null)).toBe('search');
    await search.locator('.search-sheet-cancel').click();
    await expect(search).toHaveCount(0, { timeout: 2_000 });
    await expect.poll(async () => page.evaluate(() => history.state?.__wmOverlay?.id ?? null)).toBeNull();

    await page.locator('[data-mobile-tab="search"]').click();
    await expect(search).toHaveClass(/open/);
    await expect.poll(async () => page.evaluate(() => history.state?.__wmOverlay?.id ?? null)).toBe('search');
    await search.click({ position: { x: 2, y: 2 } });
    await expect(search).toHaveCount(0, { timeout: 2_000 });
    await expect.poll(async () => page.evaluate(() => history.state?.__wmOverlay?.id ?? null)).toBeNull();
  });

  test('closes Settings with browser Back after opening it from More', async ({ page }) => {
    const baselineHistoryLength = await page.evaluate(() => history.length);
    await page.locator('[data-mobile-tab="more"]').click();
    await page.locator('#mobileMenuSettings').click();
    const settings = page.locator('#unifiedSettingsModal');
    await expect(settings).toHaveClass(/active/);
    await expect.poll(async () => page.evaluate(() => history.state?.__wmOverlay?.id ?? null)).toBe('settings');
    expect(await page.evaluate(() => history.length)).toBe(baselineHistoryLength + 1);

    await page.evaluate(() => history.back());
    await expect(settings).not.toHaveClass(/active/);
  });

  test('Back with unsaved Settings changes opens one responsive confirm', async ({ page }) => {
    await page.locator('[data-mobile-tab="more"]').click();
    await page.locator('#mobileMenuSettings').click();
    const settings = page.locator('#unifiedSettingsModal');
    await expect(settings).toHaveClass(/active/);

    await page.locator('#us-tab-panels').click();
    await page.locator('.panel-toggle-item:not(.pro-locked)').first().click();
    await page.evaluate(() => history.back());

    const confirm = page.locator('.confirm-dialog-overlay');
    await expect(confirm).toHaveCount(1);
    await expect(confirm).toHaveClass(/active/);
    await page.evaluate(() => history.back());
    await expect(confirm).toHaveCount(1);
    await expect(settings).toHaveClass(/active/);
    await expect.poll(async () => page.evaluate(() => history.state?.__wmOverlay?.id ?? null)).toBe('settings');
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expect(settings).toHaveClass(/active/);
    await expect.poll(async () => page.evaluate(() => history.state?.__wmOverlay?.id ?? null)).toBe('settings');
  });

  test('primary-tab transitions preserve unsaved Settings changes', async ({ page }) => {
    await page.locator('[data-mobile-tab="more"]').click();
    await page.locator('#mobileMenuSettings').click();
    const settings = page.locator('#unifiedSettingsModal');
    await expect(settings).toHaveClass(/active/);
    await page.locator('#us-tab-panels').click();
    await page.locator('.panel-toggle-item:not(.pro-locked)').first().click();

    await page.locator('[data-mobile-tab="search"]').click();
    await expect(page.locator('.confirm-dialog-overlay')).toHaveCount(1);
    await expect(settings).toHaveClass(/active/);
    await expect(page.locator('.search-overlay.search-mobile')).toHaveCount(0);
    await expect.poll(async () => page.evaluate(() => history.state?.__wmOverlay?.id ?? null)).toBe('settings');
    await page.keyboard.press('Escape');
    await expect(page.locator('.confirm-dialog-overlay')).toHaveCount(0);
    await expect(settings).toHaveClass(/active/);
  });

  test('reveals an enabled alert panel and reports when none are enabled', async ({ page }) => {
    const strategicRisk = page.locator('#panelsGrid [data-panel="strategic-risk"]');
    await expect(strategicRisk).toHaveCount(1);
    await page.locator('#panelsGrid [data-panel="oref-sirens"], #panelsGrid [data-panel="intel"]').evaluateAll((panels) => {
      panels.forEach((panel) => panel.classList.add('hidden'));
    });
    await strategicRisk.evaluate((panel) => {
      panel.classList.remove('hidden');
    });

    await page.locator('[data-mobile-tab="alerts"]').click();
    await expect(strategicRisk).toBeInViewport();

    await page.locator('#panelsGrid [data-panel="strategic-risk"], #panelsGrid [data-panel="oref-sirens"], #panelsGrid [data-panel="intel"]').evaluateAll((panels) => {
      panels.forEach((panel) => panel.classList.add('hidden'));
    });
    await page.locator('[data-mobile-tab="alerts"]').click();
    await expect(page.locator('.toast-notification')).toContainText('No active alerts yet');
  });
});

test.describe('desktop navigation parity (#5201 P0)', () => {
  test('keeps the existing footer and does not expose the mobile tab bar', async ({ page }) => {
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('data-wm-event-handlers-ready', 'true', { timeout: 45_000 });
    await expect(page.locator('#mobileTabBar')).toBeHidden();
    await expect(page.locator('.site-footer')).toBeVisible();
    await expect(page.locator('#mapSection')).not.toHaveClass(/collapsed/);
  });
});
