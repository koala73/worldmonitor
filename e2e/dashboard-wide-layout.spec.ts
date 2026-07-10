import { expect, test, type Page } from '@playwright/test';

interface WideLayoutMetrics {
  viewportWidth: number;
  scrollWidth: number;
  sectionHeight: number;
  mapHeight: number;
  bottomHeight: number;
  bottomChildren: number;
}

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

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.dataset.wmEventHandlersReady === 'true');
}

async function readWideLayoutMetrics(page: Page): Promise<WideLayoutMetrics> {
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

function hasDragActiveClass(page: Page): Promise<boolean> {
  return page.evaluate(() => document.body.classList.contains('panel-drag-active'));
}

function emptyPlaceholderOpacity(page: Page): Promise<number> {
  return page.evaluate(() => {
    const grid = document.getElementById('mapBottomGrid');
    if (!grid) return 0;
    return parseFloat(getComputedStyle(grid, '::after').opacity || '0');
  });
}

// Begins a panel drag past DRAG_THRESHOLD (8px) without releasing the mouse, so callers
// can assert mid-drag state. The cursor stays in the top-of-grid region, well away from
// the below-map drop zone, so a subsequent mouse.up() does not populate the bottom grid.
async function beginPanelDragInUpperGrid(page: Page): Promise<void> {
  const header = page.locator('#panelsGrid > .panel[data-panel]:not(.hidden) > .panel-header').first();
  await expect(header).toBeVisible();
  const box = await header.boundingBox();
  expect(box, 'first panel header should have a rendered bounding box').not.toBeNull();
  const startX = box!.x + Math.min(48, box!.width / 2);
  const startY = box!.y + box!.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Cross the 8px threshold, then settle a few pixels away — staying in the upper grid.
  await page.mouse.move(startX + 12, startY + 12, { steps: 3 });
  await page.mouse.move(startX + 16, startY + 16, { steps: 3 });
}

test.describe('dashboard wide display layout', () => {
  test('empty map drop zone does not consume the map column and stays collapsed after resize', async ({ page }) => {
    test.setTimeout(30_000);

    await setupDashboard(page, { width: 2537, height: 1270 });
    const initial = await readWideLayoutMetrics(page);

    expect(initial.bottomChildren).toBe(0);
    expect(initial.scrollWidth).toBeLessThanOrEqual(initial.viewportWidth + 1);
    expect(initial.bottomHeight).toBeLessThanOrEqual(4);
    expect(initial.sectionHeight).toBeGreaterThan(100);
    expect(initial.mapHeight).toBeGreaterThan(initial.sectionHeight * 0.85);

    await page.setViewportSize({ width: 1920, height: 1080 });
    await expect
      .poll(async () => (await readWideLayoutMetrics(page)).bottomHeight, { timeout: 2_000, intervals: [50, 100, 200] })
      .toBeLessThanOrEqual(4);
    const resized = await readWideLayoutMetrics(page);

    expect(resized.bottomChildren).toBe(0);
    expect(resized.scrollWidth).toBeLessThanOrEqual(resized.viewportWidth + 1);
    expect(resized.bottomHeight).toBeLessThanOrEqual(4);
    expect(resized.sectionHeight).toBeGreaterThan(100);
    expect(resized.mapHeight).toBeGreaterThan(resized.sectionHeight * 0.85);
  });

  test('empty drop zone re-expands during an active drag and collapses again after release', async ({ page }) => {
    test.setTimeout(30_000);

    await setupDashboard(page, { width: 2537, height: 1270 });

    // Baseline: empty + collapsed.
    await expect
      .poll(async () => (await readWideLayoutMetrics(page)).bottomHeight, { timeout: 2_000, intervals: [50, 100, 200] })
      .toBeLessThanOrEqual(4);
    expect((await readWideLayoutMetrics(page)).bottomChildren).toBe(0);

    await beginPanelDragInUpperGrid(page);

    // panel-drag-active reveals the 120px drop target and its placeholder while still empty.
    await expect.poll(() => hasDragActiveClass(page)).toBe(true);
    await expect
      .poll(async () => (await readWideLayoutMetrics(page)).bottomHeight, { timeout: 2_000, intervals: [50, 100, 200] })
      .toBeGreaterThanOrEqual(100);
    expect(await emptyPlaceholderOpacity(page)).toBeGreaterThan(0);
    expect((await readWideLayoutMetrics(page)).bottomChildren).toBe(0);

    // Release in the upper grid (no drop into the bottom zone) -> class clears, zone re-collapses.
    await page.mouse.up();
    await expect.poll(() => hasDragActiveClass(page)).toBe(false);
    await expect
      .poll(async () => (await readWideLayoutMetrics(page)).bottomHeight, { timeout: 2_000, intervals: [50, 100, 200] })
      .toBeLessThanOrEqual(4);
    expect((await readWideLayoutMetrics(page)).bottomChildren).toBe(0);
  });

  test('Escape during a drag clears panel-drag-active and re-collapses the empty drop zone', async ({ page }) => {
    test.setTimeout(30_000);

    await setupDashboard(page, { width: 2537, height: 1270 });

    await beginPanelDragInUpperGrid(page);
    await expect.poll(() => hasDragActiveClass(page)).toBe(true);
    await expect
      .poll(async () => (await readWideLayoutMetrics(page)).bottomHeight, { timeout: 2_000, intervals: [50, 100, 200] })
      .toBeGreaterThanOrEqual(100);

    await page.keyboard.press('Escape');

    await expect.poll(() => hasDragActiveClass(page)).toBe(false);
    await expect
      .poll(async () => (await readWideLayoutMetrics(page)).bottomHeight, { timeout: 2_000, intervals: [50, 100, 200] })
      .toBeLessThanOrEqual(4);
    expect((await readWideLayoutMetrics(page)).bottomChildren).toBe(0);

    // Release the still-held button; drag state was already torn down by Escape.
    await page.mouse.up();
  });
});
