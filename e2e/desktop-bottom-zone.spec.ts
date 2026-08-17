import { expect, test, type Page } from '@playwright/test';

const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Tauri/2.0';
const VIEWPORT_HEIGHT = 800;
const TEST_STATE_INITIALIZED_KEY = '__desktop_bottom_zone_test_initialized';

/**
 * #6426: the desktop app treats >= 900px as ultrawide (getUltraWideMinWidth,
 * src/app/panel-layout.ts) and moves saved bottom-set panels into
 * #mapBottomGrid — but panels.css hid that container below 1600px
 * unconditionally, so for any desktop window in the 900-1599px band the
 * user's bottom-zone panels sat in a display:none container with nothing
 * indicating where they went.
 *
 * The web bundle is booted in desktop mode through isDesktopRuntime()'s
 * user-agent sniff ("Tauri" in navigator.userAgent) — the same signal the
 * packaged app can be detected by — so this runs against the standard e2e
 * dev server without a desktop build.
 */

async function prepareDashboard(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.dataset.wmEventHandlersReady === 'true');
}

async function seedBottomPanel(page: Page): Promise<string> {
  const firstPanel = page.locator('#panelsGrid > .panel[data-panel]').first();
  await expect(firstPanel).toBeAttached({ timeout: 60_000 });
  const panelId = await firstPanel.getAttribute('data-panel');
  expect(panelId).toBeTruthy();

  await page.evaluate((id) => {
    const order = Array.from(document.querySelectorAll('.panel[data-panel]'))
      .map((el) => (el as HTMLElement).dataset.panel)
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    localStorage.setItem('panel-order', JSON.stringify(order));
    localStorage.setItem('panel-order-bottom-set', JSON.stringify([id]));
  }, panelId);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.dataset.wmEventHandlersReady === 'true');

  return panelId!;
}

function panelIn(grid: string, panelId: string) {
  return `#${grid} .panel[data-panel="${panelId}"]`;
}

async function clearDashboardState(page: Page): Promise<void> {
  await page.addInitScript((initializedKey) => {
    if (localStorage.getItem(initializedKey) === 'true') return;
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('worldmonitor-variant', 'happy');
    localStorage.setItem(initializedKey, 'true');
  }, TEST_STATE_INITIALIZED_KEY);
}

test.describe('desktop bottom zone in the 900-1599px band', () => {
  test.use({ userAgent: DESKTOP_USER_AGENT });

  test.beforeEach(async ({ page }) => {
    await clearDashboardState(page);
  });

  test('saved bottom-set panel follows both desktop breakpoint seams', async ({ page }) => {
    await prepareDashboard(page, 1200);
    // The Tauri UA sniff must have produced the desktop layout, or the band
    // under test does not exist.
    await expect(page.locator('main.main-content.desktop-grid')).toHaveCount(1, { timeout: 30_000 });

    // Discover a real panel id in this variant, then persist it as the
    // bottom set the same way savePanelOrder() does. Both keys are needed:
    // applySavedPanelOrder() early-returns when `panel-order` is absent, so
    // seeding only the bottom-set key never reaches the zone logic. The app
    // readiness marker is required so initPanelTabs() cannot overwrite the
    // seed with its still-empty in-memory bottom set.
    const panelId = await seedBottomPanel(page);

    // The panel must land in the bottom grid AND be visible — before the
    // fix it landed there but the container was display:none !important.
    const seeded = page.locator(panelIn('mapBottomGrid', panelId));
    await expect(seeded).toBeVisible({ timeout: 60_000 });

    // The desktop threshold is inclusive: 900px keeps the panel in the
    // bottom zone, while 899px moves it back to the main grid.
    await page.setViewportSize({ width: 900, height: VIEWPORT_HEIGHT });
    await expect(seeded).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(panelIn('panelsGrid', panelId))).toHaveCount(0);

    await page.setViewportSize({ width: 899, height: VIEWPORT_HEIGHT });
    await expect(page.locator(panelIn('panelsGrid', panelId))).toBeVisible({ timeout: 30_000 });
    await expect(seeded).toHaveCount(0);

    // Returning above the desktop threshold restores the remembered bottom
    // placement, including the upper edge of the web-only hide band.
    await page.setViewportSize({ width: 1599, height: VIEWPORT_HEIGHT });
    await expect(seeded).toBeVisible({ timeout: 30_000 });
    await page.setViewportSize({ width: 1600, height: VIEWPORT_HEIGHT });
    await expect(seeded).toBeVisible({ timeout: 30_000 });
  });

  test('empty bottom zone stays collapsed in the desktop band', async ({ page }) => {
    await prepareDashboard(page, 1200);

    const metrics = await page.evaluate(() => {
      const grid = document.getElementById('mapBottomGrid');
      if (!grid) throw new Error('map bottom grid was not rendered');
      return { children: grid.children.length, height: grid.getBoundingClientRect().height };
    });

    expect(metrics.children).toBe(0);
    expect(metrics.height).toBeLessThanOrEqual(4);
  });
});

test.describe('web bottom zone below the web breakpoint', () => {
  test.beforeEach(async ({ page }) => {
    await clearDashboardState(page);
  });

  test('keeps the bottom zone hidden through 1599px and shows it at 1600px', async ({ page }) => {
    await prepareDashboard(page, 1200);
    await expect(page.locator('main.main-content.desktop-grid')).toHaveCount(0);

    const panelId = await seedBottomPanel(page);
    const seeded = page.locator(panelIn('mapBottomGrid', panelId));

    await expect(page.locator('#mapBottomGrid')).toBeHidden();
    await expect(page.locator(panelIn('panelsGrid', panelId))).toBeVisible({ timeout: 30_000 });

    await page.setViewportSize({ width: 1599, height: VIEWPORT_HEIGHT });
    await expect(page.locator('#mapBottomGrid')).toBeHidden();
    await expect(page.locator(panelIn('panelsGrid', panelId))).toBeVisible({ timeout: 30_000 });

    await page.setViewportSize({ width: 1600, height: VIEWPORT_HEIGHT });
    await expect(seeded).toBeVisible({ timeout: 30_000 });
  });
});
