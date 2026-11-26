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
    for (const [timezoneId, locale, region] of [
      ['America/New_York', 'en-US', 'america'],
      ['Europe/London', 'en-GB', 'eu'],
      ['Asia/Tokyo', 'ja-JP', 'asia'],
    ] as const) {
      test.describe(timezoneId, () => {
        test.use({ ...mobileContext, timezoneId, locale });

        test(`starts in the ${region} view`, async ({ page }) => {
          await page.goto('/');
          await expect(page.locator('#regionSelect')).toHaveValue(region);
        });
      });
    }
  });

  test.describe('region presets', () => {
    test.use(mobileContext);

    // #11157: fixed pixel pans tuned for a desktop map put Europe over the
    // Arctic, the Middle East over Central Asia, America over the Pacific,
    // and Asia and Oceania off a phone's map.
    for (const [view, lat, lon] of [
      ['america', 38, -95],
      ['eu', 50, 15],
      ['mena', 28, 45],
      ['asia', 35, 105],
      ['oceania', -25, 135],
    ] as const) {
      test(`centers the ${view} preset on the phone map`, async ({ page }) => {
        await page.goto(`/?view=${view}`);
        await expect(page.locator('html')).toHaveAttribute('data-wm-event-handlers-ready', 'true', { timeout: 45_000 });
        await expect(page.locator('#mapContainer')).toBeVisible();
        await expectRenderedCenter(page, lat, lon);
      });
    }

    test('centers a preset chosen while the map was collapsed', async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem('mobile-map-collapsed', 'true'));
      await page.goto('/?view=asia');
      await expect(page.locator('html')).toHaveAttribute('data-wm-event-handlers-ready', 'true', { timeout: 45_000 });
      await page.locator('.map-collapse-btn').click();
      await expect(page.locator('#mapContainer')).toBeVisible();
      await expectRenderedCenter(page, 35, 105);
    });

    test('keeps a preset centered when the map is resized', async ({ page }) => {
      await page.goto('/?view=oceania');
      await expect(page.locator('html')).toHaveAttribute('data-wm-event-handlers-ready', 'true', { timeout: 45_000 });
      await expectRenderedCenter(page, -25, 135);
      await page.setViewportSize({ width: 320, height: 844 });
      await expectRenderedCenter(page, -25, 135);
    });
  });

  test.describe('URL restore', () => {
    test.use(mobileContext);
    // A first visit opens the map expanded (#10220). These cases guard #9620: a deep-link
    // center must survive a collapsed (0x0) boot, so boot a viewer who collapsed it.
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem('mobile-map-collapsed', 'true'));
    });

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
      // A first visit opens with the map expanded (#10220).
      await expect(page.locator('#mapSection')).not.toHaveClass(/collapsed/);
      const mapEl = page.locator('#mapContainer');
      await expect(mapEl).toBeVisible({ timeout: 10000 });

      const box = await mapEl.boundingBox();
      expect(box).not.toBeNull();
      // CDP touch input does not drive native page scrolling here, so check what the browser
      // uses to decide: the touch-action values from the touched element up to the nearest
      // scroll container, #mapContainer (overflow: hidden), inclusive. Rules above it do not apply.
      const chain = await page.evaluate(({ x, y }) => {
        const map = document.getElementById('mapContainer');
        const hit = document.elementFromPoint(x, y);
        if (!map || !hit || !map.contains(hit)) return null;
        const values: string[] = [];
        for (let el: Element | null = hit; el; el = el === map ? null : el.parentElement) {
          values.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}:${getComputedStyle(el).touchAction}`);
        }
        return values;
      }, { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 });
      expect(chain, 'the map center hits an element inside #mapContainer').not.toBeNull();
      expect(chain!.some((entry) => entry.endsWith(':none')), chain!.join(' < ')).toBe(true);
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
    test('map opens as a short strip on a first visit and Hide Map collapses it', async ({ browser }) => {
      const context = await browser.newContext({ ...mobileContext, locale: 'en-US' });
      const page = await context.newPage();
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-wm-event-handlers-ready', 'true', { timeout: 45_000 });
      const mapSection = page.locator('#mapSection');
      const heightRatio = () => page.evaluate(() =>
        (document.getElementById('mapSection')?.getBoundingClientRect().height ?? 0) / window.innerHeight);
      // A first visit is expanded (#10220), as a strip about a third of the viewport tall (#10472).
      await expect(mapSection).not.toHaveClass(/collapsed/);
      const strip = await heightRatio();
      expect(strip).toBeGreaterThan(0.25);
      expect(strip).toBeLessThan(0.4);
      await page.locator('.map-collapse-btn').click();
      await expect(mapSection).toHaveClass(/collapsed/);
      expect(await heightRatio()).toBeLessThan(strip / 2);
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
