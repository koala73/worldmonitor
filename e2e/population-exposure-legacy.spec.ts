import { expect, test } from '@playwright/test';
import { seedAnonymousDashboard } from './bootstrap-request-budget-fixtures';

for (const refreshed of [false, true]) {
  test(`population exposure handles ${refreshed ? 'current' : 'legacy'} bootstrap fields`, async ({ page }, testInfo) => {
    await seedAnonymousDashboard(page, 'full', { localStorage: {
      'worldmonitor-panels': JSON.stringify({ 'population-exposure': { name: 'Population Exposure', enabled: true, priority: 0 } }),
    } });
    await page.route(/^https?:\/\/(?!(127\.0\.0\.1:\d+|localhost:\d+)(?:\/|$)).*/i, route => route.abort());
    await page.route('**/api/**', route => route.fulfill({ json: {} }));
    const point = {
      id: 'gaza', country: 'Israel', locationName: 'Gaza town', location: { latitude: 31.52, longitude: 34.45 },
      dateStart: Date.now(), dateEnd: Date.now(), sideA: 'A', sideB: 'B', deathsBest: 0, deathsLow: 0, deathsHigh: 0,
      violenceType: 'UCDP_VIOLENCE_TYPE_STATE_BASED', sourceOriginal: 'Test data',
      ...(refreshed ? { hasPreciseLocation: true } : {}),
    };
    await page.route('**/api/bootstrap*', route => route.fulfill({ json: { missing: [], data: {
      ucdpEvents: {
        events: [point, { ...point, id: 'broad', locationName: 'Excluded broad location', hasPreciseLocation: false }],
        ...(refreshed ? {
          exposureEvents: [{ ...point, exposureEventCount: 2 }],
          exposureCoverage: { totalEvents: 3, withoutPreciseLocation: 1, withoutEstimate: 0, atOtherPlaces: 0 },
        } : {}),
      },
      unrestEvents: { events: [{
        id: 'aden', title: 'Test unrest', city: 'Aden', country: 'Yemen', location: { latitude: 12.8, longitude: 45 },
        hasPreciseLocation: true, sourceType: 'UNREST_SOURCE_TYPE_ACLED', occurredAt: Date.now(),
        eventType: 'UNREST_EVENT_TYPE_PROTEST', severity: 'UNREST_SEVERITY_LOW',
        confidence: 'UNREST_CONFIDENCE_HIGH', fatalities: 0, sources: [], tags: [], actors: [],
      }] },
    } } }));
    await page.goto('/dashboard?lang=en');
    const panel = page.locator('#panelsGrid .panel[data-panel="population-exposure"]');
    await panel.scrollIntoViewIfNeeded();
    await expect(panel.locator('.popexp-card')).toHaveCount(2);
    await expect(panel).toContainText('Gaza town, Palestine');
    await expect(panel).toContainText('Aden, Yemen');
    await expect(panel).not.toContainText('Excluded broad location');
    if (refreshed) {
      await expect(panel).toContainText('Events shown: 3 of 4');
      await expect(panel).toContainText('2 events');
      await expect(panel.locator('.popexp-panel-content')).not.toContainText('pending update');
    } else {
      await expect(panel).toContainText('Location precision pending update');
      await expect(panel).toContainText('Unrest coverage');
      await expect(panel).toContainText('Events shown: 1 of 1');
      await expect(panel).toContainText('UCDP coverage pending update');
    }
    // Use the panel's keyboard resize control so the evidence includes the footer.
    await panel.locator('.panel-resize-handle').focus();
    await page.keyboard.press('ArrowDown');
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await panel.scrollIntoViewIfNeeded();
      expect(await panel.locator('.panel-content').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      await panel.screenshot({ path: testInfo.outputPath(`exposure-${refreshed ? 'current' : 'legacy'}-${width}.png`) });
    }
  });
}

test('population exposure keeps Eilat and Gaza densities without borrowing for neighbours', async ({ page }, testInfo) => {
  await seedAnonymousDashboard(page, 'full', { localStorage: {
    'worldmonitor-panels': JSON.stringify({ 'population-exposure': { name: 'Population Exposure', enabled: true, priority: 0 } }),
  } });
  await page.route(/^https?:\/\/(?!(127\.0\.0\.1:\d+|localhost:\d+)(?:\/|$)).*/i, route => route.abort());
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  const points = [
    ['eilat-centre', 'Eilat centre', 'Israel', 29.55, 34.95],
    ['eilat-south', 'Eilat south', 'Israel', 29.54, 34.94],
    ['gaza', 'Gaza control', 'Israel', 31.52, 34.45],
    ['eilat-north', 'Atlas Jordan point', 'Jordan', 29.57, 34.96],
    ['teknaf', 'Teknaf', 'Bangladesh', 20.86, 92.30],
  ] as const;
  const events = points.map(([id, locationName, country, latitude, longitude]) => ({
    id, locationName, country, location: { latitude, longitude }, hasPreciseLocation: true,
    dateStart: Date.now(), dateEnd: Date.now(), sideA: 'A', sideB: 'B', deathsBest: 0, deathsLow: 0, deathsHigh: 0,
    violenceType: 'UCDP_VIOLENCE_TYPE_STATE_BASED', sourceOriginal: 'Test data',
  }));
  await page.route('**/api/bootstrap*', route => route.fulfill({ json: { missing: [], data: {
    ucdpEvents: { events, exposureEvents: events, exposureCoverage: { totalEvents: 5, withoutPreciseLocation: 0, withoutEstimate: 2, atOtherPlaces: 0 } },
  } } }));
  await page.goto('/dashboard?lang=en');
  const panel = page.locator('#panelsGrid .panel[data-panel="population-exposure"]');
  await panel.scrollIntoViewIfNeeded();
  await expect(panel.locator('.popexp-card')).toHaveCount(3);
  for (const name of ['Eilat centre', 'Eilat south']) await expect(panel.locator('.popexp-card').filter({ hasText: name })).toContainText('3.5M');
  await expect(panel.locator('.popexp-card').filter({ hasText: 'Gaza control' })).toContainText('7.0M');
  await expect(panel).toContainText('Events shown: 3 of 5');
  await expect(panel).not.toContainText('Teknaf');
  await expect(panel).not.toContainText('Atlas Jordan point');
  await panel.locator('.panel-resize-handle').focus();
  await page.keyboard.press('ArrowDown');
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await panel.scrollIntoViewIfNeeded();
    await panel.screenshot({ path: testInfo.outputPath(`atlas-regressions-${width}.png`) });
  }
});
