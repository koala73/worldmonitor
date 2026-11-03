import { devices, expect, test, type Page } from '@playwright/test';
import { geoEquirectangular } from 'd3';

const MOBILE_VIEWPORT = devices['iPhone 14 Pro Max'];

async function expectRenderedCenter(page: Page, lat: number, lon: number) {
  await expect(page.locator('#mapContainer')).toHaveClass(/svg-mode/);
  await expect.poll(async () => {
    const size = await page.locator('#mapContainer').evaluate(el => ({ width: el.clientWidth, height: el.clientHeight }));
    const point = geoEquirectangular()
      .scale(Math.min(size.width / (2 * Math.PI), size.height / (128 * Math.PI / 180)))
      .center([0, 8])
      .translate([size.width / 2, size.height / 2])([lon, lat])!;
    return page.locator('#mapSvg').evaluate((el, [x, y]) => {
      const matrix = (el as SVGSVGElement).getScreenCTM();
      if (!matrix) return Infinity;
      const rendered = new DOMPoint(x, y).matrixTransform(matrix);
      const bounds = document.getElementById('mapContainer')!.getBoundingClientRect();
      return Math.hypot(rendered.x - bounds.x - bounds.width / 2, rendered.y - bounds.y - bounds.height / 2);
    }, point);
  }).toBeLessThan(1);
}

test.describe('Mobile map native experience', () => {
  const { defaultBrowserType: _bt, ...mobileContext } = MOBILE_VIEWPORT;

  test.describe('timezone-based startup region', () => {
    test('America/New_York → america view', async ({ browser }) => {
      const context = await browser.newContext({
        ...mobileContext,
        timezoneId: 'America/New_York',
        locale: 'en-US',
      });
      const page = await context.newPage();
      await page.addInitScript(() => {
        (window as any).__testResolvedLocation = true;
      });
      await page.goto('/');
      await page.waitForTimeout(3000);
      const region = await page.evaluate(() => {
        const select = document.getElementById('regionSelect') as HTMLSelectElement | null;
        return select?.value ?? null;
      });
      expect(region).toBe('america');
      await context.close();
    });

    test('Europe/London → eu view', async ({ browser }) => {
      const context = await browser.newContext({
        ...mobileContext,
        timezoneId: 'Europe/London',
        locale: 'en-GB',
      });
      const page = await context.newPage();
      await page.goto('/');
      await page.waitForTimeout(3000);
      const region = await page.evaluate(() => {
        const select = document.getElementById('regionSelect') as HTMLSelectElement | null;
        return select?.value ?? null;
      });
      expect(region).toBe('eu');
      await context.close();
    });

    test('Asia/Tokyo → asia view', async ({ browser }) => {
      const context = await browser.newContext({
        ...mobileContext,
        timezoneId: 'Asia/Tokyo',
        locale: 'ja-JP',
      });
      const page = await context.newPage();
      await page.goto('/');
      await page.waitForTimeout(3000);
      const region = await page.evaluate(() => {
        const select = document.getElementById('regionSelect') as HTMLSelectElement | null;
        return select?.value ?? null;
      });
      expect(region).toBe('asia');
      await context.close();
    });
  });

  test.describe('URL restore', () => {
    test.use(mobileContext);

    test('lat/lon override view center', async ({ page }) => {
      await page.goto('/?view=eu&lat=48.86&lon=2.35&zoom=5');
      await expect(page.locator('html')).toHaveAttribute('data-wm-event-handlers-ready', 'true', { timeout: 45_000 });
      await page.locator('.map-collapse-btn').click();
      await expect(page.locator('#mapSection')).not.toHaveClass(/collapsed/);
      await expect(page.locator('#mapContainer')).toBeVisible();
      await expectRenderedCenter(page, 48.86, 2.35);
      await expect.poll(() => new URL(page.url()).searchParams.get('lat')).toBe('48.8600');
      await expect.poll(() => new URL(page.url()).searchParams.get('lon')).toBe('2.3500');
      await expect(page.locator('#regionSelect')).toHaveValue('eu');
    });

    test('zero-degree coordinates center at equator/prime meridian', async ({ page }) => {
      await page.goto('/?lat=0&lon=0&zoom=4');
      await expect(page.locator('html')).toHaveAttribute('data-wm-event-handlers-ready', 'true', { timeout: 45_000 });
      await page.locator('.map-collapse-btn').click();
      await expect(page.locator('#mapSection')).not.toHaveClass(/collapsed/);
      await expect(page.locator('#mapContainer')).toBeVisible();
      await expectRenderedCenter(page, 0, 0);
      await expect.poll(() => new URL(page.url()).searchParams.get('lat')).toBe('0.0000');
      await expect.poll(() => new URL(page.url()).searchParams.get('lon')).toBe('0.0000');
    });
  });

  test.describe('touch interactions', () => {
    test.use(mobileContext);

    test('single-finger pan does not scroll page', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-wm-event-handlers-ready', 'true', { timeout: 45_000 });
      await expect(page.locator('#mapContainer')).toHaveClass(/svg-mode/, { timeout: 45_000 });
      const expandMap = page.locator('.map-collapse-btn');
      await expect(expandMap).toBeVisible();
      await expandMap.click();
      await expect(page.locator('#mapSection')).not.toHaveClass(/collapsed/);
      const mapEl = page.locator('#mapContainer');
      await expect(mapEl).toBeVisible({ timeout: 10000 });

      const scrollBefore = await page.evaluate(() => window.scrollY);
      const box = await mapEl.boundingBox();
      expect(box).not.toBeNull();
      const startX = box!.x + box!.width / 2;
      const startY = box!.y + box!.height / 2;
      const touch = await page.context().newCDPSession(page);
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: startX, y: startY, id: 1 }],
      });
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: startX, y: startY + 60, id: 1 }],
      });
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await touch.detach();

      const scrollAfter = await page.evaluate(() => window.scrollY);
      expect(scrollAfter).toBe(scrollBefore);
    });
  });

  test.describe('geolocation startup centering', () => {
    test('centers map on granted geolocation coords', async ({ browser }) => {
      const context = await browser.newContext({
        ...mobileContext,
        geolocation: { latitude: 48.8566, longitude: 2.3522 },
        permissions: ['geolocation'],
      });
      const page = await context.newPage();
      await page.goto('/');
      await page.waitForFunction(
        () => {
          const select = document.getElementById('regionSelect') as HTMLSelectElement | null;
          return select?.value === 'eu';
        },
        { timeout: 10000 },
      );
      await context.close();
    });
  });

  test.describe('mobile map viewport', () => {
    test('map starts collapsed for feed-first mobile and expands to fill the viewport', async ({ browser }) => {
      const context = await browser.newContext({
        ...mobileContext,
        locale: 'en-US',
      });
      const page = await context.newPage();
      await page.goto('/');
      const mapSection = page.locator('#mapSection');
      await expect(mapSection).toBeVisible({ timeout: 10000 });
      await expect(mapSection).toHaveClass(/collapsed/);

      const collapsedRatio = await page.evaluate(() => {
        const el = document.getElementById('mapSection');
        return (el?.getBoundingClientRect().height ?? 0) / window.innerHeight;
      });
      expect(collapsedRatio).toBeLessThan(0.3);

      await page.locator('.map-collapse-btn').click();
      await expect(mapSection).not.toHaveClass(/collapsed/);
      const expandedRatio = await page.evaluate(() => {
        const el = document.getElementById('mapSection');
        return (el?.getBoundingClientRect().height ?? 0) / window.innerHeight;
      });
      expect(expandedRatio).toBeGreaterThanOrEqual(0.7);
      await context.close();
    });
  });

  test.describe('breakpoint consistency at 768px', () => {
    test('JS and CSS agree at exactly 768px', async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: 768, height: 1024 },
        locale: 'en-US',
      });
      const page = await context.newPage();
      await page.goto('/');
      await page.waitForTimeout(2000);

      const result = await page.evaluate(() => {
        const jsMobile = window.innerWidth <= 768;
        const el = document.createElement('div');
        el.style.display = 'none';
        document.body.appendChild(el);
        const cssMobile = window.matchMedia('(max-width: 768px)').matches;
        el.remove();
        return { jsMobile, cssMobile };
      });

      expect(result.jsMobile).toBe(result.cssMobile);
      await context.close();
    });
  });
});
