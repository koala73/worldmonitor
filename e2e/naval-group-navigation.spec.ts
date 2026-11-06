import { expect, test } from '@playwright/test';

type HarnessWindow = Window & {
  __mobileMapIntegrationHarness?: {
    ready: boolean;
    seedNavalGroup: () => void;
    getWrapperTransform: () => string;
    getOverlayPositionSignature: (selector: string) => string;
  };
};

for (const width of [1280, 390]) {
  test.describe(`Naval group navigation (${width}px)`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('restores the overflowing popup scroll position and selected row', async ({ page }, testInfo) => {
      await page.goto('/tests/mobile-map-integration-harness.html?lang=en');
      await page.waitForFunction(() => (window as HarnessWindow).__mobileMapIntegrationHarness?.ready);
      await page.evaluate(() => (window as HarnessWindow).__mobileMapIntegrationHarness!.seedNavalGroup());
      await page.locator('.vessel-cluster').click();
      const popup = page.locator('.map-popup');
      await popup.locator('.cluster-toggle').click();
      const member = popup.locator('[data-vessel-index="19"]');
      await member.scrollIntoViewIfNeeded();
      await member.focus();
      const scroll = await popup.evaluate(element => element.scrollTop);
      expect(scroll).toBeGreaterThan(0);
      await member.click();
      await expect(popup.locator('.popup-title')).toHaveText('Test vessel 20');
      expect(await popup.evaluate(element => element.scrollTop)).toBe(0);
      await popup.locator('.popup-back').click();
      expect(await popup.evaluate(element => element.scrollTop)).toBeCloseTo(scroll, 0);
      await expect(member).toBeFocused();
      await expect(member).toBeInViewport();
      await popup.screenshot({ path: testInfo.outputPath(`scroll-restored-${width}.png`) });
    });

    test('opens details without map movement and returns to expanded group', async ({ page }, testInfo) => {
      await page.goto('/tests/mobile-map-integration-harness.html?lang=en');
      await page.waitForFunction(() => (window as HarnessWindow).__mobileMapIntegrationHarness?.ready);
      await page.evaluate(() => (window as HarnessWindow).__mobileMapIntegrationHarness!.seedNavalGroup());
      const marker = page.locator('.vessel-cluster');
      await expect(marker).toBeVisible();
      const mapState = () => page.evaluate(() => ({
        transform: (window as HarnessWindow).__mobileMapIntegrationHarness!.getWrapperTransform(),
        marker: (window as HarnessWindow).__mobileMapIntegrationHarness!.getOverlayPositionSignature('.vessel-cluster'),
      }));
      const before = await mapState();
      await marker.click();
      const popup = page.locator('.map-popup');
      await expect(popup).toBeVisible();
      await popup.locator('.popup-close').focus();
      await page.keyboard.press('Tab');
      await expect(popup.locator('[data-vessel-index="0"]')).toBeFocused();
      await expect(popup.locator('[data-vessel-index="5"]')).toBeHidden();
      await popup.screenshot({ path: testInfo.outputPath(`group-${width}.png`) });
      await popup.locator('.cluster-toggle').click();
      const member = popup.locator('[data-vessel-index="5"]');
      await member.focus();
      await page.keyboard.press('Enter');
      await expect(popup.locator('.popup-title')).toHaveText('USS Test');
      await expect(popup).toContainText('Position approximate');
      await expect(popup).not.toContainText('0 kts');
      await expect(popup.locator('.popup-stat').filter({ hasText: 'HEADING' })).toContainText('Unknown');
      await expect(popup.locator('.popup-back')).toBeFocused();
      await popup.screenshot({ path: testInfo.outputPath(`details-${width}.png`) });
      await page.keyboard.press('Space');
      await expect(popup.locator('.popup-title')).toContainText('Indian Ocean Naval Group');
      await expect(member).toBeFocused();
      await expect(member).toBeVisible();
      await popup.locator('[data-vessel-index="0"]').click();
      await expect(popup.locator('.popup-title')).toHaveText('USS Boxer');
      await expect(popup).toContainText('Live ship tracking');
      await expect(popup).toContainText('0 kts');
      await expect(popup).not.toContainText('Position approximate');
      await popup.locator('.popup-back').click();
      await popup.locator('[data-vessel-index="6"]').click();
      await expect(popup.locator('.popup-title')).toHaveText('Unknown vessel');
      await expect(popup).not.toContainText('NaN');
      await popup.locator('.popup-back').click();
      await popup.locator('.cluster-toggle').click();
      await expect(member).toBeHidden();
      expect(await mapState()).toEqual(before);
      const rect = await popup.boundingBox();
      expect(rect!.x).toBeGreaterThanOrEqual(0);
      expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
      await page.keyboard.press('Escape');
      await expect(popup).toBeHidden();
    });
  });
}
