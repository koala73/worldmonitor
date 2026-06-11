import { expect, test, type Page } from '@playwright/test';

const WORLD_TOPOLOGY = {
  type: 'Topology',
  transform: {
    scale: [0.01, 0.01],
    translate: [-5, -5],
  },
  objects: {
    countries: {
      type: 'GeometryCollection',
      geometries: [
        {
          type: 'Polygon',
          arcs: [[0]],
          id: 'TST',
          properties: { name: 'Testland' },
        },
      ],
    },
  },
  arcs: [
    [
      [0, 0],
      [1000, 0],
      [0, 1000],
      [-1000, 0],
      [0, -1000],
    ],
  ],
};

async function stubWorldAtlas(page: Page): Promise<void> {
  await page.route('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(WORLD_TOPOLOGY),
    });
  });
}

test.describe('public map embed', () => {
  const embedPath = '/embed?layers=conflicts&center=0,0&zoom=1&theme=dark&variant=full';

  test('renders the map-only embed route with attribution', async ({ page }, testInfo) => {
    await stubWorldAtlas(page);
    await page.goto(embedPath);

    await expect(page.locator('.wm-embed-attribution')).toHaveText('Live map by World Monitor');
    await expect(page.locator('.map-svg')).toBeVisible();
    await expect.poll(async () => page.locator('.country').count()).toBeGreaterThan(0);
    await expect(page.locator('.map-controls, .time-slider, .layer-toggles, .map-legend')).toHaveCount(0);
    await expect(page.locator('body')).toHaveAttribute('data-embed-ready', 'true');

    const screenshotPath = testInfo.outputPath('embed-direct.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await testInfo.attach('embed-direct', { path: screenshotPath, contentType: 'image/png' });
  });

  test('loads inside a third-party iframe host page', async ({ page, baseURL }, testInfo) => {
    await stubWorldAtlas(page);
    const embedUrl = new URL(embedPath, baseURL ?? 'http://127.0.0.1:4173').toString();
    await page.setContent(`
      <!doctype html>
      <html>
        <body style="margin:0;background:#f7f7f7">
          <main style="max-width:860px;margin:24px auto;font-family:sans-serif">
            <h1>Host page</h1>
            <iframe id="wm" src="${embedUrl}" title="World Monitor live map" style="width:100%;height:420px;border:0;display:block"></iframe>
          </main>
        </body>
      </html>
    `);

    const frame = page.frameLocator('#wm');
    await expect(frame.locator('.wm-embed-attribution')).toHaveText('Live map by World Monitor');
    await expect(frame.locator('.map-svg')).toBeVisible();
    await expect.poll(async () => frame.locator('.country').count()).toBeGreaterThan(0);
    await expect(frame.locator('.map-controls, .time-slider, .layer-toggles, .map-legend')).toHaveCount(0);

    const screenshotPath = testInfo.outputPath('embed-iframe.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await testInfo.attach('embed-iframe', { path: screenshotPath, contentType: 'image/png' });
  });
});
