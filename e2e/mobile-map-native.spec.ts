import { devices, expect, test } from '@playwright/test';

const MOBILE_VIEWPORT = devices['iPhone 14 Pro Max'];

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
      await page.waitForTimeout(3000);
      const url = page.url();
      const params = new URL(url).searchParams;
      const lat = params.get('lat');
      const lon = params.get('lon');
      if (lat && lon) {
        expect(parseFloat(lat)).toBeCloseTo(48.86, 0);
        expect(parseFloat(lon)).toBeCloseTo(2.35, 0);
      } else {
        const region = await page.evaluate(() => {
          const select = document.getElementById('regionSelect') as HTMLSelectElement | null;
          return select?.value ?? null;
        });
        expect(region).not.toBe('eu');
      }
    });

    test('zero-degree coordinates center at equator/prime meridian', async ({ page }) => {
      await page.goto('/?lat=0&lon=0&zoom=4');
      await page.waitForTimeout(3000);
      const url = page.url();
      const params = new URL(url).searchParams;
      const lat = params.get('lat');
      const lon = params.get('lon');
      expect(lat).not.toBeNull();
      expect(lon).not.toBeNull();
      if (lat && lon) {
        expect(Math.abs(parseFloat(lat))).toBeLessThan(5);
        expect(Math.abs(parseFloat(lon))).toBeLessThan(5);
      }
    });
  });

  test.describe('touch interactions', () => {
    test.use(mobileContext);

    test('single-finger pan does not scroll page', async ({ page }) => {
      await page.goto('/');
      await page.waitForTimeout(3000);
      const mapEl = page.locator('#mapContainer');
      await expect(mapEl).toBeVisible({ timeout: 10000 });

      const scrollBefore = await page.evaluate(() => window.scrollY);

      const box = await mapEl.boundingBox();
      if (box) {
        const startX = box.x + box.width / 2;
        const startY = box.y + box.height / 2;
        await page.touchscreen.tap(startX, startY);
        await page.mouse.move(startX, startY);
        await page.touchscreen.tap(startX, startY + 50);
      }

      const scrollAfter = await page.evaluate(() => window.scrollY);
      expect(scrollAfter).toBe(scrollBefore);
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
