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
    map.state = { layers: { ...Object.fromEntries(Object.keys(DEFAULT_MAP_LAYERS).map(key => [key, false])), no2Activity: true, diseaseOutbreaks: true } };
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

test('mobile SVG disclosure buttons remain available except during fullscreen video', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/tests/runtime-harness.html');
  await page.evaluate(async () => {
    await import('/src/styles/main.css');
    const { bindMapControlDisclosure } = await import('/src/components/map-control-disclosure.ts');
    const container = document.createElement('div');
    container.style.cssText = 'position:relative;width:390px;height:600px';
    document.body.append(container);
    for (const kind of ['layers', 'legend'] as const) {
      const panel = document.createElement('div');
      panel.className = kind === 'layers' ? 'layer-toggles' : 'map-legend';
      const content = document.createElement('span');
      content.textContent = 'Panel content';
      panel.append(content);
      container.append(panel);
      bindMapControlDisclosure(container, panel, kind, kind);
    }
  });
  for (const selector of ['.layer-toggles', '.map-legend']) {
    const panel = page.locator(selector);
    const button = panel.locator('.map-control-disclosure');
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(panel.locator('span')).toBeHidden();
    await button.click();
    await expect(panel.locator('span')).toBeVisible();
    if (selector === '.layer-toggles') {
      const layers = await panel.boundingBox();
      const legend = await page.locator('.map-legend').boundingBox();
      expect(layers!.y + layers!.height).toBeLessThanOrEqual(legend!.y);
    }
    await button.click();
  }
  await page.evaluate(() => document.body.classList.add('live-news-fullscreen-active'));
  await expect(page.locator('.layer-toggles')).toBeHidden();
  await expect(page.locator('.map-legend')).toBeHidden();
});
