import { expect, test } from '@playwright/test';

test.describe('China activity nowcast panel', () => {
  test('explains the comparison safely at narrow and desktop widths', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/tests/china-activity-nowcast-panel-harness.html');
    await expect.poll(() => page.evaluate(() =>
      window.__chinaActivityNowcastHarness?.ready ?? false)).toBe(true);

    const panel = page.locator('[data-panel="china-activity-nowcast"]');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Official and proxies agree');
    await expect(panel).toContainText('90-day comparison window');
    await expect(panel).toContainText('4/7 proxy families eligible');
    await expect(panel).toContainText('nbs_industrial_value_added_yoy:2026-06:r1');
    await expect(panel.locator('.china-nowcast-contribution')).toHaveCount(7);
    await expect(panel.locator('.china-nowcast-contribution--excluded')).toHaveCount(3);
    await expect(panel).toContainText('<script>unsafe official label</script>');
    await expect(panel.locator('script')).toHaveCount(0);
    await expect(panel.locator('img')).toHaveCount(0);

    await panel.locator('summary').click();
    await expect(panel).toContainText('Leave-one-family-out sensitivity');
    await expect(panel).toContainText('Historical evaluation unavailable');
    await expect(panel).toContainText('<img src=x onerror=alert(1)> unsafe limitation');

    const narrowOverflow = await panel.evaluate((element) => ({
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      panel: element.scrollWidth - element.clientWidth,
    }));
    expect(narrowOverflow.document).toBeLessThanOrEqual(1);
    expect(narrowOverflow.panel).toBeLessThanOrEqual(1);

    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(panel.locator('.china-nowcast-contributions')).toHaveCSS(
      'grid-template-columns',
      /.+ .+/,
    );
  });
});
