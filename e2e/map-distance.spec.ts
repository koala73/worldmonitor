import { expect, test, type Page } from '@playwright/test';

type Camera = { lon: number; lat: number; zoom: number };
type HarnessWindow = Window & {
  __mapHarness?: {
    ready: boolean;
    setCamera: (camera: Camera) => void;
    getDeckLayerSnapshot: () => { id: string; dataCount: number }[];
  };
};
const setCamera = (page: Page, camera: Camera) => page.evaluate(camera => (window as HarnessWindow).__mapHarness?.setCamera(camera), camera);
const ready = async (page: Page, query = '') => {
  await page.goto(`/tests/map-harness.html${query}`);
  await page.waitForFunction(() => (window as HarnessWindow).__mapHarness?.ready);
  await page.evaluate(() => document.body.classList.remove('e2e-deterministic'));
};

test('2D scale and ruler follow the camera and preserve map interactions', async ({ page }) => {
  await ready(page);
  const scale = page.locator('.map-distance-control .maplibregl-ctrl-scale');
  await expect(scale).toBeVisible();
  const initial = await scale.textContent();
  await setCamera(page, { lon: -19, lat: 65, zoom: 7 });
  await expect(scale).not.toHaveText(initial!);
  await page.getByRole('button', { name: 'Measure distance', exact: true }).click();
  const canvas = page.locator('.maplibregl-canvas');
  await canvas.click({ position: { x: 350, y: 230 } });
  await expect(page.locator('.map-distance-status')).toContainText('point B');
  await canvas.click({ position: { x: 550, y: 230 } });
  await expect(page.locator('.map-distance-status')).toContainText('km');
  await expect(page.locator('.map-distance-panel')).toContainText('Geodesic');
  await expect(page.locator('.map-popup')).not.toBeVisible();
  await page.evaluate(() => document.body.classList.remove('e2e-deterministic'));
  await expect.poll(() => page.evaluate(() => (window as HarnessWindow).__mapHarness?.getDeckLayerSnapshot().find(l => l.id === 'map-distance-line')?.dataCount)).toBe(1);
  await page.screenshot({ path: '.claude/verify-evidence/ruler-desktop-iceland.png' });
  await page.getByLabel('Distance units').selectOption('mi');
  await expect(page.locator('.map-distance-status')).toContainText('mi');
  await expect(scale).toContainText(/mi|ft/);
  await page.getByRole('button', { name: 'Reset measurement' }).click();
  await expect(page.locator('.map-distance-status')).toContainText('point A');
  await canvas.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.map-distance-status')).toContainText('point B');
  await page.keyboard.press('Escape');
  await expect(page.locator('.map-distance-panel')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Measure distance', exact: true })).toBeFocused();
  await expect(scale).toBeVisible();
  const before = await scale.textContent();
  await canvas.dblclick({ position: { x: 350, y: 230 } });
  await expect(scale).not.toHaveText(before!);
});

for (const [name, a, b, km] of [
  ['equator', [0, 0], [1, 0], 111.2],
  ['legacy locale', [0, 0], [1, 0], 111.2],
  ['Iceland', [-22, 65], [-21, 65], 47.0],
  ['dateline', [179.9, 0], [-179.9, 0], 22.2],
] as const) {
  test(`ruler measures ${name} coordinates and converts km to miles`, async ({ page }) => {
    await ready(page, name === 'legacy locale' ? '?lang=en_US' : '');
    await page.getByRole('button', { name: 'Measure distance', exact: true }).click();
    for (const [lon, lat] of [a, b]) {
      // With world copies disabled, low zoom constrains the center away from ±180.
      await setCamera(page, { lon, lat, zoom: name === 'dateline' ? 13 : 6 });
      await page.locator('.maplibregl-canvas').focus();
      await page.keyboard.press('Enter');
    }
    await expect(page.locator('.map-distance-status')).toHaveText(`Geodesic distance: ${km.toLocaleString('en-US')} km`);
    await page.getByLabel('Distance units').selectOption('mi');
    await expect(page.locator('.map-distance-status')).toHaveText(`Geodesic distance: ${(km / 1.609344).toLocaleString('en-US', { maximumFractionDigits: 1 })} mi`);
    await expect.poll(() => page.evaluate(() => (window as HarnessWindow).__mapHarness?.getDeckLayerSnapshot().find(l => l.id === 'map-distance-line')?.dataCount)).toBe(1);
    await page.getByRole('button', { name: 'Exit measurement' }).click();
    await expect.poll(() => page.evaluate(() => (window as HarnessWindow).__mapHarness?.getDeckLayerSnapshot().some(l => l.id === 'map-distance-line'))).toBe(false);
  });
}

test('scale reflects latitude and resized light and dark panels', async ({ page }) => {
  await ready(page);
  const scale = page.locator('.map-distance-control .maplibregl-ctrl-scale');
  for (const lat of [0, 65]) {
    await setCamera(page, { lon: -19, lat, zoom: 6 });
    const actual = await scale.evaluate(el => ({ width: el.getBoundingClientRect().width, label: el.textContent! }));
    const [number, unit] = actual.label.split(/\s+/);
    const km = Number(number) * (unit === 'm' ? 0.001 : 1);
    // Independent Web Mercator ground resolution at the scale's reference latitude.
    const expected = actual.width * Math.cos(lat * Math.PI / 180) * 2 * Math.PI * 6371.0088 / (512 * 2 ** 6);
    expect(Math.abs(km - expected) / expected).toBeLessThan(0.03);
  }
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => {
      document.documentElement.dataset.theme = theme;
      document.getElementById('app')!.style.cssText = 'width:360px;height:300px;min-width:0;min-height:0;position:relative;margin:0';
      document.querySelector<HTMLElement>('.map-clear-trails-btn')!.style.display = '';
      localStorage.setItem('wm-map-provider', 'openfreemap');
      localStorage.setItem('wm-map-theme:openfreemap', theme === 'light' ? 'positron' : 'dark');
      window.dispatchEvent(new CustomEvent('map-theme-changed'));
      document.body.classList.remove('e2e-deterministic');
    }, theme);
    await page.setViewportSize({ width: 390, height: 460 });
    await expect(scale).toBeVisible();
    const trailsBottom = await page.locator('.map-clear-trails-btn').evaluate(el => el.getBoundingClientRect().bottom);
    expect((await scale.boundingBox())!.y).toBeGreaterThan(trailsBottom);
    await page.getByRole('button', { name: 'Measure distance', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Exit measurement' })).toBeVisible();
    const fits = await page.locator('.map-distance-control').evaluate(el => {
      const rect = el.getBoundingClientRect();
      const parent = document.getElementById('app')!.getBoundingClientRect();
      return rect.left >= parent.left && rect.right <= parent.right && rect.bottom <= parent.bottom;
    });
    expect(fits).toBe(true);
    await page.screenshot({ path: `.claude/verify-evidence/ruler-small-${theme}.png` });
    await page.getByRole('button', { name: 'Exit measurement' }).click();
  }
});

test('German ruler supports cancelling a partial selection', async ({ page }) => {
  await page.goto('/tests/map-harness.html?lang=de');
  await page.waitForFunction(() => (window as HarnessWindow).__mapHarness?.ready);
  await page.evaluate(() => document.body.classList.remove('e2e-deterministic'));
  await page.getByRole('button', { name: 'Entfernung messen', exact: true }).click();
  await page.keyboard.press('Enter');
  await expect(page.locator('.map-distance-status')).toContainText('Punkt B');
  await page.getByRole('button', { name: 'Auswahl abbrechen' }).click();
  await expect(page.locator('.map-distance-status')).toContainText('Punkt A');
  await page.keyboard.press('Escape');
  await expect(page.locator('.map-distance-panel')).toBeHidden();
});
