import { expect, test } from '@playwright/test';

test.describe('China corridor control towers', () => {
  test('supports comparison, family filtering, keyboard navigation, safe text, and narrow layouts', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/tests/china-corridor-panel-harness.html');
    await expect.poll(() => page.evaluate(() =>
      (window as unknown as {
        __chinaCorridorPanelHarness?: { ready: boolean };
      }).__chinaCorridorPanelHarness?.ready ?? false)).toBe(true);

    const panel = page.locator('[data-panel="china-corridors"]');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('tab')).toHaveCount(4);
    await expect(panel.locator('[data-family-filter]')).toHaveCount(6);
    await expect(panel.locator('script')).toHaveCount(0);
    await expect(panel.locator('img')).toHaveCount(0);
    await expect(panel).toContainText('<script>unsafe publisher</script>');
    await expect(panel).toContainText('<img src=x onerror=alert(1)> unsafe title');
    await expect(panel).toContainText('released Jul 25, 2026');

    const firstTab = panel.getByRole('tab').first();
    await firstTab.focus();
    await firstTab.press('ArrowRight');
    await expect(panel.getByRole('tab').nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => page.evaluate(() =>
      (window as unknown as {
        __chinaCorridorPanelHarness?: { selectedCorridorId: string | null };
      }).__chinaCorridorPanelHarness?.selectedCorridorId ?? null))
      .toBe('china-greater-bay-area');

    const portFilter = panel.locator('[data-family-filter="port"]');
    await portFilter.click();
    await expect(portFilter).toHaveAttribute('aria-pressed', 'false');
    await expect(panel.locator('[data-family="port"]')).toHaveCount(0);

    const overflow = await panel.evaluate((element) => ({
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      panel: element.scrollWidth - element.clientWidth,
    }));
    expect(overflow.document).toBeLessThanOrEqual(1);
    expect(overflow.panel).toBeLessThanOrEqual(1);
  });

  test('renders the selected reviewed boundary and configured nodes on the DeckGL map', async ({ page }) => {
    await page.goto('/tests/map-harness.html');
    await expect(page.locator('.deckgl-map-wrapper')).toBeVisible();
    await expect.poll(() => page.evaluate(() =>
      (window as unknown as {
        __mapHarness?: { ready: boolean };
      }).__mapHarness?.ready ?? false), { timeout: 45_000 }).toBe(true);

    await page.evaluate(() => (window as unknown as {
      __mapHarness?: { showChinaCorridor: (index?: number) => void };
    }).__mapHarness?.showChinaCorridor(0));
    await expect.poll(() => page.evaluate(() => {
      const layers = (window as unknown as {
        __mapHarness?: { getDeckLayerSnapshot: () => Array<{ id: string; dataCount: number }> };
      }).__mapHarness?.getDeckLayerSnapshot() ?? [];
      return layers
        .filter((layer) => layer.id.startsWith('china-corridor-'))
        .map((layer) => ({ id: layer.id, dataCount: layer.dataCount }));
    })).toEqual([
      { id: 'china-corridor-boundary-china-yangtze-river-delta', dataCount: 1 },
      { id: 'china-corridor-nodes-china-yangtze-river-delta', dataCount: 10 },
    ]);
  });
});
