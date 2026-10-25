import { devices, expect, test } from '@playwright/test';
import type { CrossBorderData } from '../src/services/displacement';

type HarnessWindow = Window & {
  __mobileMapHarness?: {
    ready: boolean;
    getPopupRect: () => {
      left: number;
      top: number;
      right: number;
      bottom: number;
      width: number;
      height: number;
      viewportWidth: number;
      viewportHeight: number;
    } | null;
    getFirstHotspotRect: () => {
      width: number;
      height: number;
    } | null;
  };
  __mobileMapIntegrationHarness?: {
    ready: boolean;
    setCrossBorderArrivals: (data: CrossBorderData) => void;
    toggleCrossBorderLayer: () => void;
    pendingDeferredCallbacks: number;
    flushDeferredCallbacks: () => void;
    destroyMap: () => void;
    getDynamicLayerChildCount: () => number;
    getInitialDynamicRendered: () => boolean;
    getWrapperTransform: () => string;
    getPopupRect: () => {
      left: number;
      top: number;
      right: number;
      bottom: number;
      width: number;
      height: number;
      viewportWidth: number;
      viewportHeight: number;
    } | null;
  };
};

const MOBILE_DEVICE_MATRIX = [
  { label: 'iPhone SE', use: devices['iPhone SE'] },
  { label: 'iPhone 14 Pro Max', use: devices['iPhone 14 Pro Max'] },
  { label: 'Pixel 5', use: devices['Pixel 5'] },
  { label: 'Galaxy S9+', use: devices['Galaxy S9+'] },
] as const;

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`Hotspot popup header (${viewport.width}px)`, () => {
    test.use({ viewport, deviceScaleFactor: 1.25 });

    test('keeps the header and close button inside after scrolling and reopening', async ({ page }, testInfo) => {
      await page.goto('/tests/mobile-map-harness.html?long=1');
      await page.waitForFunction(() => (window as HarnessWindow).__mobileMapHarness?.ready);
      const marker = page.locator('#mapOverlays .hotspot');
      const markerBefore = await marker.boundingBox();
      expect(markerBefore).not.toBeNull();
      expect(markerBefore!.x + markerBefore!.width / 2).toBeCloseTo(viewport.width / 2, 0);
      expect(markerBefore!.y + markerBefore!.height / 2).toBeCloseTo(viewport.height / 2, 0);

      const popup = page.locator('.map-popup');
      const header = popup.locator('.popup-header');
      const close = header.getByRole('button', { name: 'Close', exact: true });
      const expectHeaderInside = async () => {
        await expect.poll(async () => {
          const parent = await popup.boundingBox();
          const child = await header.boundingBox();
          return child!.x - parent!.x;
        }, { message: 'The header must stay inside the popup left edge', timeout: 3000 }).toBeGreaterThanOrEqual(0);
        const parent = (await popup.boundingBox())!;
        const child = (await header.boundingBox())!;
        const button = (await close.boundingBox())!;
        expect(child.x + child.width).toBeLessThanOrEqual(parent.x + parent.width);
        expect(child.y).toBeGreaterThanOrEqual(parent.y);
        expect(child.y + child.height).toBeLessThanOrEqual(parent.y + parent.height);
        expect(button.x).toBeGreaterThanOrEqual(parent.x);
        expect(button.x + button.width).toBeLessThanOrEqual(parent.x + parent.width);
        expect(button.y).toBeGreaterThanOrEqual(parent.y);
        expect(button.y + button.height).toBeLessThanOrEqual(parent.y + parent.height);
      };

      for (let opening = 0; opening < 2; opening++) {
        await marker.click();
        await expect(popup).toBeVisible();
        await expectHeaderInside();
        await popup.evaluate((element) => { element.scrollTop = 120; });
        await expect.poll(() => popup.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        await expectHeaderInside();
        const scrolledPopup = (await popup.boundingBox())!;
        const stickyHeader = (await header.boundingBox())!;
        expect(stickyHeader.y - scrolledPopup.y).toBeCloseTo(1, 0);
        if (opening === 0) {
          await page.screenshot({ path: testInfo.outputPath('hotspot-header-scrolled.png') });
        }
        await close.click();
        await expect(popup).toHaveCount(0);
      }

      expect(await marker.boundingBox()).toEqual(markerBefore);
    });
  });
}

for (const deviceConfig of MOBILE_DEVICE_MATRIX) {
  test.describe(`Mobile SVG popup QA (${deviceConfig.label})`, () => {
    const { defaultBrowserType: _defaultBrowserType, ...contextOptions } = deviceConfig.use;
    test.use(contextOptions);

    test('shows separate cross-border markers and clickable details above the fullscreen map', async ({ page }) => {
      await page.goto('/tests/mobile-map-integration-harness.html?mobile=1');
      await page.waitForFunction(() => (window as HarnessWindow).__mobileMapIntegrationHarness?.ready);
      await page.evaluate(() => (window as HarnessWindow).__mobileMapIntegrationHarness!.toggleCrossBorderLayer());
      await page.evaluate(() => {
        const point = {
          situation: 'test', label: 'Controlled arrivals', kind: 'arrival' as const, country: 'ES',
          individuals: 2300, date: '2026-10-19', change: null, changeSince: '', lastMonth: null,
          accelerating: true, lat: 40, lon: -4, measure: 'daily', last30Days: 2300,
          source: 'Controlled publisher', sourceUrl: 'https://example.com/report',
        };
        (window as HarnessWindow).__mobileMapIntegrationHarness!.setCrossBorderArrivals({
          situations: [], points: [point], deaths: [{ ...point, kind: 'death', label: 'Controlled deaths', individuals: 17, accelerating: false }],
        });
        document.body.classList.add('live-news-fullscreen-active');
        document.getElementById('app')!.classList.add('live-news-fullscreen');
      });
      const popup = page.locator('.map-popup.map-popup-sheet');
      const arrivalBox = await page.locator('.cross-border-point').boundingBox();
      const deathBox = await page.locator('.cross-border-death').boundingBox();
      expect(arrivalBox).not.toBeNull();
      expect(deathBox).not.toBeNull();
      expect(deathBox!.x + deathBox!.width).toBeLessThanOrEqual(arrivalBox!.x);
      const arrivalDot = await page.locator('.cross-border-point .cross-border-dot').boundingBox();
      const deathDot = await page.locator('.cross-border-death .cross-border-dot').boundingBox();
      expect(deathBox!.width).toBeGreaterThan(deathDot!.width);
      expect(deathDot!.width).toBeLessThan(arrivalDot!.width);
      await page.locator('.cross-border-point').tap();
      await expect(popup).toContainText('2,300');
      await expect(popup).toContainText('2026-10-19');
      await expect(popup).toContainText('Controlled publisher');
      await expect(popup.locator('a')).toHaveAttribute('href', 'https://example.com/report');
      await popup.locator('.popup-close').tap();
      await expect(popup).toHaveCount(0);
      await page.locator('.cross-border-death').tap();
      await expect(popup).toContainText('Controlled deaths');
      await expect(popup).toContainText('17');
      await popup.locator('.popup-close').tap();
      await page.evaluate(() => {
        document.body.classList.remove('live-news-fullscreen-active');
        document.getElementById('app')!.classList.remove('live-news-fullscreen');
      });
      await page.evaluate(() => (window as HarnessWindow).__mobileMapIntegrationHarness!.toggleCrossBorderLayer());
      await expect(page.locator('.cross-border-marker')).toHaveCount(0);
      await page.evaluate(() => (window as HarnessWindow).__mobileMapIntegrationHarness!.toggleCrossBorderLayer());
      await expect(page.locator('.cross-border-marker')).toHaveCount(2);
      await page.evaluate(() => (window as HarnessWindow).__mobileMapIntegrationHarness!.setCrossBorderArrivals({ situations: [], points: [], deaths: [] }));
      await expect(page.locator('.cross-border-marker')).toHaveCount(0);
    });

    test('keeps popup in viewport and supports dismissal patterns', async ({ page }) => {
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));

      await page.goto('/tests/mobile-map-harness.html');

      await expect
        .poll(async () => {
          return await page.evaluate(() => {
            const w = window as HarnessWindow;
            return Boolean(w.__mobileMapHarness?.ready);
          });
        }, { timeout: 20000 })
        .toBe(true);

      const hotspotRect = await page.evaluate(() => {
        const w = window as HarnessWindow;
        return w.__mobileMapHarness?.getFirstHotspotRect() ?? null;
      });

      expect(hotspotRect).not.toBeNull();
      expect(hotspotRect?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(hotspotRect?.height ?? 0).toBeGreaterThanOrEqual(44);

      const hotspot = page.locator('.hotspot').first();
      await expect(hotspot).toBeVisible();
      await hotspot.tap();

      const popup = page.locator('.map-popup.map-popup-sheet');
      await expect(popup).toBeVisible();
      await expect.poll(async () => page.evaluate(() => history.state?.__wmOverlay?.id ?? null)).toBe('map-popup');
      await page.evaluate(() => history.back());
      await expect(popup).toHaveCount(0);
      await expect.poll(async () => page.evaluate(() => history.state?.__wmOverlay?.id ?? null)).toBeNull();

      await hotspot.tap();
      await expect(popup).toBeVisible();

      await expect
        .poll(async () => {
          return await page.evaluate(() => {
            const w = window as HarnessWindow;
            const rect = w.__mobileMapHarness?.getPopupRect();
            if (!rect) return false;
            return (
              rect.left >= 0 &&
              rect.top >= 0 &&
              rect.right <= rect.viewportWidth + 1 &&
              rect.bottom <= rect.viewportHeight + 1
            );
          });
        }, { timeout: 5000 })
        .toBe(true);

      const popupRect = await page.evaluate(() => {
        const w = window as HarnessWindow;
        return w.__mobileMapHarness?.getPopupRect() ?? null;
      });

      expect(popupRect).not.toBeNull();
      expect(popupRect?.left ?? -1).toBeGreaterThanOrEqual(0);
      expect(popupRect?.top ?? -1).toBeGreaterThanOrEqual(0);
      expect((popupRect?.right ?? 0) - (popupRect?.viewportWidth ?? 0)).toBeLessThanOrEqual(1);
      expect((popupRect?.bottom ?? 0) - (popupRect?.viewportHeight ?? 0)).toBeLessThanOrEqual(1);

      const dragPopupBy = async (distance: number): Promise<void> => {
        await page.evaluate((dragDistance) => {
          const popupEl = document.querySelector('.map-popup.map-popup-sheet') as HTMLElement | null;
          const handle = document.querySelector('.map-popup-sheet-handle') as HTMLElement | null;
          if (!popupEl || !handle || typeof Touch === 'undefined') return;

          const rect = handle.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const startY = rect.top + rect.height / 2;
          const endY = startY + dragDistance;
          const target = handle;

          const makeTouch = (y: number): Touch =>
            new Touch({
              identifier: 42,
              target,
              clientX: x,
              clientY: y,
              pageX: x,
              pageY: y,
              screenX: x,
              screenY: y,
              radiusX: 2,
              radiusY: 2,
              rotationAngle: 0,
              force: 0.5,
            });

          const startTouch = makeTouch(startY);
          target.dispatchEvent(
            new TouchEvent('touchstart', {
              bubbles: true,
              cancelable: true,
              touches: [startTouch],
              targetTouches: [startTouch],
              changedTouches: [startTouch],
            })
          );

          const moveTouch = makeTouch(endY);
          target.dispatchEvent(
            new TouchEvent('touchmove', {
              bubbles: true,
              cancelable: true,
              touches: [moveTouch],
              targetTouches: [moveTouch],
              changedTouches: [moveTouch],
            })
          );

          target.dispatchEvent(
            new TouchEvent('touchend', {
              bubbles: true,
              cancelable: true,
              touches: [],
              targetTouches: [],
              changedTouches: [moveTouch],
            })
          );
        }, distance);
      };

      await dragPopupBy(48);
      await expect(page.locator('.map-popup.map-popup-sheet')).toBeVisible();
      await expect
        .poll(async () => {
          return await page.evaluate(() => {
            const popupEl = document.querySelector('.map-popup.map-popup-sheet') as HTMLElement | null;
            return popupEl?.style.transform ?? null;
          });
        }, { timeout: 2000 })
        .toBe('');

      await dragPopupBy(150);
      await expect(page.locator('.map-popup')).toHaveCount(0);
      await expect.poll(async () => page.evaluate(() => history.state?.__wmOverlay?.id ?? null)).toBeNull();

      await hotspot.tap();
      await expect(page.locator('.map-popup.map-popup-sheet')).toBeVisible();
      await page.locator('.popup-close').first().tap();
      await expect(page.locator('.map-popup')).toHaveCount(0);
      await expect.poll(async () => page.evaluate(() => history.state?.__wmOverlay?.id ?? null)).toBeNull();

      await hotspot.tap();
      await expect(page.locator('.map-popup.map-popup-sheet')).toBeVisible();

      await page.touchscreen.tap(6, 6);
      await expect(page.locator('.map-popup')).toHaveCount(0);
      await expect.poll(async () => page.evaluate(() => history.state?.__wmOverlay?.id ?? null)).toBeNull();

      expect(pageErrors).toEqual([]);
    });
  });
}

test.describe('Mobile SVG popup integration path', () => {
  const { defaultBrowserType: _defaultBrowserType, ...iphoneSE } = devices['iPhone SE'];
  test.use(iphoneSE);

  test('opens popup through MapComponent hotspot marker tap', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.goto('/tests/mobile-map-integration-harness.html');

    await expect
      .poll(async () => {
        return await page.evaluate(() => {
          const w = window as HarnessWindow;
          return Boolean(w.__mobileMapIntegrationHarness?.ready);
        });
      }, { timeout: 30000 })
      .toBe(true);

    const timeSlider = page.locator('.time-slider');
    const mapControls = page.locator('.map-controls');
    await expect(timeSlider).toBeVisible();
    await expect(mapControls).toBeVisible();
    const controlsDoNotOverlap = await page.evaluate(() => {
      const slider = document.querySelector('.time-slider') as HTMLElement | null;
      const controls = document.querySelector('.map-controls') as HTMLElement | null;
      if (!slider || !controls) return false;
      const sliderRect = slider.getBoundingClientRect();
      const controlsRect = controls.getBoundingClientRect();
      return sliderRect.right <= controlsRect.left + 1;
    });
    expect(controlsDoNotOverlap).toBe(true);

    const hotspot = page.locator('.hotspot').first();
    await expect(hotspot).toBeVisible();
    await hotspot.tap();

    const popup = page.locator('.map-popup.map-popup-sheet');
    await expect(popup).toBeVisible();

    await expect
      .poll(async () => {
        return await page.evaluate(() => {
          const w = window as HarnessWindow;
          const rect = w.__mobileMapIntegrationHarness?.getPopupRect();
          if (!rect) return false;
          return (
            rect.left >= 0 &&
            rect.top >= 0 &&
            rect.right <= rect.viewportWidth + 1 &&
            rect.bottom <= rect.viewportHeight + 1
          );
        });
      }, { timeout: 5000 })
      .toBe(true);

    const popupRect = await page.evaluate(() => {
      const w = window as HarnessWindow;
      return w.__mobileMapIntegrationHarness?.getPopupRect() ?? null;
    });

    expect(popupRect).not.toBeNull();
    expect(popupRect?.left ?? -1).toBeGreaterThanOrEqual(0);
    expect(popupRect?.top ?? -1).toBeGreaterThanOrEqual(0);
    expect((popupRect?.right ?? 0) - (popupRect?.viewportWidth ?? 0)).toBeLessThanOrEqual(1);
    expect((popupRect?.bottom ?? 0) - (popupRect?.viewportHeight ?? 0)).toBeLessThanOrEqual(1);

    await popup.locator('.popup-close').first().tap();
    await expect(page.locator('.map-popup')).toHaveCount(0);

    expect(pageErrors).toEqual([]);
  });

  test('defers overlays while preserving transform and guarding destroy', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.goto('/tests/mobile-map-integration-harness.html?defer-control=1');

    await expect
      .poll(async () => {
        return await page.evaluate(() => document.querySelectorAll('.country').length);
      }, { timeout: 30000 })
      .toBeGreaterThan(0);

    await expect
      .poll(async () => {
        return await page.evaluate(() => {
          const w = window as HarnessWindow;
          return w.__mobileMapIntegrationHarness?.pendingDeferredCallbacks ?? 0;
        });
      }, { timeout: 10000 })
      .toBeGreaterThan(0);

    const transformBeforeFlush = await page.evaluate(() => {
      const w = window as HarnessWindow;
      return w.__mobileMapIntegrationHarness?.getWrapperTransform() ?? '';
    });
    expect(transformBeforeFlush).toContain('scale(2.7)');

    const dynamicBeforeFlush = await page.evaluate(() => {
      const w = window as HarnessWindow;
      return w.__mobileMapIntegrationHarness?.getDynamicLayerChildCount() ?? -1;
    });
    expect(dynamicBeforeFlush).toBe(0);

    await page.evaluate(() => {
      const w = window as HarnessWindow;
      w.__mobileMapIntegrationHarness?.destroyMap();
      w.__mobileMapIntegrationHarness?.flushDeferredCallbacks();
    });

    const initialDynamicRendered = await page.evaluate(() => {
      const w = window as HarnessWindow;
      return w.__mobileMapIntegrationHarness?.getInitialDynamicRendered() ?? true;
    });
    expect(initialDynamicRendered).toBe(false);
    expect(pageErrors).toEqual([]);
  });
});
