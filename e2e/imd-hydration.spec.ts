import { expect, test } from '@playwright/test';
import { seedAnonymousDashboard } from './bootstrap-request-budget-fixtures';

test('IMD hydration reaches both natural and weather layers without a failed refetch', async ({ page }, testInfo) => {
  await seedAnonymousDashboard(page, 'full', { localStorage: { 'worldmonitor-layers': JSON.stringify({ natural: true, weather: true }) } });
  await page.route(/^https?:\/\/(?!(127\.0\.0\.1:4173|localhost:4173)(?:\/|$)).*/i, route => route.abort());
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  let refetches = 0;
  await page.route('**/api/bootstrap*', async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('keys') === 'imdCycloneMarine') {
      refetches++;
      await route.fulfill({ status: 503, json: { error: 'controlled unavailable refetch' } });
      return;
    }
    const now = Date.now();
    await route.fulfill({ json: { missing: [], data: {
      imdCycloneMarine: {
        coverageState: 'ok', generatedAt: now,
        cycloneEvents: [{ id: 'imd-browser', title: 'IMD Fixture Storm', category: 'severeStorms', categoryTitle: 'Cyclone', lat: 15, lon: 80, date: now, closed: false, sourceName: 'IMD' }],
        portAlerts: [{ id: 'imd-port', event: 'IMD Port Warning', severity: 'Severe', headline: 'IMD Fixture Port', description: 'Controlled warning', areaDesc: 'Fixture port', onset: now, expires: now + 3600000, coordinates: [[85, 20]], centroid: [85, 20], source: 'IMD', countryCode: 'IN', geometryPrecision: 'point' }],
        marineBulletins: [], sourceName: 'India Meteorological Department',
      },
      weatherAlerts: { alerts: [] }, naturalEvents: { events: [] },
    } } });
  });
  await page.goto('/dashboard?lat=18&lon=82&zoom=3&layers=natural,weather');
  await expect(page.locator('html')).toHaveAttribute('data-wm-initial-data-ready', 'true', { timeout: 60000 });
  await expect(page.locator('.nat-event-marker')).toHaveCount(1);
  await expect(page.locator('.weather-marker')).toHaveCount(1);
  expect(refetches).toBe(0);
  await page.locator('.nat-event-marker').click();
  await expect(page.getByText('IMD Fixture Storm', { exact: true }).last()).toBeVisible();
  await expect(page.getByText('IMD', { exact: true }).last()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('imd-hydrated-both-layers.png') });
});
