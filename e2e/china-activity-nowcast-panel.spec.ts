import { expect, test } from '@playwright/test';
import type {} from '../src/e2e/china-activity-nowcast-panel-harness';

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
    await expect(panel).toContainText('4/8 proxy families eligible');
    await expect(panel).toContainText('nbs_industrial_value_added_yoy:2026-06:r1');
    await expect(panel.locator('.china-nowcast-contribution')).toHaveCount(8);
    await expect(panel.locator('.china-nowcast-contribution--excluded')).toHaveCount(4);
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

    // The dashboard sidebar column is 375px wide on a desktop viewport. Three
    // cards abreast squeezed each to 115px and the heading text overflowed its
    // cell, so a column this narrow holds one card per row.
    await panel.evaluate((element) => { element.style.width = '375px'; });
    await expect(panel.locator('.china-nowcast-contributions')).toHaveCSS(
      'grid-template-columns',
      /^\S+$/,
    );
    // The method grid, open since the summary click above, follows the same
    // rule: one column in a dashboard column, several when the panel is wide.
    const methodGrid = panel.locator('.china-nowcast-method__grid');
    await expect(methodGrid).toHaveCSS('grid-template-columns', /^\S+$/);
    const methodOverflow = await methodGrid.evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(methodOverflow).toBeLessThanOrEqual(1);
    const columnOverflow = await panel.locator('.panel-content').evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    );
    expect(columnOverflow).toBeLessThanOrEqual(1);

    await panel.evaluate((element) => { element.style.width = ''; });
    await expect(methodGrid).toHaveCSS('grid-template-columns', /.+ .+/);
  });
});
