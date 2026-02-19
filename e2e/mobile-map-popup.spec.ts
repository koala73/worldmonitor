import { devices, expect, test } from '@playwright/test';

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

for (const deviceConfig of MOBILE_DEVICE_MATRIX) {
  test.describe(`Mobile SVG popup QA (${deviceConfig.label})`, () => {
    const { defaultBrowserType: _defaultBrowserType, ...contextOptions } = deviceConfig.use;
    test.use(contextOptions);

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

      await hotspot.tap();
      await expect(page.locator('.map-popup.map-popup-sheet')).toBeVisible();
      await page.locator('.popup-close').first().tap();
      await expect(page.locator('.map-popup')).toHaveCount(0);

      await hotspot.tap();
      await expect(page.locator('.map-popup.map-popup-sheet')).toBeVisible();

      await page.touchscreen.tap(6, 6);
      await expect(page.locator('.map-popup')).toHaveCount(0);

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
});
