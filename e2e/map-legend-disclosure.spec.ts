import { expect, test } from '@playwright/test';

test('collapsed legends preserve active NO2 attribution', async ({ page }) => {
  await page.goto('/tests/runtime-harness.html');
  await page.evaluate(async () => {
    await import('/src/styles/main.css');
    const { DeckGLMap } = await import('/src/components/DeckGLMap.ts');
    const { DEFAULT_MAP_LAYERS } = await import('/src/config/index.ts');
    const { initI18n } = await import('/src/services/i18n.ts');
    await initI18n();
    const map = Object.create(DeckGLMap.prototype);
    map.container = document.createElement('div');
    map.container.style.cssText = 'position:relative;width:562px;height:450px';
    document.body.append(map.container);
    map.controlDisclosureCleanups = [];
    map.state = { layers: { ...Object.fromEntries(Object.keys(DEFAULT_MAP_LAYERS).map(key => [key, false])), no2Activity: true, hotspots: true } };
    map.no2Activity = { attribution: 'Contains modified Copernicus Sentinel data (2026)' };
    localStorage.removeItem('worldmonitor-map-legend-expanded');
    map.createLegend();
    Object.assign(window, { legendTestMap: map });
  });
  const button = page.locator('.map-legend .map-control-disclosure');
  const credit = page.locator('.no2-activity-credit');
  const scale = page.locator('#no2ActivityLegend .legend-item').first();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(credit).toBeVisible();
  await expect(scale).toBeHidden();
  await button.click();
  await expect(scale).toBeVisible();
  await expect(credit).toBeVisible();
  await page.evaluate(() => {
    const map = (window as any).legendTestMap;
    map.container.style.width = '1100px';
    map.no2Activity.attribution = 'Contains modified Copernicus Sentinel data (2027)';
    map.updateLegend();
  });
  await button.click();
  await expect(credit).toBeVisible();
  await expect(credit).toContainText('(2027)');
  await expect(scale).toBeHidden();
  await page.evaluate(() => {
    const map = (window as any).legendTestMap;
    map.state.layers.no2Activity = false;
    map.updateLegend();
  });
  await expect(credit).toBeHidden();
  await expect(button).toBeVisible();
});
