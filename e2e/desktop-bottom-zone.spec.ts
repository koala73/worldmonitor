import { expect, test, type Page } from '@playwright/test';

const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Tauri/2.0';
const VIEWPORT_HEIGHT = 800;
const TEST_STATE_INITIALIZED_KEY = '__desktop_bottom_zone_test_initialized';

/**
 * #6426/#6417: desktop and web now share one 900px split-layout threshold.
 * Saved bottom-set panels must enter #mapBottomGrid at 900px and return to
 * #panelsGrid at 899px on both runtimes. The earlier desktop-only class and
 * web-only 1600px seam no longer exist.
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

test.describe('desktop bottom zone at the shared split threshold', () => {
  test.use({ userAgent: DESKTOP_USER_AGENT });

  test.beforeEach(async ({ page }) => {
    await clearDashboardState(page);
  });

  test('saved bottom-set panel follows the 899px/900px seam', async ({ page }) => {
    await prepareDashboard(page, 1200);

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

    // Returning to the shared threshold restores the remembered placement.
    await page.setViewportSize({ width: 900, height: VIEWPORT_HEIGHT });
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

test.describe('web bottom zone at the shared split threshold', () => {
  test.beforeEach(async ({ page }) => {
    await clearDashboardState(page);
  });

  test('moves saved panels between the main and bottom grids at 899px/900px', async ({ page }) => {
    await prepareDashboard(page, 899);
    const panelId = await seedBottomPanel(page);
    const seeded = page.locator(panelIn('mapBottomGrid', panelId));

    await expect(page.locator('#mapBottomGrid')).toBeHidden();
    await expect(page.locator(panelIn('panelsGrid', panelId))).toBeVisible({ timeout: 30_000 });

    await page.setViewportSize({ width: 900, height: VIEWPORT_HEIGHT });
    await expect(seeded).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(panelIn('panelsGrid', panelId))).toHaveCount(0);

    await page.setViewportSize({ width: 899, height: VIEWPORT_HEIGHT });
    await expect(page.locator('#mapBottomGrid')).toBeHidden();
    await expect(page.locator(panelIn('panelsGrid', panelId))).toBeVisible({ timeout: 30_000 });
  });
});
