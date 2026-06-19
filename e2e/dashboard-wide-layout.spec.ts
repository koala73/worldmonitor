import { expect, test, type Page } from '@playwright/test';

async function installLocalOnlyNetwork(page: Page): Promise<void> {
  await page.route(/^https?:\/\/(?!(127\.0\.0\.1:4173|localhost:4173)(?:\/|$)).*/i, (route) => {
    return route.abort('blockedbyclient');
  });
}

async function setupDashboard(page: Page, viewport: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(viewport);
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('worldmonitor-variant', 'full');
  });
  await installLocalOnlyNetwork(page);

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.dataset.wmEventHandlersReady === 'true');
}

async function readWideLayoutMetrics(page: Page) {
  return page.evaluate(() => {
    const mapSection = document.getElementById('mapSection');
    const mapContainer = document.getElementById('mapContainer');
    const bottomGrid = document.getElementById('mapBottomGrid');
    if (!mapSection || !mapContainer || !bottomGrid) {
      throw new Error('Dashboard map layout nodes were not rendered');
    }

    const mapRect = mapContainer.getBoundingClientRect();
    const bottomRect = bottomGrid.getBoundingClientRect();
    const sectionRect = mapSection.getBoundingClientRect();

    return {
      viewportWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      sectionHeight: sectionRect.height,
      mapHeight: mapRect.height,
      bottomHeight: bottomRect.height,
      bottomChildren: bottomGrid.children.length,
    };
  });
}

test.describe('dashboard wide display layout', () => {
  test('empty map drop zone does not consume the map column and stays collapsed after resize', async ({ page }) => {
    test.setTimeout(150_000);

    await setupDashboard(page, { width: 2537, height: 1270 });
    const initial = await readWideLayoutMetrics(page);

    expect(initial.bottomChildren).toBe(0);
    expect(initial.scrollWidth).toBeLessThanOrEqual(initial.viewportWidth + 1);
    expect(initial.bottomHeight).toBeLessThanOrEqual(4);
    expect(initial.mapHeight).toBeGreaterThan(initial.sectionHeight * 0.85);

    await page.setViewportSize({ width: 1920, height: 1080 });
    await expect.poll(() => readWideLayoutMetrics(page)).toMatchObject({
      bottomChildren: 0,
    });
    const resized = await readWideLayoutMetrics(page);

    expect(resized.scrollWidth).toBeLessThanOrEqual(resized.viewportWidth + 1);
    expect(resized.bottomHeight).toBeLessThanOrEqual(4);
    expect(resized.mapHeight).toBeGreaterThan(resized.sectionHeight * 0.85);
  });
});
